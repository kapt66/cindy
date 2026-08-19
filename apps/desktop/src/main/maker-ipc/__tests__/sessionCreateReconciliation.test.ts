import { describe, expect, it, vi } from 'vitest';

import { reconcileCreateOptsFromPersistedSession } from '../sessionCreateReconciliation';

describe('persisted session create-option reconciliation', () => {
  it('fails closed when recovery cannot read the authoritative row', async () => {
    const busy = new Error('SQLITE_BUSY');
    const applyRow = vi.fn();

    await expect(reconcileCreateOptsFromPersistedSession({
      sessionId: 'session-1',
      requirePersistedSession: true,
      readRow: vi.fn(async () => { throw busy; }),
      applyRow,
    })).rejects.toBe(busy);
    expect(applyRow).not.toHaveBeenCalled();
  });

  it('fails closed when the persisted recovery row is missing', async () => {
    await expect(reconcileCreateOptsFromPersistedSession({
      sessionId: 'session-1',
      requirePersistedSession: true,
      readRow: vi.fn(async () => null),
      applyRow: vi.fn(),
    })).rejects.toThrow('session session-1 row missing during lazy create reconciliation');
  });

  it('allows a fresh create to continue when no persisted row exists', async () => {
    const applyRow = vi.fn();
    await expect(reconcileCreateOptsFromPersistedSession({
      sessionId: 'session-new',
      failClosedOnReadError: true,
      readRow: vi.fn(async () => null),
      applyRow,
    })).resolves.toBeUndefined();
    expect(applyRow).not.toHaveBeenCalled();
  });

  it('allows a fresh create to have no row yet', async () => {
    await expect(reconcileCreateOptsFromPersistedSession({
      sessionId: 'session-new',
      readRow: vi.fn(async () => null),
      applyRow: vi.fn(),
    })).resolves.toBeUndefined();
  });
});
