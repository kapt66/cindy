import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import type { McprStatus } from '../../../shared/mcpr-plugin-capability';
import { GhostMcprSlot, summarizeMcprPreviewOutput, type McprSlotDeps } from '../mcprSlot';

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
    getPluginCapabilityStatus: vi.fn(async (): Promise<McprStatus> => ({
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
  it('summarizes preview response shapes without logging repository paths or commit text', () => {
    const summary = summarizeMcprPreviewOutput({
      changes: [{ path: 'private/runtime-output/', indexStatus: '?', worktreeStatus: '?', kind: 'untracked' }],
      commitSha: 'secret-sha',
      activeTurnCount: 0,
      workspaceBusy: false,
      latestCommit: { sha: 'secret-sha', subject: 'private subject' },
      instance: { id: 'private-instance', name: 'private-name' },
    });

    expect(summary).toMatchObject({
      changesType: 'array', changesCount: 1, invalidChangeCount: 0, trailingSlashPathCount: 1,
      latestCommitType: 'object', instanceType: 'object',
    });
    expect(JSON.stringify(summary)).not.toMatch(/private|secret/);
  });

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

  it('keeps server runtime build routes behind the same manifest and scope gate', async () => {
    const { slot, service } = makeSlot({
      getGhost: () => mcprGhost(['server-runtime.build.start']),
    });
    const response = await slot.handleRequest('mcpr-ghost', {
      operation: 'call',
      request: {
        contractVersion: 1,
        route: 'server-runtime.build.start',
        scope: 'selected-instance',
        input: { instanceId: 'instance-1' },
      },
    });

    expect(response).toMatchObject({
      operation: 'call',
      result: { ok: true, route: 'server-runtime.build.start' },
    });
    expect(service.callPluginCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'server-runtime.build.start',
        input: { instanceId: 'instance-1' },
        scope: 'selected-instance',
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

  it('never exposes the Host-only runtime contract route to plugin calls', async () => {
    const { slot, service } = makeSlot({ getGhost: () => mcprGhost(['server-runtime.build.contract']) });
    const response = await slot.handleRequest('mcpr-ghost', { operation: 'call', request: { contractVersion: 1, route: 'server-runtime.build.contract', input: { instanceId: 'instance-1' } } });
    expect(response).toMatchObject({ operation: 'call', result: { ok: false, code: 'ROUTE_NOT_DECLARED' } });
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

  it('opens the Host MCPRouter login window when configuration is required', async () => {
    const openLoginWindow = vi.fn();
    const { slot, service } = makeSlot({ openLoginWindow });
    service.getPluginCapabilityStatus.mockImplementation(async () => ({
      contractVersion: 1, configured: false, remote: 'unauthenticated', checkedAt: '2026-08-05T00:00:00.000Z',
    }));
    const response = await slot.handleRequest('mcpr-ghost', { operation: 'configure-login' });
    expect(response).toMatchObject({ operation: 'configure-login', result: { outcome: 'failed', code: 'AUTH_REQUIRED' } });
    expect(openLoginWindow).toHaveBeenCalledOnce();
  });

  it('keeps local server lifecycle behind the server runtime manifest permission', async () => {
    const service = { prepare: vi.fn(async () => ({ instanceId: 'instance-1', taskId: 'task-1', runId: 'run-1', status: 'preparing', logs: [] })) };
    const { slot } = makeSlot({
      getGhost: () => mcprGhost(['server-runtime.build.start']),
      getToolCallSessionId: (ghostId, callId) => ghostId === 'mcpr-ghost' && callId === 'tool-call-1' ? 'session-1' : null,
      getLocalServerService: () => ({
        prepare: service.prepare,
        start: vi.fn(), status: vi.fn(), stop: vi.fn(), logs: vi.fn(),
      }),
    });
    const response = await slot.handleRequest('mcpr-ghost', { operation: 'local', input: { action: 'prepare', instanceId: 'instance-1', taskId: 'task-1' } });
    expect(response).toMatchObject({ operation: 'call', result: { ok: true, route: 'local-server' } });
    expect(service.prepare).toHaveBeenCalledWith('instance-1', 'task-1');
  });

  it('delegates config directory selection and stop-all to the Host local server service', async () => {
    const configure = vi.fn(async () => ({ instanceId: 'instance-1', configConfigured: true, prepared: false, programs: [] }));
    const stop = vi.fn(async () => ({ instanceId: 'instance-1', programs: [] }));
    const { slot } = makeSlot({
      getGhost: () => mcprGhost(['server-runtime.build.start']),
      getLocalServerService: () => ({ configure, prepare: vi.fn(), start: vi.fn(), status: vi.fn(), stop, logs: vi.fn() }),
    });

    await expect(slot.handleRequest('mcpr-ghost', { operation: 'local', input: { action: 'configure', instanceId: 'instance-1' } }))
      .resolves.toMatchObject({ operation: 'call', result: { ok: true, route: 'local-server' } });
    await expect(slot.handleRequest('mcpr-ghost', { operation: 'local', input: { action: 'stop-all', instanceId: 'instance-1' } }))
      .resolves.toMatchObject({ operation: 'call', result: { ok: true, route: 'local-server' } });
    expect(configure).toHaveBeenCalledWith('instance-1', undefined, undefined);
    expect(stop).toHaveBeenCalledWith('instance-1');
  });

  it('passes bounded config input values only through the Host-local slot', async () => {
    const configure = vi.fn(async () => ({ instanceId: 'instance-1', configConfigured: true, configInputs: [], prepared: false, programs: [] }));
    const { slot } = makeSlot({
      getGhost: () => mcprGhost(['server-runtime.build.start']),
      getLocalServerService: () => ({ configure, prepare: vi.fn(), start: vi.fn(), status: vi.fn(), stop: vi.fn(), logs: vi.fn() }),
    });

    await expect(slot.handleRequest('mcpr-ghost', {
      operation: 'local', input: { action: 'configure', instanceId: 'instance-1', inputId: 'databaseAddress', value: 'localhost:13000' },
    })).resolves.toMatchObject({ operation: 'call', result: { ok: true, route: 'local-server' } });
    expect(configure).toHaveBeenCalledWith('instance-1', 'databaseAddress', 'localhost:13000');
  });

  it('probes and adopts only Host-validated project config directories', async () => {
    const probeProjectConfig = vi.fn(async () => ({ candidate: { inputId: 'dataTables', label: '配置表位置', relativeDirectory: 'saga2_json' } }));
    const configureProjectConfig = vi.fn(async () => ({ instanceId: 'instance-1', configConfigured: true, configInputs: [], prepared: false, programs: [] }));
    const { slot } = makeSlot({
      getGhost: () => mcprGhost(['server-runtime.build.start']),
      getToolCallSessionId: (ghostId, callId) => ghostId === 'mcpr-ghost' && callId === 'tool-call-1' ? 'session-1' : null,
      getLocalServerService: () => ({
        probeProjectConfig, configureProjectConfig,
        prepare: vi.fn(), start: vi.fn(), status: vi.fn(), stop: vi.fn(), logs: vi.fn(),
      }),
    });

    await expect(slot.handleRequest('mcpr-ghost', {
      operation: 'local', input: { action: 'probe-project-config', instanceId: 'instance-1', toolCallId: 'tool-call-1', inputId: 'dataTables', relativeDirectory: 'saga2_json' },
    })).resolves.toMatchObject({ operation: 'call', result: { ok: true, route: 'local-server' } });
    await expect(slot.handleRequest('mcpr-ghost', {
      operation: 'local', input: { action: 'configure-project-config', instanceId: 'instance-1', toolCallId: 'tool-call-1', inputId: 'dataTables', relativeDirectory: 'saga2_json' },
    })).resolves.toMatchObject({ operation: 'call', result: { ok: true, route: 'local-server' } });
    expect(probeProjectConfig).toHaveBeenCalledWith('instance-1', 'session-1', 'saga2_json', 'dataTables');
    expect(configureProjectConfig).toHaveBeenCalledWith('instance-1', 'session-1', 'saga2_json', 'dataTables');
  });

  it('rejects project config probing without a live tool-call session binding', async () => {
    const probeProjectConfig = vi.fn();
    const { slot } = makeSlot({
      getGhost: () => mcprGhost(['server-runtime.build.start']),
      getToolCallSessionId: () => null,
      getLocalServerService: () => ({
        probeProjectConfig,
        prepare: vi.fn(), start: vi.fn(), status: vi.fn(), stop: vi.fn(), logs: vi.fn(),
      }),
    });

    await expect(slot.handleRequest('mcpr-ghost', {
      operation: 'local', input: { action: 'probe-project-config', instanceId: 'instance-1', toolCallId: 'stale-call', inputId: 'dataTables', relativeDirectory: 'saga2_json' },
    })).resolves.toMatchObject({ operation: 'call', result: { ok: false, code: 'INVALID_INPUT' } });
    expect(probeProjectConfig).not.toHaveBeenCalled();
  });
});
