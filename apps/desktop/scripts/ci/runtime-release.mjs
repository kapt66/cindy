import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gzipFile } from '../../../../scripts/shared/oss.mjs';
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

const RUNTIME_DEFINITIONS = Object.freeze([
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

function runtimeBinaryName(platformKey, baseName) {
  return platformKey.startsWith('win32-') ? `${baseName}.exe` : baseName;
}

export function collectLocalRuntimeAssets(platformKey, { projectRoot = PROJECT_ROOT } = {}) {
  return Object.fromEntries(
    RUNTIME_DEFINITIONS.map((definition) => {
      const sourceRoot = path.join(projectRoot, 'apps', definition.sourceDir, platformKey);
      const version = fs.readFileSync(path.join(sourceRoot, '.version'), 'utf8').trim();
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
  { required = true, allowMissing = [] } = {},
) {
  for (const definition of RUNTIME_DEFINITIONS) {
    const asset = manifest?.[definition.field];
    if (!asset && (!required || allowMissing.includes(definition.field))) continue;
    if (!validRuntimeManifestAsset(asset, platformKey)) {
      throw new Error(`manifest 缺少或包含非法的 ${definition.field} ${platformKey} 运行时资产`);
    }
  }
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

export async function publishRuntimeAssets(storage, localAssets, baseManifest, outputDir) {
  const manifestAssets = {};
  const results = {};

  for (const definition of RUNTIME_DEFINITIONS) {
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
  );
  return { manifestAssets: Object.freeze(manifestAssets), results: Object.freeze(results) };
}
