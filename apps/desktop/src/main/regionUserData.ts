/**
 * regionUserData — packaged userData 覆写兼容入口。
 *
 * Cindy Meka 正式版已收敛为固定安装身份，cn / global 都使用 Electron 默认的
 * `CindyMeka` 目录；dev 保持独立。本模块保留纯函数和早期调用位，兼容上游结构。
 *
 * 语义边界:
 *  - cn / global 目录名 = productName 默认派生目录 → 返回 null。
 *  - dev(非 packaged)永远返回 null:dev 的隔离语义由 --isolated /
 *    XDT_USER_DATA_DIR(devCliFlags)承载,不与区域身份耦合。
 *  - 命令行显式传了 Chromium 原生 `--user-data-dir` 时返回 null,尊重调用方
 *    (smoke-packaged.mjs 用它把假库指到 os.tmpdir 临时目录)。
 *  - 只决定**目录名**,拼绝对路径(appData 基址)留给调用方——本模块保持
 *    零 Electron 依赖,可直接单测。
 */

import {
  BRAND_IDENTITY,
  brandUserDataDirName,
  type CindyRegion,
} from '@cindy/maker-shared/brand-identity';

/** argv 里是否显式指定了 Chromium 原生 --user-data-dir(= 与空格两种形态)。 */
function hasExplicitUserDataDir(argv: readonly string[]): boolean {
  return argv.some((a) => a === '--user-data-dir' || a.startsWith('--user-data-dir='));
}

/**
 * 解析本构建是否需要覆写 userData 目录。
 * 返回目录名(调用方拼到 appData 下)或 null(保持 Electron 默认)。
 */
export function resolveRegionUserDataDirName(input: {
  isPackaged: boolean;
  region: CindyRegion;
  argv: readonly string[];
}): string | null {
  if (!input.isPackaged) return null;
  if (hasExplicitUserDataDir(input.argv)) return null;
  const dirName = brandUserDataDirName(input.region);
  // 与 productName 默认派生目录同名 → 不覆写,走 Electron 原生路径。
  if (dirName === BRAND_IDENTITY.userDataDirName) return null;
  return dirName;
}
