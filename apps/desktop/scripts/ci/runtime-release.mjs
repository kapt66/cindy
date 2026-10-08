import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gzipFile } from '../../../../scripts/shared/oss.mjs';
import { CODEX_PACKAGE_PLATFORMS } from '../../../../tools/codex-package/update.mjs';
import {
  PI_RUNTIME_PLATFORMS,
  ensurePiThemeAssets,
  extractArchive,
  flattenExtractedDir,
} from '../../../../tools/pi/update.mjs';
import { createDeterministicTarGz } from '../../../../tools/shared/dir-dist-archive.mjs';
import {
  createDownloadProgressLogger,
  downloadToFileWithTimeout,
} from '../../../../tools/shared/fetch-with-timeout.mjs';
import { pinnedAssetDescriptor } from '../../../../tools/shared/github-release-pin.mjs';
import { normalizeExpectedSha256, verifyFileSha256OrRemove } from '../../../../tools/shared/verify-sha256.mjs';
import { sha256File } from './release-lib.mjs';

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const RUNTIME_DEFINITIONS = Object.freeze([
  Object.freeze({
    field: 'claudeCode',
    objectRoot: 'claude-code',
    sourceDir: 'claude-code-bin',
    binaryBaseName: 'claude',
  }),
  Object.freeze({
    field: 'codex',
    objectRoot: 'codex',
    sourceDir: 'codex-bin',
    binaryBaseName: 'codex',
  }),
  Object.freeze({
    field: 'ripgrep',
    objectRoot: 'ripgrep',
    sourceDir: 'ripgrep-bin',
    binaryBaseName: 'rg',
  }),
]);

export const AGENT_RUNTIME_DEFINITIONS = Object.freeze(
  RUNTIME_DEFINITIONS.filter(({ field }) => field === 'claudeCode' || field === 'codex'),
);

/**
 * 桌面端**启动时真正消费**的 vendor runtime 定义——目录分发形态（`tar-gz-dir`）。
 *
 * 事实（2026-09-16 Windows canary 0.0.21「环境初始化失败」的根因）：上游
 * `b43ee771ad`（2026-09-03）把生产侧 codex 从**单文件**换成**目录分发**后，桌面端
 * `agent-binaries` 的 `CONFIG.codex` 变成 `manifestField: 'codexPackage'` +
 * `artifactKind: 'tar-gz-dir'`（`apps/desktop/src/main/agent-binaries/index.ts`）。
 * 缺这个字段时 `prepare('codex')` 直接返回 `asset_missing`，`check-environment`
 * `allPassed=false`，splash 进入「环境初始化失败」——而且 asset 查找先于本地回退，
 * 本机既有旧单文件 codex 也救不回来。
 *
 * 因此应用 manifest 必须**同时**带：
 *   - `codex`（单文件 gz，`RUNTIME_DEFINITIONS`）：MCPRouter 的 linux runtime manifest
 *     与 ≤0.0.20 客户端仍读它（老客户端读不到会在热更到新版之前就先卡死在启动页）；
 *   - `codexPackage`（整目录 tar.gz，本定义）：≥0.0.21 桌面端启动所需的目录分发 runtime。
 *
 * 落点对象直接复用 pin 记录的**上游官方包**（`tools/codex-package/latest.json` 的
 * `runtimeAssets.<platformKey>`：直链 + sha256 + 字节数）：字节可复现、sha256 与 pin
 * 同源，不依赖发版机本地 `apps/codex-package-bin` 的落位状态，也不会因为「本机重新
 * 打包一次 → 字节不同」在同一个不可覆盖对象上撞车。
 */
export const CODEX_PACKAGE_DIR_DIST_DEFINITION = Object.freeze({
  field: 'codexPackage',
  objectRoot: 'codex-package',
  archiveName: 'codex-package.tar.gz',
  // 规范平台表（安装侧维护，发布侧只读复用）：target/entrypoint 的交叉校验真值。
  canonicalPlatforms: CODEX_PACKAGE_PLATFORMS,
  pinFile: ['tools', 'codex-package', 'latest.json'],
  pinLabel: 'codex-package',
});

/**
 * pi 的目录分发 runtime（`agent-binaries` 的 `CONFIG.pi`：`manifestField: 'pi'` +
 * `tar-gz-dir` + `optionalAsset`）。
 *
 * 背景（0.0.21 / 0.0.22 packaged 包「模型只有零星几个可用」）：Pi agent 的 runtime
 * 只能从 CDN manifest 的 `pi` 段获取——安装包不内置 `resources/pi`，客户端也没有
 * 其它回退（`resolvePiBinaryPath` 只认受管安装版），而本仓发布链路从来没发过这个段。
 * 于是每次 `prepare('pi')` 都是 `asset_missing` → `pi agent disabled for this launch`
 * → `get-capabilities` 只报 claude-code / codex。XD 网关这类供应商的多数模型只在 `pi`
 * 路由上默认开启（其它 agent 上与模型原生协议不兼容，`defaultEnabled=false`），因此
 * packaged 用户看到的模型列表被砍到零星几个，而开发机因为有 `apps/pi-bin/<platform>/`
 * 本地短路（`ensure-dev-runtime-assets.mjs`）一切正常。
 *
 * 与 codexPackage 的两点差异：
 *   - pin（`tools/pi/latest.json`）只有 url / sha256 / size，没有 target / entrypoint，
 *     因此不做那套 pin 元数据交叉校验，平台映射复用安装侧规范表
 *     `PI_RUNTIME_PLATFORMS`（`tools/pi/update.mjs`）。
 *   - 发布物**不能原样转发上游归档**：上游 win32 是 `.zip`、unix 是带 `pi/` 壳目录的
 *     `.tar.gz`，而且上游归档不含 `theme/`（缺它 Pi 的 RPC 模式启动即崩）。所以本定义
 *     走 `repack`：解包 → 归一布局 → 补本仓主题 → **确定性** tar.gz
 *     （`dir-dist-archive.mjs`：重跑必须得到同一份字节，否则版本化对象会撞上
 *     「同路径内容不同，拒绝覆盖」）。
 *
 * pin 的 sha256 仍然是硬门禁：下载的**上游归档**先按 pin 逐字节校验，再转换；发布后把
 * pin 的摘要作为 `pinned-sha256` 元数据留在对象上，重跑据此证明「在线对象确实由当前 pin
 * 的字节重打包而来」，而不是只看版本号。
 */
export const PI_DIR_DIST_DEFINITION = Object.freeze({
  field: 'pi',
  objectRoot: 'pi',
  archiveName: 'pi.dist.tar.gz',
  pinFile: ['tools', 'pi', 'latest.json'],
  pinLabel: 'pi',
  // 安装侧规范平台表（key / 上游资产名 / 主执行文件名）：发布侧只读复用，不另造映射。
  platforms: PI_RUNTIME_PLATFORMS,
  repack: 'pinned-archive',
  /** 解包后补齐上游归档缺的 `theme/`（与安装侧同一条实现，否则 Pi RPC 模式启动即崩）。 */
  afterExtract(extractDir) {
    ensurePiThemeAssets(extractDir);
  },
});

export const DIR_DIST_RUNTIME_DEFINITIONS = Object.freeze([
  CODEX_PACKAGE_DIR_DIST_DEFINITION,
  PI_DIR_DIST_DEFINITION,
]);

/** 应用 canary/stable manifest 必须齐全的 runtime 段（单文件三个 + 目录分发两段）。 */
export const RELEASE_RUNTIME_DEFINITIONS = Object.freeze([
  ...RUNTIME_DEFINITIONS,
  ...DIR_DIST_RUNTIME_DEFINITIONS,
]);

const PLATFORM_KEY_RE = /^(?:win32|darwin|linux)-(?:x64|arm64)$/;

function runtimeBinaryName(platformKey, baseName) {
  return platformKey.startsWith('win32-') ? `${baseName}.exe` : baseName;
}

export function collectLocalRuntimeAssets(
  platformKey,
  { projectRoot = PROJECT_ROOT, definitions = RUNTIME_DEFINITIONS } = {},
) {
  return Object.fromEntries(
    definitions.map((definition) => {
      const sourceRoot = path.join(projectRoot, 'apps', definition.sourceDir, platformKey);
      const versionFile = path.join(sourceRoot, '.version');
      if (!fs.existsSync(versionFile)) {
        // 不吞错也不抛裸 ENOENT：点名是哪个 runtime、缺哪个路径、用哪条命令补齐
        // （2026-09-16 canary 就是在这里以一个无上下文的 ENOENT 失败的）。
        throw new Error(
          `${definition.field} 本地 runtime 未就位：缺少 ${versionFile}。` +
            `发布物里的 runtime 是单文件形态，需先执行 ` +
            `"node scripts/ensure-agent-binaries.mjs --kinds=claude,codex-single,ripgrep --platform=${platformKey}"。`,
        );
      }
      const version = fs.readFileSync(versionFile, 'utf8').trim();
      if (!VERSION_RE.test(version)) {
        throw new Error(`${definition.field} 本地版本非法: ${version || '<empty>'}`);
      }
      const binaryName = runtimeBinaryName(platformKey, definition.binaryBaseName);
      const binaryPath = path.join(sourceRoot, binaryName);
      const stat = fs.statSync(binaryPath);
      if (!stat.isFile() || stat.size <= 1024) {
        throw new Error(`${definition.field} 本地二进制缺失或无效: ${binaryPath}`);
      }
      const binarySha256 = sha256File(binaryPath);
      const file = `${definition.objectRoot}/${version}/${platformKey}/${binaryName}.gz`;
      return [
        definition.field,
        Object.freeze({
          ...definition,
          version,
          platformKey,
          binaryName,
          binaryPath,
          binarySha256,
          file,
        }),
      ];
    }),
  );
}

function validRuntimeManifestAsset(asset, platformKey) {
  return (
    asset &&
    typeof asset === 'object' &&
    VERSION_RE.test(asset.version) &&
    typeof asset.file === 'string' &&
    asset.file.includes(`/${platformKey}/`) &&
    !asset.file.includes('..') &&
    SHA256_RE.test(asset.sha256) &&
    Number.isSafeInteger(asset.size) &&
    asset.size > 0 &&
    (asset.binarySha256 === undefined || SHA256_RE.test(asset.binarySha256))
  );
}

export function assertRuntimeManifestAssets(
  manifest,
  platformKey,
  { required = true, allowMissing = [], definitions = RUNTIME_DEFINITIONS } = {},
) {
  for (const definition of definitions) {
    const asset = manifest?.[definition.field];
    if (!asset && (!required || allowMissing.includes(definition.field))) continue;
    if (!validRuntimeManifestAsset(asset, platformKey)) {
      throw new Error(`manifest 缺少或包含非法的 ${definition.field} ${platformKey} 运行时资产`);
    }
  }
  return manifest;
}

export function runtimeManifestKey(platformKey) {
  if (!PLATFORM_KEY_RE.test(platformKey)) {
    throw new Error(`非法 runtime platformKey=${platformKey}`);
  }
  return `runtime-manifest-${platformKey}.json`;
}

/**
 * 目录分发段在 manifest 里的形状（与 `dirDistManifestAsset` 逐字段同形）。
 *
 * 只取 `version` / `file` / `sha256` / `size` 四个字段：`collectPinnedDirDistAssets` 的条目
 * 还带 `url` / `platformKey` / `upstreamAssetName` 等**发布侧**字段（pin 直链、规范表条目、
 * 主执行文件名），它们绝不能漏进 manifest —— 消费端（客户端 `getVendorAsset` / MCPRouter 的
 * `agentBinaryCache`）只认这四个，多写字段等于在 wire 上发明新契约。
 */
function dirDistManifestSection(asset) {
  return {
    version: asset.version,
    file: asset.file,
    sha256: asset.sha256,
    size: asset.size,
  };
}

/** 从发布产物里挑出**存在**的目录分发段；缺失的段直接不写（消费端把缺失视为合法）。 */
function dirDistManifestSections(dirDistAssets) {
  if (!dirDistAssets) return {};
  return Object.fromEntries(
    DIR_DIST_RUNTIME_DEFINITIONS.filter(
      (definition) => dirDistAssets[definition.field],
    ).map((definition) => [
      definition.field,
      dirDistManifestSection(dirDistAssets[definition.field]),
    ]),
  );
}

/**
 * 组装 agent runtime manifest（`runtime-manifest-<platformKey>.json`）。
 *
 * `dirDistAssets` 是 `publishDirDistAssets` 的 `manifestAssets`，**可选**：不传时 manifest
 * 形状与老契约逐字一致（`schemaVersion` / `platformKey` / `claudeCode` / `codex`，加上可选的
 * `ccMgr`）——老客户端与老镜像仍在读 `claudeCode` 与单文件 `codex`，这一段行为一个字都不能变。
 *
 * `codexPackage` / `pi` 是 2026-10-08 为 MCPRouter 的 linux runtime 补的两个目录分发段：
 * 单文件 `codex` 里**没有** `bin/codex-code-mode-host`（它只存在于目录发行包），缺
 * `codexPackage` 时远端 Codex 的 code-mode（命令执行）起不来；`pi` 决定远端能否跑 Pi。
 *
 * 两个新段的**可选性**是红线：消费端把「缺失」视为合法（回退镜像内那份 / 老 manifest 继续
 * 可用），`schemaVersion` 保持 `1`。因此这里对它们只做「存在即校验、缺失即合法」
 * （`required: false`）——**要求齐备是发布侧的事**（`publish-agent-runtimes.mjs`），不是这里。
 */
export function buildAgentRuntimeManifest(platformKey, assets, ccMgrAsset, dirDistAssets) {
  const manifest = {
    schemaVersion: 1,
    platformKey,
    claudeCode: structuredClone(assets.claudeCode),
    codex: structuredClone(assets.codex),
    // `ccMgr` 是**可选段**：只有确实发布过 cc-mgr bundle 时才写。消费端（MCPRouter 的
    // `agentBinaryCache.validateManifest`）把「缺失」视为合法并回退镜像内那份，因此
    // 老 manifest 与「还没发过 cc-mgr 的区域」都不会因此打挂。
    ...(ccMgrAsset ? { ccMgr: structuredClone(ccMgrAsset) } : {}),
    // `codexPackage` / `pi`：同一套可选性契约，见上面的函数注释。
    ...dirDistManifestSections(dirDistAssets),
  };
  assertRuntimeManifestAssets(manifest, platformKey, {
    definitions: AGENT_RUNTIME_DEFINITIONS,
  });
  if (dirDistAssets) {
    assertRuntimeManifestAssets(manifest, platformKey, {
      required: false,
      definitions: DIR_DIST_RUNTIME_DEFINITIONS,
    });
  }
  return manifest;
}

/**
 * 目录分发段在 runtime manifest 里的**预览文本**（`--execute` 之前的 dry-run 打印）。
 *
 * 为什么需要它：`codexPackage` 与 `pi` 的 `sha256`/`size` **来源不同**，只打印版本号无法
 * 人工核对，而两者又都是「同路径内容不同即拒绝覆盖」的版本化对象 —— 发错一次就得人工介入。
 *   - `codexPackage`：**原样转发** pin 的上游官方整包 ⇒ manifest 段的 `sha256`/`size` 与 pin
 *     同源，dry-run 阶段就能确定；
 *   - `pi`：发布侧**确定性重打包**（解包 → 补齐 `theme/` → tar.gz）⇒ manifest 段记的是重打包
 *     产物的 `sha256`/`size`，只有 `--execute` 真正下载上游归档后才能算出来。这里用 `null`
 *     占位并注明口径，**绝不**把 pin（上游归档）的摘要当成段摘要打印出去。
 */
export function formatMekaDirDistManifestPreview(
  dirDistAssets,
  definitions = DIR_DIST_RUNTIME_DEFINITIONS,
) {
  return definitions.map((definition) => {
    const asset = dirDistAssets?.[definition.field];
    if (!asset) {
      return `  ${definition.field}: <未收集到该段的待发布资产>`;
    }
    const section = definition.repack
      ? { version: asset.version, file: asset.file, sha256: null, size: null }
      : dirDistManifestSection(asset);
    const note = definition.repack
      ? `重打包：sha256/size 在 --execute 时按确定性重打包产物填写` +
        `（上游 pin sha256=${asset.sha256}, ${asset.size} bytes）`
      : '原样转发 pin 字节（sha256/size 与 pin 同源）';
    return `  ${definition.field}: ${JSON.stringify(section)}  ← ${note}`;
  });
}

/* ==========================================================================
 * cc-mgr bundle：按版本可寻址的 CDN 对象（L2「按版本交付」的生产端）
 *
 * 与上面 claude/codex 的三点差别，都是刻意的（消费端有对应注释）：
 *   - **平台无关**：cc-mgr 是一份 JS，各平台同一份字节，所以对象路径里没有 platformKey；
 *   - **明文**：不做 gzip，因此只有一个 sha256（没有 gzip 摘要 + 解压后摘要的两段校验）；
 *   - **同时记 protocol**：manager 版本相同但 protocol 不同属于不可部署的 pin mismatch。
 *
 * 版本号与摘要都不在这里手写：版本从 `packages/maker-cc-manager/src/protocol.ts` 解析，
 * 摘要从**构建产物**现算，并且发布前用产物自己的 `--version` 探针核对一遍 —— 这正是
 * MCPRouter 侧 `build-cc-mgr-bundle.mjs` 的纪律，两端必须同样严。
 * ========================================================================== */

export const CC_MGR_CDN_OBJECT_PREFIX = 'cc-mgr';
export const CC_MGR_BUNDLE_FILE_NAME = 'cc-mgr.mjs';
const CC_MGR_PROTOCOL_SOURCE = ['packages', 'maker-cc-manager', 'src', 'protocol.ts'];
const CC_MGR_BUILT_BUNDLE = ['packages', 'maker-cc-manager', 'dist', 'cc-mgr.mjs'];

export function ccMgrBundleSourcePath() {
  return path.join(PROJECT_ROOT, ...CC_MGR_BUILT_BUNDLE);
}

export function ccMgrProtocolSourcePath() {
  return path.join(PROJECT_ROOT, ...CC_MGR_PROTOCOL_SOURCE);
}

/** CDN 对象路径：`cc-mgr/<managerVersion>/cc-mgr.mjs`（无平台段）。 */
export function ccMgrBundleObjectPath(managerVersion) {
  if (!VERSION_RE.test(managerVersion)) {
    throw new Error(`非法 cc-mgr managerVersion=${managerVersion}`);
  }
  return `${CC_MGR_CDN_OBJECT_PREFIX}/${managerVersion}/${CC_MGR_BUNDLE_FILE_NAME}`;
}

/**
 * 从 `maker-cc-manager` 的 protocol 源码里读出 (managerVersion, protocolVersion)。
 *
 * 解析源码而不是 import：`protocol.ts` 是 TS，发布脚本是 ESM 且跑在 node 下，直接 import
 * 需要转译。两个常量是**手写字符串字面量**（bundle 不用语义化版本体系），因此正则匹配
 * 足够稳定；匹配不到就 fail，绝不回退默认值。
 */
export function readCcMgrPinFromProtocolSource(sourceText) {
  const bundle = /export const CC_MGR_BUNDLE_VERSION = '([^']+)'/.exec(sourceText);
  const protocol = /export const PROTOCOL_VERSION = (\d+)/.exec(sourceText);
  if (!bundle) throw new Error('maker-cc-manager protocol.ts 里找不到 CC_MGR_BUNDLE_VERSION');
  if (!protocol) throw new Error('maker-cc-manager protocol.ts 里找不到 PROTOCOL_VERSION');
  const managerVersion = bundle[1];
  if (!VERSION_RE.test(managerVersion)) {
    throw new Error(`CC_MGR_BUNDLE_VERSION 不是可发布的版本号: ${managerVersion}`);
  }
  return { managerVersion, protocolVersion: Number(protocol[1]) };
}

export function readLocalCcMgrPin() {
  return readCcMgrPinFromProtocolSource(fs.readFileSync(ccMgrProtocolSourcePath(), 'utf8'));
}

/**
 * 用产物自己的 `--version` 探针核对它自报的版本与 pin 一致。
 *
 * 为什么必须做：bundle 是**构建产物**，源码常量改了而产物是旧的（或构建缓存命中）时，
 * 发布出去的字节与 pin 就对不上 —— 那正是「两端版本分叉」这类事故的入口。宁可在这里
 * 失败，也不要等用户会话在握手时炸。
 */
export function probeCcMgrBundleVersion(bundlePath, expected) {
  const probe = spawnSync(process.execPath, [bundlePath, '--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    throw new Error(
      `cc-mgr bundle 探针失败 (exit=${probe.status ?? 'unknown'}): ${(probe.stderr ?? '').trim()}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse((probe.stdout ?? '').trim());
  } catch {
    throw new Error(`cc-mgr bundle 探针输出不是 JSON: ${(probe.stdout ?? '').trim().slice(0, 200)}`);
  }
  if (
    parsed.managerVersion !== expected.managerVersion
    || parsed.protocolVersion !== expected.protocolVersion
  ) {
    throw new Error(
      `cc-mgr bundle 自报 ${parsed.managerVersion}/protocol ${parsed.protocolVersion}，`
      + `与 pin ${expected.managerVersion}/protocol ${expected.protocolVersion} 不一致；`
      + '先跑 pnpm --filter @cindy/maker-cc-manager bundle 重建产物',
    );
  }
  return parsed;
}

/**
 * 上传一个**版本化、不可覆盖**的 cc-mgr 对象，返回 manifest 里要写的那一段。
 *
 * 不可覆盖是硬规则（与 runtime 对象同口径）：同路径内容不同必须失败，绝不静默覆盖 ——
 * 否则「同一个版本号两份不同字节」会在两台机器上表现不一致，且无法回滚。
 */
export async function publishCcMgrBundle(storage, options) {
  const { managerVersion, protocolVersion } = options.pin;
  const bundlePath = options.bundlePath;
  if (!fs.existsSync(bundlePath)) {
    throw new Error(
      `cc-mgr bundle 不存在: ${bundlePath}；先跑 pnpm --filter @cindy/maker-cc-manager bundle`,
    );
  }
  const objectPath = ccMgrBundleObjectPath(managerVersion);
  const sha256 = sha256File(bundlePath);
  const size = fs.statSync(bundlePath).size;

  const remote = await storage.head(objectPath);
  if (remote) {
    const remoteSha = remote.metadata.sha256?.toLowerCase();
    if (remoteSha === sha256 && remote.size === size) {
      return { uploaded: false, manifestAsset: { managerVersion, protocolVersion, file: objectPath, sha256, size } };
    }
    throw new Error(
      `cc-mgr 版本化对象已存在但内容不同，拒绝覆盖: ${objectPath} `
      + `(remote sha256=${remoteSha ?? 'missing'} size=${remote.size}, local sha256=${sha256} size=${size})`,
    );
  }

  await storage.putFile(objectPath, bundlePath, {
    metadata: {
      sha256,
      'manager-version': managerVersion,
      'protocol-version': String(protocolVersion),
    },
  });
  const verified = await storage.head(objectPath);
  if (
    !verified
    || verified.size !== size
    || verified.metadata.sha256?.toLowerCase() !== sha256
  ) {
    throw new Error(`cc-mgr 上传后校验失败: ${objectPath}`);
  }
  return { uploaded: true, manifestAsset: { managerVersion, protocolVersion, file: objectPath, sha256, size } };
}

async function prepareCompressedAsset(local, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(
    outputDir,
    `${local.field}-${local.version}-${local.platformKey}-${local.binaryName}.gz`,
  );
  const cachePath = `${outputPath}.json`;

  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const stat = fs.statSync(outputPath);
    if (
      cache.binarySha256 === local.binarySha256 &&
      stat.isFile() &&
      stat.size === cache.size &&
      sha256File(outputPath) === cache.sha256
    ) {
      return {
        filePath: outputPath,
        sha256: cache.sha256,
        size: cache.size,
      };
    }
  } catch {
    // Missing or stale compression cache; rebuild it below.
  }

  await gzipFile(local.binaryPath, outputPath);
  const compressed = {
    filePath: outputPath,
    sha256: sha256File(outputPath),
    size: fs.statSync(outputPath).size,
  };
  fs.writeFileSync(
    cachePath,
    `${JSON.stringify({
      binarySha256: local.binarySha256,
      sha256: compressed.sha256,
      size: compressed.size,
    })}\n`,
  );
  return compressed;
}

async function putImmutableRuntimeAsset(storage, local, compressed) {
  const remote = await storage.head(local.file);
  if (remote) {
    const remoteBinarySha256 = remote.metadata['binary-sha256']?.toLowerCase();
    const remoteGzipSha256 = remote.metadata.sha256?.toLowerCase();
    if (
      remoteBinarySha256 === local.binarySha256 &&
      SHA256_RE.test(remoteGzipSha256 ?? '') &&
      remote.size > 0
    ) {
      return {
        uploaded: false,
        manifestAsset: {
          version: local.version,
          file: local.file,
          sha256: remoteGzipSha256,
          size: remote.size,
          binarySha256: local.binarySha256,
        },
      };
    }
    if (remoteGzipSha256 === compressed.sha256 && remote.size === compressed.size) {
      return {
        uploaded: false,
        manifestAsset: {
          version: local.version,
          file: local.file,
          sha256: compressed.sha256,
          size: compressed.size,
          binarySha256: local.binarySha256,
        },
      };
    }
    throw new Error(`运行时版本化对象已存在但内容不同，拒绝覆盖: ${local.file}`);
  }

  await storage.putFile(local.file, compressed.filePath, {
    metadata: {
      sha256: compressed.sha256,
      'binary-sha256': local.binarySha256,
    },
  });
  const verified = await storage.head(local.file);
  if (
    !verified ||
    verified.size !== compressed.size ||
    verified.metadata.sha256?.toLowerCase() !== compressed.sha256 ||
    verified.metadata['binary-sha256']?.toLowerCase() !== local.binarySha256
  ) {
    throw new Error(`RustFS 运行时上传后校验失败: ${local.file}`);
  }
  return {
    uploaded: true,
    manifestAsset: {
      version: local.version,
      file: local.file,
      sha256: compressed.sha256,
      size: compressed.size,
      binarySha256: local.binarySha256,
    },
  };
}

export async function publishRuntimeAssets(
  storage,
  localAssets,
  baseManifest,
  outputDir,
  { definitions = RUNTIME_DEFINITIONS } = {},
) {
  const manifestAssets = {};
  const results = {};

  for (const definition of definitions) {
    const local = localAssets[definition.field];
    const existing = baseManifest?.[definition.field];
    if (
      validRuntimeManifestAsset(existing, local.platformKey) &&
      existing.version === local.version &&
      (!existing.binarySha256 || existing.binarySha256 === local.binarySha256) &&
      (await storage.head(existing.file))
    ) {
      manifestAssets[definition.field] = existing;
      results[definition.field] = 'reused';
      continue;
    }

    const compressed = await prepareCompressedAsset(local, outputDir);
    const published = await putImmutableRuntimeAsset(storage, local, compressed);
    manifestAssets[definition.field] = published.manifestAsset;
    results[definition.field] = published.uploaded ? 'uploaded' : 'reused';
  }

  assertRuntimeManifestAssets(
    { ...baseManifest, ...manifestAssets },
    Object.values(localAssets)[0].platformKey,
    { definitions },
  );
  return { manifestAssets: Object.freeze(manifestAssets), results: Object.freeze(results) };
}

// ── 目录分发 runtime（codexPackage / pi）────────────────────────────────

/**
 * 目录分发资产在「规范平台表」里的条目（发布侧的唯一真值来源）。
 *
 * 表由安装侧维护（`tools/codex-package/update.mjs` 的 `CODEX_PACKAGE_PLATFORMS`，
 * 就是 `ensurePlatform` 用来校验官方包布局的那份），发布侧只读复用——不在这里另造一份
 * 平台映射，否则两份表迟早漂移。pi 同理复用 `tools/pi/update.mjs` 的
 * `PI_RUNTIME_PLATFORMS`（key / 上游资产名 / 主执行文件名）。
 */
function canonicalPlatformFor(definition, platformKey) {
  const table = definition.canonicalPlatforms;
  if (!Array.isArray(table)) {
    throw new Error(`${definition.field} 缺少 canonicalPlatforms 规范表`);
  }
  const entry = table.find((candidate) => candidate.key === platformKey);
  if (!entry) {
    throw new Error(`${definition.field} 规范表没有 ${platformKey} 条目`);
  }
  return entry;
}

/** 解析某平台下这个定义的上游资产名与主执行文件名（两种规范表形状的适配层）。 */
function dirDistPlatformEntry(definition, platformKey) {
  if (Array.isArray(definition.platforms)) {
    const entry = definition.platforms.find((candidate) => candidate.key === platformKey);
    if (!entry) throw new Error(`${definition.field} 规范表没有 ${platformKey} 条目`);
    return { assetName: entry.asset, mainBinaryName: entry.binFile, canonical: undefined };
  }
  return {
    assetName: definition.archiveName,
    mainBinaryName: undefined,
    canonical: canonicalPlatformFor(definition, platformKey),
  };
}

/**
 * 从 pin 构造待发布目录分发资产（纯读盘，不触网）。
 *
 * pin 字段缺失/非法（含非 `https://github.com/...` 直链）即抛错：发布链路不能
 * 放宽信任边界，见 `tools/shared/github-release-pin.mjs`。
 */
export function collectPinnedDirDistAssets(
  platformKey,
  { projectRoot = PROJECT_ROOT, definitions = DIR_DIST_RUNTIME_DEFINITIONS } = {},
) {
  if (!PLATFORM_KEY_RE.test(platformKey)) {
    throw new Error(`非法 runtime platformKey=${platformKey}`);
  }
  return Object.fromEntries(
    definitions.map((definition) => {
      const pinPath = path.join(projectRoot, ...definition.pinFile);
      if (!fs.existsSync(pinPath)) {
        throw new Error(`${definition.field} pin 缺失：${pinPath}`);
      }
      let pin;
      try {
        pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
      } catch (error) {
        throw new Error(`${definition.field} pin 不是合法 JSON：${pinPath}`, { cause: error });
      }
      const version = typeof pin?.version === 'string' ? pin.version.trim() : '';
      if (!VERSION_RE.test(version)) {
        throw new Error(`${definition.field} pin 版本非法: ${version || '<empty>'}`);
      }
      const platformEntry = dirDistPlatformEntry(definition, platformKey);
      const pinAsset = pin?.runtimeAssets?.[platformKey];
      if (platformEntry.canonical) {
        // codexPackage 的 pin 每个平台条目都带 target/entrypoint，安装侧
        // （tools/codex-package/update.mjs 的 validateCodexPackageDirectory）也校验它们。
        // 发布侧**复用同一个规范表**逐项比对，并**要求字段存在**：缺字段即 fail closed，
        // 绝不让校验静默退化成“不校验”。只比 entrypoint 是不够的——`bin/codex` /
        // `bin/codex.exe` 各覆盖两个平台，跨架构整段粘贴（例如把 win32-arm64 条目放进
        // win32-x64 槽位）能骗过它，结果是把 arm64 字节发到 x64 路径；必须连 target 一起比。
        if (typeof pinAsset?.target !== 'string' || typeof pinAsset?.entrypoint !== 'string') {
          throw new Error(
            `${definition.field} pin 缺少 ${platformKey} 的 target/entrypoint 元数据`,
          );
        }
        for (const field of ['target', 'entrypoint']) {
          if (pinAsset[field] !== platformEntry.canonical[field]) {
            throw new Error(
              `${definition.field} pin 的 ${platformKey} ${field} 与规范值不符: ` +
                `${pinAsset[field]} !== ${platformEntry.canonical[field]}`,
            );
          }
        }
      }
      const descriptor = pinnedAssetDescriptor(pin, platformKey, {
        assetName: platformEntry.assetName,
        label: definition.pinLabel,
      });
      const sha256 = normalizeExpectedSha256(descriptor.digest);
      return [
        definition.field,
        Object.freeze({
          ...definition,
          version,
          platformKey,
          sha256,
          size: descriptor.size,
          url: descriptor.browser_download_url,
          file: `${definition.objectRoot}/${version}/${platformKey}/${definition.archiveName}`,
          // pi：重打包前需要知道上游归档名（决定 zip / tar.gz 解包路径）与主执行文件名
          // （`flattenExtractedDir` 归一布局的判据）。
          ...(platformEntry.mainBinaryName
            ? { upstreamAssetName: platformEntry.assetName, binaryName: platformEntry.mainBinaryName }
            : {}),
        }),
      ];
    }),
  );
}

function dirDistManifestAsset(local) {
  return {
    version: local.version,
    file: local.file,
    sha256: local.sha256,
    size: local.size,
  };
}

/** 重打包定义留在对象元数据里的 pin 归档摘要键（重跑据此证明对象确实来自当前 pin 字节）。 */
const PINNED_ARCHIVE_SHA256_METADATA_KEY = 'pinned-sha256';

function remoteMatchesPinnedArchive(remote, local) {
  return (
    normalizeExpectedSha256(remote?.metadata?.[PINNED_ARCHIVE_SHA256_METADATA_KEY]) === local.sha256
  );
}

/**
 * 下载并校验 pin 归档 → 解包 → 归一布局 → 定义声明的目录补全 → 确定性 tar.gz。
 *
 * 导出供单测直接覆盖重打包（含确定性：同一份内容必须得到同一份字节）。调用方负责
 * 清理 `workDir`（本函数只清自己产出的中间文件）。
 */
export async function prepareRepackedDirDistArchive(
  definition,
  local,
  workDir,
  { download = downloadToFileWithTimeout, log = console.log } = {},
) {
  if (typeof local.binaryName !== 'string' || !local.binaryName) {
    throw new Error(`${definition.field} 缺少主执行文件名，无法归一布局`);
  }
  const upstreamName = typeof local.upstreamAssetName === 'string' && local.upstreamAssetName
    ? local.upstreamAssetName
    : local.url.split('?')[0].split('/').pop();
  const extension = /[.]zip$/i.test(upstreamName) ? 'zip' : 'tar.gz';
  fs.mkdirSync(workDir, { recursive: true });
  const archivePath = path.join(workDir, `upstream-${definition.field}-${local.version}-${local.platformKey}.${extension}`);
  const extractDir = path.join(workDir, 'extracted');
  const outputPath = path.join(workDir, `${definition.field}-${local.version}-${local.platformKey}.tar.gz`);
  try {
    const progress = createDownloadProgressLogger(`${definition.field} ${local.platformKey}`);
    try {
      await download(local.url, archivePath, {}, {
        onProgress: progress.onProgress,
        minThroughputBytesPerSec: 0,
      });
    } finally {
      progress.finish();
    }
    const size = fs.statSync(archivePath).size;
    if (size !== local.size) {
      // 大小先于 sha256 判定：给"上游包变了"与"下载被截断"两类问题更直白的归因。
      throw new Error(
        `${definition.field} ${local.platformKey} 下载字节数不符: 期望 ${local.size}, 实际 ${size} (pin ${local.version})`,
      );
    }
    verifyFileSha256OrRemove(
      archivePath,
      local.sha256,
      `${definition.field} ${local.platformKey}@${local.version}`,
    );
    fs.mkdirSync(extractDir, { recursive: true });
    await extractArchive(archivePath, extractDir);
    flattenExtractedDir(extractDir, local.binaryName);
    // 上游归档缺 `theme/`（缺它 Pi 的 RPC 模式启动即崩）：与安装侧走同一条补齐实现。
    definition.afterExtract?.(extractDir);
    await createDeterministicTarGz(extractDir, outputPath);
    const prepared = {
      filePath: outputPath,
      sha256: sha256File(outputPath),
      size: fs.statSync(outputPath).size,
    };
    log(
      `  ${definition.field}: ${local.version} ${local.platformKey} 重打包 ` +
        `(${local.size} -> ${prepared.size} bytes)`,
    );
    return prepared;
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

/**
 * 原样转发 pin 字节的目录分发段（codexPackage）：上传/复用版本化对象。
 * 幂等复用判据与单文件链路一致：manifest 已记录同版本同 sha256 且对象仍在 → 复用。
 */
async function publishForwardedDirDistAsset(
  storage,
  definition,
  local,
  existing,
  outputDir,
  { download, log },
) {
  if (
    validRuntimeManifestAsset(existing, local.platformKey) &&
    existing.version === local.version &&
    normalizeExpectedSha256(existing.sha256) === local.sha256 &&
    (await storage.head(existing.file))
  ) {
    return { manifestAsset: existing, result: 'reused' };
  }

  const remote = await storage.head(local.file);
  if (remote) {
    const remoteSha256 = normalizeExpectedSha256(remote.metadata?.sha256);
    if (remoteSha256 === local.sha256 && remote.size === local.size) {
      return { manifestAsset: dirDistManifestAsset(local), result: 'reused' };
    }
    throw new Error(`运行时版本化对象已存在但内容不同，拒绝覆盖: ${local.file}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const archivePath = path.join(
    outputDir,
    `${definition.field}-${local.version}-${local.platformKey}.tar.gz`,
  );
  try {
    const progress = createDownloadProgressLogger(`${definition.field} ${local.platformKey}`);
    try {
      await download(local.url, archivePath, {}, { onProgress: progress.onProgress, minThroughputBytesPerSec: 0 });
    } finally {
      progress.finish();
    }
    const size = fs.statSync(archivePath).size;
    if (size !== local.size) {
      // 大小先于 sha256 判定：给"上游包变了"与"下载被截断"两类问题更直白的归因。
      throw new Error(
        `${definition.field} ${local.platformKey} 下载字节数不符: 期望 ${local.size}, 实际 ${size} (pin ${local.version})`,
      );
    }
    verifyFileSha256OrRemove(archivePath, local.sha256, `${definition.field} ${local.platformKey}@${local.version}`);
    await storage.putFile(local.file, archivePath, {
      metadata: { sha256: local.sha256, 'pinned-version': local.version },
    });
    const verified = await storage.head(local.file);
    if (
      !verified ||
      verified.size !== local.size ||
      normalizeExpectedSha256(verified.metadata?.sha256) !== local.sha256
    ) {
      throw new Error(`RustFS ${definition.field} 上传后校验失败: ${local.file}`);
    }
    log(`  ${definition.field}: ${local.version} ${local.platformKey} (${local.size} bytes) -> ${local.file}`);
    return { manifestAsset: dirDistManifestAsset(local), result: 'uploaded' };
  } finally {
    try { fs.rmSync(archivePath, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * 重打包目录分发段（pi）：manifest 记的是**重打包产物**的 sha256，pin 的摘要留在对象
 * 元数据里。因此复用判定分两层：对象仍在且 `pinned-sha256` 等于当前 pin → 说明在线对象
 * 就是当前上游字节的确定性重打包结果；manifest 段则能沿用就沿用，不能（例如 canary 被
 * reset 回上一版 stable）就用对象自身的 sha256/size 重建。
 */
async function publishRepackedDirDistAsset(
  storage,
  definition,
  local,
  existing,
  outputDir,
  { download, log },
) {
  const remote = await storage.head(local.file);
  if (remote) {
    const remoteSha256 = normalizeExpectedSha256(remote.metadata?.sha256);
    if (!remoteMatchesPinnedArchive(remote, local) || !remoteSha256 || !(remote.size > 0)) {
      throw new Error(
        `运行时版本化对象已存在但内容不同，拒绝覆盖: ${local.file} ` +
          `(对象不是由当前 pin ${local.version}/${local.sha256.slice(0, 12)} 重打包而来)`,
      );
    }
    if (
      validRuntimeManifestAsset(existing, local.platformKey) &&
      existing.version === local.version &&
      normalizeExpectedSha256(existing.sha256) === remoteSha256 &&
      existing.size === remote.size
    ) {
      return { manifestAsset: existing, result: 'reused' };
    }
    return {
      manifestAsset: {
        version: local.version,
        file: local.file,
        sha256: remoteSha256,
        size: remote.size,
      },
      result: 'reused',
    };
  }

  const workDir = path.join(outputDir, `${definition.field}-${local.version}-${local.platformKey}`);
  fs.mkdirSync(outputDir, { recursive: true });
  let prepared;
  try {
    prepared = await prepareRepackedDirDistArchive(definition, local, workDir, { download, log });
    await storage.putFile(local.file, prepared.filePath, {
      metadata: {
        sha256: prepared.sha256,
        [PINNED_ARCHIVE_SHA256_METADATA_KEY]: local.sha256,
        'pinned-version': local.version,
      },
    });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  const verified = await storage.head(local.file);
  if (
    !verified ||
    verified.size !== prepared.size ||
    normalizeExpectedSha256(verified.metadata?.sha256) !== prepared.sha256 ||
    !remoteMatchesPinnedArchive(verified, local)
  ) {
    throw new Error(`RustFS ${definition.field} 上传后校验失败: ${local.file}`);
  }
  log(`  ${definition.field}: ${local.version} ${local.platformKey} -> ${local.file}`);
  return {
    manifestAsset: {
      version: local.version,
      file: local.file,
      sha256: prepared.sha256,
      size: prepared.size,
    },
    result: 'uploaded',
  };
}

/**
 * 上传/复用目录分发 runtime 对象（版本化、不可覆盖、上传后回读校验），返回可写入
 * manifest 的资产段。按定义分派：`repack` 定义走“下载 pin 归档 → 重打包”（pi），
 * 其余原样转发 pin 字节（codexPackage）。
 *
 * `download` 只作为单测注入缝（生产走 `downloadToFileWithTimeout`）。
 */
export async function publishDirDistAssets(
  storage,
  localAssets,
  baseManifest,
  outputDir,
  { definitions = DIR_DIST_RUNTIME_DEFINITIONS, download = downloadToFileWithTimeout, log = console.log } = {},
) {
  const manifestAssets = {};
  const results = {};
  for (const definition of definitions) {
    const local = localAssets[definition.field];
    if (!local) throw new Error(`缺少 ${definition.field} 待发布资产`);
    const existing = baseManifest?.[definition.field];
    const published = definition.repack
      ? await publishRepackedDirDistAsset(storage, definition, local, existing, outputDir, { download, log })
      : await publishForwardedDirDistAsset(storage, definition, local, existing, outputDir, { download, log });
    manifestAssets[definition.field] = published.manifestAsset;
    results[definition.field] = published.result;
  }

  return { manifestAssets: Object.freeze(manifestAssets), results: Object.freeze(results) };
}

