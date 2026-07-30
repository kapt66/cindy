import type { GhostManifest } from './ghost';
import type { PluginIconMetadata } from '@cindy/plugin-protocol';

export type PluginMarketScope = 'public' | 'organization' | 'personal';
export type PluginMarketInstallState =
  | 'not-installed'
  | 'installed'
  | 'update-available'
  | 'conflict';

/** Renderer-safe Plugin 市场列表项；所有字段都来自协议或本地安装事实。 */
export interface PluginMarketItem {
  pluginId: string;
  ghostId: string;
  name: string;
  description: string | null;
  author: string | null;
  scope: PluginMarketScope;
  organizationId: string | null;
  defaultInstall: boolean;
  releaseId: string;
  version: string;
  publishedAt: string;
  icon: PluginIconMetadata | null;
  installState: PluginMarketInstallState;
  enabled: boolean | null;
}
/** 市场快照。服务不可用时 renderer 保留本地插件并只展示非阻断提示。 */
export interface PluginMarketSnapshot {
  items: PluginMarketItem[];
  unavailableReason: string | null;
}

/** 详情额外携带经 Desktop 当前 runtime validator 验证过的完整清单。 */
export interface PluginMarketDetail extends PluginMarketItem {
  manifest: GhostManifest;
}

export type PluginMarketInstallPhase = 'preparing' | 'downloading' | 'installing';
export const MEKA_PLUGIN_MARKET_INSTALL_PROGRESS_CHANNEL =
  'meka-plugin-market:install-progress';
const PLUGIN_MARKET_INSTALL_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPluginMarketInstallOperationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    PLUGIN_MARKET_INSTALL_OPERATION_ID_PATTERN.test(value)
  );
}

/**
 * Renderer-safe progress for one explicit Meka market installation.
 * Main never exposes the signed URL, temporary path, or package contents.
 */
export interface PluginMarketInstallProgress {
  operationId: string;
  pluginId: string;
  phase: PluginMarketInstallPhase;
  downloadedBytes: number;
  totalBytes: number;
}

export function isPluginMarketInstallProgress(
  value: unknown,
): value is PluginMarketInstallProgress {
  if (typeof value !== 'object' || value === null) return false;
  const progress = value as Partial<PluginMarketInstallProgress>;
  return (
    isPluginMarketInstallOperationId(progress.operationId) &&
    typeof progress.pluginId === 'string' &&
    progress.pluginId.length <= 128 &&
    (progress.phase === 'preparing' ||
      progress.phase === 'downloading' ||
      progress.phase === 'installing') &&
    Number.isSafeInteger(progress.downloadedBytes) &&
    Number.isSafeInteger(progress.totalBytes) &&
    progress.totalBytes! > 0 &&
    progress.downloadedBytes! >= 0 &&
    progress.downloadedBytes! <= progress.totalBytes!
  );
}
