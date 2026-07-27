import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import type { MekaP4Settings } from '../../shared/meka-settings';

interface GateResult {
  proceed: boolean;
}

export function isMekaP4ConfigComplete(
  settings: Pick<MekaP4Settings, 'p4RootPath' | 'subfolders'>,
): boolean {
  return !!settings.p4RootPath?.trim() && settings.subfolders.length > 0;
}

/**
 * Preserve the original Meka send-time guard: SAGA2 sessions require a P4
 * root with at least one recognized project child directory.
 */
export function useMekaConfigGate(): { checkAndConfirm: () => Promise<GateResult> } {
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const { t } = useTranslation();

  const checkAndConfirm = useCallback(async (): Promise<GateResult> => {
    try {
      const settings = await window.electronAPI.mekaSettings.getP4();
      if (isMekaP4ConfigComplete(settings)) {
        return { proceed: true };
      }
    } catch {
      // Keep the original fail-open behavior. Main still validates the project
      // path when creating the session and will return a structured error.
      return { proceed: true };
    }

    const goToSettings = await confirm({
      title: t('meka.gate.incomplete.title'),
      description: t('meka.gate.incomplete.description'),
      confirmText: t('meka.gate.goSettings'),
      cancelText: t('logic.confirm.cancel'),
      autoFocusConfirm: true,
    });
    if (goToSettings) navigate('/settings?tab=meka-assistant');
    return { proceed: false };
  }, [confirm, navigate, t]);

  return { checkAndConfirm };
}
