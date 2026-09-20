import type { AgentKind, McpProvider } from '@cindy/maker-core';

import {
  declareMekaRuntimeMcpAgents,
  type MekaRuntimeMcpAgentDeclaration,
} from '../mcp-integrations/meka-runtime-mcp.js';
import { MEKA_AGENT_CAPABILITIES, MEKA_AGENT_KINDS } from './agentMatrix.js';

/**
 * 三个 `AgentKind` 各自实际持有的 provider 数组（maker-host `_mcpProviders` 的投影）。
 * 视图而不是快照：注册是原地 push，调用方会话随后读到的就是同一批数组。
 */
export interface MekaAgentMcpRegistry {
  get(agentKind: AgentKind): McpProvider[] | undefined;
}

/**
 * 单个 agent 的注册结论。
 * `skipped` 是**显式留档**（矩阵声明 runtimeMcp=false），不是「调用方忘了传」——
 * 后者在下面会直接抛错，不会走到这里。
 */
export type MekaCapabilityRegistration =
  | { agentKind: AgentKind; action: 'registered'; providers: McpProvider[] }
  | { agentKind: AgentKind; action: 'skipped'; reason: 'runtime-mcp-unsupported' };

/**
 * 形态 B：进程级 Meka 能力注册（**唯一生产入口**）。
 *
 * 为什么需要它：原来 maker-host 是
 * `registerMekaRuntimeMcpArrays(claudeMcpProviders, codexMcpProviders)` —— 传哪几个
 * 数组全靠调用方手写。Pi 的 `piMcpProviders` 从没被传进来，于是 Pi 静默地拿不到
 * `mcp-router` / `meka-design` / inline Meka MCP，任何人都不报错。
 *
 * 现在改成「遍历能力矩阵」：
 * - `runtimeMcp: true` 的 agent：从 registry 取数组并注册；**取不到就抛**（漏传 = 启动期硬失败）；
 * - `runtimeMcp: false` 的 agent（当前只有 Pi，D1）：显式跳过并留下可断言记录。
 *
 * 注册顺序 = `MEKA_AGENT_KINDS` 顺序（矩阵对象键序），且每个数组内部仍是
 * `routerProvider` → `mekaDesignProvider` 的原有 push 顺序；数组里已有 provider 的
 * 相对顺序不受影响（I1/I2：claude / codex 拿到的 provider 集合与顺序与改动前一致）。
 */
export function registerMekaCapabilities(
  registry: MekaAgentMcpRegistry,
): MekaCapabilityRegistration[] {
  const declarations: MekaRuntimeMcpAgentDeclaration[] = [];
  const outcomes: MekaCapabilityRegistration[] = [];

  for (const agentKind of MEKA_AGENT_KINDS) {
    if (!MEKA_AGENT_CAPABILITIES[agentKind].runtimeMcp) {
      declarations.push({ agentKind });
      outcomes.push({ agentKind, action: 'skipped', reason: 'runtime-mcp-unsupported' });
      continue;
    }
    const providers = registry.get(agentKind);
    if (!providers) {
      throw new Error(
        `Meka runtime MCP provider array is missing for agent "${agentKind}" ` +
          `(MEKA_AGENT_CAPABILITIES["${agentKind}"].runtimeMcp === true) — ` +
          'register it or flip the matrix entry; do not ship a silent capability gap',
      );
    }
    declarations.push({ agentKind, providers });
    outcomes.push({ agentKind, action: 'registered', providers });
  }

  // 覆盖全量 AgentKind（含显式声明为不支持者）与矩阵一致性由下游断言，
  // 缺声明 / 声明与矩阵矛盾都会在这里抛，而不是静默少注册一个 agent。
  declareMekaRuntimeMcpAgents(declarations);
  return outcomes;
}
