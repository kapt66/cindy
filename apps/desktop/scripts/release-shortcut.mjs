#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureBinary } from '../../../scripts/ensure-agent-binaries.mjs';
import {
  packageArgsForShortcut,
  parseReleaseShortcutArgs,
  publishArgsForShortcut,
  targetArchs,
} from './ci/release-shortcut-lib.mjs';

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_ROOT = path.join(DESKTOP_ROOT, 'release', 'artifacts');

function runNodeScript(scriptName, args) {
  const scriptPath = path.join(DESKTOP_ROOT, 'scripts', scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: DESKTOP_ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${scriptName} 失败，退出码 ${result.status}`);
  }
}

function collectBuildInfoFiles(dir, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) collectBuildInfoFiles(fullPath, output);
    else if (entry.isFile() && entry.name === 'build-info.json') output.push(fullPath);
  }
  return output;
}

function findFreshBuildInfos(options, startedAt) {
  const expectedArchs = targetArchs(options.platform, options.arch);
  const candidates = collectBuildInfoFiles(path.join(ARTIFACT_ROOT, 'cn'))
    .map((filePath) => {
      try {
        return {
          filePath,
          mtimeMs: fs.statSync(filePath).mtimeMs,
          value: JSON.parse(fs.readFileSync(filePath, 'utf8')),
        };
      } catch {
        return null;
      }
    })
    .filter(
      (entry) =>
        entry &&
        entry.mtimeMs >= startedAt &&
        entry.value.region === 'cn' &&
        entry.value.platform === options.platform &&
        expectedArchs.includes(entry.value.arch) &&
        entry.value.versionless === false,
    );

  const selected = expectedArchs.map((arch) => {
    const matches = candidates
      .filter((entry) => entry.value.arch === arch)
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    if (!matches[0]) {
      throw new Error(`打包完成但没有找到本轮 ${options.platform}-${arch} 的 build-info.json`);
    }
    return matches[0];
  });

  const versions = new Set(selected.map((entry) => entry.value.version));
  if (versions.size !== 1) {
    throw new Error(`本轮多架构产物版本不一致: ${[...versions].join(', ')}`);
  }
  return selected.map((entry) => entry.filePath);
}

async function main() {
  const options = parseReleaseShortcutArgs(process.argv.slice(2));
  if (process.platform !== options.platform) {
    throw new Error(
      `不支持交叉发布：当前 ${process.platform}，目标 ${options.platform}`,
    );
  }

  for (const arch of targetArchs(options.platform, options.arch)) {
    const platformKey = `${options.platform}-${arch}`;
    await ensureBinary('claude', platformKey);
    await ensureBinary('codex', platformKey);
  }

  const startedAt = Date.now();
  console.log(`==> Cindy Meka CN 快捷发布：${options.platform} ${options.versionSpec}`);
  runNodeScript('package-desktop.mjs', packageArgsForShortcut(options));

  const buildInfos = findFreshBuildInfos(options, startedAt);
  console.log('==> 本轮产物全部完成；先逐架构执行本地发布校验...');
  for (const buildInfo of buildInfos) {
    runNodeScript(
      'publish-desktop.mjs',
      publishArgsForShortcut(buildInfo, options),
    );
  }

  console.log('==> 本地校验全部通过；开始逐架构发布 canary...');
  for (const buildInfo of buildInfos) {
    runNodeScript(
      'publish-desktop.mjs',
      publishArgsForShortcut(buildInfo, options, { execute: true }),
    );
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
