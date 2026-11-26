/**
 * Remote agent-transport lifecycle registry.
 *
 * Every remote session (SSH host or `mcpr:<instanceId>`) opens its own transport
 * (an SSH exec channel or an MCPRouter WebSocket) inside
 * `remoteCcQueryFactory`. The agent's `close()` normally disposes it, but a
 * session can leave Maker's active set on a path that never reaches the agent's
 * close (a worker session that finished its turn and was archived, an event loop
 * that ended, a failed abort). When that happens the transport stays open, the
 * MCPRouter runtime keeps counting an active tunnel, and every commit/push/submit
 * on that instance is rejected with `blocked / session-open` until the whole app
 * restarts. It reproduced 2026-10-30: `activeTurnCount` 0 → create worker →
 * archive worker → 1, still 1 twelve hours later.
 *
 * So the transport itself is the source of truth: registration happens when the
 * factory opens it, and any retirement path (agent close, session close hook,
 * worker archive) releases it through the same single-shot entry point.
 */

export interface RemoteTransportEntry {
  hostId: string;
  openedAt: number;
  dispose: () => Promise<void>;
}

export interface RemoteTransportSnapshot {
  sessionId: string;
  hostId: string;
  openedAt: number;
}

/** 按**隧道身份**登记的 transport 快照（`psb:` 的 Codex app-server 连接等）。 */
export interface RemoteHostTransportSnapshot {
  hostId: string;
  openedAt: number;
}

export interface RemoteTransportEvent {
  at: number;
  type:
    | 'register'
    | 'replaced'
    | 'release-start'
    | 'release-done'
    | 'release-error'
    | 'dispose-step'
    | 'kill';
  sessionId: string;
  detail?: string;
}

const transports = new Map<string, RemoteTransportEntry>();
/**
 * 隧道身份 → transport。
 *
 * 为什么需要这一档：`psb:` 的 Codex app-server 连接按**隧道身份**（`psb:<PSB sessionId>`）
 * 复用，而不是按 Maker 会话——Maker 会话可以在同一个 PSB 会话上重建 runtime，但那条长连接
 * 只有一条。它同样会「会话退休但不经过 agent close」地泄漏，而 PSB 侧按会话统计活动隧道
 * （泄漏会让 stop / commit 类动作被牵住），所以两种作用域都必须有登记与释放入口。
 */
const hostTransports = new Map<string, { openedAt: number; dispose: () => Promise<void> }>();
const events: RemoteTransportEvent[] = [];
const MAX_EVENTS = 200;

/** Dev diagnostics: why a transport was opened/released and how far disposal got. */
export function recordRemoteTransportEvent(
  type: RemoteTransportEvent['type'],
  sessionId: string,
  detail?: string,
): void {
  events.push({ at: Date.now(), type, sessionId, ...(detail ? { detail } : {}) });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function listRemoteTransportEvents(): RemoteTransportEvent[] {
  return [...events];
}

let logger: {
  warn(message: string, details?: Record<string, unknown>): void;
} | null = null;

/** Route registry warnings into the desktop maker logger once it exists. */
export function setRemoteTransportLogger(
  next: { warn(message: string, details?: Record<string, unknown>): void } | null,
): void {
  logger = next;
}

export function registerRemoteTransport(
  sessionId: string,
  hostId: string,
  dispose: () => Promise<void>,
  now: number = Date.now(),
): void {
  // A replaced session (runtime refresh / agent switch) may reuse the business
  // id. The old entry is dead weight once the new transport is registered, but we
  // cannot `await` here — fire-and-forget so the stale socket still gets closed.
  const previous = transports.get(sessionId);
  transports.set(sessionId, { hostId, openedAt: now, dispose });
  recordRemoteTransportEvent('register', sessionId, hostId);
  if (previous) {
    recordRemoteTransportEvent('replaced', sessionId, previous.hostId);
    void previous.dispose().catch((error) => {
      logger?.warn('replaced remote transport dispose failed', {
        sessionId,
        hostId: previous.hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

export function hasRemoteTransport(sessionId: string): boolean {
  return transports.has(sessionId);
}

export function listRemoteTransports(): RemoteTransportSnapshot[] {
  return [...transports.entries()].map(([sessionId, entry]) => ({
    sessionId,
    hostId: entry.hostId,
    openedAt: entry.openedAt,
  }));
}

/**
 * 登记一条按**隧道身份**持有的 transport（`psb:` 的 Codex app-server 连接）。
 *
 * 与按会话登记同一纪律：被复用/替换的旧条目必须关掉（fire-and-forget，旧连接不能挂在
 * 一张没人认领的表里），释放入口单一（`releaseRemoteHostTransport`）。
 */
export function registerRemoteHostTransport(
  hostId: string,
  dispose: () => Promise<void>,
  now: number = Date.now(),
): void {
  const previous = hostTransports.get(hostId);
  hostTransports.set(hostId, { openedAt: now, dispose });
  recordRemoteTransportEvent('register', `host:${hostId}`, hostId);
  if (previous) {
    recordRemoteTransportEvent('replaced', `host:${hostId}`, hostId);
    void previous.dispose().catch((error) => {
      logger?.warn('replaced remote host transport dispose failed', {
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

export function hasRemoteHostTransport(hostId: string): boolean {
  return hostTransports.has(hostId);
}

export function listRemoteHostTransports(): RemoteHostTransportSnapshot[] {
  return [...hostTransports.entries()].map(([hostId, entry]) => ({
    hostId,
    openedAt: entry.openedAt,
  }));
}

/**
 * Release the transport owned by a tunnel host identity (`psb:<sessionId>`).
 *
 * 与 `releaseRemoteTransport` 同一单次语义：先移除条目再 dispose，因此 agent close、
 * 会话结束释放、应用退出三条路径都调它时只有第一条真正干活。
 */
export async function releaseRemoteHostTransport(hostId: string, reason: string): Promise<boolean> {
  const entry = hostTransports.get(hostId);
  if (!entry) return false;
  hostTransports.delete(hostId);
  recordRemoteTransportEvent('release-start', `host:${hostId}`, `${hostId}/${reason}`);
  try {
    await entry.dispose();
    recordRemoteTransportEvent('release-done', `host:${hostId}`, hostId);
    return true;
  } catch (error) {
    recordRemoteTransportEvent('release-error', `host:${hostId}`, String((error as Error)?.message ?? error));
    logger?.warn('remote host transport dispose failed', {
      hostId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * 应用退出 / 账号边界：把两种作用域里登记的长连接全部释放。
 *
 * 退出路径不该逐会话推理「哪条还可能活着」——登记表本身就是唯一真源。
 */
export async function releaseAllRemoteTransports(
  reason: string,
): Promise<{ sessions: number; hosts: number }> {
  const sessionIds = [...transports.keys()];
  const hostIds = [...hostTransports.keys()];
  await Promise.allSettled([
    ...sessionIds.map((sessionId) => releaseRemoteTransport(sessionId, reason)),
    ...hostIds.map((hostId) => releaseRemoteHostTransport(hostId, reason)),
  ]);
  return { sessions: sessionIds.length, hosts: hostIds.length };
}

/**
 * Release the transport owned by `sessionId`, if any. Single-shot: the entry is
 * removed before disposal, so agent close, session close and worker archive can
 * all call this and only the first one does the work.
 */
export async function releaseRemoteTransport(sessionId: string, reason: string): Promise<boolean> {
  const entry = transports.get(sessionId);
  if (!entry) return false;
  transports.delete(sessionId);
  recordRemoteTransportEvent('release-start', sessionId, `${entry.hostId}/${reason}`);
  try {
    await entry.dispose();
    recordRemoteTransportEvent('release-done', sessionId, entry.hostId);
    return true;
  } catch (error) {
    recordRemoteTransportEvent('release-error', sessionId, String((error as Error)?.message ?? error));
    logger?.warn('remote transport dispose failed', {
      sessionId,
      hostId: entry.hostId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function resetRemoteTransportRegistryForTests(): void {
  transports.clear();
  hostTransports.clear();
  logger = null;
}
