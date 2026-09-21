// 应用 manifest 的 codex 目录分发资产（manifest.codexPackage）发布链。
//
// 背景（2026-09-16 Windows canary 0.0.21「环境初始化失败」）：2026-09-03 的
// `b43ee771ad`（use Codex package in production）把桌面端 agent-binaries 的 codex
// 消费契约改成 `manifestField: 'codexPackage'` + `tar-gz-dir`，但本仓发布链路
// （runtime-release.mjs / release-lib.mjs）仍然只发单文件 `codex`。于是一路走到
// 「canary 热更成功、进程起来、环境检查失败」：prepare('codex') → asset_missing →
// allPassed=false → splash「环境初始化失败」，而且 asset 查找先于本地回退，本机
// 既有的旧单文件 codex 也救不回来。
//
// node 内置 test runner：`node --test scripts/__tests__/codex-package-cdn-release.test.mjs`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildCanaryManifest } from '../../apps/desktop/scripts/ci/release-lib.mjs';
import {
  CODEX_PACKAGE_DIR_DIST_DEFINITION,
  DIR_DIST_RUNTIME_DEFINITIONS,
  RELEASE_RUNTIME_DEFINITIONS,
  assertRuntimeManifestAssets,
  collectPinnedDirDistAssets,
  publishDirDistAssets,
} from '../../apps/desktop/scripts/ci/runtime-release.mjs';
import { sha256Hex } from '../../tools/shared/verify-sha256.mjs';

const PLATFORM_KEY = 'win32-x64';
const ARCHIVE_BYTES = Buffer.alloc(4096, 'codex-package');
const ARCHIVE_SHA256 = sha256Hex(ARCHIVE_BYTES);
const PIN_VERSION = '0.153.4';

function makePin(overrides = {}) {
  return {
    version: PIN_VERSION,
    runtimeAssets: {
      [PLATFORM_KEY]: {
        url: 'https://github.com/openai/codex/releases/download/rust-v0.153.4/codex-package-x86_64-pc-windows-msvc.tar.gz',
        sha256: ARCHIVE_SHA256,
        size: ARCHIVE_BYTES.length,
        target: 'x86_64-pc-windows-msvc',
        entrypoint: 'bin/codex.exe',
        ...overrides,
      },
    },
  };
}

function withPinRoot(pin, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-package-pin-'));
  try {
    const pinDir = path.join(root, 'tools', 'codex-package');
    fs.mkdirSync(pinDir, { recursive: true });
    fs.writeFileSync(path.join(pinDir, 'latest.json'), `${JSON.stringify(pin, null, 2)}\n`);
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 下载注入缝：把固定的归档字节写到目标路径。 */
function fakeDownload(url, destPath, _init, _overrides) {
  assert.match(url, /^https:\/\/github\.com\//);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, ARCHIVE_BYTES);
}

function makeStorage(initial = []) {
  const objects = new Map(initial);
  return {
    objects,
    async head(key) {
      return objects.get(key) ?? null;
    },
    async putFile(key, filePath, options = {}) {
      objects.set(key, { size: fs.statSync(filePath).size, metadata: options.metadata ?? {} });
    },
  };
}

test('collectPinnedDirDistAssets: 目录分发资产锚定 pin（sha256/size/url/对象路径）', () => {
  withPinRoot(makePin(), (root) => {
    const assets = collectPinnedDirDistAssets(PLATFORM_KEY, {
      projectRoot: root,
      definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
    });
    const codexPackage = assets.codexPackage;
    assert.equal(codexPackage.version, PIN_VERSION);
    assert.equal(codexPackage.sha256, ARCHIVE_SHA256);
    assert.equal(codexPackage.size, ARCHIVE_BYTES.length);
    assert.equal(
      codexPackage.file,
      `codex-package/${PIN_VERSION}/${PLATFORM_KEY}/codex-package.tar.gz`,
    );
    // 客户端 assertRuntimeManifestAssets 的路径约束：必须带平台段。
    assert.ok(codexPackage.file.includes(`/${PLATFORM_KEY}/`));
  });
});

test('collectPinnedDirDistAssets: pin 的 target/entrypoint 必须存在且与规范表一致', () => {
  // 存在且一致 → 通过（真实 pin 就带这两个字段）
  withPinRoot(makePin(), (root) => {
    assert.doesNotThrow(() =>
      collectPinnedDirDistAssets(PLATFORM_KEY, {
        projectRoot: root,
        definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
      }),
    );
  });
  // 缺 entrypoint → fail closed（不允许静默退化成“不校验”）
  withPinRoot(makePin({ entrypoint: undefined }), (root) => {
    assert.throws(
      () =>
        collectPinnedDirDistAssets(PLATFORM_KEY, {
          projectRoot: root,
          definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
        }),
      /缺少 .* target\/entrypoint 元数据/,
    );
  });
  // 缺 target → 同样 fail closed
  withPinRoot(makePin({ target: undefined }), (root) => {
    assert.throws(
      () =>
        collectPinnedDirDistAssets(PLATFORM_KEY, {
          projectRoot: root,
          definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
        }),
      /缺少 .* target\/entrypoint 元数据/,
    );
  });
  // 跨 OS 粘贴：win32 槽位拿到 darwin 的 entrypoint → 拦住
  withPinRoot(makePin({ entrypoint: 'bin/codex' }), (root) => {
    assert.throws(
      () =>
        collectPinnedDirDistAssets(PLATFORM_KEY, {
          projectRoot: root,
          definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
        }),
      /entrypoint 与规范值不符/,
    );
  });
  // 跨架构粘贴：entrypoint 相同（都是 bin/codex.exe），只有 target 不同。
  // 这正是只比 entrypoint 会漏掉的那类误编辑——arm64 字节会被发到 x64 路径。
  withPinRoot(makePin({ target: 'aarch64-pc-windows-msvc' }), (root) => {
    assert.throws(
      () =>
        collectPinnedDirDistAssets(PLATFORM_KEY, {
          projectRoot: root,
          definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
        }),
      /target 与规范值不符/,
    );
  });
});

test('collectPinnedDirDistAssets: pin 缺失/非 github 直链/非法 sha256 一律 fail closed', () => {
  withPinRoot(makePin(), (root) => {
    assert.throws(
      () =>
        collectPinnedDirDistAssets(PLATFORM_KEY, {
          projectRoot: path.join(root, 'missing'),
          definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
        }),
      /pin 缺失/,
    );
  });
  withPinRoot(makePin({ url: 'https://example.com/codex-package.tar.gz' }), (root) => {
    assert.throws(
      () =>
        collectPinnedDirDistAssets(PLATFORM_KEY, {
          projectRoot: root,
          definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
        }),
      /approved github\.com release asset/,
    );
  });
  withPinRoot(makePin({ sha256: 'not-a-sha256' }), (root) => {
    assert.throws(
      () =>
        collectPinnedDirDistAssets(PLATFORM_KEY, {
          projectRoot: root,
          definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
        }),
      /valid sha256/,
    );
  });
});

test('publishDirDistAssets: 首次发布上传并回读校验，重复发布幂等复用', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-package-out-'));
  try {
    const assets = withPinRoot(makePin(), (pinRoot) =>
      collectPinnedDirDistAssets(PLATFORM_KEY, {
        projectRoot: pinRoot,
        definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
      }),
    );
    const storage = makeStorage();
    const first = await publishDirDistAssets(storage, assets, null, path.join(root, 'out'), {
      definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
      download: fakeDownload,
      log: () => {},
    });
    assert.equal(first.results.codexPackage, 'uploaded');
    assert.equal(first.manifestAssets.codexPackage.sha256, ARCHIVE_SHA256);
    assert.equal(storage.objects.size, 1);
    // 归档中间文件不残留
    assert.deepEqual(fs.readdirSync(path.join(root, 'out')), []);

    const manifest = { app: { version: '0.0.22' }, ...first.manifestAssets };
    const second = await publishDirDistAssets(storage, assets, manifest, path.join(root, 'out'), {
      definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
      download: () => {
        throw new Error('复用路径不应再下载');
      },
      log: () => {},
    });
    assert.equal(second.results.codexPackage, 'reused');
    assert.equal(storage.objects.size, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishDirDistAssets: 字节数不符 / sha256 不符 / 同版本对象内容不同都必须失败', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-package-bad-'));
  try {
    const assets = withPinRoot(makePin(), (pinRoot) =>
      collectPinnedDirDistAssets(PLATFORM_KEY, {
        projectRoot: pinRoot,
        definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
      }),
    );

    await assert.rejects(
      publishDirDistAssets(makeStorage(), assets, null, path.join(root, 'short'), {
        definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
        download: (_url, destPath) => fs.writeFileSync(destPath, Buffer.alloc(16)),
        log: () => {},
      }),
      /下载字节数不符/,
    );

    await assert.rejects(
      publishDirDistAssets(makeStorage(), assets, null, path.join(root, 'tampered'), {
        definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
        download: (_url, destPath) => fs.writeFileSync(destPath, Buffer.alloc(ARCHIVE_BYTES.length, 'evil')),
        log: () => {},
      }),
      /SHA256 mismatch/,
    );

    const key = assets.codexPackage.file;
    await assert.rejects(
      publishDirDistAssets(
        makeStorage([[key, { size: 12, metadata: { sha256: 'a'.repeat(64) } }]]),
        assets,
        null,
        path.join(root, 'conflict'),
        {
          definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
          download: fakeDownload,
          log: () => {},
        },
      ),
      /拒绝覆盖/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildCanaryManifest + assertRuntimeManifestAssets: codex 与 codexPackage 必须同时在册', () => {
  const asset = (file) => ({ version: '1.2.3', file, sha256: 'a'.repeat(64), size: 1 });
  const release = {
    version: '0.0.22',
    platformKey: PLATFORM_KEY,
    installer: { name: 'cindy-meka-0.0.22-Setup.exe', sha256: 'b'.repeat(64), size: 2 },
    hotfix: { name: 'cindy-meka-0.0.22.zip', sha256: 'c'.repeat(64), size: 3 },
  };
  const manifest = buildCanaryManifest(null, release, {
    runtimeAssets: {
      claudeCode: asset(`claude-code/1.2.3/${PLATFORM_KEY}/claude.exe.gz`),
      codex: asset(`codex/1.2.3/${PLATFORM_KEY}/codex.exe.gz`),
      ripgrep: asset(`ripgrep/1.2.3/${PLATFORM_KEY}/rg.exe.gz`),
      codexPackage: asset(`codex-package/${PIN_VERSION}/${PLATFORM_KEY}/codex-package.tar.gz`),
      pi: asset(`pi/${PIN_VERSION}/${PLATFORM_KEY}/pi.dist.tar.gz`),
    },
  });
  assert.equal(manifest.app.version, '0.0.22');
  // 单文件 codex 保留给 MCPRouter linux runtime manifest 与 ≤0.0.20 客户端
  assert.equal(manifest.codex.file, `codex/1.2.3/${PLATFORM_KEY}/codex.exe.gz`);
  assert.equal(
    manifest.codexPackage.file,
    `codex-package/${PIN_VERSION}/${PLATFORM_KEY}/codex-package.tar.gz`,
  );
  assert.equal(manifest.pi.file, `pi/${PIN_VERSION}/${PLATFORM_KEY}/pi.dist.tar.gz`);
  assertRuntimeManifestAssets(manifest, PLATFORM_KEY, { definitions: RELEASE_RUNTIME_DEFINITIONS });

  // 缺 pi 段的形态：客户端 prepare('pi') = asset_missing → pi agent 不注册 → 只在 pi 路由
  // 上默认开启的模型（XD 网关 deepseek-v4.1-flash 等）在 packaged 包里消失。必须报错。
  const withoutPi = { ...manifest };
  delete withoutPi.pi;
  assert.throws(
    () =>
      assertRuntimeManifestAssets(withoutPi, PLATFORM_KEY, {
        definitions: RELEASE_RUNTIME_DEFINITIONS,
      }),
    /pi/,
  );

  // 缺 codexPackage 就是 0.0.21 事故的形态：这里必须报错，而不是静默发一个坏 manifest。
  delete manifest.codexPackage;
  assert.throws(
    () =>
      assertRuntimeManifestAssets(manifest, PLATFORM_KEY, {
        definitions: RELEASE_RUNTIME_DEFINITIONS,
      }),
    /codexPackage/,
  );
  // 单文件链路（MCPRouter linux runtime manifest）不受目录分发定义影响。
  assert.deepEqual(
    DIR_DIST_RUNTIME_DEFINITIONS.map((definition) => definition.field),
    ['codexPackage', 'pi'],
  );
});

test('buildCanaryManifest: baseManifest 的陈旧 codexPackage 不得顶包', () => {
  const asset = (file, sha) => ({ version: '1.2.3', file, sha256: sha, size: 1 });
  const release = {
    version: '0.0.22',
    platformKey: PLATFORM_KEY,
    installer: { name: 'cindy-meka-0.0.22-Setup.exe', sha256: 'b'.repeat(64), size: 2 },
    hotfix: { name: 'cindy-meka-0.0.22.zip', sha256: 'c'.repeat(64), size: 3 },
  };
  const stalePackage = {
    version: '0.153.0',
    file: `codex-package/0.153.0/${PLATFORM_KEY}/codex-package.tar.gz`,
    sha256: '9'.repeat(64),
    size: 9,
  };
  const stalePi = {
    version: '0.84.4',
    file: `pi/0.84.4/${PLATFORM_KEY}/pi.dist.tar.gz`,
    sha256: '7'.repeat(64),
    size: 7,
  };
  // 判定“本轮值”是否真的覆盖了陈旧值；下面用 stalePackage 做反向对照，确保该判定有区分力。
  const isFresh = (manifest) => manifest.codexPackage?.version === '0.153.4';

  // 上一版 canary 里带着旧 codexPackage：本轮漏传该段时必须被 delete，而不是原样留下。
  const staleBase = { app: { version: '0.0.21' }, codexPackage: stalePackage, pi: stalePi };
  const withoutSection = buildCanaryManifest(staleBase, release, {
    runtimeAssets: {
      claudeCode: asset(`claude-code/1.2.3/${PLATFORM_KEY}/claude.exe.gz`, 'a'.repeat(64)),
      codex: asset(`codex/1.2.3/${PLATFORM_KEY}/codex.exe.gz`, 'e'.repeat(64)),
      ripgrep: asset(`ripgrep/1.2.3/${PLATFORM_KEY}/rg.exe.gz`, 'f'.repeat(64)),
    },
  });
  assert.equal('codexPackage' in withoutSection, false, '陈旧 codexPackage 必须被清掉');
  assert.equal('pi' in withoutSection, false, '陈旧 pi 必须被清掉');
  // 清掉后不再是“齐备”的 → 齐备断言必须拦住（否则陈旧值会骗过守卫）
  assert.throws(
    () =>
      assertRuntimeManifestAssets(withoutSection, PLATFORM_KEY, {
        definitions: RELEASE_RUNTIME_DEFINITIONS,
      }),
    /codexPackage/,
  );

  // 本轮有值 → 覆盖 baseManifest 的陈旧值
  const replaced = buildCanaryManifest(staleBase, release, {
    runtimeAssets: {
      claudeCode: asset(`claude-code/1.2.3/${PLATFORM_KEY}/claude.exe.gz`, 'a'.repeat(64)),
      codex: asset(`codex/1.2.3/${PLATFORM_KEY}/codex.exe.gz`, 'e'.repeat(64)),
      ripgrep: asset(`ripgrep/1.2.3/${PLATFORM_KEY}/rg.exe.gz`, 'f'.repeat(64)),
      codexPackage: {
        version: '0.153.4',
        file: `codex-package/0.153.4/${PLATFORM_KEY}/codex-package.tar.gz`,
        sha256: '8'.repeat(64),
        size: 8,
      },
      pi: {
        version: '0.85.1',
        file: `pi/0.85.1/${PLATFORM_KEY}/pi.dist.tar.gz`,
        sha256: '6'.repeat(64),
        size: 6,
      },
    },
  });
  assert.equal(isFresh(replaced), true, '本轮的值必须覆盖上一版的陈旧值');
  assert.equal(replaced.pi.version, '0.85.1', '本轮的值必须覆盖上一版的陈旧 pi');
  // 用“旧值”做对照断言，确保上面这条真的有区分力（旧值必须判为不 fresh）。
  assert.equal(isFresh({ codexPackage: stalePackage }), false);
  assertRuntimeManifestAssets(replaced, PLATFORM_KEY, {
    definitions: RELEASE_RUNTIME_DEFINITIONS,
  });
});
