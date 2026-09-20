/**
 * Meka 注入层对外**唯一**入口。
 *
 * 入口形态与口子（一个形态恰好一个入口，不提供第二入口）：
 * - 形态 A：会话创建 / 恢复 —— `applyMekaRuntimeConfig`（= `resolveMekaInjection` + `applyMekaInjection`）
 * - 形态 B：进程级能力注册 —— `./mcpRegistration.js`（本文件不转发，避免出现两个入口名）
 * - 形态 C：每轮续聊 —— `prepareCombatFollowupRuntimeContext`
 *
 * 分层：
 * - `combatPrompts.ts` 段落文本与战斗 ID 解析的唯一来源（零文本改动）
 * - `resolvePlan.ts`   第 2 层：解析（含全部 I/O）→ `MekaInjectionPlan`
 * - `applyPlan.ts`     第 3 层：落地（纯写 opts，不做 I/O）
 *
 * 历史：本目录是 `maker-ipc/mekaRuntimeInjection.ts`（688 行）的搬迁与显式分层。对外导出名与
 * 签名保持不变，`maker-ipc/register.ts` 与两份注入测试只改 import 路径、断言未动。
 */

import type { MakerSessionCreateOpts } from '../maker-ipc/sessionRequest.js';
import { applyMekaInjection, emptyMekaRuntimeResult } from './applyPlan.js';
import { prepareCombatFollowupRuntimeContext, resolveMekaInjection } from './resolvePlan.js';
import type { AppliedMekaRuntimeConfig, ApplyMekaRuntimeConfigDeps } from './types.js';

export {
  combatSkillIdVendorPatchFromUserPrompt,
  parseCombatSkillIdFromUserPrompt,
} from './combatPrompts.js';
export { applyMekaInjection, resolveMekaInjection };
export { prepareCombatFollowupRuntimeContext };
export type {
  AppliedMekaRuntimeConfig,
  ApplyMekaRuntimeConfigDeps,
  CombatFollowupRuntimeContext,
  CombatSkillIdParseResult,
  MekaInjectionDeps,
  MekaInjectionInput,
  MekaInjectionPlan,
  MekaInjectionResult,
  MekaInlineMcpConfig,
  MekaNativeSkillMount,
  MekaPromptSegment,
  MekaPromptSegmentId,
  MekaSessionBindingPatch,
  MekaTurnInjection,
  PersistedMekaSessionBinding,
} from './types.js';

/**
 * 形态 A：会话创建 / 恢复。
 *
 * 只做组合：解析（含全部 I/O）→ 落地（只写 opts）。本身不含任何业务分支。
 * `sessionId` 的生产唯一来源是 `opts.id`（缺省 / 非字符串 → 空串，沿用重构前的判定）。
 */
export async function applyMekaRuntimeConfig(
  opts: MakerSessionCreateOpts,
  deps: ApplyMekaRuntimeConfigDeps = {},
): Promise<AppliedMekaRuntimeConfig> {
  const plan = await resolveMekaInjection({
    sessionId: typeof opts.id === 'string' ? opts.id : '',
    opts,
    deps,
  });
  if (!plan) return emptyMekaRuntimeResult();
  return applyMekaInjection(opts, plan);
}
