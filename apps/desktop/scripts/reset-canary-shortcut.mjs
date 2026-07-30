#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseResetCanaryShortcutArgs,
  resetCanaryArgsForShortcut,
  targetArchs,
} from './ci/release-shortcut-lib.mjs';

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runReset(args) {
  const scriptPath = path.join(DESKTOP_ROOT, 'scripts', 'reset-canary-desktop.mjs');
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: DESKTOP_ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`reset-canary-desktop.mjs 失败，退出码 ${result.status}`);
  }
}

function main() {
  const options = parseResetCanaryShortcutArgs(process.argv.slice(2));
  const archs = targetArchs(options.platform, options.arch);

  console.log('==> 先预览全部目标，不写入 RustFS...');
  for (const arch of archs) {
    runReset(resetCanaryArgsForShortcut(options.platform, arch));
  }
  if (!options.yes) return;

  console.log('==> 全部预览通过；开始将 canary 对齐 stable...');
  for (const arch of archs) {
    runReset(
      resetCanaryArgsForShortcut(options.platform, arch, {
        yes: true,
      }),
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
