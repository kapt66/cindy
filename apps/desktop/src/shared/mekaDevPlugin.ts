import type { GhostManifest, GhostTrustInfo, InstalledGhost } from './ghost';

export type MekaDevPluginStatus = 'watching' | 'syncing' | 'error';

export interface MekaDevPluginItem {
  /** 开发副本在 Ghost runtime 内的独立身份。 */
  runtimeId: string;
  /** 源码 ghost.json 声明的原始插件 ID，用于关联正式／远端版本。 */
  pluginId: string;
  sourceDir: string;
  status: MekaDevPluginStatus;
  error?: string;
  updatedAt?: number;
}

export interface MekaDevPluginInspection {
  sourceDir: string;
  manifest: GhostManifest;
  trust: GhostTrustInfo;
  /** 用户确认时实际检查过的源码包快照，用于阻断确认后的目录替换。 */
  packageSha256: string;
}

export type MekaDevPluginPickResult =
  | { canceled: true }
  | ({
      canceled: false;
      dataOwnerId: string;
      sessionGeneration: number;
    } & MekaDevPluginInspection);

export interface MekaDevPluginInstallRequest {
  sourceDir: string;
  expectedPackageSha256: string;
  expectedDataOwnerId: string;
  expectedSessionGeneration: number;
}

export interface MekaDevPluginInstallResult {
  ghost: InstalledGhost;
  item: MekaDevPluginItem;
}

export type MekaDevPluginPackageResult =
  | { canceled: true }
  | {
      canceled: false;
      filePath: string;
      pluginId: string;
      version: string;
    };

export interface MekaDevPluginUploadResult {
  pluginId: string;
  version: string;
  visibility: MekaPluginVisibility;
  releasePublished: boolean;
}

export const MEKA_PLUGIN_VISIBILITIES = ['private', 'shared', 'public'] as const;
export type MekaPluginVisibility = (typeof MEKA_PLUGIN_VISIBILITIES)[number];

export interface MekaDevPluginExistingRelease {
  pluginResourceId: string;
  currentReleaseId: string;
  currentVersion: string;
  visibility: MekaPluginVisibility;
  sharedUsernames: string[];
}

export interface MekaDevPluginUploadInfo {
  pluginId: string;
  version: string;
  existing: MekaDevPluginExistingRelease | null;
}

export interface MekaDevPluginUploadRequest {
  id: string;
  visibility: MekaPluginVisibility;
  sharedUsernames: string[];
  /** The release the user reviewed; null means the plugin did not yet exist. */
  expectedCurrentReleaseId: string | null;
}
