#!/usr/bin/env node

// =============================================================================
// package-desktop.mjs — 桌面端统一打包入口(只打包,不发布)
//
// 打包/发布拆分(2026-07):本脚本产出可分发的本地产物 + build-info.json,
// 全程不写 OSS/CDN;发布(上传、update manifest、canary/stable)由后续的
// publish 侧脚本读 build-info.json 接手。
//
// 用法:
//   node scripts/package-desktop.mjs [options]
//
//   --platform win32|darwin|linux   默认当前平台(不支持交叉打包)
//   --arch     x64|arm64            显式传 = 只打该单架构;缺省时 darwin
//                                   双架构连打(arm64 + x64,同一版本号,
//                                   与发布侧 canary/promote 的 mac 双架构
//                                   默认行为对齐),win/linux 取当前 arch
//                                   (linux 两种 arch 都可打,但只能在同架构
//                                   宿主上——原生模块与 vec0.so 不交叉编译;
//                                   win32 仅 x64)
//   --region   cn|global|dev        版本无关包默认 global；传 --version 时必填，
//                                   决定应用身份、端点清单与发布目标
//   --version  x.y.z|major|minor|patch
//              缺省 = 版本无关打包:占位版本 0.0.0,包不参与热更新
//              (updateService 对 0.0.0 短路),开源社区拉仓即可打;
//              bump 关键字会只读拉一次 CDN manifest 取基线——这是打包阶段
//              仅存的 CDN 依赖,显式 x.y.z 则不再碰 CDN manifest。
//              (agent 侧车二进制走缓存优先的 ensureBinary:已就位且版本
//              匹配 pin 时跳过下载;首次打包仍需网络拉一次,之后可离线。)
//   --skip-smoke                    跳过 packaged smoke test(调试用)
//   --allow-unsigned                有版本打包放行无签名(win 缺 CINDY_WIN_SIGN_CMD /
//                                   mac 缺 APPLE_APP_PASSWORD 时降级 ad-hoc)
//   --no-sign                       主动跳过签名(即使签名配置在手;隐含 --allow-unsigned)。
//                                   外部签名命令依赖发布方自己的环境,不具备
//                                   该环境的机器打版本无关包时用它
//
// 产物: release/artifacts/<region>/<version|unversioned>/<platform-arch>/
//   cindy-meka-<version|unversioned>-Setup.exe / -<arch>.dmg /
//              -<amd64|arm64>.deb
//   cindy-meka-<version>.zip (Windows) / -<arch>.zip (macOS)   热更包
//   build-info.json                                      发布侧唯一输入
// =============================================================================

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBinary } from '../../../scripts/ensure-agent-binaries.mjs';
import { desktopClientBuildEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';
import {
  DESKTOP_ROOT,
  RELEASE_DIR,
  PACKAGED_APP_NAME,
  packagedAppName,
  loadDotenv,
  exec,
  sha256,
  writePackageVersion,
  runDbValidate,
  verifyPackagedDrizzle,
  runSmokeTest,
  runIOSSimulatorReleaseGate,
  fetchExistingManifestIfAvailable,
  findInstallerArtifact,
  ensureLinuxRuntimeAssets,
  logLinuxPackagingRequirements,
  writeMacEntitlements,
  adhocSignMacApp,
  resolveAppleIdentity,
  signMacAppWithIdentity,
  notarizeMacApp,
  createMacDMG,
} from './ci/lib.mjs';
import {
  VERSIONLESS_VERSION,
  parsePackageArgs,
  resolvePackageVersion,
  artifactRelDir,
  artifactBaseName,
  buildBuildInfo,
  debianArch,
  hostCanExecArch,
} from './ci/package-lib.mjs';
import {
  applyMacSigningConfigToEnv,
  applyReleaseCdnBaseUrlToEnv,
  validateMekaReleaseCdnBaseUrl,
} from './ci/release-regions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 构建元数据收集(commit / drizzle journal / electron 版本)────────────────

function collectBuildMeta() {
  const journal = JSON.parse(
    fs.readFileSync(path.join(DESKTOP_ROOT, 'drizzle', 'meta', '_journal.json'), 'utf8'),
  );
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const schemaVersionMax = entries.reduce(
    (max, e) => (typeof e.idx === 'number' && e.idx > max ? e.idx : max),
    -1,
  );
  const migrationFiles = fs
    .readdirSync(path.join(DESKTOP_ROOT, 'drizzle'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  let commitSha = '';
  try {
    commitSha = execSync('git rev-parse HEAD', { encoding: 'utf8', cwd: DESKTOP_ROOT }).trim();
  } catch { /* not in a git work tree */ }

  let electronVersion = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf8'));
    electronVersion = pkg.devDependencies?.electron ?? '';
  } catch { /* ignore */ }

  return { schemaVersionMax, migrationFiles, commitSha, electronVersion };
}

function verifyPackagedSourceMetadata({ appName, platform, arch, expectedCommit }) {
  const packagedDir = path.join(DESKTOP_ROOT, 'out', `${appName}-${platform}-${arch}`);
  const metadataPath =
    platform === 'darwin'
      ? path.join(packagedDir, `${appName}.app`, 'Contents', 'Resources', 'cindy-source.json')
      : path.join(packagedDir, 'resources', 'cindy-source.json');
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`packaged Cindy source metadata missing at ${metadataPath}`);
  }
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch (err) {
    throw new Error(`packaged Cindy source metadata is invalid JSON: ${err.message}`);
  }
  if (
    !metadata ||
    typeof metadata.sourceCommit !== 'string' ||
    !metadata.sourceCommit ||
    typeof metadata.builtAt !== 'string' ||
    !metadata.builtAt ||
    Number.isNaN(Date.parse(metadata.builtAt))
  ) {
    throw new Error(`packaged Cindy source metadata has invalid sourceCommit/builtAt: ${metadataPath}`);
  }
  if (expectedCommit && metadata.sourceCommit !== expectedCommit) {
    throw new Error(
      `packaged Cindy source metadata commit mismatch: expected ${expectedCommit}, got ${metadata.sourceCommit}`,
    );
  }
  console.log(`    verified packaged source metadata: ${metadata.sourceCommit}`);
}

// ── 产物级版本断言:核对 asar 内的真实版本 ────────────────────────────────────
//
// 为什么必须有这一层(而不是只信 build-info.json / 发布侧校验):
//   1. 版本无关哨兵 0.0.0 会同时关掉两条关键链路——updateService 对 0.0.0 短路
//      (包永久不参与应用内热更),插件市场协议把它当「未知版本 ⇒ 无条件放行」;
//   2. 收口点只在本脚本:APP_VERSION 注入 packagerConfig.appVersion,而 packaged
//      下 app.getVersion() 读的是 asar 内 package.json 的 version——那份文件由
//      writePackageVersion() 在本脚本里临时改写(forge 的 vite 插件
//      packageAfterCopy 直接复制 apps/desktop/package.json,仓内常驻值是占位
//      '0.0.0');
//   3. 于是只要有人绕过本脚本直接 `electron-forge make`,或仓外发布流水线自带
//      打包逻辑,产物就会带着占位版本出门;发布侧 validateBuildInfo 只看
//      build-info.json(它复述的是本脚本自己写进去的版本),杀不住仓外产物。
//   结论:断言必须落在「产物本身」上,且必须在 make 之后、归集/发布之前。

const align4 = (n) => n + ((4 - (n % 4)) % 4);

/** versionless 哨兵(0.0.0 与 0.0.0-*)判定。
 *  与 src/main/updateService.ts 的 isVersionlessAppVersion 同口径——那条链路决定
 *  产物是否参与应用内热更;这里在 .mjs 侧无法 import TS 实现,只能镜像同一规则,
 *  两侧语义必须一致,改其中一侧要同步另一侧。 */
export function isVersionlessSentinelVersion(version) {
  return version === VERSIONLESS_VERSION || version.startsWith(`${VERSIONLESS_VERSION}-`);
}

/**
 * 解析 asar 归档头部(布局对齐 @electron/asar 3.x 的 readArchiveHeaderSync):
 *   [0..3]     uint32LE 第一个 pickle 的 payload 长度(固定 4)
 *   [4..7]     uint32LE 头部 pickle 的整段长度 headerLength
 *   [8..11]    uint32LE 头部 JSON 的字节长度 jsonLength
 *   [12..12+jsonLength) 头部 JSON(目录树)
 * 数据段起点 = 8 + headerLength,条目里的 offset 相对它。
 * 纯函数(只吃两段 header buffer):偏移解析因此能脱离真实打包产物被单测覆盖。
 * 取舍:不用 @electron/asar 是因为它只是 forge 的传递依赖、未声明在本仓
 * package.json,靠 hoisted node_modules 才可见;自己解析只需 20 行、无新依赖。
 * 局限:这是对归档二进制布局的硬编码,格式若变会在此 fail closed(单测另用官方
 * 实现写出的真实归档做交叉校验,见 scripts/__tests__/meka-release-identity.test.mjs)。
 */
export function parseAsarHeader(sizeBuf, headerBuf) {
  if (sizeBuf.length < 8) {
    throw new Error(`asar 头部长度前缀不完整(读到 ${sizeBuf.length} 字节,需要 8)`);
  }
  const headerLength = sizeBuf.readUInt32LE(4);
  if (headerLength < 8 || headerBuf.length !== headerLength) {
    throw new Error(
      `asar 头部长度不一致:前缀声明 ${headerLength},实际读到 ${headerBuf.length}`,
    );
  }
  const payloadSize = headerBuf.readUInt32LE(0);
  const jsonLength = headerBuf.readUInt32LE(4);
  if (payloadSize !== headerLength - 4 || payloadSize !== 4 + align4(jsonLength)) {
    throw new Error(
      `asar 头部 pickle 自校验失败(payload=${payloadSize} 段长=${headerLength} JSON=${jsonLength});`
      + '归档格式与读取器预期不符,请人工确认产物版本',
    );
  }
  let header;
  try {
    header = JSON.parse(headerBuf.subarray(8, 8 + jsonLength).toString('utf8'));
  } catch (err) {
    throw new Error(`asar 头部 JSON 解析失败: ${err.message}`);
  }
  return { header, dataOffset: 8 + headerLength };
}

/** 在 asar 目录树里按 'a/b/c' 定位文件条目;路径不存在或指向目录时返回 null。 */
export function resolveAsarEntry(header, entryPath) {
  let node = header;
  for (const part of String(entryPath).split('/').filter(Boolean)) {
    const next = node?.files?.[part];
    if (!next) return null;
    node = next;
  }
  return node && typeof node.files === 'object' ? null : node;
}

/**
 * 从 asar 归档读出一个条目的内容。read(offset, length) 由调用方注入:生产是按需
 * 分段读文件,单测是内存 buffer——偏移解析、条目定位、越界拒绝全部走同一条代码
 * 路径,只有最外面那层 IO 适配不同。
 */
export function readAsarEntry(read, entryPath) {
  const sizeBuf = read(0, 8);
  if (sizeBuf.length < 8) {
    throw new Error(`asar 头部长度前缀不完整(读到 ${sizeBuf.length} 字节,需要 8)`);
  }
  const headerBuf = read(8, sizeBuf.readUInt32LE(4));
  const { header, dataOffset } = parseAsarHeader(sizeBuf, headerBuf);
  const entry = resolveAsarEntry(header, entryPath);
  if (!entry) {
    throw new Error(`asar 内没有 ${entryPath} 这个条目`);
  }
  if (entry.unpacked) {
    throw new Error(`asar 条目 ${entryPath} 被 unpack 到归档外(app.asar.unpacked/),无法按归档读取`);
  }
  const size = Number(entry.size);
  const offset = Number(entry.offset);
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`asar 条目 ${entryPath} 的 size/offset 非法: size=${entry.size} offset=${entry.offset}`);
  }
  return read(dataOffset + offset, size);
}

/** 只读「头部 + 目标条目」两段,不把整个 app.asar(数百 MB)读进内存。 */
export function readAsarEntryFromFile(asarPath, entryPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    return readAsarEntry((offset, length) => {
      const buf = Buffer.alloc(length);
      const got = fs.readSync(fd, buf, 0, length, offset);
      if (got !== length) {
        throw new Error(`asar 读取不完整(${asarPath}):offset=${offset} 需要 ${length} 字节,实读 ${got}`);
      }
      return buf;
    }, entryPath);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 产物级版本断言(纯判定):
 * - 版本化构建:产物内版本必须等于请求版本,且不得是 versionless 哨兵;
 * - versionless 构建:产物内版本必须是哨兵(0.0.0),这是预期而非异常。
 * 失败一律 throw,消息里给出「为什么严重、怎么查、怎么修」。
 * @param {{ packagedVersion: string, requestedVersion: string, versionless: boolean }} ctx
 */
export function assertPackagedAppVersion({ packagedVersion, requestedVersion, versionless }) {
  const actual = typeof packagedVersion === 'string' ? packagedVersion.trim() : '';
  if (!actual) {
    throw new Error(
      `打包产物内读不到版本号(asar 内 package.json 的 version 为空或非字符串:${JSON.stringify(packagedVersion)})`,
    );
  }
  const actualIsSentinel = isVersionlessSentinelVersion(actual);
  if (versionless) {
    if (!actualIsSentinel) {
      throw new Error(
        `本次是版本无关构建,产物内版本应为占位哨兵 ${VERSIONLESS_VERSION},实得 ${actual}。`
        + '版本无关包按设计不参与应用内热更,不该带着真实版本号流出去;'
        + '出现真实版本说明构建环境里残留了 APP_VERSION,或 package.json 被别的流程改写。'
        + '请清掉环境里的 APP_VERSION 重打,或显式传 --version x.y.z 打发布包。',
      );
    }
    return;
  }
  if (actualIsSentinel) {
    throw new Error(
      `打包产物内的版本是占位哨兵 ${actual},与请求版本 ${requestedVersion} 不符——`
      + '这个包会被 updateService 判定为版本无关(永久不参与应用内自动更新),'
      + '插件市场协议也会把它当未知版本无条件放行,绝不能发布。'
      + '注意 APP_VERSION 只由 package-desktop.mjs 注入(asar 内 package.json 的 version '
      + '来自 writePackageVersion 的临时改写);绕过本脚本直接 electron-forge make、'
      + '或仓外发布流水线自带打包逻辑时,会丢掉这层保护。'
      + `请改用 pnpm --filter desktop release:package -- --region <region> --version ${requestedVersion} 重新打包。`,
    );
  }
  if (actual !== requestedVersion) {
    throw new Error(
      `打包产物内版本与请求版本不一致:期望 ${requestedVersion},实得 ${actual}。`
      + 'CDN manifest 的 app.version 取自请求版本,而客户端启动后 app.getVersion() 看到的是'
      + '产物内版本,两者不一致会让热更版本比较错位(客户端永远认为自己是另一个版本)。'
      + '请确认打包机上没有残留的 APP_VERSION / 过期 package.json 改写后重新执行 package-desktop.mjs。',
    );
  }
}

/** 读出已打包产物内真实的 app.getVersion() 来源并断言。
 *  版本从 asar 内 package.json 的 version 读:这正是 packaged 下 app.getVersion()
 *  的取值来源,且三平台路径同构(win/linux resources/app.asar,mac
 *  Contents/Resources/app.asar)。不取 Info.plist CFBundleShortVersionString /
 *  PE FileVersion / deb control:它们会被各自格式归一(如 0.0.64.0)、分平台实现,
 *  且都不等于客户端启动后 app.getVersion() 看到的值。 */
function verifyPackagedAppVersion({ appName, platform, arch, version, versionless }) {
  const packagedDir = path.join(DESKTOP_ROOT, 'out', `${appName}-${platform}-${arch}`);
  const asarPath =
    platform === 'darwin'
      ? path.join(packagedDir, `${appName}.app`, 'Contents', 'Resources', 'app.asar')
      : path.join(packagedDir, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    throw new Error(`打包产物内找不到 app.asar(${asarPath}),无法核对产物版本`);
  }
  let packagedVersion;
  try {
    packagedVersion = JSON.parse(readAsarEntryFromFile(asarPath, 'package.json').toString('utf8')).version;
  } catch (err) {
    throw new Error(`读取打包产物版本失败(${asarPath} 内 package.json):${err.message}`);
  }
  assertPackagedAppVersion({ packagedVersion, requestedVersion: version, versionless });
  console.log(
    versionless
      ? `    verified packaged app version: ${packagedVersion}(版本无关,哨兵符合预期)`
      : `    verified packaged app version: ${packagedVersion}`,
  );
}

// ── CDN 基线(仅 --version major/minor/patch 时调用,只读)─────────────────────

async function fetchCdnBaselineVersion(platformKey, region) {
  // 打包不发布,env 里通常没有 CDN 配置——按 region 从 release-regions.json
  // 只注入 cdnBaseUrl(env 显式值优先),满足这次只读拉取即可。
  applyReleaseCdnBaseUrlToEnv(region);
  // mac 双架构 manifest 同版本,任一即可;win/linux 用各自 key。
  const manifest = await fetchExistingManifestIfAvailable(platformKey, region);
  if (!manifest) {
    throw new Error(`CDN 上没有 ${platformKey} 的 manifest,无法计算 bump 基线;请显式传 --version x.y.z`);
  }
  return manifest.app?.version ?? '';
}

// ── 通用步骤 ────────────────────────────────────────────────────────────────

function cleanOutDir() {
  const outDir = path.join(DESKTOP_ROOT, 'out');
  if (!fs.existsSync(outDir)) return;
  console.log('==> Cleaning previous build output...');
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`ERROR: Cannot remove ${outDir} — is ${PACKAGED_APP_NAME} still running or antivirus scanning it?`);
    console.error(err.message);
    process.exit(1);
  }
}

function runForgeMake({ platform, arch, region, version, versionless, noSign }) {
  console.log('==> Building remote bundles...');
  execSync('node scripts/build-remote-bundles.mjs', { cwd: DESKTOP_ROOT, stdio: 'inherit' });

  console.log(`==> Running electron-forge make (${platform}-${arch}, region=${region})...`);
  const clientBuildEnv = desktopClientBuildEnv({ allowEnvOverride: false, authRegion: region });
  const mekaReleaseCdnBaseUrl = process.env.XDT_CDN_BASE_URL?.trim().replace(/\/+$/, '');
  if (region === 'cn' && !versionless && !mekaReleaseCdnBaseUrl) {
    throw new Error(
      'XDT_CDN_BASE_URL is required for a versioned Meka release; '
      + 'refusing to bake the Cindy endpoint bootstrap into an upgrade',
    );
  }
  if (mekaReleaseCdnBaseUrl) {
    const validatedCdnBaseUrl = validateMekaReleaseCdnBaseUrl(mekaReleaseCdnBaseUrl);
    // 版本化 Meka 包必须能继续从原渠道取 endpoint.json 与后续 manifest。
    // 发布机显式提供旧渠道地址时，它优先于仓内 Cindy 清单基址。
    clientBuildEnv.VITE_ENDPOINT_MANIFEST_BASE_URL = validatedCdnBaseUrl;
  }
  const forgeEnv = {
    ...process.env,
    NODE_ENV: 'production',
    // 烘焙面只含 region + 端点清单自举基址,按 region 二选一。
    ...clientBuildEnv,
    // forge.config.ts 的 NSIS appId / AUMID 优先读这个(与 VITE_ 同源,双保险)。
    CINDY_AUTH_REGION: region,
    // forge.config.ts 注入 packagerConfig.appVersion;版本无关时为占位 0.0.0。
    APP_VERSION: version,
  };
  // Git Bash(agent 常用 shell)会导出 NoDefaultCurrentDirectoryInExePath=1,
  // 使 cmd.exe 不再搜索当前目录——node-pty rebuild 时 winpty.gyp 的
  // `cmd /c "cd shared && GetCommitHash.bat"` 会直接 not recognized 挂掉。
  // 人类在 cmd/PowerShell 跑没有这个变量;这里对构建子进程摘掉它,
  // 把 agent shell 归一到人类 shell 的行为(仅作用于 forge make 子进程)。
  for (const key of Object.keys(forgeEnv)) {
    if (key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete forgeEnv[key];
  }
  // --no-sign: remove both supported signing entry points so forge skips all
  // packaged exe, installer and uninstaller signing.
  if (noSign) {
    delete forgeEnv.CINDY_WIN_SIGN_CMD;
    delete forgeEnv.NPKG_TOKEN;
  }
  execSync(`npx electron-forge make --platform ${platform} --arch ${arch}`, {
    cwd: DESKTOP_ROOT,
    stdio: 'inherit',
    env: forgeEnv,
  });
}

/** PowerShell 单引号字面量转义:内嵌 ' 双写,防路径含单引号时命令截断。 */
function psq(value) {
  return String(value).replaceAll("'", "''");
}

/** 物理 ARM64 mac 检测(即使当前进程跑在 Rosetta 下也返回 true;Intel 无该 oid)。 */
function isPhysicalArm64Mac() {
  try {
    return execSync('sysctl -in hw.optional.arm64', { encoding: 'utf8' }).trim() === '1';
  } catch {
    return false;
  }
}

/** 跳过 smoke 启动前,用 lipo 确认 packaged 主二进制确实是目标架构。 */
function verifyMacBinaryArch(appName, arch) {
  const exePath = path.join(
    DESKTOP_ROOT, 'out', `${appName}-darwin-${arch}`, `${appName}.app`, 'Contents', 'MacOS', appName,
  );
  const archInfo = execFileSync('lipo', ['-archs', exePath], { encoding: 'utf8' }).trim();
  const want = arch === 'arm64' ? 'arm64' : 'x86_64';
  if (!archInfo.includes(want)) {
    console.error(`ERROR: expected ${want} binary but lipo reports "${archInfo}" (${exePath})`);
    process.exit(1);
  }
}

function fileEntry(role, filePath) {
  return {
    role,
    name: path.basename(filePath),
    sha256: sha256(filePath),
    size: fs.statSync(filePath).size,
  };
}

// ── 平台收尾:签名 + 产物归集,返回 files/signing 供 build-info ────────────────

function findSetupExe(makeBaseDir) {
  // 只认文件名含 setup 的 .exe(NSIS 产物目录里可能还有其它 exe)。
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry.name.endsWith('.exe') && entry.name.toLowerCase().includes('setup')) {
        return full;
      }
    }
    return null;
  }
  return walk(makeBaseDir);
}

async function finishWindows({ artifactDir, baseName, appName, versionless, allowUnsigned, noSign }) {
  const makeBaseDir = path.join(DESKTOP_ROOT, 'out', 'make');
  const packagedDir = path.join(DESKTOP_ROOT, 'out', `${appName}-win32-x64`);
  const setupExe = findSetupExe(makeBaseDir);
  if (!setupExe) {
    console.error(`ERROR: No Setup.exe found under ${makeBaseDir}`);
    process.exit(1);
  }

  // 签名已全部在 forge make 阶段完成,这里不再后置补签:
  //   - 包内 exe(Cindy/cindy-updater/loudness/node-pty/adb/rg)由
  //     forge.config.ts 的 postPackage signPackagedExes 签;
  //   - 安装器 Setup.exe + 卸载器 Uninstall <App>.exe 由 NSIS maker 的
  //     win.sign(customSign)签(Issue #998)。
  // 两处都经 forge.config.ts 的 CINDY_WIN_SIGN_CMD 可插拔外部签名命令(发布方
  // 在构建环境注入,仓库不绑定任何签名实现)。
  // 门禁在拷贝进 release/artifacts 之前跑:失败时产物目录不留「看起来能用」
  // 的未签名 Setup.exe。校验对象是 make 产出的源文件。
  const hasWindowsSigning = noSign
    ? false
    : Boolean(process.env.CINDY_WIN_SIGN_CMD?.trim() || process.env.NPKG_TOKEN?.trim());
  let installerSigned = false;
  if (noSign) {
    console.log('==> --no-sign: installer / uninstaller / internal exes are UNSIGNED');
  } else if (hasWindowsSigning) {
    // make 阶段用同一签名命令已签全部 exe + installer + uninstaller;签名命令
    // 失败会让 make 直接挂掉(forge fail closed)。这里再验一道「产物确实带
    // Authenticode 签名块」,防外部命令被误配成 no-op(退出 0 但没签)时
    // build-info 记下假阳性签名状态。只验签名存在,不验证书链——构建机不一定
    // 信任发布证书,按 Valid 判定会误伤。
    // 坏状态清单:NotSigned(没签)与 HashMismatch(签名后文件被改/签名损坏)
    // 一票否决;UnknownError / NotTrusted 属「构建机不信任证书链」的正常状态,
    // 放行——这正是不按 Valid 判定的原因。
    const badSigStatuses = ['NotSigned', 'HashMismatch'];
    // execFileSync 数组传参:不经 cmd.exe,路径里的 % ^ & 等元字符不会被外层
    // shell 展开;psq 只需管 PowerShell 单引号字面量这一层。
    const sigStatus = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-AuthenticodeSignature '${psq(setupExe)}').Status`],
      { encoding: 'utf8' },
    ).trim();
    if (badSigStatuses.includes(sigStatus)) {
      console.error(`ERROR: Windows 签名已配置且 make 成功,但 Setup.exe 签名状态为 ${sigStatus}。`);
      console.error('       签名命令疑似 no-op 或签名后文件被改动,请检查 CINDY_WIN_SIGN_CMD / NPKG_TOKEN 与构建流程。');
      process.exit(1);
    }
    // 再全量扫一遍 packaged 目录:internalExesSigned 不能只凭签名命令在手就记
    // true——forge 的固定清单/递归范围若漏了某个包内 exe(热更 ZIP 正是从这个
    // 目录打的),这里兜底抓出来 fail closed,漏签 exe 在严格策略机器上会被拦。
    const badExes = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-ChildItem -Path '${psq(packagedDir)}' -Recurse -Filter *.exe | Get-AuthenticodeSignature | Where-Object { $_.Status -eq 'NotSigned' -or $_.Status -eq 'HashMismatch' } | ForEach-Object { $_.Status.ToString() + ' ' + $_.Path }`,
      ],
      { encoding: 'utf8' },
    ).trim();
    if (badExes) {
      console.error('ERROR: packaged 目录内以下 exe 签名不可用(未签 / 签名后被改动;forge 签名清单可能有遗漏):');
      console.error(badExes);
      process.exit(1);
    }
    installerSigned = true;
  } else if (!versionless && !allowUnsigned) {
    console.error('ERROR: 有版本的 Windows 打包要求 CINDY_WIN_SIGN_CMD 或 NPKG_TOKEN(安装包 / 卸载器 / 内部 exe 均在 forge make 阶段签名)。');
    console.error('       缺签名的包在严格策略 Windows 机器上热更/启动/卸载会被拦。');
    console.error('       确要产出未签名包时加 --allow-unsigned。');
    process.exit(1);
  } else {
    console.log('==> Windows signing not configured — installer / uninstaller / internal exes are UNSIGNED');
  }

  const installerPath = path.join(artifactDir, `${baseName}-Setup.exe`);
  fs.copyFileSync(setupExe, installerPath);

  const files = [fileEntry('installer', installerPath)];

  // 热更 ZIP 只对有版本的包有意义(版本无关包不参与热更新)。
  if (!versionless) {
    const hotfixZipPath = path.join(artifactDir, `${baseName}.zip`);
    console.log('==> Creating hotfix ZIP from packaged app...');
    if (fs.existsSync(hotfixZipPath)) fs.unlinkSync(hotfixZipPath);
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${psq(packagedDir)}\\*' -DestinationPath '${psq(hotfixZipPath)}'`,
      ],
      { stdio: 'inherit' },
    );
    files.push(fileEntry('hotfix', hotfixZipPath));
  }

  return { files, signing: { installerSigned, internalExesSigned: hasWindowsSigning } };
}

async function finishDarwin({ artifactDir, baseName, appName, arch, versionless, allowUnsigned, noSign }) {
  const packagedDir = path.join(DESKTOP_ROOT, 'out', `${appName}-darwin-${arch}`);
  const appPath = path.join(packagedDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) {
    console.error(`ERROR: ${appPath} not found`);
    process.exit(1);
  }

  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const helperEntitlementsPath = path.join(RELEASE_DIR, 'build-helper.entitlements');
  const mainEntitlementsPath = path.join(RELEASE_DIR, 'build-main.entitlements');
  writeMacEntitlements(helperEntitlementsPath);
  writeMacEntitlements(mainEntitlementsPath, { appleEvents: true });

  const wantsRealSigning = !versionless && !noSign;
  const requireNativeReleaseGate = process.env.CINDY_IOS_SIMULATOR_RELEASE_NATIVE_SMOKE === '1';
  const requestedSigningMode = process.env.MAC_SIGNING_MODE?.trim() || 'developer-id';
  if (!['developer-id', 'self-signed', 'adhoc'].includes(requestedSigningMode)) {
    throw new Error('MAC_SIGNING_MODE must be developer-id, self-signed, or adhoc');
  }
  const applePassword = noSign ? undefined : process.env.APPLE_APP_PASSWORD;
  const signIdentity = noSign ? undefined : process.env.APPLE_SIGN_IDENTITY?.trim();
  let signingMode = 'adhoc';

  if (wantsRealSigning && requestedSigningMode === 'self-signed' && !signIdentity && !allowUnsigned) {
    throw new Error(
      'MAC_SIGNING_MODE=self-signed requires APPLE_SIGN_IDENTITY '
      + '(the existing Meka certificate name in the macOS keychain)',
    );
  }
  if (
    wantsRealSigning
    && requestedSigningMode === 'developer-id'
    && (!applePassword || !signIdentity)
    && !allowUnsigned
  ) {
    throw new Error(
      'Developer ID macOS packaging requires APPLE_SIGN_IDENTITY and APPLE_APP_PASSWORD',
    );
  }
  if (wantsRealSigning && requestedSigningMode === 'adhoc' && !allowUnsigned) {
    throw new Error(
      'Versioned macOS packaging cannot use ad-hoc signing unless --allow-unsigned is explicit',
    );
  }

  const files = [];
  const canSelfSign = wantsRealSigning && requestedSigningMode === 'self-signed' && signIdentity;
  const canDeveloperSign =
    wantsRealSigning && requestedSigningMode === 'developer-id' && signIdentity && applePassword;
  if (canSelfSign || canDeveloperSign) {
    const identity = canSelfSign
      ? { signIdentity, timestamp: false }
      : { ...resolveAppleIdentity(), applePassword, timestamp: true };
    console.log(
      canSelfSign
        ? '==> Signing (existing Meka self-signed identity)...'
        : '==> Signing (Developer ID)...',
    );
    const iosSimulatorHelperSigned = signMacAppWithIdentity(
      appPath,
      helperEntitlementsPath,
      mainEntitlementsPath,
      identity,
      { arch },
    );
    if (requireNativeReleaseGate && !iosSimulatorHelperSigned) {
      throw new Error(
        'CINDY_IOS_SIMULATOR_RELEASE_NATIVE_SMOKE=1 requires a packaged Native Helper',
      );
    }
    if (canDeveloperSign) {
      console.log('==> Notarizing...');
      notarizeMacApp(appPath, identity);
      signingMode = 'developer-id+notarized';
    } else {
      signingMode = 'self-signed';
    }

    if (hostCanExecArch(arch, isPhysicalArm64Mac())) {
      runIOSSimulatorReleaseGate(
        appPath,
        arch,
        canDeveloperSign
          ? (iosSimulatorHelperSigned ? 'verified' : 'untrusted')
          : 'untrusted',
        requireNativeReleaseGate,
      );
    } else if (requireNativeReleaseGate) {
      throw new Error(
        `CINDY_IOS_SIMULATOR_RELEASE_NATIVE_SMOKE=1 requires a host that can natively run the ${arch} package`,
      );
    } else {
      verifyMacBinaryArch(appName, arch);
      console.log(
        `==> Skipping iOS Simulator release gate: ${arch} app is not runnable on this ${
          isPhysicalArm64Mac() ? 'arm64' : 'Intel'
        } host (Mach-O arch verified)`,
      );
    }

    const dmgPath = path.join(artifactDir, `${baseName}-${arch}.dmg`);
    console.log('==> Creating DMG...');
    // DMG 卷名 = 安装窗口标题,走 '<appName> Installer'(cn/global
    // 'Cindy Installer' / dev 'CindyDev Installer');版本号不进卷名,
    // 安装包文件名里已有。
    createMacDMG(appPath, dmgPath, `${appName} Installer`, identity);
    files.push(fileEntry('installer', dmgPath));

    const hotfixZipPath = path.join(artifactDir, `${baseName}-${arch}.zip`);
    console.log('==> Creating hotfix ZIP...');
    if (fs.existsSync(hotfixZipPath)) fs.unlinkSync(hotfixZipPath);
    exec(`/usr/bin/ditto -c -k "${packagedDir}" "${hotfixZipPath}"`);
    files.push(fileEntry('hotfix', hotfixZipPath));
  } else {
    // 版本无关(或显式放行)→ ad-hoc 签名,产出 .app 的 zip 供本机/内部试用。
    adhocSignMacApp(appPath, helperEntitlementsPath, mainEntitlementsPath, arch);
    if (requireNativeReleaseGate) {
      throw new Error(
        'CINDY_IOS_SIMULATOR_RELEASE_NATIVE_SMOKE=1 requires a Developer ID signed and notarized package',
      );
    }
    if (hostCanExecArch(arch, isPhysicalArm64Mac())) {
      runIOSSimulatorReleaseGate(appPath, arch, 'untrusted');
    } else {
      verifyMacBinaryArch(appName, arch);
      console.log(
        `==> Skipping iOS Simulator release gate: ${arch} app is not runnable on this ${
          isPhysicalArm64Mac() ? 'arm64' : 'Intel'
        } host (Mach-O arch verified)`,
      );
    }
    const appZipPath = path.join(artifactDir, `${baseName}-${arch}.zip`);
    console.log('==> Creating app ZIP (ad-hoc signed)...');
    if (fs.existsSync(appZipPath)) fs.unlinkSync(appZipPath);
    exec(`/usr/bin/ditto -c -k --keepParent "${appPath}" "${appZipPath}"`);
    files.push(fileEntry('installer', appZipPath));
  }

  return { files, signing: { mode: signingMode } };
}

async function finishLinux({ artifactDir, baseName, arch }) {
  const makeBaseDir = path.join(DESKTOP_ROOT, 'out', 'make');
  const debPath = findInstallerArtifact(makeBaseDir, 'deb');
  if (!debPath) {
    console.error(`ERROR: No .deb found under ${makeBaseDir}`);
    process.exit(1);
  }
  // 架构后缀跟随 deb 命名规范(x64 → amd64,arm64 → arm64),与 MakerDeb 写出的
  // 包一致:归集时写死 amd64 会让 arm64 产物顶着 amd64 的名字发出去。
  const installerPath = path.join(artifactDir, `${baseName}-${debianArch(arch)}.deb`);
  fs.copyFileSync(debPath, installerPath);
  // One verified payload: Debian uses pkexec; managed user installs on Arch /
  // Omarchy extract it without elevation and atomically switch releases.
  return { files: [fileEntry('installer', installerPath)], signing: { mode: 'none' } };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // 打包本身不发布；只读通用构建 env，不要求 OSS 发布四件套。
  loadDotenv(undefined, { refreshReleaseConfig: false });
  let args;
  try {
    args = parsePackageArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
  const { platform, archs, region, versionSpec, skipSmoke, allowUnsigned, noSign } = args;
  // ensureBinary 的 CDN fallback 按此 region 选择清单基址；必须早于二进制准备。
  process.env.CINDY_AUTH_REGION = region;
  // mac 签名身份按区域从 release-regions.json 注入(文件缺失时静默跳过,
  // 届时签名要求身份齐备,由 resolveAppleIdentity fail closed)。只在 darwin
  // 且未显式跳签时加载:appPasswordEnv 声明即承诺(指向空 env 会抛错),
  // 不该拦住 win/linux 或 --no-sign 的打包。
  if (platform === 'darwin' && !noSign) applyMacSigningConfigToEnv(region);

  if (platform !== process.platform) {
    console.error(`ERROR: 不支持交叉打包(当前 ${process.platform},目标 ${platform});请在目标平台机器上执行。`);
    process.exit(1);
  }

  // 版本号只解析一次,mac 双架构共用(canary 发布要求两 arch 同版本)。
  const { version, versionless } = await resolvePackageVersion(versionSpec, () =>
    fetchCdnBaselineVersion(platform === 'darwin' ? 'darwin-arm64' : `${platform}-${archs[0]}`, region),
  );

  console.log('='.repeat(60));
  console.log(`==> Package Cindy desktop`);
  console.log(`    platform: ${archs.map((a) => `${platform}-${a}`).join(' + ')}`);
  console.log(`    region:   ${region}`);
  console.log(`    version:  ${versionless ? `(版本无关,占位 ${version},不参与热更新)` : version}`);
  console.log('='.repeat(60));

  // Linux 只校验 sqlite-vec 等原生运行资产。Claude/Codex/Pi 各平台都不进安装包
  // (forge extraResource 不含它们),由 packaged runtime 首启时复用系统 CLI 或
  // 从 CDN 安装到 userData(仅 Linux 的 Claude/Codex 另有系统 CLI / 官方下载
  // fallback),打包阶段无需预下载。ripgrep 是唯一进包的
  // agent 二进制,这里按 pin 预 ensure(缓存命中即跳过),在昂贵的 forge make
  // 之前尽早失败;forge prePackage 的 stageRipgrep 仍会兜底校验。
  if (platform === 'linux') {
    // 必须按目标 arch 校验:vec0.so 是 per-arch 的预编译件,缺省的 linux-x64
    // 在 aarch64 机器上通常还是未 pull 的 LFS 指针,校验错了目标既漏检真正要
    // 进包的那份,又会拿另一个架构的缺失把打包拦死。
    for (const platformKey of archs.map((a) => `${platform}-${a}`)) {
      await ensureLinuxRuntimeAssets({ platformKey });
    }
    logLinuxPackagingRequirements();
  } else {
    for (const platformKey of archs.map((a) => `${platform}-${a}`)) {
      await ensureBinary('ripgrep', platformKey);
    }
  }

  runDbValidate();

  // 版本号临时写入 package.json(asar 内 app.getVersion() 的来源),退出自动恢复。
  writePackageVersion(version);

  // 产物基名按区域派生(cn/global 'Cindy' / dev 'CindyDev',out 目录 / exe /
  // .app 同名;forge.config 的 packagerConfig.name 同源)。
  const appName = packagedAppName(region);
  const baseName = artifactBaseName({ version, versionless });
  const finishers = { win32: finishWindows, darwin: finishDarwin, linux: finishLinux };
  const meta = collectBuildMeta();
  const results = [];

  // 逐 arch 完整走「make → 校验 → smoke → 归集 → build-info」;mac 缺省会连打
  // arm64 + x64(cleanOutDir 每轮清 out/,上一轮产物已归集进 release/artifacts)。
  for (const arch of archs) {
    const platformKey = `${platform}-${arch}`;

    // 本轮目标产物目录构建前先清:构建失败时不能给同一路径留上一轮的旧
    // build-info.json / 安装包(看起来像可发布结果,易被人工分发或发布侧误取)。
    const artifactDir = path.join(
      RELEASE_DIR,
      ...artifactRelDir({ region, version, versionless, platformKey }).split('/'),
    );
    fs.rmSync(artifactDir, { recursive: true, force: true });

    cleanOutDir();
    runForgeMake({ platform, arch, region, version, versionless, noSign });

    verifyPackagedSourceMetadata({
      appName,
      platform,
      arch,
      expectedCommit: meta.commitSha,
    });

    // 产物级版本断言:必须在 make 之后、任何归集/发布动作之前——占位版本要在
    // 「产物已经产出」这一刻被拦下,而不是等发布侧读 build-info.json(那份文件
    // 只复述本脚本自己写进去的版本,拦不住绕过本脚本的打包路径)。
    verifyPackagedAppVersion({ appName, platform, arch, version, versionless });

    // drizzle 资源校验(平台差异只在 packaged 内路径)。
    const drizzleOut =
      platform === 'darwin'
        ? path.join(DESKTOP_ROOT, 'out', `${appName}-darwin-${arch}`, `${appName}.app`, 'Contents', 'Resources', 'drizzle')
        : path.join(DESKTOP_ROOT, 'out', `${appName}-${platformKey}`, 'resources', 'drizzle');
    verifyPackagedDrizzle(drizzleOut);

    if (skipSmoke) {
      console.log('==> Skipping packaged smoke test (--skip-smoke)');
    } else if (platform === 'darwin' && arch === 'arm64' && !isPhysicalArm64Mac()) {
      // Intel mac 缺省双架构连打时,arm64 产物在 x64 硬件上起不来(smoke 脚本只
      // 处理了「arm64 宿主打 x64 包」的镜像场景)。lipo 验完二进制架构即跳过启动。
      verifyMacBinaryArch(appName, arch);
      console.log('==> Skipping smoke: arm64 artifact not runnable on Intel host (binary arch verified)');
    } else {
      runSmokeTest(platform, arch, region);
    }

    // 产物目录(本轮开始前已清空)
    fs.mkdirSync(artifactDir, { recursive: true });

    // 归集途中(如 DMG/hotfix ZIP 制作)失败时清掉本轮产物目录:安装器已拷入
    // 而 build-info.json 未写的半成品目录看起来像可发布结果,不能留。
    let files, signing, buildInfoPath;
    try {
      ({ files, signing } = await finishers[platform]({
        artifactDir,
        baseName,
        appName,
        arch,
        version,
        versionless,
        allowUnsigned,
        noSign,
      }));

      const buildInfo = buildBuildInfo({
        version,
        versionless,
        region,
        platform,
        arch,
        commitSha: meta.commitSha,
        electronVersion: meta.electronVersion,
        schemaVersionMax: meta.schemaVersionMax,
        migrationFiles: meta.migrationFiles,
        files,
        signing,
      });
      buildInfoPath = path.join(artifactDir, 'build-info.json');
      fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2) + '\n');
    } catch (err) {
      fs.rmSync(artifactDir, { recursive: true, force: true });
      throw err;
    }

    results.push({ platformKey, artifactDir, files, buildInfoPath });
  }

  console.log('');
  console.log('=== Package complete ===');
  for (const r of results) {
    console.log(`Artifacts:  ${r.artifactDir}`);
    for (const f of r.files) {
      console.log(`  [${f.role}] ${f.name}  ${(f.size / 1024 / 1024).toFixed(1)} MB  sha256=${f.sha256.slice(0, 12)}…`);
    }
    console.log(`Build info: ${r.buildInfoPath}`);
  }
  if (versionless) {
    console.log('注意: 版本无关包(0.0.0)不参与热更新,仅供本地/社区使用,不能作为发布产物。');
  }
}

// 本文件是「import 即执行打包」的入口脚本,但 scripts/__tests__ 的单测要 import
// 它来覆盖上面的纯函数(parseAsarHeader / readAsarEntry / assertPackagedAppVersion)。
// 只在「本文件被测试加载」时跳过 main():
//   - NODE_TEST_CONTEXT:node --test 在测试子进程里注入;
//   - VITEST:vitest 注入;
//   - 入口 argv 指向测试文件(有人直接 node 跑测试文件时的兜底)。
// 注意判据方向:这里判的是「是否处于测试」,不是「是否被直接执行」——反向的
// argv 路径比较一旦失手(大小写 / 软链 / 包装器),打包会静默跳过 main,代价远大于
// 这里偶发多跑一次 main。
const underTestRunner =
  Boolean(process.env.NODE_TEST_CONTEXT || process.env.VITEST)
  || /(?:^|[\\/])__tests__[\\/]|\.test\.[cm]?js$/.test(process.argv[1] ?? '');

if (!underTestRunner) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
