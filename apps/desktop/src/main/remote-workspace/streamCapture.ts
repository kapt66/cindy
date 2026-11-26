/**
 * 「远程工作区」串流观看端的**画面捕获态**（main 进程侧）—— 全屏时宿主快捷键必须让路。
 *
 * ## 为什么需要 main 这一层
 *
 * 用户在全屏看远端画面时，键鼠应当**只**作用于远端。但 Electron 里按键有两条会「漏回宿主」的
 * 路，renderer 完全管不到：
 *
 * 1. **应用菜单 accelerator**：macOS 上 Cmd+W / Cmd+R / Cmd+Q / 缩放 / 全屏由系统在 renderer
 *    收到按键**之前**就分发了。renderer 里再怎么 stopPropagation 也拦不住 →
 *    只能 `webContents.setIgnoreMenuShortcuts(true)`。
 * 2. **main 侧的快捷键消费**：`before-input-event` 里另有监听（例如 dev 的 F12 开关 DevTools、
 *    窗口恢复等）。这里加一道闸，按「会不会触发宿主行为」判定后 `preventDefault()`。
 *
 * 本模块只做**状态机与判定**，不 import Electron：真正的 `webContents` 接线由
 * `streamCaptureRuntime.ts` 注入（单测可以直接用假 hooks，不需要 Electron）。
 *
 * ## 三条不变式
 *
 * 1. **自救键永远放行**：共享允许清单 `psbStreamCaptureIsPassthroughInput`（Esc / F5 / F11 /
 *    F12 / 开发者工具组合）在抑制之前先判。全屏的退出路径只有 Esc，拦掉它会让用户卡在全屏里
 *    出不来 —— 这比「某个快捷键漏给宿主」严重得多。
 * 2. **恢复路径必须走完**：失焦 / 隐藏 / 关闭 / 页面导航 / 渲染进程崩溃 / 显式退出，六个
 *    入口全部收敛到 `release()`；卸载单个监听失败不能挡住 `setIgnoreMenuShortcuts(false)`，
 *    否则「快捷键被永久吃掉」比不抑制更糟。
 * 3. **只作用于发起窗口**：捕获态按 `webContents.id` 记，不碰别的窗口，也不改 PSB 任何状态。
 *
 * ## 与渲染层的清单一致
 *
 * 允许清单在共享契约 `shared/psb-workspace-admin.ts`（`psbStreamCaptureIsPassthroughInput`）；
 * 渲染层「哪些键不发给远端」必须引用同一份判定。本文件的「额外宿主快捷键」是 registry 之外的
 * 兜底（见 `psbStreamCaptureExtraHostCombos`），只影响 main 的抑制，不外发。
 */

import type { AppShortcutCombo } from '../../shared/appShortcuts.js';
import { matchesElectronInput } from '../../shared/appShortcuts.js';
import { psbStreamCaptureIsPassthroughInput } from '../../shared/psb-workspace-admin.js';

/** `before-input-event` 输入形状（Electron `Input` 中本模块用到的子集）。 */
export interface PsbStreamCaptureInput {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/**
 * 宿主侧接线（生产实现 = `streamCaptureRuntime.ts`；单测用假实现）。
 *
 * 每个 hook 都返回**幂等**的卸载函数：`release()` 会在任意时刻调用它（可能 webContents 已经
 * 销毁），所以卸载自身不得抛错；真抛了也会被控制器的 try/catch 兜住。
 */
export interface PsbStreamCaptureHooks {
  /**
   * 安装按键拦截：`shouldSuppress(input)` 为 true 时必须 `preventDefault()`（按键不进 renderer）。
   * 返回卸载函数。
   */
  installInputGuard(shouldSuppress: (input: PsbStreamCaptureInput) => boolean): () => void;
  /** 页面/进程消失（webContents 销毁、渲染进程崩溃、主 frame 导航）。返回卸载函数。 */
  onSenderReset(listener: () => void): () => void;
  /** 窗口失焦 / 隐藏 / 关闭。返回卸载函数。 */
  onWindowInactive(listener: () => void): () => void;
  /** Electron `webContents.setIgnoreMenuShortcuts`；对已销毁的 webContents 是 no-op。 */
  setIgnoreMenuShortcuts(ignore: boolean): void;
}

export interface PsbStreamCaptureDeps {
  /**
   * 当前生效的宿主快捷键（app-shortcut registry 的合并结果）。
   *
   * **每次按键现取**：用户在设置里改绑快捷键后，捕获态的抑制清单必须立刻跟着变，
   * 不能拿窗口创建时的旧快照。
   */
  collectHostCombos(): readonly AppShortcutCombo[];
  /** 平台（默认 `process.platform`；单测显式传入）。 */
  platform?: string;
  log?: { debug(message: string, fields?: Record<string, unknown>): void };
}

/** 一条捕获态。 */
interface CaptureEntry {
  readonly hooks: PsbStreamCaptureHooks;
  readonly workspaceId: string | null;
  readonly disposers: Array<() => void>;
}

export interface SetPsbStreamCaptureActiveInput {
  /** 发起窗口的 `webContents.id`（同一 webContents 只能有一条捕获态）。 */
  readonly key: number;
  readonly hooks: PsbStreamCaptureHooks;
  readonly active: boolean;
  /** 仅诊断用（哪个工作区页在捕获）；不参与判定。 */
  readonly workspaceId?: string | null;
}

export interface PsbStreamCaptureController {
  /**
   * 进入 / 退出捕获态。同态重复调用是幂等的（`active:true` 再来一次不会重复挂监听）。
   * 进入失败（webContents 正在销毁等）会把已装的部分回滚后**抛出**，绝不留下「只装了
   * 抑制、没留恢复路径」的半态。
   */
  setActive(input: SetPsbStreamCaptureActiveInput): void;
  isActive(key: number): boolean;
  /** 当前处于捕获态的窗口（诊断与测试用）。 */
  activeKeys(): number[];
  /** 进程退出 / 账号边界：全部恢复原状。 */
  dispose(): void;
}

function combo(
  code: string,
  modifiers: Partial<Pick<AppShortcutCombo, 'meta' | 'ctrl' | 'alt' | 'shift'>> = {},
): AppShortcutCombo {
  return { code, meta: false, ctrl: false, alt: false, shift: false, ...modifiers };
}

/** `darwin` 上 mod = ⌘，其它平台 mod = Ctrl（与 `shared/appShortcuts.ts` 同一口径）。 */
function modCombo(
  code: string,
  platform: string,
  extra: Partial<Pick<AppShortcutCombo, 'meta' | 'ctrl' | 'alt' | 'shift'>> = {},
): AppShortcutCombo {
  return platform === 'darwin'
    ? combo(code, { ...extra, meta: true })
    : combo(code, { ...extra, ctrl: true });
}

/**
 * registry 之外、仍会触发宿主行为的组合（兜底清单）。
 *
 * WHY 不并进 registry：这些是**菜单 role 的默认 accelerator**，不是应用级可改绑动作
 * （release 包甚至不建菜单）。macOS 上 `setIgnoreMenuShortcuts(true)` 已覆盖它们；非 darwin
 * 平台 Cindy 不建应用菜单（`Menu.setApplicationMenu(null)`），所以这份清单在 win/linux 上是
 * 纯兜底 —— 万一将来有 before-input-event / renderer 消费同一组合，也不会漏给宿主。
 *
 * 只保留 `mod+Shift+R`（forceReload）：它不在产品口径的「自救允许清单」里，而整页刷新会丢掉
 * 正在进行的回合与草稿。别的候选都已进共享允许清单（`F5` / `F11` / 开发者工具组合），
 * 不再重复列在这里。
 */
export function psbStreamCaptureExtraHostCombos(platform: string): AppShortcutCombo[] {
  return [modCombo('KeyR', platform, { shift: true })];
}

/**
 * 捕获态下这条输入是否必须 `preventDefault()`。
 *
 * 判定顺序：不是按键事件 → 不拦（鼠标事件要进 renderer 做输入采集）；共享允许清单里的自救键
 * （Esc / F5 / F11 / F12 / 开发者工具）→ 放行；命中 registry 生效组合或额外宿主组合 → 拦。
 * **未命中一律放行**：普通字母/数字、输入法组合键、Ctrl+C/V 这类编辑键都要照常进 renderer，
 * 由它转发给远端。
 */
export function psbStreamCaptureShouldSuppressInput(
  input: PsbStreamCaptureInput,
  hostCombos: readonly AppShortcutCombo[],
  platform: string,
): boolean {
  if (input.type !== 'keyDown' && input.type !== 'keyUp') return false;
  if (psbStreamCaptureIsPassthroughInput(input, platform)) return false;
  const matches = (combos: readonly AppShortcutCombo[]): boolean =>
    combos.some((candidate) => matchesElectronInput(input, candidate));
  return matches(hostCombos) || matches(psbStreamCaptureExtraHostCombos(platform));
}

export function createPsbStreamCaptureController(
  deps: PsbStreamCaptureDeps,
): PsbStreamCaptureController {
  const platform = deps.platform ?? process.platform;
  const entries = new Map<number, CaptureEntry>();

  /** 恢复原状并忘掉这条捕获态。可重入、可对任意时刻调用（含 webContents 已销毁）。 */
  function release(key: number): void {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    // 逆序卸载；单条失败不阻断其余（恢复路径必须走完）。
    for (const dispose of entry.disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        /* best-effort：监听已被销毁的页面带走时卸载会抛，忽略 */
      }
    }
    try {
      entry.hooks.setIgnoreMenuShortcuts(false);
    } catch {
      /* best-effort：webContents 已销毁 */
    }
    deps.log?.debug('psb stream capture released', { key, workspaceId: entry.workspaceId });
  }

  function activate(input: SetPsbStreamCaptureActiveInput): void {
    const { key, hooks } = input;
    if (entries.has(key)) {
      // 同一 webContents 重复进入：幂等。不重复挂监听，也不重置已有恢复路径。
      return;
    }
    const entry: CaptureEntry = {
      hooks,
      workspaceId: input.workspaceId ?? null,
      disposers: [],
    };
    entries.set(key, entry);
    try {
      entry.disposers.push(
        hooks.installInputGuard((eventInput) =>
          psbStreamCaptureShouldSuppressInput(eventInput, deps.collectHostCombos(), platform),
        ),
      );
      entry.disposers.push(hooks.onSenderReset(() => release(key)));
      entry.disposers.push(hooks.onWindowInactive(() => release(key)));
      hooks.setIgnoreMenuShortcuts(true);
    } catch (error) {
      // 半态比不抑制更糟：先回滚，再把失败交给调用方（IPC 层会转成 INTERNAL）。
      release(key);
      deps.log?.debug('psb stream capture activation failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    deps.log?.debug('psb stream capture activated', {
      key,
      workspaceId: entry.workspaceId,
    });
  }

  return {
    setActive(input) {
      if (input.active) activate(input);
      else release(input.key);
    },
    isActive: (key) => entries.has(key),
    activeKeys: () => [...entries.keys()],
    dispose() {
      for (const key of [...entries.keys()]) release(key);
    },
  };
}
