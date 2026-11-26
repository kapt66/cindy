/**
 * 「远程连接」画面的键鼠交互（PSB 网页串流观看端的等价实现）。
 *
 * ## 它做什么
 *
 * 在画面容器（stage）上监听 `pointer*` / `wheel` / `keydown` / `keyup`，把本地事件归一成 PSB
 * 观看端输入事件（归一逻辑全在 `stream/psbStreamInput.ts`），经**工作区级**
 * `adminStreamInput` 发到同一条串流 WS。
 *
 * ## 保序：移动合并 + 边沿立即发送
 *
 * 指针移动按 rAF 合并（一帧最多一条），但合并器 `PsbStreamInputPump` 是**唯一出口**：
 * 按下 / 抬起 / 滚轮 / 键盘这些边沿一律走 `pump.sendEdge()` —— 它先冲刷待发移动再发边沿，
 * 于是同一帧里「先移动到 (x,y)、再按下」不会被写成「先在旧位置按下、再移动」。
 * 直接 `sender.send` 边沿会绕过这层排序（2026-11-26 独立审查修复）。
 *
 * ## 模式（与 PSB 网页同一套产品模型）
 *
 * - **被动态**（不在全屏）：只在指针位于画面上、或画面自身持有焦点时转发。**不抢**宿主
 *   快捷键 —— 页面不能让用户在这里按不了 Ctrl+W / Cmd+Q 之类的应用快捷键。
 * - **捕获态**（`document.fullscreenElement === stage`）：键鼠一律转发并 `preventDefault()` /
 *   `stopPropagation()`（宿主自救键除外，见共享契约 `psbStreamCaptureIsPassthroughInput`），
 *   并在用户手势（点「全屏」）里尽力申请 Keyboard Lock；退出全屏 `unlock()`。同时经
 *   `setAdminStreamCaptureActive` 通知 main 让本窗口的宿主菜单快捷键让路（Electron 的
 *   accelerator 在 main 侧，渲染层拦不住）。不支持时静默降级。
 *
 * ## 释放策略（远端不卡键的全部理由）
 *
 * 远端（xdotool）只认「收到过 keydown 的键正在按下」这一份状态，浏览器不保证补发 keyup。
 * 以下时机一律补发 release-all：窗口失焦、`visibilitychange→hidden`、画面失焦、退出全屏、
 * 断连 / 停止串流、组件卸载。鼠标拖出画面靠 `setPointerCapture` 兜住 move / up。
 *
 * ## 鼠标不“透传”到宿主
 *
 * 命中画面时拦掉 `contextmenu` / `auxclick` / `dblclick` / `selectstart` / `dragstart` / `wheel`
 * 的默认行为（右键菜单、拖拽、双击选中、页面滚动都不该在远程画面上发生）。全屏时右下角退出按钮是画面里的
 * 本地 UI，点它仍然操作本地按钮（那是用户自己按的「退出全屏」，不能发给远端）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import {
  PsbStreamInputPump,
  PsbStreamPressedState,
  isCapturePassthroughKey,
  keyboardLockApiOf,
  keyboardToRemoteEvents,
  mapClientPointToRemote,
  pointerButtonEvent,
  wheelEvent,
  type PsbStreamInputEvent,
  type PsbStreamPoint,
} from '../stream/psbStreamInput';
import {
  createPsbStreamInputSender,
  tryGetAdminStreamCaptureBridge,
  tryGetAdminStreamInputBridge,
  type PsbStreamInputSender,
} from './psbAdminStreamInput';

/** Keyboard Lock 的三态（只用于界面提示；`unsupported` 不影响事件级捕获）。 */
export type PsbKeyboardLockState = 'off' | 'locked' | 'unsupported';

export interface PsbStreamInteractionInput {
  readonly workspaceId: string;
  readonly stageRef: RefObject<HTMLDivElement | null>;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  /** 已建立观看端订阅且有画面（首帧后）：只有这时才值得发输入。 */
  readonly streaming: boolean;
  /** 状态里的远端分辨率兜底；canvas 后备尺寸是当前帧的精确尺寸。 */
  readonly remoteSize: { readonly width: number | null; readonly height: number | null };
  /** 浏览器是否把 stage 全屏（`document.fullscreenElement === stage`）。 */
  readonly fullscreen: boolean;
  /**
   * 输入上行失败（IPC reject）：通常意味着观看端已断。调用方据此节流提示并让串流回到
   * 未启动态（r4 P2：旧实现静默吞掉，用户看到的是「鼠标不动了」）。
   */
  readonly onSendError?: (error: unknown) => void;
}

export interface PsbStreamInteraction {
  /** 输入通道 + 画面都就绪：界面显示「画面可操作」，键鼠会转发。 */
  readonly interactive: boolean;
  /** 全屏捕获态：键鼠全部转发到远端（宿主调试快捷键除外）。 */
  readonly capture: boolean;
  readonly keyboardLock: PsbKeyboardLockState;
  /**
   * 在**用户手势**里（点「全屏」且 `requestFullscreen()` 兑现后）申请 Keyboard Lock；
   * 重复调用幂等。不是手势的路径由 `fullscreen` 变化的 effect 重试一次。
   */
  readonly requestKeyboardLock: () => void;
}

/** 键盘锁定的申请 / 释放，静默失败（Firefox/Safari 没有这个 API，Chrome 也可能被策略拒绝）。 */
function navigatorLike(): unknown {
  return typeof navigator === 'undefined' ? null : navigator;
}

/**
 * 渲染层平台标识（`psbStreamCaptureIsPassthroughInput` 需要区分 macOS 的开发者工具组合）。
 *
 * 优先用 preload 注入的 `electronAPI.platform`；单测 / 旧 preload 没有它时按 userAgent 兜底。
 */
function rendererPlatform(): string {
  const injected =
    typeof window === 'undefined'
      ? undefined
      : (window as { readonly electronAPI?: { readonly platform?: string } }).electronAPI?.platform;
  if (injected === 'darwin' || injected === 'linux') return injected;
  if (injected === 'win32') return 'win32';
  if (typeof navigator !== 'undefined' && /Macintosh|Mac OS X/i.test(navigator.userAgent)) {
    return 'darwin';
  }
  return 'win32';
}

function releasePointerCaptureOf(stage: HTMLDivElement, pointerId: number | undefined): void {
  if (pointerId === undefined) return;
  if (typeof stage.releasePointerCapture !== 'function') return;
  try {
    stage.releasePointerCapture(pointerId);
  } catch {
    // 指针已经不在这条指针捕获里（浏览器在 pointerup 后自动释放）。
  }
}

export function usePsbStreamInteraction(input: PsbStreamInteractionInput): PsbStreamInteraction {
  const { workspaceId, stageRef, canvasRef, streaming, remoteSize, fullscreen } = input;
  // 工作区级输入桥：方法缺失（旧 preload / 通道未落地）→ 只读观看。
  const inputBridge = tryGetAdminStreamInputBridge();
  const captureBridge = tryGetAdminStreamCaptureBridge();
  const platform = rendererPlatform();
  const interactive = streaming && inputBridge !== null;
  /** 失败回调经 ref 取最新：发送器不因父组件重渲染重建（那会打断串行链）。 */
  const onSendErrorRef = useRef(input.onSendError);
  onSendErrorRef.current = input.onSendError;

  const [keyboardLock, setKeyboardLock] = useState<PsbKeyboardLockState>('off');
  const aliveRef = useRef(true);

  const pressedRef = useRef<PsbStreamPressedState | null>(null);
  if (pressedRef.current === null) pressedRef.current = new PsbStreamPressedState();
  const lastPointRef = useRef<PsbStreamPoint | null>(null);
  const senderRef = useRef<PsbStreamInputSender | null>(null);
  const pumpRef = useRef<PsbStreamInputPump | null>(null);

  // 事件处理器里读最新值，避免每次状态变化都重挂监听。
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const captureRef = useRef(interactive && fullscreen);
  captureRef.current = interactive && fullscreen;
  const remoteSizeRef = useRef(remoteSize);
  remoteSizeRef.current = remoteSize;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 发送器 + 合并器：桥存在时创建；切换工作区时重建。
  useEffect(() => {
    if (!inputBridge) return undefined;
    const sender = createPsbStreamInputSender({
      workspaceId,
      send: (payload) => inputBridge.adminStreamInput(payload),
      // 失败回调取 ref：发送器 effect 不因父组件回调身份变化重建（重建会丢已排队的释放事件）。
      onSendError: (error) => onSendErrorRef.current?.(error),
    });
    senderRef.current = sender;
    const pump = new PsbStreamInputPump({ send: (event) => sender.send(event) });
    pumpRef.current = pump;
    return () => {
      // 卸载（关页签 / 切工作区 / 切分类）时先补释放，再拆掉通道：否则远端会卡住按下的键。
      const pressed = pressedRef.current;
      if (pressed) {
        for (const event of pressed.releaseAllPayload(lastPointRef.current)) sender.send(event);
      }
      pump.dispose();
      sender.dispose();
      if (pumpRef.current === pump) pumpRef.current = null;
      if (senderRef.current === sender) senderRef.current = null;
    };
  }, [inputBridge, workspaceId]);

  /** 补发所有按下的键与鼠标键（幂等：记账为空时什么都不发）。 */
  const releaseAll = useCallback(() => {
    pumpRef.current?.clear();
    const sender = senderRef.current;
    const pressed = pressedRef.current;
    if (!sender || !pressed) return;
    for (const event of pressed.releaseAllPayload(lastPointRef.current)) sender.send(event);
  }, []);

  /** 全屏捕获态（键鼠全部属于远端）。 */
  const captureActive = interactive && fullscreen;

  /**
   * 通知 main「本窗口现在处于画面捕获态」：宿主菜单快捷键（Electron menu accelerator）在 main
   * 侧处理，渲染层的 `preventDefault` 拦不住，所以「全屏时键鼠不透传给宿主」必须两边一起做。
   *
   * 退出全屏 / 卸载 / 窗口失焦都发 `active:false`（main 对失焦 / 隐藏 / 关闭另有兜底恢复）。
   */
  useEffect(() => {
    if (!captureBridge) return undefined;
    const notify = (active: boolean): void => {
      void captureBridge
        .setAdminStreamCaptureActive({ active, workspaceId })
        .catch(() => undefined);
    };
    notify(captureActive);
    const onBlur = (): void => notify(false);
    const onFocus = (): void => {
      if (captureActive) notify(true);
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      if (captureActive) notify(false);
    };
  }, [captureActive, captureBridge, workspaceId]);

  // 指针事件 → 远端像素。容器矩形每次现取。
  //
  // 为什么不做 rect 缓存（2026-11-26 独立审查讨论项）：`getBoundingClientRect()` 在 Chromium 里
  // 读的是本帧已布局的结果（不是强制同步布局），指针事件回调里的开销是纳秒~微秒级；而缓存的
  // 失效点很多（窗口 resize、全屏切换、右侧栏折叠 / 拖宽、画面上方浮层变化），漏一个就会把
  // 指针映射到错误位置 —— 那是用户直接能感觉到的「点不准」。指针移动本身已由合并器压到
  // 「一帧至多一条上行」，这里的读取频率不构成上行压力。故保持每次现取，不做缓存。
  const pointFor = useCallback(
    (event: { readonly clientX: number; readonly clientY: number }): PsbStreamPoint | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const size = remoteSizeRef.current;
      const remoteWidth =
        size.width !== null && Number.isFinite(size.width) && size.width > 0
          ? size.width
          : canvas.width;
      const remoteHeight =
        size.height !== null && Number.isFinite(size.height) && size.height > 0
          ? size.height
          : canvas.height;
      return mapClientPointToRemote({
        clientX: event.clientX,
        clientY: event.clientY,
        canvasRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        remoteWidth,
        remoteHeight,
      });
    },
    [canvasRef],
  );

  // 指针 / 滚轮 / 键鼠监听：只有「可交互」时才挂（只读时不拦用户任何操作）。
  useEffect(() => {
    if (!interactive) return undefined;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return undefined;
    const pressed = pressedRef.current;
    if (!pressed) return undefined;

    /**
     * 边沿事件（按下 / 抬起 / 滚轮 / 键盘）一律经合并器发：`sendEdge` 会先冲刷待发移动再发边沿，
     * 保证同一帧里「移动到 (x,y) → 按下」的顺序不被打乱（直接 `sender.send` 会让 pointerdown
     * 抢在还没发出的 pointermove 前面，远端就在旧位置按下）。
     */
    const sendEdge = (event: PsbStreamInputEvent): void => {
      const pump = pumpRef.current;
      if (pump) pump.sendEdge(event);
      else senderRef.current?.send(event);
    };
    /** 事件是否发生在画面上（canvas 自身或舞台空白 / 黑边）。控制条等本地 UI 不算。 */
    const isPictureTarget = (target: EventTarget | null): boolean => {
      if (target === null) return false;
      return target === stageRef.current || target === canvasRef.current;
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (!interactiveRef.current || !isPictureTarget(event.target)) return;
      const point = pointFor(event);
      if (!point) return;
      // 让画面自己拿到焦点：被动态的键盘事件只转发给「画面持有焦点」的按键。
      try {
        stageRef.current?.focus({ preventScroll: true });
      } catch {
        // focus 被拒绝（元素已脱离文档）时不影响鼠标转发。
      }
      // 拦掉默认行为：文本选中、原生拖拽、双击选中都不该在远程画面上发生。
      event.preventDefault();
      if (event.pointerId !== undefined && typeof stage.setPointerCapture === 'function') {
        try {
          stage.setPointerCapture(event.pointerId);
        } catch {
          // 指针已经释放（jsdom / 极端时序）：拖出画面的事件由 window 监听兜住。
        }
      }
      lastPointRef.current = point;
      pressed.pointerDown(event.button);
      sendEdge(pointerButtonEvent('pointerdown', point, event.button));
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!interactiveRef.current) return;
      // 拖拽中（指针捕获后 target 会变成 stage）或指针在画面上才转发；掠过本地控制条不转发。
      if (!isPictureTarget(event.target) && pressed.pressedButtonCount === 0) return;
      const point = pointFor(event);
      if (!point) return;
      lastPointRef.current = point;
      pumpRef.current?.queueMove(point);
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (!interactiveRef.current) return;
      const tracked = pressed.pressedButtons.has(event.button);
      if (!tracked && !isPictureTarget(event.target)) return;
      const point = pointFor(event) ?? lastPointRef.current;
      pressed.pointerUp(event.button);
      if (point) {
        lastPointRef.current = point;
        sendEdge(pointerButtonEvent('pointerup', point, event.button));
      }
      releasePointerCaptureOf(stage, event.pointerId);
    };

    const onPointerCancel = (event: PointerEvent): void => {
      if (!interactiveRef.current) return;
      for (const payload of pressed.releaseButtonsPayload(lastPointRef.current)) {
        sendEdge(payload);
      }
      releasePointerCaptureOf(stage, event.pointerId);
    };

    const onWheel = (event: WheelEvent): void => {
      if (!interactiveRef.current || !isPictureTarget(event.target)) return;
      const point = pointFor(event);
      if (!point) return;
      // 命中画面时拦住宿主滚动 / 缩放：滚轮属于远端。
      event.preventDefault();
      lastPointRef.current = point;
      const rect = stage.getBoundingClientRect();
      sendEdge(
        wheelEvent(point, event, {
          width: Math.max(1, rect.width),
          height: Math.max(1, rect.height),
        }),
      );
    };

    /** 命中画面时拦掉宿主默认行为（右键菜单 / 拖拽 / 双击选中 / 选区）。 */
    const onBlockedGesture = (event: Event): void => {
      if (!interactiveRef.current || !isPictureTarget(event.target)) return;
      event.preventDefault();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!interactiveRef.current) return;
      const capture = captureRef.current;
      // 被动态：焦点必须在画面**本身**（焦点在控制条按钮上时键盘属于宿主）。
      if (!capture && document.activeElement !== stage) return;
      // IME 组合期的按键是本地输入法的中间状态：不发（也不拦，让候选窗走完）。
      if (event.isComposing || event.keyCode === 229) return;
      // 全屏捕获也要给用户留自救键（刷新 / 退出全屏 / 开发者工具）。
      if (capture && isCapturePassthroughKey(event, platform)) return;
      if (capture) {
        event.preventDefault();
        event.stopPropagation();
      }
      for (const next of keyboardToRemoteEvents({
        type: 'keydown',
        key: event.key,
        code: event.code,
        repeat: event.repeat,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
      })) {
        pressed.keyDown(next);
        sendEdge(next);
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (!interactiveRef.current) return;
      const capture = captureRef.current;
      const tracked = pressed.hasKey({ key: event.key, code: event.code });
      // 被动态焦点离开画面后，只有「我们记得按下过」的键还要把 keyup 送到远端（防卡键）。
      if (!capture && document.activeElement !== stage && !tracked) return;
      if (capture && isCapturePassthroughKey(event, platform)) return;
      if (capture) {
        event.preventDefault();
        event.stopPropagation();
      }
      const composing = event.isComposing || event.keyCode === 229;
      // 组合期开始前按下过的键：keyup 必须补发，否则远端一直按着它。
      if (composing && !tracked) return;
      for (const next of keyboardToRemoteEvents({
        type: 'keyup',
        key: event.key,
        code: event.code,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
      })) {
        pressed.keyUp(next);
        sendEdge(next);
      }
    };

    // 窗口失焦 / 页面隐藏：浏览器不会再补发 keyup，必须主动释放。
    const onWindowBlur = (): void => releaseAll();
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') releaseAll();
    };

    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('contextmenu', onBlockedGesture);
    stage.addEventListener('auxclick', onBlockedGesture);
    stage.addEventListener('dblclick', onBlockedGesture);
    stage.addEventListener('selectstart', onBlockedGesture);
    stage.addEventListener('dragstart', onBlockedGesture);
    // 拖出画面 / 在控制条上松开：pointerup 挂在 window 上才能收到（指针捕获之外的第二道保险）。
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    // 键盘用 document 捕获阶段：全屏时即使焦点被控制条拿走，键盘仍属于远端。
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stage.removeEventListener('pointerdown', onPointerDown);
      stage.removeEventListener('pointermove', onPointerMove);
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('contextmenu', onBlockedGesture);
      stage.removeEventListener('auxclick', onBlockedGesture);
      stage.removeEventListener('dblclick', onBlockedGesture);
      stage.removeEventListener('selectstart', onBlockedGesture);
      stage.removeEventListener('dragstart', onBlockedGesture);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [canvasRef, interactive, pointFor, releaseAll, stageRef]);

  // 画面失焦（被动态）：远端会以为按键一直按着，补释放。
  useEffect(() => {
    if (!interactive) return undefined;
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onFocusOut = (): void => {
      if (captureRef.current) return;
      releaseAll();
    };
    stage.addEventListener('focusout', onFocusOut);
    return () => stage.removeEventListener('focusout', onFocusOut);
  }, [interactive, releaseAll, stageRef]);

  // 断连 / 停止观看：输入通道不再可用，先补释放（否则远端卡键）。
  const previousInteractiveRef = useRef(interactive);
  useEffect(() => {
    if (previousInteractiveRef.current && !interactive) releaseAll();
    previousInteractiveRef.current = interactive;
  }, [interactive, releaseAll]);

  const unlockKeyboardLock = useCallback((): void => {
    const api = keyboardLockApiOf(navigatorLike());
    try {
      api?.unlock?.();
    } catch {
      // 宿主不支持 / 已解锁：忽略。
    }
    if (aliveRef.current) setKeyboardLock('off');
  }, []);

  const requestKeyboardLock = useCallback((): void => {
    if (typeof document === 'undefined' || document.fullscreenElement === null) return;
    const api = keyboardLockApiOf(navigatorLike());
    if (!api || typeof api.lock !== 'function') {
      if (aliveRef.current) setKeyboardLock('unsupported');
      return;
    }
    try {
      void api
        .lock()
        .then(() => {
          if (aliveRef.current) setKeyboardLock('locked');
        })
        .catch(() => {
          // 浏览器/策略拒绝：事件级捕获照旧生效，只降级提示。
          if (aliveRef.current) setKeyboardLock('unsupported');
        });
    } catch {
      if (aliveRef.current) setKeyboardLock('unsupported');
    }
  }, []);

  // 进入全屏：焦点回到画面（被动态判定与键盘事件都依赖它），并幂等重试 Keyboard Lock；
  // 退出全屏：补释放 + 解锁（Esc 退出全屏不经过我们的按钮，浏览器也不会补发 keyup）。
  const previousFullscreenRef = useRef(fullscreen);
  useEffect(() => {
    const wasFullscreen = previousFullscreenRef.current;
    previousFullscreenRef.current = fullscreen;
    if (fullscreen) {
      try {
        stageRef.current?.focus({ preventScroll: true });
      } catch {
        // 元素还没挂载 / 已移除：焦点留在原处不影响事件级捕获（document 监听）。
      }
      requestKeyboardLock();
      return;
    }
    if (wasFullscreen) {
      unlockKeyboardLock();
      releaseAll();
    }
  }, [fullscreen, releaseAll, requestKeyboardLock, stageRef, unlockKeyboardLock]);

  // 卸载：解锁（释放事件由发送器 effect 的 cleanup 补发）。
  useEffect(() => () => unlockKeyboardLock(), [unlockKeyboardLock]);

  return {
    interactive,
    capture: captureActive,
    keyboardLock,
    requestKeyboardLock,
  };
}
