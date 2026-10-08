/**
 * Pi 远端钩子的 transport 分类回归（2026-09-29 缺口 → 2026-10-09 `mode=pi` 隧道落地）。
 *
 * 现场（2026-09-29）：用户在 MCPR 位置下切到 Pi 引擎建任务，第一条消息报
 * ```
 * LAZY_CREATE_FAILED: remote SSH host "mcpr:f235de4c-…" not found in pool
 *   — connect it first under Settings → Remote
 * ```
 * 根因不是 SSH 主机没连，而是 **`mcpr:<instance.id>` 被喂进了 SSH pool**：
 * `packages/maker-core/src/agents/pi/index.ts` 的 startSession 对任何 `remoteHostId`
 * 都先调 `getRemotePiTransport`，而当时 Pi 的远端钩子一个都没走 transport 分类。
 *
 * 2026-10-09 起 MCPRouter 有了两条隧道（`mode=pi` 数据面 / `mode=exec` 执行面），
 * 因此本文件守的是**新契约**：
 *   1. 每个 Pi 远端钩子在 `mcpr:` 上都必须走**隧道实现**（零次触碰 SSH pool），
 *      SSH 分支的行为一字不变；
 *   2. 源码级不变量：`index.ts` 里每个 `getRemoteSshPool().get(remoteHostId)` 所在的
 *      钩子体内都必须先出现共享分类器 —— 这条能抓住**将来新增**的未分类钩子。
 *
 * 提取而不是 import：`maker-host/index.ts` 是巨型组装函数，import 会拉起整个 Electron
 * main 依赖树；与 `mcprRemoteFileOps.test.ts` / `remoteCcQueryFactory.test.ts` 同一模式。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { classifyRemoteSessionTransport } from '../remote-session-routing.js';

const source = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8').replace(/\r\n?/g, '\n');

/** Pi deps 里的 6 个远端钩子 + 伙伴 Skill 的两个远端读取钩子。 */
const PI_REMOTE_HOOKS = [
  'getRemotePiTransport',
  'getRemotePiFileOps',
  'getRemoteAgentFileOps',
  'resolveRemotePiBinaryPath',
  'rewriteRemotePiMcpBridgeUrl',
  'getRemotePiAgentProxyEnv',
  'readSkillSource',
  'fingerprintSkillSource',
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

/** Pi 侧重名钩子的前驱锚点（三份 `getRemoteAgentFileOps` 里只有 Pi 那份紧跟本属性）。 */
function piHookSource(name: string): string {
  return name === 'getRemoteAgentFileOps'
    ? extractHookProperty(name, 'getRemotePiFileOps: (remoteHostId) => {')
    : extractHookProperty(name);
}

const SSH_FILE_OPS = {
  readFile: vi.fn(async () => 'ssh'),
  sha256File: vi.fn(async () => 'ssh-hash'),
};
const MCPR_FILE_OPS = {
  readFile: vi.fn(async () => 'mcpr'),
  sha256File: vi.fn(async () => 'mcpr-hash'),
};

interface PiHookDeps {
  poolGet: ReturnType<typeof vi.fn>;
  createFileOps: ReturnType<typeof vi.fn>;
  createMcprFileOps: ReturnType<typeof vi.fn>;
  createMcprTransport: ReturnType<typeof vi.fn>;
  resolveMcprBinaryPath: ReturnType<typeof vi.fn>;
  mcprBridgeUnavailable: ReturnType<typeof vi.fn>;
  mcprProxyEnv: ReturnType<typeof vi.fn>;
  sshProxyEnv: ReturnType<typeof vi.fn>;
}

/**
 * 用真实钩子源码 + 注入依赖构造可调用函数。
 *
 * 注入的符号必须覆盖钩子体里出现的**每一个标识符**（`new Function` 只认参数），因此
 * 本地分支用到的 `fs` / `fsSync` / `createHash` 也一并给桩 —— 它们在本用例的
 * `mcpr:` / SSH 远端分支里不会被求值。
 */
function buildPiHook(
  name: PiRemoteHook,
  deps: PiHookDeps,
  extra: Record<string, unknown> = {},
): (...args: unknown[]) => unknown {
  const hookSource = stripTypeScriptSyntax(piHookSource(name));
  const injected: Record<string, unknown> = {
    classifyRemoteSessionTransport,
    getRemoteSshPool: () => ({ get: deps.poolGet }),
    createRemotePiFileOps: deps.createFileOps,
    createMcprPiFileOps: deps.createMcprFileOps,
    createMcprPiTransport: deps.createMcprTransport,
    resolveMcprPiBinaryPath: deps.resolveMcprBinaryPath,
    resolveRemotePiBinaryPath: async () => '/remote/pi',
    mcprPiMcpBridgeUnavailable: deps.mcprBridgeUnavailable,
    resolveMcprPiAgentProxyEnv: deps.mcprProxyEnv,
    getRemoteAgentProxyEnv: deps.sshProxyEnv,
    shouldSkipMcprPiMcpBridge: () => true,
    PI_MCP_FORWARD_PORT_START: 20000,
    ensurePiManagerInstalled: async () => undefined,
    broadcastSilentInstallStatus: () => undefined,
    createPiRemoteProviderForwardLease: () => ({
      ensure: async () => undefined,
      releaseAll: async () => undefined,
    }),
    createSshPiDaemonTransport: () => ({ close: async () => undefined }),
    desktopMakerLogger: { child: () => ({ info: () => undefined, warn: () => undefined }) },
    fs: { readFile: async () => 'local' },
    fsSync: { createReadStream: () => ({ [Symbol.asyncIterator]: async function* () { /* empty */ } }) },
    createHash: () => ({ update: () => ({ digest: () => 'local-hash' }) }),
    ...extra,
  };
  const names = Object.keys(injected);
  const factory = new Function(
    ...names,
    `return ({ ${hookSource} })['${name}'];`,
  ) as (...values: unknown[]) => (...args: unknown[]) => unknown;
  return factory(...names.map((key) => injected[key]));
}

function deps(): PiHookDeps {
  return {
    poolGet: vi.fn(() => undefined),
    createFileOps: vi.fn(() => SSH_FILE_OPS),
    createMcprFileOps: vi.fn(() => MCPR_FILE_OPS),
    createMcprTransport: vi.fn(() => ({ close: async () => undefined })),
    resolveMcprBinaryPath: vi.fn(async () => '$HOME/.xdt-server/v1/pi/pi'),
    mcprBridgeUnavailable: vi.fn(() => {
      throw new Error('[MCPR_PI_MCP_BRIDGE_UNAVAILABLE] test stub');
    }),
    mcprProxyEnv: vi.fn(() => null),
    sshProxyEnv: vi.fn(async () => null),
  };
}

/** 每个钩子的最小实参表（分类在第一句，后面的实参不参与分类判断）。 */
const HOOK_ARGS: Record<PiRemoteHook, unknown[]> = {
  getRemotePiTransport: ['', {
    args: ['--mode', 'rpc'],
    cwd: '/inst/wd',
    env: { CINDY_PI_API_KEY: 'k' },
    sessionId: 's1',
    remoteBinaryPath: '$HOME/.xdt-server/v1/pi/pi',
  }],
  getRemotePiFileOps: [''],
  getRemoteAgentFileOps: [''],
  resolveRemotePiBinaryPath: [''],
  rewriteRemotePiMcpBridgeUrl: ['', 'http://127.0.0.1:41000/mcp/ghost'],
  getRemotePiAgentProxyEnv: [''],
  readSkillSource: [{ path: '/inst/skills/x/SKILL.md', remoteHostId: '' }],
  fingerprintSkillSource: [{ path: '/inst/skills/x/SKILL.md', remoteHostId: '' }],
};

/** 只替换 remoteHostId 的实参构造（两个 Skill 钩子把 id 放在对象里）。 */
function hookArgs(name: PiRemoteHook, remoteHostId: string): unknown[] {
  const args = [...HOOK_ARGS[name]];
  if (name === 'readSkillSource' || name === 'fingerprintSkillSource') {
    args[0] = { path: '/inst/skills/x/SKILL.md', remoteHostId };
    return args;
  }
  args[0] = remoteHostId;
  return args;
}

function callHook(
  name: PiRemoteHook,
  remoteHostId: string,
  d: PiHookDeps,
): Promise<unknown> | unknown {
  return buildPiHook(name, d)(...hookArgs(name, remoteHostId));
}

describe('Pi 远端钩子：`mcpr:<id>` 必须走隧道实现，且不得进入 SSH pool', () => {
  it.each(PI_REMOTE_HOOKS)('%s 在 mcpr: 上零次触碰 SSH pool', async (name) => {
    const d = deps();
    await Promise.resolve()
      .then(() => callHook(name, 'mcpr:instance-1', d))
      .catch(() => undefined);
    expect(d.poolGet).not.toHaveBeenCalled();
    expect(d.createFileOps).not.toHaveBeenCalled();
  });

  it('getRemotePiTransport 走 mode=pi 隧道（不查 pool、不做 SSH 安装前置）', async () => {
    const d = deps();
    await callHook('getRemotePiTransport', 'mcpr:instance-1', d);
    expect(d.createMcprTransport).toHaveBeenCalledTimes(1);
    expect(d.createMcprTransport.mock.calls[0][0]).toMatchObject({
      remoteHostId: 'mcpr:instance-1',
      remoteBinaryPath: '$HOME/.xdt-server/v1/pi/pi',
      cwd: '/inst/wd',
      sessionId: 's1',
    });
    expect(d.poolGet).not.toHaveBeenCalled();
  });

  it.each(['getRemotePiFileOps', 'getRemoteAgentFileOps'] as const)(
    '%s 走 mode=exec 隧道 file ops（与 SSH 同一份实现）',
    (name) => {
      const d = deps();
      expect(callHook(name, 'mcpr:instance-1', d)).toBe(MCPR_FILE_OPS);
      expect(d.createMcprFileOps).toHaveBeenCalledWith('mcpr:instance-1');
      expect(d.poolGet).not.toHaveBeenCalled();
    },
  );

  it('resolveRemotePiBinaryPath 走隧道侧解析（不 exec probe SSH）', async () => {
    const d = deps();
    await expect(callHook('resolveRemotePiBinaryPath', 'mcpr:instance-1', d)).resolves.toBe(
      '$HOME/.xdt-server/v1/pi/pi',
    );
    expect(d.resolveMcprBinaryPath).toHaveBeenCalledWith('mcpr:instance-1');
    expect(d.poolGet).not.toHaveBeenCalled();
  });

  it('rewriteRemotePiMcpBridgeUrl 在 mcpr: 上显式失败（绝不把 loopback URL 交给实例）', async () => {
    const d = deps();
    // 该钩子是 async：抛错表现为 rejected promise，必须用 rejects 断言（否则既漏断言
    // 又留下 unhandled rejection）。
    await expect(
      Promise.resolve().then(() => callHook('rewriteRemotePiMcpBridgeUrl', 'mcpr:instance-1', d)),
    ).rejects.toThrow(/\[MCPR_PI_MCP_BRIDGE_UNAVAILABLE\]/);
    expect(d.mcprBridgeUnavailable).toHaveBeenCalledWith('mcpr:instance-1');
    expect(d.poolGet).not.toHaveBeenCalled();
  });

  it('getRemotePiAgentProxyEnv 在 mcpr: 上返回 null（没有反向转发，不注入代理 env）', async () => {
    const d = deps();
    await expect(callHook('getRemotePiAgentProxyEnv', 'mcpr:instance-1', d)).resolves.toBeNull();
    expect(d.mcprProxyEnv).toHaveBeenCalled();
    expect(d.sshProxyEnv).not.toHaveBeenCalled();
    expect(d.poolGet).not.toHaveBeenCalled();
  });

  it.each(['readSkillSource', 'fingerprintSkillSource'] as const)(
    '%s 的 mcpr: 分支走隧道 file ops（不报 remote SSH host）',
    async (name) => {
      const d = deps();
      await expect(
        Promise.resolve().then(() => callHook(name, 'mcpr:instance-1', d)),
      ).resolves.toBe(name === 'readSkillSource' ? 'mcpr' : 'mcpr-hash');
      expect(d.createMcprFileOps).toHaveBeenCalledWith('mcpr:instance-1');
      expect(d.poolGet).not.toHaveBeenCalled();
    },
  );

  it('畸形的 `mcpr:` 同样留在隧道一侧（不降级成 SSH host）', () => {
    const d = deps();
    expect(classifyRemoteSessionTransport('mcpr:')).toBe('mcpr');
    expect(callHook('getRemotePiFileOps', 'mcpr:', d)).toBe(MCPR_FILE_OPS);
    expect(d.poolGet).not.toHaveBeenCalled();
  });
});

describe('Pi 远端钩子：SSH 分支的既有行为不变', () => {
  it('getRemotePiFileOps 仍然先查 pool 再建远端 file ops', () => {
    const d = deps();
    const remoteHost = { id: 'ssh-host-1' };
    d.poolGet.mockReturnValue(remoteHost);

    expect(callHook('getRemotePiFileOps', 'ssh-host-1', d)).toBe(SSH_FILE_OPS);
    expect(d.poolGet).toHaveBeenCalledWith('ssh-host-1');
    expect(d.createFileOps).toHaveBeenCalledWith(remoteHost);
    expect(d.createMcprFileOps).not.toHaveBeenCalled();
  });

  it('getRemoteAgentFileOps（Pi 侧）与 getRemotePiFileOps 同形', () => {
    const d = deps();
    const remoteHost = { id: 'ssh-host-1' };
    d.poolGet.mockReturnValue(remoteHost);

    expect(callHook('getRemoteAgentFileOps', 'ssh-host-1', d)).toBe(SSH_FILE_OPS);
    expect(d.poolGet).toHaveBeenCalledWith('ssh-host-1');
  });

  it('resolveRemotePiBinaryPath 的 SSH 分支仍然 probe SSH host', async () => {
    const d = deps();
    d.poolGet.mockReturnValue({ id: 'ssh-host-1' });

    await expect(callHook('resolveRemotePiBinaryPath', 'ssh-host-1', d)).resolves.toBe('/remote/pi');
    expect(d.poolGet).toHaveBeenCalledWith('ssh-host-1');
    expect(d.resolveMcprBinaryPath).not.toHaveBeenCalled();
  });

  it('getRemotePiAgentProxyEnv 的 SSH 分支仍然走 SSH host', async () => {
    const d = deps();
    d.poolGet.mockReturnValue({ id: 'ssh-host-1' });

    await expect(callHook('getRemotePiAgentProxyEnv', 'ssh-host-1', d)).resolves.toBeNull();
    expect(d.poolGet).toHaveBeenCalledWith('ssh-host-1');
    expect(d.sshProxyEnv).toHaveBeenCalled();
  });

  it('getRemotePiTransport 的 SSH 分支仍然查 pool', async () => {
    const d = deps();
    d.poolGet.mockReturnValue({ id: 'ssh-host-1', getStatus: () => 'ready' });

    // SSH 分支后面要组装 daemon transport，本用例只断言「分类器放行、走到了 pool」；
    // 之后的失败（缺 host 方法等）与本轮改动无关，不吞也不断言其类型。
    await Promise.resolve()
      .then(() => callHook('getRemotePiTransport', 'ssh-host-1', d))
      .catch(() => undefined);
    expect(d.poolGet).toHaveBeenCalledWith('ssh-host-1');
    expect(d.createMcprTransport).not.toHaveBeenCalled();
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
      if (!body.includes('classifyRemoteSessionTransport(')) {
        offences.push(`${declaration.name} (offset ${cursor})`);
      }
      cursor = source.indexOf(needle, cursor + needle.length);
    }
    expect(scanned, '应至少扫到一个查询（口径活性）').toBeGreaterThan(0);
    expect(offences, `未先分类就查 SSH pool 的钩子：\n${offences.join('\n')}`).toEqual([]);
  });

  it('remotePiSkipMcpBridge 只对 mcpr 跳过 in-process bridge（SSH/本机不跳）', () => {
    const declaration = '\n      remotePiSkipMcpBridge: ';
    expect(source.split(declaration).length - 1, 'remotePiSkipMcpBridge 应唯一').toBe(1);
    const start = source.indexOf(declaration);
    // 条件是跨行的，取一个有界窗口（只看一行会漏）。
    const body = source.slice(start, start + 400);
    expect(body).toContain("classifyRemoteSessionTransport(remoteHostId) === 'mcpr'");
    expect(body).toContain('shouldSkipMcprPiMcpBridge()');
  });
});
