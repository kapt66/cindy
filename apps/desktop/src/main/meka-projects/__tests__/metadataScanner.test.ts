import { describe, expect, it } from 'vitest';

import { inferMekaSubProjectPath } from '../metadataScanner';

describe('inferMekaSubProjectPath', () => {
  it('uses the closest Perforce owner', () => {
    const files = [
      '.p4ignore',
      'game/.p4ignore',
      'game/client/.p4ignore',
      'game/client/AGENTS.md',
    ];
    expect(inferMekaSubProjectPath('game/client/AGENTS.md', files)).toBe('game/client');
  });

  it('returns null outside a Perforce workspace', () => {
    expect(inferMekaSubProjectPath('packages/app/AGENTS.md', ['packages/app/AGENTS.md']))
      .toBeNull();
  });
});
