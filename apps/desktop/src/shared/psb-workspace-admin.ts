/**
 * 「远程工作区」管理页（**工作区级**）的跨进程契约。
 *
 * ## 与 `psb-remote-workspace.ts` 的分工
 *
 * `psb-remote-workspace.ts` 描述的是**会话级**链路：「某个本地任务 ↔ 某条 PSB agent 会话」
 * （`psb:<sessionId>` 身份、隧道、发消息、串流观看端）。本文件描述的是**工作区级**页面：
 * 「此刻管理哪个 PSB 工作区」，以及为它服务的**内部观看端会话**。
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
 * 「本机记录的最近使用过的远程工作区」解析，观看端则用**我们自己身份的内部 PSB 会话**
 * 订阅串流（见 `PSB_ADMIN_VIEWER_SESSION_TITLE`）。用户任务结束不影响它，用户的 PSB
 * 会话被拒也不影响它 —— 这是本层存在的全部理由。
 *
 * ## 边界
 *
 * 只放**形状与纯函数**：通道名、DTO、内部会话标识、PSB 串流状态到管理页状态的映射。
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
  /** main → renderer：当前工作区上下文变化（工作区 / 占用 / 桌面会话状态 / 观看端会话）。 */
  CONTEXT_CHANGED: 'psb-remote:admin-context-changed',
  /** 启动串流（会保证一条内部观看端 PSB 会话存在，后续帧经 `STREAM_EVENT` 推送）。 */
  STREAM_START: 'psb-remote:admin-stream-start',
  /** 停止串流（内部观看端会话**保留**，供下次复用；见 `PSB_ADMIN_VIEWER_SESSION_TITLE`）。 */
  STREAM_STOP: 'psb-remote:admin-stream-stop',
  /** 读串流状态（工作区级读数；只借已有会话的 HTTP 读口，**不创建会话、不占用工作区**）。 */
  STREAM_STATUS: 'psb-remote:admin-stream-status',
  /** main → renderer：串流事件（帧 / 状态 / 光标 / 关闭 / 错误）。`sessionId` 是内部观看端会话。 */
  STREAM_EVENT: 'psb-remote:admin-stream-event',
  /**
   * 键鼠输入（renderer 采集 → main → 内部观看端会话的 WS）。
   *
   * 入参是**工作区级**的 `{ workspaceId, event }`：渲染层不持有也不需要内部观看端会话 id
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
 * 管理页描述的**工作区**（不是会话）。
 *
 * 所有字段只用于「顶部信息条」的展示，不含任何会话身份：页面不因为用户任务结束而退化。
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
   * 该工作区的**内部观看端** PSB 会话 id（没有则 `null`）。
   *
   * 它不是用户的会话：只在 `STREAM_START` 时懒创建/复用，用于订阅串流。读状态路径只会在
   * **本机记录里已有**这条 id 时借它做一次只读 HTTP（不创建、不占用）；没有记录就是 `null`。
   * 渲染层用它对 `STREAM_EVENT` 里的事件做过滤（事件载荷带的就是这个 id）。
   */
  readonly viewerSessionId: string | null;
}

/**
 * `CONTEXT` invoke 的结果。
 *
 * `context: null` = **本机没有任何可用线索**（既没有远程任务，也没有最近使用记录）：
 * 页面显示空提示态。PSB 暂时读不到但本机有记录时**不会**返回 `null`，而是返回带
 * `lastErrorZh` 的上下文（保留上一次快照，见工程契约 §8.3 的「读取失败保留最后一次快照」）。
 */
export interface PsbWorkspaceAdminContextResult {
  readonly context: PsbWorkspaceAdminContext | null;
}

/**
 * `CONTEXT_CHANGED` 的载荷：与 invoke 结果**同形**，渲染层可以直接用它替换状态。
 *
 * 触发点只有 main「刚拿到新事实」的时刻：工作区变化、占用/在线变化、桌面会话状态变化、
 * 内部观看端会话变化。main 不轮询 PSB，也不因为这个事件去读远端。
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
 * `status: null` = **此刻读不到 PSB 的状态**（本机没有可借用的内部观看端会话、也没有活着的
 * 用户任务会话，或 PSB 不可达）。这与 `capable: false` 是两件事：把「读不到」当「客户端不支持
 * 串流」会让启动按钮永远不可用，正是本批要修的那类退化。已读到的历史状态会经
 * `CONTEXT_CHANGED` / `STREAM_EVENT` 先行到达，渲染层保留自己的最后一次快照即可。
 *
 * ## 读路径不创建会话、不占用工作区（2026-11-26 审查修正）
 *
 * 桌面会话状态（`desktopSession` / `reasonCode`）只能借一条会话去问 PSB 的 `stream/status`。
 * 候选顺序：
 *   1. 内存里已有的内部观看端绑定（本进程启动过串流）；
 *   2. 本机记录里该工作区的内部观看端会话 id（**应用重启后的主路径**，只读 HTTP）；
 *   3. 最近一次上下文解析记下的、还活着的用户任务会话。
 *
 * 三条都没有就返回 `status: null`。**不会**为了读状态新建 PSB 会话：新会话属于工作区写操作，
 * 写前占用闸门会顺带把工作区锁到自己名下 —— 打开「远程工作区」页签就静默占用一个空闲工作区
 * 是不可接受的副作用（审查发现的原实现正是这种「读着读着就占用」）。同样**不按标题认领**
 * `listSessions` 里的会话：同一工作区的列表可能含其他人的会话，认错会话会把别人的流当成自己的。
 */
export interface PsbWorkspaceAdminStreamStatusResult {
  readonly status: PsbWorkspaceAdminStreamStatus | null;
  /**
   * 本次读数所用的内部观看端会话（没有则 `null`）。加性字段，与 `STREAM_START` 同形。
   *
   * 值是「本机记录 / 内存绑定」里那条真实存在的内部会话；读到状态的这一刻它一定存在，但
   * **不代表已订阅**（读状态只发 HTTP）。渲染层可以直接用它过滤 `STREAM_EVENT` / 决定输入
   * 是否可发；没有记录时是 `null`（用户在页面上点「启动」之后才会有）。
   */
  readonly viewerSessionId: string | null;
}

/** `STREAM_START` 的结果：新状态 + 内部观看端会话 id（渲染层据此过滤 `STREAM_EVENT`）。 */
export interface PsbWorkspaceAdminStreamStartResult {
  readonly status: PsbWorkspaceAdminStreamStatus;
  readonly workspaceId: string;
  readonly viewerSessionId: string;
}

/* ============================== 4. 内部观看端会话 ============================== */

/**
 * 内部观看端会话的标题标记。
 *
 * 作用只有一个：让用户在 PSB 会话列表里能辨认出「这条是 Cindy 的观看端，不是我的任务」。
 *
 * **不再用标题认领会话**（2026-11-26 审查修正）：`listSessions(workspaceId)` 会返回同一工作区
 * 里**其他人**（以及同一账号其它窗口）的会话，按标题前缀认领会认到别人的会话上——订阅别人的
 * 流、把别人的会话当成自己的复用。复用的唯一依据是本机记录里的 `viewers[workspaceId]`
 * （`main/remote-workspace/adminRecentStore.ts`，持久化）；没有记录就新建一条，不认领陌生标题。
 *
 * 语义契约：
 *   - `STREAM_START` 时先看本机记录里的内部会话 id（校验仍非终态）→ 复用；
 *   - 没有记录 / 已终态才新建一条（`agentKind: 'pi'`、`clientRequestId` 幂等），并立刻记下 id；
 *   - **不要**把用户的会话改名成这个前缀，也不要在别处复用它 —— 它是内部会话的标识，
 *     不是产品文案（不翻译、不进 i18n）。
 */
export const PSB_ADMIN_VIEWER_SESSION_TITLE = 'Cindy 观看端';

/**
 * 内部观看端会话此刻**可直接复用**吗（不需要重建）。
 *
 * 只有 `starting` / `running` / `idle` 算可复用；`stopped` / `failed` 是 PSB 的终态、
 * **永不逆转**，复用它一定被 PSB 拒（本批要修的正是这个竞态）。
 */
export function psbAdminViewerSessionReusable(status: string | null | undefined): boolean {
  return status === 'starting' || status === 'running' || status === 'idle';
}

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

/** `STREAM_INPUT` 的入参（工作区级：main 从工作区绑定解析内部观看端会话）。 */
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
