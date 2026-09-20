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
  /** 能否消费 `opts.nativeSkillPluginPath` / `nativeSkillPluginRevision`（技能快照）。 */
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
export const MEKA_AGENT_CAPABILITIES: Readonly<Record<AgentKind, MekaAgentCapabilities>> = {
  'claude-code': { skillSnapshot: true, runtimeMcp: true },
  codex: { skillSnapshot: true, runtimeMcp: true },
  // Pi：**有意不支持**（D1，用户裁决，2026-XX）。依据：packages/maker-core/src/agents/pi/**
  // 对 nativeSkillPluginPath 与 Meka 运行时 MCP 零引用；maker-host 里 Pi 的 provider 数组
  // 也从没被传给 Meka 注册。这里显式写 false，是把「意外缺失」改写成「声明式缺失」——
  // 本轮**不补齐** Pi 能力（补齐另开一轮），Pi 的实际行为必须与改动前逐字节一致。
  pi: { skillSnapshot: false, runtimeMcp: false },
};

/**
 * 矩阵键的运行期投影。由对象键派生而不是手写第二份清单：矩阵里多一个 agent，
 * 注册与断言会自动覆盖到它；「矩阵是否覆盖 AgentKind 全量」由上面的 Record 类型
 * （编译期）+ `__tests__/agentMatrix.test.ts`（运行期）负责。
 */
export const MEKA_AGENT_KINDS: readonly AgentKind[] = Object.freeze(
  Object.keys(MEKA_AGENT_CAPABILITIES) as AgentKind[],
);

/** 矩阵里声明 `runtimeMcp: true` 的 agent：必须（且只能）由它们拿到 Meka 运行时 MCP。 */
export function mekaRuntimeMcpAgentKinds(): AgentKind[] {
  return MEKA_AGENT_KINDS.filter((kind) => MEKA_AGENT_CAPABILITIES[kind].runtimeMcp);
}
