import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface LogSupportRowProps {
  presentation?: 'settings' | 'dialog';
}

// Shared by Settings and the startup/login recovery surface. Neither action needs a login.
//
// Meka divergence (WL-26): upstream also ships `UploadLogsRow` / `UploadLogsActionRow` plus
// `useManualLogUpload` here. Cindy Meka does not enable client log upload at all, so only the
// local-log action (collection/redaction surface, still used by issue diagnostics) is kept.
// On the next upstream sync, keep the removal instead of restoring the upload rows.
export function OpenLogsRow({ presentation = 'settings' }: LogSupportRowProps) {
  const { t } = useTranslation();
  const inDialog = presentation === 'dialog';
  const handleOpen = async () => {
    try {
      const res = await window.electronAPI.openLogsDir();
      if (!res.success) toast.error(t('settings.about.openLogsDirError'));
    } catch {
      toast.error(t('settings.about.openLogsDirError'));
    }
  };

  return (
    // Preserve AboutSection's existing 18px row gutter; dialogs supply their own panel padding.
    <div
      className={cn(
        'flex justify-between gap-3',
        inDialog ? 'items-start' : 'items-center px-[18px] py-4',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span
          className={cn(
            'text-13',
            inDialog ? 'text-[var(--confirm-title)]' : 'text-[var(--settings-section-sublabel)]',
          )}
        >
          {t('settings.about.logsDirLabel')}
        </span>
        {inDialog && (
          <p className="text-12 leading-normal text-[var(--confirm-desc)]">
            {t('logSupport.localFiles')}
          </p>
        )}
      </div>
      <Button
        variant="secondary"
        size="sm"
        type="button"
        onClick={handleOpen}
        palette={inDialog ? 'confirmation' : 'default'}
        className={inDialog ? 'px-3' : '-mr-1 px-2.5'}
        title={t('settings.about.openLogsDirTooltip')}
      >
        {!inDialog && <FolderOpen size={13} />}
        {t('settings.about.openLogsDir')}
      </Button>
    </div>
  );
}
