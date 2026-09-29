/**
 * Pi 远端钩子的 transport 分类回归（2026-09-29 实机缺口）。
 *
 * 现场：用户在 MCPR 位置下切到 Pi 引擎建任务，第一条消息报
 * ```
 * LAZY_CREATE_FAILED: remote SSH host "mcpr:f235de4c-…" not found in pool
 *   — connect it first under Settings → Remote
 * ```
 * 根因不是 SSH 主机没连，而是 **`mcpr:<instance.id>` 被喂进了 SSH pool**：
 * `packages/maker-core/src/agents/pi/index.ts` 的 startSession 对任何 `remoteHostId`
 * 都先调 `getRemotePiTransport`，而 `maker-host/index.ts` 里 Pi 的 6 个远端钩子当时
 * 没有一个走 `classifyRemoteSessionTransport` —— 对照 Claude / Codex 的同类钩子都走了。
 *
 * 为什么是「没有实现」而不是「暂时坏了」：MCPRouter 的 project-agent-instances 只宣告
 * `claude` / `codex`（`meka-settings/routerService.ts` 的 `normalizeInstance`），
 * 而 Pi 的远端形态只有 SSH（`docs/dev-rules/pi-harness.md`「SSH 远端能力」）。
 *
 * 本文件守三件事：
 *   1. 6 个 Pi 远端钩子在 `mcpr:` 上都必须抛**类型化**的 `MCPR_AGENT_UNSUPPORTED`，
 *      且**零次**触碰 SSH pool（行为级，不是字符序）；
 *   2. SSH host 的既有行为不变（分类器不能把合法路径也挡掉）；
 *   3. 源码级不变量：`index.ts` 里每个 `getRemoteSshPool().get(remoteHostId)` 所在的
 *      钩子体内都必须先出现共享分类器 —— 这条能抓住**将来新增**的未分类钩子，
 *      而前两条只能覆盖今天已知的 6 个（mcpr-remote-session-routing.md §3.7 的规则）。
 *
 * 提取而不是 import：`maker-host/index.ts` 是巨型组装函数，import 会拉起整个 Electron
 * main 依赖树；与 `mcprRemoteFileOps.test.ts` / `remoteCcQueryFactory.test.ts` 同一模式。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import {
  MCPR_AGENT_UNSUPPORTED_CODE,
  McprUnsupportedAgentError,
  assertMcprHostSupportsAgent,
  classifyRemoteSessionTransport,
} from '../remote-session-routing.js';

const source = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8').replace(/\r\n?/g, '\n');

/** Pi deps 里的 6 个远端钩子（`buildPiAgentForDesktop` 的 deps 对象）。 */
const PI_REMOTE_HOOKS = [
  'getRemotePiTransport',
  'getRemotePiFileOps',
  'getRemoteAgentFileOps',
  'resolveRemotePiBinaryPath',
  'rewriteRemotePiMcpBridgeUrl',
  'getRemotePiAgentProxyEnv',
] as const;

type PiRemoteHook = (typeof PI_REMOTE_HOOKS)[number];

/**
 * 按属性名逐字提取钩子体。
 *
 * 箭头体从 `=>` 之后第一个 `{` 起算，而不是属性名之后第一个 `{` ——
 * `getRemotePiTransport` 的参数是解构对象（`{ remoteBinaryPath, args, … }`），
 * 取错会把参数当函数体，平衡括号后得到一段无法执行的源码。
 *
 * `after` 用于重名钩子：`getRemoteAgentFileOps` 在 Claude / Codex / Pi 三处各有一份，
 * Pi 那份以 `getRemotePiFileOps` 为前驱锚点选取（错误串无法区分三者，
 * 见 `mcprRemoteFileOps.test.ts` 的同类注释）。
 */
function extractHookProperty(name: string, after?: string): string {
  const anchor = `\n      ${name}: `;
  const occurrences: number[] = [];
  for (let at = source.indexOf(anchor); at !== -1; at = source.indexOf(anchor, at + 1)) {
    occurrences.push(at);
  }
  const afterIndex = after ? source.indexOf(`\n      ${after}`) : -1;
  if (after) expect(afterIndex, `前驱锚点 ${after} 应存在`).toBeGreaterThan(-1);
  const candidates = after ? occurrences.filter((at) => at > afterIndex) : occurrences;
  expect(candidates.length, `${name}${after ? `（${after} 之后）` : ''} 应唯一`).toBe(1);
  const start = candidates[0] + 1;
  const arrow = source.indexOf('=>', start);
  expect(arrow, `${name} 应是箭头函数`).toBeGreaterThan(-1);
  const bodyStart = source.indexOf('{', arrow);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`未能闭合 ${name} 的钩子体`);
}

/** 去掉 TS 语法（提取出的是对象字面量的属性片段，在 TS 里是合法的箭头函数表达式）。 */
function stripTypeScriptSyntax(code: string): string {
  return ts
    .transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    })
    .outputText.trim()
    .replace(/;\s*$/, '');
}

interface PiHookDeps {
  poolGet: ReturnType<typeof vi.fn>;
  createFileOps: ReturnType<typeof vi.fn>;
  remoteProxyEnv: ReturnType<typeof vi.fn>;
}

/** Pi 侧重名钩子的前驱锚点（三份 `getRemoteAgentFileOps` 里只有 Pi 那份紧跟本属性）。 */
function piHookSource(name: string): string {
  return name === 'getRemoteAgentFileOps'
    ? extractHookProperty(name, 'getRemotePiFileOps: (remoteHostId) => {')
    : extractHookProperty(name);
}

/**
 * 用真实钩子源码 + 注入依赖构造可调用函数。
 *
 * 只注入 `mcpr:` 分支会走到的符号是**刻意**的：门禁必须在这条路径上第一句就抛，
 * 后面的远端安装 / transport 组装根本不该被求值。SSH 分支要的符号另行按需给桩。
 */
function buildPiHook(
  name: PiRemoteHook,
  deps: PiHookDeps,
  extra: Record<string, unknown> = {},
): (...args: unknown[]) => unknown {
  const hookSource = stripTypeScriptSyntax(piHookSource(name));
  const injected = {
    classifyRemoteSessionTransport,
    assertMcprHostSupportsAgent,
    getRemoteSshPool: () => ({ get: deps.poolGet }),
    createRemotePiFileOps: deps.createFileOps,
    resolveRemotePiBinaryPath: async () => '/remote/pi',
    getRemoteAgentProxyEnv: deps.remoteProxyEnv,
    PI_MCP_FORWARD_PORT_START: 20000,
    ensurePiManagerInstalled: async () => undefined,
    broadcastSilentInstallStatus: () => undefined,
    createPiRemoteProviderForwardLease: () => ({
      ensure: async () => undefined,
      releaseAll: async () => undefined,
    }),
    createSshPiDaemonTransport: () => ({ close: async () => undefined }),
    desktopMakerLogger: { child: () => ({ info: () => undefined, warn: () => undefined }) },
    ...extra,
  };
  const names = Object.keys(injected);
  const factory = new Function(
    ...names,
    `return ({ ${hookSource} })['${name}'];`,
  ) as (...values: unknown[]) => (...args: unknown[]) => unknown;
  return factory(...names.map((key) => injected[key as keyof typeof injected]));
}

const SSH_FILE_OPS = { readFile: vi.fn(async () => ''), sha256File: vi.fn(async () => 'hash') };

function deps(): PiHookDeps {
  return {
    poolGet: vi.fn(() => undefined),
    createFileOps: vi.fn(() => SSH_FILE_OPS),
    remoteProxyEnv: vi.fn(async () => null),
  };
}

/** 每个钩子的最小实参表（门禁在第一句，后面的实参不参与分类判断）。 */
const HOOK_ARGS: Record<PiRemoteHook, unknown[]> = {
  getRemotePiTransport: ['', { args: [], cwd: '/remote/wd', env: {}, sessionId: 's1' }],
  getRemotePiFileOps: [''],
  getRemoteAgentFileOps: [''],
  resolveRemotePiBinaryPath: [''],
  rewriteRemotePiMcpBridgeUrl: ['', 'http://127.0.0.1:41000/mcp/ghost'],
  getRemotePiAgentProxyEnv: [''],
};

function callHook(
  name: PiRemoteHook,
  remoteHostId: string,
  d: PiHookDeps,
): Promise<unknown> | unknown {
  const hook = buildPiHook(name, d);
  const args = [...HOOK_ARGS[name]];
  args[0] = remoteHostId;
  return hook(...args);
}

describe('Pi 远端钩子：`mcpr:<id>` 不得进入 SSH pool（现场缺口）', () => {
  it.each(PI_REMOTE_HOOKS)('%s 收到 mcpr: 时抛类型化 MCPR_AGENT_UNSUPPORTED', async (name) => {
    const d = deps();
    await expect(Promise.resolve().then(() => callHook(name, 'mcpr:instance-1', d))).rejects.toMatchObject({
      code: MCPR_AGENT_UNSUPPORTED_CODE,
    });
    expect(d.poolGet).not.toHaveBeenCalled();
    expect(d.createFileOps).not.toHaveBeenCalled();
  });

  it.each(PI_REMOTE_HOOKS)('%s 的报错里不再出现误导性的 remote SSH host 归因', async (name) => {
    const d = deps();
    const failure = await Promise.resolve()
      .then(() => callHook(name, 'mcpr:instance-1', d))
      .then(
        () => null,
        (err: unknown) => err as Error,
      );
    expect(failure, `${name} 必须失败`).toBeInstanceOf(McprUnsupportedAgentError);
    expect(failure?.message).toContain('[MCPR_AGENT_UNSUPPORTED]');
    expect(failure?.message).not.toContain('remote SSH host');
    expect(failure?.message).not.toContain('not found in pool');
    expect(d.poolGet).not.toHaveBeenCalled();
  });

  it.each(PI_REMOTE_HOOKS)('%s 对畸形的 `mcpr:` 同样不降级成 SSH host', async (name) => {
    const d = deps();
    expect(classifyRemoteSessionTransport('mcpr:')).toBe('mcpr');
    await expect(Promise.resolve().then(() => callHook(name, 'mcpr:', d))).rejects.toMatchObject({
      code: MCPR_AGENT_UNSUPPORTED_CODE,
    });
    expect(d.poolGet).not.toHaveBeenCalled();
  });
});

describe('Pi 远端钩子：SSH host 的既有行为不变', () => {
  it('getRemotePiFileOps 仍然先查 pool 再建远端 file ops', () => {
    const d = deps();
    const remoteHost = { id: 'ssh-host-1' };
    d.poolGet.mockReturnValue(remoteHost);

    expect(callHook('getRemotePiFileOps', 'ssh-host-1', d)).toBe(SSH_FILE_OPS);
    expect(d.poolGet).toHaveBeenCalledWith('ssh-host-1');
    expect(d.createFileOps).toHaveBeenCalledWith(remoteHost);
  });

  it('getRemoteAgentFileOps（Pi 侧）与 getRemotePiFileOps 同形', () => {
    const d = deps();
    const remoteHost = { id: 'ssh-host-1' };
    d.poolGet.mockReturnValue(remoteHost);

    expect(callHook('getRemoteAgentFileOps', 'ssh-host-1', d)).toBe(SSH_FILE_OPS);
    expect(d.poolGet).toHaveBeenCalledWith('ssh-host-1');
  });

  it('resolveRemotePiBinaryPath 仍然 probe SSH host', async () => {
    const d = deps();
    d.poolGet.mockReturnValue({ id: 'ssh-host-1' });

    await expect(callHook('resolveRemotePiBinaryPath', 'ssh-host-1', d)).resolves.toBe('/remote/pi');
    expect(d.poolGet).toHaveBeenCalledWith('ssh-host-1');
  });

  it('getRemotePiAgentProxyEnv 仍然走 SSH host', async () => {
    const d = deps();
    d.poolGet.mockReturnValue({ id: 'ssh-host-1' });

    await expect(callHook('getRemotePiAgentProxyEnv', 'ssh-host-1', d)).resolves.toBeNull();
    expect(d.poolGet).toHaveBeenCalledWith('ssh-host-1');
  });

  it('getRemotePiTransport 的 SSH 分支仍然查 pool（不再被门禁误挡）', async () => {
    const d = deps();
    d.poolGet.mockReturnValue({ id: 'ssh-host-1', getStatus: () => 'ready' });

    // SSH 分支后面要组装 daemon transport，本用例只断言「分类器放行、走到了 pool」；
    // 之后的失败（缺 host 方法等）与本次门禁无关，不吞也不断言其类型。
    await Promise.resolve()
      .then(() => callHook('getRemotePiTransport', 'ssh-host-1', d))
      .catch(() => undefined);
    expect(d.poolGet).toHaveBeenCalledWith('ssh-host-1');
  });

  it('SSH host 不在 pool 时仍然 fail loud（不静默吞成空 reader）', () => {
    const d = deps();
    expect(() => callHook('getRemotePiFileOps', 'ssh-host-1', d)).toThrow(
      /remote SSH host "ssh-host-1" not found in pool/,
    );
    expect(d.poolGet).toHaveBeenCalledWith('ssh-host-1');
  });
});

describe('源码级不变量：index.ts 里每个 SSH pool 查询所在的钩子都必须先分类', () => {
  /**
   * 扫描所有 `getRemoteSshPool().get(remoteHostId)`，回溯到最近的 6 空格缩进属性声明
   * （`      name: `），取出该属性体，要求体内出现共享分类器。
   *
   * 缩进必须精确匹配 6 空格：钩子体内是 8 空格，用 `lastIndexOf('\n      ')` 之类的
   * 前缀匹配会落到体内任意一行上，取到的就不是属性声明。
   *
   * 只覆盖形参名恰好是 `remoteHostId`（远端 transport 钩子的统一命名）的查询；
   * 用 `hostId` 的几处是 codex bridge 恢复类查询，未命中时只当作「host 未就绪」跳过、
   * 不产生误导错误，未纳入本不变量（见交付说明的存量清单）。
   */
  it('没有未分类的 remoteHostId 型 SSH pool 查询', () => {
    const needle = 'getRemoteSshPool().get(remoteHostId)';
    const declarationRe = /^ {6}([A-Za-z_$][\w$]*): /gm;
    const offences: string[] = [];
    let cursor = source.indexOf(needle);
    let scanned = 0;
    while (cursor !== -1) {
      scanned += 1;
      declarationRe.lastIndex = 0;
      let found: { name: string; index: number } | null = null;
      for (let m = declarationRe.exec(source); m && m.index < cursor; m = declarationRe.exec(source)) {
        found = { name: m[1], index: m.index };
      }
      expect(found, `offset ${cursor} 处应能回溯到属性声明`).not.toBeNull();
      const declaration = found as { name: string; index: number };
      const arrow = source.indexOf('=>', declaration.index);
      const bodyStart = source.indexOf('{', arrow);
      let depth = 0;
      let body = '';
      for (let i = bodyStart; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            body = source.slice(bodyStart, i + 1);
            break;
          }
        }
      }
      const classified =
        body.includes('classifyRemoteSessionTransport(') ||
        body.includes('assertMcprHostSupportsAgent(');
      if (!classified) offences.push(`${declaration.name} (offset ${cursor})`);
      cursor = source.indexOf(needle, cursor + needle.length);
    }
    expect(scanned, '应至少扫到一个查询（口径活性）').toBeGreaterThan(0);
    expect(offences, `未先分类就查 SSH pool 的钩子：\n${offences.join('\n')}`).toEqual([]);
  });
});

describe('assertMcprHostSupportsAgent 的判定语义', () => {
  it('本地 / SSH 一律放行（分类器不能把既有路径也挡掉）', () => {
    expect(() => assertMcprHostSupportsAgent('pi', 'ssh-host-1')).not.toThrow();
    expect(() => assertMcprHostSupportsAgent('pi', null as unknown as string)).not.toThrow();
    expect(() => assertMcprHostSupportsAgent('pi', '')).not.toThrow();
  });

  it('mcpr: 上 claude-code / codex 放行，其余引擎拒绝', () => {
    expect(() => assertMcprHostSupportsAgent('claude-code', 'mcpr:instance-1')).not.toThrow();
    expect(() => assertMcprHostSupportsAgent('codex', 'mcpr:instance-1')).not.toThrow();
    expect(() => assertMcprHostSupportsAgent('pi', 'mcpr:instance-1')).toThrow(
      McprUnsupportedAgentError,
    );
  });

  it('拒绝时带上引擎与主机身份，便于日志与 UI 归类', () => {
    try {
      assertMcprHostSupportsAgent('pi', 'mcpr:instance-1');
      throw new Error('应当抛出');
    } catch (err) {
      expect(err).toBeInstanceOf(McprUnsupportedAgentError);
      const typed = err as McprUnsupportedAgentError;
      expect(typed.code).toBe(MCPR_AGENT_UNSUPPORTED_CODE);
      expect(typed.agentKind).toBe('pi');
      expect(typed.remoteHostId).toBe('mcpr:instance-1');
      expect(typed.name).toBe('McprUnsupportedAgentError');
    }
  });
});
