// github-release-pin 的单测：GitHub API 限流不得阻断"已 pin 且校验 sha256"的安装，
// 但其它 API 错误（404 等）与非法 pin 必须继续 fail closed。
//
// 背景：2026-09-16 Windows canary 第二次失败——未认证 api.github.com 每出口 IP 只有
// 60 次/小时，runner 与开发机共用出口 IP，配额耗尽后 codex-package / pi 取元数据直接 403。
// node 内置 test runner：`node --test scripts/__tests__/github-release-pin.test.mjs`。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isGitHubRateLimitError,
  pinnedAssetDescriptor,
  resolveInstallReleaseMeta,
} from '../../tools/shared/github-release-pin.mjs';

const SHA = 'a'.repeat(64);
const URL_OK = 'https://github.com/openai/codex/releases/download/rust-v0.153.4/codex-package-x86_64-pc-windows-msvc.tar.gz';

function pin(overrides = {}) {
  return {
    version: '0.153.4',
    runtimeAssets: {
      'win32-x64': {
        url: URL_OK,
        sha256: SHA,
        size: 136_123_456,
        target: 'x86_64-pc-windows-msvc',
        entrypoint: 'bin/codex.exe',
        ...overrides,
      },
    },
  };
}

function httpError(status, statusText, url = 'https://api.github.com/x') {
  return Object.assign(new Error(`HTTP ${status} ${statusText}: ${url}`), { status, statusText, url });
}

test('isGitHubRateLimitError: 只认限流（403 + rate limit / 429），不吞其它 403 与 404', () => {
  assert.equal(isGitHubRateLimitError(httpError(403, 'rate limit exceeded')), true);
  assert.equal(isGitHubRateLimitError(httpError(429, 'Too Many Requests')), true);
  assert.equal(isGitHubRateLimitError(httpError(403, 'Forbidden')), false);
  assert.equal(isGitHubRateLimitError(httpError(404, 'Not Found')), false);
  assert.equal(isGitHubRateLimitError(new Error('HTTP 403 rate limit exceeded: x')), false, '没有 status 就不能判定为限流');
  assert.equal(isGitHubRateLimitError(new Error('socket hang up')), false);
});

test('pinnedAssetDescriptor: 用 pin 的直链 + sha256 构造与 API 同形的资产描述符', () => {
  const asset = pinnedAssetDescriptor(pin(), 'win32-x64', {
    assetName: 'codex-package-x86_64-pc-windows-msvc.tar.gz',
    label: 'codex-package 0.153.4',
    expectedTarget: 'x86_64-pc-windows-msvc',
    expectedEntrypoint: 'bin/codex.exe',
  });
  assert.equal(asset.name, 'codex-package-x86_64-pc-windows-msvc.tar.gz');
  assert.equal(asset.browser_download_url, URL_OK);
  assert.equal(asset.digest, `sha256:${SHA}`);
  assert.equal(asset.size, 136_123_456);
});

test('pinnedAssetDescriptor: pin 缺字段/非法来源一律 fail closed', () => {
  const opts = { assetName: 'a.tar.gz' };
  assert.throws(() => pinnedAssetDescriptor(pin({ sha256: undefined }), 'win32-x64', opts), /missing a valid sha256/);
  assert.throws(() => pinnedAssetDescriptor(pin({ size: 0 }), 'win32-x64', opts), /missing a valid size/);
  assert.throws(() => pinnedAssetDescriptor(pin({ url: 'http://github.com/x' }), 'win32-x64', opts), /not an approved github.com/);
  assert.throws(() => pinnedAssetDescriptor(pin({ url: 'https://evil.example/x.tar.gz' }), 'win32-x64', opts), /not an approved github.com/);
  assert.throws(() => pinnedAssetDescriptor(pin({ url: 'not a url' }), 'win32-x64', opts), /not a valid URL/);
  assert.throws(() => pinnedAssetDescriptor(pin(), 'linux-x64', opts), /missing/);
  assert.throws(() => pinnedAssetDescriptor(null, 'win32-x64', opts), /missing/);
  assert.throws(
    () => pinnedAssetDescriptor(pin(), 'win32-x64', { assetName: 'a', expectedTarget: 'other' }),
    /target metadata does not match/,
  );
  assert.throws(
    () => pinnedAssetDescriptor(pin(), 'win32-x64', { assetName: 'a', expectedEntrypoint: 'bin/other.exe' }),
    /entrypoint metadata does not match/,
  );
});

test('resolveInstallReleaseMeta: 上游可用时照旧用 API 元数据并做 pin 交叉校验', async () => {
  const live = { assets: [{ name: 'a.tar.gz', browser_download_url: URL_OK, digest: `sha256:${SHA}` }] };
  let assertedWith = null;
  const result = await resolveInstallReleaseMeta({
    fetchLiveMeta: async () => live,
    assertPinned: (meta) => { assertedWith = meta; },
    pinnedMeta: () => { throw new Error('pin-only path must not be used'); },
  });
  assert.equal(result.pinOnly, false);
  assert.equal(result.meta, live);
  assert.equal(assertedWith, live);
});

test('resolveInstallReleaseMeta: 上游限流 → 降级为 pin 直链并告警（sha256 仍由下载阶段强制）', async () => {
  const warnings = [];
  const result = await resolveInstallReleaseMeta({
    fetchLiveMeta: async () => { throw httpError(403, 'rate limit exceeded'); },
    assertPinned: () => { throw new Error('assertPinned must not run without live metadata'); },
    pinnedMeta: () => ({ assets: [pinnedAssetDescriptor(pin(), 'win32-x64', { assetName: 'a.tar.gz' })] }),
    warn: (message) => warnings.push(message),
  });
  assert.equal(result.pinOnly, true);
  assert.equal(result.meta.assets.length, 1);
  assert.equal(result.meta.assets[0].browser_download_url, URL_OK);
  assert.equal(result.meta.assets[0].digest, `sha256:${SHA}`);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /GitHub API rate limit hit.*reviewed pin/);
});

test('resolveInstallReleaseMeta: 非限流错误与"pin 不一致"都必须 fail closed', async () => {
  // 404：pin 指向的 release 没了 → 不得降级
  await assert.rejects(
    resolveInstallReleaseMeta({
      fetchLiveMeta: async () => { throw httpError(404, 'Not Found'); },
      assertPinned: () => {},
      pinnedMeta: () => ({ assets: [] }),
    }),
    /HTTP 404/,
  );
  // 上游元数据与 pin 不一致（digest 漂移）→ 不得降级
  await assert.rejects(
    resolveInstallReleaseMeta({
      fetchLiveMeta: async () => ({ assets: [] }),
      assertPinned: () => { throw new Error('asset digest does not match pin'); },
      pinnedMeta: () => ({ assets: [] }),
    }),
    /digest does not match pin/,
  );
});

test('resolveInstallReleaseMeta: 限流但 pin 不完整时仍然 fail closed（不静默放行）', async () => {
  await assert.rejects(
    resolveInstallReleaseMeta({
      fetchLiveMeta: async () => { throw httpError(403, 'rate limit exceeded'); },
      assertPinned: () => {},
      pinnedMeta: () => { throw new Error('Pinned a.tar.gz asset metadata is missing for win32-x64'); },
    }),
    /asset metadata is missing/,
  );
});
