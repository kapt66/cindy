/**
 * Meka 白名单清单的结构契约。
 *
 * `docs/dev-rules/meka-whitelist-verification.md` 是上游同步后的验收范围定义：
 * 它之所以能长期当权威清单用，靠的不是「记得更新」，而是这层结构强制——
 *
 *   1. 每个 WL 项必须带齐四个字段（不变量 / 锚点 / 自动化门禁 / 实机验证）。
 *      只写「能力名 + 一句话」的条目会在这里失败，避免清单退化成愿望列表。
 *   2. 清单里出现的每条 pnpm 命令必须真实存在（根 script 或 workspace script），
 *      否则照着清单执行的人会撞上 "Command not found"。
 *   3. WL 编号唯一；允许删除后留空号（删除能力时不得复用编号）。
 *   4. 清单必须被根 AGENTS.md 与 development-workflow.md 索引，
 *      否则它不会在正确的时机被读到。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CHECKLIST = 'docs/dev-rules/meka-whitelist-verification.md';
const REQUIRED_FIELDS = ['保护的不变量', '代码锚点', '自动化门禁', '实机验证'];
const INDEXING_DOCS = ['AGENTS.md', 'docs/dev-rules/development-workflow.md'];

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** 去掉 fenced code block 与 inline code span，只留叙述文字。 */
function prose(markdown) {
  return markdown
    .replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, '')
    .replace(/(`+)(?:(?!\1)[^\n])*?\1/g, '');
}

/** 抽取清单项：`### WL-<n> <名称>` 到下一个同级/更高级标题之间。 */
function collectItems(markdown) {
  const lines = markdown.split(/\r?\n/);
  const items = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^###\s+WL-([0-9]+(?:\.[0-9]+)?)\s+(\S.*)$/);
    if (heading) {
      current = { id: heading[1], title: heading[2].trim(), body: [] };
      items.push(current);
      continue;
    }
    if (/^#{1,3}\s/.test(line)) current = null;
    if (current) current.body.push(line);
  }
  return items.map((item) => ({ ...item, body: item.body.join('\n') }));
}

/** 清单里出现过的所有 pnpm 调用（围栏块与行内 code 都算）。 */
function pnpmInvocations(markdown) {
  const invocations = [];
  for (const match of markdown.matchAll(/pnpm\s+([^\n`|]+)/g)) {
    const line = match[1].trim();
    if (!line || line.startsWith('run ')) continue;
    invocations.push(line);
  }
  return [...new Set(invocations)];
}

function workspaceManifests() {
  const map = new Map();
  for (const pattern of ['apps/*/package.json', 'packages/*/package.json']) {
    const dir = pattern.split('/')[0];
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(dir, entry.name, 'package.json');
      const absolute = path.join(ROOT, manifestPath);
      if (!fs.existsSync(absolute)) continue;
      const manifest = JSON.parse(fs.readFileSync(absolute, 'utf8'));
      if (manifest.name) map.set(manifest.name, { path: manifestPath, manifest });
    }
  }
  return map;
}

test('白名单清单存在且每一项都带齐四个必填字段', () => {
  assert.ok(fs.existsSync(path.join(ROOT, CHECKLIST)), `${CHECKLIST} 缺失`);
  const items = collectItems(readText(CHECKLIST));
  assert.ok(items.length > 0, '清单没有任何 WL 项');
  for (const item of items) {
    for (const field of REQUIRED_FIELDS) {
      assert.ok(
        item.body.includes(`**${field}**`),
        `WL-${item.id}（${item.title}）缺少必填字段「${field}」`,
      );
    }
  }
});

test('WL 编号唯一，且不复用已删除的编号', () => {
  const items = collectItems(readText(CHECKLIST));
  const ids = items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, `WL 编号重复：${ids.join(', ')}`);
  const topLevel = items
    .map((item) => item.id)
    .filter((id) => !id.includes('.'))
    .map(Number)
    .sort((a, b) => a - b);
  assert.equal(topLevel[0], 1, '顶层编号必须从 WL-1 开始');
  for (let index = 1; index < topLevel.length; index += 1) {
    assert.ok(
      topLevel[index] > topLevel[index - 1],
      `顶层编号未升序：${topLevel.join(', ')}`,
    );
  }
});

test('清单里的每条 pnpm 命令都必须真实存在', () => {
  const rootPackage = JSON.parse(readText('package.json'));
  const workspaces = workspaceManifests();
  for (const invocation of pnpmInvocations(readText(CHECKLIST))) {
    const tokens = invocation.split(/\s+/).filter(Boolean);
    if (tokens[0] === '--filter') {
      const selector = tokens[1];
      const workspace = workspaces.get(selector);
      assert.ok(workspace, `未知 workspace 选择器：pnpm ${invocation}`);
      // `pnpm --filter <ws> run <script>` 与 `pnpm --filter <ws> <script>` 都要认。
      const command = tokens[2] === 'run' ? tokens[3] : tokens[2];
      if (command === 'exec') {
        const binary = tokens[3];
        assert.ok(
          workspace.manifest.dependencies?.[binary]
            || workspace.manifest.devDependencies?.[binary],
          `pnpm ${invocation}：${selector} 未声明二进制 ${binary}`,
        );
        continue;
      }
      assert.ok(
        workspace.manifest.scripts?.[command],
        `pnpm ${invocation}：${selector} 缺少 script ${command}`,
      );
      continue;
    }
    assert.ok(rootPackage.scripts?.[tokens[0]], `根 package.json 缺少 script：${tokens[0]}`);
  }
});

test('清单被 AGENTS.md 与开发工作流索引', () => {
  for (const doc of INDEXING_DOCS) {
    assert.match(
      readText(doc),
      /meka-whitelist-verification\.md/,
      `${doc} 必须索引 ${CHECKLIST}`,
    );
  }
});

test('清单声明了与 audit:merge 的分工，不把结构审计当成语义验收', () => {
  const raw = readText(CHECKLIST);
  const body = prose(raw);
  assert.match(raw, /pnpm audit:merge|audit:merge/, '清单必须说明与 audit:merge 的分工');
  assert.match(body, /语义/, '清单必须点明自己抓的是语义层面的覆盖');
  assert.match(body, /白名单/, '清单必须说明白名单机制');
});
