import { PanelsTopLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { restoreGhostPanel } from '@/lib/ghostPanelBubbleState';
import {
  setGhostPanelPresentationOverride,
  useGhostPanelModalPresentation,
  useGhostPanelPresentationOverride,
  type GhostPanelPresentationOverride,
} from '@/lib/ghostPanelPresentationPreference';

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
 * - `instanceId` 是**物理实例键**（`_root__<id>` / `_ns__<ns>__<id>`）：分离窗口账本
 *   （`ghostPanelWindow.setDetached`，见 `ghostPanels.tsx` 的 `setDetached(instanceId, true)`）
 *   与气泡状态按实例定位。缺省回落到 `ghostId`，兼容旧调用方（裸 id 目录两者同值）。
 */
export function PluginPanelPresentationPreference({
  ghostId,
  instanceId,
}: {
  ghostId: string;
  instanceId?: string;
}) {
  const { t } = useTranslation();
  const globalModal = useGhostPanelModalPresentation();
  const override = useGhostPanelPresentationOverride(ghostId);
  const detachKey = instanceId ?? ghostId;

  const handleChange = (next: GhostPanelPresentationOverride): void => {
    setGhostPanelPresentationOverride(ghostId, next);
    const effectiveModal = next === 'modal' || (next === 'inherit' && globalModal);
    // Choosing a host presentation also exits stale detached/minimized states
    // so the next visible host matches the explicit user choice.
    void window.electronAPI.ghostPanelWindow.setDetached(detachKey, false).catch(() => undefined);
    if (!effectiveModal) restoreGhostPanel(detachKey);
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
