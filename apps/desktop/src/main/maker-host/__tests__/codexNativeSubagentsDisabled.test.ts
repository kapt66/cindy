/**
 * Meka「codex 原生子代理硬关」在 **Host 侧的最后一跳**回归。
 *
 * 契约（三跳，见 `docs/dev-rules/maker-core-and-agent-behavior.md` 与
 * `docs/migrations/2026-09-25-origin-main-to-meka-main.md`）：
 *   1. Meka 战斗 runtime 在 `vendorOptions` 里下发 `codexNativeSubagentsDisabled: true`；
 *   2. `maker-host/index.ts` 的 `prepareCodexExtraSpawnConfig` 读 `ctx.codexNativeSubagentsDisabled`
 *      并往 argv 追加 `-c agents.enabled=false`；
 *   3. 同一函数用它关掉智能调配门（`&& !disableNativeSubagents`）。
 *
 * 为什么这个文件用「逐字提取 + 注入依赖」而不是 import：
 * `maker-host/index.ts` 是单个巨型组装函数（`getMaker()`，~3.5k 行），
 * `prepareCodexExtraSpawnConfig` 只是 `new CodexAgent({...})` 里的一个属性体，没有任何
 * 可注入的接缝；import 会拉起整个 Electron main 依赖树，而 `getMaker()` 还要求
 * claude/codex 二进制与 ripgrep 都已 prepare（bootstrap 才能满足）。全仓 `__tests__`
 * 下没有任何文件 import `index.ts`，本目录既有先例 `mcprRemoteFileOps.test.ts` 用同一
 * 手法执行真实钩子体（`remoteCcQueryFactory.test.ts` 只用字符序，证明不了行为）。
 *
 * 因此这里用 TypeScript 编译器**按 AST 定位**该属性并取原文（不是正则/括号配对，
 * 换行、注释、模板串都不会影响），transpile 后在 `new Function` 里把自由标识符做成
 * 形参注入（形参名 = 依赖名，缺一个就 ReferenceError，不会静默走 global）。
 * 断言钉在**可观察结果**上：返回的 `extraArgs` 里是否出现相邻的
 * `['-c', 'agents.enabled=false']`，以及智能调配是否被准备。
 *
 * 生产代码一行未改：本文件只读源码。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { SUBAGENT_MODEL_SETTINGS_DEFAULTS } from '../../../shared/subagentModelSettings';
import {
  buildCodexSubagentSpawnArgs,
  resolveCodexSubagentRoutingProfile,
  type CodexSmartSubagentConfig,
} from '../codex-subagent-config.js';

/** argv 契约：关掉 codex 原生子代理时要出现的相邻参数对。 */
const DISABLED_SUBAGENTS_ARGV = ['-c', 'agents.enabled=false'];
/** 反向证据：智能调配开的 argv 里一定有这一项（值是 catalog 路径）。 */
const SMART_ROUTING_ARGV_PREFIX = 'model_catalog_json=';

const SMART_SUBAGENT_CONFIG: CodexSmartSubagentConfig = {
  catalogPath: '/fake/codex/smart-models.json',
  modelCatalog: { models: [{ slug: 'gpt-5.6-sol' }] },
  routingSignature: 'smart:fixture',
  routes: [
    { providerId: 'openai', catalogModel: 'gpt-5.6-luna' },
    { providerId: 'xd', catalogModel: 'deepseek/deepseek-v4-flash' },
  ],
};

const sourceText = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8').replace(/\r\n?/g, '\n');
const sourceFile = ts.createSourceFile(
  'maker-host/index.ts',
  sourceText,
  ts.ScriptTarget.ES2022,
  true,
  ts.ScriptKind.TS,
);

/**
 * 按 AST 定位 `prepareCodexExtraSpawnConfig` 属性并返回其原文
 * （`name: async (providers, ctx) => { ... }`，不含尾逗号）。
 */
function findCodexSpawnConfigHookText(): string {
  const found: ts.PropertyAssignment[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(sourceFile) === 'prepareCodexExtraSpawnConfig'
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  expect(
    found,
    'maker-host/index.ts 里 `prepareCodexExtraSpawnConfig` 属性应唯一（提取锚点失效说明实现被搬走/改名）',
  ).toHaveLength(1);
  return found[0]!.getText(sourceFile);
}

interface CodexSpawnConfig {
  extraArgs: string[];
  extraEnv: Record<string, string>;
  codexProxyActive: boolean;
  codexSubagentRoutingProfile?: 'default' | 'smart';
  smartSubagentRoutes?: unknown;
}

type CodexSpawnConfigHook = (
  providers: unknown,
  ctx: Record<string, unknown>,
) => Promise<CodexSpawnConfig>;

/**
 * 把真实钩子体编译成可执行函数：自由标识符全部变成 `new Function` 的形参，
 * 由 `scope` 注入（缺名即 ReferenceError；`Error`/`Number`/`String` 等真全局不在
 * scope 里，因此照常解析到全局）。
 */
function compileHook(
  scope: Record<string, unknown>,
  hookText: string = findCodexSpawnConfigHookText(),
): CodexSpawnConfigHook {
  const javascript = ts
    .transpileModule(`({ ${hookText} }).prepareCodexExtraSpawnConfig`, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.trim();
  const dependencyNames = Object.keys(scope);
  const factory = new Function(
    ...dependencyNames,
    `return ${javascript};`,
  ) as (...args: unknown[]) => CodexSpawnConfigHook;
  return factory(...dependencyNames.map((name) => scope[name]));
}

/** 相邻子序列判定：`-c` 与 `agents.enabled=false` 必须紧挨着出现。 */
function hasAdjacentArgv(argv: readonly string[], pair: readonly string[]): boolean {
  for (let start = 0; start + pair.length <= argv.length; start += 1) {
    if (pair.every((value, offset) => argv[start + offset] === value)) return true;
  }
  return false;
}

function hasSmartRoutingArgv(argv: readonly string[]): boolean {
  return argv.some((arg) => arg.startsWith(SMART_ROUTING_ARGV_PREFIX));
}

interface HookSpies {
  prepareSmart: ReturnType<typeof vi.fn>;
  listProviders: ReturnType<typeof vi.fn>;
}

/**
 * 注入依赖。默认值刻意让「智能调配可用」：设置里 `codexSmartSubagentRouting: true`、
 * `prepareCodexSmartSubagentConfig` 返回一份带 routes 的配置、proxy 判定 ready，
 * 这样「argv 里有没有智能调配」和「智能调配有没有被准备」都能形成正反证据。
 */
function scope(spies: HookSpies): Record<string, unknown> {
  const noop = (): void => {};
  const logger = { error: noop, warn: noop, info: noop, debug: noop, trace: noop, fatal: noop };
  return {
    _maker: { makerMemory: { isEnabled: () => false } },
    broadcastCodexRuntimeRoute: async () => {},
    buildCodexCustomProviderArgs: () => ({ extraArgs: [], extraEnv: {} }),
    buildCodexProxySpawnArgs: () => [],
    // 真实纯函数：反向证据要看到上游原本会追加的智能调配 argv。
    buildCodexSubagentSpawnArgs,
    buildRemoteCodexSessionMcpConfig: () => ({}),
    CODEX_CINDY_COMPACT_PROVIDER_ID: 'cindy-compact-fixture',
    CODEX_OPENAI_COMPACT_PROVIDER_ID: 'openai-compact-fixture',
    CODEX_SUMMARY_COMPACT_PROVIDER_ID: 'summary-compact-fixture',
    // 模块级 `let codexAppliedContactsEnabled`，钩子内会赋值。
    codexAppliedContactsEnabled: null,
    codexPath: '/fake/codex/bin/codex',
    deriveCodexCustomProviderRoutes: () => [],
    desktopCodexAuthAdapter: { hasCodexOAuthLogin: async () => false },
    desktopMakerLogger: { ...logger, child: () => logger },
    ensureCodexControlPlaneProxyReady: async () => {},
    ensureCodexCustomContextProxyReady: async () => {},
    ensureCodexProxyReady: async () => {},
    getActiveCatalog: () => ({ providers: [] }),
    getActiveCatalogRevision: () => 'revision-fixture',
    getActiveCodexBridgeInstanceId: () => 'bridge-fixture',
    getActiveCodexBridgeServerNames: () => [],
    getChatgptBridgeAuthForDispatch: () => null,
    getCodexControlPlaneProxyEndpoint: () => 'http://127.0.0.1:1',
    getCodexCustomContextProxyEndpoint: () => 'http://127.0.0.1:1',
    getCodexExtraSpawnConfig: async () => ({
      extraArgs: [] as string[],
      extraEnv: {} as Record<string, string>,
      buildSessionMcpConfig: undefined,
      bridgeServerNames: [] as string[],
    }),
    getCodexHome: () => '/fake/codex-home',
    getCodexProxyEndpoint: () => 'http://127.0.0.1:1',
    getDesktopProviderService: () => ({ listProviders: spies.listProviders }),
    isCodexControlPlaneProxyHandleReady: () => true,
    isCodexCustomContextProxyHandleReady: () => true,
    isCodexProxyHandleReady: () => true,
    pluginRegistry: { isEnabled: () => false },
    prepareCodexBrowserCompanion: async () => null,
    prepareCodexCustomContextCatalog: async () => ({
      catalogPath: '/fake/codex/custom-context.json',
      extraArgs: [] as string[],
    }),
    prepareCodexSmartSubagentConfig: spies.prepareSmart,
    readClaudeApiKey: () => 'gateway-api-key-fixture',
    readSubagentModelSettings: () => ({
      ...SUBAGENT_MODEL_SETTINGS_DEFAULTS,
      codexSmartSubagentRouting: true,
    }),
    registerCodexScopedCustomProviderRoutes: () => () => {},
    releaseCodexCustomContextProxy: async () => {},
    resolveCodexBrowserCompanionSpawnConfig: () => ({
      extraArgs: [] as string[],
      codexBrowserUseAvailable: false,
    }),
    // 真实纯函数：智能调配档位判定不自己复刻。
    resolveCodexSubagentRoutingProfile,
    setCodexAppliedCustomProviderRoutes: noop,
    setCodexProxyAuthInjection: noop,
    setCodexProxyGatewayKeyReader: noop,
    setCodexSubagentOAuthReader: noop,
    toCodexCustomProviderHostRoutes: (routes: unknown) => routes,
  };
}

function makeHarness(): { hook: CodexSpawnConfigHook; spies: HookSpies } {
  const spies: HookSpies = {
    prepareSmart: vi.fn(() => SMART_SUBAGENT_CONFIG),
    listProviders: vi.fn(async () => [] as unknown[]),
  };
  return { hook: compileHook(scope(spies)), spies };
}

describe('prepareCodexExtraSpawnConfig：Meka codex 原生子代理硬关', () => {
  it('提取锚点仍然成立：硬关判定与 argv 仍在本钩子体内，且 `agents.enabled=false` 只出现一次', () => {
    const hookText = findCodexSpawnConfigHookText();
    expect(hookText).toContain('ctx.codexNativeSubagentsDisabled === true');
    expect(hookText).toContain('disableNativeSubagents');
    // 唯一性：全函数只有这一处能产出该 flag，避免「另一条路径悄悄也带上了」。
    expect(hookText.split('agents.enabled=false')).toHaveLength(2);
  });

  it('ctx.codexNativeSubagentsDisabled === true：argv 带 `-c agents.enabled=false`，且智能调配未被准备', async () => {
    const { hook, spies } = makeHarness();

    const config = await hook([], { codexNativeSubagentsDisabled: true });

    // 第二跳：argv 里出现（且相邻）。
    expect(hasAdjacentArgv(config.extraArgs, DISABLED_SUBAGENTS_ARGV)).toBe(true);
    expect(hasAdjacentArgv(config.extraArgs, ['agents.enabled=false', '-c'])).toBe(false);

    // 第三跳：智能调配门被关掉 —— 既不准备配置，也不去问 provider 服务。
    expect(spies.prepareSmart).not.toHaveBeenCalled();
    expect(spies.listProviders).not.toHaveBeenCalled();
    expect(config.codexSubagentRoutingProfile).toBe('default');
    expect(config.smartSubagentRoutes).toBeUndefined();
    // 硬关必须**取代**智能调配 argv，不能 coexist（否则 -c 后写的会赢）。
    expect(hasSmartRoutingArgv(config.extraArgs)).toBe(false);
  });

  it.each([['false（显式关闭）', false], ['undefined（未下发）', undefined]])(
    'ctx.codexNativeSubagentsDisabled = %s：argv 不含该 flag，智能调配照常准备',
    async (_label, disabled) => {
      const { hook, spies } = makeHarness();

      const config = await hook([], disabled === undefined ? {} : { codexNativeSubagentsDisabled: disabled });

      expect(hasAdjacentArgv(config.extraArgs, DISABLED_SUBAGENTS_ARGV)).toBe(false);
      // 反例必须走通「真实」的智能调配路线，否则上面的「不含」可能只是因为钩子整体罢工。
      expect(spies.prepareSmart).toHaveBeenCalledTimes(1);
      expect(spies.listProviders).toHaveBeenCalledTimes(1);
      expect(config.codexSubagentRoutingProfile).toBe('smart');
      expect(config.smartSubagentRoutes).toEqual(SMART_SUBAGENT_CONFIG.routes);
      expect(config.extraArgs).toEqual(
        buildCodexSubagentSpawnArgs(
          { ...SUBAGENT_MODEL_SETTINGS_DEFAULTS, codexSmartSubagentRouting: true },
          SMART_SUBAGENT_CONFIG,
        ),
      );
      expect(hasSmartRoutingArgv(config.extraArgs)).toBe(true);
    },
  );

  it('未下发 flag 时智能调配 argv 透传真实 catalog 路径（上一条的等价正证，防提取串味）', async () => {
    const { hook } = makeHarness();

    const config = await hook([], {});

    expect(config.extraArgs).toContain(
      `${SMART_ROUTING_ARGV_PREFIX}"${SMART_SUBAGENT_CONFIG.catalogPath}"`,
    );
  });

  it('harness 自检：抹掉本钩子体里的 flag 后同一断言必须翻转（证明断言不是空转）', async () => {
    const originalText = findCodexSpawnConfigHookText();
    const mutatedText = originalText.replace("['-c', 'agents.enabled=false']", '[]');
    // 替换必须命中：否则说明生产代码换了写法，本文件的自检与断言都要一起复核。
    expect(mutatedText).not.toBe(originalText);

    const spies: HookSpies = {
      prepareSmart: vi.fn(() => SMART_SUBAGENT_CONFIG),
      listProviders: vi.fn(async () => [] as unknown[]),
    };
    const mutatedHook = compileHook(scope(spies), mutatedText);

    const config = await mutatedHook([], { codexNativeSubagentsDisabled: true });
    expect(hasAdjacentArgv(config.extraArgs, DISABLED_SUBAGENTS_ARGV)).toBe(false);
    // 对照组：同一份 scope、同一份 ctx 下未变异的钩子必须为 true。
    const liveConfig = await makeHarness().hook([], { codexNativeSubagentsDisabled: true });
    expect(hasAdjacentArgv(liveConfig.extraArgs, DISABLED_SUBAGENTS_ARGV)).toBe(true);
  });
});
