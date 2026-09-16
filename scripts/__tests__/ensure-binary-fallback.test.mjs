// ensureBinary 兜底编排的集成测试：单文件分发回退 CDN，目录分发 fail closed。
//
// 关键技巧：用假 platformKey 'test-fallback-platform'。各 update.mjs 的 ensurePlatform 会先
// `PLATFORMS.find(...)` 找不到而立即抛 "Unknown platform key"——**不打真实网络、不碰任何真实
// 平台的二进制目录**，确定性地模拟"上游失败"，再观察 ensureBinary 的兜底分支。mock CDN 提供
// 单文件分发的 manifest + .gz；Codex 完整包不得退化成单文件。node 内置 test runner，无 vitest 依赖。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ensureBinary, planEnsurePlatformFailure, ENSURE_FAILURE_ACTIONS } from '../ensure-agent-binaries.mjs';
import { RuntimeInstallError } from '../../tools/shared/runtime-install-error.mjs';

const PLATFORM = 'test-fallback-platform'; // 假平台：上游立即抛 unknown，不打网络、不碰真实二进制
const CLAUDE_PIN = JSON.parse(fs.readFileSync('tools/claude/latest.json', 'utf8')).version;
const RIPGREP_PIN = JSON.parse(fs.readFileSync('tools/ripgrep/latest.json', 'utf8')).version;

const BIN = Buffer.alloc(4096, 5);
const GZ = zlib.gzipSync(BIN);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const dirsToClean = [
  path.join('apps', 'claude-code-bin', PLATFORM),
  path.join('apps', 'codex-package-bin', PLATFORM),
  path.join('apps', 'ripgrep-bin', PLATFORM),
];

let server;
let savedCdnBase;

before(async () => {
  server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === `/manifest-${PLATFORM}-canary.json`) {
      res.end(JSON.stringify({
        claudeCode: { version: CLAUDE_PIN, file: 'x', sha256: sha(GZ), size: GZ.length, binarySha256: sha(BIN) },
        ripgrep: { version: RIPGREP_PIN, file: 'x', sha256: sha(GZ), size: GZ.length, binarySha256: sha(BIN) },
      }));
    } else if (
      u === `/claude-code/${CLAUDE_PIN}/${PLATFORM}/claude.gz` ||
      u === `/ripgrep/${RIPGREP_PIN}/${PLATFORM}/rg.gz`
    ) {
      res.end(GZ);
    } else {
      res.writeHead(404);
      res.end('nf');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  savedCdnBase = process.env.XDT_CDN_BASE_URL;
  process.env.XDT_CDN_BASE_URL = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (savedCdnBase === undefined) delete process.env.XDT_CDN_BASE_URL;
  else process.env.XDT_CDN_BASE_URL = savedCdnBase;
  for (const d of dirsToClean) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  await new Promise((r) => server.close(r));
});

test('ensureBinary(claude): 上游失败 → 回退 CDN，落地正确二进制 + .version==pin', async () => {
  const binPath = await ensureBinary('claude', PLATFORM, { force: true });
  assert.ok(fs.readFileSync(binPath).equals(BIN), 'binary content == mock CDN binary');
  const ver = fs.readFileSync(path.join(path.dirname(binPath), '.version'), 'utf8').trim();
  assert.equal(ver, CLAUDE_PIN);
});

test('ensureBinary(codex): 完整目录包拒绝单二进制 CDN 回退', async () => {
  await assert.rejects(
    ensureBinary('codex', PLATFORM, { force: true }),
    /directory distribution.*pnpm update:codex-package/s,
  );
  assert.equal(fs.existsSync(path.join('apps', 'codex-package-bin', PLATFORM)), false);
});

test('ensureBinary(ripgrep): 上游失败 → 回退 CDN，落地正确二进制 + .version==pin', async () => {
  const binPath = await ensureBinary('ripgrep', PLATFORM, { force: true });
  assert.ok(fs.readFileSync(binPath).equals(BIN), 'binary content == mock CDN binary');
  const ver = fs.readFileSync(path.join(path.dirname(binPath), '.version'), 'utf8').trim();
  assert.equal(ver, RIPGREP_PIN);
});

// ── 失败阶段归因（2026-09-16 Windows canary 回归）────────────────────────────
// 当时下载命中了缓存、真正失败的是本地目录 promote，却被包装成
// "Failed to download ... from upstream"，把排查引向网络和"应用是否在运行"。
// 下面把"只有 download 阶段才考虑网络侧兜底"这条编排契约固定下来。

function promoteFailure(message = '落位失败：EPERM: operation not permitted') {
  return new RuntimeInstallError('promote', message, {
    cause: Object.assign(new Error('EPERM: operation not permitted, rename a -> b'), { code: 'EPERM' }),
  });
}

test('planEnsurePlatformFailure: promote 阶段失败按本地落位失败上报，绝不再走 CDN/网络兜底', () => {
  for (const kind of ['codex', 'claude', 'ripgrep', 'pi']) {
    const plan = planEnsurePlatformFailure({
      kind,
      platformKey: 'win32-x64',
      version: '0.153.4',
      error: promoteFailure(),
    });
    assert.equal(plan.action, ENSURE_FAILURE_ACTIONS.LOCAL_INSTALL_FAILED, kind);
    assert.match(plan.error.message, /local install failed, not a download problem/);
    assert.match(plan.error.message, /EPERM/);
    assert.doesNotMatch(plan.error.message, /Failed to download/);
    assert.match(plan.error.message, new RegExp(`pnpm update:${kind}`));
  }
});

test('planEnsurePlatformFailure: 阶段未知的目录分发仍 fail closed（不得退化成单文件 CDN）', () => {
  const plan = planEnsurePlatformFailure({
    kind: 'codex',
    platformKey: 'win32-x64',
    version: '0.153.4',
    error: new Error('Unknown platform key for codex-package: test-fallback-platform'),
  });
  assert.equal(plan.action, ENSURE_FAILURE_ACTIONS.FAIL_CLOSED_DIR_DIST);
  assert.match(plan.error.message, /directory distribution.*pnpm update:codex-package/s);
});

test('planEnsurePlatformFailure: 单文件分发的 download 阶段失败才回退 CDN', () => {
  const plan = planEnsurePlatformFailure({
    kind: 'claude',
    platformKey: 'win32-x64',
    version: '2.1.259',
    error: new RuntimeInstallError('download', 'download failed: connect timeout', {
      cause: new Error('connect timeout'),
    }),
  });
  assert.equal(plan.action, ENSURE_FAILURE_ACTIONS.CDN_FALLBACK);
  assert.match(plan.detail, /connect timeout/);
  // 未标注阶段的普通错误保持既有行为（claude/ripgrep 仍可回退）
  const untagged = planEnsurePlatformFailure({
    kind: 'claude',
    platformKey: 'win32-x64',
    version: '2.1.259',
    error: new Error('fetch failed'),
  });
  assert.equal(untagged.action, ENSURE_FAILURE_ACTIONS.CDN_FALLBACK);
});
