import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hasRemoteTransport,
  listRemoteTransports,
  registerRemoteTransport,
  releaseRemoteTransport,
  resetRemoteTransportRegistryForTests,
  setRemoteTransportLogger,
} from '../remoteTransportRegistry';

afterEach(() => {
  resetRemoteTransportRegistryForTests();
});

describe('remote transport registry', () => {
  it('releases the registered transport exactly once', async () => {
    const dispose = vi.fn(async () => undefined);
    registerRemoteTransport('session-1', 'mcpr:instance-1', dispose, 1000);

    expect(hasRemoteTransport('session-1')).toBe(true);
    await expect(releaseRemoteTransport('session-1', 'agent-close')).resolves.toBe(true);
    await expect(releaseRemoteTransport('session-1', 'worker-close')).resolves.toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(hasRemoteTransport('session-1')).toBe(false);
  });

  it('does nothing for a session that never opened a transport', async () => {
    await expect(releaseRemoteTransport('unknown', 'session-close')).resolves.toBe(false);
  });

  it('swallows a dispose failure so a retirement path never throws', async () => {
    const warnings: Array<{ message: string; details?: Record<string, unknown> }> = [];
    setRemoteTransportLogger({
      warn: (message, details) => warnings.push({ message, details }),
    });
    registerRemoteTransport('session-2', 'ssh:host-a', async () => {
      throw new Error('socket already gone');
    });

    await expect(releaseRemoteTransport('session-2', 'session-close')).resolves.toBe(false);
    expect(hasRemoteTransport('session-2')).toBe(false);
    expect(warnings[0]?.message).toBe('remote transport dispose failed');
    expect(warnings[0]?.details).toMatchObject({ sessionId: 'session-2', reason: 'session-close' });
  });

  it('disposes the previous transport when a session id is reused', async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    registerRemoteTransport('session-3', 'mcpr:instance-1', first, 1000);
    registerRemoteTransport('session-3', 'mcpr:instance-2', second, 2000);

    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    expect(listRemoteTransports()).toEqual([
      { sessionId: 'session-3', hostId: 'mcpr:instance-2', openedAt: 2000 },
    ]);

    await releaseRemoteTransport('session-3', 'agent-close');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('exposes a snapshot for diagnostics', () => {
    registerRemoteTransport('a', 'mcpr:x', async () => undefined, 1);
    registerRemoteTransport('b', 'ssh:y', async () => undefined, 2);
    expect(listRemoteTransports()).toEqual([
      { sessionId: 'a', hostId: 'mcpr:x', openedAt: 1 },
      { sessionId: 'b', hostId: 'ssh:y', openedAt: 2 },
    ]);
  });
});
