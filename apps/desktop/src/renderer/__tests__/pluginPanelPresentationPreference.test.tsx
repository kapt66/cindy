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
});
