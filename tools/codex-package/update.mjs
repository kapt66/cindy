#!/usr/bin/env node

/**
 * update.mjs — 下载 openai/codex GitHub Release 的完整 codex-package 运行时。
 *
 * 用法：
 *   node tools/codex-package/update.mjs            # 拉最新版
 *   node tools/codex-package/update.mjs 0.145.0    # 固定版本
 *   node tools/codex-package/update.mjs --platform=win32-x64
 *
 * 与 tools/codex/update.mjs 的单二进制形态不同，官方 codex-package 是完整目录：
 * codex-package.json + bin/ + codex-path/ + codex-resources/。本脚本完整保留该
 * 布局，并校验官方 package manifest、入口文件、旁侧资产与目录清单。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createDownloadProgressLogger,
  downloadToFileWithTimeout,
  fetchJsonWithTimeout,
} from '../shared/fetch-with-timeout.mjs';
import {
  normalizeExpectedSha256,
  sha256File,
  verifyFileSha256OrRemove,
} from '../shared/verify-sha256.mjs';
import {
  verifyDirDistManifest,
  writeDirDistManifest,
} from '../shared/dir-dist-manifest.mjs';
import {
  PLACEMENT_RENAME_RETRY_DELAYS_MS,
  SWAP_RENAME_RETRY_DELAYS_MS,
  renameWithRetry,
} from '../shared/rename-with-retry.mjs';
import {
  RuntimeInstallError,
  asRuntimeInstallError,
  describeErrorChain,
} from '../shared/runtime-install-error.mjs';
import { pinnedAssetDescriptor, resolveInstallReleaseMeta } from '../shared/github-release-pin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const RELEASES_LATEST_URL = 'https://api.github.com/repos/openai/codex/releases/latest';
const RELEASES_BY_TAG_URL = (tag) => `https://api.github.com/repos/openai/codex/releases/tags/${tag}`;
const CACHE_FILE = path.join(__dirname, 'latest.json');
const UPDATES_DIR = path.join(__dirname, 'updates');
const BIN_DIR = path.join(PROJECT_ROOT, 'apps', 'codex-package-bin');
const PACKAGE_MANIFEST_FILE = 'codex-package.json';
const PACKAGE_LAYOUT_VERSION = 1;
const PACKAGE_VARIANT = 'codex';
const RESOURCES_DIR = 'codex-resources';
const PATH_DIR = 'codex-path';
const ASSET_DIGEST_FILE = '.asset-digest.bin';

export const CODEX_PACKAGE_PLATFORMS = Object.freeze([
  {
    key: 'darwin-arm64',
    target: 'aarch64-apple-darwin',
    asset: 'codex-package-aarch64-apple-darwin.tar.gz',
    entrypoint: 'bin/codex',
  },
  {
    key: 'darwin-x64',
    target: 'x86_64-apple-darwin',
    asset: 'codex-package-x86_64-apple-darwin.tar.gz',
    entrypoint: 'bin/codex',
  },
  {
    key: 'linux-x64',
    target: 'x86_64-unknown-linux-musl',
    asset: 'codex-package-x86_64-unknown-linux-musl.tar.gz',
    entrypoint: 'bin/codex',
  },
  {
    key: 'linux-arm64',
    target: 'aarch64-unknown-linux-musl',
    asset: 'codex-package-aarch64-unknown-linux-musl.tar.gz',
    entrypoint: 'bin/codex',
  },
  {
    key: 'win32-x64',
    target: 'x86_64-pc-windows-msvc',
    asset: 'codex-package-x86_64-pc-windows-msvc.tar.gz',
    entrypoint: 'bin/codex.exe',
  },
  {
    key: 'win32-arm64',
    target: 'aarch64-pc-windows-msvc',
    asset: 'codex-package-aarch64-pc-windows-msvc.tar.gz',
    entrypoint: 'bin/codex.exe',
  },
]);

function ghHeaders() {
  const headers = { 'User-Agent': 'cindy-codex-package-update' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchReleaseMeta(tag) {
  const url = tag ? RELEASES_BY_TAG_URL(tag) : RELEASES_LATEST_URL;
  return fetchJsonWithTimeout(url, { headers: ghHeaders() });
}

function versionFromTag(tag) {
  const match = tag.match(/^rust-v(\d+\.\d+\.\d+)$/);
  if (!match) throw new Error(`Unexpected tag format: ${tag} (expected rust-vX.Y.Z)`);
  return match[1];
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function readCachedVersion() {
  return readCache()?.version ?? null;
}

function runtimeAssetPins(meta, version) {
  return Object.fromEntries(CODEX_PACKAGE_PLATFORMS.map((platform) => {
    const asset = (meta.assets || []).find((candidate) => candidate.name === platform.asset);
    const sha256 = normalizeExpectedSha256(asset?.digest);
    if (!asset || typeof asset.browser_download_url !== 'string' || !sha256) {
      throw new Error(`Cannot pin codex-package ${version} ${platform.key}: release asset metadata is incomplete`);
    }
    return [platform.key, {
      url: asset.browser_download_url,
      sha256,
      ...(typeof asset.size === 'number' && asset.size > 0 ? { size: asset.size } : {}),
      target: platform.target,
      entrypoint: platform.entrypoint,
    }];
  }));
}

function saveCache(meta, version) {
  const cache = {
    version,
    tag_name: meta.tag_name,
    name: meta.name,
    published_at: meta.published_at,
    layoutVersion: PACKAGE_LAYOUT_VERSION,
    variant: PACKAGE_VARIANT,
    runtimeAssets: runtimeAssetPins(meta, version),
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
}

/** Fail closed when mutable GitHub release metadata no longer matches the reviewed pin. */
export function assertPinnedRuntimeAsset(cache, meta, version, platform) {
  if (!cache || cache.version !== version) {
    throw new Error(`Codex package runtime pin missing for ${platform.key}@${version}`);
  }
  if (cache.layoutVersion !== PACKAGE_LAYOUT_VERSION || cache.variant !== PACKAGE_VARIANT) {
    throw new Error(`Codex package layout pin is incompatible for ${platform.key}@${version}`);
  }
  const pin = cache.runtimeAssets?.[platform.key];
  const asset = (meta.assets || []).find((candidate) => candidate.name === platform.asset);
  const liveSha256 = normalizeExpectedSha256(asset?.digest);
  if (!pin || !asset || !liveSha256 || liveSha256 !== pin.sha256) {
    throw new Error(`Codex package asset digest does not match pin for ${platform.key}@${version}`);
  }
  if (asset.browser_download_url !== pin.url) {
    throw new Error(`Codex package asset URL does not match pin for ${platform.key}@${version}`);
  }
  if (pin.target !== platform.target || pin.entrypoint !== platform.entrypoint) {
    throw new Error(`Codex package target metadata does not match pin for ${platform.key}@${version}`);
  }
  return asset;
}

function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function readCachedAssetDigest(destDir) {
  try {
    return normalizeExpectedSha256(fs.readFileSync(path.join(destDir, ASSET_DIGEST_FILE), 'utf8'));
  } catch {
    return null;
  }
}

export function assetDigestMatchesUpstream(recordedDigest, asset) {
  const upstream = normalizeExpectedSha256(asset?.digest);
  const recorded = normalizeExpectedSha256(recordedDigest);
  return !!upstream && !!recorded && upstream === recorded;
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function assertSafePackageTree(rootDir) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Codex package contains unsupported symlink: ${path.relative(rootDir, absolutePath)}`);
      }
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Codex package contains unsupported filesystem entry: ${path.relative(rootDir, absolutePath)}`);
      }
    }
  };
  walk(rootDir);
}

export function validateCodexPackageDirectory(packageDir, { version, target, entrypoint }) {
  const manifestPath = path.join(packageDir, PACKAGE_MANIFEST_FILE);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Codex package manifest unreadable: ${manifestPath}`, { cause: error });
  }

  const expected = {
    layoutVersion: PACKAGE_LAYOUT_VERSION,
    version,
    target,
    variant: PACKAGE_VARIANT,
    entrypoint,
    resourcesDir: RESOURCES_DIR,
    pathDir: PATH_DIR,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (manifest?.[field] !== value) {
      throw new Error(`Codex package manifest ${field} mismatch: expected ${JSON.stringify(value)}, got ${JSON.stringify(manifest?.[field])}`);
    }
  }

  assertSafePackageTree(packageDir);

  const entrypointPath = path.join(packageDir, ...entrypoint.split('/'));
  const executableSuffix = entrypoint.endsWith('.exe') ? '.exe' : '';
  const codeModeHostPath = path.join(packageDir, 'bin', `codex-code-mode-host${executableSuffix}`);
  const ripgrepPath = path.join(packageDir, PATH_DIR, `rg${executableSuffix}`);
  const resourcesPath = path.join(packageDir, RESOURCES_DIR);

  for (const requiredFile of [entrypointPath, codeModeHostPath, ripgrepPath]) {
    if (!isRegularFile(requiredFile)) {
      throw new Error(`Codex package required file missing: ${requiredFile}`);
    }
  }
  if (!isDirectory(resourcesPath)) {
    throw new Error(`Codex package resources directory missing: ${resourcesPath}`);
  }

  return {
    manifest,
    entrypointPath,
    codeModeHostPath,
    ripgrepPath,
    resourcesPath,
  };
}

function chmodPackageExecutables(validated) {
  if (process.platform === 'win32') return;
  for (const filePath of [validated.entrypointPath, validated.codeModeHostPath, validated.ripgrepPath]) {
    try { fs.chmodSync(filePath, 0o755); } catch { /* ignore */ }
  }
  const chmodResources = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) chmodResources(absolutePath);
      else if (entry.isFile()) {
        try { fs.chmodSync(absolutePath, 0o755); } catch { /* ignore */ }
      }
    }
  };
  chmodResources(validated.resourcesPath);
}

function entrypointHashMarker(packageDir, entrypoint) {
  return path.join(packageDir, ...entrypoint.split('/')) + '.sha256.bin';
}

function isPackageCacheUsable(packageDir, version, platform) {
  try {
    const validated = validateCodexPackageDirectory(packageDir, {
      version,
      target: platform.target,
      entrypoint: platform.entrypoint,
    });
    if (!verifyDirDistManifest(packageDir)) return false;
    const expectedHash = fs.readFileSync(entrypointHashMarker(packageDir, platform.entrypoint), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(expectedHash) && sha256File(validated.entrypointPath) === expectedHash;
  } catch {
    return false;
  }
}

function targetsExist(version, targets) {
  return targets.every((platform) => isPackageCacheUsable(
    path.join(UPDATES_DIR, version, platform.key),
    version,
    platform,
  ));
}

function targetsMatchUpstreamDigest(meta, version, targets) {
  return targets.every((platform) => {
    const asset = (meta.assets || []).find((candidate) => candidate.name === platform.asset);
    return assetDigestMatchesUpstream(
      readCachedAssetDigest(path.join(UPDATES_DIR, version, platform.key)),
      asset,
    );
  });
}

/** 用系统 tar 从 stdin 解压，避免 Windows 盘符被 tar 误判成远程主机。 */
export async function extractArchive(archivePath, destDir) {
  const child = spawn('tar', ['-xzf', '-'], { cwd: destDir, stdio: ['pipe', 'inherit', 'inherit'] });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`))));
  });
  const input = pipeline(fs.createReadStream(archivePath), child.stdin);
  try {
    await Promise.all([input, exit]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.allSettled([input, exit]);
    throw error;
  }
}

/**
 * 用同卷原子改名把 staging 目录换成 destinationDir。
 *
 * 两处改名都走有界退避重试：Windows 上刚写入的 `.exe` 会被安全扫描/预读组件短暂持有，
 * rename 一个包含它的目录会返回 EPERM（2026-09-16 Windows canary 发布失败的真因；
 * 实测数据见 docs/dev-rules/agent-runtime-release.md）。落位成功后旧备份删不掉只告警——
 * 那时候新 runtime 已经生效，不能把成功报成失败。
 *
 * @param {string} stagingDir
 * @param {string} destinationDir
 * @param {{ renameSync?: Function, sleep?: Function, remove?: Function, warn?: Function }} [deps]
 *   单测注入缝（注入的是最底层 rename/sleep/rm，重试逻辑本身仍走生产实现），生产不传。
 */
export function replaceDirectory(stagingDir, destinationDir, deps = {}) {
  const {
    renameSync = fs.renameSync,
    sleep,
    remove = (targetPath) => fs.rmSync(targetPath, { recursive: true, force: true }),
    warn = (message) => console.warn(message),
  } = deps;

  const backupDir = `${destinationDir}.backup-${process.pid}-${Date.now()}`;
  let backedUp = false;
  try {
    if (fs.existsSync(destinationDir)) {
      // 旧目录里可能有正在运行的镜像：那不是会自动消失的锁，预算刻意短（见 rename-with-retry）。
      renameWithRetry(destinationDir, backupDir, {
        delaysMs: SWAP_RENAME_RETRY_DELAYS_MS,
        rename: renameSync,
        sleep,
      });
      backedUp = true;
    }
    try {
      renameWithRetry(stagingDir, destinationDir, {
        delaysMs: PLACEMENT_RENAME_RETRY_DELAYS_MS,
        rename: renameSync,
        sleep,
      });
    } catch (error) {
      // 新运行时没落位就还原旧目录，保持"要么新、要么旧"的不变量。
      if (!fs.existsSync(destinationDir) && backedUp && fs.existsSync(backupDir)) {
        try { renameSync(backupDir, destinationDir); } catch { /* 保留原始错误 */ }
      }
      throw error;
    }
    if (backedUp && fs.existsSync(backupDir)) {
      try {
        remove(backupDir);
      } catch (error) {
        warn(`  WARN: 旧 runtime 备份未能删除，可手动清理：${backupDir}（${describeErrorChain(error)}）`);
      }
    }
  } finally {
    try { remove(stagingDir); } catch { /* ignore */ }
    if (backedUp && fs.existsSync(destinationDir)) {
      try { remove(backupDir); } catch { /* ignore */ }
    }
  }
}

async function downloadAsset(meta, version, platform, { force = false, throughputGuard = false } = {}) {
  const asset = (meta.assets || []).find((candidate) => candidate.name === platform.asset);
  if (!asset) throw new Error(`Asset not found in release: ${platform.asset} (tag ${meta.tag_name})`);

  const destinationDir = path.join(UPDATES_DIR, version, platform.key);
  if (
    !force
    && isPackageCacheUsable(destinationDir, version, platform)
    && assetDigestMatchesUpstream(readCachedAssetDigest(destinationDir), asset)
  ) {
    const entrypointPath = path.join(destinationDir, ...platform.entrypoint.split('/'));
    console.log(`  [${platform.key}] skip (cached, package complete, digest pinned, ${formatMB(fs.statSync(entrypointPath).size)})`);
    return;
  }

  const expectedDigest = asset.digest;
  if (!expectedDigest) {
    throw new Error(
      `codex-package ${platform.key} asset ${platform.asset}@${version}: digest field absent — `
      + 'GitHub only provides asset digests for releases published after 2025-06-03.',
    );
  }

  fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
  const stagingDir = `${destinationDir}.staging-${process.pid}-${Date.now()}`;
  const tempArchive = path.join(os.tmpdir(), `codex-package-${version}-${platform.key}-${Date.now()}.tar.gz`);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  console.log(`  [${platform.key}] ${asset.browser_download_url}`);
  const progress = createDownloadProgressLogger(platform.key);
  try {
    try {
      await downloadToFileWithTimeout(asset.browser_download_url, tempArchive, { headers: ghHeaders() }, {
        onProgress: progress.onProgress,
        minThroughputBytesPerSec: throughputGuard ? undefined : 0,
      });
    } finally {
      progress.finish();
    }

    const verifiedDigest = verifyFileSha256OrRemove(
      tempArchive,
      expectedDigest,
      `codex-package ${platform.key} asset ${platform.asset}@${version}`,
    );
    console.log(`    [${platform.key}] sha256 ok`);

    await extractArchive(tempArchive, stagingDir);
    const validated = validateCodexPackageDirectory(stagingDir, {
      version,
      target: platform.target,
      entrypoint: platform.entrypoint,
    });
    chmodPackageExecutables(validated);
    fs.writeFileSync(entrypointHashMarker(stagingDir, platform.entrypoint), `${sha256File(validated.entrypointPath)}\n`);
    fs.writeFileSync(path.join(stagingDir, ASSET_DIGEST_FILE), `${verifiedDigest}\n`);
    writeDirDistManifest(stagingDir);
    if (!verifyDirDistManifest(stagingDir)) {
      throw new Error(`Codex package directory manifest verification failed: ${stagingDir}`);
    }

    replaceDirectory(stagingDir, destinationDir);
    const finalEntrypoint = path.join(destinationDir, ...platform.entrypoint.split('/'));
    console.log(`    → ${finalEntrypoint} (${formatMB(fs.statSync(finalEntrypoint).size)})`);
  } finally {
    try { fs.rmSync(tempArchive, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function promoteOnePlatform(version, platform) {
  const sourceDir = path.join(UPDATES_DIR, version, platform.key);
  if (!isPackageCacheUsable(sourceDir, version, platform)) {
    console.warn(`  [${platform.key}] WARN: source package missing or incomplete, skipping (${sourceDir})`);
    return;
  }

  const destinationDir = path.join(BIN_DIR, platform.key);
  const stagingDir = `${destinationDir}.staging-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.cpSync(sourceDir, stagingDir, { recursive: true });
    const validated = validateCodexPackageDirectory(stagingDir, {
      version,
      target: platform.target,
      entrypoint: platform.entrypoint,
    });
    chmodPackageExecutables(validated);
    fs.writeFileSync(path.join(stagingDir, '.version'), `${version}\n`);
    writeDirDistManifest(stagingDir);
    if (!verifyDirDistManifest(stagingDir)) {
      throw new Error(`Promoted Codex package manifest verification failed: ${stagingDir}`);
    }
    replaceDirectory(stagingDir, destinationDir);
  } catch (error) {
    // 落位是本地动作：这里失败与下载无关，必须带上阶段标签，避免上层误报成
    // "Failed to download ... from upstream" 并去走无用的 CDN 兜底。
    const lockHint = isTargetLockError(error)
      ? ' 目标目录（或其中刚写入的 runtime 文件）仍被占用——应用正在运行就关掉它再重试。'
      : '';
    throw new RuntimeInstallError(
      'promote',
      `codex-package ${platform.key}@${version}: 落位到 ${destinationDir} 失败：` +
        `${describeErrorChain(error)}。${lockHint}`,
      { cause: error },
    );
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const entrypointPath = path.join(destinationDir, ...platform.entrypoint.split('/'));
  console.log(`  [${platform.key}] → ${entrypointPath} (${formatMB(fs.statSync(entrypointPath).size)})`);
}

export function isTargetLockError(error) {
  return error?.code === 'EBUSY' || error?.code === 'ETXTBSY' || error?.code === 'EPERM';
}

function promoteToVendorBin(version, platforms = CODEX_PACKAGE_PLATFORMS) {
  console.log('');
  console.log('==> Promoting to apps/codex-package-bin/ ...');
  for (const platform of platforms) promoteOnePlatform(version, platform);
}

export function readPinnedVersion() {
  return readCachedVersion();
}

/**
 * 解析本次安装要用的 release 元数据：优先上游 API + pin 交叉校验，仅在上游限流时降级为
 * pin 直链（未认证 api.github.com 只有 60 次/小时，是与开发机共用出口 IP 的 runner 上的真实
 * 阻断点；内容仍由 pin 的 sha256 强制校验）。导出以便单测注入 fetchMeta。
 */
export async function resolveCodexPackageInstallMeta({ version, platform, fetchMeta = fetchReleaseMeta, warn }) {
  return resolveInstallReleaseMeta({
    fetchLiveMeta: () => fetchMeta(`rust-v${version}`),
    assertPinned: (meta) => assertPinnedRuntimeAsset(readCache(), meta, version, platform),
    pinnedMeta: () => ({
      assets: [
        pinnedAssetDescriptor(readCache(), platform.key, {
          assetName: platform.asset,
          label: `codex-package ${version}`,
          expectedTarget: platform.target,
          expectedEntrypoint: platform.entrypoint,
        }),
      ],
    }),
    warn,
  });
}

export async function ensurePlatform({ version, platformKey, force = false }) {
  const platform = CODEX_PACKAGE_PLATFORMS.find((candidate) => candidate.key === platformKey);
  if (!platform) throw new Error(`Unknown platform key for codex-package: ${platformKey}`);
  const { meta } = await resolveCodexPackageInstallMeta({ version, platform });
  try {
    // 下载 / 解压 / 校验 / 缓存落位：只有这一段失败才可能值得走网络侧兜底。
    await downloadAsset(meta, version, platform, { force, throughputGuard: true });
  } catch (error) {
    throw asRuntimeInstallError('download', error);
  }
  promoteOnePlatform(version, platform);
}

function parseArgs(argv) {
  const args = { version: null, force: false, platform: null };
  for (const argument of argv) {
    if (argument === '--force' || argument === '-f') args.force = true;
    else if (argument.startsWith('--platform=')) args.platform = argument.slice('--platform='.length);
    else if (argument.startsWith('--version=')) args.version = argument.slice('--version='.length);
    else if (!argument.startsWith('-')) args.version = argument;
  }
  return args;
}

function resolvePlatforms(platformKey) {
  if (!platformKey) return CODEX_PACKAGE_PLATFORMS;
  const platform = CODEX_PACKAGE_PLATFORMS.find((candidate) => candidate.key === platformKey);
  if (!platform) {
    throw new Error(
      `Unknown --platform=${platformKey} (known: ${CODEX_PACKAGE_PLATFORMS.map((candidate) => candidate.key).join(', ')})`,
    );
  }
  return [platform];
}

async function main() {
  const { version: requestedVersion, force, platform: platformKey } = parseArgs(process.argv.slice(2));
  const targets = resolvePlatforms(platformKey);

  if (requestedVersion) {
    const tag = `rust-v${requestedVersion}`;
    console.log(`==> Pinning codex-package to ${requestedVersion} (specified, tag=${tag})...`);
    const meta = await fetchReleaseMeta(tag);
    for (const platform of targets) {
      await downloadAsset(meta, requestedVersion, platform, { force });
    }
    promoteToVendorBin(requestedVersion, targets);
    saveCache(meta, requestedVersion);
    console.log('');
    console.log('=== Done ===');
    console.log(`Version: ${requestedVersion}`);
    console.log(`Output:  ${path.join(UPDATES_DIR, requestedVersion)}`);
    console.log(`Bin:     ${BIN_DIR}`);
    return;
  }

  console.log('==> Fetching latest release from GitHub (openai/codex codex-package)...');
  const meta = await fetchReleaseMeta(null);
  const latestVersion = versionFromTag(meta.tag_name);
  const cachedVersion = readCachedVersion();
  console.log(`    Latest: ${latestVersion} (${meta.tag_name})`);
  console.log(`    Cached: ${cachedVersion ?? '(none)'}`);

  if (
    cachedVersion === latestVersion
    && !force
    && targetsExist(latestVersion, targets)
    && targetsMatchUpstreamDigest(meta, latestVersion, targets)
  ) {
    saveCache(meta, latestVersion);
    promoteToVendorBin(latestVersion, targets);
    console.log('==> Already up to date.');
    return;
  }

  console.log(`==> New version detected (${cachedVersion ?? 'none'} → ${latestVersion}), downloading...`);
  for (const platform of targets) {
    await downloadAsset(meta, latestVersion, platform, { force });
  }
  saveCache(meta, latestVersion);
  promoteToVendorBin(latestVersion, targets);

  console.log('');
  console.log('=== Done ===');
  console.log(`Version: ${latestVersion}`);
  console.log(`Output:  ${path.join(UPDATES_DIR, latestVersion)}`);
  console.log(`Bin:     ${BIN_DIR}`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
