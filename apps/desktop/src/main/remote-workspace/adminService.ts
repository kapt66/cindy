/**
 * 「远程工作区」管理页的 main 侧服务（**工作区级**，与用户任务解耦）。
 *
 * ## 它替用户解决什么
 *
 * 「远程工作区」页签是 PSB 网页远程工作区的快捷访问：看这台机器、这个目录、现在被谁占用，
 * 以及它的实时画面。**这些都不该因为「用户 Agent 任务结束了」而消失**。旧实现把页面绑在
 * 「当前打开任务 → 它的 PSB 会话」上，于是 PSB 会话一进终态（PSB 契约里不可逆），页面就读不到
 * 状态、点「启动」还被 PSB 拒（「agent 会话已结束」）—— 一个纯粹的观看需求被用户任务的
 * 生命周期连坐。
 *
 * 本模块把两件事拆开：
 *
 * 1. **工作区从哪来**（`context()`）：优先当前打开任务的 PSB 会话（**任何状态**，含终态；
 *    `sessionStatus` 失败时用本机持久化的 `会话→工作区` 映射 / 最近使用记录兜底），否则用
 *    最近使用过的远程工作区。都没有 → `context: null`（页面的空提示态）。
 * 2. **画面从哪来**（`streamStart()`）：用**我们自己身份的内部 PSB 会话**订阅串流
 *    （`PSB_ADMIN_VIEWER_SESSION_TITLE`）。它跟用户的 agent 会话是两条会话，终态互不影响；
 *    存在则复用、不存在才建（`clientRequestId` 幂等），并且**停流不停会话**（避免每次
 *    「启动/停止」都重建远端会话）。复用只认本机记录里的 `viewerSessionId`（持久化），
 *    **不按标题认领** `listSessions` 里的会话——那是全工作区可见范围，可能含别人的会话。
 * 3. **「远端现在能不能看」从哪读**（`streamStatus()` / `context()` 的桌面会话字段）：借一条
 *    **已经存在**的会话去读 PSB 的 `stream/status`：内存绑定 → 本机记录的内部观看端会话 →
 *    还活着的用户任务会话。**读路径绝不创建 PSB 会话、绝不占用工作区**（2026-11-26 审查：写
 *    前占用闸门落地后，读路径建会话 = 打开页签就静默占用空闲工作区）；没有可用会话时桌面
 *    状态就是 `null`（未知），等用户显式「启动」才创建。
 *
 * ## 三条不变式
 *
 * 1. **页面不写「猜测」**：读不到的桌面会话状态是 `null`（未知），**不是** `dangerously` 的
 *    `none`；读不到串流状态时 `STREAM_STATUS` 返回 `null` 而不是 `capable:false`。
 *    「不知道」被当成「不支持」会让按钮永久不可用，这正是本批要修的退化。
 * 2. **推送只在「刚拿到新事实」时发**：`CONTEXT_CHANGED` 的比较对象是完整上下文快照，
 *    值没变不发；main 不轮询 PSB（与 `push.ts` 的既有取舍同一条）。
 * 3. **失败归因保留 PSB 原话**：跨 IPC 的 `message` 只放 PSB 的可读原文或空串，不放 token /
 *    身份字段；内部会话与用户会话的 id 都是 PSB 的、不是凭据。
 *
 * ## 纯度
 *
 * 只依赖共享契约 + 注入端口（`PsbWorkspaceAdminServiceDeps`），不 import Electron / DB /
 * 真实 PSB 客户端：生产装配在 `adminRuntime.ts`，单测直接注入内存 fake。
 */

import { createIpcError } from '../../shared/ipc-errors.js';
import type {
  PsbCreateSessionRequest,
  PsbCreateSessionResult,
  PsbRemoteWorkspace,
  PsbSessionStatusResult,
  PsbSessionStreamStatus,
  PsbStreamEvent,
} from '../../shared/psb-remote-workspace.js';
import { parsePsbRemoteHostId, psbSessionIsTerminal } from '../../shared/psb-remote-workspace.js';
import type {
  PsbWorkspaceAdminContext,
  PsbWorkspaceAdminContextChangedEvent,
  PsbWorkspaceAdminContextResult,
  PsbWorkspaceAdminContextSource,
  PsbWorkspaceAdminStreamStartResult,
  PsbWorkspaceAdminStreamStatus,
  PsbWorkspaceAdminStreamStatusResult,
} from '../../shared/psb-workspace-admin.js';
import {
  PSB_ADMIN_VIEWER_SESSION_TITLE,
  psbAdminStreamStatusFallback,
  psbAdminStreamStatusFromPsb,
  psbAdminViewerSessionReusable,
} from '../../shared/psb-workspace-admin.js';
import type { PsbAdminRecentWorkspaceStore } from './adminRecentStore.js';
import { PsbClientError, toPsbRemoteFailure } from './psbClient.js';

/** main 侧日志面（生产 = `createLogger('psb-remote')`）。 */
export interface PsbAdminLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/**
 * 管理页用到的 PSB 远程端口。
 *
 * 生产实现就是 `PsbRemoteService`（结构相容，无需适配层）；单测注入内存 fake。
 * 只列管理页真正用到的端口 —— 端口越窄，越不容易在单测里假装 PSB。
 * **端口里没有 listSessions**：内部观看端复用只认本机记录的 id，不按标题在可见会话列表里认领
 *（那会认到别人的会话，见 `adminRecentStore` 文件头）。
 */
export interface PsbAdminRemotePort {
  listWorkspaces(): Promise<PsbRemoteWorkspace[]>;
  sessionStatus(sessionId: string): Promise<PsbSessionStatusResult>;
  createSession(input: PsbCreateSessionRequest): Promise<PsbCreateSessionResult>;
  getStreamStatus(sessionId: string): Promise<PsbSessionStreamStatus>;
  startStream(sessionId: string): Promise<PsbSessionStreamStatus>;
  stopStream(sessionId: string): Promise<void>;
  /**
   * 写操作前的占用闸门（`streamStart` 用）：失败抛 `PSB_*` 失败码（被他人占用带人名），
   * 成功即保证工作区由当前身份锁定（必要时已自动占用）。
   */
  ensureWorkspaceLocked(workspaceId: string): Promise<void>;
  /**
   * 键鼠输入（唯一的上行业务消息 `{kind:'input', event}`）。
   *
   * 没有活动连接时抛 `PSB_STREAM_NOT_ACTIVE`（`streamViewer.sendInput` 的语义）；管理页
   * 不缓存「是否在播」——那是观测，不是闸门，靠一条旧状态放行输入会让用户以为操作没反应。
   */
  sendStreamInput(sessionId: string, event: Record<string, unknown>): Promise<void>;
  /** 订阅本进程内的串流事件（返回退订函数）。管理页只关心内部观看端会话的事件。 */
  onStreamEvent(listener: (event: PsbStreamEvent) => void): () => void;
}

export interface PsbWorkspaceAdminServiceDeps {
  /** 现取 PSB 服务：账号边界会 `dispose` 并重新装配实例，不能捕获旧的那个。 */
  resolveRemote(): PsbAdminRemotePort;
  /** 读本地任务行的 `remoteHostId`（`psb:` 前缀才是远程工作区会话）。 */
  readLocalSessionRemoteHostId(localSessionId: string): Promise<string | null>;
  store: PsbAdminRecentWorkspaceStore;
  emitContextChanged(event: PsbWorkspaceAdminContextChangedEvent): void;
  emitStreamEvent(event: PsbStreamEvent): void;
  log: PsbAdminLogger;
  /** 内部会话创建的幂等键（每次真正发起创建新生成一个）。 */
  createRequestId(): string;
}

export interface PsbWorkspaceAdminService {
  context(input: { localSessionId?: string | null }): Promise<PsbWorkspaceAdminContextResult>;
  streamStart(workspaceId: string): Promise<PsbWorkspaceAdminStreamStartResult>;
  streamStop(workspaceId: string): Promise<void>;
  /**
   * 读工作区级串流状态。
   *
   * **只借已经存在的会话**（内存绑定 → 本机记录的内部观看端会话 id → 还活着的用户任务会话）
   * 发一次只读 HTTP `stream/status`：**不创建 PSB 会话、不占用工作区、不订阅**。没有可用会话
   * 或 PSB 读不到时返回 `status: null`（不抛错，`null` ≠ `capable:false`）。返回值带
   * `viewerSessionId`（加性；只来自本机记录 / 内存绑定）。
   */
  streamStatus(workspaceId: string): Promise<PsbWorkspaceAdminStreamStatusResult>;
  /**
   * 转发一条键鼠输入到该工作区的内部观看端 WS。
   *
   * 输入是**高频**路径：这里不做上下文重读、不落盘、不打 info 日志，只在没有可用会话时抛
   * 可行动失败（`PSB_STREAM_NOT_ACTIVE`：先启动观看）。事件形状与大小上限已在 IPC 层校验
   * （`validatePsbStreamInputEvent`），本函数只做「工作区 → 会话」解析。
   */
  streamInput(workspaceId: string, event: Record<string, unknown>): Promise<void>;
  /** 账号边界 / 进程退出：退订、停掉本端串流（远端内部会话不在这里停）。 */
  dispose(): void;
}

/** 工作区的内部观看端绑定（每个工作区最多一条）。 */
interface ViewerBinding {
  readonly workspaceId: string;
  readonly sessionId: string;
  /** 最近一次读到的串流状态（事件 / 显式读数都会更新它）。 */
  status: PsbWorkspaceAdminStreamStatus | null;
}

/** 工作区解析结果。 */
interface ResolvedWorkspace {
  readonly workspace: PsbRemoteWorkspace;
  readonly source: PsbWorkspaceAdminContextSource;
  /** 可借用来读「桌面会话状态」的会话（**活着**的用户会话；终态会话读了必被拒）。 */
  readonly probeSessionId: string | null;
  /** 解析时 PSB 给的可读失败原因（只在兜底到缓存时用于解释）。 */
  readonly failureMessageZh: string | null;
}

type WorkspaceLookup =
  | { readonly kind: 'found'; readonly workspace: PsbRemoteWorkspace }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly failureMessageZh: string | null };

interface StreamProbe {
  readonly status: PsbWorkspaceAdminStreamStatus | null;
  /** 读到状态的那条会话 id（`status === null` 时是 `null`）。 */
  readonly sessionId: string | null;
  readonly failureMessageZh: string | null;
}

/** 缓存上限：工作区级别的内存表也要有界（见工程约定 §8.4）。 */
const WORKSPACE_CACHE_LIMIT = 16;

function normalizedId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/** 有界写入：Map 的插入顺序即淘汰顺序（最旧的先删）。 */
function rememberBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limit = WORKSPACE_CACHE_LIMIT,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function isMissingSessionFailure(failure: { code: string }): boolean {
  // PSB 对「会话已终态 / 记录不存在 / 非归属人」统一给 NOT_FOUND（403 也按找不到呈现，
  // 不泄漏存在性，与 `psbIpcCodeForFailure` 同口径）。
  return failure.code === 'NOT_FOUND' || failure.code === 'FORBIDDEN';
}

/**
 * 「此刻没有可观看的连接，输入无处可发」的统一失败。
 *
 * 用 `PsbClientError` 而不是 IPC 错误码字面量：跨 IPC 的映射仍走 `psbIpcCodeForFailure`
 * 这一条路（`PSB_STREAM_NOT_ACTIVE` → 同名的可恢复错误码），别在这里另造一套分类。
 */
function streamNotActiveFailure(): PsbClientError {
  return new PsbClientError(
    {
      code: 'PSB_STREAM_NOT_ACTIVE',
      messageKey: 'remoteWorkspace.session.streamIdle',
      message: null,
    },
    null,
  );
}

export function createPsbWorkspaceAdminService(
  deps: PsbWorkspaceAdminServiceDeps,
): PsbWorkspaceAdminService {
  /** 工作区 id → 内部观看端绑定。 */
  const bindings = new Map<string, ViewerBinding>();
  /** 工作区 id → 进行中的「保证内部观看端会话存在」（并发 start 共享一次）。 */
  const ensureInFlight = new Map<string, Promise<ViewerBinding>>();
  /** 工作区 id → 最近一次读到的工作区行（PSB 读不到时保留最后一次快照）。 */
  const lastWorkspaceRowById = new Map<string, PsbRemoteWorkspace>();
  /** 工作区 id → 最近一次串流状态（来自显式读数或串流事件）。 */
  const lastStatusByWorkspace = new Map<string, PsbWorkspaceAdminStreamStatus>();
  /** 工作区 id → 可借用来读桌面会话状态的用户会话（解析上下文时记下的）。 */
  const lastProbeSessionByWorkspace = new Map<string, string>();

  let currentRemote: PsbAdminRemotePort | null = null;
  let unsubscribeStream: (() => void) | null = null;
  /** 最近一次 `context()` 的入参：串流动作后按它重新解析并推送（页面是「单页」语义）。 */
  let lastLocalSessionId: string | null = null;
  /** 最近一次发出的上下文序列化值；`undefined` = 还没建立基线（首次只记不发）。 */
  let lastEmitted: string | undefined;
  /** `CONTEXT_CHANGED` 的合并窗口：串流事件可能连发，重读不叠加（§8.6）。 */
  let refreshInFlight: Promise<void> | null = null;
  let refreshPending = false;

  function remote(): PsbAdminRemotePort {
    const next = deps.resolveRemote();
    if (next !== currentRemote) {
      // 账号边界换了服务实例：旧绑定与旧订阅全部失效（旧实例的 socket 已随 dispose 断开）。
      resetState();
      currentRemote = next;
      unsubscribeStream = next.onStreamEvent(handleStreamEvent);
      deps.log.debug('psb admin: bound to a new remote service instance');
    }
    return next;
  }

  function resetState(): void {
    try {
      unsubscribeStream?.();
    } catch {
      /* best-effort：退订失败不影响后续重建 */
    }
    unsubscribeStream = null;
    bindings.clear();
    ensureInFlight.clear();
    lastWorkspaceRowById.clear();
    lastStatusByWorkspace.clear();
    lastProbeSessionByWorkspace.clear();
    lastEmitted = undefined;
    refreshInFlight = null;
    refreshPending = false;
  }

  /* ------------------------------ 工作区解析 ------------------------------ */

  /**
   * 工作区被确认**不可见**（被删 / 无权限）时的本地清理。
   *
   * 不清远端会话：它已经属于一个不存在的工作区，PSB 侧会随之失效；这里只把本机记录与内存绑定
   * 丢掉，避免以后每次打开都白读一次、也避免继续拿一个不存在的 workspaceId 去订阅。
   */
  function forgetWorkspaceLocally(workspaceId: string): void {
    bindings.delete(workspaceId);
    lastStatusByWorkspace.delete(workspaceId);
    lastProbeSessionByWorkspace.delete(workspaceId);
    lastWorkspaceRowById.delete(workspaceId);
    deps.store.forgetWorkspace(workspaceId);
  }

  async function lookupWorkspace(workspaceId: string): Promise<WorkspaceLookup> {
    try {
      const workspaces = await remote().listWorkspaces();
      const found = workspaces.find((entry) => entry.id === workspaceId);
      if (!found) return { kind: 'missing' };
      rememberBounded(lastWorkspaceRowById, found.id, found);
      return { kind: 'found', workspace: found };
    } catch (error) {
      const failure = toPsbRemoteFailure(error);
      deps.log.debug('psb admin: listing workspaces failed while resolving the page workspace', {
        workspaceId,
        code: failure.code,
      });
      return { kind: 'failed', failureMessageZh: failure.message };
    }
  }

  async function readWorkspaceFromSession(psbSessionId: string): Promise<ResolvedWorkspace | null> {
    try {
      const result = await remote().sessionStatus(psbSessionId);
      const workspace = result.workspace;
      rememberBounded(lastWorkspaceRowById, workspace.id, workspace);
      // 读成功就把映射刷新一遍：终态/404 之后靠它兜底，也顺带把「最近使用」推进到当前工作区。
      deps.store.rememberSessionWorkspace(psbSessionId, workspace.id);
      deps.store.rememberWorkspace(workspace.id);
      return {
        workspace,
        source: 'session',
        // 终态会话的 stream/status 必被 PSB 拒（会话不可逆转）：不拿它当探针，省一次必失败的请求。
        probeSessionId: psbSessionIsTerminal(result.session.status) ? null : psbSessionId,
        failureMessageZh: null,
      };
    } catch (error) {
      const failure = toPsbRemoteFailure(error);
      deps.log.debug('psb admin: reading the task PSB session failed; falling back to records', {
        psbSessionId,
        code: failure.code,
      });
      return null;
    }
  }

  /**
   * 解析「此刻该管理哪个工作区」。
   *
   * 顺序即优先级：当前任务的 PSB 会话（任何状态）→ 本机「会话→工作区」映射 →
   * 最近使用过的远程工作区 → `null`。每一步都只回答「工作区是谁」，不回答「会话还能不能用」。
   */
  async function resolveWorkspace(
    localSessionId: string | null,
  ): Promise<ResolvedWorkspace | null> {
    if (localSessionId) {
      const psbSessionId = parsePsbRemoteHostId(await readRemoteHostId(localSessionId));
      if (psbSessionId) {
        const fromSession = await readWorkspaceFromSession(psbSessionId);
        if (fromSession) return fromSession;

        // 会话读不到（终态被拒 / 记录已清 / 网络）：先用**这条会话**的本机映射，
        // 再退回最近使用的远程工作区。两条都是「工作区事实来自本机记录」。
        const mappedId = deps.store.workspaceIdForSession(psbSessionId);
        if (mappedId) {
          const mapped = await lookupWorkspace(mappedId);
          if (mapped.kind === 'found') {
            return {
              workspace: mapped.workspace,
              source: 'last-used',
              probeSessionId: null,
              failureMessageZh: null,
            };
          }
          if (mapped.kind === 'missing') forgetWorkspaceLocally(mappedId);
        }
      }
    }

    const lastUsedId = deps.store.read().lastWorkspaceId;
    if (!lastUsedId) return null;
    const lastUsed = await lookupWorkspace(lastUsedId);
    if (lastUsed.kind === 'found') {
      return {
        workspace: lastUsed.workspace,
        source: 'last-used',
        probeSessionId: null,
        failureMessageZh: null,
      };
    }
    if (lastUsed.kind === 'missing') {
      // 记录里的工作区已不可见（被删 / 无权限）：清掉，别让以后每次打开都白读一次。
      forgetWorkspaceLocally(lastUsedId);
      return null;
    }
    // PSB 暂时读不到：保留最后一次快照（与工程契约 §5「读取失败保留最后一次快照」同一取舍），
    // 让页面不因一次网络抖动而清空。
    const cached = lastWorkspaceRowById.get(lastUsedId);
    if (!cached) return null;
    return {
      workspace: cached,
      source: 'last-used',
      probeSessionId: null,
      failureMessageZh: lastUsed.failureMessageZh,
    };
  }

  async function readRemoteHostId(localSessionId: string): Promise<string | null> {
    try {
      return normalizedId(await deps.readLocalSessionRemoteHostId(localSessionId));
    } catch (error) {
      deps.log.warn('psb admin: reading the local session row failed', {
        localSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /* ------------------------------ 桌面会话状态 ------------------------------ */

  /**
   * 用「可借用的会话」读工作区级串流状态。
   *
   * PSB 的 `stream/status` 挂在会话路径上，但它回答的是**工作区**的桌面会话状态。终态会话
   * 读不了，所以候选顺序是：内部观看端会话（内存绑定 / 本机记录）→ 还活着的用户会话。
   * 读不到就返回 `status: null`（未知），**不猜** `none`，也**不去建会话**。
   */
  async function probeStreamStatus(sessionIds: readonly string[]): Promise<StreamProbe> {
    let failureMessageZh: string | null = null;
    for (const sessionId of sessionIds) {
      try {
        const status = await remote().getStreamStatus(sessionId);
        return {
          status: psbAdminStreamStatusFromPsb(status),
          sessionId,
          failureMessageZh: null,
        };
      } catch (error) {
        const failure = toPsbRemoteFailure(error);
        failureMessageZh ??= failure.message;
        deps.log.debug('psb admin: stream status probe failed', {
          sessionId,
          code: failure.code,
        });
      }
    }
    return { status: null, sessionId: null, failureMessageZh };
  }

  function buildContext(input: {
    workspace: PsbRemoteWorkspace;
    source: PsbWorkspaceAdminContextSource;
    binding: ViewerBinding | null;
    desktop: PsbWorkspaceAdminStreamStatus | null;
    failureMessageZh: string | null;
  }): PsbWorkspaceAdminContext {
    const { workspace, desktop } = input;
    return {
      workspaceId: workspace.id,
      clientName: workspace.clientName,
      clientOnline: workspace.clientOnline,
      title: workspace.title,
      // PSB 行给模板标题；空白串归一成 `null`，页头据此省略「模板 ·」段。
      templateTitle: workspace.templateTitle?.trim() || null,
      directoryName: workspace.directoryName ?? '',
      state: workspace.state,
      occupancy: {
        occupied: workspace.occupancy.occupied,
        byMe: workspace.occupancy.byMe,
        personName: workspace.occupancy.personName,
      },
      // 未知就是 `null`：`none` 只表示 PSB 明确说「没有桌面会话」。
      desktopSession: desktop?.desktopSession ?? null,
      reasonCode: desktop?.reasonCode ?? null,
      // PSB 的失败原话优先（那是最新事实），否则用状态里带的原因（含串流关闭归因）。
      lastErrorZh: input.failureMessageZh ?? desktop?.lastErrorZh ?? null,
      source: input.source,
      viewerSessionId: input.binding?.sessionId ?? null,
    };
  }

  /**
   * 值没变不发推送；第一次只建立基线（invoke 的返回值本身就是这一次的事实）。
   *
   * 载荷带上解析这次上下文用的 `localSessionId`：这是广播，多窗口各自打开不同任务时，
   * 渲染层靠它判断「这条推送是不是我这次读取的结果」，不匹配就丢弃（见共享契约
   * `PsbWorkspaceAdminContextChangedEvent`）。
   */
  function emitIfChanged(context: PsbWorkspaceAdminContext | null): void {
    const serialized = JSON.stringify(context);
    const previous = lastEmitted;
    lastEmitted = serialized;
    if (previous === undefined || previous === serialized) return;
    deps.emitContextChanged({ context, localSessionId: lastLocalSessionId });
  }

  async function context(input: {
    localSessionId?: string | null;
  }): Promise<PsbWorkspaceAdminContextResult> {
    lastLocalSessionId = normalizedId(input.localSessionId);
    const resolved = await resolveWorkspace(lastLocalSessionId);
    if (!resolved) {
      emitIfChanged(null);
      return { context: null };
    }

    const workspaceId = resolved.workspace.id;
    let binding = bindings.get(workspaceId) ?? null;
    if (resolved.probeSessionId) {
      rememberBounded(lastProbeSessionByWorkspace, workspaceId, resolved.probeSessionId);
    }
    // 桌面会话状态只能借一条**已经存在**的会话去问 PSB。读路径**不创建任何 PSB 会话、不占用
    // 工作区**：应用重启后内存绑定全丢时，只复用本机记录里的内部观看端会话 id（一次只读 HTTP，
    // 不订阅、不占观看名额）。没有记录 / 用户任务会话可用时，桌面状态保持 `null`（未知），
    // 等用户显式「启动」再创建内部会话。
    const persistedViewer = binding ? null : persistedViewerSessionId(workspaceId);
    const probeIds = [
      ...(binding ? [binding.sessionId] : []),
      ...(persistedViewer ? [persistedViewer] : []),
      ...(resolved.probeSessionId ? [resolved.probeSessionId] : []),
    ];
    const probe = await probeStreamStatus(probeIds);
    if (probe.status && !binding && persistedViewer && probe.sessionId === persistedViewer) {
      // 记录里的会话还活着且能读：复用成内存绑定（不新建会话）。真正的订阅仍要用户点「启动」。
      binding = { workspaceId, sessionId: persistedViewer, status: probe.status };
      bindings.set(workspaceId, binding);
    }
    if (persistedViewer && probe.sessionId !== persistedViewer) {
      // 记录里的会话读不到（或没被优先读到）：确认它终态/不存在就清掉，避免下次启动复用死会话。
      await forgetViewerSessionIfDead(workspaceId, persistedViewer);
    }
    if (probe.status) rememberBounded(lastStatusByWorkspace, workspaceId, probe.status);
    const desktop =
      probe.status ?? lastStatusByWorkspace.get(workspaceId) ?? binding?.status ?? null;

    // 「最近使用」只在值变化时落盘（见 `adminRecentStore` 的写纪律）。
    deps.store.rememberWorkspace(workspaceId);

    const built = buildContext({
      workspace: resolved.workspace,
      source: resolved.source,
      binding,
      desktop,
      // 读到新状态就以它为准（它自带 lastErrorZh）；读不到时把 PSB 原话带出去解释「为什么是缓存」。
      failureMessageZh: probe.status ? null : (probe.failureMessageZh ?? resolved.failureMessageZh),
    });
    emitIfChanged(built);
    return { context: built };
  }

  /* ------------------------------ 内部观看端会话 ------------------------------ */

  /** 本机记录里该工作区的内部观看端会话 id（没记过 / 已清掉时 `null`）。 */
  function persistedViewerSessionId(workspaceId: string): string | null {
    return deps.store.viewerSessionIdForWorkspace(workspaceId);
  }

  /**
   * 记录里的内部观看端会话读不到时，确认它终态/不存在就清掉（`null` = 读不清，保持记录）。
   *
   * 只在**确认死亡**时清：网络抖动不能把一条还能用的会话从记录里删掉，否则下次启动会多建一条。
   */
  async function forgetViewerSessionIfDead(workspaceId: string, sessionId: string): Promise<void> {
    const dead = await viewerSessionIsDead(sessionId);
    if (dead !== true) return;
    if (deps.store.viewerSessionIdForWorkspace(workspaceId) !== sessionId) return;
    deps.store.forgetViewerSession(workspaceId);
    if (bindings.get(workspaceId)?.sessionId === sessionId) bindings.delete(workspaceId);
    deps.log.debug('psb admin: forgot a dead internal viewer session', { workspaceId, sessionId });
  }

  async function createViewerBinding(workspaceId: string): Promise<ViewerBinding> {
    const created = await remote().createSession({
      workspaceId,
      // `pi` 是三种 Harness 里最轻的一种：观看端只订阅画面，不跑 agent 回合。
      agentKind: 'pi',
      title: PSB_ADMIN_VIEWER_SESSION_TITLE,
      clientRequestId: deps.createRequestId(),
    });
    const binding: ViewerBinding = {
      workspaceId,
      sessionId: created.session.id,
      status: null,
    };
    bindings.set(workspaceId, binding);
    // 立刻落盘：应用重启 / 页面重新打开时**只认这条记录**复用（不按标题认领他人的会话）。
    deps.store.rememberViewerSession(workspaceId, binding.sessionId);
    deps.store.rememberSessionWorkspace(binding.sessionId, workspaceId);
    deps.store.rememberWorkspace(workspaceId);
    deps.log.info('psb admin: created the internal viewer session', {
      workspaceId,
      viewerSessionId: binding.sessionId,
    });
    return binding;
  }

  /**
   * 复用本机记录里的内部观看端会话（**启动路径专用**）。
   *
   * 只认记录里的 id，不再按标题在 `listSessions` 里认领：那个列表包含同工作区**其他人**的
   * 会话，认错会话会把别人的流当成自己的（审查发现）。PSB 终态不可逆，所以先读一次会话状态
   * 确认仍可复用；终态 / 不存在就清记录、返回 `null` 让调用方新建。
   *
   * 失败语义：可归因的「会话已不存在」收敛成 `null`（正常走重建）；网络 / 鉴权失败**原样抛**
   * ——启动是写路径，用户需要看到真实原因，静默新建一条只会掩盖问题。
   */
  async function adoptPersistedViewerBinding(
    workspaceId: string,
    sessionId: string,
  ): Promise<ViewerBinding | null> {
    try {
      const result = await remote().sessionStatus(sessionId);
      if (
        result.session.workspaceId !== workspaceId ||
        !psbAdminViewerSessionReusable(result.session.status)
      ) {
        deps.store.forgetViewerSession(workspaceId);
        deps.log.info('psb admin: recorded viewer session is not reusable; recreating', {
          workspaceId,
          sessionId,
          status: result.session.status,
        });
        return null;
      }
      const binding: ViewerBinding = {
        workspaceId,
        sessionId,
        status: bindings.get(workspaceId)?.status ?? lastStatusByWorkspace.get(workspaceId) ?? null,
      };
      bindings.set(workspaceId, binding);
      deps.store.rememberSessionWorkspace(sessionId, workspaceId);
      return binding;
    } catch (error) {
      const failure = toPsbRemoteFailure(error);
      if (isMissingSessionFailure(failure)) {
        deps.store.forgetViewerSession(workspaceId);
        return null;
      }
      throw error;
    }
  }

  /**
   * 保证内部观看端会话存在（**只在写路径 / 用户显式启动时调用**）。
   *
   * 顺序：内存绑定 → 本机记录里的内部会话（校验仍可复用）→ 新建。同一工作区的并发启动共享
   * 一次「保证内部会话存在」，绝不建出两条内部会话。**读路径不调用本函数**（那会让打开页签
   * 变成一次工作区写操作 / 静默占用）。
   */
  async function ensureViewerBinding(workspaceId: string): Promise<ViewerBinding> {
    const existing = bindings.get(workspaceId);
    if (existing) return existing;
    const inFlight = ensureInFlight.get(workspaceId);
    if (inFlight) return inFlight;
    const task = (async (): Promise<ViewerBinding> => {
      const persisted = persistedViewerSessionId(workspaceId);
      if (persisted) {
        const adopted = await adoptPersistedViewerBinding(workspaceId, persisted);
        if (adopted) return adopted;
      }
      return createViewerBinding(workspaceId);
    })().finally(() => {
      if (ensureInFlight.get(workspaceId) === task) ensureInFlight.delete(workspaceId);
    });
    ensureInFlight.set(workspaceId, task);
    return task;
  }

  /** 该内部会话是否已终态/已不存在（`null` = 读不清，不能据此重建）。 */
  async function viewerSessionIsDead(sessionId: string): Promise<boolean | null> {
    try {
      const result = await remote().sessionStatus(sessionId);
      return psbSessionIsTerminal(result.session.status);
    } catch (error) {
      const failure = toPsbRemoteFailure(error);
      return isMissingSessionFailure(failure) ? true : null;
    }
  }

  async function stopStreamQuietly(sessionId: string): Promise<void> {
    try {
      await remote().stopStream(sessionId);
    } catch {
      /* best-effort：重建前的旧连接收尸，失败也不该挡住新连接 */
    }
  }

  /**
   * 启动串流，并在**终态竞态**下重试一次。
   *
   * 竞态：启动前看到的会话还在 `running`，但 PSB 处理订阅时它已经落定（会话被网页/别处
   * 停掉）。此时 `startStream` 失败，我们**再问一次**这条会话的状态 —— 确认它真的终态/不存在
   * 才重建内部会话重试一次；网络/鉴权失败照原样上抛（重试只会把同一个失败重放一遍）。
   */
  async function startStreamWithRecovery(workspaceId: string): Promise<{
    binding: ViewerBinding;
    status: PsbSessionStreamStatus;
  }> {
    const binding = await ensureViewerBinding(workspaceId);
    try {
      return { binding, status: await remote().startStream(binding.sessionId) };
    } catch (error) {
      const dead = await viewerSessionIsDead(binding.sessionId);
      if (dead !== true) throw error;
      deps.log.warn('psb admin: the internal viewer session ended; rebuilding once', {
        workspaceId,
        viewerSessionId: binding.sessionId,
      });
      await stopStreamQuietly(binding.sessionId);
      const rebuilt = await createViewerBinding(workspaceId);
      return { binding: rebuilt, status: await remote().startStream(rebuilt.sessionId) };
    }
  }

  async function streamStart(workspaceId: string): Promise<PsbWorkspaceAdminStreamStartResult> {
    const id = normalizedId(workspaceId);
    if (!id) throw createIpcError('INVALID_PARAMS', 'workspaceId is required');

    // 串流 = 工作区写操作（内部观看端会话的创建/复用 + 订阅）：PSB 会对未锁定者拒绝，
    // 所以先确保工作区由自己占用（未占用则自动占用）。失败在这里就给出可行动原因，
    // 不建立订阅、不建内部会话。读状态（`streamStatus`）不受此限。
    await remote().ensureWorkspaceLocked(id);

    const started = await startStreamWithRecovery(id);
    const status = psbAdminStreamStatusFromPsb(started.status);
    started.binding.status = status;
    rememberBounded(lastStatusByWorkspace, id, status);
    deps.store.rememberWorkspace(id);
    deps.store.rememberSessionWorkspace(started.binding.sessionId, id);
    // 上下文可能随这次动作变化（内部会话 id 出现、桌面会话状态变了）：重读一次并推送。
    await refreshContextNow();
    return {
      status,
      workspaceId: id,
      viewerSessionId: started.binding.sessionId,
    };
  }

  async function streamStop(workspaceId: string): Promise<void> {
    const id = normalizedId(workspaceId);
    if (!id) return;
    const binding = bindings.get(id);
    if (!binding) return;
    // 只停**观看**：内部会话保留（下一次启动直接复用，避免每次开关都重建远端会话）。
    await remote().stopStream(binding.sessionId);
    const previous = binding.status ?? psbAdminStreamStatusFallback();
    binding.status = { ...previous, active: false };
    rememberBounded(lastStatusByWorkspace, id, binding.status);
    await refreshContextNow();
  }

  /**
   * 转发一条键鼠输入。
   *
   * 解析链只有一步：`workspaceId → 内部观看端会话`。**不做「现在是否在播」的本地判断**：
   * 那是观测字段（`status.active` 是 PSB 的语义），拿它当闸门会在弱网/状态滞后时把合法输入
   * 静默丢掉；真正的闸门是 WS 是否 OPEN（`streamViewer.sendInput`），失败也就有可行动原因。
   */
  async function streamInput(workspaceId: string, event: Record<string, unknown>): Promise<void> {
    const id = normalizedId(workspaceId);
    if (!id) throw createIpcError('INVALID_PARAMS', 'workspaceId is required');
    const binding = bindings.get(id);
    if (!binding) throw streamNotActiveFailure();
    await remote().sendStreamInput(binding.sessionId, event);
  }

  /**
   * 读工作区级串流状态（**只借已存在的会话；不创建 PSB 会话、不占用工作区**）。
   *
   * `stream/status` 挂在会话路径上，所以必须有一条会话当探针。候选顺序：
   *   1. 内存里的内部观看端绑定（本进程启动过观看）；
   *   2. 本机记录里的内部观看端会话 id（应用重启后的主路径，只读 HTTP，不订阅、不占名额）；
   *   3. 最近一次上下文解析记下的、还活着的用户任务会话。
   *
   * 三者都没有就返回 `status: null`（未知）。**不再为了读状态新建内部会话**：新会话属于工作区
   * 写操作，写前占用闸门会顺带占用工作区——打开页签就静默占用一个空闲工作区是不可接受的
   * 副作用（审查发现的原实现）。`null` 仍**不等于** `capable:false`；返回值额外带
   * `viewerSessionId`（只来自内存绑定 / 本机记录），让渲染层能过滤 `STREAM_EVENT` /
   * 判断输入是否可发。
   */
  async function streamStatus(workspaceId: string): Promise<PsbWorkspaceAdminStreamStatusResult> {
    const id = normalizedId(workspaceId);
    if (!id) return { status: null, viewerSessionId: null };

    let binding = bindings.get(id) ?? null;
    // 没有内存绑定时复用本机记录里的内部观看端会话（重启后唯一可借的读口；不新建会话）。
    const persistedViewer = binding ? null : persistedViewerSessionId(id);
    const probeIds: string[] = [];
    if (binding) probeIds.push(binding.sessionId);
    else if (persistedViewer) probeIds.push(persistedViewer);
    // 再借「还活着的用户会话」读一次工作区级状态（一次只读，不轮询）。
    const userProbe = lastProbeSessionByWorkspace.get(id);
    if (userProbe && userProbe !== binding?.sessionId && userProbe !== persistedViewer) {
      probeIds.push(userProbe);
    }

    const probe = await probeStreamStatus(probeIds);
    if (probe.status) {
      rememberBounded(lastStatusByWorkspace, id, probe.status);
      if (!binding && persistedViewer && probe.sessionId === persistedViewer) {
        // 记录里的内部会话还活着：复用成内存绑定（不是新建会话）。`viewerSessionId` 从 null
        // 变为有值是 `CONTEXT_CHANGED` 的新事实，让已打开页面马上拿到。
        binding = { workspaceId: id, sessionId: persistedViewer, status: probe.status };
        bindings.set(id, binding);
        refreshContextQuietly();
      }
      if (binding) binding.status = probe.status;
      return { status: probe.status, viewerSessionId: binding?.sessionId ?? null };
    }

    // 读不到：内部会话可能已经终态/不存在 → 丢掉绑定与记录（下次启动会重建），并刷新上下文。
    if (binding) {
      const dead = await viewerSessionIsDead(binding.sessionId);
      if (dead === true) {
        bindings.delete(id);
        deps.store.forgetViewerSession(id);
        refreshContextQuietly();
        binding = null;
      }
    }
    if (!binding && persistedViewer) await forgetViewerSessionIfDead(id, persistedViewer);
    const viewerSessionId = binding?.sessionId ?? null;
    // 读不到 PSB 状态 ≠ 客户端不支持：优先返回最后一次已知状态（带最新失败原话），否则 null。
    const cached = lastStatusByWorkspace.get(id) ?? null;
    if (!cached) return { status: null, viewerSessionId };
    return {
      status: probe.failureMessageZh ? { ...cached, lastErrorZh: probe.failureMessageZh } : cached,
      viewerSessionId,
    };
  }

  /* ------------------------------ 串流事件 ------------------------------ */

  function bindingForSession(sessionId: string): ViewerBinding | null {
    for (const binding of bindings.values()) {
      if (binding.sessionId === sessionId) return binding;
    }
    return null;
  }

  /**
   * 内部观看端会话的串流事件 → 管理页通道。
   *
   * 只转发**内部会话**的事件：用户任务会话的串流属于会话页（走 `PSB_REMOTE_CHANNELS`），
   * 混进管理页会让同一帧被两处解码。
   *
   * 转发是**按会话过滤后的原样透传**（`frame` / `status` / `cursor` / `closed` / `error` 全部
   * 先 `deps.emitStreamEvent`），再按事件类型更新管理页状态；`cursor`（宿主光标形状）只给渲染层
   * 映射成**宿主风格 CSS 关键字**（只在画面区域生效），没有对应的管理页状态，因此不做映射、
   * 也不触发上下文重读。
   */
  function handleStreamEvent(event: PsbStreamEvent): void {
    const binding = bindingForSession(event.sessionId);
    if (!binding) return;
    deps.emitStreamEvent(event);
    const workspaceId = binding.workspaceId;

    if (event.type === 'status') {
      const next = psbAdminStreamStatusFromPsb(event.status);
      binding.status = next;
      rememberBounded(lastStatusByWorkspace, workspaceId, next);
      // 桌面会话状态可能随之变化（例如 PSB 推送「采集已开始」）：重读上下文并按需推送。
      refreshContextQuietly();
      return;
    }

    if (event.type === 'closed') {
      const previous = binding.status ?? psbAdminStreamStatusFallback();
      binding.status = {
        ...previous,
        active: false,
        // 4004 的结构化归因就在这里落地：不知道就保留上一次的值，不猜。
        desktopSession: event.detail?.desktopSession ?? previous.desktopSession,
        reasonCode: event.detail?.reasonCode ?? previous.reasonCode,
        lastErrorZh: event.detail?.messageZh ?? previous.lastErrorZh,
      };
      rememberBounded(lastStatusByWorkspace, workspaceId, binding.status);
      if (event.reason === 'session-ended' || event.reason === 'session-not-found') {
        // PSB 说这条内部会话已结束 / 已不存在：丢掉内存绑定**与本机记录**，下次启动重新建。
        // `session-not-found` 来自 PSB 0.1.170 的 4404（`errors=frame` 升级码，当前未启用，
        // 加性处理）。留着记录中的死 id 会让下一次启动先白读一次终态会话。
        bindings.delete(workspaceId);
        deps.store.forgetViewerSession(workspaceId);
      }
      refreshContextQuietly();
      return;
    }

    if (event.type === 'error') {
      const previous = binding.status ?? psbAdminStreamStatusFallback();
      binding.status = {
        ...previous,
        lastErrorZh: event.failure.message ?? previous.lastErrorZh,
      };
      rememberBounded(lastStatusByWorkspace, workspaceId, binding.status);
    }
    // `frame` / `cursor` 只转发，不改上下文（光标形状是渲染层视觉状态，不属于管理页状态）。
  }

  /* ------------------------------ 上下文刷新（合并窗口） ------------------------------ */

  async function refreshContextNow(): Promise<void> {
    try {
      await context({ localSessionId: lastLocalSessionId });
    } catch (error) {
      deps.log.debug('psb admin: refreshing the page context failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 串流事件驱动的刷新：**合并窗口内只重读一次**，读取在途时只记一笔待刷新。
   *
   * 不做合并的后果是每条 `status` 事件都触发一次 `listWorkspaces` + `stream/status`，
   * 而 PSB 的压力与回包字节都会随事件密度增长（工程约定 §8.6）。
   */
  function refreshContextQuietly(): void {
    refreshPending = true;
    if (refreshInFlight) return;
    refreshInFlight = (async () => {
      try {
        while (refreshPending) {
          refreshPending = false;
          await refreshContextNow();
        }
      } finally {
        refreshInFlight = null;
      }
    })();
  }

  return {
    context,
    streamStart,
    streamStop,
    streamStatus,
    streamInput,
    dispose() {
      resetState();
      currentRemote = null;
    },
  };
}
