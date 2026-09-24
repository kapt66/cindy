/**
 * 随包资源「声明集合 vs 运行期读点集合」一致性门禁(纯静态断言)。
 *
 * 为什么需要它:本仓反复出现一类**静默**缺陷——运行期读的随包资源没被
 * `forge.config.ts` 的 `extraResourcesForTarget()` 声明进产物,构建期没有任何
 * 校验;读不到时上层把它当空/当缺省处理,于是整条能力静默消失、无人报错。
 * 既有 `forge-meka-resources.ts` 的 `assertMekaResourceTree` /
 * `assertPackagedMekaResources` 只校验**写死的** `resources/meka` 一棵树
 * (存在 + 非空 + 全为普通文件 + 产物逐文件 SHA-256 一致),它没有任何机制把
 * 「运行期资源读点集合」与「extraResource 声明集合」对齐——这正是本门禁补的缺口。
 *
 * 为什么必须落在单测层:`.github/workflows/ci.yml` 的 client-ci **完全没有打包
 * 步骤**,上面那两个 assert 只在本地 `electron-forge make` 时跑,所以「CI 绿」不等于
 * 「资源声明完整」。本文件只读源码/配置**文本**,不启动 Electron、不打包、不联网、
 * 不依赖本机绝对路径、不依赖打包产物存在,因此能在 CI 作为普通单测跑。
 *
 * 抽取方式与局限(取舍):两侧都做**词法级**模式匹配,不做类型求值、不解析常量、
 * 不 import forge.config(该模块在 import 期会跑 git / 解析品牌身份,不适合单测)。
 * 因此:
 *  - 声明侧:只认 `extraResourcesForTarget()` **函数体**里的字面量,函数体外的
 *    同名字符串(注释、其它字段、文档)不参与,避免把 `builtin-ghosts` 之类
 *    在别处被提到的名字误当成声明;函数体边界用花括号配对确定,函数改名即硬失败
 *    (宁可响亮地报「抽取口径失效」,也不能静默变成空集合)。
 *  - 声明侧:模板字面量(`${...}`)与函数调用返回值不可静态求值,显式登记在
 *    `TEMPLATE_DECLARATIONS` / `RUNTIME_FUNCTION_DECLARATIONS` 并断言其形态仍在源码里。
 *  - 读点侧:覆盖 `process.resourcesPath, '<name>'`、
 *    `<x>ResourcesPath, '<name>'`、`'resources', '<name>'`、
 *    `app.getAppPath(), 'resources', '<name>'`、`'resources/<name>'` 单字符串,
 *    以及 `const root = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')`
 *    之后再 `path.join(root, '<name>')` 的间接形态。
 *  - 读点侧**抓不到**的形态(已知局限,改动这些地方时必须人工确认声明):
 *    (a) 名字藏在常量里的拼接,如 `path.join(process.resourcesPath, SOME_CONST)`
 *        (例:各 macOS native helper 的 `HELPER_RESOURCE = path.join('tools', ...)`,
 *        首段是 `tools`,恰好已被声明);
 *    (b) 数组展开,如 `path.join(resourcesPath, ...BUNDLED_ANDROID_PLATFORM_TOOLS_RESOURCE_ROOT, ...)`;
 *    (c) 只传「资源根目录」给下游解析器后再拼名字(例:`ios-simulator.ts` 把
 *        `resourceRoot` 交给 `IOSSimulatorPackagedSidecarArtifactResolver`);
 *    (d) 模板字面量名,如 ``path.join(process.resourcesPath, `${X}.exe`)``;
 *    (e) 变量名不以 `resourcesPath`/`ResourcesPath` 结尾的资源根。
 *    本门禁是「兜住一整类静默缺陷」的静态下限,不是完整证明。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';
import { describe, expect, it } from 'vitest';

/** `apps/desktop`(本文件位于 `apps/desktop/src/main/__tests__/`)。 */
const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FORGE_CONFIG_PATH = path.join(DESKTOP_DIR, 'forge.config.ts');

/** 逐级向上找仓库根(带 `.gitignore` 的那层),避免依赖 cwd 与本机绝对路径。 */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.gitignore'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`未能在 ${start} 之上找到带 .gitignore 的仓库根`);
    }
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(DESKTOP_DIR);

/**
 * 声明侧模板字面量:`` `resources/${UPDATER_EXE}` ``(forge.config.ts 的
 * `base.unshift(...)`,只影响 Windows 分支)。`UPDATER_EXE` 自身是
 * `\`${BRAND_IDENTITY.updaterName}.exe\``,取值来自品牌身份正本,故在这里显式解析。
 */
const TEMPLATE_DECLARATIONS = new Map<string, string>([
  ['resources/${UPDATER_EXE}', `resources/${BRAND_IDENTITY.updaterName}.exe`],
]);

/**
 * 声明侧「函数调用返回值」形态:`windowsUpdaterRuntimeExtraResourceForTarget(targetPlatform)`
 * 在 win32 分支返回 `resources/cindy-updater-runtime`(macOS/Linux 返回 null)。
 * 值不可静态求值,故显式登记;下面同时断言这段调用形态仍在函数体里(移除即失败)。
 */
const RUNTIME_FUNCTION_CALL_MARKER = 'windowsUpdaterRuntimeExtraResourceForTarget(targetPlatform)';
const RUNTIME_FUNCTION_DECLARATIONS = ['resources/cindy-updater-runtime'];

/**
 * 构建期 stage 的声明条目白名单:这些条目由 prePackage / 前置脚本现场生成,
 * **不在源码树里**(`.gitignore` 忽略它们),因此不能按「源码树必须存在且非空」校验。
 * 每条都必须写清**为什么**;并且下面会断言它们确实被 `.gitignore` 忽略——避免有人
 * 把「顺手补声明」的废弃路径塞进白名单蒙混过关。
 */
const BUILD_TIME_GENERATED_RESOURCES = new Map<string, string>([
  [
    'resources/cindy-source.json',
    'prePackage 的 stageCindySourceMetadata() 现场写入(git commit / 构建时间),postPackage 的 removeCindySourceMetadata() 删除;.gitignore:36-37。',
  ],
  [
    'resources/tools',
    'prePackage 现场 stage 原生/工具二进制(stageRipgrep、Android platform-tools、各 native helper 等),.gitignore:35。',
  ],
  [
    'resources/cc-manager',
    'build-remote-bundles.mjs 在 dev/package/build 前生成,.gitignore:38-39。',
  ],
  [
    'resources/pi-manager',
    'build-remote-bundles.mjs 生成(远端 pi manager bundle),.gitignore:40。',
  ],
  [
    'resources/anthropic-compat-proxy',
    'build-remote-bundles.mjs 生成,.gitignore:41。',
  ],
  [
    'resources/remote-file-service',
    'build-remote-bundles.mjs 生成,.gitignore:42。',
  ],
]);

/**
 * 非 extraResource 的「资源根」读点:命中这些名字说明读取的不是随包 extraResource,
 * 而是本体由别的机制产出/提供的路径,故不参与「必须被声明」的断言。
 */
/**
 * 「已退役、但仍被读取」的豁免位 —— **范围极窄**，登记一条必须同时满足三条：
 *   ① 该通道已被上游与本仓明确裁决退役（`.gitignore` 标注 + 设计文档登记）；
 *   ② 读取它的目的**正是观测"它不存在"这件事**（保留退役后的一次性可观测信号），
 *      而不是真的去读内容；
 *   ③ 补声明是**被禁止的**（声明它会复活废弃通道，见下一条断言），所以只能在读点侧豁免。
 *
 * 现有唯一一条 `builtin-ghosts`：随包内置插件播种已被上游退休
 * （`.gitignore:208-209`「内置插件种子已废弃(改走 plugin-store 安装)」，上游 `origin/main`
 * 同形），`cindy-brain/builtinGhostProvisioner.ts` 对「整棵种子树不在」记一次性 info
 * （每进程每父目录至多一条）——这条信号依赖读取路径继续存在才能观测到缺失；机制本身
 * 保留只用于历史已播种安装的墓碑 / 改名 / 退役对账。登记依据见
 * `docs/dev-rules/meka-whitelist-verification.md` §8.10。
 *
 * 防腐：后面的用例断言每条豁免**仍被读到**且**未被声明**；读取路径一旦删除，必须
 * 同一次改动里删掉这里的条目，否则它会退化成一个永久的盲区。
 */
const RETIRED_BUT_STILL_READ = new Map<string, string>([
  [
    'builtin-ghosts',
    '随包内置插件播种已退休(见 meka-whitelist-verification.md §8.10 与 .gitignore:208-209);'
      + '读取路径保留是为了观测「种子树整体缺失」这一设计状态并给出一次性信号，不是去读内容;'
      + '声明它属禁止项(由「声明集合不得包含废弃路径」那条断言拦下)，故只能在此豁免。',
  ],
]);

const NON_EXTRA_RESOURCE_ROOTS = new Map<string, string>([
  [
    'app.asar',
    'asar 归档本体(不是 extraResource);worklouder-codex/sdkResolver.ts 里的 resources/app.asar 更是**外部** ChatGPT/Codex 应用包内的布局,与 Cindy 的 process.resourcesPath 无关。',
  ],
  [
    'app.asar.unpacked',
    '由 packagerConfig.asar / AutoUnpackNativesPlugin 解包产出(如 native/sqlite-vec),不是 extraResource 声明项。',
  ],
]);

/**
 * 抽取口径活性探针:若这些**结构性必需**的读点从抽取结果里消失,要么是抽取正则
 * 因代码风格变化失效(守门空转),要么是读点被删——两种情况都必须人工确认后,
 * 在同一次改动里更新本列表,不能让门禁静默变成空断言。
 */
const READ_POINT_ANCHORS = ['tools', 'meka', 'drizzle', 'icon.png', 'ghost-trust.json'];

// ── 抽取:声明集合 ────────────────────────────────────────────────────────────

/**
 * 取 `extraResourcesForTarget()` 的**函数体**文本(花括号配对,不解析语义)。
 * 找不到函数头/无法配对时抛错:抽取口径失效必须响亮失败,不能退化成空集合。
 */
function extractExtraResourcesFunctionBody(forgeSource: string): string {
  const header = 'function extraResourcesForTarget(';
  const headerIndex = forgeSource.indexOf(header);
  if (headerIndex < 0) {
    throw new Error(
      `抽取口径失效:${FORGE_CONFIG_PATH} 里找不到 "${header}"。函数改名/搬走后本门禁的声明抽取需要同步更新,不能当作通过。`,
    );
  }
  const braceStart = forgeSource.indexOf('{', headerIndex);
  if (braceStart < 0) {
    throw new Error(`抽取口径失效:${header} 之后找不到函数体起始花括号。`);
  }
  let depth = 0;
  for (let i = braceStart; i < forgeSource.length; i += 1) {
    const char = forgeSource[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return forgeSource.slice(braceStart, i + 1);
    }
  }
  throw new Error(`抽取口径失效:${header} 的函数体花括号未配对。`);
}

interface DeclaredResources {
  /** 规范化后的裸资源名(去掉 `resources/` 前缀,如 `meka`、`drizzle`)。 */
  names: Set<string>;
  /** 裸名 → 源码里的声明原文(用于报错与白名单核对)。 */
  rawByLname: Map<string, string>;
  /** 函数体里出现过的模板字面量原文。 */
  templates: string[];
}

function normalizeDeclaredLiteral(literal: string): string {
  return literal.startsWith('resources/') ? literal.slice('resources/'.length) : literal;
}

function extractDeclaredResources(forgeSource: string): DeclaredResources {
  const body = extractExtraResourcesFunctionBody(forgeSource);
  const names = new Set<string>();
  const rawByLname = new Map<string, string>();

  const add = (raw: string, name: string): void => {
    names.add(name);
    if (!rawByLname.has(name)) rawByLname.set(name, raw);
  };

  for (const match of body.matchAll(/'([^']*)'/g)) {
    const literal = match[1];
    if (literal === undefined) continue;
    if (literal === 'drizzle' || literal.startsWith('resources/')) {
      add(literal, normalizeDeclaredLiteral(literal));
    }
  }

  const templates: string[] = [];
  for (const match of body.matchAll(/`([^`]*)`/g)) {
    const template = match[1];
    if (template === undefined || !template.startsWith('resources/')) continue;
    templates.push(template);
    const resolved = TEMPLATE_DECLARATIONS.get(template);
    if (resolved === undefined) {
      // 新增模板声明必须显式解析:否则它的具体名字对门禁不可见(静默缺口)。
      throw new Error(
        `未登记的模板声明 ${JSON.stringify(template)}(见 ${FORGE_CONFIG_PATH} extraResourcesForTarget)。请在 TEMPLATE_DECLARATIONS 里写明它解析成哪个具体资源名,否则该声明的存在性/读点对齐无法校验。`,
      );
    }
    add(template, normalizeDeclaredLiteral(resolved));
  }

  if (!body.includes(RUNTIME_FUNCTION_CALL_MARKER)) {
    throw new Error(
      `未找到动态声明标记 "${RUNTIME_FUNCTION_CALL_MARKER}"(见 ${FORGE_CONFIG_PATH} extraResourcesForTarget)。该调用是 win32 分支的资源声明来源,形态变了必须同步更新本门禁。`,
    );
  }
  for (const raw of RUNTIME_FUNCTION_DECLARATIONS) {
    add(raw, normalizeDeclaredLiteral(raw));
  }

  if (names.size === 0) {
    throw new Error(
      `抽取口径失效:${FORGE_CONFIG_PATH} extraResourcesForTarget() 里没有抽到任何 'resources/<name>' 声明。`,
    );
  }
  return { names, rawByLname, templates };
}

// ── 抽取:运行期读点集合 ──────────────────────────────────────────────────────

/**
 * 词法级去注释:把 `//` 与 `/* *\/` 注释内容替换为等长空白(保留换行),
 * 这样匹配下标/行号与原文件一致,且不会把文档注释里提到的资源名当成读点。
 * 局限:不做正则字面量识别;若未来出现内含未配对引号的正则字面量,可能影响
 * 引号配对。下面用 `READ_POINT_ANCHORS` 探针兜住这类退化。
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  while (i < source.length) {
    const char = source[i] ?? '';
    const next = source[i + 1] ?? '';
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (char === "'") state = 'single';
      else if (char === '"') state = 'double';
      else if (char === '`') state = 'template';
      out += char;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        out += char;
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += char === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (char === '\\') {
        out += char + next;
        i += 2;
        continue;
      }
      if (char === quote) state = 'code';
      out += char;
      i += 1;
      continue;
    }
  }
  return out;
}

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === '__tests__') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkSourceFiles(full);
    else if (/\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) yield full;
  }
}

interface ReadPoint {
  /** 裸资源名(取第一个路径段,如 `tools`)。 */
  name: string;
  /** 命中的声明原文片段(如 `tools/remote-desktop`)。 */
  raw: string;
  /** 相对 `apps/desktop` 的文件路径,正斜杠。 */
  relFile: string;
  line: number;
  /** 命中的抽取规则名,便于报错时定位口径。 */
  rule: string;
}

/**
 * 读点抽取规则。每条的用意见文件头「抽取方式与局限」。
 * `[Rr]esourcesPath` 形态要求标识符**结尾**是 ResourcesPath/resourcesPath:
 * 覆盖 `process.resourcesPath`、`resourcesPath`(参数/字段)、`options.resourcesPath`、
 * `canonicalResourcesPath` 等;不会命中 `resourcesRoot` 这类别的命名(见文件头局限)。
 */
const READ_PATH_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'resourcesPath + 字面量',
    /(?:\b[A-Za-z_$][\w$.]*)?[Rr]esourcesPath\s*(?:\?\?\s*(?:'[^']*'|"[^"]*"))?\s*,\s*'([^']+)'/g,
  ],
  ['<appPath> + \'resources\' + 字面量', /[A-Za-z_$][\w$.]*[Aa]ppPath\s*,\s*'resources'\s*,\s*'([^']+)'/g],
  ['\'resources\' + 字面量', /'resources'\s*,\s*'([^']+)'/g],
  ['\'resources/<name>\' 单字符串', /'resources\/([^']+)'/g],
];

/**
 * 资源根间接形态:`const root = <...isPackaged...> ? process.resourcesPath
 * : path.join(<appPath>, 'resources')` 之后再 `path.join(root, '<name>')`。
 * 只承认 dev 分支是 `path.join(<appPath>, 'resources')`(**以右括号收尾**)的赋值:
 * 形如 `path.join(app.getAppPath(), 'resources', 'builtin-ghosts')` 的赋值得到的是
 * **子目录**根,它的下游 `path.join(base, 'official')` 里 `official` 不是资源条目,
 * 误收会制造假报。
 */
const RESOURCES_ROOT_INDIRECTION =
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?!;)[\s\S]){0,400}?[Ii]sPackaged(?:(?!;)[\s\S]){0,400}?path\.join\([^;]*?'resources'\s*\)/g;

function collectReadPoints(): ReadPoint[] {
  const points: ReadPoint[] = [];
  const push = (name: string, raw: string, relFile: string, code: string, index: number, rule: string): void => {
    const firstSegment = raw.split('/')[0];
    if (firstSegment === undefined || firstSegment === '') return;
    points.push({
      name: firstSegment,
      raw,
      relFile,
      line: code.slice(0, index).split('\n').length,
      rule,
    });
  };

  for (const root of ['src/main', 'src/preload']) {
    for (const file of walkSourceFiles(path.join(DESKTOP_DIR, root))) {
      const original = fs.readFileSync(file, 'utf8');
      const code = stripComments(original);
      if (code.length !== original.length) {
        throw new Error(`去注释实现有 bug(长度改变):${file};本门禁的行号与命中位置都依赖等长替换。`);
      }
      const relFile = path.relative(DESKTOP_DIR, file).split(path.sep).join('/');

      for (const match of code.matchAll(RESOURCES_ROOT_INDIRECTION)) {
        const ident = match[1];
        if (ident === undefined) continue;
        const joinPattern = new RegExp(`path\\.join\\(\\s*${ident}\\s*,\\s*'([^']+)'`, 'g');
        for (const join of code.matchAll(joinPattern)) {
          const raw = join[1];
          if (raw === undefined) continue;
          push(raw.split('/')[0] ?? '', raw, relFile, code, join.index ?? 0, `资源根间接(${ident})`);
        }
      }

      for (const [rule, pattern] of READ_PATH_PATTERNS) {
        // 每次扫描用同一个 RegExp 对象需重置 lastIndex(vitest 下多次 matchAll 共享状态)。
        pattern.lastIndex = 0;
        for (const match of code.matchAll(pattern)) {
          const raw = match[1];
          if (raw === undefined) continue;
          push(raw.split('/')[0] ?? '', raw, relFile, code, match.index ?? 0, rule);
        }
      }
    }
  }
  return points;
}

// ── 抽取:.gitignore 废弃标注 ─────────────────────────────────────────────────

interface IgnoreEntry {
  pattern: string;
  line: number;
  comments: string[];
}

/** 解析 `.gitignore`:记录每条忽略规则及其**紧邻上方**的注释块(空行断开)。 */
function parseGitIgnore(source: string): IgnoreEntry[] {
  const entries: IgnoreEntry[] = [];
  let pending: string[] = [];
  source.split('\n').forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '') {
      pending = [];
      return;
    }
    if (line.startsWith('#')) {
      pending.push(line.replace(/^#+\s*/, ''));
      return;
    }
    entries.push({ pattern: line.replace(/^\/+/, ''), line: index + 1, comments: [...pending] });
    pending = [];
  });
  return entries;
}

function isDeprecatedEntry(entry: IgnoreEntry): boolean {
  return entry.comments.some((comment) => /废弃|deprecated/i.test(comment));
}

/**
 * 纯前缀/等值匹配(不支持 glob)。对「声明条目是否落在被忽略路径之下」这个用途足够:
 * 构建期生成物的忽略规则都是具体路径(如 `apps/desktop/resources/tools/`)。
 */
function ignorePatternCovers(entry: IgnoreEntry, repoRelativePath: string): boolean {
  const clean = entry.pattern.replace(/\/+$/, '');
  if (clean === '' || /[*?[\]]/.test(clean)) return false;
  return repoRelativePath === clean || repoRelativePath.startsWith(`${clean}/`);
}

const DEPRECATED_READ_HINT =
  '应改掉/退役该读取路径(不要两处都不动);若确需随包分发,必须先推翻该废弃裁决并同步 .gitignore 与本门禁,不得只补一行 extraResource。';

// ── 断言 ─────────────────────────────────────────────────────────────────────

const forgeSource = fs.readFileSync(FORGE_CONFIG_PATH, 'utf8');
const declared = extractDeclaredResources(forgeSource);
const readPoints = collectReadPoints();
const gitIgnoreSource = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
const gitIgnoreEntries = parseGitIgnore(gitIgnoreSource);

/** 声明条目 → 仓库根相对路径(如 `apps/desktop/resources/meka`)。 */
function declaredRepoRelativePath(name: string): string {
  return name === 'drizzle' ? 'apps/desktop/drizzle' : `apps/desktop/resources/${name}`;
}

/** 白名单按规范化裸名索引(声明集合里存的是裸名)。 */
const BUILD_TIME_GENERATED_BY_NAME = new Map<string, string>(
  [...BUILD_TIME_GENERATED_RESOURCES].map(([rawName, reason]) => [
    normalizeDeclaredLiteral(rawName),
    reason,
  ]),
);

function isNonEmptyEntry(absolutePath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return false;
  }
  if (stat.isFile()) return stat.size > 0;
  if (!stat.isDirectory()) return false;
  const stack = [absolutePath];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && fs.statSync(full).size > 0) return true;
    }
  }
  return false;
}

describe('随包资源声明一致性(静态门禁)', () => {
  it('抽取口径仍然接在线上(防守门空转)', () => {
    // 1) 声明集合被 ForgeConfig.extraResource 真正引用:否则声明集合再多也与产物无关。
    expect(
      /extraResource:\s*extraResourcesForTarget\(/.test(forgeSource),
      'forge.config.ts 不再以 `extraResource: extraResourcesForTarget(...)` 接线;本门禁的声明抽取随之失去意义,必须先恢复接线或同步本门禁。',
    ).toBe(true);
    // 2) 声明集合非空(抽取失效时 extractDeclaredResources 已抛错,这里是第二道)。
    expect(declared.names.size).toBeGreaterThan(0);
    // 3) 模板声明形态仍在(移除即说明声明被改动,需人工确认)。
    expect(declared.templates).toContain('resources/${UPDATER_EXE}');
    // 4) 读点抽取活性:结构性必需读点必须仍被抽到。
    const readNames = new Set(readPoints.map((point) => point.name));
    const missingAnchors = READ_POINT_ANCHORS.filter((anchor) => !readNames.has(anchor));
    expect(
      missingAnchors,
      `以下结构性必需读点未被抽到:${missingAnchors.join(', ')}。要么读点被删(需人工确认),要么抽取正则因代码风格变化失效(守门空转)——两种情况都不允许静默通过。`,
    ).toEqual([]);
    expect(readPoints.length).toBeGreaterThanOrEqual(10);
  });

  it('运行期读取的每个 resources/<name> 都必须在 extraResourcesForTarget() 里被声明', () => {
    const violations = readPoints
      .filter((point) => !declared.names.has(point.name))
      .filter((point) => !NON_EXTRA_RESOURCE_ROOTS.has(point.name))
      // 已退役但仍被读取的通道(见 RETIRED_BUT_STILL_READ):豁免"必须被声明",
      // 但由下一条用例保证它仍被读到且不得被声明。
      .filter((point) => !RETIRED_BUT_STILL_READ.has(point.name))
      .sort((left, right) => left.relFile.localeCompare(right.relFile) || left.line - right.line);

    const detail = violations.map((point) => {
      const declaredName = point.name === 'drizzle' ? 'drizzle' : `resources/${point.name}`;
      return (
        `- ${point.name} ← apps/desktop/${point.relFile}:${point.line}(规则:${point.rule},命中:${JSON.stringify(point.raw)})\n` +
        `    应在 apps/desktop/forge.config.ts 的 extraResourcesForTarget() 里声明 '${declaredName}',或改掉读取路径(改走已声明的资源)。`
      );
    });

    expect(
      violations.map((point) => point.name),
      `以下运行期读点读取的资源未被 extraResourcesForTarget() 声明——构建期不会报错,packaged 后读取静默失败:\n${detail.join('\n')}\n${DEPRECATED_READ_HINT}`,
    ).toEqual([]);
  });

  it('「已退役但仍被读取」豁免位有据可查且带防腐栏(仍被读取、且不得被声明)', () => {
    const readNames = new Set(readPoints.map((point) => point.name));
    const problems: string[] = [];
    for (const [name, reason] of RETIRED_BUT_STILL_READ) {
      if (!readNames.has(name)) {
        problems.push(
          `- ${name} 已不再被任何读点读取:读取路径若已被删除,请在本次改动里同步删除这条豁免(否则它会退化成永久盲区)。理由原文:${reason}`,
        );
      }
      if (declared.names.has(name)) {
        problems.push(
          `- ${name} 同时出现在 RETIRED_BUT_STILL_READ 与 extraResourcesForTarget() 声明里:两者互斥——声明它等于复活已退休通道。`,
        );
      }
    }
    expect(problems, `退役豁免表不成立:\n${problems.join('\n')}`).toEqual([]);
  });

  it('声明集合不得包含 .gitignore 标注废弃的路径(防「顺手补声明」复活废弃通道)', () => {
    const deprecated = gitIgnoreEntries.filter(isDeprecatedEntry);
    const revived: string[] = [];
    for (const name of declared.names) {
      const repoRelative = declaredRepoRelativePath(name);
      for (const entry of deprecated) {
        if (ignorePatternCovers(entry, repoRelative)) {
          revived.push(
            `- ${declared.rawByLname.get(name) ?? name} → ${repoRelative} 命中 .gitignore:${entry.line} 的废弃规则 ${JSON.stringify(entry.pattern)}(注释:${entry.comments.join(' ')})`,
          );
        }
      }
    }
    expect(
      revived,
      `声明集合里出现了被 .gitignore 显式忽略且已标注废弃的路径:\n${revived.join('\n')}\n这是「顺手补声明」复活废弃通道的典型形态:随包分发已废弃内容会重新引入历史私有资产/凭证。`,
    ).toEqual([]);
  });

  it('解析器自检:.gitignore 废弃标注的识别口径可用(不依赖真实文件措辞)', () => {
    // 用固定 fixture 证明解析器本身能识别「紧邻上方注释含废弃」,避免真实 .gitignore
    // 措辞变化后本门禁静默变空断言而不自知。
    const fixture = [
      '# 普通说明:构建期现场生成,不入仓',
      'apps/desktop/resources/tools/',
      '',
      '# 内置插件种子已废弃(改走 plugin-store 安装);历史克隆含私有插件与凭证,永不入仓。',
      'apps/desktop/resources/builtin-ghosts/',
      'apps/desktop/release/',
    ].join('\n');
    const parsed = parseGitIgnore(fixture);
    expect(parsed.map((entry) => entry.pattern)).toEqual([
      'apps/desktop/resources/tools/',
      'apps/desktop/resources/builtin-ghosts/',
      'apps/desktop/release/',
    ]);
    const deprecatedPatterns = parsed.filter(isDeprecatedEntry).map((entry) => entry.pattern);
    expect(deprecatedPatterns).toEqual(['apps/desktop/resources/builtin-ghosts/']);
    const ghosts = parsed.find((entry) => entry.pattern === 'apps/desktop/resources/builtin-ghosts/');
    expect(ghosts).toBeDefined();
    if (ghosts !== undefined) {
      expect(ignorePatternCovers(ghosts, 'apps/desktop/resources/builtin-ghosts')).toBe(true);
      expect(ignorePatternCovers(ghosts, 'apps/desktop/resources/builtin-ghosts/official')).toBe(true);
      expect(ignorePatternCovers(ghosts, 'apps/desktop/resources/meka')).toBe(false);
    }
  });

  it('声明集合的每个条目在源码树里真实存在且非空(构建期生成物走显式白名单)', () => {
    const problems: string[] = [];

    // 白名单必须名副其实:每条都必须真的被 .gitignore 忽略(否则「构建期生成」站不住脚,
    // 应该按源码树存在性校验)。
    for (const [rawName, reason] of BUILD_TIME_GENERATED_RESOURCES) {
      const name = normalizeDeclaredLiteral(rawName);
      if (!declared.names.has(name)) {
        problems.push(
          `- 白名单条目 ${rawName} 已不在 extraResourcesForTarget() 的声明集合里(陈旧白名单会掩盖后续缺口),请删除该白名单条目。`,
        );
        continue;
      }
      const repoRelative = declaredRepoRelativePath(name);
      const ignored = gitIgnoreEntries.some((entry) => ignorePatternCovers(entry, repoRelative));
      if (!ignored) {
        problems.push(
          `- 白名单条目 ${rawName} 并未被 .gitignore 忽略,「构建期现场生成、不在源码树」的理由不成立;若它其实入仓,请从白名单移除并按存在性校验。理由原文:${reason}`,
        );
      }
    }

    for (const name of declared.names) {
      if (BUILD_TIME_GENERATED_BY_NAME.has(name)) continue;
      const repoRelative = declaredRepoRelativePath(name);
      const absolute = path.join(REPO_ROOT, repoRelative);
      if (!fs.existsSync(absolute)) {
        problems.push(
          `- ${declared.rawByLname.get(name) ?? name} → ${repoRelative} 在源码树里不存在(声明与事实不一致:产物会缺这个资源)。若它由构建期现场生成,请加入 BUILD_TIME_GENERATED_RESOURCES 并写清理由。`,
        );
        continue;
      }
      if (!isNonEmptyEntry(absolute)) {
        problems.push(`- ${declared.rawByLname.get(name) ?? name} → ${repoRelative} 存在但为空(空目录/空文件同样会让能力静默消失)。`);
      }
    }

    expect(problems, `声明集合存在性问题:\n${problems.join('\n')}`).toEqual([]);
  });
});
