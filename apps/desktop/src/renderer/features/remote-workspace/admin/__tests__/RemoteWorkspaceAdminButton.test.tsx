// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：`RemoteWorkspaceAdminButton`（会话标题行「…」之后的「远程工作区」
 *   文字按钮的真实组件入口）。可观察的是：
 *     ① 只有 `psb:` 任务出现**带可见文字**的按钮，文字是「远程工作区」（不再是「远程管理」）；
 *     ② 点击后在**插件页签所在的同一条标签栏**（同一个页签组）里打开/聚焦那一个全局页签，
 *        不会为它弹右侧 dock —— 用户原话：「像插件窗口一样在左侧那排标签里新增一页」；
 *     ③ 已有这一页（用户把它拖到别的组）时只聚焦、不搬回默认组；
 *     ④ 重复点击不产生第二个页签。
 * - Bug / 规则依据：用户 2026-11-26 新口径（入口改名「远程工作区」、从窗口右上角挪到会话
 *   标题行「…」之后；位置接线在 `features/cc-agent/SessionContentHeader.tsx`，本文件覆盖
 *   按钮本身）；产品正本 `docs/product-rules/psb-remote-workspace-sessions.md` §2.4；DESIGN
 *   §4 Buttons（文字按钮为 28px 高的共享 Button）与 §14.6（有常驻文字标签的按钮不重复挂 Tip）。
 * - 现有覆盖缺口：锁住「单入口 + 文字按钮 + 与插件同组的全局单例 + 新文案」。
 * - 最小失败输入：`mcpr:` / SSH / 本地任务也渲染按钮；页签落进右侧 dock 组（用户看到独立
 *   面板）；连点两次出现两个页签；文案退回「Remote management」。
 * - tier：unit（jsdom + RTL + 真实 globalTabs / tabGroups 存储，无真实 PSB / Electron）。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import {
  REMOTE_WORKSPACE_ADMIN_TAB_ID,
  __resetGlobalTabsForTest,
  addGlobalPluginTab,
  addRemoteWorkspaceAdminTab,
  findRemoteWorkspaceAdminTab,
  getActiveGlobalTabId,
  getGlobalTabs,
} from '@/features/right-sidebar/globalTabs';
import {
  _resetSidebarCommandsForTests,
  onRequestRightSidebarVisibility,
  type SidebarVisibilityRequest,
  type SidebarVisibilityRequestOptions,
} from '@/features/right-sidebar/lib/sidebarCommands';
import { __resetTabGroupsForTest, getTabGroup, setTabGroup } from '@/features/right-sidebar/tabGroups';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { RemoteWorkspaceAdminButton } from '../RemoteWorkspaceAdminButton';

let visibilityRequests: Array<[SidebarVisibilityRequest, SidebarVisibilityRequestOptions]>;
let unsubscribe: () => void;

beforeEach(async () => {
  window.localStorage.clear();
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  _resetSidebarCommandsForTests();
  setDataOwnerGeneration('owner-a', 1);
  visibilityRequests = [];
  unsubscribe = onRequestRightSidebarVisibility((visibility, opts) => {
    visibilityRequests.push([visibility, opts]);
  });
  await i18n.changeLanguage('en');
});

afterEach(() => {
  unsubscribe?.();
  _resetSidebarCommandsForTests();
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  cleanup();
  vi.restoreAllMocks();
});

function renderButton() {
  render(<RemoteWorkspaceAdminButton sessionId="local-1" remoteHostId="psb:abc123" />);
  return screen.getByRole('button', { name: i18n.t('remoteWorkspace.admin.title') });
}

it('opens the global admin tab as a titled title-bar button', () => {
  const action = renderButton();
  // 文字按钮：可见标签就在按钮里（不是 icon-only），高度走共享 Button 的 28px 档；
  // 文案已按用户 2026-11-26 口径改为「远程工作区」。
  expect(i18n.t('remoteWorkspace.admin.title')).toBe('Remote workspace');
  expect(action.textContent).toContain(i18n.t('remoteWorkspace.admin.title'));
  expect(action.className).toContain('h-7');
  // 标题行是窗口拖拽区：按钮必须自挖 no-drag，否则点击被当成拖窗吞掉。
  expect((action.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion).toBe(
    'no-drag',
  );

  fireEvent.click(action);
  expect(findRemoteWorkspaceAdminTab()?.id).toBe(REMOTE_WORKSPACE_ADMIN_TAB_ID);
  expect(getActiveGlobalTabId()).toBe(REMOTE_WORKSPACE_ADMIN_TAB_ID);
});

it('lands in the same tab group as the plugin windows and does not pop the right dock', () => {
  // 用户当前布局：插件窗口在左侧组。没有插件页签时缺省边是 left（与停靠面板插件一致）。
  const action = renderButton();
  fireEvent.click(action);
  expect(getTabGroup(REMOTE_WORKSPACE_ADMIN_TAB_ID)).toBe('left');
  // 左侧组是页签组 pane（按在场自动出现），不是可折叠的右侧 dock：不得请求展开右侧栏。
  expect(visibilityRequests).toHaveLength(0);

  cleanup();
  // 真清空：保留上一页的话第二段会走「已存在 → 只聚焦」，测不到「新建时跟随插件组」。
  window.localStorage.clear();
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  // 有插件页签时跟随它所在的组（可能是 top / bottom，用户自己拖过的位置）。
  const plugin = addGlobalPluginTab('alpha')!;
  setTabGroup(plugin.id, 'top');
  fireEvent.click(renderButton());
  expect(getTabGroup(REMOTE_WORKSPACE_ADMIN_TAB_ID)).toBe('top');
  expect(visibilityRequests).toHaveLength(0);
});

it('asks for the right dock only when the tab really lives in the right group', () => {
  // 插件页签在右侧组（默认组）时，本页签落在右侧栏；这个 dock 可折叠，才需要请求展开。
  addGlobalPluginTab('alpha');
  fireEvent.click(renderButton());
  expect(getTabGroup(REMOTE_WORKSPACE_ADMIN_TAB_ID)).toBe('right');
  expect(visibilityRequests).toEqual([['open', { sessionId: 'local-1', userInitiated: true }]]);
});

it('focuses the existing page without moving it back to the default group', () => {
  const action = renderButton();
  fireEvent.click(action);
  // 用户把这页拖到下方组，再点标题栏按钮：只聚焦，不搬回左侧。
  setTabGroup(REMOTE_WORKSPACE_ADMIN_TAB_ID, 'bottom');
  fireEvent.click(action);
  expect(getGlobalTabs().filter((tab) => tab.kind === 'remote-workspace-admin')).toHaveLength(1);
  expect(getTabGroup(REMOTE_WORKSPACE_ADMIN_TAB_ID)).toBe('bottom');
  expect(getActiveGlobalTabId()).toBe(REMOTE_WORKSPACE_ADMIN_TAB_ID);
  expect(visibilityRequests).toHaveLength(0);
});

it('moves an unplaced legacy admin tab out of the right dock on the next open', () => {
  // 旧中间态把这一页按右侧 dock 打开过（没有组归属条目 = 缺省右侧组）。用户反馈「不应该在
  // 最右侧弹出独立面板」，所以下一次点击要把它挪到插件窗口那排，而不是继续留在右边。
  addRemoteWorkspaceAdminTab();
  expect(getTabGroup(REMOTE_WORKSPACE_ADMIN_TAB_ID)).toBe('right');
  fireEvent.click(renderButton());
  expect(getTabGroup(REMOTE_WORKSPACE_ADMIN_TAB_ID)).toBe('left');
  expect(getGlobalTabs().filter((tab) => tab.kind === 'remote-workspace-admin')).toHaveLength(1);
});

it.each([
  ['mcpr remote project', 'local-1', 'mcpr:instance-1'],
  ['ssh host', 'local-1', 'build-box'],
  ['local task', 'local-1', null],
  ['task not resolved yet', null, 'psb:abc123'],
])('stays hidden for a task without a PSB workspace: %s', async (_name, sessionId, remoteHostId) => {
  render(
    <RemoteWorkspaceAdminButton sessionId={sessionId} remoteHostId={remoteHostId} />,
  );
  await act(async () => {});
  expect(screen.queryByRole('button')).toBeNull();
  expect(getGlobalTabs()).toHaveLength(0);
  expect(visibilityRequests).toHaveLength(0);
});
