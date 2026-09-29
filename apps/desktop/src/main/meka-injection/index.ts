/**
 * Meka 注入层对外**唯一**入口。
 *
 * 入口形态与口子（一个形态恰好一个入口，不提供第二入口）：
 * - 形态 A：会话创建 / 恢复 —— `applyMekaRuntimeConfig`（= `resolveMekaInjection` + `applyMekaInjection`）
 * - 形态 B：进程级能力注册 —— `./mekaMcpRegistration.js`（本文件不转发，避免出现两个入口名）
 *
 * 形态 C（每轮续聊的 `prepareCombatFollowupRuntimeContext`）已随战斗业务整体退役；本文件不再
 * 有第二个入口。
 *
 * 分层（文件名带 `meka` 前缀的依据见 `docs/dev-rules/meka-injection-layer.md` §0）：
 * - `mekaPrompts.ts`     段落文本的唯一来源（`role-context` 与 `project-references` 两段）
 * - `mekaResolvePlan.ts` 第 2 层：解析（含全部 I/O）→ `MekaInjectionPlan`
 * - `mekaApplyPlan.ts`   第 3 层：落地（纯写 opts，不做 I/O）
 *
 * 历史：本目录是 `maker-ipc/mekaRuntimeInjection.ts` 的搬迁与显式分层。对外导出名与
 * 签名保持不变，`maker-ipc/register.ts` 只改 import 路径、断言未动。
 *
 * 导出面 = 形态 A 的唯一入口 + **只有公共签名上用到的**类型。层内类型
 * （`MekaInjectionPlan` 等）与形态 A 的两个子步骤**不再转出**：生产与测试都走
 * `applyMekaRuntimeConfig`，转出去只会长出第二入口（见 `docs/dev-rules/meka-injection-layer.md` §2）。
 * 段落文本构建器同理：它们由 `mekaResolvePlan.ts` 直接消费，不经本文件转发。
 */

import type { MakerSessionCreateOpts } from '../maker-ipc/sessionRequest.js';
import { applyMekaInjection, emptyMekaRuntimeResult } from './mekaApplyPlan.js';
import { resolveMekaInjection } from './mekaResolvePlan.js';
import type { AppliedMekaRuntimeConfig, ApplyMekaRuntimeConfigDeps } from './mekaInjectionTypes.js';

export type {
  AppliedMekaRuntimeConfig,
  ApplyMekaRuntimeConfigDeps,
  PersistedMekaSessionBinding,
} from './mekaInjectionTypes.js';

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
