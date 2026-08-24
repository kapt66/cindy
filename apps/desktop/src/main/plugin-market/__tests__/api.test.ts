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

const logger = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: logger.warn, error: vi.fn() }),
}));

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

function removal(pluginId: string, ghostId: string) {
  return {
    pluginId,
    ghostId,
    scope: 'organization',
    organizationId: 'org-1',
    action: 'purge',
    removedAt: '2026-08-03T08:00:00.000Z',
  };
}

/** 依序吐出各页响应（自动补 schemaVersion: 2）的 fetcher mock。 */
function pagedFetcher(...pages: Array<Record<string, unknown>>) {
  const fetcher = vi.fn();
  for (const page of pages) {
    fetcher.mockResolvedValueOnce({ schemaVersion: 2, ...page });
  }
  return fetcher;
}

describe('PluginMarketApi 默认 fetcher 的日志隐私', () => {
  it('⚠️ 默认 fetcher 走 serverApiFetch 时带 redactErrorDetails + logLabel（不外泄插件 ID）', async () => {
    // 2026-08-06 review：plugin 的 path 带用户装的插件 ID,4xx/5xx 日志不得外泄它。
    sources.serverApiFetch.mockReset();
    sources.serverApiFetch.mockRejectedValueOnce(new Error('nope'));
    await expect(new PluginMarketApi().detail('cindy-github')).rejects.toBeTruthy();
    const opts = sources.serverApiFetch.mock.calls[0]?.[1] ?? {};
    expect(opts.redactErrorDetails).toBe(true);
    expect(opts.logLabel).toBe('/api/plugins');
  });
});

describe('PluginMarketApi', () => {
  beforeEach(() => {
    sources.cindyBaseUrl = 'https://cindy-plugin.test.invalid';
    sources.mekaAccess.baseUrl = 'https://mcp-router.test.invalid';
    sources.mekaAccess.clientKey = 'meka-client-key';
    sources.serverApiFetch.mockReset();
  });

  it('paginates with opaque cursors and deduplicates repeated ids', async () => {
    const fetcher = pagedFetcher(
      { plugins: [summary(PLUGIN_A, 'alpha')], nextCursor: PLUGIN_A },
      {
        plugins: [summary(PLUGIN_A, 'alpha'), summary(PLUGIN_B, 'beta')],
        nextCursor: null,
      },
    );
    const api = new PluginMarketApi(fetcher, () => '1.2.3');

    await expect(api.listAll()).resolves.toMatchObject({
      plugins: [{ id: PLUGIN_A }, { id: PLUGIN_B }],
      removals: [],
    });
    expect(fetcher.mock.calls[1]?.[0]).toContain(`cursor=${PLUGIN_A}`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'x-cindy-version': '1.2.3' },
      timeoutMs: 15_000,
    });
  });

  it('deduplicates removals by pluginId across pages keeping the first-seen notice', async () => {
    const fetcher = pagedFetcher(
      {
        plugins: [],
        removals: [removal(PLUGIN_A, 'alpha')],
        nextCursor: PLUGIN_A,
      },
      {
        plugins: [],
        removals: [
          // 同 pluginId 但内容不同的后到通告必须被丢弃(保首见)。
          { ...removal(PLUGIN_A, 'alpha'), removedAt: '2026-08-04T00:00:00.000Z' },
          removal(PLUGIN_B, 'beta'),
        ],
        nextCursor: null,
      },
    );

    await expect(new PluginMarketApi(fetcher).listAll()).resolves.toMatchObject({
      plugins: [],
      removals: [
        { pluginId: PLUGIN_A, removedAt: '2026-08-03T08:00:00.000Z' },
        { pluginId: PLUGIN_B },
      ],
    });
  });

  it('keeps active plugins over conflicting removals across pages', async () => {
    const fetcher = pagedFetcher(
      {
        plugins: [],
        removals: [removal(PLUGIN_A, 'alpha'), removal(PLUGIN_B, 'beta')],
        nextCursor: PLUGIN_A,
      },
      { plugins: [summary(PLUGIN_A, 'alpha')], removals: [], nextCursor: null },
    );

    await expect(new PluginMarketApi(fetcher).listAll()).resolves.toMatchObject({
      plugins: [{ id: PLUGIN_A }],
      removals: [{ pluginId: PLUGIN_B }],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'market removal ignored because plugin is active',
      { pluginId: PLUGIN_A },
    );
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
    await expect(new PluginMarketApi(fetcher, async () => false).isConfigured()).resolves.toBe(
      false,
    );
  });

  it('keeps Cindy and MCPRouter requests on independent endpoints and credentials', async () => {
    sources.serverApiFetch.mockResolvedValue({
      schemaVersion: 2,
      plugins: [],
      nextCursor: null,
    });

    await new PluginMarketApi().listAll();
    await new MekaPluginMarketApi().listAll();

    const cindyOptions = sources.serverApiFetch.mock.calls[0]?.[1];
    expect(cindyOptions).toMatchObject({
      baseUrl: expect.any(Function),
    });
    expect(cindyOptions?.baseUrl()).toBe(sources.cindyBaseUrl);
    expect(cindyOptions).not.toHaveProperty('token');
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
    expect(sources.serverApiFetch.mock.calls[0]?.[1]).toHaveProperty('token', 'meka-client-key');
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
