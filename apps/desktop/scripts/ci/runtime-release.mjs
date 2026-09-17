import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gzipFile } from '../../../../scripts/shared/oss.mjs';
import { CODEX_PACKAGE_PLATFORMS } from '../../../../tools/codex-package/update.mjs';
import {
  createDownloadProgressLogger,
  downloadToFileWithTimeout,
} from '../../../../tools/shared/fetch-with-timeout.mjs';
import { pinnedAssetDescriptor } from '../../../../tools/shared/github-release-pin.mjs';
import { normalizeExpectedSha256, verifyFileSha256OrRemove } from '../../../../tools/shared/verify-sha256.mjs';
import { sha256File } from './release-lib.mjs';

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const RUNTIME_DEFINITIONS = Object.freeze([
  Object.freeze({
    field: 'claudeCode',
    objectRoot: 'claude-code',
    sourceDir: 'claude-code-bin',
    binaryBaseName: 'claude',
  }),
  Object.freeze({
    field: 'codex',
    objectRoot: 'codex',
    sourceDir: 'codex-bin',
    binaryBaseName: 'codex',
  }),
  Object.freeze({
    field: 'ripgrep',
    objectRoot: 'ripgrep',
    sourceDir: 'ripgrep-bin',
    binaryBaseName: 'rg',
  }),
]);

export const AGENT_RUNTIME_DEFINITIONS = Object.freeze(
  RUNTIME_DEFINITIONS.filter(({ field }) => field === 'claudeCode' || field === 'codex'),
);

/**
 * 桌面端**启动时真正消费**的 vendor runtime 定义——目录分发形态（`tar-gz-dir`）。
 *
 * 事实（2026-09-16 Windows canary 0.0.21「环境初始化失败」的根因）：上游
 * `b43ee771ad`（2026-09-03）把生产侧 codex 从**单文件**换成**目录分发**后，桌面端
 * `agent-binaries` 的 `CONFIG.codex` 变成 `manifestField: 'codexPackage'` +
 * `artifactKind: 'tar-gz-dir'`（`apps/desktop/src/main/agent-binaries/index.ts`）。
 * 缺这个字段时 `prepare('codex')` 直接返回 `asset_missing`，`check-environment`
 * `allPassed=false`，splash 进入「环境初始化失败」——而且 asset 查找先于本地回退，
 * 本机既有旧单文件 codex 也救不回来。
 *
 * 因此应用 manifest 必须**同时**带：
 *   - `codex`（单文件 gz，`RUNTIME_DEFINITIONS`）：MCPRouter 的 linux runtime manifest
 *     与 ≤0.0.20 客户端仍读它（老客户端读不到会在热更到新版之前就先卡死在启动页）；
 *   - `codexPackage`（整目录 tar.gz，本定义）：≥0.0.21 桌面端启动所需的目录分发 runtime。
 *
 * 落点对象直接复用 pin 记录的**上游官方包**（`tools/codex-package/latest.json` 的
 * `runtimeAssets.<platformKey>`：直链 + sha256 + 字节数）：字节可复现、sha256 与 pin
 * 同源，不依赖发版机本地 `apps/codex-package-bin` 的落位状态，也不会因为「本机重新
 * 打包一次 → 字节不同」在同一个不可覆盖对象上撞车。
 */
export const DIR_DIST_RUNTIME_DEFINITIONS = Object.freeze([
  Object.freeze({
    field: 'codexPackage',
    objectRoot: 'codex-package',
    archiveName: 'codex-package.tar.gz',
    // 规范平台表（安装侧维护，发布侧只读复用）：target/entrypoint 的交叉校验真值。
    canonicalPlatforms: CODEX_PACKAGE_PLATFORMS,
    pinFile: ['tools', 'codex-package', 'latest.json'],
    pinLabel: 'codex-package',
  }),
]);

/** 应用 canary/stable manifest 必须齐全的 runtime 段（单文件三个 + 目录分发 codexPackage）。 */
export const RELEASE_RUNTIME_DEFINITIONS = Object.freeze([
  ...RUNTIME_DEFINITIONS,
  ...DIR_DIST_RUNTIME_DEFINITIONS,
]);

const PLATFORM_KEY_RE = /^(?:win32|darwin|linux)-(?:x64|arm64)$/;

function runtimeBinaryName(platformKey, baseName) {
  return platformKey.startsWith('win32-') ? `${baseName}.exe` : baseName;
}

export function collectLocalRuntimeAssets(
  platformKey,
  { projectRoot = PROJECT_ROOT, definitions = RUNTIME_DEFINITIONS } = {},
) {
  return Object.fromEntries(
    definitions.map((definition) => {
      const sourceRoot = path.join(projectRoot, 'apps', definition.sourceDir, platformKey);
      const versionFile = path.join(sourceRoot, '.version');
      if (!fs.existsSync(versionFile)) {
        // 不吞错也不抛裸 ENOENT：点名是哪个 runtime、缺哪个路径、用哪条命令补齐
        // （2026-09-16 canary 就是在这里以一个无上下文的 ENOENT 失败的）。
        throw new Error(
          `${definition.field} 本地 runtime 未就位：缺少 ${versionFile}。` +
            `发布物里的 runtime 是单文件形态，需先执行 ` +
            `"node scripts/ensure-agent-binaries.mjs --kinds=claude,codex-single,ripgrep --platform=${platformKey}"。`,
        );
      }
      const version = fs.readFileSync(versionFile, 'utf8').trim();
      if (!VERSION_RE.test(version)) {
        throw new Error(`${definition.field} 本地版本非法: ${version || '<empty>'}`);
      }
      const binaryName = runtimeBinaryName(platformKey, definition.binaryBaseName);
      const binaryPath = path.join(sourceRoot, binaryName);
      const stat = fs.statSync(binaryPath);
      if (!stat.isFile() || stat.size <= 1024) {
        throw new Error(`${definition.field} 本地二进制缺失或无效: ${binaryPath}`);
      }
      const binarySha256 = sha256File(binaryPath);
      const file = `${definition.objectRoot}/${version}/${platformKey}/${binaryName}.gz`;
      return [
        definition.field,
        Object.freeze({
          ...definition,
          version,
          platformKey,
          binaryName,
          binaryPath,
          binarySha256,
          file,
        }),
      ];
    }),
  );
}

function validRuntimeManifestAsset(asset, platformKey) {
  return (
    asset &&
    typeof asset === 'object' &&
    VERSION_RE.test(asset.version) &&
    typeof asset.file === 'string' &&
    asset.file.includes(`/${platformKey}/`) &&
    !asset.file.includes('..') &&
    SHA256_RE.test(asset.sha256) &&
    Number.isSafeInteger(asset.size) &&
    asset.size > 0 &&
    (asset.binarySha256 === undefined || SHA256_RE.test(asset.binarySha256))
  );
}

export function assertRuntimeManifestAssets(
  manifest,
  platformKey,
  { required = true, allowMissing = [], definitions = RUNTIME_DEFINITIONS } = {},
) {
  for (const definition of definitions) {
    const asset = manifest?.[definition.field];
    if (!asset && (!required || allowMissing.includes(definition.field))) continue;
    if (!validRuntimeManifestAsset(asset, platformKey)) {
      throw new Error(`manifest 缺少或包含非法的 ${definition.field} ${platformKey} 运行时资产`);
    }
  }
  return manifest;
}

export function runtimeManifestKey(platformKey) {
  if (!PLATFORM_KEY_RE.test(platformKey)) {
    throw new Error(`非法 runtime platformKey=${platformKey}`);
  }
  return `runtime-manifest-${platformKey}.json`;
}

export function buildAgentRuntimeManifest(platformKey, assets) {
  const manifest = {
    schemaVersion: 1,
    platformKey,
    claudeCode: structuredClone(assets.claudeCode),
    codex: structuredClone(assets.codex),
  };
  assertRuntimeManifestAssets(manifest, platformKey, {
    definitions: AGENT_RUNTIME_DEFINITIONS,
  });
  return manifest;
}

async function prepareCompressedAsset(local, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(
    outputDir,
    `${local.field}-${local.version}-${local.platformKey}-${local.binaryName}.gz`,
  );
  const cachePath = `${outputPath}.json`;

  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const stat = fs.statSync(outputPath);
    if (
      cache.binarySha256 === local.binarySha256 &&
      stat.isFile() &&
      stat.size === cache.size &&
      sha256File(outputPath) === cache.sha256
    ) {
      return {
        filePath: outputPath,
        sha256: cache.sha256,
        size: cache.size,
      };
    }
  } catch {
    // Missing or stale compression cache; rebuild it below.
  }

  await gzipFile(local.binaryPath, outputPath);
  const compressed = {
    filePath: outputPath,
    sha256: sha256File(outputPath),
    size: fs.statSync(outputPath).size,
  };
  fs.writeFileSync(
    cachePath,
    `${JSON.stringify({
      binarySha256: local.binarySha256,
      sha256: compressed.sha256,
      size: compressed.size,
    })}\n`,
  );
  return compressed;
}

async function putImmutableRuntimeAsset(storage, local, compressed) {
  const remote = await storage.head(local.file);
  if (remote) {
    const remoteBinarySha256 = remote.metadata['binary-sha256']?.toLowerCase();
    const remoteGzipSha256 = remote.metadata.sha256?.toLowerCase();
    if (
      remoteBinarySha256 === local.binarySha256 &&
      SHA256_RE.test(remoteGzipSha256 ?? '') &&
      remote.size > 0
    ) {
      return {
        uploaded: false,
        manifestAsset: {
          version: local.version,
          file: local.file,
          sha256: remoteGzipSha256,
          size: remote.size,
          binarySha256: local.binarySha256,
        },
      };
    }
    if (remoteGzipSha256 === compressed.sha256 && remote.size === compressed.size) {
      return {
        uploaded: false,
        manifestAsset: {
          version: local.version,
          file: local.file,
          sha256: compressed.sha256,
          size: compressed.size,
          binarySha256: local.binarySha256,
        },
      };
    }
    throw new Error(`运行时版本化对象已存在但内容不同，拒绝覆盖: ${local.file}`);
  }

  await storage.putFile(local.file, compressed.filePath, {
    metadata: {
      sha256: compressed.sha256,
      'binary-sha256': local.binarySha256,
    },
  });
  const verified = await storage.head(local.file);
  if (
    !verified ||
    verified.size !== compressed.size ||
    verified.metadata.sha256?.toLowerCase() !== compressed.sha256 ||
    verified.metadata['binary-sha256']?.toLowerCase() !== local.binarySha256
  ) {
    throw new Error(`RustFS 运行时上传后校验失败: ${local.file}`);
  }
  return {
    uploaded: true,
    manifestAsset: {
      version: local.version,
      file: local.file,
      sha256: compressed.sha256,
      size: compressed.size,
      binarySha256: local.binarySha256,
    },
  };
}

export async function publishRuntimeAssets(
  storage,
  localAssets,
  baseManifest,
  outputDir,
  { definitions = RUNTIME_DEFINITIONS } = {},
) {
  const manifestAssets = {};
  const results = {};

  for (const definition of definitions) {
    const local = localAssets[definition.field];
    const existing = baseManifest?.[definition.field];
    if (
      validRuntimeManifestAsset(existing, local.platformKey) &&
      existing.version === local.version &&
      (!existing.binarySha256 || existing.binarySha256 === local.binarySha256) &&
      (await storage.head(existing.file))
    ) {
      manifestAssets[definition.field] = existing;
      results[definition.field] = 'reused';
      continue;
    }

    const compressed = await prepareCompressedAsset(local, outputDir);
    const published = await putImmutableRuntimeAsset(storage, local, compressed);
    manifestAssets[definition.field] = published.manifestAsset;
    results[definition.field] = published.uploaded ? 'uploaded' : 'reused';
  }

  assertRuntimeManifestAssets(
    { ...baseManifest, ...manifestAssets },
    Object.values(localAssets)[0].platformKey,
    { definitions },
  );
  return { manifestAssets: Object.freeze(manifestAssets), results: Object.freeze(results) };
}

// ── 目录分发 runtime（codexPackage）──────────────────────────────────────────

/**
 * 目录分发资产在「规范平台表」里的条目（发布侧的唯一真值来源）。
 *
 * 表由安装侧维护（`tools/codex-package/update.mjs` 的 `CODEX_PACKAGE_PLATFORMS`，
 * 就是 `ensurePlatform` 用来校验官方包布局的那份），发布侧只读复用——不在这里另造一份
 * 平台映射，否则两份表迟早漂移。
 */
function canonicalPlatformFor(definition, platformKey) {
  const table = definition.canonicalPlatforms;
  if (!Array.isArray(table)) {
    throw new Error(`${definition.field} 缺少 canonicalPlatforms 规范表`);
  }
  const entry = table.find((candidate) => candidate.key === platformKey);
  if (!entry) {
    throw new Error(`${definition.field} 规范表没有 ${platformKey} 条目`);
  }
  return entry;
}

/**
 * 从 pin 构造待发布目录分发资产（纯读盘，不触网）。
 *
 * pin 字段缺失/非法（含非 `https://github.com/...` 直链）即抛错：发布链路不能
 * 放宽信任边界，见 `tools/shared/github-release-pin.mjs`。
 */
export function collectPinnedDirDistAssets(
  platformKey,
  { projectRoot = PROJECT_ROOT, definitions = DIR_DIST_RUNTIME_DEFINITIONS } = {},
) {
  if (!PLATFORM_KEY_RE.test(platformKey)) {
    throw new Error(`非法 runtime platformKey=${platformKey}`);
  }
  return Object.fromEntries(
    definitions.map((definition) => {
      const pinPath = path.join(projectRoot, ...definition.pinFile);
      if (!fs.existsSync(pinPath)) {
        throw new Error(`${definition.field} pin 缺失：${pinPath}`);
      }
      let pin;
      try {
        pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
      } catch (error) {
        throw new Error(`${definition.field} pin 不是合法 JSON：${pinPath}`, { cause: error });
      }
      const version = typeof pin?.version === 'string' ? pin.version.trim() : '';
      if (!VERSION_RE.test(version)) {
        throw new Error(`${definition.field} pin 版本非法: ${version || '<empty>'}`);
      }
      // pin 的每个平台条目都带 target/entrypoint，安装侧
      // （tools/codex-package/update.mjs 的 validateCodexPackageDirectory）也校验它们。
      // 发布侧**复用同一个规范表**（不重造平台映射）逐项比对，并**要求字段存在**：
      // 缺字段即 fail closed，绝不让校验静默退化成“不校验”。
      // 只比 entrypoint 是不够的——`bin/codex` / `bin/codex.exe` 各覆盖两个平台，
      // 跨架构整段粘贴（例如把 win32-arm64 条目放进 win32-x64 槽位）能骗过它，
      // 结果是把 arm64 字节发到 x64 路径；必须连 target 一起比。
      const pinAsset = pin?.runtimeAssets?.[platformKey];
      if (typeof pinAsset?.target !== 'string' || typeof pinAsset?.entrypoint !== 'string') {
        throw new Error(
          `${definition.field} pin 缺少 ${platformKey} 的 target/entrypoint 元数据`,
        );
      }
      const canonical = canonicalPlatformFor(definition, platformKey);
      for (const field of ['target', 'entrypoint']) {
        if (pinAsset[field] !== canonical[field]) {
          throw new Error(
            `${definition.field} pin 的 ${platformKey} ${field} 与规范值不符: ` +
              `${pinAsset[field]} !== ${canonical[field]}`,
          );
        }
      }
      const descriptor = pinnedAssetDescriptor(pin, platformKey, {
        assetName: definition.archiveName,
        label: definition.pinLabel,
      });
      const sha256 = normalizeExpectedSha256(descriptor.digest);
      return [
        definition.field,
        Object.freeze({
          ...definition,
          version,
          platformKey,
          sha256,
          size: descriptor.size,
          url: descriptor.browser_download_url,
          file: `${definition.objectRoot}/${version}/${platformKey}/${definition.archiveName}`,
        }),
      ];
    }),
  );
}

function dirDistManifestAsset(local) {
  return {
    version: local.version,
    file: local.file,
    sha256: local.sha256,
    size: local.size,
  };
}

/**
 * 上传/复用目录分发 runtime 对象（版本化、不可覆盖、上传后回读校验），返回可写入
 * manifest 的资产段。幂等复用判据与单文件链路一致：manifest 已记录同版本同 sha256
 * 且对象仍在 → 直接复用，不再下载。
 *
 * `download` 只作为单测注入缝（生产走 `downloadToFileWithTimeout`）。
 */
export async function publishDirDistAssets(
  storage,
  localAssets,
  baseManifest,
  outputDir,
  { definitions = DIR_DIST_RUNTIME_DEFINITIONS, download = downloadToFileWithTimeout, log = console.log } = {},
) {
  const manifestAssets = {};
  const results = {};

  for (const definition of definitions) {
    const local = localAssets[definition.field];
    if (!local) throw new Error(`缺少 ${definition.field} 待发布资产`);

    const existing = baseManifest?.[definition.field];
    if (
      validRuntimeManifestAsset(existing, local.platformKey) &&
      existing.version === local.version &&
      normalizeExpectedSha256(existing.sha256) === local.sha256 &&
      (await storage.head(existing.file))
    ) {
      manifestAssets[definition.field] = existing;
      results[definition.field] = 'reused';
      continue;
    }

    const remote = await storage.head(local.file);
    if (remote) {
      const remoteSha256 = normalizeExpectedSha256(remote.metadata?.sha256);
      if (remoteSha256 === local.sha256 && remote.size === local.size) {
        manifestAssets[definition.field] = dirDistManifestAsset(local);
        results[definition.field] = 'reused';
        continue;
      }
      throw new Error(`运行时版本化对象已存在但内容不同，拒绝覆盖: ${local.file}`);
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const archivePath = path.join(
      outputDir,
      `${definition.field}-${local.version}-${local.platformKey}.tar.gz`,
    );
    try {
      const progress = createDownloadProgressLogger(`${definition.field} ${local.platformKey}`);
      try {
        await download(local.url, archivePath, {}, { onProgress: progress.onProgress, minThroughputBytesPerSec: 0 });
      } finally {
        progress.finish();
      }
      const size = fs.statSync(archivePath).size;
      if (size !== local.size) {
        // 大小先于 sha256 判定：给"上游包变了"与"下载被截断"两类问题更直白的归因。
        throw new Error(
          `${definition.field} ${local.platformKey} 下载字节数不符: 期望 ${local.size}, 实际 ${size} (pin ${local.version})`,
        );
      }
      verifyFileSha256OrRemove(archivePath, local.sha256, `${definition.field} ${local.platformKey}@${local.version}`);
      await storage.putFile(local.file, archivePath, {
        metadata: { sha256: local.sha256, 'pinned-version': local.version },
      });
      const verified = await storage.head(local.file);
      if (
        !verified ||
        verified.size !== local.size ||
        normalizeExpectedSha256(verified.metadata?.sha256) !== local.sha256
      ) {
        throw new Error(`RustFS ${definition.field} 上传后校验失败: ${local.file}`);
      }
      manifestAssets[definition.field] = dirDistManifestAsset(local);
      results[definition.field] = 'uploaded';
      log(`  ${definition.field}: ${local.version} ${local.platformKey} (${local.size} bytes) -> ${local.file}`);
    } finally {
      try { fs.rmSync(archivePath, { force: true }); } catch { /* ignore */ }
    }
  }

  return { manifestAssets: Object.freeze(manifestAssets), results: Object.freeze(results) };
}
