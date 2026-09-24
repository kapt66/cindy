import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CINDY_CLIENT_VERSION_HEADER, CINDY_PLUGIN_SPACE_HEADER } from '@cindy/plugin-protocol';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyDevPluginIdentityOverride,
  PLUGIN_CLIENT_VERSION_OVERRIDE_ENV,
  PLUGIN_EDITIONS,
  PLUGIN_SPACE_HEADER_ENABLED,
  pluginClientVersionReader,
  pluginSpaceHeaderValue,
  readPluginClientIdentity,
  resolvePluginClientIdentity,
} from '../clientIdentity';

/**
 * 插件分发来源与版本空间的声明契约门禁（设计正本
 * `docs/dev-rules/plugin-distribution-and-version-compat.md` §3.2／§5.1／§6）。
 *
 * 为什么是"读源码做静态断言"而不是 import 被测模块：工件是纯数据、运行期刻意不 import
 * （RFC §5.1 P1-5），而渠道构造点是 Electron 主进程模块，单测里 import 会拖起整张
 * Ghost host 图。形态沿用本目录 `ipcErrorBoundary.test.ts` 的既有源码级断言做法。
 *
 * 落点说明：RFC P1-1 建议建 `scripts/__tests__/plugin-distribution-contract.test.mjs` 并挂进
 * 根 `test:runner`；这里选择 desktop unit tier（`apps/desktop/vitest.config.ts` 的
 * `desktopTestInclude` 自动收集本文件，`pnpm test:unit` 必跑），
 * 按 RFC §5.3「落在 test:runner 或 desktop unit tier 上」二者等价，且无需改根 `package.json`。
 */

const REPO_ROOT = new URL('../../../../../../', import.meta.url);
const REPO_ROOT_PATH = fileURLToPath(REPO_ROOT);

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(new URL(relativePath, REPO_ROOT), 'utf8').replace(/\r\n/g, '\n');
}

const ARTIFACT_PATH = 'config/plugin-distribution.json';

// 覆盖开关是环境变量：本文件既有的"渠道读取器读的是 app.getVersion()"断言默认不应受
// 开发者 shell 里残留的 XDT_PLUGIN_CLIENT_VERSION 影响，覆盖用例自己用 vi.stubEnv 显式设置。
beforeEach(() => {
  vi.unstubAllEnvs();
  delete process.env[PLUGIN_CLIENT_VERSION_OVERRIDE_ENV];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** 与 `scripts/check-endpoint-literals.mjs` 的 `findAbsoluteOrigins` 同一条口径。 */
function findAbsoluteOrigins(content: string): string[] {
  return [...content.matchAll(/(?:https?|wss?):\/\/[A-Za-z0-9.-]+(?::\d+)?/gi)].map((match) =>
    match[0].toLowerCase(),
  );
}

const EDITION_FIELDS = [
  'surface',
  'ipcPrefix',
  'versionSpace',
  'fallbackVersionSpaces',
  'venue',
  'identity',
  'projectionOwner',
  'dataDomain',
  'ledgerFile',
] as const;

const VERSION_SPACES = ['cindy', 'cindy-meka'];
const VENUE_KINDS = ['endpoint-manifest', 'mcpr-registry'];

const MARKET_SOURCE_ROOT = 'apps/desktop/src/main/plugin-market';
const REGISTER_SOURCE_PATH = `${MARKET_SOURCE_ROOT}/registerIpc.ts`;
const SERVICE_SOURCE_PATH = `${MARKET_SOURCE_ROOT}/service.ts`;
const API_SOURCE_PATH = `${MARKET_SOURCE_ROOT}/api.ts`;
const IDENTITY_SOURCE_PATH = `${MARKET_SOURCE_ROOT}/clientIdentity.ts`;
const SURFACE_SOURCE_PATH = 'apps/desktop/src/renderer/features/plugin/lib/pluginMarketSurface.ts';
const SHARED_MARKET_PATH = 'apps/desktop/src/shared/pluginMarket.ts';

interface RawEdition {
  surface?: unknown;
  ipcPrefix?: unknown;
  versionSpace?: unknown;
  fallbackVersionSpaces?: unknown;
  venue?: Record<string, unknown>;
  identity?: Record<string, unknown>;
  projectionOwner?: unknown;
  dataDomain?: unknown;
  ledgerFile?: unknown;
}

/**
 * 工件 shape 校验。返回全部问题而不是抛首个错误，让漂移一次看全。
 * 未声明字段一律判错：新增字段必须同一次交付里更新门禁，防止工件悄悄长出无人校验的维度。
 */
function collectShapeErrors(doc: unknown): string[] {
  const errors: string[] = [];
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return ['工件必须是 JSON object'];
  }
  const root = doc as Record<string, unknown>;
  if (root.schemaVersion !== 1) errors.push('schemaVersion 必须是 1');

  const editions = root.editions;
  if (typeof editions !== 'object' || editions === null || Array.isArray(editions)) {
    return [...errors, 'editions 必须是 object'];
  }
  const declaredEditions = Object.keys(editions as Record<string, unknown>).sort();
  const expectedEditions = [...PLUGIN_EDITIONS].sort();
  if (declaredEditions.join(',') !== expectedEditions.join(',')) {
    errors.push(
      `editions 必须且只能声明 ${expectedEditions.join(' / ')}，实得 ${declaredEditions.join(' / ')}`,
    );
  }

  for (const edition of expectedEditions) {
    const value = (editions as Record<string, RawEdition>)[edition];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`editions.${edition} 必须是 object`);
      continue;
    }
    const actualFields = Object.keys(value);
    for (const field of EDITION_FIELDS) {
      if (!actualFields.includes(field)) errors.push(`editions.${edition} 缺少字段 ${field}`);
    }
    for (const field of actualFields) {
      if (!(EDITION_FIELDS as readonly string[]).includes(field)) {
        errors.push(`editions.${edition} 含未声明字段 ${field}`);
      }
    }
    if (typeof value.surface !== 'string' || value.surface.length === 0) {
      errors.push(`editions.${edition}.surface 必须是非空字符串`);
    }
    if (typeof value.ipcPrefix !== 'string' || !/^(meka-)?plugin-market$/.test(value.ipcPrefix)) {
      errors.push(`editions.${edition}.ipcPrefix 必须是 plugin-market 或 meka-plugin-market`);
    }
    if (typeof value.versionSpace !== 'string' || !VERSION_SPACES.includes(value.versionSpace)) {
      errors.push(`editions.${edition}.versionSpace 必须是 ${VERSION_SPACES.join(' / ')}`);
    }
    if (!Array.isArray(value.fallbackVersionSpaces)) {
      errors.push(
        `editions.${edition}.fallbackVersionSpaces 必须是数组（D1 方案 2 的预留位，方案 1 下为空）`,
      );
    } else {
      for (const fallback of value.fallbackVersionSpaces) {
        if (typeof fallback !== 'string' || !VERSION_SPACES.includes(fallback)) {
          errors.push(
            `editions.${edition}.fallbackVersionSpaces 只接受 ${VERSION_SPACES.join(' / ')}`,
          );
        }
        if (fallback === value.versionSpace) {
          errors.push(`editions.${edition}.fallbackVersionSpaces 不得重复主空间`);
        }
      }
    }

    const venue = value.venue;
    if (typeof venue !== 'object' || venue === null || Array.isArray(venue)) {
      errors.push(`editions.${edition}.venue 必须是 object`);
    } else {
      const kind = venue.kind;
      if (typeof kind !== 'string' || !VENUE_KINDS.includes(kind)) {
        errors.push(`editions.${edition}.venue.kind 必须是 ${VENUE_KINDS.join(' / ')}`);
      }
      // 只引用键名：端点清单型来源给键名，MCPRouter 型来源给配置路径；两者都不写地址。
      if (kind === 'endpoint-manifest' && typeof venue.endpointKey !== 'string') {
        errors.push(`editions.${edition}.venue.endpointKey 必须给出端点清单键名`);
      }
      if (kind === 'mcpr-registry' && typeof venue.source !== 'string') {
        errors.push(`editions.${edition}.venue.source 必须给出配置来源路径`);
      }
      if (typeof venue.credential !== 'string' || venue.credential.length === 0) {
        errors.push(`editions.${edition}.venue.credential 必须是非空字符串`);
      }
    }

    const identity = value.identity;
    if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) {
      errors.push(`editions.${edition}.identity 必须是 object`);
    } else {
      const identityKeys = Object.keys(identity);
      const declaredIdentityKeys = ['header', 'source', 'devOverride', 'spaceHeader'];
      for (const key of declaredIdentityKeys) {
        if (!identityKeys.includes(key))
          errors.push(`editions.${edition}.identity 缺少字段 ${key}`);
      }
      for (const key of identityKeys) {
        if (!declaredIdentityKeys.includes(key)) {
          errors.push(`editions.${edition}.identity 含未声明字段 ${key}`);
        }
      }
      if (identity.header !== CINDY_CLIENT_VERSION_HEADER) {
        errors.push(
          `editions.${edition}.identity.header 必须等于协议常量 ${CINDY_CLIENT_VERSION_HEADER}`,
        );
      }
      if (typeof identity.source !== 'string' || !identity.source.startsWith('app.getVersion()')) {
        errors.push(`editions.${edition}.identity.source 必须以 app.getVersion() 为主来源`);
      }

      // dev 覆盖也必须是**已声明**的维度：工件说"身份只由 app.getVersion() 决定"、代码却
      // 允许一个环境变量改写上报值，等价于工件不再是唯一事实源。env 名与运行期常量绑定。
      const devOverride = identity.devOverride;
      if (typeof devOverride !== 'object' || devOverride === null || Array.isArray(devOverride)) {
        errors.push(`editions.${edition}.identity.devOverride 必须是 object`);
      } else {
        const devOverrideRecord = devOverride as Record<string, unknown>;
        const declaredDevOverrideKeys = ['env', 'appliesWhen', 'purpose'];
        for (const key of declaredDevOverrideKeys) {
          if (!(key in devOverrideRecord)) {
            errors.push(`editions.${edition}.identity.devOverride 缺少字段 ${key}`);
          }
        }
        for (const key of Object.keys(devOverrideRecord)) {
          if (!declaredDevOverrideKeys.includes(key)) {
            errors.push(`editions.${edition}.identity.devOverride 含未声明字段 ${key}`);
          }
        }
        if (devOverrideRecord.env !== PLUGIN_CLIENT_VERSION_OVERRIDE_ENV) {
          errors.push(
            `editions.${edition}.identity.devOverride.env 必须等于运行期常量 ${PLUGIN_CLIENT_VERSION_OVERRIDE_ENV}`,
          );
        }
        if (
          typeof devOverrideRecord.appliesWhen !== 'string' ||
          !devOverrideRecord.appliesWhen.includes('!app.isPackaged')
        ) {
          errors.push(
            `editions.${edition}.identity.devOverride.appliesWhen 必须写明仅非打包生效（!app.isPackaged）`,
          );
        }
      }

      // 空间头（P2 就绪件）是**已声明但默认关闭**的：name 必须与协议常量同源，
      // enabled 必须与运行期开关一致（一致性由下面独立用例双向断言，这里只校验形态）。
      const spaceHeader = identity.spaceHeader;
      if (typeof spaceHeader !== 'object' || spaceHeader === null || Array.isArray(spaceHeader)) {
        errors.push(`editions.${edition}.identity.spaceHeader 必须是 object`);
      } else {
        const spaceHeaderRecord = spaceHeader as Record<string, unknown>;
        const spaceHeaderKeys = Object.keys(spaceHeaderRecord);
        const declaredSpaceHeaderKeys = ['name', 'enabled'];
        for (const key of declaredSpaceHeaderKeys) {
          if (!spaceHeaderKeys.includes(key)) {
            errors.push(`editions.${edition}.identity.spaceHeader 缺少字段 ${key}`);
          }
        }
        for (const key of spaceHeaderKeys) {
          if (!declaredSpaceHeaderKeys.includes(key)) {
            errors.push(`editions.${edition}.identity.spaceHeader 含未声明字段 ${key}`);
          }
        }
        if (spaceHeaderRecord.name !== CINDY_PLUGIN_SPACE_HEADER) {
          errors.push(
            `editions.${edition}.identity.spaceHeader.name 必须等于协议常量 ${CINDY_PLUGIN_SPACE_HEADER}`,
          );
        }
        if (typeof spaceHeaderRecord.enabled !== 'boolean') {
          errors.push(`editions.${edition}.identity.spaceHeader.enabled 必须是 boolean`);
        }
      }
    }

    if (typeof value.projectionOwner !== 'string' || value.projectionOwner.length === 0) {
      errors.push(`editions.${edition}.projectionOwner 必须是非空字符串`);
    }
    if (typeof value.dataDomain !== 'string' || value.dataDomain.length === 0) {
      errors.push(`editions.${edition}.dataDomain 必须是非空字符串`);
    }
    if (
      typeof value.ledgerFile !== 'string' ||
      !/^plugin-market\/[a-z0-9.-]+\.json$/.test(value.ledgerFile)
    ) {
      errors.push(`editions.${edition}.ledgerFile 必须是 plugin-market/<name>.json`);
    }
  }

  // versionless 是**显式声明**的身份后果，不是可以靠数值猜的默认分支。
  const policy = root.versionlessPolicy;
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    errors.push('versionlessPolicy 必须是 object');
  } else {
    const record = policy as Record<string, unknown>;
    if (record.sentinel !== '0.0.0') errors.push('versionlessPolicy.sentinel 必须是 0.0.0');
    if (record.identityKind !== 'unversioned') {
      errors.push('versionlessPolicy.identityKind 必须是 unversioned');
    }
    // 刻意**不**断言"两个 space 都恒报字面量 0.0.0"：运行期是 `app.getVersion()` 原值透传
    // （`0.0.0-*` 同样是 versionless，见 manifest 的 isVersionlessCindyVersion），断言字面量
    // 会与实现脱节。改为要求工件讲清"原值透传、不归一化"，运行期行为由「哨兵形态对账」用例实证。
    if (
      typeof record.reportedVersion !== 'string' ||
      !record.reportedVersion.includes('app.getVersion()') ||
      !record.reportedVersion.includes('不做归一化')
    ) {
      errors.push(
        'versionlessPolicy.reportedVersion 必须说明「app.getVersion() 原值透传、不做归一化」（与 resolvePluginClientIdentity 一致）',
      );
    }
    if (typeof record.projectionEffect !== 'string' || record.projectionEffect.length === 0) {
      errors.push('versionlessPolicy.projectionEffect 必须说明该身份在投影侧的后果');
    }
  }

  return errors;
}

function loadArtifact(): Record<string, unknown> {
  return JSON.parse(readRepoFile(ARTIFACT_PATH)) as Record<string, unknown>;
}

/**
 * 词法级去注释（把注释体替换成等长空白，保持行号）：让"运行期引用"扫描不被注释里对
 * 工件文件名的提及误判。只处理块注释与行注释，足够本用例使用。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:])\/\/[^\n]*/gm,
      (match, prefix: string) => prefix + ' '.repeat(match.length - prefix.length),
    );
}

/** 只收集运行期（非测试）文件，用于反向守卫与"版本来源唯一"断言。 */
function collectRuntimeSources(relativeDir: string): string[] {
  const absoluteDir = path.join(REPO_ROOT_PATH, relativeDir);
  const collected: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(absolute);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      collected.push(path.relative(REPO_ROOT_PATH, absolute).replace(/\\/g, '/'));
    }
  };
  walk(absoluteDir);
  return collected;
}

describe('插件分发声明工件（config/plugin-distribution.json）', () => {
  it('可解析，schemaVersion 与 shape 合法，cindy / meka 两个 edition 覆盖完整', () => {
    const artifact = loadArtifact();
    expect(collectShapeErrors(artifact)).toEqual([]);
  });

  it('默认终态按 D1 方案 1（单空间），但结构能表达方案 2 的过渡期双空间', () => {
    const artifact = loadArtifact();
    const editions = artifact.editions as Record<string, { fallbackVersionSpaces: string[] }>;
    // 方案 1 是默认终态：每个 edition 只有一个空间，且这一点必须显式写明，而不是靠"字段缺省"。
    for (const edition of PLUGIN_EDITIONS) {
      expect(editions[edition].fallbackVersionSpaces).toEqual([]);
    }
    // 方案 2（过渡期）不新增 schema：只往预留位里加空间，同一份 shape 仍然合法。
    const transition = structuredClone(artifact) as Record<string, unknown>;
    const transitionEditions = transition.editions as Record<
      string,
      { fallbackVersionSpaces: string[] }
    >;
    transitionEditions.meka.fallbackVersionSpaces = ['cindy'];
    expect(collectShapeErrors(transition)).toEqual([]);
  });

  it('工件里的版本空间与运行期身份解析一一对应（edition 是唯一新增轴）', () => {
    const artifact = loadArtifact();
    const editions = artifact.editions as Record<string, { versionSpace: string }>;
    for (const edition of PLUGIN_EDITIONS) {
      expect(editions[edition].versionSpace).toBe(
        resolvePluginClientIdentity({ edition, appVersion: '1.2.3' }).versionSpace,
      );
    }
  });

  it('工件内不出现任何地址字面量，也不出现端点清单里的地址值（只引用键名）', () => {
    const artifact = loadArtifact();
    const artifactText = readRepoFile(ARTIFACT_PATH);
    expect(findAbsoluteOrigins(artifactText)).toEqual([]);

    const endpointManifest = JSON.parse(readRepoFile('config/endpoint.json')) as Record<
      string,
      unknown
    >;
    for (const manifestPath of ['config/endpoint.json', 'config/endpoint.global.json']) {
      const manifest = JSON.parse(readRepoFile(manifestPath)) as Record<string, unknown>;
      for (const value of Object.values(manifest)) {
        if (typeof value !== 'string' || !value.includes('://')) continue;
        expect(artifactText).not.toContain(value);
      }
    }

    // endpoint-manifest 型来源必须指向端点清单里真实存在的键，否则"只引用键名"就是空话。
    const editions = artifact.editions as Record<string, { venue: Record<string, unknown> }>;
    expect(Object.keys(endpointManifest)).toContain(editions.cindy.venue.endpointKey);
    expect(editions.meka.venue).not.toHaveProperty('endpointKey');
    expect(editions.meka.venue).toHaveProperty('source');
  });

  it('工件不被任何运行期模块 import（防止它演化成客户端二次筛选的输入）', () => {
    // RFC §5.1 P1-5：工件是声明与上架决策的证据，不是运行期比较输入。只钉"运行期没有
    // 引用它的路径"。
    //
    // 判据：先用 stripComments 去掉注释体，再看剩余代码里有没有被引号（含反引号，即模板
    // 字面量）包住的工件文件名。本仓注释习惯用反引号包路径，若不先去注释，``工件`` 这种
    // 纯文档提及会被误判成引用；反过来若只看单/双引号，字符串里的模板字面量又会漏判。
    // 两者一起做才既不过报也不漏报。
    //
    // 局限（有意接受）：这是词法级扫描，拼接出来的引用（例如 'plugin-' + 'distribution'
    // 或按字符切分）抓不到；它只是"引用面漂移"的告警，不是"没有引用"的证明。真正的证明
    // 是反向事实：运行期不需要这份工件——见本文件对客户端身份唯一来源的断言。
    const quotedArtifactReference = /['"`][^'"`\n]*plugin-distribution[^'"`\n]*['"`]/;

    // 自检（防止断言空转）：分类器必须能抓到真实引用，且去注释必须能消掉文档式提及。
    // 没有这两条，"offenders 为空"也可能只是扫描器坏了。
    expect(
      quotedArtifactReference.test("require('../../../config/plugin-distribution.json')"),
    ).toBe(true);
    expect(quotedArtifactReference.test('await import(`config/plugin-distribution.json`)')).toBe(
      true,
    );
    expect(
      quotedArtifactReference.test(stripComments('// 见 config/plugin-distribution.json')),
    ).toBe(false);
    expect(quotedArtifactReference.test(stripComments('/* 见 plugin-distribution 工件 */'))).toBe(
      false,
    );
    // 去注释不得吃掉代码：同一行 `//` 之后的引用仍要保留。
    expect(
      quotedArtifactReference.test(
        stripComments("// 说明\nconst p = 'config/plugin-distribution.json';"),
      ),
    ).toBe(true);

    const corpus = collectRuntimeSources('apps/desktop/src');
    expect(corpus.length).toBeGreaterThan(100);
    const offenders = corpus.filter((file) =>
      quotedArtifactReference.test(stripComments(readRepoFile(file))),
    );
    expect(offenders).toEqual([]);
  });
});

describe('工件与代码枚举不漂移', () => {
  it('Renderer surface 枚举与工件的 surface 声明双向覆盖', () => {
    const surfaceSource = readRepoFile(SURFACE_SOURCE_PATH);
    const declaration = /export type PluginMarketSurface = ([^;]+);/.exec(surfaceSource);
    expect(declaration).not.toBeNull();
    const codeSurfaces = [...(declaration?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map(
      (match) => match[1],
    );
    expect(codeSurfaces.length).toBeGreaterThan(0);

    const artifact = loadArtifact();
    const editions = artifact.editions as Record<string, { surface: string }>;
    const declaredSurfaces = PLUGIN_EDITIONS.map((edition) => editions[edition].surface);
    expect([...declaredSurfaces].sort()).toEqual([...codeSurfaces].sort());
    // 一个 surface 只能归属一个 edition，否则"这次操作走哪个渠道"又有两个答案。
    expect(new Set(declaredSurfaces).size).toBe(declaredSurfaces.length);
    // 归属必须**逐个**钉死：只比集合的话，把两个 edition 的 surface 对调仍然「集合相等」，
    // 于是工件可以声明「cindy edition 走 Meka 面板」而门禁全绿。
    expect(editions.cindy.surface).toBe('plugins');
    expect(editions.meka.surface).toBe('meka');
    // surface → channel 的真实映射是代码里这处三元表达式；它必须与工件的归属一致，
    // 否则"这次操作走哪个渠道"在工件与代码里各说一套。
    expect(surfaceSource).toMatch(
      /surface === 'meka'\s*\?\s*channels\.mekaPluginMarket\s*:\s*channels\.pluginMarket/,
    );
  });

  it('两组 IPC 前缀与工件的 ipcPrefix 声明双向覆盖', () => {
    const channelSource = [
      readRepoFile(REGISTER_SOURCE_PATH),
      readRepoFile(SHARED_MARKET_PATH),
    ].join('\n');
    const codePrefixes = [
      ...new Set(
        [...channelSource.matchAll(/'(meka-plugin-market|plugin-market):/g)].map(
          (match) => match[1],
        ),
      ),
    ];
    expect(codePrefixes.length).toBeGreaterThan(0);

    const artifact = loadArtifact();
    const editions = artifact.editions as Record<string, { ipcPrefix: string }>;
    const declaredPrefixes = PLUGIN_EDITIONS.map((edition) => editions[edition].ipcPrefix);
    expect([...declaredPrefixes].sort()).toEqual([...codePrefixes].sort());
    expect(new Set(declaredPrefixes).size).toBe(declaredPrefixes.length);
    // 同 surface：两组前缀的正确性只靠集合相等挡不住"整体对调"（registerIpc.ts 里两组前缀
    // 同时存在，集合比较无法区分归属），所以逐 edition 硬钉。
    expect(editions.cindy.ipcPrefix).toBe('plugin-market');
    expect(editions.meka.ipcPrefix).toBe('meka-plugin-market');
  });

  it('dataDomain 与账本落点一致（两个渠道各自的数据域不交叉）', () => {
    const artifact = loadArtifact();
    const editions = artifact.editions as Record<
      string,
      { dataDomain: string; ledgerFile: string }
    >;
    const ledgerSources: Record<string, string> = {
      cindy: readRepoFile(SERVICE_SOURCE_PATH),
      meka: readRepoFile(REGISTER_SOURCE_PATH),
    };
    for (const edition of PLUGIN_EDITIONS) {
      const ledgerFile = editions[edition].ledgerFile;
      const [directory, fileName] = ledgerFile.split('/');
      expect(ledgerSources[edition]).toContain(`'${directory}'`);
      expect(ledgerSources[edition]).toContain(`'${fileName}'`);
    }
    expect(editions.cindy.dataDomain).not.toBe(editions.meka.dataDomain);
    expect(editions.cindy.ledgerFile).not.toBe(editions.meka.ledgerFile);
  });
});

describe('渠道构造点的身份收口（源码级断言）', () => {
  const registerSource = readRepoFile(REGISTER_SOURCE_PATH);
  const serviceSource = readRepoFile(SERVICE_SOURCE_PATH);
  const apiSource = readRepoFile(API_SOURCE_PATH);
  const identitySource = readRepoFile(IDENTITY_SOURCE_PATH);

  it('两条渠道的构造点都从 clientIdentity 取身份，且不得退回无参构造', () => {
    expect(registerSource).toContain("new MekaPluginMarketApi(pluginClientVersionReader('meka'))");
    expect(serviceSource).toContain(
      "new PluginMarketApi(undefined, pluginClientVersionReader('cindy'))",
    );
    for (const source of [registerSource, serviceSource]) {
      // 无参构造会落到基类默认值 0.0.0：等于把该渠道的服务端版本兼容门整体关掉。
      expect(source).not.toMatch(/new MekaPluginMarketApi\(\s*\)/);
      expect(source).not.toMatch(/new PluginMarketApi\(\s*\)/);
      expect(source).not.toContain("() => '0.0.0'");
    }
    // 基类默认值本身保留（参数形态兼容单测与注入 fetcher 的假渠道），但只允许出现在
    // 基类签名这一处；Meka 子类不得再有无参路径。
    expect(apiSource.match(/\(\) => '0\.0\.0'/g)).toHaveLength(1);
    expect(apiSource).not.toMatch(/new MekaPluginMarketApi\(\s*\)/);
  });

  it('MekaPluginMarketApi 的身份读取器是必填参数（没有默认值可退）', () => {
    expect(apiSource).toContain('constructor(identityVersionReader: () => string) {');
    expect(apiSource).not.toMatch(/constructor\(identityVersionReader: \(\) => string\s*=/);
    expect(apiSource).toContain('super(mekaFetcher, identityVersionReader);');
  });

  it('默认请求头只有 x-cindy-version；空间头只写在开关分支里（默认不发）', () => {
    // RFC P2-1 的 `x-cindy-plugin-space` 必须双端同时上线，提前单端发出去就是 wire 漂移
    // （`protocol-and-submodules.md` 的修改准入）。P2 客户端就绪件的口径是：**常量与写头代码
    // 都在，但默认不发送**——所以这里钉住两件事：① 版本头照旧；② 空间头的写入只出现在
    // `if (PLUGIN_SPACE_HEADER_ENABLED)` 分支内，开关为 false 时那一支不执行。
    const start = apiSource.indexOf('private requestOptions()');
    const end = apiSource.indexOf('\n  }', start);
    expect(start).toBeGreaterThan(-1);
    const requestOptionsBody = apiSource.slice(start, end);

    const guard = 'if (PLUGIN_SPACE_HEADER_ENABLED) {';
    const guardStart = requestOptionsBody.indexOf(guard);
    expect(guardStart).toBeGreaterThan(-1);
    const alwaysSentPart = requestOptionsBody.slice(0, guardStart);
    expect(alwaysSentPart).toContain('[CINDY_CLIENT_VERSION_HEADER]: this.versionReader()');
    // 开关分支之前（即默认路径上）不得出现任何空间头写入：默认请求与今天逐字节相同。
    expect(alwaysSentPart).not.toMatch(/plugin-space|pluginSpace|CINDY_PLUGIN_SPACE_HEADER/);

    const guardedPart = requestOptionsBody.slice(guardStart);
    expect(guardedPart).toContain('headers[CINDY_PLUGIN_SPACE_HEADER] =');
    expect(guardedPart).toContain('pluginSpaceHeaderValue(this.pluginEdition())');
  });

  it('空间头只在 ON 时按渠道 edition 取值，且取值来自身份解析的同一轴（不新造映射表）', () => {
    // 取值必须是 edition 名（`cindy` / `meka`），不是 `versionSpace`（`cindy-meka`）：
    // 后者是版本线的名字，写成头值就等于服务端要认第二种拼写。
    for (const edition of PLUGIN_EDITIONS) {
      expect(pluginSpaceHeaderValue(edition)).toBe(
        resolvePluginClientIdentity({ edition, appVersion: '1.2.3' }).edition,
      );
    }
    expect(pluginSpaceHeaderValue('cindy')).toBe('cindy');
    expect(pluginSpaceHeaderValue('meka')).toBe('meka');
    // 协议常量是唯一的头名真源（与版本头同一口径）。
    expect(CINDY_PLUGIN_SPACE_HEADER).toBe('x-cindy-plugin-space');
  });

  it('工件 identity.spaceHeader 与运行期开关双向绑定（任一侧漂移即红灯）', () => {
    // 这条是 P2 就绪件的核心守卫：协议常量与写头代码都在，唯一允许"不发头"的依据就是这个
    // 开关。工件说关了而运行期偷偷打开（客户端悄悄开始发头）——或反之（工件已登记开启而
    // 客户端仍不发）——都必须红灯。
    const artifact = loadArtifact();
    const editions = artifact.editions as Record<
      string,
      { identity: { spaceHeader: { name: string; enabled: boolean } } }
    >;
    expect(PLUGIN_SPACE_HEADER_ENABLED).toBe(false);
    for (const edition of PLUGIN_EDITIONS) {
      const spaceHeader = editions[edition].identity.spaceHeader;
      expect(spaceHeader.name).toBe(CINDY_PLUGIN_SPACE_HEADER);
      expect(spaceHeader.enabled).toBe(PLUGIN_SPACE_HEADER_ENABLED);
    }
  });

  it('运行期开关是模块常量（默认 false），没有运行期翻转入口', () => {
    // 只有源码里这一处声明；不得读环境变量／配置来决定发不发头（否则"某台机器上悄悄开始
    // 发头"就成了运行期状态，工件与门禁都锁不住）。全文件对它只有一次赋值，且必须是 false
    // ——要翻成 true，必须同一次交付里显式改这里、工件与门槛说明。
    expect(identitySource).toContain('export const PLUGIN_SPACE_HEADER_ENABLED: boolean = false;');
    const assignments = [
      ...identitySource.matchAll(/PLUGIN_SPACE_HEADER_ENABLED[^=\n]*=\s*([^;\n]+)/g),
    ].map((match) => match[1].trim());
    expect(assignments).toEqual(['false']);
    // 写空间头的运行期文件只有 api.ts 一处（头名从协议常量取，不在别处重写）。
    const spaceHeaderSources = collectRuntimeSources(MARKET_SOURCE_ROOT).filter((file) =>
      readRepoFile(file).includes('CINDY_PLUGIN_SPACE_HEADER'),
    );
    expect(spaceHeaderSources).toEqual([API_SOURCE_PATH]);
  });

  it('app.getVersion() 在 plugin-market 里只有一个读取处', () => {
    // 只认代码里的调用：注释用反引号提到 `app.getVersion()` 不算读取处（本仓注释习惯）。
    const appVersionCall = /(?<!`)app\.getVersion\(\)/;
    const pluginMarketSources = collectRuntimeSources(MARKET_SOURCE_ROOT);
    const versionSources = pluginMarketSources.filter((file) =>
      appVersionCall.test(readRepoFile(file)),
    );
    expect(versionSources).toEqual([IDENTITY_SOURCE_PATH]);
    expect(identitySource).toContain('appVersion: app.getVersion()');
    expect(identitySource).toContain('readPluginClientIdentity(edition).reportedVersion');
  });
});

describe('插件客户端身份解析（RFC §6.1：身份可复现）', () => {
  it('发布包身份可复现：versioned / 0.0.x 落在 cindy-meka 空间', () => {
    expect(resolvePluginClientIdentity({ edition: 'meka', appVersion: '0.0.25' })).toEqual({
      edition: 'meka',
      versionSpace: 'cindy-meka',
      header: CINDY_CLIENT_VERSION_HEADER,
      reportedVersion: '0.0.25',
      identityKind: 'versioned',
    });
  });

  it('源码包身份可复现：unversioned / 0.0.0 / cindy-meka，与发布包的差异只在 identityKind', () => {
    const release = resolvePluginClientIdentity({ edition: 'meka', appVersion: '0.0.25' });
    const source = resolvePluginClientIdentity({ edition: 'meka', appVersion: '0.0.0' });
    expect(source).toMatchObject({
      versionSpace: 'cindy-meka',
      reportedVersion: '0.0.0',
      identityKind: 'unversioned',
    });
    expect(source.versionSpace).toBe(release.versionSpace);
    expect(source.identityKind).not.toBe(release.identityKind);
  });

  it('cindy edition 仍在上游线上（现状语义不变）', () => {
    expect(resolvePluginClientIdentity({ edition: 'cindy', appVersion: '0.1.61' })).toMatchObject({
      versionSpace: 'cindy',
      reportedVersion: '0.1.61',
      identityKind: 'versioned',
    });
  });

  it('两个 space 的 versionless 都上报 0.0.0（预期行为，不是缺陷）', () => {
    // 协议把 `0.0.0` / `0.0.0-*` 判成版本无关并无条件放行；这不是"某个渠道漏传版本"
    // 造成的，而是 dev 与社区源码打包的既定语义，两个 edition 一致。
    for (const edition of PLUGIN_EDITIONS) {
      expect(resolvePluginClientIdentity({ edition, appVersion: '0.0.0' })).toMatchObject({
        reportedVersion: '0.0.0',
        identityKind: 'unversioned',
      });
    }
    expect(
      resolvePluginClientIdentity({ edition: 'cindy', appVersion: '0.0.0-dev' }).identityKind,
    ).toBe('unversioned');
  });

  it('哨兵形态原样上报，不做归一化（0.0.0-* 与 0.0.0 是同一判定的不同写法）', () => {
    // 协议判定是 `value === '0.0.0' || value.startsWith('0.0.0-')`，所以 `0.0.0-dev.1`
    // 这类预发布哨兵也必须原样透出：客户端不做版本归一化，归一是协议与市场侧的事。
    // 若这里被"整理"成 0.0.0，市场侧看到的构建标识就丢了，排查"哪个 dev 构建装到了什么"
    // 会失去唯一线索。
    for (const edition of PLUGIN_EDITIONS) {
      for (const sentinel of ['0.0.0', '0.0.0-dev', '0.0.0-dev.1', '0.0.0-local']) {
        expect(resolvePluginClientIdentity({ edition, appVersion: sentinel })).toMatchObject({
          reportedVersion: sentinel,
          identityKind: 'unversioned',
        });
      }
    }
    // 反面：非 0.0.0 前缀的预发布版本是正常版本，不得被当成 versionless。
    expect(
      resolvePluginClientIdentity({ edition: 'meka', appVersion: '0.0.25-rc.1' }),
    ).toMatchObject({ reportedVersion: '0.0.25-rc.1', identityKind: 'versioned' });
  });
  it('同一输入唯一确定，且允许打包形态显式声明 versionless 而不必靠数值猜', () => {
    const input = { edition: 'meka', appVersion: '0.0.25' } as const;
    expect(resolvePluginClientIdentity(input)).toEqual(resolvePluginClientIdentity(input));
    expect(resolvePluginClientIdentity({ ...input, versionless: true })).toMatchObject({
      reportedVersion: '0.0.25',
      identityKind: 'unversioned',
    });
  });

  it('渠道读取器读的是 app.getVersion()，不是任何硬编码值', () => {
    for (const edition of PLUGIN_EDITIONS) {
      expect(pluginClientVersionReader(edition)()).toBe(app.getVersion());
      expect(readPluginClientIdentity(edition).versionSpace).toBe(
        resolvePluginClientIdentity({ edition, appVersion: '1.2.3' }).versionSpace,
      );
    }
  });
});

describe('dev 上报版本覆盖（XDT_PLUGIN_CLIENT_VERSION：仅非打包生效）', () => {
  it('非打包 + 合法覆盖 ⇒ 上报覆盖值且 identityKind = versioned', () => {
    // 缺陷机制：dev 的 0.0.0 被判成 versionless、市场无条件放行（最宽投影）；覆盖成
    // 真实 0.0.x 才等于"用发布版的判定输入"（RFC §2④／§6.1）。
    const override = applyDevPluginIdentityOverride({
      appVersion: '0.0.0',
      isPackaged: false,
      overrideRaw: '0.0.25',
    });
    expect(override).toEqual({ reportedVersion: '0.0.25', source: 'dev-override' });
    expect(
      resolvePluginClientIdentity({ edition: 'meka', appVersion: override.reportedVersion }),
    ).toEqual({
      edition: 'meka',
      versionSpace: 'cindy-meka',
      header: CINDY_CLIENT_VERSION_HEADER,
      reportedVersion: '0.0.25',
      identityKind: 'versioned',
    });
  });

  it('非打包 + 未设覆盖 ⇒ 仍是 app.getVersion()（0.0.0 ⇒ unversioned，行为不变）', () => {
    expect(
      applyDevPluginIdentityOverride({
        appVersion: '0.0.0',
        isPackaged: false,
        overrideRaw: undefined,
      }),
    ).toEqual({ reportedVersion: '0.0.0', source: 'app-version' });
    expect(resolvePluginClientIdentity({ edition: 'meka', appVersion: '0.0.0' }).identityKind).toBe(
      'unversioned',
    );
    // 接线层同样不引入覆盖：未设开关时身份与直接解析 app.getVersion() 逐字段相同。
    expect(readPluginClientIdentity('meka')).toEqual(
      resolvePluginClientIdentity({ edition: 'meka', appVersion: app.getVersion() }),
    );
  });

  it('打包 + 设了覆盖 ⇒ 忽略覆盖（连非法值也忽略，生产路径不读该开关）', () => {
    // 用纯函数的 isPackaged 入参断言，不依赖真实 Electron / 打包产物。
    for (const overrideRaw of ['0.0.25', '', 'not-a-version', '0.0.0']) {
      expect(
        applyDevPluginIdentityOverride({ appVersion: '0.0.30', isPackaged: true, overrideRaw }),
      ).toEqual({ reportedVersion: '0.0.30', source: 'app-version' });
    }
  });

  it('非打包 + 非法值 ⇒ 抛错（含空值；不许静默回退成 0.0.0）', () => {
    for (const overrideRaw of ['not-a-version', 'v0.0.25', '0.0', '0.0.25.1', '', '  ']) {
      expect(() =>
        applyDevPluginIdentityOverride({ appVersion: '0.0.0', isPackaged: false, overrideRaw }),
      ).toThrow(PLUGIN_CLIENT_VERSION_OVERRIDE_ENV);
    }
  });

  it('非打包 + versionless 哨兵 ⇒ 抛错（传哨兵等于没开）', () => {
    for (const overrideRaw of ['0.0.0', '0.0.0-dev.1']) {
      expect(() =>
        applyDevPluginIdentityOverride({ appVersion: '0.0.0', isPackaged: false, overrideRaw }),
      ).toThrow(/哨兵|versionless/);
    }
  });

  it('接线：非打包下 readPluginClientIdentity / 读取器上报覆盖值，且不改 app.getVersion()', () => {
    // electron-stub 没有 app.isPackaged（= undefined，非打包路径），这是本用例成立的前提；
    // 若将来 stub 改成 isPackaged: true，这条断言会先红，提示改用纯函数入参。
    expect(Boolean(app.isPackaged)).toBe(false);
    const appVersion = app.getVersion();
    vi.stubEnv(PLUGIN_CLIENT_VERSION_OVERRIDE_ENV, '0.0.25');

    expect(readPluginClientIdentity('meka')).toMatchObject({
      reportedVersion: '0.0.25',
      identityKind: 'versioned',
    });
    expect(pluginClientVersionReader('cindy')()).toBe('0.0.25');
    // 覆盖只改写"上报给市场的版本"：版本号本身、更新器、日志与 UI 都拿 app.getVersion()。
    expect(app.getVersion()).toBe(appVersion);
  });
});
