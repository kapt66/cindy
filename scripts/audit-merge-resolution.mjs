#!/usr/bin/env node
/**
 * merge-resolution audit —— 审计一次「上游同步 merge」的解决结果，专抓**静默丢失**。
 *
 * ## 为什么需要它
 *
 * 把上游 merge 进长期 fork 时，真正危险的不是 Git 报出来的冲突，而是**它不报的那些**：
 *
 * - 上游新增了一个文件 / 一整块能力，而产品线那一侧从未碰过 → Git 认为无事发生，
 *   但解决结果里没有它。**这类丢失永远不会出现在冲突清单里**；
 * - 上游相对冲突基点改过某文件，产品线也改过，解决时整体取了自己那一侧 → Git 只报
 *   "已解决"，没人知道上游那几百行没了；
 * - 上游重构（行为不变、纯搬家）让**源码文本断言型测试**变红，容易被误判成"上游自己就红"
 *   而放行。
 *
 * 2026-08→09 那次同步就踩了这个坑：`hook-control` 整组（`ackReactions.ts`、
 * `requestLedger.ts` 与 `dispatcher.ts` 的 request-ledger / ack-reactions / turn-delivery）
 * 被解成旧世代且**没有任何冲突提示**，`typecheck` 是唯一信号；同一批还丢了 4 条 Meka i18n key。
 * 症状的共同点是「代码和它的测试被一起解成旧版本，于是测试全绿」。
 *
 * 本脚本把当时手工做的三类机械审计固化成可重复的一道门，让下一次同步能在提交前
 * 自证「没有静默丢东西」。
 *
 * ## 三类判定
 *
 * - **BLOCKER**：未解决冲突路径、冲突标记残留、生成物被手解。必失败。
 * - **DROPPED**：一侧相对基点**实质新增**的内容在结果里缺失（整文件被丢、或新增行丢失
 *   且不是纯重排）。默认失败——这正是本脚本存在的理由。
 * - **REVIEW**：两侧都改过而结果整体等于其中一侧。Git 认为冲突已解决，但语义上可能
 *   丢了另一侧，需要人确认。默认不失败（很多情况本就是正确取舍）。
 *
 * ## 判定口径（为什么这样才准）
 *
 * - **只看内容，不看 diff hunk**：以三方 blob 的 SHA 做文件级分类，再对"两侧都动过"的
 *   文件做行级比对。这样与 Git 的递归合并算法解耦，不受 rename / 空白策略影响。
 * - **行比对先 trim 后比较**：上游重排缩进、换行位置变化不应算丢失。
 * - **token 兜底**：行级判为缺失后，再用 token 多重集复核。如果只是被拆行 / 合并行，
 *   token 不会丢，降级为 `reformatted` 不计入 DROPPED。这条把纯格式噪声压到可忽略。
 * - **二进制与无文本文件跳过内容级比对**，只做文件级存在性判断。
 *
 * ## 用法
 *
 * ```bash
 * # 同步 merge 进行中（默认审计 index —— 也就是 commit 将包含的内容）
 * node scripts/audit-merge-resolution.mjs
 *
 * # 想审工作区实际文件（含尚未 stage 的手工修复）
 * node scripts/audit-merge-resolution.mjs --worktree
 *
 * # merge 已提交，审计那个 merge commit
 * node scripts/audit-merge-resolution.mjs --merge-commit HEAD
 *
 * # 显式指定四方，做任意范围比对
 * node scripts/audit-merge-resolution.mjs --base <ref> --ours <ref> --theirs <ref> --result <ref>
 * ```
 *
 * 退出码：`0` 通过；`1` 有 BLOCKER 或 DROPPED；`2` 用法 / 仓库状态错误。
 *
 * 只读 git 对象与工作区，不写任何文件、不访问网络。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 低于这个行数不报，避免少量重写噪声淹没信号。 */
const DEFAULT_MIN_LINES = 5;
/** 缺失 token 占上游新增 token 的比例达到这个值才算 DROPPED。 */
const DEFAULT_LOSS_RATIO = 0.3;
/** 单文件最多展示多少条缺失示例。 */
const SAMPLE_LIMIT = 4;

/**
 * 生成物：手解等于把"本该再生"的值固化成手写结果，下次同步必然再冲突，
 * 且很容易在解的过程中丢掉上游真实变更。命中后只提示、不尝试判断对错。
 */
const GENERATED_ARTIFACT_PATTERNS = [
  { re: /(^|\/)pnpm-lock\.yaml$/, hint: '用 `pnpm install` 依 workspace 重新生成，不要手解。' },
  { re: /(^|\/)drizzle\/meta\/.*\.json$/, hint: '从 schema 源重新生成（`pnpm --filter desktop db:generate`），不要手解。' },
  { re: /(^|\/)docs\/legal\/notices\/.*\.(txt|json)$/, hint: '由 `scripts/generate-third-party-notices.mjs` 再生。' },
];

/** 内容级比对直接跳过的扩展名（二进制 / 无文本语义）。 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.tar', '.7z', '.dmg', '.exe', '.dll', '.node', '.wasm',
  '.pdf', '.mp3', '.mp4', '.mov', '.sqlite', '.db',
]);

// ---------------------------------------------------------------------------
// 文本归一化（纯函数，便于单测）
// ---------------------------------------------------------------------------

export function normalizeText(text) {
  return String(text ?? '').replace(/\r\n/g, '\n');
}

/**
 * 参与比对的有效行：trim 后去空行。
 *
 * 刻意**不**剔除注释行：注释丢失也可能是真实损失（尤其 docs / 规则文件），
 * 而纯注释重写造成的少量噪声由 {@link isReformattedOnly} 的 token 兜底吸收。
 */
export function significantLines(text) {
  return normalizeText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 行去重集合，用于 O(1) 判断某行是否仍在结果里。 */
export function lineSet(text) {
  return new Set(significantLines(text));
}

/**
 * token 多重集：按非标识符字符切分后统计出现次数。
 *
 * 用途是区分「真的删了内容」与「只是拆行 / 并行 / 改了缩进」——后者 token 不会减少。
 */
export function tokenMultiset(text) {
  const counts = new Map();
  for (const line of significantLines(text)) {
    for (const token of line.split(/[^A-Za-z0-9_$./-]+/)) {
      if (!token) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * 判断缺失的行是否只是"重排"而没丢信息。
 *
 * 算法：把缺失行的 token 逐个数一下，看有多少在结果里**仍按足够次数**存在。
 * 如果缺失部分涉及的 token 基本都还在，说明只是拆行 / 并行 / 移动位置 → reformatted。
 *
 * @returns {{reformatted: boolean, lostTokens: number, totalTokens: number}}
 */
export function classifyMissingTokens(missingLines, resultTokens) {
  const remaining = new Map(resultTokens);
  let lostTokens = 0;
  let totalTokens = 0;
  for (const line of missingLines) {
    for (const token of line.split(/[^A-Za-z0-9_$./-]+/)) {
      if (!token) continue;
      totalTokens++;
      // token 以 `foo.x` 这种带标点的形式切出，逐个消费结果侧的余量
      const key = token;
      const have = remaining.get(key) ?? 0;
      if (have > 0) remaining.set(key, have - 1);
      else lostTokens++;
    }
  }
  return { reformatted: totalTokens > 0 && lostTokens / totalTokens < 0.5, lostTokens, totalTokens };
}

// ---------------------------------------------------------------------------
// 文件级分类（纯函数）
// ---------------------------------------------------------------------------

/**
 * 用一个文件的四个版本判定它在解决结果里发生了什么。
 *
 * 入参是各版本的 blob SHA（`null` = 该版本不存在）。`base` 为 merge-base。
 * 返回 `status` 之一：
 *
 * - `identical`            四方一致，无需关注
 * - `additive-ours`        只有我们新增 / 修改（上游没碰）→ 不可能冲突
 * - `additive-theirs`      只有上游新增 / 修改（我们没碰）
 * - `took-ours`            两侧都动过，结果整体等于我们那一侧 → 可能丢上游
 * - `took-theirs`          两侧都动过，结果整体等于上游 → 可能丢我们
 * - `hand-merged`          两侧都动过，结果与两侧都不同 → 正常人工解决
 * - `dropped-by-result`    结果里没有这个文件，但某一侧有它
 * - `added-by-result`      结果里有、两侧都没有（比如解决方案附带的新文件）
 */
export function classifyFile({ base, ours, theirs, result }) {
  const has = (v) => v != null;
  if (!has(result)) {
    // 走到这里说明该路径至少在一侧存在（调用方只遍历并集），结果里没有就是被丢了。
    // 不额外要求 `base` 存在：上游**新增**的文件被删时 base 本来就是 null。
    return has(base) || has(ours) || has(theirs) ? 'dropped-by-result' : null;
  }
  if (!has(base)) {
    if (!has(ours) && !has(theirs)) return 'added-by-result';
    if (has(ours) && !has(theirs)) return ours === result ? 'additive-ours' : 'hand-merged';
    if (has(theirs) && !has(ours)) return theirs === result ? 'additive-theirs' : 'hand-merged';
    // 两侧各自新增同一路径
    if (ours === result && theirs !== result) return 'took-ours';
    if (theirs === result && ours !== result) return 'took-theirs';
    return ours === theirs && ours === result ? 'identical' : 'hand-merged';
  }
  const oursChanged = ours !== base;
  const theirsChanged = theirs !== base;
  if (!oursChanged && !theirsChanged) return result === base ? 'identical' : 'added-by-result';
  if (oursChanged && !theirsChanged) return result === ours ? 'additive-ours' : 'hand-merged';
  if (theirsChanged && !oursChanged) return result === theirs ? 'additive-theirs' : 'hand-merged';
  if (ours === theirs) return result === ours ? 'identical' : 'hand-merged';
  if (result === ours) return 'took-ours';
  if (result === theirs) return 'took-theirs';
  return 'hand-merged';
}

/**
 * 判断结果里缺失某文件时，某一侧是否**真的丢了东西**。
 *
 * 关键区分是"有意删除"与"丢失"——Git 无法自动知道意图，但下面两条能挡掉绝大多数
 * 必然发生的合法删除：
 *
 * 1. **对方也删了**（`base` 有、`other` 没有）：上游删除文件是常规重构动作，
 *    解决时接受该删除就是正确行为，不该报成"我们丢了自己的文件"。
 *    典型：插件市场解耦（D3）一次删掉整批权限确认 UI。
 * 2. **结果里还有**：没丢。
 *
 * 剩下的形态（对方从未有过、而我们这侧有内容却消失了）才值得人看一眼——
 * 它可能是"被上游新实现取代后的孤儿清理"（合理），也可能是真的误删。
 */
export function lostFromResult({ base, side, other, result }) {
  if (result != null) return false;
  if (side == null) return false;
  if (other == null && base != null) return false; // 对方删除了它，接受删除是正常的
  return true;
}

/** 内容归一化 key：行尾与首尾空白差异不应被当成"另一个文件"。 */
export function contentKey(text) {
  if (text == null) return null;
  return normalizeText(text).trim();
}

/**
 * 路径归一化 key：去掉各级目录名里的数字前缀。
 *
 * 迁移编号顺移时同名文件会换号（`0098_bright_baron_zemo.ts` →
 * `0101_bright_baron_zemo.ts`），companion script 的内容还会随编号变化，
 * 所以既比不了 SHA 也比不了内容。这类只能降级为 REVIEW 提示，不能静默忽略——
 * 万一同名文件其实是两回事，漏报比多报贵得多。
 */
export function renameKey(filePath) {
  return filePath.replace(/(^|\/)\d+_/g, '$1');
}

// ---------------------------------------------------------------------------
// 内容级比对
// ---------------------------------------------------------------------------

/**
 * 比较一侧相对基点的**新增行**有多少在结果里找不到。
 *
 * @returns {null | {addedLines: number, missingLines: number, missingRatio: number,
 *                   lostTokens: number, totalTokens: number, reformatted: boolean,
 *                   samples: string[]}}
 *   `null` 表示无需报告（没有新增、缺失太少、或判定为纯重排）。
 */
export function compareAdditions({
  baseText,
  sideText,
  resultText,
  minLines = DEFAULT_MIN_LINES,
  lossRatio = DEFAULT_LOSS_RATIO,
}) {
  if (sideText == null || resultText == null) return null;
  const baseLines = lineSet(baseText ?? '');
  const sideLines = significantLines(sideText);
  const added = sideLines.filter((line) => !baseLines.has(line));
  if (added.length === 0) return null;

  const resultLines = lineSet(resultText);
  const missing = added.filter((line) => !resultLines.has(line));
  if (missing.length < minLines) return null;

  const { reformatted, lostTokens, totalTokens } = classifyMissingTokens(missing, tokenMultiset(resultText));
  const missingRatio = missing.length / added.length;
  if (reformatted && missingRatio < 0.8) {
    // 只是拆行 / 重排：token 没丢且缺失比例不高
    return { addedLines: added.length, missingLines: missing.length, missingRatio, lostTokens, totalTokens, reformatted: true, samples: [] };
  }
  if (lostTokens / Math.max(totalTokens, 1) < lossRatio) {
    return { addedLines: added.length, missingLines: missing.length, missingRatio, lostTokens, totalTokens, reformatted: true, samples: [] };
  }
  return {
    addedLines: added.length,
    missingLines: missing.length,
    missingRatio,
    lostTokens,
    totalTokens,
    reformatted: false,
    samples: missing.slice(0, SAMPLE_LIMIT).map((line) => line.slice(0, 110)),
  };
}

/** 命中生成物清单则返回修复提示，否则 null。 */
export function generatedArtifactHint(filePath) {
  for (const { re, hint } of GENERATED_ARTIFACT_PATTERNS) {
    if (re.test(filePath)) return hint;
  }
  return null;
}

/**
 * 生成物不做内容级丢失比对。
 *
 * 它们的"正确内容"与两侧都不同（从源再生），逐行比对只会产生噪声：迁移编号顺移会让
 * 整批 snapshot 变成合法的第三个值，lockfile 的键序/格式也天然与上游不同。这类文件的
 * 正确性由各自的校验命令保证（`db:validate` / `pnpm install`），本工具只负责提醒去跑。
 */
export function isGeneratedArtifact(filePath) {
  return generatedArtifactHint(filePath) !== null;
}

/** 扩展名是否属于跳过内容级比对的类型。 */
export function isBinaryPath(filePath) {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// ---------------------------------------------------------------------------
// git 适配层
// ---------------------------------------------------------------------------

export function createGit(root) {
  const run = (args, options = {}) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30, ...options }).toString();

  return {
    /** 解析 `<ref>` 为完整 SHA；失败返回 null。 */
    revParse(ref) {
      try {
        return run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim() || null;
      } catch {
        return null;
      }
    },
    /** merge-base；失败返回 null。 */
    mergeBase(a, b) {
      try {
        return run(['merge-base', a, b]).trim() || null;
      } catch {
        return null;
      }
    },
    /** 提交树的 `path -> blobSha`（gitlink / 目录不入表）。 */
    tree(ref) {
      const out = run(['ls-tree', '-r', '-z', '--full-tree', ref]);
      return parseTreeListing(out);
    },
    /**
     * index 的 `path -> blobSha` 与未解决路径集合。
     * 冲突未解决时同一路径会有 stage 1/2/3，这里按未解决单独收集。
     */
    index() {
      const out = run(['ls-files', '-s', '-z']);
      return parseIndexListing(out);
    },
    /** 批量读取 blob 文本；二进制返回 null。`shas` 去重后分批。 */
    blobs(shas) {
      return readBlobTexts(root, shas);
    },
    /**
     * 读取工作区若干路径的文本（`--worktree` 模式）。
     * 只看调用方点名的路径——绝不能遍历全仓：一次同步涉及数千文件，
     * 逐个读盘会让审计慢到不可用。
     */
    worktreeTexts(paths) {
      const map = new Map();
      for (const rel of paths) {
        try {
          const buf = fs.readFileSync(path.join(root, rel));
          map.set(rel, buf.includes(0) ? null : buf.toString('utf8'));
        } catch {
          map.set(rel, null); // 不存在 / 不可读
        }
      }
      return map;
    },
    /** 工作区现存文件集合（仅用于判断存在性）。 */
    worktreePaths(paths) {
      const map = new Map();
      for (const rel of paths) {
        try {
          if (fs.statSync(path.join(root, rel)).isFile()) map.set(rel, 'worktree');
        } catch {
          /* 不存在 */
        }
      }
      return map;
    },
    /** 首个父提交，用于 `--merge-commit` 模式推断。 */
    firstParent(ref) {
      try {
        return run(['rev-parse', `${ref}^1`]).trim() || null;
      } catch {
        return null;
      }
    },
    secondParent(ref) {
      try {
        return run(['rev-parse', `${ref}^2`]).trim() || null;
      } catch {
        return null;
      }
    },
    isMergeCommit(ref) {
      try {
        return run(['rev-list', '--parents', '-n', '1', ref]).trim().split(/\s+/).length > 2;
      } catch {
        return false;
      }
    },
    mergeHead() {
      try {
        return run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).trim() || null;
      } catch {
        return null;
      }
    },
    shortSha(ref) {
      try {
        return run(['rev-parse', '--short', ref]).trim();
      } catch {
        return ref;
      }
    },
  };
}

export function parseTreeListing(out) {
  const map = new Map();
  for (const record of out.split('\0')) {
    if (!record) continue;
    const match = record.match(/^\d+ blob ([0-9a-f]+)\t(.*)$/s);
    if (match) map.set(match[2], match[1]);
  }
  return map;
}

export function parseIndexListing(out) {
  const map = new Map();
  const unmerged = new Set();
  for (const record of out.split('\0')) {
    if (!record) continue;
    const match = record.match(/^\d+ ([0-9a-f]+) (\d)\t(.*)$/s);
    if (!match) continue;
    const [, sha, stage, filePath] = match;
    if (stage === '0') map.set(filePath, sha);
    else unmerged.add(filePath);
  }
  return { map, unmerged: [...unmerged].sort() };
}

/**
 * 用 `git cat-file --batch` 一次进程批量取内容，避免每文件一次 spawn
 * （Windows 上单次 spawn ~20ms，数千文件会慢到不可用）。
 *
 * 必须显式带 `cwd`：漏掉它会在**调用者所在仓库**里查对象，临时仓库 /
 * 其它 checkout 的 blob 全部查不到，内容级比对会静默失效（表现为"什么都查不出来"，
 * 而不是报错）——单测里专门有一条覆盖这个。
 */
function readBlobTexts(cwd, shas) {
  const unique = [...new Set(shas.filter(Boolean))];
  const result = new Map();
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const out = execFileSync('git', ['cat-file', '--batch'], {
      cwd,
      input: `${chunk.join('\n')}\n`,
      maxBuffer: 1 << 30,
    });
    let pos = 0;
    while (pos < out.length) {
      const nl = out.indexOf(0x0a, pos);
      if (nl < 0) break;
      const header = out.toString('utf8', pos, nl);
      const parts = header.split(' ');
      if (parts.length < 3) {
        pos = nl + 1; // missing / ambiguous：跳过
        continue;
      }
      const [, type, sizeText] = parts;
      const size = Number(sizeText);
      const start = nl + 1;
      const end = start + size;
      if (type === 'blob') {
        const buf = out.subarray(start, end);
        result.set(parts[0], buf.includes(0) ? null : buf.toString('utf8'));
      } else {
        result.set(parts[0], null);
      }
      pos = end + 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 主审计
// ---------------------------------------------------------------------------

/**
 * 执行审计。所有 git 访问经由 `git` 适配对象注入，便于用内存 fixture 单测。
 *
 * @param {object} options
 * @param {object} options.git            createGit(root) 的产物（或等价 fake）
 * @param {string} options.base           merge-base ref
 * @param {string} options.ours           产品线侧 ref
 * @param {string} options.theirs         上游侧 ref
 * @param {'index'|'worktree'|string} options.result  `index` / `worktree` / 任意 ref
 * @param {number} [options.minLines]
 * @param {number} [options.lossRatio]
 * @param {string[]} [options.allow]      容忍的路径/目录前缀（逐条记账）
 */
export function audit({
  git,
  base,
  ours,
  theirs,
  result,
  minLines = DEFAULT_MIN_LINES,
  lossRatio = DEFAULT_LOSS_RATIO,
  allow = [],
}) {
  const baseTree = git.tree(base);
  const oursTree = git.tree(ours);
  const theirsTree = git.tree(theirs);

  let resultTree;
  let unmergedPaths = [];
  let resultLabel;
  let resultIsWorktree = false;
  if (result === 'index') {
    const idx = git.index();
    resultTree = idx.map;
    unmergedPaths = idx.unmerged;
    resultLabel = 'index（commit 将包含的内容）';
  } else if (result === 'worktree') {
    const all = new Set([...baseTree.keys(), ...oursTree.keys(), ...theirsTree.keys()]);
    resultTree = git.worktreePaths([...all]);
    resultIsWorktree = true;
    resultLabel = 'worktree（含未 stage 的改动）';
  } else {
    resultTree = git.tree(result);
    resultLabel = result;
  }

  const allPaths = [...new Set([
    ...baseTree.keys(), ...oursTree.keys(), ...theirsTree.keys(), ...resultTree.keys(),
  ])].sort();

  const allowed = (p) => allow.some((prefix) => p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));

  const byStatus = new Map();
  const droppedUpstream = [];
  const droppedOurs = [];
  const generatedHits = [];
  const reviewItems = [];
  const conflictMarkers = [];

  // 只有「双方都动过」的文件才可能既冲突又丢内容；先收一遍路径，一次读盘。
  // 绝不遍历全仓：一次同步涉及数千文件，逐个读盘会让审计慢到不可用。
  const suspects = [];
  for (const filePath of allPaths) {
    const info = {
      base: baseTree.get(filePath) ?? null,
      ours: oursTree.get(filePath) ?? null,
      theirs: theirsTree.get(filePath) ?? null,
      result: resultTree.get(filePath) ?? null,
    };
    const status = classifyFile(info);
    if (!status || status === 'identical') continue;
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    if (allowed(filePath)) continue;
    suspects.push({ filePath, info, status });
  }

  const worktreeTexts = resultIsWorktree
    ? git.worktreeTexts(suspects.map((s) => s.filePath))
    : null;

  /**
   * 结果里出现过的 blob SHA 集合，用于识别**内容搬迁**（文件级重命名）。
   *
   * 一侧删了 `old.ts`、结果里多了 `new.ts` 且内容一字未改时，Git 看到的是"删除 + 新增"，
   * 但语义上是搬家而非丢失——迁移编号顺移（上游 `0093_*.sql` → 产品线 `0096_*.sql`）
   * 就是最常见的一类。
   */
  const resultShas = resultIsWorktree ? null : new Set(resultTree.values());
  const keptElsewhereBySha = (sha) => Boolean(resultShas && sha && resultShas.has(sha));

  /**
   * 仅凭 SHA 还不够：迁移顺移常常只差一个尾随换行（上游 `SELECT 1;` 9 字节 vs
   * 产品线 `SELECT 1;\n` 10 字节），SHA 就不同了。所以再按**归一化内容**兜一层。
   * 候选只取 `added-by-result`（结果里的新路径）——搬迁的目标必然是这类，数量很小。
   */
  const droppedForRename = suspects.filter((s) => s.status === 'dropped-by-result');
  const addedForRename = suspects.filter((s) => s.status === 'added-by-result');
  const renameProbeShas = [];
  if (!resultIsWorktree) {
    for (const s of addedForRename) if (!isBinaryPath(s.filePath)) renameProbeShas.push(s.info.result);
    for (const s of droppedForRename) {
      if (isBinaryPath(s.filePath)) continue;
      if (s.info.ours) renameProbeShas.push(s.info.ours);
      if (s.info.theirs) renameProbeShas.push(s.info.theirs);
    }
  }
  const renameTexts = renameProbeShas.length > 0 ? git.blobs(renameProbeShas) : new Map();
  const resultContentKeys = new Set(
    addedForRename.map((s) => contentKey(renameTexts.get(s.info.result))).filter(Boolean),
  );
  const addedRenameKeys = new Set(addedForRename.map((s) => renameKey(s.filePath)));
  const keptElsewhereByContent = (sha) => {
    const key = contentKey(sha ? renameTexts.get(sha) : null);
    return Boolean(key && resultContentKeys.has(key));
  };

  // 批量取 blob：把本轮需要的 sha 一次喂给 `git cat-file --batch`
  const shas = [];
  for (const { filePath, info, status } of suspects) {
    if (status !== 'hand-merged' && status !== 'took-ours' && status !== 'took-theirs') continue;
    if (isBinaryPath(filePath)) continue;
    if (isGeneratedArtifact(filePath)) continue;
    if (!resultIsWorktree) shas.push(info.result);
    if (status === 'hand-merged' || status === 'took-theirs') shas.push(info.ours);
    if (status === 'hand-merged' || status === 'took-ours') shas.push(info.theirs);
    shas.push(info.base);
  }
  const texts = shas.length > 0 ? git.blobs(shas) : new Map();
  const textOfSha = (sha) => (sha ? (texts.get(sha) ?? null) : null);

  for (const { filePath, info, status } of suspects) {
    if (status === 'dropped-by-result') {
      // 同号段搬迁（迁移编号顺移）：既比不了 SHA 也比不了内容，降级为待确认
      if (addedRenameKeys.has(renameKey(filePath))) {
        reviewItems.push({ path: filePath, status: 'moved' });
        continue;
      }
      // "内容其实还在、只是换了路径"不算丢失
      const moved = (sha) => keptElsewhereBySha(sha) || keptElsewhereByContent(sha);
      if (lostFromResult({ base: info.base, side: info.theirs, other: info.ours, result: info.result }) && !moved(info.theirs)) {
        droppedUpstream.push({ path: filePath, kind: 'file-removed', side: 'upstream' });
      }
      if (lostFromResult({ base: info.base, side: info.ours, other: info.theirs, result: info.result }) && !moved(info.ours)) {
        droppedOurs.push({ path: filePath, kind: 'file-removed', side: 'ours' });
      }
      continue;
    }

    const hint = generatedArtifactHint(filePath);
    const bothMoved = info.ours !== info.base && info.theirs !== info.base;
    if (hint && (status === 'hand-merged' || status === 'took-ours' || status === 'took-theirs')) {
      generatedHits.push({ path: filePath, status, hint });
    }
    if (bothMoved && (status === 'took-ours' || status === 'took-theirs')) {
      reviewItems.push({ path: filePath, status });
    }

    // 内容级比对只对"结果与某一侧可能不同"的形态做。
    // `additive-*` 的 result blob 就等于那一侧，内容必然一致，比对纯属浪费——
    // 而这类文件在同步里占比最高（上游改动但产品线没碰）。
    const sidesToCheck = [];
    if (status === 'took-ours') sidesToCheck.push('theirs');
    if (status === 'took-theirs') sidesToCheck.push('ours');
    if (status === 'hand-merged') sidesToCheck.push('theirs', 'ours');
    if (sidesToCheck.length === 0) continue;
    if (isBinaryPath(filePath)) continue;
    // 生成物跳过内容级：正确形态由各自的校验命令保证，见 isGeneratedArtifact
    if (isGeneratedArtifact(filePath)) continue;

    const resultText = resultIsWorktree
      ? (worktreeTexts.get(filePath) ?? null)
      : textOfSha(info.result);

    // 冲突标记只可能出现在双方都动过的文件里 —— 在这里顺手查，
    // 比单独遍历全仓读盘快几个数量级。
    if (resultText != null) {
      const lines = normalizeText(resultText).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/^(<{7} |>{7} |>={7}$)/.test(lines[i])) {
          conflictMarkers.push({ path: filePath, line: i + 1, marker: lines[i].slice(0, 7) });
        }
      }
    }

    for (const side of sidesToCheck) {
      const label = side === 'theirs' ? 'upstream' : 'ours';
      const cmp = compareAdditions({
        baseText: textOfSha(info.base),
        sideText: textOfSha(info[side]),
        resultText,
        minLines,
        lossRatio,
      });
      if (!cmp || cmp.reformatted) continue;
      const row = { path: filePath, kind: 'lines-missing', side: label, status, ...cmp };
      (label === 'upstream' ? droppedUpstream : droppedOurs).push(row);
    }
  }

  return {
    base, ours, theirs, resultLabel,
    counts: {
      paths: allPaths.length,
      ...Object.fromEntries([...byStatus.entries()].map(([k, v]) => [k, v])),
    },
    unmergedPaths,
    conflictMarkers,
    droppedUpstream,
    droppedOurs,
    generatedHits,
    reviewItems,
  };
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

/**
 * 汇总各类发现。
 *
 * 生成物（lockfile / drizzle snapshot）**不计入失败**：它们本来就该与两侧都不同
 * （从源再生），"被改动过"本身无法自动判定对错——例如迁移编号顺移会让整批 snapshot
 * 都变成 hand-merged/took-ours 的正确结果。真正的丢失由内容级 DROPPED 抓；
 * 这里只负责提醒"记得从源再生并跑校验"。
 */
export function summarize(result) {
  const blockers = result.unmergedPaths.length + result.conflictMarkers.length;
  const dropped = result.droppedUpstream.length + result.droppedOurs.length;
  return {
    blockers,
    dropped,
    review: result.reviewItems.length,
    generated: result.generatedHits.length,
    fail: blockers > 0 || dropped > 0,
  };
}

export function formatReport(result, { maxFindings = 20 } = {}) {
  const lines = [];
  const push = (s = '') => lines.push(s);
  push('merge-resolution audit');
  push(`  base   = ${result.base}`);
  push(`  ours   = ${result.ours}  (产品线侧)`);
  push(`  theirs = ${result.theirs}  (上游侧)`);
  push(`  result = ${result.resultLabel}`);
  push('');

  const { blockers, dropped, review, generated } = summarize(result);

  if (blockers > 0) {
    push('BLOCKER —— 必须修完再提交');
    for (const p of result.unmergedPaths) push(`  ✗ 未解决冲突: ${p}`);
    for (const m of result.conflictMarkers.slice(0, maxFindings)) {
      push(`  ✗ 冲突标记残留: ${m.path}:${m.line}  ${m.marker}`);
    }
    push('');
  }

  if (dropped > 0) {
    push('DROPPED —— 一侧实质新增的内容在结果里缺失（这类丢失不会出现在 Git 冲突清单里）');
    const show = (rows, label) => {
      for (const row of rows.slice(0, maxFindings)) {
        if (row.kind === 'file-removed') {
          push(`  ✗ [${label}] 整个文件被丢: ${row.path}`);
        } else {
          const pct = Math.round(row.missingRatio * 100);
          push(`  ✗ [${label}] ${row.path}  ${row.missingLines}/${row.addedLines} 新增行缺失 (${pct}%, 丢失 token ${row.lostTokens}/${row.totalTokens})`);
          for (const s of row.samples) push(`        ${s}`);
        }
      }
      if (rows.length > maxFindings) push(`  … 另有 ${rows.length - maxFindings} 条`);
    };
    show(result.droppedUpstream, 'upstream');
    show(result.droppedOurs, 'ours');
    push('');
  }

  if (review > 0) {
    push('REVIEW —— 两侧都改过而结果整体等于其中一侧，或疑似搬迁，需人工确认是否丢了另一侧');
    for (const item of result.reviewItems.slice(0, maxFindings)) {
      if (item.status === 'moved') {
        push(`  ! ${item.path}  （疑似按编号顺移，确认内容真的是同一份）`);
      } else {
        const taken = item.status === 'took-ours' ? 'ours' : 'theirs';
        push(`  ! ${item.path}  == ${taken}`);
      }
    }
    if (result.reviewItems.length > maxFindings) push(`  … 另有 ${result.reviewItems.length - maxFindings} 条`);
    push('');
  }

  if (generated > 0) {
    push('GENERATED —— 这些文件是生成物，请确认是从源再生而不是手工解决（不阻断）');
    const byHint = new Map();
    for (const item of result.generatedHits) {
      if (!byHint.has(item.hint)) byHint.set(item.hint, []);
      byHint.get(item.hint).push(item.path);
    }
    for (const [hint, paths] of byHint) {
      push(`  ⚠ ${paths.length} 个文件：${hint}`);
      for (const p of paths.slice(0, 3)) push(`      ${p}`);
      if (paths.length > 3) push(`      … 另有 ${paths.length - 3} 个`);
    }
    push('');
  }

  push('SUMMARY');
  const c = result.counts;
  push(`  paths=${c.paths}  hand-merged=${c['hand-merged'] ?? 0}  took-ours=${c['took-ours'] ?? 0}  took-theirs=${c['took-theirs'] ?? 0}`);
  push(`  additive-ours=${c['additive-ours'] ?? 0}  additive-theirs=${c['additive-theirs'] ?? 0}  dropped-by-result=${c['dropped-by-result'] ?? 0}  added-by-result=${c['added-by-result'] ?? 0}`);
  push(`  blockers=${blockers}  dropped=${dropped}  review=${review}  generated=${generated}`);
  push(`  verdict: ${blockers > 0 || dropped > 0 ? 'FAIL' : review > 0 || generated > 0 ? 'PASS (有待确认项)' : 'PASS'}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    base: null, ours: null, theirs: null, result: null,
    minLines: DEFAULT_MIN_LINES, lossRatio: DEFAULT_LOSS_RATIO,
    allow: [], json: false, maxFindings: 20,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      return value;
    };
    if (arg === '--base') options.base = next();
    else if (arg === '--ours') options.ours = next();
    else if (arg === '--theirs') options.theirs = next();
    else if (arg === '--result') options.result = next();
    else if (arg === '--merge-commit') options.result = next();
    else if (arg === '--worktree') options.result = 'worktree';
    else if (arg === '--min-lines') options.minLines = Number(next());
    else if (arg === '--loss-ratio') options.lossRatio = Number(next());
    else if (arg === '--allow') options.allow.push(next());
    else if (arg === '--max-findings') options.maxFindings = Number(next());
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

export function resolveRange(git, options) {
  const mergeHead = options.theirs ? null : git.mergeHead();

  if (options.result && options.result !== 'index' && options.result !== 'worktree') {
    // merge 已提交：从 merge commit 的两个父推断，除非用户显式覆盖
    const commit = git.revParse(options.result);
    if (!commit) throw new Error(`--result 指向的 ref 不存在: ${options.result}`);
    if (!git.isMergeCommit(commit)) {
      throw new Error(`--result ${options.result} 不是 merge commit，请显式给出 --base/--ours/--theirs`);
    }
    const ours = options.ours ?? git.firstParent(commit);
    const theirs = options.theirs ?? git.secondParent(commit);
    const base = options.base ?? git.mergeBase(ours, theirs);
    return { base, ours, theirs, result: commit };
  }

  if (mergeHead) {
    const ours = options.ours ?? 'HEAD';
    const theirs = options.theirs ?? mergeHead;
    const base = options.base ?? git.mergeBase(ours, theirs);
    return { base, ours, theirs, result: options.result ?? 'index' };
  }

  // 没有进行中的 merge：要求显式给出范围
  const theirs = options.theirs ?? 'origin/main';
  const ours = options.ours ?? 'HEAD';
  const base = options.base ?? git.mergeBase(ours, theirs);
  return { base, ours, theirs, result: options.result ?? 'ours-commit' };
}

/**
 * CLI 入口。
 *
 * `rootOverride` 只为单测而存在——测试需要在临时仓库上跑完整流程（含退出码），
 * 不能落到本仓库上。生产调用不传。
 */
export function main(argv = process.argv.slice(2), { root: rootOverride } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[merge-audit] ${error.message}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const root = rootOverride ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const git = createGit(root);

  let range;
  try {
    range = resolveRange(git, options);
    if (!range.base || !range.ours || !range.theirs) {
      throw new Error('无法确定 base / ours / theirs，请用 --base/--ours/--theirs 显式指定');
    }
    if (range.result === 'ours-commit' || range.result === null) {
      // 无进行中 merge 且未指定结果：把 ours 当作已提交的结果（审计历史 merge 用 --merge-commit）
      range.result = options.result ?? range.ours;
    }
    const result = audit({
      git,
      base: range.base,
      ours: range.ours,
      theirs: range.theirs,
      result: range.result,
      minLines: options.minLines,
      lossRatio: options.lossRatio,
      allow: options.allow,
    });
    if (options.json) {
      console.log(JSON.stringify({ ...result, summary: summarize(result) }, null, 2));
    } else {
      console.log(formatReport(result, { maxFindings: options.maxFindings }));
    }
    return summarize(result).fail ? 1 : 0;
  } catch (error) {
    console.error(`[merge-audit] ${error.message}`);
    return 2;
  }
}

const USAGE = `merge-resolution audit —— 审计上游同步 merge 的解决结果，抓静默丢失

用法:
  node scripts/audit-merge-resolution.mjs [options]

自动推断（默认）:
  merge 进行中   base=merge-base(HEAD,MERGE_HEAD) ours=HEAD theirs=MERGE_HEAD result=index
  --merge-commit <ref>  base=merge-base(ref^1,ref^2) ours=ref^1 theirs=ref^2 result=ref

选项:
  --base <ref>           冲突基点（默认 merge-base）
  --ours <ref>           产品线侧（默认 HEAD）
  --theirs <ref>         上游侧（默认 MERGE_HEAD / origin/main）
  --result <ref>         merge 结果；或 --worktree 审工作区、默认 index
  --worktree             审计工作区实际文件（含未 stage 的手工修复）
  --merge-commit <ref>   审计已提交的 merge commit
  --min-lines <n>        触发报告的最少缺失行数（默认 ${DEFAULT_MIN_LINES}）
  --loss-ratio <0..1>    判定丢失的 token 占比阈值（默认 ${DEFAULT_LOSS_RATIO}）
  --allow <path>         容忍该路径/目录前缀，可重复（逐个记账）
  --max-findings <n>     每类最多展示条数（默认 20）
  --json                 输出 JSON
  -h, --help             显示本帮助

退出码: 0 通过 / 1 有 BLOCKER 或 DROPPED / 2 用法或仓库状态错误`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
