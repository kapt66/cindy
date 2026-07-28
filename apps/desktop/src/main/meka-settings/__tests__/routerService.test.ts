import { describe, expect, it, vi } from 'vitest';

import { createMekaRouterService, type MekaSecretVault } from '../routerService';
import type { MekaRouterClient } from '../routerClient';
import { DEFAULT_MEKA_MCPROUTER_URL } from '../config';

function setup(initial: Record<string, unknown> = {}) {
  let persisted = `${JSON.stringify(initial)}\n`;
  const temporary = new Map<string, string>();
  const secrets = new Map<string, string>();
  const vault: MekaSecretVault = {
    read: (key) => secrets.get(key) ?? null,
    store: (key, value) => {
      secrets.set(key, value);
    },
    remove: (key) => {
      secrets.delete(key);
    },
  };
  const client = {
    normalizeBaseUrl: vi.fn((url: string) => url.replace(/\/+$/, '')),
    normalizeMcpEndpointUrl: vi.fn((url: string) => url.trim().replace(/#.*$/, '')),
    login: vi.fn(async () => 'session-token'),
    ensureClientKey: vi.fn(async () => 'client-key'),
    logout: vi.fn(async () => undefined),
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => ({ content: [] })),
    listRoutes: vi.fn(async () => []),
    setRoute: vi.fn(async () => undefined),
    discover: vi.fn(async () => undefined),
    deleteEndpointRoutes: vi.fn(async () => undefined),
    listInstances: vi.fn(async () => []),
    listTemplates: vi.fn(async () => []),
    findOrCreateInstance: vi.fn(async () => ({})),
  } as unknown as MekaRouterClient;
  const service = createMekaRouterService({
    configPath: 'C:\\userData\\meka-assistant-settings.json',
    vault,
    client,
    readFile: async () => persisted,
    writeFile: async (filePath, content) => {
      temporary.set(filePath, content);
    },
    rename: async (from) => {
      persisted = temporary.get(from) ?? persisted;
      temporary.delete(from);
    },
    unlink: async (filePath) => {
      temporary.delete(filePath);
    },
    mkdir: async () => undefined,
  });
  return {
    service,
    client,
    secrets,
    readPersisted: () => JSON.parse(persisted) as Record<string, unknown>,
  };
}

describe('MekaRouterService', () => {
  it('exposes and accepts the original Meka MCPRouter default address', async () => {
    const fixture = setup();

    await expect(fixture.service.getSettings()).resolves.toMatchObject({
      configured: false,
      routerUrl: null,
      defaultRouterUrl: DEFAULT_MEKA_MCPROUTER_URL,
    });

    await fixture.service.connect('', 'meka-user', 'secret');

    expect(fixture.client.login).toHaveBeenCalledWith(
      DEFAULT_MEKA_MCPROUTER_URL.replace(/\/+$/, ''),
      'meka-user',
      'secret',
    );
  });

  it('connects with the original client-key identity and preserves P4/unknown settings', async () => {
    const fixture = setup({
      schemaVersion: 1,
      p4RootPath: 'C:\\P4',
      subfolders: { saga2_design: true },
      unknownFutureCompatibleField: { keep: true },
    });

    await fixture.service.connect('https://router.example/', 'meka-user', 'secret');

    expect(fixture.client.login).toHaveBeenCalledWith(
      'https://router.example',
      'meka-user',
      'secret',
    );
    expect(fixture.readPersisted()).toMatchObject({
      p4RootPath: 'C:\\P4',
      subfolders: { saga2_design: true },
      unknownFutureCompatibleField: { keep: true },
      routerUrl: 'https://router.example',
      routerUsername: 'meka-user',
    });
    expect(fixture.secrets.get('meka.router.sessionToken')).toBe('session-token');
    expect(fixture.secrets.get('meka.router.clientKey')).toBe('client-key');
  });

  it('keeps MCPRouter login successful when optional MekaDesign route discovery fails', async () => {
    const fixture = setup({ mekadesignConfigured: true });
    vi.mocked(fixture.client.listRoutes).mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      fixture.service.connect('https://router.example', 'meka-user', 'secret'),
    ).resolves.toBeUndefined();

    await expect(fixture.service.getSettings()).resolves.toMatchObject({
      configured: true,
      mekaDesignConfigured: false,
    });
    expect(fixture.readPersisted()).toMatchObject({ mekadesignConfigured: true });
  });

  it('restores an existing MekaDesign registration from MCPRouter routes on login', async () => {
    const fixture = setup();
    vi.mocked(fixture.client.listRoutes).mockResolvedValue([
      {
        id: 'design-read',
        toolName: 'design_read',
        endpoint: 'https://design.example/api/mcp?key=mcp_secret',
        clientName: 'MekaDesign',
        enabled: true,
      },
      {
        id: 'ordinary-route',
        toolName: 'other_tool',
        endpoint: 'https://other.example/mcp',
        clientName: 'Other client',
        enabled: true,
      },
    ]);

    await fixture.service.connect('https://router.example', 'meka-user', 'secret');

    await expect(fixture.service.getSettings()).resolves.toMatchObject({
      configured: true,
      mekaDesignConfigured: true,
    });
    expect(fixture.readPersisted()).toMatchObject({ mekadesignConfigured: true });
    expect(fixture.secrets.get('meka.mekadesign.url')).toBe(
      'https://design.example/api/mcp?key=mcp_secret',
    );
  });

  it('restores a legacy MekaDesign route after its safe-storage URL could not be migrated', async () => {
    const fixture = setup({ mekadesignConfigured: true });
    vi.mocked(fixture.client.listRoutes).mockResolvedValue([
      {
        id: 'legacy-design-read',
        toolName: 'design_read',
        endpoint: 'https://legacy-design.example/api/mcp?key=mcp_legacy',
        enabled: true,
      },
      {
        id: 'legacy-design-write',
        toolName: 'design_write',
        endpoint: 'https://legacy-design.example/api/mcp?key=mcp_legacy',
        enabled: true,
      },
    ]);

    await fixture.service.connect('https://router.example', 'meka-user', 'secret');

    await expect(fixture.service.getSettings()).resolves.toMatchObject({
      mekaDesignConfigured: true,
    });
    expect(fixture.secrets.get('meka.mekadesign.url')).toBe(
      'https://legacy-design.example/api/mcp?key=mcp_legacy',
    );
  });

  it('syncs MekaDesign for an already authenticated MCPRouter without another login', async () => {
    const fixture = setup({
      routerUrl: 'https://router.example',
      routerUsername: 'meka-user',
      mekadesignConfigured: true,
    });
    fixture.secrets.set('meka.router.sessionToken', 'existing-session');
    fixture.secrets.set('meka.router.clientKey', 'existing-client-key');
    vi.mocked(fixture.client.listRoutes).mockResolvedValue([
      {
        id: 'legacy-design-read',
        toolName: 'design_read',
        endpoint: 'https://legacy-design.example/api/mcp?key=mcp_existing',
        enabled: true,
      },
    ]);

    await expect(fixture.service.getSettings()).resolves.toMatchObject({
      configured: true,
      mekaDesignConfigured: true,
    });
    expect(fixture.client.login).not.toHaveBeenCalled();
    expect(fixture.secrets.get('meka.mekadesign.url')).toBe(
      'https://legacy-design.example/api/mcp?key=mcp_existing',
    );
  });

  it('keeps the last local MekaDesign state when an authenticated router is unavailable', async () => {
    const fixture = setup({
      routerUrl: 'https://router.example',
      routerUsername: 'meka-user',
      mekadesignConfigured: true,
    });
    fixture.secrets.set('meka.router.sessionToken', 'existing-session');
    fixture.secrets.set('meka.router.clientKey', 'existing-client-key');
    fixture.secrets.set('meka.mekadesign.url', 'https://design.example/api/mcp?key=mcp_saved');
    vi.mocked(fixture.client.listRoutes).mockRejectedValue(new TypeError('fetch failed'));

    await expect(fixture.service.getSettings()).resolves.toMatchObject({
      configured: true,
      mekaDesignConfigured: true,
    });
    expect(fixture.readPersisted()).toMatchObject({ mekadesignConfigured: true });
  });

  it('preserves standalone MekaDesign when the logged-in router has no such client', async () => {
    const fixture = setup({ mekadesignConfigured: true });
    fixture.secrets.set('meka.mekadesign.url', 'https://old-design.example/api/mcp');
    vi.mocked(fixture.client.listRoutes).mockResolvedValue([
      {
        id: 'ordinary-route',
        toolName: 'other_tool',
        endpoint: 'https://other.example/mcp',
        clientName: 'Other client',
        enabled: true,
      },
    ]);

    await fixture.service.connect('https://router.example', 'meka-user', 'secret');

    await expect(fixture.service.getSettings()).resolves.toMatchObject({
      mekaDesignConfigured: true,
      mekaDesignConflict: false,
      mekaDesignConflictId: null,
    });
    expect(fixture.readPersisted()).toMatchObject({ mekadesignConfigured: true });
  });

  it('configures MekaDesign directly without MCPRouter discovery', async () => {
    const fixture = setup();
    await fixture.service.connect('https://router.example', 'meka-user', 'secret');

    await fixture.service.connectMekaDesign(
      'https://design.example/api/mcp?key=mcp_secret#ignored',
    );

    expect(fixture.client.discover).not.toHaveBeenCalled();
    expect(fixture.secrets.get('meka.mekadesign.url')).toBe(
      'https://design.example/api/mcp?key=mcp_secret',
    );
  });

  it('keeps standalone MekaDesign configured when MCPRouter is disconnected', async () => {
    const fixture = setup();
    await fixture.service.connect('https://router.example', 'meka-user', 'secret');
    await fixture.service.connectMekaDesign('https://design.example/api/mcp?key=mcp_direct');

    await fixture.service.disconnect();

    await expect(fixture.service.getSettings()).resolves.toMatchObject({
      configured: false,
      routerUrl: null,
      mekaDesignConfigured: true,
    });
  });

  it('does not immediately restore a Router address after MekaDesign is explicitly disconnected', async () => {
    const fixture = setup({
      routerUrl: 'https://router.example',
      routerUsername: 'meka-user',
      mekadesignConfigured: true,
    });
    fixture.secrets.set('meka.router.sessionToken', 'session-token');
    fixture.secrets.set('meka.router.clientKey', 'client-key');
    fixture.secrets.set('meka.mekadesign.url', 'https://design.example/api/mcp?key=mcp_router');
    vi.mocked(fixture.client.listRoutes).mockResolvedValue([
      {
        id: 'design-read',
        toolName: 'design_read',
        endpoint: 'https://design.example/api/mcp?key=mcp_router',
        clientName: 'MekaDesign',
        enabled: true,
      },
    ]);

    await fixture.service.disconnectMekaDesign();

    await expect(fixture.service.getSettings()).resolves.toMatchObject({
      mekaDesignConfigured: false,
      mekaDesignConflict: false,
    });
    expect(fixture.readPersisted()).toMatchObject({
      mekadesignConfigured: false,
      mekaDesignRouterSyncSuppressed: true,
    });
  });

  it('reports a conflict instead of replacing a different standalone MekaDesign address', async () => {
    const fixture = setup({
      routerUrl: 'https://router.example',
      routerUsername: 'meka-user',
      mekadesignConfigured: true,
    });
    fixture.secrets.set('meka.router.sessionToken', 'existing-session');
    fixture.secrets.set('meka.router.clientKey', 'existing-client-key');
    fixture.secrets.set('meka.mekadesign.url', 'https://direct.example/api/mcp?key=mcp_direct');
    vi.mocked(fixture.client.listRoutes).mockResolvedValue([
      {
        id: 'router-design',
        toolName: 'design_read',
        endpoint: 'https://router-design.example/api/mcp?key=mcp_router',
        clientName: 'MekaDesign',
        enabled: true,
      },
    ]);

    const settings = await fixture.service.getSettings();
    expect(settings).toMatchObject({
      mekaDesignConfigured: true,
      mekaDesignUrl: 'https://direct.example/api/mcp?key=mcp_direct',
      mekaDesignConflict: true,
      mekaDesignConflictId: expect.any(String),
    });
    expect(JSON.stringify(settings)).not.toContain('mcp_router');
    expect(fixture.secrets.get('meka.mekadesign.url')).toBe(
      'https://direct.example/api/mcp?key=mcp_direct',
    );

    await expect(fixture.service.useMekaDesignFromRouter('stale-conflict')).rejects.toThrow(
      'conflict changed',
    );
    await fixture.service.useMekaDesignFromRouter(settings.mekaDesignConflictId!);

    expect(fixture.secrets.get('meka.mekadesign.url')).toBe(
      'https://router-design.example/api/mcp?key=mcp_router',
    );
  });

  it('does not downgrade a future settings schema or leave newly stored secrets behind', async () => {
    const fixture = setup({ schemaVersion: 99, p4RootPath: 'C:\\P4' });
    vi.mocked(fixture.client.listRoutes).mockResolvedValue([
      {
        id: 'design-read',
        toolName: 'design_read',
        endpoint: 'https://design.example/api/mcp?key=mcp_candidate',
        clientName: 'MekaDesign',
        enabled: true,
      },
    ]);

    await expect(
      fixture.service.connect('https://router.example', 'user', 'secret'),
    ).rejects.toThrow('read-only');

    expect(fixture.readPersisted()).toEqual({ schemaVersion: 99, p4RootPath: 'C:\\P4' });
    expect(fixture.secrets.size).toBe(0);
  });

  it('stores project bindings without disturbing the rest of the shared Meka config', async () => {
    const fixture = setup({ p4RootPath: 'C:\\P4', custom: 'keep' });

    await fixture.service.setProjectBindings('project-1', ['instance-1', 'instance-1', '']);

    expect(await fixture.service.listProjectBindings('project-1')).toEqual(['instance-1']);
    expect(fixture.readPersisted()).toMatchObject({
      p4RootPath: 'C:\\P4',
      custom: 'keep',
      projectRemoteInstanceIds: { 'project-1': ['instance-1'] },
    });
  });

  it('exposes only project-bound tools and authorizes every high-risk call', async () => {
    const fixture = setup({
      routerUrl: 'https://router.example',
      mekadesignConfigured: true,
      projectRemoteInstanceIds: { 'project-1': ['bound-instance'] },
    });
    fixture.secrets.set('meka.router.sessionToken', 'session-token');
    fixture.secrets.set('meka.router.clientKey', 'client-key');
    fixture.secrets.set('meka.mekadesign.url', 'https://direct-design.example/api/mcp');
    vi.mocked(fixture.client.listTools).mockResolvedValue([
      { name: 'global-read' },
      { name: 'design-read' },
      { name: 'bound-read', annotations: { instanceId: 'bound-instance' } },
      { name: 'unbound-read', annotations: { instanceId: 'other-instance' } },
      { name: 'deploy-production', annotations: { riskLevel: 'high' } },
    ]);
    vi.mocked(fixture.client.listRoutes).mockResolvedValue([
      {
        id: 'router-design-read',
        toolName: 'design-read',
        endpoint: 'https://router-design.example/api/mcp',
        clientName: 'MekaDesign',
        enabled: true,
      },
    ]);
    vi.mocked(fixture.client.callTool).mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });

    await expect(fixture.service.listProjectTools('project-1')).resolves.toEqual([
      { name: 'global-read' },
      { name: 'bound-read', annotations: { instanceId: 'bound-instance' } },
      { name: 'deploy-production', annotations: { riskLevel: 'high' } },
    ]);
    await expect(fixture.service.callProjectTool('project-1', 'design-read', {})).rejects.toThrow(
      'only through the direct MekaDesign MCP',
    );
    await expect(fixture.service.callProjectTool('project-1', 'unbound-read', {})).rejects.toThrow(
      'not bound',
    );
    await expect(
      fixture.service.callProjectTool('project-1', 'deploy-production', {}),
    ).rejects.toThrow('explicit user approval');

    const authorize = vi.fn(async () => true);
    await expect(
      fixture.service.callProjectTool('project-1', 'deploy-production', {}, authorize),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(authorize).toHaveBeenCalledWith({
      toolName: 'deploy-production',
      args: {},
      risk: 'high',
    });
    expect(fixture.client.callTool).toHaveBeenCalledWith(
      'https://router.example',
      'client-key',
      'deploy-production',
      {},
    );
    expect(fixture.client.callTool).not.toHaveBeenCalledWith(
      'https://router.example',
      'client-key',
      'design-read',
      {},
    );
  });
});
