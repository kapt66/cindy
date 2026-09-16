// 单文件 codex runtime（tools/codex/update.mjs）的 pin 降级与发布链路线性。
//
// 背景：2026-09-16 Windows canary 打包全部成功后在发布校验阶段 ENOENT——
// publish-desktop.mjs → collectLocalRuntimeAssets 需要 apps/codex-bin/<platform>（单文件
// codex runtime），而 2026-09-03 的 codex-package 迁移把 KINDS.codex 换成了
// codex-package-bin，没人再安装 codex-bin。补齐安装路径时同一条链也会撞上
// api.github.com 的 60 次/小时配额，所以单文件 codex 的 ensurePlatform 同样要支持 pin 降级。
// node 内置 test runner：`node --test scripts/__tests__/codex-single-pin-fallback.test.mjs`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveCodexInstallMeta } from '../../tools/codex/update.mjs';
import { collectLocalRuntimeAssets } from '../../apps/desktop/scripts/ci/runtime-release.mjs';

const PIN = JSON.parse(fs.readFileSync(new URL('../../tools/codex/latest.json', import.meta.url), 'utf8'));
const PLATFORM_KEY = 'win32-x64';
const ENTRY = { asset: 'codex-x86_64-pc-windows-msvc.exe.tar.gz' };

function rateLimitError() {
  return Object.assign(new Error('HTTP 403 rate limit exceeded: https://api.github.com/…'), {
    status: 403,
    statusText: 'rate limit exceeded',
  });
}

test('resolveCodexInstallMeta: 上游限流 → 用 pin 直链与 sha256（发布链路不再被配额挡住）', async () => {
  const warnings = [];
  const result = await resolveCodexInstallMeta({
    version: PIN.version,
    platformKey: PLATFORM_KEY,
    entry: ENTRY,
    fetchMeta: async () => { throw rateLimitError(); },
    warn: (message) => warnings.push(message),
  });
  assert.equal(result.pinOnly, true);
  const asset = result.meta.assets[0];
  assert.equal(asset.name, ENTRY.asset);
  assert.equal(asset.browser_download_url, PIN.runtimeAssets[PLATFORM_KEY].url);
  assert.equal(asset.digest, `sha256:${PIN.runtimeAssets[PLATFORM_KEY].sha256}`);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /installing from the reviewed pin/);
});

test('resolveCodexInstallMeta: 上游正常时走 API 并做 pin 交叉校验；漂移/404 仍然 fail closed', async () => {
  const ok = await resolveCodexInstallMeta({
    version: PIN.version,
    platformKey: PLATFORM_KEY,
    entry: ENTRY,
    fetchMeta: async () => ({
      assets: [{
        name: ENTRY.asset,
        browser_download_url: PIN.runtimeAssets[PLATFORM_KEY].url,
        digest: `sha256:${PIN.runtimeAssets[PLATFORM_KEY].sha256}`,
      }],
    }),
  });
  assert.equal(ok.pinOnly, false);

  await assert.rejects(
    resolveCodexInstallMeta({
      version: PIN.version,
      platformKey: PLATFORM_KEY,
      entry: ENTRY,
      fetchMeta: async () => ({
        assets: [{
          name: ENTRY.asset,
          browser_download_url: PIN.runtimeAssets[PLATFORM_KEY].url,
          digest: `sha256:${'b'.repeat(64)}`,
        }],
      }),
    }),
    /digest does not match pin/,
  );

  await assert.rejects(
    resolveCodexInstallMeta({
      version: PIN.version,
      platformKey: PLATFORM_KEY,
      entry: ENTRY,
      fetchMeta: async () => {
        throw Object.assign(new Error('HTTP 404 Not Found'), { status: 404, statusText: 'Not Found' });
      },
    }),
    /HTTP 404/,
  );
});

test('collectLocalRuntimeAssets: 单文件 runtime 缺失时报出可执行的补齐命令，而不是裸 ENOENT', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-runtime-collect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => collectLocalRuntimeAssets(PLATFORM_KEY, { projectRoot: root }),
    (error) => {
      assert.doesNotMatch(error.message, /^ENOENT/);
      assert.match(error.message, /本地 runtime 未就位/);
      assert.match(error.message, /apps[\\/]codex-bin|apps[\\/]claude-code-bin/);
      assert.match(error.message, /ensure-agent-binaries\.mjs --kinds=claude,codex-single,ripgrep/);
      return true;
    },
  );
});
