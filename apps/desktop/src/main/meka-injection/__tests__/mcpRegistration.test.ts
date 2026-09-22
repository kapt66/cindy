import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { AgentKind, McpProvider, McpProviderContext } from '@cindy/maker-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routerService = vi.hoisted(() => ({
  listInstances: vi.fn(),
  listProjectBindings: vi.fn(),
  listProjectTools: vi.fn(),
  callProjectCapability: vi.fn(),
  callProjectTool: vi.fn(),
  listTemplates: vi.fn(),
  createInstance: vi.fn(),
  setProjectBindings: vi.fn(),
  getConnectionStatus: vi.fn(),
  reconnectStored: vi.fn(),
  getMekaDesignEndpoint: vi.fn(),
}));

const p4Service = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../meka-settings/ipc.js', () => ({
  getMekaRouterService: () => routerService,
  getMekaP4SettingsService: () => p4Service,
}));

import {
  declareMekaRuntimeMcpAgents,
  prepareMekaRuntimeMcp,
  resetMekaRuntimeMcpRegistryForTests,
} from '../../mcp-integrations/meka-runtime-mcp.js';
import { registerMekaCapabilities } from '../mekaMcpRegistration.js';

/**
 * 形态 B（进程级 Meka 能力注册）的契约测试。
 *
 * 钉住四件事：
 * 1. 三个 agent 的 provider 数组**都拿到** `mcp_router` + `meka_design`，且在原有 provider
 *    之后追加（claude-code / codex 的集合与顺序与收编前一致：I1/I2 的行为不变要求）；
 * 2. pi 的数组与它们拿到的是**同一批 provider 实例**（矩阵 `runtimeMcp: true` 的可执行
 *    形式）；inline Meka provider 同样扇出到 pi 数组 ——
 *    「矩阵说拿到」必须真的落到数组上，否则就是又一次静默缺失；
 * 3. pi 的 provider 是否**真的到达 harness**：矩阵/数组只是第一步，进程级 bridge 的
 *    工厂阶段必须收下这些 provider（由 `mcp-integrations/__tests__/meka-runtime-mcp.test.ts`
 *    的 pi bridge 用例做真 HTTP 往返验证）；
 * 4. 漏传或声明不覆盖全量 AgentKind 都直接抛（漏传不再是静默缺失）。
 *
 * 名字对照：角色配置里的 provider id 是 `mcp-router` / `meka-design`，落成 provider
 * 对象后 `name` 是 `mcp_router` / `meka_design`（见 meka-runtime-mcp.ts）。
 */
const MEKA_PROVIDER_NAMES = ['mcp_router', 'meka_design'] as const;
/** 三个 agent 的核心 provider：Meka 的两个 provider 必须追加在它们之后。 */
const BASE_PROVIDER_NAMES = ['lizi', 'orca-worker-bridge', 'cindy-make'] as const;
const ALL_AGENT_KINDS = ['claude-code', 'codex', 'pi'] as const;

function provider(name: string): McpProvider {
  return { name };
}

function names(providers: readonly McpProvider[]): string[] {
  return providers.map((candidate) => candidate.name);
}

interface RuntimeArraysFixture {
  arrays: Record<AgentKind, McpProvider[]>;
  registry: { get(agentKind: AgentKind): McpProvider[] | undefined };
}

/** 复刻 maker-host 的 `_mcpProviders`：三个数组各自独立、但 provider 实例同一批。 */
function makeRuntimeArrays(): RuntimeArraysFixture {
  const shared = [provider('lizi'), provider('orca-worker-bridge'), provider('cindy-make')];
  const arrays: Record<AgentKind, McpProvider[]> = {
    'claude-code': [...shared],
    codex: [...shared],
    pi: [...shared],
  };
  return { arrays, registry: { get: (agentKind) => arrays[agentKind] } };
}

beforeEach(() => {
  resetMekaRuntimeMcpRegistryForTests();
  for (const mock of Object.values(routerService)) mock.mockReset();
  p4Service.get.mockReset();
});

describe('registerMekaCapabilities', () => {
  it('三个 agent 都拿到 mcp_router + meka_design，追加在原数组之后', () => {
    const { arrays, registry } = makeRuntimeArrays();

    const outcomes = registerMekaCapabilities(registry);

    for (const agentKind of ALL_AGENT_KINDS) {
      expect(names(arrays[agentKind])).toEqual([...BASE_PROVIDER_NAMES, ...MEKA_PROVIDER_NAMES]);
    }
    expect(
      outcomes
        .filter((outcome) => outcome.action === 'registered')
        .map((outcome) => outcome.agentKind),
    ).toEqual([...ALL_AGENT_KINDS]);
    expect(outcomes.some((outcome) => outcome.action === 'skipped')).toBe(false);
  });

  it('角色配置的 provider id（mcp-router / meka-design）确实落在数组里那两个 provider 对象上', () => {
    const { arrays, registry } = makeRuntimeArrays();
    registerMekaCapabilities(registry);

    for (const agentKind of ALL_AGENT_KINDS) {
      const router = arrays[agentKind].find((candidate) => candidate.name === 'mcp_router');
      const mekaContext = (providerIds: string[]): McpProviderContext => ({
        agentKind,
        workingDir: 'C:\\p4',
        sessionId: 'meka-session',
        vendorOptions: { source: 'meka', mekaProjectId: 'saga2', mekaMcpProviderIds: providerIds },
      });

      // 角色配置用 id `mcp-router` / `project-agent`，SDK 侧 provider name 是 `mcp_router`。
      expect(router?.isEnabled?.(mekaContext(['mcp-router']))).toBe(true);
      expect(router?.isEnabled?.(mekaContext(['project-agent']))).toBe(true);
      expect(router?.isEnabled?.(mekaContext([]))).toBe(false);
      expect(router?.isEnabled?.(mekaContext(['meka-design']))).toBe(false);
    }
  });

  it('pi 的数组与 claude-code / codex 拿到同一批 Meka provider（矩阵 runtimeMcp: true 的可执行形式）', () => {
    const { arrays, registry } = makeRuntimeArrays();

    registerMekaCapabilities(registry);

    expect(names(arrays.pi)).toEqual([...BASE_PROVIDER_NAMES, ...MEKA_PROVIDER_NAMES]);
    // 同一批 provider 实例：三个数组共享对象，不是各建一份。
    expect(arrays.pi.find((candidate) => candidate.name === 'mcp_router')).toBe(
      arrays['claude-code'].find((candidate) => candidate.name === 'mcp_router'),
    );
    expect(arrays.pi.find((candidate) => candidate.name === 'mcp_router')).toBe(
      arrays.codex.find((candidate) => candidate.name === 'mcp_router'),
    );
  });

  it('inline Meka MCP 扇出到全部三个数组（含 pi）', () => {
    const { arrays, registry } = makeRuntimeArrays();
    registerMekaCapabilities(registry);

    prepareMekaRuntimeMcp([
      { id: 'meka-inline-probe', transport: 'stdio', command: 'probe', args: [] },
    ]);

    for (const agentKind of ALL_AGENT_KINDS) {
      expect(names(arrays[agentKind])).toContain('meka-inline-probe');
    }
    // 幂等：第二次 prepare 不重复 push。
    prepareMekaRuntimeMcp([
      { id: 'meka-inline-probe', transport: 'stdio', command: 'probe', args: [] },
    ]);
    for (const agentKind of ALL_AGENT_KINDS) {
      expect(names(arrays[agentKind]).filter((name) => name === 'meka-inline-probe')).toHaveLength(1);
    }
  });

  it('没有 agent 走到 skipped 分支（矩阵当前全为 true；分支本身仍保留并需要有覆盖）', () => {
    const { registry } = makeRuntimeArrays();

    const outcomes = registerMekaCapabilities(registry);

    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((outcome) => outcome.action)).toEqual([
      'registered',
      'registered',
      'registered',
    ]);
  });

  it('矩阵说支持却拿不到数组 = 装配期硬失败（漏传不再静默缺失）', () => {
    const { arrays } = makeRuntimeArrays();

    for (const missing of ['claude-code', 'codex', 'pi'] as const) {
      expect(() =>
        registerMekaCapabilities({
          get: (agentKind) => (agentKind === missing ? undefined : arrays[agentKind]),
        }),
      ).toThrow(new RegExp(`missing for agent "${missing}"`));
    }
  });

  it('重复调用是幂等的（切账号后重装 maker 会再注册一次）', () => {
    const { arrays, registry } = makeRuntimeArrays();

    registerMekaCapabilities(registry);
    registerMekaCapabilities(registry);

    for (const agentKind of ALL_AGENT_KINDS) {
      expect(names(arrays[agentKind])).toEqual([...BASE_PROVIDER_NAMES, ...MEKA_PROVIDER_NAMES]);
    }
  });
});

describe('declareMekaRuntimeMcpAgents 完整性断言', () => {
  it('声明未覆盖全量 AgentKind 时抛错（少声明一个 = 会被静默漏掉的那一个）', () => {
    const { arrays } = makeRuntimeArrays();

    expect(() =>
      declareMekaRuntimeMcpAgents([
        { agentKind: 'claude-code', providers: arrays['claude-code'] },
        { agentKind: 'codex', providers: arrays.codex },
      ]),
    ).toThrow(/incomplete; missing AgentKind\(s\): pi/);
  });

  it('矩阵说支持却不给数组时抛错（三个 agent 现在都必须给数组）', () => {
    const { arrays } = makeRuntimeArrays();

    // 三列都是 runtimeMcp: true，所以「全部给数组」是唯一合法形态。
    expect(() =>
      declareMekaRuntimeMcpAgents([
        { agentKind: 'claude-code', providers: arrays['claude-code'] },
        { agentKind: 'codex', providers: arrays.codex },
        { agentKind: 'pi', providers: arrays.pi },
      ]),
    ).not.toThrow();
    // 任一 agent 漏给数组 = 矩阵说支持却拿不到 → 抛（pi 曾经的真实形态）。
    for (const missing of ['claude-code', 'codex', 'pi'] as const) {
      expect(() =>
        declareMekaRuntimeMcpAgents([
          { agentKind: 'claude-code', ...(missing === 'claude-code' ? {} : { providers: arrays['claude-code'] }) },
          { agentKind: 'codex', ...(missing === 'codex' ? {} : { providers: arrays.codex }) },
          { agentKind: 'pi', ...(missing === 'pi' ? {} : { providers: arrays.pi }) },
        ]),
      ).toThrow(/contradicts/);
    }
  });

  it('同一 AgentKind 重复声明时抛错', () => {
    const { arrays } = makeRuntimeArrays();

    expect(() =>
      declareMekaRuntimeMcpAgents([
        { agentKind: 'claude-code', providers: arrays['claude-code'] },
        { agentKind: 'claude-code', providers: arrays['claude-code'] },
        { agentKind: 'codex', providers: arrays.codex },
        { agentKind: 'pi', providers: arrays.pi },
      ]),
    ).toThrow(/duplicate/);
  });
});

/**
 * maker-host 侧的接线契约：注册必须由**完整 registry**驱动。源码级断言是为了拦住
 * 「又改回手工枚举数组」——那是 Pi 静默缺失的成因，光靠行为测试抓不到回归（漏传
 * claude/codex 之外的数组时行为测试仍然全绿）。
 *
 * 断言的写法刻意避开精确字面量（原版 `toContain('registerMekaCapabilities({ get: (agentKind) => _mcpProviders[agentKind] })')`
 * 只要调用点换行、加一个逗号或改个局部名就误红，而**真正的回归**——枚举数组——它并不比
 * 正则更早发现）：注释先剥掉，再把空白归一化，然后匹配调用形状；`_mcpProviders` 的三个
 * 赋值全部要求出现在注册点之前，而不是只查 `pi` 那一行。
 *
 * 它仍然是**源码级、非行为级**判据（WL-16 已登记）；行为面由上面的
 * `registerMekaCapabilities` 单测覆盖。
 */
describe('maker-host 接线契约（源码级）', () => {
  const hostSource = readFileSync(resolve(process.cwd(), 'src/main/maker-host/index.ts'), 'utf8');
  /** 去掉块注释与整行 `//` 注释：注释里出现 `registerMekaRuntimeMcpArrays(` 不算调用。 */
  const hostCode = hostSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

  it('走 registerMekaCapabilities + 完整 registry，而不是手工枚举数组', () => {
    expect(hostCode).toMatch(
      /registerMekaCapabilities\(\{ ?get: ?\(agentKind\) => ?_mcpProviders\[agentKind\],? ?\}\)/,
    );
    // 低层原语只认数组、不认归属（少传一个发现不了）——生产路径不得出现它的调用。
    expect(hostCode).not.toMatch(/\bregisterMekaRuntimeMcpArrays ?\(/);
  });

  it('注册发生在三个 _mcpProviders[*] 赋值之后', () => {
    // 必须定位**调用**而不是标识符：文件顶部有 `import { registerMekaCapabilities }`，
    // 用裸标识符定位会命中 import 段，让「顺序」断言退化成恒真（本用例加严时实测踩到）。
    const registration = hostSource.indexOf('registerMekaCapabilities({');
    expect(registration).toBeGreaterThan(-1);
    for (const assignment of [
      "_mcpProviders['claude-code'] =",
      '_mcpProviders.codex =',
      '_mcpProviders.pi =',
    ]) {
      const index = hostSource.indexOf(assignment);
      expect(index, `missing assignment: ${assignment}`).toBeGreaterThan(-1);
      expect(registration, `registration must follow: ${assignment}`).toBeGreaterThan(index);
    }
  });
});

