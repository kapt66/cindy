/**
 * Meka 助理会话的跨层身份判定。
 *
 * 唯一真源是持久化绑定 `(mekaProjectId, mekaRoleId)` 成对存在。`workspaceKind === 'meka'`
 * 与旧 `mekaRole` 只作为存量数据兼容；新会话不再写 `workspaceKind='meka'`。
 * 规则正本见 `docs/dev-rules/meka-assistant-session-binding.md`。
 *
 * 远程工作区（`psb:`）会话**不是** Meka 助理会话（产品正本
 * `docs/product-rules/psb-remote-workspace-sessions.md` §2.1：它是普通任务，只是跑在 PSB
 * 远端工作区里）：即使某条 `psb:` 会话带着旧 `workspaceKind === 'meka'` 字段，也一律不算。
 * 渲染层的同一判据封装在 `renderer/features/remote-workspace/sidebar/isRemoteWorkspaceSession.ts`，
 * 前缀解析只在共享契约 `psb-remote-workspace.ts` 的 `parsePsbRemoteHostId` 一处。
 */

import { parsePsbRemoteHostId } from './psb-remote-workspace';

export interface MekaAssistantSessionLike {
  workspaceKind?: string | null;
  mekaProjectId?: string | null;
  mekaRoleId?: string | null;
  /** 更旧的内置角色标记（无 project/role id），只读兼容。 */
  mekaRole?: string | null;
  /** 远端 transport 身份；`psb:<PSB sessionId>` 表示远程工作区会话。 */
  remoteHostId?: string | null;
}

/** 会话是不是远程工作区（`psb:`）会话 —— 与渲染层 `isRemoteWorkspaceSession` 同口径。 */
export function isRemoteWorkspaceSession(
  session: Pick<MekaAssistantSessionLike, 'remoteHostId'> | null | undefined,
): boolean {
  return parsePsbRemoteHostId(session?.remoteHostId) !== null;
}

/** 会话是否带完整的 Meka 项目/角色绑定（新真源）。 */
export function hasMekaAssistantBinding(session: MekaAssistantSessionLike | null | undefined): boolean {
  if (!session) return false;
  return Boolean(session.mekaProjectId) && Boolean(session.mekaRoleId);
}

/**
 * 会话是不是 Meka 助理会话。
 *
 * - 绑定成对：新会话 / 新数据；
 * - `workspaceKind === 'meka'`：2026-11-20 之前创建的旧行；
 * - `mekaRole`：更旧、只有内置角色标记的行。
 *
 * 远程工作区会话无论带什么历史字段都不算 Meka 助理会话（见文件头）。
 */
export function isMekaAssistantSession(session: MekaAssistantSessionLike | null | undefined): boolean {
  if (!session) return false;
  if (isRemoteWorkspaceSession(session)) return false;
  if (hasMekaAssistantBinding(session)) return true;
  return session.workspaceKind === 'meka' || Boolean(session.mekaRole);
}
