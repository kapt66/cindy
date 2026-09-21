import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import type { MekaProject } from '../../../../shared/meka-projects';
import {
  buildMekaProjectSessionGroups,
  mekaProjectGroupKey,
  resolveMekaFoldState,
} from '../sidebar/sections/MekaAssistantSection';
import { buildMekaRoleEditorRoute, resolveMekaSessionScope } from '../useMekaSessionScope';

const mekaAssistantSectionSource = readFileSync(
  resolve(__dirname, '..', 'sidebar', 'sections', 'MekaAssistantSection.tsx'),
  'utf8',
);

const sidebarUpperSource = readFileSync(
  resolve(__dirname, '..', 'CCAgentSidebarUpper.tsx'),
  'utf8',
);

const project: MekaProject = {
  id: 'project-a',
  name: 'project-a',
  displayName: 'Project A',
  description: null,
  tags: [],
  isBuiltin: false,
  configSource: 'project',
  configUnavailable: false,
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
  it('applies the shared sidebar list style without changing Meka grouping', () => {
    expect(mekaAssistantSectionSource).toContain(
      "import { useSidebarMainViewMode } from '@/hooks/useSidebarCardMode';",
    );
    expect(mekaAssistantSectionSource).toContain(
      "const mainSessionVariant: 'text' | 'list' = mainViewMode === 'list' ? 'list' : 'text';",
    );
    expect(mekaAssistantSectionSource).toContain('sessionVariant={mainSessionVariant}');
  });

  // 2026-09-15 用户裁决:「Meka 助理」段头右侧与「全部任务」段头对齐——同一套
  // 「收起所有分组」+「侧边栏显示设置」按钮。以下断言防止回退到只有管理按钮的旧段头。
  it('mirrors the main-list header actions in the Meka section header', () => {
    expect(mekaAssistantSectionSource).toContain(
      "import { HEADER_ACTIONS_CLASS, HEADER_HOVER_ACTION_CLASS, SidebarFoldAllButton } from '../SidebarHeaderActions';",
    );
    expect(mekaAssistantSectionSource).toContain('<div className={HEADER_ACTIONS_CLASS}>');
    expect(mekaAssistantSectionSource).toContain('<SidebarFoldAllButton');
    // 显示设置与「全部任务」段头是同一份全局菜单(不是 Meka 专属菜单)。
    expect(mekaAssistantSectionSource).toContain('<SidebarFilterPopover');
    expect(mekaAssistantSectionSource).toContain('filter={filter}');
    expect(mekaAssistantSectionSource).toContain('allKnownProjects={allKnownProjects}');
    // 折叠作用域 = Meka 自己的项目分组:渲染、状态判定与批量收起共用同一个 key。
    expect(mekaAssistantSectionSource).toContain('mekaProjectGroupKey(group.projectId)');
    expect(mekaAssistantSectionSource).toContain('setCollapsedProjects(new Set(groupKeys))');
    // 段头右侧多了两个 28px 动作钮 → 标题必须能截断(与「全部任务」标题同款),
    // 否则窄侧栏(下限 180px)下 14px 文案会在 h-6 行里折行、盖住下面的项目树。
    expect(mekaAssistantSectionSource).toContain('min-w-0 truncate text-sm font-medium');
    // 父层必须把全局 filter 与菜单候选集喂进来,否则菜单点开是空的。
    // 只取 MekaAssistantSection 这一次调用(同一文件里 MainListScopeHeader 也传同名 prop)。
    const mekaCallSite = sidebarUpperSource.slice(
      sidebarUpperSource.indexOf('<MekaAssistantSection'),
      sidebarUpperSource.indexOf('<PinnedSection'),
    );
    expect(mekaCallSite).toContain('filter={filter}');
    expect(mekaCallSite).toContain('allKnownProjects={visibleProjectUniverse}');
    expect(mekaCallSite).toContain('dialogueCount={allGroups.dialogues.length}');
    expect(mekaCallSite).toContain('hasRemoteDevices={deviceGroupingAvailable}');
  });

  it('offers the fold-all action only while Meka project groups are actually visible', () => {
    const collapsed = (...keys: string[]) => new Set(keys);
    const base = { sectionCollapsed: false };

    // 还有任意一个项目分组没收起 → 按钮文案/图标是「收起所有分组」。
    expect(
      resolveMekaFoldState({
        ...base,
        groupKeys: ['project-a', mekaProjectGroupKey(null)],
        collapsedProjectKeys: collapsed('project-a'),
      }),
    ).toBe('collapse');
    // 全部收齐(含孤儿桶)→ 切成「展开所有分组」。
    expect(
      resolveMekaFoldState({
        ...base,
        groupKeys: ['project-a', mekaProjectGroupKey(null)],
        collapsedProjectKeys: collapsed('project-a', mekaProjectGroupKey(null)),
      }),
    ).toBe('expand');
    // 没有项目分组 → 无分组可收,退场。
    expect(
      resolveMekaFoldState({ ...base, groupKeys: [], collapsedProjectKeys: collapsed() }),
    ).toBeNull();
    // 整段已收起 → 按钮退场(点了看不出变化),避免与标题旁的整段收起语义打架。
    expect(
      resolveMekaFoldState({
        groupKeys: ['project-a'],
        collapsedProjectKeys: collapsed(),
        sectionCollapsed: true,
      }),
    ).toBeNull();
  });

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
