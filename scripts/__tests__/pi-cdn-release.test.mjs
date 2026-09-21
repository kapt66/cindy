// 应用 manifest 的 pi 目录分发资产（manifest.pi）发布链。
//
// 背景（0.0.21 / 0.0.22 packaged 包「模型只有零星几个可用」）：`agent-binaries` 的
// `CONFIG.pi` 是 `manifestField: 'pi'` + `tar-gz-dir` + `optionalAsset`，而 Pi 的 runtime
// **只能从这一段拿**——安装包不内置 `resources/pi`，客户端也没有别的回退
// （`resolvePiBinaryPath` 只认受管安装版）。本仓发布链路（runtime-release.mjs /
// release-lib.mjs）从来没发过这个段，于是每次启动都是：
//   prepare('pi') → asset_missing → 「pi agent disabled for this launch」
//   → get-capabilities 只报 claude-code / codex
// XD 网关这类供应商的多数模型只在 `pi` 路由上默认开启（其它 agent 与模型原生协议不兼容，
// `defaultEnabled=false`），所以 packaged 用户看到的模型列表被砍到零星几个
// （deepseek-v4.1-flash 就是典型），而开发机因为有 `apps/pi-bin/<platform>/` 短路一切正常。
//
// pi 与 codexPackage 的差别决定了这里必须重打包而不是原样转发：
//   1. 上游 pin 的 win32 资产是 `.zip`、unix 是带 `pi/` 壳目录的 `.tar.gz`，客户端只认
//      tar.gz 目录分发；
//   2. 上游归档不含 `theme/`（缺它 Pi 的 RPC 模式启动即崩），必须补本仓主题。
// 重打包因此必须是**确定性**的：版本化对象不可覆盖，同一版本重跑只能得到同一份字节。
//
// node 内置 test runner：`node --test scripts/__tests__/pi-cdn-release.test.mjs`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildCanaryManifest } from '../../apps/desktop/scripts/ci/release-lib.mjs';
import {
  PI_DIR_DIST_DEFINITION,
  RELEASE_RUNTIME_DEFINITIONS,
  assertRuntimeManifestAssets,
  collectPinnedDirDistAssets,
  prepareRepackedDirDistArchive,
  publishDirDistAssets,
} from '../../apps/desktop/scripts/ci/runtime-release.mjs';
import { resolveTarExecutable } from '../../tools/pi/update.mjs';
import { sha256Hex } from '../../tools/shared/verify-sha256.mjs';

const PIN_VERSION = '0.85.1';
const UPSTREAM_ASSET = 'pi-darwin-arm64.tar.gz';
const UPSTREAM_URL = `https://github.com/earendil-works/pi/releases/download/v${PIN_VERSION}/${UPSTREAM_ASSET}`;
const THEME_FILES = ['theme/dark.json', 'theme/light.json', 'theme/theme-schema.json'];

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 造一份「上游 unix 归档」：内容包在 `pi/` 壳目录里、不含 theme/、主执行文件为 `pi`。
 * （与真实上游资产同形；win32 的平铺 zip 另有一条 Windows-only 用例。）
 */
function makeUpstreamTarGz(root, { nested = true, withTheme = false, mainBinary = 'pi' } = {}) {
  const inputDir = path.join(root, 'upstream-input');
  const packageDir = nested ? path.join(inputDir, 'pi') : inputDir;
  fs.mkdirSync(path.join(packageDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, mainBinary), Buffer.alloc(4096, 0x70));
  fs.writeFileSync(path.join(packageDir, 'assets', 'CHANGELOG.md'), '# pi\n');
  if (withTheme) {
    fs.mkdirSync(path.join(packageDir, 'theme'), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'theme', 'dark.json'), '{"name":"upstream"}\n');
  }
  const archivePath = path.join(root, UPSTREAM_ASSET);
  const created = spawnSync(
    resolveTarExecutable(),
    nested
      ? ['-czf', archivePath, '-C', inputDir, 'pi']
      : ['-czf', archivePath, '-C', inputDir, '.'],
    { encoding: 'utf8' },
  );
  assert.equal(created.status, 0, created.stderr || created.error?.message);
  return fs.readFileSync(archivePath);
}

/** 把 pin 写进一个临时 projectRoot，返回值同时给出归档字节。 */
function withPiPin(archiveBytes, run, overrides = {}) {
  const root = tempDir('cindy-pi-pin-');
  try {
    const pinDir = path.join(root, 'tools', 'pi');
    fs.mkdirSync(pinDir, { recursive: true });
    fs.writeFileSync(
      path.join(pinDir, 'latest.json'),
      `${JSON.stringify(
        {
          version: PIN_VERSION,
          runtimeAssets: {
            'darwin-arm64': {
              url: UPSTREAM_URL,
              sha256: sha256Hex(archiveBytes),
              size: archiveBytes.length,
              ...overrides,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** pi 目标定义单独收集（codexPackage 的 pin 不在本用例的临时 projectRoot 里）。 */
function collectPiAssets(projectRoot, platformKey = 'darwin-arm64', definitions = [PI_DIR_DIST_DEFINITION]) {
  return collectPinnedDirDistAssets(platformKey, { projectRoot, definitions });
}

/** 只发布 pi 段（默认定义集还包含 codexPackage，它的 pin 不在本用例里）。 */
function publishPi(storage, assets, baseManifest, outputDir, options = {}) {
  return publishDirDistAssets(storage, assets, baseManifest, outputDir, {
    definitions: [PI_DIR_DIST_DEFINITION],
    ...options,
  });
}

function fakeDownload(bytes) {
  return (url, destPath) => {
    assert.match(url, /^https:\/\/github\.com\//);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, bytes);
  };
}

function makeStorage(initial = []) {
  const objects = new Map(initial);
  return {
    objects,
    async head(key) {
      return objects.get(key) ?? null;
    },
    async putFile(key, filePath, options = {}) {
      const bytes = fs.readFileSync(filePath);
      objects.set(key, {
        size: bytes.length,
        bytes,
        metadata: options.metadata ?? {},
      });
    },
  };
}

function extractUploaded(bytes, intoDir) {
  fs.mkdirSync(intoDir, { recursive: true });
  const archivePath = path.join(intoDir, 'uploaded.tar.gz');
  fs.writeFileSync(archivePath, bytes);
  const extracted = path.join(intoDir, 'extracted');
  fs.mkdirSync(extracted, { recursive: true });
  const result = spawnSync(resolveTarExecutable(), ['-xzf', archivePath, '-C', extracted], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return extracted;
}

test('collectPinnedDirDistAssets: pi 资产锚定 pin 的平台表（资产名/主执行文件/对象路径）', () => {
  const bytes = makeUpstreamTarGz(tempDir('cindy-pi-fixture-'));
  withPiPin(bytes, (projectRoot) => {
    const assets = collectPiAssets(projectRoot);
    assert.equal(assets.pi.version, PIN_VERSION);
    assert.equal(assets.pi.sha256, sha256Hex(bytes));
    assert.equal(assets.pi.size, bytes.length);
    assert.equal(assets.pi.url, UPSTREAM_URL);
    assert.equal(assets.pi.upstreamAssetName, UPSTREAM_ASSET);
    assert.equal(assets.pi.binaryName, 'pi');
    assert.equal(assets.pi.file, `pi/${PIN_VERSION}/darwin-arm64/pi.dist.tar.gz`);
    // 客户端 assertRuntimeManifestAssets 的路径约束：必须带平台段。
    assert.ok(assets.pi.file.includes('/darwin-arm64/'));
  });
});

test('collectPinnedDirDistAssets: pi pin 缺失/非 github 直链/非法 sha256 一律 fail closed', () => {
  const bytes = makeUpstreamTarGz(tempDir('cindy-pi-fixture-'));
  withPiPin(bytes, (projectRoot) => {
    assert.throws(
      () => collectPiAssets(path.join(projectRoot, 'missing')),
      /pin 缺失/,
    );
  });
  withPiPin(bytes, (projectRoot) => {
    assert.throws(
      () => collectPiAssets(projectRoot),
      /approved github\.com release asset/,
    );
  }, { url: 'https://example.test/pi-darwin-arm64.tar.gz' });
  withPiPin(bytes, (projectRoot) => {
    assert.throws(
      () => collectPiAssets(projectRoot),
      /valid sha256/,
    );
  }, { sha256: 'not-a-sha256' });
});

test('collectPinnedDirDistAssets: 平台表没有该平台时拒绝（不猜布局）', () => {
  const bytes = makeUpstreamTarGz(tempDir('cindy-pi-fixture-'));
  withPiPin(bytes, (projectRoot) => {
    assert.throws(
      () =>
        collectPinnedDirDistAssets('darwin-arm64', {
          projectRoot,
          definitions: [
            {
              ...PI_DIR_DIST_DEFINITION,
              platforms: [{ key: 'win32-x64', asset: 'pi-windows-x64.zip', binFile: 'pi.exe' }],
            },
          ],
        }),
      /规范表没有 darwin-arm64 条目/,
    );
  });
});

test('publishDirDistAssets(pi): 下载 pin 归档 → 归一布局 → 补主题 → 确定性 tar.gz', async () => {
  const fixtureRoot = tempDir('cindy-pi-fixture-');
  const outputRoot = tempDir('cindy-pi-out-');
  try {
    const upstream = makeUpstreamTarGz(fixtureRoot);
    const assets = withPiPin(upstream, (projectRoot) => collectPiAssets(projectRoot));
    const storage = makeStorage();
    const published = await publishPi(storage, assets, null, path.join(outputRoot, 'out'), {
      download: fakeDownload(upstream),
      log: () => {},
    });

    assert.equal(published.results.pi, 'uploaded');
    const remote = storage.objects.get(assets.pi.file);
    assert.ok(remote, '上传对象必须落在版本化路径上');
    // manifest 记的是**重打包产物**；pin 的摘要在对象元数据里（重跑据此证明来源）。
    assert.equal(published.manifestAssets.pi.sha256, sha256Hex(remote.bytes));
    assert.equal(published.manifestAssets.pi.size, remote.bytes.length);
    assert.equal(remote.metadata.sha256, published.manifestAssets.pi.sha256);
    assert.equal(remote.metadata['pinned-sha256'], sha256Hex(upstream));
    assert.equal(remote.metadata['pinned-version'], PIN_VERSION);
    // 真的重打包了，而不是原样转发上游字节。
    assert.notEqual(sha256Hex(remote.bytes), sha256Hex(upstream));

    // 客户端解包契约：主执行文件在归档根（不再有 `pi/` 壳目录），theme/ 由本仓补齐。
    const extracted = extractUploaded(remote.bytes, path.join(outputRoot, 'verify'));
    assert.ok(fs.statSync(path.join(extracted, 'pi')).isFile(), '主执行文件必须在归档根');
    assert.equal(fs.existsSync(path.join(extracted, 'pi')), true);
    for (const themeFile of THEME_FILES) {
      assert.ok(fs.existsSync(path.join(extracted, themeFile)), `缺少补齐的 ${themeFile}`);
    }

    // 中间产物不残留（临时 workDir 与下载归档都要清掉）。
    assert.deepEqual(fs.readdirSync(path.join(outputRoot, 'out')), []);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('prepareRepackedDirDistArchive: 同一份内容两次重打包得到同一份字节', async () => {
  const fixtureRoot = tempDir('cindy-pi-fixture-');
  const outputRoot = tempDir('cindy-pi-determinism-');
  try {
    const upstream = makeUpstreamTarGz(fixtureRoot);
    const local = withPiPin(upstream, (projectRoot) => collectPiAssets(projectRoot)).pi;
    const first = await prepareRepackedDirDistArchive(
      PI_DIR_DIST_DEFINITION,
      local,
      path.join(outputRoot, 'run-1'),
      { download: fakeDownload(upstream), log: () => {} },
    );
    const second = await prepareRepackedDirDistArchive(
      PI_DIR_DIST_DEFINITION,
      local,
      path.join(outputRoot, 'run-2'),
      { download: fakeDownload(upstream), log: () => {} },
    );
    assert.equal(first.sha256, second.sha256, '重打包必须逐字节确定（否则不可覆盖对象会拒绝重跑）');
    assert.equal(first.size, second.size);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('publishDirDistAssets(pi): 重复发布幂等复用，且不再下载', async () => {
  const fixtureRoot = tempDir('cindy-pi-fixture-');
  const outputRoot = tempDir('cindy-pi-reuse-');
  try {
    const upstream = makeUpstreamTarGz(fixtureRoot);
    const assets = withPiPin(upstream, (projectRoot) => collectPiAssets(projectRoot));
    const storage = makeStorage();
    const first = await publishPi(storage, assets, null, path.join(outputRoot, 'out'), {
      download: fakeDownload(upstream),
      log: () => {},
    });
    const manifest = { app: { version: '0.0.23' }, ...first.manifestAssets };
    const second = await publishPi(storage, assets, manifest, path.join(outputRoot, 'out'), {
      download: () => {
        throw new Error('复用路径不应再下载');
      },
      log: () => {},
    });
    assert.equal(second.results.pi, 'reused');
    assert.deepEqual(second.manifestAssets.pi, first.manifestAssets.pi);
    assert.equal(storage.objects.size, 1);

    // canary 被 reset 回上一版 stable（baseManifest 没有 pi 段）时，仍能按对象自身的
    // sha256/size 重建该段，而不是重下一次或直接失败。
    const rebuilt = await publishPi(storage, assets, null, path.join(outputRoot, 'out'), {
      download: () => {
        throw new Error('对象仍在时不应再下载');
      },
      log: () => {},
    });
    assert.equal(rebuilt.results.pi, 'reused');
    assert.deepEqual(rebuilt.manifestAssets.pi, first.manifestAssets.pi);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('publishDirDistAssets(pi): pin 字节不符 / 同版本对象来自别的 pin 都必须失败', async () => {
  const fixtureRoot = tempDir('cindy-pi-fixture-');
  const outputRoot = tempDir('cindy-pi-bad-');
  try {
    const upstream = makeUpstreamTarGz(fixtureRoot);
    const assets = withPiPin(upstream, (projectRoot) => collectPiAssets(projectRoot));

    // 下载字节被截断：大小先于 sha256 归因。
    await assert.rejects(
      publishPi(makeStorage(), assets, null, path.join(outputRoot, 'short'), {
        download: (_url, destPath) => fs.writeFileSync(destPath, Buffer.alloc(16)),
        log: () => {},
      }),
      /下载字节数不符/,
    );

    // 同字节数的篡改内容：pin 硬门禁拦住。
    await assert.rejects(
      publishPi(makeStorage(), assets, null, path.join(outputRoot, 'tampered'), {
        download: (_url, destPath) => fs.writeFileSync(destPath, Buffer.alloc(upstream.length, 0x65)),
        log: () => {},
      }),
      /SHA256 mismatch/,
    );

    // 版本化对象已存在，但 `pinned-sha256` 不是当前 pin → 拒绝覆盖（换了上游字节的同版本）。
    await assert.rejects(
      publishPi(
        makeStorage([
          [
            assets.pi.file,
            { size: 32, metadata: { sha256: 'a'.repeat(64), 'pinned-sha256': 'b'.repeat(64) } },
          ],
        ]),
        assets,
        null,
        path.join(outputRoot, 'conflict'),
        { download: fakeDownload(upstream), log: () => {} },
      ),
      /拒绝覆盖/,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('prepareRepackedDirDistArchive: 归档里找不到主执行文件即失败', async () => {
  const fixtureRoot = tempDir('cindy-pi-fixture-');
  const outputRoot = tempDir('cindy-pi-layout-');
  try {
    // `pi/` 壳目录在，但里面没有主执行文件 → 布局归一后仍缺主程序，必须失败。
    const missingBinary = makeUpstreamTarGz(fixtureRoot, { mainBinary: 'not-pi' });
    const local = withPiPin(missingBinary, (projectRoot) => collectPiAssets(projectRoot)).pi;
    await assert.rejects(
      prepareRepackedDirDistArchive(PI_DIR_DIST_DEFINITION, local, path.join(outputRoot, 'run-1'), {
        download: fakeDownload(missingBinary),
        log: () => {},
      }),
      /missing main executable/,
    );

    // 既没有平铺主程序、也没有 `pi/` 壳目录 → 直接拒绝，不猜布局。
    const wrongLayoutRoot = tempDir('cindy-pi-fixture-flat-');
    try {
      const flatBinary = makeUpstreamTarGz(wrongLayoutRoot, { nested: false, mainBinary: 'not-pi' });
      const flatLocal = withPiPin(flatBinary, (projectRoot) => collectPiAssets(projectRoot)).pi;
      await assert.rejects(
        prepareRepackedDirDistArchive(PI_DIR_DIST_DEFINITION, flatLocal, path.join(outputRoot, 'run-2'), {
          download: fakeDownload(flatBinary),
          log: () => {},
        }),
        /No pi\/ directory found/,
      );
    } finally {
      fs.rmSync(wrongLayoutRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('publishDirDistAssets(pi): Windows 平铺 zip 上游资产同样重打成 tar.gz', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows tar ZIP behavior');
  const fixtureRoot = tempDir('cindy-pi-zip-fixture-');
  const outputRoot = tempDir('cindy-pi-zip-out-');
  try {
    // 上游 win32 资产是平铺 zip（v0.83+ 起不再包 `pi/` 壳目录）。
    const inputDir = path.join(fixtureRoot, 'input');
    fs.mkdirSync(path.join(inputDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(inputDir, 'pi.exe'), Buffer.alloc(4096, 0x70));
    fs.writeFileSync(path.join(inputDir, 'assets', 'CHANGELOG.md'), '# pi\n');
    const zipPath = path.join(fixtureRoot, 'pi-windows-x64.zip');
    const created = spawnSync(
      resolveTarExecutable(),
      ['-a', '-cf', zipPath, '-C', inputDir, '.'],
      { encoding: 'utf8' },
    );
    assert.equal(created.status, 0, created.stderr || created.error?.message);
    const upstream = fs.readFileSync(zipPath);

    const pinRoot = tempDir('cindy-pi-zip-pin-');
    const pinDir = path.join(pinRoot, 'tools', 'pi');
    fs.mkdirSync(pinDir, { recursive: true });
    fs.writeFileSync(
      path.join(pinDir, 'latest.json'),
      `${JSON.stringify(
        {
          version: PIN_VERSION,
          runtimeAssets: {
            'win32-x64': {
              url: `https://github.com/earendil-works/pi/releases/download/v${PIN_VERSION}/pi-windows-x64.zip`,
              sha256: sha256Hex(upstream),
              size: upstream.length,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    try {
      const assets = collectPiAssets(pinRoot, 'win32-x64');
      assert.equal(assets.pi.binaryName, 'pi.exe');
      const storage = makeStorage();
      const published = await publishPi(
        storage,
        assets,
        null,
        path.join(outputRoot, 'out'),
        { download: fakeDownload(upstream), log: () => {} },
      );
      assert.equal(published.results.pi, 'uploaded');
      const remote = storage.objects.get(assets.pi.file);
      const extracted = extractUploaded(remote.bytes, path.join(outputRoot, 'verify'));
      assert.ok(fs.statSync(path.join(extracted, 'pi.exe')).isFile(), 'pi.exe 必须在归档根');
      assert.ok(fs.existsSync(path.join(extracted, 'theme', 'dark.json')));
    } finally {
      fs.rmSync(pinRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('buildCanaryManifest + assertRuntimeManifestAssets: pi 段与其它 runtime 同时在册', () => {
  const asset = (file) => ({ version: '1.2.3', file, sha256: 'a'.repeat(64), size: 1 });
  const release = {
    version: '0.0.23',
    platformKey: 'win32-x64',
    installer: { name: 'cindy-meka-0.0.23-Setup.exe', sha256: 'b'.repeat(64), size: 2 },
    hotfix: { name: 'cindy-meka-0.0.23.zip', sha256: 'c'.repeat(64), size: 3 },
  };
  const runtimeAssets = {
    claudeCode: asset(`claude-code/1.2.3/win32-x64/claude.exe.gz`),
    codex: asset(`codex/1.2.3/win32-x64/codex.exe.gz`),
    ripgrep: asset(`ripgrep/1.2.3/win32-x64/rg.exe.gz`),
    codexPackage: asset(`codex-package/1.2.3/win32-x64/codex-package.tar.gz`),
    pi: asset(`pi/${PIN_VERSION}/win32-x64/pi.dist.tar.gz`),
  };
  const manifest = buildCanaryManifest(null, release, { runtimeAssets });
  assert.deepEqual(manifest.pi, runtimeAssets.pi);
  assertRuntimeManifestAssets(manifest, 'win32-x64', { definitions: RELEASE_RUNTIME_DEFINITIONS });
  assert.equal(
    RELEASE_RUNTIME_DEFINITIONS.some((definition) => definition.field === 'pi'),
    true,
    'pi 必须进入应用 manifest 的齐备判据，否则漏发会被静默放过',
  );

  // 上一版 canary 带着 pi，本轮没发 → 必须被清掉（陈旧段不得顶包）。
  const dropped = buildCanaryManifest(
    { app: { version: '0.0.22' }, pi: { version: '0.84.4', file: 'pi/0.84.4/win32-x64/pi.dist.tar.gz', sha256: 'd'.repeat(64), size: 4 } },
    release,
    { runtimeAssets: { ...runtimeAssets, pi: undefined } },
  );
  assert.equal('pi' in dropped, false);
  assert.throws(
    () => assertRuntimeManifestAssets(dropped, 'win32-x64', { definitions: RELEASE_RUNTIME_DEFINITIONS }),
    /pi/,
  );
});
