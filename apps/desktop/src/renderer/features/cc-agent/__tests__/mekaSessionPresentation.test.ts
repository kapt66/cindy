import { describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import type { MekaProject } from '../../../../shared/meka-projects';
import { buildMekaProjectSessionGroups } from '../sidebar/sections/MekaAssistantSection';
import { buildMekaRoleEditorRoute, resolveMekaSessionScope } from '../useMekaSessionScope';

const project: MekaProject = {
  id: 'project-a',
  name: 'project-a',
  displayName: 'Project A',
  description: null,
  tags: [],
  isBuiltin: false,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  roles: [
    {
      id: 'role-a',
      projectId: 'project-a',
      name: 'role-a',
      displayName: 'Planner',
      description: null,
      tags: [],
      filePath: 'meka-roles/role-a.json',
      isBuiltin: false,
      contentDigest: null,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  formalWorkflowEnabled: true,
  workflowType: 'jira',
  jiraProjectKey: 'APP',
};

function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    agentKind: 'cc',
    workspaceKind: 'meka',
    status: 'active',
    source: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mekaProjectId: 'project-a',
    mekaRoleId: 'role-a',
    ...patch,
  } as Session;
}

describe('Meka session presentation', () => {
  it('groups formal and regular sessions under the frozen project binding', () => {
    const groups = buildMekaProjectSessionGroups(
      [project],
      [session('regular'), session('formal', { isFormal: true })],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.project?.displayName).toBe('Project A');
    expect(groups[0]?.formalWorkflowActive).toBe(true);
    expect(groups[0]?.regularSessions.map((item) => item.id)).toEqual(['regular']);
    expect(groups[0]?.formalSessions.map((item) => item.id)).toEqual(['formal']);
  });

  it('keeps configured projects visible before their first session and exposes both subgroups', () => {
    const groups = buildMekaProjectSessionGroups([project], []);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      projectId: 'project-a',
      formalWorkflowActive: true,
      formalSessions: [],
      regularSessions: [],
    });
  });

  it('keeps sessions flat when the project does not have an active formal workflow', () => {
    const groups = buildMekaProjectSessionGroups(
      [{ ...project, formalWorkflowEnabled: false }],
      [session('formal', { isFormal: true }), session('regular')],
    );

    expect(groups[0]?.formalWorkflowActive).toBe(false);
    expect(groups[0]?.formalSessions).toEqual([]);
    expect(groups[0]?.regularSessions.map((item) => item.id)).toEqual(['formal', 'regular']);
  });

  it('keeps sessions whose project was removed visible in an unavailable group', () => {
    const groups = buildMekaProjectSessionGroups(
      [],
      [session('orphan', { mekaProjectId: 'removed-project' })],
    );

    expect(groups[0]).toMatchObject({
      projectId: 'removed-project',
      project: null,
    });
  });

  it('keeps legacy sessions visible and pinned sessions first within their project', () => {
    const groups = buildMekaProjectSessionGroups(
      [project],
      [
        session('recent', { updatedAt: '2026-02-01T00:00:00.000Z' }),
        session('pinned', {
          pinnedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
        session('legacy', { mekaProjectId: null, mekaRoleId: null, mekaRole: 'planner' }),
      ],
    );

    expect(groups[0]?.regularSessions.map((item) => item.id)).toEqual(['pinned', 'recent']);
    expect(groups[1]).toMatchObject({ projectId: null, project: null });
    expect(groups[1]?.regularSessions[0]?.id).toBe('legacy');
  });

  it('shows only the role name in the session header', () => {
    expect(resolveMekaSessionScope(project, 'role-a')).toBe('Planner');
    expect(resolveMekaSessionScope(project, 'removed-role')).toBeNull();
    expect(resolveMekaSessionScope(null, 'role-a')).toBeNull();
  });

  it('builds a direct role-editor route with encoded frozen identities', () => {
    expect(buildMekaRoleEditorRoute('project/a', 'role & planner')).toBe(
      '/cc-agent/meka?projectId=project%2Fa&roleId=role%20%26%20planner',
    );
  });
});
