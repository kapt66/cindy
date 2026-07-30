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

/** Host-owned per-Plugin view preference declared by panel-bearing Plugins. */
export function PluginPanelPresentationPreference({ ghostId }: { ghostId: string }) {
  const { t } = useTranslation();
  const globalModal = useGhostPanelModalPresentation();
  const override = useGhostPanelPresentationOverride(ghostId);

  const handleChange = (next: GhostPanelPresentationOverride): void => {
    setGhostPanelPresentationOverride(ghostId, next);
    const effectiveModal = next === 'modal' || (next === 'inherit' && globalModal);
    // Choosing a host presentation also exits stale detached/minimized states
    // so the next visible host matches the explicit user choice.
    void window.electronAPI.ghostPanelWindow.setDetached(ghostId, false).catch(() => undefined);
    if (!effectiveModal) restoreGhostPanel(ghostId);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-[color-mix(in_srgb,var(--border-default)_72%,transparent)] bg-[color-mix(in_srgb,var(--surface-elevated)_82%,var(--surface))] px-5 py-4">
      <div className="flex items-center gap-2">
        <PanelsTopLeft size={14} className="text-[var(--text-tertiary)]" aria-hidden="true" />
        <p className="text-14 font-medium leading-[22px] text-[var(--text-primary)]">
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
