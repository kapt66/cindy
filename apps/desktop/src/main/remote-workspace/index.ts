/**
 * PSB 远程工作区服务（main 进程单例装配）。
 *
 * ## 职责边界
 *
 * 本模块是「远程工作区」在 main 的**唯一服务入口**：把 HTTP 客户端（`psbClient`）、串流观看端
 * （`streamViewer`）、推送（`push`）与宿主依赖（登录态 / Connection JWT 签发 / 出网 / 日志）
 * 装到一起，向 IPC 层暴露一组语义方法。IPC 层只做参数校验与错误映射，不自己拼 URL、不自己取 token。
 *
 * ## 依赖注入
 *
 * 生产依赖全部来自宿主既有装配；`createPsbRemoteService` 接受同样的形状，便于单测注入假实现。
 * 三条与本模块相关的约束：
 *
 * 1. **token 只在运行时取**：`getConnectionTokenProvider()` 是 `cindy-brain/index.ts` 的导出，
 *    该模块图很大且与 `maker-host` 互相引用。这里只保存函数引用、在真正发起请求时才调用，
 *    避免模块求值顺序把循环依赖变成 undefined。
 * 2. **出网走宿主封装**：HTTP 用 `outboundFetch`（吃系统代理），WS 用 `createOutboundHttpAgent`
 *    （`ws` 的 agent），与 MCPRouter / 插件出网同一套口径；不做明文 `ws://` 降级。
 * 3. **推送只经 `push.ts`**：服务不直接碰 `BrowserWindow`，广播判据收在一处。
 */

import type { AuthState } from '../authManager.js';
import { getAuthState } from '../authManager.js';
import { getConnectionTokenProvider } from '../cindy-brain/index.js';
import { createLogger } from '../logger.js';
import { createOutboundHttpAgent, outboundFetch } from '../maker-host/outbound-fetch.desktop.js';

import type {
  PsbCreateSessionRequest,
  PsbCreateSessionResult,
  PsbCreateWorkspaceRequest,
  PsbProjectTemplate,
  PsbRemoteClient,
  PsbRemoteSession,
  PsbRemoteStatus,
  PsbRemoteWorkspace,
  PsbSessionStatusResult,
  PsbSessionStreamStatus,
  PsbStreamEvent,
  PsbWorkspaceChangedEvent,
} from '../../shared/psb-remote-workspace.js';
import { createPsbApi, readWorkspaceWebUrl } from './psbClient.js';
import type { PsbApi } from './psbClient.js';
import {
  getPsbConnectionToken,
  resolvePsbConnectionIdentity,
  type PsbConnectionTokenPort,
} from './psbAuth.js';
import { resolvePsbEndpoint } from './psbEndpoint.js';
import { broadcastPsbStreamEvent, broadcastPsbWorkspaceChanged } from './push.js';
import { createPsbStreamViewer } from './streamViewer.js';
import {
  createPsbWorkspaceLock,
  psbWorkspaceLockFailure,
  type PsbWorkspaceLockResult,
} from './workspaceLock.js';

/** 服务用到的日志面（生产 = `createLogger('psb-remote')`）。 */
interface PsbServiceLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface PsbRemoteServiceDeps {
  getAuthState(): AuthState;
  /** 只取函数引用；真正取 token 时才调用（见文件头第 1 条）。 */
  getConnectionTokenProvider(): PsbConnectionTokenPort;
  fetch(input: string, init: RequestInit): Promise<Response>;
  createHttpAgent(url: string): Promise<unknown>;
  logger: PsbServiceLogger;
  emitStreamEvent(event: PsbStreamEvent): void;
  emitWorkspaceChanged(event: PsbWorkspaceChangedEvent): void;
}

export interface PsbRemoteService {
  /** 入口可用性（登录态 + 企业组织 + 当前生效站点）。不发网络请求。 */
  status(): PsbRemoteStatus;
  listWorkspaces(input?: { clientId?: string; readyOnly?: boolean }): Promise<PsbRemoteWorkspace[]>;
  listClients(): Promise<PsbRemoteClient[]>;
  listProjectTemplates(): Promise<PsbProjectTemplate[]>;
  createWorkspace(input: PsbCreateWorkspaceRequest): Promise<PsbRemoteWorkspace>;
  occupyWorkspace(workspaceId: string): Promise<PsbRemoteWorkspace>;
  releaseWorkspace(workspaceId: string): Promise<PsbRemoteWorkspace>;
  /**
   * 写操作前的占用闸门：确保工作区由当前身份锁定（未占用则自动占用）。
   *
   * 失败抛 `PsbClientError`（被他人占用带人名 / 离线 / 工作区不可用 → 对应 `PSB_*` 码；
   * 网络与鉴权失败原样抛）。口径见 `main/remote-workspace/workspaceLock.ts`。
   */
  ensureWorkspaceLocked(workspaceId: string): Promise<void>;
  /**
   * 发送前的占用闸门（按 PSB 会话定位工作区）。
   *
   * 读一次 PSB 会话行（自带工作区快照）判断占用；乐观有效期内命中缓存则零网络请求。
   * 会话已读不到时按 `PSB_NOT_FOUND` 抛出（调用方先走重建，再重试本轮）。
   */
  ensureWorkspaceLockedForSession(psbSessionId: string): Promise<void>;
  createSession(input: PsbCreateSessionRequest): Promise<PsbCreateSessionResult>;
  /**
   * 某工作区里可见的 PSB 会话（含网页建的、别人的）。
   *
   * **管理页不再用它认领内部观看端会话**（2026-11-26 审查修正）：这个列表是全工作区可见范围，
   * 按标题认领会认到别人的会话；复用只认本机记录里的 `viewers[workspaceId]`
   * （`adminRecentStore.ts`）。该方法保留为 PSB 会话读口，供诊断 / 未来工作区级迁移使用。
   */
  listSessions(workspaceId: string): Promise<PsbRemoteSession[]>;
  sessionStatus(sessionId: string): Promise<PsbSessionStatusResult>;
  stopSession(sessionId: string): Promise<void>;
  /**
   * 解析某工作区的 PSB 网页地址（已按当前站点根归一）。
   *
   * 返回 `null` 表示 PSB 没给 `webUrl`，或该工作区不在当前身份可见范围内（不是错误：
   * 调用方给「找不到工作区」的可行动提示）。**读口顺序在 `psbClient.readWorkspaceWebUrl`**：
   * 列表口优先、单行 GET 仅兜底（Cindy 身份下单行 GET 恒 403，2026-11-26 真机事故）。
   */
  resolveWorkspaceWebUrl(workspaceId: string): Promise<string | null>;
  getStreamStatus(sessionId: string): Promise<PsbSessionStreamStatus>;
  startStream(sessionId: string): Promise<PsbSessionStreamStatus>;
  stopStream(sessionId: string): Promise<void>;
  sendStreamInput(sessionId: string, event: Record<string, unknown>): Promise<void>;
  /**
   * 订阅本进程内的串流事件（返回退订函数）。
   *
   * 给**副消费者**用：管理页用自己的内部观看端会话订阅串流，需要按 `sessionId` 过滤后转成
   * `psb-remote:admin-stream-event`。渲染层的两条推送仍只经 `push.ts`，这里不碰。
   */
  onStreamEvent(listener: (event: PsbStreamEvent) => void): () => void;
  /** 进程退出 / 账号边界：断开全部串流连接。 */
  dispose(): void;
}

/** 单条工作区写入后推给 renderer：工作区行快照（`null` = 已不可见）。 */
function emitWorkspaceSnapshot(
  deps: PsbRemoteServiceDeps,
  workspace: PsbRemoteWorkspace | null,
): void {
  if (!workspace) return;
  deps.emitWorkspaceChanged({ workspaceId: workspace.id, workspace });
}

export function createPsbRemoteService(deps: PsbRemoteServiceDeps): PsbRemoteService {
  const tokens: PsbConnectionTokenPort = {
    getToken: (input) => deps.getConnectionTokenProvider().getToken(input),
    invalidate: (input) => {
      deps.getConnectionTokenProvider().invalidate(input);
    },
  };

  const api: PsbApi = createPsbApi({
    fetch: deps.fetch,
    getAuthState: deps.getAuthState,
    tokens,
    logger: deps.logger,
  });

  /** 副消费者（管理页的内部观看端）的串流事件订阅者；渲染层推送仍只经 `push.ts`。 */
  const streamListeners = new Set<(event: PsbStreamEvent) => void>();

  /** 写操作前的占用闸门（会话级与工作区级共用同一份 TTL 缓存，见 `workspaceLock.ts`）。 */
  const workspaceLock = createPsbWorkspaceLock({
    listWorkspaces: () => api.listWorkspaces(),
    occupyWorkspace: (workspaceId) => api.occupyWorkspace(workspaceId),
    // 发送前闸门读会话行（自带工作区快照）：比工作区列表轻，且天然「足够新」。
    readSession: (psbSessionId) => api.getSession(psbSessionId),
    logger: deps.logger,
  });

  /** 占用闸门失败 → 抛出可跨 IPC 的失败（成功时无事发生）。 */
  function throwIfWorkspaceLockFailed(result: PsbWorkspaceLockResult): void {
    const failure = psbWorkspaceLockFailure(result);
    if (failure) throw failure;
  }

  /** 工作区级闸门（新会话创建 / 管理页启动串流等写操作）。 */
  async function ensureWorkspaceLocked(workspaceId: string): Promise<void> {
    throwIfWorkspaceLockFailed(await workspaceLock.ensure(workspaceId));
  }

  /** 发送前闸门：乐观有效期内零请求；否则读一次会话行再判断。 */
  async function ensureWorkspaceLockedForSession(psbSessionId: string): Promise<void> {
    throwIfWorkspaceLockFailed(await workspaceLock.ensureForSession(psbSessionId));
  }

  const viewer = createPsbStreamViewer({
    getToken: () => getPsbConnectionToken({ getAuthState: deps.getAuthState, tokens }),
    fetchStatus: (sessionId) => api.getStreamStatus(sessionId),
    createHttpAgent: (url) => deps.createHttpAgent(url),
    emit: (event) => {
      deps.emitStreamEvent(event);
      // 订阅者出错不能影响其它订阅者与渲染层推送：逐个隔离。
      for (const listener of streamListeners) {
        try {
          listener(event);
        } catch {
          /* 订阅者是进程内模块，异常只在它自己那边处理 */
        }
      }
    },
    logger: deps.logger,
  });

  return {
    status() {
      const endpoint = resolvePsbEndpoint();
      const resolution = resolvePsbConnectionIdentity(deps.getAuthState());
      if (resolution.kind !== 'ready') {
        return {
          ready: false,
          reasonKey: resolution.reasonKey,
          host: endpoint.host,
          testHost: endpoint.testHost,
        };
      }
      return { ready: true, reasonKey: null, host: endpoint.host, testHost: endpoint.testHost };
    },

    listWorkspaces: (input) => api.listWorkspaces(input),
    listClients: () => api.listClients(),
    listProjectTemplates: () => api.listProjectTemplates(),

    async createWorkspace(input) {
      const workspace = await api.createWorkspace(input);
      emitWorkspaceSnapshot(deps, workspace);
      return workspace;
    },

    async occupyWorkspace(workspaceId) {
      const workspace = await api.occupyWorkspace(workspaceId);
      workspaceLock.invalidate(workspaceId);
      emitWorkspaceSnapshot(deps, workspace);
      return workspace;
    },

    async releaseWorkspace(workspaceId) {
      const workspace = await api.releaseWorkspace(workspaceId);
      // 释放之后「已由我锁定」的乐观缓存立刻失效：下一次写操作要重新确认。
      workspaceLock.invalidate(workspaceId);
      emitWorkspaceSnapshot(deps, workspace);
      return workspace;
    },

    ensureWorkspaceLocked,

    async ensureWorkspaceLockedForSession(psbSessionId) {
      await ensureWorkspaceLockedForSession(psbSessionId);
    },

    async createSession(input) {
      // 新会话属于工作区写操作：PSB 会对未锁定者拒绝写入，Cindy 必须自己先锁定。
      // 占用人名/离线/未就绪都会在这里变成可行动的 PSB_* 失败，且不建会话、不落库。
      await ensureWorkspaceLocked(input.workspaceId);
      const result = await api.createSession(input);
      // 会话数是工作区行的投影（列表徽标），创建成功后其他窗口也要看到。
      emitWorkspaceSnapshot(deps, result.workspace);
      return result;
    },

    sessionStatus: (sessionId) => api.getSession(sessionId),
    listSessions: (workspaceId) => api.listSessions(workspaceId),
    stopSession: (sessionId) => api.stopSession(sessionId),

    async resolveWorkspaceWebUrl(workspaceId) {
      // 读口顺序与失败口径收在 `psbClient.readWorkspaceWebUrl`：列表优先、单行仅兜底
      // （Cindy 身份下单行 GET 恒 403，2026-11-26 真机事故）。
      return readWorkspaceWebUrl(api, workspaceId);
    },

    getStreamStatus: (sessionId) => api.getStreamStatus(sessionId),
    startStream: (sessionId) => viewer.start(sessionId),
    stopStream: (sessionId) => viewer.stop(sessionId),
    sendStreamInput: (sessionId, event) => viewer.sendInput(sessionId, event),
    onStreamEvent(listener) {
      streamListeners.add(listener);
      return () => {
        streamListeners.delete(listener);
      };
    },
    dispose: () => {
      // 先退订：dispose 会断开全部连接并把「本端主动断开」归因，订阅者不必再看这些事件。
      streamListeners.clear();
      workspaceLock.clear();
      viewer.dispose();
    },
  };
}

function createDefaultDeps(): PsbRemoteServiceDeps {
  return {
    getAuthState,
    getConnectionTokenProvider,
    fetch: outboundFetch,
    createHttpAgent: createOutboundHttpAgent,
    logger: createLogger('psb-remote'),
    emitStreamEvent: broadcastPsbStreamEvent,
    emitWorkspaceChanged: broadcastPsbWorkspaceChanged,
  };
}

let serviceSingleton: PsbRemoteService | null = null;

/** 进程内单例；IPC 注册与后续 transport 接线都从这里取。 */
export function getPsbRemoteService(): PsbRemoteService {
  if (!serviceSingleton) serviceSingleton = createPsbRemoteService(createDefaultDeps());
  return serviceSingleton;
}

/**
 * 释放单例（退出/账号边界/单测）。
 *
 * 幂等：没有已建实例时是 no-op；释放后下一次 `getPsbRemoteService()` 会重新装配。
 */
export function disposePsbRemoteService(): void {
  const current = serviceSingleton;
  serviceSingleton = null;
  current?.dispose();
}
