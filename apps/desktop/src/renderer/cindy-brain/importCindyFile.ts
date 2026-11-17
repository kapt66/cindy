import type { TFunction } from 'i18next';
import { toast } from '@/lib/toast';
import { refreshLocalThemes } from '@/themes/local-themes';
import { installGhostFromFile } from './installFlow';
import type { InstalledGhost } from '../../shared/ghost';

interface CindyFileImportDeps {
  t: TFunction;
  openPluginPanel?: (ghostId: string) => void;
  openThemes?: () => void;
  /**
   * [MEKA] 装入成功后的宿主渠道归属回写(WL-9：Meka 独立插件渠道的本地安装来源)。
   * 加性字段：非 Meka 入口不传，installFlow 里 `deps.onInstalled?.()` 本就可选。
   */
  onInstalled?: (ghost: InstalledGhost) => Promise<void>;
}

/** Common desktop file entry; legacy plugin approvals stay in installFlow. */
export async function importCindyFile(filePath: string, deps: CindyFileImportDeps): Promise<void> {
  let result;
  try { result = await window.electronAPI.cindyFiles.open(filePath); }
  catch { toast.error(deps.t('cindyFiles.failed')); return; }
  if (result.type === 'plugin') {
    await installGhostFromFile(filePath, deps);
  } else if (result.type === 'theme') {
    try {
      const refreshed = await refreshLocalThemes();
      if (!refreshed.success) throw new Error('Theme list unavailable');
      toast.success(deps.t('cindyFiles.themeInstalled'));
    } catch { toast.error(deps.t('cindyFiles.refreshFailed')); }
    deps.openThemes?.();
  } else {
    toast.error(deps.t(`cindyFiles.${result.type}`));
  }
}
