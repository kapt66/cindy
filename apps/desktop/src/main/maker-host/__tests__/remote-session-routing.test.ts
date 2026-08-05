import { describe, expect, it } from 'vitest';

import { classifyRemoteSessionTransport } from '../remote-session-routing.js';

describe('classifyRemoteSessionTransport', () => {
  it.each([
    [undefined, 'local'],
    [null, 'local'],
    ['', 'local'],
    ['mcpr:', 'mcpr'],
    ['mcpr:instance-1', 'mcpr'],
    ['ssh-host-1', 'ssh'],
  ] as const)('classifies %s as %s', (remoteHostId, expected) => {
    expect(classifyRemoteSessionTransport(remoteHostId)).toBe(expected);
  });
});
