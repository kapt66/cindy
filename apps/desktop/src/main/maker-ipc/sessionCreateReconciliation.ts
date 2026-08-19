export interface PersistedSessionReconciliationOptions<TRow> {
  sessionId: string;
  requirePersistedSession?: boolean;
  failClosedOnReadError?: boolean;
  readRow(): Promise<TRow | null | undefined>;
  applyRow(row: TRow): Promise<void> | void;
  onRequiredFailure?(error: unknown): void;
}

/**
 * Runs create-option reconciliation with different semantics for a fresh create
 * and an existing-session lazy bootstrap. Recovery must fail closed: stale queued
 * options are not safe when the authoritative row cannot be read.
 */
export async function reconcileCreateOptsFromPersistedSession<TRow>(
  options: PersistedSessionReconciliationOptions<TRow>,
): Promise<void> {
  try {
    const row = await options.readRow();
    if (!row) {
      if (options.requirePersistedSession) {
        throw new Error(
          `session ${options.sessionId} row missing during lazy create reconciliation`,
        );
      }
      return;
    }
    await options.applyRow(row);
  } catch (error) {
    if (options.requirePersistedSession || options.failClosedOnReadError) {
      options.onRequiredFailure?.(error);
      throw error;
    }
  }
}
