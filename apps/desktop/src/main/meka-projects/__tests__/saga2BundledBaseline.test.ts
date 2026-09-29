/**
 * 随包出厂基线 `apps/desktop/resources/meka/projects/saga2/project.json` 的机械守卫。
 *
 * 这份 JSON 不是普通资源：`metadata[]` 的每一条都会以「作用范围 | 绝对路径 | 用途」的行形态进入
 * 模型上下文（order 65 段，`meka-injection/mekaPrompts.ts:55-72`），而 `sourcePath` / `itemType` /
 * `rootPath` 同时是运行期的去重键（`runtimeConfig.ts:94-98`），重扫还会原样保留人工策展字段
 * （`metadataScanner.ts:28-45`）。所以"基线写坏了"在这里**不会当场报错**，只会静默地改变注入内容
 * 或悄悄丢掉一条人工决定。
 *
 * 三道已经真实发生过的坑就是本文件的全部动机
 * （`docs/product-rules/meka-project-metadata-governance.md` §4/§5，第 79 行点名了本文件）：
 *
 * 1. **基线 JSON 非法（已发生）**：一次性重写基线写出尾随逗号，PowerShell 的 `ConvertFrom-Json`
 *    接受它、Node/Electron 的 `JSON.parse` 拒绝 ⇒ 31 个单测变红。根因是拿宽容解析器当校验器，
 *    因此断言 1 只走 `JSON.parse`，其余断言全部建立在它之上。
 * 2. **禁用必须留痕**：`enabled: false` 是全量开关（`includeAllProjectMetadata`）唯一盖不住的逐条
 *    例外（`runtimeConfig.ts:166`），且会被重扫永久保留（`metadataScanner.ts:42` 的
 *    `enabled: old?.enabled ?? true`）⇒ 一个禁用决定**不会自己消失**。没有 `notes` 的禁用，等于把
 *    "为什么这条不在提示里 / 权威副本在哪"永久留给后来人；`notes` 不进 prompt，正是留痕的地方。
 * 3. **`basic.path` 必须保持项目 id token**：写成绝对路径会把出厂基线绑死到一台机器
 *    （真实根来自 Meka 设置的 `p4RootPath`）。
 *
 * 取舍：
 * - **只读真实随包文件，不造夹具**：夹具验的是解析器与机制，验不了"随包里到底写了什么"。
 * - **不断言 `metadata` 的条数**：项目新增文件是正常演进，条数不是不变量（只要求非空）。
 * - **不做整文件快照**：快照会把每次正常策展都变成红灯，且失败信息说不出是哪一条错了。
 * - 本文件不 import 运行期解析（`runtimeConfig.ts` 会拉起 db / electron 侧依赖），只做静态字段守卫。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { MekaProjectFile, MekaProjectRoleDefaults } from '../../../shared/meka-projects.js';
import { resolveMekaResourcesRoot } from '../resourcePaths.js';

/** `apps/desktop`（本文件位于 `apps/desktop/src/main/meka-projects/__tests__/`）。 */
const desktopRoot = path.resolve(__dirname, '../../../..');

/**
 * 随包基线的绝对路径，按**生产的解析规则**拼出来：`resourcePaths.ts:17-22` 的
 * `resolveMekaResourcesRoot`（非打包构建读 `<appPath>/resources/meka`）之后接
 * `<root>/projects/<projectId>/project.json`（`projectConfig.ts:437-443` 的 `bundledProjectFilePath`）。
 *
 * 两点刻意的选择：
 * - **不调 `bundledMekaProjectsRoot()`**：它取 `app.getAppPath()`，而单测里的 electron 被
 *   `apps/desktop/vitest.config.ts:59` 换成 `src/test/vitest/electron-stub.ts`，其 `getAppPath()`
 *   返回 `process.cwd()` ⇒ 路径会随调用方 cwd 漂移。这里把 `appPath` 换成本文件位置推出的
 *   `apps/desktop`：走的仍是同一个生产函数，结果与 cwd 无关，也不硬编码本机绝对路径
 *   （同目录 `resourcePaths.test.ts:5` 同样直接 import 这个函数）。
 * - `resourcesPath` 传空串：非打包分支根本不读它，填一个产物路径反而会误导读者。
 */
const bundledProjectPath = path.join(
  resolveMekaResourcesRoot({ appIsPackaged: false, appPath: desktopRoot, resourcesPath: '' }),
  'projects',
  'saga2',
  'project.json',
);

/**
 * `runtimeConfig.ts:43` 的 `PROJECT_REFERENCE_DESCRIPTION_MAX`（模块私有常量，只能在此重述）。
 * 运行期按**码点**截断：超过它就只剩前 297 个码点 + `...`（`runtimeConfig.ts:455-459`），
 * 也就是说第 298 个码点之后写什么都没人看得到。
 */
const DESCRIPTION_MAX_CODE_POINTS = 300;

/** `runtimeConfig.ts:913-921` 的穷尽性校验口径：只有这四种 itemType，多一种就会让会话解析抛错。 */
const ITEM_TYPES = ['agents-md', 'rule', 'skill', 'mcp'] as const;

/** 扫描期写入的内容指纹形态：`metadataScanner.ts:416` 的 sha256 小写 hex。 */
const CONTENT_FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/**
 * 注入行 `- <scope> | <path> | <用途>`（`mekaPrompts.ts:64-69`）里的非法字符。
 *
 * `|` 会把一个描述劈成两个字段（该行是位置解析的），反引号会破坏 Markdown 代码段；换行/回车在
 * 运行期会被 `\s+` → 空格 折叠掉（`runtimeConfig.ts:455`），严格说不会破坏行格式，但字段本身
 * 应当是单行文本——多行值会让"≤300 码点"的人工核对与真实注入长度对不上。
 */
const FORBIDDEN_DESCRIPTION_CHARS = ['\n', '\r', '|', '`'] as const;

/**
 * 条目的运行期身份：与 `runtimeConfig.ts:94-98`（`\0` 分隔）是同一个三元组，
 * 也是 `metadataScanner.ts:30,37` 重扫保留用的键（此处写成 `|` 分隔，与该处逐字一致）。
 */
function entryKey(entry: { rootPath?: string; sourcePath?: string; itemType?: string }): string {
  return `${entry.rootPath ?? ''}|${entry.sourcePath}|${entry.itemType}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** 报错位置之上最近的一条 `sourcePath`：把 "position 12345" 翻译成"哪一条写坏了"。 */
function nearestSourcePath(text: string, offset: number): string | null {
  const matches = [...text.slice(0, offset).matchAll(/"sourcePath"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
  return matches.at(-1)?.[1] ?? null;
}

let cachedText: string | null = null;

/**
 * 读随包基线原文（只读一次），并与生产读取侧同口径地剥掉 UTF-8 BOM
 * （`projectConfig.ts:458-461` 的 `readJson`）。PS 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
 * 而生产的读取侧容忍它 ⇒ 这里照做，避免把生产能读的文件判死。
 */
function bundledBaselineText(): string {
  if (cachedText !== null) return cachedText;
  const raw = readFileSync(bundledProjectPath, 'utf8');
  cachedText = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  return cachedText;
}

/**
 * **严格**解析随包基线。必须用 `JSON.parse`：宽容解析器（PowerShell 的 `ConvertFrom-Json`）会
 * 接受尾随逗号，而那正是那次 31 个单测变红事故的根因。
 *
 * 失败信息里补上出错行原文与最近的 `sourcePath`：`JSON.parse` 只报 "position N"，而一份 66 条的
 * 清单里真正需要知道的是**哪一条**写坏了。
 */
function loadBundledBaseline(): MekaProjectFile {
  const text = bundledBaselineText();
  try {
    return JSON.parse(text) as MekaProjectFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const offset = Number(/position (\d+)/.exec(message)?.[1]);
    const hasOffset = Number.isFinite(offset);
    const lines = text.split('\n');
    const lineNumber = hasOffset ? text.slice(0, offset).split('\n').length : null;
    const lineText = lineNumber === null ? null : lines[lineNumber - 1]?.trim();
    const owner = hasOffset ? nearestSourcePath(text, offset) : null;
    throw new Error(
      [
        `随包基线不是严格 JSON（${bundledProjectPath}）：${message}`,
        lineNumber === null ? null : `出错行 ${lineNumber}: ${lineText}`,
        owner === null ? null : `该位置之前最近的 sourcePath: ${owner}`,
        '注意：PowerShell 的 ConvertFrom-Json 容忍尾随逗号，只有 JSON.parse 拦得住这类错误。',
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    );
  }
}

/**
 * 条目级断言共用的入口：`metadata` 必须先被证明是数组，否则 `for (... of ...)` 抛的是
 * "is not iterable" 这种说不清契约的 TypeError。`expect` 失败即抛，因此下面的回落分支不可达。
 */
function baselineMetadata(): MekaProjectFile['metadata'] {
  const { metadata } = loadBundledBaseline();
  expect(Array.isArray(metadata), '随包基线的 metadata 必须是数组').toBe(true);
  return Array.isArray(metadata) ? metadata : [];
}

describe('bundled SAGA2 project baseline', () => {
  it('parses as strict JSON, naming the offending entry when it does not', () => {
    // 解析失败会带着「出错行原文 + 最近的 sourcePath」抛出（见 loadBundledBaseline）：
    // 那次事故的根因是用宽容解析器当校验器，只有 JSON.parse 拦得住尾随逗号一类的错误。
    const file = loadBundledBaseline();

    // 解析成功还不够：顶层必须是对象。`null` / 数组 / 字符串都是**合法 JSON**，但都不是清单，
    // 必须在第一条就报清楚，而不是让后面每条用例以各自难懂的方式失败。
    expect(typeof file).toBe('object');
    expect(file).not.toBeNull();
    expect(Array.isArray(file), '随包基线的顶层必须是对象，不是数组').toBe(false);
  });

  it('declares schemaVersion 1, projectId saga2 and a non-empty metadata list', () => {
    const file = loadBundledBaseline();

    // 头部写坏是**硬失败**、不是静默降级：`projectConfig.ts:636-647` 读随包文件时没有任何 try/catch
    // （`:653-677` 的容错只保护用户项目文件，且以 `base` 已经算出来为前提），而
    // `normalizeMekaProjectFile` 对 `schemaVersion !== 1` 抛 'invalid project file header'
    // （`:235`）、对 projectId 不符抛 'projectId mismatch'（`:238`）⇒ 内置 SAGA2 项目的面板读取与
    // 全部角色解析会一起失败。这条断言把这个失败挪到 CI，而不是留给用户去撞。
    expect(file.schemaVersion).toBe(1);
    expect(file.projectId).toBe('saga2');
    expect(Array.isArray(file.metadata)).toBe(true);
    // 条数不作断言（新增文件是正常演进），但**空清单**意味着全量展开之后模型一条项目参考都看不到，
    // 而这不会有任何报错。
    expect(file.metadata.length).toBeGreaterThan(0);
  });

  it('keeps basic.path as the saga2 project-id token, never an absolute path', () => {
    const basicPath = loadBundledBaseline().basic?.path ?? '';

    expect(
      basicPath,
      `basic.path 必须保持项目 id token 'saga2'，实际是 ${JSON.stringify(basicPath)}`,
    ).toBe('saga2');
    // 负向断言独立成立：即便将来 token 改名，也不得变成机器绝对路径 —— 那会把出厂基线绑死到一台
    // 机器，别人的会话会去解析一个不存在的目录（真实根来自 Meka 设置的 p4RootPath）。
    expect(basicPath.startsWith('/'), 'basic.path 不得是 POSIX 绝对路径').toBe(false);
    expect(/^[A-Za-z]:[\\/]/.test(basicPath), 'basic.path 不得是盘符绝对路径').toBe(false);
    expect(/^\\\\/.test(basicPath), 'basic.path 不得是 UNC 路径').toBe(false);
  });

  it('gives every metadata entry a complete, normalized shape', () => {
    const metadata = baselineMetadata();
    const violations: string[] = [];

    for (const entry of metadata) {
      const label = `[${entryKey(entry)}]`;

      if (!isNonEmptyString(entry.sourcePath)) {
        violations.push(`${label} sourcePath 必须是非空字符串`);
      } else {
        // 条目身份是「相对项目根的 POSIX 路径」：反斜杠在 POSIX 上不是分隔符，`..` 段则意味着
        // 越出项目根（`runtimeConfig.ts:927-940` 对 `..` 逃逸任何来源都抛错）。
        if (entry.sourcePath.includes('\\')) {
          violations.push(`${label} sourcePath 含反斜杠，必须是 POSIX 相对路径`);
        }
        if (entry.sourcePath.split('/').includes('..')) {
          violations.push(`${label} sourcePath 含 '..' 段（路径逃逸）`);
        }
      }
      if (!ITEM_TYPES.includes(entry.itemType)) {
        violations.push(
          `${label} itemType ${JSON.stringify(entry.itemType)} 不在 ${ITEM_TYPES.join(' / ')} 内`,
        );
      }
      if (!isNonEmptyString(entry.name)) {
        violations.push(`${label} name 必须是非空字符串`);
      }
      if (!CONTENT_FINGERPRINT_RE.test(String(entry.contentFingerprint))) {
        // 指纹是「正文是否变过」的判据，而且会被面板原样回写进用户项目文件
        // （`MekaProjectRoleEditorRoute.tsx:233`），形状坏了没有任何地方会校验。
        violations.push(
          `${label} contentFingerprint ${JSON.stringify(
            entry.contentFingerprint,
          )} 不是 64 位小写 sha256 hex`,
        );
      }
      if (!isNonEmptyString(entry.displayName)) {
        violations.push(`${label} displayName 必须是非空字符串`);
      }
      if (!isNonEmptyString(entry.description)) {
        // 描述缺失时运行期会回落到 `sourcePath` 当描述（`runtimeConfig.ts:446-454`）：
        // 注入行最终变成"路径 | 路径"，模型看不出这份文档该用来干什么。
        violations.push(`${label} description 必须是非空字符串`);
      }
      if (typeof entry.enabled !== 'boolean') {
        // 写成 `'false'` / `0` 这类"看起来像禁用"的值不会命中运行期的 `=== false` 判断
        // （`runtimeConfig.ts:166`、`:907`）⇒ 作者以为按住了，实际照旧注入，且无人报错。
        violations.push(`${label} enabled 必须是 boolean，实际是 ${typeof entry.enabled}`);
      }
      if (entry.subProjectPath !== null && typeof entry.subProjectPath !== 'string') {
        violations.push(`${label} subProjectPath 必须是 null 或字符串`);
      }
      // `rootPath` 是可选的「附加根」覆盖。它一旦写成绝对路径（尤其写死某台机器的 P4 根），
      // 该项在全量展开时就会撞上 root 白名单失配，而**只由 `includeAllProjectMetadata` 展开来的项
      // 是 warn + 跳过的**（`runtimeConfig.ts:927-940`）⇒ 注入清单里**无声少一条**，面板也照旧显示。
      // 随包基线的条目一律相对项目根解析，因此这里只允许缺省或空。
      if (entry.rootPath !== undefined && entry.rootPath !== null && entry.rootPath !== '') {
        violations.push(
          `${label} rootPath ${JSON.stringify(entry.rootPath)} 必须缺省/空（写绝对路径会让该项在全量展开时被静默跳过）`,
        );
      }
    }

    // 一次报全部违规条目：逐条 expect 会变成"修一条、跑一次"，而这是一份数十条的人工策展清单。
    expect(violations, `随包基线有条目字段不合法:\n${violations.join('\n')}`).toEqual([]);
  });

  it('keys every entry by rootPath|sourcePath|itemType without duplicates', () => {
    const metadata = baselineMetadata();
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const entry of metadata) {
      const key = entryKey(entry);
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }

    // 等价说法：`new Set(keys).size === metadata.length`。重复键的危害不是"面板多一行"：
    // `runtimeConfig.ts:803` 与 `metadataScanner.ts:28-37` 都用这个三元组建 Map ⇒ 后一条**覆盖**
    // 前一条；重扫按同一个键写回 notes / enabled 时，两行共用一份策展字段，
    // `enabled: false` 这类人工决定会静默地落到错误的行上。
    expect(
      duplicates,
      `随包基线存在重复条目键（同一 rootPath|sourcePath|itemType）:\n${duplicates.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps every description inside the injected-line contract', () => {
    const metadata = baselineMetadata();
    const violations: string[] = [];

    for (const entry of metadata) {
      const description = entry.description;
      // 空/缺失的描述由上面的字段完整性用例点名，这里只管"有内容但内容有害"。
      if (typeof description !== 'string') continue;

      const length = [...description].length;
      if (length > DESCRIPTION_MAX_CODE_POINTS) {
        violations.push(
          `${entryKey(entry)} description 长度 ${length} 码点 > ${DESCRIPTION_MAX_CODE_POINTS}，` +
            '超出的部分在运行期被截断（=死文本）',
        );
      }
      for (const forbidden of FORBIDDEN_DESCRIPTION_CHARS) {
        const index = description.indexOf(forbidden);
        if (index >= 0) {
          violations.push(
            `${entryKey(entry)} description 长度 ${length} 码点，位置 ${index} 含非法字符 ` +
              JSON.stringify(forbidden),
          );
        }
      }
    }

    expect(violations, `随包基线 description 违反注入文本契约:\n${violations.join('\n')}`).toEqual(
      [],
    );
  });

  it('records a non-empty notes reason for every disabled entry', () => {
    const metadata = baselineMetadata();
    const silent = metadata
      .filter((entry) => entry.enabled === false && !isNonEmptyString(entry.notes))
      .map((entry) => entryKey(entry));

    // 只对 `enabled === false` 要求 notes：启用中的条目**不需要** notes，
    // 更不要求条目里必须存在禁用项（今天有 5 条，全都写了理由；一条都没有也是合法的）。
    expect(
      silent,
      `禁用条目没有在 notes 里留痕（为什么禁用 + 权威副本在哪）:\n${silent.join('\n')}`,
    ).toEqual([]);
  });

  it('resolves roleDefaults.projectMetadataSelection against metadata and keeps mcp an array', () => {
    const file = loadBundledBaseline();
    const metadata = baselineMetadata();
    const roleDefaults: MekaProjectRoleDefaults = file.roleDefaults ?? {};

    // `mcp` 只断言"是数组"：当前为空是**值**不是不变量，将来加一项是合法的（顺序同理）。
    expect(Array.isArray(roleDefaults.mcp), 'roleDefaults.mcp 必须是数组').toBe(true);
    expect(
      Array.isArray(roleDefaults.projectMetadataSelection),
      'roleDefaults.projectMetadataSelection 必须是数组',
    ).toBe(true);
    const selection = Array.isArray(roleDefaults.projectMetadataSelection)
      ? roleDefaults.projectMetadataSelection
      : [];

    const knownKeys = new Set(metadata.map((entry) => entryKey(entry)));
    const problems: string[] = [];
    for (const item of selection) {
      if (!isNonEmptyString(item.sourcePath)) {
        problems.push(`${entryKey(item)} 缺 sourcePath`);
        continue;
      }
      if (!ITEM_TYPES.includes(item.itemType)) {
        problems.push(`${entryKey(item)} 的 itemType ${JSON.stringify(item.itemType)} 不合法`);
        continue;
      }
      // 悬空引用的危害：`roleDefaults` 的选择在运行期被当成**作者显式选择**（fail-closed，
      // `runtimeConfig.ts:791-793`、`:1004-1006`），但它已经没有任何 metadata 行可以承载
      // description / notes / displayName ⇒ 注入行退化成只剩路径，面板里也没有对应行可改；
      // 若该文件路径同时不合契约，还会让该项目**所有新建会话**解析失败。
      if (!knownKeys.has(entryKey(item))) {
        problems.push(`${entryKey(item)} 在 metadata 里找不到对应条目（悬空引用）`);
      }
    }

    expect(
      problems,
      `roleDefaults.projectMetadataSelection 悬空或字段不合法:\n${problems.join('\n')}`,
    ).toEqual([]);
  });
});
