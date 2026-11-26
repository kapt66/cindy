/**
 * 「远程工作区」串流观看端捕获态的**生产接线**（Electron / app-shortcut registry）。
 *
 * 纯状态机在 `streamCapture.ts`（可单测、不 import Electron）；本文件只做三件事：
 *
 * 1. 把「当前生效的宿主快捷键」接到 app-shortcut store（用户改绑立刻生效）；
 * 2. 把 `webContents` 的 `before-input-event` / 生命周期事件包装成 `PsbStreamCaptureHooks`；
 * 3. 进程退出时无条件恢复（`app.on('before-quit')`）。
 *
 * 只在 **IPC 来源窗口**（`event.sender`）上生效：不碰其它窗口，也不改 PSB 任何状态。
 */

import { app, BrowserWindow } from 'electron';

import { APP_SHORTCUT_IDS, type AppShortcutCombo } from '../../shared/appShortcuts.js';
import { getAppShortcutStore } from '../app-shortcuts/index.js';
import {
  createPsbStreamCaptureController,
  type PsbStreamCaptureController,
  type PsbStreamCaptureHooks,
  type PsbStreamCaptureInput,
} from './streamCapture.js';

let controller: PsbStreamCaptureController | null = null;
let quitHookInstalled = false;

/** 当前生效的宿主快捷键（默认 + 用户 override，按 id 展开）。 */
function collectHostShortcutCombos(): AppShortcutCombo[] {
  const store = getAppShortcutStore();
  const combos: AppShortcutCombo[] = [];
  for (const id of APP_SHORTCUT_IDS) combos.push(...store.getEffectiveCombos(id));
  return combos;
}

export function getPsbStreamCaptureController(): PsbStreamCaptureController {
  if (controller) return controller;
  controller = createPsbStreamCaptureController({
    collectHostCombos: collectHostShortcutCombos,
  });
  if (!quitHookInstalled) {
    quitHookInstalled = true;
    // 退出时一定恢复原状：窗口销毁通常也会走 onSenderReset，但 app.quit 的顺序不保证
    // （主窗可能在 before-quit 之后才销毁），而「快捷键被忽略」不该留在退出过程中。
    app.on('before-quit', () => {
      controller?.dispose();
    });
  }
  return controller;
}

function toCaptureInput(input: Electron.Input): PsbStreamCaptureInput {
  return {
    type: input.type,
    key: input.key,
    code: input.code,
    meta: input.meta,
    control: input.control,
    alt: input.alt,
    shift: input.shift,
  };
}

/** 把一个 `webContents` 包装成捕获态需要的六个恢复入口。 */
function createCaptureHooks(sender: Electron.WebContents): PsbStreamCaptureHooks {
  const win = BrowserWindow.fromWebContents(sender);
  return {
    installInputGuard(shouldSuppress) {
      const listener = (event: Electron.Event, input: Electron.Input): void => {
        if (shouldSuppress(toCaptureInput(input))) event.preventDefault();
      };
      sender.on('before-input-event', listener);
      return () => {
        if (sender.isDestroyed()) return;
        sender.removeListener('before-input-event', listener);
      };
    },
    onSenderReset(listener) {
      // 页面/进程消失的三种形态：webContents 销毁、渲染进程崩溃、主 frame 真正导航（重载/登出）。
      // 漏掉任一种都会让「快捷键被忽略」跟着一个不再存在的页面活到进程结束。
      const onDestroyed = (): void => listener();
      const onGone = (): void => listener();
      const onNavigate = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
      ): void => {
        if (isMainFrame && !isInPlace) listener();
      };
      sender.once('destroyed', onDestroyed);
      sender.on('render-process-gone', onGone);
      sender.on('did-start-navigation', onNavigate);
      return () => {
        if (sender.isDestroyed()) return;
        sender.removeListener('destroyed', onDestroyed);
        sender.removeListener('render-process-gone', onGone);
        sender.removeListener('did-start-navigation', onNavigate);
      };
    },
    onWindowInactive(listener) {
      if (!win || win.isDestroyed()) return () => {};
      // 失焦 / 隐藏（缩到托盘、最小化）/ 关闭：都视为「用户已不在画面里」，宿主快捷键恢复。
      // 回到画面时渲染层会重新发 `active:true`（见 docs/dev-rules/psb-remote-session-transport.md）。
      const off = (): void => listener();
      win.on('blur', off);
      win.on('hide', off);
      win.on('closed', off);
      return () => {
        if (win.isDestroyed()) return;
        win.removeListener('blur', off);
        win.removeListener('hide', off);
        win.removeListener('closed', off);
      };
    },
    setIgnoreMenuShortcuts(ignore) {
      if (sender.isDestroyed()) return;
      sender.setIgnoreMenuShortcuts(ignore);
    },
  };
}

/**
 * IPC 层唯一入口：按来源 `webContents` 进入 / 退出捕获态。
 *
 * 捕获态**只记在发起窗口上**：另一个窗口（或另一个工作区页签）的快捷键不受影响。
 */
export function updatePsbStreamCapture(input: {
  sender: Electron.WebContents;
  active: boolean;
  workspaceId?: string | null;
}): void {
  getPsbStreamCaptureController().setActive({
    key: input.sender.id,
    hooks: createCaptureHooks(input.sender),
    active: input.active,
    workspaceId: input.workspaceId ?? null,
  });
}

/** 释放全部捕获态（账号边界 / 单测）。幂等；之后下次调用会重新装配。 */
export function disposePsbStreamCapture(): void {
  const current = controller;
  controller = null;
  current?.dispose();
}
