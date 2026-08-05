import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import { GhostMcprSlot, type McprSlotDeps } from '../mcprSlot';

function mcprGhost(routes = ['other-configs.get']): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'mcpr-ghost',
      name: 'MCPR Ghost',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['mcpr'],
      mcpr: { routes },
    },
    dir: '/fake/mcpr-ghost',
    enabled: true,
  } as InstalledGhost;
}

function makeSlot(overrides: Partial<McprSlotDeps> = {}) {
  const service = {
    getPluginCapabilityStatus: vi.fn(async () => ({
      contractVersion: 1 as const,
      configured: true,
      remote: 'authenticated' as const,
      checkedAt: '2026-08-05T00:00:00.000Z',
    })),
    callPluginCapability: vi.fn(async (request) => ({
      ok: true as const,
      contractVersion: 1 as const,
      route: request.route,
      output: { content: 'value' },
      requestId: 'router-request',
    })),
  };
  const deps: McprSlotDeps = {
    getGhost: () => mcprGhost(),
    getService: () => service,
    ...overrides,
  };
  return { slot: new GhostMcprSlot(deps), service };
}

describe('GhostMcprSlot', () => {
  it('calls only a route declared by the installed manifest', async () => {
    const { slot, service } = makeSlot();
    const response = await slot.handleRequest('mcpr-ghost', {
      operation: 'call',
      request: {
        contractVersion: 1,
        route: 'other-configs.get',
        scope: 'account',
        input: { ownerUsername: 'alice', name: 'demo' },
      },
    });

    expect(response).toMatchObject({
      operation: 'call',
      result: { ok: true, route: 'other-configs.get' },
    });
    expect(service.callPluginCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'other-configs.get',
        input: { ownerUsername: 'alice', name: 'demo' },
      }),
    );
  });

  it('rejects undeclared routes before contacting MCPRouter', async () => {
    const { slot, service } = makeSlot();
    const response = await slot.handleRequest('mcpr-ghost', {
      operation: 'call',
      request: { contractVersion: 1, route: 'other-configs.delete', input: {} },
    });

    expect(response).toMatchObject({
      operation: 'call',
      result: { ok: false, code: 'ROUTE_NOT_DECLARED' },
    });
    expect(service.callPluginCapability).not.toHaveBeenCalled();
  });

  it('reports the real remote session state without exposing credentials', async () => {
    const { slot } = makeSlot();
    await expect(slot.handleRequest('mcpr-ghost', { operation: 'status' })).resolves.toEqual({
      operation: 'status',
      status: {
        contractVersion: 1,
        configured: true,
        remote: 'authenticated',
        checkedAt: '2026-08-05T00:00:00.000Z',
      },
    });
  });
});
