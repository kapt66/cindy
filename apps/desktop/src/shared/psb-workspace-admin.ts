/**
 * 「远程工作区」管理页（**工作区级**）的跨进程契约。
 *
 * ## 与 `psb-remote-workspace.ts` 的分工
 *
 * `psb-remote-workspace.ts` 描述的是**会话级**链路：「某个本地任务 ↔ 某条 PSB agent 会话」
 * （`psb:<sessionId>` 身份、隧道、发消息、串流观看端）。本文件描述的是**工作区级**页面：
 * 「此刻管理哪个 PSB 工作区」，以及它的**观看端绑定**（正常 = PSB 桌面访问会话 id）。
 *
 * ## 为什么要单独一层（不要把它并回会话级）
 *
 * PSB 的 agent 会话终态**不可逆**，而 Cindy 的「远程工作区」页签是 PSB 网页远程工作区的
 * 快捷访问：用户要看的是「打包机 · saga2_project 这台机器、这个目录、现在被谁占用」以及
 * 它的画面。这套内容**不依赖用户 Agent 任务是否存在、是否结束**：
 *
 *   - 当前打开的任务可能根本不是远程任务（本地任务 / SSH / MCPRouter）；
 *   - 当前任务的 PSB 会话可能已经终态，甚至 PSB 已经查不到它（404）；
 *   - 用户可能刚重启客户端，一个任务都还没打开。
 *
 * 所以页面围绕「一个工作区」工作：工作区从「当前打开任务的 PSB 会话（任何状态）」或
 * 「本机记录的最近使用过的远程工作区」解析；画面则走 PSB 的**工作区级服务接口**
 * `POST /api/cindy/remote/workspaces/:id/stream/subscribe`，拿它返回的**桌面访问会话** id
 * 订阅串流 —— **不创建任何 Agent 会话**（Agent 会话只装用户任务，PSB 0.1.172 框架规则）。
 * PSB 端点不可用的旧服务端才过渡回退到内部 Agent 会话（见 `PSB_ADMIN_INTERNAL_STREAM_SESSION_TITLE`）。
 * 用户任务结束不影响它，用户的 PSB 会话被拒也不影响它 —— 这是本层存在的全部理由。
 *
 * ## 边界
 *
 * 只放**形状与纯函数**：通道名、DTO、过渡回退会话的标识、PSB 串流状态到管理页状态的映射。
 * 不放实现（HTTP / WS / Electron）、不放文案（文案走 i18n 的 `remoteWorkspace.admin.*`）。
 */

import type { PsbSessionStreamStatus, PsbStreamEvent } from './psb-remote-workspace';

/* ============================== 1. IPC 通道 ============================== */

/**
 * renderer ↔ main 的管理页通道。
 *
 * 与 `PSB_REMOTE_CHANNELS` **分成两组常量**而不是继续往那张表里加：管理页是工作区级、
 * 有自己的失败与推送语义（见本文件头），合表会让「会话级通道」与「工作区级通道」在
 * wiring guard 里混成一团、以后也难收敛。命名沿用 `feature:sub:action`。
 */
export const PSB_ADMIN_CHANNELS = {
  /** 读当前工作区上下文（页面顶部信息条的唯一数据源）。 */
  CONTEXT: 'psb-remote:admin-context',
  /** main → renderer：当前工作区上下文变化（工作区 / 占用 / 桌面会话状态 / 观看端绑定）。 */
  CONTEXT_CHANGED: 'psb-remote:admin-context-changed',
  /**
   * 启动串流：main 先占用闸门，再走工作区级 `stream/subscribe` 拿桌面访问会话 id，然后启动
   * 观看端（后续帧经 `STREAM_EVENT` 推送）。**不创建 Agent 会话**（旧 PSB 才过渡回退）。
   */
  STREAM_START: 'psb-remote:admin-stream-start',
  /** 停止串流（观看端绑定**保留**，供下次复用）。 */
  STREAM_STOP: 'psb-remote:admin-stream-stop',
  /**
   * 读串流状态（工作区级读数；只用绑定里的会话 id 发一次只读 HTTP，
   * **不订阅、不创建会话、不占用工作区**）。
   */
  STREAM_STATUS: 'psb-remote:admin-stream-status',
  /**
   * main → renderer：串流事件（帧 / 状态 / 光标 / 关闭 / 错误）。
   * `sessionId` 是观看端绑定会话（正常 = 桌面访问会话 id，过渡回退 = 内部 Agent 会话 id）。
   */
  STREAM_EVENT: 'psb-remote:admin-stream-event',
  /**
   * 键鼠输入（renderer 采集 → main → 观看端绑定会话的 WS）。
   *
   * 入参是**工作区级**的 `{ workspaceId, event }`：渲染层不持有也不需要观看端会话 id
   * （那是 main 的事实，见 §11.3），由 main 按工作区解析出会话再转发。
   */
  STREAM_INPUT: 'psb-remote:admin-stream-input',
  /**
   * 「画面捕获态」开关（全屏 / 画面聚焦时通知 main 抑制宿主快捷键）。
   *
   * 它只改**发出 IPC 的那个窗口**：menu accelerator 忽略 + 宿主快捷键拦截；不碰别的窗口，
   * 也不改 PSB 侧任何状态。退出全屏 / 页面卸载 / 窗口失焦都必须发 `active:false`。
   */
  STREAM_CAPTURE: 'psb-remote:admin-stream-capture',
} as const;

export type PsbAdminChannel = keyof typeof PSB_ADMIN_CHANNELS;

/* ============================== 2. 当前工作区上下文 ============================== */

/** 占用视角（PSB 已按当前 Cindy 身份算好，Cindy 不再自己判谁占的）。 */
export interface PsbWorkspaceAdminOccupancy {
  readonly occupied: boolean;
  /** 占用人就是当前身份。 */
  readonly byMe: boolean;
  /** 占用人显示名（未占用时 `''`）。 */
  readonly personName: string;
}

/**
 * 该工作区的桌面会话状态（PSB 下发的三态 + `null` = 不知道）。
 *
 * `null` **不是** `none`：`none` 是 PSB 明确说「没有桌面会话」，`null` 是「这次没读到」
 * （还没有可借用的会话去问 PSB、或 PSB 暂时不可达）。把两者混起来会让界面把网络抖动
 * 显示成「没有桌面会话，请去 PSB 网页启动」。
 */
export type PsbWorkspaceAdminDesktopSession = 'none' | 'starting' | 'running' | null;

/**
 * 「当前工作区」是从哪解析出来的。
 *
 * - `'session'`：当前打开任务的 PSB 会话读成功（**任何状态**，含终态）；
 * - `'last-used'`：没有远程任务 / 不是远程任务 / 读会话失败 → 用本机记录的最近使用工作区。
 *
 * 读会话失败但用「本机会话→工作区映射」兜底解析出来的也算 `'last-used'`：工作区事实来自
 * 本机记录，不来自这条会话。界面据此可以说明「这是最近使用的工作区」。
 */
export type PsbWorkspaceAdminContextSource = 'session' | 'last-used';

/**
 * 固定信息的可信度（2026-11-26 真机事故后的加性语义）。
 *
 * - `live`：这一次从 PSB 读到了工作区行（`title` / 模板 / 机器 / 目录都是服务器事实）；
 * - `unavailable`：读不到 PSB（断网 / PSB 不可达 / 本机没有可用会话），固定信息来自本机快照
 *   或本机会话行种子；
 * - `missing`：PSB 工作区列表读成功了，但这个工作区已经不在列表里（被删 / 无权限）。
 *
 * `unavailable` 与 `missing` 都是**不可写**状态：真正的下一步不同（查网络 vs 工作区没了），
 * 所以渲染层要分开给可行动文案，不能合并成一句「操作失败」。
 */
export type PsbWorkspaceAdminAvailability = 'live' | 'unavailable' | 'missing';

/**
 * stale 的**本机归因**（渲染层据此选文案；PSB 原文仍放 `lastErrorZh` 做诊断）。
 *
 * - `list-failed`：读 PSB 工作区列表失败（网络 / 鉴权 / PSB 不可达）；
 * - `workspace-missing`：工作区列表读成功但工作区已不在（被删 / 无权限）；
 * - `session-unreadable`：当前任务的 PSB 会话读不到，固定信息来自本机会话行 / 虚拟工作目录；
 * - `snapshot-only`：本机只剩上一次保存的固定信息快照（连「哪个任务」的线索都没有）。
 */
export type PsbWorkspaceAdminStaleReason =
  | 'list-failed'
  | 'workspace-missing'
  | 'session-unreadable'
  | 'snapshot-only';

/**
 * 管理页描述的**工作区**（不是会话）。
 *
 * 所有字段只用于「顶部信息条」的展示，不含任何会话身份：页面不因为用户任务结束而退化。
 *
 * ## 固定字段 vs 状态字段（2026-11-26 真机事故）
 *
 * 工作区名称、项目模板、机器名、目录名是**固定信息**：工作区一旦创建就不再变化。占用、在线、
 * 桌面会话是**状态信息**，会随网络与别人操作变化。真机事故里 PSB 读不到（设备掉线 / 工作区
 * 被移除）时整页退化成「还没有远程工作区」，用户连「当初会话跑在哪个工作区」都不知道了。
 *
 * 因此固定字段一律以 main 的**本机快照**兜底：读不到实时行时 `stale: true`，固定字段仍显示，
 * 状态类字段显示「无法获取」而不是编造。只有本机完全没有线索时 `context` 才是 `null`。
 */
export interface PsbWorkspaceAdminContext {
  readonly workspaceId: string;
  readonly clientName: string;
  readonly clientOnline: boolean;
  /** PSB 工作区 title（例如 `saga2_project`）。 */
  readonly title: string;
  /**
   * PSB 工作区模板标题（例如 `Saga2`）；未指定模板 / PSB 没给时 `null`。
   *
   * 页头在名称之后、机器之前显示；为空时省略该段（`Meka · 打包机` → `打包机`）。
   */
  readonly templateTitle: string | null;
  /** 服务端分配的目录名（例如 `saga2_project-2`；没给时 `''`）。 */
  readonly directoryName: string;
  /** PSB 工作区状态词（`ready` / `provisioning` / …，原样透传，Cindy 不另造一套）。 */
  readonly state: string;
  readonly occupancy: PsbWorkspaceAdminOccupancy;
  readonly desktopSession: PsbWorkspaceAdminDesktopSession;
  /** 「此刻为什么没有画面」的 PSB 机器码（`NO_DESKTOP_SESSION` / …）；没有则 `null`。 */
  readonly reasonCode: string | null;
  /** PSB 给的可读原因（中文原话，兜底展示）；没有则 `null`。 */
  readonly lastErrorZh: string | null;
  readonly source: PsbWorkspaceAdminContextSource;
  /**
   * 该工作区**观看端绑定**的会话 id（没有则 `null`）。
   *
   * 正常形态是 PSB 工作区级 `stream/subscribe` 返回的**桌面访问会话** id（`remote_sessions.id`，
   * **不是** agent 会话 id）；旧 PSB 的过渡回退路径下是内部 Agent 会话 id。它只在 `STREAM_START`
   * 时建立（重复启动复用），用于订阅串流与读 `stream/status`；读状态路径只会在**本机记录里
   * 已有**这条 id 时借它做一次只读 HTTP（不订阅、不创建、不占用），没有记录就是 `null`。
   * 渲染层用它对 `STREAM_EVENT` 里的事件做过滤（事件载荷带的就是这个 id）。
   *
   * stale 时恒为 `null`：PSB 读不到时不再拿一条可能已死的绑定去试探（读路径只读、不写）。
   */
  readonly viewerSessionId: string | null;
  /**
   * 固定字段（`title` / `templateTitle` / `clientName` / `directoryName` / `state`）是否来自
   * **本机快照**，而不是这一次的 PSB 实时读取。
   *
   * 加性字段。旧 main 不返回它时，渲染层归一化按 `availability` 推断（缺省视为 live）。
   */
  readonly stale: boolean;
  /** 固定信息与工作区身份的可信度；`stale === false` 时恒为 `'live'`。加性字段。 */
  readonly availability?: PsbWorkspaceAdminAvailability;
  /** stale 的本机归因（本地化用 `remoteWorkspace.admin.stale*`；PSB 原文在 `lastErrorZh`）。 */
  readonly staleReason?: PsbWorkspaceAdminStaleReason | null;
  /** 本机固定信息快照的落盘时间（ISO 8601）；live / 没有任何快照时 `null`。 */
  readonly snapshotSavedAt?: string | null;
  /**
   * `workspaceId` 是否来自 PSB 的工作区行（可安全用于占用 / 串流 / 打开网页等写操作）。
   *
   * `false` = 只有本机会话行的线索（`psb:` 会话或 `/psb-remote/<目录>` 虚拟工作目录）时
   * 造出的**占位身份**（`psb:<psbSessionId>` / `psb-dir:<目录名>`）。此时固定信息可能退化成
   * 会话标题 / 目录名，写操作必须被拒绝并给可行动原因，不能拿占位 id 去请求 PSB。
   */
  readonly workspaceIdKnown?: boolean;
}

/**
 * `CONTEXT` invoke 的结果。
 *
 * `context: null` = **本机没有任何可用线索**（既没有可读的远程任务、也没有本机快照 / 会话行
 * 种子）：页面显示空提示态。PSB 暂时读不到但本机有快照或会话行线索时**不会**返回 `null`，而是
 * 返回 `stale: true` 的上下文（固定字段照旧显示，状态字段降级，见
 * `PsbWorkspaceAdminAvailability`）。
 */
export interface PsbWorkspaceAdminContextResult {
  readonly context: PsbWorkspaceAdminContext | null;
}

/**
 * `CONTEXT_CHANGED` 的载荷：与 invoke 结果**同形**，渲染层可以直接用它替换状态。
 *
 * 触发点只有 main「刚拿到新事实」的时刻：工作区变化、占用/在线变化、桌面会话状态变化、
 * 观看端绑定变化。main 不轮询 PSB，也不因为这个事件去读远端。
 *
 * ## 为什么要带 `localSessionId`
 *
 * 这是一个**广播**（所有受信窗口都收到），但同一时刻 main 只有一份「最近一次上下文读取用的
 * 本地任务 id」。多个窗口（主窗 + 独立页签窗口 / 设置窗）各自打开不同任务时，后发起读取的
 * 那个窗口会改写 main 里那个 id，随后广播出的上下文属于**它**。渲染层必须按这个字段过滤：
 * 不匹配就丢弃，否则另一个窗口会拿到别的任务的工作区、并把页头/观看端的写操作带到那个
 * 工作区上。`null` = 这次解析没有本地任务线索（用「最近使用的工作区」兜底），任何窗口都该接受。
 */
export interface PsbWorkspaceAdminContextChangedEvent {
  readonly context: PsbWorkspaceAdminContext | null;
  /** 解析这次上下文时 main 记下的「当前打开任务」；`null` = 没有任务线索。 */
  readonly localSessionId: string | null;
}

/* ============================== 3. 串流状态（工作区级） ============================== */

/**
 * 管理页看到的串流状态。
 *
 * 字段名按 PSB 的 Cindy 串流契约（`capability` / `encoder` / `lastErrorZh` 那套）归一，
 * 渲染层不需要知道 PSB 内部拼写（`psbAdminStreamStatusFromPsb` 是唯一映射点）。
 */
export interface PsbWorkspaceAdminStreamStatus {
  /** 客户端是否声明了串流能力。 */
  readonly capable: boolean;
  /** 当前是否有采集在跑（PSB 语义：本端订阅成功 **不** 等于有画面）。 */
  readonly active: boolean;
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  readonly encoder: string | null;
  readonly lastErrorZh: string | null;
  readonly desktopSession: PsbWorkspaceAdminDesktopSession;
  readonly reasonCode: string | null;
}

/**
 * `STREAM_STATUS` invoke 的结果。
 *
 * `status: null` = **此刻读不到 PSB 的状态**（本机没有观看端绑定，或 PSB 不可达）。这与
 * `capable: false` 是两件事：把「读不到」当「客户端不支持串流」会让启动按钮永远不可用，正是
 * 本批要修的那类退化。已读到的历史状态会经 `CONTEXT_CHANGED` / `STREAM_EVENT` 先行到达，
 * 渲染层保留自己的最后一次快照即可。
 *
 * ## 读路径不订阅、不创建会话、不占用工作区（2026-11-26 审查修正 + 0.1.172 服务接口）
 *
 * 桌面会话状态（`desktopSession` / `reasonCode`）只能借一条会话 id 去问 PSB 的
 * `stream/status`。候选顺序只有两条：
 *   1. 内存里已有的观看端绑定（本进程启动过串流）；
 *   2. 本机记录里该工作区的绑定会话 id（**应用重启后的主路径**，只读 HTTP）。
 *
 * 两者都没有就返回 `status: null`。**不会**为了读状态新建 PSB 会话、也**不会**为了读状态调用
 * 工作区级订阅：前者会让打开页签静默占用工作区（审查发现的原实现），后者会占用观看名额。
 * 同样**不按标题认领** `listSessions` 里的会话：同一工作区的列表可能含其他人的会话。
 */
export interface PsbWorkspaceAdminStreamStatusResult {
  readonly status: PsbWorkspaceAdminStreamStatus | null;
  /**
   * 本次读数所用的观看端绑定会话 id（没有则 `null`）。加性字段，与 `STREAM_START` 同形。
   *
   * 正常是**桌面访问会话** id（旧 PSB 过渡回退时是内部 Agent 会话 id）。值是「本机记录 /
   * 内存绑定」里那条真实存在的会话；读到状态的这一刻它一定存在，但**不代表已订阅**（读状态只
   * 发 HTTP）。渲染层可以直接用它过滤 `STREAM_EVENT` / 决定输入是否可发；没有绑定记录时是
   * `null`（用户在页面上点「启动」之后才会有）。
   */
  readonly viewerSessionId: string | null;
}

/** `STREAM_START` 的结果：新状态 + 观看端绑定会话 id（渲染层据此过滤 `STREAM_EVENT`）。 */
export interface PsbWorkspaceAdminStreamStartResult {
  readonly status: PsbWorkspaceAdminStreamStatus;
  readonly workspaceId: string;
  /** 观看端绑定会话 id：桌面访问会话 id（旧 PSB 过渡回退时是内部 Agent 会话 id）。 */
  readonly viewerSessionId: string;
}

/* ============================== 4. 过渡回退的内部会话 ============================== */

/**
 * **过渡兜底专用**的内部 Agent 会话标题（只在旧 PSB 没有工作区级订阅端点时出现）。
 *
 * PSB 0.1.172 的框架规则：**Agent 会话只装用户任务**；串流 / 工作区读取 / 访问起停走服务接口。
 * 新客户端优先用 `POST …/workspaces/:id/stream/subscribe`（返回桌面访问会话 id，不建会话），
 * 因此这条标题在新服务端上**永不出现**。
 *
 * 兜底时的硬约束（PSB 0.1.172 契约）：
 *   - 创建请求必须带 `purpose: 'internal'`：PSB 默认不把它列进会话列表、不计入 `sessionCount`
 *     （其它值 PSB 会 400）。Cindy 侧删掉这条兜底后，这个字段也一起消失；
 *   - 标题必须写明**内部用途**，不得伪装成用户任务（`Cindy 观看端 · 内部串流订阅`）；
 *   - 记 warn 日志，让「用户还在跑旧服务端」这件事可归因。
 *
 * **不要**把它用作「按标题认领会话」的判据：`listSessions` 是全工作区可见范围，认领标题会认到
 * 别人的会话（2026-11-26 审查）。兜底只认本次创建返回的 id（并持久化到 `adminRecentStore`）。
 */
export const PSB_ADMIN_INTERNAL_STREAM_SESSION_TITLE = 'Cindy 观看端 · 内部串流订阅';

/* ============================== 5. 纯函数映射 ============================== */

/** `null` 状态：读不到时内部使用的默认值（IPC 不返回它，而是返回 `status: null`）。 */
export function psbAdminStreamStatusFallback(): PsbWorkspaceAdminStreamStatus {
  return {
    capable: false,
    active: false,
    width: null,
    height: null,
    fps: null,
    encoder: null,
    lastErrorZh: null,
    desktopSession: null,
    reasonCode: null,
  };
}

/**
 * PSB 串流状态 → 管理页状态（唯一映射点）。
 *
 * 只做字段归一，**不改写语义**：`active` 保持 PSB 的判断（订阅成功不等于有画面），
 * `desktopSession` / `reasonCode` 缺字段时是 `null`（未知），不猜 `none`。
 */
export function psbAdminStreamStatusFromPsb(
  status: PsbSessionStreamStatus,
): PsbWorkspaceAdminStreamStatus {
  return {
    capable: status.capable === true,
    active: status.active === true,
    width: typeof status.width === 'number' ? status.width : null,
    height: typeof status.height === 'number' ? status.height : null,
    fps: typeof status.fps === 'number' ? status.fps : null,
    encoder: typeof status.codec === 'string' ? status.codec : null,
    lastErrorZh: typeof status.lastError === 'string' ? status.lastError : null,
    desktopSession: status.desktopSession ?? null,
    reasonCode: status.reasonCode ?? null,
  };
}

/** 复用共享的串流事件形状（帧 / 状态 / 光标 / 关闭 / 错误）；只是给管理页通道一个别名。 */
export type PsbAdminStreamEvent = PsbStreamEvent;

/* ==================== 5.1 stale 上下文的展示判据（纯函数，main/renderer 共用） ==================== */

/**
 * stale 文案的两组 i18n key（按「为什么看不到工作区」区分，不按原因细分）。
 *
 * 原因（`staleReason`）留给诊断与测试；用户只需要知道下一步：工作区没了 vs 网络/PSB 读不到。
 */
export const PSB_ADMIN_STALE_COPY_KEYS = {
  missing: {
    title: 'remoteWorkspace.admin.staleMissingTitle',
    hint: 'remoteWorkspace.admin.staleMissingHint',
    action: 'remoteWorkspace.admin.staleMissingAction',
  },
  unavailable: {
    title: 'remoteWorkspace.admin.staleUnavailableTitle',
    hint: 'remoteWorkspace.admin.staleUnavailableHint',
    action: 'remoteWorkspace.admin.staleUnavailableAction',
  },
} as const;

export type PsbAdminStaleCopyKind = keyof typeof PSB_ADMIN_STALE_COPY_KEYS;

/**
 * 上下文的可信度。
 *
 * 旧 main / 旧缓存载荷没有 `availability` 时按 `stale` 推断：`stale === true` 视为
 * `unavailable`（保守：不让一个旧载荷被当成实时事实去写 PSB）。
 */
export function psbAdminContextAvailability(
  context: PsbWorkspaceAdminContext,
): PsbWorkspaceAdminAvailability {
  const availability = context.availability;
  if (availability === 'live' || availability === 'unavailable' || availability === 'missing') {
    return availability;
  }
  return context.stale === true ? 'unavailable' : 'live';
}

/** 固定信息是否来自本机快照（旧 main 缺字段时按 `availability` 推断）。 */
export function psbAdminContextIsStale(context: PsbWorkspaceAdminContext): boolean {
  return psbAdminContextAvailability(context) !== 'live';
}

/**
 * 这个上下文能不能执行写操作（占用 / 解除占用 / 启动串流 / 打开网页）。
 *
 * 两条独立约束：
 *   1. 工作区事实必须来自 PSB（`live`）—— stale 时占用 / 串流只会得到一条 PSB 失败，
 *      提前在前端拦住并给「工作区已不可见 / 连不上」的可行动原因；
 *   2. 工作区 id 必须是真的（`workspaceIdKnown !== false`）—— 只有本机会话行线索时 id 是占位。
 */
export function psbAdminContextCanOperate(context: PsbWorkspaceAdminContext | null): boolean {
  if (!context) return false;
  if (context.workspaceIdKnown === false) return false;
  return psbAdminContextAvailability(context) === 'live';
}

/** stale 态的文案分组；live 时 `null`。 */
export function psbAdminContextStaleCopyKind(
  context: PsbWorkspaceAdminContext,
): PsbAdminStaleCopyKind | null {
  const availability = psbAdminContextAvailability(context);
  if (availability === 'missing') return 'missing';
  if (availability === 'unavailable') return 'unavailable';
  return null;
}

/**
 * stale 时写操作的可行动文案 key；live / 可写时 `null`。
 *
 * 占位身份（`workspaceIdKnown === false`）比 stale 更彻底：连工作区 id 都不知道，
 * 文案要说明「只能看到本机保存的信息」，不能暗示重试就能占用。
 */
export function psbAdminContextActionBlockedKey(
  context: PsbWorkspaceAdminContext | null,
): string | null {
  if (psbAdminContextCanOperate(context)) return null;
  if (context && context.workspaceIdKnown === false) {
    return 'remoteWorkspace.admin.staleUnknownWorkspaceAction';
  }
  const kind = context ? psbAdminContextStaleCopyKind(context) : null;
  return kind ? PSB_ADMIN_STALE_COPY_KEYS[kind].action : 'remoteWorkspace.admin.staleUnavailableAction';
}


/* ============================== 6. 交互输入（键鼠） ============================== */

/**
 * 可转发的输入事件种类（PSB 网页观看端 `{kind:'input', event}` 的 `event.kind`）。
 *
 * 与 PSB 观看端同一套词：Cindy **只转发**采集到的事件，不解释坐标是否归一化、修饰键怎么编码
 * （那是采集端与 PSB 客户端的事实）。main 只做两件事：拒绝不属于这套词的帧（防止渲染层 bug
 * 把任意消息写进共享中继），以及限制帧大小。
 */
export const PSB_STREAM_INPUT_KINDS = [
  'pointermove',
  'pointerdown',
  'pointerup',
  'wheel',
  'keydown',
  'keyup',
  /** 指针锁（相对移动）模式下的位移事件。 */
  'relative',
] as const;

export type PsbStreamInputKind = (typeof PSB_STREAM_INPUT_KINDS)[number];

/**
 * 单帧上限（PSB 中继硬限制，超过就是协议错）。
 *
 * 校验的是**完整上行帧** `{"kind":"input","event":{…}}` 而不是内层对象的字节数：服务端限制的
 * 是 WS 文本帧本身，按内层算会放过刚好超限的帧。
 */
export const PSB_STREAM_INPUT_MAX_FRAME_BYTES = 4096;

/** `STREAM_INPUT` 的入参（工作区级：main 从观看端绑定解析会话）。 */
export interface PsbWorkspaceAdminStreamInputRequest {
  readonly workspaceId: string;
  /** PSB 输入事件（`kind` ∈ `PSB_STREAM_INPUT_KINDS`）。 */
  readonly event: Record<string, unknown>;
}

/** 输入事件校验结果：失败带**可诊断**的原因（IPC 层原样塞进 `INVALID_PARAMS` 的 message）。 */
export type PsbStreamInputEventValidation =
  | { readonly ok: true; readonly event: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/** 复用一个编码器：输入帧在校验路径上出现频率不低（指针移动），没必要每次新建。 */
const streamInputTextEncoder = new TextEncoder();

/**
 * 校验一条待转发的输入事件（main 的 IPC 闸门，渲染层也可以在采集后先自检）。
 *
 * 只做**形状与预算**这一层：`kind` 必须在允许集合内（未知 kind 说明渲染层在造新协议，
 * PSB 会把它计成非法消息）、必须可 JSON 序列化、完整帧 ≤ `PSB_STREAM_INPUT_MAX_FRAME_BYTES`。
 * 不校验 `x/y/button/key/code` 的必填与取值范围：PSB 的网页观看端 schema 还没有正式文档
 * （`联动需求.md` 已向 PSB 要），在这里猜字段只会在联调时把合法事件挡在门外。
 */
export function validatePsbStreamInputEvent(raw: unknown): PsbStreamInputEventValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'event must be an object' };
  }
  const event = raw as Record<string, unknown>;
  const kind = event['kind'];
  if (typeof kind !== 'string' || !(PSB_STREAM_INPUT_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      reason: `event.kind must be one of ${PSB_STREAM_INPUT_KINDS.join(' | ')}`,
    };
  }
  let frame: string | undefined;
  try {
    frame = JSON.stringify({ kind: 'input', event });
  } catch {
    return { ok: false, reason: 'event is not JSON serializable' };
  }
  if (typeof frame !== 'string') {
    return { ok: false, reason: 'event is not JSON serializable' };
  }
  const bytes = streamInputTextEncoder.encode(frame).byteLength;
  if (bytes > PSB_STREAM_INPUT_MAX_FRAME_BYTES) {
    return {
      ok: false,
      reason: `input frame is ${bytes} bytes (limit ${PSB_STREAM_INPUT_MAX_FRAME_BYTES})`,
    };
  }
  return { ok: true, event };
}

/* ============================== 7. 画面捕获态（宿主快捷键让路） ============================== */

/** `STREAM_CAPTURE` 的入参。 */
export interface PsbWorkspaceAdminStreamCaptureRequest {
  /** `true` = 进入捕获态；`false` = 退出（退出全屏 / 页面卸载 / 主动释放）。 */
  readonly active: boolean;
  /** 仅用于诊断与日志（main 不据此鉴权：哪个窗口在捕获由 IPC 来源决定）。 */
  readonly workspaceId?: string;
}

/**
 * 捕获态下**仍然交给宿主 / 页面**处理的按键（`key` 或 `code` 命中即放行）。
 *
 * 这份清单是 main（`before-input-event` 抑制）与渲染层（「本端保留键 / 不转发给远端」）
 * **共用**的唯一来源，取自产品口径（`docs/product-rules/psb-remote-workspace-sessions.md`
 * §2.4「全屏 = 远端独占键鼠」）——只有这几类留给用户自救：
 *
 * - `Escape`：退出全屏（浏览器 / Electron 自己消费，拦掉用户就再也出不来）；
 * - `F5`：刷新（页面卡死时的最后一条路）；
 * - `F11`：窗口全屏惯例键（交给宿主，不转发给远端）；
 * - `F12`：DevTools 兜底通道（dev 下 `bootstrap-electron.ts` 在 main 侧监听）。
 *
 * 组合键（开发者工具）见 `PSB_STREAM_CAPTURE_PASSTHROUGH_CODES`；判定统一走
 * `psbStreamCaptureIsPassthroughInput`，不要在两侧各写一份。
 */
export const PSB_STREAM_CAPTURE_PASSTHROUGH_KEYS = ['Escape', 'F5', 'F11', 'F12'] as const;

/**
 * 捕获态下留给宿主的组合键（开发者工具自救）。
 *
 * 修饰键按平台固定：非 darwin 是 `Ctrl+Shift`，darwin 是 `⌘+⌥`（macOS 的开发者工具习惯键是
 * ⌥⌘I）。这里只列主键，修饰键判定在 `psbStreamCaptureIsPassthroughInput` 里，两侧共用。
 */
export const PSB_STREAM_CAPTURE_PASSTHROUGH_CODES = ['KeyI', 'KeyJ', 'KeyC'] as const;

/** 捕获态按键判定的最小输入面（Electron `Input` / DOM `KeyboardEvent` 都能满足）。 */
export interface PsbStreamCaptureKeyInput {
  readonly key: string;
  readonly code: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

const passthroughKeySet: ReadonlySet<string> = new Set<string>(PSB_STREAM_CAPTURE_PASSTHROUGH_KEYS);

/**
 * 这个按键是否属于「宿主保留」的允许清单（捕获态下必须放行）。
 *
 * 平台口径：非 darwin 是 `Ctrl+Shift+I/J/C`，darwin 是 `Cmd+Alt+I/J/C`（macOS 上开发者工具
 * 的习惯键是 ⌥⌘I，不是 ⇧⌘I）。两侧（main 抑制 / 渲染层转发）共用本函数，避免「哪一侧漏拦」
 * 取决于谁先改。
 */
export function psbStreamCaptureIsPassthroughInput(
  input: PsbStreamCaptureKeyInput,
  platform: string,
): boolean {
  if (passthroughKeySet.has(input.key) || passthroughKeySet.has(input.code)) return true;
  const darwin = platform === 'darwin';
  // 修饰键必须与平台口径**完全一致**：多按一个键的变体（如 ⌃⇧⌘I）不算「留给宿主的自救键」。
  const modifiersMatch = darwin
    ? input.meta && input.alt && !input.control && !input.shift
    : input.control && input.shift && !input.meta && !input.alt;
  if (!modifiersMatch) return false;
  return (PSB_STREAM_CAPTURE_PASSTHROUGH_CODES as readonly string[]).includes(input.code);
}
