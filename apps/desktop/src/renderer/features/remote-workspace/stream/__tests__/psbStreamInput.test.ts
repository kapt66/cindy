/**
 * 测试价值
 * - 生产入口与可观察结果：`stream/psbStreamInput.ts`（「远程连接」页键鼠归一与合并器的唯一纯函数
 *   实现点）。可观察结果：
 *   ① `mapClientPointToRemote` 把浏览器坐标映射成远端屏幕像素，contain 黑边夹到画面边缘；
 *   ② `wheelToRemoteDeltas` 按 `deltaMode` 把行 / 页换算成 CSS 像素；
 *   ③ `keyboardToRemoteEvents` 忽略重复 keydown 与 IME 组合、保留修饰键与 `code`；
 *   ④ 全屏捕获允许清单（共享契约）只放行宿主自救键（Escape / F5 / F11 / F12 / 平台对应的
 *      开发者工具组合）；
 *   ⑤ `PsbStreamPressedState.releaseAllPayload` 在失焦 / 断连时补发 keyup 与 pointerup；
 *   ⑥ `PsbStreamInputPump` 一帧至多一条 pointermove，边沿事件立即发送且保序。
 * - Bug / 规则依据：用户 2026-11-26 口径「串流要像 PSB 网页一样可交互、全屏时键鼠不透传到宿主」；
 *   产品正本 `docs/product-rules/psb-remote-workspace-sessions.md` §2.4 / §6；协议
 *   `shared/psb-remote-workspace.ts` 与 PSB 网页观看端 `input.ts` / `input-capture.ts`。
 * - 现有覆盖缺口：此前串流只有观看、没有任何输入归一 / 释放 / 合并逻辑；本文件钉住坐标、滚轮、
 *   键盘、允许清单、释放与合并六类规则。
 * - 最小失败输入：黑边坐标发成 0,0 或越界；行模式滚轮漏乘 16；Ctrl+S 被当成宿主保留键；
 *   IME 组合期把拼音发给远端；失焦不补 keyup（远端卡键）；每个 pointermove 各发一帧。
 * - tier：unit（纯函数，node 环境）。
 */

import { describe, expect, it } from 'vitest';

import {
  PsbStreamInputPump,
  PsbStreamPressedState,
  fitContentIntoRect,
  isCapturePassthroughKey,
  keyboardToRemoteEvents,
  mapClientPointToRemote,
  pointerButtonEvent,
  pointerMoveEvent,
  releaseAllPayload,
  wheelEvent,
  wheelToRemoteDeltas,
  WHEEL_DELTA_MODE_LINE,
  WHEEL_DELTA_MODE_PAGE,
  WHEEL_DELTA_MODE_PIXEL,
  WHEEL_PIXELS_PER_LINE,
  type PsbStreamInputEvent,
  type PsbStreamPoint,
} from '../psbStreamInput';

/* ============================== 1. 坐标映射 ============================== */

describe('mapClientPointToRemote', () => {
  // 960×540 的显示区域里放 1920×1080 的远端画面：比例一致，没有黑边，坐标 ×2。
  const rect = { x: 0, y: 0, width: 960, height: 540 };
  const remote = { remoteWidth: 1920, remoteHeight: 1080 };

  it('maps the browser point onto remote screen pixels', () => {
    expect(
      mapClientPointToRemote({ clientX: 480, clientY: 270, canvasRect: rect, ...remote }),
    ).toEqual({ x: 960, y: 540 });
    expect(mapClientPointToRemote({ clientX: 0, clientY: 0, canvasRect: rect, ...remote })).toEqual(
      { x: 0, y: 0 },
    );
    // 右下角恰好等于远端尺寸时夹到「宽-1 / 高-1」：客户端按像素坐标从 0 开始注入。
    expect(
      mapClientPointToRemote({ clientX: 960, clientY: 540, canvasRect: rect, ...remote }),
    ).toEqual({ x: 1919, y: 1079 });
  });

  it('clamps points in the letterbox bars to the picture edge', () => {
    // 容器 1000×540（比画面宽）：1920×1080 的画面按高度铺满成 960×540，左右各 20px 黑边。
    const letterboxed = { x: 0, y: 0, width: 1000, height: 540 };
    // 左侧黑边里的点 → 远端 x=0（贴着画面左边缘，而不是停在黑边里）。
    expect(
      mapClientPointToRemote({ clientX: 5, clientY: 270, canvasRect: letterboxed, ...remote }),
    ).toEqual({ x: 0, y: 540 });
    // 右侧黑边里的点 → 远端 x=1919。
    expect(
      mapClientPointToRemote({ clientX: 995, clientY: 270, canvasRect: letterboxed, ...remote }),
    ).toEqual({ x: 1919, y: 540 });
    // 画面内容在容器里水平居中：容器 x=100、宽 1000 时内容从 120 开始。
    expect(
      mapClientPointToRemote({
        clientX: 120,
        clientY: 0,
        canvasRect: { x: 100, y: 10, width: 1000, height: 540 },
        ...remote,
      }),
    ).toEqual({ x: 0, y: 0 });
    // fitContentIntoRect 与映射用的是同一份布局：这里再钉一次居中结果。
    expect(
      fitContentIntoRect({ width: 1920, height: 1080 }, { x: 0, y: 0, width: 1000, height: 540 }),
    ).toEqual({ x: 20, y: 0, width: 960, height: 540 });
  });

  it('fills the whole rect when the picture is stretched (contain=false)', () => {
    // 拉伸模式下没有黑边：容器坐标线性映射到整个远端屏幕。
    expect(
      mapClientPointToRemote({
        clientX: 500,
        clientY: 270,
        canvasRect: { x: 0, y: 0, width: 1000, height: 540 },
        ...remote,
        contain: false,
      }),
    ).toEqual({ x: 960, y: 540 });
  });

  it('drops events instead of inventing 0,0 before the picture size is known', () => {
    expect(
      mapClientPointToRemote({
        clientX: 10,
        clientY: 10,
        canvasRect: rect,
        remoteWidth: 0,
        remoteHeight: 0,
      }),
    ).toBeNull();
    expect(
      mapClientPointToRemote({
        clientX: 10,
        clientY: 10,
        canvasRect: { x: 0, y: 0, width: 0, height: 0 },
        ...remote,
      }),
    ).toBeNull();
    expect(
      mapClientPointToRemote({ clientX: Number.NaN, clientY: 10, canvasRect: rect, ...remote }),
    ).toBeNull();
  });
});

/* ============================== 2. 滚轮 ============================== */

describe('wheelToRemoteDeltas', () => {
  const viewport = { width: 1000, height: 500 };

  it('passes pixel deltas through', () => {
    expect(
      wheelToRemoteDeltas({ deltaX: 12, deltaY: -40, deltaMode: WHEEL_DELTA_MODE_PIXEL }, viewport),
    ).toEqual({ deltaX: 12, deltaY: -40 });
  });

  it('converts line mode to pixels with the shared line height', () => {
    expect(
      wheelToRemoteDeltas({ deltaX: 0, deltaY: 3, deltaMode: WHEEL_DELTA_MODE_LINE }, viewport),
    ).toEqual({ deltaX: 0, deltaY: 3 * WHEEL_PIXELS_PER_LINE });
  });

  it('converts page mode to the viewport size', () => {
    expect(
      wheelToRemoteDeltas({ deltaX: 0, deltaY: 1, deltaMode: WHEEL_DELTA_MODE_PAGE }, viewport),
    ).toEqual({ deltaX: 0, deltaY: 500 });
    expect(
      wheelToRemoteDeltas({ deltaX: 2, deltaY: 0, deltaMode: WHEEL_DELTA_MODE_PAGE }, viewport),
    ).toEqual({ deltaX: 2000, deltaY: 0 });
  });

  it('never emits non-finite deltas', () => {
    expect(
      wheelToRemoteDeltas(
        { deltaX: Number.NaN, deltaY: Number.POSITIVE_INFINITY, deltaMode: WHEEL_DELTA_MODE_PIXEL },
        viewport,
      ),
    ).toEqual({ deltaX: 0, deltaY: 0 });
  });

  it('builds a wheel event with the pointer position in remote pixels', () => {
    expect(
      wheelEvent(
        { x: 806, y: 399 },
        { deltaX: 0, deltaY: 100, deltaMode: WHEEL_DELTA_MODE_PIXEL },
        viewport,
      ),
    ).toEqual({ kind: 'wheel', x: 806, y: 399, deltaX: 0, deltaY: 100 });
  });
});

/* ============================== 3. 键盘 ============================== */

describe('keyboardToRemoteEvents', () => {
  it('keeps key + code and forwards modifier keys on their own edges', () => {
    expect(keyboardToRemoteEvents({ type: 'keydown', key: 'a', code: 'KeyA' })).toEqual([
      { kind: 'keydown', key: 'a', code: 'KeyA' },
    ]);
    expect(keyboardToRemoteEvents({ type: 'keyup', key: 'a', code: 'KeyA' })).toEqual([
      { kind: 'keyup', key: 'a', code: 'KeyA' },
    ]);
    // 修饰键单独按下 / 抬起必须发：远端靠它判断「这一下是 Alt+左键」。
    expect(keyboardToRemoteEvents({ type: 'keydown', key: 'Shift', code: 'ShiftLeft' })).toEqual([
      { kind: 'keydown', key: 'Shift', code: 'ShiftLeft' },
    ]);
    // 旧环境没有 code：仍然发 key（协议里 code 可选）。
    expect(keyboardToRemoteEvents({ type: 'keydown', key: 'a' })).toEqual([
      { kind: 'keydown', key: 'a' },
    ]);
  });

  it('ignores key repeat and IME composition', () => {
    expect(
      keyboardToRemoteEvents({ type: 'keydown', key: 'a', code: 'KeyA', repeat: true }),
    ).toEqual([]);
    expect(
      keyboardToRemoteEvents({ type: 'keydown', key: 'a', code: 'KeyA', isComposing: true }),
    ).toEqual([]);
    expect(
      keyboardToRemoteEvents({ type: 'keydown', key: 'Process', code: 'KeyA', keyCode: 229 }),
    ).toEqual([]);
    // 组合期的 keyup 仍然返回事件：调用方按「是否记得按下过」决定发不发，避免远端卡键。
    expect(
      keyboardToRemoteEvents({ type: 'keyup', key: 'a', code: 'KeyA', isComposing: true }),
    ).toEqual([{ kind: 'keyup', key: 'a', code: 'KeyA' }]);
  });

  it('drops events without a usable key identity', () => {
    expect(keyboardToRemoteEvents({ type: 'keydown', key: '' })).toEqual([]);
    expect(keyboardToRemoteEvents({ type: 'keydown', key: 'Unidentified' })).toEqual([]);
    expect(keyboardToRemoteEvents({ type: 'keydown', key: 'Unidentified', code: 'KeyA' })).toEqual([
      { kind: 'keydown', key: 'Unidentified', code: 'KeyA' },
    ]);
  });
});

/* ============================== 4. 全屏捕获 ============================== */

describe('full-screen capture rules', () => {
  it('leaves only the host rescue shortcuts to the browser', () => {
    // 允许清单与 main 侧抑制共用共享契约 `psbStreamCaptureIsPassthroughInput`：
    // Escape（退出全屏）/ F5 / F11 / F12 + 平台对应的开发者工具组合。
    expect(isCapturePassthroughKey({ key: 'Escape', code: 'Escape' }, 'win32')).toBe(true);
    expect(isCapturePassthroughKey({ key: 'F5', code: 'F5' }, 'win32')).toBe(true);
    expect(isCapturePassthroughKey({ key: 'F11', code: 'F11' }, 'win32')).toBe(true);
    expect(isCapturePassthroughKey({ key: 'F12', code: 'F12' }, 'win32')).toBe(true);
    // 环境没有 code 时用 key 兜底，不能把 F5 当普通键转发给远端。
    expect(isCapturePassthroughKey({ key: 'F5' }, 'win32')).toBe(true);
    // 开发者工具组合（Windows/Linux Ctrl+Shift，macOS Cmd+Alt），修饰键必须完全一致。
    expect(
      isCapturePassthroughKey({ key: 'I', code: 'KeyI', ctrlKey: true, shiftKey: true }, 'win32'),
    ).toBe(true);
    expect(
      isCapturePassthroughKey({ key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true }, 'win32'),
    ).toBe(true);
    expect(
      isCapturePassthroughKey({ key: 'i', code: 'KeyI', metaKey: true, altKey: true }, 'darwin'),
    ).toBe(true);
    // 平台不匹配 / 修饰键多按一个：不算「留给宿主的自救键」。
    expect(
      isCapturePassthroughKey({ key: 'i', code: 'KeyI', metaKey: true, altKey: true }, 'win32'),
    ).toBe(false);
    expect(
      isCapturePassthroughKey({ key: 'I', code: 'KeyI', ctrlKey: true, shiftKey: true }, 'darwin'),
    ).toBe(false);
    // 普通组合键与单键都是远端输入，不属于允许清单。
    expect(isCapturePassthroughKey({ key: 's', code: 'KeyS', ctrlKey: true }, 'win32')).toBe(false);
    expect(isCapturePassthroughKey({ key: 'a', code: 'KeyA' }, 'win32')).toBe(false);
    expect(isCapturePassthroughKey({ key: 'Alt', code: 'AltLeft' }, 'win32')).toBe(false);
    // 只有 Ctrl 没有 Shift 的 Ctrl+I 不是开发者工具快捷键。
    expect(isCapturePassthroughKey({ key: 'i', code: 'KeyI', ctrlKey: true }, 'win32')).toBe(false);
  });

});

/* ============================== 5. 按下状态与全部释放 ============================== */

describe('pressed state and release-all', () => {
  it('releases every pressed key and mouse button at the last known position', () => {
    const pressed = new PsbStreamPressedState();
    pressed.keyDown({ key: 'Shift', code: 'ShiftLeft' });
    pressed.keyDown({ key: 'a', code: 'KeyA' });
    pressed.pointerDown(0);
    pressed.pointerDown(2);

    const events = pressed.releaseAllPayload({ x: 10, y: 20 });
    expect(events).toEqual([
      { kind: 'keyup', key: 'Shift', code: 'ShiftLeft' },
      { kind: 'keyup', key: 'a', code: 'KeyA' },
      { kind: 'pointerup', x: 10, y: 20, button: 0 },
      { kind: 'pointerup', x: 10, y: 20, button: 2 },
    ]);
    // 释放后记账清空：重复调用不会重发。
    expect(pressed.releaseAllPayload({ x: 10, y: 20 })).toEqual([]);
  });

  it('does not invent mouse releases before the remote position is known', () => {
    const pressed = new PsbStreamPressedState();
    pressed.keyDown({ key: 'Alt', code: 'AltLeft' });
    pressed.pointerDown(0);
    // 位置未知时只补键盘：位置错误的抬起比不补更糟。
    expect(pressed.releaseAllPayload(null)).toEqual([
      { kind: 'keyup', key: 'Alt', code: 'AltLeft' },
    ]);
    // 鼠标键也没有被静默清掉之外的副作用（清掉后下一次按下才重新记账）。
    expect(pressed.pressedButtonCount).toBe(0);
  });

  it('keeps keyboard state when only the pointer is cancelled', () => {
    const pressed = new PsbStreamPressedState();
    pressed.keyDown({ key: 'Ctrl', code: 'ControlLeft' });
    pressed.pointerDown(0);
    expect(pressed.releaseButtonsPayload({ x: 5, y: 6 })).toEqual([
      { kind: 'pointerup', x: 5, y: 6, button: 0 },
    ]);
    expect(pressed.hasKey({ key: 'Ctrl', code: 'ControlLeft' })).toBe(true);
  });

  it('tracks keys by physical code so left/right modifiers do not collide', () => {
    const pressed = new PsbStreamPressedState();
    pressed.keyDown({ key: 'Shift', code: 'ShiftLeft' });
    pressed.keyDown({ key: 'Shift', code: 'ShiftRight' });
    expect(pressed.pressedKeys.size).toBe(2);
    pressed.keyUp({ key: 'Shift', code: 'ShiftRight' });
    expect(pressed.releaseAllPayload({ x: 0, y: 0 })).toEqual([
      { kind: 'keyup', key: 'Shift', code: 'ShiftLeft' },
    ]);
  });

  it('exposes the standalone release payload for callers that keep their own state', () => {
    const keys = new Map([
      ['KeyA', { key: 'a', code: 'KeyA' }],
      ['ShiftLeft', { key: 'Shift', code: 'ShiftLeft' }],
    ]);
    const buttons = new Set([1]);
    expect(releaseAllPayload(keys, buttons, { x: 7, y: 8 })).toEqual([
      { kind: 'keyup', key: 'a', code: 'KeyA' },
      { kind: 'keyup', key: 'Shift', code: 'ShiftLeft' },
      { kind: 'pointerup', x: 7, y: 8, button: 1 },
    ]);
  });
});

/* ============================== 6. 合并器 ============================== */

/** 手工帧调度器：让测试自己决定什么时候跑 rAF。 */
function manualScheduler() {
  const pending: Array<{ callback: () => void }> = [];
  return {
    scheduler: {
      schedule: (callback: () => void) => {
        const entry = { callback };
        pending.push(entry);
        return () => {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
        };
      },
    },
    runFrame: () => {
      const current = pending.splice(0);
      for (const entry of current) entry.callback();
    },
    pendingCount: () => pending.length,
  };
}

describe('PsbStreamInputPump', () => {
  function createPump() {
    const sent: PsbStreamInputEvent[] = [];
    const frame = manualScheduler();
    const pump = new PsbStreamInputPump({
      send: (event) => sent.push(event),
      scheduler: frame.scheduler,
    });
    return { sent, pump, frame };
  }

  it('coalesces pointer moves into one event per frame and keeps the last position', () => {
    const { sent, pump, frame } = createPump();
    const points: PsbStreamPoint[] = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    for (const point of points) pump.queueMove(point);
    // 一帧内多次移动只排一次 rAF，且还没发出去。
    expect(frame.pendingCount()).toBe(1);
    expect(sent).toEqual([]);
    frame.runFrame();
    expect(sent).toEqual([pointerMoveEvent({ x: 3, y: 3 })]);
    // 帧内再移动会重新排一帧。
    pump.queueMove({ x: 4, y: 4 });
    expect(frame.pendingCount()).toBe(1);
    frame.runFrame();
    expect(sent).toEqual([pointerMoveEvent({ x: 3, y: 3 }), pointerMoveEvent({ x: 4, y: 4 })]);
  });

  it('sends edge events immediately and keeps ordering with the pending move', () => {
    const { sent, pump, frame } = createPump();
    pump.queueMove({ x: 9, y: 9 });
    // 键 / 鼠标边沿不能等下一帧：先冲刷待发移动，再立即发送按下。
    pump.sendEdge(pointerButtonEvent('pointerdown', { x: 9, y: 9 }, 0));
    expect(sent).toEqual([
      { kind: 'pointermove', x: 9, y: 9 },
      { kind: 'pointerdown', x: 9, y: 9, button: 0 },
    ]);
    // 已冲刷的移动不会再被这一帧重复发送。
    frame.runFrame();
    expect(sent).toHaveLength(2);
  });

  it('drops queued moves on clear and stops sending after dispose', () => {
    const { sent, pump, frame } = createPump();
    pump.queueMove({ x: 1, y: 1 });
    pump.clear();
    expect(pump.hasPendingMove).toBe(false);
    frame.runFrame();
    expect(sent).toEqual([]);
    pump.queueMove({ x: 2, y: 2 });
    pump.dispose();
    frame.runFrame();
    pump.sendEdge(pointerButtonEvent('pointerup', { x: 2, y: 2 }, 0));
    expect(sent).toEqual([]);
  });
});
