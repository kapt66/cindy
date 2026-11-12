// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetGhostPanelPresentationPreferenceForTest,
  getGhostPanelPresentationOverride,
  setGhostPanelModalPresentationEnabled,
} from '../lib/ghostPanelPresentationPreference';
import {
  __resetGlobalTabsForTest,
  getGlobalTabs,
} from '../features/right-sidebar/globalTabs';
import { PluginPanelPresentationPreference } from '../features/plugin/PluginPanelPresentationPreference';
import type { InstalledGhost } from '../../shared/ghost';

import { vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const ghost = (id: string): InstalledGhost => ({
  enabled: true,
  dir: `/plugins/${id}`,
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  manifest: {
    schemaVersion: 2,
    id,
    name: id,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['panel'],
    panel: { title: id, html: 'panel.html', position: 'left', allowUserPresentationOverride: true },
  },
});

beforeEach(() => {
  __resetGlobalTabsForTest();
  __resetGhostPanelPresentationPreferenceForTest();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    appVersion: '0.0.0-test',
    sidebarTabWindow: { closeForTab: async () => ({ ok: true }) },
  };
});

afterEach(() => {
  cleanup();
  __resetGhostPanelPresentationPreferenceForTest();
  __resetGlobalTabsForTest();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('PluginPanelPresentationPreference', () => {
  // 生产入口:用户在三态选择器里选值 → 偏好落盘 → 页签投影按新有效值收敛。
  it('stores a per-Plugin choice and can return to the global default', () => {
    setGhostPanelModalPresentationEnabled(true);
    render(<PluginPanelPresentationPreference ghostId="meka-p4" />);
    const select = screen.getByRole('combobox', {
      name: 'settings.ghosts.detail.panelPresentation.aria',
    });

    fireEvent.change(select, { target: { value: 'docked' } });
    expect(getGhostPanelPresentationOverride('meka-p4')).toBe('docked');

    fireEvent.change(select, { target: { value: 'inherit' } });
    expect(getGhostPanelPresentationOverride('meka-p4')).toBe('inherit');
  });

  it('keeps the preference on the logical id while projecting the physical instance tab', () => {
    const instance = {
      ...ghost('meka-p4'),
      dir: '/brain/_ns/_root/meka-p4',
      instanceKey: '_root__meka-p4',
      namespace: null,
      namespaceState: 'confirmed' as const,
    };
    render(
      <PluginPanelPresentationPreference
        ghostId="meka-p4"
        instanceId="_root__meka-p4"
        ghost={instance}
      />,
    );

    fireEvent.change(
      screen.getByRole('combobox', { name: 'settings.ghosts.detail.panelPresentation.aria' }),
      { target: { value: 'docked' } },
    );

    // 偏好按逻辑 id 存（`_root__meka-p4` 会被 store 的 isValidGhostId 直接拒掉）；
    // 页签按物理实例键收敛：docked 时该实例的 page 页签应当补回（并清 dismissed）。
    expect(getGhostPanelPresentationOverride('meka-p4')).toBe('docked');
    expect(getGhostPanelPresentationOverride('_root__meka-p4')).toBe('inherit');
    expect(getGlobalTabs().some((tab) => tab.id === 'g__root__meka-p4')).toBe(true);
  });

  // I3:选 modal 只摘页签、不写 dismissed；关 Modal 不是用户关过页签。
  it('removes the panel tab without recording a dismissal when switching to modal', () => {
    const instance = ghost('meka-p4');
    render(
      <PluginPanelPresentationPreference ghostId="meka-p4" instanceId="meka-p4" ghost={instance} />,
    );
    const select = screen.getByRole('combobox', {
      name: 'settings.ghosts.detail.panelPresentation.aria',
    });

    fireEvent.change(select, { target: { value: 'docked' } });
    expect(getGlobalTabs().some((tab) => tab.id === 'g_meka-p4')).toBe(true);

    fireEvent.change(select, { target: { value: 'modal' } });
    expect(getGlobalTabs().some((tab) => tab.id === 'g_meka-p4')).toBe(false);
    const stored = window.localStorage.getItem('xdt:rightSidebarGlobalTabs:v1:guest');
    expect(stored ?? '').not.toContain('meka-p4');
  });
});
