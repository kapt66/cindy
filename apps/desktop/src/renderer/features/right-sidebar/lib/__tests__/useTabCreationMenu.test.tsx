// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：右栏「+」创建菜单的单一打开入口。`useTabCreationMenu.select()` 对
 *   「远程工作区」页签必须走 `openRemoteWorkspaceAdminTab`（管理页 / 标题栏按钮用的同一条路径），
 *   并落在点「+」的那排标签栏所在组；重复点只聚焦同一个全局页签。
 * - Bug／规则依据：
 *   ① 2026-11-26 独立审查 r6——菜单此前直接 `addRemoteWorkspaceAdminTab`，绕过单入口里的组迁移
 *      （旧中间态按右侧 dock 打开的页签回不到插件标签栏）与展开请求，两条入口行为不一致；
 *   ② 2026-11-27 s5 复审 P1——菜单先调单入口、再 `setTabGroup` 覆盖组：dock 展开判定用旧组，
 *      用户在左排点「+」却弹出右侧 dock。组必须由单入口只写一次、展开判定按最终组执行。
 * - 现有覆盖缺口：`AddTabDropdown.test.tsx` 覆盖菜单渲染与插件页签落点，不覆盖远程工作区页签的
 *   打开路径与 dock 展开判定。
 * - 最小失败输入：菜单直接建页签 → 旧页签不迁移组；单入口按偏好组（right）展开 dock 后再把页签
 *   挪到 left → 左排点 + 弹出右侧 dock。
 * - tier：unit（jsdom + 本地 localStorage，无网络/进程）。
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/cindy-brain/useInstalledGhosts', () => ({ useInstalledGhosts: () => [] }));
vi.mock('@/features/bots/botStore', () => ({ useBotProfiles: () => [] }));
vi.mock('@/features/bots/botSessionOwners', () => ({ findBotProfileForSession: () => undefined }));
vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: { subscribe: () => () => undefined, findById: () => null },
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => [],
}));
vi.mock('@/features/cc-agent/lib/remoteSessionWriteGuard', () => ({
  isRemoteSessionWriteBlocked: () => false,
}));

import { useTabCreationMenu } from '../useTabCreationMenu';
import {
  REMOTE_WORKSPACE_ADMIN_TAB_KIND,
  __resetGlobalTabsForTest,
  addGlobalPluginTab,
  findRemoteWorkspaceAdminTab,
} from '../../globalTabs';
import { __resetTabGroupsForTest, getTabGroup } from '../../tabGroups';
import { _resetSidebarCommandsForTests, onRequestRightSidebarVisibility } from '../sidebarCommands';

beforeEach(() => {
  localStorage.clear();
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  _resetSidebarCommandsForTests();
});

function mountMenu() {
  const onSelect = vi.fn();
  const onGlobalTabSelected = vi.fn();
  const hook = renderHook(() =>
    useTabCreationMenu({
      sessionId: 'session-1',
      subagentsAvailable: false,
      onSelect,
    }),
  );
  return { ...hook, onSelect, onGlobalTabSelected };
}

describe('right sidebar remote-workspace admin tab entry', () => {
  it('opens the single global tab through the shared entry and keeps the clicked group', () => {
    const { result, onSelect, onGlobalTabSelected } = mountMenu();

    act(() => {
      result.current.select(REMOTE_WORKSPACE_ADMIN_TAB_KIND, {
        groupId: 'left',
        onGlobalTabSelected,
      });
    });

    const tab = findRemoteWorkspaceAdminTab();
    expect(tab).not.toBeNull();
    // 「+」菜单独有语义：落点 = 点 + 的那排标签栏所在组。
    expect(getTabGroup(tab!.id)).toBe('left');
    expect(onGlobalTabSelected).toHaveBeenCalledWith(tab!.id, false);
    // 全局至多一个：再次选择只聚焦同一条，不新建第二条。
    act(() => {
      result.current.select(REMOTE_WORKSPACE_ADMIN_TAB_KIND, {
        groupId: 'left',
        onGlobalTabSelected,
      });
    });
    expect(findRemoteWorkspaceAdminTab()!.id).toBe(tab!.id);
    expect(onGlobalTabSelected).toHaveBeenLastCalledWith(tab!.id, true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('decides the right-dock reveal from the final group, not the preferred plugin group', () => {
    // 插件窗口那排已经在右侧组 → 单入口的「偏好组」是 right。
    addGlobalPluginTab('plugin-instance');
    const requests: Array<{ visibility: string; sessionId?: string }> = [];
    onRequestRightSidebarVisibility((visibility, opts) => {
      requests.push({ visibility, sessionId: opts.sessionId });
    });
    const { result } = mountMenu();

    // 用户在**左排**点「+」：页签落到 left，dock 不得被展开（旧实现先按 right 展开再挪组）。
    act(() => {
      result.current.select(REMOTE_WORKSPACE_ADMIN_TAB_KIND, { groupId: 'left' });
    });
    expect(getTabGroup(findRemoteWorkspaceAdminTab()!.id)).toBe('left');
    expect(requests).toEqual([]);
  });

  it('reveals the right dock only when the final group is the collapsible right column', () => {
    addGlobalPluginTab('plugin-instance');
    const requests: Array<{ visibility: string; sessionId?: string; userInitiated?: boolean }> = [];
    onRequestRightSidebarVisibility((visibility, opts) => {
      requests.push({ visibility, sessionId: opts.sessionId, userInitiated: opts.userInitiated });
    });
    const { result } = mountMenu();

    // 没有显式落点（例如标题栏 / 管理页按钮）：跟随插件窗口那排 = right，此时才展开 dock。
    act(() => {
      result.current.select(REMOTE_WORKSPACE_ADMIN_TAB_KIND);
    });
    expect(getTabGroup(findRemoteWorkspaceAdminTab()!.id)).toBe('right');
    expect(requests).toEqual([{ visibility: 'open', sessionId: 'session-1', userInitiated: true }]);
  });

  it('moves an already-open tab to the clicked group without revealing the other dock', () => {
    addGlobalPluginTab('plugin-instance');
    const requests: string[] = [];
    onRequestRightSidebarVisibility((visibility) => requests.push(visibility));
    const { result } = mountMenu();

    // 先在偏好组（right）打开，再从左侧插件窗口那排点「+」：既有页签被挪到 left，
    // 且这一次点击不能顺手把右侧 dock 展开。
    act(() => {
      result.current.select(REMOTE_WORKSPACE_ADMIN_TAB_KIND, { groupId: 'right' });
    });
    expect(requests).toEqual(['open']);
    act(() => {
      result.current.select(REMOTE_WORKSPACE_ADMIN_TAB_KIND, { groupId: 'left' });
    });
    expect(getTabGroup(findRemoteWorkspaceAdminTab()!.id)).toBe('left');
    expect(requests).toEqual(['open']);
  });
});
