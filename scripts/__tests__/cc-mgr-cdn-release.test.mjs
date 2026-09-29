// cc-mgr bundle 的**按版本交付**（L2）生产端：对象路径、pin 解析、不可覆盖上传、
// 产物自证探针，以及 `ccMgr` 段对老 manifest 的兼容性。
//
// 为什么这块要有测试：cc-mgr 的版本闸门是**精确字符串相等**，而这次事故（2026-09-28
// `[INVALID_BUNDLE_VERSION] client bundle 0.0.10 does not match server bundle 0.0.9`）
// 的根因就是两端各自手写版本、没有自动化比对。发布端一旦发出「源码常量新、字节旧」的
// 对象，分叉就从 CDN 开始了 —— 所以这里既锁形状，也锁「产物必须自报 pin」这条纪律。
//
// node 内置 test runner：`node --test scripts/__tests__/cc-mgr-cdn-release.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildAgentRuntimeManifest,
  ccMgrBundleObjectPath,
  probeCcMgrBundleVersion,
  publishCcMgrBundle,
  readCcMgrPinFromProtocolSource,
  readLocalCcMgrPin,
} from '../../apps/desktop/scripts/ci/runtime-release.mjs';
import { sha256Hex } from '../../tools/shared/verify-sha256.mjs';

const PLATFORM_KEY = 'linux-x64';
const BUNDLE_BYTES = Buffer.from('// fixture cc-mgr bundle\nexport const x = 1;\n');

/**
 * 临时目录 + 可靠清理。**必须 await run**：早先只写 `return run(root)` 时，async 回调返回
 * 的是 promise，`finally` 会在它 resolve 之前就删掉目录，于是用例以 ENOENT 假红。
 */
async function withTempDir(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-cc-mgr-release-'));
  try {
    return await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeBundle(root, bytes = BUNDLE_BYTES) {
  const bundlePath = path.join(root, 'cc-mgr.mjs');
  fs.writeFileSync(bundlePath, bytes);
  return bundlePath;
}

function makeStorage(initial = []) {
  const objects = new Map(initial);
  return {
    objects,
    async head(key) {
      return objects.get(key) ?? null;
    },
    async putFile(key, filePath, options = {}) {
      objects.set(key, {
        size: fs.statSync(filePath).size,
        metadata: options.metadata ?? {},
      });
    },
  };
}

function agentAssets() {
  return {
    claudeCode: {
      version: '2.1.219',
      file: 'claude-code/2.1.219/linux-x64/claude.gz',
      sha256: 'a'.repeat(64),
      size: 10,
      binarySha256: 'b'.repeat(64),
    },
    codex: {
      version: '0.145.0',
      file: 'codex/0.145.0/linux-x64/codex.gz',
      sha256: 'c'.repeat(64),
      size: 10,
      binarySha256: 'd'.repeat(64),
    },
  };
}

test('cc-mgr 的对象路径是平台无关的，且拒绝非法版本号', () => {
  assert.equal(ccMgrBundleObjectPath('0.0.10'), 'cc-mgr/0.0.10/cc-mgr.mjs');
  // 平台无关：路径里**不得**出现 platformKey（与 claude/codex 的 gz 资产相反）。
  assert.ok(!ccMgrBundleObjectPath('0.0.10').includes(PLATFORM_KEY));
  assert.throws(() => ccMgrBundleObjectPath('nightly'), /非法 cc-mgr managerVersion/);
  assert.throws(() => ccMgrBundleObjectPath('../etc/passwd'), /非法 cc-mgr managerVersion/);
});

test('pin 从 maker-cc-manager 的 protocol 源码解析，失败即报错不回退默认值', () => {
  const source = "export const PROTOCOL_VERSION = 5 as const;\n"
    + "export const CC_MGR_BUNDLE_VERSION = '0.0.10' as const;\n";
  assert.deepEqual(readCcMgrPinFromProtocolSource(source), {
    managerVersion: '0.0.10',
    protocolVersion: 5,
  });
  assert.throws(() => readCcMgrPinFromProtocolSource('export const PROTOCOL_VERSION = 5;'), /CC_MGR_BUNDLE_VERSION/);
  assert.throws(() => readCcMgrPinFromProtocolSource("export const CC_MGR_BUNDLE_VERSION = '0.0.10';"), /PROTOCOL_VERSION/);
  assert.throws(
    () => readCcMgrPinFromProtocolSource("export const PROTOCOL_VERSION = 5;\nexport const CC_MGR_BUNDLE_VERSION = 'v1';"),
    /不是可发布的版本号/,
  );
});

test('真实仓库源码解析出的 pin 形状正确（口径活性）', () => {
  const pin = readLocalCcMgrPin();
  assert.match(pin.managerVersion, /^\d+\.\d+\.\d+/);
  assert.ok(Number.isInteger(pin.protocolVersion));
  assert.ok(pin.protocolVersion >= 2);
});

test('产物探针：自报版本与 pin 一致才放行，不一致必须失败', async () => {
  await withTempDir((root) => {
    const matching = path.join(root, 'matching.mjs');
    fs.writeFileSync(
      matching,
      "console.log(JSON.stringify({ managerVersion: '0.0.10', protocolVersion: 5 }));\n",
    );
    assert.deepEqual(
      probeCcMgrBundleVersion(matching, { managerVersion: '0.0.10', protocolVersion: 5 }),
      { managerVersion: '0.0.10', protocolVersion: 5 },
    );

    // 「源码常量新、产物旧」正是本轮事故的入口：必须在这里失败。
    const stale = path.join(root, 'stale.mjs');
    fs.writeFileSync(
      stale,
      "console.log(JSON.stringify({ managerVersion: '0.0.9', protocolVersion: 4 }));\n",
    );
    assert.throws(
      () => probeCcMgrBundleVersion(stale, { managerVersion: '0.0.10', protocolVersion: 5 }),
      /自报 0\.0\.9\/protocol 4，与 pin 0\.0\.10\/protocol 5 不一致/,
    );

    const notJson = path.join(root, 'noisy.mjs');
    fs.writeFileSync(notJson, "console.log('not json');\n");
    assert.throws(
      () => probeCcMgrBundleVersion(notJson, { managerVersion: '0.0.10', protocolVersion: 5 }),
      /不是 JSON/,
    );

    const crashing = path.join(root, 'crash.mjs');
    fs.writeFileSync(crashing, 'process.exit(3);\n');
    assert.throws(
      () => probeCcMgrBundleVersion(crashing, { managerVersion: '0.0.10', protocolVersion: 5 }),
      /探针失败/,
    );
  });
});

test('发布 cc-mgr：首次上传写对象 + 元数据，重复发布同样字节时复用', async () => {
  await withTempDir(async (root) => {
    const bundlePath = writeBundle(root);
    const storage = makeStorage();
    const pin = { managerVersion: '0.0.10', protocolVersion: 5 };

    const first = await publishCcMgrBundle(storage, { bundlePath, pin });
    assert.equal(first.uploaded, true);
    assert.deepEqual(first.manifestAsset, {
      managerVersion: '0.0.10',
      protocolVersion: 5,
      file: 'cc-mgr/0.0.10/cc-mgr.mjs',
      sha256: sha256Hex(BUNDLE_BYTES),
      size: BUNDLE_BYTES.length,
    });
    const stored = storage.objects.get('cc-mgr/0.0.10/cc-mgr.mjs');
    assert.equal(stored.metadata.sha256, sha256Hex(BUNDLE_BYTES));
    assert.equal(stored.metadata['manager-version'], '0.0.10');
    assert.equal(stored.metadata['protocol-version'], '5');

    const second = await publishCcMgrBundle(storage, { bundlePath, pin });
    assert.equal(second.uploaded, false);
    assert.deepEqual(second.manifestAsset, first.manifestAsset);
  });
});

test('发布 cc-mgr：同版本对象内容不同必须失败（版本化对象不可覆盖）', async () => {
  await withTempDir(async (root) => {
    const storage = makeStorage([
      ['cc-mgr/0.0.10/cc-mgr.mjs', { size: BUNDLE_BYTES.length, metadata: { sha256: 'e'.repeat(64) } }],
    ]);
    await assert.rejects(
      () => publishCcMgrBundle(storage, {
        bundlePath: writeBundle(root),
        pin: { managerVersion: '0.0.10', protocolVersion: 5 },
      }),
      /已存在但内容不同，拒绝覆盖/,
    );
  });
});

test('发布 cc-mgr：产物不存在时给出可执行的报错', async () => {
  await withTempDir(async (root) => {
    await assert.rejects(
      () => publishCcMgrBundle(makeStorage(), {
        bundlePath: path.join(root, 'missing.mjs'),
        pin: { managerVersion: '0.0.10', protocolVersion: 5 },
      }),
      /先跑 pnpm --filter @cindy\/maker-cc-manager bundle/,
    );
  });
});

test('manifest：不带 ccMgr 时保持旧形状（老消费端与老区域不受影响）', () => {
  const legacy = buildAgentRuntimeManifest(PLATFORM_KEY, agentAssets());
  assert.equal('ccMgr' in legacy, false);
  assert.deepEqual(Object.keys(legacy), ['schemaVersion', 'platformKey', 'claudeCode', 'codex']);
});

test('manifest：带 ccMgr 时写入该段，且 schemaVersion 仍为 1（消费端硬断言 1）', () => {
  const ccMgr = {
    managerVersion: '0.0.10',
    protocolVersion: 5,
    file: 'cc-mgr/0.0.10/cc-mgr.mjs',
    sha256: sha256Hex(BUNDLE_BYTES),
    size: BUNDLE_BYTES.length,
  };
  const manifest = buildAgentRuntimeManifest(PLATFORM_KEY, agentAssets(), ccMgr);
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.ccMgr, ccMgr);
  // 深拷贝：调用方后续改动 manifest 不得回头改到发布脚本手里的资产对象。
  manifest.ccMgr.size = 1;
  assert.equal(ccMgr.size, BUNDLE_BYTES.length);
});
