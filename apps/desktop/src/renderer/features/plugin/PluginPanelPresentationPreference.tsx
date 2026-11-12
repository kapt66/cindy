import { PanelsTopLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { applyGhostPanelPresentationChange } from './lib/panelTabProjection';
import {
  setGhostPanelPresentationOverride,
  useGhostPanelModalPresentation,
  useGhostPanelPresentationOverride,
  type GhostPanelPresentationOverride,
} from '@/lib/ghostPanelPresentationPreference';

import type { InstalledGhost } from '../../../shared/ghost';

const PRESENTATION_OPTIONS: readonly GhostPanelPresentationOverride[] = [
  'inherit',
  'docked',
  'modal',
];

/**
 * Host-owned per-Plugin view preference declared by panel-bearing Plugins.
 *
 * 两个 key 空间必须分开，不能共用一个值：
 * - `ghostId` 是**逻辑插件 id**：偏好 store（`ghostPanelPresentationPreference.ts`）与
 *   启动器/设置页的读取方（`ghost.manifest.id`）都用它；store 按 `isValidGhostId` 过滤，
 *   传物理实例键（`_root__<id>`）会被直接拒掉，开关等于失效。
 * - `instanceId` 是**物理实例键**（`_root__<id>` / `_ns__<ns>__<id>`）：全局页签
 *   （`g_<instanceId>`）与放置记忆按实例定位。缺省回落到 `ghostId`，兼容旧调用方
 *   （裸 id 目录两者同值）。
 *
 * 选择后的收敛统一交给 `applyGhostPanelPresentationChange`（摘/补页签 + 清窗口放置
 * 记忆）:Modal 与页签两个宿主不能同时存在，否则同一实例会有两个 webview 各存一份数据。
 */
export function PluginPanelPresentationPreference({
  ghostId,
  ghost,
}: {
  ghostId: string;
  /** 物理实例键（`_root__<id>` / `_ns__<ns>__<id>`），保留给只按实例定位的调用方。 */
  instanceId?: string;
  /** 该插件的已装实例:用于页签投影与放置记忆收敛。 */
  ghost?: InstalledGhost | null;
}) {
  const { t } = useTranslation();
  // 订阅全局开关:全局默认变化时选择器的「跟随默认」文案语义随之变化(重渲染);
  // 有效值本身由 `resolveGhostPanelPresentation` 在入口处统一解析。
  useGhostPanelModalPresentation();
  const override = useGhostPanelPresentationOverride(ghostId);

  const handleChange = (next: GhostPanelPresentationOverride): void => {
    setGhostPanelPresentationOverride(ghostId, next);
    // 偏好先落盘,再按新的有效呈现方式收敛页签(不写 dismissed)。
    if (ghost) applyGhostPanelPresentationChange(ghost);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-[color-mix(in_srgb,var(--border-default)_72%,transparent)] bg-[color-mix(in_srgb,var(--surface-elevated)_82%,var(--surface))] px-5 py-4">
      <div className="flex items-center gap-2">
        <PanelsTopLeft size={14} className="text-[var(--text-tertiary)]" aria-hidden="true" />
        <p className="text-14 font-medium leading-[1.571] text-[var(--text-primary)]">
          {t('settings.ghosts.detail.panelPresentation.title')}
        </p>
      </div>
      <p className="text-13 leading-5 text-[var(--text-tertiary)]">
        {t('settings.ghosts.detail.panelPresentation.description')}
      </p>
      <select
        value={override}
        onChange={(event) =>
          handleChange(event.target.value as GhostPanelPresentationOverride)
        }
        aria-label={t('settings.ghosts.detail.panelPresentation.aria')}
        className="h-9 w-full appearance-none rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 text-13 text-[var(--settings-input-text)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
      >
        {PRESENTATION_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {t(`settings.ghosts.detail.panelPresentation.options.${option}`)}
          </option>
        ))}
      </select>
    </div>
  );
}
