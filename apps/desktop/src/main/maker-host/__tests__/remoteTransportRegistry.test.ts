import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hasRemoteHostTransport,
  hasRemoteTransport,
  listRemoteHostTransports,
  listRemoteTransports,
  registerRemoteHostTransport,
  registerRemoteTransport,
  releaseAllRemoteTransports,
  releaseRemoteHostTransport,
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

/**
 * `psb:` 的 Codex app-server 连接按**隧道身份**复用（Maker 会话可以在同一 PSB 会话上重建
 * runtime），所以它有自己的作用域。两档登记都在同一张诊断表里，会话结束 / 应用退出都走
 * 同一个释放入口 —— 少了任何一档，PSB 侧会一直把这条隧道算成「活动」，牵住 stop / commit。
 */
describe('remote transport registry (host scope)', () => {
  it('registers and releases a host-scoped transport exactly once', async () => {
    const dispose = vi.fn(async () => undefined);
    registerRemoteHostTransport('psb:s1', dispose, 100);
    expect(hasRemoteHostTransport('psb:s1')).toBe(true);
    expect(listRemoteHostTransports()).toEqual([{ hostId: 'psb:s1', openedAt: 100 }]);

    await expect(releaseRemoteHostTransport('psb:s1', 'session-end')).resolves.toBe(true);
    await expect(releaseRemoteHostTransport('psb:s1', 'app-quit')).resolves.toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(hasRemoteHostTransport('psb:s1')).toBe(false);
  });

  it('disposes the previous host transport when the same identity is re-registered', async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    registerRemoteHostTransport('psb:s1', first, 1);
    registerRemoteHostTransport('psb:s1', second, 2);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    expect(listRemoteHostTransports()).toEqual([{ hostId: 'psb:s1', openedAt: 2 }]);
    await releaseRemoteHostTransport('psb:s1', 'session-end');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('releases both scopes on app quit', async () => {
    const sessionDispose = vi.fn(async () => undefined);
    const hostDispose = vi.fn(async () => undefined);
    registerRemoteTransport('local-1', 'mcpr:instance-1', sessionDispose);
    registerRemoteHostTransport('psb:s1', hostDispose);
    await expect(releaseAllRemoteTransports('app-quit')).resolves.toEqual({ sessions: 1, hosts: 1 });
    expect(sessionDispose).toHaveBeenCalledTimes(1);
    expect(hostDispose).toHaveBeenCalledTimes(1);
    expect(listRemoteTransports()).toEqual([]);
    expect(listRemoteHostTransports()).toEqual([]);
  });
});
