// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetGhostPanelPresentationPreferenceForTest,
  setGhostPanelModalPresentationEnabled,
  setGhostPanelPresentationOverride,
} from '@/lib/ghostPanelPresentationPreference';
import {
  __resetGlobalTabsForTest,
  addGlobalPluginTab,
  getGlobalTabs,
  getGlobalTabsSnapshot,
  removeGlobalTab,
  setGlobalPanelAutoTabEnabled,
} from '@/features/right-sidebar/globalTabs';
import {
  __resetSidebarTabWindowsStateForTest,
  __setSidebarTabWindowsStateForTest,
  isTabPoppedOut,
} from '@/lib/sidebarTabWindowState';
import { syncPanelTabProjection, applyGhostPanelPresentationChange } from '../panelTabProjection';
import type { InstalledGhost } from '../../../../../shared/ghost';

/**
 * 页签投影收敛:让「有效 modal」的实例没有承载 panel 页的全局页签,且不污染 dismissed
 * 记忆;切回 docked 时页签回来、dismissed 被清。Tier: unit。
 */

function ghost(
  id: string,
  panel: { position?: 'left' | 'right' | 'top' | 'bottom' | 'tab'; mainView?: boolean } = {},
): InstalledGhost {
  return {
    enabled: true,
    dir: `/brain/_ns/_root/${id}`,
    instanceKey: `_root__${id}`,
    namespace: null,
    namespaceState: 'confirmed',
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    manifest: {
      schemaVersion: 3,
      id,
      name: id,
      version: '1.0.0',
      entry: 'main.js',
      slots: ['panel'],
      ...(panel.mainView ? { mainView: { title: id, html: 'main.html' } } : {}),
      ...(panel.position
        ? { panel: { title: id, html: 'panel.html', position: panel.position } }
        : {}),
    },
  } as unknown as InstalledGhost;
}

const instanceIdFor = (id: string) => `_root__${id}`;
const panelTabId = (id: string) => `g_${instanceIdFor(id)}`;

beforeEach(() => {
  window.localStorage.clear();
  __resetGlobalTabsForTest();
  __resetGhostPanelPresentationPreferenceForTest();
  __resetSidebarTabWindowsStateForTest();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      appVersion: '0.0.0-test',
      sidebarTabWindow: { closeForTab: vi.fn(async () => ({ ok: true })) },
    },
  });
});

afterEach(() => {
  __resetGhostPanelPresentationPreferenceForTest();
  __resetGlobalTabsForTest();
  __resetSidebarTabWindowsStateForTest();
  Reflect.deleteProperty(window, 'electronAPI');
});

// T1:只跑上游 reconcile 会加页签;Meka 投影必须把它摘掉且**不记 dismissed**。
it('removes the panel tab of a modal instance without recording a dismissal', () => {
  const p4 = ghost('meka-p4', { position: 'left' });
  setGhostPanelModalPresentationEnabled(true);

  syncPanelTabProjection([p4]);

  expect(getGlobalTabs().some((tab) => tab.id === panelTabId('meka-p4'))).toBe(false);
  expect(getGlobalTabsSnapshot().dismissedInstanceIds).not.toContain(instanceIdFor('meka-p4'));
});

// T2:modal → docked 切换后页签回来、落在声明的边,且 dismissed 被清。
it('restores the tab on the declared edge after switching back to docked', () => {
  const p4 = ghost('meka-p4', { position: 'left' });
  setGhostPanelModalPresentationEnabled(true);
  syncPanelTabProjection([p4]);
  expect(getGlobalTabs().some((tab) => tab.id === panelTabId('meka-p4'))).toBe(false);

  setGhostPanelPresentationOverride('meka-p4', 'docked');
  applyGhostPanelPresentationChange(p4);

  const tab = getGlobalTabs().find((candidate) => candidate.id === panelTabId('meka-p4'));
  expect(tab).toBeDefined();
  expect((tab?.state as { view?: string } | null)?.view).toBe('panel');
  expect(getGlobalTabsSnapshot().dismissedInstanceIds).not.toContain(instanceIdFor('meka-p4'));
});

// 关页签 = 用户关过(dismissed)。切 docked 必须把这条记忆清掉,否则「切回来了但面板不出来」。
it('clears the dismissal recorded by closing the tab when returning to docked', () => {
  const p4 = ghost('meka-p4', { position: 'left' });
  // 走真实生产路径:先有页签,用户点 X 关闭(上游 removeGlobalTab)写 dismissed。
  addGlobalPluginTab(instanceIdFor('meka-p4'), { ghost: p4, view: 'panel' });
  removeGlobalTab(panelTabId('meka-p4'));
  expect(getGlobalTabsSnapshot().dismissedInstanceIds).toContain(instanceIdFor('meka-p4'));

  applyGhostPanelPresentationChange(p4);

  expect(getGlobalTabsSnapshot().dismissedInstanceIds).not.toContain(instanceIdFor('meka-p4'));
  expect(getGlobalTabs().some((tab) => tab.id === panelTabId('meka-p4'))).toBe(true);
});

// T4:同实例同时声明 mainView 与 panel:modal 时只摘 panel 页页签,mainView 页签保留。
it('keeps the mainView tab while removing the panel tab of the same instance', () => {
  const both = ghost('dual-view', { position: 'left', mainView: true });
  addGlobalPluginTab(instanceIdFor('dual-view'), { ghost: both, view: 'main' });
  expect(getGlobalTabs()).toHaveLength(1);

  setGhostPanelModalPresentationEnabled(true);
  syncPanelTabProjection([both]);

  const tabs = getGlobalTabs();
  expect(tabs).toHaveLength(1);
  expect((tabs[0]?.state as { view?: string } | null)?.view).toBe('main');
});

// T3:页签正弹在独立窗口里时,切 modal 必须把窗口一并收掉(Modal 没有窗口承载)。
it('closes a popped-out sidebar tab window when switching to modal', async () => {
  const p4 = ghost('meka-p4', { position: 'left' });
  addGlobalPluginTab(instanceIdFor('meka-p4'), { ghost: p4, view: 'panel' });
  __setSidebarTabWindowsStateForTest({
    [panelTabId('meka-p4')]: { windowId: 'w1', sessionId: null, open: true },
  });
  expect(isTabPoppedOut(panelTabId('meka-p4'))).toBe(true);

  setGlobalPanelAutoTabEnabled(instanceIdFor('meka-p4'), false, p4);

  expect(getGlobalTabs().some((tab) => tab.id === panelTabId('meka-p4'))).toBe(false);
  const closeForTab = (
    window as unknown as { electronAPI: { sidebarTabWindow: { closeForTab: () => unknown } } }
  ).electronAPI.sidebarTabWindow.closeForTab;
  await vi.waitFor(() => expect(closeForTab).toHaveBeenCalled());
});

// tab 形态与无面板插件不参与投影:它们本来就不该有停靠页签。
it('leaves tab-form and panel-less plugins untouched', () => {
  const tabPlugin = ghost('tab-plugin', { position: 'tab' });
  const noPanel = ghost('no-panel');

  setGhostPanelModalPresentationEnabled(true);
  syncPanelTabProjection([tabPlugin, noPanel]);

  expect(getGlobalTabs()).toHaveLength(0);
  expect(getGlobalTabsSnapshot().dismissedInstanceIds).toHaveLength(0);
});
