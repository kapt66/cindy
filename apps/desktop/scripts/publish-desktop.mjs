#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDotenv } from './ci/lib.mjs';
import {
  assertPublishVersionOrder,
  buildCanaryManifest,
  buildPublishedEndpointManifest,
  manifestKey,
  putImmutableArtifact,
  readStoredManifest,
  validateBuildInfo,
  verifyCdnText,
  verifyCdnManifest,
} from './ci/release-lib.mjs';
import { createMekaReleaseStorage } from './ci/release-storage.mjs';
import { resolveMekaS3Config } from './ci/release-regions.mjs';
import {
  assertRuntimeManifestAssets,
  collectLocalRuntimeAssets,
  publishRuntimeAssets,
} from './ci/runtime-release.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENDPOINT_MANIFEST_FILE_BY_REGION = Object.freeze({
  cn: 'endpoint.json',
  global: 'endpoint.global.json',
  dev: 'endpoint.dev.json',
});

function endpointManifestPath(region) {
  const fileName = ENDPOINT_MANIFEST_FILE_BY_REGION[region];
  if (!fileName) throw new Error(`不支持的 endpoint manifest region: ${region}`);
  return path.join(PROJECT_ROOT, 'config', fileName);
}

function parseArgs(argv) {
  const result = {
    buildInfo: '',
    execute: false,
    releaseNotesFile: '',
    requireRelogin: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--build-info' && argv[i + 1]) result.buildInfo = argv[++i];
    else if (arg === '--release-notes-file' && argv[i + 1]) result.releaseNotesFile = argv[++i];
    else if (arg === '--require-relogin') result.requireRelogin = true;
    else if (arg === '--execute') result.execute = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!result.buildInfo) throw new Error('必须提供 --build-info <path>');
  return result;
}

async function main() {
  loadDotenv(undefined, { refreshReleaseConfig: false });
  const args = parseArgs(process.argv.slice(2));
  const release = validateBuildInfo(args.buildInfo);
  const localRuntimeAssets = collectLocalRuntimeAssets(release.platformKey);
  const endpointManifestText = buildPublishedEndpointManifest(
    fs.readFileSync(endpointManifestPath(release.region), 'utf8'),
  );
  const releaseNotes = args.releaseNotesFile
    ? fs.readFileSync(path.resolve(args.releaseNotesFile), 'utf8').trim()
    : undefined;

  const installerKey = `app/${release.platformKey}/${release.installer.name}`;
  const hotfixKey = `hotfix/${release.platformKey}/${release.hotfix.name}`;
  const canaryKey = manifestKey(release.platformKey, 'canary');
  console.log(`Cindy Meka ${release.version} (${release.region}/${release.platformKey})`);
  console.log(`  installer -> ${installerKey}`);
  console.log(`  hotfix    -> ${hotfixKey}`);
  console.log('  endpoints -> endpoint.json');
  console.log(`  manifest  -> ${canaryKey}`);
  console.log(
    `  runtimes  -> Claude ${localRuntimeAssets.claudeCode.version}, ` +
      `Codex ${localRuntimeAssets.codex.version}, ` +
      `ripgrep ${localRuntimeAssets.ripgrep.version}`,
  );

  if (!args.execute) {
    console.log('\n本地校验通过；未写入 RustFS。确认后追加 --execute。');
    return;
  }

  const storage = createMekaReleaseStorage(resolveMekaS3Config(release.region));
  const [canary, stable] = await Promise.all([
    readStoredManifest(storage, release.platformKey, 'canary'),
    readStoredManifest(storage, release.platformKey, 'stable'),
  ]);
  assertPublishVersionOrder(release.version, canary?.json, stable?.json);

  const baseManifest = canary?.json ?? stable?.json;
  const runtime = await publishRuntimeAssets(
    storage,
    localRuntimeAssets,
    baseManifest,
    path.join(path.dirname(release.buildInfoPath), 'runtime'),
  );
  const manifest = buildCanaryManifest(baseManifest, release, {
    releaseNotes,
    requireRelogin: args.requireRelogin,
    runtimeAssets: runtime.manifestAssets,
  });
  assertRuntimeManifestAssets(manifest, release.platformKey);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const localManifestPath = path.join(path.dirname(release.buildInfoPath), canaryKey);
  fs.writeFileSync(localManifestPath, manifestText);

  // Publication order is intentional: immutable bytes first, mutable pointer last.
  const installerResult = await putImmutableArtifact(storage, installerKey, release.installer);
  const hotfixResult = await putImmutableArtifact(storage, hotfixKey, release.hotfix);
  await storage.putText('endpoint.json', endpointManifestText);
  await verifyCdnText(storage, 'endpoint.json', endpointManifestText);
  await storage.putText(canaryKey, manifestText, {
    metadata: { version: release.version },
  });
  await verifyCdnManifest(storage, release.platformKey, 'canary', manifestText);

  console.log('\nCanary 发布完成：');
  console.log(`  installer: ${installerResult.reused ? 'reused' : 'uploaded'}`);
  console.log(`  hotfix:    ${hotfixResult.reused ? 'reused' : 'uploaded'}`);
  console.log(`  claude:    ${runtime.results.claudeCode}`);
  console.log(`  codex:     ${runtime.results.codex}`);
  console.log(`  ripgrep:   ${runtime.results.ripgrep}`);
  console.log(`  installer: ${storage.cdnUrl(installerKey)}`);
  console.log(`  hotfix:    ${storage.cdnUrl(hotfixKey)}`);
  console.log(`  endpoints: ${storage.cdnUrl('endpoint.json')}`);
  console.log(`  manifest:  ${storage.cdnUrl(canaryKey)}`);
  console.log('下一步先做 canary 升级验收，再运行 release:promote。');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
