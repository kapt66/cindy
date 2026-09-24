import { toast } from '@/lib/toast';

type Translate = (key: string) => string;

export async function checkForUpdateWithToast(t: Translate): Promise<void> {
  const { result } = await window.electronAPI.checkForUpdate();
  switch (result) {
    case 'idle':
      toast.success(t('titleBar.updateCheckToast.alreadyLatest'));
      break;
    case 'downloading':
      toast.warning(t('titleBar.updateCheckToast.downloading'));
      break;
    case 'ready':
      toast.success(t('titleBar.updateCheckToast.ready'));
      break;
    case 'manifest_failed':
      toast.error(t('titleBar.updateCheckToast.manifestFailed'));
      break;
    case 'download_failed':
      toast.error(t('titleBar.updateCheckToast.downloadFailed'));
      break;
    case 'manual_download':
      toast.warning(t('titleBar.updateCheckToast.manualDownload'));
      break;
    case 'apply_exhausted':
      // The client stopped auto-applying this version on purpose — "you're on the
      // latest version" would be a lie, and the only way forward is a manual install.
      toast.warning(t('titleBar.updateCheckToast.applyExhausted'));
      break;
    case 'no_asset':
      // 清单广告了更高版本，只是本平台这一轮没有可安装资产：idle 的「已经是最新版本了」
      // 与事实相反，如实告知「有新版但暂无安装包」。
      toast.warning(t('titleBar.updateCheckToast.noAsset'));
      break;
    case 'versionless':
      // 版本无关(占位 0.0.0)本地包有意不参与自动更新——同样不是「已是最新版本」。
      toast.warning(t('titleBar.updateCheckToast.versionless'));
      break;
  }
}
