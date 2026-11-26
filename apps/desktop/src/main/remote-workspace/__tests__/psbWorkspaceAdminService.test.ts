/**
 * 管理页（工作区级「远程工作区」页）的 main 侧服务与最近使用记录。
 *
 * 测试价值
 * - 生产入口与可观察结果：`createPsbWorkspaceAdminService(deps)` 是渲染层 `adminContext` /
 *   `adminStreamStart` / `adminStreamStop` / `adminStreamStatus` / `adminStreamInput` 的唯一实现；
 *   `createPsbAdminRecentWorkspaceStore(io)` 是「最近使用的远程工作区」的唯一落点。
 *   可观察结果是：页面顶部拿到的 `PsbWorkspaceAdminContext`、内部观看端会话 id、串流状态、
 *   以及 `CONTEXT_CHANGED` 推送。
 * - Bug／规则依据：2026-11-26 实测退化 —— 页面跟随「当前任务的 PSB 会话」，PSB 会话终态后
 *   读不到状态、点「启动」被 PSB 拒（`agent 会话已结束`）。规则见
 *   `docs/dev-rules/psb-remote-session-transport.md` §11（工作区级管理页与内部观看端会话）。
 *   同日真机联调第二处退化：应用重启后内存绑定全丢，`adminStreamStatus` / `adminContext` 没有
 *   会话可借去读 `stream/status` → `desktopSession` 恒为 `null`。修复口径后来被审查修正：
 *   读路径**只复用本机记录里的内部观看端会话 id（只读 HTTP）**，绝不新建 PSB 会话——写前占用
 *   闸门落地后，读状态时建会话会让「打开远程工作区页签」静默占用一个空闲工作区。只有用户
 *   显式「启动」才创建内部会话；复用也只认本机记录，不按标题认领 `listSessions` 里别人的会话。
 * - 现有覆盖缺口：`psbClient.test.ts` / `streamViewer.test.ts` 只覆盖 HTTP 外壳与观看端；
 *   没有用例覆盖「工作区从哪解析」「内部观看端会话怎么复用/新建」「终态竞态重试一次」
 *   「读不到 ≠ 客户端不支持」「读路径不创建会话 / 不占用」，也没有覆盖最近使用记录（含观看端
 *   映射）的容量与幂等写。
 * - 最小失败输入：① 本地任务 `remoteHostId='psb:s1'` 且 `sessionStatus` 抛 404（PSB 已清记录）；
 *   ② 本机记录里的 `psb-viewer-*` 已 `stopped`；③ `startStream` 第一次抛 NOT_FOUND；
 *   ④ 记录文件里塞 40 条映射、观看端重复工作区与坏行；⑤ 重启后没有内存绑定：`streamStatus`
 *   若按需建会话就会「读着读着占用了工作区」（审查缺陷），或建会话失败时把未知当成 `none`。
 * - tier：unit（进程内内存 fake，无网络 / 无 Electron / 无真实文件）。
 * - 实测耗时：单独运行 2.4s（其中 30 条用例 125ms；其余为 vitest 启动与模块加载）。
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  PsbCreateSessionRequest,
  PsbCreateSessionResult,
  PsbRemoteSession,
  PsbRemoteWorkspace,
  PsbSessionStatusResult,
  PsbSessionStreamStatus,
  PsbStreamEvent,
} from '../../../shared/psb-remote-workspace';
import {
  PSB_ADMIN_VIEWER_SESSION_TITLE,
  psbAdminStreamStatusFromPsb,
  type PsbWorkspaceAdminContext,
} from '../../../shared/psb-workspace-admin';
import {
  PSB_ADMIN_RECENT_SESSION_LIMIT,
  PSB_ADMIN_RECENT_VIEWER_LIMIT,
  createPsbAdminRecentWorkspaceStore,
  normalizePsbAdminRecentState,
  type PsbAdminRecentWorkspaceFile,
  type PsbAdminRecentWorkspaceIo,
} from '../adminRecentStore';
import {
  createPsbWorkspaceAdminService,
  type PsbAdminRemotePort,
  type PsbWorkspaceAdminService,
  type PsbWorkspaceAdminServiceDeps,
} from '../adminService';
import { PsbClientError } from '../psbClient';

/* ============================== fixtures ============================== */

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
    occupancy: { occupied: true, byMe: true, personId: '7', personName: '我', occupiedAt: 1 },
    usable: true,
    unusableReason: null,
    sessionCount: 1,
    webUrl: 'https://psb.example/remote/workspaces/ws-saga2',
    sessionsWebUrl: null,
    ...overrides,
  };
}

function sessionRow(overrides: Partial<PsbRemoteSession> = {}): PsbRemoteSession {
  return {
    id: 'psb-user-session',
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
    ...overrides,
  };
}

function viewerSessionRow(overrides: Partial<PsbRemoteSession> = {}): PsbRemoteSession {
  return sessionRow({
    id: 'psb-viewer',
    title: PSB_ADMIN_VIEWER_SESSION_TITLE,
    createdAt: '2026-11-26T02:00:00.000Z',
    ...overrides,
  });
}

function streamStatus(overrides: Partial<PsbSessionStreamStatus> = {}): PsbSessionStreamStatus {
  return {
    capable: true,
    active: false,
    width: 2560,
    height: 1440,
    fps: 60,
    codec: 'h264',
    lastError: null,
    desktopSession: 'running',
    reasonCode: null,
    ...overrides,
  };
}

function notFound(): PsbClientError {
  return new PsbClientError(
    { code: 'NOT_FOUND', messageKey: 'remoteWorkspace.error.notFound', message: '会话不存在' },
    404,
  );
}

function unreachable(): PsbClientError {
  return new PsbClientError(
    {
      code: 'PSB_UNREACHABLE',
      messageKey: 'remoteWorkspace.error.unreachable',
      message: '连不上 PSB',
    },
    null,
  );
}

/* ============================== harness ============================== */

/** 可变的 PSB 行为：测试中途改它就等于「PSB 的事实变了」，不必重建服务实例。 */
interface RemoteBehavior {
  listWorkspaces: () => Promise<PsbRemoteWorkspace[]>;
  sessionStatus: (sessionId: string) => Promise<PsbSessionStatusResult>;
  streamStatus: (sessionId: string) => Promise<PsbSessionStreamStatus>;
  startStream: (sessionId: string) => Promise<PsbSessionStreamStatus>;
  /** 输入转发（默认成功；抛错用来模拟「WS 已断」）。 */
  sendStreamInput: (sessionId: string, event: Record<string, unknown>) => Promise<void>;
  /** 建会话（缺省 = 成功的 `Cindy 观看端` 会话；抛错用来模拟工作区不可见 / 客户端离线）。 */
  createSession?: (input: PsbCreateSessionRequest) => Promise<PsbCreateSessionResult>;
  /**
   * 写操作前的占用闸门（生产 = `PsbRemoteService.ensureWorkspaceLocked`）。
   * 缺省成功；抛错用来模拟「被别人占用 / 离线 / 未就绪」。
   */
  ensureWorkspaceLocked: (workspaceId: string) => Promise<void>;
  localRemoteHostId: string | null;
}

interface Harness {
  readonly service: PsbWorkspaceAdminService;
  readonly deps: PsbWorkspaceAdminServiceDeps;
  readonly behavior: RemoteBehavior;
  readonly contextEvents: (PsbWorkspaceAdminContext | null)[];
  readonly streamEvents: PsbStreamEvent[];
  readonly createSessionCalls: PsbCreateSessionRequest[];
  readonly startStreamCalls: string[];
  readonly stopStreamCalls: string[];
  /** 转发给观看端的输入（会话 id + 事件；断言「解析到哪条会话」）。 */
  readonly inputCalls: Array<{ sessionId: string; event: Record<string, unknown> }>;
  /** 占用闸门的调用顺序（工作区 id；断言「启动串流前先确保锁定」）。 */
  readonly lockChecks: string[];
  readonly storeWrites: () => number;
  /** 模拟账号边界：换成一个新的 PSB 服务实例。 */
  swapRemote(behavior: Partial<RemoteBehavior>): void;
  /** 触发一条内部观看端会话的串流事件（生产 = 观看端 emit）。 */
  emitStreamEvent(event: PsbStreamEvent): void;
}

interface HarnessOptions {
  behavior?: Partial<RemoteBehavior>;
  recent?: Partial<PsbAdminRecentWorkspaceFile>;
}

/** 一次运行里记录下来的 PSB 写动作（断言「有没有重建会话」「停了哪条会话」）。 */
interface RemoteCalls {
  created: PsbCreateSessionRequest[];
  started: string[];
  stopped: string[];
  inputs: Array<{ sessionId: string; event: Record<string, unknown> }>;
  lockChecks: string[];
}

function createRemote(
  behavior: RemoteBehavior,
  calls: RemoteCalls,
  listeners: Set<(event: PsbStreamEvent) => void>,
): PsbAdminRemotePort {
  let created = 0;
  return {
    listWorkspaces: () => behavior.listWorkspaces(),
    sessionStatus: (sessionId) => behavior.sessionStatus(sessionId),
    createSession: async (input) => {
      calls.created.push(input);
      if (behavior.createSession) return behavior.createSession(input);
      created += 1;
      return {
        session: viewerSessionRow({ id: `psb-viewer-${created}` }),
        workspace: workspaceRow(),
      };
    },
    getStreamStatus: (sessionId) => behavior.streamStatus(sessionId),
    startStream: async (sessionId) => {
      calls.started.push(sessionId);
      return behavior.startStream(sessionId);
    },
    stopStream: async (sessionId) => {
      calls.stopped.push(sessionId);
    },
    sendStreamInput: async (sessionId, event) => {
      calls.inputs.push({ sessionId, event });
      await behavior.sendStreamInput(sessionId, event);
    },
    ensureWorkspaceLocked: async (workspaceId) => {
      calls.lockChecks.push(workspaceId);
      await behavior.ensureWorkspaceLocked(workspaceId);
    },
    onStreamEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const contextEvents: (PsbWorkspaceAdminContext | null)[] = [];
  const streamEvents: PsbStreamEvent[] = [];
  const calls: RemoteCalls = { created: [], started: [], stopped: [], inputs: [], lockChecks: [] };
  const listeners = new Set<(event: PsbStreamEvent) => void>();
  const recent: PsbAdminRecentWorkspaceFile = {
    lastWorkspaceId: null,
    sessions: [],
    viewers: [],
    ...options.recent,
    ...(options.recent?.sessions ? { sessions: [...options.recent.sessions] } : {}),
    ...(options.recent?.viewers ? { viewers: [...options.recent.viewers] } : {}),
  };
  let writes = 0;
  const io: PsbAdminRecentWorkspaceIo = {
    read: () => recent,
    write: (next) => {
      writes += 1;
      recent.lastWorkspaceId = next.lastWorkspaceId;
      recent.sessions = [...next.sessions];
      recent.viewers = [...next.viewers];
    },
  };

  const behavior: RemoteBehavior = {
    listWorkspaces: async () => [workspaceRow()],
    sessionStatus: async (sessionId) => ({
      session: sessionRow({ id: sessionId }),
      workspace: workspaceRow(),
    }),
    streamStatus: async () => streamStatus(),
    startStream: async () => streamStatus(),
    sendStreamInput: async () => {},
    ensureWorkspaceLocked: async () => {},
    localRemoteHostId: null,
    ...options.behavior,
  };

  let activeRemote = createRemote(behavior, calls, listeners);

  const deps: PsbWorkspaceAdminServiceDeps = {
    resolveRemote: () => activeRemote,
    readLocalSessionRemoteHostId: async () => behavior.localRemoteHostId,
    store: createPsbAdminRecentWorkspaceStore(io),
    emitContextChanged: (event) => {
      contextEvents.push(event.context);
    },
    emitStreamEvent: (event) => {
      streamEvents.push(event);
    },
    log: { debug: () => {}, info: () => {}, warn: () => {} },
    createRequestId: () => `req-${calls.created.length + 1}`,
  };

  return {
    service: createPsbWorkspaceAdminService(deps),
    deps,
    behavior,
    contextEvents,
    streamEvents,
    createSessionCalls: calls.created,
    startStreamCalls: calls.started,
    stopStreamCalls: calls.stopped,
    inputCalls: calls.inputs,
    lockChecks: calls.lockChecks,
    storeWrites: () => writes,
    swapRemote(next) {
      Object.assign(behavior, next);
      listeners.clear();
      activeRemote = createRemote(behavior, calls, listeners);
    },
    emitStreamEvent(event) {
      for (const listener of listeners) listener(event);
    },
  };
}

/* ============================== 工作区解析 ============================== */

describe('管理页：当前工作区解析', () => {
  it('当前任务的 PSB 会话读成功（任何状态）→ 用会话的工作区，并映射占用/在线/模板/桌面会话', async () => {
    const harness = createHarness({
      behavior: { localRemoteHostId: 'psb:psb-user-session' },
    });

    const { context } = await harness.service.context({ localSessionId: 'local-1' });

    expect(context).toMatchObject({
      workspaceId: WORKSPACE_ID,
      clientName: '打包机',
      clientOnline: true,
      title: 'saga2_project',
      templateTitle: 'Saga2',
      directoryName: 'saga2_project-2',
      state: 'ready',
      occupancy: { occupied: true, byMe: true, personName: '我' },
      desktopSession: 'running',
      source: 'session',
      viewerSessionId: null,
    });
    // 最近使用记录被推进到当前工作区（页面默认对象）。
    expect(harness.deps.store.read().lastWorkspaceId).toBe(WORKSPACE_ID);
  });

  it('PSB 没给模板标题 / 只给空白时 templateTitle 归一为 null（页头省略模板段）', async () => {
    for (const templateTitle of [null, '   ']) {
      const harness = createHarness({
        behavior: {
          localRemoteHostId: 'psb:psb-user-session',
          sessionStatus: async (sessionId) => ({
            session: sessionRow({ id: sessionId }),
            workspace: workspaceRow({ templateTitle }),
          }),
        },
      });
      const { context } = await harness.service.context({ localSessionId: 'local-1' });
      expect(context?.templateTitle).toBeNull();
      // 其它字段不受影响：机器名与标题仍映射出来。
      expect(context).toMatchObject({ clientName: '打包机', title: 'saga2_project' });
    }
  });

  it('PSB 会话已终态 → 仍解析出工作区（source=session）；终态会话不当探针，读路径不建会话', async () => {
    const probes: string[] = [];
    const harness = createHarness({
      behavior: {
        localRemoteHostId: 'psb:psb-user-session',
        sessionStatus: async (sessionId) => ({
          session: sessionRow({ id: sessionId, status: 'stopped' }),
          workspace: workspaceRow(),
        }),
        streamStatus: async (sessionId) => {
          probes.push(sessionId);
          return streamStatus();
        },
      },
    });

    const { context } = await harness.service.context({ localSessionId: 'local-1' });

    expect(context).toMatchObject({
      workspaceId: WORKSPACE_ID,
      source: 'session',
      // 没有可借用的探针会话 → 桌面状态是未知，等用户显式「启动」。
      desktopSession: null,
    });
    // 终态会话读 stream/status 必被 PSB 拒：它绝不能进探针列表（白费一次必失败的请求）。
    expect(probes).not.toContain('psb-user-session');
    // 读路径**不创建 PSB 会话、不占用工作区**：写前占用闸门落地后，打开页签不能静默占用
    // 一个空闲工作区（审查发现的原实现缺陷）。
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.lockChecks).toHaveLength(0);
    expect(context?.viewerSessionId).toBeNull();
  });

  it('PSB 会话已读不到（404）→ 用本机「会话→工作区」映射兜底，页面不退化（桌面状态未知）', async () => {
    const harness = createHarness({
      behavior: {
        localRemoteHostId: 'psb:psb-user-session',
        sessionStatus: async () => {
          throw notFound();
        },
      },
      recent: {
        lastWorkspaceId: 'ws-other',
        sessions: [{ sessionId: 'psb-user-session', workspaceId: WORKSPACE_ID }],
      },
    });

    const { context } = await harness.service.context({ localSessionId: 'local-1' });

    // 工作区靠本机记录兜底；没有可用会话时桌面状态是 null（未知），**不是** none。
    expect(context).toMatchObject({
      workspaceId: WORKSPACE_ID,
      title: 'saga2_project',
      source: 'last-used',
      desktopSession: null,
    });
    expect(context?.viewerSessionId).toBeNull();
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.lockChecks).toHaveLength(0);
  });

  it('当前任务不是远程工作区会话 → 用最近使用过的远程工作区', async () => {
    const harness = createHarness({
      behavior: { localRemoteHostId: 'mcpr:instance-1' },
      recent: { lastWorkspaceId: WORKSPACE_ID },
    });

    const { context } = await harness.service.context({ localSessionId: 'local-1' });

    expect(context).toMatchObject({ workspaceId: WORKSPACE_ID, source: 'last-used' });
  });

  it('没有任何线索（无远程任务、无记录）→ context=null（页面的空提示态）', async () => {
    const harness = createHarness();
    const result = await harness.service.context({ localSessionId: null });

    expect(result.context).toBeNull();
  });

  it('PSB 暂时不可达但本机有记录 → 保留最后一次工作区快照并带上 PSB 原话', async () => {
    const harness = createHarness({ recent: { lastWorkspaceId: WORKSPACE_ID } });
    // 先成功读一次，建立「最后一次快照」。
    await harness.service.context({ localSessionId: null });

    harness.behavior.listWorkspaces = async () => {
      throw unreachable();
    };
    harness.behavior.streamStatus = async () => {
      throw unreachable();
    };

    const { context } = await harness.service.context({ localSessionId: null });

    expect(context).toMatchObject({ workspaceId: WORKSPACE_ID, source: 'last-used' });
    expect(context?.lastErrorZh).toBe('连不上 PSB');
  });

  it('记录里的工作区已不可见（被删）→ 清掉记录与内部绑定，回到空提示态', async () => {
    const harness = createHarness({ recent: { lastWorkspaceId: 'ws-deleted' } });
    // 先建立内部观看端绑定（模拟用户之前看过这个工作区，且本机记录里有它的观看端会话）。
    harness.behavior.listWorkspaces = async () => [workspaceRow({ id: 'ws-deleted' })];
    const started = await harness.service.streamStart('ws-deleted');
    expect(harness.deps.store.viewerSessionIdForWorkspace('ws-deleted')).toBe(
      started.viewerSessionId,
    );

    // 工作区被删：列表里不再有它。
    harness.behavior.listWorkspaces = async () => [];
    const result = await harness.service.context({ localSessionId: null });

    expect(result.context).toBeNull();
    expect(harness.deps.store.read().lastWorkspaceId).toBeNull();
    // 工作区不可见时连同它的观看端记录一起丢掉，避免以后拿不存在的 workspace 再去订阅。
    expect(harness.deps.store.viewerSessionIdForWorkspace('ws-deleted')).toBeNull();
  });
});

/* ============================== 上下文推送 ============================== */

describe('管理页：CONTEXT_CHANGED 推送', () => {
  it('同值不推送；占用发生变化时推一次（载荷与 invoke 结果同形）', async () => {
    const harness = createHarness({ recent: { lastWorkspaceId: WORKSPACE_ID } });

    // 第一次 invoke 只建立基线，不推送。
    await harness.service.context({ localSessionId: null });
    expect(harness.contextEvents).toHaveLength(0);
    // 读路径只推进「最近使用」这一条记录（值不变时 0 次写）；它不建会话、不写观看端记录。
    const writesAfterFirstRead = harness.storeWrites();
    expect(writesAfterFirstRead).toBe(0);
    expect(harness.deps.store.read().viewers).toEqual([]);

    // 读到同一份事实：不推送。
    await harness.service.context({ localSessionId: null });
    expect(harness.contextEvents).toHaveLength(0);

    // 别人拿走了占用：同一实例内的下一次读取必须推送。
    harness.behavior.listWorkspaces = async () => [
      workspaceRow({
        occupancy: {
          occupied: true,
          byMe: false,
          personId: '9',
          personName: '小王',
          occupiedAt: 2,
        },
      }),
    ];
    const { context } = await harness.service.context({ localSessionId: null });

    expect(harness.contextEvents).toEqual([context]);
    expect(harness.contextEvents[0]?.occupancy).toEqual({
      occupied: true,
      byMe: false,
      personName: '小王',
    });
    // 读路径不写放大：内部会话只在第一次建，之后三次读取 0 次落盘
    // （见 `adminRecentStore` 的写纪律：写入口幂等、次数不随刷新增长）。
    expect(harness.storeWrites()).toBe(writesAfterFirstRead);
  });
});

/* ============================== 内部观看端会话 ============================== */

describe('管理页：内部观看端会话', () => {
  it('本机记录里已有可复用的内部会话 → 校验后直接复用，不新建', async () => {
    const harness = createHarness({
      recent: { viewers: [{ workspaceId: WORKSPACE_ID, sessionId: 'psb-viewer-existing' }] },
      behavior: {
        sessionStatus: async (sessionId) => ({
          session: viewerSessionRow({ id: sessionId, status: 'running' }),
          workspace: workspaceRow(),
        }),
      },
    });

    const result = await harness.service.streamStart(WORKSPACE_ID);

    expect(result.viewerSessionId).toBe('psb-viewer-existing');
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(result.status).toMatchObject({ capable: true, desktopSession: 'running' });
  });

  it('记录里的内部会话已终态 → 清掉记录并新建一条（pi / 标题标记 / 幂等键）再订阅', async () => {
    const harness = createHarness({
      recent: { viewers: [{ workspaceId: WORKSPACE_ID, sessionId: 'psb-viewer-old' }] },
      behavior: {
        sessionStatus: async (sessionId) => ({
          session: viewerSessionRow({ id: sessionId, status: 'stopped' }),
          workspace: workspaceRow(),
        }),
      },
    });

    const result = await harness.service.streamStart(WORKSPACE_ID);

    expect(harness.createSessionCalls).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        agentKind: 'pi',
        title: PSB_ADMIN_VIEWER_SESSION_TITLE,
        clientRequestId: 'req-1',
      },
    ]);
    expect(result.viewerSessionId).toBe('psb-viewer-1');
    // 新建的内部会话立刻落盘，下一次启动只认这条记录（不按标题认领别人的会话）。
    expect(harness.deps.store.viewerSessionIdForWorkspace(WORKSPACE_ID)).toBe('psb-viewer-1');
    expect(harness.deps.store.read().viewers).toHaveLength(1);
  });

  it('不按标题认领陌生会话：列表里别人的 `Cindy 观看端` 不会被复用', async () => {
    // PSB 的 listSessions 含同工作区其他人的会话（title 前缀也可能撞名）；管理页端口现在
    // 根本不再列会话，只认本机记录。本用例钉住「没有任何 listSessions 调用路径」。
    const harness = createHarness();

    const result = await harness.service.streamStart(WORKSPACE_ID);

    expect(result.viewerSessionId).toBe('psb-viewer-1');
    expect(harness.createSessionCalls).toHaveLength(1);
    expect('listSessions' in harness.deps.resolveRemote()).toBe(false);
  });

  it('终态竞态（订阅时内部会话已结束）→ 重建一次内部会话并重试成功', async () => {
    let raceChecks = 0;
    const harness = createHarness({
      recent: { viewers: [{ workspaceId: WORKSPACE_ID, sessionId: 'psb-viewer-race' }] },
      behavior: {
        startStream: async (sessionId) => {
          if (sessionId === 'psb-viewer-race') throw notFound();
          return streamStatus({ active: true });
        },
        sessionStatus: async (sessionId) => {
          // 第一次（复用时）说还活着；订阅失败后的死亡确认说它已终态。
          raceChecks += 1;
          return {
            session: viewerSessionRow({
              id: sessionId,
              status: sessionId === 'psb-viewer-race' && raceChecks > 1 ? 'stopped' : 'running',
            }),
            workspace: workspaceRow(),
          };
        },
      },
    });

    const result = await harness.service.streamStart(WORKSPACE_ID);

    expect(harness.startStreamCalls).toEqual(['psb-viewer-race', 'psb-viewer-1']);
    expect(harness.createSessionCalls).toHaveLength(1);
    expect(result.viewerSessionId).toBe('psb-viewer-1');
    expect(result.status.active).toBe(true);
    expect(harness.deps.store.viewerSessionIdForWorkspace(WORKSPACE_ID)).toBe('psb-viewer-1');
  });

  it('复用时 PSB 网络失败 → 照原样上抛，不静默新建一条（启动是写路径）', async () => {
    const harness = createHarness({
      recent: { viewers: [{ workspaceId: WORKSPACE_ID, sessionId: 'psb-viewer-existing' }] },
      behavior: {
        sessionStatus: async () => {
          throw unreachable();
        },
        startStream: async () => {
          throw unreachable();
        },
      },
    });

    await expect(harness.service.streamStart(WORKSPACE_ID)).rejects.toBeInstanceOf(PsbClientError);
    expect(harness.createSessionCalls).toHaveLength(0);
    // 网络抖动不能把记录删掉（下次可能就好了）。
    expect(harness.deps.store.viewerSessionIdForWorkspace(WORKSPACE_ID)).toBe(
      'psb-viewer-existing',
    );
  });

  it('停流只停观看：内部会话保留，下一次启动直接复用（不重建远端会话）', async () => {
    const harness = createHarness({
      recent: { viewers: [{ workspaceId: WORKSPACE_ID, sessionId: 'psb-viewer-existing' }] },
    });
    await harness.service.streamStart(WORKSPACE_ID);

    await harness.service.streamStop(WORKSPACE_ID);
    expect(harness.stopStreamCalls).toEqual(['psb-viewer-existing']);

    await harness.service.streamStart(WORKSPACE_ID);
    expect(harness.createSessionCalls).toHaveLength(0);
  });

  it('启动串流前先确保工作区由自己锁定（占用闸门先于复用/建内部会话）', async () => {
    const harness = createHarness({
      recent: { viewers: [{ workspaceId: WORKSPACE_ID, sessionId: 'psb-viewer-existing' }] },
    });

    await harness.service.streamStart(WORKSPACE_ID);

    // 闸门到位，且顺序上先于内部会话（未锁定就建会话/订阅会被 PSB 拒绝）。
    expect(harness.lockChecks).toEqual([WORKSPACE_ID]);
    expect(harness.startStreamCalls).toEqual(['psb-viewer-existing']);
  });

  it('工作区被别人占用 → 拒绝启动串流，且不建内部会话、不建立订阅', async () => {
    const harness = createHarness({
      behavior: {
        ensureWorkspaceLocked: async () => {
          throw new PsbClientError(
            {
              code: 'WORKSPACE_OCCUPIED_BY_OTHER',
              messageKey: 'remoteWorkspace.error.occupiedByOther',
              message: '张三',
            },
            null,
          );
        },
      },
    });

    const error = await harness.service.streamStart(WORKSPACE_ID).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PsbClientError);
    expect((error as PsbClientError).failure.code).toBe('WORKSPACE_OCCUPIED_BY_OTHER');
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.startStreamCalls).toHaveLength(0);
  });
});

/* ============================== 交互输入 ============================== */

describe('管理页：键鼠输入转发', () => {
  it('按工作区解析到内部观看端会话后原样转发事件（不重读上下文、不落盘）', async () => {
    const harness = createHarness({
    });
    const started = await harness.service.streamStart(WORKSPACE_ID);
    const writesBeforeInput = harness.storeWrites();

    const event = { kind: 'pointermove', x: 0.5, y: 0.25 };
    await harness.service.streamInput(WORKSPACE_ID, event);

    // 会话必须是 main 解析出来的内部观看端会话，而不是渲染层传进来的任何 id。
    expect(harness.inputCalls).toEqual([{ sessionId: started.viewerSessionId, event }]);
    // 输入是高频路径：不得触发最近使用记录写入（否则每次鼠标移动都写盘）。
    expect(harness.storeWrites()).toBe(writesBeforeInput);
  });

  it('没有启动过观看 → PSB_STREAM_NOT_ACTIVE（可行动：先启动串流）而不是静默丢弃', async () => {
    const harness = createHarness();

    const error = await harness.service
      .streamInput(WORKSPACE_ID, { kind: 'keydown', key: 'a', code: 'KeyA' })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PsbClientError);
    expect((error as PsbClientError).failure).toMatchObject({
      code: 'PSB_STREAM_NOT_ACTIVE',
      messageKey: 'remoteWorkspace.session.streamIdle',
    });
    expect(harness.inputCalls).toHaveLength(0);
  });

  it('观看已断开（WS 不在 OPEN）→ 传播同一可行动失败，不吞掉', async () => {
    const disconnected = new PsbClientError(
      {
        code: 'PSB_STREAM_NOT_ACTIVE',
        messageKey: 'remoteWorkspace.session.streamIdle',
        message: null,
      },
      null,
    );
    const harness = createHarness({
      behavior: {
        sendStreamInput: async () => {
          throw disconnected;
        },
      },
    });
    await harness.service.streamStart(WORKSPACE_ID);

    await expect(
      harness.service.streamInput(WORKSPACE_ID, { kind: 'wheel', deltaY: 120 }),
    ).rejects.toBe(disconnected);
  });
});

/* ============================== 串流事件与读数 ============================== */

describe('管理页：串流事件与状态读数', () => {
  it('只转发内部观看端会话的事件，并据事件里的桌面会话状态推送上下文', async () => {
    const harness = createHarness({
    });
    const started = await harness.service.streamStart(WORKSPACE_ID);
    harness.contextEvents.length = 0;
    harness.streamEvents.length = 0;

    // 用户任务会话的事件不属于管理页通道。
    harness.emitStreamEvent({
      type: 'frame',
      sessionId: 'psb-user-session',
      payload: new ArrayBuffer(1),
    });
    expect(harness.streamEvents).toHaveLength(0);

    // 之后的 PSB 状态读数故意失败：让「事件带来的桌面会话归因」成为唯一新事实
    // （生产中 PSB 的 4004 归因就是这里唯一的即时信号）。
    harness.behavior.streamStatus = async () => {
      throw unreachable();
    };

    // 内部会话的关闭事件 → 转发 + 桌面会话状态按 PSB 结构化归因更新。
    harness.emitStreamEvent({
      type: 'closed',
      sessionId: started.viewerSessionId,
      reason: 'not-ready',
      detail: {
        reasonCode: 'NO_DESKTOP_SESSION',
        desktopSession: 'none',
        messageZh: '没有桌面会话',
      },
    });
    expect(harness.streamEvents).toHaveLength(1);

    await vi.waitFor(() => {
      expect(harness.contextEvents.at(-1)).toMatchObject({
        desktopSession: 'none',
        reasonCode: 'NO_DESKTOP_SESSION',
      });
    });
  });

  it('宿主光标形状事件按内部会话原样转发（用户任务会话的不进管理页通道）', async () => {
    const harness = createHarness({
    });
    const started = await harness.service.streamStart(WORKSPACE_ID);
    harness.streamEvents.length = 0;

    // `stream.cursor` 在 main 已由观看端校验成 `PsbStreamCursorShape`；管理页服务只负责
    // 「按内部会话过滤 + 原样转发」，不做任何状态映射（光标不是管理页状态）。
    const cursor = {
      serial: 3,
      width: 32,
      height: 32,
      xhot: 5,
      yhot: 2,
      imageBase64: 'iVBORw0KGgo',
      name: 'text',
    };
    harness.emitStreamEvent({ type: 'cursor', sessionId: started.viewerSessionId, cursor });
    expect(harness.streamEvents).toEqual([
      { type: 'cursor', sessionId: started.viewerSessionId, cursor },
    ]);

    harness.emitStreamEvent({
      type: 'cursor',
      sessionId: 'psb-user-session',
      cursor: { ...cursor, serial: 4 },
    });
    expect(harness.streamEvents).toHaveLength(1);
  });

  it('读不到 PSB 状态时 STREAM_STATUS 返回 null（不是 capable:false）', async () => {
    const harness = createHarness({
      behavior: {
        streamStatus: async () => {
          throw unreachable();
        },
      },
    });

    const result = await harness.service.streamStatus(WORKSPACE_ID);

    expect(result.status).toBeNull();
  });

  it('内部会话已终态 → STREAM_STATUS 丢掉绑定与本机记录，读路径不按需重建', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        viewers: [{ workspaceId: WORKSPACE_ID, sessionId: 'psb-viewer-existing' }],
      },
      behavior: {
        sessionStatus: async (sessionId) => ({
          session: viewerSessionRow({ id: sessionId, status: 'running' }),
          workspace: workspaceRow(),
        }),
      },
    });
    // 启动：记录里的会话还活着 → 复用（不新建）。
    const started = await harness.service.streamStart(WORKSPACE_ID);
    expect(started.viewerSessionId).toBe('psb-viewer-existing');

    // 会话落定：流式读数失败，死亡确认说它停了。
    harness.behavior.streamStatus = async () => {
      throw notFound();
    };
    harness.behavior.sessionStatus = async (sessionId) => ({
      session: viewerSessionRow({ id: sessionId, status: 'stopped' }),
      workspace: workspaceRow(),
    });
    await harness.service.streamStatus(WORKSPACE_ID);

    // 绑定与记录都必须丢掉（下次**启动**会重建；读路径不再建会话）。
    expect(harness.deps.store.viewerSessionIdForWorkspace(WORKSPACE_ID)).toBeNull();
    const { context } = await harness.service.context({ localSessionId: null });
    expect(context?.viewerSessionId).toBeNull();
    expect(harness.createSessionCalls).toHaveLength(0);
  });

  it('PSB 0.1.170 的 4404（session-not-found）→ 丢掉内部观看端绑定与本机记录', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        viewers: [{ workspaceId: WORKSPACE_ID, sessionId: 'psb-viewer-existing' }],
      },
    });
    const started = await harness.service.streamStart(WORKSPACE_ID);
    expect(started.viewerSessionId).toBe('psb-viewer-existing');

    harness.emitStreamEvent({
      type: 'closed',
      sessionId: started.viewerSessionId,
      reason: 'session-not-found',
      detail: { reasonCode: null, desktopSession: null, messageZh: '会话不存在' },
    });

    expect(harness.deps.store.viewerSessionIdForWorkspace(WORKSPACE_ID)).toBeNull();
    await vi.waitFor(async () => {
      const { context } = await harness.service.context({ localSessionId: null });
      expect(context?.viewerSessionId).toBeNull();
    });
    expect(harness.createSessionCalls).toHaveLength(0);
  });

  it('串流状态到管理页状态的映射把 PSB 拼写归一并把未知字段留 null', () => {
    // PSB 现行字段是 `capability` / `encoder` / `lastErrorZh`（契约草稿是 `capable` / `codec` /
    // `lastError`）：解析层已归一，这里钉住「映射不改语义、缺字段是未知」。
    const parsed = {
      capable: true,
      active: true,
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'h264',
      lastError: '没有正在运行的桌面会话',
      desktopSession: null,
      reasonCode: null,
    } as PsbSessionStreamStatus;

    const mapped = psbAdminStreamStatusFromPsb(parsed);

    expect(mapped).toMatchObject({
      capable: true,
      active: true,
      encoder: 'h264',
      lastErrorZh: '没有正在运行的桌面会话',
      desktopSession: null,
      reasonCode: null,
    });
  });
});

/* ==================== 工作区级状态探针（只读，不创建会话 / 不占用） ==================== */

describe('管理页：工作区级状态探针', () => {
  it('没有本机记录 / 没有可用会话 → STREAM_STATUS 返回 null，且绝不建会话、不占用工作区', async () => {
    // 审查发现：读路径按需建内部观看端会话。写前占用闸门（创建会话是工作区写操作）落地后，
    // 打开「远程工作区」页签就会静默占用一个空闲工作区。修法是读路径只借已有会话。
    const harness = createHarness({ recent: { lastWorkspaceId: WORKSPACE_ID } });

    const result = await harness.service.streamStatus(WORKSPACE_ID);

    expect(result).toEqual({ status: null, viewerSessionId: null });
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.lockChecks).toHaveLength(0);
    expect(harness.startStreamCalls).toHaveLength(0);
  });

  it('本机记录里有内部观看端会话 → 只读 HTTP 复用（不新建、不占用、不订阅）', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        viewers: [{ workspaceId: WORKSPACE_ID, sessionId: 'psb-viewer-existing' }],
      },
      behavior: {
        streamStatus: async (sessionId) => {
          expect(sessionId).toBe('psb-viewer-existing');
          return streamStatus({ active: true, desktopSession: 'running' });
        },
      },
    });

    const result = await harness.service.streamStatus(WORKSPACE_ID);

    expect(result.status).toMatchObject({ capable: true, active: true, desktopSession: 'running' });
    expect(result.viewerSessionId).toBe('psb-viewer-existing');
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.lockChecks).toHaveLength(0);
    // 只读探针：`stream/status` 是 HTTP，复用记录不代表订阅（不占观看名额）。
    expect(harness.startStreamCalls).toEqual([]);

    // 第二次读数用内存绑定，不再依赖记录查找，也不重复创建/占用。
    const second = await harness.service.streamStatus(WORKSPACE_ID);
    expect(second.viewerSessionId).toBe('psb-viewer-existing');
    expect(harness.createSessionCalls).toHaveLength(0);
  });

  it('本机记录里的内部观看端会话已终态 → 清掉记录，返回 null，不新建', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        viewers: [{ workspaceId: WORKSPACE_ID, sessionId: 'psb-viewer-dead' }],
      },
      behavior: {
        streamStatus: async () => {
          throw notFound();
        },
        sessionStatus: async (sessionId) => ({
          session: viewerSessionRow({ id: sessionId, status: 'stopped' }),
          workspace: workspaceRow(),
        }),
      },
    });

    const result = await harness.service.streamStatus(WORKSPACE_ID);

    expect(result.status).toBeNull();
    expect(harness.deps.store.viewerSessionIdForWorkspace(WORKSPACE_ID)).toBeNull();
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.lockChecks).toHaveLength(0);
  });

  it('记录里的会话读数失败但读不清死活（网络）→ status:null 且保留记录', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        viewers: [{ workspaceId: WORKSPACE_ID, sessionId: 'psb-viewer-existing' }],
      },
      behavior: {
        streamStatus: async () => {
          throw unreachable();
        },
        sessionStatus: async () => {
          throw unreachable();
        },
      },
    });

    const result = await harness.service.streamStatus(WORKSPACE_ID);

    expect(result.status).toBeNull();
    // 网络抖动不能把还能用的会话记录删掉（否则下次启动会多建一条远端会话）。
    expect(harness.deps.store.viewerSessionIdForWorkspace(WORKSPACE_ID)).toBe(
      'psb-viewer-existing',
    );
    expect(harness.createSessionCalls).toHaveLength(0);
  });

  it('adminContext 重启后首次读：用本机记录里的内部会话读出 desktopSession（不建会话）', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        viewers: [{ workspaceId: WORKSPACE_ID, sessionId: 'psb-viewer-existing' }],
      },
      behavior: {
        streamStatus: async () => streamStatus({ active: true, desktopSession: 'running' }),
      },
    });

    const { context } = await harness.service.context({ localSessionId: null });

    expect(context).toMatchObject({
      workspaceId: WORKSPACE_ID,
      source: 'last-used',
      desktopSession: 'running',
      reasonCode: null,
      viewerSessionId: 'psb-viewer-existing',
    });
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.lockChecks).toHaveLength(0);
  });

  it('adminContext 读到 none 时如实反映（不是 null，也不猜 starting）', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        viewers: [{ workspaceId: WORKSPACE_ID, sessionId: 'psb-viewer-existing' }],
      },
      behavior: {
        streamStatus: async () =>
          streamStatus({ active: false, desktopSession: 'none', reasonCode: 'NO_DESKTOP_SESSION' }),
      },
    });

    const { context } = await harness.service.context({ localSessionId: null });

    expect(context).toMatchObject({
      desktopSession: 'none',
      reasonCode: 'NO_DESKTOP_SESSION',
    });
  });

  it('工作区明确不可用（客户端离线）→ 桌面状态保持未知（不伪造 none），仍不建会话', async () => {
    const harness = createHarness({
      recent: { lastWorkspaceId: WORKSPACE_ID },
      behavior: {
        listWorkspaces: async () => [
          workspaceRow({ usable: false, unusableReason: 'client-offline' }),
        ],
      },
    });

    const { context } = await harness.service.context({ localSessionId: null });

    expect(harness.createSessionCalls).toHaveLength(0);
    expect(context).toMatchObject({ workspaceId: WORKSPACE_ID, desktopSession: null });
  });

  it('读数复用本机记录的内部会话时推送一次上下文（viewerSessionId 从 null 变为有值）', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        viewers: [{ workspaceId: WORKSPACE_ID, sessionId: 'psb-viewer-existing' }],
      },
      behavior: {
        // 第一次读：PSB 暂时不可达 → 没有绑定，基线 viewerSessionId=null。
        streamStatus: async () => {
          throw unreachable();
        },
      },
    });
    const { context } = await harness.service.context({ localSessionId: null });
    expect(context?.viewerSessionId).toBeNull();
    harness.contextEvents.length = 0;

    // PSB 恢复：读数复用记录里的内部会话（不新建），viewerSessionId 从 null 变为有值。
    harness.behavior.streamStatus = async () => streamStatus({ active: true, desktopSession: 'running' });
    const result = await harness.service.streamStatus(WORKSPACE_ID);
    expect(result.viewerSessionId).toBe('psb-viewer-existing');
    expect(harness.createSessionCalls).toHaveLength(0);

    await vi.waitFor(() => {
      expect(harness.contextEvents.at(-1)?.viewerSessionId).toBe('psb-viewer-existing');
    });
  });
});

/* ============================== 最近使用记录 ============================== */

describe('最近使用记录', () => {
  it('坏数据收敛成空记录，会话/观看端映射去重并与上限对齐', () => {
    expect(normalizePsbAdminRecentState(null)).toEqual({
      lastWorkspaceId: null,
      sessions: [],
      viewers: [],
    });
    expect(
      normalizePsbAdminRecentState({ lastWorkspaceId: '  ', sessions: 'x', viewers: {} }),
    ).toEqual({
      lastWorkspaceId: null,
      sessions: [],
      viewers: [],
    });

    const overflow = Array.from({ length: PSB_ADMIN_RECENT_SESSION_LIMIT + 8 }, (_, index) => ({
      sessionId: `s-${index}`,
      workspaceId: 'ws-1',
    }));
    const viewersOverflow = Array.from(
      { length: PSB_ADMIN_RECENT_VIEWER_LIMIT + 4 },
      (_, index) => ({ workspaceId: `ws-${index}`, sessionId: `psb-viewer-${index}` }),
    );
    const normalized = normalizePsbAdminRecentState({
      lastWorkspaceId: 'ws-1',
      sessions: [
        { sessionId: 'dup', workspaceId: 'ws-1' },
        { sessionId: 'dup', workspaceId: 'ws-2' },
        { sessionId: '', workspaceId: 'ws-1' },
        { workspaceId: 'ws-1' },
        ...overflow,
      ],
      viewers: [
        { workspaceId: 'ws-1', sessionId: 'psb-viewer-1' },
        { workspaceId: 'ws-1', sessionId: 'psb-viewer-duplicate' },
        { workspaceId: '', sessionId: 'psb-viewer-2' },
        { sessionId: 'psb-viewer-3' },
        ...viewersOverflow,
      ],
    });

    expect(normalized.lastWorkspaceId).toBe('ws-1');
    expect(normalized.sessions).toHaveLength(PSB_ADMIN_RECENT_SESSION_LIMIT);
    expect(normalized.sessions[0]).toEqual({ sessionId: 'dup', workspaceId: 'ws-1' });
    expect(normalized.viewers).toHaveLength(PSB_ADMIN_RECENT_VIEWER_LIMIT);
    // 同一工作区只保留第一条（最近的在前），坏行 / 重复工作区被丢弃。
    expect(normalized.viewers[0]).toEqual({ workspaceId: 'ws-1', sessionId: 'psb-viewer-1' });
  });

  it('写是幂等的：同值不落盘；工作区不可见时清掉指向它的会话与观看端记录', () => {
    let writes = 0;
    const file: PsbAdminRecentWorkspaceFile = { lastWorkspaceId: null, sessions: [], viewers: [] };
    const store = createPsbAdminRecentWorkspaceStore({
      read: () => file,
      write: (next) => {
        writes += 1;
        file.lastWorkspaceId = next.lastWorkspaceId;
        file.sessions = [...next.sessions];
        file.viewers = [...next.viewers];
      },
    });

    store.rememberWorkspace('ws-1');
    store.rememberWorkspace('ws-1');
    store.rememberSessionWorkspace('psb-1', 'ws-1');
    store.rememberSessionWorkspace('psb-1', 'ws-1');
    store.rememberViewerSession('ws-1', 'psb-viewer-1');
    store.rememberViewerSession('ws-1', 'psb-viewer-1');
    expect(writes).toBe(3);
    expect(store.workspaceIdForSession('psb-1')).toBe('ws-1');
    expect(store.viewerSessionIdForWorkspace('ws-1')).toBe('psb-viewer-1');

    // 换一条观看端会话：仍然幂等写（同值不再写），旧值被替换。
    store.rememberViewerSession('ws-1', 'psb-viewer-2');
    expect(writes).toBe(4);
    expect(store.viewerSessionIdForWorkspace('ws-1')).toBe('psb-viewer-2');

    store.forgetViewerSession('ws-1');
    expect(writes).toBe(5);
    expect(store.viewerSessionIdForWorkspace('ws-1')).toBeNull();
    store.forgetViewerSession('ws-1');
    expect(writes).toBe(5);

    store.forgetWorkspace('ws-1');
    expect(writes).toBe(6);
    expect(store.read()).toEqual({ lastWorkspaceId: null, sessions: [], viewers: [] });
    expect(store.workspaceIdForSession('psb-1')).toBeNull();
  });
});

/* ============================== 账号边界 ============================== */

describe('管理页：账号边界', () => {
  it('PSB 服务换实例（dispose 后重新装配）→ 丢掉旧绑定；旧账号的观看端记录不可复用时新建', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        viewers: [{ workspaceId: WORKSPACE_ID, sessionId: 'psb-viewer-old-account' }],
      },
    });
    const started = await harness.service.streamStart(WORKSPACE_ID);
    expect(started.viewerSessionId).toBe('psb-viewer-old-account');

    // 新账号看不到旧身份的 PSB 会话：记录里的 id 读不到 → 清记录（读路径不新建）。
    harness.swapRemote({
      streamStatus: async (sessionId) => {
        if (sessionId === 'psb-viewer-old-account') throw notFound();
        return streamStatus();
      },
      sessionStatus: async (sessionId) => {
        if (sessionId === 'psb-viewer-old-account') throw notFound();
        return { session: sessionRow({ id: sessionId }), workspace: workspaceRow() };
      },
    });
    const { context } = await harness.service.context({ localSessionId: null });

    expect(context?.workspaceId).toBe(WORKSPACE_ID);
    expect(context?.viewerSessionId).toBeNull();
    expect(harness.deps.store.viewerSessionIdForWorkspace(WORKSPACE_ID)).toBeNull();

    // 用户在页面上点「启动」：新建一条属于新账号的内部会话并落盘。
    const restarted = await harness.service.streamStart(WORKSPACE_ID);
    expect(restarted.viewerSessionId).toBe('psb-viewer-1');
    expect(harness.deps.store.viewerSessionIdForWorkspace(WORKSPACE_ID)).toBe('psb-viewer-1');
  });
});
