/**
 * 「远程连接」页的**串流生命周期判据**（纯函数，node 环境可单测）。
 *
 * 用户口径（2026-11-26 改口）：进入页面 / 页签重新可见时**不再自动打开串流**，一律由用户
 * 点「启动」明确开始；离开页面 / 页签不可见时仍然自动停止，释放 PSB 的观看名额（名额有限，
 * 见产品正本 §2.4、工程契约 §5）。
 *
 * 所以这里只保留两个纯判据，不再有任何「自动启动」触发：
 *   - `canManuallyStartPsbStream`：用户点「启动」是否可点（桥就绪 / 播放器可用 / PSB 声明
 *     支持串流 / 不在启动中）；
 *   - `shouldReleasePsbStreamOnLeave`：页签不可见且已连接时是否该释放观看名额。
 *
 * 页面可见性用**既有 tab pane 可见性**（`active && shellVisible`，页签被切走时 body 是
 * `display:none`），不用 `document.visibilityState` —— 后者只反映窗口，切到别的页签时仍是
 * `visible`，拿它当判据会在后台占着观看名额。
 */

/** 用户点「启动」按钮的可点条件（与既有状态机一致；不看远端是否 running，让 PSB 给可行动错误）。 */
export interface PsbManualStartState {
  /** preload 管理工作区桥是否就绪。 */
  readonly bridgeReady: boolean;
  /** 播放器是否可用（WebCodecs / canvas 2D 可用）；不可用时订阅了也没画面。 */
  readonly playerAvailable: boolean;
  /** PSB 是否声明这台客户端支持串流（`false` = 启动必失败，按钮禁用；`unknown` 视为允许）。 */
  readonly capable: boolean;
  /** 正在启动：禁止重复点击。 */
  readonly starting: boolean;
}

export function canManuallyStartPsbStream(state: PsbManualStartState): boolean {
  return state.bridgeReady && state.playerAvailable && state.capable && !state.starting;
}

/** 离开可见区时是否释放观看名额（只在已连接且没有正在进行的停止操作时发）。 */
export interface PsbStreamLeaveState {
  /** 页签是否可见（`active && shellVisible`）。 */
  readonly visible: boolean;
  /** 本端已订阅 / 已在播（含等待首帧）。 */
  readonly connected: boolean;
  readonly stopping: boolean;
}

export function shouldReleasePsbStreamOnLeave(state: PsbStreamLeaveState): boolean {
  return !state.visible && state.connected && !state.stopping;
}
