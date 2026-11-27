/**
 * psbRemoteWorkspaceParsing.test.ts — PSB 响应解析的**安全默认**与失败单表契约。
 *
 * ## 测试价值
 *
 * - 生产入口与可观察结果：`parsePsbRemoteWorkspace` / `parsePsbRemoteSession` /
 *   `parsePsbSessionStreamStatus` 是 main 与渲染层共用的唯一 PSB 解析入口；它们的返回值直接
 *   决定「这条会话要不要发送前重建（远端写）」「用哪条隧道」「界面显示什么」。失败单表
 *   （`PSB_FAILURE_DESCRIPTORS`）决定跨 IPC 的码与文案键。
 * - Bug／规则依据（2026-11-26 审查 r3）：未知 `agentKind` 曾回落 `'claude-code'`（决定隧道
 *   mode）、未知 `status` 曾回落 `'failed'`（终态 ⇒ 触发透明重建 = 一次远端写）、未知
 *   `state` 曾回落 `'failed'`（把新状态显示成失败）；PSB 字符串字段无长度上限直通 IPC / 落盘；
 *   `stream.cursor` 的 X11 名查表走对象原型链（`constructor` 会命中 `Object.prototype` 并返回
 *   函数当 CSS 关键字）。
 * - 现有覆盖缺口：main 的 `psbClient.test.ts` 只覆盖 HTTP 客户端行为，不覆盖共享解析器的
 *   未知枚举/长度边界；渲染层测试用现成夹具，不会传入畸形 PSB 行。
 * - 最小失败输入：`{ id:'s1', workspaceId:'w1', agentKind:'future-agent', status:'paused' }`
 *   以前会解析成 `claude-code` + `failed`（错误隧道 + 错误重建）；一个 1 万字符的 `title`
 *   以前会原样进入 IPC 与本机快照。
 * - tier：unit（纯函数；不启动 Electron）。
 */

import { describe, expect, it } from 'vitest';

import { isIpcErrorCode, type IpcErrorCode } from '../ipc-errors';
import {
  psbAdminStreamStatusFromPsb,
  readPsbAdminStreamStatus,
} from '../psb-workspace-admin';
import {
  PSB_FAILURE_DESCRIPTORS,
  PSB_IPC_FAILURE_MESSAGE_KEYS,
  PSB_STREAM_CURSOR_MAX_NAME_LENGTH,
  PSB_TEXT_LIMITS,
  parsePsbRemoteSession,
  parsePsbRemoteWorkspace,
  parsePsbSessionStreamStatus,
  psbBannerMessageKeyForIpcCode,
  psbFailureDescriptorForIpcCode,
  psbFailureDescriptorForPsbCode,
  psbFailureMessageKeyForIpcCode,
  psbFailureMessageKeyForPsbCode,
  psbIpcCodeForFailure,
  psbNoRunningSessionIpcCode,
  psbNoRunningSessionMessageKey,
  psbStreamAccessFailureCopyForIpcCode,
  psbStreamCursorKeyword,
  psbWorkspaceHealth,
  psbWorkspaceWritable,
  parsePsbWorkspaceAccessStartResult,
  readPsbGuardFailurePromotion,
  readPsbWorkspaceAccessState,
  resolvePsbFailureCode,
  type PsbDescribedIpcCode,
  type PsbFailureDescriptor,
} from '../psb-remote-workspace';

const READY_WORKSPACE = {
  id: 'ws-1',
  title: 'SAGA2 设计',
  clientId: 'client-1',
  clientName: '设计机-01',
  clientOnline: true,
  clientPlatform: 'linux',
  state: 'ready',
  templateKey: 'saga2',
  templateTitle: 'SAGA2',
  directoryName: 'saga2-2',
  clientPath: '/srv/ws/saga2-2',
  occupancy: { occupied: false, byMe: false, personId: null, personName: '', occupiedAt: null },
  usable: true,
  unusableReason: null,
  sessionCount: 0,
  webUrl: 'https://psb.example/workspaces/ws-1',
  sessionsWebUrl: 'https://psb.example/workspaces/ws-1/sessions',
} as const;

describe('未知 PSB 枚举不落可写默认', () => {
  it('未知 agentKind / status 解析成 null（不回落 claude-code / failed）', () => {
    const session = parsePsbRemoteSession({
      id: 's1',
      workspaceId: 'w1',
      agentKind: 'future-agent',
      status: 'paused',
    });
    // 回落 'claude-code' 会用错隧道；回落 'failed' 会在下次发送时触发远端重建。
    expect(session?.agentKind).toBeNull();
    expect(session?.status).toBeNull();
  });

  it('未知工作区状态解析成 null，界面不把它伪装成 failed', () => {
    const workspace = parsePsbRemoteWorkspace({ ...READY_WORKSPACE, state: 'hibernating' });
    expect(workspace?.state).toBeNull();
    // 未知状态按「未就绪」处理：不可开会话，徽标不显示 failed。
    const health = psbWorkspaceHealth(workspace!);
    expect(health.canStartSession).toBe(false);
    expect(health.badgeKey).not.toBe('remoteWorkspace.badge.failed');
  });
});

describe('PSB 字符串字段的长度上限', () => {
  it('展示字段超限截断（不让畸形载荷撑爆 IPC / 落盘）', () => {
    const workspace = parsePsbRemoteWorkspace({
      ...READY_WORKSPACE,
      title: 'x'.repeat(PSB_TEXT_LIMITS.name + 10),
      webUrl: 'https://psb.example/' + 'y'.repeat(PSB_TEXT_LIMITS.url + 10),
    });
    expect(workspace?.title).toHaveLength(PSB_TEXT_LIMITS.name);
    expect(workspace?.webUrl).toHaveLength(PSB_TEXT_LIMITS.url);
  });

  it('标识字段超限整行丢弃（截断会让两个对象撞成同一身份）', () => {
    expect(
      parsePsbRemoteWorkspace({ ...READY_WORKSPACE, id: 'z'.repeat(PSB_TEXT_LIMITS.identity + 1) }),
    ).toBeNull();
    expect(
      parsePsbRemoteSession({
        id: 's1',
        workspaceId: 'w'.repeat(PSB_TEXT_LIMITS.identity + 1),
      }),
    ).toBeNull();
  });
});

describe('串流状态只认 PSB 契约字段名（capability / encoder / lastErrorZh）', () => {
  it('PSB 现行字段被读出', () => {
    const status = parsePsbSessionStreamStatus({
      capability: true,
      active: true,
      encoder: 'h264',
      lastErrorZh: '采集未启动',
    });
    expect(status).toMatchObject({ capability: true, encoder: 'h264', lastErrorZh: '采集未启动' });
  });

  it('早期草稿拼写不再被读取（capable / codec / lastError）', () => {
    const status = parsePsbSessionStreamStatus({
      capable: true,
      codec: 'h264',
      lastError: '草稿拼写',
    });
    expect(status.capability).toBe(false);
    expect(status.encoder).toBeNull();
    expect(status.lastErrorZh).toBeNull();
  });
});

describe('失败单表：PSB 码 / 通知码 / IPC 码 / 文案键 / 状态只在一处手写', () => {
  it('单表的每个 IPC 码都是合法的 IpcErrorCode（跨 IPC 能被渲染层认出）', () => {
    for (const ipcCode of Object.keys(PSB_FAILURE_DESCRIPTORS)) {
      expect(isIpcErrorCode(ipcCode), `${ipcCode} 未登记在 ipc-errors 单表`).toBe(true);
    }
  });

  it('PSB 码 → 文案键与 IPC 码 → 文案键一致（按钮失败与错误横幅同一句话）', () => {
    // VCS 家族：PSB 原始码（main 的 failure.code）与 IPC 码（跨进程后渲染层拿到的）两条路
    // 都必须给出同一个键，否则会出现「main 说 A、界面显示 B」。
    for (const descriptor of Object.values(PSB_FAILURE_DESCRIPTORS)) {
      if (descriptor.noticeCode === null) continue;
      expect(psbFailureMessageKeyForPsbCode(descriptor.psbCode)).toBe(descriptor.messageKey);
      expect(psbFailureMessageKeyForIpcCode(descriptor.noticeCode)).toBeNull();
    }
    const dirty = PSB_FAILURE_DESCRIPTORS.PSB_WORKSPACE_VCS_DIRTY;
    const dirtyFailure = {
      code: dirty.psbCode,
      messageKey: dirty.messageKey,
      message: 'PSB 原话',
    };
    expect(psbFailureDescriptorForIpcCode('PSB_WORKSPACE_VCS_DIRTY')?.messageKey).toBe(
      dirty.messageKey,
    );
    // 错误横幅只是「占用人名可省略」的覆盖，未覆盖的码与普通文案一致。
    expect(psbBannerMessageKeyForIpcCode('PSB_WORKSPACE_VCS_DIRTY')).toBe(
      psbFailureMessageKeyForIpcCode('PSB_WORKSPACE_VCS_DIRTY'),
    );
    expect(psbFailureMessageKeyForIpcCode('PSB_WORKSPACE_VCS_DIRTY')).toBe(
      dirtyFailure.messageKey,
    );
  });

  it('串流访问三档由单表派生：state → IPC 码 → 文案键 → 是否重试', () => {
    expect(psbNoRunningSessionIpcCode('none')).toBe('PSB_STREAM_NO_RUNNING_SESSION');
    expect(psbNoRunningSessionIpcCode('starting')).toBe('PSB_STREAM_ACCESS_STARTING');
    expect(psbNoRunningSessionIpcCode('stopping')).toBe('PSB_STREAM_ACCESS_STOPPING');
    // running / 未知一律落到「去网页启动」档（安全默认：不进自动重试循环）。
    expect(psbNoRunningSessionIpcCode('running')).toBe('PSB_STREAM_NO_RUNNING_SESSION');
    expect(psbNoRunningSessionIpcCode(null)).toBe('PSB_STREAM_NO_RUNNING_SESSION');

    expect(psbNoRunningSessionMessageKey('starting')).toBe(
      'remoteWorkspace.admin.streamAccessStarting',
    );
    expect(psbStreamAccessFailureCopyForIpcCode('PSB_STREAM_ACCESS_STARTING')).toMatchObject({
      state: 'starting',
      retryOnce: true,
      offerOpenWeb: false,
    });
    expect(psbStreamAccessFailureCopyForIpcCode('PSB_STREAM_NO_RUNNING_SESSION')).toMatchObject({
      state: 'none',
      retryOnce: false,
      offerOpenWeb: true,
    });
    expect(psbStreamAccessFailureCopyForIpcCode('PSB_AUTH_REQUIRED')).toBeNull();
  });

  it('每个 PSB 码都有描述符与文案键（单表穷尽；漏登记没有运行期兜底）', () => {
    // 运行期：表内每一项都有可翻译文案键，IPC 码反查与投影表一致。
    for (const [ipcCode, descriptor] of Object.entries(PSB_FAILURE_DESCRIPTORS)) {
      expect(descriptor.messageKey, `${ipcCode} 缺文案键`).toMatch(/^remoteWorkspace\./);
      expect(psbFailureMessageKeyForIpcCode(ipcCode)).toBe(descriptor.messageKey);
      expect(PSB_IPC_FAILURE_MESSAGE_KEYS[ipcCode as PsbDescribedIpcCode]).toBe(
        descriptor.messageKey,
      );
    }
    // 编译期穷尽：`ipc-errors.ts` 里每个 `PSB_*` 码都必须在单表里有一行。
    // 新增 IPC 码却漏加描述符时，下面这一行的类型不是 `true`，typecheck 直接失败。
    type GlobalPsbCode = Extract<IpcErrorCode, `PSB_${string}`>;
    const everyGlobalPsbCodeIsDescribed: [
      Exclude<GlobalPsbCode, PsbDescribedIpcCode>,
    ] extends [never]
      ? true
      : false = true;
    expect(everyGlobalPsbCodeIsDescribed).toBe(true);

    // 反向：表里每个 PSB 原始码（含历史别名）都能反查回 IPC 码与文案键。
    const ipcCodesByPsbCode = new Map<string, string[]>();
    for (const [ipcCode, rawDescriptor] of Object.entries(PSB_FAILURE_DESCRIPTORS)) {
      const descriptor = rawDescriptor as PsbFailureDescriptor;
      for (const psbCode of [descriptor.psbCode, ...(descriptor.alsoPsbCodes ?? [])]) {
        const list = ipcCodesByPsbCode.get(psbCode) ?? [];
        list.push(ipcCode);
        ipcCodesByPsbCode.set(psbCode, list);
      }
    }
    for (const [psbCode, ipcCodes] of ipcCodesByPsbCode) {
      const rows = ipcCodes.map(
        (ipcCode) =>
          PSB_FAILURE_DESCRIPTORS[ipcCode as PsbDescribedIpcCode] as PsbFailureDescriptor,
      );
      // 同码多行只允许「一条无鉴别默认 + 其余都有 state/messageKey 鉴别」；否则反查会静默选错下一步。
      const defaults = rows.filter(
        (row) => row.state === null && row.whenMessageKey === undefined,
      );
      expect(defaults.length, `${psbCode} 有 ${defaults.length} 条无鉴别默认描述`).toBeLessThanOrEqual(1);
      if (ipcCodes.length === 1) {
        expect(psbFailureMessageKeyForPsbCode(psbCode), `${psbCode} 反查不到文案键`).not.toBeNull();
        expect(
          psbIpcCodeForFailure({ code: psbCode, messageKey: 'unused', message: null }),
        ).toBe(ipcCodes[0]);
      }
    }
  });

  it('AUTH_REQUIRED 的两个下一步由单表鉴别（组织账号 vs 未登录），不在代码里写 if', () => {
    expect(
      psbIpcCodeForFailure({
        code: 'AUTH_REQUIRED',
        messageKey: 'remoteWorkspace.status.needOrg',
        message: null,
      }),
    ).toBe('PSB_ORG_REQUIRED');
    expect(
      psbIpcCodeForFailure({
        code: 'AUTH_REQUIRED',
        messageKey: 'remoteWorkspace.error.auth',
        message: null,
      }),
    ).toBe('PSB_AUTH_REQUIRED');
    expect(psbFailureMessageKeyForIpcCode('PSB_ORG_REQUIRED')).toBe(
      'remoteWorkspace.error.orgRequired',
    );
  });

  it('可写判据的四条原因与两份文案键都来自单表（失败 / 输入禁用不各写一份）', () => {
    const occupancy = {
      occupied: false,
      byMe: false,
      personId: null,
      personName: '',
      occupiedAt: null,
    } as const;
    const cases = [
      ['occupied-by-other', 'PSB_WORKSPACE_OCCUPIED_BY_OTHER'],
      ['client-offline', 'PSB_CLIENT_OFFLINE'],
      ['workspace-not-ready', 'PSB_WORKSPACE_NOT_READY'],
      ['agent-unsupported', 'PSB_AGENT_UNSUPPORTED'],
    ] as const;
    for (const [reason, ipcCode] of cases) {
      const writable = psbWorkspaceWritable({
        state: 'ready',
        clientOnline: true,
        occupancy,
        usable: true,
        unusableReason: reason,
      });
      const descriptor = PSB_FAILURE_DESCRIPTORS[ipcCode] as PsbFailureDescriptor;
      expect(writable.ok).toBe(false);
      expect(writable.ipcCode).toBe(ipcCode);
      expect(writable.messageKey).toBe(descriptor.messageKey);
      expect(writable.inputMessageKey).toBe(
        descriptor.inputMessageKey ?? descriptor.messageKey,
      );
      expect(
        psbIpcCodeForFailure({
          code: writable.ipcCode!,
          messageKey: writable.messageKey!,
          message: null,
        }),
      ).toBe(ipcCode);
    }
  });

  it('远端字符串查表不命中原型链（constructor / toString 不是文案键）', () => {
    expect(psbFailureMessageKeyForIpcCode('constructor')).toBeNull();
    expect(psbFailureMessageKeyForIpcCode('__proto__')).toBeNull();
    expect(psbBannerMessageKeyForIpcCode('toString')).toBeNull();
  });
});

describe('stream.cursor 的 X11 名查表也不命中原型链', () => {
  it('constructor / toString 等原型键回退 default（不是函数）', () => {
    const base = {
      serial: 1,
      width: 16,
      height: 16,
      xhot: 0,
      yhot: 0,
      imageBase64: 'AAAA',
    };
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(psbStreamCursorKeyword({ ...base, name })).toBe('default');
    }
    // 合法别名仍按表映射（同一形状两端同一 CSS 值）。
    expect(psbStreamCursorKeyword({ ...base, name: 'xterm' })).toBe('text');
    // 超长 name 仍截断到诊断上限（与 cursor 同口径）。
    expect(PSB_STREAM_CURSOR_MAX_NAME_LENGTH).toBe(64);
  });
});

describe('管理页串流状态只保留一个归一化强度', () => {
  it('形状不认识 → null（= 此刻读不到，不是 capability:false）', () => {
    expect(readPsbAdminStreamStatus(undefined)).toBeNull();
    expect(readPsbAdminStreamStatus({})).toBeNull();
    expect(readPsbAdminStreamStatus({ capability: 'yes', active: true })).toBeNull();
    // 原型链上的键不能冒充状态字段。
    expect(readPsbAdminStreamStatus({ constructor: true })).toBeNull();
  });

  it('已知形状归一：可选字段缺省级补 null，未知枚举补 null', () => {
    expect(
      readPsbAdminStreamStatus({
        capability: true,
        active: false,
        width: 1920,
        height: 1080,
        fps: 30,
        encoder: 'h264',
        lastErrorZh: null,
        desktopSession: 'future-state',
        reasonCode: 'FUTURE_CODE',
      }),
    ).toEqual({
      capability: true,
      active: false,
      width: 1920,
      height: 1080,
      fps: 30,
      encoder: 'h264',
      lastErrorZh: null,
      desktopSession: null,
      reasonCode: null,
    });
  });

  it('main 侧的已解析状态映射与 IPC 读口得到同一形状（复用同一 DTO）', () => {
    const parsed = parsePsbSessionStreamStatus({ capability: true, active: true, encoder: 'h264' });
    const fromPsb = psbAdminStreamStatusFromPsb(parsed);
    expect(fromPsb).toEqual(readPsbAdminStreamStatus(parsed));
    expect(fromPsb.desktopSession).toBeNull();
    expect(fromPsb.reasonCode).toBeNull();
  });
});

/* ============ 启动访问（CINDY-RW-17）：202/200 外壳与业务码提升 ============ */

/**
 * PSB-RW-17（0.1.183）：`access/start` 的 202/200 外壳、`details.code` 的业务码提升，
 * 以及 agent-tunnel Upgrade 拒绝体的守卫提升。解析错一层的后果是「界面显示泛泛失败 / 又去
 * 网页点启动」，所以逐字段钉住真实序列化形状。
 */
describe('启动访问：访问状态 / 202-200 外壳 / details.code 业务码提升', () => {
  it('readPsbWorkspaceAccessState 只认 state 与 access.state，未知词归 null', () => {
    expect(readPsbWorkspaceAccessState({ state: 'running' })).toBe('running');
    expect(readPsbWorkspaceAccessState({ access: { state: 'starting' } })).toBe('starting');
    expect(readPsbWorkspaceAccessState({ desktopSession: 'running' })).toBeNull();
    expect(readPsbWorkspaceAccessState({ access: { state: 'future-state' } })).toBeNull();
    expect(readPsbWorkspaceAccessState(null)).toBeNull();
  });

  it('parsePsbWorkspaceAccessStartResult 解析 202 / 200 两种真实外壳', () => {
    expect(
      parsePsbWorkspaceAccessStartResult({
        access: { state: 'starting', session: { id: 'desktop-9', state: 'starting', display: 90 } },
        state: 'starting',
        sessionId: 'desktop-9',
        attached: false,
      }),
    ).toEqual({
      state: 'starting',
      sessionId: 'desktop-9',
      attached: false,
      access: { state: 'starting' },
    });

    expect(
      parsePsbWorkspaceAccessStartResult({
        access: { state: 'running', session: { id: 'desktop-9', state: 'running' } },
        state: 'running',
        sessionId: 'desktop-9',
        attached: true,
      }),
    ).toEqual({
      state: 'running',
      sessionId: 'desktop-9',
      attached: true,
      access: { state: 'running' },
    });

    // 不是对象 = 协议违约（调用方按 PSB_PROTOCOL 处理，不伪造一个成功）。
    expect(parsePsbWorkspaceAccessStartResult('nope')).toBeNull();
  });

  it('resolvePsbFailureCode：details.code 命中单表时提升，两个具体码冲突时保留顶层', () => {
    const promote = resolvePsbFailureCode({
      code: 'FORBIDDEN',
      message: '先占用工作区再启动访问。',
      details: { code: 'WORKSPACE_NOT_OCCUPIED' },
    });
    expect(promote).toBe('WORKSPACE_NOT_OCCUPIED');

    // 顶层已经是具体业务码：保留它（REST 契约里 error.code 是权威位置）。
    expect(
      resolvePsbFailureCode({
        code: 'WORKSPACE_OCCUPIED_BY_OTHER',
        message: '',
        details: { code: 'TOO_MANY_TUNNELS' },
      }),
    ).toBe('WORKSPACE_OCCUPIED_BY_OTHER');

    // details.code 不在单表（不认识的新码）：不提升，保留外层。
    expect(
      resolvePsbFailureCode({ code: 'FORBIDDEN', message: '', details: { code: 'FUTURE_CODE' } }),
    ).toBe('FORBIDDEN');
  });

  it('readPsbGuardFailurePromotion：四种守卫码提升为跨 IPC 业务码，其余不提升', () => {
    const cases: ReadonlyArray<{ detailsCode: string; ipcCode: string }> = [
      { detailsCode: 'WORKSPACE_NOT_OCCUPIED', ipcCode: 'PSB_WORKSPACE_NOT_OCCUPIED' },
      { detailsCode: 'WORKSPACE_OCCUPIED_BY_OTHER', ipcCode: 'PSB_WORKSPACE_OCCUPIED_BY_OTHER' },
      { detailsCode: 'AGENT_SESSION_ACTIVE', ipcCode: 'PSB_AGENT_SESSION_ACTIVE' },
      { detailsCode: 'TOO_MANY_TUNNELS', ipcCode: 'PSB_TOO_MANY_TUNNELS' },
    ];
    for (const item of cases) {
      const promoted = readPsbGuardFailurePromotion({
        code: 'CONFLICT',
        message: '可读中文原因。',
        details: { code: item.detailsCode },
      });
      expect(promoted?.ipcCode, item.detailsCode).toBe(item.ipcCode);
      expect(promoted?.failure.code).toBe(item.detailsCode);
      expect(promoted?.failure.message).toBe('可读中文原因。');
      // 提升后的 IPC 码必须能在单表里查到文案（否则渲染层会落通用失败）。
      expect(psbFailureMessageKeyForIpcCode(item.ipcCode)).not.toBeNull();
    }

    expect(
      readPsbGuardFailurePromotion({ code: 'CONFLICT', message: '', details: { code: 'AUTH_INVALID' } }),
    ).toBeNull();
  });

  it('TOO_MANY_TUNNELS 在失败单表里可行动（关掉其它远程会话后重试），且 IPC 码合法', () => {
    expect(psbIpcCodeForFailure({ code: 'TOO_MANY_TUNNELS', messageKey: 'x', message: null })).toBe(
      'PSB_TOO_MANY_TUNNELS',
    );
    expect(psbFailureMessageKeyForIpcCode('PSB_TOO_MANY_TUNNELS')).toBe(
      'remoteWorkspace.error.tooManyTunnels',
    );
    expect(psbFailureDescriptorForIpcCode('PSB_TOO_MANY_TUNNELS')?.nextStep).toBe('stop-session');
  });
});
