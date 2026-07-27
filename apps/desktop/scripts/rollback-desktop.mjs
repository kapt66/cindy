#!/usr/bin/env node

import { loadDotenv } from './ci/lib.mjs';
import {
  compareReleaseVersions,
  manifestKey,
  putImmutableText,
  readStoredManifest,
  stableBackupKey,
  validateManifestForPlatform,
  verifyCdnManifest,
} from './ci/release-lib.mjs';
import { createMekaReleaseStorage } from './ci/release-storage.mjs';
import { resolveMekaS3Config } from './ci/release-regions.mjs';

function parseArgs(argv) {
  const result = { region: '', platform: '', arch: '', toVersion: '', yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--region' && argv[i + 1]) result.region = argv[++i];
    else if (arg === '--platform' && argv[i + 1]) result.platform = argv[++i];
    else if (arg === '--arch' && argv[i + 1]) result.arch = argv[++i];
    else if (arg === '--to-version' && argv[i + 1]) result.toVersion = argv[++i];
    else if (arg === '--yes') result.yes = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!result.region || !result.platform || !result.arch || !result.toVersion) {
    throw new Error('必须提供 --region <...> --platform <...> --arch <...> --to-version <x.y.z>');
  }
  return result;
}

async function main() {
  loadDotenv(undefined, { refreshReleaseConfig: false });
  const args = parseArgs(process.argv.slice(2));
  const platformKey = `${args.platform}-${args.arch}`;
  const storage = createMekaReleaseStorage(resolveMekaS3Config(args.region));
  const stable = await readStoredManifest(storage, platformKey, 'stable');
  if (!stable) throw new Error(`远端不存在 ${manifestKey(platformKey, 'stable')}`);

  const targetKey = stableBackupKey(platformKey, args.toVersion);
  const targetHead = await storage.head(targetKey);
  if (!targetHead) throw new Error(`远端不存在回滚备份: ${targetKey}`);
  const targetText = await storage.getText(targetKey);
  const target = validateManifestForPlatform(JSON.parse(targetText), platformKey);
  if (target.app.version !== args.toVersion) {
    throw new Error(`备份路径版本与 manifest 不一致: ${args.toVersion} != ${target.app.version}`);
  }
  if (compareReleaseVersions(target.app.version, stable.json.app.version) >= 0) {
    throw new Error(
      `回滚目标 ${target.app.version} 必须低于当前 stable ${stable.json.app.version}`,
    );
  }

  console.log(`Stable:   ${stable.json.app.version}`);
  console.log(`Rollback: ${target.app.version}`);
  if (!args.yes) {
    console.log('预览完成；未写入 RustFS。确认后追加 --yes。');
    return;
  }

  await putImmutableText(
    storage,
    stableBackupKey(platformKey, stable.json.app.version),
    stable.text,
  );
  const stableKey = manifestKey(platformKey, 'stable');
  await storage.putText(stableKey, targetText, {
    metadata: { version: target.app.version, rollback: 'true' },
  });
  await verifyCdnManifest(storage, platformKey, 'stable', targetText);
  console.log(`Stable 已回滚到 ${target.app.version}: ${storage.cdnUrl(stableKey)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
