/**
 * Meka 助理会话的跨层身份判定。
 *
 * 唯一真源是持久化绑定 `(mekaProjectId, mekaRoleId)` 成对存在。`workspaceKind === 'meka'`
 * 与旧 `mekaRole` 只作为存量数据兼容；新会话不再写 `workspaceKind='meka'`。
 * 规则正本见 `docs/dev-rules/meka-assistant-session-binding.md`。
 */

export interface MekaAssistantSessionLike {
  workspaceKind?: string | null;
  mekaProjectId?: string | null;
  mekaRoleId?: string | null;
  /** 更旧的内置角色标记（无 project/role id），只读兼容。 */
  mekaRole?: string | null;
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
 */
export function isMekaAssistantSession(session: MekaAssistantSessionLike | null | undefined): boolean {
  if (!session) return false;
  if (hasMekaAssistantBinding(session)) return true;
  return session.workspaceKind === 'meka' || Boolean(session.mekaRole);
}
