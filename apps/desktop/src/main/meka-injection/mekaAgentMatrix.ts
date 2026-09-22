import type { AgentKind } from '@cindy/maker-core';

/**
 * 单个 agent 能消费的 Meka 注入能力。
 *
 * 这一层存在的理由：以前「谁拿到了什么」是**涌现**的 —— 由 maker-host 里手工
 * 传数组、手工写 vendorOptions 决定。少传一个数组不会报错，只会让那个 agent 在
 * 用户侧静默缺能力（Pi 就是这么丢掉 mcp-router / meka-design 的）。改成显式矩阵后，
 * 「缺失」只能是**声明式**的，而声明会被测试钉住。
 */
export interface MekaAgentCapabilities {
  /**
   * 能否消费 `opts.nativeSkillPluginPath` / `opts.nativeSkillRevision`（技能快照）。
   *
   * 落地形态**按 harness 不同**（快照目录本身与 agent 无关）：
   * - claude-code：整目录当本地 plugin 挂（`plugins: [{ type: 'local', path }]`）；
   * - codex：把 `<path>/skills` 注册为额外原生根（`SkillsExtraRootsSet`）；
   * - pi：把 `<path>/skills/<id>` 逐个作为显式 `--skill` 目录传入
   *   （`packages/maker-core/src/agents/pi/host-skill-mount.ts`）；
   * - **远端会话例外（三者一致）**：路径必须是 harness 真正运行的那台机器上的路径，
   *   本地快照路径不得透传给远端 harness。
   */
  skillSnapshot: boolean;
  /** 进程级 Meka 运行时 MCP（mcp-router / project-agent / meka-design / inline）是否注入该 agent 的 provider 数组。 */
  runtimeMcp: boolean;
}

/**
 * Meka 注入能力矩阵。
 *
 * 穷尽性用本仓既有写法：`Readonly<Record<AgentKind, ...>>`（同
 * `renderer/lib/modelHarnessPresentation.ts` 的 `MODEL_HARNESS_COLOR`、
 * `maker-host/model-route-guard-live.ts` 的 `DEFAULT_ONESHOT_MODEL`）。maker-core
 * 新增一个 `AgentKind` 而这里没填 → **编译期**失败；运行期再由
 * `__tests__/agentMatrix.test.ts` 的键集合断言兜一次（改矩阵必须动测试，不允许
 * 「顺手加个 agent」悄悄滑过去）。
 */
export const MEKA_AGENT_CAPABILITIES: Readonly<Record<AgentKind, MekaAgentCapabilities>> =
  Object.freeze({
    'claude-code': Object.freeze({ skillSnapshot: true, runtimeMcp: true }),
    codex: Object.freeze({ skillSnapshot: true, runtimeMcp: true }),
    // Pi：两列都补齐（2026-09-21，取代此前的 D1「Pi 有意不支持」）。
    //
    // 依据（两列都是**可执行**的，不是「看起来像」）：
    // - runtimeMcp：pi 与 codex 同形态 —— 进程级 MCP bridge 在工厂阶段冻结 provider 集合，
    //   per-session 判定留到 tool-call（`mcp-integrations/meka-runtime-mcp.ts` 的
    //   `isHarnessBridgeBootstrapContext` 显式包含 `agentKind: 'pi'`），会话侧由
    //   `piEnvironment.getPiExtraSpawnConfig` 把 `?session=` 身份 + vendorOptions 送进
    //   bridge。证据：`__tests__/mcpRegistration.test.ts`、`meka-runtime-mcp.test.ts`
    //   （真 HTTP 往返断言 pi 会话能调用 mcp_router）。
    // - skillSnapshot：pi 用既有显式 `--skill` 通道逐个挂 `<pluginPath>/skills/<id>`
    //   （`packages/maker-core/src/agents/pi/host-skill-mount.ts` + `pi/index.ts` 的
    //   startSession argv），与伙伴自有 Skill 走的是同一条通道，没有新机制。
    //
    // 有意不覆盖的边界（不是遗漏，是平台事实；由
    // `packages/maker-core/src/agents/pi/__tests__/host-skill-mount.test.ts` 钉住）：
    // 远端会话（SSH / MCPRouter worker）不挂本地快照 —— Meka 的远端技能投递
    // （`buildMekaRemoteCodexBundle` / `ensureRemoteCodexCapability`）目前只有 codex 通道。
    pi: Object.freeze({ skillSnapshot: true, runtimeMcp: true }),
  });

/**
 * 矩阵键的运行期投影。由对象键派生而不是手写第二份清单：矩阵里多一个 agent，
 * 注册与断言会自动覆盖到它；「矩阵是否覆盖 AgentKind 全量」由上面的 Record 类型
 * （编译期）+ `__tests__/agentMatrix.test.ts`（运行期）负责。
 *
 * 冻结（矩阵对象、每个能力条目、本数组）是**运行期**防线：`Readonly<...>` 只在编译期
 * 生效，`as` 断言或 `any` 仍可在运行期就地改写矩阵 —— 那会让注册期断言与矩阵悄悄脱钩，
 * 而 `agentMatrix.test.ts` 的 `Object.isFrozen` 用例现在覆盖这三层。
 */
export const MEKA_AGENT_KINDS: readonly AgentKind[] = Object.freeze(
  Object.keys(MEKA_AGENT_CAPABILITIES) as AgentKind[],
);

/** 矩阵里声明 `runtimeMcp: true` 的 agent：必须（且只能）由它们拿到 Meka 运行时 MCP。 */
export function mekaRuntimeMcpAgentKinds(): AgentKind[] {
  return MEKA_AGENT_KINDS.filter((kind) => MEKA_AGENT_CAPABILITIES[kind].runtimeMcp);
}

