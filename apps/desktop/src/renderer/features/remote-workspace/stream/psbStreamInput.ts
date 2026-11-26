/**
 * PSB 串流观看端的键鼠输入归一化：**纯函数 / 纯类，node 环境可单测**。
 *
 * ## 来源与边界（2026-11-26 用户口径：优先复用 PSB 网页串流逻辑）
 *
 * 迁移自 PSB 网页观看端，只保留与协议相关的规则，不引入 React / Tailwind / PSB token 依赖：
 *   - `project_steward_bot/packages/web/src/features/remote-clients/stream/input.ts`
 *     （坐标 / 滚轮 / 键盘归一 + rAF 合并器）；
 *   - `project_steward_bot/packages/web/src/features/remote-clients/stream/input-capture.ts`
 *     （全屏捕获策略 / 宿主允许清单 / 全部释放）。
 *
 * ## 协议（与 PSB 客户端注入侧约定，Cindy 只归一、不改写语义）
 *
 * 输入经**工作区级** `adminStreamInput({ workspaceId, event })` 发到同一条串流 WS；事件形状：
 *
 * ```json
 * { "kind": "pointermove", "x": 806, "y": 399 }
 * { "kind": "pointerdown", "x": 806, "y": 399, "button": 0 }
 * { "kind": "pointerup",   "x": 806, "y": 399, "button": 0 }
 * { "kind": "wheel",       "x": 806, "y": 399, "deltaX": 0, "deltaY": 100 }
 * { "kind": "keydown",     "key": "a", "code": "KeyA" }
 * { "kind": "keyup",       "key": "a", "code": "KeyA" }
 * ```
 *
 * - `x` / `y` 是**远端屏幕像素**（`0..宽-1` / `0..高-1`，与客户端 `xdotool mousemove` 同一坐标系）。
 *   浏览器先按 contain 布局把指针位置映射到「画面内容」（黑边夹到边缘），再乘远端像素尺寸 ——
 *   只有浏览器知道黑边多宽、画面缩了多少，客户端反推不出来。
 * - `button` 是 DOM `PointerEvent.button`（0 左 / 1 中 / 2 右），**不是** X11 按钮号（差 1），
 *   映射由客户端输入模块负责。
 * - `wheel` 的 `deltaX` / `deltaY` 是 **CSS 像素**（`deltaMode` 已换算：行 ×16、页 ×视口边长）；
 *   客户端按「一格 ≈ 100 像素」折成滚轮点击数（单次最多 10 格）。
 * - `keydown` / `keyup` 必须带 `key`，`code` 可选；IKE/IME 组合期不发，重复 keydown 忽略。
 * - 单帧 ≤ 4KiB：本模块产出的事件都只有几个字段，天然远低于上限。
 * - `relative`（相对位移）仍在 PSB 中继契约里，但观看端**不产生**（PSB 2026-11-26 已移除
 *   Pointer Lock，永远使用宿主指针），Cindy 跟随同一行为。
 *
 * ## 无法拦住的边界（写在这里，界面不要假装能拦）
 *
 * `Alt+Tab`、`Win`/`Meta`、`Ctrl+Alt+Del`、`Ctrl+Shift+Esc` 由操作系统先处理；全屏下 `Esc`
 * 由浏览器占用（退出全屏）。Keyboard Lock 只能锁「浏览器愿意交出来的键」，边界由宿主系统决定。
 */

import { psbStreamCaptureIsPassthroughInput } from '../../../../shared/psb-workspace-admin';

/* ============================== 1. 坐标映射 ============================== */

/** 远端屏幕像素坐标（整数）。 */
export interface PsbStreamPoint {
  readonly x: number;
  readonly y: number;
}

export interface PsbStreamSize {
  readonly width: number;
  readonly height: number;
}

/** 与 `DOMRect` 同形的矩形（`getBoundingClientRect()` 的直接投影，测试可传纯对象）。 */
export interface PsbStreamRect extends PsbStreamPoint, PsbStreamSize {}

/** 只取指针事件里用得到的两个字段（`PointerEvent` / `WheelEvent` / `MouseEvent` 都满足）。 */
export interface PsbStreamClientPoint {
  readonly clientX: number;
  readonly clientY: number;
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** 把数值夹到 0..1；非有限数按 0 处理。 */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 画面内容（按自身宽高比）在矩形里**等比居中**后的位置与尺寸（contain 布局的黑边由此产生）。
 *
 * 与 PSB 网页的 `fitFrameIntoViewport` 同一算法；尺寸非法时返回零矩形，由调用方丢弃事件。
 */
export function fitContentIntoRect(content: PsbStreamSize, viewport: PsbStreamRect): PsbStreamRect {
  if (
    !isPositive(content.width) ||
    !isPositive(content.height) ||
    !isPositive(viewport.width) ||
    !isPositive(viewport.height)
  ) {
    return { x: viewport.x, y: viewport.y, width: 0, height: 0 };
  }
  const scale = Math.min(viewport.width / content.width, viewport.height / content.height);
  const width = content.width * scale;
  const height = content.height * scale;
  return {
    x: viewport.x + (viewport.width - width) / 2,
    y: viewport.y + (viewport.height - height) / 2,
    width,
    height,
  };
}

/** 归一化坐标（0..1）→ 远端屏幕像素整数，夹到 `[0, 宽-1] × [0, 高-1]`。 */
function unitToRemotePixels(unit: number, size: number): number {
  const pixels = Math.max(0, Math.floor(size));
  if (pixels <= 0) return 0;
  return Math.min(pixels - 1, Math.max(0, Math.round(unit * pixels)));
}

/**
 * 浏览器视口坐标 → **远端屏幕像素**（`null` = 此刻没有可换算的目标坐标系，调用方丢弃事件）。
 *
 * 黑边上的点夹到画面边缘（0 或 1），这是远端的正常语义：光标贴着画面边缘，而不是停在黑边里。
 * 画面尺寸还没到（首帧之前 / 容器未布局）时返回 `null`，绝不发 `0,0`。
 *
 * @param input.canvasRect 画面容器的视口矩形（通常直接传 `canvas.getBoundingClientRect()`）。
 * @param input.remoteWidth `remoteHeight` 远端屏幕像素尺寸（PSB 状态里的分辨率，或当前帧尺寸）。
 * @param input.contain 默认 `true`（等比铺满、其余为黑边）；`false` 表示画面被拉伸填满容器。
 */
export function mapClientPointToRemote(input: {
  readonly clientX: number;
  readonly clientY: number;
  readonly canvasRect: PsbStreamRect;
  readonly remoteWidth: number;
  readonly remoteHeight: number;
  readonly contain?: boolean;
}): PsbStreamPoint | null {
  const { clientX, clientY, canvasRect, remoteWidth, remoteHeight } = input;
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  if (!isPositive(remoteWidth) || !isPositive(remoteHeight)) return null;
  if (!isPositive(canvasRect.width) || !isPositive(canvasRect.height)) return null;
  if (!Number.isFinite(canvasRect.x) || !Number.isFinite(canvasRect.y)) return null;

  const content =
    input.contain === false
      ? { x: canvasRect.x, y: canvasRect.y, width: canvasRect.width, height: canvasRect.height }
      : fitContentIntoRect({ width: remoteWidth, height: remoteHeight }, canvasRect);
  if (!isPositive(content.width) || !isPositive(content.height)) return null;

  return {
    x: unitToRemotePixels(clampUnit((clientX - content.x) / content.width), remoteWidth),
    y: unitToRemotePixels(clampUnit((clientY - content.y) / content.height), remoteHeight),
  };
}

/* ============================== 2. 滚轮归一 ============================== */

/** DOM `WheelEvent.deltaMode` 三档（显式写常量，避免在 node 测试里依赖 `WheelEvent` 全局）。 */
export const WHEEL_DELTA_MODE_PIXEL = 0;
export const WHEEL_DELTA_MODE_LINE = 1;
export const WHEEL_DELTA_MODE_PAGE = 2;

/** 行模式换算成一行的像素数（Chrome / Firefox 常见行高，取折中值）。 */
export const WHEEL_PIXELS_PER_LINE = 16;

/**
 * 滚轮增量 → CSS 像素。
 *
 * 浏览器允许以「像素 / 行 / 页」三种单位上报；直接把 `deltaY` 当像素会在触控板（行模式）上
 * 偏小一个数量级。页模式按视口边长换算。
 *
 * @param viewport 画面容器（stage）的 CSS 像素尺寸；页模式用它折算一页。
 */
export function wheelToRemoteDeltas(
  event: { readonly deltaX: number; readonly deltaY: number; readonly deltaMode: number },
  viewport: PsbStreamSize,
): { readonly deltaX: number; readonly deltaY: number } {
  let scaleX = 1;
  let scaleY = 1;
  if (event.deltaMode === WHEEL_DELTA_MODE_LINE) {
    scaleX = WHEEL_PIXELS_PER_LINE;
    scaleY = WHEEL_PIXELS_PER_LINE;
  } else if (event.deltaMode === WHEEL_DELTA_MODE_PAGE) {
    scaleX = Math.max(1, viewport.width);
    scaleY = Math.max(1, viewport.height);
  }
  return {
    deltaX: Number.isFinite(event.deltaX) ? event.deltaX * scaleX : 0,
    deltaY: Number.isFinite(event.deltaY) ? event.deltaY * scaleY : 0,
  };
}

/* ============================== 3. 事件形状 ============================== */

/**
 * 归一化后的输入事件。字段按 `kind` 取用，与 PSB 中继的 `event` 负载同构。
 *
 * 用 type alias（而不是 interface）以便直接作为 `Record<string, unknown>` 的 IPC 载荷。
 */
export type PsbStreamPointerMoveEvent = {
  readonly kind: 'pointermove';
  readonly x: number;
  readonly y: number;
};

export type PsbStreamPointerButtonEvent = {
  readonly kind: 'pointerdown' | 'pointerup';
  readonly x: number;
  readonly y: number;
  /** DOM `PointerEvent.button`（0 左 / 1 中 / 2 右），客户端负责映射成 X11 按钮号。 */
  readonly button: number;
};

export type PsbStreamWheelEvent = {
  readonly kind: 'wheel';
  readonly x: number;
  readonly y: number;
  /** CSS 像素（`deltaMode` 已换算）；客户端按 100px ≈ 1 格折算。 */
  readonly deltaX: number;
  readonly deltaY: number;
};

export type PsbStreamKeyboardEvent = {
  readonly kind: 'keydown' | 'keyup';
  readonly key: string;
  /** 物理键位（`KeyboardEvent.code`）；环境不给时省略。 */
  readonly code?: string;
};

export type PsbStreamInputEvent =
  | PsbStreamPointerMoveEvent
  | PsbStreamPointerButtonEvent
  | PsbStreamWheelEvent
  | PsbStreamKeyboardEvent;

/** 指针移动事件（远端屏幕像素）。 */
export function pointerMoveEvent(point: PsbStreamPoint): PsbStreamPointerMoveEvent {
  return { kind: 'pointermove', x: point.x, y: point.y };
}

/** 指针按下 / 抬起；`button` 原样透传 DOM 的 0/1/2。 */
export function pointerButtonEvent(
  kind: 'pointerdown' | 'pointerup',
  point: PsbStreamPoint,
  button: number,
): PsbStreamPointerButtonEvent {
  return { kind, x: point.x, y: point.y, button };
}

/** 滚轮事件：`deltaX/deltaY` 换算成 CSS 像素，`x/y` 是滚轮发生处的远端屏幕像素。 */
export function wheelEvent(
  point: PsbStreamPoint,
  event: { readonly deltaX: number; readonly deltaY: number; readonly deltaMode: number },
  viewport: PsbStreamSize,
): PsbStreamWheelEvent {
  const deltas = wheelToRemoteDeltas(event, viewport);
  return { kind: 'wheel', x: point.x, y: point.y, deltaX: deltas.deltaX, deltaY: deltas.deltaY };
}

/* ============================== 4. 键盘归一 ============================== */

/** 只取键盘事件里用得到的字段（`KeyboardEvent` 满足这个结构）。 */
export interface PsbStreamKeyboardEventLike {
  readonly type: 'keydown' | 'keyup';
  readonly key: string;
  readonly code?: string;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
  /** Chromium 在 IME 组合期把 keyCode 置 229；缺 `isComposing` 的环境用它兜底。 */
  readonly keyCode?: number;
}

/**
 * 键盘事件 → 归一化事件列表（`[]` = 这一下不转发）。
 *
 * - **重复 keydown 忽略**：远端只需要「按下」这一条边沿，`xdotool` 的按键状态不会因为重复而改变。
 * - **IME 组合期不发**：组合中的按键是本地输入法的中间状态，发给远端只会打出乱码。
 * - `key` 为空 / `Unidentified` 且没有 `code` 时不发（环境没给出可用的键身份）。
 * - 修饰键（Shift / Ctrl / Alt / Meta）单独按下、抬起都照发：远端要靠它们判断「这一下是 Alt+左键」。
 *
 * 与 PSB 网页唯一的差异在 keyup：组合期的 keyup **仍然发出**。本地输入法只决定 keydown 不发，
 * 若对应 keydown 之前已经发过（例如组合开始前按住的修饰键），丢掉 keyup 会让远端一直按着它。
 * 是否真的发 keyup 由调用方按「事件是否在按下状态」再筛一次（见 `PsbStreamPressedState`）。
 */
export function keyboardToRemoteEvents(
  event: PsbStreamKeyboardEventLike,
): PsbStreamKeyboardEvent[] {
  if (event.key === '') return [];
  const code = typeof event.code === 'string' && event.code.length > 0 ? event.code : undefined;
  if (event.type === 'keydown') {
    if (event.isComposing === true || event.keyCode === 229) return [];
    if (event.repeat === true) return [];
  }
  if (event.key === 'Unidentified' && code === undefined) return [];
  return [
    code === undefined
      ? { kind: event.type, key: event.key }
      : { kind: event.type, key: event.key, code },
  ];
}

/* ============================== 5. 全屏捕获策略 ============================== */

/**
 * 捕获态下这个按键是否要**留给宿主**（不转发、不 `preventDefault`）。
 *
 * 允许清单的**唯一来源**是共享契约 `psbStreamCaptureIsPassthroughInput`
 * （`shared/psb-workspace-admin.ts`）：main 侧抑制宿主快捷键与渲染层「不转发」用的是同一个
 * 函数，避免「哪一侧漏拦取决于谁先改」。清单内容（`Escape` / `F5` / `F11` / `F12` 与平台对应的
 * 开发者工具组合）由共享契约维护，这里不重复抄写。
 *
 * 注意 `Escape` 也在清单里：全屏下它由浏览器 / Electron 消费（退出全屏），即使我们不拦，
 * 事件也不会到页面；放行它比「转发给远端 + 让宿主管」更符合用户预期。
 *
 * @param platform `'darwin'` / `'win32'` / `'linux'`（开发者工具组合的修饰键按平台不同）。
 */
export function isCapturePassthroughKey(
  event: {
    readonly key?: string;
    readonly code?: string;
    readonly ctrlKey?: boolean;
    readonly altKey?: boolean;
    readonly metaKey?: boolean;
    readonly shiftKey?: boolean;
  },
  platform: string,
): boolean {
  return psbStreamCaptureIsPassthroughInput(
    {
      key: typeof event.key === 'string' ? event.key : '',
      code: typeof event.code === 'string' ? event.code : '',
      meta: event.metaKey === true,
      control: event.ctrlKey === true,
      alt: event.altKey === true,
      shift: event.shiftKey === true,
    },
    platform,
  );
}

/* ============================== 6. Keyboard Lock ============================== */

/**
 * Keyboard Lock API 的最小形状。`lib.dom.d.ts` 未收录 `navigator.keyboard`，这里做结构性声明，
 * 由调用方传 `navigator` 进来；字段全可选，Firefox / Safari / 拒绝策略都要能静默降级。
 */
export interface KeyboardLockApi {
  readonly lock?: () => Promise<void>;
  readonly unlock?: () => void;
}

/** 取 `navigator.keyboard`（结构不成立时返回 `null`，不抛异常）。 */
export function keyboardLockApiOf(navigatorLike: unknown): KeyboardLockApi | null {
  if (typeof navigatorLike !== 'object' || navigatorLike === null) return null;
  const keyboard = (navigatorLike as { readonly keyboard?: unknown }).keyboard;
  if (typeof keyboard !== 'object' || keyboard === null) return null;
  return keyboard as KeyboardLockApi;
}

/* ============================== 7. 按下状态与全部释放 ============================== */

/** 记录一个已发过 keydown 的键身份（`code` 优先，环境不给时用 `key`）。 */
export interface PsbStreamPressedKey {
  readonly key: string;
  readonly code?: string;
}

/** 键身份：`code`（物理键位）优先；左右修饰键只有 code 能区分。 */
export function pressedKeyId(event: { readonly key: string; readonly code?: string }): string {
  const code = typeof event.code === 'string' && event.code.length > 0 ? event.code : undefined;
  return code ?? event.key;
}

/**
 * 「全部释放」载荷：把当前按下的键与鼠标键拼成一批 `keyup` / `pointerup`。
 *
 * 为什么必须有它：远端（xdotool 注入）只认「收到过 keydown 的键正在按下」这一份状态，浏览器
 * 不保证在失焦 / 退出全屏 / 断线 / 卸载时补发 keyup。少了这一批，远端会**卡住** Alt / Ctrl /
 * 左键，表现为「Unity 一直在旋转 / 一直在框选」。
 *
 * - 键：按 `pressedKeys` 里的身份逐个补 `keyup`；
 * - 鼠标：没有可换算的远端坐标（首帧还没到）时**不补** pointerup —— 位置错误的抬起比不补更糟。
 */
export function releaseAllPayload(
  pressedKeys: ReadonlyMap<string, PsbStreamPressedKey>,
  pressedButtons: ReadonlySet<number>,
  at: PsbStreamPoint | null,
): PsbStreamInputEvent[] {
  const events: PsbStreamInputEvent[] = [];
  for (const pressed of pressedKeys.values()) {
    events.push(
      pressed.code === undefined
        ? { kind: 'keyup', key: pressed.key }
        : { kind: 'keyup', key: pressed.key, code: pressed.code },
    );
  }
  if (at === null) return events;
  for (const button of pressedButtons) {
    events.push({ kind: 'pointerup', x: at.x, y: at.y, button });
  }
  return events;
}

/**
 * 本地「哪些键 / 鼠标键还按着」的记账（纯类，可单测）。
 *
 * 用途：① 失焦 / 退出全屏 / 断连时补发释放；② keyup 在焦点已经离开画面后仍然能送达远端；
 * ③ 重复 keydown 不重复发送（`keyboardToRemoteEvents` 已过滤 repeat，这里再兜一层状态幂等）。
 */
export class PsbStreamPressedState {
  private readonly keys = new Map<string, PsbStreamPressedKey>();
  private readonly buttons = new Set<number>();

  keyDown(event: PsbStreamPressedKey): void {
    const id = pressedKeyId(event);
    if (!this.keys.has(id)) this.keys.set(id, { key: event.key, code: event.code });
  }

  keyUp(event: PsbStreamPressedKey): void {
    this.keys.delete(pressedKeyId(event));
  }

  hasKey(event: PsbStreamPressedKey): boolean {
    return this.keys.has(pressedKeyId(event));
  }

  pointerDown(button: number): void {
    this.buttons.add(button);
  }

  pointerUp(button: number): void {
    this.buttons.delete(button);
  }

  get pressedKeys(): ReadonlyMap<string, PsbStreamPressedKey> {
    return this.keys;
  }

  get pressedButtons(): ReadonlySet<number> {
    return this.buttons;
  }

  get pressedButtonCount(): number {
    return this.buttons.size;
  }

  /** 只释放鼠标键（`pointercancel` 用；键盘状态保持）。 */
  releaseButtonsPayload(at: PsbStreamPoint | null): PsbStreamInputEvent[] {
    const events = releaseAllPayload(new Map(), this.buttons, at);
    this.buttons.clear();
    return events;
  }

  /** 释放全部并清空记账。 */
  releaseAllPayload(at: PsbStreamPoint | null): PsbStreamInputEvent[] {
    const events = releaseAllPayload(this.keys, this.buttons, at);
    this.clear();
    return events;
  }

  clear(): void {
    this.keys.clear();
    this.buttons.clear();
  }
}

/* ============================== 8. 指针移动合并器（rAF） ============================== */

/** 一帧调度器：返回取消函数。默认用 `requestAnimationFrame`（≈60Hz），没有时退 setTimeout。 */
export interface PsbStreamFrameScheduler {
  schedule(callback: () => void): () => void;
}

/**
 * 默认帧调度：`requestAnimationFrame` 一帧最多跑一次（≤ 屏幕刷新率，常规 60Hz）。
 * 无 rAF 的环境（个别测试 / 老 WebView）退化为 16ms 定时器，行为一致。
 */
export const psbStreamBrowserFrameScheduler: PsbStreamFrameScheduler = {
  schedule(callback) {
    if (typeof requestAnimationFrame === 'function') {
      const handle = requestAnimationFrame(() => callback());
      return () => cancelAnimationFrame(handle);
    }
    const handle = setTimeout(callback, 16);
    return () => clearTimeout(handle);
  },
};

/**
 * 指针移动合并器：**一帧至多一条 pointermove，边沿事件立即发送且保序**。
 *
 * 60Hz 鼠标在 120Hz 屏上会在一帧里产生多个 `pointermove`；每个都发一条 WS 文本帧，中继与
 * 客户端注入侧都要多处理一次，而人眼只看到一帧。位置是幂等的，所以只保留最后一个，在
 * `requestAnimationFrame` 里一次性发出。按键边沿（down / up / wheel / keydown / keyup）**不能
 * 合并**：先冲刷掉待发移动，再按到达顺序立即发送，保证「先移动到位再按下」的顺序不被打乱。
 */
export class PsbStreamInputPump {
  private move: PsbStreamPoint | null = null;
  private cancelFrame: (() => void) | null = null;
  private disposed = false;
  private readonly send: (event: PsbStreamInputEvent) => void;
  private readonly scheduler: PsbStreamFrameScheduler;

  constructor(options: {
    readonly send: (event: PsbStreamInputEvent) => void;
    readonly scheduler?: PsbStreamFrameScheduler;
  }) {
    this.send = options.send;
    this.scheduler = options.scheduler ?? psbStreamBrowserFrameScheduler;
  }

  /** 记录一次绝对位置（同一帧内覆盖）；首次进入本帧时排一次 rAF。 */
  queueMove(point: PsbStreamPoint): void {
    if (this.disposed) return;
    this.move = point;
    if (this.cancelFrame !== null) return;
    this.cancelFrame = this.scheduler.schedule(() => {
      this.cancelFrame = null;
      this.flushMove();
    });
  }

  /** 立即发送边沿事件（先冲刷待发移动，保证顺序）。 */
  sendEdge(event: PsbStreamInputEvent): void {
    if (this.disposed) return;
    this.flushMove();
    this.send(event);
  }

  /** 取走并发送本帧的待发移动（没有则什么都不做）。 */
  flushMove(): void {
    const point = this.move;
    this.move = null;
    if (point === null) return;
    this.send(pointerMoveEvent(point));
  }

  /** 丢弃待发移动（失焦 / 释放全部时旧位置已经没有意义）。 */
  clear(): void {
    this.move = null;
    this.cancelFrame?.();
    this.cancelFrame = null;
  }

  get hasPendingMove(): boolean {
    return this.move !== null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
  }
}
