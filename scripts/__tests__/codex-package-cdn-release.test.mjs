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
//
// 本文件另外覆盖 **linux runtime manifest**（`runtime-manifest-linux-x64.json`）的目录分发
// 段：`buildAgentRuntimeManifest` 的 `codexPackage` / `pi` 可选段与 `--execute` 之前的
// dry-run 预览（该组装函数与这里被测的 `DIR_DIST_RUNTIME_DEFINITIONS` 是同一套机制）。
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
  buildAgentRuntimeManifest,
  collectPinnedDirDistAssets,
  formatMekaDirDistManifestPreview,
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

/* ==========================================================================
 * linux runtime manifest 的目录分发段（codexPackage / pi）
 *
 * 背景（2026-10-08 事故）：MCPRouter 只从 `runtime-manifest-linux-x64.json` 取 runtime，
 * 而该 manifest **从来没有** `codexPackage` 段。单文件 `codex` 里没有
 * `bin/codex-code-mode-host`（它只存在于目录发行包），于是远端 Codex 的 code-mode
 * （命令执行）起不来，会话里报「命令执行环境因缺少 codex-code-mode-host 无法启动」。
 * 桌面端 0.0.21 起早就改用目录分发（上面的用例覆盖桌面那一侧），这里锁的是**发布侧**：
 * linux manifest 必须带上这两个可选段，且 `claudeCode` / 单文件 `codex` 的老契约逐字不变。
 * ========================================================================== */

const LINUX_PLATFORM_KEY = 'linux-x64';
const PI_PIN_VERSION = '1.0.2';
const PI_SHA256 = 'e'.repeat(64);
const PI_SIZE = 424242;

/** 与真实 `tools/codex-package/latest.json` 同形的 linux-x64 条目（规范表真值）。 */
function makeLinuxPin(overrides = {}) {
  return {
    version: PIN_VERSION,
    runtimeAssets: {
      [LINUX_PLATFORM_KEY]: {
        url: 'https://github.com/openai/codex/releases/download/rust-v0.153.4/codex-package-x86_64-unknown-linux-musl.tar.gz',
        sha256: ARCHIVE_SHA256,
        size: ARCHIVE_BYTES.length,
        target: 'x86_64-unknown-linux-musl',
        entrypoint: 'bin/codex',
        ...overrides,
      },
    },
  };
}

/** linux-x64 的单文件两段（`claudeCode` / `codex`）：向后兼容的对照面。 */
function linuxAgentAssets() {
  return {
    claudeCode: {
      version: '2.1.219',
      file: `claude-code/2.1.219/${LINUX_PLATFORM_KEY}/claude.gz`,
      sha256: 'a'.repeat(64),
      size: 10,
      binarySha256: 'b'.repeat(64),
    },
    codex: {
      version: '0.145.0',
      file: `codex/0.145.0/${LINUX_PLATFORM_KEY}/codex.gz`,
      sha256: 'c'.repeat(64),
      size: 10,
      binarySha256: 'd'.repeat(64),
    },
  };
}

function linuxDirDistSections() {
  return {
    codexPackage: {
      version: PIN_VERSION,
      file: `codex-package/${PIN_VERSION}/${LINUX_PLATFORM_KEY}/codex-package.tar.gz`,
      sha256: ARCHIVE_SHA256,
      size: ARCHIVE_BYTES.length,
    },
    pi: {
      version: PI_PIN_VERSION,
      file: `pi/${PI_PIN_VERSION}/${LINUX_PLATFORM_KEY}/pi.dist.tar.gz`,
      sha256: PI_SHA256,
      size: PI_SIZE,
    },
  };
}

test('linux runtime: codexPackage 原样转发 pin 字节，manifest 段摘要与 pin 同源', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-linux-codex-package-out-'));
  try {
    const assets = withPinRoot(makeLinuxPin(), (pinRoot) =>
      collectPinnedDirDistAssets(LINUX_PLATFORM_KEY, {
        projectRoot: pinRoot,
        definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
      }),
    );
    assert.equal(
      assets.codexPackage.file,
      `codex-package/${PIN_VERSION}/${LINUX_PLATFORM_KEY}/codex-package.tar.gz`,
    );
    const storage = makeStorage();
    const published = await publishDirDistAssets(
      storage,
      assets,
      null,
      path.join(outputRoot, 'out'),
      {
        definitions: [CODEX_PACKAGE_DIR_DIST_DEFINITION],
        download: fakeDownload,
        log: () => {},
      },
    );
    assert.equal(published.results.codexPackage, 'uploaded');
    // 原样转发：manifest 段的 sha256/size 必须逐字等于 pin（不是本机重新打包的产物）。
    assert.deepEqual(published.manifestAssets.codexPackage, {
      version: PIN_VERSION,
      file: `codex-package/${PIN_VERSION}/${LINUX_PLATFORM_KEY}/codex-package.tar.gz`,
      sha256: ARCHIVE_SHA256,
      size: ARCHIVE_BYTES.length,
    });
    assert.equal(storage.objects.get(assets.codexPackage.file).metadata.sha256, ARCHIVE_SHA256);
    // 归档中间文件不残留
    assert.deepEqual(fs.readdirSync(path.join(outputRoot, 'out')), []);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('linux runtime: 两个可选段写进 manifest，缺失时消费端合法而发布侧必须齐备', () => {
  const agentAssets = linuxAgentAssets();
  const dirDist = linuxDirDistSections();

  // 1) 不传目录分发资产：形状与老契约逐字一致（老客户端 / 老镜像的红线）。
  const legacy = buildAgentRuntimeManifest(LINUX_PLATFORM_KEY, agentAssets);
  assert.equal(legacy.schemaVersion, 1);
  assert.deepEqual(Object.keys(legacy), ['schemaVersion', 'platformKey', 'claudeCode', 'codex']);
  assert.deepEqual(legacy.claudeCode, agentAssets.claudeCode);
  assert.deepEqual(legacy.codex, agentAssets.codex);
  // 消费端口径：两个新段缺失合法（required:false 的定义集不该因缺失报错）。
  assert.doesNotThrow(() =>
    assertRuntimeManifestAssets(legacy, LINUX_PLATFORM_KEY, {
      required: false,
      definitions: DIR_DIST_RUNTIME_DEFINITIONS,
    }),
  );

  // 2) 传了目录分发资产：按 version/file/sha256/size 四字段写入，其它段一字不变。
  const manifest = buildAgentRuntimeManifest(
    LINUX_PLATFORM_KEY,
    agentAssets,
    undefined,
    dirDist,
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(Object.keys(manifest), [
    'schemaVersion',
    'platformKey',
    'claudeCode',
    'codex',
    'codexPackage',
    'pi',
  ]);
  assert.deepEqual(manifest.claudeCode, agentAssets.claudeCode);
  assert.deepEqual(manifest.codex, agentAssets.codex);
  assert.deepEqual(manifest.codexPackage, dirDist.codexPackage);
  assert.deepEqual(manifest.pi, dirDist.pi);

  // 3) 深拷贝：调用方后续动 manifest 不得回头改到发布脚本手里的资产对象。
  manifest.pi.size = 1;
  assert.equal(dirDist.pi.size, PI_SIZE);

  // 4) 只给一个段：另一段缺失仍然合法（两段相互独立、都是可选段）。
  const onlyPackage = buildAgentRuntimeManifest(
    LINUX_PLATFORM_KEY,
    agentAssets,
    undefined,
    { codexPackage: dirDist.codexPackage },
  );
  assert.equal('pi' in onlyPackage, false);
  assert.doesNotThrow(() =>
    assertRuntimeManifestAssets(onlyPackage, LINUX_PLATFORM_KEY, {
      required: false,
      definitions: DIR_DIST_RUNTIME_DEFINITIONS,
    }),
  );
  // 但发布侧要求两段齐备（2026-10-08 事故的形态正是「从来不发这一段」）。
  assert.throws(
    () =>
      assertRuntimeManifestAssets(onlyPackage, LINUX_PLATFORM_KEY, {
        definitions: DIR_DIST_RUNTIME_DEFINITIONS,
      }),
    /pi/,
  );
  assert.doesNotThrow(() =>
    assertRuntimeManifestAssets(manifest, LINUX_PLATFORM_KEY, {
      definitions: DIR_DIST_RUNTIME_DEFINITIONS,
    }),
  );

  // 5) 发布侧字段（pin 直链 / 平台 key / 上游资产名）不得漏进 manifest：消费端只认四字段。
  const pinnedLike = {
    ...dirDist.pi,
    url: 'https://github.com/earendil-works/pi/releases/download/v1.0.2/pi-linux-x64.tar.gz',
    platformKey: LINUX_PLATFORM_KEY,
    upstreamAssetName: 'pi-linux-x64.tar.gz',
  };
  assert.deepEqual(
    Object.keys(
      buildAgentRuntimeManifest(LINUX_PLATFORM_KEY, agentAssets, undefined, { pi: pinnedLike }).pi,
    ),
    ['version', 'file', 'sha256', 'size'],
  );
});

test('linux runtime: 段存在但形状非法必须 fail closed（缺失才合法）', () => {
  const agentAssets = linuxAgentAssets();
  const good = linuxDirDistSections().codexPackage;
  // 对象路径不带平台段 → 客户端按平台取资产会拿错
  assert.throws(
    () =>
      buildAgentRuntimeManifest(LINUX_PLATFORM_KEY, agentAssets, undefined, {
        codexPackage: { ...good, file: 'codex-package/0.153.4/codex-package.tar.gz' },
      }),
    /codexPackage/,
  );
  // 摘要非法
  assert.throws(
    () =>
      buildAgentRuntimeManifest(LINUX_PLATFORM_KEY, agentAssets, undefined, {
        codexPackage: { ...good, sha256: 'not-a-sha256' },
      }),
    /codexPackage/,
  );
  // size 必须是 > 0 的安全整数
  assert.throws(
    () =>
      buildAgentRuntimeManifest(LINUX_PLATFORM_KEY, agentAssets, undefined, {
        pi: { ...linuxDirDistSections().pi, size: 0 },
      }),
    /pi/,
  );
});

test('dry-run 预览打印两个新段与对象路径，且点明 pi 与 codexPackage 的摘要来源不同', () => {
  const sections = linuxDirDistSections();
  const lines = formatMekaDirDistManifestPreview(sections);
  assert.equal(lines.length, 2);
  assert.ok(
    lines[0].startsWith('  codexPackage: '),
    `第一行应当是 codexPackage 段: ${lines[0]}`,
  );
  assert.ok(lines[1].startsWith('  pi: '), `第二行应当是 pi 段: ${lines[1]}`);

  const jsonOf = (line) => JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
  // codexPackage 是原样转发 ⇒ dry-run 就能打印出与最终 manifest 逐字相同的四字段。
  assert.deepEqual(jsonOf(lines[0]), sections.codexPackage);
  assert.match(lines[0], /原样转发/);
  // pi 是确定性重打包 ⇒ 摘要只有 --execute 下载上游归档后才算得出，这里必须是 null 占位，
  // 绝不能把 pin（上游归档）的摘要冒充成段摘要。
  assert.deepEqual(jsonOf(lines[1]), {
    version: PI_PIN_VERSION,
    file: `pi/${PI_PIN_VERSION}/${LINUX_PLATFORM_KEY}/pi.dist.tar.gz`,
    sha256: null,
    size: null,
  });
  assert.match(lines[1], /重打包/);
  assert.match(lines[1], /上游 pin sha256=/);
  // 对象路径必须在输出里，便于人工核对不可覆盖的版本化对象。
  assert.ok(lines[0].includes(`"file":"codex-package/${PIN_VERSION}/${LINUX_PLATFORM_KEY}/codex-package.tar.gz"`));
  assert.ok(lines[1].includes(`"file":"pi/${PI_PIN_VERSION}/${LINUX_PLATFORM_KEY}/pi.dist.tar.gz"`));
  // 未收集到资产时也要有明确输出（dry-run 不允许静默少打印一段）。
  assert.match(
    formatMekaDirDistManifestPreview({}).join('\n'),
    /codexPackage: <未收集到该段的待发布资产>[\s\S]*pi: <未收集到该段的待发布资产>/,
  );
});
