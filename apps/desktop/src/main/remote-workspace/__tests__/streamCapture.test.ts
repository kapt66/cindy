/**
 * 串流观看端「画面捕获态」的宿主快捷键抑制与恢复（`streamCapture.ts`）。
 *
 * 测试价值
 * - 生产入口与可观察结果：`createPsbStreamCaptureController().setActive(...)` 是 main 在
 *   全屏/画面聚焦时让宿主快捷键让路的唯一状态机（生产接线在 `streamCaptureRuntime.ts`）。
 *   可观察结果是：`setIgnoreMenuShortcuts` 的开关、`before-input-event` 里哪些按键被
 *   `preventDefault()`、以及失焦/页面消失后是否**恢复原状**。
 * - Bug／规则依据：用户要求「全屏时键鼠事件不允许透传到宿主」（PSB 协作需求 2026-11-26
 *   12:5xZ 新需求 1）。Electron 里菜单 accelerator 在 renderer 收到按键之前分发，只能在 main
 *   拦；保留键（Esc / F5 / F11 / F12 / 开发者工具）与渲染层共用共享判定
 *   `psbStreamCaptureIsPassthroughInput`（产品口径见 `docs/product-rules/psb-remote-workspace-sessions.md`
 *   §2.4「全屏 = 远端独占键鼠」）。
 * - 现有覆盖缺口：`remote-desktop-viewer` 的 `setInputCaptured` 只管它自己的独立窗口，
 *   工作区页签是**主窗口内的页面**，此前没有任何 main 侧抑制；也没有用例覆盖「恢复路径」。
 * - 最小失败输入：捕获态下按 Ctrl+W / Ctrl+Shift+R（旧行为会关页签 / 刷新页面）；窗口 blur 后
 *   仍保持 `setIgnoreMenuShortcuts(true)`（用户退出全屏后快捷键永久失效）；拦掉 F5 / 开发者
 *   工具组合（用户失去自救路径）。
 * - tier：unit（假 hooks，无 Electron / 无真实窗口）。
 * - 实测耗时：单文件 `<1s`（含 vitest 启动）。
 */

import { describe, expect, it } from 'vitest';

import type { AppShortcutCombo } from '../../../shared/appShortcuts';
import { psbStreamCaptureIsPassthroughInput } from '../../../shared/psb-workspace-admin';
import {
  createPsbStreamCaptureController,
  psbStreamCaptureExtraHostCombos,
  psbStreamCaptureShouldSuppressInput,
  type PsbStreamCaptureHooks,
  type PsbStreamCaptureInput,
} from '../streamCapture';

/* ============================== fixtures ============================== */

function combo(
  code: string,
  modifiers: Partial<Pick<AppShortcutCombo, 'meta' | 'ctrl' | 'alt' | 'shift'>> = {},
): AppShortcutCombo {
  return { code, meta: false, ctrl: false, alt: false, shift: false, ...modifiers };
}

function key(code: string, modifiers: Partial<PsbStreamCaptureInput> = {}): PsbStreamCaptureInput {
  return {
    type: 'keyDown',
    key: code,
    code,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...modifiers,
  };
}

/** 假的 `webContents` 接线面：记录开关与拦截结果，并能模拟失焦 / 页面消失。 */
function createFakeHooks() {
  const state = {
    ignoreMenuShortcuts: [] as boolean[],
    preventDefaults: [] as string[],
    guardInstalled: 0,
    guardRemoved: 0,
    resetInstalled: 0,
    resetRemoved: 0,
    inactiveInstalled: 0,
    inactiveRemoved: 0,
    /** 当前生效的按键拦截（null = 没有监听）。 */
    guard: null as null | ((input: PsbStreamCaptureInput) => boolean),
    resetListeners: [] as Array<() => void>,
    inactiveListeners: [] as Array<() => void>,
  };

  const hooks: PsbStreamCaptureHooks = {
    installInputGuard(shouldSuppress) {
      state.guardInstalled += 1;
      state.guard = shouldSuppress;
      return () => {
        state.guardRemoved += 1;
        state.guard = null;
      };
    },
    onSenderReset(listener) {
      state.resetInstalled += 1;
      state.resetListeners.push(listener);
      return () => {
        state.resetRemoved += 1;
        const index = state.resetListeners.indexOf(listener);
        if (index >= 0) state.resetListeners.splice(index, 1);
      };
    },
    onWindowInactive(listener) {
      state.inactiveInstalled += 1;
      state.inactiveListeners.push(listener);
      return () => {
        state.inactiveRemoved += 1;
        const index = state.inactiveListeners.indexOf(listener);
        if (index >= 0) state.inactiveListeners.splice(index, 1);
      };
    },
    setIgnoreMenuShortcuts(ignore) {
      state.ignoreMenuShortcuts.push(ignore);
    },
  };

  return {
    hooks,
    state,
    /** 模拟一条 `before-input-event`：返回是否被 `preventDefault()`（也计入 preventDefaults）。 */
    fire(input: PsbStreamCaptureInput): boolean {
      const suppressed = state.guard?.(input) === true;
      if (suppressed) state.preventDefaults.push(input.code);
      return suppressed;
    },
    /** 模拟窗口 blur / hide。 */
    windowInactive(): void {
      for (const listener of [...state.inactiveListeners]) listener();
    },
    /** 模拟 webContents 销毁 / 渲染进程崩溃 / 主 frame 导航。 */
    senderReset(): void {
      for (const listener of [...state.resetListeners]) listener();
    },
  };
}

const registryCombos: AppShortcutCombo[] = [
  combo('KeyW', { ctrl: true }), // close-tab-or-window (win/linux)
  combo('KeyN', { ctrl: true }), // new-maker
  combo('KeyR', { ctrl: true }), // browser-reload (mod+R)
  combo('Equal', { ctrl: true }), // zoom-in
];

function createHarness(options: { platform?: string; combos?: AppShortcutCombo[] } = {}) {
  const fake = createFakeHooks();
  let combos = options.combos ?? registryCombos;
  const controller = createPsbStreamCaptureController({
    platform: options.platform ?? 'win32',
    collectHostCombos: () => combos,
  });
  return {
    controller,
    fake,
    setCombos(next: AppShortcutCombo[]): void {
      combos = next;
    },
    activate(active = true, workspaceId: string | null = null): void {
      controller.setActive({
        key: 7,
        hooks: fake.hooks,
        active,
        workspaceId,
      });
    },
  };
}

/* ============================== 状态机 ============================== */

describe('串流捕获态：进入 / 退出', () => {
  it('进入即关闭菜单 accelerator；退出恢复，且不再拦截按键', () => {
    const harness = createHarness();

    harness.activate();
    expect(harness.controller.isActive(7)).toBe(true);
    expect(harness.fake.state.ignoreMenuShortcuts).toEqual([true]);
    expect(harness.fake.state.guardInstalled).toBe(1);

    harness.activate(false);
    expect(harness.controller.isActive(7)).toBe(false);
    expect(harness.fake.state.ignoreMenuShortcuts).toEqual([true, false]);
    expect(harness.fake.state.guardRemoved).toBe(1);
    // 卸载后按键流回 renderer：不再 preventDefault。
    expect(harness.fake.fire(key('KeyW', { control: true }))).toBe(false);
  });

  it('同态重复调用是幂等的（不重复挂监听、不重复开关）', () => {
    const harness = createHarness();
    harness.activate();
    harness.activate();

    expect(harness.fake.state.guardInstalled).toBe(1);
    expect(harness.fake.state.ignoreMenuShortcuts).toEqual([true]);
    expect(harness.controller.activeKeys()).toEqual([7]);

    // 未激活时退出也是 no-op。
    harness.controller.setActive({ key: 99, hooks: harness.fake.hooks, active: false });
    expect(harness.fake.state.ignoreMenuShortcuts).toEqual([true]);
  });

  it('dispose 释放全部捕获态（进程退出 / 账号边界）', () => {
    const harness = createHarness();
    harness.activate();

    harness.controller.dispose();

    expect(harness.controller.isActive(7)).toBe(false);
    expect(harness.fake.state.ignoreMenuShortcuts).toEqual([true, false]);
  });

  it('窗口失焦 / 隐藏 → 自动恢复原状', () => {
    const harness = createHarness();
    harness.activate();

    harness.fake.windowInactive();

    expect(harness.controller.isActive(7)).toBe(false);
    expect(harness.fake.state.ignoreMenuShortcuts).toEqual([true, false]);
    expect(harness.fake.state.guardRemoved).toBe(1);
    expect(harness.fake.state.inactiveRemoved).toBe(1);
  });

  it('页面消失（销毁 / 崩溃 / 主 frame 导航）→ 自动恢复原状', () => {
    const harness = createHarness();
    harness.activate();

    harness.fake.senderReset();

    expect(harness.controller.isActive(7)).toBe(false);
    expect(harness.fake.state.ignoreMenuShortcuts).toEqual([true, false]);
    expect(harness.fake.state.resetRemoved).toBe(1);
  });

  it('进入失败时回滚，不留「只抑制、没恢复路径」的半态', () => {
    const fake = createFakeHooks();
    const failing: PsbStreamCaptureHooks = {
      ...fake.hooks,
      installInputGuard: () => {
        throw new Error('webContents gone');
      },
    };
    const controller = createPsbStreamCaptureController({
      platform: 'win32',
      collectHostCombos: () => registryCombos,
    });

    expect(() => controller.setActive({ key: 3, hooks: failing, active: true })).toThrow(
      'webContents gone',
    );
    expect(controller.isActive(3)).toBe(false);
    // 回滚路径也把「忽略菜单快捷键」恢复成 false（此时还没置 true，但必须显式恢复一次，
    // 避免接线实现把 true 放在 guard 之前时留下永久抑制）。
    expect(fake.state.ignoreMenuShortcuts.at(-1)).toBe(false);
  });
});

/* ============================== 按键判定 ============================== */

describe('串流捕获态：哪些按键让路', () => {
  it('registry 里的宿主快捷键被拦（Ctrl+W / Ctrl+N / Ctrl+=）', () => {
    const harness = createHarness();
    harness.activate();

    expect(harness.fake.fire(key('KeyW', { control: true }))).toBe(true);
    expect(harness.fake.fire(key('KeyN', { control: true }))).toBe(true);
    expect(harness.fake.fire(key('Equal', { control: true }))).toBe(true);
    // keyUp 同样拦：菜单 accelerator 在 keyDown 就分发，但按键抬起也不该漏给宿主。
    expect(harness.fake.fire({ ...key('KeyW', { control: true }), type: 'keyUp' })).toBe(true);
  });

  it('用户改绑后立刻以新组合判定（不拿窗口创建时的旧快照）', () => {
    const harness = createHarness();
    harness.activate();
    expect(harness.fake.fire(key('KeyK', { control: true }))).toBe(false);

    harness.setCombos([combo('KeyK', { ctrl: true })]);

    expect(harness.fake.fire(key('KeyK', { control: true }))).toBe(true);
    expect(harness.fake.fire(key('KeyW', { control: true }))).toBe(false);
  });

  it('自救允许清单放行：Esc / F5 / F11 / F12 与开发者工具组合（产品口径 §2.4）', () => {
    const harness = createHarness();
    harness.activate();

    expect(harness.fake.fire(key('Escape'))).toBe(false);
    expect(harness.fake.fire(key('F5'))).toBe(false);
    expect(harness.fake.fire(key('F11'))).toBe(false);
    expect(harness.fake.fire(key('F12'))).toBe(false);
    // win/linux 的开发者工具自救组合是 Ctrl+Shift+I/J/C（不是 ⌥ 或 ⇧⌘ 变体）。
    expect(harness.fake.fire(key('KeyI', { control: true, shift: true }))).toBe(false);
    expect(harness.fake.fire(key('KeyJ', { control: true, shift: true }))).toBe(false);
    expect(harness.fake.fire(key('KeyC', { control: true, shift: true }))).toBe(false);
  });

  it('registry 之外的兜底组合仍被拦：Ctrl+Shift+R（forceReload 会丢掉进行中的回合）', () => {
    const harness = createHarness();
    harness.activate();

    expect(psbStreamCaptureExtraHostCombos('win32').map((entry) => entry.code)).toEqual(['KeyR']);
    expect(harness.fake.fire(key('KeyR', { control: true, shift: true }))).toBe(true);
    // 不带 Shift 的 Ctrl+R 由 registry 的 browser-reload 默认组合覆盖，同样被拦。
    expect(harness.fake.fire(key('KeyR', { control: true }))).toBe(true);
  });

  it('普通输入放行：字母、编辑键、修饰键组合、鼠标事件（远端要收到）', () => {
    const harness = createHarness();
    harness.activate();

    expect(harness.fake.fire(key('KeyA'))).toBe(false);
    expect(harness.fake.fire(key('KeyC', { control: true }))).toBe(false);
    expect(harness.fake.fire(key('KeyV', { control: true, shift: true }))).toBe(false);
    expect(harness.fake.fire(key('Tab', { alt: true }))).toBe(false);
    expect(harness.fake.fire({ ...key('mouseDown'), type: 'mouseDown' })).toBe(false);
  });

  it('未捕获时不拦任何键（控制器之外的窗口行为不受影响）', () => {
    const harness = createHarness();
    harness.activate(false);

    expect(harness.fake.fire(key('KeyW', { control: true }))).toBe(false);
  });

  it('纯判定函数可直接复用（平台差异：darwin 用 ⌘，开发者工具组合是 ⌥⌘ 而不是 ⇧⌘）', () => {
    const darwinCombos = [combo('KeyW', { meta: true })];
    expect(
      psbStreamCaptureShouldSuppressInput(key('KeyW', { meta: true }), darwinCombos, 'darwin'),
    ).toBe(true);
    // macOS 的自救组合是 ⌥⌘I/J/C，放行；⌃⇧I 不是 macOS 的开发者工具键，按平台口径不匹配。
    expect(
      psbStreamCaptureShouldSuppressInput(key('KeyI', { meta: true, alt: true }), [], 'darwin'),
    ).toBe(false);
    expect(
      psbStreamCaptureShouldSuppressInput(
        key('KeyI', { control: true, shift: true }),
        [],
        'darwin',
      ),
    ).toBe(false);
    // 同一组 Ctrl+Shift+I 在 win/linux 上属于自救清单。
    expect(
      psbStreamCaptureIsPassthroughInput(key('KeyI', { control: true, shift: true }), 'win32'),
    ).toBe(true);
  });
});
