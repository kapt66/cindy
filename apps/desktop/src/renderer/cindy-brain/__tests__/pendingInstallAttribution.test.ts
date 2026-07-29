import { describe, expect, it, vi } from 'vitest';

import { createPendingInstallAttribution } from '../pendingInstallAttribution';

describe('pending install channel attribution', () => {
  it('records an explicitly carried Meka channel after install succeeds', async () => {
    const markLocalInstall = vi.fn(async () => ({ ok: true }));
    const onInstalled = createPendingInstallAttribution('meka', 'owner-1', markLocalInstall);

    await onInstalled?.({
      manifest: { id: 'meka-flow-check' },
    } as never);

    expect(markLocalInstall).toHaveBeenCalledWith('meka-flow-check', 'owner-1');
  });

  it('does not infer Meka attribution for an ordinary pending install', () => {
    expect(
      createPendingInstallAttribution(
        null,
        'owner-1',
        vi.fn(async () => ({ ok: true })),
      ),
    ).toBeUndefined();
  });
});
