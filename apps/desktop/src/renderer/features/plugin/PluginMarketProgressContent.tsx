import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { PluginMarketInstallProgress } from '../../../shared/pluginMarket';

export function PluginMarketProgressContent({
  progress,
  update,
  fallback,
  showBar = true,
}: {
  progress: PluginMarketInstallProgress | null | undefined;
  update: boolean;
  fallback: ReactNode;
  showBar?: boolean;
}) {
  const { t } = useTranslation();
  const percent =
    progress?.phase === 'downloading'
      ? Math.min(100, Math.floor((progress.downloadedBytes / progress.totalBytes) * 100))
      : null;
  const label =
    progress?.phase === 'preparing'
      ? t('settings.ghosts.market.preparing')
      : progress?.phase === 'downloading'
        ? t('settings.ghosts.market.downloading', { percent })
        : progress?.phase === 'installing'
          ? t(
              update
                ? 'settings.ghosts.market.updating'
                : 'settings.ghosts.market.installing',
            )
          : fallback;

  return (
    <>
      <span>{label}</span>
      {showBar && percent !== null ? (
        <span
          className="pointer-events-none absolute inset-x-3 bottom-1 h-0.5 overflow-hidden rounded-full bg-[var(--border-transparent-mixed)]"
          aria-hidden="true"
        >
          <span
            className="block h-full rounded-full bg-current"
            style={{ width: `${percent}%` }}
          />
        </span>
      ) : null}
    </>
  );
}
