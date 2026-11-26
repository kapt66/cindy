// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：真实的「+」创建菜单 hook（`useTabCreationMenu`）与真实的
 *   `remote-workspace-admin` 页签注册。可观察的是：
 *     ① 菜单里有「远程工作区」一项，且**没有**第二个远程工作区页签 kind（旧的串流页签已退役）；
 *     ② 选中它 = 打开/聚焦那**一个**全局页签（不走按任务分桶的 addTab，`onSelect` 不会被调用）；
 *     ③ 没有打开任务 / 打开的不是远程工作区任务时也能选中（页面自己进提示态），
 *        再次选中只是聚焦同一页签、菜单显示「已打开」。
 * - Bug / 规则依据：用户要求「在左侧的标签页加号点击后，也需要能手动添加远程工作区页面，
 *   跟会话页按钮一样的效果」；产品正本 `docs/product-rules/psb-remote-workspace-sessions.md` §2.4。
 * - 现有覆盖缺口：加号菜单的全局页签分支此前只覆盖插件项（`plugin-view`）。
 * - 最小失败输入：菜单项走 `addTab` → 页签落进当前任务桶、切任务就消失；重复选中产生第二个页签。
 * - tier：unit（jsdom localStorage + RTL，无 Electron）。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// 真实注册：菜单项来自页签注册表，本用例要验证的就是真实条目，不复制 label / 排序常量。
import '@/features/right-sidebar/plugins/remote-workspace-admin';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  REMOTE_WORKSPACE_ADMIN_TAB_ID,
  __resetGlobalTabsForTest,
  addGlobalPluginTab,
  findRemoteWorkspaceAdminTab,
  getActiveGlobalTabId,
  getGlobalTabs,
} from '@/features/right-sidebar/globalTabs';
import { getTabKind, listTabKindMenuMetas } from '@/features/right-sidebar/registry';
import type { TabKindId } from '@/features/right-sidebar/types';
import { useTabCreationMenu } from '@/features/right-sidebar/lib/useTabCreationMenu';
import { __resetTabGroupsForTest, getTabGroup, setTabGroup } from '@/features/right-sidebar/tabGroups';

const m = vi.hoisted(() => ({ rows: new Map<string, { remoteHostId?: string | null }>() }));

// 菜单项文案在这个用例里只用来定位按钮，不验证译法；但 `openSideChatTab` 会连带初始化
// 真实 i18n 实例，所以保留其余导出（只替换 useTranslation）。
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({ useInstalledGhosts: () => [] }));
vi.mock('@/features/bots/botStore', () => ({
  useBotProfiles: () => [],
  canonicalBotSessionId: () => undefined,
}));
vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: {
    subscribe: () => () => {},
    findById: (id: string) => m.rows.get(id) ?? null,
  },
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => [],
}));

/** 把创建菜单摊平成按钮：一个 kind 一个按钮，点击等价于用户在菜单里选中它。 */
function MenuProbe({
  sessionId,
  onSelect,
  groupId,
}: {
  sessionId: string;
  onSelect: (kind: TabKindId) => void;
  groupId?: 'left' | 'right' | 'top' | 'bottom';
}) {
  const menu = useTabCreationMenu({ sessionId, subagentsAvailable: false, onSelect });
  return (
    <>
      {menu.items.map((item) => (
        <button
          key={item.kind}
          type="button"
          data-kind={item.kind}
          data-already-open={item.alreadyOpen ? 'true' : 'false'}
          disabled={item.disabled}
          onClick={() => menu.select(item.kind, { groupId })}
        >
          {item.labelKey}
        </button>
      ))}
    </>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  m.rows = new Map();
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  setDataOwnerGeneration('owner-a', 1);
});

afterEach(() => {
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  window.localStorage.clear();
  cleanup();
  vi.restoreAllMocks();
});

it('registers one remote workspace tab kind and retires the old stream kind', () => {
  const metas = listTabKindMenuMetas().filter((meta) => meta.kind.startsWith('remote-workspace'));
  expect(metas.map((meta) => meta.kind)).toEqual(['remote-workspace-admin']);
  expect(metas[0]).toMatchObject({ enabled: true, singleton: true });
  const plugin = getTabKind('remote-workspace-admin');
  expect(plugin?.menu.hiddenFromMenu).toBeFalsy();
  // 旧「串流」页签 kind 已退役：持久化里若还留着这种行，由右侧栏的遗留页签清理关掉。
  expect(getTabKind('remote-workspace-stream' as TabKindId)).toBeNull();
});

it('opens and focuses the one global tab instead of adding a per-task tab', () => {
  const onSelect = vi.fn();
  render(<MenuProbe sessionId="local-1" onSelect={onSelect} />);
  const item = () =>
    screen.getByRole('button', { name: 'remoteWorkspace.admin.title' }) as HTMLButtonElement;
  expect(item().disabled).toBe(false);
  expect(item().dataset.alreadyOpen).toBe('false');

  fireEvent.click(item());
  // 走全局页签：页签 id 固定、激活位指向它；按任务分桶的通用路径没有被触发。
  expect(findRemoteWorkspaceAdminTab()?.id).toBe(REMOTE_WORKSPACE_ADMIN_TAB_ID);
  expect(getActiveGlobalTabId()).toBe(REMOTE_WORKSPACE_ADMIN_TAB_ID);
  expect(onSelect).not.toHaveBeenCalled();

  // 再选一次：还是同一个页签，菜单改口「已打开」。
  fireEvent.click(item());
  expect(getGlobalTabs().filter((tab) => tab.kind === 'remote-workspace-admin')).toHaveLength(1);
  expect(onSelect).not.toHaveBeenCalled();
});

it('allows opening the page with no task open and keeps it in the requesting tab group', () => {
  const onSelect = vi.fn();
  render(<MenuProbe sessionId="" onSelect={onSelect} groupId="left" />);
  const item = screen.getByRole('button', { name: 'remoteWorkspace.admin.title' }) as HTMLButtonElement;
  // 没有打开任务也能手动加这一页（页面自己显示提示态）。
  expect(item.disabled).toBe(false);
  fireEvent.click(item);
  expect(findRemoteWorkspaceAdminTab()?.id).toBe(REMOTE_WORKSPACE_ADMIN_TAB_ID);
  expect(getTabGroup(REMOTE_WORKSPACE_ADMIN_TAB_ID)).toBe('left');
  expect(onSelect).not.toHaveBeenCalled();
});

it('falls back to the plugin window group when the menu does not say which bar it was', () => {
  // 插件窗口在下方组时，「+」菜单没有带组信息的那条路径应跟随插件页签，而不是硬编码左侧。
  const plugin = addGlobalPluginTab('alpha')!;
  setTabGroup(plugin.id, 'bottom');
  const onSelect = vi.fn();
  render(<MenuProbe sessionId="local-1" onSelect={onSelect} />);
  fireEvent.click(screen.getByRole('button', { name: 'remoteWorkspace.admin.title' }));
  expect(getTabGroup(REMOTE_WORKSPACE_ADMIN_TAB_ID)).toBe('bottom');
  expect(onSelect).not.toHaveBeenCalled();
});
