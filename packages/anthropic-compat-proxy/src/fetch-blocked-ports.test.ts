import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
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

describe('fetch blocked ports', () => {
  it('covers the Fetch-standard bad ports that appear in low dynamic ranges', () => {
    // 名单存在本身是契约的一部分：Windows 动态端口段可被压到 1024-15000，这一段里
    // 就有下面这些 bad port；漏一个就多一份 `listen(0)` 命中后整条链路不可用的概率。
    for (const port of [989, 990, 993, 995, 3659, 4045, 4190, 5060, 5061, 10080,
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
});
