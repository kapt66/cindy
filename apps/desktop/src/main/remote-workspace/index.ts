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
  PsbWorkspaceStreamSubscription,
} from '../../shared/psb-remote-workspace.js';
import type {
  PsbRunWorkspaceVcsActionResponse,
  WorkspaceVcsActionKind,
  WorkspaceVcsNotice,
  WorkspaceVcsOperation,
} from '../../shared/psb-workspace-vcs.js';
import { workspaceVcsActionIsIrreversible } from '../../shared/psb-workspace-vcs.js';
import { createIpcError } from '../../shared/ipc-errors.js';
import {
  createPsbApi,
  PsbClientError,
  readWorkspaceVcsOperationId,
  readWorkspaceWebUrl,
} from './psbClient.js';
import type { PsbApi, PsbWorkspaceAccessEnsureOutcome } from './psbClient.js';
import {
  getPsbConnectionToken,
  resolvePsbConnectionIdentity,
  type PsbConnectionTokenPort,
} from './psbAuth.js';
import { resolvePsbEndpoint } from './psbEndpoint.js';
import {
  broadcastPsbWorkspaceChanged,
  broadcastPsbWorkspaceVcsNotice,
} from './push.js';
// 「工作区会话启动 / 占用成功」= 固定信息（名称 / 模板 / 机器）的落盘点：PSB 以后读不到
// （断网 / 设备掉线 / 工作区被删）时，管理页仍能显示当初是哪个工作区（2026-11-26 真机事故）。
import { recordPsbSessionWorkspace, recordPsbWorkspaceSeen } from './adminRecentRuntime.js';
// 账号边界 / teardown 时出账待释放工作区：旧账号的锁只能用旧身份归还，新身份重试是越权
// （见 `maker-host/psb-workspace-session-release.ts` 文件头「账本」）。
import { clearPendingWorkspaceReleases } from '../maker-host/psb-workspace-session-release.js';
import { createPsbStreamViewer } from './streamViewer.js';
import {
  createWorkspaceVcsNoticeCache,
  sanitizeWorkspaceVcsNotice,
} from './vcsNotice.js';
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
  emitWorkspaceChanged(event: PsbWorkspaceChangedEvent): void;
  /** 工作区被版本控制检查拒绝时广播 notice（`notice:null` = 已解除；CINDY-RW-10）。 */
  emitWorkspaceVcsNotice(event: {
    workspaceId: string;
    operation: WorkspaceVcsOperation;
    notice: WorkspaceVcsNotice | null;
  }): void;
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
   * 读某工作区当前的版本控制检查通知（CINDY-RW-10 更正版）。
   *
   * 占用 / 解除占用被拒时 main 会把 `error.details.vcs` 写进有界缓存并广播；渲染层拿到 invoke
   * 失败后用它兜底读取（推送与失败到渲染层的先后顺序不可依赖）。`null` = 该工作区没有 notice。
   */
  readWorkspaceVcsNotice(workspaceId: string): WorkspaceVcsNotice | null;
  /**
   * 执行一条版本控制处置动作（`inspect-vcs` / `revert-then-occupy` / `revert-then-release` /
   * `retry`）。渲染层只传 kind，method / path / body 由 main 从服务端 notice 的有界缓存取，
   * 并在执行前重新做工作区绑定 / 白名单校验（见 `vcsNotice.ts`）。
   *
   * `revert-then-*` 是**不可逆**动作：缺 `confirm:true` 直接 `INVALID_PARAMS`（即使 IPC 被绕过）。
   * 成功后失效占用缓存并推工作区快照；失败若仍带 `vcs` 会刷新缓存并再次广播。
   */
  runWorkspaceVcsAction(input: {
    workspaceId: string;
    kind: WorkspaceVcsActionKind;
    confirm?: boolean;
  }): Promise<PsbRunWorkspaceVcsActionResponse>;
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
   * 订阅某工作区的串流（PSB 0.1.172 工作区级服务接口）。
   *
   * 只解析该工作区当前 `running` 的**桌面访问会话**并返回它的 id：**不创建任何 Agent 会话**。
   * 观看端 WS 与 `stream/status` 过渡期同时接受桌面访问会话 id 与 agent 会话 id（PSB 口径）。
   * 没有 running 访问会话时失败抛 `PsbClientError`（404/409 + PSB 可读原因），不要在这里自动
   * 拉起桌面访问（那会绕过人的确认）。
   */
  subscribeWorkspaceStream(workspaceId: string): Promise<PsbWorkspaceStreamSubscription>;
  /**
   * **尽力**拉起该工作区的桌面访问（可选增强；失败一律非致命）。
   *
   * 走 PSB 通用网页接口 `POST /api/remote/workspaces/:id/access/start`（幂等 ensure）并轮询
   * `GET /api/cindy/remote/workspaces/:id/access` 到 `running` 或预算用尽。Cindy Bearer 当前
   * **未被放行** `/api/remote/**`（恒 403），所以 403/404/405 一律收敛成
   * `reason:'cindy-entry-not-open'`，调用方继续走原有错误路径。**不抛异常**。
   */
  ensureWorkspaceAccess(workspaceId: string): Promise<PsbWorkspaceAccessEnsureOutcome>;
  /**
   * 某工作区里可见的 PSB 会话（含网页建的、别人的）。
   *
   * **管理页不用它认领任何会话**（2026-11-26 审查 + 0.1.172 服务接口）：这个列表是全工作区
   * 可见范围，按标题认领会认到别人的会话；管理页的观看端只认工作区级 `stream/subscribe`
   * 返回的桌面访问会话 id（本机记录持久化）。该方法保留为 PSB 会话读口，供诊断 / 未来工作区级
   * 迁移使用。
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
   * 给**副消费者**用：管理页用自己的观看端绑定（桌面访问会话）订阅串流，需要按 `sessionId`
   * 过滤后转成 `psb-remote:admin-stream-event`。渲染层的两条推送仍只经 `push.ts`，这里不碰。
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

  /** 副消费者（管理页的工作区级观看端）的串流事件订阅者；渲染层推送仍只经 `push.ts`。 */
  const streamListeners = new Set<(event: PsbStreamEvent) => void>();

  /**
   * 版本控制检查通知的有界缓存（CINDY-RW-10）。
   *
   * 两种来源：0.1.180 的 2xx `data.vcs`（`advisory:true`，主路径）与旧版 409
   * `error.details.vcs`（兼容路径）。成功占用 / 释放 / 清理或继续后清除。渲染层读它来渲染
   * 「查看详情 / 一键清理 / 继续」——IPC 错误只能带 code+message，带不了 actions。
   */
  const vcsNotices = createWorkspaceVcsNoticeCache();

  /** 清除某工作区的 VCS 通知；清掉过就广播 `notice:null`（让常驻提示条消失）。 */
  function clearWorkspaceVcsNotice(workspaceId: string): void {
    const entry = vcsNotices.readEntry(workspaceId);
    if (!vcsNotices.clear(workspaceId)) return;
    deps.emitWorkspaceVcsNotice({
      workspaceId,
      operation: entry?.operation ?? 'ensure',
      notice: null,
    });
  }

  /**
   * 0.1.180 的**建议性**通知（占用 / 释放成功响应里的 `data.vcs`）：校验后缓存 + 广播。
   *
   * 非阻塞：操作已经成功，这里只负责把「检出脏，可一键清理」这条建议交给渲染层。
   * `dirty:false` / 缺省时不做任何事（契约允许不带）。
   */
  function rememberWorkspaceVcsAdvisory(
    workspaceId: string,
    raw: WorkspaceVcsNotice | null | undefined,
    operation: WorkspaceVcsOperation,
  ): void {
    if (!raw) return;
    const notice = sanitizeWorkspaceVcsNotice(workspaceId, raw, operation);
    if (!notice || !notice.dirty) return;
    if (!vcsNotices.remember(workspaceId, { ...notice, advisory: true }, operation)) return;
    deps.logger.info('psb workspace vcs advisory received', {
      workspaceId,
      operation,
      code: notice.code,
    });
    deps.emitWorkspaceVcsNotice({ workspaceId, operation, notice: { ...notice, advisory: true } });
  }

  /**
   * 旧版 409（`error.details.vcs`）兼容路径：校验工作区绑定后缓存 + 广播，**再原样重抛**。
   *
   * 校验失败（路径不属于这个工作区 / body 越界）只记日志、不缓存：宁可按普通 PSB 失败展示，
   * 也不把一份不可执行却看似可点的 notice 交给渲染层。
   */
  function captureWorkspaceVcsFailure(
    error: unknown,
    workspaceId: string,
    operation: WorkspaceVcsOperation,
  ): void {
    if (!(error instanceof PsbClientError) || !error.failure.vcs) return;
    const notice = sanitizeWorkspaceVcsNotice(workspaceId, error.failure.vcs, operation);
    if (!notice) {
      deps.logger.warn('psb workspace vcs notice failed validation; not cached', {
        workspaceId,
        code: error.failure.code,
      });
      return;
    }
    if (!vcsNotices.remember(workspaceId, notice, operation)) return;
    deps.emitWorkspaceVcsNotice({ workspaceId, operation, notice });
  }

  /**
   * 占用（手动 / 自动）。
   *
   * 0.1.180：成功响应可能带建议性 `vcs` → 缓存 + 广播（覆盖 `ensure` 自动占用入口）；
   * 成功且没有建议 → 清掉旧通知（此刻检查通过）。
   * 旧版：409 VCS → 缓存后重抛（兼容路径）。
   */
  async function occupyWithVcsNotice(
    workspaceId: string,
    operation: WorkspaceVcsOperation,
  ): Promise<PsbRemoteWorkspace> {
    try {
      const outcome = await api.occupyWorkspace(workspaceId);
      if (outcome.vcs) rememberWorkspaceVcsAdvisory(workspaceId, outcome.vcs, operation);
      else clearWorkspaceVcsNotice(workspaceId);
      return outcome.workspace;
    } catch (error) {
      captureWorkspaceVcsFailure(error, workspaceId, operation);
      throw error;
    }
  }

  /** 写操作前的占用闸门（会话级与工作区级共用同一份 TTL 缓存，见 `workspaceLock.ts`）。 */
  const workspaceLock = createPsbWorkspaceLock({
    listWorkspaces: () => api.listWorkspaces(),
    // 自动占用同样会产生 advisory：`occupyWithVcsNotice` 已在 'ensure' 入口缓存并广播，
    // 锁只拿工作区行判占用（advisory 通知的是渲染层，不是锁判据）。
    occupyWorkspace: async (workspaceId) => {
      const workspace = await occupyWithVcsNotice(workspaceId, 'ensure');
      return { workspace, vcs: null };
    },
    // 发送前闸门读会话行（自带工作区快照）：比工作区列表轻，且天然「足够新」。
    readSession: (psbSessionId) => api.getSession(psbSessionId),
    logger: deps.logger,
  });

  /** 占用闸门结果 → 可跨 IPC 的失败（成功时无事发生，advisory 已由占用端口广播）。 */
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
      // 串流事件只经本进程内的订阅者（管理页 `adminService` 把绑定会话的事件转成
      // `ADMIN_CHANNELS.STREAM_EVENT`，帧的定向投递在 `push.ts`）；会话级推送通道已删除。
      // 订阅者出错不能影响其它订阅者：逐个隔离。
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
      // 0.1.180 起占用恒成功；成功响应可能带**建议性** `data.vcs`（检出脏）→ 非阻塞提示。
      // 旧版 PSB 的 409 拒绝仍在 `occupyWithVcsNotice` 里按兼容路径缓存后重抛。
      const workspace = await occupyWithVcsNotice(workspaceId, 'occupy');
      workspaceLock.invalidate(workspaceId);
      emitWorkspaceSnapshot(deps, workspace);
      // 占用成功 = 一次新鲜的固定信息确认（用户建会话前必走这里）：落盘快照。
      recordPsbWorkspaceSeen(workspace);
      return workspace;
    },

    async releaseWorkspace(workspaceId) {
      try {
        const workspace = await api.releaseWorkspace(workspaceId);
        if (workspace.vcs) {
          // 释放成功但服务端建议「检出脏」：同样是 advisory，非阻塞提示（释放已生效）。
          rememberWorkspaceVcsAdvisory(workspaceId, workspace.vcs, 'release');
        } else {
          // 释放成功且没有建议 = 此刻工作区干净且已归还：旧 notice 撤掉（含常驻提示条）。
          clearWorkspaceVcsNotice(workspaceId);
        }
        // 释放之后「已由我锁定」的乐观缓存立刻失效：下一次写操作要重新确认。
        workspaceLock.invalidate(workspaceId);
        emitWorkspaceSnapshot(deps, workspace.workspace);
        // 释放响应也带工作区行：固定字段顺手再确认一次（值不变 0 次写）。
        recordPsbWorkspaceSeen(workspace.workspace);
        return workspace.workspace;
      } catch (error) {
        captureWorkspaceVcsFailure(error, workspaceId, 'release');
        throw error;
      }
    },

    readWorkspaceVcsNotice: (workspaceId) => vcsNotices.read(workspaceId),

    async runWorkspaceVcsAction(input) {
      const id = input.workspaceId.trim();
      if (!id) throw createIpcError('INVALID_PARAMS', 'workspaceId is required');

      /** 清掉提示 + 补一次工作区快照（动作已生效后调用）。 */
      async function refreshAfterAction(kind: WorkspaceVcsActionKind): Promise<void> {
        clearWorkspaceVcsNotice(id);
        try {
          const workspaces = await api.listWorkspaces();
          emitWorkspaceSnapshot(deps, workspaces.find((entry) => entry.id === id) ?? null);
        } catch (error) {
          deps.logger.warn('psb workspace vcs action succeeded but the workspace refresh failed', {
            workspaceId: id,
            kind,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // `continue` 只关提示：0.1.180 的语义就是「忽略提示，继续使用工作区」，不发任何请求。
      if (input.kind === 'continue') {
        workspaceLock.invalidate(id);
        clearWorkspaceVcsNotice(id);
        return {
          workspaceId: id,
          kind: input.kind,
          accepted: false,
          operationId: null,
          data: null,
        } satisfies PsbRunWorkspaceVcsActionResponse;
      }

      const action = vcsNotices.findAction(id, input.kind);
      if (!action || !action.method || !action.path) {
        // 缓存里没有这条动作（已被刷新 / 别的窗口先处理掉 / 服务端没下发）：不给猜测路径。
        throw createIpcError(
          'PRECONDITION_FAILED',
          'no actionable PSB workspace vcs action is cached for this workspace',
        );
      }
      // 不可逆动作（清理 / 还原）必须显式确认：渲染层弹二次确认后传 confirm:true；
      // main 不信「点了按钮」这件事（即使 IPC 被绕过也不能凭一个 kind 就还原用户检出）。
      if (workspaceVcsActionIsIrreversible(input.kind) && input.confirm !== true) {
        throw createIpcError('INVALID_PARAMS', 'this action requires explicit confirmation');
      }
      let data: unknown;
      try {
        data = await api.runRemoteAction({
          method: action.method,
          path: action.path,
          ...(action.body === undefined ? {} : { body: action.body }),
        });
      } catch (error) {
        // 旧版兼容路径：清理 / 重试之后仍被 409 拒绝 → 刷新 notice（新的 projects/actions 以
        // 服务端为准），再重抛。0.1.180 的清理是 202 异步，不会走到这里。
        captureWorkspaceVcsFailure(
          error,
          id,
          input.kind === 'revert-then-release' ? 'release' : 'occupy',
        );
        throw error;
      }
      workspaceLock.invalidate(id);
      const operationId = readWorkspaceVcsOperationId(data);
      if (input.kind !== 'inspect-vcs') {
        // 清理已接受（202）/ 旧版还原或重试成功：检查已通过（或动作已生效），撤掉提示条并
        // 补一次工作区快照。**不猜异步清理的轮询端点**：operationId 只给渲染层展示
        // 「清理已开始」，由用户点「刷新」重新读工作区（见 shared/psb-workspace-vcs.ts）。
        await refreshAfterAction(input.kind);
      }
      return {
        workspaceId: id,
        kind: input.kind,
        accepted: operationId !== null,
        operationId,
        data: data ?? null,
      } satisfies PsbRunWorkspaceVcsActionResponse;
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
      // `purpose: 'internal'` 的会话按 PSB 口径不进列表/计数，PSB 返回的工作区行也不会把它算进去。
      emitWorkspaceSnapshot(deps, result.workspace);
      // **会话启动那一刻**落盘固定信息快照 + `会话→工作区`映射（用户口径：这些数据是固定的，
      // 不能等以后每次打开页面再向服务器要）。重启 / PSB 读不到时靠它们兜底页面。
      recordPsbWorkspaceSeen(result.workspace);
      recordPsbSessionWorkspace(result.session.id, result.workspace.id);
      return result;
    },

    /**
     * 工作区级串流订阅（服务接口，**不创建 Agent 会话**）。
     *
     * 不经过占用闸门：读当前 running 桌面访问会话不是工作区写操作，PSB 也不要求锁定；订阅
     * 失败（404/409 + 可读原因）由调用方决定是展示还是走旧 PSB 的过渡回退。
     */
    subscribeWorkspaceStream: (workspaceId) => api.subscribeWorkspaceStream(workspaceId),

    /**
     * 尽力拉起桌面访问（可选增强，见 `PsbRemoteService.ensureWorkspaceAccess`）。
     *
     * 不经过占用闸门：它读/写的是**桌面访问**这一层（PSB 的服务接口），不是工作区占用；
     * 失败一律非致命，调用方（管理页 `streamStart`）继续走原订阅路径。
     */
    ensureWorkspaceAccess: (workspaceId) => api.ensureWorkspaceAccess(workspaceId),

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
    emitWorkspaceChanged: broadcastPsbWorkspaceChanged,
    emitWorkspaceVcsNotice: broadcastPsbWorkspaceVcsNotice,
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
 *
 * 同时**清空待释放账本**：账本条目带 dataOwner 印记，旧账号的占用只能用旧身份归还；
 * 切号 / 退出登录后留在账本里只会被新身份越权重试（或永远 pending）。下一次登录后的
 * 新会话结束会重新收集属于新身份的义务。
 */
export function disposePsbRemoteService(): void {
  const current = serviceSingleton;
  serviceSingleton = null;
  current?.dispose();
  clearPendingWorkspaceReleases();
}
