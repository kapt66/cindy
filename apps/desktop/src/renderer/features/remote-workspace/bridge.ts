/**
 * 渲染层访问 PSB 远程工作区的**唯一入口**（preload 桥的窄封装）。
 *
 * ## 为什么要有这个文件
 *
 * 远程工作区的 IPC 面很宽（列表 / 占用 / 建会话 / 串流 / 事件订阅）。如果每个组件各自
 * `window.electronAPI.psbRemote.xxx`，会发生两件坏事：
 *
 * 1. 类型只存在于 `vite-env.d.ts` 的 `ElectronAPI` 里，页面代码拿不到窄签名，
 *    参数打错不报错；
 * 2. 失败形状（`PsbRemoteFailure`）与事件（`PsbStreamEvent`）在各处重复解构，
 *    "为什么输入框置灰"会出现在三个地方且各自不同。
 *
 * 所以这里收敛成一个接口：**组件只依赖本文件的类型**，preload 的物理形状变化只改这里一处。
 *
 * ## 不可用时的行为
 *
 * 只读页/列表在没有桥时（旧 preload、单测、非主窗口）应当渲染"不可用"而不是崩。
 * 因此 `tryGetPsbRemoteBridge()` 返回 `null`（供渲染与测试使用），
 * `getPsbRemoteBridge()` 在缺失时抛错（供**用户显式动作**路径报错）。
 *
 * ## 会话级串流通道已删除（2026-11-26）
 *
 * 这里曾有一组会话级串流方法（`streamStatus` / `streamStart` / `streamStop` / `streamInput` /
 * `onStreamEvent`），与工作区级管理页并存；渲染层对会话级零消费，两套只会让「谁启动了串流、
 * 帧该推给谁」有两个答案。现在只保留管理页的 `adminStream*` / `onAdminStreamEvent`。
 */

import type {
  PsbCreateSessionRequest,
  PsbCreateSessionResult,
  PsbCreateWorkspaceRequest,
  PsbCreateWorkspaceResult,
  PsbListClientsResult,
  PsbListTemplatesResult,
  PsbListWorkspacesResult,
  PsbOccupyWorkspaceResult,
  PsbPendingWorkspaceReleasesResult,
  PsbPendingWorkspaceReleasesRetryResult,
  PsbRemoteStatus,
  PsbSessionStatusResult,
  PsbSessionWorkspaceReleaseRequest,
  PsbSessionWorkspaceReleaseResult,
  PsbSessionsReboundEvent,
  PsbStreamEvent,
  PsbWorkspaceChangedEvent,
  PsbWorkspaceRefRequest,
} from '../../../shared/psb-remote-workspace';
import type {
  PsbRunWorkspaceVcsActionRequest,
  PsbRunWorkspaceVcsActionResponse,
  PsbWorkspaceVcsNoticeEvent,
  PsbWorkspaceVcsNoticeResult,
} from '../../../shared/psb-workspace-vcs';
import type {
  PsbAdminStreamEvent,
  PsbWorkspaceAdminContextChangedEvent,
  PsbWorkspaceAdminContextResult,
  PsbWorkspaceAdminStreamCaptureRequest,
  PsbWorkspaceAdminStreamInputRequest,
  PsbWorkspaceAdminStreamStartResult,
  PsbWorkspaceAdminStreamStatusResult,
} from '../../../shared/psb-workspace-admin';

export interface PsbRemoteBridge {
  status(): Promise<PsbRemoteStatus>;
  listWorkspaces(input?: { clientId?: string; readyOnly?: boolean }): Promise<PsbListWorkspacesResult>;
  listClients(): Promise<PsbListClientsResult>;
  listProjectTemplates(): Promise<PsbListTemplatesResult>;
  createWorkspace(input: PsbCreateWorkspaceRequest): Promise<PsbCreateWorkspaceResult>;
  occupyWorkspace(input: PsbWorkspaceRefRequest): Promise<PsbOccupyWorkspaceResult>;
  releaseWorkspace(input: PsbWorkspaceRefRequest): Promise<PsbOccupyWorkspaceResult>;
  /**
   * 读某工作区当前的版本控制检查通知（CINDY-RW-10 更正版）。
   *
   * 占用 / 解除占用被 PSB 的版本控制检查拒绝时，`error.details.vcs` 里的 `projects` / `actions`
   * 不能随 invoke 失败跨进程；main 已缓存并广播（`onWorkspaceVcsNotice`），这里是**兜底读口**：
   * invoke 失败后读一次，避免推送与失败到达顺序的竞争。`notice:null` = 没有通知。
   */
  workspaceVcsNotice(input: PsbWorkspaceRefRequest): Promise<PsbWorkspaceVcsNoticeResult>;
  /**
   * 执行一条版本控制处置动作（`inspect-vcs` / `revert-then-occupy` / `revert-then-release` /
   * `retry`）。**只传 kind**：method/path/body 由 main 从服务端下发的 notice 里取并校验，
   * 渲染层绝不自己拼 URL。`revert-then-*` 不可逆，必须二次确认后传 `confirm:true`。
   */
  runWorkspaceVcsAction(
    input: PsbRunWorkspaceVcsActionRequest,
  ): Promise<PsbRunWorkspaceVcsActionResponse>;
  /**
   * 版本控制通知变更（main 在拒绝时广播、在占用/释放/还原成功后广播 `notice:null`）。
   *
   * 渲染层据此显示 / 撤下常驻提示条与处置按钮；按 `workspaceId` 过滤。
   */
  onWorkspaceVcsNotice(handler: (event: PsbWorkspaceVcsNoticeEvent) => void): () => void;
  createSession(input: PsbCreateSessionRequest): Promise<PsbCreateSessionResult>;
  refreshWorkspaces(input?: { workspaceIds?: readonly string[] }): Promise<PsbListWorkspacesResult>;
  sessionStatus(input: { sessionId: string }): Promise<PsbSessionStatusResult>;
  stopSession(input: { sessionId: string }): Promise<void>;
  openWebWorkspace(input: { workspaceId: string }): Promise<void>;
  onWorkspaceChanged(handler: (event: PsbWorkspaceChangedEvent) => void): () => void;
  /**
   * 远程会话在发送时被透明重建（本地任务不变，PSB 侧换了新会话）。
   *
   * 主进程在**新的 `remote_host_id` 已落库之后**推送；渲染层据此把该本地任务派生的
   * `remoteHostId` 换成新值（输入判据、远程管理页、串流面板一起指向新会话），不需要
   * 依赖会话行 patch 的到达顺序。
   */
  onSessionsRebound(handler: (event: PsbSessionsReboundEvent) => void): () => void;

  /* ------------------ 会话结束归还工作区占用（r6/r7 跨组接线） ------------------ */

  /**
   * 报告「这条本地任务结束了」→ main 归还它占用的 PSB 工作区。
   *
   * 只传本地会话 id + 会话行的远端身份（`psb:<id>`）+ 终态原因；**占用者判断与账本都在
   * main**（渲染层拿不到 workspaceId，也不该自己判「还有没有别的任务在用」）。
   *
   * `ok:false` 表示 main 把失败记进了它自己的待释放账本（可重试），**事件已经送达**：
   * 调用方清掉本地待投记录即可，不要为同一件事排第二份重试。
   */
  releaseWorkspaceForSession(
    input: PsbSessionWorkspaceReleaseRequest,
  ): Promise<PsbSessionWorkspaceReleaseResult>;
  /** 读 main 的待释放账本（常驻提示条 / 诊断；不触发任何写操作）。 */
  pendingWorkspaceReleases(): Promise<PsbPendingWorkspaceReleasesResult>;
  /**
   * 显式重试 main 的待释放账本（用户点「重试解除占用」时调用一次）。
   *
   * 只做一次、不排后台轮询：返回值带重试后的完整账本与本次计数。
   */
  retryPendingWorkspaceReleases(): Promise<PsbPendingWorkspaceReleasesRetryResult>;
  /** main 的待释放账本变了（失败入账 / 重试成功出账 / 退出前重试）→ 完整快照。 */
  onPendingWorkspaceReleasesChanged(
    handler: (event: PsbPendingWorkspaceReleasesResult) => void,
  ): () => void;

  /* ------------------ 「远程工作区」管理页（工作区级） ------------------ */

  /**
   * 读当前工作区上下文（页面顶部信息条的唯一数据源）。
   *
   * `localSessionId` 只是「当前打开的任务」这条线索，可以为空：工作区解析完全在 main 侧
   * （优先当前任务的 PSB 会话，任何状态；否则本机记录的最近使用工作区），渲染层不传
   * `remoteHostId` / `workspaceId` —— 那些是主进程的事实，传进来只会成为可伪造的输入。
   *
   * `context: null` = 本机没有任何线索（空提示态）；PSB 暂时读不到但本机有记录时返回的是
   * 带 `lastErrorZh` 的上一次快照，不会清空页面。
   */
  adminContext(input?: { localSessionId?: string | null }): Promise<PsbWorkspaceAdminContextResult>;
  /** 当前工作区变化（工作区 / 占用 / 桌面会话状态 / 观看端绑定）→ 载荷与 `adminContext` 结果同形。 */
  onAdminContextChanged(
    handler: (event: PsbWorkspaceAdminContextChangedEvent) => void,
  ): () => void;
  /**
   * 启动串流：main 走工作区级 `stream/subscribe` 拿**桌面访问会话 id**（不建 Agent 会话；
   * 旧 PSB 才过渡回退到内部会话），返回它的 `viewerSessionId` 供事件过滤。
   */
  adminStreamStart(input: PsbWorkspaceRefRequest): Promise<PsbWorkspaceAdminStreamStartResult>;
  /** 停止串流（观看端绑定保留，供下次复用）。幂等。 */
  adminStreamStop(input: PsbWorkspaceRefRequest): Promise<void>;
  /** 读串流状态；`status: null` = 此刻读不到 PSB 状态（**不是**「客户端不支持串流」）。 */
  adminStreamStatus(input: PsbWorkspaceRefRequest): Promise<PsbWorkspaceAdminStreamStatusResult>;
  /**
   * 转发一条键鼠输入（唯一的上行业务消息 `{kind:'input', event}`）。
   *
   * 事件必须是 PSB 观看端协议里的 `kind`（`PSB_STREAM_INPUT_KINDS`）；main 会校验形状与
   * 4KiB 上限，非法事件直接 `INVALID_PARAMS` 拒绝。没有活动观看时失败码是
   * `PSB_STREAM_NOT_ACTIVE`（先启动串流即可，不是「本机不能串流」）。
   */
  adminStreamInput(input: PsbWorkspaceAdminStreamInputRequest): Promise<void>;
  /**
   * 进入 / 退出「画面捕获态」（全屏或画面聚焦）：main 会让本窗口的宿主快捷键让路
   * （`setIgnoreMenuShortcuts` + `before-input-event`）。
   *
   * 允许清单（Esc / F5 / F11 / F12 与开发者工具组合）的唯一来源是共享契约
   * `psbStreamCaptureIsPassthroughInput`：main 的抑制与渲染层的「不转发」都判它。
   * 退出全屏、页面卸载、窗口失焦时都要发 `active:false`（main 对失焦/隐藏/关闭另有兜底恢复；
   * 重新聚焦后需要再发一次 `active:true` 才会恢复独占）。
   */
  setAdminStreamCaptureActive(input: PsbWorkspaceAdminStreamCaptureRequest): Promise<void>;
  /**
   * 观看端绑定会话的串流事件；按 `viewerSessionId` 过滤。
   *
   * `sessionId` 正常是**桌面访问会话** id（PSB 工作区级 `stream/subscribe` 返回），旧 PSB 过渡
   * 回退时是内部 Agent 会话 id；字段名保持不变，渲染层只做「等值过滤」。
   */
  onAdminStreamEvent(handler: (event: PsbAdminStreamEvent) => void): () => void;
}

interface ElectronApiWithPsbRemote {
  readonly psbRemote?: PsbRemoteBridge;
}

/** 读 preload 桥；不存在时返回 `null`（渲染与单测用）。 */
export function tryGetPsbRemoteBridge(): PsbRemoteBridge | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { electronAPI?: ElectronApiWithPsbRemote }).electronAPI;
  return api?.psbRemote ?? null;
}

/**
 * 运行时探测桥上的某个方法是否存在（旧 preload / 单测替身可能只有一部分方法）。
 *
 * 管理页 / 交互串流的「此版本暂不支持」降级要逐个探方法，而不是只看对象在不在。
 * 探测只允许走这一个函数：调用点各自 `as unknown as Record<string, unknown>` 会绕开类型、
 * 也绕开对 `PsbRemoteBridge` 方法名的编译期约束。
 *
 * 返回值是**类型谓词**：`true` 时把可空桥收窄成非空（调用点因此可以写
 * `if (!psbBridgeHasMethod(bridge, 'x')) return; await bridge.x(...)`）。
 * 谓词只保证「桥存在且这个方法是函数」；其余方法的存在性由 `PsbRemoteBridge` 的静态契约
 * （preload 的返回类型注解）保证——运行期探针是给「旧 preload / 测试替身」的降级路径。
 */
export function psbBridgeHasMethod<K extends keyof PsbRemoteBridge>(
  bridge: PsbRemoteBridge | null | undefined,
  method: K,
): bridge is PsbRemoteBridge & Required<Pick<PsbRemoteBridge, K>> {
  if (!bridge) return false;
  return typeof (bridge as unknown as Record<string, unknown>)[method] === 'function';
}

/**
 * 取 preload 桥；不存在时抛出**可归因**的错误。
 *
 * 只在**用户显式动作**（点新建会话、点占用、点版本控制处置按钮）里用：那里必须给出一句
 * 可行动的失败，而不是静默什么都不发生。只读渲染路径用 {@link tryGetPsbRemoteBridge}。
 *
 * 错误文本带 `[PSB_REMOTE_BRIDGE_MISSING]` 前缀（稳定机器码，日志与错误上报可按它过滤）；
 * 不要再在调用点手写这句字符串。
 */
export function getPsbRemoteBridge(): PsbRemoteBridge {
  const bridge = tryGetPsbRemoteBridge();
  if (!bridge) {
    throw new Error('[PSB_REMOTE_BRIDGE_MISSING] the PSB remote workspace bridge is unavailable');
  }
  return bridge;
}
