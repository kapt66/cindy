/**
 * confirmDialogKeyboardGuard —— 「确认框是当前最顶层交互面」的键盘 / 焦点闸门。
 *
 * ## 为什么需要（2026-11-27 复测）
 *
 * PSB 远程工作区的**发送前占用预检**会在一次发送途中弹出 `useConfirmDialog` 的「占用工作区」
 * 确认框。它不是从某个按钮的点击里同步打开的：发送先清空并锁定 composer，预检读完 PSB 事实后
 * 才异步弹框。这段时间里 composer 的焦点恢复 / 编辑锁在来回切，确认框的 Radix 焦点陷阱只保证
 * `Tab` 不跑出去，并不接管 `keydown` 的默认行为。结果：用户按 `Enter` 取消确认框（AlertDialog
 * 默认焦点在「取消」）之后，这个 `Enter`（或紧接着的第二下）可能落到下面的编辑器里——编辑器
 * 把回车当普通输入（草稿多一行），或又走一遍发送（同一次取消后再弹一个框）。
 *
 * ## 两个闸门
 *
 * 1. **打开期间**：`Enter` / `Esc` 只允许落在确认框内部（`[role="alertdialog"]`）。落到别处的
 *    同名键由 provider 的 window capture listener `preventDefault + stopPropagation`，composer
 *    既不会发送、也不会落换行；这不是重做焦点陷阱，只是兜住「异步焦点恢复 / 陷阱没兜住」的竞态。
 * 2. **关闭之后**：用 **一次性 + 短窗口** 吞掉「用来关框的那个键」。窗口过后用户再按 `Enter`
 *    就是一次正常的新发送（工作区仍空闲时会再问一次，符合产品预期「确认前不占用」）。
 *
 * ## 边界
 *
 * - 窗口值只需覆盖「同一次按键的重复 / 紧随其后的第二下」，不改变用户正常节奏下的下一次发送。
 * - 只有 `Enter` / `Escape` 参与；输入法组字中的 `Enter`（选字）不拦，否则会把 IME 打断。
 * - 状态是模块级的：`ConfirmDialogProvider`（打开 / 关闭 / 记录关框键）与 composer 的焦点恢复
 *   hook（等待确认框彻底关闭再归还焦点）共享同一份事实。测试可
 *   `__resetConfirmDialogKeyboardGuardForTests()` 复位。
 */

/** 关闭确认框后吞掉同名键的窗口。 */
export const CONFIRM_DIALOG_DISMISS_KEY_GUARD_MS = 300;

/**
 * 「这个键算不算确认框的关框键」。把最后一次落在确认框内部的 Enter / Esc 记为关框键：
 * 只有它离真正关闭足够近时才算（避免「在框里按过 Enter 后改用鼠标取消」把鼠标取消也记成键盘关闭）。
 */
export const CONFIRM_DIALOG_DISMISS_KEY_RECENCY_MS = 500;

const DISMISS_KEYS: ReadonlySet<string> = new Set(['Enter', 'Escape']);

const settledListeners = new Set<() => void>();

let openDialogs = 0;
let lastDialogKey: { key: string; at: number } | null = null;
let suppressed: { key: string; until: number } | null = null;

/** 这个键是否属于确认框的「关框键」集合。 */
export function isConfirmDialogDismissKey(key: string): boolean {
  return DISMISS_KEYS.has(key);
}

/** 确认框已经展示（`ConfirmDialogProvider` 的 `processNext`）。 */
export function noteConfirmDialogOpened(): void {
  openDialogs += 1;
  // 新一轮确认自己接收键盘：上一轮残留的关闭键抑制不能带进来。
  suppressed = null;
  lastDialogKey = null;
}

/** 记录一个落在确认框内部的候选关框键（provider 的 window capture listener 调用）。 */
export function noteConfirmDialogDismissKey(key: string, now = Date.now()): void {
  if (!DISMISS_KEYS.has(key)) return;
  lastDialogKey = { key, at: now };
}

/**
 * 确认框彻底关闭（DOM 已卸载，`currentItem` 已清）。
 *
 * 若最后一次落在框内的键是「刚刚」按下的，就把同名键抑制一次性生效：关框那一下及其重复不能
 * 漏进 composer。鼠标 / 程序关闭（`lastDialogKey` 过期或从未有过）不抑制，用户的下一次 Enter
 * 照常发送。
 */
export function noteConfirmDialogSettled(now = Date.now()): void {
  openDialogs = Math.max(0, openDialogs - 1);
  const recentKey =
    lastDialogKey && now - lastDialogKey.at <= CONFIRM_DIALOG_DISMISS_KEY_RECENCY_MS
      ? lastDialogKey.key
      : null;
  lastDialogKey = null;
  suppressed = recentKey ? { key: recentKey, until: now + CONFIRM_DIALOG_DISMISS_KEY_GUARD_MS } : null;
  if (openDialogs !== 0) return;
  // 通知「确认框已彻底关闭」：composer 的焦点恢复会在这之后（下一帧）再试一次。
  for (const listener of [...settledListeners]) {
    try {
      listener();
    } catch {
      // 某个订阅者异常不应影响其它订阅者或 provider 收尾。
    }
  }
}

/** 当前是否还有确认框（含退场动画期间）。composer 的焦点恢复据此让路。 */
export function isConfirmDialogOpen(): boolean {
  return openDialogs > 0;
}

/** 订阅「确认框队列彻底关闭」。返回注销函数。 */
export function subscribeConfirmDialogSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
}

/**
 * 落在确认框**之外**的 Enter / Esc 是否应该被吞掉。
 *
 * provider 已确认目标不在 `[role="alertdialog"]` 内才调用这里：
 * - 有确认框打开 → 一律吞（顶层交互面是确认框）；
 * - 刚关闭且是关框键 → 一次性吞掉；
 * - 其余（无框、窗口过期、别的键、输入法组字）→ 放行。
 */
export function shouldSwallowOutsideConfirmDialogKey(
  event: Pick<KeyboardEvent, 'key' | 'isComposing'> & { keyCode?: number },
  now = Date.now(),
): boolean {
  if (!DISMISS_KEYS.has(event.key)) return false;
  if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) return false;
  if (openDialogs > 0) return true;
  if (!suppressed) return false;
  if (now > suppressed.until) {
    suppressed = null;
    return false;
  }
  if (suppressed.key !== event.key) return false;
  suppressed = null;
  return true;
}

/** 测试用：清空模块级状态（provider 换文件 / 用例之间不互相泄漏）。 */
export function __resetConfirmDialogKeyboardGuardForTests(): void {
  openDialogs = 0;
  lastDialogKey = null;
  suppressed = null;
  settledListeners.clear();
}
