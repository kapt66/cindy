/**
 * [MEKA] 面板呈现方式的页签投影收敛。
 *
 * 上游 `reconcileGlobalPluginTabs` 只管「加」,不管呈现方式,所以 Meka 侧补两个方向:
 *  - 同步路径(启动 / `ghosts:changed` / `ghostPanels.syncGhostPanelRegistrations` → S3):
 *    只做**减法** —— 「有效 modal」的实例不留承载 panel 页的全局页签,且不污染
 *    `dismissedInstanceIds`(关 Modal ≠ 用户关过页签)。**不做加法**:自动加页签仍归上游
 *    reconcile,否则用户关过的页签会被同步重新加回来,破坏「关过不再自动加回」。
 *  - 显式切换(设置总开关 / 详情页三态选择器 / `applyGhostPanelPresentationChange`):
 *    两个方向都收敛 —— 切 modal 摘页签(不写 dismissed)+ 清窗口放置记忆,
 *    切 docked 清 dismissed 并补回 `view:'panel'` 页签。
 *
 * 全部幂等:重复调用不会抖动页签,也不会写 dismissed。
 */

import {
  rememberPluginWindowPlacement,
  setGlobalPanelAutoTabEnabled,
} from '@/features/right-sidebar/globalTabs';
import { resolveGhostPanelPresentation } from '@/lib/ghostPanelPresentationPreference';

import type { InstalledGhost } from '../../../../shared/ghost';
import { installedGhostStoragePart } from '../../../../shared/pluginIdentity';

/** 该实例会不会被 Meka 判成 Modal 呈现(只对停靠形态的面板有意义)。 */
function resolvesToModal(ghost: InstalledGhost): boolean {
  const panel = ghost.manifest.panel;
  if (!panel || panel.position === 'tab') return false;
  return resolveGhostPanelPresentation(ghost) === 'modal';
}

/**
 * 同步路径的减法投影:让「有效 modal」的实例没有承载 panel 页的全局页签。
 * 判定用**逻辑插件 id**(`manifest.id`,偏好键)+ **物理实例键**(页签键),两者不可混。
 */
export function syncPanelTabProjection(ghosts: readonly InstalledGhost[]): void {
  for (const ghost of ghosts) {
    if (!resolvesToModal(ghost)) continue;
    setGlobalPanelAutoTabEnabled(installedGhostStoragePart(ghost), false, ghost);
  }
}

/**
 * 用户显式切换某个插件的呈现方式(设置总开关 / 三态选择器)后的收口。
 * 调用前 override/全局开关必须已经落盘,否则 resolver 读到旧值。
 */
export function applyGhostPanelPresentationChange(ghost: InstalledGhost): void {
  const instanceId = installedGhostStoragePart(ghost);
  const modal = resolvesToModal(ghost);
  setGlobalPanelAutoTabEnabled(instanceId, !modal, ghost);
  if (modal) {
    // modal 期间不应保留「下次从页签/侧栏点开进独立窗口」的放置记忆:
    // 切回 docked 后第一次点入口会弹窗,是明确的意外行为。
    rememberPluginWindowPlacement(instanceId, false);
  }
}
