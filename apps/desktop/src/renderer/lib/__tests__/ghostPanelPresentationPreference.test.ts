// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  __GHOST_PANEL_PRESENTATION_OVERRIDES_STORAGE_KEY,
  __GHOST_PANEL_PRESENTATION_STORAGE_KEY,
  __resetGhostPanelPresentationPreferenceForTest,
  getGhostPanelPresentationOverride,
  isGhostPanelModalPresentationEnabled,
  setGhostPanelModalPresentationEnabled,
  setGhostPanelPresentationOverride,
} from '../ghostPanelPresentationPreference';

afterEach(() => {
  __resetGhostPanelPresentationPreferenceForTest();
});

describe('ghostPanelPresentationPreference', () => {
  it('defaults to the existing docked presentation without persisting a snapshot', () => {
    expect(isGhostPanelModalPresentationEnabled()).toBe(false);
    expect(localStorage.getItem(__GHOST_PANEL_PRESENTATION_STORAGE_KEY)).toBeNull();
  });

  it('persists only the explicit modal override and removes it when returning to default', () => {
    setGhostPanelModalPresentationEnabled(true);
    expect(isGhostPanelModalPresentationEnabled()).toBe(true);
    expect(localStorage.getItem(__GHOST_PANEL_PRESENTATION_STORAGE_KEY)).toBe('true');

    setGhostPanelModalPresentationEnabled(false);
    expect(isGhostPanelModalPresentationEnabled()).toBe(false);
    expect(localStorage.getItem(__GHOST_PANEL_PRESENTATION_STORAGE_KEY)).toBeNull();
  });

  it('fails closed to the docked default when stored data is invalid', () => {
    localStorage.setItem(__GHOST_PANEL_PRESENTATION_STORAGE_KEY, '{"modal":"yes"}');
    expect(isGhostPanelModalPresentationEnabled()).toBe(false);
  });

  it('follows the same preference when another renderer window changes storage', () => {
    expect(isGhostPanelModalPresentationEnabled()).toBe(false);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: __GHOST_PANEL_PRESENTATION_STORAGE_KEY,
        newValue: 'true',
      }),
    );
    expect(isGhostPanelModalPresentationEnabled()).toBe(true);
  });

  it('resolves a per-Plugin override before the global default', () => {
    setGhostPanelPresentationOverride('meka-p4', 'modal');
    expect(getGhostPanelPresentationOverride('meka-p4')).toBe('modal');
    expect(isGhostPanelModalPresentationEnabled('meka-p4')).toBe(true);
    expect(isGhostPanelModalPresentationEnabled('another-plugin')).toBe(false);

    setGhostPanelModalPresentationEnabled(true);
    setGhostPanelPresentationOverride('meka-p4', 'docked');
    expect(isGhostPanelModalPresentationEnabled('meka-p4')).toBe(false);
    expect(isGhostPanelModalPresentationEnabled('another-plugin')).toBe(true);
  });

  it('removes the per-Plugin entry when returning to inherit', () => {
    setGhostPanelPresentationOverride('meka-p4', 'modal');
    expect(localStorage.getItem(__GHOST_PANEL_PRESENTATION_OVERRIDES_STORAGE_KEY)).toBe(
      '{"meka-p4":"modal"}',
    );

    setGhostPanelPresentationOverride('meka-p4', 'inherit');

    expect(getGhostPanelPresentationOverride('meka-p4')).toBe('inherit');
    expect(localStorage.getItem(__GHOST_PANEL_PRESENTATION_OVERRIDES_STORAGE_KEY)).toBeNull();
  });

  it('drops invalid stored Plugin IDs and presentation values', () => {
    localStorage.setItem(
      __GHOST_PANEL_PRESENTATION_OVERRIDES_STORAGE_KEY,
      JSON.stringify({
        'meka-p4': 'modal',
        '../escape': 'modal',
        other: 'floating',
      }),
    );

    expect(getGhostPanelPresentationOverride('meka-p4')).toBe('modal');
    expect(getGhostPanelPresentationOverride('other')).toBe('inherit');
  });
});
