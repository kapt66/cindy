/**
 * 工作区占用的一句话展示（页头、侧栏锁 Tip 等**所有**占用文案共用这一处，2026-11-26 用户口径）。
 *
 * PSB 的 `occupancy` 即使在 `byMe: true` 时也会回自己的 `personName`，所以展示规则是：
 *   - 未占用 → 「无人占用」；
 *   - 占用中且有名字 → 直接显示名字；占用人是自己时追加「（你）」后缀（`张三（你）`）；
 *   - 占用中但 PSB 没给名字 → 自己显示「你」，别人显示「他人占用」。
 *
 * 不做多份实现：页头与侧栏锁是同一个事实的两个入口，各写一份必然漂移。
 */

import type { TFunction } from 'i18next';

/** 与 `PsbWorkspaceAdminOccupancy` / `PsbWorkspaceOccupancy` 结构兼容的最小形状。 */
export interface WorkspaceOccupancyLike {
  readonly occupied: boolean;
  readonly byMe: boolean;
  readonly personName: string;
}

export function formatWorkspaceOccupancy(
  occupancy: WorkspaceOccupancyLike,
  t: TFunction,
): string {
  if (!occupancy.occupied) return t('remoteWorkspace.admin.occupancyFree');
  const name = occupancy.personName.trim();
  if (!name) {
    return occupancy.byMe
      ? t('remoteWorkspace.admin.occupancyMine')
      : t('remoteWorkspace.admin.occupancyTakenByOther');
  }
  // 自己占用时 PSB 也会给名字：`张三（你）`。i18n 用整句模板，避免各语言自己拼括号/空格。
  return occupancy.byMe
    ? t('remoteWorkspace.admin.occupancySelfValue', { name })
    : name;
}
