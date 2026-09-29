import type { MakerVendor } from './ccAgent.types';

/**
 * MCPRouter 位置下的引擎面 = 已注册引擎 − Pi。
 *
 * **为什么是「没有实现」而不是「暂时不可用」**：
 *   - MCPRouter 的 project-agent-instances 只把 `agentType` 为 `claude` / `codex` 的实例判为可用
 *     （`main/meka-settings/routerService.ts` 的 `normalizeInstance`）；
 *   - Pi 的远端形态只有 SSH（`packages/maker-pi-manager` + `SshPiDaemonTransport`，
 *     见 `docs/dev-rules/pi-harness.md`「SSH 远端能力」）。
 *
 * 所以 `pi` + `mcpr:<id>` 是注定失败的组合，必须在**引擎面**就收掉；否则用户会选出来，
 * 再在发送时撞主进程侧的类型化拒绝（`MCPR_AGENT_UNSUPPORTED`）。2026-09-29 的实机故障
 * 更糟：那一版还没门禁，报的是 `remote SSH host "mcpr:<id>" not found in pool`，
 * 把「不支持」误导成「SSH 主机没连」。
 *
 * **收进来当一个纯函数，是因为这条规则有两个消费方**：新建任务草稿的引擎下拉
 * （`NewMakerDraftRoute` 的 `hiddenSwitcherVendors`）与「引擎跟着模型走」的统一模型列表
 * （`ChatInput` 的 `unifiedAgents`）。两处各写一遍条件正是本仓反复吃过的「同一规则两处漂移」
 * 形状；这里是它们的唯一判定点。
 *
 * **身份稳定**：不需要收窄时返回入参本身（不拷贝）。调用方普遍把它放进 `useMemo` 依赖，
 * 每次新建一个 `Set` 会让下游 memo 全部失效。
 */
export function resolveMcprEngineSurface(
  availableVendors: ReadonlySet<MakerVendor>,
  mcprTarget: boolean,
): ReadonlySet<MakerVendor> {
  if (!mcprTarget) return availableVendors;
  if (!availableVendors.has('pi')) return availableVendors;
  const surface = new Set(availableVendors);
  surface.delete('pi');
  return surface;
}
