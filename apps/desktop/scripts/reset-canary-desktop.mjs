#!/usr/bin/env node

import { loadDotenv } from './ci/lib.mjs';
import {
  canaryBackupKey,
  manifestKey,
  putImmutableText,
  readStoredManifest,
  sha256Text,
  verifyCdnManifest,
} from './ci/release-lib.mjs';
import { resolveMekaS3Config } from './ci/release-regions.mjs';
import { createMekaReleaseStorage } from './ci/release-storage.mjs';
import { assertRuntimeManifestAssets } from './ci/runtime-release.mjs';

function parseArgs(argv) {
  const result = { region: '', platform: '', arch: '', yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--region' && argv[i + 1]) result.region = argv[++i];
    else if (arg === '--platform' && argv[i + 1]) result.platform = argv[++i];
    else if (arg === '--arch' && argv[i + 1]) result.arch = argv[++i];
    else if (arg === '--yes') result.yes = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!result.region || !result.platform || !result.arch) {
    throw new Error(
      '必须提供 --region <cn|global|dev> --platform <win32|darwin> --arch <x64|arm64>',
    );
  }
  return result;
}

function referencedAssetKeys(manifest, platformKey) {
  assertRuntimeManifestAssets(manifest, platformKey);
  return [
    manifest.app.installer.file,
    manifest.app.hotfix.file,
    manifest.claudeCode.file,
    manifest.codex.file,
  ];
}

async function assertStoredAssets(storage, manifest, platformKey) {
  const keys = referencedAssetKeys(manifest, platformKey);
  const heads = await Promise.all(keys.map((key) => storage.head(key)));
  const missing = keys.filter((_, index) => !heads[index]);
  if (missing.length > 0) {
    throw new Error(`stable manifest 引用的远端对象不存在，拒绝重置 canary: ${missing.join(', ')}`);
  }
}

async function main() {
  loadDotenv(undefined, { refreshReleaseConfig: false });
  const args = parseArgs(process.argv.slice(2));
  const platformKey = `${args.platform}-${args.arch}`;
  const storage = createMekaReleaseStorage(resolveMekaS3Config(args.region));
  const [canary, stable] = await Promise.all([
    readStoredManifest(storage, platformKey, 'canary'),
    readStoredManifest(storage, platformKey, 'stable'),
  ]);
  if (!stable) throw new Error(`远端不存在 ${manifestKey(platformKey, 'stable')}`);
  await assertStoredAssets(storage, stable.json, platformKey);

  console.log(`Canary: ${canary?.json.app.version ?? '<missing>'}`);
  console.log(`Stable: ${stable.json.app.version}`);
  if (canary && sha256Text(canary.text) === sha256Text(stable.text)) {
    console.log('Canary 已与 stable 完全一致，无需操作。');
    return;
  }
  if (!args.yes) {
    console.log('预览完成；未写入 RustFS。确认后追加 --yes。');
    return;
  }

  if (canary) {
    const backupKey = canaryBackupKey(platformKey, canary.json.app.version, canary.text);
    await putImmutableText(storage, backupKey, canary.text);
    console.log(`Canary 已备份: ${storage.cdnUrl(backupKey)}`);
  }

  const canaryKey = manifestKey(platformKey, 'canary');
  await storage.putText(canaryKey, stable.text, {
    metadata: {
      version: stable.json.app.version,
      resetToStable: 'true',
    },
  });
  await verifyCdnManifest(storage, platformKey, 'canary', stable.text);
  console.log(`Canary 已对齐 stable ${stable.json.app.version}: ${storage.cdnUrl(canaryKey)}`);
  console.log('版本化产物未删除；已安装更高 canary 的客户端不会自动降级。');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
