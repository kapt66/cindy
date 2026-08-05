import type { OrcaRole, WorkspaceKind } from '@/lib/ccAgent.types';

export interface CollabEligibleSessionLike {
  workingDir?: string | null;
  workspaceKind?: WorkspaceKind | null;
  remoteHostId?: string | null;
  orcaRole?: OrcaRole | null;
}

export interface CollabEligibleDraftLike {
  workingDir?: string | null;
  remoteHostId?: string | null;
  deviceLinkDeviceId?: string | null;
  workspaceKind?: WorkspaceKind | null;
}

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
      && isLocalCollabWorkspaceKind(session.workspaceKind)
      && session.workingDir,
  );
}

/**
 * Meka drafts receive their app-managed working directory from Main while the
 * session is created, so they are eligible before a local cwd exists.
 */
export function canShowMekaCollabToggleForDraft(draft: CollabEligibleDraftLike): boolean {
  if (draft.remoteHostId != null || draft.deviceLinkDeviceId != null) return false;
  if (draft.workspaceKind === 'meka') return true;
  return draft.workspaceKind === 'project' && draft.workingDir != null;
}
