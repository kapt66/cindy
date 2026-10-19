// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetGhostPanelPresentationPreferenceForTest,
  getGhostPanelPresentationOverride,
  setGhostPanelModalPresentationEnabled,
} from '../lib/ghostPanelPresentationPreference';
import { PluginPanelPresentationPreference } from '../features/plugin/PluginPanelPresentationPreference';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  __resetGhostPanelPresentationPreferenceForTest();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('PluginPanelPresentationPreference', () => {
  it('stores a per-Plugin choice and can return to the global default', () => {
    const setDetached = vi.fn(async () => undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      ghostPanelWindow: { setDetached },
    };
    setGhostPanelModalPresentationEnabled(true);
    render(<PluginPanelPresentationPreference ghostId="meka-p4" />);
    const select = screen.getByRole('combobox', {
      name: 'settings.ghosts.detail.panelPresentation.aria',
    });

    fireEvent.change(select, { target: { value: 'docked' } });
    expect(getGhostPanelPresentationOverride('meka-p4')).toBe('docked');
    expect(setDetached).toHaveBeenLastCalledWith('meka-p4', false);

    fireEvent.change(select, { target: { value: 'inherit' } });
    expect(getGhostPanelPresentationOverride('meka-p4')).toBe('inherit');
  });

  it('keeps the preference on the logical id while resetting the physical instance host', () => {
    const setDetached = vi.fn(async () => undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      ghostPanelWindow: { setDetached },
    };
    render(<PluginPanelPresentationPreference ghostId="meka-p4" instanceId="_root__meka-p4" />);

    fireEvent.change(
      screen.getByRole('combobox', { name: 'settings.ghosts.detail.panelPresentation.aria' }),
      { target: { value: 'docked' } },
    );

    // 偏好按逻辑 id 存（`_root__meka-p4` 会被 store 的 isValidGhostId 直接拒掉）；
    // 分离窗口 / 气泡按物理实例键收，否则新布局安装的窗口关不掉。
    expect(getGhostPanelPresentationOverride('meka-p4')).toBe('docked');
    expect(getGhostPanelPresentationOverride('_root__meka-p4')).toBe('inherit');
    expect(setDetached).toHaveBeenLastCalledWith('_root__meka-p4', false);
  });
});
