import { describe, expect, it } from 'vitest';

import { isMekaP4ConfigComplete } from '../useMekaConfigGate';

describe('Meka P4 configuration gate', () => {
  it('requires both a P4 root and at least one recognized SAGA2 child directory', () => {
    expect(isMekaP4ConfigComplete({ p4RootPath: null, subfolders: [] })).toBe(false);
    expect(isMekaP4ConfigComplete({ p4RootPath: 'C:\\P4', subfolders: [] })).toBe(false);
    expect(
      isMekaP4ConfigComplete({
        p4RootPath: 'C:\\P4',
        subfolders: [{ name: 'saga2_design' }],
      }),
    ).toBe(true);
  });
});
