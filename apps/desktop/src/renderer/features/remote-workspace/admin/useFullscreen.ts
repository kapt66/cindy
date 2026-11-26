/**
 * 画面全屏（2026-11-26 独立审查 r4：从 1087 行组件里抽出）。
 *
 * 浏览器是唯一事实：用户按 Esc 退出全屏不经过我们的按钮，所以状态只从
 * `fullscreenchange` 同步回来（不做本地「先改再等事件」的乐观翻转）。
 *
 * 进入走 `stage.requestFullscreen()`；失败（用户拒绝 / 环境不支持）静默保持原布局，不报错、
 * 不影响串流。返回值告诉调用方「这次是否真的进入了全屏」，用于在用户手势链里补一次画面焦点
 * 与 Keyboard Lock 申请（不支持时降级，不影响事件级捕获）。
 */

import { useCallback, useEffect, useState, type RefObject } from 'react';

export interface FullscreenControls {
  readonly isFullscreen: boolean;
  /** 切换；返回切换后的全屏状态（`true` = 刚刚进入）。 */
  readonly toggle: () => Promise<boolean>;
}

export function useFullscreen(stageRef: RefObject<HTMLElement | null>): FullscreenControls {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onChange = () => setIsFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', onChange);
    onChange();
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [stageRef]);

  const toggle = useCallback(async (): Promise<boolean> => {
    if (typeof document === 'undefined') return false;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen?.();
        return false;
      }
      const stage = stageRef.current;
      if (stage && typeof stage.requestFullscreen === 'function') {
        await stage.requestFullscreen();
        return true;
      }
    } catch {
      // 用户拒绝 / 环境不支持全屏：保持原布局，不报错、不影响串流。
    }
    return false;
  }, [stageRef]);

  return { isFullscreen, toggle };
}
