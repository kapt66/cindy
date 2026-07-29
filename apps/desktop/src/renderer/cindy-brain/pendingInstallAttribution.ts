import type { InstalledGhost } from '../../shared/ghost';

/**
 * 将 main 传来的一次性安装渠道转换成 installFlow 的成功回调。
 * 渠道或 owner 缺失时保持无归属，绝不从插件清单或文件路径猜测。
 */
export function createPendingInstallAttribution(
  channel: 'meka' | null,
  dataOwnerId: string | null,
  markLocalInstall: (ghostId: string, ownerId: string) => Promise<unknown>,
): ((ghost: InstalledGhost) => Promise<void>) | undefined {
  if (channel !== 'meka' || !dataOwnerId) return undefined;
  return async (ghost) => {
    await markLocalInstall(ghost.manifest.id, dataOwnerId);
  };
}
