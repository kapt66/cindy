/**
 * PSB 工作区占用闸门（`workspaceLock.ts`）。
 *
 * 测试价值
 * - 生产入口与可观察结果：`createPsbWorkspaceLock(ports).ensure()` 是「开新会话 / 启动串流 /
 *   发送消息」三条写入路径共用的唯一锁定判据。用户可观察结果是：未被自己锁定 → 自动占用后
 *   继续；被别人占用 → 可行动失败（带人名）；离线 / 未就绪 / 不可见 → 对应原因；网络失败 → 报错。
 * - Bug／规则依据：PSB 服务端对工作区写操作做占用闸门（2026-11-26 口径），Cindy 必须在写入前
 *   自己锁定，否则只能在 PSB 拒绝后显示一句不可行动的失败。规则见
 *   `docs/dev-rules/psb-remote-session-transport.md` §12 与
 *   `docs/product-rules/psb-remote-workspace-sessions.md`「写前锁定」。
 * - 现有覆盖缺口：`sessionRebind.test.ts` 只覆盖「工作区被别人占就不重建」的发送前重建分支，
 *   没有覆盖「未占用时自动占用」「乐观缓存不重复请求」「失败不缓存」「失败 → PSB_* 文案码」。
 * - 最小失败输入：① 列表里工作区 `occupancy.occupied=false`（应自动占用一次）；
 *   ② `occupy` 抛 `WORKSPACE_OCCUPIED_BY_OTHER`（被抢先）；③ `listWorkspaces` 抛网络错误；
 *   ④ 同一工作区 1.5s 内连续两次 ensure（应只有一次请求）。
 * - tier：unit（进程内内存 fake，无网络 / 无 Electron）。
 * - 实测耗时：单独运行 1.74s（其中 14 条用例 6ms；其余为 vitest 启动与模块加载）。
 */

import { describe, expect, it } from 'vitest';

import {
  psbIpcCodeForFailure,
  type PsbRemoteWorkspace,
  type PsbSessionStatusResult,
} from '../../../shared/psb-remote-workspace';
import { PsbClientError } from '../psbClient';
import {
  PSB_WORKSPACE_LOCK_TTL_MS,
  createPsbWorkspaceLock,
  psbWorkspaceLockFailure,
  psbWorkspaceLockFailureError,
} from '../workspaceLock';

const WORKSPACE_ID = 'ws-saga2';

function workspaceRow(overrides: Partial<PsbRemoteWorkspace> = {}): PsbRemoteWorkspace {
  return {
    id: WORKSPACE_ID,
    title: 'saga2_project',
    clientId: 'client-pack',
    clientName: '打包机',
    clientOnline: true,
    clientPlatform: 'win32',
    state: 'ready',
    templateKey: 'saga2',
    templateTitle: 'Saga2',
    directoryName: 'saga2_project-2',
    clientPath: 'D:\\psb\\saga2_project-2',
    occupancy: { occupied: false, byMe: false, personId: null, personName: '', occupiedAt: null },
    usable: true,
    unusableReason: null,
    sessionCount: 0,
    webUrl: null,
    sessionsWebUrl: null,
    ...overrides,
  };
}

function occupiedByMe(): PsbRemoteWorkspace {
  return workspaceRow({
    occupancy: { occupied: true, byMe: true, personId: '7', personName: '我', occupiedAt: 1 },
  });
}

function occupiedByOther(name = '张三'): PsbRemoteWorkspace {
  return workspaceRow({
    occupancy: { occupied: true, byMe: false, personId: '9', personName: name, occupiedAt: 2 },
  });
}

interface HarnessOptions {
  workspaces?: () => Promise<PsbRemoteWorkspace[]>;
  occupy?: (workspaceId: string) => Promise<PsbRemoteWorkspace>;
  /** 发送前闸门读会话行（缺省 = 会话属于 `WORKSPACE_ID`，工作区按 `workspaces` 或默认空闲行）。 */
  session?: (psbSessionId: string) => Promise<PsbSessionStatusResult>;
  now?: () => number;
}

function createHarness(options: HarnessOptions = {}) {
  const counts = { list: 0, occupy: 0, session: 0 };
  let clock = 0;
  const lock = createPsbWorkspaceLock(
    {
      listWorkspaces: async () => {
        counts.list += 1;
        return options.workspaces ? options.workspaces() : [workspaceRow()];
      },
      occupyWorkspace: async (workspaceId) => {
        counts.occupy += 1;
        return {
          workspace: options.occupy ? await options.occupy(workspaceId) : occupiedByMe(),
          // 0.1.180：占用响应可能带建议性 VCS 通知；锁只关心工作区行（advisory 由服务层广播）。
          vcs: null,
        };
      },
      readSession: async (psbSessionId) => {
        counts.session += 1;
        if (options.session) return options.session(psbSessionId);
        return {
          session: {
            id: psbSessionId,
            workspaceId: WORKSPACE_ID,
            clientId: 'client-pack',
            title: '用户任务',
            agentKind: 'pi',
            status: 'running',
            statusMessage: null,
            createdAt: '2026-11-26T01:00:00.000Z',
            updatedAt: '2026-11-26T01:00:00.000Z',
            createdBy: { personId: '7', personName: '我', source: 'cindy' },
            webUrl: null,
          },
          workspace: workspaceRow(),
        };
      },
    },
    { now: options.now ?? (() => clock) },
  );
  return {
    lock,
    counts,
    advance(ms: number) {
      clock += ms;
    },
  };
}

function psbFailure(code: string, message: string | null = null): PsbClientError {
  return new PsbClientError({ code, messageKey: 'remoteWorkspace.error.unknown', message }, null);
}

describe('占用闸门：状态机', () => {
  it('未被占用 → 自动占用一次后放行；乐观有效期内不再请求', async () => {
    const harness = createHarness();

    expect(await harness.lock.ensure(WORKSPACE_ID)).toEqual({ ok: true });
    expect(harness.counts).toEqual({ list: 1, occupy: 1, session: 0 });

    // 连续发送不为每条消息多打一次 PSB：TTL 内走缓存。
    expect(await harness.lock.ensure(WORKSPACE_ID)).toEqual({ ok: true });
    expect(harness.counts).toEqual({ list: 1, occupy: 1, session: 0 });

    harness.advance(PSB_WORKSPACE_LOCK_TTL_MS + 1);
    expect(await harness.lock.ensure(WORKSPACE_ID)).toEqual({ ok: true });
    expect(harness.counts.list).toBe(2);
  });

  it('已由自己占用 → 放行，且不再调用 occupy', async () => {
    const harness = createHarness({ workspaces: async () => [occupiedByMe()] });

    expect(await harness.lock.ensure(WORKSPACE_ID)).toEqual({ ok: true });
    expect(harness.counts).toEqual({ list: 1, occupy: 0, session: 0 });
  });

  it('被他人占用 → occupied-by-other + 占用人名，且不尝试占用', async () => {
    const harness = createHarness({ workspaces: async () => [occupiedByOther('李四')] });

    expect(await harness.lock.ensure(WORKSPACE_ID)).toEqual({
      ok: false,
      reason: 'occupied-by-other',
      personName: '李四',
    });
    expect(harness.counts.occupy).toBe(0);
  });

  it('客户端离线 / 工作区未就绪 / 工作区不可见 → 各自的 reason（不尝试占用）', async () => {
    const offline = createHarness({ workspaces: async () => [workspaceRow({ clientOnline: false })] });
    expect(await offline.lock.ensure(WORKSPACE_ID)).toEqual({ ok: false, reason: 'offline' });
    expect(offline.counts.occupy).toBe(0);

    const provisioning = createHarness({
      workspaces: async () => [workspaceRow({ state: 'provisioning' })],
    });
    expect(await provisioning.lock.ensure(WORKSPACE_ID)).toEqual({
      ok: false,
      reason: 'workspace-unavailable',
      missing: false,
      state: 'provisioning',
    });

    const gone = createHarness({ workspaces: async () => [] });
    expect(await gone.lock.ensure(WORKSPACE_ID)).toEqual({
      ok: false,
      reason: 'workspace-unavailable',
      missing: true,
      state: null,
    });
  });

  it('自动占用时被他人抢先 → 仍按 occupied-by-other 回报（人名来自 PSB 失败原文）', async () => {
    const harness = createHarness({
      occupy: async () => {
        throw psbFailure('WORKSPACE_OCCUPIED_BY_OTHER', '王五');
      },
    });

    expect(await harness.lock.ensure(WORKSPACE_ID)).toEqual({
      ok: false,
      reason: 'occupied-by-other',
      personName: '王五',
    });
  });

  it('失败不缓存：占用被释放后，下一次 ensure 立刻自动重新占用', async () => {
    let workspaces = [occupiedByOther('张三')];
    const harness = createHarness({ workspaces: async () => workspaces });

    expect(await harness.lock.ensure(WORKSPACE_ID)).toMatchObject({
      ok: false,
      reason: 'occupied-by-other',
    });
    // 对方释放（无人占用）：下一次必须重新判断，不能被上一次失败缓存挡掉。
    workspaces = [workspaceRow()];
    expect(await harness.lock.ensure(WORKSPACE_ID)).toEqual({ ok: true });
    expect(harness.counts.occupy).toBe(1);
  });

  it('网络失败原样抛出，不静默当成「可以写」', async () => {
    const harness = createHarness({
      workspaces: async () => {
        throw psbFailure('PSB_UNREACHABLE', '连不上 PSB');
      },
    });

    await expect(harness.lock.ensure(WORKSPACE_ID)).rejects.toMatchObject({
      failure: { code: 'PSB_UNREACHABLE' },
    });
  });

  it('PSB 的权威 usable/unusableReason 被采信（不是只看在线 + state）', async () => {
    // 旧实现完全不读 `usable`：PSB 说「不能开新会话」时 Cindy 仍放行。四种原因各自成可行动结果。
    const occupied = createHarness({
      workspaces: async () => [
        workspaceRow({
          usable: false,
          unusableReason: 'occupied-by-other',
          occupancy: {
            occupied: true,
            byMe: false,
            personId: '9',
            personName: '李四',
            occupiedAt: 2,
          },
        }),
      ],
    });
    expect(await occupied.lock.ensure(WORKSPACE_ID)).toEqual({
      ok: false,
      reason: 'occupied-by-other',
      personName: '李四',
    });

    const offline = createHarness({
      workspaces: async () => [
        workspaceRow({ usable: false, unusableReason: 'client-offline' }),
      ],
    });
    expect(await offline.lock.ensure(WORKSPACE_ID)).toEqual({ ok: false, reason: 'offline' });

    const notReady = createHarness({
      workspaces: async () => [
        workspaceRow({ usable: false, unusableReason: 'workspace-not-ready' }),
      ],
    });
    expect(await notReady.lock.ensure(WORKSPACE_ID)).toMatchObject({
      ok: false,
      reason: 'workspace-unavailable',
      missing: false,
    });
  });

  it('agent-unsupported 只否定「开新会话」：工作区级写入口（占用闸门）不被无关原因锁死', async () => {
    const harness = createHarness({
      workspaces: async () => [
        workspaceRow({ usable: false, unusableReason: 'agent-unsupported' }),
      ],
    });
    // 占用闸门服务建会话 / 启串流 / 发送三条写入口；串流与那台机器有没有某 Harness 无关，
    // 所以这里按 requireAgentRuntime:false 放行并自动占用。
    expect(await harness.lock.ensure(WORKSPACE_ID)).toEqual({ ok: true });
    expect(harness.counts.occupy).toBe(1);
  });

  it('调用方给出新鲜快照 → 不读列表（发送路径少一次请求）', async () => {
    const harness = createHarness({ workspaces: async () => [occupiedByMe()] });

    expect(await harness.lock.ensure(WORKSPACE_ID, { snapshot: occupiedByMe() })).toEqual({
      ok: true,
    });
    expect(harness.counts).toEqual({ list: 0, occupy: 0, session: 0 });
  });

  it('释放后失效缓存：下一次 ensure 重新确认', async () => {
    const harness = createHarness();
    await harness.lock.ensure(WORKSPACE_ID);
    expect(harness.counts.list).toBe(1);

    harness.lock.invalidate(WORKSPACE_ID);
    await harness.lock.ensure(WORKSPACE_ID);
    expect(harness.counts.list).toBe(2);
  });
});

describe('占用闸门：发送前（按 PSB 会话）', () => {
  it('首次读一次会话行（自带工作区快照）→ 未占用则自动占用；TTL 内再发送零请求', async () => {
    const harness = createHarness();

    expect(await harness.lock.ensureForSession('psb-1')).toEqual({ ok: true });
    // 会话行给了工作区快照，不需要再读工作区列表。
    expect(harness.counts).toEqual({ list: 0, occupy: 1, session: 1 });

    expect(await harness.lock.ensureForSession('psb-1')).toEqual({ ok: true });
    expect(harness.counts).toEqual({ list: 0, occupy: 1, session: 1 });
  });

  it('会话行显示工作区已被他人占用 → occupied-by-other（人名来自快照），不尝试占用', async () => {
    const harness = createHarness({
      session: async (psbSessionId) => ({
        session: {
          id: psbSessionId,
          workspaceId: WORKSPACE_ID,
          clientId: 'client-pack',
          title: '用户任务',
          agentKind: 'pi',
          status: 'running',
          statusMessage: null,
          createdAt: '2026-11-26T01:00:00.000Z',
          updatedAt: '2026-11-26T01:00:00.000Z',
          createdBy: { personId: '7', personName: '我', source: 'cindy' },
          webUrl: null,
        },
        workspace: occupiedByOther('李四'),
      }),
    });

    expect(await harness.lock.ensureForSession('psb-1')).toEqual({
      ok: false,
      reason: 'occupied-by-other',
      personName: '李四',
    });
    expect(harness.counts.occupy).toBe(0);
  });

  it('会话行读不到（已被清理）→ 原样抛出，不静默放行', async () => {
    const harness = createHarness({
      session: async () => {
        throw psbFailure('NOT_FOUND', '会话不存在');
      },
    });

    await expect(harness.lock.ensureForSession('psb-1')).rejects.toMatchObject({
      failure: { code: 'NOT_FOUND' },
    });
  });
});

describe('占用闸门：失败 → PSB_* 文案码', () => {
  it('三种可行动失败各自映射到不同的 IPC 码（下一步不同，不能糊成一个）', () => {
    expect(
      psbIpcCodeForFailure(
        psbWorkspaceLockFailureError({
          ok: false,
          reason: 'occupied-by-other',
          personName: '张三',
        }).failure,
      ),
    ).toBe('PSB_WORKSPACE_OCCUPIED_BY_OTHER');
    expect(
      psbIpcCodeForFailure(psbWorkspaceLockFailureError({ ok: false, reason: 'offline' }).failure),
    ).toBe('PSB_CLIENT_OFFLINE');
    expect(
      psbIpcCodeForFailure(
        psbWorkspaceLockFailureError({
          ok: false,
          reason: 'workspace-unavailable',
          missing: false,
          state: 'provisioning',
        }).failure,
      ),
    ).toBe('PSB_WORKSPACE_NOT_READY');
    expect(
      psbIpcCodeForFailure(
        psbWorkspaceLockFailureError({
          ok: false,
          reason: 'workspace-unavailable',
          missing: true,
          state: null,
        }).failure,
      ),
    ).toBe('PSB_NOT_FOUND');
  });

  it('被他人占用的失败 message 只放占用人名（渲染层回填 {{name}}），成功结果不产生异常', () => {
    const failure = psbWorkspaceLockFailureError({
      ok: false,
      reason: 'occupied-by-other',
      personName: '张三',
    }).failure;

    expect(failure).toMatchObject({
      code: 'WORKSPACE_OCCUPIED_BY_OTHER',
      messageKey: 'remoteWorkspace.error.occupiedByOther',
      message: '张三',
    });
    expect(psbWorkspaceLockFailure({ ok: true })).toBeNull();
  });
});
