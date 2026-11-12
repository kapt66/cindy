// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  __GHOST_PANEL_PRESENTATION_OVERRIDES_STORAGE_KEY,
  __GHOST_PANEL_PRESENTATION_STORAGE_KEY,
  __resetGhostPanelPresentationPreferenceForTest,
  getGhostPanelPresentationOverride,
  isGhostPanelModalPresentationEnabled,
  resolveGhostPanelPresentation,
  setGhostPanelModalPresentationEnabled,
  setGhostPanelPresentationOverride,
} from '../ghostPanelPresentationPreference';
import type { InstalledGhost } from '../../../shared/ghost';

/** 只带声明的已装实例:resolver 只读 `manifest.panel` 与 `manifest.id`。 */
function ghost(
  id: string,
  panel?: { position?: 'left' | 'right' | 'top' | 'bottom' | 'tab' },
): Pick<InstalledGhost, 'manifest'> {
  return {
    manifest: {
      schemaVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      panel: panel ? { html: 'panel.html', ...panel } : undefined,
    },
  } as Pick<InstalledGhost, 'manifest'>;
}

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

  // T5:有效宿主真值表(§2.4)。生产入口是同一个纯函数,入口/投影/settings 都读它。
  it('resolves the effective host from override → global switch → docked default', () => {
    // 无 panel 声明:恒 docked(与全局开关无关)。
    setGhostPanelModalPresentationEnabled(true);
    expect(resolveGhostPanelPresentation(ghost('no-panel'))).toBe('docked');

    // 停靠形态 + 无任何偏好:跟随全局开关(此处 on → modal)。
    expect(resolveGhostPanelPresentation(ghost('meka-p4', { position: 'left' }))).toBe('modal');

    // 全局关闭 = 未设置:回到 docked 产品默认。
    setGhostPanelModalPresentationEnabled(false);
    expect(resolveGhostPanelPresentation(ghost('meka-p4', { position: 'left' }))).toBe('docked');

    // 插件级 override 压过全局开关(两个方向都要)。
    setGhostPanelModalPresentationEnabled(true);
    setGhostPanelPresentationOverride('meka-p4', 'docked');
    expect(resolveGhostPanelPresentation(ghost('meka-p4', { position: 'left' }))).toBe('docked');
    setGhostPanelModalPresentationEnabled(false);
    setGhostPanelPresentationOverride('meka-p4', 'modal');
    expect(resolveGhostPanelPresentation(ghost('meka-p4', { position: 'left' }))).toBe('modal');

    // 五值里的 right/top/bottom 也是停靠形态,同样受该开关影响。
    setGhostPanelModalPresentationEnabled(true);
    expect(resolveGhostPanelPresentation(ghost('edge', { position: 'right' }))).toBe('modal');
  });

  // `position:'tab'` 由 manifest 固定成插件页宿主:任何偏好都不得把它判成 modal
  // (否则同一实例会出现两个 webview 各存一份插件数据)。
  it('never resolves tab-form panels to modal', () => {
    setGhostPanelModalPresentationEnabled(true);
    setGhostPanelPresentationOverride('tab-plugin', 'modal');
    expect(resolveGhostPanelPresentation(ghost('tab-plugin', { position: 'tab' }))).toBe('docked');
  });

  it('falls back to docked when stored preference data is corrupted', () => {
    localStorage.setItem(__GHOST_PANEL_PRESENTATION_STORAGE_KEY, 'not-json');
    localStorage.setItem(__GHOST_PANEL_PRESENTATION_OVERRIDES_STORAGE_KEY, '[1,2,3]');
    __resetGhostPanelPresentationPreferenceForTest();
    localStorage.setItem(__GHOST_PANEL_PRESENTATION_STORAGE_KEY, 'not-json');
    localStorage.setItem(__GHOST_PANEL_PRESENTATION_OVERRIDES_STORAGE_KEY, '[1,2,3]');
    expect(resolveGhostPanelPresentation(ghost('meka-p4', { position: 'left' }))).toBe('docked');
  });
});
