import { describe, expect, it } from 'vitest';

import { compareAppVersions } from '../updateVersion';

describe('compareAppVersions', () => {
  it.each([
    ['1.2.3', '1.2.3', 0],
    ['1.2.4', '1.2.3', 1],
    ['2.0.0', '10.0.0', -8],
    ['1.0.0', '1.0.0-rc.1', 1],
    ['1.0.0-rc.2', '1.0.0-rc.10', -8],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0+build.2', '1.0.0+build.1', 0],
    ['999999999999999999999.0.0', '999999999999999999998.0.0', 1],
  ])('compares %s with %s', (left, right, expectedSign) => {
    expect(Math.sign(compareAppVersions(left, right) ?? Number.NaN)).toBe(Math.sign(expectedSign));
  });

  it.each(['1.2', '01.2.3', '1.0.0-rc.01', 'v1.2.3', '', 'latest'])(
    'rejects invalid version %s',
    (value) => {
      expect(compareAppVersions(value, '1.0.0')).toBeNull();
      expect(compareAppVersions('1.0.0', value)).toBeNull();
    },
  );
});
