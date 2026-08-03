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
    normalizeBaseUrl: vi.fn((url: string) =>
      url.startsWith('http:')
        ? DEFAULT_MEKA_MCPROUTER_URL.replace(/\/+$/, '')
        : url.replace(/\/+$/, ''),
    ),
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
    listOwnedMekaPlugins: vi.fn(async () => []),
    uploadMekaPlugin: vi.fn(async () => ({})),
    setMekaPluginAccess: vi.fn(async () => ({})),
    listOwnedMekaSkills: vi.fn(async () => []),
    uploadMekaSkill: vi.fn(async () => ({})),
    setMekaSkillAccess: vi.fn(async () => ({})),
    deleteMekaSkill: vi.fn(async () => undefined),
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
  it('exposes and accepts the HTTPS Meka MCPRouter default address', async () => {
    const fixture = setup();
    expect(DEFAULT_MEKA_MCPROUTER_URL).toBe('https://mcpr.meka.pawdy.fun/');

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

  it('routes a previously saved HTTP origin through the production HTTPS Router', async () => {
    const fixture = setup({ routerUrl: 'http://retired-router.example/' });
    fixture.secrets.set('meka.router.sessionToken', 'existing-session');
    fixture.secrets.set('meka.router.clientKey', 'existing-client-key');

    await expect(fixture.service.getSettings()).resolves.toMatchObject({
      configured: true,
      routerUrl: DEFAULT_MEKA_MCPROUTER_URL.replace(/\/+$/, ''),
    });
    await expect(fixture.service.getPluginRegistryAccess()).resolves.toEqual({
      baseUrl: DEFAULT_MEKA_MCPROUTER_URL.replace(/\/+$/, ''),
      clientKey: 'existing-client-key',
    });
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

  it('resolves anonymous default and bound registry access without session credentials', async () => {
    const fixture = setup();
    fixture.secrets.set('meka.router.sessionToken', 'not-yet-persisted-session');
    fixture.secrets.set('meka.router.clientKey', 'not-yet-persisted-key');

    await expect(fixture.service.getPluginRegistryAccess()).resolves.toEqual({
      baseUrl: DEFAULT_MEKA_MCPROUTER_URL.replace(/\/+$/, ''),
      clientKey: null,
    });

    await fixture.service.connect('https://router.example/', 'meka-user', 'secret');

    await expect(fixture.service.getPluginRegistryAccess()).resolves.toEqual({
      baseUrl: 'https://router.example',
      clientKey: 'client-key',
    });

    await fixture.service.disconnect();
    await expect(fixture.service.getPluginRegistryAccess()).resolves.toEqual({
      baseUrl: DEFAULT_MEKA_MCPROUTER_URL.replace(/\/+$/, ''),
      clientKey: null,
    });
  });

  it('uses a saved custom Router origin anonymously when no binding exists', async () => {
    const fixture = setup({ routerUrl: 'https://public-router.example/' });

    await expect(fixture.service.getPluginRegistryAccess()).resolves.toEqual({
      baseUrl: 'https://public-router.example',
      clientKey: null,
    });
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

  it('previews an owned Plugin and publishes a confirmed immutable update with synchronized access', async () => {
    const fixture = setup({ routerUrl: 'https://router.example' });
    fixture.secrets.set('meka.router.sessionToken', 'session-token');
    fixture.secrets.set('meka.router.clientKey', 'client-key');
    const existing = {
      id: 'plugin-resource',
      ghostId: 'demo-plugin',
      visibility: 'private' as const,
      sharedUsernames: [],
      currentRelease: {
        id: 'release-1',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        sizeBytes: 4,
        publishedAt: '2026-07-29T00:00:00.000Z',
      },
    };
    const updated = {
      ...existing,
      visibility: 'shared' as const,
      sharedUsernames: ['alice'],
      currentRelease: { ...existing.currentRelease, id: 'release-2', version: '2.0.0' },
    };
    vi.mocked(fixture.client.listOwnedMekaPlugins).mockResolvedValue([existing]);
    vi.mocked(fixture.client.uploadMekaPlugin).mockResolvedValue(updated);
    vi.mocked(fixture.client.setMekaPluginAccess).mockResolvedValue(updated);

    await expect(fixture.service.getMekaPluginUploadInfo('demo-plugin', '2.0.0')).resolves.toEqual({
      pluginId: 'demo-plugin',
      version: '2.0.0',
      existing: {
        pluginResourceId: 'plugin-resource',
        currentReleaseId: 'release-1',
        currentVersion: '1.0.0',
        visibility: 'private',
        sharedUsernames: [],
      },
    });
    await expect(
      fixture.service.uploadMekaPlugin(
        new Uint8Array([1, 2, 3, 4]),
        'demo-plugin',
        '2.0.0',
        'shared',
        ['alice', 'alice'],
        'release-1',
      ),
    ).resolves.toEqual({
      pluginId: 'demo-plugin',
      version: '2.0.0',
      visibility: 'shared',
      releasePublished: true,
    });
    expect(fixture.client.uploadMekaPlugin).toHaveBeenCalledWith(
      'https://router.example',
      'session-token',
      expect.any(Uint8Array),
      'plugin-resource',
    );
    expect(fixture.client.setMekaPluginAccess).toHaveBeenCalledWith(
      'https://router.example',
      'session-token',
      'plugin-resource',
      'shared',
      ['alice'],
    );
  });

  it('synchronizes access without overwriting an existing immutable version', async () => {
    const fixture = setup({ routerUrl: 'https://router.example' });
    fixture.secrets.set('meka.router.sessionToken', 'session-token');
    fixture.secrets.set('meka.router.clientKey', 'client-key');
    const existing = {
      id: 'plugin-resource',
      ghostId: 'demo-plugin',
      visibility: 'private' as const,
      sharedUsernames: [],
      currentRelease: {
        id: 'release-1',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        sizeBytes: 4,
        publishedAt: '2026-07-29T00:00:00.000Z',
      },
    };
    vi.mocked(fixture.client.listOwnedMekaPlugins).mockResolvedValue([existing]);
    vi.mocked(fixture.client.setMekaPluginAccess).mockResolvedValue({
      ...existing,
      visibility: 'public',
    });

    await expect(
      fixture.service.uploadMekaPlugin(
        new Uint8Array([1]),
        'demo-plugin',
        '1.0.0',
        'public',
        [],
        'release-1',
      ),
    ).resolves.toMatchObject({
      visibility: 'public',
      releasePublished: false,
    });
    expect(fixture.client.uploadMekaPlugin).not.toHaveBeenCalled();
    expect(fixture.client.setMekaPluginAccess).toHaveBeenCalledWith(
      'https://router.example',
      'session-token',
      'plugin-resource',
      'public',
      [],
    );
  });

  it('publishes an immutable Meka Skill release and synchronizes exact-user access', async () => {
    const fixture = setup({ routerUrl: 'https://router.example' });
    fixture.secrets.set('meka.router.sessionToken', 'session-token');
    fixture.secrets.set('meka.router.clientKey', 'client-key');
    const existing = {
      id: 'skill-resource',
      slug: 'release-notes',
      name: 'release-notes',
      description: 'Prepare release notes',
      visibility: 'private' as const,
      sharedUsernames: [],
      currentRelease: {
        id: 'release-1',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        sizeBytes: 4,
        uncompressedSizeBytes: 8,
        publishedAt: '2026-07-29T00:00:00.000Z',
      },
    };
    const updated = {
      ...existing,
      currentRelease: { ...existing.currentRelease, id: 'release-2', version: '2.0.0' },
    };
    vi.mocked(fixture.client.listOwnedMekaSkills).mockResolvedValue([existing]);
    vi.mocked(fixture.client.uploadMekaSkill).mockResolvedValue(updated);
    vi.mocked(fixture.client.setMekaSkillAccess).mockResolvedValue({
      ...updated,
      visibility: 'shared',
      sharedUsernames: ['alice'],
    });

    const source = {
      sourceId: 'source-1',
      directoryPath: 'C:\\skills\\release-notes',
      name: 'release-notes',
      description: 'Prepare release notes',
      fileCount: 2,
      packageSizeBytes: 4,
    };
    await expect(fixture.service.getMekaSkillPublishInfo(source)).resolves.toMatchObject({
      source,
      suggestedVersion: '1.0.1',
      existing: {
        skillResourceId: 'skill-resource',
        currentReleaseId: 'release-1',
        currentVersion: '1.0.0',
      },
    });
    await expect(
      fixture.service.uploadMekaSkill(
        new Uint8Array([1, 2, 3, 4]),
        source,
        '2.0.0',
        'Adds Jira formatting',
        'shared',
        ['alice', 'alice'],
        'release-1',
      ),
    ).resolves.toEqual({
      skillId: 'release-notes',
      version: '2.0.0',
      visibility: 'shared',
      releasePublished: true,
    });
    expect(fixture.client.uploadMekaSkill).toHaveBeenCalledWith(
      'https://router.example',
      'session-token',
      expect.any(Uint8Array),
      'skill-resource',
      'Adds Jira formatting',
    );
    expect(fixture.client.setMekaSkillAccess).toHaveBeenCalledWith(
      'https://router.example',
      'session-token',
      'skill-resource',
      'shared',
      ['alice'],
    );
  });

  it('synchronizes Meka Skill access without uploading an existing immutable version', async () => {
    const fixture = setup({ routerUrl: 'https://router.example' });
    fixture.secrets.set('meka.router.sessionToken', 'session-token');
    fixture.secrets.set('meka.router.clientKey', 'client-key');
    const existing = {
      id: 'skill-resource',
      slug: 'release-notes',
      name: 'release-notes',
      description: 'Prepare release notes',
      visibility: 'private' as const,
      sharedUsernames: [],
      currentRelease: {
        id: 'release-1',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        sizeBytes: 4,
        uncompressedSizeBytes: 8,
        publishedAt: '2026-07-29T00:00:00.000Z',
      },
    };
    vi.mocked(fixture.client.listOwnedMekaSkills).mockResolvedValue([existing]);
    vi.mocked(fixture.client.setMekaSkillAccess).mockResolvedValue({
      ...existing,
      visibility: 'public',
    });
    const source = {
      sourceId: 'source-1',
      directoryPath: 'C:\\skills\\release-notes',
      name: 'release-notes',
      description: 'Prepare release notes',
      fileCount: 1,
      packageSizeBytes: 4,
    };

    await expect(
      fixture.service.uploadMekaSkill(
        new Uint8Array([1, 2, 3, 4]),
        source,
        '1.0.0',
        '',
        'public',
        [],
        'release-1',
      ),
    ).resolves.toEqual({
      skillId: 'release-notes',
      version: '1.0.0',
      visibility: 'public',
      releasePublished: false,
    });
    expect(fixture.client.uploadMekaSkill).not.toHaveBeenCalled();
    expect(fixture.client.setMekaSkillAccess).toHaveBeenCalledWith(
      'https://router.example',
      'session-token',
      'skill-resource',
      'public',
      [],
    );
  });

  it('suggests 1.0.0 when the Meka Skill does not exist remotely', async () => {
    const fixture = setup({ routerUrl: 'https://router.example' });
    fixture.secrets.set('meka.router.sessionToken', 'session-token');
    fixture.secrets.set('meka.router.clientKey', 'client-key');
    vi.mocked(fixture.client.listOwnedMekaSkills).mockResolvedValue([]);
    const source = {
      sourceId: 'source-1',
      directoryPath: 'C:\\skills\\release-notes',
      name: 'release-notes',
      description: 'Prepare release notes',
      fileCount: 1,
      packageSizeBytes: 100,
    };

    await expect(fixture.service.getMekaSkillPublishInfo(source)).resolves.toEqual({
      source,
      suggestedVersion: '1.0.0',
      existing: null,
    });
  });

  it('loads, updates, and deletes only the expected owned Meka Skill release', async () => {
    const fixture = setup({ routerUrl: 'https://router.example' });
    fixture.secrets.set('meka.router.sessionToken', 'session-token');
    fixture.secrets.set('meka.router.clientKey', 'client-key');
    const existing = {
      id: 'skill-resource',
      slug: 'release-notes',
      name: 'Release notes',
      description: 'Prepare release notes',
      visibility: 'private' as const,
      sharedUsernames: [],
      currentRelease: {
        id: 'release-1',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        sizeBytes: 4,
        uncompressedSizeBytes: 8,
        publishedAt: '2026-07-29T00:00:00.000Z',
      },
    };
    const updated = {
      ...existing,
      visibility: 'shared' as const,
      sharedUsernames: ['alice'],
    };
    vi.mocked(fixture.client.listOwnedMekaSkills).mockResolvedValue([existing]);
    vi.mocked(fixture.client.setMekaSkillAccess).mockResolvedValue(updated);

    await expect(fixture.service.getMekaSkillManagementInfo('skill-resource')).resolves.toEqual({
      skillResourceId: 'skill-resource',
      slug: 'release-notes',
      name: 'Release notes',
      currentReleaseId: 'release-1',
      currentVersion: '1.0.0',
      visibility: 'private',
      sharedUsernames: [],
    });
    await expect(
      fixture.service.updateMekaSkillAccess('skill-resource', 'release-1', 'shared', [
        'alice',
        'alice',
      ]),
    ).resolves.toMatchObject({
      visibility: 'shared',
      sharedUsernames: ['alice'],
    });
    expect(fixture.client.setMekaSkillAccess).toHaveBeenCalledWith(
      'https://router.example',
      'session-token',
      'skill-resource',
      'shared',
      ['alice'],
    );

    await expect(
      fixture.service.deleteMekaSkill('skill-resource', 'stale-release'),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(fixture.client.deleteMekaSkill).not.toHaveBeenCalled();

    await expect(
      fixture.service.deleteMekaSkill('skill-resource', 'release-1'),
    ).resolves.toBeUndefined();
    expect(fixture.client.deleteMekaSkill).toHaveBeenCalledWith(
      'https://router.example',
      'session-token',
      'skill-resource',
    );
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
