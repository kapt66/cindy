/**
 * GhostConfirmDialogBridge —— confirm 槽的 main ↔ renderer 往返桥(2026-07-31)。
 *
 * confirm 槽要的是**答案**,而 notify 那条通道是单向的(broadcast 完就结束)。
 * 所以这里照 GhostGrantConfirmBridge 的成熟模式做一条带回执的往返:
 * main 铸一个 requestId → 投给 renderer → pending promise 挂起 → renderer 用
 * ConfirmDialogProvider 弹主机同款确认框 → 用户点击后经 IPC 回包 → settle。
 *
 * 与过户确认卡(GhostGrantConfirmBridge)的差别:
 *
 * 1. **本地模式广播投递,结算仍只认第一个答案**。过户确认卡是聊天流里的卡片,广播到
 *    多窗口再靠 DISMISSED 收卡没问题;模态确认框则只应该在用户看得见的地方出现。
 *    单窗口投递在 2026-11-19 用户复测里仍失败:框投到了用户没在看的完整会话副窗 /
 *    被遮挡的窗口 / 别的虚拟桌面,用户没看到、点不到,插件等到 90s 超时。现在把同一
 *    requestId 推给**所有能承载确认框的窗口**(主窗口 + `?secondaryWindow=1` 完整会话
 *    副窗),把"至少一处在用户眼前"的概率问题变成确定问题:
 *      - 当前聚焦的可承载窗口(没有则主窗口,再没有则第一个可承载窗口)先
 *        restore/show/focus + `moveTop()` + `flashFrame(true)`,保证至少一处在最前;
 *      - 其余窗口只 push,不抢焦点;
 *      - 桥以**第一次** resolve 为准(第一个用户点击/取消),结算时向**其它**已投窗口
 *        补发 `ghosts:confirm-dismissed` 收掉重复模态框;迟到的 resolve 一律
 *        `handled:false`(现有逻辑不变)。
 * 2. **不挂会话**。它可能来自面板点击、也可能来自工具调用链,不一定有 sessionId;
 *    清理靠超时与显式 cancelAll(窗口关闭/插件沉睡时调)。
 *
 * ## 目标窗口口径(2026-11-19 用户实测后补齐)
 *
 * confirm 宿主(`GhostConfirmDialogHost`)只挂在完整主壳 `main-entry → App.tsx` 上。
 * 右侧栏独立窗、资源用量窗、远程桌面查看器、utility 浮窗都是**轻量 renderer +
 * 专用 preload**,收不到 `ghosts:confirm-request`;投过去就是「小窗/白屏/点不到」。
 * 所以可投窗口由注入的 `isHostable` 判据决定(生产 =
 * `confirmDialogWindow.isModalConfirmHostWindow`)。辅助窗永远不投,宁可回 UNAVAILABLE
 * (明确区别于用户拒绝),也不把模态框塞进画不出来的窗口。
 *
 * ## ack 观测(只做诊断,不再改投)
 *
 * renderer 收到 push 的第一时间回一条 `acknowledge` IPC。广播已经把框送到所有可承载
 * 窗口,ack 不再触发「改投主窗口」,只用于:
 *  - 记 `ghost confirm: renderer ack`(哪个窗口、延迟多少);
 *  - 短窗口内**一个 ack 都没有**时,说明没有任何窗口画出框(渲染进程卡死/窗口在别的
 *    虚拟桌面无法绘制等)。此时把主窗口 bring to front + `flashFrame`,并记
 *    `ghost confirm: ack missing; forcing main window to front`——不改结算,最差仍是
 *    90s 超时按「没同意」。
 *
 * ## client-mode 口径
 *
 * Host 托管模式下 Host 没有 ack 端点,跨 client 窗口广播会把同一份 push 重复送到
 * Host 连接,所以 `bootstrap-electron.ts` 的 `onPluginPush` 保持**单窗口**投递
 * (`selectGhostConfirmWindow` 选出的主窗口/完整会话窗口),与本地模式的广播口径不同。
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
 * 一次已生效投递的收卡句柄。广播会让同一 requestId 出现在多个窗口,桥在 settle 时用
 * 它向**作答窗口以外**的已投窗口补发 dismissed,并给所有窗口停掉任务栏闪烁。
 */
export interface GhostConfirmDeliveredTarget {
  /** 该窗口的稳定标识(生产 = webContents.id);用来跳过已经作答的那个窗口。 */
  id: number;
  /** 从该窗口收起确认框(main → 该窗口一条 dismissed 推送)。 */
  dismiss(): void;
  /**
   * 停掉投递时开的任务栏闪烁(生产 = `flashFrame(false)`)。settle 时对**所有**已投
   * 窗口调用(含作答窗口),避免任务栏常亮。
   */
  stopAttention?(): void;
}

/**
 * 投递结果。
 *
 * `targets` = 本次成功投递到的全部窗口(按投递顺序)。桥记录它们,settle 时向**作答
 * 窗口以外**的窗口补发 dismissed;旧装配不给该字段时不做收卡,行为与旧版一致。
 */
export interface GhostConfirmDeliveryResult {
  delivered: boolean;
  targets?: GhostConfirmDeliveredTarget[];
}

export interface GhostConfirmDialogBridgeDeps {
  /**
   * 把确认框投给**所有可承载窗口**(本地模式广播)。返回 delivered:false = 没有可投
   * 的窗口(桥据此 reject,槽回 UNAVAILABLE,而不是谎报用户拒绝)。
   */
  sendToWindow(payload: GhostConfirmPush): GhostConfirmDeliveryResult;
  /**
   * ack 缺失时把主窗口带到可见前台(可选,生产注入 restore/show/focus + moveTop +
   * flashFrame)。只影响可见性,不结算本单。
   */
  raiseMainWindow?(requestId: string): void;
  /** 等 renderer「已收到」回执的窗口;缺省 GHOST_CONFIRM_ACK_TIMEOUT_MS。<=0 关闭。 */
  ackTimeoutMs?: number;
  /** 兜底超时;缺省 GHOST_CONFIRM_TIMEOUT_MS。测试注小值。 */
  timeoutMs?: number;
  now?(): number;
  log?: GhostConfirmWindowLog;
}

/**
 * confirm 宿主窗口的最小结构。`BrowserWindow` 结构化满足;单测给假对象即可,
 * 不用 mock Electron(与本模块 electron-free 的边界一致)。
 */
export interface GhostConfirmTargetWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  /** 把窗口提到同层最前(不改变焦点归属的补强)。 */
  moveTop(): void;
  /** 任务栏闪烁开关;投递时开,settle/dismiss 时关。 */
  flashFrame(flag: boolean): void;
}

type GhostConfirmWindowLog = {
  info?: (message: string, meta?: Record<string, unknown>) => void;
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
   * 本次投递窗口的收卡句柄(可选)。桥记录每一次成功投递;settle 时向**其余**已投窗口
   * 补发 dismissed,收起广播造成的重复模态框。缺省 = 不记录、不补发(旧装配/无收卡
   * 通道),不改答案。
   */
  deliveryTarget?(window: TWindow, payload: GhostConfirmPush): GhostConfirmDeliveredTarget | undefined;
  /** 诊断日志里的窗口 id(生产 = webContents.id)。缺省时用收卡句柄的 id。 */
  windowId?(window: TWindow): number;
  log?: GhostConfirmWindowLog;
}

/** 日志里只带最小关联信息,不带插件正文。 */
type GhostConfirmDeliveryLogContext = {
  requestId?: string;
  ghostId?: string;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readWindowState<TWindow extends GhostConfirmTargetWindow, T>(
  window: TWindow,
  read: (window: TWindow) => T,
): T | null {
  try {
    return read(window);
  } catch {
    return null;
  }
}

/**
 * 投递前把 confirm 的宿主窗口带到可见前台:最小化 → restore;未聚焦 → show、focus、
 * moveTop;并开任务栏闪烁(flashFrame)。已经聚焦且没最小化时整段跳过,不每次抢焦点
 * 造成抖动。每一步独立兜底:任何一步抛错只记 warn,继续后面的步骤与投递——投递成功
 * 才是这次调用的结果。
 *
 * 2026-11-19 用户复测:confirm 是**模态**确认框,用户切到别的应用/虚拟桌面时目标窗口
 * 不在前台,弹窗可能完全看不见,插件只能等到超时拿到 `confirmed:false`——看起来像
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
  // isFocused 读不出来时按"没聚焦"处理:宁可多做一次 show/focus,也要保证框在前台。
  if (readWindowState(window, (win) => win.isFocused()) === true) return;
  attempt('show host window', () => {
    window.show();
  });
  attempt('focus host window', () => {
    window.focus();
  });
  attempt('raise host window above other windows', () => {
    window.moveTop();
  });
  attempt('flash the host window', () => {
    window.flashFrame(true);
  });
}

function isUsableCandidate<TWindow extends GhostConfirmTargetWindow>(
  window: TWindow | null,
  candidates: Pick<GhostConfirmWindowCandidates<TWindow>, 'isHostable'>,
): window is TWindow {
  return Boolean(window && !window.isDestroyed() && candidates.isHostable(window));
}

/**
 * 选 confirm 的**置前窗口**(纯选窗,不投递)。
 *
 * 顺序:聚焦且可承载 → 主窗口 → 其它可承载的完整会话副窗 → null。
 *
 * 为什么聚焦优先:用户正看着的窗口弹模态框最不容易被忽略;但聚焦窗口必须是
 * **可承载**的——侧栏/资源用量/utility 窗虽然也可能拿到焦点,却画不出确认框。
 * 为什么主窗口排第二、而不是"第一个可承载窗口":getAllWindows() 的顺序是创建
 * 顺序而非用户注意力顺序,侧栏窗常常排在前面;主窗口是用户一定看得见的那扇。
 *
 * 本地模式用它选**唯一**被带到前台的窗口,其余可承载窗口只收 push(广播见
 * `createGhostConfirmWindowSender`);client-mode 仍用它做单窗口投递。
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

/** 把确认框投给一个已在广播名单里的窗口;失败只 warn + 返回 false(不抛)。 */
function deliverGhostConfirmDialog<TWindow extends GhostConfirmTargetWindow>(
  window: TWindow,
  payload: GhostConfirmPush,
  send: (window: TWindow, payload: GhostConfirmPush) => void,
  log?: GhostConfirmWindowLog,
  deliveryTarget?: (window: TWindow, payload: GhostConfirmPush) => GhostConfirmDeliveredTarget | undefined,
): { delivered: boolean; target?: GhostConfirmDeliveredTarget } {
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
 * 造 confirm 槽的 sendToWindow:**本地模式广播**。
 *
 * 1. 收集**所有可承载**窗口(排除侧栏/资源/远程查看器/utility 等轻量窗);
 * 2. 选一个置前窗口(聚焦可承载 → 主窗口 → 第一个可承载),只对它做
 *    restore/show/focus + moveTop + flashFrame(true);
 * 3. 其余可承载窗口只 push,不抢焦点;
 * 4. 每个成功投递的窗口登记收卡句柄,settle 时由桥收掉其它窗口的重复模态框。
 *
 * 可见性失败不改变 fail-closed:一个窗口都投不出去才回 delivered:false(桥据此
 * reject → 槽回 UNAVAILABLE,而不是谎报用户拒绝);可见性动作抛错只 warn,不阻断
 * 投递;部分窗口推送失败时只要至少一处投成功就继续(用户有地方可点)。
 */
export function createGhostConfirmWindowSender<TWindow extends GhostConfirmTargetWindow>(
  deps: GhostConfirmWindowSenderDeps<TWindow>,
): (payload: GhostConfirmPush) => GhostConfirmDeliveryResult {
  return (payload) => {
    const windows = deps.getAllWindows().filter((window) => isUsableCandidate(window, deps));
    if (windows.length === 0) {
      deps.log?.warn('ghost confirm: no host window to deliver the dialog', {
        ghostId: payload.ghostId,
        requestId: payload.requestId,
      });
      return { delivered: false };
    }
    const mainWindow = deps.getMainWindow();
    // 置前窗口:聚焦可承载 → 主窗口 → 第一个可承载。只带它到前台,不抢其它窗口焦点。
    const primary = selectGhostConfirmWindow(deps) ?? windows[0];
    revealGhostConfirmWindow(primary, payload, deps.log);

    const delivered: Array<{ window: TWindow; target?: GhostConfirmDeliveredTarget }> = [];
    for (const window of windows) {
      const { delivered: sent, target } = deliverGhostConfirmDialog(
        window, payload, deps.send, deps.log, deps.deliveryTarget,
      );
      if (sent) delivered.push({ window, target });
    }
    if (delivered.length === 0) return { delivered: false };

    const deliveredSet = new Set(delivered.map((entry) => entry.window));
    const windowId = (window: TWindow): number | null => {
      const target = delivered.find((entry) => entry.window === window)?.target;
      if (target) return target.id;
      try {
        return deps.windowId?.(window) ?? null;
      } catch {
        return null;
      }
    };
    deps.log?.info?.('ghost confirm: delivered', {
      ghostId: payload.ghostId,
      requestId: payload.requestId,
      windowCount: delivered.length,
      primary: windowId(primary),
      windows: windows.map((window) => ({
        id: windowId(window),
        isMain: window === mainWindow,
        visible: readWindowState(window, (win) => win.isVisible()),
        focused: readWindowState(window, (win) => win.isFocused()),
        minimized: readWindowState(window, (win) => win.isMinimized()),
        delivered: deliveredSet.has(window),
      })),
    });
    const targets = delivered
      .map((entry) => entry.target)
      .filter((target): target is GhostConfirmDeliveredTarget => target !== undefined);
    return { delivered: true, ...(targets.length > 0 ? { targets } : {}) };
  };
}

interface PendingConfirmEntry {
  ghostId: string;
  resolve: (confirmed: boolean) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  /** renderer「已收到」回执的诊断闹钟;回执到达/结算即清。 */
  ackTimeoutId?: ReturnType<typeof setTimeout>;
  /** 投递时刻(ms),用于算 ack 延迟。 */
  deliveredAt: number;
  /** 已回执的窗口 id;>0 表示至少一个窗口把框画出来了。 */
  ackedWindows: Set<number>;
  /** ack 闹钟已经触发过(用于日志区分迟到回执)。 */
  ackTimedOut: boolean;
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
      let outcome: GhostConfirmDeliveryResult;
      try {
        outcome = this.deps.sendToWindow(payload);
      } catch (error) {
        this.deps.log?.warn('ghost confirm: delivery threw; treated as unavailable', {
          ghostId: params.ghostId,
          requestId,
          err: describeError(error),
        });
        reject(new Error('没有可挂靠的宿主窗口'));
        return;
      }
      if (!outcome.delivered) {
        reject(new Error('没有可挂靠的宿主窗口'));
        return;
      }
      const now = this.deps.now ?? Date.now;
      const timeoutMs = this.deps.timeoutMs ?? GHOST_CONFIRM_TIMEOUT_MS;
      const timeoutId = setTimeout(() => {
        // 没人应答 = 没同意。日志留痕(带 ack 数),方便排查"插件说它问了但我没看到"。
        this.deps.log?.warn('ghost confirm timed out (treated as declined)', {
          ghostId: params.ghostId,
          requestId,
          ackCount: this.pending.get(requestId)?.ackedWindows.size ?? 0,
        });
        this.settle(requestId, false);
      }, timeoutMs);
      const entry: PendingConfirmEntry = {
        ghostId: params.ghostId,
        resolve,
        timeoutId,
        deliveredAt: now(),
        ackedWindows: new Set(),
        ackTimedOut: false,
        targets: new Map((outcome.targets ?? []).map((target) => [target.id, target])),
      };
      this.pending.set(requestId, entry);
      this.armAckObservation(requestId, entry);
    });
  }

  /**
   * renderer 回执:确认框已经在该窗口弹出来了(用户还没点)。
   *
   * 广播口径下 ack 只做诊断:记录哪个窗口、延迟多少;第一个 ack 取消「ack 缺失 → 把
   * 主窗口带到前台」的兜底。不结算本单——结算仍只看用户点击或 90s 超时。返回是否命中
   * 在途请求(陌生/迟到的回执直接忽略)。
   */
  acknowledge(requestId: string, ackedBy?: number): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    const now = this.deps.now ?? Date.now;
    if (ackedBy !== undefined) entry.ackedWindows.add(ackedBy);
    if (entry.ackTimeoutId !== undefined) {
      clearTimeout(entry.ackTimeoutId);
      entry.ackTimeoutId = undefined;
    }
    this.deps.log?.info?.('ghost confirm: renderer ack', {
      ghostId: entry.ghostId,
      requestId,
      windowId: ackedBy ?? null,
      latencyMs: Math.max(0, now() - entry.deliveredAt),
      ...(entry.ackTimedOut ? { afterAckTimeout: true } : {}),
    });
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
   * 短窗口内一个 renderer 回执都没有时的可见性兜底:把主窗口 bring to front +
   * flashFrame,并记 warn。广播已经覆盖所有可承载窗口,所以这里**不改投、不结算**;
   * 用户仍可从任一已投窗口作答,最差到 90s 超时按"没同意"。
   */
  private armAckObservation(requestId: string, entry: PendingConfirmEntry): void {
    const ackTimeoutMs = this.deps.ackTimeoutMs ?? GHOST_CONFIRM_ACK_TIMEOUT_MS;
    if (ackTimeoutMs <= 0) return;
    entry.ackTimeoutId = setTimeout(() => {
      entry.ackTimeoutId = undefined;
      if (!this.pending.has(requestId)) return;
      if (entry.ackedWindows.size > 0) return;
      entry.ackTimedOut = true;
      this.raiseMainWindow(requestId);
      this.deps.log?.warn('ghost confirm: ack missing; forcing main window to front', {
        ghostId: entry.ghostId,
        requestId,
        targetCount: entry.targets.size,
        windowIds: [...entry.targets.keys()],
        ackTimeoutMs,
      });
    }, ackTimeoutMs);
  }

  private raiseMainWindow(requestId: string): void {
    const raise = this.deps.raiseMainWindow;
    if (!raise) return;
    try {
      raise(requestId);
    } catch (error) {
      this.deps.log?.warn('ghost confirm: failed to force main window to front', {
        requestId,
        err: describeError(error),
      });
    }
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
    const dismissed = targets.filter((target) => target.id !== answeredBy);
    this.deps.log?.info?.('ghost confirm: settle', {
      ghostId: entry.ghostId,
      requestId,
      answeredBy: answeredBy ?? null,
      confirmed,
      dismissed: dismissed.length,
    });
    entry.resolve(confirmed);
    // 先结算答案、再收卡:收卡只是把重复/迟到的模态框拿掉,不参与答案计算。
    // 所有已投窗口都要停掉投递时开的任务栏闪烁;作答窗口不重复收 dismissed
    // (它的 pending 已先清掉,dismissed 是 no-op;跳过更省一次 IPC)。
    for (const target of targets) {
      try {
        target.stopAttention?.();
      } catch (error) {
        this.deps.log?.warn('ghost confirm: failed to stop the taskbar flash', {
          requestId,
          err: describeError(error),
        });
      }
    }
    for (const target of dismissed) {
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
