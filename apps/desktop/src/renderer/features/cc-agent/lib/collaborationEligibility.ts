import type { OrcaRole, WorkspaceKind } from '@/lib/ccAgent.types';
import { isMekaAssistantSession } from '../../../../shared/mekaAssistantSession';

export interface CollabEligibleSessionLike {
  workingDir?: string | null;
  workspaceKind?: WorkspaceKind | null;
  remoteHostId?: string | null;
  orcaRole?: OrcaRole | null;
  /** Meka 助理会话身份字段：新真源是成对绑定，只供 isMekaAssistantSession 判定。 */
  mekaProjectId?: string | null;
  mekaRoleId?: string | null;
  mekaRole?: string | null;
}

export interface CollabEligibleDraftLike {
  workingDir?: string | null;
  remoteHostId?: string | null;
  deviceLinkDeviceId?: string | null;
  workspaceKind?: WorkspaceKind | null;
}

/**
 * workspaceKind 层面的本地协同工作区归类。
 *
 * `'meka'` 只服务旧数据兼容（2026-11-20 之前创建的会话）：新 Meka 会话的
 * workspaceKind 是普通值，身份由 `isMekaAssistantSession` 的持久化绑定给出。
 */
export function isLocalCollabWorkspaceKind(
  workspaceKind: WorkspaceKind | null | undefined,
): boolean {
  return workspaceKind === 'project' || workspaceKind === 'meka';
}

export function canShowCollabToggleForSession(
  session: CollabEligibleSessionLike | null | undefined,
): boolean {
  return Boolean(
    session
      && session.orcaRole !== 'worker'
      && session.remoteHostId == null
      // 新 Meka 会话可能是普通 kind（项目目录 'project' / 兜底目录 'dialogue'），
      // 身份以持久化绑定为准；kind 归类只兜旧行。
      && (isMekaAssistantSession(session) || isLocalCollabWorkspaceKind(session.workspaceKind))
      && session.workingDir,
  );
}

/**
 * Meka drafts receive their app-managed working directory from Main while the
 * session is created, so they are eligible before a local cwd exists.
 *
 * 草稿的 `workspaceKind` 是创建意图（NewMakerDraftRoute 显式传 `'meka'`），不是
 * 持久化会话身份；会话身份判定只走 `isMekaAssistantSession`。
 */
export function canShowMekaCollabToggleForDraft(draft: CollabEligibleDraftLike): boolean {
  if (draft.remoteHostId != null || draft.deviceLinkDeviceId != null) return false;
  if (draft.workspaceKind === 'meka') return true;
  return draft.workspaceKind === 'project' && draft.workingDir != null;
}
