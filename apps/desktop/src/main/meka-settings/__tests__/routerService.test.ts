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

  it('registers MekaDesign with explicit MCPRouter client metadata', async () => {
    const fixture = setup();
    await fixture.service.connect('https://router.example', 'meka-user', 'secret');

    await fixture.service.connectMekaDesign(
      'https://design.example/api/mcp?key=mcp_secret#ignored',
    );

    expect(fixture.client.discover).toHaveBeenCalledWith(
      'https://router.example',
      'session-token',
      'https://design.example/api/mcp?key=mcp_secret',
      {
        clientName: 'MekaDesign',
        clientDescription: 'MekaDesign 设计平台 MCP 工具',
      },
    );
    expect(fixture.secrets.get('meka.mekadesign.url')).toBe(
      'https://design.example/api/mcp?key=mcp_secret',
    );
  });

  it('does not downgrade a future settings schema or leave newly stored secrets behind', async () => {
    const fixture = setup({ schemaVersion: 99, p4RootPath: 'C:\\P4' });

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
      projectRemoteInstanceIds: { 'project-1': ['bound-instance'] },
    });
    fixture.secrets.set('meka.router.sessionToken', 'session-token');
    fixture.secrets.set('meka.router.clientKey', 'client-key');
    vi.mocked(fixture.client.listTools).mockResolvedValue([
      { name: 'global-read' },
      { name: 'bound-read', annotations: { instanceId: 'bound-instance' } },
      { name: 'unbound-read', annotations: { instanceId: 'other-instance' } },
      { name: 'deploy-production', annotations: { riskLevel: 'high' } },
    ]);
    vi.mocked(fixture.client.callTool).mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });

    await expect(fixture.service.listProjectTools('project-1')).resolves.toEqual([
      { name: 'global-read' },
      { name: 'bound-read', annotations: { instanceId: 'bound-instance' } },
      { name: 'deploy-production', annotations: { riskLevel: 'high' } },
    ]);
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
  });
});
