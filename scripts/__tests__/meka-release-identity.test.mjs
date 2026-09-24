import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  artifactBaseName,
  buildBuildInfo,
} from '../../apps/desktop/scripts/ci/package-lib.mjs';
// package-desktop.mjs 是「import 即打包」的入口脚本;它只在本文件被测试加载时
// 跳过 main()(判据见该文件末尾注释),所以这里 import 是安全的。
import {
  assertPackagedAppVersion,
  isVersionlessSentinelVersion,
  readAsarEntry,
  readAsarEntryFromFile,
} from '../../apps/desktop/scripts/package-desktop.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * 按 asar 归档布局在内存里拼一个最小归档(不落盘),用来覆盖头部偏移解析:
 *   [0..3]=4 / [4..7]=头部 pickle 整段长度 / [8..11]=JSON 字节长度 / JSON / 数据段。
 * 布局取自 @electron/asar 的 readArchiveHeaderSync + createFilesystemWriteStream;
 * 与官方实现的交叉校验见下方单独一条用例。
 */
function buildAsarBuffer(files) {
  const align4 = (n) => n + ((4 - (n % 4)) % 4);
  const headerTree = { files: {} };
  const contents = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const buf = Buffer.from(content, 'utf8');
    headerTree.files[name] = { size: buf.length, offset: String(offset) };
    offset += buf.length;
    contents.push(buf);
  }
  const json = Buffer.from(JSON.stringify(headerTree), 'utf8');
  const payloadSize = 4 + align4(json.length);
  const headerLength = 4 + payloadSize;
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeUInt32LE(4, 0);
  sizeBuf.writeUInt32LE(headerLength, 4);
  const headerBuf = Buffer.alloc(headerLength);
  headerBuf.writeUInt32LE(payloadSize, 0);
  headerBuf.writeUInt32LE(json.length, 4);
  json.copy(headerBuf, 8);
  return Buffer.concat([sizeBuf, headerBuf, ...contents]);
}

test('Cindy Meka release artifacts use the independent new channel names', () => {
  assert.equal(
    artifactBaseName({ version: '0.0.65', versionless: false }),
    'cindy-meka-0.0.65',
  );
  assert.equal(
    artifactBaseName({ version: '0.0.0', versionless: true }),
    'cindy-meka-unversioned',
  );
  assert.equal(
    buildBuildInfo({
      version: '0.0.65',
      versionless: false,
      region: 'cn',
      platform: 'win32',
      arch: 'x64',
      commitSha: 'abc',
      electronVersion: '1',
      schemaVersionMax: 88,
      migrationFiles: [],
      files: [],
      signing: {},
    }).product,
    'cindy-meka-desktop',
  );
});

test('packaging mirrors Cindy Meka executable, updater destination and ZIP names', () => {
  const ciLib = read('apps/desktop/scripts/ci/lib.mjs');
  const smoke = read('apps/desktop/scripts/smoke-packaged.mjs');
  const forge = read('apps/desktop/forge.config.ts');
  const packager = read('apps/desktop/scripts/package-desktop.mjs');

  assert.match(ciLib, /export const PACKAGED_APP_NAME = 'CindyMeka';/);
  assert.match(smoke, /const PACKAGED_APP_NAME = 'CindyMeka';/);
  assert.match(
    forge,
    /target', 'release', 'cindy-updater\.exe'\)/,
    'Cargo source bin remains cindy-updater',
  );
  assert.match(
    forge,
    /resources', UPDATER_EXE\)/,
    'packaged updater destination follows cindy-meka-updater identity',
  );
  assert.match(
    packager,
    /path\.join\(artifactDir, `\$\{baseName\}\.zip`\)/,
    'Windows keeps the old architecture-free hotfix name',
  );
  assert.match(
    packager,
    /path\.join\(artifactDir, `\$\{baseName\}-\$\{arch\}\.zip`\)/,
    'macOS keeps the old architecture-qualified hotfix name',
  );
  assert.doesNotMatch(packager, /`\$\{baseName\}-hotfix\.zip`/);
});

test('release packaging can pin the endpoint bootstrap to the Cindy Meka CDN', () => {
  const packager = read('apps/desktop/scripts/package-desktop.mjs');
  assert.match(packager, /process\.env\.XDT_CDN_BASE_URL/);
  assert.match(
    packager,
    /region === 'cn' && !versionless && !mekaReleaseCdnBaseUrl/,
  );
  assert.match(
    packager,
    /clientBuildEnv\.VITE_ENDPOINT_MANIFEST_BASE_URL = validatedCdnBaseUrl/,
  );
});

test('macOS packaged smoke isolates its temporary profile from the product keychain', () => {
  const smoke = read('apps/desktop/scripts/smoke-packaged.mjs');
  assert.match(smoke, /platform === 'darwin' \? \['--use-mock-keychain'\] : \[\]/);
});

test('release completion prints installer and hotfix download URLs', () => {
  const publisher = read('apps/desktop/scripts/publish-desktop.mjs');
  assert.match(publisher, /storage\.cdnUrl\(installerKey\)/);
  assert.match(publisher, /storage\.cdnUrl\(hotfixKey\)/);
});

test('Windows release keeps the old Meka signing service without exposing its token', () => {
  const forge = read('apps/desktop/forge.config.ts');
  const packager = read('apps/desktop/scripts/package-desktop.mjs');
  const signer = read('apps/desktop/scripts/sign.py');

  assert.match(forge, /process\.env\.NPKG_TOKEN\?\.trim\(\)/);
  assert.match(forge, /return `python "\$\{signScript\}" \{file\}`/);
  assert.doesNotMatch(forge, /NPKG_TOKEN\}.*\{file\}|\{file\}.*NPKG_TOKEN\}/);
  assert.match(packager, /delete forgeEnv\.NPKG_TOKEN/);
  assert.match(signer, /os\.environ\.get\("NPKG_TOKEN"/);
  assert.doesNotMatch(signer, /sys\.argv\[2\]/);
  assert.match(signer, /SIGNING_POLL_ATTEMPTS = 200/);
  assert.match(signer, /SIGNING_POLL_INTERVAL_SECONDS = 3/);
  assert.match(signer, /range\(SIGNING_POLL_ATTEMPTS\)/);
});

test('macOS release accepts the existing Meka certificate without requiring notarization credentials', () => {
  const packager = read('apps/desktop/scripts/package-desktop.mjs');
  const ciLib = read('apps/desktop/scripts/ci/lib.mjs');
  const envExample = read('apps/desktop/.env.example');

  assert.match(packager, /requestedSigningMode === 'self-signed'/);
  assert.match(packager, /timestamp: false/);
  assert.match(packager, /signingMode = 'self-signed'/);
  assert.match(ciLib, /identity\.timestamp === false \? '' : ' --timestamp'/);
  assert.match(envExample, /MAC_SIGNING_MODE=developer-id/);
});

// ── 产物级版本断言 ───────────────────────────────────────────────────────────
// 残余旁路:绕过 package-desktop.mjs 直接 `electron-forge make`(或仓外发布流水线
// 自带打包逻辑)时,asar 内会带着仓内占位的 0.0.0 出门,而发布侧 validateBuildInfo
// 只读 build-info.json(它复述本脚本自己写的版本),拦不住仓外产物。下面两组用例
// 分别锁定「判定语义」和「产物内真实版本确实被读出来」。

test('packaged version assertion reads the version out of the asar archive', () => {
  const archive = buildAsarBuffer({
    'package.json': JSON.stringify({ name: 'cindy-meka', version: '1.2.3' }),
    'other.txt': 'not the entry we want',
  });
  const slice = (offset, length) => archive.subarray(offset, offset + length);

  assert.equal(
    JSON.parse(readAsarEntry(slice, 'package.json').toString('utf8')).version,
    '1.2.3',
  );
  // 条目不存在 / 头部被截断都要 fail closed,而不是读出一段错位的内容。
  assert.throws(() => readAsarEntry(slice, 'missing.json'), /没有 missing\.json/);
  assert.throws(
    () => readAsarEntry((offset, length) => slice(offset, Math.min(length, 4)), 'package.json'),
    /头部/,
  );
});

test('asar reader agrees with an archive written by the official @electron/asar', async (t) => {
  let asar;
  try {
    asar = await import('@electron/asar');
  } catch {
    // 官方实现只是 forge 的传递依赖;不可用时上面那条合成归档用例仍然覆盖同一段
    // 偏移解析逻辑,这里如实标 skip,不静默放过。
    t.skip('@electron/asar is not installed (transitive forge dependency); skipping real-archive cross-check');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-asar-'));
  try {
    const srcDir = path.join(root, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'package.json'),
      JSON.stringify({ name: 'cindy-meka', version: '0.0.64' }),
    );
    const archivePath = path.join(root, 'app.asar');
    await asar.createPackage(srcDir, archivePath);

    assert.equal(
      JSON.parse(readAsarEntryFromFile(archivePath, 'package.json').toString('utf8')).version,
      '0.0.64',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('packaged version assertion matrix', () => {
  const assertVersion = (overrides) =>
    assertPackagedAppVersion({
      packagedVersion: '1.2.3',
      requestedVersion: '1.2.3',
      versionless: false,
      ...overrides,
    });

  // 版本化 × 相等 → 通过
  assert.doesNotThrow(() => assertVersion({}));
  // 版本化 × 不等 → 失败
  assert.throws(
    () => assertVersion({ packagedVersion: '1.2.4' }),
    /不一致:期望 1\.2\.3,实得 1\.2\.4/,
  );
  // 版本化 × 哨兵(含 0.0.0-* 历史形态)→ 失败,消息要指出占位值不可发布
  assert.throws(() => assertVersion({ packagedVersion: '0.0.0' }), /占位哨兵 0\.0\.0/);
  assert.throws(() => assertVersion({ packagedVersion: '0.0.0-dev' }), /占位哨兵 0\.0\.0-dev/);
  // 版本化 × 读不到版本 → 失败
  assert.throws(() => assertVersion({ packagedVersion: undefined }), /读不到版本号/);
  // versionless × 哨兵 → 通过(这是预期例外,不得误报)
  assert.doesNotThrow(() =>
    assertVersion({ packagedVersion: '0.0.0', requestedVersion: '0.0.0', versionless: true }),
  );
  // versionless × 真实版本 → 失败(版本无关包不该带着真实版本流出去)
  assert.throws(
    () => assertVersion({ packagedVersion: '1.2.3', requestedVersion: '0.0.0', versionless: true }),
    /版本无关构建/,
  );

  assert.equal(isVersionlessSentinelVersion('0.0.0'), true);
  assert.equal(isVersionlessSentinelVersion('0.0.0-rc.1'), true);
  assert.equal(isVersionlessSentinelVersion('0.0.1'), false);
  assert.equal(isVersionlessSentinelVersion('1.0.0'), false);
});

test('packaging asserts the artifact version after make and before collecting artifacts', () => {
  const packager = read('apps/desktop/scripts/package-desktop.mjs');
  const makeAt = packager.indexOf('runForgeMake({ platform, arch, region, version, versionless, noSign });');
  const assertAt = packager.indexOf(
    'verifyPackagedAppVersion({ appName, platform, arch, version, versionless });',
  );
  const collectAt = packager.indexOf('await finishers[platform]({');

  assert.ok(makeAt > 0, 'runForgeMake 调用点必须存在');
  assert.ok(assertAt > makeAt, '产物级版本断言必须在 runForgeMake 之后');
  assert.ok(collectAt > assertAt, '产物级版本断言必须在产物归集之前');
  assert.match(packager, /APP_VERSION: version/);
});
