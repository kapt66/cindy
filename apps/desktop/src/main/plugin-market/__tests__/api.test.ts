import { beforeEach, describe, expect, it, vi } from 'vitest';

const sources = vi.hoisted(() => ({
  cindyBaseUrl: 'https://cindy-plugin.test.invalid' as string | null,
  mekaAccess: {
    baseUrl: 'https://mcp-router.test.invalid',
    clientKey: 'meka-client-key' as string | null,
  },
  serverApiFetch: vi.fn(),
}));

vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: vi.fn(() => sources.cindyBaseUrl),
}));
vi.mock('../../meka-settings/ipc.js', () => ({
  getMekaRouterService: () => ({
    getPluginRegistryAccess: vi.fn(async () => sources.mekaAccess),
  }),
}));
vi.mock('../../serverApiClient.js', () => ({
  serverApiFetch: sources.serverApiFetch,
}));

import { MekaPluginMarketApi, PluginMarketApi } from '../api';

const PLUGIN_A = `c${'a'.repeat(24)}`;
const PLUGIN_B = `c${'b'.repeat(24)}`;

function summary(id: string, ghostId: string) {
  return {
    id,
    ghostId,
    name: ghostId,
    description: null,
    author: null,
    scope: 'public',
    organizationId: null,
    defaultInstall: false,
    currentRelease: {
      id: `release-${ghostId}`,
      version: '1.0.0',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
      publishedAt: '2026-07-23T00:00:00.000Z',
    },
  };
}

describe('PluginMarketApi', () => {
  beforeEach(() => {
    sources.cindyBaseUrl = 'https://cindy-plugin.test.invalid';
    sources.mekaAccess.baseUrl = 'https://mcp-router.test.invalid';
    sources.mekaAccess.clientKey = 'meka-client-key';
    sources.serverApiFetch.mockReset();
  });

  it('paginates with opaque cursors and deduplicates repeated ids', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 2,
        plugins: [summary(PLUGIN_A, 'alpha')],
        nextCursor: PLUGIN_A,
      })
      .mockResolvedValueOnce({
        schemaVersion: 2,
        plugins: [summary(PLUGIN_A, 'alpha'), summary(PLUGIN_B, 'beta')],
        nextCursor: null,
      });
    const api = new PluginMarketApi(fetcher);

    await expect(api.listAll()).resolves.toHaveLength(2);
    expect(fetcher.mock.calls[1]?.[0]).toContain(`cursor=${PLUGIN_A}`);
  });

  it('fails closed when the server still returns schema v1', async () => {
    const api = new PluginMarketApi(
      vi.fn().mockResolvedValue({
        schemaVersion: 1,
        plugins: [],
        nextCursor: null,
      }),
    );

    await expect(api.listAll()).rejects.toThrow('schemaVersion');
  });

  it('treats injected sources as configured unless a checker says otherwise', async () => {
    const fetcher = vi.fn();
    await expect(new PluginMarketApi(fetcher).isConfigured()).resolves.toBe(true);
    await expect(
      new PluginMarketApi(fetcher, async () => false).isConfigured(),
    ).resolves.toBe(false);
  });

  it('keeps Cindy and MCPRouter requests on independent endpoints and credentials', async () => {
    sources.serverApiFetch.mockResolvedValue({
      schemaVersion: 2,
      plugins: [],
      nextCursor: null,
    });

    await new PluginMarketApi().listAll();
    await new MekaPluginMarketApi().listAll();

    expect(sources.serverApiFetch.mock.calls[0]?.[1]).toMatchObject({
      baseUrl: sources.cindyBaseUrl,
    });
    expect(sources.serverApiFetch.mock.calls[0]?.[1]).not.toHaveProperty('token');
    expect(sources.serverApiFetch.mock.calls[1]?.[1]).toMatchObject({
      baseUrl: sources.mekaAccess.baseUrl,
      token: sources.mekaAccess.clientKey,
      skipAutoRefresh: true,
      redactErrorDetails: true,
    });
    expect(sources.serverApiFetch.mock.calls[1]?.[0]).toContain('/api/plugins?');
  });

  it('uses the anonymous public surface without credentials when MCPRouter is unbound', async () => {
    sources.mekaAccess.clientKey = null;
    sources.serverApiFetch
      .mockResolvedValueOnce({
        schemaVersion: 2,
        plugins: [],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        url: 'https://mcp-router.test.invalid/api/plugin-assets/release-1?expires=1&sig=test',
        expiresAt: '2026-07-23T00:05:00.000Z',
        sha256: 'a'.repeat(64),
        sizeBytes: 42,
      });
    const api = new MekaPluginMarketApi();

    await expect(api.isConfigured()).resolves.toBe(true);
    await api.listAll();
    await api.download(PLUGIN_A, 'release-1');

    expect(sources.serverApiFetch.mock.calls.map((call) => call[0])).toEqual([
      expect.stringContaining('/api/public/plugins?'),
      `/api/public/plugins/${PLUGIN_A}/releases/release-1/download`,
    ]);
    for (const [, options] of sources.serverApiFetch.mock.calls) {
      expect(options).toMatchObject({
        baseUrl: sources.mekaAccess.baseUrl,
        skipAutoRefresh: true,
        redactErrorDetails: true,
      });
      expect(options).not.toHaveProperty('token');
    }
  });

  it('re-evaluates Router authentication before each catalog request', async () => {
    sources.serverApiFetch.mockResolvedValue({
      schemaVersion: 2,
      plugins: [],
      nextCursor: null,
    });
    const api = new MekaPluginMarketApi();

    await api.listAll();
    sources.mekaAccess.clientKey = null;
    await api.listAll();

    expect(sources.serverApiFetch.mock.calls.map((call) => call[0])).toEqual([
      expect.stringContaining('/api/plugins?'),
      expect.stringContaining('/api/public/plugins?'),
    ]);
    expect(sources.serverApiFetch.mock.calls[0]?.[1]).toHaveProperty(
      'token',
      'meka-client-key',
    );
    expect(sources.serverApiFetch.mock.calls[1]?.[1]).not.toHaveProperty('token');
  });

  it('keeps MCPRouter package downloads on the shared HTTPS-only contract', async () => {
    sources.mekaAccess.baseUrl = 'https://mcpr.meka.pawdy.fun';
    sources.serverApiFetch.mockResolvedValue({
      url: 'https://mcpr.meka.pawdy.fun/api/plugin-assets/release-1?expires=1&sig=test',
      expiresAt: '2026-07-23T00:05:00.000Z',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
    });
    const api = new MekaPluginMarketApi();

    await expect(api.download(PLUGIN_A, 'release-1')).resolves.toMatchObject({
      url: 'https://mcpr.meka.pawdy.fun/api/plugin-assets/release-1?expires=1&sig=test',
    });

    sources.serverApiFetch.mockResolvedValue({
      url: 'http://insecure.example.test/api/plugin-assets/release-1?expires=1&sig=test',
      expiresAt: '2026-07-23T00:05:00.000Z',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
    });
    await expect(api.download(PLUGIN_A, 'release-1')).rejects.toThrow('HTTPS URL');
  });

  it('rejects a cursor that does not advance', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      schemaVersion: 2,
      plugins: [],
      nextCursor: PLUGIN_A,
    });
    const api = new PluginMarketApi(fetcher);

    await expect(api.listAll()).rejects.toThrow('游标未前进');
  });
});
