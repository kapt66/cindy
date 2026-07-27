import { describe, expect, it } from 'vitest';

import { TAB_IDS } from '@/lib/tabLabels';

describe('Settings tab order', () => {
  it('keeps the Meka assistant between model providers and billing', () => {
    const providersIndex = TAB_IDS.indexOf('providers');

    expect(TAB_IDS.slice(providersIndex, providersIndex + 3)).toEqual([
      'providers',
      'meka-assistant',
      'billing',
    ]);
  });
});
