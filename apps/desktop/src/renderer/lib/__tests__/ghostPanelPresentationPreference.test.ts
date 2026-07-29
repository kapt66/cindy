// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  __GHOST_PANEL_PRESENTATION_STORAGE_KEY,
  __resetGhostPanelPresentationPreferenceForTest,
  isGhostPanelModalPresentationEnabled,
  setGhostPanelModalPresentationEnabled,
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
});
