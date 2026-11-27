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
 * ## 多窗口：所有「最近一次」都必须按 localSessionId 分桶（2026-11-26 独立审查）
 *
 * 管理页是**广播**面：`CONTEXT_CHANGED` 发给所有受信窗口，而每个窗口各自打开一个任务。
 * 旧实现用两个全局量：
 *
 *   - 全局 `lastLocalSessionId`（最后一次 `context()` 入参）：窗口 B 读一次就改写了它，随后
 *     窗口 A 的动作刷新出来的推送标成 B 的任务 —— A 会丢弃，B 会把它当成自己的工作区；
 *   - 单一 `lastEmitted` 推送基线：A、B 交替读不同任务时基线互相覆盖，同一份上下文会被
 *     反复当成「变了」/「没变」，推送要么丢要么错。
 *
 * 现在：
 *   - `context()` 把入参固化到本次调用的局部变量，不再写任何全局「最近 id」；
 *   - 推送基线与去重按 `localSessionId` 分桶（无任务线索的兜底桶单独一桶），
 *     `emitIfChanged(context, localSessionId)` 显式带桶；
 *   - **无任务线索的兜底桶（`localSessionId = null`）只建立基线、不广播**（2026-11-27 审查
 *     s2 P1）：`CONTEXT_CHANGED` 是广播面，一个「没有任务」的上下文推到有任务的窗口会被当成
 *     「当前任务的工作区变了」而覆盖页面状态。没有任务线索的调用方拿 invoke 的返回值即可；
 *   - `refreshContextNow/Quietly` 由调用方传入 `{ localSessionId, workspaceId }`：刷新
 *     发起窗口的桶 + 所有「上次解析到该工作区」的桶。不再读全局最近 id（ipc 层可以把
 *     发起动作的 `localSessionId` 透传进来；不透传时按工作区匹配也能覆盖单窗口场景）。
 *
 * ## stale 闸门的新鲜度（写操作前）
 *
 * `KnownWorkspaceState` 带 `checkedAt`：`streamStart` 只在状态足够新时直接拒绝；过旧就先重新
 * 解析一次（服务器恢复后点「启动」应该能用，而不是被十几分钟前的失败永久拦住）。
 * 写路径的 PSB 失败也会**反向吸收**进闸门：`NOT_FOUND` / `FORBIDDEN` → `missing`，
 * `PSB_UNREACHABLE` → `unavailable` —— 刚被 PSB 告知「工作区没了」之后不能还把它标成 live。
 * 占位身份（`workspaceIdKnown: false`）用专门的 `staleReason: 'unknown-workspace'` 与
 * 专门的失败码 / messageKey（`remoteWorkspace.admin.staleUnknownWorkspaceAction`）。
 *
 * ## 启发式匹配不落盘（持久化风险）
 *
 * 历史会话没有会话详情时，会用 `/psb-remote/<目录名>` 反查实时工作区列表（目录名 / title /
 * clientPath basename）。这是**启发式**：同名目录在列表里唯一时才命中，但仍是猜测。猜对了
 * 可以按 live 展示；**猜错了不能持久化**——否则这个任务以后永远指向别人的工作区。所以：
 *   - 只有 `sessionStatus` 详情返回的 workspace id 才写 `会话→工作区` 映射；
 *   - 目录 / title 命中的结果只留在内存（`lastWorkspaceRowById` 标 inferred，日志记
 *     `inferred: true`），不写映射、不写快照；
 *   - 之后用户点「启动」并在 PSB 上真的锁定成功，那一刻 PSB 已确认工作区存在，才落快照。
 *
 * ## 过渡回退（只有旧 PSB）：内部会话必须收尸
 *
 * 工作区级订阅端点是 PSB 0.1.172 新增的。旧服务端上这条路由不存在（404/405/`UNSUPPORTED`），
 * 此时允许临时回退到「内部 Agent 会话」充当观看端，必须同时满足：
 *
 *   - 创建时显式传 `purpose: 'internal'`（PSB 默认不列进会话列表、不增加 `sessionCount`）；
 *   - 标题写明内部用途（`PSB_ADMIN_INTERNAL_STREAM_SESSION_TITLE`），**不伪装成用户任务**；
 *   - 记 warn 日志。
 *
 * 旧实现只建会话、不收尸：创建成功但起观看端失败时内部会话留在 PSB 里；PSB 升级后旧的内部
 * 会话也永远没人清。现在：
 *   - 起观看端失败 → **best-effort `stopSession`** 回滚这条内部会话（失败只记 debug）；
 *   - 记录本进程创建的 fallback 会话；**工作区级订阅成功**（说明服务端已支持新端点）或
 *     绑定被判定失效时，按 TTL / 失效清理（不再被任何绑定引用即可清；仍被引用时等 TTL）。
 *
 * 新端点可用时这条路径**永不**执行；其它失败（409 没有 running 桌面访问、鉴权、网络、可读
 * 业务错误）不触发回退 —— 那些不是「端点不存在」，静默建会话只会掩盖真实原因。
 *
 * ## 启动串流的必经步骤：占用闸门 → `ensureWorkspaceAccess` → 订阅 → 起观看端
 *
 * CINDY-RW-17（PSB 0.1.183）起，PSB 在 Cindy 命名空间放行了「启动桌面访问」的幂等 ensure
 * 入口。Cindy 与网页**同一口径**：读 `GET …/access` → 只有终态（none/stopped/failed）才
 * `POST …/access/start` → 轮询到 `running` → 再 `stream/subscribe`。顺序固定：
 *
 *   1. 占用闸门（`ensureWorkspaceLocked`，mine 才放行；空闲返回 `PSB_WORKSPACE_NOT_OCCUPIED`，
 *      由渲染层弹确认 → 用户确认占用 → 重试同一次启动）；
 *   2. `ensureWorkspaceAccess`（**必经路径**，不再是「可选增强 / 能力位」）：失败带码抛出
 *      （未占用 / 被他人占用 / 超时 / 网络），`unsupported`（旧 PSB 没有该路由）才退回直接
 *      订阅 —— 旧服务端的订阅 409 会给出可行动文案；
 *   3. 工作区级订阅拿桌面访问会话 id（旧 PSB 才过渡回退内部会话）；
 *   4. 起观看端。
 *
 * 因此 Cindy 用户**不需要再去 PSB 网页启动访问**：`starting` 期间界面显示「正在启动桌面
 * 访问…」，启动完成后自动进入订阅。旧的「能力位 / 后台预热 / 不阻塞启动」编排已删除：
 * 它建立在「Cindy Bearer 未被放行、最多得到 403」的历史事实上，会让真机启动串流永远拿不到
 * 访问，只能等用户去网页点一次。
 *
 * ## 三条不变式
 *
 * 1. **页面不写「猜测」**：读不到的桌面会话状态是 `null`（未知），**不是** `none`；读不到
 *    串流状态时 `STREAM_STATUS` 返回 `null` 而不是 `capable:false`。
 *    「不知道」被当成「不支持」会让按钮永久不可用，这正是本批要修的退化。
 * 2. **推送只在「刚拿到新事实」时发**：`CONTEXT_CHANGED` 的比较对象是该 `localSessionId`
 *    桶的完整上下文快照，值没变不发；main 不轮询 PSB（与 `push.ts` 的既有取舍同一条）。
 * 3. **失败归因保留 PSB 原话**：跨 IPC 的 `message` 只放 PSB 的可读原文或 `null`，
 *    **不再写中文兜底句**（文案在 i18n，由渲染层按码选择）；不放 token / 身份字段；
 *    桌面会话 id 与内部会话 id 都是 PSB 的、不是凭据。
 *
 * ## 固定信息快照与 stale 降级（2026-11-26 真机事故）
 *
 * 用户口径：工作区名称 / 模板 / 机器在会话启动时就是**固定信息**，不会变；但设备会掉线、
 * 工作区会被移除，所以不能只靠服务器即时读取。实现：
 *
 *   - 实时读成功（`context` / `createSession` / 占用成功）→ 把固定字段落盘成快照（值不变 0 次写）；
 *   - 读不到（断网 / 被删 / 当前任务的 PSB 会话读不到）→ **仍返回上下文**，`stale: true`
 *     + `availability`（`missing` = 列表读成功但工作区不在 / `unavailable` = 读不到 PSB），
 *     状态类字段（占用 / 桌面会话）留空由渲染层显示「无法获取」；
 *   - 历史会话（快照 & 会话映射都缺）→ 用虚拟工作目录的目录名种子出占位上下文
 *     （`workspaceIdKnown: false`，写操作一律拒绝）；
 *   - 只有本机**完全没有线索**（没有快照、没有会话行种子）才返回 `context: null`。
 *
 * stale 时写操作（启动串流等）由 `streamStart` 直接给可行动失败（工作区已不可见 / 连不上），
 * 不再发一次注定失败的 PSB 写请求。
 *
 * ## 并发：start / stop 按工作区串行 + 代次
 *
 * 用户可以在「启动」还在路上时点「停止」（或反过来）。旧实现让两条动作并发跑，结果是
 * 「停止已经返回，随后启动完成的串流又起来了」。现在：
 *   - 同一工作区的 start / stop 进同一条串行队列；
 *   - `streamStop` 在**入队前**推进该工作区的操作代次；
 *   - `streamStart` 记下入队时的代次，落定（拿到启动结果）后发现代次变了就**自己停掉**
 *     刚起的串流并返回未启动状态，随后排队的 stop 视为已完成、不重复停。
 * 这条互斥在服务内部完成，ipc / index 不需要额外的 helper。
 *
 * ## 多窗口：一条观看连接，多个 owner（2026-11-27 复审 P1）
 *
 * 进程内只有一个串流观看端实例（`streamViewer`），`startStream` 的语义是**替换**该会话的旧连接
 * 并补发 `closed(superseded)`。管理页是多窗口面：两个窗口可以打开同一个工作区各自点「启动」。
 * 旧实现每次都真的重连，于是第二个窗口启动会换掉第一个窗口的连接 —— 第一个窗口被判「已终止」
 * 回 idle，之后它点「停止」也不再发 `adminStreamStop`（已不在观看态），owner 引用计数永不归零，
 * 最后一个窗口停止时流不停。
 *
 * 现在的语义：
 *
 * - `streamStart` 发现该工作区**已有健康观看连接**（绑定上的 `viewerActive`）时**复用**：返回
 *   当前状态、不重连、不产生 `superseded`；这次启动只表示多一个观看者（owner +1 在 ipc 层）。
 * - 连接真的断了（`closed` / `error` 事件 / 显式停止）才清掉 `viewerActive`，下次启动重新
 *   `startStream`。
 * - 本端**内部收尸**（绑定失效后重建前的旧连接、代次竞态里的自停）补发的
 *   `closed(client-stopped)` 只更新本端状态、**不转发**（`quietStreamStops`）：它不是用户动作，
 *   广播出去会把别的窗口误判成「串流被关闭」。
 * - owner 账本在 ipc 层（`streamOwners.ts`）：`start` +1、`stop` / 窗口销毁 / 渲染层收到
 *   `closed`/`error` 后的「仅释放 owner」请求 -1，**归零才停流**。
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
  PsbWorkspaceState,
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
   * 保证该工作区桌面访问到 `running`（CINDY-RW-17，启动串流的**必经路径**）。
   *
   * 生产 = `PsbRemoteService.ensureWorkspaceAccess`（网页同款状态机：读 access → 终态才
   * POST start → 轮询到 running，预算 90s）。失败收敛成可归因结果而非异常：
   * `not-occupied`（403，等用户确认占用）/ `occupied-by-other`（409）/ `timeout` / `failed`
   * 由本服务带码抛出；只有 `unsupported`（旧 PSB 没有该路由）退回直接订阅。
   *
   * 可选端口仅为兼容旧装配 / 单测 fake：没有它时按旧路径直接订阅（并记一条 info）。
   */
  ensureWorkspaceAccess?(workspaceId: string): Promise<PsbWorkspaceAccessEnsureOutcome>;
  /**
   * 创建工作区会话。**只有过渡兜底**（新端点不可用的旧 PSB）会调用，且必须传
   * `purpose: 'internal'`（见文件头）。
   */
  createSession(input: PsbCreateSessionRequest): Promise<PsbCreateSessionResult>;
  /**
   * **结束**一条 PSB 会话（`DELETE …/sessions/:id`）。管理页只用它给过渡回退创建的内部
   * Agent 会话收尸（旧实现建了就不管，PSB 升级后那些会话永远留着）。
   *
   * 可选端口：旧装配 / 单测 fake 没有它时跳过（best-effort，失败只记日志）。
   */
  stopSession?(sessionId: string): Promise<void>;
  getStreamStatus(sessionId: string): Promise<PsbSessionStreamStatus>;
  startStream(sessionId: string): Promise<PsbSessionStreamStatus>;
  stopStream(sessionId: string): Promise<void>;
  /**
   * 写操作前的占用闸门（`streamStart` 用）：失败抛 `PSB_*` 失败码（被他人占用带人名），
   * 成功即保证工作区由当前身份锁定。
   *
   * **空闲时不会自动占用**（2026-11-27 用户复测口径）：缺省返回
   * `PSB_WORKSPACE_NOT_OCCUPIED`，渲染层弹确认框、用户确认后走显式占用再重试
   * `streamStart`。只有显式用户动作的调用点才可传 `allowAutoOccupy: true`。
   */
  ensureWorkspaceLocked(
    workspaceId: string,
    options?: { allowAutoOccupy?: boolean },
  ): Promise<void>;
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
  /** 可注入时钟（单测用固定时钟验证 TTL / 时间戳；缺省 `Date.now`）。 */
  now?(): number;
}

/** 启动 / 停止 / 状态读数的可选入参：发起动作的窗口任务 id（多窗口推送分桶用）。 */
export interface PsbAdminActionInput {
  /** 发起这次动作的窗口当前打开的任务；只用于刷新该窗口的上下文桶。 */
  readonly localSessionId?: string | null;
}

export interface PsbWorkspaceAdminService {
  context(input: { localSessionId?: string | null }): Promise<PsbWorkspaceAdminContextResult>;
  streamStart(
    workspaceId: string,
    input?: PsbAdminActionInput,
  ): Promise<PsbWorkspaceAdminStreamStartResult>;
  streamStop(workspaceId: string, input?: PsbAdminActionInput): Promise<void>;
  /**
   * 读工作区级串流状态。
   *
   * **只用绑定里的会话 id** 发一次只读 HTTP `stream/status`：**不订阅、不创建 PSB 会话、不占用
   * 工作区**。没有绑定（用户还没点过「启动」）或 PSB 读不到时返回 `status: null`（不抛错，
   * `null` ≠ `capable:false`）。返回值带 `viewerSessionId`（加性；只来自内存绑定 / 本机记录）。
   */
  streamStatus(
    workspaceId: string,
    input?: PsbAdminActionInput,
  ): Promise<PsbWorkspaceAdminStreamStatusResult>;
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
  /**
   * 本端**是否有一条健康观看连接**（`remote().startStream` 成功、此后没有 `closed` / `error`）。
   *
   * 为什么需要它（2026-11-27 复审 P1「多窗口误杀」）：`streamViewer.start` 的语义是
   * **原子替换**旧连接并补发 `closed(superseded)`。多窗口共用同一条进程内观看端，第二个窗口
   * 点「启动」若直接再调 `startStream`，第一个窗口就会收到 superseded 而回 idle、并且再也不会
   * 发 `adminStreamStop`（它已不在观看态）—— owner 引用计数泄漏，最后一个窗口停止时流不停。
   * 所以启动路径先看这个标记：**有健康连接就复用**（不重连、不产生 superseded），只把 owner
   * 计数加一；连接真的断了（`closed` / `error` 事件）才重新 `startStream`。
   *
   * 语义边界：它只表示「那一条观看连接还在」，不是 PSB 的 `active`（有没有画面仍以
   * `status.active` 为准，见文件头）。
   */
  viewerActive: boolean;
}

/** 工作区实时解析结果（PSB 行可用）。 */
interface ResolvedWorkspaceLive {
  readonly kind: 'live';
  readonly workspace: PsbRemoteWorkspace;
  readonly source: PsbWorkspaceAdminContextSource;
  /** 解析时 PSB 给的可读失败原因（只在兜底到缓存时用于解释）。 */
  readonly failureMessageZh: string | null;
  /**
   * 是不是按目录名 / title **启发式**匹配出来的（不是会话详情 / 已知 id 的权威结果）。
   *
   * 启发式结果只用于这次展示：不写「最近使用」与固定信息快照（见文件头）。
   */
  readonly inferred: boolean;
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
  readonly directoryName: string | null;
  /** PSB 工作区状态词；未知 / 旧 PSB 没给时 `null`（不再伪装成某个词）。 */
  readonly state: PsbWorkspaceState | null;
  /** 固定信息快照的落盘时间（ISO）；会话行种子没有快照，为 `null`。 */
  readonly snapshotSavedAt: string | null;
  readonly workspaceIdKnown: boolean;
  readonly failureMessageZh: string | null;
  /** 这次降级解析背后 PSB 给的失败形状（码 + 原文），写操作闸门据此给专用失败码。 */
  readonly failure: PsbRemoteFailure | null;
}

type ResolvedWorkspace = ResolvedWorkspaceLive | ResolvedWorkspaceStale;

type WorkspaceLookup =
  | { readonly kind: 'found'; readonly workspace: PsbRemoteWorkspace }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly failure: PsbRemoteFailure };

/** 管理页在内存里记住的「这个工作区上次解析结果」，给写操作闸门用。 */
interface KnownWorkspaceState {
  readonly availability: 'live' | 'unavailable' | 'missing';
  readonly staleReason: PsbWorkspaceAdminStaleReason | null;
  readonly workspaceIdKnown: boolean;
  /** PSB 的失败形状（没读到时为 `null`）：写闸门的失败码 / 原文都从这里来。 */
  readonly failure: PsbRemoteFailure | null;
  /** 这次结论是什么时候得出的（`now()` 毫秒）。过旧时 `streamStart` 会重新解析一次。 */
  readonly checkedAt: number;
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

/**
 * 一个 `localSessionId` 的推送桶。
 *
 * 多窗口各自打开不同任务时，各桶的上下文完全不同；推送基线必须按桶保存，否则 A/B 交替读取
 * 会互相把对方的值当成「上一次」。`lastWorkspaceId` 只用于「按工作区刷新」时找到该刷哪些桶。
 */
interface ContextBucket {
  readonly key: string;
  readonly localSessionId: string | null;
  /** 最近一次发出的上下文序列化值；`undefined` = 还没建立基线（首次只记不发）。 */
  lastEmitted: string | undefined;
  /** 最近一次解析到的真实工作区 id（占位身份 / 空上下文为 `null`）。 */
  lastWorkspaceId: string | null;
}

/** 过渡回退创建的内部 Agent 会话（用于回滚 / TTL 清理）。 */
interface FallbackSessionRecord {
  readonly workspaceId: string;
  readonly createdAt: number;
}

/** 触发上下文重读的目标（显式传，不再读全局「最近 id」）。 */
interface AdminRefreshTarget {
  /** 发起这次动作的窗口任务（只刷新它自己的桶）。 */
  readonly localSessionId?: string | null;
  /** 刷新所有「上次解析到这个工作区」的桶。 */
  readonly workspaceId?: string | null;
}

/** 缓存上限：工作区级别的内存表也要有界（见工程约定 §8.4）。 */
const WORKSPACE_CACHE_LIMIT = 16;

/** 多窗口推送桶的上限（同时打开的不同任务上下文；超过淘汰最久没读的）。 */
const CONTEXT_BUCKET_LIMIT = 8;

/** 过渡回退内部会话的容量上限（同一进程不会同时给很多工作区做回退）。 */
const FALLBACK_SESSION_LIMIT = 8;

/** 写操作闸门对「工作区能不能写」的信任窗口：过旧就先重新解析，而不是拿旧结论永久拦。 */
const WORKSPACE_STATE_TRUST_MS = 15_000;


/** 过渡回退内部会话的兜底存活上限（仍被绑定引用时，超过它也会被清理）。 */
const FALLBACK_SESSION_TTL_MS = 30 * 60_000;

/** 无任务线索的兜底桶 key（与正常 localSessionId 不可能撞）。 */
const NULL_CONTEXT_BUCKET_KEY = '\u0000no-local-session';

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

/** 这个工作区状态是否允许写操作（PSB 事实 + 真 id）。 */
function workspaceStateIsWritable(state: KnownWorkspaceState): boolean {
  return state.availability === 'live' && state.workspaceIdKnown;
}

/**
 * stale / 占位身份下写操作的可行动失败（`streamStart` 的闸门）。
 *
 * 三种状态给三条**不同的码**（渲染层按码选 i18n 文案，见 `PSB_IPC_FAILURE_MESSAGE_KEYS`）：
 *   - 占位身份（`workspaceIdKnown:false`）：`WORKSPACE_ID_UNKNOWN` —— 本机只有历史线索，
 *     重试也没用，要重新打开一个远程工作区任务；
 *   - 工作区已不可见：`WORKSPACE_MISSING` —— 换工作区 / 找管理员；
 *   - 读不到 PSB：`WORKSPACE_UNREACHABLE` —— 查网络后重试。
 * `message` 只放 PSB 原文（`null` = 没有），**不再自写中文兜底**。
 */
function staleWorkspaceActionFailure(state: KnownWorkspaceState): PsbClientError {
  const detail = state.failure?.message?.trim() || null;
  if (!state.workspaceIdKnown) {
    return new PsbClientError(
      {
        code: 'WORKSPACE_ID_UNKNOWN',
        messageKey: 'remoteWorkspace.admin.staleUnknownWorkspaceAction',
        message: detail,
      },
      null,
    );
  }
  if (state.availability === 'missing') {
    return new PsbClientError(
      {
        code: 'WORKSPACE_MISSING',
        messageKey: 'remoteWorkspace.admin.staleMissingAction',
        message: detail,
      },
      null,
    );
  }
  return new PsbClientError(
    {
      code: 'WORKSPACE_UNREACHABLE',
      messageKey: 'remoteWorkspace.admin.staleUnavailableAction',
      message: detail,
    },
    null,
  );
}

export function createPsbWorkspaceAdminService(
  deps: PsbWorkspaceAdminServiceDeps,
): PsbWorkspaceAdminService {
  const clock = deps.now ?? (() => Date.now());

  /** 工作区 id → 观看端绑定。 */
  const bindings = new Map<string, ViewerBinding>();
  /** 工作区 id → 进行中的「拿到可用绑定」（并发 start 共享一次订阅 / 过渡回退创建）。 */
  const ensureInFlight = new Map<string, Promise<ViewerBinding>>();
  /** 工作区 id → 最近一次解析出的可信度（写操作闸门用：stale / 占位身份时直接给可行动失败）。 */
  const lastWorkspaceState = new Map<string, KnownWorkspaceState>();
  /** 工作区 id → 最近一次读到的工作区行 + 它是不是目录 / title 启发式的猜测（不落盘）。 */
  const lastWorkspaceRowById = new Map<
    string,
    { readonly row: PsbRemoteWorkspace; readonly inferred: boolean }
  >();
  /** 工作区 id → 最近一次串流状态（来自显式读数或串流事件）。 */
  const lastStatusByWorkspace = new Map<string, PsbWorkspaceAdminStreamStatus>();
  /** localSessionId 分桶的推送基线（多窗口，见文件头）。 */
  const contextBuckets = new Map<string, ContextBucket>();
  /** 过渡回退创建的内部 Agent 会话（用于回滚 / TTL 清理，见文件头）。 */
  const fallbackSessions = new Map<string, FallbackSessionRecord>();
  /** 按工作区的串行队列尾部：start / stop 同一工作区不并发。 */
  const workspaceOperationTail = new Map<string, Promise<void>>();
  /** 按工作区的操作代次：`streamStop` 入队前 +1；`streamStart` 落定后发现它变了就自停。 */
  const workspaceGeneration = new Map<string, number>();
  /** 已经被「代次变化」自动停掉的代次（排队的 stop 看到它就不重复停一次）。 */
  const selfStoppedGeneration = new Map<string, number>();

  let currentRemote: PsbAdminRemotePort | null = null;
  let unsubscribeStream: (() => void) | null = null;
  /** 待重读的桶：key → 该桶的 localSessionId（合并窗口，见工程约定 §8.6）。 */
  const refreshPending = new Map<string, string | null>();
  let refreshInFlight: Promise<void> | null = null;

  function remote(): PsbAdminRemotePort {
    const next = deps.resolveRemote();
    if (next !== currentRemote) {
      // 账号边界换了服务实例：旧绑定与旧订阅全部失效（旧实例的 socket 已随 dispose 断开）。
      // 首次装配（currentRemote === null）不能走清理：那时可能已经有排队中的动作，
      // 清掉按工作区的串行队列会让同一工作区的 start / stop 失去互斥。
      if (currentRemote !== null) resetState();
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
    contextBuckets.clear();
    fallbackSessions.clear();
    workspaceOperationTail.clear();
    workspaceGeneration.clear();
    selfStoppedGeneration.clear();
    refreshPending.clear();
    refreshInFlight = null;
  }

  /* ------------------------------ 推送桶 ------------------------------ */

  function bucketKeyFor(localSessionId: string | null): string {
    return localSessionId ?? NULL_CONTEXT_BUCKET_KEY;
  }

  /** 取（或建）一个 localSessionId 的推送桶；访问顺序即 LRU。 */
  function contextBucketFor(localSessionId: string | null): ContextBucket {
    const key = bucketKeyFor(localSessionId);
    const existing = contextBuckets.get(key);
    if (existing) {
      contextBuckets.delete(key);
      contextBuckets.set(key, existing);
      return existing;
    }
    const bucket: ContextBucket = {
      key,
      localSessionId,
      lastEmitted: undefined,
      lastWorkspaceId: null,
    };
    rememberBounded(contextBuckets, key, bucket, CONTEXT_BUCKET_LIMIT);
    return bucket;
  }

  /**
   * 值没变不发推送；第一次只建立基线（invoke 的返回值本身就是这一次的事实）。
   *
   * 基线与去重**按 localSessionId 分桶**：不同窗口各自有一份「上次发出的上下文」，
   * 载荷里的 `localSessionId` 必须与桶一致（渲染层按它过滤）。
   *
   * **无任务线索的兜底桶（`localSessionId = null`）只更新基线、不推送**（2026-11-27 审查 s2 P1）：
   * `CONTEXT_CHANGED` 是广播面，一个「没有任务」的上下文推到所有窗口后，有任务窗口会把它当成
   * 「当前任务的工作区变了」而覆盖自己的页面状态。没有任务线索的调用方本来就有 invoke 的
   * 返回值（`context()` / `streamStart()` / `streamStatus()` 都返回上下文），不需要推送。
   */
  function emitIfChanged(
    context: PsbWorkspaceAdminContext | null,
    localSessionId: string | null,
    resolvedWorkspaceId: string | null,
  ): void {
    const bucket = contextBucketFor(localSessionId);
    bucket.lastWorkspaceId = resolvedWorkspaceId;
    const serialized = JSON.stringify(context);
    const previous = bucket.lastEmitted;
    bucket.lastEmitted = serialized;
    if (previous === undefined || previous === serialized) return;
    if (bucket.localSessionId === null) {
      // 兜底桶不推送：见上面的方法注释（只保留基线，避免跨窗口覆盖）。
      return;
    }
    deps.emitContextChanged({ context, localSessionId: bucket.localSessionId });
  }

  /** 这次刷新要重读哪些桶（显式目标，不读全局最近 id）。 */
  function collectRefreshBuckets(target: AdminRefreshTarget): ContextBucket[] {
    const keys = new Set<string>();
    if (target.localSessionId !== undefined) {
      const localSessionId = normalizedId(target.localSessionId);
      const key = bucketKeyFor(localSessionId);
      if (contextBuckets.has(key)) keys.add(key);
    }
    const workspaceId = normalizedId(target.workspaceId ?? null);
    if (workspaceId) {
      for (const bucket of contextBuckets.values()) {
        if (bucket.lastWorkspaceId === workspaceId) keys.add(bucket.key);
      }
    }
    const buckets: ContextBucket[] = [];
    for (const key of keys) {
      const bucket = contextBuckets.get(key);
      if (bucket) buckets.push(bucket);
    }
    return buckets;
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
    forgetBinding(workspaceId);
    lastStatusByWorkspace.delete(workspaceId);
    lastWorkspaceRowById.delete(workspaceId);
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
      return { kind: 'failed', failure };
    }
  }

  /** 把一次实时工作区行记成固定信息快照（值不变 0 次写；读路径唯一的落盘点）。 */
  function rememberSnapshotFor(workspace: PsbRemoteWorkspace): void {
    deps.store.rememberWorkspaceSnapshot({
      workspaceId: workspace.id,
      title: workspace.title,
      templateTitle: workspace.templateTitle,
      clientName: workspace.clientName,
      directoryName: workspace.directoryName,
    });
  }

  /** 记录一次写操作闸门用的工作区状态（`checkedAt` 用注入时钟）。 */
  function setWorkspaceState(
    workspaceId: string,
    state: Omit<KnownWorkspaceState, 'checkedAt'>,
  ): void {
    lastWorkspaceState.set(workspaceId, { ...state, checkedAt: clock() });
  }

  /**
   * 实时解析成功：刷新内存行、固定信息快照与「写操作可信度」表。
   *
   * @param options.persist 是否落盘快照 / 最近使用（**目录 / title 启发式命中时传 `false`**）。
   * @param options.inferred 这次结果来自启发式匹配（只留内存，日志记 inferred）。
   */
  function liveResolved(
    workspace: PsbRemoteWorkspace,
    source: PsbWorkspaceAdminContextSource,
    options: {
      readonly persist?: boolean;
      readonly inferred?: boolean;
      readonly failureMessageZh?: string | null;
    } = {},
  ): ResolvedWorkspaceLive {
    const inferred = options.inferred === true;
    rememberBounded(lastWorkspaceRowById, workspace.id, { row: workspace, inferred });
    if (options.persist !== false) rememberSnapshotFor(workspace);
    setWorkspaceState(workspace.id, {
      availability: 'live',
      staleReason: null,
      workspaceIdKnown: true,
      failure: null,
    });
    if (inferred) {
      deps.log.info(
        'psb admin: matched a workspace by directory/title heuristic; keeping it in memory only',
        { workspaceId: workspace.id, inferred: true },
      );
    }
    return {
      kind: 'live',
      workspace,
      source,
      failureMessageZh: options.failureMessageZh ?? null,
      inferred,
    };
  }

  /** 记录 stale 解析结果（写操作闸门据此直接拒绝，不再打一次注定失败的 PSB 写请求）。 */
  function noteStaleState(resolved: Omit<ResolvedWorkspaceStale, 'kind'>): ResolvedWorkspaceStale {
    setWorkspaceState(resolved.workspaceId, {
      availability: resolved.availability,
      staleReason: resolved.staleReason,
      workspaceIdKnown: resolved.workspaceIdKnown,
      failure: resolved.failure,
    });
    return { kind: 'stale', ...resolved };
  }

  /** 用固定信息快照构造 stale 解析结果。 */
  function staleFromSnapshot(
    snapshot: PsbAdminWorkspaceSnapshot,
    source: PsbWorkspaceAdminContextSource,
    availability: 'unavailable' | 'missing',
    staleReason: PsbWorkspaceAdminStaleReason,
    failure: PsbRemoteFailure | null,
  ): ResolvedWorkspaceStale {
    return noteStaleState({
      workspaceId: snapshot.workspaceId,
      source,
      availability,
      staleReason,
      title: snapshot.title,
      templateTitle: snapshot.templateTitle,
      clientName: snapshot.clientName,
      directoryName: snapshot.directoryName,
      state: null,
      snapshotSavedAt: snapshot.savedAt,
      workspaceIdKnown: true,
      failureMessageZh: failure?.message ?? null,
      failure,
    });
  }

  /**
   * PSB 读不到、但内存里还有上一次实时行（比快照新或快照写失败时）：
   * 固定信息仍可信，标成 stale 展示。
   */
  function staleFromCachedRow(
    row: PsbRemoteWorkspace,
    source: PsbWorkspaceAdminContextSource,
    failure: PsbRemoteFailure | null,
  ): ResolvedWorkspaceStale {
    return noteStaleState({
      workspaceId: row.id,
      source,
      availability: 'unavailable',
      staleReason: 'list-failed',
      title: row.title,
      templateTitle: row.templateTitle?.trim() || null,
      clientName: row.clientName,
      directoryName: row.directoryName ?? null,
      state: row.state,
      snapshotSavedAt: null,
      workspaceIdKnown: true,
      failureMessageZh: failure?.message ?? null,
      failure,
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
   * 占位身份（`workspaceIdKnown: false`）用**专门的 `staleReason: 'unknown-workspace'`**：
   * 它不是「PSB 读不到」的一种原因，而是「连工作区 id 都没有」这个身份事实；渲染层据此给
   * 「只能看到本机保存的信息，重新打开远程工作区任务再试」的文案。
   */
  function staleFromSessionHint(
    psbSessionId: string | null,
    hint: PsbAdminLocalSessionHint | null,
    failure: PsbRemoteFailure | null,
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
        'session-unreadable',
        failure,
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
      staleReason: 'unknown-workspace',
      title,
      templateTitle: null,
      clientName: '',
      directoryName,
      state: null,
      snapshotSavedAt: null,
      workspaceIdKnown: false,
      failureMessageZh: failure?.message ?? null,
      failure,
    });
  }

  /**
   * 历史会话的第二条实时兜底（2026-11-26 真机复验）：`workspaceId` 未知时，用会话行
   * `/psb-remote/<目录>` 的**目录名**去实时工作区列表匹配（`directoryName` / `title` /
   * `clientPath` basename 三种拼写相同即命中）。
   *
   * 真机里「会话详情 404、但工作区好好地在列表里」被误判成 stale；服务器通畅时必须走服务器：
   * 匹配到就返回实时行（`live`，页头名称 / 模板 / 机器 / 占用全部来自 PSB）。
   *
   * **这是启发式，结果不持久化**（见文件头）：命中只用于这一次展示；只有会话详情返回的
   * workspace id 才写 `会话→工作区` 映射。
   */
  type DirectoryWorkspaceMatch =
    | { readonly kind: 'found'; readonly workspace: PsbRemoteWorkspace }
    | { readonly kind: 'none' }
    | { readonly kind: 'failed'; readonly failure: PsbRemoteFailure };

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
      return { kind: 'failed', failure };
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
      // **权威映射**：会话详情读成功才把「这条 PSB 会话属于哪个工作区」落盘（启发式匹配不写）。
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
    readonly failure: PsbRemoteFailure | null;
  }

  /**
   * 按已知 workspaceId 解析：实时行 → （不可见 / 读不到时）固定信息快照 → 内存上一次行。
   * `resolved: null` 时调用方继续用其它兜底，不在这里直接清空页面。
   *
   * **无论有没有可展示的降级结果，闸门状态都会更新**：`streamStart` 过旧时靠这次重新解析
   * 决定「工作区恢复了没有」；只更新有快照的分支会让「快照丢失后工作区恢复了也点不动」。
   */
  async function resolveKnownWorkspaceId(
    workspaceId: string,
  ): Promise<KnownWorkspaceResolution> {
    const lookup = await lookupWorkspace(workspaceId);
    if (lookup.kind === 'found') {
      return {
        resolved: liveResolved(lookup.workspace, 'last-used'),
        listFailed: false,
        failure: null,
      };
    }
    if (lookup.kind === 'missing') {
      // 工作区已不可见（被删 / 无权限）：易变记录清掉，固定信息快照留着显示。
      forgetWorkspaceLocally(workspaceId);
      const snapshot = deps.store.workspaceSnapshot(workspaceId);
      if (snapshot) {
        return {
          resolved: staleFromSnapshot(snapshot, 'last-used', 'missing', 'workspace-missing', null),
          listFailed: false,
          failure: null,
        };
      }
      setWorkspaceState(workspaceId, {
        availability: 'missing',
        staleReason: 'workspace-missing',
        workspaceIdKnown: true,
        failure: null,
      });
      return { resolved: null, listFailed: false, failure: null };
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
          lookup.failure,
        ),
        listFailed: true,
        failure: lookup.failure,
      };
    }
    const cached = lastWorkspaceRowById.get(workspaceId)?.row;
    if (cached) {
      return {
        resolved: staleFromCachedRow(cached, 'last-used', lookup.failure),
        listFailed: true,
        failure: lookup.failure,
      };
    }
    setWorkspaceState(workspaceId, {
      availability: 'unavailable',
      staleReason: 'list-failed',
      workspaceIdKnown: true,
      failure: lookup.failure,
    });
    return { resolved: null, listFailed: true, failure: lookup.failure };
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
      knownListFailure: PsbRemoteFailure | null = null,
    ): Promise<ResolvedWorkspace | null> => {
      if (!directoryName) return null;
      if (knownListFailure) {
        return staleFromSessionHint(psbSessionId, sessionHint, knownListFailure);
      }
      const matched = await matchWorkspaceByDirectoryName(directoryName);
      if (matched.kind === 'found') {
        // 用实时行做 live 渲染（名称 / 模板 / 机器 / 占用都是 PSB 事实），但**是启发式命中**：
        // 只留内存、记 inferred，不写 `会话→工作区` 映射 / 快照（猜错会被持久化）。
        return liveResolved(matched.workspace, 'session', { persist: false, inferred: true });
      }
      // 列表读失败 / 确实匹配不到：降级种子，名称用目录名（不是任务标题）。
      return staleFromSessionHint(
        psbSessionId,
        sessionHint,
        matched.kind === 'failed' ? matched.failure : null,
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
          const seeded = await tryDirectoryMatch(mapped.failure);
          if (seeded) return seeded;
        }
      }
      const byDirectory = await tryDirectoryMatch();
      if (byDirectory) return byDirectory;
      const seeded = staleFromSessionHint(psbSessionId, sessionHint, null);
      if (seeded) return seeded;
    } else if (localSessionId) {
      // `remoteHostId` 丢了但工作目录还是 `/psb-remote/<目录>`：历史会话同样先按目录名
      // 实时匹配，匹配不到才给降级上下文。
      const byDirectory = await tryDirectoryMatch();
      if (byDirectory) return byDirectory;
      const seeded = staleFromSessionHint(null, sessionHint, null);
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

  /** 结束一条内部回退会话（best-effort；端口没有该方法 / 失败都只记 debug）。 */
  async function stopSessionQuietly(sessionId: string): Promise<void> {
    let port: PsbAdminRemotePort;
    try {
      port = remote();
    } catch (error) {
      deps.log.debug('psb admin: resolving the remote service while stopping a session failed', {
        viewerSessionId: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (typeof port.stopSession !== 'function') return;
    try {
      await port.stopSession(sessionId);
    } catch (error) {
      deps.log.debug('psb admin: stopping the fallback internal stream session failed', {
        viewerSessionId: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 记录一条回退内部会话（有界；超出上限时丢最旧的跟踪记录，不在此时发网络请求）。 */
  function trackFallbackSession(sessionId: string, workspaceId: string): void {
    rememberBounded(
      fallbackSessions,
      sessionId,
      { workspaceId, createdAt: clock() },
      FALLBACK_SESSION_LIMIT,
    );
  }

  /** 丢掉内存绑定与本机记录；若是回退内部会话，顺带 best-effort 结束它（fire-and-forget）。 */
  function forgetBinding(workspaceId: string): void {
    const binding = bindings.get(workspaceId);
    bindings.delete(workspaceId);
    deps.store.forgetDesktopSession(workspaceId);
    if (binding && fallbackSessions.delete(binding.sessionId)) {
      deps.log.info(
        'psb admin: dropping a fallback internal stream session that is no longer usable',
        { workspaceId, viewerSessionId: binding.sessionId },
      );
      void stopSessionQuietly(binding.sessionId);
    }
  }

  /**
   * 起观看端失败后回滚回退内部会话（await 版：失败路径要真的把它结束掉再抛原错误）。
   *
   * 只处理本进程 `trackFallbackSession` 记录过的会话：上一进程遗留的内部会话没有可靠判据，
   * 不在这里猜（下一次工作区级订阅成功时的 TTL / 失效清理覆盖不到它，属已知边界）。
   */
  async function rollbackFallbackSession(workspaceId: string, sessionId: string): Promise<void> {
    if (!fallbackSessions.delete(sessionId)) return;
    if (bindings.get(workspaceId)?.sessionId === sessionId) {
      bindings.delete(workspaceId);
      deps.store.forgetDesktopSession(workspaceId);
    }
    deps.log.info(
      'psb admin: ending the fallback internal session after the stream failed to start',
      { workspaceId, viewerSessionId: sessionId },
    );
    await stopSessionQuietly(sessionId);
  }

  /**
   * 工作区级订阅成功 = 服务端已支持新端点：清掉本进程遗留的旧回退内部会话。
   *
   * 清理条件（见文件头）：不再被任何内存绑定引用（失效）→ 立即清；仍被引用 → 等 TTL。
   * 全部 best-effort、不阻塞当前启动。
   */
  function cleanupFallbackSessionsAfterSubscribe(): void {
    if (fallbackSessions.size === 0) return;
    const boundSessionIds = new Set<string>();
    for (const binding of bindings.values()) boundSessionIds.add(binding.sessionId);
    const stale: Array<{ sessionId: string; record: FallbackSessionRecord }> = [];
    for (const [sessionId, record] of fallbackSessions) {
      if (boundSessionIds.has(sessionId) && clock() - record.createdAt < FALLBACK_SESSION_TTL_MS) {
        continue;
      }
      stale.push({ sessionId, record });
    }
    if (stale.length === 0) return;
    for (const entry of stale) fallbackSessions.delete(entry.sessionId);
    void (async () => {
      for (const entry of stale) {
        deps.log.info('psb admin: ending an obsolete fallback internal stream session', {
          workspaceId: entry.record.workspaceId,
          viewerSessionId: entry.sessionId,
        });
        await stopSessionQuietly(entry.sessionId);
      }
    })();
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
            // 只是「有一条绑定 id」，本端还没有订阅（例如重启后从本机记录复用的读口）。
            viewerActive: false,
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

  /* --------------------- 启动访问：网页同款状态机（必经路径） --------------------- */

  /**
   * 确保桌面访问到 `running`（CINDY-RW-17）。**启动串流的必经路径**，失败带码抛出。
   *
   * 返回 `'unsupported'` = 旧 PSB 没有这条路由（404/405/`UNIMPLEMENTED`）：调用方退回直接
   * 订阅，由订阅的 409 给可行动文案；其余结果只可能来自「失败」路径（抛出）。
   *
   * 端口协议是「不抛异常、收敛成可行动结果」；这里再兜一层：端口万一违约抛了错，也按
   * `PSB_UNREACHABLE` 之类的可归因形状往上抛，而不是吞掉（吞掉会让启动串流在访问没起来时
   * 继续去订阅，回到旧 bug）。
   */
  async function ensureWorkspaceAccessOrThrow(
    workspaceId: string,
  ): Promise<'ready' | 'unsupported'> {
    const port = remote();
    if (typeof port.ensureWorkspaceAccess !== 'function') {
      // 旧装配 / 旧 fake：没有这个端口就按旧路径直接订阅（生产装配一定有它）。
      deps.log.info('psb admin: the remote port has no workspace access ensure; subscribing directly', {
        workspaceId,
      });
      return 'ready';
    }
    let outcome: PsbWorkspaceAccessEnsureOutcome;
    try {
      outcome = await port.ensureWorkspaceAccess(workspaceId);
    } catch (error) {
      const failure = toPsbRemoteFailure(error);
      deps.log.warn('psb admin: workspace access ensure threw', {
        workspaceId,
        code: failure.code,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (outcome.ok) {
      deps.log.info('psb admin: workspace access is running before subscribing', {
        workspaceId,
        startedByThisCall: outcome.startedByThisCall,
      });
      return 'ready';
    }
    if (outcome.reason === 'unsupported') {
      deps.log.info('psb admin: workspace access ensure is unavailable on this PSB; subscribing directly', {
        workspaceId,
      });
      return 'unsupported';
    }
    deps.log.info('psb admin: workspace access ensure failed; refusing to subscribe', {
      workspaceId,
      reason: outcome.reason,
      code: outcome.failure?.code ?? null,
    });
    throw new PsbClientError(
      outcome.failure ?? {
        code: 'PSB_UNKNOWN',
        messageKey: 'remoteWorkspace.error.unknown',
        message: null,
      },
      null,
    );
  }
  /**
   * 建立观看绑定：优先工作区级服务接口；**只有端点不可用**（旧 PSB）才过渡回退。
   *
   * 正常路径**不创建任何 Agent 会话**：`subscribeWorkspaceStream` 只解析当前 running 的桌面
   * 访问会话。回退路径必须带 `purpose:'internal'`（见文件头），新端点可用时永不执行。
   * **订阅前已经由 `startStreamLocked` 确保访问 running**（CINDY-RW-17 必经路径）：
   * 这里的 409 只可能是竞态（访问刚被回收），语义仍是可行动的
   * `PSB_STREAM_NO_RUNNING_SESSION` + `state`，原样上抛给渲染层。
   */
  async function acquireBinding(workspaceId: string): Promise<ViewerBinding> {
    let sessionId: string;
    let viaInternalFallback = false;
    try {
      const subscription = await remote().subscribeWorkspaceStream(workspaceId);
      sessionId = subscription.sessionId;
      // 新端点可用：本进程遗留的旧回退内部会话该收了（TTL / 失效，见文件头）。
      cleanupFallbackSessionsAfterSubscribe();
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
      // 记录回退会话：起观看端失败时要回滚；PSB 升级后要按 TTL / 失效清理。
      trackFallbackSession(sessionId, workspaceId);
    }

    const binding: ViewerBinding = {
      workspaceId,
      sessionId,
      status: null,
      viewerActive: false,
    };
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

  /**
   * 本端内部收尸（重建前的旧连接 / 代次竞态的自停）正在停的会话。
   *
   * 为什么需要：`streamViewer.stop` 会补发 `closed(client-stopped)`，那是**给用户点停止**用的
   * 状态收敛事件。内部收尸不是用户的动作：它的 `closed` 既不该广播给别的窗口（会把正在看的
   * 窗口误判成「被关闭」并回 idle），也不该在启动路径里被当成「本轮失败」。停的时候按下标记，
   * `handleStreamEvent` 据此不转发这条事件；其余状态（绑定 / `active:false`）照常更新。
   * 生产里 `remote().stopStream` → viewer.stop 的事件是**同步** emit 的，所以标记覆盖整个 await。
   */
  const quietStreamStops = new Set<string>();

  async function stopStreamQuietly(sessionId: string): Promise<void> {
    quietStreamStops.add(sessionId);
    try {
      await remote().stopStream(sessionId);
    } catch {
      /* best-effort：重建前的旧连接收尸，失败也不该挡住新连接 / 停止请求 */
    } finally {
      quietStreamStops.delete(sessionId);
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
   *
   * 过渡回退创建的内部会话若起观看端失败，**回滚它**（best-effort `stopSession`）：旧实现
   * 建了会话就留在 PSB 里，用户会看到一条自己没有发起过的任务。
   */
  async function startStreamWithRecovery(workspaceId: string): Promise<{
    binding: ViewerBinding;
    status: PsbSessionStreamStatus;
  }> {
    const binding = await ensureBinding(workspaceId);
    try {
      const status = await remote().startStream(binding.sessionId);
      binding.viewerActive = true;
      return { binding, status };
    } catch (error) {
      if (!isStaleStreamSessionFailure(error)) {
        await rollbackFallbackSession(workspaceId, binding.sessionId);
        throw error;
      }
      const failure = toPsbRemoteFailure(error);
      deps.log.warn('psb admin: the bound viewer session is no longer usable; resubscribing once', {
        workspaceId,
        viewerSessionId: binding.sessionId,
        code: failure.code,
      });
      binding.viewerActive = false;
      await stopStreamQuietly(binding.sessionId);
      forgetBinding(workspaceId);
      const rebuilt = await ensureBinding(workspaceId);
      try {
        const retryStatus = await remote().startStream(rebuilt.sessionId);
        rebuilt.viewerActive = true;
        return { binding: rebuilt, status: retryStatus };
      } catch (retryError) {
        await rollbackFallbackSession(workspaceId, rebuilt.sessionId);
        throw retryError;
      }
    }
  }

  /* ------------------------------ 串流启停（串行 + 代次） ------------------------------ */

  function currentGeneration(workspaceId: string): number {
    return workspaceGeneration.get(workspaceId) ?? 0;
  }

  /** 同一工作区的 start / stop 串行执行；上一个任务失败不阻塞下一个。 */
  function runWorkspaceOperation<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
    const previous = workspaceOperationTail.get(workspaceId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    workspaceOperationTail.set(workspaceId, tail);
    void tail.finally(() => {
      if (workspaceOperationTail.get(workspaceId) === tail) workspaceOperationTail.delete(workspaceId);
    });
    return run;
  }

  /**
   * 把 PSB **工作区级**写路径的失败吸收进「工作区能不能写」的闸门。
   *
   * 关键点（2026-11-26 审查）：**刚被 PSB 告知工作区不存在，不能还标成 live**。否则用户点第二次
   * 「启动」时闸门认为一切正常，又去打一次注定 404 的占用请求，还拿不到「工作区已不可见」这种
   * 可行动原因。只吸收明确指向工作区身份 / 可达性的失败；占用冲突 / 未就绪 / 客户端离线不是
   * 「工作区不可见」，不改闸门。
   *
   * 调用点只有**工作区级**动作（`ensureWorkspaceLocked`）。观看会话级失败（`streamStart`
   * 里带会话 id 的调用）**不得**走这里（2026-11-27 审查 s2 P1：会话 404 曾被误吸收成工作区
   * 不可见，把下一次「启动」永久挡住）。
   */
  function absorbWriteFailure(workspaceId: string, error: unknown): void {
    const failure = toPsbRemoteFailure(error);
    if (failure.code === 'NOT_FOUND' || failure.code === 'FORBIDDEN') {
      setWorkspaceState(workspaceId, {
        availability: 'missing',
        staleReason: 'workspace-missing',
        workspaceIdKnown: true,
        failure,
      });
      forgetWorkspaceLocally(workspaceId);
      deps.log.info('psb admin: the workspace is no longer visible; re-resolve before next write', {
        workspaceId,
        code: failure.code,
      });
      return;
    }
    if (failure.code === 'PSB_UNREACHABLE') {
      setWorkspaceState(workspaceId, {
        availability: 'unavailable',
        staleReason: 'list-failed',
        workspaceIdKnown: true,
        failure,
      });
    }
  }

  async function startStreamLocked(
    workspaceId: string,
    localSessionId: string | null,
    generationAtEntry: number,
  ): Promise<PsbWorkspaceAdminStreamStartResult> {
    // 「这个工作区上次解析出来就是不可见 / 连不上」时**直接给可行动失败**，不再先打占用闸门：
    // 那条路只会得到一条 404 或 20s 网络超时，用户看到的是不可行动的错误。但结论必须够新：
    // 超过信任窗口就先重新解析一次（服务器恢复了，用户点「启动」就该能用）。
    const known = lastWorkspaceState.get(workspaceId);
    if (known && !workspaceStateIsWritable(known)) {
      if (clock() - known.checkedAt <= WORKSPACE_STATE_TRUST_MS) {
        deps.log.info('psb admin: refusing to start streaming for an unavailable workspace', {
          workspaceId,
          availability: known.availability,
          staleReason: known.staleReason,
        });
        throw staleWorkspaceActionFailure(known);
      }
      deps.log.info('psb admin: the cached workspace state is stale; re-resolving before starting', {
        workspaceId,
        availability: known.availability,
        ageMs: clock() - known.checkedAt,
      });
      const revalidated = await resolveKnownWorkspaceId(workspaceId);
      const current = lastWorkspaceState.get(workspaceId) ?? known;
      if (!revalidated.resolved || !workspaceStateIsWritable(current)) {
        throw staleWorkspaceActionFailure(current);
      }
    }

    // **多窗口复用已有健康连接**（2026-11-27 复审 P1「多窗口误杀」）：
    // 进程内只有一个观看端实例，`remote().startStream` 的语义是**原子替换**该会话的旧连接并
    // 补发 `closed(superseded)`。第二个窗口点「启动」若直接再调一次，第一个窗口的连接就被换掉：
    // 它收到 superseded 回 idle 后再也不会发 `adminStreamStop`（已不在观看态）→ owner 引用计数
    // 永远不归零 → 最后一个窗口停止时流不停。所以「已经有健康连接」时这一次启动只表示**多一个
    // 观看者**：返回当前状态，连接不动（owner +1 由 ipc 层在成功返回后登记）。
    const reusable = bindings.get(workspaceId);
    if (reusable?.viewerActive === true) {
      deps.log.debug('psb admin: reusing the healthy viewer connection for another window', {
        workspaceId,
        viewerSessionId: reusable.sessionId,
      });
      return {
        status: reusable.status ?? lastStatusByWorkspace.get(workspaceId) ?? psbAdminStreamStatusFallback(),
        workspaceId,
        viewerSessionId: reusable.sessionId,
      };
    }

    // 串流 = 工作区写操作（订阅当前桌面访问会话 / 过渡回退建内部会话）：PSB 会对未锁定者拒绝，
    // 所以先确认工作区由自己占用。**不自动占用**（2026-11-27 用户复测口径）：空闲时这里返回
    // `PSB_WORKSPACE_NOT_OCCUPIED`，渲染层弹确认框、用户确认后显式占用再重试本次启动；
    // 失败在这里就给出可行动原因，不建立订阅。读状态（`streamStatus`）不受此限。
    try {
      await remote().ensureWorkspaceLocked(workspaceId, { allowAutoOccupy: false });
    } catch (error) {
      absorbWriteFailure(workspaceId, error);
      throw error;
    }

    // 占用成功 = 又确认了一次工作区固定信息（名称 / 模板 / 机器不会变）：落盘快照，
    // 下次 PSB 读不到时页面还能显示。值不变 0 次写。
    const observed = lastWorkspaceRowById.get(workspaceId)?.row;
    if (observed) rememberSnapshotFor(observed);

    // **CINDY-RW-17 必经步骤**：确保桌面访问到 running（网页同款状态机；预算是 90s 级，
    // 期间界面显示「正在启动桌面访问…」）。失败带码抛出（未占用 / 被他人占用 / 超时 / 网络），
    // 不在访问没起来时继续订阅；只有旧 PSB（没有该路由）才退回直接订阅，由订阅的 409 给
    // 可行动文案。
    try {
      await ensureWorkspaceAccessOrThrow(workspaceId);
    } catch (error) {
      // 未占用 / 被他人占用是工作区级事实：与占用闸门同一套失败归因（但**不**吸收成
      // 「工作区不可见」——那两种码在 bsorbWriteFailure 里本来就不处理）。
      deps.log.info('psb admin: refusing to start streaming because the workspace access is not ready', {
        workspaceId,
        code: toPsbRemoteFailure(error).code,
        status: error instanceof PsbClientError ? error.status : null,
      });
      throw error;
    }

    let started: { binding: ViewerBinding; status: PsbSessionStreamStatus };
    try {
      started = await startStreamWithRecovery(workspaceId);
    } catch (error) {
      // **归因修正**（2026-11-27 审查 s2 P1）：走到这里时工作区已经在这一轮
      // `ensureWorkspaceLocked` 里被 PSB 确认「可见 / 就绪 / 由我锁定」，失败只可能来自
      // 观看会话本身（`stream/subscribe` 的会话、`startStream(<sessionId>)` 的会话），
      // 端点路径里带的是会话 id —— 这里出现的 `NOT_FOUND` 是**会话级**的，把它吸收成
      // 「工作区不可见」会让下一次点「启动」被错误的 stale 闸门永久挡住。工作区级失败
      // 仍由上面的 `ensureWorkspaceLocked` catch 吸收，不丢诊断。
      deps.log.info('psb admin: starting the viewer stream failed (session-scoped failure, not workspace-missing)', {
        workspaceId,
        code: toPsbRemoteFailure(error).code,
        status: error instanceof PsbClientError ? error.status : null,
      });
      throw error;
    }

    const binding = started.binding;
    const status = psbAdminStreamStatusFromPsb(started.status);
    const generationNow = currentGeneration(workspaceId);
    if (generationNow !== generationAtEntry) {
      // 用户在「启动」落定前已经点了「停止」：不能把刚起的串流留在远端（旧实现的竞态）。
      deps.log.info(
        'psb admin: a stop request superseded this stream start; stopping the new stream',
        { workspaceId, viewerSessionId: binding.sessionId },
      );
      await stopStreamQuietly(binding.sessionId);
      binding.viewerActive = false;
      selfStoppedGeneration.set(workspaceId, generationNow);
      binding.status = { ...status, active: false };
      rememberBounded(lastStatusByWorkspace, workspaceId, binding.status);
      await refreshContextNow({ workspaceId, localSessionId });
      return {
        status: binding.status,
        workspaceId,
        viewerSessionId: binding.sessionId,
      };
    }

    binding.status = status;
    rememberBounded(lastStatusByWorkspace, workspaceId, status);
    deps.store.rememberWorkspace(workspaceId);
    // 上下文可能随这次动作变化（绑定出现、桌面会话状态变了）：重读并发起动作的桶 + 同工作区桶。
    await refreshContextNow({ workspaceId, localSessionId });
    return {
      status,
      workspaceId,
      viewerSessionId: binding.sessionId,
    };
  }

  async function streamStart(
    workspaceId: string,
    input?: PsbAdminActionInput,
  ): Promise<PsbWorkspaceAdminStreamStartResult> {
    const id = normalizedId(workspaceId);
    if (!id) throw createIpcError('INVALID_PARAMS', 'workspaceId is required');
    const localSessionId = normalizedId(input?.localSessionId);
    const generationAtEntry = currentGeneration(id);
    // 代次在**入队时**取：若 stop 在排队期间推进了它，start 落定后会自停。
    return runWorkspaceOperation(id, () =>
      startStreamLocked(id, localSessionId, generationAtEntry),
    );
  }

  async function stopStreamLocked(
    workspaceId: string,
    localSessionId: string | null,
    generation: number,
  ): Promise<void> {
    // 启动落定时已经因为这次 stop 自动停过：不重复停一次（也不会多一次写上下文）。
    // 记录只对**产生它的那一次** stop 有效，入口已经清过不匹配的旧记录（见 `streamStop`）。
    if (selfStoppedGeneration.get(workspaceId) === generation) {
      selfStoppedGeneration.delete(workspaceId);
      return;
    }
    const binding = bindings.get(workspaceId);
    if (!binding) return;
    // 只停**观看**：绑定保留（下一次启动直接复用同一条桌面访问会话，不重复订阅）。
    await remote().stopStream(binding.sessionId);
    binding.viewerActive = false;
    const previous = binding.status ?? psbAdminStreamStatusFallback();
    binding.status = { ...previous, active: false };
    rememberBounded(lastStatusByWorkspace, workspaceId, binding.status);
    await refreshContextNow({ workspaceId, localSessionId });
  }

  async function streamStop(workspaceId: string, input?: PsbAdminActionInput): Promise<void> {
    const id = normalizedId(workspaceId);
    if (!id) return;
    const localSessionId = normalizedId(input?.localSessionId);
    // **入队前**推进代次：已经在路上的 start 落定后会发现自己被取代，从而自停。
    const generation = currentGeneration(id) + 1;
    workspaceGeneration.set(id, generation);
    // 上一轮「自停」记录只对产生它的那次 stop 有效：代次单调递增，未来任何一次 stop 的
    // generation 都不等于旧值，留着只会让这张表随工作区数量无界残留（2026-11-27 复审 P2）。
    if (selfStoppedGeneration.get(id) !== generation) selfStoppedGeneration.delete(id);
    await runWorkspaceOperation(id, () => stopStreamLocked(id, localSessionId, generation));
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
   *   2. 本机记录里的绑定 id（应用重启后的主路径，只读 HTTP，不占名额）。
   *
   * 两者都没有就返回 `status: null`（未知）—— 页面进入时不建立绑定，等用户显式「启动」。
   * `null` 仍**不等于** `capable:false`；返回值额外带 `viewerSessionId`（只来自内存绑定 /
   * 本机记录），让渲染层能过滤 `STREAM_EVENT` / 判断输入是否可发。
   */
  async function streamStatus(
    workspaceId: string,
    input?: PsbAdminActionInput,
  ): Promise<PsbWorkspaceAdminStreamStatusResult> {
    const id = normalizedId(workspaceId);
    if (!id) return { status: null, viewerSessionId: null };
    const localSessionId = normalizedId(input?.localSessionId);

    // 已知 stale（工作区不可见 / PSB 读不到）：别再拿一条可能已死的绑定去打一次网络。
    // 返回 `status: null`（无法获取）而不是 `capable:false`，页面在 stale 态下不乱判能力位。
    const known = lastWorkspaceState.get(id);
    if (known && !workspaceStateIsWritable(known)) {
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
        scheduleContextRefresh({ workspaceId: id, localSessionId });
      }
      binding.status = probe.status;
      return { status: probe.status, viewerSessionId: binding.sessionId };
    }

    if (probe.kind === 'dead') {
      // 绑定已经失效（桌面访问被重建 / 内部会话已结束）→ 丢掉内存绑定与本机记录（下次启动
      // 重新订阅），并刷新上下文让页面看到 `viewerSessionId` 变回 null。
      forgetBinding(id);
      scheduleContextRefresh({ workspaceId: id, localSessionId });
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
   *   - `lastErrorZh` 只放 PSB 原文做诊断，可读原因由 `availability` / `staleReason` 选本地化文案。
   */
  function buildStaleContext(
    resolved: ResolvedWorkspaceStale,
    failureMessageZh: string | null,
  ): PsbWorkspaceAdminContext {
    return {
      workspaceId: resolved.workspaceId,
      clientName: resolved.clientName,
      // 快照不再保存在线状态（易变）；stale 时**不**把它当事实。
      clientOnline: false,
      title: resolved.title,
      templateTitle: resolved.templateTitle?.trim() || null,
      directoryName: resolved.directoryName ?? '',
      state: resolved.state,
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

  async function context(input: {
    localSessionId?: string | null;
  }): Promise<PsbWorkspaceAdminContextResult> {
    // 入参固化到局部：全局「最近 id」正是多窗口串工作区的根因（见文件头）。
    const localSessionId = normalizedId(input.localSessionId);
    const resolved = await resolveWorkspace(localSessionId);
    if (!resolved) {
      emitIfChanged(null, localSessionId, null);
      return { context: null };
    }

    // stale：固定字段来自本机快照 / 会话行种子，状态字段未知。不再读绑定探针（PSB 本来就
    // 读不到，多打一次只会多等一次超时），也不推进「最近使用」——工作区事实不是这次读到的。
    if (resolved.kind === 'stale') {
      const built = buildStaleContext(resolved, resolved.failureMessageZh);
      emitIfChanged(
        built,
        localSessionId,
        resolved.workspaceIdKnown ? resolved.workspaceId : null,
      );
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
    // `liveResolved` 写入（值不变 0 次写）。启发式匹配不推进「最近使用」：猜错会让下次
    // 打开页面默认落到别人的工作区（见文件头）。
    if (!resolved.inferred) deps.store.rememberWorkspace(workspaceId);

    const built = buildLiveContext({
      workspace: resolved.workspace,
      source: resolved.source,
      binding,
      desktop,
      failureMessageZh,
    });
    emitIfChanged(built, localSessionId, workspaceId);
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
    // 本端内部收尸（重建旧连接 / 代次竞态自停）补发的 `closed(client-stopped)` 不是用户动作，
    // 也不该让别的窗口以为「自己正在看的串流被关闭」：只更新本端状态，不转发（见
    // `quietStreamStops`）。用户显式停止的那条 `closed` 走正常路径（此时没有内部标记）。
    const internallyStopped = event.type === 'closed' && quietStreamStops.has(event.sessionId);
    if (!internallyStopped) deps.emitStreamEvent(event);
    const workspaceId = binding.workspaceId;

    if (event.type === 'status') {
      const next = psbAdminStreamStatusFromPsb(event.status);
      binding.status = next;
      rememberBounded(lastStatusByWorkspace, workspaceId, next);
      // 桌面会话状态可能随之变化（例如 PSB 推送「采集已开始」）：重读该工作区的所有窗口桶。
      scheduleContextRefresh({ workspaceId });
      return;
    }

    if (event.type === 'closed') {
      // 连接已经结束（远端关闭 / 本端收尸）：下次「启动」必须真的重新订阅串流，不能复用标记。
      binding.viewerActive = false;
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
      scheduleContextRefresh({ workspaceId });
      return;
    }

    if (event.type === 'error') {
      // 错误断开后这条连接不再可用：下一次启动必须重新 `startStream`（不能复用）。
      binding.viewerActive = false;
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

  /**
   * 按显式目标重读上下文（不再读全局「最近 id」）。
   *
   * 目标是「发起这次动作的窗口桶 + 所有上次解析到该工作区的桶」：单窗口时两者通常是同一个；
   * 多窗口同时看同一工作区时每个窗口都能拿到新事实；只开了别的任务/工作区的窗口不受打扰。
   */
  async function refreshContextNow(target: AdminRefreshTarget = {}): Promise<void> {
    for (const bucket of collectRefreshBuckets(target)) {
      try {
        await context({ localSessionId: bucket.localSessionId });
      } catch (error) {
        deps.log.debug('psb admin: refreshing the page context failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * 串流事件驱动的刷新：**合并窗口内只重读一次**，读取在途时只记一笔待刷新。
   *
   * 不做合并的后果是每条 `status` 事件都触发一次 `listWorkspaces` + `stream/status`，
   * 而 PSB 的压力与回包字节都会随事件密度增长（工程约定 §8.6）。
   */
  function scheduleContextRefresh(target: AdminRefreshTarget): void {
    for (const bucket of collectRefreshBuckets(target)) {
      refreshPending.set(bucket.key, bucket.localSessionId);
    }
    if (refreshPending.size === 0 || refreshInFlight) return;
    refreshInFlight = (async () => {
      try {
        while (refreshPending.size > 0) {
          const batch = [...refreshPending];
          refreshPending.clear();
          for (const [, localSessionId] of batch) {
            try {
              await context({ localSessionId });
            } catch (error) {
              deps.log.debug('psb admin: refreshing the page context failed', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
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
