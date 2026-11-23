import { useCallback, useRef } from 'react';

import { createLogger } from '@/lib/logger';
import { openPluginInSidebar } from '@/features/right-sidebar/pluginPlacement';
import { findGlobalTabByInstance } from '@/features/right-sidebar/globalTabs';

import { findInstalledGhostByInstanceId, installedGhostStoragePart } from '../../../shared/pluginIdentity';
import type { InstalledGhost } from '../../../shared/ghost';

const log = createLogger('plugins.panelLauncher');

/**
 * 打开面板的实际结果。调用方必须能区分「真的开了」与「什么都没发生」:
 * 面板主 CTA 只文案改成「使用面板」但点了静默失败,比没有入口更糟。
 *
 * - `docked`:上游右侧栏全局页签(用户看不见它「就在旁边」,调用方要给一句反馈);
 * - `page`:交给插件页内的 `GhostPagePanelHost`(页内页签,就地可见);
 * - `unavailable`:没有可用的宿主(未装/已停用/无面板/tab 宿主缺失)、
 *   全局页签已达上限(`addGlobalPluginTab` 返回 null),或打开右侧栏时抛错。
 */
export type GhostPanelOpenResult = 'docked' | 'page' | 'unavailable';

export interface GhostPanelLauncher {
  /** 打开某个插件实例的面板,并返回它实际落到了哪种宿主(见 `GhostPanelOpenResult`)。 */
  openPanel: (id: string) => Promise<GhostPanelOpenResult>;
}

/**
 * One launch boundary for every Plugin-catalog entry point.
 *
 * 呈现方式完全跟随上游 manifest:没有本机覆盖、没有 Modal 分支。
 *
 * - `tab`(manifest 固定):交给插件页里的 `GhostPagePanelHost`,本函数不处理;
 * - 其余停靠形态:上游右侧栏全局页签(`openPluginInSidebar(ghost,'panel')`);
 *   页面内没有其它面板宿主。
 *
 * 三个市场/详情入口(详情主 CTA「使用面板」/ 列表卡片主动作 / `?panel=` 深链 /
 * 安装流程)全部复用本函数,不各自维护打开分支。
 */
export function useGhostPanelLauncher({
  ghosts,
  openPageHost,
}: {
  ghosts: InstalledGhost[];
  /**
   * `panel.position:'tab'` 的宿主在插件页里(`GhostPagePanelHost`,`openPanelId` 状态),
   * 由调用方注入;launcher 仍是唯一分流点。
   */
  openPageHost?: (instanceId: string) => void;
}): GhostPanelLauncher {
  const openPageHostRef = useRef(openPageHost);
  openPageHostRef.current = openPageHost;

  const openPanel = useCallback(
    async (id: string): Promise<GhostPanelOpenResult> => {
      // `id` 是**物理实例键**（`_root__<id>` / `_ns__<ns>__<id>`，与插件页 `selectedDetail.id`
      // 和 `?panel=` 深链同源），不是逻辑插件 id：namespace 隔离后新装 root 落在
      // `_ns/_root/<id>`，用 `manifest.id === id` 找不到任何实例，面板会静默不开。
      const ghost = findInstalledGhostByInstanceId(ghosts, id);
      if (!ghost?.manifest.panel || ghost.enabled === false) return 'unavailable';
      const panel = ghost.manifest.panel;
      // tab 形态由插件页内的 GhostPagePanelHost 承载,这里不抢宿主。
      if (panel.position === 'tab') {
        if (!openPageHostRef.current) return 'unavailable';
        openPageHostRef.current(id);
        return 'page';
      }

      // 停靠形态:上游右侧栏全局页签。
      try {
        await openPluginInSidebar(ghost, 'panel');
      } catch (err) {
        // 打开右侧栏页签的链路(布局树/窗口交回/唤醒右侧栏)可能抛错;以前
        // `.catch(() => undefined)` 把它吞成成功,用户点完什么都看不到。
        log.warn('open docked plugin panel failed', { id, err });
        return 'unavailable';
      }
      // `openPluginInSidebar` 在 `addGlobalPluginTab` 返回 null(全局页签达到上限)时
      // 静默 return,不抛错;回查页签是否真的存在,才能如实告诉调用方「没开成」。
      if (!findGlobalTabByInstance(installedGhostStoragePart(ghost))) {
        log.warn('docked plugin panel tab was not created', { id });
        return 'unavailable';
      }
      return 'docked';
    },
    [ghosts],
  );

  return { openPanel };
}
