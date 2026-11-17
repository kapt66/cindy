/**
 * Meka「codex 原生子代理硬关」回归（Host 侧最后一跳）。
 *
 * 契约（三跳，见 `docs/dev-rules/maker-core-and-agent-behavior.md` 与
 * `docs/migrations/2026-09-25-origin-main-to-meka-main.md`）：
 *   1. Meka 战斗 runtime 在 `vendorOptions` 里下发 `codexNativeSubagentsDisabled: true`；
 *   2. `prepareCodexExtraSpawnConfig` 读到 `ctx.codexNativeSubagentsDisabled === true` 时
 *      往 argv 追加相邻的 `['-c', 'agents.enabled=false']`，且**只追加一次**；
 *   3. 同一函数用 `disableNativeSubagents` 关掉智能调配门 ⇒ 智能调配的 catalog argv
 *      不出现、`prepareCodexSmartSubagentConfig` 不被调用。
 *
 * 第八轮同步（2026-11-17）前的实现方式：按 AST 从 `maker-host/index.ts` 里逐字提取
 * `prepareCodexExtraSpawnConfig` 属性体 + `new Function` 注入自由标识符。上游本轮把该属性
 * 收敛成 `createCodexSpawnConfig(ports)` 工厂（`maker-host/index.ts` 里只剩
 * `prepareCodexExtraSpawnConfig: createCodexSpawnConfig({...})` 一次调用），提取锚点因此
 * 失效。现在改为**直接驱动真实工厂**（与同目录 `codexSpawnConfigCore.test.ts` 同一手法）：
 * 断言仍钉在可观察结果上（argv 里是否出现相邻参数对、智能调配是否被准备），并且比源码
 * 扫描更强——它执行的是生产入口本身。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

import { createCodexSpawnConfig } from '../codexSpawnConfigCore.js';
import {
  buildCodexSubagentSpawnArgs,
  codexHostUsesSmartSubagentRouting,
} from '../codex-subagent-config.js';

/** argv 契约：关掉 codex 原生子代理时要出现的相邻参数对。 */
const DISABLED_SUBAGENTS_ARGV = ['-c', 'agents.enabled=false'];
/** 反向证据：智能调配开的 argv 里一定有这一项（值是 catalog 路径）。 */
const SMART_ROUTING_ARGV_PREFIX = 'model_catalog_json=';

const prepareSmart = vi.hoisted(() => vi.fn());
// 只要 provider 列表非空即可驱动智能调配分支；`ProviderView` 其余字段与本契约无关。
const listProviders = vi.hoisted(() =>
  vi.fn(async () => [{ id: 'xd' }] as unknown as ProviderView[]),
);

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// 智能调配默认**可用**：这样「有没有被准备」与「argv 里有没有 catalog 路径」都能形成正反证据。
vi.mock('../subagent-model-settings-store.js', () => ({
  readSubagentModelSettings: () => ({ codexSmartSubagentRouting: true }),
  resolveModelCompactionPct: vi.fn(),
}));
vi.mock('../codex-smart-subagent-routing.js', () => ({
  prepareCodexSmartSubagentConfig: prepareSmart,
  codexSmartSubagentRoutingSignature: () => 'smart:fixture',
  selectCodexSmartSubagentCandidates: () => [],
}));
vi.mock('../codex-browser-companion.js', () => ({
  prepareCodexBrowserCompanion: vi.fn(async () => null),
  resolveCodexBrowserCompanionSpawnConfig: (value: { extraArgs: string[] } | null) => ({
    extraArgs: value?.extraArgs ?? [], codexBrowserUseAvailable: value !== null,
  }),
}));
vi.mock('../codex-custom-context-catalog.js', () => ({
  prepareCodexGuestModelCatalog: async () => ({ extraArgs: [] }),
  prepareCodexCustomContextCatalog: vi.fn(async () => ({ catalogPath: '/fake/custom.json', extraArgs: [] })),
}));
vi.mock('../model-context-limit-store.js', () => ({
  readModelContextLimit: vi.fn(), resolveModelCompactionPct: vi.fn(),
}));
vi.mock('../catalog-to-descriptors.js', () => ({ resolveModelDefaultContextWindow: vi.fn() }));

function fixture() {
  const prepare = createCodexSpawnConfig({
    binaryPath: 'unused-test-binary', getCodexHome: () => 'unused-test-home',
    getCodexExtraSpawnConfig: vi.fn(async () => ({
      extraArgs: [], extraEnv: {},
      bridge: null, bridgeServerNames: [],
      buildSessionMcpConfig: undefined,
    })),
    broadcastCodexRuntimeRoute: vi.fn(async () => {}),
    readClaudeApiKey: () => null, isReplacedCindyGatewayKey: () => false,
    hasCodexOAuthLogin: async () => true, listProviders,
    getDesktopSelectableCatalog: () => ({ version: 'fixture', providers: [] }),
    resolveDesktopModelContextProviderId: vi.fn(), prepareRemote: vi.fn(),
    readSubagentOAuth: async () => ({
      accessToken: 'fixture-only', accountId: 'fixture', canDispatch: () => true,
    }),
    proxy: {
      setCodexProxyAuthInjection: vi.fn(), setCodexProxyGatewayKeyReader: vi.fn(),
      setCodexSubagentOAuthReader: vi.fn(), setCodexAppliedCustomProviderRoutes: vi.fn(),
      ensureCodexCustomContextProxyReady: vi.fn(async () => {}),
      isCodexCustomContextProxyHandleReady: () => true,
      releaseCodexCustomContextProxy: vi.fn(async () => {}),
      ensureCodexControlPlaneProxyReady: vi.fn(async () => {}),
      ensureCodexProxyReady: vi.fn(async () => {}),
      isCodexControlPlaneProxyHandleReady: () => true, isCodexProxyHandleReady: () => true,
      getCodexCustomContextProxyEndpoint: () => 'http://127.0.0.1:9',
      getCodexControlPlaneProxyEndpoint: () => 'http://127.0.0.1:9',
      getCodexProxyEndpoint: () => 'http://127.0.0.1:9',
    },
  });
  return { prepare };
}

/** 相邻子序列判定：`-c` 与 `agents.enabled=false` 必须紧挨着出现。 */
function countAdjacentArgv(argv: readonly string[], pair: readonly string[]): number {
  let count = 0;
  for (let start = 0; start + pair.length <= argv.length; start += 1) {
    if (pair.every((value, offset) => argv[start + offset] === value)) count += 1;
  }
  return count;
}

function hasSmartRoutingArgv(argv: readonly string[]): boolean {
  return argv.some((arg) => arg.startsWith(SMART_ROUTING_ARGV_PREFIX));
}

const ownerCtx = { credentialMode: 'gateway-key' as const };

describe('Meka：codex 原生子代理硬关（Host 最后一跳）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareSmart.mockReturnValue({
      catalogPath: '/fake/codex/smart-models.json',
      modelCatalog: { models: [{ slug: 'gpt-5.6-sol' }] },
      routingSignature: 'smart:fixture',
      routes: [{ providerId: 'xd', catalogModel: 'deepseek/deepseek-v4-flash' }],
    });
  });

  it('ctx.codexNativeSubagentsDisabled === true：argv 追加且只追加一次 `-c agents.enabled=false`', async () => {
    const f = fixture();
    const config = await f.prepare([], { ...ownerCtx, codexNativeSubagentsDisabled: true });
    expect(countAdjacentArgv(config.extraArgs, DISABLED_SUBAGENTS_ARGV)).toBe(1);
  });

  it('ctx.codexNativeSubagentsDisabled === true：智能调配门被关（不准备 catalog、argv 无 catalog 路径）', async () => {
    const f = fixture();
    const config = await f.prepare([], { ...ownerCtx, codexNativeSubagentsDisabled: true });
    expect(prepareSmart).not.toHaveBeenCalled();
    expect(hasSmartRoutingArgv(config.extraArgs)).toBe(false);
  });

  it.each([false, undefined])(
    'ctx.codexNativeSubagentsDisabled = %s（显式关闭 / 未下发）：argv 不含该 flag，智能调配照常准备',
    async (flag) => {
      const f = fixture();
      const config = await f.prepare([], { ...ownerCtx, codexNativeSubagentsDisabled: flag });
      expect(countAdjacentArgv(config.extraArgs, DISABLED_SUBAGENTS_ARGV)).toBe(0);
      // 反向证据：智能调配确实可用且被准备（否则上一条「没准备」可能是假绿）。
      expect(prepareSmart).toHaveBeenCalledTimes(1);
      expect(hasSmartRoutingArgv(config.extraArgs)).toBe(true);
    },
  );

  it('harness 自检：同一断言在硬关/放行两侧必须翻转（证明断言不是空转）', async () => {
    const f = fixture();
    const disabled = await f.prepare([], { ...ownerCtx, codexNativeSubagentsDisabled: true });
    const enabled = await f.prepare([], { ...ownerCtx });
    expect(countAdjacentArgv(disabled.extraArgs, DISABLED_SUBAGENTS_ARGV)).toBe(1);
    expect(countAdjacentArgv(enabled.extraArgs, DISABLED_SUBAGENTS_ARGV)).toBe(0);
    // 真实纯函数仍在链上：放行侧必须被判定为「宿主允许智能调配」。
    // （该谓词的 ctx 只关心 hostPurpose / deviceHostedGuest*，与 credentialMode 无关。）
    expect(
      codexHostUsesSmartSubagentRouting(
        { codexSmartSubagentRouting: true } as Parameters<typeof codexHostUsesSmartSubagentRouting>[0],
        {},
      ),
    ).toBe(true);
    expect(typeof buildCodexSubagentSpawnArgs).toBe('function');
  });
});
