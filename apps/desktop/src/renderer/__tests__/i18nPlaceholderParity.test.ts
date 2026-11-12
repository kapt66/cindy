/**
 * i18nPlaceholderParity.test.ts —— desktop 侧「占位符名」跨语种契约门。
 *
 * ## 为什么需要这个文件
 *
 * 2026-11-06 第七轮上游同步给 7 个新语种补 Meka 英文占位时做了术语大小写归一，
 * 归一误作用到了 `{{...}}` 占位符名上：`newChat.collaboration.workerPrefix` 的
 * `{{worker}}` → `{{Worker}}`，`cindyMake.code.taskTitle` 的 `{{worktree}}` →
 * `{{Worktree}}`。i18next 的变量名**大小写敏感**，调用点传的是 `{ worktree }`
 * （`CindyMakePreflightDialog.tsx`、`cindyMakeDoctorStream.ts`），于是任务标题会渲染
 * 字面量而不是 runId。
 *
 * 当时 desktop 侧四道门全是绿的：`check:i18n` 只查 key 结构、
 * `check:i18n-glossary` 只查术语与标点、`i18nCompleteness` 只查 key 齐全、
 * `i18nBrandPlaceholder` 只查固定 key 的 `appName` 渲染——**没有一个比较过占位符名**。
 * mobile 有 `i18nCatalogParity`（逐 key 比占位符集合），desktop 缺这一层，本文件补上。
 *
 * ## 为什么不直接「逐 key 集合相等」
 *
 * desktop 存量的占位符与 en 并非严格一致，且有正当理由：复数 key 的 `_one` 在
 * en 用字面量、欧洲语种用 `{{count}}`（i18next 标准）；`{{pronoun}}` 是
 * `i18n/index.ts` 的 `defaultVariables`，en 不再重复写；`{{name}}`/`{{status}}` 等由
 * 调用点按 key 传（`localizeAgentStatus.ts` 同时传 `name` 与 `status`）。
 * 严格相等会产生上百条存量噪音。因此这里钉三条**可判定且当前零误报**的不变量：
 *
 * 1. 占位符名不得以大写字母开头 —— 本仓 12 语全部 382 个占位符名均为小写开头；
 * 2. 占位符名不得与 en 同名占位符**仅差大小写**（`{{appname}}` vs `{{appName}}`）；
 * 3. en 用 `{{appName}}` 的 key，各语种也必须出现 `{{appName}}`（品牌名走插值），
 *    存量遗漏冻结在 `KNOWN_APPNAME_MISSING`，只减不增。
 *
 * 收录口径与 `i18nBrandPlaceholder.test.ts` 一致：只约束「指应用自身」的品牌文案。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SUPPORTED_LOCALES } from '../../shared/locale';

const LOCALES_DIR = resolve(__dirname, '..', 'i18n', 'locales');
const NAMESPACES = ['common.json', 'aiRename.json'] as const;
const PLACEHOLDER_RE = /\{\{\s*([^{}\s"'`]+)\s*\}\}/g;

/**
 * `{{appName}}` 缺失的存量：`update.agentInstall.reasons.notRestarted` 在下列语种里
 * 把品牌名整句省掉了（en/de 有 `{{appName}}`）。属既有译文与 en 源的漂移，
 * 不是本轮引入；补译时把对应行从这里删掉，别新增。
 */
const KNOWN_APPNAME_MISSING: ReadonlySet<string> = new Set([
  'ja:update.agentInstall.reasons.notRestarted',
  'ko:update.agentInstall.reasons.notRestarted',
  'zh-CN:update.agentInstall.reasons.notRestarted',
  'zh-TW:update.agentInstall.reasons.notRestarted',
  'zh-Hans-x-lzh:update.agentInstall.reasons.notRestarted',
  'zh-Hant-x-lzh:update.agentInstall.reasons.notRestarted',
]);

type Catalog = Map<string, string>;

function flatten(node: unknown, prefix: string, out: Catalog): void {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  if (typeof node === 'string') out.set(prefix, node);
}

function loadCatalog(locale: string): Catalog {
  const out: Catalog = new Map();
  for (const ns of NAMESPACES) {
    const file = resolve(LOCALES_DIR, locale, ns);
    const namespace = ns === 'common.json' ? '' : ns.replace(/\.json$/, '');
    flatten(JSON.parse(readFileSync(file, 'utf8')), namespace, out);
  }
  return out;
}

function placeholdersOf(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

const CATALOGS = new Map(SUPPORTED_LOCALES.map((locale) => [locale, loadCatalog(locale)]));
const EN = CATALOGS.get('en')!;
const NON_EN_LOCALES = SUPPORTED_LOCALES.filter((locale) => locale !== 'en');

describe('desktop i18n 占位符名 parity', () => {
  it('12 语与 SUPPORTED_LOCALES 对齐(新增语言必须一并纳入本门)', () => {
    expect([...CATALOGS.keys()].sort()).toEqual([...SUPPORTED_LOCALES].sort());
    expect(CATALOGS.size).toBe(12);
  });

  it('占位符名不得以大写字母开头(大小写归一不得作用到 {{...}})', () => {
    const problems: string[] = [];
    for (const locale of SUPPORTED_LOCALES) {
      for (const [key, value] of CATALOGS.get(locale)!) {
        for (const name of placeholdersOf(value)) {
          if (/^[A-Z]/.test(name)) problems.push(`${locale}:${key} → {{${name}}}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('占位符名不得与 en 同名占位符仅差大小写', () => {
    const problems: string[] = [];
    for (const locale of NON_EN_LOCALES) {
      for (const [key, value] of CATALOGS.get(locale)!) {
        const enValue = EN.get(key);
        if (typeof enValue !== 'string') continue;
        const enNames = placeholdersOf(enValue);
        for (const name of placeholdersOf(value)) {
          if (enNames.includes(name)) continue;
          const caseTwin = enNames.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
          if (caseTwin) problems.push(`${locale}:${key} → {{${name}}}(en: {{${caseTwin}}})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('en 用 {{appName}} 的 key，各语种也必须用 {{appName}}', () => {
    const problems: string[] = [];
    for (const locale of NON_EN_LOCALES) {
      for (const [key, value] of CATALOGS.get(locale)!) {
        const enValue = EN.get(key);
        if (typeof enValue !== 'string' || !placeholdersOf(enValue).includes('appName')) continue;
        if (placeholdersOf(value).includes('appName')) continue;
        if (KNOWN_APPNAME_MISSING.has(`${locale}:${key}`)) continue;
        problems.push(`${locale}:${key}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
