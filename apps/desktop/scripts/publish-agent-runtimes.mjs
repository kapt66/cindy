#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadDotenv } from './ci/lib.mjs';
import { verifyCdnText } from './ci/release-lib.mjs';
import { resolveMekaS3Config } from './ci/release-regions.mjs';
import { createMekaReleaseStorage } from './ci/release-storage.mjs';
import {
  AGENT_RUNTIME_DEFINITIONS,
  buildAgentRuntimeManifest,
  collectLocalRuntimeAssets,
  publishRuntimeAssets,
  runtimeManifestKey,
} from './ci/runtime-release.mjs';

const RELEASE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'release',
  'runtime-assets',
);

export function parseAgentRuntimePublishArgs(argv) {
  const result = { execute: false, platform: '', region: 'cn' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--execute') result.execute = true;
    else if (arg === '--platform' && argv[index + 1]) result.platform = argv[++index];
    else if (arg.startsWith('--platform=')) result.platform = arg.slice('--platform='.length);
    else if (arg === '--region' && argv[index + 1]) result.region = argv[++index];
    else if (arg.startsWith('--region=')) result.region = arg.slice('--region='.length);
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!result.platform) throw new Error('必须提供 --platform <platformKey>');
  if (!['cn', 'global', 'dev'].includes(result.region)) {
    throw new Error(`不支持的发布区域: ${result.region}`);
  }
  runtimeManifestKey(result.platform);
  return result;
}

export async function putAgentRuntimeManifestIfChanged(storage, manifestKey, manifestText) {
  const existing = await storage.head(manifestKey);
  if (existing) {
    const remoteText = await storage.getText(manifestKey);
    if (remoteText === manifestText) return 'reused';
  }
  await storage.putText(manifestKey, manifestText);
  return existing ? 'updated' : 'created';
}

async function main() {
  loadDotenv(undefined, { refreshReleaseConfig: false });
  const args = parseAgentRuntimePublishArgs(process.argv.slice(2));
  const localAssets = collectLocalRuntimeAssets(args.platform, {
    definitions: AGENT_RUNTIME_DEFINITIONS,
  });

  console.log(
    `Cindy agent runtimes (${args.region}/${args.platform}): ` +
      `Claude ${localAssets.claudeCode.version}, Codex ${localAssets.codex.version}`,
  );
  if (!args.execute) {
    console.log('本地校验通过；未写入 RustFS。确认后追加 --execute。');
    return;
  }

  const storage = createMekaReleaseStorage(resolveMekaS3Config(args.region));
  const published = await publishRuntimeAssets(
    storage,
    localAssets,
    null,
    path.join(RELEASE_DIR, args.platform),
    { definitions: AGENT_RUNTIME_DEFINITIONS },
  );
  const manifest = buildAgentRuntimeManifest(args.platform, published.manifestAssets);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestKey = runtimeManifestKey(args.platform);

  const manifestResult = await putAgentRuntimeManifestIfChanged(storage, manifestKey, manifestText);
  await verifyCdnText(storage, manifestKey, manifestText);
  console.log(
    `Published ${manifestKey} (${manifestResult}): `
      + `Claude ${published.results.claudeCode}, Codex ${published.results.codex}`,
  );
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
