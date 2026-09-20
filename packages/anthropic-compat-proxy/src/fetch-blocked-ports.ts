/**
 * Fetch 标准 bad port 名单与本仓的 Fetch-safe 端口绑定工具 —— **单一真相源**。
 *
 * 为什么单独成文件：这份名单的消费方不止本包。任何"把 `http://127.0.0.1:<port>` 交给
 * 全局 `fetch`（或任意 undici 实例）"的调用方都必须用同一份判据，而独立成模块可以让
 * 消费方只拉这一小段、不必把整个代理实现一起加载（单测尤其在意这点）。
 *
 * 背景：`server.listen(0)` 只让内核挑"空闲"端口，内核**不判**客户端肯不肯用这个端口。
 * undici 按 Fetch 规范拒绝对一批 bad port 发请求，报
 * `TypeError: fetch failed` + `cause: bad port`。命中后该 URL 上**每个请求都失败**，
 * 表现为整条链路不可用，而不是偶发超时。OS 动态端口段并不保证避开这批端口：Windows
 * 默认段 49152-65535 只含少量，但可被改成 1024-15000 —— 那时段内含 18 个 bad port，
 * `listen(0)` 命中率约 1/777（2026-09-20 在本仓 CI 机器实测）。
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FETCH_BLOCKED_PORTS = new Set<number>([
  0, 1, 7, 9, 11, 13, 15, 17, 19,
  20, 21, 22, 23, 25, 37, 42, 43,
  53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117,
  119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526,
  530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export function isFetchBlockedPort(port: number): boolean {
  return FETCH_BLOCKED_PORTS.has(port);
}

/** `listen(0)` 命中被拉黑端口后重新绑定几次。命中约 1/777，正常一次就成。 */
const FETCH_SAFE_BIND_MAX_ATTEMPTS = 32;

/**
 * 把任意 `http.Server` 绑到 loopback 上一个**全局 fetch 能用**的临时端口，返回端口号。
 *
 * 用于替代裸 `server.listen(0, '127.0.0.1')` / `listen(0, host, cb)`：语义相同，只是当
 * 内核分到 Fetch bad port 时 `close()` 后重新 `listen(0)` 重选。生产代码（远端 MCP
 * bridge）与单测共用本函数，避免各自实现一份端口黑名单或各自遗漏。
 *
 * 抛出时调用方拿不到可用端口 —— 宁可绑定失败，也不要交出一个 fetch 打不通的 URL。
 */
export async function listenOnFetchSafePort(
  server: Server,
  host = '127.0.0.1',
): Promise<number> {
  for (let attempt = 1; attempt <= FETCH_SAFE_BIND_MAX_ATTEMPTS; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, host);
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? (address as AddressInfo).port : 0;
    if (port !== 0 && !isFetchBlockedPort(port)) return port;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  throw new Error(
    `failed to bind a Fetch-safe loopback port after ${FETCH_SAFE_BIND_MAX_ATTEMPTS} attempts`,
  );
}
