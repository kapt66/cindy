import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  FETCH_SAFE_BIND_MAX_ATTEMPTS,
  FetchSafePortBindError,
  isFetchBlockedPort,
  listenOnFetchSafePort,
} from './fetch-blocked-ports.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

/**
 * 假 server：按脚本顺序返回内核"分配"的端口，记录 bind/close 次数。
 * 用来确定性地复现"内核分到 Fetch bad port"（真实 listen(0) 只有约 1/735 概率命中，
 * 不能拿概率当断言）。
 */
function scriptedServer(ports: number[]): {
  server: Server;
  listenCalls: () => number;
  closedPorts: number[];
} {
  const server = new EventEmitter() as unknown as Server;
  const closedPorts: number[] = [];
  let assigned = 0;
  let current = 0;
  let listening = false;
  server.listen = (() => {
    current = ports[Math.min(assigned, ports.length - 1)];
    assigned += 1;
    listening = true;
    queueMicrotask(() => server.emit('listening'));
    return server;
  }) as Server['listen'];
  server.close = ((callback?: (error?: Error) => void) => {
    if (listening) {
      listening = false;
      closedPorts.push(current);
    }
    queueMicrotask(() => callback?.());
    return server;
  }) as Server['close'];
  server.address = (() =>
    listening ? { address: '127.0.0.1', family: 'IPv4', port: current } : null) as Server['address'];
  return { server, listenCalls: () => assigned, closedPorts };
}

describe('fetch blocked ports', () => {
  it('covers the Fetch-standard bad ports that appear in low dynamic ranges', () => {
    // 名单存在本身是契约的一部分：Windows 动态端口段可被压到 1024-15000，这一段里
    // 就有下面这些 bad port；漏一个就多一份 `listen(0)` 命中后整条链路不可用的概率。
    for (const port of [989, 990, 993, 995, 3659, 4045, 4190, 5060, 5061, 6000, 10080,
                        6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]) {
      expect(isFetchBlockedPort(port), `port ${port} must be blocked`).toBe(true);
    }
    // 相邻的普通端口不能被误判，否则会把可用端口当坏端口空转。
    for (const port of [6001, 6063, 6565, 6567, 6670, 6698, 10081, 49152]) {
      expect(isFetchBlockedPort(port), `port ${port} must not be blocked`).toBe(false);
    }
  });

  it('binds a loopback port that fetch can actually use', async () => {
    const server = createServer((_request, response) => response.end('ok'));
    servers.push(server);

    const port = await listenOnFetchSafePort(server);

    expect(port).toBeGreaterThan(0);
    expect(isFetchBlockedPort(port)).toBe(false);
    expect((server.address() as AddressInfo).port).toBe(port);
    // 真正的验收：这个 URL 上的一次 fetch 必须成功 —— 这正是修 bad port 要保的能力。
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('rebinds when the network stack assigns a Fetch-blocked port and closes the rejected listener', async () => {
    // 首次 6000 是真实的 Fetch bad port（Chromium/undici 都会拒），第二次才可用。
    const fake = scriptedServer([6000, 43210]);

    const port = await listenOnFetchSafePort(fake.server);

    expect(port).toBe(43210);
    expect(fake.listenCalls()).toBe(2);
    // 被拒的那次绑定要 close 掉：既不能把坏端口交给调用方，也不能把 socket 留在 listener 上。
    expect(fake.closedPorts).toEqual([6000]);
    expect((fake.server.address() as AddressInfo).port).toBe(43210);
  });

  it('fails with a structured error instead of handing out a blocked URL when every attempt is bad', async () => {
    const fake = scriptedServer([10080]);

    const error = await listenOnFetchSafePort(fake.server).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FetchSafePortBindError);
    expect(error).toMatchObject({
      code: 'FETCH_SAFE_PORT_UNAVAILABLE',
      attempts: FETCH_SAFE_BIND_MAX_ATTEMPTS,
      lastPort: 10080,
    });
    // 结构化错误要带得出尝试次数与最后端口，日志/排查不依赖解析文案。
    expect(FETCH_SAFE_BIND_MAX_ATTEMPTS).toBe(32);
    expect(fake.listenCalls()).toBe(FETCH_SAFE_BIND_MAX_ATTEMPTS);
    // 每次重选前的 listener 都已关闭，失败路径不泄漏 socket。
    expect(fake.closedPorts).toHaveLength(FETCH_SAFE_BIND_MAX_ATTEMPTS);
  });
});
