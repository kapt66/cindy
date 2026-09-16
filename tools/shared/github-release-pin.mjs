/**
 * github-release-pin —— GitHub Release runtime 安装路径的"pin 优先"降级。
 *
 * 背景（2026-09-16 Windows canary 发布第二次失败）：安装链路先用 api.github.com 取 release
 * 元数据、再与 pin 比对。未认证的 GitHub API 配额是**每出口 IP 60 次/小时**，而 runner 与开发机
 * 是同一台机器、共用同一出口 IP，配额耗尽后 `fetchReleaseMeta` 直接 403
 * （`HTTP 403 rate limit exceeded`），codex-package 与 pi 当场装不上，发布被阻断。
 *
 * 事实边界：pin（`tools/<kind>/latest.json` 的 `runtimeAssets.<platformKey>`）本身就记录了官方
 * 资产的直链、sha256 与字节数，是**经过复核、随仓库分发**的信任锚；API 元数据只是"上游元数据
 * 是否仍与 pin 一致"的交叉校验。因此：
 *   - **内容校验不降级**：始终从 pin 的直链下载，并按 pin 的 sha256 逐字节校验，不符即失败；
 *   - **交叉校验尽力而为**：能取到 API 元数据就照旧比对；仅在**限流**（403 + rate limit / 429）
 *     时降级为纯 pin 模式并显式告警；
 *   - **其它 API 错误仍 fail closed**：例如 404（pin 指向的 release 不存在）必须报错，
 *     不能靠降级把"pin 已失效"变成"下载一个不该下载的东西"。
 *
 * 注意：这不是"允许离线绕过校验"。降级只影响"是否与上游元数据交叉比对"，不影响
 * "下载物必须等于 pin 的 sha256"这条硬门禁。
 */

import { normalizeExpectedSha256 } from './verify-sha256.mjs';

/** 允许的官方资产来源：GitHub Release 直链（与 pin 记录一致）。 */
const APPROVED_ASSET_HOST = 'github.com';

/**
 * 是否为 GitHub API 限流/配额耗尽。只认 429，或 403 且带限流信号；其它 403（例如
 * 权限/策略拒绝）保持 fail closed，不降级。
 */
export function isGitHubRateLimitError(error) {
  const status = Number(error?.status);
  if (status === 429) return true;
  if (status !== 403) return false;
  const signal = `${error?.statusText ?? ''} ${error?.message ?? ''}`;
  return /rate limit|secondary rate|abuse detection|api rate limit exceeded/i.test(signal);
}

/**
 * 从已复核的 pin 构造 release 资产描述符（与 GitHub API 的 asset 字段同形，供下载函数复用）。
 * 任何字段缺失/非法都抛错（fail closed）——降级路径同样不能放宽信任边界。
 *
 * @param {object} pin `tools/<kind>/latest.json` 解析结果
 * @param {string} platformKey 如 `win32-x64`
 * @param {{ assetName: string, label?: string, expectedTarget?: string, expectedEntrypoint?: string }} options
 */
export function pinnedAssetDescriptor(pin, platformKey, options) {
  const { assetName, label = assetName, expectedTarget, expectedEntrypoint } = options;
  const asset = pin?.runtimeAssets?.[platformKey];
  const fail = (detail) => {
    throw new Error(`Pinned ${label} asset metadata is ${detail} for ${platformKey}`);
  };
  if (!asset) fail('missing');
  const sha256 = normalizeExpectedSha256(asset.sha256);
  const size = Number(asset.size);
  if (!sha256) fail('missing a valid sha256');
  if (!Number.isFinite(size) || size <= 0) fail('missing a valid size');
  if (typeof asset.url !== 'string' || asset.url.length === 0) fail('missing a download URL');
  let url;
  try {
    url = new URL(asset.url);
  } catch {
    fail(`not a valid URL (${asset.url})`);
  }
  if (url.protocol !== 'https:' || url.host !== APPROVED_ASSET_HOST) {
    throw new Error(`Pinned ${label} asset URL is not an approved ${APPROVED_ASSET_HOST} release asset: ${asset.url}`);
  }
  if (expectedTarget !== undefined && asset.target !== expectedTarget) {
    throw new Error(`Pinned ${label} target metadata does not match for ${platformKey}: ${asset.target} !== ${expectedTarget}`);
  }
  if (expectedEntrypoint !== undefined && asset.entrypoint !== expectedEntrypoint) {
    throw new Error(`Pinned ${label} entrypoint metadata does not match for ${platformKey}: ${asset.entrypoint} !== ${expectedEntrypoint}`);
  }
  return {
    name: assetName,
    browser_download_url: asset.url,
    digest: `sha256:${sha256}`,
    size,
  };
}

/**
 * 取"本次安装要用的 release 元数据"：优先上游 API 并做 pin 交叉校验；仅在上游限流时降级为
 * pin 直链（sha256 仍由下载阶段强制校验）。
 *
 * @param {object} options
 * @param {() => Promise<object>} options.fetchLiveMeta 取上游 release 元数据
 * @param {(meta: object) => void} options.assertPinned 用 pin 交叉校验上游元数据（不一致即抛）
 * @param {() => object} options.pinnedMeta 由 pin 构造元数据（缺字段即抛 = fail closed）
 * @param {(message: string) => void} [options.warn]
 * @returns {Promise<{ meta: object, pinOnly: boolean }>}
 */
export async function resolveInstallReleaseMeta({ fetchLiveMeta, assertPinned, pinnedMeta, warn = (message) => console.warn(message) }) {
  try {
    const meta = await fetchLiveMeta();
    assertPinned(meta);
    return { meta, pinOnly: false };
  } catch (error) {
    if (!isGitHubRateLimitError(error)) throw error;
    warn(
      `  WARN: GitHub API rate limit hit (${error.message}); installing from the reviewed pin instead ` +
        '(the pinned sha256 is still enforced).',
    );
    return { meta: pinnedMeta(), pinOnly: true };
  }
}
