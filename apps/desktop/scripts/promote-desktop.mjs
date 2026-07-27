#!/usr/bin/env node

import { loadDotenv } from './ci/lib.mjs';
import {
  assertPromotionOrder,
  manifestKey,
  putImmutableText,
  readStoredManifest,
  sha256Text,
  stableBackupKey,
  verifyCdnManifest,
} from './ci/release-lib.mjs';
import { createMekaReleaseStorage } from './ci/release-storage.mjs';
import { resolveMekaS3Config } from './ci/release-regions.mjs';

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

async function main() {
  loadDotenv(undefined, { refreshReleaseConfig: false });
  const args = parseArgs(process.argv.slice(2));
  const platformKey = `${args.platform}-${args.arch}`;
  const storage = createMekaReleaseStorage(resolveMekaS3Config(args.region));
  const [canary, stable] = await Promise.all([
    readStoredManifest(storage, platformKey, 'canary'),
    readStoredManifest(storage, platformKey, 'stable'),
  ]);
  if (!canary) throw new Error(`远端不存在 ${manifestKey(platformKey, 'canary')}`);
  assertPromotionOrder(canary.json, stable?.json);

  console.log(`Canary: ${canary.json.app.version}`);
  console.log(`Stable: ${stable?.json.app.version ?? '<first release>'}`);
  if (stable && sha256Text(stable.text) === sha256Text(canary.text)) {
    console.log('Stable 已与 canary 完全一致，无需操作。');
    return;
  }
  if (!args.yes) {
    console.log('预览完成；未写入 RustFS。确认 canary 验收通过后追加 --yes。');
    return;
  }

  if (stable) {
    await putImmutableText(
      storage,
      stableBackupKey(platformKey, stable.json.app.version),
      stable.text,
    );
  }
  const stableKey = manifestKey(platformKey, 'stable');
  await storage.putText(stableKey, canary.text, {
    metadata: { version: canary.json.app.version },
  });
  await verifyCdnManifest(storage, platformKey, 'stable', canary.text);
  console.log(`Stable 已推进到 ${canary.json.app.version}: ${storage.cdnUrl(stableKey)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
