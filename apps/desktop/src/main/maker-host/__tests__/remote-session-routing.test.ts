import { describe, expect, it } from 'vitest';

import {
  classifyRemoteSessionTransport,
  resolveRemoteCodexCredentialMode,
} from '../remote-session-routing.js';

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

describe('resolveRemoteCodexCredentialMode', () => {
  it.each([
    ['mcpr:', 'gateway-key'],
    ['mcpr:instance-1', 'gateway-key'],
    ['ssh-host-1', undefined],
  ] as const)('maps %s to %s', (remoteHostId, expected) => {
    expect(resolveRemoteCodexCredentialMode(remoteHostId)).toBe(expected);
  });
});
