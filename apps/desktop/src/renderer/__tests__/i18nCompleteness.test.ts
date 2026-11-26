/**
 * i18nCompleteness.test.ts —— 静态 i18n 完整性闸门(规则 18 的自动化兜底)。
 *
 * 背景:`fallbackLng = 'en'`,某 key 在某语言缺失会**静默回退英文、不报错**;若连 en 都缺,
 * 则直接渲染裸 key 字符串。开发期几乎发现不了,只有对应语言用户撞见——历史上只能靠人逐语言
 * 点界面排查(device-link 这轮就漏了 `settings.remoteControl.*` / `settings.imBot.*` 等整批)。
 * 本测试把"扫源码里用到的 key 是否 4 语言齐全"自动化,让这类遗漏在 CI 里红,而非靠人测。
 *
 * 判定:
 *  - 只看**静态字面量** `t('a.b.c')`(模板字面量 t(`a.${x}`) 无法静态解析 → 跳过,见末尾统计)。
 *  - 带**内联默认值**的 key 跳过(`t('k','默认')` 位置参 或 `t('k',{ defaultValue })`):
 *    这类有默认渲染,缺 key 不是可见 bug,作者有意为之。
 *  - 复数感知:i18next 用 `key_one`/`key_other` 等;`a.b` 视为命中当 `a.b` 或 `a.b_<复数后缀>` 存在。
 *  - KNOWN_MISSING:**与 device-link 无关的既有遗漏**,记录在案不阻断本轮;修一条删一条。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { glob } from 'node:fs/promises';

const RENDERER = resolve(__dirname, '..');
const LOCALES_DIR = resolve(RENDERER, 'i18n', 'locales');

const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'] as const;

/**
 * 既有 i18n 债务(**非本分支 device-link 引入**,owner 文件未在本次改动集内)。
 * 记录在案以免阻断 device-link 工作;后续按文件 owner 逐条补齐后从这里删除。
 */
const KNOWN_MISSING: ReadonlySet<string> = new Set([
]);

function loadLocales(): Record<string, unknown>[] {
  const dirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  return dirs.map(
    (d) =>
      JSON.parse(readFileSync(resolve(LOCALES_DIR, d, 'common.json'), 'utf8')) as Record<
        string,
        unknown
      >,
  );
}

function localeNames(): string[] {
  return readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** 复数感知的 key 存在性判定。 */
function present(tree: Record<string, unknown>, key: string): boolean {
  const parts = key.split('.');
  let cur: unknown = tree;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      // 末段可能是复数:在父对象里找 leaf_<suffix>
      const parent = parts.slice(0, -1);
      const leaf = parts[parts.length - 1];
      let pc: unknown = tree;
      for (const pp of parent) {
        if (pc && typeof pc === 'object' && pp in (pc as Record<string, unknown>)) {
          pc = (pc as Record<string, unknown>)[pp];
        } else {
          return false;
        }
      }
      if (pc && typeof pc === 'object') {
        return PLURAL_SUFFIXES.some((suf) => leaf + suf in (pc as Record<string, unknown>));
      }
      return false;
    }
  }
  return cur !== undefined;
}

interface Scan {
  used: Set<string>;
  withDefault: Set<string>;
  templateCount: number;
}

// A literal prefix followed by concatenation is not a complete static key.
const STATIC_KEY_RE = /\bt\(\s*['"]([A-Za-z0-9_][A-Za-z0-9_.]*)['"]\s*(?=[,)])/g;

function scanText(txt: string): Scan {
  const used = new Set<string>();
  const withDefault = new Set<string>();
  let templateCount = 0;

  // 位置参默认:t('k', '默认')
  const posDefaultRe = /\bt\(\s*['"]([A-Za-z0-9_][A-Za-z0-9_.]*)['"]\s*,\s*['"]/g;
  // 选项默认:t('k', { ... defaultValue ... })
  const optDefaultRe = /\bt\(\s*['"]([A-Za-z0-9_][A-Za-z0-9_.]*)['"]\s*,\s*\{[^}]*defaultValue/g;
  const templateRe = /\bt\(\s*`/g;

  for (const m of txt.matchAll(STATIC_KEY_RE)) used.add(m[1]);
  for (const m of txt.matchAll(posDefaultRe)) withDefault.add(m[1]);
  for (const m of txt.matchAll(optDefaultRe)) withDefault.add(m[1]);
  templateCount += [...txt.matchAll(templateRe)].length;
  return { used, withDefault, templateCount };
}

async function scanSource(): Promise<Scan> {
  const result: Scan = { used: new Set(), withDefault: new Set(), templateCount: 0 };
  for await (const entry of glob('**/*.{ts,tsx}', { cwd: RENDERER })) {
    if (entry.includes('__tests__') || entry.startsWith('i18n/')) continue;
    const scan = scanText(readFileSync(resolve(RENDERER, entry), 'utf8'));
    for (const key of scan.used) result.used.add(key);
    for (const key of scan.withDefault) result.withDefault.add(key);
    result.templateCount += scan.templateCount;
  }
  return result;
}

describe('static translation key scanner', () => {
  it('does not treat a dynamic concatenation prefix as a complete key', () => {
    const scan = scanText(`
      t('cindyMake.code.phases.' + phase);
      t("settings.cindyMake.tasks." + action + 'Confirm', { count });
      t('settings.cindyMake.tasks.status.'
        + statusOf(selected, taskAction));
      t('cindyMake.source.errors.' + code, 'Fallback');
      t('cindyMakeDoctor.checks.' + check.id, { defaultValue: 'Fallback' });
    `);
    expect([...scan.used]).toEqual([]);
    expect([...scan.withDefault]).toEqual([]);
  });

  it('retains complete static keys, options and inline defaults', () => {
    const scan = scanText(`
      t('missing.key');
      t("plural.key", { count });
      t('positional.key', 'Fallback');
      t('options.key', { count, defaultValue: 'Fallback' });
    `);
    expect([...scan.used]).toEqual([
      'missing.key', 'plural.key', 'positional.key', 'options.key',
    ]);
    expect([...scan.withDefault]).toEqual(['positional.key', 'options.key']);
    expect(present({}, 'missing.key')).toBe(false);
  });
});

describe('i18n completeness (static keys present in all locales)', () => {
  it('checks complete literal keys without treating dynamic prefixes as keys', () => {
    const source = `t('static.key'); t("static.options", { count: 2 });
      t('dynamic.' + phase); t('multiline.'
 + status);`;
    expect([...source.matchAll(STATIC_KEY_RE)].map(match => match[1]))
      .toEqual(['static.key', 'static.options']);
  });

  it('every static t() key (no inline default) exists in all supported locales', async () => {
    const locales = localeNames();
    const trees = loadLocales();
    expect(locales.length).toBeGreaterThanOrEqual(5); // zh-CN / zh-TW / en / ja / ko

    const { used, withDefault, templateCount } = await scanSource();

    const required = [...used].filter((k) => !withDefault.has(k) && !KNOWN_MISSING.has(k));

    const failures: string[] = [];
    for (const key of required) {
      const missingIn = locales.filter((_, i) => !present(trees[i], key));
      if (missingIn.length > 0) failures.push(`${key} → missing in [${missingIn.join(', ')}]`);
    }

    // 诊断信息(失败时打印),便于一次看清缺口。
    if (failures.length > 0) {
      console.error(
        `i18n gaps (${failures.length}); scanned ${used.size} static keys, ` +
          `${withDefault.size} with inline default skipped, ${templateCount} template t(\`...\`) sites unresolved:\n` +
          failures.join('\n'),
      );
    }
    expect(failures).toEqual([]);
  });

  it('KNOWN_MISSING stays minimal and only holds genuinely-absent keys (no stale entries)', async () => {
    // 防 allowlist 腐化:若某 KNOWN_MISSING key 已在所有语言补齐,应从名单删除。
    const trees = loadLocales();
    const stale = [...KNOWN_MISSING].filter((k) => trees.every((t) => present(t, k)));
    expect(stale).toEqual([]);
  });
});

/**
 * 本批 i18n 收敛的事实（Wave 2 → 第三轮）：删掉的冗余 key 必须在 12 个 locale 里同时消失，
 * 「远端 / 那台电脑」这类混用不能再回到 PSB 远程工作区文案里。
 *
 * 只锚定 `remoteWorkspace` 子树：SSH / MCPRouter / 设备互联的「远端」是别的概念，
 * 不在本测试范围（也不要为了过测试去改它们）。
 */
const DELETED_REMOTE_WORKSPACE_KEYS = [
  'remoteWorkspace.vcs.confirm.description',
  'remoteWorkspace.vcs.refresh',
  'remoteWorkspace.session.stream',
] as const;

function remoteWorkspaceTree(locale: string): Record<string, unknown> {
  const tree = JSON.parse(readFileSync(resolve(LOCALES_DIR, locale, 'common.json'), 'utf8')) as {
    remoteWorkspace?: Record<string, unknown>;
  };
  return tree.remoteWorkspace ?? {};
}

function flattenStrings(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenStrings(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('PSB 远程工作区文案收敛（死 key / 术语）', () => {
  it('已删除的冗余 key 在 12 个 locale 里 0 存在（不留半张 key 表）', () => {
    const stillPresent = localeNames().filter((locale) => {
      const workspace = remoteWorkspaceTree(locale);
      return DELETED_REMOTE_WORKSPACE_KEYS.some((key) => present(workspace, key));
    });
    expect(stillPresent, `这些 locale 仍保留了已删除的 key`).toEqual([]);
  });

  it('zh-CN 远程工作区文案统一用「远程」，不再混入「远端」', () => {
    const leftovers = flattenStrings(remoteWorkspaceTree('zh-CN')).filter(([, value]) =>
      value.includes('远端'),
    );
    expect(leftovers, '「远端」与已裁决的「远程」术语混用').toEqual([]);
  });

  it('串流不支持的说明不再同时指「这台电脑」与「那台电脑」', () => {
    for (const locale of ['zh-CN', 'zh-TW']) {
      const value = flattenStrings(remoteWorkspaceTree(locale)).find(
        ([key]) => key === 'session.streamUnsupported',
      )?.[1];
      expect(typeof value, `${locale} 缺 session.streamUnsupported`).toBe('string');
      expect(value).not.toMatch(/那台(电脑|電腦)/);
      expect(value).toMatch(/这台|這台/);
    }
  });
});
