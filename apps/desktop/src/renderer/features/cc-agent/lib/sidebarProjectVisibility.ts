import { teammateFolderName, teammateFolderOfProjectPath } from '@cindy/maker-shared/teammate-project';

import type { Session } from '@/lib/ccAgent.types';
import {
  isMekaAssistantSession,
  isRemoteWorkspaceSession,
} from '../../../../shared/mekaAssistantSession';

import {
  projectIdentityKeyForSession,
  projectKeyComparisonKey,
  type ProjectNode,
} from './projectGrouping';

type SidebarProjectSession = Pick<
  Session,
  | 'workingDir'
  | 'projectDir'
  | 'companion'
  | 'remoteHostId'
  | 'deviceLinkDeviceId'
  | 'workspaceKind'
  | 'mekaProjectId'
  | 'mekaRoleId'
  | 'mekaRole'
>;

/**
 * Sidebar-only project visibility.
 *
 * Hidden project keys are a negative overlay on top of the session-derived
 * project catalogue. Session state and project membership remain untouched.
 */
export function isProjectHidden(
  projectKey: string,
  hiddenProjectKeys: ReadonlySet<string>,
  localPlatform: string,
): boolean {
  const comparisonKey = projectKeyComparisonKey(projectKey, localPlatform);
  if (comparisonKey == null) return false;
  for (const hiddenProjectKey of hiddenProjectKeys) {
    if (projectKeyComparisonKey(hiddenProjectKey, localPlatform) === comparisonKey) return true;
  }
  return false;
}

export function isSessionInHiddenProject(
  session: SidebarProjectSession,
  hiddenProjectKeys: ReadonlySet<string>,
  localPlatform: string,
): boolean {
  // Dialogue tasks own a working directory too, but that directory is not a
  // user-added project and must never be hidden by a project tombstone.
  if (session.workspaceKind === 'dialogue' && !session.companion?.taskProjectDir) return false;
  const projectKey = projectIdentityKeyForSession(session);
  return projectKey != null && isProjectHidden(projectKey, hiddenProjectKeys, localPlatform);
}

export function buildProjectKeyComparisonSet(
  projectKeys: Iterable<string>,
  localPlatform: string,
): Set<string> {
  const comparisonKeys = new Set<string>();
  for (const projectKey of projectKeys) {
    const comparisonKey = projectKeyComparisonKey(projectKey, localPlatform);
    if (comparisonKey != null) comparisonKeys.add(comparisonKey);
  }
  return comparisonKeys;
}

export function projectKeyComparisonSetHas(
  comparisonKeys: ReadonlySet<string>,
  projectKey: string | null | undefined,
  localPlatform: string,
): boolean {
  const comparisonKey = projectKeyComparisonKey(projectKey, localPlatform);
  return comparisonKey != null && comparisonKeys.has(comparisonKey);
}

/** Resolve an external/deep-link key to the exact representative rendered in the sidebar. */
export function findProjectRepresentativeKey(
  projects: readonly Pick<ProjectNode, 'projectKey'>[],
  projectKey: string,
  localPlatform: string,
): string | null {
  const comparisonKey = projectKeyComparisonKey(projectKey, localPlatform);
  if (comparisonKey == null) return null;
  return (
    projects.find(
      (project) => projectKeyComparisonKey(project.projectKey, localPlatform) === comparisonKey,
    )?.projectKey ?? null
  );
}

/** Session-level project selectors must use the same comparison identity as project nodes. */
export function isSessionInProjectComparisonSet(
  session: SidebarProjectSession,
  projectComparisonKeys: ReadonlySet<string>,
  localPlatform: string,
): boolean {
  if (session.workspaceKind === 'dialogue' && !session.companion?.taskProjectDir) return false;
  return projectKeyComparisonSetHas(
    projectComparisonKeys,
    projectIdentityKeyForSession(session),
    localPlatform,
  );
}

/** Single-project action membership using the same local Windows comparison identity. */
export function isSessionInProject(
  session: SidebarProjectSession,
  projectKey: string,
  localPlatform: string,
): boolean {
  if (session.workspaceKind === 'dialogue' && !session.companion?.taskProjectDir) return false;
  const sessionProjectKey = projectIdentityKeyForSession(session);
  const sessionComparisonKey = projectKeyComparisonKey(sessionProjectKey, localPlatform);
  const projectComparisonKey = projectKeyComparisonKey(projectKey, localPlatform);
  return sessionComparisonKey != null && sessionComparisonKey === projectComparisonKey;
}

function isSessionInHiddenProjectComparisonSet(
  session: SidebarProjectSession,
  hiddenProjectComparisonKeys: ReadonlySet<string>,
  localPlatform: string,
): boolean {
  return isSessionInProjectComparisonSet(session, hiddenProjectComparisonKeys, localPlatform);
}

/**
 * A teammate's project on this computer while the teammate runs on another computer (its copy here
 * is demoted, cloud-companions.md §2.1): hidden, its files stay; shown again once it comes back.
 */
export function withoutTeammateProjectsElsewhere(
  projects: readonly ProjectNode[],
  demotedBotIds: readonly string[],
): ProjectNode[] {
  if (demotedBotIds.length === 0) return Array.from(projects);
  const folders = new Set(demotedBotIds.map(teammateFolderName));
  return projects.filter((project) => {
    if (project.remoteHostId || project.deviceLinkDeviceId) return true;
    const folder = teammateFolderOfProjectPath(project.workingDir);
    return !folder || !folders.has(folder);
  });
}

export function visibleSidebarProjects(
  projects: readonly ProjectNode[],
  hiddenProjectKeys: ReadonlySet<string>,
  localPlatform: string,
): ProjectNode[] {
  if (hiddenProjectKeys.size === 0) return Array.from(projects);
  const hiddenProjectComparisonKeys = buildProjectKeyComparisonSet(
    hiddenProjectKeys,
    localPlatform,
  );
  if (hiddenProjectComparisonKeys.size === 0) return Array.from(projects);
  return projects.filter(
    (project) =>
      !projectKeyComparisonSetHas(
        hiddenProjectComparisonKeys,
        project.projectKey,
        localPlatform,
      ),
  );
}

/**
 * Build the sidebar presentation without mutating the persisted session.
 *
 * A removed project's tasks stay associated with their working directory so
 * re-adding that directory can restore the original grouping. While the
 * project is hidden, present those tasks as ordinary Chat entries instead of
 * dropping them from the sidebar altogether.
 */
export function sidebarSessionsWithHiddenProjectsAsDialogues(
  sessions: readonly Session[],
  hiddenProjectKeys: ReadonlySet<string>,
  localPlatform: string,
): Session[] {
  if (hiddenProjectKeys.size === 0) return Array.from(sessions);
  const hiddenProjectComparisonKeys = buildProjectKeyComparisonSet(
    hiddenProjectKeys,
    localPlatform,
  );
  if (hiddenProjectComparisonKeys.size === 0) return Array.from(sessions);
  return sessions.map((session) =>
    // Meka 会话的身份是持久化绑定而不是工作区归属：即便其目录命中被隐藏项目，
    // 也不能被改写成 dialogue —— 否则会掉进普通项目/对话分组并从 Meka 段消失。
    // 远程工作区会话同理：身份是 `psb:<PSB sessionId>`，虚拟工作目录只是显示引用，
    // 被改写成 dialogue 会让它离开「远程工作区」节点（产品正本 §2.1：只有一个归属位置）。
    isSessionInHiddenProjectComparisonSet(
      session,
      hiddenProjectComparisonKeys,
      localPlatform,
    ) && !isMekaAssistantSession(session) && !isRemoteWorkspaceSession(session)
      ? { ...session, workspaceKind: 'dialogue',
          ...(session.companion ? { companion: { ...session.companion, taskProjectDir: undefined } } : {}) }
      : session,
  );
}
