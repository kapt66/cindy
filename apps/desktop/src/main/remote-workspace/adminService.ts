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
 * 本模块把三件事拆开：
 *
 * 1. **工作区从哪来**（`context()`）：优先当前打开任务的 PSB 会话（**任何状态**，含终态；
 *    `sessionStatus` 失败时用本机持久化的 `会话→工作区` 映射 / 最近使用记录兜底），否则用
 *    最近使用过的远程工作区。都没有 → `context: null`（页面的空提示态）。
 * 2. **画面从哪来**（`streamStart()`）：走 PSB 的**工作区级服务接口**
 *    `POST /api/cindy/remote/workspaces/:id/stream/subscribe`，拿它返回的**桌面访问会话** id
 *    打开观看端。这条路径**不创建任何 Agent 会话** —— Agent 会话只装用户任务（PSB 0.1.172
 *    框架规则；2026-11-26 用户事故：会话列表里出现「Cindy 观看端」是模型用错，不是「内部会话
 *    没被隐藏」）。绑定（workspace → 桌面会话 id）持久化在 `adminRecentStore`：重复「启动」
 *    先复用；失效（桌面访问被重建）再重新订阅。「停止」只断本端观看、保留绑定。
 * 3. **「远端现在能不能看」从哪读**（`streamStatus()` / `context()` 的桌面会话字段）：用**绑定
 *    里的会话 id** 读 PSB 的 `stream/status`（桌面访问会话 id；过渡兜底时是内部 Agent 会话 id，
 *    两条路由 PSB 都接受）。**读路径绝不订阅、绝不创建 PSB 会话、绝不占用工作区**；没有绑定
 *    （用户还没点过「启动」/ 重启后无记录）时桌面状态就是 `null`（未知）。
 *
 * ## 过渡兜底：只有旧 PSB 才回退到内部 Agent 会话
 *
 * 工作区级订阅端点是 PSB 0.1.172 新增的。旧服务端上这条路由不存在（404/405/`UNSUPPORTED`），
 * 此时**允许临时回退**到「内部 Agent 会话」充当观看端，但必须同时满足：
 *
 *   - 创建时显式传 `purpose: 'internal'`（PSB 默认不列进会话列表、不增加 `sessionCount`；
 *     其它值 PSB 会 400）；
 *   - 标题写明内部用途（`PSB_ADMIN_INTERNAL_STREAM_SESSION_TITLE`），**不伪装成用户任务**；
 *   - 记 warn 日志。
 *
 * 新端点可用时这条路径**永不**执行；其它失败（409 没有 running 桌面访问、鉴权、网络、可读
 * 业务错误）不触发回退 —— 那些不是「端点不存在」，静默建会话只会掩盖真实原因。
 *
 * ## 三条不变式
 *
 * 1. **页面不写「猜测」**：读不到的桌面会话状态是 `null`（未知），**不是** `none`；读不到
 *    串流状态时 `STREAM_STATUS` 返回 `null` 而不是 `capable:false`。
 *    「不知道」被当成「不支持」会让按钮永久不可用，这正是本批要修的退化。
 * 2. **推送只在「刚拿到新事实」时发**：`CONTEXT_CHANGED` 的比较对象是完整上下文快照，
 *    值没变不发；main 不轮询 PSB（与 `push.ts` 的既有取舍同一条）。
 * 3. **失败归因保留 PSB 原话**：跨 IPC 的 `message` 只放 PSB 的可读原文或空串，不放 token /
 *    身份字段；桌面会话 id 与内部会话 id 都是 PSB 的、不是凭据。
 *
 * ## 固定信息快照与 stale 降级（2026-11-26 真机事故）
 *
 * 用户口径：工作区名称 / 模板 / 机器在会话启动时就是**固定信息**，不会变；但设备会掉线、
 * 工作区会被移除，所以不能只靠服务器即时读取。实现：
 *
 *   - 实时读成功（`context` / `createSession` / 占用成功，见 `index.ts` 与
 *     `adminRecentRuntime.ts`）→ 把固定字段落盘成快照（值不变 0 次写）；
 *   - 读不到（断网 / 被删 / 当前任务的 PSB 会话读不到）→ **仍返回上下文**，`stale: true`
 *     + `availability`（`missing` = 列表读成功但工作区不在 / `unavailable` = 读不到 PSB），
 *     状态类字段（占用 / 桌面会话）留空由渲染层显示「无法获取」；
 *   - 历史会话（快照 & 会话映射都缺）→ 用本机会话行的 `title` + `/psb-remote/<目录>` 种子出
 *     占位上下文（`workspaceIdKnown: false`，写操作一律拒绝）；
 *   - 只有本机**完全没有线索**（没有快照、没有会话行种子）才返回 `context: null`。
 *
 * stale 时写操作（启动串流等）由 `streamStart` 直接给可行动失败（工作区已不可见 / 连不上），
 * 不再发一次注定失败的 PSB 写请求。
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
  PsbRemoteFailure,
  PsbRemoteWorkspace,
  PsbSessionStatusResult,
  PsbSessionStreamStatus,
  PsbStreamEvent,
  PsbWorkspaceStreamSubscription,
} from '../../shared/psb-remote-workspace.js';
import { parsePsbRemoteHostId } from '../../shared/psb-remote-workspace.js';
import type {
  PsbWorkspaceAdminContext,
  PsbWorkspaceAdminContextChangedEvent,
  PsbWorkspaceAdminContextResult,
  PsbWorkspaceAdminContextSource,
  PsbWorkspaceAdminStaleReason,
  PsbWorkspaceAdminStreamStartResult,
  PsbWorkspaceAdminStreamStatus,
  PsbWorkspaceAdminStreamStatusResult,
} from '../../shared/psb-workspace-admin.js';
import {
  PSB_ADMIN_INTERNAL_STREAM_SESSION_TITLE,
  psbAdminStreamStatusFallback,
  psbAdminStreamStatusFromPsb,
} from '../../shared/psb-workspace-admin.js';
import type {
  PsbAdminRecentWorkspaceStore,
  PsbAdminWorkspaceSnapshot,
} from './adminRecentStore.js';
import { PsbClientError, toPsbRemoteFailure } from './psbClient.js';
import type { PsbWorkspaceAccessEnsureOutcome } from './psbClient.js';

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
 * **端口里没有 listSessions**：观看端绑定只认本机记录的 id / 工作区级订阅的返回值，不按标题
 * 在可见会话列表里认领（那会认到别人的会话，见 `adminRecentStore` 文件头）。
 */
export interface PsbAdminRemotePort {
  listWorkspaces(): Promise<PsbRemoteWorkspace[]>;
  /**
   * 读一条 **agent** PSB 会话。管理页只用它解析「当前打开的任务属于哪个工作区」；
   * **不拿它订阅 / 读串流状态**（串流走桌面访问会话，见 `subscribeWorkspaceStream`）。
   */
  sessionStatus(sessionId: string): Promise<PsbSessionStatusResult>;
  /**
   * 工作区级串流订阅（PSB 0.1.172 服务接口）：返回当前 `running` **桌面访问会话** id，
   * **不创建任何 Agent 会话**。没有 running 访问会话时抛 404/409（可读原因）；PSB 0.1.180
   * 的 409 会带 `details.code='NO_RUNNING_SESSION'` + `details.state`，客户端已把它解析成
   * `failure.code='PSB_STREAM_NO_RUNNING_SESSION'` + `failure.streamAccessState`。
   */
  subscribeWorkspaceStream(workspaceId: string): Promise<PsbWorkspaceStreamSubscription>;
  /**
   * **尽力**拉起该工作区的桌面访问（可选增强；失败一律非致命，**永不抛**）。
   *
   * 生产 = `PsbRemoteService.ensureWorkspaceAccess`：Cindy 的 Bearer 目前未被 PSB 放行
   * `/api/remote/**`（403），所以通常返回 `reason:'cindy-entry-not-open'`，此时订阅照常进行，
   * 由 409 给出可行动文案。旧装配 / 单测 fake 可以完全没有这个方法（可选端口）。
   */
  ensureWorkspaceAccess?(workspaceId: string): Promise<PsbWorkspaceAccessEnsureOutcome>;
  /**
   * 创建工作区会话。**只有过渡兜底**（新端点不可用的旧 PSB）会调用，且必须传
   * `purpose: 'internal'`（见文件头）。
   */
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
  /** 订阅本进程内的串流事件（返回退订函数）。管理页只关心自己绑定的观看端会话的事件。 */
  onStreamEvent(listener: (event: PsbStreamEvent) => void): () => void;
}

/**
 * 当前打开任务的**本机会话行线索**（历史会话兜底用）。
 *
 * PSB 读不到时，`remoteHostId` 决定「这是不是一个 psb 会话」；`title` / `workingDir`
 * （`/psb-remote/<目录名>` 虚拟路径）是唯一还能拿到的固定信息种子 —— 它们不是 PSB 的权威
 * 名称，但足以让页面显示「当初是哪个工作区」而不是空态，并明确标成降级信息。
 */
export interface PsbAdminLocalSessionHint {
  readonly remoteHostId: string | null;
  readonly title: string | null;
  readonly workingDir: string | null;
}

export interface PsbWorkspaceAdminServiceDeps {
  /** 现取 PSB 服务：账号边界会 `dispose` 并重新装配实例，不能捕获旧的那个。 */
  resolveRemote(): PsbAdminRemotePort;
  /** 读本地任务行的 `remoteHostId`（`psb:` 前缀才是远程工作区会话）。 */
  readLocalSessionRemoteHostId(localSessionId: string): Promise<string | null>;
  /**
   * 读本地任务行的更多线索（`title` / `workingDir`）。缺省时只按 `readLocalSessionRemoteHostId`
   * 解析工作区（历史会话兜底会退化，但功能不崩）。
   */
  readLocalSessionHint?(localSessionId: string): Promise<PsbAdminLocalSessionHint | null>;
  store: PsbAdminRecentWorkspaceStore;
  emitContextChanged(event: PsbWorkspaceAdminContextChangedEvent): void;
  emitStreamEvent(event: PsbStreamEvent): void;
  log: PsbAdminLogger;
  /**
   * 过渡兜底创建内部会话的幂等键（每次真正发起创建新生成一个）。
   * 正常路径（工作区级订阅）不需要它。
   */
  createRequestId(): string;
}

export interface PsbWorkspaceAdminService {
  context(input: { localSessionId?: string | null }): Promise<PsbWorkspaceAdminContextResult>;
  streamStart(workspaceId: string): Promise<PsbWorkspaceAdminStreamStartResult>;
  streamStop(workspaceId: string): Promise<void>;
  /**
   * 读工作区级串流状态。
   *
   * **只用绑定里的会话 id** 发一次只读 HTTP `stream/status`：**不订阅、不创建 PSB 会话、不占用
   * 工作区**。没有绑定（用户还没点过「启动」）或 PSB 读不到时返回 `status: null`（不抛错，
   * `null` ≠ `capable:false`）。返回值带 `viewerSessionId`（加性；只来自内存绑定 / 本机记录）。
   */
  streamStatus(workspaceId: string): Promise<PsbWorkspaceAdminStreamStatusResult>;
  /**
   * 转发一条键鼠输入到该工作区绑定的观看端 WS。
   *
   * 输入是**高频**路径：这里不做上下文重读、不落盘、不打 info 日志，只在没有可用绑定时抛
   * 可行动失败（`PSB_STREAM_NOT_ACTIVE`：先启动观看）。事件形状与大小上限已在 IPC 层校验
   * （`validatePsbStreamInputEvent`），本函数只做「工作区 → 会话」解析。
   */
  streamInput(workspaceId: string, event: Record<string, unknown>): Promise<void>;
  /** 账号边界 / 进程退出：退订、停掉本端串流（远端桌面访问会话不在这里停）。 */
  dispose(): void;
}

/** 工作区的观看端绑定（每个工作区最多一条）。 */
interface ViewerBinding {
  readonly workspaceId: string;
  /**
   * 观看端连接所挂的会话 id。
   *
   * 正常形态是**桌面访问会话** id（PSB `remote_sessions.id`，工作区级 `stream/subscribe`
   * 返回；**不是** agent 会话 id）；过渡兜底时是内部 Agent 会话 id。观看端 WS 与
   * `stream/status` 都按它走（PSB 过渡形态：两条既有路由同时接受这两类 id）。
   */
  readonly sessionId: string;
  /** 最近一次读到的串流状态（事件 / 显式读数都会更新它）。 */
  status: PsbWorkspaceAdminStreamStatus | null;
}

/** 工作区实时解析结果（PSB 行可用）。 */
interface ResolvedWorkspaceLive {
  readonly kind: 'live';
  readonly workspace: PsbRemoteWorkspace;
  readonly source: PsbWorkspaceAdminContextSource;
  /** 解析时 PSB 给的可读失败原因（只在兜底到缓存时用于解释）。 */
  readonly failureMessageZh: string | null;
}

/**
 * 工作区降级解析结果（固定信息来自本机快照 / 会话行种子）。
 *
 * `availability` 区分用户下一步：`missing` = PSB 说工作区不在了（删 / 无权限）；
 * `unavailable` = 读不到 PSB（网络 / 鉴权 / PSB 不可达）或当前任务的会话读不到。
 */
interface ResolvedWorkspaceStale {
  readonly kind: 'stale';
  readonly workspaceId: string;
  readonly source: PsbWorkspaceAdminContextSource;
  readonly availability: 'unavailable' | 'missing';
  readonly staleReason: PsbWorkspaceAdminStaleReason;
  readonly title: string;
  readonly templateTitle: string | null;
  readonly clientName: string;
  readonly clientOnline: boolean | null;
  readonly directoryName: string | null;
  readonly state: string | null;
  /** 固定信息快照的落盘时间（ISO）；会话行种子没有快照，为 `null`。 */
  readonly snapshotSavedAt: string | null;
  readonly workspaceIdKnown: boolean;
  readonly failureMessageZh: string | null;
}

type ResolvedWorkspace = ResolvedWorkspaceLive | ResolvedWorkspaceStale;

type WorkspaceLookup =
  | { readonly kind: 'found'; readonly workspace: PsbRemoteWorkspace }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly failureMessageZh: string | null };

/** 管理页在内存里记住的「这个工作区上次解析结果」，给写操作闸门用。 */
interface KnownWorkspaceState {
  readonly availability: 'live' | 'unavailable' | 'missing';
  readonly staleReason: PsbWorkspaceAdminStaleReason | null;
  readonly workspaceIdKnown: boolean;
  readonly failureMessageZh: string | null;
}

/**
 * 用绑定里的会话 id 读一次状态的结果。
 *
 * - `ok`：读到了（`dead`/`failed` 都不会进缓存）；
 * - `dead`：PSB 明确说这条会话找不到 / 没权限（桌面访问被重建、内部会话已结束）→ 绑定作废；
 * - `failed`：读不清（网络 / 鉴权 / 协议错）→ **绑定保留**，只记诊断。两者分开是刻意的：
 *   网络抖动删掉记录会让下次启动多订阅/多建一条会话。
 */
type BindingProbe =
  | { readonly kind: 'ok'; readonly status: PsbWorkspaceAdminStreamStatus }
  | { readonly kind: 'dead'; readonly failure: PsbRemoteFailure }
  | { readonly kind: 'failed'; readonly failure: PsbRemoteFailure; readonly error: unknown };

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
 * 这条订阅失败是否表示「工作区级订阅端点不存在」（旧 PSB）→ 允许过渡回退。
 *
 * PSB 0.1.172 之前没有这条路由：404（路由不存在）/ 405 / `UNSUPPORTED`。新服务端上的 404
 * 意思是「工作区不可见」，但那时 `ensureWorkspaceLocked` 已经先行确认工作区可见、就绪、
 * 由当前身份锁定，所以这里的 404 只可能是「端点不存在」；万一工作区真的在这几毫秒内消失，
 * 回退建会话同样 404/400，最终错误一致且**不会留下任何会话行**。
 */
function isWorkspaceSubscribeUnavailable(error: unknown): boolean {
  if (!(error instanceof PsbClientError)) return false;
  if (error.status === 404 || error.status === 405) return true;
  switch (error.failure.code) {
    case 'UNSUPPORTED':
    case 'NOT_IMPLEMENTED':
    case 'ROUTE_NOT_FOUND':
      return true;
    default:
      return false;
  }
}

/**
 * 启动观看端失败时，这条失败是否说明「绑定的会话已不可用」→ 重新订阅一次。
 *
 * 只认**明确指向会话不存在 / 未就绪**的失败；鉴权、网络、客户端不支持串流都不重试（重试只会
 * 把同一个失败重放一遍，还会掩盖真实原因）。
 */
function isStaleStreamSessionFailure(error: unknown): boolean {
  if (!(error instanceof PsbClientError)) return false;
  if (error.status === 404 || error.status === 409 || error.status === 410) return true;
  switch (error.failure.code) {
    case 'NOT_FOUND':
    case 'FORBIDDEN':
    case 'PSB_STREAM_NOT_READY':
      return true;
    default:
      return false;
  }
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

/**
 * 会话的虚拟工作目录前缀（与共享 `buildPsbVirtualWorkingDir` 同一形状：
 * `/psb-remote/<目录名>`）。这里只做**反查目录名**，不新建第二套路径格式。
 *
 * 为什么在 main 侧反查：历史会话没有固定信息快照，读 PSB 也失败时，会话行的
 * `workingDir` 是唯一还能拿到「当初在哪个目录」的线索；目录名又常能对上同一工作区的快照。
 */
const PSB_VIRTUAL_WORKING_DIR_PREFIX = '/psb-remote/';

/** `/psb-remote/<目录名>` → 目录名；不是虚拟工作目录时 `null`。 */
function psbVirtualDirectoryName(workingDir: string | null): string | null {
  if (!workingDir) return null;
  const trimmedWorkingDir = workingDir.trim();
  if (!trimmedWorkingDir.startsWith(PSB_VIRTUAL_WORKING_DIR_PREFIX)) return null;
  const rest = trimmedWorkingDir.slice(PSB_VIRTUAL_WORKING_DIR_PREFIX.length);
  const directoryName = rest.split(/[\\/]/, 1)[0]?.trim();
  return directoryName ? directoryName : null;
}

/** 工作区 `clientPath` 的 basename（`D:\psb\saga2_project-2` → `saga2_project-2`）；空值返回 `''`。 */
function psbPathBasename(path: string | null | undefined): string {
  const text = (path ?? '').trim();
  if (!text) return '';
  const parts = text.split(/[\\/]/);
  return parts[parts.length - 1]?.trim() ?? '';
}

/**
 * stale / 占位身份下写操作的可行动失败（`streamStart` 的闸门）。
 *
 * 为什么不放行再去打 PSB：工作区已不可见时那只会得到一条 404/网络错误，用户看到的是
 * 「操作失败」一类不可行动的话；这里直接说清「已经看不到这个工作区」或「暂时连不上」，
 * 并保留 PSB 原话做诊断。渲染层还会按 `availability` 先给本地化文案，这是 main 侧兜底。
 */
function staleWorkspaceActionFailure(state: KnownWorkspaceState): PsbClientError {
  const missing = state.availability === 'missing';
  const detail = state.failureMessageZh?.trim() || null;
  return new PsbClientError(
    missing
      ? {
          code: 'NOT_FOUND',
          messageKey: 'remoteWorkspace.error.notFound',
          message: detail ?? '这个远程工作区已不可见（可能已被删除或没有访问权限），无法继续操作。',
        }
      : {
          code: 'PSB_UNREACHABLE',
          messageKey: 'remoteWorkspace.error.unreachable',
          message: detail ?? '暂时连不上这个远程工作区（网络或 PSB 不可达），请检查网络后重试。',
        },
    null,
  );
}

export function createPsbWorkspaceAdminService(
  deps: PsbWorkspaceAdminServiceDeps,
): PsbWorkspaceAdminService {
  /** 工作区 id → 观看端绑定。 */
  const bindings = new Map<string, ViewerBinding>();
  /** 工作区 id → 进行中的「拿到可用绑定」（并发 start 共享一次订阅 / 过渡回退创建）。 */
  const ensureInFlight = new Map<string, Promise<ViewerBinding>>();
  /** 工作区 id → 最近一次解析出的可信度（写操作闸门用：stale / 占位身份时直接给可行动失败）。 */
  const lastWorkspaceState = new Map<string, KnownWorkspaceState>();
  /** 工作区 id → 最近一次读到的工作区行（PSB 读不到时保留最后一次快照）。 */
  const lastWorkspaceRowById = new Map<string, PsbRemoteWorkspace>();
  /** 工作区 id → 最近一次串流状态（来自显式读数或串流事件）。 */
  const lastStatusByWorkspace = new Map<string, PsbWorkspaceAdminStreamStatus>();

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
    lastWorkspaceState.clear();
    lastWorkspaceRowById.clear();
    lastStatusByWorkspace.clear();
    lastEmitted = undefined;
    refreshInFlight = null;
    refreshPending = false;
  }

  /* ------------------------------ 工作区解析 ------------------------------ */

  /**
   * 工作区被确认**不可见**（被删 / 无权限）时的本地清理。
   *
   * 不清远端任何东西：桌面访问会话属于 PSB 工作区，工作区没了它也随之失效；这里丢掉的是
   * **观看端绑定**与内存缓存（避免拿一个不存在的 workspaceId 去订阅），但**保留**
   * `会话→工作区`映射、`lastWorkspaceId` 与固定信息快照 —— 它们都是「当初是哪个工作区」的
   * 历史事实，页面要继续显示（stale 口径，见文件头），下一次解析也还要靠映射找回这条快照。
   */
  function forgetWorkspaceLocally(workspaceId: string): void {
    bindings.delete(workspaceId);
    lastStatusByWorkspace.delete(workspaceId);
    lastWorkspaceRowById.delete(workspaceId);
    deps.store.forgetDesktopSession(workspaceId);
  }

  async function lookupWorkspace(workspaceId: string): Promise<WorkspaceLookup> {
    try {
      const workspaces = await remote().listWorkspaces();
      const found = workspaces.find((entry) => entry.id === workspaceId);
      if (!found) return { kind: 'missing' };
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

  /** 把一次实时工作区行记成固定信息快照（值不变 0 次写；读路径唯一的落盘点）。 */
  function rememberSnapshotFor(workspace: PsbRemoteWorkspace): void {
    deps.store.rememberWorkspaceSnapshot({
      workspaceId: workspace.id,
      title: workspace.title,
      templateTitle: workspace.templateTitle,
      clientName: workspace.clientName,
      clientOnline: workspace.clientOnline,
      directoryName: workspace.directoryName,
      state: workspace.state,
    });
  }

  /** 实时解析成功：刷新内存行、固定信息快照与「写操作可信度」表。 */
  function liveResolved(
    workspace: PsbRemoteWorkspace,
    source: PsbWorkspaceAdminContextSource,
    failureMessageZh: string | null = null,
  ): ResolvedWorkspaceLive {
    rememberBounded(lastWorkspaceRowById, workspace.id, workspace);
    rememberSnapshotFor(workspace);
    lastWorkspaceState.set(workspace.id, {
      availability: 'live',
      staleReason: null,
      workspaceIdKnown: true,
      failureMessageZh: null,
    });
    return { kind: 'live', workspace, source, failureMessageZh };
  }

  /** 记录 stale 解析结果（写操作闸门据此直接拒绝，不再打一次注定失败的 PSB 写请求）。 */
  function noteStaleState(resolved: Omit<ResolvedWorkspaceStale, 'kind'>): ResolvedWorkspaceStale {
    lastWorkspaceState.set(resolved.workspaceId, {
      availability: resolved.availability,
      staleReason: resolved.staleReason,
      workspaceIdKnown: resolved.workspaceIdKnown,
      failureMessageZh: resolved.failureMessageZh,
    });
    return { kind: 'stale', ...resolved };
  }

  /** 用固定信息快照构造 stale 解析结果。 */
  function staleFromSnapshot(
    snapshot: PsbAdminWorkspaceSnapshot,
    source: PsbWorkspaceAdminContextSource,
    availability: 'unavailable' | 'missing',
    staleReason: PsbWorkspaceAdminStaleReason,
    failureMessageZh: string | null,
  ): ResolvedWorkspaceStale {
    return noteStaleState({
      workspaceId: snapshot.workspaceId,
      source,
      availability,
      staleReason,
      title: snapshot.title,
      templateTitle: snapshot.templateTitle,
      clientName: snapshot.clientName,
      clientOnline: snapshot.clientOnline,
      directoryName: snapshot.directoryName,
      state: snapshot.state,
      snapshotSavedAt: snapshot.savedAt,
      workspaceIdKnown: true,
      failureMessageZh,
    });
  }

  /**
   * PSB 读不到、但内存里还有上一次实时行（比快照新或快照写失败时）：
   * 固定信息仍可信，标成 stale 展示。
   */
  function staleFromCachedRow(
    row: PsbRemoteWorkspace,
    source: PsbWorkspaceAdminContextSource,
    failureMessageZh: string | null,
  ): ResolvedWorkspaceStale {
    return noteStaleState({
      workspaceId: row.id,
      source,
      availability: 'unavailable',
      staleReason: 'list-failed',
      title: row.title,
      templateTitle: row.templateTitle?.trim() || null,
      clientName: row.clientName,
      clientOnline: row.clientOnline,
      directoryName: row.directoryName ?? null,
      state: row.state,
      snapshotSavedAt: null,
      workspaceIdKnown: true,
      failureMessageZh,
    });
  }

  /**
   * 历史会话兜底（快照 & 会话映射 & 实时目录匹配都失败）：用本机会话行种子出**降级**上下文。
   *
   * 名称优先级（2026-11-26 真机复验修正）：目录名对得上的固定信息快照（title / 模板 / 机器都
   * 有）→ `/psb-remote/<目录>` 的目录名。**任务标题不是工作区名称**：真机里曾把
   * 「联调测试只回复OK」这种任务标题冒充成工作区名，必须禁止。机器名 / 模板拿不到就留空
   * （渲染层显示「—」），不编造。
   *
   * `workspaceIdKnown: false` 明确告诉渲染层「这个 id 是占位，不能拿去写 PSB」。
   */
  function staleFromSessionHint(
    psbSessionId: string | null,
    hint: PsbAdminLocalSessionHint | null,
    staleReason: PsbWorkspaceAdminStaleReason,
    failureMessageZh: string | null,
  ): ResolvedWorkspaceStale | null {
    const directoryName = psbVirtualDirectoryName(hint?.workingDir ?? null);
    // 目录名通常唯一（`saga2_project-2`）：命中快照就能拿回名称 / 模板 / 机器。
    const byDirectory = directoryName
      ? deps.store.workspaceSnapshotByDirectoryName(directoryName)
      : null;
    if (byDirectory) {
      return staleFromSnapshot(
        byDirectory,
        'last-used',
        'unavailable',
        staleReason,
        failureMessageZh,
      );
    }
    const title = directoryName ?? '';
    if (!title && !psbSessionId) return null;
    const workspaceId = psbSessionId
      ? `psb:${psbSessionId}`
      : `psb-dir:${directoryName ?? title}`;
    return noteStaleState({
      workspaceId,
      source: 'session',
      availability: 'unavailable',
      staleReason,
      title,
      templateTitle: null,
      clientName: '',
      clientOnline: null,
      directoryName,
      state: null,
      snapshotSavedAt: null,
      workspaceIdKnown: false,
      failureMessageZh,
    });
  }

  /**
   * 历史会话的第二条实时兜底（2026-11-26 真机复验）：`workspaceId` 未知时，用会话行
   * `/psb-remote/<目录>` 的**目录名**去实时工作区列表匹配（`directoryName` / `title` /
   * `clientPath` basename 三种拼写相同即命中）。
   *
   * 真机里「会话详情 404、但工作区好好地在列表里」被误判成 stale；服务器通畅时必须走服务器：
   * 匹配到就返回实时行（`live`，页头名称 / 模板 / 机器 / 占用全部来自 PSB）。
   */
  type DirectoryWorkspaceMatch =
    | { readonly kind: 'found'; readonly workspace: PsbRemoteWorkspace }
    | { readonly kind: 'none' }
    | { readonly kind: 'failed'; readonly failureMessageZh: string | null };

  async function matchWorkspaceByDirectoryName(
    directoryName: string,
  ): Promise<DirectoryWorkspaceMatch> {
    let workspaces: PsbRemoteWorkspace[];
    try {
      workspaces = await remote().listWorkspaces();
    } catch (error) {
      const failure = toPsbRemoteFailure(error);
      deps.log.debug('psb admin: listing workspaces failed while matching the session directory', {
        directoryName,
        code: failure.code,
      });
      return { kind: 'failed', failureMessageZh: failure.message };
    }
    const target = directoryName.trim();
    // PSB 的 `directoryName` 可能带后缀（`saga2_project-2`）而用户可读 `title` 是 `saga2_project`；
    // `clientPath` 的 basename 也是同一事实的第三种拼写。三种都认，避免「列表里明明有」却判 stale。
    const matchesTarget = (entry: PsbRemoteWorkspace, folded: boolean): boolean => {
      const candidates = [entry.directoryName ?? '', entry.title, psbPathBasename(entry.clientPath)];
      return candidates.some((candidate) => {
        const value = candidate.trim();
        return folded
          ? value.toLowerCase() === target.toLowerCase()
          : value === target;
      });
    };
    const exact = workspaces.find((entry) => matchesTarget(entry, false)) ?? null;
    if (exact) return { kind: 'found', workspace: exact };
    // 大小写差异（目录名由 PSB 生成、`title` 是用户可读名）也认：唯一命中才算，不猜多个候选。
    const loose = workspaces.filter((entry) => matchesTarget(entry, true));
    return loose.length === 1 ? { kind: 'found', workspace: loose[0] } : { kind: 'none' };
  }

  async function readWorkspaceFromSession(
    psbSessionId: string,
  ): Promise<ResolvedWorkspaceLive | null> {
    try {
      const result = await remote().sessionStatus(psbSessionId);
      const workspace = result.workspace;
      // 读成功就把映射刷新一遍：终态/404 之后靠它兜底，也顺带把「最近使用」推进到当前工作区。
      deps.store.rememberSessionWorkspace(psbSessionId, workspace.id);
      deps.store.rememberWorkspace(workspace.id);
      return liveResolved(workspace, 'session');
    } catch (error) {
      const failure = toPsbRemoteFailure(error);
      deps.log.debug('psb admin: reading the task PSB session failed; falling back to records', {
        psbSessionId,
        code: failure.code,
      });
      return null;
    }
  }

  /** 按已知 workspaceId 解析的结果：`listFailed` 让调用方避免重复打一次注定失败的列表请求。 */
  interface KnownWorkspaceResolution {
    readonly resolved: ResolvedWorkspace | null;
    readonly listFailed: boolean;
    readonly failureMessageZh: string | null;
  }

  /**
   * 按已知 workspaceId 解析：实时行 → （不可见 / 读不到时）固定信息快照 → 内存上一次行。
   * `resolved: null` 时调用方继续用其它兜底，不在这里直接清空页面。
   */
  async function resolveKnownWorkspaceId(
    workspaceId: string,
  ): Promise<KnownWorkspaceResolution> {
    const lookup = await lookupWorkspace(workspaceId);
    if (lookup.kind === 'found') {
      return {
        resolved: liveResolved(lookup.workspace, 'last-used'),
        listFailed: false,
        failureMessageZh: null,
      };
    }
    if (lookup.kind === 'missing') {
      // 工作区已不可见（被删 / 无权限）：易变记录清掉，固定信息快照留着显示。
      forgetWorkspaceLocally(workspaceId);
      const snapshot = deps.store.workspaceSnapshot(workspaceId);
      return {
        resolved: snapshot
          ? staleFromSnapshot(snapshot, 'last-used', 'missing', 'workspace-missing', null)
          : null,
        listFailed: false,
        failureMessageZh: null,
      };
    }
    // PSB 暂时读不到：保留上一次的固定信息（快照优先，其次内存行），状态类字段降级。
    const snapshot = deps.store.workspaceSnapshot(workspaceId);
    if (snapshot) {
      return {
        resolved: staleFromSnapshot(
          snapshot,
          'last-used',
          'unavailable',
          'list-failed',
          lookup.failureMessageZh,
        ),
        listFailed: true,
        failureMessageZh: lookup.failureMessageZh,
      };
    }
    const cached = lastWorkspaceRowById.get(workspaceId);
    return {
      resolved: cached
        ? staleFromCachedRow(cached, 'last-used', lookup.failureMessageZh)
        : null,
      listFailed: true,
      failureMessageZh: lookup.failureMessageZh,
    };
  }

  /**
   * 解析「此刻该管理哪个工作区」。
   *
   * 顺序即优先级：当前任务的 PSB 会话（任何状态；详情可读时用它的 workspace id 精确匹配）→
   * 本机「会话→工作区」映射 / 快照 → **历史会话的目录名实时匹配**（会话详情 404 / 没有映射时，
   * 用 `/psb-remote/<目录>` 去实时列表找同一个工作区，服务器通畅时仍按 live 渲染）→
   * 当前任务的降级种子 → 最近使用过的远程工作区（同上三级）→ 最近确认过的快照。
   * 每一步都只回答「工作区是谁」，不回答「会话还能不能用」；**任何一步只要有固定信息就不
   * 返回 `null`** —— 空态只在本机完全没有任何线索时出现（2026-11-26 真机事故口径）。
   */
  async function resolveWorkspace(
    localSessionId: string | null,
  ): Promise<ResolvedWorkspace | null> {
    let sessionHint: PsbAdminLocalSessionHint | null = null;
    if (localSessionId) {
      sessionHint = await readLocalSessionHint(localSessionId);
    }
    const psbSessionId = parsePsbRemoteHostId(
      sessionHint ? sessionHint.remoteHostId : localSessionId ? await readRemoteHostId(localSessionId) : null,
    );
    const directoryName = psbVirtualDirectoryName(sessionHint?.workingDir ?? null);

    /**
     * 历史会话的实时目录匹配（会话详情读不到 / 没有映射时）。
     *
     * `knownListFailure` 由调用方在刚刚读过列表且失败时传入：不再重复请求（双倍超时），
     * 直接产出带 `list-failed` 归因的降级种子。
     */
    const tryDirectoryMatch = async (
      knownListFailure: { readonly failureMessageZh: string | null } | null = null,
    ): Promise<ResolvedWorkspace | null> => {
      if (!directoryName) return null;
      if (knownListFailure) {
        return staleFromSessionHint(
          psbSessionId,
          sessionHint,
          'list-failed',
          knownListFailure.failureMessageZh,
        );
      }
      const matched = await matchWorkspaceByDirectoryName(directoryName);
      if (matched.kind === 'found') {
        // 用实时行做 live 渲染（名称 / 模板 / 机器 / 占用都是 PSB 事实），并补记映射，
        // 下次重启即使列表读不到也能用快照兜底。
        if (psbSessionId) {
          deps.store.rememberSessionWorkspace(psbSessionId, matched.workspace.id);
        }
        deps.store.rememberWorkspace(matched.workspace.id);
        return liveResolved(matched.workspace, 'session');
      }
      // 列表读失败 / 确实匹配不到：降级种子，名称用目录名（不是任务标题）。
      return staleFromSessionHint(
        psbSessionId,
        sessionHint,
        matched.kind === 'failed' ? 'list-failed' : 'session-unreadable',
        matched.kind === 'failed' ? matched.failureMessageZh : null,
      );
    };

    if (psbSessionId) {
      const fromSession = await readWorkspaceFromSession(psbSessionId);
      if (fromSession) return fromSession;

      // 会话读不到（终态被拒 / 记录已清 / 网络）：先用**这条会话**的本机映射（含它的快照），
      // 再退到目录名实时匹配（服务器通畅时仍走服务器），最后才是降级种子。
      const mappedId = deps.store.workspaceIdForSession(psbSessionId);
      if (mappedId) {
        const mapped = await resolveKnownWorkspaceId(mappedId);
        if (mapped.resolved) return mapped.resolved;
        if (mapped.listFailed) {
          const seeded = await tryDirectoryMatch({ failureMessageZh: mapped.failureMessageZh });
          if (seeded) return seeded;
        }
      }
      const byDirectory = await tryDirectoryMatch();
      if (byDirectory) return byDirectory;
      const seeded = staleFromSessionHint(psbSessionId, sessionHint, 'session-unreadable', null);
      if (seeded) return seeded;
    } else if (localSessionId) {
      // `remoteHostId` 丢了但工作目录还是 `/psb-remote/<目录>`：历史会话同样先按目录名
      // 实时匹配，匹配不到才给降级上下文。
      const byDirectory = await tryDirectoryMatch();
      if (byDirectory) return byDirectory;
      const seeded = staleFromSessionHint(null, sessionHint, 'session-unreadable', null);
      if (seeded) return seeded;
    }

    const lastUsedId = deps.store.read().lastWorkspaceId;
    if (lastUsedId) {
      const lastUsed = await resolveKnownWorkspaceId(lastUsedId);
      if (lastUsed.resolved) return lastUsed.resolved;
    }

    // 只剩本机快照（没有任务线索 / 最近使用已失效）：用最近确认过的那条兜底。用户口径：
    // 「只有本机完全没有快照（从未用过）才空」。
    const latest = deps.store.latestWorkspaceSnapshot();
    if (latest) {
      return staleFromSnapshot(latest, 'last-used', 'unavailable', 'snapshot-only', null);
    }
    return null;
  }

  /** 读会话行线索（旧装配 / 单测没有 hint 端口时退化成只读 `remoteHostId`）。 */
  async function readLocalSessionHint(
    localSessionId: string,
  ): Promise<PsbAdminLocalSessionHint | null> {
    if (!deps.readLocalSessionHint) return null;
    try {
      return await deps.readLocalSessionHint(localSessionId);
    } catch (error) {
      deps.log.warn('psb admin: reading the local session row hint failed', {
        localSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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

  /* ------------------------------ 观看端绑定 ------------------------------ */

  /** 本机记录里该工作区观看端绑定的会话 id（没记过 / 已清掉时 `null`）。 */
  function persistedBindingSessionId(workspaceId: string): string | null {
    return deps.store.desktopSessionIdForWorkspace(workspaceId);
  }

  /** 丢掉内存绑定与本机记录（远端会话不在这里停：桌面访问会话归 PSB，内部会话归 PSB 清理）。 */
  function forgetBinding(workspaceId: string): void {
    bindings.delete(workspaceId);
    deps.store.forgetDesktopSession(workspaceId);
  }

  /** 用一条已知的会话 id 建立内存绑定（已存在则复用同一条，不重复写记录）。 */
  function adoptBinding(workspaceId: string, sessionId: string): ViewerBinding {
    const existing = bindings.get(workspaceId);
    const binding: ViewerBinding =
      existing && existing.sessionId === sessionId
        ? existing
        : {
            workspaceId,
            sessionId,
            status: lastStatusByWorkspace.get(workspaceId) ?? null,
          };
    bindings.set(workspaceId, binding);
    return binding;
  }

  /**
   * 用一条绑定的会话 id 读一次工作区级串流状态（只读 HTTP，不订阅、不创建会话）。
   *
   * 失败分两级：`dead`（PSB 明确说找不到 / 没权限）可以安全地丢掉绑定；`failed`（网络 / 鉴权 /
   * 协议错）只记诊断，绑定保留 —— 网络抖动不能删记录，否则下次启动会多订阅/多建一条会话。
   */
  async function probeBinding(sessionId: string): Promise<BindingProbe> {
    try {
      const status = await remote().getStreamStatus(sessionId);
      return { kind: 'ok', status: psbAdminStreamStatusFromPsb(status) };
    } catch (error) {
      const failure = toPsbRemoteFailure(error);
      deps.log.debug('psb admin: reading the stream status of the viewer binding failed', {
        sessionId,
        code: failure.code,
      });
      return isMissingSessionFailure(failure)
        ? { kind: 'dead', failure }
        : { kind: 'failed', failure, error };
    }
  }

  /**
   * 启动路径专用：拿到一个「确认还能用」的绑定（内存 → 本机记录）。
   *
   * **先查绑定状态**：重复「启动」复用同一条桌面访问会话；桌面访问被重建后旧 id 读不到，就丢掉
   * 绑定、由调用方重新订阅。可行动性优先：读不清（网络 / 鉴权）**原样抛**，不静默换一条 ——
   * 启动是用户显式写路径，静默重订阅只会掩盖真实原因。
   */
  async function resolveUsableBinding(workspaceId: string): Promise<ViewerBinding | null> {
    const memory = bindings.get(workspaceId) ?? null;
    const persisted = memory ? null : persistedBindingSessionId(workspaceId);
    const sessionId = memory?.sessionId ?? persisted;
    if (!sessionId) return null;

    const probe = await probeBinding(sessionId);
    if (probe.kind === 'failed') throw probe.error;
    if (probe.kind === 'dead') {
      deps.log.info('psb admin: the viewer binding is gone; subscribing again', {
        workspaceId,
        viewerSessionId: sessionId,
        code: probe.failure.code,
      });
      forgetBinding(workspaceId);
      return null;
    }
    rememberBounded(lastStatusByWorkspace, workspaceId, probe.status);
    const binding = memory ?? adoptBinding(workspaceId, sessionId);
    binding.status = probe.status;
    return binding;
  }

  /**
   * 订阅前**尽力**拉起桌面访问（可选增强，失败一律不阻断）。
   *
   * 为什么放在这里而不是 `streamStart` 开头：订阅是唯一需要「有一个 running 桌面访问」的地方；
   * 重复「启动」复用仍活着的绑定时，不该为一次纯 HTTP 复用多发一条 ensure。放在订阅前一刻，
   * 语义仍是「subscribe 前先尝试 ensure」，且旧 PSB 过渡回退也覆盖到。
   *
   * ## 为什么结果只记日志
   *
   * Cindy 的 Bearer 目前**没有**被放行 PSB 通用网页接口（`/api/remote/**` 恒 403），PSB 台账
   * 记的是「Cindy 入口下一轮加」。所以这里不能把「拉起访问」当闸门：入口没开时继续往下走，
   * 由订阅的 409（`NO_RUNNING_SESSION` + `state`）给出可行动文案。端口没有该方法（旧装配 /
   * 单测 fake）时同样直接跳过。
   */
  async function ensureWorkspaceAccessQuietly(workspaceId: string): Promise<void> {
    const port = remote();
    if (typeof port.ensureWorkspaceAccess !== 'function') return;
    try {
      const outcome = await port.ensureWorkspaceAccess(workspaceId);
      if (outcome.ok) {
        deps.log.info('psb admin: workspace access is running before subscribing', {
          workspaceId,
          startedByThisCall: outcome.startedByThisCall,
        });
        return;
      }
      deps.log.info('psb admin: workspace access ensure did not succeed; continuing to subscribe', {
        workspaceId,
        reason: outcome.reason,
        code: outcome.failure?.messageKey ?? null,
      });
    } catch (error) {
      // 约定是「永不抛」，但端口是外部实现：这里兜一层，保证启动流程不被增强接口打断。
      deps.log.warn('psb admin: workspace access ensure threw; continuing to subscribe', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 建立观看绑定：优先工作区级服务接口；**只有端点不可用**（旧 PSB）才过渡回退。
   *
   * 正常路径**不创建任何 Agent 会话**：`subscribeWorkspaceStream` 只解析当前 running 的桌面
   * 访问会话。回退路径必须带 `purpose:'internal'`（见文件头），新端点可用时永不执行。
   * 订阅前先尝试 `ensureWorkspaceAccess`（尽力而为，见上）；没有 running 访问会话时 PSB 的
   * 409 会被客户端解析成 `PSB_STREAM_NO_RUNNING_SESSION` + `state`，原样上抛给渲染层。
   */
  async function acquireBinding(workspaceId: string): Promise<ViewerBinding> {
    await ensureWorkspaceAccessQuietly(workspaceId);
    let sessionId: string;
    let viaInternalFallback = false;
    try {
      const subscription = await remote().subscribeWorkspaceStream(workspaceId);
      sessionId = subscription.sessionId;
    } catch (error) {
      if (!isWorkspaceSubscribeUnavailable(error)) throw error;
      viaInternalFallback = true;
      const failure = toPsbRemoteFailure(error);
      deps.log.warn(
        'psb admin: workspace-level stream subscribe is unavailable; falling back to an internal agent session',
        {
          workspaceId,
          code: failure.code,
          status: error instanceof PsbClientError ? error.status : null,
        },
      );
      const created = await remote().createSession({
        workspaceId,
        // `pi` 是三种 Harness 里最轻的一种：观看端只订阅画面，不跑 agent 回合。
        agentKind: 'pi',
        title: PSB_ADMIN_INTERNAL_STREAM_SESSION_TITLE,
        // PSB 0.1.172：`internal` 默认不进会话列表 / 不计入 sessionCount；其它值会 400。
        purpose: 'internal',
        clientRequestId: deps.createRequestId(),
      });
      sessionId = created.session.id;
    }

    const binding: ViewerBinding = { workspaceId, sessionId, status: null };
    bindings.set(workspaceId, binding);
    // 立刻落盘：应用重启 / 页面重新打开时**只认这条记录**去读状态（读路径不订阅、不建会话）。
    deps.store.rememberDesktopSession(workspaceId, binding.sessionId);
    deps.store.rememberWorkspace(workspaceId);
    deps.log.info('psb admin: bound the workspace stream viewer', {
      workspaceId,
      viewerSessionId: binding.sessionId,
      viaInternalFallback,
    });
    return binding;
  }

  /**
   * 保证有可用绑定（**只在写路径 / 用户显式启动时调用**）。
   *
   * 顺序：内存绑定 → 本机记录（两者都**先读一次状态**确认还能用）→ 工作区级订阅（旧 PSB 才
   * 回退）。同一工作区的并发启动共享一次「拿绑定」，绝不建出两条内部会话 / 两次订阅。
   * **读路径不调用本函数**（那会让打开页签变成一次订阅 / 不受欢迎的写操作）。
   */
  async function ensureBinding(workspaceId: string): Promise<ViewerBinding> {
    const inFlight = ensureInFlight.get(workspaceId);
    if (inFlight) return inFlight;
    const task = (async (): Promise<ViewerBinding> => {
      const usable = await resolveUsableBinding(workspaceId);
      if (usable) return usable;
      return acquireBinding(workspaceId);
    })().finally(() => {
      if (ensureInFlight.get(workspaceId) === task) ensureInFlight.delete(workspaceId);
    });
    ensureInFlight.set(workspaceId, task);
    return task;
  }

  async function stopStreamQuietly(sessionId: string): Promise<void> {
    try {
      await remote().stopStream(sessionId);
    } catch {
      /* best-effort：重建前的旧连接收尸，失败也不该挡住新连接 */
    }
  }

  /**
   * 启动观看，并在**失效竞态**下恢复一次。
   *
   * 竞态：拿到绑定后到 PSB 处理订阅之间，桌面访问会话可能已被重建（旧 id 不再指向 running
   * 会话）。此时 `startStream` 失败，我们**确认失败指向会话失效**才重新订阅一次并重试；
   * 鉴权 / 网络 / 不支持串流照原样上抛（重试只会把同一个失败重放一遍）。
   *
   * 重新订阅也失败（例如 409「没有 running 桌面访问会话」）就把 PSB 的可读原因抛给用户：
   * 那是可行动的下一步（先去 PSB 网页启动桌面访问），不是「本机不能串流」。
   */
  async function startStreamWithRecovery(workspaceId: string): Promise<{
    binding: ViewerBinding;
    status: PsbSessionStreamStatus;
  }> {
    const binding = await ensureBinding(workspaceId);
    try {
      return { binding, status: await remote().startStream(binding.sessionId) };
    } catch (error) {
      if (!isStaleStreamSessionFailure(error)) throw error;
      const failure = toPsbRemoteFailure(error);
      deps.log.warn('psb admin: the bound viewer session is no longer usable; resubscribing once', {
        workspaceId,
        viewerSessionId: binding.sessionId,
        code: failure.code,
      });
      await stopStreamQuietly(binding.sessionId);
      forgetBinding(workspaceId);
      const rebuilt = await ensureBinding(workspaceId);
      return { binding: rebuilt, status: await remote().startStream(rebuilt.sessionId) };
    }
  }

  async function streamStart(workspaceId: string): Promise<PsbWorkspaceAdminStreamStartResult> {
    const id = normalizedId(workspaceId);
    if (!id) throw createIpcError('INVALID_PARAMS', 'workspaceId is required');

    // 「这个工作区上次解析出来就是不可见 / 连不上」时**直接给可行动失败**，不再先打占用闸门：
    // 那条路只会得到一条 404 或 20s 网络超时，用户看到的是不可行动的错误；这里明确说清
    // 「已经看不到这个工作区」或「暂时连不上」，页面刷新出新上下文后重试即可（2026-11-26 口径）。
    const known = lastWorkspaceState.get(id);
    if (known && (known.availability !== 'live' || !known.workspaceIdKnown)) {
      deps.log.info('psb admin: refusing to start streaming for an unavailable workspace', {
        workspaceId: id,
        availability: known.availability,
        staleReason: known.staleReason,
      });
      throw staleWorkspaceActionFailure(known);
    }

    // 串流 = 工作区写操作（订阅当前桌面访问会话 / 过渡回退建内部会话）：PSB 会对未锁定者拒绝，
    // 所以先确保工作区由自己占用（未占用则自动占用）。失败在这里就给出可行动原因，不建立订阅。
    // 读状态（`streamStatus`）不受此限。
    await remote().ensureWorkspaceLocked(id);

    // 占用成功 = 又确认了一次工作区固定信息（名称 / 模板 / 机器不会变）：落盘快照，
    // 下次 PSB 读不到时页面还能显示。值不变 0 次写。
    const observed = lastWorkspaceRowById.get(id);
    if (observed) rememberSnapshotFor(observed);

    const started = await startStreamWithRecovery(id);
    const status = psbAdminStreamStatusFromPsb(started.status);
    started.binding.status = status;
    rememberBounded(lastStatusByWorkspace, id, status);
    deps.store.rememberWorkspace(id);
    // 上下文可能随这次动作变化（绑定出现、桌面会话状态变了）：重读一次并推送。
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
    // 只停**观看**：绑定保留（下一次启动直接复用同一条桌面访问会话，不重复订阅）。
    await remote().stopStream(binding.sessionId);
    const previous = binding.status ?? psbAdminStreamStatusFallback();
    binding.status = { ...previous, active: false };
    rememberBounded(lastStatusByWorkspace, id, binding.status);
    await refreshContextNow();
  }

  /**
   * 转发一条键鼠输入。
   *
   * 解析链只有一步：`workspaceId → 绑定会话`。**不做「现在是否在播」的本地判断**：那是观测
   * 字段（`status.active` 是 PSB 的语义），拿它当闸门会在弱网/状态滞后时把合法输入静默丢掉；
   * 真正的闸门是 WS 是否 OPEN（`streamViewer.sendInput`），失败也就有可行动原因。
   */
  async function streamInput(workspaceId: string, event: Record<string, unknown>): Promise<void> {
    const id = normalizedId(workspaceId);
    if (!id) throw createIpcError('INVALID_PARAMS', 'workspaceId is required');
    const binding = bindings.get(id);
    if (!binding) throw streamNotActiveFailure();
    await remote().sendStreamInput(binding.sessionId, event);
  }

  /**
   * 读工作区级串流状态（**只用绑定里的会话 id；不订阅、不创建 PSB 会话、不占用工作区**）。
   *
   * `stream/status` 挂在会话路径上，所以必须有一条会话 id 当读口。来源只有两个：
   *   1. 内存里的观看端绑定（本进程启动过观看）；
   *   2. 本机记录里的绑定 id（应用重启后的主路径，只读 HTTP，不订阅、不占名额）。
   *
   * 两者都没有就返回 `status: null`（未知）—— 页面进入时不建立绑定，等用户显式「启动」。
   * `null` 仍**不等于** `capable:false`；返回值额外带 `viewerSessionId`（只来自内存绑定 /
   * 本机记录），让渲染层能过滤 `STREAM_EVENT` / 判断输入是否可发。
   */
  async function streamStatus(workspaceId: string): Promise<PsbWorkspaceAdminStreamStatusResult> {
    const id = normalizedId(workspaceId);
    if (!id) return { status: null, viewerSessionId: null };

    // 已知 stale（工作区不可见 / PSB 读不到）：别再拿一条可能已死的绑定去打一次网络。
    // 返回 `status: null`（无法获取）而不是 `capable:false`，页面在 stale 态下不乱判能力位。
    const known = lastWorkspaceState.get(id);
    if (known && (known.availability !== 'live' || !known.workspaceIdKnown)) {
      return { status: null, viewerSessionId: null };
    }

    let binding = bindings.get(id) ?? null;
    const persisted = binding ? null : persistedBindingSessionId(id);
    const sessionId = binding?.sessionId ?? persisted;
    if (!sessionId) return { status: null, viewerSessionId: null };

    const probe = await probeBinding(sessionId);
    if (probe.kind === 'ok') {
      rememberBounded(lastStatusByWorkspace, id, probe.status);
      if (!binding) {
        // 记录里的绑定还能读：复用成内存绑定（不是新建会话）。`viewerSessionId` 从 null 变为
        // 有值是 `CONTEXT_CHANGED` 的新事实，让已打开页面马上拿到。
        binding = adoptBinding(id, sessionId);
        refreshContextQuietly();
      }
      binding.status = probe.status;
      return { status: probe.status, viewerSessionId: binding.sessionId };
    }

    if (probe.kind === 'dead') {
      // 绑定已经失效（桌面访问被重建 / 内部会话已结束）→ 丢掉内存绑定与本机记录（下次启动
      // 重新订阅），并刷新上下文让页面看到 `viewerSessionId` 变回 null。
      forgetBinding(id);
      refreshContextQuietly();
    }
    // 读不到 PSB 状态 ≠ 客户端不支持：优先返回最后一次已知状态（带最新失败原话），否则 null。
    const viewerSessionId = probe.kind === 'dead' ? null : sessionId;
    const cached = lastStatusByWorkspace.get(id) ?? null;
    if (!cached) return { status: null, viewerSessionId };
    return {
      status: probe.failure.message ? { ...cached, lastErrorZh: probe.failure.message } : cached,
      viewerSessionId,
    };
  }

  /* ------------------------------ 上下文 ------------------------------ */

  /** PSB 实时行构造上下文（固定字段与状态字段都是真值）。 */
  function buildLiveContext(input: {
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
      // 加性字段：观看端绑定会话 id（正常 = 桌面访问会话 id），渲染层按它对 STREAM_EVENT 过滤。
      viewerSessionId: input.binding?.sessionId ?? null,
      stale: false,
      availability: 'live',
      staleReason: null,
      snapshotSavedAt: null,
      workspaceIdKnown: true,
    };
  }

  /**
   * 固定信息来自本机快照 / 会话行种子时的上下文。
   *
   * 语义边界（渲染层据此渲染，不要自己再推断）：
   *   - `title` / `templateTitle` / `clientName` / `directoryName` 来自快照，**照常显示**；
   *   - `occupancy` 是**未知**（结构上必须给值 → 全空），`desktopSession` / `reasonCode` 未知
   *     （`null`），渲染层在 stale 时显示「无法获取」；
   *   - `lastErrorZh` 只放 PSB 原文做诊断，可读原因由 `availability` 选本地化文案。
   */
  function buildStaleContext(
    resolved: ResolvedWorkspaceStale,
    failureMessageZh: string | null,
  ): PsbWorkspaceAdminContext {
    return {
      workspaceId: resolved.workspaceId,
      clientName: resolved.clientName,
      // 快照里的在线状态只作诊断保存；stale 时**不**把它当事实（渲染层不展示）。
      clientOnline: resolved.clientOnline ?? false,
      title: resolved.title,
      templateTitle: resolved.templateTitle?.trim() || null,
      directoryName: resolved.directoryName ?? '',
      state: resolved.state ?? '',
      // 占用未知：不猜占用人，也不猜「无人占用」。
      occupancy: { occupied: false, byMe: false, personName: '' },
      desktopSession: null,
      reasonCode: null,
      lastErrorZh: failureMessageZh?.trim() || resolved.failureMessageZh?.trim() || null,
      source: resolved.source,
      // 读不到 PSB 时不再拿一条可能已死的绑定去试探；页面进入 stale 态。
      viewerSessionId: null,
      stale: true,
      availability: resolved.availability,
      staleReason: resolved.staleReason,
      snapshotSavedAt: resolved.snapshotSavedAt,
      workspaceIdKnown: resolved.workspaceIdKnown,
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

    // stale：固定字段来自本机快照 / 会话行种子，状态字段未知。不再读绑定探针（PSB 本来就
    // 读不到，多打一次只会多等一次超时），也不推进「最近使用」——工作区事实不是这次读到的。
    if (resolved.kind === 'stale') {
      const built = buildStaleContext(resolved, resolved.failureMessageZh);
      emitIfChanged(built);
      return { context: built };
    }

    const workspaceId = resolved.workspace.id;
    let binding = bindings.get(workspaceId) ?? null;
    const persisted = binding ? null : persistedBindingSessionId(workspaceId);
    const sessionId = binding?.sessionId ?? persisted;
    let desktop = lastStatusByWorkspace.get(workspaceId) ?? binding?.status ?? null;
    let failureMessageZh = resolved.failureMessageZh;

    // 桌面会话状态只能借**绑定里那条会话 id** 去问 PSB。读路径**不订阅、不建会话、不占用工作区**：
    // 应用重启后内存绑定全丢时，只复用本机记录里的绑定 id（一次只读 HTTP）；没有绑定就保持
    // `null`（未知），等用户显式「启动」再建立绑定。
    if (sessionId) {
      const probe = await probeBinding(sessionId);
      if (probe.kind === 'ok') {
        desktop = probe.status;
        // 读到新状态就以它为准（它自带 lastErrorZh）。
        failureMessageZh = null;
        if (!binding) binding = adoptBinding(workspaceId, sessionId);
        binding.status = probe.status;
        rememberBounded(lastStatusByWorkspace, workspaceId, probe.status);
      } else {
        // 失败原话只放非空的 PSB 文本：空串不能把「上一次的失败原因」盖成空。
        const detail = probe.failure.message?.trim();
        if (detail) failureMessageZh = detail;
        if (probe.kind === 'dead') {
          // 绑定已失效：丢掉内存绑定与本机记录，下一次「启动」会重新订阅。
          forgetBinding(workspaceId);
          binding = null;
        }
      }
    }

    // 「最近使用」只在值变化时落盘（见 `adminRecentStore` 的写纪律）；固定信息快照已在
    // `liveResolved` 写入（值不变 0 次写）。
    deps.store.rememberWorkspace(workspaceId);

    const built = buildLiveContext({
      workspace: resolved.workspace,
      source: resolved.source,
      binding,
      desktop,
      failureMessageZh,
    });
    emitIfChanged(built);
    return { context: built };
  }

  /* ------------------------------ 串流事件 ------------------------------ */

  function bindingForSession(sessionId: string): ViewerBinding | null {
    for (const binding of bindings.values()) {
      if (binding.sessionId === sessionId) return binding;
    }
    return null;
  }

  /**
   * 管理页观看端的事件 → 管理页通道。
   *
   * 只转发**自己绑定**的会话的事件：用户任务会话 / 其它观看端的串流属于会话页（走
   * `PSB_REMOTE_CHANNELS`），混进管理页会让同一帧被两处解码。
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
        // PSB 说这条会话已结束 / 已不存在（桌面访问被重建或停止）：丢掉内存绑定**与本机记录**，
        // 下次启动重新订阅。`session-not-found` 来自 PSB 0.1.170 的 4404（`errors=frame` 升级码，
        // 当前未启用，加性处理）。留着记录中的死 id 会让下一次启动先白读一次。
        forgetBinding(workspaceId);
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
