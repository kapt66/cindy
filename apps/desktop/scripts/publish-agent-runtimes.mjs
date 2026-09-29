#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { loadDotenv } from './ci/lib.mjs';
import { verifyCdnText } from './ci/release-lib.mjs';
import { resolveMekaS3Config } from './ci/release-regions.mjs';
import { createMekaReleaseStorage } from './ci/release-storage.mjs';
import {
  AGENT_RUNTIME_DEFINITIONS,
  buildAgentRuntimeManifest,
  ccMgrBundleSourcePath,
  collectLocalRuntimeAssets,
  probeCcMgrBundleVersion,
  publishCcMgrBundle,
  publishRuntimeAssets,
  readLocalCcMgrPin,
  runtimeManifestKey,
} from './ci/runtime-release.mjs';
import { ensurePublishedRuntimes } from '../../../scripts/ensure-agent-binaries.mjs';

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

/**
 * 发布 cc-mgr bundle：先**重建**产物、用产物自己的 `--version` 探针核对 pin，再上传。
 *
 * 为什么在发布脚本里重建而不是复用 `resources/cc-manager/cc-mgr.mjs`：那一份是桌面端打包
 * 阶段的产物，可能在本次发布之前就已经存在（甚至来自旧源码）。bundle 的版本闸门是精确
 * 相等，一旦发出「源码常量新、字节旧」的对象，两端分叉就从 CDN 开始了。这里现建现探，
 * 代价是几秒钟，换来的是「发出去的字节确实自报这个版本」。
 */
function buildAndProbeCcMgrBundle(pin) {
  const build = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['--filter', '@cindy/maker-cc-manager', 'bundle'],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (build.status !== 0) {
    throw new Error(`cc-mgr bundle 构建失败，pnpm 退出码: ${build.status ?? 'unknown'}`);
  }
  const bundlePath = ccMgrBundleSourcePath();
  probeCcMgrBundleVersion(bundlePath, pin);
  return bundlePath;
}

async function main() {
  loadDotenv(undefined, { refreshReleaseConfig: false });
  const args = parseAgentRuntimePublishArgs(process.argv.slice(2));
  // 发布物是**单文件** runtime（claude + codex 单文件），与桌面端打包用的 codex-package 不是
  // 同一份产物；这里先按 AGENT_RUNTIME_DEFINITIONS 的集合确保就位。
  await ensurePublishedRuntimes(args.platform, ['claude', 'codex-single']);
  const localAssets = collectLocalRuntimeAssets(args.platform, {
    definitions: AGENT_RUNTIME_DEFINITIONS,
  });
  // cc-mgr 是平台无关的 JS，各平台 manifest 里是同一段；这里把版本与产物都定下来。
  const ccMgrPin = readLocalCcMgrPin();
  const ccMgrBundlePath = buildAndProbeCcMgrBundle(ccMgrPin);

  console.log(
    `Cindy agent runtimes (${args.region}/${args.platform}): ` +
      `Claude ${localAssets.claudeCode.version}, Codex ${localAssets.codex.version}, ` +
      `cc-mgr ${ccMgrPin.managerVersion}/protocol ${ccMgrPin.protocolVersion}`,
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
  const ccMgr = await publishCcMgrBundle(storage, {
    bundlePath: ccMgrBundlePath,
    pin: ccMgrPin,
  });
  const manifest = buildAgentRuntimeManifest(
    args.platform,
    published.manifestAssets,
    ccMgr.manifestAsset,
  );
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestKey = runtimeManifestKey(args.platform);

  const manifestResult = await putAgentRuntimeManifestIfChanged(storage, manifestKey, manifestText);
  await verifyCdnText(storage, manifestKey, manifestText);
  console.log(
    `Published ${manifestKey} (${manifestResult}): `
      + `Claude ${published.results.claudeCode}, Codex ${published.results.codex}, `
      + `cc-mgr ${ccMgr.uploaded ? 'uploaded' : 'reused'} ${ccMgr.manifestAsset.file}`,
  );
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
