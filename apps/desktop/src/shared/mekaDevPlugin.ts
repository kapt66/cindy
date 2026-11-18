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
  /**
   * 源码 `ghost.json` 声明的版本,即下一次打包/同步会产出的版本。
   * 读不到源码清单时省略——不要用已装版本冒充。
   */
  sourceVersion?: string;
  /**
   * 已装开发副本 manifest 的版本,即当前运行中的版本。
   * 与 `sourceVersion` 同时存在且不同 = 源码改过但还没同步。
   */
  installedVersion?: string;
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

/**
 * 按点分段的数值比较两个 Meka 插件版本号(`v` 前缀与前导零都不影响结果)。
 *
 * 返回 >0 表示 `a` 更高,<0 表示 `a` 更低,0 表示**按数值段**相同。MCPRouter 的
 * Release 不可覆盖,所以「目标版本是否更高」必须在客户端先判一次,不能只等服务端
 * 409:本地版本低于线上已发布版本时,上传一定失败。
 *
 * 边界(有意如此):
 * - 段数不同时缺失段按 0 处理(`1.0` 与 `1.0.0` 视为相同);
 * - 非数字段按 0 处理(`1.0.0-beta` 与 `1.0.0` 视为相同),因此**不能**用返回值 0
 *   判定「同一个版本」——字符串相等才是,调用方须先做严格相等判断。
 */
export function compareMekaPluginVersion(a: string, b: string): number {
  const segments = (version: string) =>
    version
      .trim()
      .replace(/^v(?=\d)/i, '')
      .split('.')
      .map((part) => Number(part));
  const left = segments(a);
  const right = segments(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftValue = Number.isFinite(left[index]) ? left[index] : 0;
    const rightValue = Number.isFinite(right[index]) ? right[index] : 0;
    const difference = leftValue - rightValue;
    if (difference !== 0) return difference;
  }
  return 0;
}
