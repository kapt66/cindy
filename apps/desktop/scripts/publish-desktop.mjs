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
  DIR_DIST_RUNTIME_DEFINITIONS,
  RELEASE_RUNTIME_DEFINITIONS,
  assertRuntimeManifestAssets,
  collectLocalRuntimeAssets,
  collectPinnedDirDistAssets,
  publishDirDistAssets,
  publishRuntimeAssets,
} from './ci/runtime-release.mjs';
import { ensurePublishedRuntimes } from '../../../scripts/ensure-agent-binaries.mjs';

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
  // 发布物里的 runtime 是**单文件**形态（claude / codex 单文件 / ripgrep），与桌面端打包用的
  // codex-package 目录分发不是同一份产物。这里先确保它们就位，否则 collectLocalRuntimeAssets
  // 会在读 apps/<dir>/<platform>/.version 时 ENOENT（2026-09-16 canary 的失败点）。
  await ensurePublishedRuntimes(release.platformKey);
  const localRuntimeAssets = collectLocalRuntimeAssets(release.platformKey);
  // 桌面端启动真正消费的 codex 是**目录分发**（manifest.codexPackage）；它直接复用
  // pin 记录的上游官方整包，不依赖发版机本地 apps/codex-package-bin 的落位状态。
  const dirDistAssets = collectPinnedDirDistAssets(release.platformKey);
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
  console.log(
    `  codex 目录分发 -> codexPackage ${dirDistAssets.codexPackage.version} ` +
      `(${dirDistAssets.codexPackage.file})`,
  );
  console.log(
    `  pi 目录分发    -> pi ${dirDistAssets.pi.version} (${dirDistAssets.pi.file})`,
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
  const runtimeOutputDir = path.join(path.dirname(release.buildInfoPath), 'runtime');
  const runtime = await publishRuntimeAssets(
    storage,
    localRuntimeAssets,
    baseManifest,
    runtimeOutputDir,
  );
  const dirDist = await publishDirDistAssets(
    storage,
    dirDistAssets,
    baseManifest,
    runtimeOutputDir,
  );
  const manifest = buildCanaryManifest(baseManifest, release, {
    releaseNotes,
    requireRelogin: args.requireRelogin,
    runtimeAssets: { ...runtime.manifestAssets, ...dirDist.manifestAssets },
  });
  assertRuntimeManifestAssets(manifest, release.platformKey, {
    definitions: RELEASE_RUNTIME_DEFINITIONS,
  });
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
  console.log(`  codexPackage: ${dirDist.results.codexPackage}`);
  console.log(`  pi:           ${dirDist.results.pi}`);
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
