import { describe, expect, it } from 'vitest';

import { isSettingsTab, TAB_IDS } from '@/lib/tabLabels';

describe('Settings tab order', () => {
  it('keeps the Meka assistant between model providers and billing', () => {
    const providersIndex = TAB_IDS.indexOf('providers');

    expect(TAB_IDS.slice(providersIndex, providersIndex + 3)).toEqual([
      'providers',
      'meka-assistant',
      'billing',
    ]);
  });

  it('keeps Pi extensions inside General instead of exposing a top-level tab', () => {
    expect(TAB_IDS).not.toContain('pi-extensions');
    expect(isSettingsTab('pi-extensions')).toBe(false);
  });

  it('places Plugins immediately before builtin tools', () => {
    const toolsIndex = TAB_IDS.indexOf('builtin-tools');

    expect(TAB_IDS.slice(toolsIndex - 1, toolsIndex + 1)).toEqual(['ghosts', 'builtin-tools']);
  });
});
