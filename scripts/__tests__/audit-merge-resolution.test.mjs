import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  classifyFile,
  classifyMissingTokens,
  compareAdditions,
  contentKey,
  generatedArtifactHint,
  isBinaryPath,
  lostFromResult,
  significantLines,
  tokenMultiset,
  parseTreeListing,
  parseIndexListing,
  createGit,
  audit,
  summarize,
  formatReport,
  parseArgs,
  main,
} from '../audit-merge-resolution.mjs';

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('classifyFile: additive 与 identical 不产生噪声', () => {
  // 只有一侧动过 —— 永远不可能冲突，这是 fork 里绝大多数改动
  assert.equal(classifyFile({ base: 'b', ours: 'o', theirs: 'b', result: 'o' }), 'additive-ours');
  assert.equal(classifyFile({ base: 'b', ours: 'b', theirs: 't', result: 't' }), 'additive-theirs');
  assert.equal(classifyFile({ base: 'b', ours: 'b', theirs: 'b', result: 'b' }), 'identical');
  // 上游新增文件，我们没碰
  assert.equal(classifyFile({ base: null, ours: null, theirs: 't', result: 't' }), 'additive-theirs');
  assert.equal(classifyFile({ base: null, ours: 'o', theirs: null, result: 'o' }), 'additive-ours');
});

test('classifyFile: 两侧都动过时区分 hand-merged 与 took-one-side', () => {
  // 真正的三方解决：结果与两侧都不同
  assert.equal(classifyFile({ base: 'b', ours: 'o', theirs: 't', result: 'm' }), 'hand-merged');
  // 整体取了某一侧 —— Git 认为已解决，但可能丢了另一侧
  assert.equal(classifyFile({ base: 'b', ours: 'o', theirs: 't', result: 'o' }), 'took-ours');
  assert.equal(classifyFile({ base: 'b', ours: 'o', theirs: 't', result: 't' }), 'took-theirs');
  // 两侧改成了相同结果，不算分歧
  assert.equal(classifyFile({ base: 'b', ours: 's', theirs: 's', result: 's' }), 'identical');
});

test('classifyFile: 结果里缺失文件被识别（整份能力被丢的形态）', () => {
  assert.equal(classifyFile({ base: null, ours: null, theirs: 't', result: null }), 'dropped-by-result');
  assert.equal(classifyFile({ base: 'b', ours: 'b', theirs: 't2', result: null }), 'dropped-by-result');
  // 结果新增了谁都没有的文件：不算问题
  assert.equal(classifyFile({ base: null, ours: null, theirs: null, result: 'r' }), 'added-by-result');
  assert.equal(classifyFile({ base: null, ours: null, theirs: null, result: null }), null);
});

test('lostFromResult: 接受「对方删除」是正常操作，只有真丢自己东西才报', () => {
  // 上游删除、我们接受 —— 插件市场解耦（D3）一次删掉整批 UI 就是这个形态
  assert.equal(
    lostFromResult({ base: 'b', side: 'o', other: null, result: null }),
    false,
    '对方也删了：接受删除，不该报成我们丢文件',
  );
  // 结果里还有：没丢
  assert.equal(lostFromResult({ base: 'b', side: 'o', other: 't', result: 'r' }), false);
  // 这一侧本来就没有：没丢
  assert.equal(lostFromResult({ base: 'b', side: null, other: 't', result: null }), false);
  // 上游新增的文件被丢 —— 本次 hook-control 事故的形态
  assert.equal(
    lostFromResult({ base: null, side: 't', other: null, result: null }),
    true,
    '对方从未有过而我们丢了内容：应报告',
  );
  // 我们自己新增的文件消失了：值得人看一眼
  assert.equal(lostFromResult({ base: null, side: 'o', other: null, result: null }), true);
});

test('contentKey: 尾随换行差异不应被当成另一个文件', () => {
  assert.equal(contentKey('SELECT 1;'), contentKey('SELECT 1;\n'));
  assert.equal(contentKey('a\r\nb\r\n'), contentKey('a\nb\n'));
  assert.notEqual(contentKey('SELECT 1;'), contentKey('SELECT 2;'));
  assert.equal(contentKey(null), null);
});

test('compareAdditions: 真实丢失被抓到并给出样本', () => {
  const cmp = compareAdditions({
    baseText: 'function tomlString(v) {\n}\n',
    sideText: 'function tomlString(v) {\n}\nfunction smartRoutingHint(routes) {\n  return routes.map(route => route.catalogModel).join(", ");\n}\nexport function resolveCodexSubagentRoutingProfile(settings) {\n  return settings.mode;\n}\n',
    resultText: 'function tomlString(v) {\n}\n',
    minLines: 3,
    lossRatio: 0.3,
  });
  assert.ok(cmp, '应报告缺失');
  assert.equal(cmp.reformatted, false);
  assert.ok(cmp.missingLines >= 4);
  assert.ok(cmp.samples.length > 0);
  assert.ok(cmp.samples.length <= 4);
});

test('compareAdditions: 纯重排 / 拆行不算丢失（降噪的关键）', () => {
  const cmp = compareAdditions({
    baseText: 'const x = 1;\n',
    // 上游把同一调用拆成多行：token 完全没变
    sideText: 'const x = 1;\nrunMediaResult({\n  raw,\n  allowedHosts,\n  assertActive,\n});\n',
    // 结果保留了原始单行写法
    resultText: 'const x = 1;\nrunMediaResult({ raw, allowedHosts, assertActive });\n',
    minLines: 3,
    lossRatio: 0.3,
  });
  assert.ok(cmp, '应有中间结果');
  assert.equal(cmp.reformatted, true, 'token 未丢 → 判定为重排');
  assert.deepEqual(cmp.samples, []);
});

test('compareAdditions: 低于阈值不报，避免少量重写淹没信号', () => {
  assert.equal(
    compareAdditions({ baseText: '', sideText: 'a\nb\n', resultText: 'a\nb\n', minLines: 5 }),
    null,
    '新增少于 minLines 时不报',
  );
  // 有一行真实丢失，但整体比例很低 → token 占比未达阈值
  const wide = Array.from({ length: 40 }, (_, i) => `keep me ${i} unique_marker_${i}`).join('\n');
  const cmp = compareAdditions({
    baseText: '',
    sideText: `${wide}\ngone_marker_alpha gone_marker_beta\n`,
    resultText: `${wide}\n`,
    minLines: 3,
    lossRatio: 0.3,
  });
  assert.equal(cmp, null, '低于 lossRatio 不报');
});

test('classifyMissingTokens / tokenMultiset: 只按余量消费 token', () => {
  const tokens = tokenMultiset('alpha beta');
  assert.equal(tokens.get('alpha'), 1);
  assert.equal(tokens.get('beta'), 1);
  // 结果里 alpha 只剩一次：两个缺失行共需 2 个 alpha，只能满足 1 个
  const verdict = classifyMissingTokens(['alpha beta', 'alpha'], tokens);
  assert.ok(verdict.totalTokens > 0);
  assert.equal(verdict.lostTokens, 1);
});

test('significantLines: trim 后丢弃空行，CRLF 归一化', () => {
  assert.deepEqual(significantLines('a\r\n\r\n  b  \n'), ['a', 'b']);
});

test('generatedArtifactHint / isBinaryPath: 生成物与二进制识别', () => {
  assert.ok(generatedArtifactHint('pnpm-lock.yaml'));
  assert.ok(generatedArtifactHint('apps/desktop/drizzle/meta/0093_snapshot.json'));
  assert.equal(generatedArtifactHint('apps/desktop/src/main/index.ts'), null);
  assert.equal(isBinaryPath('docs/a/b.png'), true);
  assert.equal(isBinaryPath('src/main/index.ts'), false);
});

test('parseTreeListing / parseIndexListing: 解析并保留未解决路径', () => {
  const tree = parseTreeListing(
    ['100644 blob aaa\tfoo.ts', '100755 blob bbb\tscripts/x.mjs', ''].join('\0'),
  );
  assert.equal(tree.get('foo.ts'), 'aaa');
  assert.equal(tree.get('scripts/x.mjs'), 'bbb');
  // gitlink（submodule）不是 blob，不应进表
  assert.equal(tree.size, 2);

  const idx = parseIndexListing([
    '100644 aaa111 0\tclean.ts\0',
    '100644 bbb222 1\tconflict.ts\0',
    '100644 ccc333 2\tconflict.ts\0',
    '100644 ddd444 3\tconflict.ts\0',
  ].join(''));
  assert.equal(idx.map.get('clean.ts'), 'aaa111');
  assert.equal(idx.map.has('conflict.ts'), false);
  assert.deepEqual(idx.unmerged, ['conflict.ts']);
});

test('parseArgs: 未知参数报错，--allow 可重复', () => {
  const options = parseArgs(['--worktree', '--allow', 'docs/', '--allow', 'a/b.ts']);
  assert.equal(options.result, 'worktree');
  assert.deepEqual(options.allow, ['docs/', 'a/b.ts']);
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
});

// ---------------------------------------------------------------------------
// 端到端：在临时仓库上跑真实 merge
// ---------------------------------------------------------------------------

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-merge-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  // 关掉 autocrlf，否则 Windows 上换行归一化会干扰文本比对断言
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  return { dir, git };
}

const write = (dir, rel, text) => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

/**
 * 构造一个「上游同步」形态的 merge：base → ours(=main，产品线) 与 upstream 各自演进，
 * 再把 upstream merge 进 main。返回时 merge 处于未提交状态，`resolve` 负责写解决结果；
 * 只要结果里没有冲突标记就 stage 进 index（审计默认看 index）。
 */
function syncMerge(t, { baseFiles, oursFiles, theirsFiles, resolve, stage = true }) {
  const { dir, git } = makeRepo(t);
  const commitAll = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  for (const [rel, text] of Object.entries(baseFiles)) write(dir, rel, text);
  const base = commitAll('base');

  for (const [rel, text] of Object.entries(oursFiles)) write(dir, rel, text);
  const ours = commitAll('ours');

  git('checkout', '-q', '-b', 'upstream', base);
  for (const [rel, text] of Object.entries(theirsFiles)) write(dir, rel, text);
  const theirs = commitAll('theirs');

  git('checkout', '-q', 'main');
  try {
    git('merge', '--no-commit', '--no-ff', 'upstream');
  } catch {
    /* 冲突：交给 resolve 处理 */
  }
  resolve({ dir, git, base, ours, theirs });
  if (stage) git('add', '-A');

  return { dir, git, base, ours, theirs };
}

const auditAt = (dir, range, extra = {}) =>
  audit({ git: createGit(dir), ...range, result: 'index', ...extra });

/** 本次同步最典型的 fixture：两侧都改 A.txt，上游另加 U.txt，产品线另加 M.txt。 */
const SYNC_FIXTURE = {
  baseFiles: { 'A.txt': 'line1\n' },
  oursFiles: { 'A.txt': 'line1\nours\n', 'M.txt': 'meka only\n' },
  theirsFiles: { 'A.txt': 'line1\ntheirs\n', 'U.txt': 'upstream only\n' },
};

test('端到端: 正常三方解决 → PASS，无 dropped / 无 REVIEW', (t) => {
  const ctx = syncMerge(t, {
    ...SYNC_FIXTURE,
    resolve: ({ dir }) => write(dir, 'A.txt', 'line1\nours\ntheirs\n'),
  });
  const result = auditAt(ctx.dir, { base: ctx.base, ours: ctx.ours, theirs: ctx.theirs });
  const summary = summarize(result);
  assert.equal(summary.dropped, 0, '不应报告丢失');
  assert.equal(summary.blockers, 0);
  assert.equal(summary.fail, false);
  assert.match(formatReport(result), /verdict: PASS/);
});

test('端到端: 上游新增的整个文件被丢 → DROPPED + exit 1（本次 hook-control 事故的形态）', (t) => {
  const ctx = syncMerge(t, {
    ...SYNC_FIXTURE,
    resolve: ({ dir }) => {
      write(dir, 'A.txt', 'line1\nours\ntheirs\n');
      // 上游新增的能力文件在解决时被静默丢掉：Git 不会报任何冲突
      fs.rmSync(path.join(dir, 'U.txt'));
    },
  });
  const result = auditAt(ctx.dir, { base: ctx.base, ours: ctx.ours, theirs: ctx.theirs });
  const summary = summarize(result);
  assert.equal(summary.dropped, 1);
  assert.equal(summary.fail, true);
  assert.equal(result.droppedUpstream[0].path, 'U.txt');
  assert.equal(result.droppedUpstream[0].kind, 'file-removed');

  t.mock.method(console, 'log', () => {});
  assert.equal(main([], { root: ctx.dir }), 1, '有 DROPPED 时退出码必须为 1');
});

test('端到端: 整体取了我们这一侧、上游新增行丢失 → REVIEW + DROPPED', (t) => {
  const ctx = syncMerge(t, {
    ...SYNC_FIXTURE,
    resolve: ({ dir }) => write(dir, 'A.txt', 'line1\nours\n'),
  });
  // fixture 只有 1 行差异，显式放宽阈值让判定可观察
  const result = auditAt(
    ctx.dir,
    { base: ctx.base, ours: ctx.ours, theirs: ctx.theirs },
    { minLines: 1, lossRatio: 0.3 },
  );
  const summary = summarize(result);
  assert.ok(summary.review >= 1, 'A.txt 两侧都改过而结果等于 ours，应进 REVIEW');
  assert.equal(result.reviewItems[0].path, 'A.txt');
  assert.equal(result.reviewItems[0].status, 'took-ours');
  assert.equal(summary.dropped, 1, '上游新增的 theirs 行应被计为丢失');
  assert.equal(result.droppedUpstream[0].side, 'upstream');
});

test('端到端: 未解决冲突 → BLOCKER + exit 1', (t) => {
  const ctx = syncMerge(t, {
    ...SYNC_FIXTURE,
    resolve: () => {},
    stage: false,
  });
  const result = auditAt(ctx.dir, { base: ctx.base, ours: ctx.ours, theirs: ctx.theirs });
  const summary = summarize(result);
  assert.ok(result.unmergedPaths.includes('A.txt'), '应报告未解决路径');
  assert.ok(summary.blockers > 0);
  assert.equal(summary.fail, true);
  assert.match(formatReport(result), /BLOCKER/);
});

test('端到端: 冲突标记残留会被抓到（即使已 stage）', (t) => {
  const ctx = syncMerge(t, {
    ...SYNC_FIXTURE,
    resolve: ({ dir }) =>
      write(dir, 'A.txt', 'line1\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> upstream\n'),
  });
  const result = auditAt(ctx.dir, { base: ctx.base, ours: ctx.ours, theirs: ctx.theirs });
  assert.ok(result.conflictMarkers.some((m) => m.path === 'A.txt' && m.line === 2));
  assert.ok(summarize(result).blockers > 0);
});

test('端到端: 生成物被手解会被点名并要求再生', (t) => {
  const LOCK_BASE = 'lockfileVersion: 9\nimporters:\n  .: {}\n';
  const ctx = syncMerge(t, {
    baseFiles: { 'A.txt': 'line1\n', 'pnpm-lock.yaml': LOCK_BASE },
    oursFiles: { 'A.txt': 'line1\nours\n', 'pnpm-lock.yaml': `${LOCK_BASE}  .:\n    deps: meka\n` },
    theirsFiles: { 'A.txt': 'line1\ntheirs\n', 'pnpm-lock.yaml': `${LOCK_BASE}  .:\n    deps: upstream\n` },
    resolve: ({ dir }) => {
      write(dir, 'A.txt', 'line1\nours\ntheirs\n');
      // 手解成第三个值：既不是 ours 也不是 theirs
      write(dir, 'pnpm-lock.yaml', `${LOCK_BASE}  .:\n    deps: hand-merged\n`);
    },
  });
  const result = auditAt(ctx.dir, { base: ctx.base, ours: ctx.ours, theirs: ctx.theirs });
  const hit = result.generatedHits.find((g) => g.path === 'pnpm-lock.yaml');
  assert.ok(hit, '两侧都改过的 lockfile 被手解应被点名');
  assert.equal(hit.status, 'hand-merged');
  assert.match(hit.hint, /pnpm install/);
  assert.equal(summarize(result).fail, false, '生成物只提示，不阻断（编号顺移等合法第三值不应假红）');
  assert.equal(summarize(result).generated, 1);
  // 生成物不参与内容级比对：正确形态由 `pnpm install` 再生保证
  assert.equal(summarize(result).dropped, 0);
});

test('端到端: 内容搬到新路径（重命名）不算丢失', (t) => {
  const ctx = syncMerge(t, {
    baseFiles: { 'A.txt': 'line1\n' },
    oursFiles: { 'A.txt': 'line1\nours\n' },
    // 上游在旧路径新增了内容
    theirsFiles: { 'A.txt': 'line1\ntheirs\n', '0093_parched_switch.sql': 'ALTER TABLE t ADD c;\n' },
    // 解决时把它顺移到新编号下 —— 内容一字未改（迁移编号顺移的真实形态）
    resolve: ({ dir }) => {
      write(dir, 'A.txt', 'line1\nours\ntheirs\n');
      fs.rmSync(path.join(dir, '0093_parched_switch.sql'));
      write(dir, '0096_parched_switch.sql', 'ALTER TABLE t ADD c;\n');
    },
  });
  const result = auditAt(ctx.dir, { base: ctx.base, ours: ctx.ours, theirs: ctx.theirs });
  assert.equal(summarize(result).dropped, 0, '同内容换路径应识别为重命名，不算丢失');
});

test('端到端: 纯格式重排不算 DROPPED（低误报是工具可用的前提）', (t) => {
  const ctx = syncMerge(t, {
    baseFiles: { 'A.txt': 'const call = run({ raw, allowedHosts });\n' },
    oursFiles: { 'M.txt': 'meka\n' },
    // 上游只是把同一调用拆成多行，token 完全没变
    theirsFiles: { 'A.txt': 'const call = run({\n  raw,\n  allowedHosts,\n});\n' },
    // 解决时保留我们原本的单行写法
    resolve: ({ dir }) => write(dir, 'A.txt', 'const call = run({ raw, allowedHosts });\n'),
  });
  const result = auditAt(ctx.dir, { base: ctx.base, ours: ctx.ours, theirs: ctx.theirs });
  assert.equal(summarize(result).dropped, 0, '拆行不应被判为丢失');
});

test('端到端: --allow 可豁免已确认的丢失路径', (t) => {
  const ctx = syncMerge(t, {
    ...SYNC_FIXTURE,
    resolve: ({ dir }) => {
      write(dir, 'A.txt', 'line1\nours\ntheirs\n');
      fs.rmSync(path.join(dir, 'U.txt'));
    },
  });
  const result = auditAt(
    ctx.dir,
    { base: ctx.base, ours: ctx.ours, theirs: ctx.theirs },
    { allow: ['U.txt'] },
  );
  assert.equal(summarize(result).dropped, 0, '显式豁免后不再报告');
});

test('CLI: --help 退出 0，非法参数退出 2', (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  assert.equal(main(['--help']), 0);
  assert.equal(main(['--bogus']), 2);
});
