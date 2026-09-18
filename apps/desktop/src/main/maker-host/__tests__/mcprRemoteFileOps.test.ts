/**
 * WL-4.1.2 行为级回归：`getRemoteAgentFileOps` 收到 `mcpr:<instance.id>` 时
 * **不得触碰 SSH pool**。
 *
 * 为什么需要这个文件（缺口记录见 `docs/dev-rules/meka-whitelist-verification.md`
 * WL-4.1.2「覆盖缺口」）：既有断言是**源码文本序**（`remoteCcQueryFactory.test.ts`
 * 的 `indexOf` 比较），它只能证明「guard 写在前面」，不能证明行为。本文件把
 * `maker-host/index.ts` 里 Codex deps 的那**一个**真实钩子体逐字提取出来，注入
 * spy 依赖后**实际执行**，断言：
 *
 *   1. `mcpr:<id>` ⇒ `getRemoteSshPool()` **零调用**、不抛 `remote SSH host ...`；
 *   2. SSH host ⇒ 仍然走 pool（新 guard 不改变既有行为）；
 *   3. SSH host 不在 pool ⇒ 仍然 fail loud（不把 SSH 故障静默吞成空 reader）；
 *   4. 下游 `hasCurrentTeammateInstructions` 在空 reader 下判「不可读 ⇒ 重新投递」。
 *
 * 提取而不是 import：`maker-host/index.ts` 是巨型组装函数，import 会拉起整个
 * Electron main 依赖树；与 `remoteCcQueryFactory.test.ts` 同一模式，但这里执行真实
 * 函数体而非比较字符序。
 *
 * 回归来源：2026-09 同步把上游 Codex teammate-resume 分支接进来
 * （`packages/maker-core/src/agents/codex/index.ts` 的 `hasCurrentTeammateInstructions`
 * 调用），该调用点无条件先求值本钩子；远程会话 `useProxyChannel` 恒为 false，于是
 * MCPRouter 会话 resume 时必然走到 SSH pool 并抛
 * `remote SSH host "mcpr:<id>" is not connected`。
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { classifyRemoteSessionTransport } from '../remote-session-routing.js';
import { parseMcprRemoteHostId } from '../../../shared/meka-router.js';

interface TeammateInstructionsModule {
  hasCurrentTeammateInstructions(
    rolloutPath: string | undefined,
    marker: string,
    remote?: { readFileTail?: (file: string, maxBytes: number) => Promise<string> },
  ): Promise<boolean>;
  teammateRuntimeInstructionItem(instructions: string): { marker: string };
}

// maker-core 的公共出口没有 re-export 这两个内部工具(它们只在 codex 内部使用),
// 而 package.json 的 exports 不允许子路径导入。所以先解析包入口, 再相对它加载文件：
// 万一是 pnpm 符号链接布局也能落到同一份 maker-core 源(与运行时同源), 不是拷贝。
const teammateRequire = createRequire(import.meta.url);
const teammate = teammateRequire(
  // 包入口 `.../maker-core/src/index.ts` ⇒ 同目录树下的 codex 内部模块。
  teammateRequire.resolve('@cindy/maker-core').replace(/[\\/]index\.ts$/, '/agents/codex/teammate-runtime-instructions.ts'),
) as TeammateInstructionsModule;

const source = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8').replace(/\r\n?/g, '\n');

/**
 * 逐字提取 Codex deps 里那一个钩子体。
 *
 * 三个 `getRemoteAgentFileOps` 实现中只有 Codex 这一个抛
 * `remote SSH host "<id>" is not connected`（无 "not found in pool" 后缀），
 * 因此以该错误串定位唯一块，并断言只命中一次。
 */
function extractCodexHookSource(): string {
  const anchor = 'throw new Error(`remote SSH host "${remoteHostId}" is not connected`)';
  expect(source.split(anchor).length - 1, 'Codex getRemoteAgentFileOps 锚点应唯一').toBe(1);
  const anchorIdx = source.indexOf(anchor);
  const start = source.lastIndexOf('getRemoteAgentFileOps:', anchorIdx);
  expect(start, '锚点前应能找到钩子声明').toBeGreaterThan(-1);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('未能闭合钩子体');
}

/**
 * 去掉 TS 专属语法(node 的 `Function` 构造器只吃 JS)。
 *
 * 用真正的 TypeScript transpile，而不是逐条正则：这个 helper 被 Codex 侧与 Claude
 * 侧两个提取器共用，而 `maker-host/index.ts` 的两个钩子体会随实现演进换写法
 * （已实测出现过 `const v: PiRemoteFileOps = {}`、`return {} as Pick<...>`、
 * `type X = ReturnType<...>; return {} as unknown as X` 三种）。每换一次写法就补一条
 * 正则，等于让**测试**跟着实现漂移，且失败信息是 `new Function` 的
 * `SyntaxError: Unexpected identifier 'as'`，与真实回归无法区分。
 *
 * 提取出来的是对象字面量的**属性**片段（`name: (arg) => { ... }`，不含尾逗号），
 * 在 TS 里是合法的「labeled statement + 箭头函数表达式」，transpile 后仍是同一形状。
 * 结尾的 `;` 是 TS 为表达式语句补的，嵌回 `({ ... })` 前要去掉。
 *
 * 仍然保留纯函数形态（输入串 → 输出串），调用方不需要知道实现方式。
 */
function stripTypeScriptSyntax(code: string): string {
  return ts
    .transpileModule(code, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.trim()
    .replace(/;\s*$/, '');
}

interface HookDeps {
  poolGet: ReturnType<typeof vi.fn>;
  createFileOps: ReturnType<typeof vi.fn>;
}

/** 用真实钩子源码 + 注入依赖构造一个可调用函数（不 import 整个 index.ts）。 */
function buildCodexHook(deps: HookDeps): (remoteHostId: string) => unknown {
  const hookSource = stripTypeScriptSyntax(extractCodexHookSource());
  const factory = new Function(
    'getRemoteSshPool',
    'createRemotePiFileOps',
    'classifyRemoteSessionTransport',
    `return ({ ${hookSource} }).getRemoteAgentFileOps;`,
  ) as (
    pool: () => { get: unknown },
    createFileOps: unknown,
    classify: unknown,
  ) => (remoteHostId: string) => unknown;
  return factory(
    () => ({ get: deps.poolGet }),
    deps.createFileOps,
    classifyRemoteSessionTransport,
  );
}

const SSH_FILE_OPS = {
  stat: vi.fn(async () => ({ isFile: true })),
  listDir: vi.fn(async () => []),
  readFile: vi.fn(async () => ''),
  sha256File: vi.fn(async () => 'hash'),
};

function deps(): HookDeps {
  return {
    poolGet: vi.fn(() => undefined),
    createFileOps: vi.fn(() => SSH_FILE_OPS),
  };
}

describe('Codex getRemoteAgentFileOps 的 transport 分类（WL-4.1.2）', () => {
  it('`mcpr:<instance.id>` 不查 SSH pool，也不抛 remote SSH host ... is not connected', () => {
    const d = deps();
    const hook = buildCodexHook(d);

    expect(() => hook('mcpr:instance-1')).not.toThrow();
    expect(d.poolGet).not.toHaveBeenCalled();
    expect(d.createFileOps).not.toHaveBeenCalled();
  });

  it('不完整/畸形的 `mcpr:` 同样不降级成 SSH host（保持 MCPRouter 错误路径）', () => {
    const d = deps();
    const hook = buildCodexHook(d);

    // `mcpr:` 是分类器按前缀识别的 malformed 值：它必须留在 MCPRouter 错误路径，
    // 不能落到 SSH pool 变成 SSH_HOST_NOT_FOUND。
    expect(classifyRemoteSessionTransport('mcpr:')).toBe('mcpr');
    expect(parseMcprRemoteHostId('mcpr:')).toBeNull();

    expect(() => hook('mcpr:')).not.toThrow();
    expect(d.poolGet).not.toHaveBeenCalled();
  });

  it('返回的空 reader 让下游判「不可读 ⇒ 重新投递指令」，而不是跳过', async () => {
    const d = deps();
    const hook = buildCodexHook(d);
    const fileOps = hook('mcpr:instance-1') as Record<string, unknown>;
    const current = teammate.teammateRuntimeInstructionItem('CURRENT TEAMMATE BASELINE');

    expect(fileOps.readFileTail).toBeUndefined();
    // 与 codex/index.ts 调用点同形：opts.remoteHostId ? getRemoteAgentFileOps(...) ?? {} : undefined
    const shouldInject = !(await teammate.hasCurrentTeammateInstructions(
      '/remote/codex/sessions/rollout.jsonl',
      current.marker,
      fileOps,
    ));
    expect(shouldInject).toBe(true);
    // 空 reader ≠ 本地回退：它绝不能去读本机同名路径。
    expect(d.poolGet).not.toHaveBeenCalled();
  });

  it('SSH host 仍然先查 pool 再建远端 file ops（新 guard 不改变既有行为）', () => {
    const d = deps();
    const remoteHost = { id: 'ssh-host-1' };
    d.poolGet.mockReturnValue(remoteHost);
    const hook = buildCodexHook(d);

    expect(hook('ssh-host-1')).toBe(SSH_FILE_OPS);
    expect(d.poolGet).toHaveBeenCalledWith('ssh-host-1');
    expect(d.createFileOps).toHaveBeenCalledWith(remoteHost);
  });

  it('SSH host 不在 pool 时仍然 fail loud（不把 SSH 故障静默吞成空 reader）', () => {
    const d = deps();
    const hook = buildCodexHook(d);

    expect(() => hook('ssh-host-1')).toThrow('remote SSH host "ssh-host-1" is not connected');
    expect(d.poolGet).toHaveBeenCalledWith('ssh-host-1');
  });
});

describe('空 reader 的下游契约（teammate 指令去重）', () => {
  it('缺失、被压缩、不可读一律判「重新投递」', async () => {
    const marker = teammate.teammateRuntimeInstructionItem('BASELINE').marker;
    // 无 rollout 路径
    expect(await teammate.hasCurrentTeammateInstructions(undefined, marker, {})).toBe(false);
    // 远端 reader 无 readFileTail（空 reader 形态）
    expect(await teammate.hasCurrentTeammateInstructions('/remote/rollout.jsonl', marker, {})).toBe(
      false,
    );
    // 远端读失败
    expect(
      await teammate.hasCurrentTeammateInstructions('/remote/rollout.jsonl', marker, {
        readFileTail: async () => {
          throw new Error('remote unreachable');
        },
      }),
    ).toBe(false);
  });
});

/* ==========================================================================
 * Claude 侧同一缺口（任务 3 / AUDIT-3）
 *
 * Claude 的 `getRemoteAgentFileOps` 也曾经是 SSH-only:`getRemoteSshPool().get()`
 * 未命中就抛 `remote SSH host "<id>" not found in pool — ...`。它的唯一消费方是
 * `ClaudeCodeAgent.listAgentSkills`, 所以 MCPRouter(`mcpr:`) Claude 会话做远端
 * Skill 发现时会拿 SSH pool 的错误。
 *
 * 与 Codex 侧保持同一形态:分类器先行,`mcpr:` 不碰 SSH pool。**但 Claude 侧不能
 * 像 Codex 那样退化成空 reader** ——
 *   1. `scanRemoteClaudeSkills` 直接调 `fileOps.listDir/stat/readFile`, 传 `{}`
 *      会 TypeError, 不是安全退化;
 *   2. `listAgentSkills` 的结果进 `botProfileRuntime` 的远程 Skill catalog, 而它
 *      对 `remoteHostId` 会话要求「读不到 catalog ⇒ 抛错」
 *      (`botProfileRuntime.ts` 的 `if (opts.remoteHostId) throw error`, 有
 *      `refuses to start a remote Bot when its native Skill catalog is unavailable`
 *      守这条):空 catalog 会把用户配置的 Skill 全标成 unavailable, 而远端 harness
 *      仍能发现环境技能 ⇒ 快照与实际分叉。
 * 因此这里断言的是「不查 pool + 不报 SSH 错误 + 仍是 fail-closed 抛错」, 而不是
 * 「返回空 reader」。
 * ========================================================================== */

/**
 * 逐字提取 Claude deps 里那一个钩子体。
 *
 * Claude 与 Pi 两个实现连错误串都完全一样, 无法按错误串定位; 因此锚定所属的
 * agent 构造点 `new ClaudeCodeAgent({`(全文件唯一), 取它之后的第一个钩子声明,
 * 再用 `[MCPR_FILE_OPS_UNAVAILABLE]` 反证抓到的确实是 Claude 那一份。
 */
function extractClaudeHookSource(): string {
  const agentAnchor = 'new ClaudeCodeAgent({';
  expect(source.split(agentAnchor).length - 1, 'ClaudeCodeAgent 构造点应唯一').toBe(1);
  const start = source.indexOf('getRemoteAgentFileOps:', source.indexOf(agentAnchor));
  expect(start, 'Claude 构造点之后应能找到钩子声明').toBeGreaterThan(-1);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const body = source.slice(start, i + 1);
        expect(body, '抓到的必须是 Claude 那一份钩子').toContain('[MCPR_FILE_OPS_UNAVAILABLE]');
        return body;
      }
    }
  }
  throw new Error('未能闭合 Claude 钩子体');
}

function buildClaudeHook(deps: HookDeps): (remoteHostId: string) => unknown {
  const hookSource = stripTypeScriptSyntax(extractClaudeHookSource());
  const factory = new Function(
    'getRemoteSshPool',
    'createRemotePiFileOps',
    'classifyRemoteSessionTransport',
    `return ({ ${hookSource} }).getRemoteAgentFileOps;`,
  ) as (
    pool: () => { get: unknown },
    createFileOps: unknown,
    classify: unknown,
  ) => (remoteHostId: string) => unknown;
  return factory(
    () => ({ get: deps.poolGet }),
    deps.createFileOps,
    classifyRemoteSessionTransport,
  );
}

describe('Claude getRemoteAgentFileOps 的 transport 分类（任务 3）', () => {
  it('`mcpr:<instance.id>` 不查 SSH pool，也不再报 remote SSH host 错误', () => {
    const d = deps();
    const hook = buildClaudeHook(d);

    expect(() => hook('mcpr:instance-1')).toThrow(/\[MCPR_FILE_OPS_UNAVAILABLE\]/);
    // 旧形态是 `remote SSH host "mcpr:..." not found in pool` —— 那是把 MCPRouter
    // 身份当 SSH host 查出来的错误。
    expect(() => hook('mcpr:instance-1')).not.toThrow(/remote SSH host/);
    expect(d.poolGet).not.toHaveBeenCalled();
    expect(d.createFileOps).not.toHaveBeenCalled();
  });

  it('不完整/畸形的 `mcpr:` 同样不降级成 SSH host', () => {
    const d = deps();
    const hook = buildClaudeHook(d);

    expect(classifyRemoteSessionTransport('mcpr:')).toBe('mcpr');
    expect(parseMcprRemoteHostId('mcpr:')).toBeNull();

    expect(() => hook('mcpr:')).toThrow(/\[MCPR_FILE_OPS_UNAVAILABLE\]/);
    expect(d.poolGet).not.toHaveBeenCalled();
  });

  it('SSH host 仍然先查 pool 再建远端 file ops（新 guard 不改变既有行为）', () => {
    const d = deps();
    const remoteHost = { id: 'ssh-host-1' };
    d.poolGet.mockReturnValue(remoteHost);
    const hook = buildClaudeHook(d);

    expect(hook('ssh-host-1')).toBe(SSH_FILE_OPS);
    expect(d.poolGet).toHaveBeenCalledWith('ssh-host-1');
    expect(d.createFileOps).toHaveBeenCalledWith(remoteHost);
  });

  it('SSH host 不在 pool 时仍然 fail loud（不把 SSH 故障静默吞掉）', () => {
    const d = deps();
    const hook = buildClaudeHook(d);

    expect(() => hook('ssh-host-1')).toThrow(
      'remote SSH host "ssh-host-1" not found in pool',
    );
    expect(d.poolGet).toHaveBeenCalledWith('ssh-host-1');
  });
});
