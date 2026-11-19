/**
 * GhostConfirmDialogBridge —— confirm 槽的 main ↔ renderer 往返桥(2026-07-31)。
 *
 * confirm 槽要的是**答案**,而 notify 那条通道是单向的(broadcast 完就结束)。
 * 所以这里照 GhostGrantConfirmBridge 的成熟模式做一条带回执的往返:
 * main 铸一个 requestId → 投给 renderer → pending promise 挂起 → renderer 用
 * ConfirmDialogProvider 弹主机同款确认框 → 用户点击后经 IPC 回包 → settle。
 *
 * 与过户确认卡(GhostGrantConfirmBridge)的两处不同,都是刻意的:
 *
 * 1. **只投一个窗口,不 broadcast**。过户确认卡是聊天流里的卡片,广播到多窗口
 *    再靠 DISMISSED 收卡没问题;模态确认框广播出去会在每个窗口各弹一个、收回
 *    多份答案(preview 槽注释里踩过同类坑)。所以这里由 deps.sendToWindow 精确
 *    投递单个窗口,投不出去就 reject 让槽回 UNAVAILABLE。
 * 2. **不挂会话**。它可能来自面板点击、也可能来自工具调用链,不一定有 sessionId;
 *    清理靠超时与显式 cancelAll(窗口关闭/插件沉睡时调)。
 *
 * ## 目标窗口口径(2026-11-19 用户实测后补齐)
 *
 * confirm 宿主(`GhostConfirmDialogHost`)只挂在完整主壳 `main-entry → App.tsx` 上。
 * 右侧栏独立窗、资源用量窗、远程桌面查看器、utility 浮窗都是**轻量 renderer +
 * 专用 preload**,收不到 `ghosts:confirm-request`;投过去就是「小窗/白屏/点不到」,
 * 然后 90s 超时被误记成"用户拒绝"。所以选窗由注入的 `isHostable` 判据决定
 * (生产 = `confirmDialogWindow.isModalConfirmHostWindow`):
 *
 *   focused 且可承载 → 主窗口 → 其它可承载的完整会话副窗 → 都没有则 false
 *
 * 只有「主窗口 / `?secondaryWindow=1` 的完整会话副窗」可承载;辅助窗永远不投,
 * 宁可回 UNAVAILABLE(明确区别于用户拒绝),也不把模态框塞进画不出来的窗口。
 *
 * 投递后若 **短窗口**内没收到 renderer 的「已收到」回执(`acknowledge`,renderer
 * 在收到请求的第一时间回 IPC),且首次目标不是主窗口,则**改投主窗口一次**——
 * 避免选窗判据漏掉某个新窗口类型时白等 90s。改投失败不改变 fail-closed。
 *
 * 改投会让**同一个 requestId 短暂出现在两个窗口**。桥记录本次已投递的窗口;用户作答、
 * 兜底超时或清理时,向除作答窗口以外的已投窗口各补发一次 `ghosts:confirm-dismissed`
 * (本地模式由装配注入,按 `sendGhostWindowPush` 的单窗口口径推送,**不广播**),把迟到
 * 的第二个模态框收起。收卡只收 UI:迟到回包一律 `handled:false`,不改变已结算的答案,
 * 也绝不产生新的 `confirmed:true`。
 *
 * fail closed 是本模块的第一原则:超时、投递失败、回包形状非法、被清理,
 * 一律 resolve 成 false(没同意)。绝不把「问不出来」错当成「用户同意了」。
 *
 * 沙箱崩溃/离线的自动恢复**不在**本桥:90s 超时只说明没人回答,重启会再弹一个框。
 * 恢复在派发器(`pipeDispatcher.ts`):投递发现逻辑页离线时,在同一实例上做**一次**
 * 受控重启(单飞 + 冷却)后重投同一份卷子;失败仍回原 `GHOST_CRASHED`
 * (「电子脑离线,派发失败」),不无限重试、不把超时当同意。
 *
 * 本模块保持 electron-free(投递与选窗由外注入),单测直接 new。
 */

import { randomUUID } from 'node:crypto';

import { GHOST_CONFIRM_ACK_TIMEOUT_MS, GHOST_CONFIRM_TIMEOUT_MS } from '../../shared/ghost.js';

/** 推给 renderer 的确认框载荷(身份三件套由主机填,renderer 只负责画)。 */
export interface GhostConfirmPush {
  requestId: string;
  ghostId: string;
  ghostName: string;
  iconDataUrl?: string;
  body: string;
  /** null = renderer 用自己的缺省按钮文案(跟用户语言走)。 */
  confirmText: string | null;
  cancelText: string | null;
  danger: boolean;
}

/**
 * 一次已生效投递的收卡句柄。桥在 settle 时用它收起**其它**还没作答的窗口——8s 没
 * 回执会改投主窗口,原窗口只是慢/阻塞时同一 requestId 会在两个窗口各有一个模态框。
 */
export interface GhostConfirmDeliveredTarget {
  /** 该窗口的稳定标识(生产 = webContents.id);用来跳过已经作答的那个窗口。 */
  id: number;
  /** 从该窗口收起确认框(main → 该窗口一条 dismissed 推送)。 */
  dismiss(): void;
}

/**
 * 投递结果。
 *
 * `double-check`:`targetIsMainWindow` 让桥知道「ack 没到时还值不值得改投主窗口」
 * ——首次已经投在主窗口上就没有第二处可改投。旧装配(纯 boolean)按「已投主窗口」
 * 处理,即不改投,保持老行为。
 *
 * `target` = 本次投递落到哪个窗口(收卡句柄)。桥记录每次成功投递,settle 时据此向
 * 其余窗口补发 dismissed;旧装配不给该字段时不做收卡,行为与旧版一致。
 */
export interface GhostConfirmDeliveryResult {
  delivered: boolean;
  targetIsMainWindow: boolean;
  target?: GhostConfirmDeliveredTarget;
}

export type GhostConfirmSendOutcome = boolean | GhostConfirmDeliveryResult;

export interface GhostConfirmDialogBridgeDeps {
  /**
   * 把确认框投给**一个**窗口。返回 false(或 delivered:false)= 没有可投的窗口
   * (桥据此 reject,槽回 UNAVAILABLE,而不是谎报用户拒绝)。
   */
  sendToWindow(payload: GhostConfirmPush): GhostConfirmSendOutcome;
  /**
   * 短窗口内没收到 renderer 回执时改投主窗口一次(可选)。生产接线到
   * `createGhostConfirmMainWindowRedelivery`;未提供 = 不做回执改投,行为与旧版一致。
   */
  redeliverToMainWindow?(payload: GhostConfirmPush): GhostConfirmSendOutcome;
  /** 等 renderer 「已收到」回执的窗口;缺省 GHOST_CONFIRM_ACK_TIMEOUT_MS。<=0 关闭。 */
  ackTimeoutMs?: number;
  /** 兜底超时;缺省 GHOST_CONFIRM_TIMEOUT_MS。测试注小值。 */
  timeoutMs?: number;
  now?(): number;
  log?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/**
 * confirm 宿主窗口的最小结构。`BrowserWindow` 结构化满足;单测给假对象即可,
 * 不用 mock Electron(与本模块 electron-free 的边界一致)。
 */
export interface GhostConfirmTargetWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  isFocused(): boolean;
  focus(): void;
}

type GhostConfirmWindowLog = {
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

/** 选窗所需的三类候选 + 「能不能承载模态确认框」判据。 */
export interface GhostConfirmWindowCandidates<TWindow extends GhostConfirmTargetWindow> {
  getFocusedWindow(): TWindow | null;
  /** 应用主窗口(深链目标);侧栏/资源用量/utility 窗永远不是它。 */
  getMainWindow(): TWindow | null;
  getAllWindows(): TWindow[];
  /**
   * 这个窗口此刻能否承载模态确认框(生产 = isModalConfirmHostWindow:受信完整
   * 主壳 + 非辅助窗口)。判据不在本模块内,便于单测与 client-mode 复用。
   */
  isHostable(window: TWindow): boolean;
}

export interface GhostConfirmWindowSenderDeps<TWindow extends GhostConfirmTargetWindow>
  extends GhostConfirmWindowCandidates<TWindow> {
  send(window: TWindow, payload: GhostConfirmPush): void;
  /**
   * 本次投递窗口的收卡句柄(可选)。桥记录每一次成功投递;settle(用户作答/超时/
   * 清理)时向**其余**已投窗口补发 dismissed,收起 8s 改投造成的第二个模态框。
   * 缺省 = 不记录、不补发(旧装配/无收卡通道),不改答案。
   */
  deliveryTarget?(window: TWindow, payload: GhostConfirmPush): GhostConfirmDeliveredTarget | undefined;
  log?: GhostConfirmWindowLog;
}

export interface GhostConfirmMainWindowRedeliveryDeps<TWindow extends GhostConfirmTargetWindow> {
  getMainWindow(): TWindow | null;
  isHostable(window: TWindow): boolean;
  send(window: TWindow, payload: GhostConfirmPush): void;
  /** 同 `GhostConfirmWindowSenderDeps.deliveryTarget`:改投到的主窗口也要参与收卡。 */
  deliveryTarget?(window: TWindow, payload: GhostConfirmPush): GhostConfirmDeliveredTarget | undefined;
  log?: GhostConfirmWindowLog;
}

/** 回执/改投日志里只带最小关联信息,不带插件正文。 */
type GhostConfirmDeliveryLogContext = {
  requestId?: string;
  ghostId?: string;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 投递前把 confirm 的宿主窗口带到可见前台:最小化 → restore;未聚焦 → show、focus。
 * 每一步独立兜底:任何一步抛错只记 warn,继续后面的步骤与投递——投递成功才是这次
 * 调用的结果。已聚焦时整段跳过,不每次抢焦点造成抖动。
 *
 * 2026-11-19 用户实测:confirm 是**模态**确认框,用户切到别的应用时目标窗口不在
 * 前台,弹窗可能完全看不见,插件只能等到超时拿到 `confirmed:false`——看起来像
 * "用户取消",实际是"用户没看到"。notify 等广播**不**走这条路径。
 */
export function revealGhostConfirmWindow(
  window: GhostConfirmTargetWindow,
  context: GhostConfirmDeliveryLogContext,
  log?: GhostConfirmWindowLog,
): void {
  const attempt = (action: string, run: () => void): void => {
    try {
      run();
    } catch (error) {
      log?.warn(`ghost confirm: failed to ${action}; delivering anyway`, {
        ...context,
        err: describeError(error),
      });
    }
  };
  attempt('restore minimized host window', () => {
    if (window.isMinimized()) window.restore();
  });
  attempt('show host window', () => {
    if (!window.isFocused()) window.show();
  });
  attempt('focus host window', () => {
    if (!window.isFocused()) window.focus();
  });
}

function isUsableCandidate<TWindow extends GhostConfirmTargetWindow>(
  window: TWindow | null,
  candidates: Pick<GhostConfirmWindowCandidates<TWindow>, 'isHostable'>,
): window is TWindow {
  return Boolean(window && !window.isDestroyed() && candidates.isHostable(window));
}

/**
 * 选 confirm 的目标窗口(纯选窗,不投递)。
 *
 * 顺序:聚焦且可承载 → 主窗口 → 其它可承载的完整会话副窗 → null。
 *
 * 为什么聚焦优先:用户正看着的窗口弹模态框最不容易被忽略;但聚焦窗口必须是
 * **可承载**的——侧栏/资源用量/utility 窗虽然也可能拿到焦点,却画不出确认框。
 * 为什么主窗口排第二、而不是"第一个可承载窗口":getAllWindows() 的顺序是创建
 * 顺序而非用户注意力顺序,侧栏窗常常排在前面;主窗口是用户一定看得见的那扇。
 * client-mode 的同一判据见 bootstrap-electron 的 onPluginPush。
 */
export function selectGhostConfirmWindow<TWindow extends GhostConfirmTargetWindow>(
  candidates: GhostConfirmWindowCandidates<TWindow>,
): TWindow | null {
  const focused = candidates.getFocusedWindow();
  if (isUsableCandidate(focused, candidates)) return focused;
  const main = candidates.getMainWindow();
  if (isUsableCandidate(main, candidates)) return main;
  for (const window of candidates.getAllWindows()) {
    if (isUsableCandidate(window, candidates)) return window;
  }
  return null;
}

/** 把确认框带给一个已选定的窗口;失败只 warn + 回 delivered:false(不抛)。 */
function deliverGhostConfirmDialog<TWindow extends GhostConfirmTargetWindow>(
  window: TWindow,
  payload: GhostConfirmPush,
  send: (window: TWindow, payload: GhostConfirmPush) => void,
  log?: GhostConfirmWindowLog,
  deliveryTarget?: (window: TWindow, payload: GhostConfirmPush) => GhostConfirmDeliveredTarget | undefined,
): { delivered: boolean; target?: GhostConfirmDeliveredTarget } {
  revealGhostConfirmWindow(window, payload, log);
  try {
    send(window, payload);
  } catch (error) {
    log?.warn('ghost confirm: failed to push the dialog; treated as unavailable', {
      ghostId: payload.ghostId,
      requestId: payload.requestId,
      err: describeError(error),
    });
    return { delivered: false };
  }
  // 收卡句柄是投递的附属物:它抛错不能让一次已经投出去的确认框被报成"没投成"
  // (那会让槽回 UNAVAILABLE,而框还挂在窗口上)。
  let target: GhostConfirmDeliveredTarget | undefined;
  try {
    target = deliveryTarget?.(window, payload);
  } catch (error) {
    log?.warn('ghost confirm: failed to register the dismiss handle; duplicate dialogs will stay open', {
      ghostId: payload.ghostId,
      requestId: payload.requestId,
      err: describeError(error),
    });
  }
  return target ? { delivered: true, target } : { delivered: true };
}

/**
 * 造 confirm 槽的 sendToWindow:选一个可承载的窗口 → 带到可见前台 → 推送。
 *
 * 可见性失败不改变 fail-closed:选不到窗口、窗口已销毁、推送抛错都回 delivered:false
 * (桥据此 reject → 槽回 UNAVAILABLE,而不是谎报用户拒绝);可见性动作抛错只 warn,
 * 不阻断投递。`targetIsMainWindow` 供桥在收不到 renderer 回执时判断是否改投。
 */
export function createGhostConfirmWindowSender<TWindow extends GhostConfirmTargetWindow>(
  deps: GhostConfirmWindowSenderDeps<TWindow>,
): (payload: GhostConfirmPush) => GhostConfirmDeliveryResult {
  return (payload) => {
    const window = selectGhostConfirmWindow(deps);
    if (!window) {
      deps.log?.warn('ghost confirm: no host window to deliver the dialog', {
        ghostId: payload.ghostId,
        requestId: payload.requestId,
      });
      return { delivered: false, targetIsMainWindow: false };
    }
    const { delivered, target } = deliverGhostConfirmDialog(
      window, payload, deps.send, deps.log, deps.deliveryTarget,
    );
    // 主窗口身份用引用比较:选窗时取的就是同一个 BrowserWindow。
    const mainWindow = deps.getMainWindow();
    return {
      delivered,
      targetIsMainWindow: window === mainWindow,
      ...(target ? { target } : {}),
    };
  };
}

/**
 * 造「改投主窗口」回调:只投主窗口,主窗口不可承载时回 delivered:false(不再找第二个
 * 候选——第一次已经试过聚焦/其它窗口了,再扩散就是广播)。改投成功时同样带上收卡句柄,
 * 让桥在用户从原窗口作答时能收起主窗口上的重复框。
 */
export function createGhostConfirmMainWindowRedelivery<TWindow extends GhostConfirmTargetWindow>(
  deps: GhostConfirmMainWindowRedeliveryDeps<TWindow>,
): (payload: GhostConfirmPush) => GhostConfirmDeliveryResult {
  return (payload) => {
    const mainWindow = deps.getMainWindow();
    if (!isUsableCandidate(mainWindow, deps)) {
      deps.log?.warn('ghost confirm: main window cannot host the dialog; no redelivery', {
        ghostId: payload.ghostId,
        requestId: payload.requestId,
      });
      return { delivered: false, targetIsMainWindow: false };
    }
    const { delivered, target } = deliverGhostConfirmDialog(
      mainWindow, payload, deps.send, deps.log, deps.deliveryTarget,
    );
    return {
      delivered,
      targetIsMainWindow: true,
      ...(target ? { target } : {}),
    };
  };
}

interface PendingConfirmEntry {
  ghostId: string;
  resolve: (confirmed: boolean) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  /** renderer「已收到」回执的兜底闹钟;回执到达/结算即清。 */
  ackTimeoutId?: ReturnType<typeof setTimeout>;
  /** 本次已投递到的窗口(按 id 去重);settle 时只收**除作答窗口以外**的框。 */
  targets: Map<number, GhostConfirmDeliveredTarget>;
}

export class GhostConfirmDialogBridge {
  private readonly pending = new Map<string, PendingConfirmEntry>();

  constructor(private readonly deps: GhostConfirmDialogBridgeDeps) {}

  /**
   * 弹一个确认框并等答案。没有可投窗口时 reject(区别于「用户拒绝」)。
   * 其余一切异常路径都 resolve(false)。
   */
  request(params: Omit<GhostConfirmPush, 'requestId'>): Promise<boolean> {
    const requestId = randomUUID();
    const payload: GhostConfirmPush = { requestId, ...params };
    return new Promise<boolean>((resolve, reject) => {
      const outcome = this.deps.sendToWindow(payload);
      const delivered = typeof outcome === 'boolean' ? outcome : outcome.delivered;
      if (!delivered) {
        reject(new Error('没有可挂靠的宿主窗口'));
        return;
      }
      // 旧装配只有 boolean:无从知道目标是谁,按"已投主窗口"处理(不改投),行为不变。
      const targetIsMainWindow = typeof outcome === 'boolean' ? true : outcome.targetIsMainWindow;
      const firstTarget = typeof outcome === 'boolean' ? undefined : outcome.target;
      const timeoutMs = this.deps.timeoutMs ?? GHOST_CONFIRM_TIMEOUT_MS;
      const timeoutId = setTimeout(() => {
        // 没人应答 = 没同意。日志留痕,方便排查"插件说它问了但我没看到"。
        this.deps.log?.warn('ghost confirm timed out (treated as declined)', {
          ghostId: params.ghostId,
          requestId,
        });
        this.settle(requestId, false);
      }, timeoutMs);
      const entry: PendingConfirmEntry = {
        ghostId: params.ghostId,
        resolve,
        timeoutId,
        targets: new Map(firstTarget ? [[firstTarget.id, firstTarget]] : []),
      };
      this.pending.set(requestId, entry);
      this.armAckFallback(requestId, payload, entry, targetIsMainWindow);
    });
  }

  /**
   * renderer 回执:确认框已经在该窗口弹出来了(用户还没点)。
   *
   * 只负责取消「ack 超时改投主窗口」的兜底动作,不结算本单——结算仍只看用户点击
   * 或 90s 超时。返回是否命中在途请求(陌生/迟到的回执直接忽略)。
   */
  acknowledge(requestId: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    if (entry.ackTimeoutId !== undefined) {
      clearTimeout(entry.ackTimeoutId);
      entry.ackTimeoutId = undefined;
    }
    return true;
  }

  /**
   * renderer 回包。返回是否命中本桥的 pending(false = 陌生/已结算的 requestId,
   * 直接忽略——重复回包与伪造 id 都走这条,不抛)。
   * 非布尔的 confirmed 一律按 false 兜底,不让沙箱靠畸形回包骗到「同意」。
   *
   * `answeredBy` = 回包窗口的 webContents id(生产 IPC 直接取 event.sender.id):
   * settle 时跳过它、只收其它已投窗口的重复框;缺省 = 不知道是谁答的,收全部已投窗口
   * (作答窗口自己的 pending 已先清掉,dismissed 落在那边是 no-op)。
   */
  resolve(requestId: string, confirmed: unknown, answeredBy?: number): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    if (typeof confirmed !== 'boolean') {
      this.deps.log?.warn('ghost confirm: invalid decision shape, treated as declined', {
        requestId,
      });
    }
    this.settle(requestId, confirmed === true, answeredBy);
    return true;
  }

  /**
   * 清掉在途确认(窗口全关、插件沉睡/卸载时调):一律按「没同意」结算,
   * 免得插件那侧永久挂起。传 ghostId 只清该插件的。
   */
  cancelAll(ghostId?: string): void {
    for (const [requestId, entry] of Array.from(this.pending.entries())) {
      if (ghostId !== undefined && entry.ghostId !== ghostId) continue;
      this.settle(requestId, false);
    }
  }

  /** 在途单数(单测与诊断用)。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * 短窗口内没有 renderer 回执时的兜底:首次不是主窗口 → 改投主窗口一次。
   *
   * 这是 A 版选窗判据的补丁位:新窗口类型若没被判据覆盖,确认框可能投进一个
   * 画不出来的窗口。改投只做一次(不重挂闹钟),失败也不改变 fail-closed——
   * 用户仍可以通过原窗口作答,最差到 90s 超时按"没同意"。改投成功要把主窗口的
   * 收卡句柄记下来,否则用户从原窗口作答时主窗口上的重复框没人收。
   */
  private armAckFallback(
    requestId: string,
    payload: GhostConfirmPush,
    entry: PendingConfirmEntry,
    targetIsMainWindow: boolean,
  ): void {
    const redeliverToMainWindow = this.deps.redeliverToMainWindow;
    const ackTimeoutMs = this.deps.ackTimeoutMs ?? GHOST_CONFIRM_ACK_TIMEOUT_MS;
    if (!redeliverToMainWindow || ackTimeoutMs <= 0 || targetIsMainWindow) return;
    entry.ackTimeoutId = setTimeout(() => {
      entry.ackTimeoutId = undefined;
      if (!this.pending.has(requestId)) return;
      const outcome = redeliverToMainWindow(payload);
      const redelivered = typeof outcome === 'boolean' ? outcome : outcome.delivered;
      const target = typeof outcome === 'boolean' ? undefined : outcome.target;
      if (redelivered && target) entry.targets.set(target.id, target);
      this.deps.log?.warn('ghost confirm: no renderer ack; redelivered to main window', {
        ghostId: payload.ghostId,
        requestId,
        redelivered,
      });
    }, ackTimeoutMs);
  }

  private settle(requestId: string, confirmed: boolean, answeredBy?: number): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timeoutId);
    if (entry.ackTimeoutId !== undefined) {
      clearTimeout(entry.ackTimeoutId);
      entry.ackTimeoutId = undefined;
    }
    const targets = [...entry.targets.values()];
    entry.targets.clear();
    entry.resolve(confirmed);
    // 先结算答案、再收卡:收卡只是把迟到的第二个模态框拿掉,不参与答案计算。
    // 已经作答的窗口不重复收(它的 pending 已先清掉,dismissed 是 no-op;跳过更省一次
    // IPC)。收卡抛错只 warn,绝不能反噬已经结算的答案。
    for (const target of targets) {
      if (target.id === answeredBy) continue;
      try {
        target.dismiss();
      } catch (error) {
        this.deps.log?.warn('ghost confirm: failed to dismiss the duplicate dialog', {
          requestId,
          err: describeError(error),
        });
      }
    }
  }
}

let bridgeSingleton: GhostConfirmDialogBridge | null = null;

/**
 * 初始化单例(cindy-brain/index.ts 装配期调用,注入投递)。未初始化(极早期/
 * 单测环境)时 getter 返回 null,调用方按「确认通道未就绪」拒绝,不抛。
 */
export function initGhostConfirmDialogBridge(
  deps: GhostConfirmDialogBridgeDeps,
): GhostConfirmDialogBridge {
  bridgeSingleton = new GhostConfirmDialogBridge(deps);
  return bridgeSingleton;
}

export function getGhostConfirmDialogBridge(): GhostConfirmDialogBridge | null {
  return bridgeSingleton;
}
