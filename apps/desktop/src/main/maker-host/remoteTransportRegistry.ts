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
  logger = null;
}
