/**
 * 管理页（工作区级「远程工作区」页）的 main 侧服务与最近使用记录。
 *
 * 测试价值
 * - 生产入口与可观察结果：`createPsbWorkspaceAdminService(deps)` 是渲染层 `adminContext` /
 *   `adminStreamStart` / `adminStreamStop` / `adminStreamStatus` / `adminStreamInput` 的唯一实现；
 *   `createPsbAdminRecentWorkspaceStore(io)` 是「最近使用的远程工作区 + 观看端绑定」的唯一落点。
 *   可观察结果是：页面顶部拿到的 `PsbWorkspaceAdminContext`、观看端绑定会话 id、串流状态、
 *   以及 `CONTEXT_CHANGED` 推送。
 * - Bug／规则依据（2026-11-26 用户事故：「会话列表只装用户任务」）：PSB 0.1.172 的框架规则是
 *   **串流 / 工作区读取 / 访问起停走服务接口**，Agent 会话只装用户任务。旧实现为工作区级观看端
 *   创建标题「Cindy 观看端」的内部 pi 会话，于是 PSB 会话列表出现用户没发起过的任务。
 *   现在 `streamStart` 必须走工作区级 `POST …/workspaces/:id/stream/subscribe` 拿**桌面访问会话**
 *   id；只有该端点不可用（旧 PSB 404/405/`UNSUPPORTED`）才允许过渡回退，且必须带
 *   `purpose:'internal'` + 内部用途标题 + warn 日志。规则正本见
 *   `docs/dev-rules/psb-remote-session-transport.md` §11 / `docs/product-rules/
 *   psb-remote-workspace-sessions.md` §2.4。
 * - 现有覆盖缺口：`psbClient.test.ts` 只覆盖 HTTP 外壳与解析，`streamViewer.test.ts` 只覆盖观看端；
 *   本文件补「工作区 → 桌面访问会话绑定的状态机」（订阅 / 复用 / 失效重订阅 / 过渡回退 /
 *   读路径不建会话不订阅）与最近使用记录（新 JSON 键 `desktopSessions`）。
 * - 最小失败输入：① 无绑定启动时 mock 的订阅被调用一次且 `createSession` 未被调用；
 *   ② 订阅返回 404/405/`UNSUPPORTED`（旧服务端）→ 回退创建会话且 `purpose==='internal'`；
 *   ③ 订阅返回 409 `NO_RUNNING_SESSION` → 抛可行动错误且不建会话；④ 记录里的桌面会话
 *   `stream/status` 404 → 丢掉绑定重新订阅；⑤ 读完状态/进入页面不能出现订阅或建会话调用。
 * - 2026-11-26 独立审查（FIX-B）补的用例：多窗口 `localSessionId` 分桶（含「窗口 watchdog 重读
 *   不产生错标推送」）、写闸门 `checkedAt` / 15s 信任窗与 `NOT_FOUND` 吸收、占位身份专用
 *   `unknown-workspace` + `WORKSPACE_ID_UNKNOWN`、目录启发式命中不持久化（占用成功才落快照）、
 *   本机记录无 `version` / 快照只比固定字段 / `savedAt`-`confirmedAt` 分开 / 按时间取最新 /
 *   坏行不伪造 1970、回退内部会话失败回滚与 TTL 收尸、start-stop 串行与代次、ensure 不阻塞 +
 *   能力位缓存 + 失败原因补 detail、`context` 读会话行抛错的容错。
 * - tier：unit（进程内内存 fake，无网络 / 无 Electron / 无真实文件）。
 * - 实测耗时：单独运行 3.2s（其中 74 条用例 282ms；其余为 vitest 启动与模块加载）。
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
  PsbWorkspaceStreamSubscription,
} from '../../../shared/psb-remote-workspace';
import {
  PSB_ADMIN_INTERNAL_STREAM_SESSION_TITLE,
  psbAdminStreamStatusFromPsb,
  type PsbWorkspaceAdminContext,
  type PsbWorkspaceAdminContextChangedEvent,
} from '../../../shared/psb-workspace-admin';
import { psbIpcCodeForFailure } from '../../../shared/psb-remote-workspace';
import {
  PSB_ADMIN_RECENT_DESKTOP_SESSION_LIMIT,
  PSB_ADMIN_RECENT_SESSION_LIMIT,
  PSB_ADMIN_WORKSPACE_SNAPSHOT_LIMIT,
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
import type { PsbWorkspaceAccessEnsureOutcome } from '../psbClient';

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

function streamStatus(overrides: Partial<PsbSessionStreamStatus> = {}): PsbSessionStreamStatus {
  return {
    capability: true,
    active: false,
    width: 2560,
    height: 1440,
    fps: 60,
    encoder: 'h264',
    lastErrorZh: null,
    desktopSession: 'running',
    reasonCode: null,
    ...overrides,
  };
}

function subscription(sessionId: string): PsbWorkspaceStreamSubscription {
  return { sessionId, streamPath: null, subscriberId: null, expiresAt: null };
}

function notFound(): PsbClientError {
  return new PsbClientError(
    { code: 'NOT_FOUND', messageKey: 'remoteWorkspace.admin.staleMissingTitle', message: '会话不存在' },
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

/**
 * 新 PSB 上「没有 running 桌面访问会话」的真实形态（409 + `details.state` + 可行动中文）。
 *
 * 2026-11-26 真机：这里曾经只带 PSB 原始码，界面因此显示「操作失败，请稍后重试。」；
 * 现在 main 的客户端已把它解析成 `PSB_STREAM_NO_RUNNING_SESSION` + `streamAccessState`。
 */
function noRunningSession(
  state: 'none' | 'starting' | 'stopping' | 'stopped' | 'failed' = 'none',
): PsbClientError {
  return new PsbClientError(
    {
      code: 'PSB_STREAM_NO_RUNNING_SESSION',
      messageKey:
        state === 'starting'
          ? 'remoteWorkspace.admin.streamAccessStarting'
          : state === 'stopping'
            ? 'remoteWorkspace.admin.streamAccessStopping'
            : 'remoteWorkspace.admin.streamAccessNone',
      message: '该工作区还没有运行中的桌面访问会话，请先在 PSB 网页启动远程桌面。',
      streamAccessState: state,
    },
    409,
  );
}

/** 旧 PSB 的「端点不存在」形态（404 路由 / 405 / UNSUPPORTED）。 */
function subscribeUnavailable(
  kind: 'route-404' | 'method-405' | 'unsupported',
): PsbClientError {
  switch (kind) {
    case 'route-404':
      return new PsbClientError(
        { code: 'NOT_FOUND', messageKey: 'remoteWorkspace.admin.staleMissingTitle', message: '接口不存在' },
        404,
      );
    case 'method-405':
      return new PsbClientError(
        { code: 'HTTP_405', messageKey: 'remoteWorkspace.error.unknown', message: 'Method Not Allowed' },
        405,
      );
    case 'unsupported':
      return new PsbClientError(
        {
          code: 'UNSUPPORTED',
          messageKey: 'remoteWorkspace.error.unknown',
          message: '当前 PSB 版本不支持工作区级串流订阅',
        },
        400,
      );
  }
}

/* ============================== harness ============================== */

/** 可变的 PSB 行为：测试中途改它就等于「PSB 的事实变了」，不必重建服务实例。 */
interface RemoteBehavior {
  listWorkspaces: () => Promise<PsbRemoteWorkspace[]>;
  sessionStatus: (sessionId: string) => Promise<PsbSessionStatusResult>;
  streamStatus: (sessionId: string) => Promise<PsbSessionStreamStatus>;
  startStream: (sessionId: string) => Promise<PsbSessionStreamStatus>;
  /**
   * 停止观看（生产 = 观看端 `stop`，会**同步**补发 `closed(client-stopped)`）。
   * 单测用它模拟「内部收尸补发的 closed」是否被误转发（2026-11-27 复审 P1）。
   */
  stopStream?: (sessionId: string) => Promise<void> | void;
  /** 输入转发（默认成功；抛错用来模拟「WS 已断」）。 */
  sendStreamInput: (sessionId: string, event: Record<string, unknown>) => Promise<void>;
  /** 工作区级串流订阅（默认成功，返回 `desktop-<n>`；抛错用来模拟旧 PSB / 409）。 */
  subscribeWorkspaceStream: (workspaceId: string) => Promise<PsbWorkspaceStreamSubscription>;
  /** 建会话（缺省 = 成功的内部会话；只在过渡回退路径会被调用）。 */
  createSession?: (input: PsbCreateSessionRequest) => Promise<PsbCreateSessionResult>;
  /** 结束 PSB 会话（过渡回退内部会话收尸；缺省成功并记录调用）。 */
  stopSession?: (sessionId: string) => Promise<void>;
  /**
   * 写操作前的占用闸门（生产 = `PsbRemoteService.ensureWorkspaceLocked`）。
   * 缺省成功；抛错用来模拟「被别人占用 / 离线 / 未就绪 / 已删除」。
   */
  ensureWorkspaceLocked: (workspaceId: string) => Promise<void>;
  /**
   * 订阅前尽力拉起桌面访问（生产 = `PsbRemoteService.ensureWorkspaceAccess`）。
   * 缺省 = 「Cindy 入口未开放」（PSB 白名单还没放行 `/api/remote/**`）；单测用它断言
   * 「ensure 在订阅之前发起」与「失败不阻断订阅」。
   */
  ensureWorkspaceAccess?: (workspaceId: string) => Promise<PsbWorkspaceAccessEnsureOutcome>;
  /**
   * 某个本地任务行对应的 PSB 会话身份（缺省 = `localRemoteHostId`）。
   * 多窗口测试用它让不同窗口的任务指向不同工作区。
   */
  localRemoteHostIdForSession?: (localSessionId: string) => string | null;
  localRemoteHostId: string | null;
}

interface Harness {
  readonly service: PsbWorkspaceAdminService;
  readonly deps: PsbWorkspaceAdminServiceDeps;
  readonly behavior: RemoteBehavior;
  readonly contextEvents: (PsbWorkspaceAdminContext | null)[];
  /** 完整推送载荷（含 `localSessionId`；多窗口分桶断言用）。 */
  readonly contextChangedEvents: PsbWorkspaceAdminContextChangedEvent[];
  readonly streamEvents: PsbStreamEvent[];
  /** 过渡回退创建的会话请求（断言 `purpose:'internal'` 与标题）。 */
  readonly createSessionCalls: PsbCreateSessionRequest[];
  /** 工作区级订阅调用（断言复用：重复 start 只订阅一次）。 */
  readonly subscribeCalls: string[];
  readonly startStreamCalls: string[];
  readonly stopStreamCalls: string[];
  /** 被结束的 PSB 会话（过渡回退内部会话收尸）。 */
  readonly stoppedSessionCalls: string[];
  /** 转发给观看端的输入（会话 id + 事件；断言「解析到哪条会话」）。 */
  readonly inputCalls: Array<{ sessionId: string; event: Record<string, unknown> }>;
  /** 占用闸门的调用顺序（工作区 id；断言「启动串流前先确保锁定」）。 */
  readonly lockChecks: string[];
  /** 订阅前「尽力拉起桌面访问」的调用顺序（断言它发生在订阅之前）。 */
  readonly ensureAccessCalls: string[];
  /** warn 日志（断言过渡回退被记录；正常路径不应有回退类 warn）。 */
  readonly warnings: Array<{ message: string; fields?: Record<string, unknown> }>;
  /** info 日志（断言启发式匹配记了 `inferred`）。 */
  readonly infos: Array<{ message: string; fields?: Record<string, unknown> }>;
  readonly storeWrites: () => number;
  /** 模拟账号边界：换成一个新的 PSB 服务实例。 */
  swapRemote(behavior: Partial<RemoteBehavior>): void;
  /** 触发一条观看端绑定的串流事件（生产 = 观看端 emit）。 */
  emitStreamEvent(event: PsbStreamEvent): void;
}

interface HarnessOptions {
  behavior?: Partial<RemoteBehavior>;
  recent?: Partial<PsbAdminRecentWorkspaceFile>;
  /** 模拟旧装配 / 旧 fake：端口上**没有** `ensureWorkspaceAccess`（可选方法）。 */
  withoutAccessEnsure?: boolean;
  /** 可注入时钟（TTL / 时间戳断言）；缺省真实时间。 */
  now?: () => number;
}

/** 一次运行里记录下来的 PSB 动作（断言「有没有建会话」「订阅了几次」）。 */
interface RemoteCalls {
  created: PsbCreateSessionRequest[];
  subscribed: string[];
  started: string[];
  stopped: string[];
  stoppedSessions: string[];
  inputs: Array<{ sessionId: string; event: Record<string, unknown> }>;
  lockChecks: string[];
  ensureAccess: string[];
}

function createRemote(
  behavior: RemoteBehavior,
  calls: RemoteCalls,
  listeners: Set<(event: PsbStreamEvent) => void>,
  withoutAccessEnsure = false,
): PsbAdminRemotePort {
  return {
    listWorkspaces: () => behavior.listWorkspaces(),
    sessionStatus: (sessionId) => behavior.sessionStatus(sessionId),
    subscribeWorkspaceStream: async (workspaceId) => {
      calls.subscribed.push(workspaceId);
      return behavior.subscribeWorkspaceStream(workspaceId);
    },
    createSession: async (input) => {
      calls.created.push(input);
      if (behavior.createSession) return behavior.createSession(input);
      const session = sessionRow({
        id: `internal-${calls.created.length}`,
        title: input.title ?? null,
        agentKind: 'pi',
      });
      return { session, workspace: workspaceRow() };
    },
    stopSession: async (sessionId) => {
      calls.stoppedSessions.push(sessionId);
      if (behavior.stopSession) await behavior.stopSession(sessionId);
    },
    getStreamStatus: (sessionId) => behavior.streamStatus(sessionId),
    startStream: async (sessionId) => {
      calls.started.push(sessionId);
      return behavior.startStream(sessionId);
    },
    stopStream: async (sessionId) => {
      calls.stopped.push(sessionId);
      await behavior.stopStream?.(sessionId);
    },
    sendStreamInput: async (sessionId, event) => {
      calls.inputs.push({ sessionId, event });
      await behavior.sendStreamInput(sessionId, event);
    },
    ensureWorkspaceLocked: async (workspaceId) => {
      calls.lockChecks.push(workspaceId);
      await behavior.ensureWorkspaceLocked(workspaceId);
    },
    ...(withoutAccessEnsure || !behavior.ensureWorkspaceAccess
      ? {}
      : {
          ensureWorkspaceAccess: async (workspaceId: string) => {
            calls.ensureAccess.push(workspaceId);
            return behavior.ensureWorkspaceAccess!(workspaceId);
          },
        }),
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
  const contextChangedEvents: PsbWorkspaceAdminContextChangedEvent[] = [];
  const streamEvents: PsbStreamEvent[] = [];
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const infos: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const calls: RemoteCalls = {
    created: [],
    subscribed: [],
    started: [],
    stopped: [],
    stoppedSessions: [],
    inputs: [],
    lockChecks: [],
    ensureAccess: [],
  };
  const listeners = new Set<(event: PsbStreamEvent) => void>();
  const recent: PsbAdminRecentWorkspaceFile = {
    lastWorkspaceId: null,
    sessions: [],
    desktopSessions: [],
    workspaceSnapshots: [],
    ...options.recent,
    ...(options.recent?.sessions ? { sessions: [...options.recent.sessions] } : {}),
    ...(options.recent?.desktopSessions
      ? { desktopSessions: [...options.recent.desktopSessions] }
      : {}),
    ...(options.recent?.workspaceSnapshots
      ? { workspaceSnapshots: [...options.recent.workspaceSnapshots] }
      : {}),
  };
  let writes = 0;
  const io: PsbAdminRecentWorkspaceIo = {
    read: () => recent,
    write: (next) => {
      writes += 1;
      recent.lastWorkspaceId = next.lastWorkspaceId;
      recent.sessions = [...next.sessions];
      recent.desktopSessions = [...next.desktopSessions];
      recent.workspaceSnapshots = [...(next.workspaceSnapshots ?? [])];
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
    subscribeWorkspaceStream: async () => subscription(`desktop-${calls.subscribed.length}`),
    ensureWorkspaceLocked: async () => {},
    // 生产现状：PSB 白名单还没放行 Cindy 的 `/api/remote/**`，所以「尽力拉起」恒为非致命
    // `cindy-entry-not-open`。默认就按这个真实形态跑，避免单测里假装「能拉起」。
    ...(options.withoutAccessEnsure === true
      ? {}
      : {
          ensureWorkspaceAccess: async (): Promise<PsbWorkspaceAccessEnsureOutcome> => ({
            ok: false,
            reason: 'cindy-entry-not-open',
            failure: null,
          }),
        }),
    localRemoteHostId: null,
    ...options.behavior,
  };

  let activeRemote = createRemote(behavior, calls, listeners, options.withoutAccessEnsure === true);

  const deps: PsbWorkspaceAdminServiceDeps = {
    resolveRemote: () => activeRemote,
    readLocalSessionRemoteHostId: async (localSessionId) =>
      behavior.localRemoteHostIdForSession
        ? behavior.localRemoteHostIdForSession(localSessionId)
        : behavior.localRemoteHostId,
    store: createPsbAdminRecentWorkspaceStore(io),
    emitContextChanged: (event) => {
      contextChangedEvents.push(event);
      contextEvents.push(event.context);
    },
    emitStreamEvent: (event) => {
      streamEvents.push(event);
    },
    log: {
      debug: () => {},
      info: (message, fields) => {
        infos.push({ message, fields });
      },
      warn: (message, fields) => {
        warnings.push({ message, fields });
      },
    },
    createRequestId: () => `req-${calls.created.length + 1}`,
    ...(options.now ? { now: options.now } : {}),
  };

  return {
    service: createPsbWorkspaceAdminService(deps),
    deps,
    behavior,
    contextEvents,
    contextChangedEvents,
    streamEvents,
    createSessionCalls: calls.created,
    subscribeCalls: calls.subscribed,
    startStreamCalls: calls.started,
    stopStreamCalls: calls.stopped,
    stoppedSessionCalls: calls.stoppedSessions,
    inputCalls: calls.inputs,
    lockChecks: calls.lockChecks,
    ensureAccessCalls: calls.ensureAccess,
    warnings,
    infos,
    storeWrites: () => writes,
    swapRemote(next) {
      Object.assign(behavior, next);
      listeners.clear();
      activeRemote = createRemote(behavior, calls, listeners, options.withoutAccessEnsure === true);
    },
    emitStreamEvent(event) {
      for (const listener of listeners) listener(event);
    },
  };
}

/* ============================== 工作区解析 ============================== */

describe('管理页：当前工作区解析', () => {
  it('当前任务的 PSB 会话读成功（任何状态）→ 用会话的工作区，并映射占用/在线/模板', async () => {
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
      // 还没有观看端绑定：桌面状态是未知（`null`），不是 `none`。
      desktopSession: null,
      source: 'session',
      viewerSessionId: null,
    });
    // 最近使用记录被推进到当前工作区（页面默认对象）。
    expect(harness.deps.store.read().lastWorkspaceId).toBe(WORKSPACE_ID);
    // 读路径不订阅、不建会话、不占用（打开页签不能变成工作区写操作）。
    expect(harness.subscribeCalls).toHaveLength(0);
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.lockChecks).toHaveLength(0);
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

  it('PSB 会话已终态 → 仍解析出工作区（source=session）；不用它当读口、不建会话', async () => {
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
      // 没有观看端绑定 → 桌面状态未知，等用户显式「启动」建立绑定。
      desktopSession: null,
    });
    // 用户任务的 agent 会话**不再**被借来读 stream/status（PSB 0.1.172：新代码只走工作区级绑定）。
    expect(probes).toHaveLength(0);
    expect(context?.viewerSessionId).toBeNull();
    expect(harness.subscribeCalls).toHaveLength(0);
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.lockChecks).toHaveLength(0);
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

  it('记录里的工作区已不可见（被删）→ 页面仍显示固定信息（stale/missing），只清易变记录', async () => {
    const harness = createHarness({ recent: { lastWorkspaceId: 'ws-deleted' } });
    // 页面先实时读一次（固定信息落盘），再建立观看端绑定（模拟用户之前启动过这个工作区的观看）。
    harness.behavior.listWorkspaces = async () => [workspaceRow({ id: 'ws-deleted' })];
    await harness.service.context({ localSessionId: null });
    const started = await harness.service.streamStart('ws-deleted');
    expect(harness.deps.store.desktopSessionIdForWorkspace('ws-deleted')).toBe(
      started.viewerSessionId,
    );
    expect(harness.deps.store.workspaceSnapshot('ws-deleted')?.title).toBe('saga2_project');

    // 工作区被删：列表里不再有它。
    harness.behavior.listWorkspaces = async () => [];
    const result = await harness.service.context({ localSessionId: null });

    // 2026-11-26 真机事故口径：不能退化成「还没有远程工作区」；固定信息（名称 / 模板 / 机器）
    // 仍要显示，只是状态不可信。
    expect(result.context).toMatchObject({
      workspaceId: 'ws-deleted',
      title: 'saga2_project',
      templateTitle: 'Saga2',
      clientName: '打包机',
      stale: true,
      availability: 'missing',
      staleReason: 'workspace-missing',
      source: 'last-used',
      desktopSession: null,
      viewerSessionId: null,
    });
    // 「最近使用」与固定信息快照保留：下次打开仍能显示「当初是哪个工作区」。
    expect(harness.deps.store.read().lastWorkspaceId).toBe('ws-deleted');
    expect(harness.deps.store.workspaceSnapshot('ws-deleted')).not.toBeNull();
    // 工作区不可见时丢掉指向它的**易变**记录（会话映射 + 观看端绑定），避免拿不存在的
    // workspace 再去订阅。
    expect(harness.deps.store.desktopSessionIdForWorkspace('ws-deleted')).toBeNull();
    // 再次读取仍是同一条 stale/missing（知道工作区「已不可见」，不会因为丢失映射退化成
    // 「暂时连不上」：原因不同，用户下一步也不同）。
    const again = await harness.service.context({ localSessionId: null });
    expect(again.context).toMatchObject({
      workspaceId: 'ws-deleted',
      stale: true,
      availability: 'missing',
      staleReason: 'workspace-missing',
    });
    // 读路径仍然不订阅、不建会话、不占用。
    expect(harness.subscribeCalls).toHaveLength(1);
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.lockChecks).toHaveLength(1);
  });

  it('固定信息快照：live 读取写入、PSB 读不到时用快照构造 stale 上下文（名称/模板/机器不变）', async () => {
    const harness = createHarness({ recent: { lastWorkspaceId: WORKSPACE_ID } });
    await harness.service.context({ localSessionId: null });
    const snapshot = harness.deps.store.workspaceSnapshot(WORKSPACE_ID);
    expect(snapshot).toMatchObject({
      workspaceId: WORKSPACE_ID,
      title: 'saga2_project',
      templateTitle: 'Saga2',
      clientName: '打包机',
      directoryName: 'saga2_project-2',
    });
    expect(typeof snapshot?.savedAt).toBe('string');
    expect(typeof snapshot?.confirmedAt).toBe('string');
    // 快照只存固定字段：在线 / 工作区状态是易变信息，不落盘（2026-11-26 审查）。
    expect(snapshot).not.toHaveProperty('clientOnline');
    expect(snapshot).not.toHaveProperty('state');

    // PSB 不可达：不再依赖任何内存状态（模拟应用重启后的第一次读取）。
    harness.behavior.listWorkspaces = async () => {
      throw unreachable();
    };
    const restarted = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        workspaceSnapshots: snapshot ? [snapshot] : [],
      },
      behavior: {
        listWorkspaces: async () => {
          throw unreachable();
        },
      },
    });
    const { context } = await restarted.service.context({ localSessionId: null });

    expect(context).toMatchObject({
      workspaceId: WORKSPACE_ID,
      title: 'saga2_project',
      templateTitle: 'Saga2',
      clientName: '打包机',
      stale: true,
      availability: 'unavailable',
      staleReason: 'list-failed',
      snapshotSavedAt: snapshot?.savedAt,
      source: 'last-used',
      // 状态类信息不猜：占用 / 桌面会话都是未知。
      desktopSession: null,
      viewerSessionId: null,
    });
    expect(context?.lastErrorZh).toBe('连不上 PSB');
    // stale 时读路径不再拿绑定去试探 PSB（没有绑定；也不订阅 / 不占用）。
    expect(restarted.subscribeCalls).toHaveLength(0);
    expect(restarted.lockChecks).toHaveLength(0);
  });

  it('历史会话兜底：匹配不到实时工作区时名称用目录名（不是任务标题），为 stale/unavailable', async () => {
    const harness = createHarness({
      behavior: {
        localRemoteHostId: 'psb:psb-legacy',
        sessionStatus: async () => {
          throw notFound();
        },
        // 列表可用但没有同目录工作区（默认行的目录是 saga2_project-2）。
      },
    });
    // 本机会话行只留下标题与 `/psb-remote/<目录>` 虚拟工作目录（历史数据没有快照）。
    harness.deps.readLocalSessionHint = async () => ({
      remoteHostId: 'psb:psb-legacy',
      title: '修一下检出脚本',
      workingDir: '/psb-remote/saga2_project-9',
    });

    const { context } = await harness.service.context({ localSessionId: 'local-legacy' });

    expect(context).toMatchObject({
      // 真机复验修正：任务标题不是工作区名称；名称退回目录名，模板/机器留空不编造。
      title: 'saga2_project-9',
      directoryName: 'saga2_project-9',
      stale: true,
      availability: 'unavailable',
      // 占位身份（连工作区 id 都没有）用专门原因，不复用「PSB 读不到」。
      staleReason: 'unknown-workspace',
      workspaceIdKnown: false,
      source: 'session',
      templateTitle: null,
      clientName: '',
      desktopSession: null,
    });
    expect(context?.title).not.toBe('修一下检出脚本');
    // 占位身份：不能用它去占用 / 启动串流（写操作闸门直接给可行动失败）。
    expect(context?.workspaceId).toBe('psb:psb-legacy');
    expect(harness.subscribeCalls).toHaveLength(0);
    expect(harness.lockChecks).toHaveLength(0);
  });

  it('历史会话（会话详情 404、无快照/映射）→ 用目录名匹配实时列表，匹配到即按 live 渲染（不持久化）', async () => {
    const harness = createHarness({
      behavior: {
        localRemoteHostId: 'psb:psb-legacy',
        sessionStatus: async () => {
          throw notFound();
        },
        listWorkspaces: async () => [
          workspaceRow({ id: 'ws-matched', title: 'saga2_project', directoryName: 'saga2_project-9' }),
        ],
      },
    });
    harness.deps.readLocalSessionHint = async () => ({
      remoteHostId: 'psb:psb-legacy',
      title: '修一下检出脚本',
      workingDir: '/psb-remote/saga2_project-9',
    });

    const { context } = await harness.service.context({ localSessionId: 'local-legacy' });

    // 服务器通畅时走服务器：名称 / 模板 / 机器 / 占用全部来自实时工作区行，不是降级种子。
    expect(context).toMatchObject({
      workspaceId: 'ws-matched',
      title: 'saga2_project',
      templateTitle: 'Saga2',
      clientName: '打包机',
      directoryName: 'saga2_project-9',
      stale: false,
      availability: 'live',
      workspaceIdKnown: true,
      occupancy: { occupied: true, byMe: true, personName: '我' },
      source: 'session',
    });
    // 2026-11-26 审查：目录 / title 匹配是**启发式**，猜对了可以展示，猜错了不能持久化
    // （否则这个任务以后永远指向别人的工作区）。结果只留内存并记 `inferred` 日志。
    expect(harness.deps.store.workspaceIdForSession('psb-legacy')).toBeNull();
    expect(harness.deps.store.workspaceSnapshot('ws-matched')).toBeNull();
    expect(harness.deps.store.read().lastWorkspaceId).toBeNull();
    expect(
      harness.infos.some(
        (entry) =>
          entry.fields?.['inferred'] === true &&
          entry.fields?.['workspaceId'] === 'ws-matched',
      ),
    ).toBe(true);
    // 读路径仍不订阅 / 不占用。
    expect(harness.lockChecks).toHaveLength(0);
    expect(harness.subscribeCalls).toHaveLength(0);
  });

  it('目录名匹配也认工作区 title（真机 `saga2_project` 形状）与 clientPath basename', async () => {
    // 真机：workingDir=/psb-remote/saga2_project，而列表行的 directoryName 带后缀
    // （saga2_project-2）、title 才是 saga2_project。三种拼写都算同一个工作区。
    const harness = createHarness({
      behavior: {
        localRemoteHostId: 'psb:psb-legacy',
        sessionStatus: async () => {
          throw notFound();
        },
        listWorkspaces: async () => [
          workspaceRow({
            id: 'ws-title-match',
            title: 'saga2_project',
            directoryName: 'saga2_project-2',
            clientPath: 'D:\\psb\\saga2_project-2',
          }),
        ],
      },
    });
    harness.deps.readLocalSessionHint = async () => ({
      remoteHostId: 'psb:psb-legacy',
      title: '联调测试只回复OK',
      workingDir: '/psb-remote/saga2_project',
    });

    const { context } = await harness.service.context({ localSessionId: 'local-legacy' });

    expect(context).toMatchObject({
      workspaceId: 'ws-title-match',
      title: 'saga2_project',
      stale: false,
      availability: 'live',
      source: 'session',
    });
  });

  it('历史会话目录匹配时，会话详情可读则优先用详情里的工作区 id（精确匹配）', async () => {
    const harness = createHarness({
      behavior: {
        localRemoteHostId: 'psb:psb-legacy',
        sessionStatus: async (sessionId) => ({
          session: sessionRow({ id: sessionId, status: 'stopped' }),
          workspace: workspaceRow({ id: 'ws-from-detail', title: 'detail-workspace' }),
        }),
        // 列表里另有同目录工作区：不能把它当成会话所属工作区。
        listWorkspaces: async () => [
          workspaceRow({ id: 'ws-listed', directoryName: 'saga2_project-9' }),
        ],
      },
    });
    harness.deps.readLocalSessionHint = async () => ({
      remoteHostId: 'psb:psb-legacy',
      title: '修一下检出脚本',
      workingDir: '/psb-remote/saga2_project-9',
    });

    const { context } = await harness.service.context({ localSessionId: 'local-legacy' });

    expect(context).toMatchObject({
      workspaceId: 'ws-from-detail',
      title: 'detail-workspace',
      stale: false,
      source: 'session',
    });
  });

  it('历史会话目录匹配遇到列表读失败 → stale/unavailable（带 list-failed 归因与原话）', async () => {
    const harness = createHarness({
      behavior: {
        localRemoteHostId: 'psb:psb-legacy',
        sessionStatus: async () => {
          throw notFound();
        },
        listWorkspaces: async () => {
          throw unreachable();
        },
      },
    });
    harness.deps.readLocalSessionHint = async () => ({
      remoteHostId: 'psb:psb-legacy',
      title: '修一下检出脚本',
      workingDir: '/psb-remote/saga2_project-9',
    });

    const { context } = await harness.service.context({ localSessionId: 'local-legacy' });

    expect(context).toMatchObject({
      title: 'saga2_project-9',
      stale: true,
      availability: 'unavailable',
      // 占位身份：没有 PSB 给出的 workspace id，专门原因（不是 list-failed 家族）。
      staleReason: 'unknown-workspace',
      workspaceIdKnown: false,
    });
    expect(context?.lastErrorZh).toBe('连不上 PSB');
  });

  it('stale 时启动串流直接给可行动失败（不先打占用闸门、不订阅）', async () => {
    const harness = createHarness({ recent: { lastWorkspaceId: WORKSPACE_ID } });
    await harness.service.context({ localSessionId: null });
    harness.behavior.listWorkspaces = async () => {
      throw unreachable();
    };
    const stale = await harness.service.context({ localSessionId: null });
    expect(stale.context?.stale).toBe(true);

    const error = await harness.service
      .streamStart(WORKSPACE_ID)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PsbClientError);
    expect((error as PsbClientError).failure).toMatchObject({
      code: 'WORKSPACE_UNREACHABLE',
      messageKey: 'remoteWorkspace.admin.staleUnavailableAction',
      // 失败 detail 只放 PSB 原文，main 不再写中文兜底句。
      message: '连不上 PSB',
    });
    // 不再先打占用闸门 / 订阅：用户马上拿到「连不上」的可行动原因。
    expect(harness.lockChecks).toHaveLength(0);
    expect(harness.subscribeCalls).toHaveLength(0);
  });
});

/* ============================== 上下文推送 ============================== */

describe('管理页：CONTEXT_CHANGED 推送', () => {
  it('同值不推送；占用发生变化时推一次（载荷与 invoke 结果同形）', async () => {
    const harness = createHarness({ recent: { lastWorkspaceId: WORKSPACE_ID } });
    // 推送只对**有任务线索**的桶生效（2026-11-27 审查 s2 P1：兜底桶不广播，见下一条用例）。
    const localSessionId = 'local-task-1';

    // 第一次 invoke 只建立基线，不推送。
    await harness.service.context({ localSessionId });
    expect(harness.contextEvents).toHaveLength(0);
    // 第一次实时读取会落一次固定信息快照（新增写入点）；此后同值读取 0 次写，不随轮询放大。
    const writesAfterFirstRead = harness.storeWrites();
    expect(writesAfterFirstRead).toBe(1);
    expect(harness.deps.store.workspaceSnapshot(WORKSPACE_ID)).toMatchObject({
      workspaceId: WORKSPACE_ID,
      title: 'saga2_project',
      templateTitle: 'Saga2',
      clientName: '打包机',
    });
    expect(harness.deps.store.read().desktopSessions).toEqual([]);

    // 读到同一份事实：不推送、不重复落盘。
    await harness.service.context({ localSessionId });
    expect(harness.contextEvents).toHaveLength(0);
    expect(harness.storeWrites()).toBe(writesAfterFirstRead);

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
    const { context } = await harness.service.context({ localSessionId });

    expect(harness.contextEvents).toEqual([context]);
    expect(harness.contextChangedEvents[0]?.localSessionId).toBe(localSessionId);
    expect(harness.contextEvents[0]?.occupancy).toEqual({
      occupied: true,
      byMe: false,
      personName: '小王',
    });
    // 读路径不写放大：三次读取 0 次落盘。
    expect(harness.storeWrites()).toBe(writesAfterFirstRead);
  });

  // 2026-11-27 审查 s2 P1（NULL 桶覆盖有任务窗口）：没有任务线索的上下文不广播。
  // 最小失败输入：兜底桶在事实变化后 emit → 所有窗口（含有任务窗口）收到一份「没有任务」的
  // 上下文并覆盖自己的页面状态。这里断言兜底桶无论基线是否建立都不产生推送。
  it('无任务线索的兜底桶只建基线、不广播（不覆盖有任务的窗口）', async () => {
    const harness = createHarness({ recent: { lastWorkspaceId: WORKSPACE_ID } });

    await harness.service.context({ localSessionId: null });
    harness.contextChangedEvents.length = 0;

    // 事实变了：兜底桶重读也不推送（只回 invoke 结果）。
    harness.behavior.listWorkspaces = async () => [
      workspaceRow({
        occupancy: { occupied: true, byMe: false, personId: '9', personName: '小王', occupiedAt: 2 },
      }),
    ];
    const result = await harness.service.context({ localSessionId: null });
    expect(result.context?.occupancy).toMatchObject({ byMe: false, personName: '小王' });
    expect(harness.contextChangedEvents).toHaveLength(0);
  });
});

/* ==================== 启动串流：工作区级订阅（不建 Agent 会话） ==================== */

describe('管理页：启动串流走工作区级订阅', () => {
  it('无绑定启动 → 订阅一次、用桌面访问会话 id 起观看端、不调用 createSession', async () => {
    const harness = createHarness();

    const result = await harness.service.streamStart(WORKSPACE_ID);

    // 生产入口的真实副作用：订阅工作区 → 用返回的桌面访问会话 id 订阅串流。
    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID]);
    expect(harness.startStreamCalls).toEqual(['desktop-1']);
    expect(result.viewerSessionId).toBe('desktop-1');
    expect(result.status).toMatchObject({ capability: true, desktopSession: 'running' });
    // 关键红线：没有任何 Agent 会话被创建。
    expect(harness.createSessionCalls).toHaveLength(0);
    // 绑定持久化：重启后靠它只读地读状态。
    expect(harness.deps.store.desktopSessionIdForWorkspace(WORKSPACE_ID)).toBe('desktop-1');
    expect(harness.deps.store.read().desktopSessions).toHaveLength(1);
  });

  it('启动串流前先确保工作区由自己锁定（占用闸门先于订阅）', async () => {
    const harness = createHarness();

    await harness.service.streamStart(WORKSPACE_ID);

    expect(harness.lockChecks).toEqual([WORKSPACE_ID]);
    // 顺序由 `streamStart` 的实现保证：闸门失败时订阅不会被调用（见下一个用例）。
    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID]);
  });

  it('工作区被别人占用 → 拒绝启动，不订阅、不建会话', async () => {
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
    expect(harness.subscribeCalls).toHaveLength(0);
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.startStreamCalls).toHaveLength(0);
  });

  it('重复「启动」复用同一条桌面访问会话（只订阅一次、也不重连观看端）', async () => {
    const harness = createHarness();

    const first = await harness.service.streamStart(WORKSPACE_ID);
    const second = await harness.service.streamStart(WORKSPACE_ID);

    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID]);
    // 2026-11-27 复审 P1：已有健康观看连接时**复用**（不再 `startStream` 重连）。重连会原子
    // 替换旧连接并补发 closed(superseded)，多窗口时等于把第一个窗口的观看判成终止。
    expect(harness.startStreamCalls).toEqual(['desktop-1']);
    expect(second.viewerSessionId).toBe(first.viewerSessionId);
    expect(harness.createSessionCalls).toHaveLength(0);
  });

  it('并发「启动」共享一次订阅（不会订阅出两条绑定）', async () => {
    const harness = createHarness();

    const [a, b] = await Promise.all([
      harness.service.streamStart(WORKSPACE_ID),
      harness.service.streamStart(WORKSPACE_ID),
    ]);

    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID]);
    expect(new Set([a.viewerSessionId, b.viewerSessionId])).toEqual(new Set(['desktop-1']));
    expect(harness.createSessionCalls).toHaveLength(0);
  });

  it('重启后（只有本机记录）→ 先确认绑定还能读，再复用它起观看端（不重新订阅）', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        desktopSessions: [{ workspaceId: WORKSPACE_ID, sessionId: 'desktop-existing' }],
      },
      behavior: {
        streamStatus: async (sessionId) => {
          expect(sessionId).toBe('desktop-existing');
          return streamStatus({ active: true, desktopSession: 'running' });
        },
      },
    });

    const result = await harness.service.streamStart(WORKSPACE_ID);

    expect(result.viewerSessionId).toBe('desktop-existing');
    expect(harness.startStreamCalls).toEqual(['desktop-existing']);
    expect(harness.subscribeCalls).toHaveLength(0);
    expect(harness.createSessionCalls).toHaveLength(0);
  });

  it('绑定已失效（桌面访问被重建）→ 丢掉旧绑定、重新订阅、用新 id 起观看端', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        desktopSessions: [{ workspaceId: WORKSPACE_ID, sessionId: 'desktop-old' }],
      },
      behavior: {
        streamStatus: async (sessionId) => {
          if (sessionId === 'desktop-old') throw notFound();
          return streamStatus();
        },
      },
    });

    const result = await harness.service.streamStart(WORKSPACE_ID);

    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID]);
    expect(harness.startStreamCalls).toEqual(['desktop-1']);
    expect(result.viewerSessionId).toBe('desktop-1');
    expect(harness.deps.store.desktopSessionIdForWorkspace(WORKSPACE_ID)).toBe('desktop-1');
    expect(harness.createSessionCalls).toHaveLength(0);
  });

  it('起观看端时绑定刚好失效（终态竞态）→ 确认失效后重新订阅一次并重试', async () => {
    let streamStarts = 0;
    const harness = createHarness({
      behavior: {
        startStream: async (sessionId) => {
          streamStarts += 1;
          if (sessionId === 'desktop-1') {
            throw new PsbClientError(
              {
                code: 'PSB_STREAM_NOT_READY',
                messageKey: 'remoteWorkspace.error.unknown',
                message: '会话未就绪',
              },
              409,
            );
          }
          return streamStatus({ active: true });
        },
      },
    });

    const result = await harness.service.streamStart(WORKSPACE_ID);

    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID, WORKSPACE_ID]);
    expect(harness.startStreamCalls).toEqual(['desktop-1', 'desktop-2']);
    expect(result.viewerSessionId).toBe('desktop-2');
    expect(result.status.active).toBe(true);
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.deps.store.desktopSessionIdForWorkspace(WORKSPACE_ID)).toBe('desktop-2');
    expect(streamStarts).toBe(2);
  });

  it('起观看端时网络失败 → 原样上抛，不重新订阅（重试只会重放同一个失败）', async () => {
    const harness = createHarness({
      behavior: {
        startStream: async () => {
          throw unreachable();
        },
      },
    });

    await expect(harness.service.streamStart(WORKSPACE_ID)).rejects.toBeInstanceOf(PsbClientError);

    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID]);
    expect(harness.startStreamCalls).toEqual(['desktop-1']);
    // 绑定保留：网络抖动不能把记录删掉（下次可能就好了）。
    expect(harness.deps.store.desktopSessionIdForWorkspace(WORKSPACE_ID)).toBe('desktop-1');
  });

  it('停流只断本端观看：绑定保留，下一次启动直接复用（不重新订阅）', async () => {
    const harness = createHarness();
    await harness.service.streamStart(WORKSPACE_ID);

    await harness.service.streamStop(WORKSPACE_ID);
    expect(harness.stopStreamCalls).toEqual(['desktop-1']);

    await harness.service.streamStart(WORKSPACE_ID);
    expect(harness.subscribeCalls).toHaveLength(1);
    expect(harness.startStreamCalls).toEqual(['desktop-1', 'desktop-1']);
  });
});

/* ========== 串流连接复用与内部收尸（多窗口误杀 / owner 泄漏，2026-11-27 复审 P1） ========== */

/**
 * 多窗口共用同一条进程内观看端：`streamStart` 不能因为「第二个窗口点启动」就重连。
 * 旧行为的现场表现：B 启动 → `streamViewer.start` 原子替换 A 的连接并补发
 * `closed(superseded)` → A 被判终止回 idle，之后 A 再不会发 `adminStreamStop` → owner 计数
 * 永不归零 → B 停止时流不停。这里的可观察结果是：只调一次 PSB 的 `startStream`、返回同一条
 * 观看端会话；连接真断（`closed` / `error`）之后才允许重新起。
 */
describe('管理页：多窗口复用同一条串流连接', () => {
  it('两个窗口先后启动同一工作区 → 只起一次观看端、复用同一条绑定（不重连、不产生 superseded）', async () => {
    const harness = createHarness();

    const first = await harness.service.streamStart(WORKSPACE_ID, { localSessionId: 'local-a' });
    const second = await harness.service.streamStart(WORKSPACE_ID, { localSessionId: 'local-b' });

    expect(harness.startStreamCalls).toEqual(['desktop-1']);
    expect(harness.stopStreamCalls).toHaveLength(0);
    expect(first.viewerSessionId).toBe('desktop-1');
    expect(second.viewerSessionId).toBe('desktop-1');
    // 第二个窗口拿到的是当前状态（不是 PSB 又推的一份），启动接口的形状不变。
    expect(second.status.capability).toBe(true);
  });

  it('连接被远端关闭（未就绪）之后不再复用：下一次启动真的重新起观看端', async () => {
    const harness = createHarness();
    await harness.service.streamStart(WORKSPACE_ID);

    harness.emitStreamEvent({
      type: 'closed',
      sessionId: 'desktop-1',
      reason: 'not-ready',
      detail: { reasonCode: null, desktopSession: null, messageZh: null },
    });
    await harness.service.streamStart(WORKSPACE_ID);

    // 绑定（桌面访问会话）还在，所以不重新订阅；但观看连接要重新起。
    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID]);
    expect(harness.startStreamCalls).toEqual(['desktop-1', 'desktop-1']);
  });

  it('连接错误断开之后不再复用：下一次启动真的重新起观看端', async () => {
    const harness = createHarness();
    await harness.service.streamStart(WORKSPACE_ID);

    harness.emitStreamEvent({
      type: 'error',
      sessionId: 'desktop-1',
      failure: {
        code: 'PSB_STREAM_UNREACHABLE',
        messageKey: 'remoteWorkspace.error.unreachable',
        message: 'read ECONNRESET',
      },
    });
    await harness.service.streamStart(WORKSPACE_ID);

    expect(harness.startStreamCalls).toEqual(['desktop-1', 'desktop-1']);
  });

  it('用户停止之后不再复用：下一次启动重新起观看端（停止 = 本端没有连接）', async () => {
    const harness = createHarness();
    await harness.service.streamStart(WORKSPACE_ID);
    await harness.service.streamStop(WORKSPACE_ID);
    await harness.service.streamStart(WORKSPACE_ID);

    expect(harness.stopStreamCalls).toEqual(['desktop-1']);
    expect(harness.startStreamCalls).toEqual(['desktop-1', 'desktop-1']);
  });

  it('stale 恢复路径内部收尸补发的 closed(client-stopped) 不转发给渲染层（不误伤其它窗口）', async () => {
    // 生产形态：观看端 `stop` 会同步补发 closed(client-stopped)。stale 恢复路径自己会 stop 旧
    // 连接再重建绑定 —— 那条 closed 不是用户动作，转发出去会让别的窗口显示「串流被关闭」。
    let firstStart = true;
    const harness = createHarness({
      behavior: {
        startStream: async (sessionId) => {
          if (firstStart) {
            firstStart = false;
            return streamStatus();
          }
          if (sessionId === 'desktop-1') throw notFound();
          return streamStatus();
        },
        stopStream: (sessionId) => {
          harness.emitStreamEvent({
            type: 'closed',
            sessionId,
            reason: 'client-stopped',
            detail: { reasonCode: null, desktopSession: null, messageZh: null },
          });
        },
      },
    });
    await harness.service.streamStart(WORKSPACE_ID);
    // 连接出错（渲染层已经收到这条）→ 下次启动必须重新起，此时 PSB 说绑定会话已失效。
    harness.emitStreamEvent({
      type: 'error',
      sessionId: 'desktop-1',
      failure: {
        code: 'PSB_STREAM_UNREACHABLE',
        messageKey: 'remoteWorkspace.error.unreachable',
        message: 'read ECONNRESET',
      },
    });
    expect(harness.streamEvents.some((event) => event.type === 'error')).toBe(true);
    harness.streamEvents.length = 0;

    const result = await harness.service.streamStart(WORKSPACE_ID);

    expect(harness.stopStreamCalls).toEqual(['desktop-1']);
    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID, WORKSPACE_ID]);
    expect(harness.startStreamCalls).toEqual(['desktop-1', 'desktop-1', 'desktop-2']);
    expect(result.viewerSessionId).toBe('desktop-2');
    // 内部收尸的 closed 一条都不转发（转发只发生在用户显式停止的路径，见下一条用例）。
    expect(harness.streamEvents.filter((event) => event.type === 'closed')).toHaveLength(0);
  });

  it('用户显式停止补发的 closed(client-stopped) 照常转发（内部收尸的抑制不误伤正常路径）', async () => {
    const harness = createHarness({
      behavior: {
        stopStream: (sessionId) => {
          harness.emitStreamEvent({
            type: 'closed',
            sessionId,
            reason: 'client-stopped',
            detail: { reasonCode: null, desktopSession: null, messageZh: null },
          });
        },
      },
    });
    await harness.service.streamStart(WORKSPACE_ID);
    harness.streamEvents.length = 0;

    await harness.service.streamStop(WORKSPACE_ID);

    expect(harness.streamEvents).toEqual([
      expect.objectContaining({ type: 'closed', sessionId: 'desktop-1', reason: 'client-stopped' }),
    ]);
  });
});

/* ============= 订阅前「尽力拉起桌面访问」（可选增强，Cindy 入口未放行） ============= */

describe('管理页：订阅前尽力拉起桌面访问', () => {
  it('拉起发生在订阅之前；入口未开放（403/404）也照常订阅、照常建观看端', async () => {
    // 生产现状默认就是 `cindy-entry-not-open`（PSB 白名单没放行 Cindy 的 /api/remote/**）。
    const subscribeCallsAtEnsure: number[] = [];
    const harness = createHarness({
      behavior: {
        ensureWorkspaceAccess: async () => {
          subscribeCallsAtEnsure.push(harness.subscribeCalls.length);
          return { ok: false, reason: 'cindy-entry-not-open', failure: null };
        },
      },
    });

    const result = await harness.service.streamStart(WORKSPACE_ID);

    // 0 = 那一刻还没订阅过任何工作区 —— ensure 必须排在 subscribe 前。
    expect(subscribeCallsAtEnsure).toEqual([0]);
    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID]);
    expect(result.viewerSessionId).toBe('desktop-1');
    expect(harness.createSessionCalls).toHaveLength(0);
  });

  it('拉起到 running 时不改变启动语义（仍然用订阅返回的桌面访问会话）', async () => {
    const harness = createHarness({
      behavior: {
        ensureWorkspaceAccess: async () => ({
          ok: true,
          state: 'running',
          startedByThisCall: true,
        }),
      },
    });

    const result = await harness.service.streamStart(WORKSPACE_ID);

    expect(harness.ensureAccessCalls).toEqual([WORKSPACE_ID]);
    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID]);
    expect(result.viewerSessionId).toBe('desktop-1');
  });

  it('拉起本身抛异常（端口违约）也不阻断启动', async () => {
    const harness = createHarness({
      behavior: {
        ensureWorkspaceAccess: async () => {
          throw new Error('boom');
        },
      },
    });

    const result = await harness.service.streamStart(WORKSPACE_ID);

    expect(harness.ensureAccessCalls).toEqual([WORKSPACE_ID]);
    expect(result.viewerSessionId).toBe('desktop-1');
    // 这属于「增强接口坏了」，要留痕，但只 warn 不失败（后台预热，异常在微任务里被兜住）。
    await vi.waitFor(() => {
      expect(
        harness.warnings.some((entry) => entry.message.includes('workspace access ensure threw')),
      ).toBe(true);
    });
  });

  it('拉起访问不再阻塞启动必经路径：ensure 一直不返回，启动照常完成', async () => {
    // 用可变 holder 而不是 `let release = null`：后者在 promise executor 里赋值时 TS 无法
    // 收窄到「可调用」，会在 `release?.()` 报 not callable。
    const releaseEnsure: { fn: (() => void) | null } = { fn: null };
    const harness = createHarness({
      behavior: {
        // 真实形态下它有 ~3s 轮询预算；这里模拟「慢到永远不返回」，启动不能被它拖住。
        ensureWorkspaceAccess: () =>
          new Promise<PsbWorkspaceAccessEnsureOutcome>((resolve) => {
            releaseEnsure.fn = () =>
              resolve({ ok: true, state: 'running', startedByThisCall: true });
          }),
      },
    });

    const result = await harness.service.streamStart(WORKSPACE_ID);

    expect(result.viewerSessionId).toBe('desktop-1');
    // ensure 是**先发起**的（后台预热），但订阅与起观看端都不等它。
    expect(harness.ensureAccessCalls).toEqual([WORKSPACE_ID]);
    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID]);
    expect(harness.startStreamCalls).toEqual(['desktop-1']);
    releaseEnsure.fn?.();
    await vi.waitFor(() => {
      expect(harness.infos.some((entry) => entry.message.includes('access is running'))).toBe(
        true,
      );
    });
  });

  it('入口未开放的能力位在本进程内缓存：再次订阅不再白打一次 ensure', async () => {
    const harness = createHarness();
    await harness.service.streamStart(WORKSPACE_ID);
    // 等后台预热把 `cindy-entry-not-open` 写进能力位。
    await vi.waitFor(() => {
      expect(
        harness.infos.some(
          (entry) =>
            entry.message.includes('access ensure did not succeed') &&
            entry.fields?.['reason'] === 'cindy-entry-not-open',
        ),
      ).toBe(true);
    });
    expect(harness.ensureAccessCalls).toEqual([WORKSPACE_ID]);

    // 绑定失效（桌面访问被重建）→ 下次启动要重新订阅，但入口未开放的能力位已经知道结果。
    harness.behavior.streamStatus = async (sessionId) => {
      if (sessionId === 'desktop-1') throw notFound();
      return streamStatus();
    };
    await harness.service.streamStatus(WORKSPACE_ID);
    expect(harness.deps.store.desktopSessionIdForWorkspace(WORKSPACE_ID)).toBeNull();

    const restarted = await harness.service.streamStart(WORKSPACE_ID);
    expect(restarted.viewerSessionId).toBe('desktop-2');
    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID, WORKSPACE_ID]);
    // 能力位 closed 且未过期：不再发起第二次 ensure。
    expect(harness.ensureAccessCalls).toEqual([WORKSPACE_ID]);
  });

  it('拉起访问失败且订阅本身没有可读原因 → 启动失败带上 ensure 的 PSB 原文（码不变）', async () => {
    const harness = createHarness({
      behavior: {
        ensureWorkspaceAccess: async () => ({
          ok: false,
          reason: 'failed',
          failure: {
            code: 'PSB_UNREACHABLE',
            messageKey: 'remoteWorkspace.error.unreachable',
            message: '入口未开放：403',
          },
        }),
        subscribeWorkspaceStream: async () => {
          // PSB 上游没给可读 message 的情况：main 不能只留一条空失败。
          throw new PsbClientError(
            {
              code: 'PSB_STREAM_NO_RUNNING_SESSION',
              messageKey: 'remoteWorkspace.admin.streamAccessNone',
              message: null,
              streamAccessState: 'none',
            },
            409,
          );
        },
      },
    });

    const error = (await harness.service
      .streamStart(WORKSPACE_ID)
      .catch((cause: unknown) => cause)) as PsbClientError;

    // 主失败的码 / 可行动语义不变，只补 PSB 原文做 detail。
    expect(error.failure.code).toBe('PSB_STREAM_NO_RUNNING_SESSION');
    expect(error.failure.streamAccessState).toBe('none');
    expect(error.failure.message).toBe('入口未开放：403');
    expect(error.status).toBe(409);
    // 拉起访问失败不会自行触发旧 PSB 的建会话回退。
    expect(harness.createSessionCalls).toHaveLength(0);
  });

  it('旧装配（端口上没有 ensureWorkspaceAccess）照常启动', async () => {
    const harness = createHarness({ withoutAccessEnsure: true });

    const result = await harness.service.streamStart(WORKSPACE_ID);

    expect(harness.ensureAccessCalls).toHaveLength(0);
    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID]);
    expect(result.viewerSessionId).toBe('desktop-1');
  });

  it('占用闸门失败时不浪费一次「拉起访问」（闸门先于 ensure）', async () => {
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

    await harness.service.streamStart(WORKSPACE_ID).catch(() => undefined);

    expect(harness.lockChecks).toEqual([WORKSPACE_ID]);
    expect(harness.ensureAccessCalls).toHaveLength(0);
    expect(harness.subscribeCalls).toHaveLength(0);
  });
});

/* ==================== 过渡回退：旧 PSB 才建内部 Agent 会话 ==================== */

describe('管理页：旧 PSB 的过渡回退', () => {
  it.each(['route-404', 'method-405', 'unsupported'] as const)(
    '订阅端点不可用（%s）→ 回退创建内部会话，带 purpose=internal + 内部用途标题 + warn 日志',
    async (kind) => {
      const harness = createHarness({
        behavior: {
          subscribeWorkspaceStream: async () => {
            throw subscribeUnavailable(kind);
          },
        },
      });

      const result = await harness.service.streamStart(WORKSPACE_ID);

      // 回退只允许一种创建：显式 internal 用途 + 不伪装成用户任务的标题 + 幂等键。
      expect(harness.createSessionCalls).toEqual([
        {
          workspaceId: WORKSPACE_ID,
          agentKind: 'pi',
          title: PSB_ADMIN_INTERNAL_STREAM_SESSION_TITLE,
          purpose: 'internal',
          clientRequestId: 'req-1',
        },
      ]);
      expect(harness.startStreamCalls).toEqual(['internal-1']);
      expect(result.viewerSessionId).toBe('internal-1');
      expect(harness.deps.store.desktopSessionIdForWorkspace(WORKSPACE_ID)).toBe('internal-1');
      // 回退必须可在日志里归因（不能悄悄降级）。
      expect(
        harness.warnings.some((entry) =>
          entry.message.includes('workspace-level stream subscribe is unavailable'),
        ),
      ).toBe(true);
    },
  );

  it('订阅 409「没有 running 桌面访问会话」→ 按 state 抛新码，不建会话、不落盘、不起观看端', async () => {
    // 2026-11-26 真机：访问未运行时点「启动串流」只显示「串流失败：操作失败，请稍后重试。」。
    // 现在必须是带 state 的结构化失败，渲染层才能给出「去网页启动访问 / 等一会儿」。
    for (const state of ['none', 'stopped', 'failed', 'starting', 'stopping'] as const) {
      const harness = createHarness({
        behavior: {
          subscribeWorkspaceStream: async () => {
            throw noRunningSession(state);
          },
        },
      });

      const error = (await harness.service
        .streamStart(WORKSPACE_ID)
        .catch((cause: unknown) => cause)) as PsbClientError;

      expect(error).toBeInstanceOf(PsbClientError);
      expect(error.status).toBe(409);
      expect(error.failure.code).toBe('PSB_STREAM_NO_RUNNING_SESSION');
      expect(error.failure.streamAccessState).toBe(state);
      // 跨 IPC 的码由 state 决定：none 家族 / 正在启动 / 正在结束。
      expect(psbIpcCodeForFailure(error.failure)).toBe(
        state === 'starting'
          ? 'PSB_STREAM_ACCESS_STARTING'
          : state === 'stopping'
            ? 'PSB_STREAM_ACCESS_STOPPING'
            : 'PSB_STREAM_NO_RUNNING_SESSION',
      );
      // PSB 的可读原因原样保留：渲染层要显示「先在 PSB 网页启动桌面访问」。
      expect(error.failure.message).toContain('启动远程桌面');
      expect(harness.createSessionCalls).toHaveLength(0);
      expect(harness.startStreamCalls).toHaveLength(0);
      expect(harness.deps.store.desktopSessionIdForWorkspace(WORKSPACE_ID)).toBeNull();
      expect(harness.warnings).toHaveLength(0);
      // 订阅之前仍然先「尽力拉起」过一次（PSB 白名单未放行时它恒为非致命失败）。
      expect(harness.ensureAccessCalls).toEqual([WORKSPACE_ID]);
    }
  });

  it('订阅遇到网络失败 → 原样上抛，不降级去建会话', async () => {
    const harness = createHarness({
      behavior: {
        subscribeWorkspaceStream: async () => {
          throw unreachable();
        },
      },
    });

    await expect(harness.service.streamStart(WORKSPACE_ID)).rejects.toBeInstanceOf(PsbClientError);
    expect(harness.createSessionCalls).toHaveLength(0);
  });
});

/* ============================== 交互输入 ============================== */

describe('管理页：键鼠输入转发', () => {
  it('按工作区解析到观看端绑定后原样转发事件（不重读上下文、不落盘）', async () => {
    const harness = createHarness();
    const started = await harness.service.streamStart(WORKSPACE_ID);
    const writesBeforeInput = harness.storeWrites();

    const event = { kind: 'pointermove', x: 0.5, y: 0.25 };
    await harness.service.streamInput(WORKSPACE_ID, event);

    // 会话必须是 main 解析出来的观看端绑定，而不是渲染层传进来的任何 id。
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

/* ============================== 串流事件 ============================== */

describe('管理页：串流事件', () => {
  it('只转发观看端绑定会话的事件，并据事件里的桌面会话状态推送上下文', async () => {
    const harness = createHarness({ recent: { lastWorkspaceId: WORKSPACE_ID } });
    // 页面先读一次上下文（真实入口：点击「启动」前页面已有本窗口的推送桶）。
    // 推送只对**有任务线索**的桶生效（2026-11-27 审查 s2 P1），这里带本地任务 id。
    const localSessionId = 'local-task-viewer';
    await harness.service.context({ localSessionId });
    const started = await harness.service.streamStart(WORKSPACE_ID, { localSessionId });
    harness.contextEvents.length = 0;
    harness.contextChangedEvents.length = 0;
    harness.streamEvents.length = 0;

    // 别的会话（用户任务 / 其它观看端）的事件不属于管理页通道。
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

    // 绑定会话的关闭事件 → 转发 + 桌面会话状态按 PSB 结构化归因更新。
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

  it('宿主光标形状事件按绑定会话原样转发（别的会话的不进管理页通道）', async () => {
    const harness = createHarness();
    const started = await harness.service.streamStart(WORKSPACE_ID);
    harness.streamEvents.length = 0;

    // `stream.cursor` 在 main 已由观看端校验成 `PsbStreamCursorShape`；管理页服务只负责
    // 「按绑定会话过滤 + 原样转发」，不做任何状态映射（光标不是管理页状态）。
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

  it('PSB 0.1.170 的 4404（session-not-found）→ 丢掉观看端绑定与本机记录', async () => {
    const harness = createHarness();
    const started = await harness.service.streamStart(WORKSPACE_ID);

    harness.emitStreamEvent({
      type: 'closed',
      sessionId: started.viewerSessionId,
      reason: 'session-not-found',
      detail: { reasonCode: null, desktopSession: null, messageZh: '会话不存在' },
    });

    expect(harness.deps.store.desktopSessionIdForWorkspace(WORKSPACE_ID)).toBeNull();
    await vi.waitFor(async () => {
      const { context } = await harness.service.context({ localSessionId: null });
      expect(context?.viewerSessionId).toBeNull();
    });
  });

  it('串流状态映射只做可选字段归一，不改写 PSB 契约字段名', () => {
    // 2026-11-26 shared 收敛：`PsbSessionStreamStatus` 字段名 = PSB 线上拼写
    // （`capability` / `encoder` / `lastErrorZh`），旧的 `capable` / `codec` / `lastError`
    // 是未发布的契约草稿拼写，已删除双读兼容。映射层只把缺省的可选字段归一成 `null`。
    const parsed = {
      capability: true,
      active: true,
      width: 1920,
      height: 1080,
      fps: 30,
      encoder: 'h264',
      lastErrorZh: '没有正在运行的桌面会话',
      // 旧服务端 / 非串流入口不给这两个加性字段。
    } as PsbSessionStreamStatus;

    const mapped = psbAdminStreamStatusFromPsb(parsed);

    expect(mapped).toMatchObject({
      capability: true,
      active: true,
      encoder: 'h264',
      lastErrorZh: '没有正在运行的桌面会话',
      desktopSession: null,
      reasonCode: null,
    });
  });
});

/* ==================== 工作区级状态读数（只读，不订阅 / 不建会话 / 不占用） ==================== */

describe('管理页：工作区级状态读数', () => {
  it('没有绑定 → STREAM_STATUS 返回 null，且绝不订阅、不建会话、不占用工作区', async () => {
    const harness = createHarness({ recent: { lastWorkspaceId: WORKSPACE_ID } });

    const result = await harness.service.streamStatus(WORKSPACE_ID);

    expect(result).toEqual({ status: null, viewerSessionId: null });
    expect(harness.subscribeCalls).toHaveLength(0);
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.lockChecks).toHaveLength(0);
    expect(harness.startStreamCalls).toHaveLength(0);
  });

  it('本机记录里有绑定 → 用桌面访问会话 id 只读 HTTP（不订阅、不建会话、不占用）', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        desktopSessions: [{ workspaceId: WORKSPACE_ID, sessionId: 'desktop-existing' }],
      },
      behavior: {
        streamStatus: async (sessionId) => {
          expect(sessionId).toBe('desktop-existing');
          return streamStatus({ active: true, desktopSession: 'running' });
        },
      },
    });

    const result = await harness.service.streamStatus(WORKSPACE_ID);

    expect(result.status).toMatchObject({ capability: true, active: true, desktopSession: 'running' });
    expect(result.viewerSessionId).toBe('desktop-existing');
    expect(harness.subscribeCalls).toHaveLength(0);
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.lockChecks).toHaveLength(0);
    // 只读探针：`stream/status` 是 HTTP，复用绑定不代表订阅（不占观看名额）。
    expect(harness.startStreamCalls).toEqual([]);

    // 第二次读数用内存绑定，不再依赖记录查找，也不重复订阅/占用。
    const second = await harness.service.streamStatus(WORKSPACE_ID);
    expect(second.viewerSessionId).toBe('desktop-existing');
    expect(harness.subscribeCalls).toHaveLength(0);
  });

  it('记录里的绑定已失效 → 清掉记录，返回 null，不重建', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        desktopSessions: [{ workspaceId: WORKSPACE_ID, sessionId: 'desktop-dead' }],
      },
      behavior: {
        streamStatus: async () => {
          throw notFound();
        },
      },
    });

    const result = await harness.service.streamStatus(WORKSPACE_ID);

    expect(result.status).toBeNull();
    expect(harness.deps.store.desktopSessionIdForWorkspace(WORKSPACE_ID)).toBeNull();
    expect(harness.subscribeCalls).toHaveLength(0);
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.lockChecks).toHaveLength(0);
  });

  it('读数失败但读不清死活（网络）→ status:null 且保留绑定', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        desktopSessions: [{ workspaceId: WORKSPACE_ID, sessionId: 'desktop-existing' }],
      },
      behavior: {
        streamStatus: async () => {
          throw unreachable();
        },
      },
    });

    const result = await harness.service.streamStatus(WORKSPACE_ID);

    expect(result.status).toBeNull();
    // 网络抖动不能把还能用的绑定记录删掉（否则下次启动会多订阅一次）。
    expect(harness.deps.store.desktopSessionIdForWorkspace(WORKSPACE_ID)).toBe(
      'desktop-existing',
    );
    expect(harness.subscribeCalls).toHaveLength(0);
  });

  it('adminContext 重启后首次读：用本机记录的绑定读出 desktopSession（不订阅、不建会话）', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        desktopSessions: [{ workspaceId: WORKSPACE_ID, sessionId: 'desktop-existing' }],
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
      viewerSessionId: 'desktop-existing',
    });
    expect(harness.subscribeCalls).toHaveLength(0);
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.lockChecks).toHaveLength(0);
  });

  it('adminContext 读到 none 时如实反映（不是 null，也不猜 starting）', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        desktopSessions: [{ workspaceId: WORKSPACE_ID, sessionId: 'desktop-existing' }],
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

  it('工作区明确不可用（客户端离线）→ 桌面状态保持未知（不伪造 none），仍不订阅', async () => {
    const harness = createHarness({
      recent: { lastWorkspaceId: WORKSPACE_ID },
      behavior: {
        listWorkspaces: async () => [
          workspaceRow({ usable: false, unusableReason: 'client-offline' }),
        ],
      },
    });

    const { context } = await harness.service.context({ localSessionId: null });

    expect(harness.subscribeCalls).toHaveLength(0);
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(context).toMatchObject({ workspaceId: WORKSPACE_ID, desktopSession: null });
  });

  it('读数复用本机记录的绑定时推送一次上下文（viewerSessionId 从 null 变为有值）', async () => {
    const harness = createHarness({
      recent: {
        lastWorkspaceId: WORKSPACE_ID,
        desktopSessions: [{ workspaceId: WORKSPACE_ID, sessionId: 'desktop-existing' }],
      },
      behavior: {
        // 第一次读：PSB 暂时不可达 → 没有内存绑定，基线 viewerSessionId=null。
        streamStatus: async () => {
          throw unreachable();
        },
      },
    });
    // 推送只对**有任务线索**的桶生效（2026-11-27 审查 s2 P1）。
    const localSessionId = 'local-task-status';
    const { context } = await harness.service.context({ localSessionId });
    expect(context?.viewerSessionId).toBeNull();
    harness.contextEvents.length = 0;

    // PSB 恢复：读数复用记录里的绑定（不订阅），viewerSessionId 从 null 变为有值。
    harness.behavior.streamStatus = async () =>
      streamStatus({ active: true, desktopSession: 'running' });
    const result = await harness.service.streamStatus(WORKSPACE_ID, { localSessionId });
    expect(result.viewerSessionId).toBe('desktop-existing');
    expect(harness.subscribeCalls).toHaveLength(0);

    await vi.waitFor(() => {
      expect(harness.contextEvents.at(-1)?.viewerSessionId).toBe('desktop-existing');
    });
    expect(harness.contextChangedEvents.at(-1)?.localSessionId).toBe(localSessionId);
  });
});

/* ============================== 最近使用记录 ============================== */

describe('最近使用记录', () => {
  const EMPTY_STATE = {
    lastWorkspaceId: null,
    sessions: [],
    desktopSessions: [],
    workspaceSnapshots: [],
  } as const;

  it('坏数据收敛成空记录，会话/绑定映射去重并与上限对齐；旧 viewers / version 键被忽略', () => {
    expect(normalizePsbAdminRecentState(null)).toEqual(EMPTY_STATE);
    expect(
      normalizePsbAdminRecentState({
        version: 1,
        lastWorkspaceId: '  ',
        sessions: 'x',
        desktopSessions: {},
      }),
    ).toEqual(EMPTY_STATE);

    const overflow = Array.from({ length: PSB_ADMIN_RECENT_SESSION_LIMIT + 8 }, (_, index) => ({
      sessionId: `s-${index}`,
      workspaceId: 'ws-1',
    }));
    const bindingOverflow = Array.from(
      { length: PSB_ADMIN_RECENT_DESKTOP_SESSION_LIMIT + 4 },
      (_, index) => ({ workspaceId: `ws-${index}`, sessionId: `desktop-${index}` }),
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
      desktopSessions: [
        { workspaceId: 'ws-1', sessionId: 'desktop-1' },
        { workspaceId: 'ws-1', sessionId: 'desktop-duplicate' },
        { workspaceId: '', sessionId: 'desktop-2' },
        { sessionId: 'desktop-3' },
        ...bindingOverflow,
      ],
      // 旧版本（内部观看端 Agent 会话）的键：不读、不迁移（语义已作废）。
      viewers: [{ workspaceId: 'ws-legacy', sessionId: 'psb-viewer-legacy' }],
    });

    expect(normalized.lastWorkspaceId).toBe('ws-1');
    expect(normalized.sessions).toHaveLength(PSB_ADMIN_RECENT_SESSION_LIMIT);
    expect(normalized.sessions[0]).toEqual({ sessionId: 'dup', workspaceId: 'ws-1' });
    expect(normalized.desktopSessions).toHaveLength(PSB_ADMIN_RECENT_DESKTOP_SESSION_LIMIT);
    // 同一工作区只保留第一条（最近的在前），坏行 / 重复工作区被丢弃。
    expect(normalized.desktopSessions[0]).toEqual({
      workspaceId: 'ws-1',
      sessionId: 'desktop-1',
    });
    expect(normalized.desktopSessions.some((entry) => entry.workspaceId === 'ws-legacy')).toBe(
      false,
    );
  });

  it('落盘文件没有 version 字段（writePatch 会删默认值，改为加性演进）', () => {
    const stored: PsbAdminRecentWorkspaceFile[] = [];
    const file: PsbAdminRecentWorkspaceFile = {
      lastWorkspaceId: null,
      sessions: [],
      desktopSessions: [],
      workspaceSnapshots: [],
    };
    const store = createPsbAdminRecentWorkspaceStore({
      read: () => file,
      write: (next) => {
        stored.push(next);
        file.lastWorkspaceId = next.lastWorkspaceId;
        file.sessions = [...next.sessions];
        file.desktopSessions = [...next.desktopSessions];
        file.workspaceSnapshots = [...(next.workspaceSnapshots ?? [])];
      },
    });

    store.rememberWorkspace('ws-1');
    store.rememberWorkspaceSnapshot({
      workspaceId: 'ws-1',
      title: 'saga2_project',
      clientName: '打包机',
      savedAt: '2026-11-26T00:00:00.000Z',
    });

    expect(stored).not.toHaveLength(0);
    for (const payload of stored) {
      expect(payload).not.toHaveProperty('version');
    }
    // 旧文件带 version 也能读（归一化忽略它）。
    expect(normalizePsbAdminRecentState({ version: 7, lastWorkspaceId: 'ws-1' }).lastWorkspaceId).toBe(
      'ws-1',
    );
  });

  it('写是幂等的：同值不落盘；固定字段相同的快照 0 次写（易变状态不再参与比较）', () => {
    let writes = 0;
    const file: PsbAdminRecentWorkspaceFile = {
      lastWorkspaceId: null,
      sessions: [],
      desktopSessions: [],
      workspaceSnapshots: [],
    };
    const store = createPsbAdminRecentWorkspaceStore({
      read: () => file,
      write: (next) => {
        writes += 1;
        file.lastWorkspaceId = next.lastWorkspaceId;
        file.sessions = [...next.sessions];
        file.desktopSessions = [...next.desktopSessions];
        file.workspaceSnapshots = [...(next.workspaceSnapshots ?? [])];
      },
    });

    store.rememberWorkspace('ws-1');
    store.rememberWorkspace('ws-1');
    store.rememberSessionWorkspace('psb-1', 'ws-1');
    store.rememberSessionWorkspace('psb-1', 'ws-1');
    store.rememberDesktopSession('ws-1', 'desktop-1');
    store.rememberDesktopSession('ws-1', 'desktop-1');
    expect(writes).toBe(3);
    expect(store.workspaceIdForSession('psb-1')).toBe('ws-1');
    expect(store.desktopSessionIdForWorkspace('ws-1')).toBe('desktop-1');

    // 固定信息快照：值不变 0 次写，`savedAt` 保留第一次落盘时间。
    const snapshotInput = {
      workspaceId: 'ws-1',
      title: 'saga2_project',
      templateTitle: 'Saga2',
      clientName: '打包机',
      directoryName: 'saga2_project-2',
      savedAt: '2026-11-26T00:00:00.000Z',
    };
    expect(store.rememberWorkspaceSnapshot(snapshotInput)).toBe(true);
    expect(writes).toBe(4);
    expect(store.rememberWorkspaceSnapshot({ ...snapshotInput })).toBe(false);
    expect(writes).toBe(4);
    expect(store.workspaceSnapshot('ws-1')).toMatchObject({
      title: 'saga2_project',
      templateTitle: 'Saga2',
      clientName: '打包机',
      directoryName: 'saga2_project-2',
      savedAt: '2026-11-26T00:00:00.000Z',
      confirmedAt: '2026-11-26T00:00:00.000Z',
    });

    // 旧文件行里可能残留 clientOnline / state（易变状态）：读取时归一丢弃，且不参与等值比较。
    const withVolatile = normalizePsbAdminRecentState({
      workspaceSnapshots: [
        {
          ...store.workspaceSnapshot('ws-1'),
          clientOnline: true,
          state: 'ready',
        },
      ],
    });
    expect(withVolatile.workspaceSnapshots[0]).not.toHaveProperty('clientOnline');
    expect(withVolatile.workspaceSnapshots[0]).not.toHaveProperty('state');
    const storeWithVolatile = createPsbAdminRecentWorkspaceStore({
      read: () => ({ ...file, workspaceSnapshots: withVolatile.workspaceSnapshots }),
      write: (next) => {
        writes += 1;
        file.workspaceSnapshots = [...(next.workspaceSnapshots ?? [])];
      },
    });
    expect(storeWithVolatile.rememberWorkspaceSnapshot(snapshotInput)).toBe(false);
    expect(writes).toBe(4);

    // 换一条绑定：幂等写（同值不再写），旧值被替换。
    store.rememberDesktopSession('ws-1', 'desktop-2');
    expect(writes).toBe(5);
    expect(store.desktopSessionIdForWorkspace('ws-1')).toBe('desktop-2');

    store.forgetDesktopSession('ws-1');
    expect(writes).toBe(6);
    expect(store.desktopSessionIdForWorkspace('ws-1')).toBeNull();
    store.forgetDesktopSession('ws-1');
    expect(writes).toBe(6);
  });

  it('快照的 savedAt / confirmedAt 分开：重写保留首次落盘时间、推进确认时间', () => {
    let writes = 0;
    const file: PsbAdminRecentWorkspaceFile = {
      lastWorkspaceId: null,
      sessions: [],
      desktopSessions: [],
      workspaceSnapshots: [],
    };
    const store = createPsbAdminRecentWorkspaceStore({
      read: () => file,
      write: (next) => {
        writes += 1;
        file.workspaceSnapshots = [...(next.workspaceSnapshots ?? [])];
      },
    });

    expect(
      store.rememberWorkspaceSnapshot({
        workspaceId: 'ws-1',
        title: '旧名称',
        clientName: '打包机',
        savedAt: '2026-11-26T00:00:00.000Z',
        confirmedAt: '2026-11-26T00:00:00.000Z',
      }),
    ).toBe(true);
    // 固定字段变化（目录名第一次拿到）：重写，但 `savedAt` 仍是第一次的时间。
    expect(
      store.rememberWorkspaceSnapshot({
        workspaceId: 'ws-1',
        title: '旧名称',
        clientName: '打包机',
        directoryName: 'saga2_project-2',
        confirmedAt: '2026-11-27T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(writes).toBe(2);
    expect(store.workspaceSnapshot('ws-1')).toMatchObject({
      savedAt: '2026-11-26T00:00:00.000Z',
      confirmedAt: '2026-11-27T00:00:00.000Z',
    });
  });

  it('latestWorkspaceSnapshot 按 confirmedAt 取最新，不依赖文件里的数组顺序', () => {
    const snapshot = (workspaceId: string, confirmedAt: string): Record<string, unknown> => ({
      workspaceId,
      title: workspaceId,
      clientName: 'machine',
      savedAt: confirmedAt,
      confirmedAt,
    });
    // 文件顺序刻意与时间相反（手改 / 旧版本写坏）。
    const normalized = normalizePsbAdminRecentState({
      workspaceSnapshots: [
        snapshot('ws-old', '2026-11-20T00:00:00.000Z'),
        snapshot('ws-new', '2026-11-27T00:00:00.000Z'),
        snapshot('ws-mid', '2026-11-24T00:00:00.000Z'),
      ],
    });
    expect(normalized.workspaceSnapshots.map((entry) => entry.workspaceId)).toEqual([
      'ws-new',
      'ws-mid',
      'ws-old',
    ]);
    const store = createPsbAdminRecentWorkspaceStore({
      read: () => normalized,
      write: () => undefined,
    });
    expect(store.latestWorkspaceSnapshot()?.workspaceId).toBe('ws-new');

    // 同一 workspaceId 的重复行：保留 confirmedAt 最新的那条，而不是文件里先出现的那条。
    const deduped = normalizePsbAdminRecentState({
      workspaceSnapshots: [
        snapshot('ws-1', '2026-11-20T00:00:00.000Z'),
        { ...snapshot('ws-1', '2026-11-27T00:00:00.000Z'), title: 'newer' },
      ],
    });
    expect(deduped.workspaceSnapshots).toHaveLength(1);
    expect(deduped.workspaceSnapshots[0]).toMatchObject({
      title: 'newer',
      confirmedAt: '2026-11-27T00:00:00.000Z',
    });
  });

  it('坏行时间不伪造 1970：两个时间都不可解析的行丢弃，只有一个时用另一个补齐', () => {
    expect(normalizePsbAdminRecentState({ workspaceSnapshots: 'x' }).workspaceSnapshots).toEqual([]);
    expect(
      normalizePsbAdminRecentState({
        workspaceSnapshots: [
          null,
          'x',
          { workspaceId: 'ws-1' },
          { workspaceId: '', title: 't', clientName: 'c' },
          { workspaceId: 'ws-1', title: '  ', clientName: '' },
          // 两个时间都坏（旧实现会填成 1970-01-01 并抢到「最近确认」）：丢弃。
          { workspaceId: 'bad', title: 'bad', clientName: 'c', savedAt: 42 },
          { workspaceId: 'bad', title: 'bad', clientName: 'c', savedAt: 'not-a-date' },
          // 只有 confirmedAt：savedAt 用它补齐。
          {
            workspaceId: 'ws-confirmed',
            title: 'saga2_project',
            clientName: '打包机',
            confirmedAt: '2026-11-26T02:00:00.000Z',
          },
          // 只有 savedAt：confirmedAt 用它补齐。
          {
            workspaceId: 'ws-saved',
            title: 'saved',
            clientName: 'c',
            savedAt: '2026-11-26T01:00:00.000Z',
          },
          // 倒挂（savedAt 晚于 confirmedAt）：归一成 savedAt <= confirmedAt。
          {
            workspaceId: 'ws-inverted',
            title: 'inverted',
            clientName: 'c',
            savedAt: '2026-11-27T00:00:00.000Z',
            confirmedAt: '2026-11-24T00:00:00.000Z',
          },
        ],
      }).workspaceSnapshots,
    ).toEqual([
      // 倒挂的时间戳归一成「savedAt = 较早、confirmedAt = 较晚」，按 confirmedAt 排在最前。
      {
        workspaceId: 'ws-inverted',
        title: 'inverted',
        templateTitle: null,
        clientName: 'c',
        directoryName: null,
        savedAt: '2026-11-24T00:00:00.000Z',
        confirmedAt: '2026-11-27T00:00:00.000Z',
      },
      {
        workspaceId: 'ws-confirmed',
        title: 'saga2_project',
        templateTitle: null,
        clientName: '打包机',
        directoryName: null,
        savedAt: '2026-11-26T02:00:00.000Z',
        confirmedAt: '2026-11-26T02:00:00.000Z',
      },
      {
        workspaceId: 'ws-saved',
        title: 'saved',
        templateTitle: null,
        clientName: 'c',
        directoryName: null,
        savedAt: '2026-11-26T01:00:00.000Z',
        confirmedAt: '2026-11-26T01:00:00.000Z',
      },
    ]);
  });

  it('固定信息快照的容量上限：超出上限淘汰 confirmedAt 最旧的那条', () => {
    const overflow = Array.from({ length: PSB_ADMIN_WORKSPACE_SNAPSHOT_LIMIT + 5 }, (_, index) => ({
      workspaceId: `ws-${index}`,
      title: `ws-${index}`,
      templateTitle: null,
      clientName: 'machine',
      directoryName: null,
      savedAt: '2026-11-26T00:00:00.000Z',
      // 第 0 条最新，越往后越旧。
      confirmedAt: new Date(
        Date.parse('2026-11-26T00:00:00.000Z') - index * 60_000,
      ).toISOString(),
    }));
    const normalized = normalizePsbAdminRecentState({ workspaceSnapshots: overflow });
    expect(normalized.workspaceSnapshots).toHaveLength(PSB_ADMIN_WORKSPACE_SNAPSHOT_LIMIT);
    expect(normalized.workspaceSnapshots[0].workspaceId).toBe('ws-0');
    // 最旧的 5 条被淘汰。
    expect(normalized.workspaceSnapshots.some((entry) => entry.workspaceId === 'ws-20')).toBe(
      false,
    );
  });
});

/* ==================== 多窗口：localSessionId 分桶（2026-11-26 独立审查） ==================== */

describe('管理页：多窗口上下文分桶', () => {
  const ROW_A = () => workspaceRow({ id: 'ws-a', title: '项目A', directoryName: 'dir-a' });
  const ROW_B = () =>
    workspaceRow({
      id: 'ws-b',
      title: '项目B',
      directoryName: 'dir-b',
      occupancy: { occupied: true, byMe: false, personId: '9', personName: '小王', occupiedAt: 2 },
    });

  function multiWindowHarness(): Harness {
    return createHarness({
      behavior: {
        listWorkspaces: async () => [ROW_A(), ROW_B()],
        // `remoteHostId = psb:a` 会在 main 侧被解析成 PSB 会话 id `a`。
        sessionStatus: async (sessionId) => ({
          session: sessionRow({ id: sessionId }),
          workspace: sessionId === 'a' ? ROW_A() : ROW_B(),
        }),
        localRemoteHostIdForSession: (localSessionId) =>
          localSessionId === 'local-a' ? 'psb:a' : 'psb:b',
      },
    });
  }

  it('两个窗口各自读自己的任务：推送基线互不覆盖、窗口 watchdog 重读不产生错标推送', async () => {
    const harness = multiWindowHarness();

    const a1 = await harness.service.context({ localSessionId: 'local-a' });
    const b1 = await harness.service.context({ localSessionId: 'local-b' });
    expect(a1.context?.workspaceId).toBe('ws-a');
    expect(b1.context?.workspaceId).toBe('ws-b');
    // 两个窗口第一次读都只建立各自基线，不推送。
    expect(harness.contextChangedEvents).toHaveLength(0);

    // 窗口 A 的 30s watchdog 再读同一任务：值没变，不推送。
    // 旧实现此时会拿**全局最近**的 localSessionId（B）发出错标推送，A/B 都会丢弃。
    await harness.service.context({ localSessionId: 'local-a' });
    expect(harness.contextChangedEvents).toHaveLength(0);

    // B 的工作区占用变了：只推 B 的桶，`localSessionId` 精确是 B。
    const ROW_B_MINE = {
      ...ROW_B(),
      occupancy: { occupied: true, byMe: true, personId: '7', personName: '我', occupiedAt: 3 },
    };
    harness.behavior.sessionStatus = async (sessionId) => ({
      session: sessionRow({ id: sessionId }),
      workspace: sessionId === 'a' ? ROW_A() : ROW_B_MINE,
    });
    await harness.service.context({ localSessionId: 'local-b' });
    expect(harness.contextChangedEvents).toHaveLength(1);
    expect(harness.contextChangedEvents[0].localSessionId).toBe('local-b');
    expect(harness.contextChangedEvents[0].context?.workspaceId).toBe('ws-b');
    expect(harness.contextChangedEvents[0].context?.occupancy.byMe).toBe(true);

    // A 的桶不受影响：再读 A 仍然不推送（没有把 B 的事件错标给 A）。
    await harness.service.context({ localSessionId: 'local-a' });
    expect(harness.contextChangedEvents).toHaveLength(1);
  });

  it('串流动作只刷新相关桶：发起窗口拿到自己的 id，另一个窗口不被刷成别人的工作区', async () => {
    const harness = multiWindowHarness();
    await harness.service.context({ localSessionId: 'local-a' });
    await harness.service.context({ localSessionId: 'local-b' });
    harness.contextChangedEvents.length = 0;

    const started = await harness.service.streamStart('ws-a', { localSessionId: 'local-a' });
    expect(started.viewerSessionId).toBe('desktop-1');

    await vi.waitFor(() => {
      expect(harness.contextChangedEvents.length).toBeGreaterThan(0);
    });
    // 拉起观看端让 A 的上下文多了 viewerSessionId：事件只属于 A。
    for (const event of harness.contextChangedEvents) {
      expect(event.localSessionId).toBe('local-a');
      expect(event.context?.workspaceId).toBe('ws-a');
    }
    // B 的桶没有被刷新（列 B 的上下文仍来自它自己的读取）。
    expect(harness.contextChangedEvents.some((event) => event.localSessionId === 'local-b')).toBe(
      false,
    );
  });
});

/* ==================== stale 闸门的新鲜度（checkedAt） ==================== */

describe('管理页：写操作闸门的新鲜度', () => {
  it('过旧的可写状态会重新解析：PSB 恢复后「启动」不再被旧失败永久拦住', async () => {
    let now = Date.parse('2026-11-26T00:00:00.000Z');
    const harness = createHarness({
      now: () => now,
      recent: { lastWorkspaceId: WORKSPACE_ID },
    });
    await harness.service.context({ localSessionId: null });

    harness.behavior.listWorkspaces = async () => {
      throw unreachable();
    };
    const stale = await harness.service.context({ localSessionId: null });
    expect(stale.context?.stale).toBe(true);

    // 结论还新鲜：直接给可行动失败（不再为每次点击打一次 20s 超时）。
    const blocked = await harness.service.streamStart(WORKSPACE_ID).catch((cause: unknown) => cause);
    expect((blocked as PsbClientError).failure.code).toBe('WORKSPACE_UNREACHABLE');
    expect(harness.lockChecks).toHaveLength(0);

    now += 1_000;
    const stillBlocked = await harness.service
      .streamStart(WORKSPACE_ID)
      .catch((cause: unknown) => cause);
    expect((stillBlocked as PsbClientError).failure.code).toBe('WORKSPACE_UNREACHABLE');
    expect(harness.lockChecks).toHaveLength(0);

    // 超过信任窗口：重新解析，PSB 已恢复 → 正常启动。
    harness.behavior.listWorkspaces = async () => [workspaceRow()];
    now += 60_000;
    const started = await harness.service.streamStart(WORKSPACE_ID);
    expect(started.viewerSessionId).toBe('desktop-1');
    expect(harness.lockChecks).toEqual([WORKSPACE_ID]);
    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID]);
  });

  it('写路径遇到 NOT_FOUND 后不标 live：第二次启动直接给「工作区已不可见」且不再打 PSB', async () => {
    const harness = createHarness({ recent: { lastWorkspaceId: WORKSPACE_ID } });
    await harness.service.context({ localSessionId: null });

    harness.behavior.ensureWorkspaceLocked = async () => {
      throw notFound();
    };
    const first = (await harness.service
      .streamStart(WORKSPACE_ID)
      .catch((cause: unknown) => cause)) as PsbClientError;
    expect(first.failure.code).toBe('NOT_FOUND');
    expect(harness.lockChecks).toHaveLength(1);

    const second = (await harness.service
      .streamStart(WORKSPACE_ID)
      .catch((cause: unknown) => cause)) as PsbClientError;
    // 闸门吸收失败：不再打占用闸门 / 订阅；失败码与 messageKey 给「工作区已不可见」，
    // 原文只放 PSB 的话（不写中文兜底）。
    expect(second.failure).toMatchObject({
      code: 'WORKSPACE_MISSING',
      messageKey: 'remoteWorkspace.admin.staleMissingAction',
      message: '会话不存在',
    });
    expect(harness.lockChecks).toHaveLength(1);
    expect(harness.subscribeCalls).toHaveLength(0);
  });

  // 2026-11-27 审查 s2 P1（startStreamWithRecovery 归因）：观看会话（`startStream(<sessionId>)`）
  // 的 404 是**会话级**的，不能被吸收成「工作区不可见」—— 否则下一次点「启动」会被错误的
  // stale 闸门永久拦住，而工作区其实好好的。最小失败输入：会话起的 notFound 被 absorb 后，
  // 第二次启动直接 WORKSPACE_MISSING 且不再打 PSB。
  it('观看会话级 NOT_FOUND 不吸收成工作区不可见：第二次启动仍打 PSB，归因保持会话级', async () => {
    const harness = createHarness({ recent: { lastWorkspaceId: WORKSPACE_ID } });
    await harness.service.context({ localSessionId: null });

    harness.behavior.startStream = async () => {
      throw notFound();
    };
    const first = (await harness.service
      .streamStart(WORKSPACE_ID)
      .catch((cause: unknown) => cause)) as PsbClientError;
    expect(first.failure.code).toBe('NOT_FOUND');
    expect(harness.lockChecks).toHaveLength(1);

    const second = (await harness.service
      .streamStart(WORKSPACE_ID)
      .catch((cause: unknown) => cause)) as PsbClientError;
    // 工作区仍被当成可写：重新走占用闸门 + 订阅，而不是直接给 stale 的 WORKSPACE_MISSING。
    expect(second.failure.code).toBe('NOT_FOUND');
    expect(harness.lockChecks).toHaveLength(2);
    expect(harness.subscribeCalls.length).toBeGreaterThan(0);
  });

  it('占位身份用专门 staleReason 与专门失败码（不是 notFound / unreachable）', async () => {
    const harness = createHarness({
      behavior: {
        localRemoteHostId: 'psb:psb-legacy',
        sessionStatus: async () => {
          throw notFound();
        },
      },
    });
    harness.deps.readLocalSessionHint = async () => ({
      remoteHostId: 'psb:psb-legacy',
      title: '修一下检出脚本',
      workingDir: '/psb-remote/saga2_project-9',
    });

    const { context } = await harness.service.context({ localSessionId: 'local-legacy' });
    expect(context).toMatchObject({
      staleReason: 'unknown-workspace',
      workspaceIdKnown: false,
    });

    const error = (await harness.service
      .streamStart('psb:psb-legacy')
      .catch((cause: unknown) => cause)) as PsbClientError;
    expect(error.failure).toMatchObject({
      code: 'WORKSPACE_ID_UNKNOWN',
      messageKey: 'remoteWorkspace.admin.staleUnknownWorkspaceAction',
      message: null,
    });
    expect(harness.lockChecks).toHaveLength(0);
    expect(harness.subscribeCalls).toHaveLength(0);
  });
});

/* ==================== 启发式匹配的持久化边界 ==================== */

describe('管理页：启发式匹配只在内存', () => {
  function heuristicHarness(): Harness {
    const harness = createHarness({
      behavior: {
        localRemoteHostId: 'psb:psb-legacy',
        sessionStatus: async () => {
          throw notFound();
        },
        listWorkspaces: async () => [
          workspaceRow({ id: 'ws-matched', title: 'saga2_project', directoryName: 'saga2_project-9' }),
        ],
      },
    });
    harness.deps.readLocalSessionHint = async () => ({
      remoteHostId: 'psb:psb-legacy',
      title: '修一下检出脚本',
      workingDir: '/psb-remote/saga2_project-9',
    });
    return harness;
  }

  it('目录启发式命中不写会话映射 / 快照；占用成功确认后才落固定信息快照', async () => {
    const harness = heuristicHarness();
    const { context } = await harness.service.context({ localSessionId: 'local-legacy' });
    expect(context?.workspaceId).toBe('ws-matched');
    expect(harness.deps.store.workspaceIdForSession('psb-legacy')).toBeNull();
    expect(harness.deps.store.workspaceSnapshot('ws-matched')).toBeNull();

    // 用户点「启动」并在 PSB 上锁定成功：这一刻 PSB 已确认工作区存在，快照可以落盘。
    await harness.service.streamStart('ws-matched');
    expect(harness.deps.store.workspaceSnapshot('ws-matched')?.title).toBe('saga2_project');
    // 但会话 → 工作区映射仍不写：那是**身份**，启发式没有资格决定它。
    expect(harness.deps.store.workspaceIdForSession('psb-legacy')).toBeNull();
  });
});

/* ==================== 过渡回退内部会话的收尸 ==================== */

describe('管理页：过渡回退内部会话收尸', () => {
  it('回退会话起观看端失败 → best-effort stopSession 回滚，且不留绑定记录', async () => {
    const harness = createHarness({
      behavior: {
        subscribeWorkspaceStream: async () => {
          throw subscribeUnavailable('unsupported');
        },
        startStream: async () => {
          throw unreachable();
        },
      },
    });

    const error = (await harness.service
      .streamStart(WORKSPACE_ID)
      .catch((cause: unknown) => cause)) as PsbClientError;

    expect(error.failure.code).toBe('PSB_UNREACHABLE');
    expect(harness.createSessionCalls).toHaveLength(1);
    // 内部会话被结束（best-effort），本机绑定记录不保留（下一次启动重新订阅，不残留死 id）。
    expect(harness.stoppedSessionCalls).toEqual(['internal-1']);
    expect(harness.deps.store.desktopSessionIdForWorkspace(WORKSPACE_ID)).toBeNull();
  });

  it('PSB 说回退会话已结束 → 丢绑定并结束内部会话', async () => {
    const harness = createHarness({
      behavior: {
        subscribeWorkspaceStream: async () => {
          throw subscribeUnavailable('unsupported');
        },
      },
    });
    const started = await harness.service.streamStart(WORKSPACE_ID);
    expect(started.viewerSessionId).toBe('internal-1');

    harness.emitStreamEvent({
      type: 'closed',
      sessionId: 'internal-1',
      reason: 'session-ended',
      detail: { reasonCode: null, desktopSession: null, messageZh: '会话已结束' },
    });

    expect(harness.deps.store.desktopSessionIdForWorkspace(WORKSPACE_ID)).toBeNull();
    await vi.waitFor(() => {
      expect(harness.stoppedSessionCalls).toEqual(['internal-1']);
    });
  });

  it('新订阅成功后按 TTL 清理仍被引用的旧回退会话（另一工作区正常订阅触发）', async () => {
    let now = Date.parse('2026-11-26T00:00:00.000Z');
    const harness = createHarness({
      now: () => now,
      behavior: {
        subscribeWorkspaceStream: async (workspaceId) => {
          if (workspaceId === WORKSPACE_ID) throw subscribeUnavailable('route-404');
          return subscription('desktop-other');
        },
      },
    });
    const fallback = await harness.service.streamStart(WORKSPACE_ID);
    expect(fallback.viewerSessionId).toBe('internal-1');

    // 另一个工作区（旧 PSB 上不存在该问题）用工作区级订阅成功；此时旧回退会话已存活超过 TTL。
    now += 31 * 60_000;
    harness.behavior.listWorkspaces = async () => [
      workspaceRow(),
      workspaceRow({ id: 'ws-other', title: 'other', directoryName: 'dir-other' }),
    ];
    const other = await harness.service.streamStart('ws-other');
    expect(other.viewerSessionId).toBe('desktop-other');

    await vi.waitFor(() => {
      expect(harness.stoppedSessionCalls).toEqual(['internal-1']);
    });
    // 正在用的观看端不会被误停。
    expect(harness.stopStreamCalls).not.toContain('desktop-other');
  });
});

/* ==================== 启动 / 停止的串行与代次 ==================== */

describe('管理页：启动与停止的互斥', () => {
  it('启动落定前收到停止 → 自动停掉刚起的串流，排队的 stop 不重复停', async () => {
    const pendingStart: { resolve: ((status: PsbSessionStreamStatus) => void) | null } = {
      resolve: null,
    };
    const harness = createHarness({
      behavior: {
        startStream: () =>
          new Promise<PsbSessionStreamStatus>((resolve) => {
            pendingStart.resolve = resolve;
          }),
      },
    });

    const startPromise = harness.service.streamStart(WORKSPACE_ID);
    await vi.waitFor(() => {
      expect(harness.startStreamCalls).toEqual(['desktop-1']);
    });
    const stopPromise = harness.service.streamStop(WORKSPACE_ID);
    pendingStart.resolve?.(streamStatus());
    const [started] = await Promise.all([startPromise, stopPromise]);

    // 启动返回「未在播」，并且刚起的串流真的被停掉（不把用户已经点过停止的观看留在远端）。
    expect(started.viewerSessionId).toBe('desktop-1');
    expect(started.status.active).toBe(false);
    expect(harness.stopStreamCalls).toEqual(['desktop-1']);

    // 之后再启动：复用同一条绑定，正常起观看端。
    harness.behavior.startStream = async () => streamStatus({ active: true });
    const again = await harness.service.streamStart(WORKSPACE_ID);
    expect(again.status.active).toBe(true);
    expect(harness.subscribeCalls).toEqual([WORKSPACE_ID]);
    expect(harness.startStreamCalls).toEqual(['desktop-1', 'desktop-1']);
  });
});

/* ==================== 失败码 / 文案口径 ==================== */

describe('管理页：失败码与文案口径（main 不自写中文）', () => {
  it('stale / 不可达失败只给码 + messageKey + PSB 原文，不出现自写中文兜底句', async () => {
    const harness = createHarness({ recent: { lastWorkspaceId: WORKSPACE_ID } });
    await harness.service.context({ localSessionId: null });
    harness.behavior.listWorkspaces = async () => {
      throw unreachable();
    };
    await harness.service.context({ localSessionId: null });

    const error = (await harness.service
      .streamStart(WORKSPACE_ID)
      .catch((cause: unknown) => cause)) as PsbClientError;

    expect(error.failure).toMatchObject({
      code: 'WORKSPACE_UNREACHABLE',
      messageKey: 'remoteWorkspace.admin.staleUnavailableAction',
      message: '连不上 PSB',
    });
    // 旧实现会在这里自写「暂时连不上…请检查网络后重试。」；现在文案只来自 i18n。
    expect(error.failure.message).not.toContain('请检查网络后重试');
    expect(error.failure.message).not.toContain('无法继续操作');
  });
});

/* ==================== context 读取失败不崩 ==================== */

describe('管理页：context 的初始错误容错', () => {
  it('读会话行线索抛错时不向上抛：退化为最近使用的工作区并留 warn', async () => {
    const harness = createHarness({ recent: { lastWorkspaceId: WORKSPACE_ID } });
    harness.deps.readLocalSessionHint = async () => {
      throw new Error('localDb is down');
    };
    harness.deps.readLocalSessionRemoteHostId = async () => {
      throw new Error('localDb is down');
    };

    const result = await harness.service.context({ localSessionId: 'local-1' });

    expect(result.context?.workspaceId).toBe(WORKSPACE_ID);
    expect(harness.warnings.length).toBeGreaterThan(0);
  });
});

/* ============================== 账号边界 ============================== */

describe('管理页：账号边界', () => {
  it('PSB 服务换实例（dispose 后重新装配）→ 丢掉旧绑定；旧账号的绑定不可复用时重新订阅', async () => {
    const harness = createHarness();
    const started = await harness.service.streamStart(WORKSPACE_ID);
    expect(started.viewerSessionId).toBe('desktop-1');

    // 新账号看不到旧身份的桌面访问会话：记录里的 id 读不到 → 清记录（读路径不订阅）。
    harness.swapRemote({
      streamStatus: async (sessionId) => {
        if (sessionId === 'desktop-1') throw notFound();
        return streamStatus();
      },
    });
    const { context } = await harness.service.context({ localSessionId: null });

    expect(context?.workspaceId).toBe(WORKSPACE_ID);
    expect(context?.viewerSessionId).toBeNull();
    expect(harness.deps.store.desktopSessionIdForWorkspace(WORKSPACE_ID)).toBeNull();

    // 用户在页面上点「启动」：按新账号重新订阅并落盘。
    const restarted = await harness.service.streamStart(WORKSPACE_ID);
    expect(restarted.viewerSessionId).toBe('desktop-2');
    expect(harness.createSessionCalls).toHaveLength(0);
    expect(harness.deps.store.desktopSessionIdForWorkspace(WORKSPACE_ID)).toBe('desktop-2');
  });
});
