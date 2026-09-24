import { CINDY_PLUGIN_SPACE_HEADER } from '@cindy/plugin-protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sources = vi.hoisted(() => ({
  cindyBaseUrl: 'https://cindy-plugin.test.invalid' as string | null,
  mekaAccess: {
    baseUrl: 'https://mcp-router.test.invalid',
    clientKey: 'meka-client-key' as string | null,
  },
  /** MCPRouter 未绑定（`getPluginRegistryAccess()` 抛错）时 Meka 渠道应视为未配置。 */
  mekaRegistryFails: false as boolean,
  serverApiFetch: vi.fn(),
}));

vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: vi.fn(() => sources.cindyBaseUrl),
}));
vi.mock('../../meka-settings/ipc.js', () => ({
  getMekaRouterService: () => ({
    getPluginRegistryAccess: vi.fn(async () => {
      if (sources.mekaRegistryFails) throw new Error('MCPRouter unbound');
      return sources.mekaAccess;
    }),
  }),
}));
vi.mock('../../serverApiClient.js', () => ({
  serverApiFetch: sources.serverApiFetch,
}));

import { MekaPluginMarketApi, PluginMarketApi } from '../api';
import { pluginClientVersionReader } from '../clientIdentity';

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
    sources.mekaRegistryFails = false;
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
    await new MekaPluginMarketApi(pluginClientVersionReader('meka')).listAll();

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

  // P2 客户端就绪件的核心验收点：空间头的协议常量与写头代码都在，但**默认不发**。
  // 这里不只看"没有那个键"，而是把整个 headers 对象逐字节比出来——多出任何头（哪怕是空对象
  // 或别的默认头）都算与今天漂移。两条渠道各测一次，因为版本头取值不同。
  it('默认关闭空间头：两条渠道的请求头与现状逐字节相同（恰好只有 x-cindy-version）', async () => {
    sources.serverApiFetch.mockResolvedValue({
      schemaVersion: 2,
      plugins: [],
      nextCursor: null,
    });

    await new PluginMarketApi(undefined, () => '1.2.3').listAll();
    await new MekaPluginMarketApi(() => '2.4.1').listAll();

    const cindyHeaders = sources.serverApiFetch.mock.calls[0]?.[1]?.headers;
    const mekaHeaders = sources.serverApiFetch.mock.calls[1]?.[1]?.headers;
    expect(JSON.stringify(cindyHeaders)).toBe(JSON.stringify({ 'x-cindy-version': '1.2.3' }));
    expect(JSON.stringify(mekaHeaders)).toBe(JSON.stringify({ 'x-cindy-version': '2.4.1' }));
    for (const headers of [cindyHeaders, mekaHeaders]) {
      expect(Object.keys(headers ?? {})).toEqual(['x-cindy-version']);
      expect(headers).not.toHaveProperty(CINDY_PLUGIN_SPACE_HEADER);
    }
  });

  // 开关是模块常量、默认 false，生产语义**不支持运行期翻转**；要证明"打开后会带空间头"只能在
  // 模块图层面做替身：resetModules + doMock 出 enabled=true 的 clientIdentity，再动态 import
  // 真实的 api 模块。它验证的是"开启后两个渠道各带自己 edition 的空间名"，不改生产常量、
  // 也不给生产路径加任何运行期开关。
  it('开关打开时两条渠道各带自己 edition 的空间名（cindy / meka）', async () => {
    vi.resetModules();
    vi.doMock('../clientIdentity.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../clientIdentity.js')>();
      return { ...actual, PLUGIN_SPACE_HEADER_ENABLED: true };
    });
    try {
      const enabledApi = await import('../api');
      sources.serverApiFetch.mockResolvedValue({
        schemaVersion: 2,
        plugins: [],
        nextCursor: null,
      });

      await new enabledApi.PluginMarketApi(undefined, () => '1.2.3').listAll();
      await new enabledApi.MekaPluginMarketApi(() => '2.4.1').listAll();

      expect(sources.serverApiFetch.mock.calls[0]?.[1]?.headers).toEqual({
        'x-cindy-version': '1.2.3',
        [CINDY_PLUGIN_SPACE_HEADER]: 'cindy',
      });
      expect(sources.serverApiFetch.mock.calls[1]?.[1]?.headers).toEqual({
        'x-cindy-version': '2.4.1',
        [CINDY_PLUGIN_SPACE_HEADER]: 'meka',
      });
    } finally {
      vi.doUnmock('../clientIdentity.js');
      vi.resetModules();
    }
  });

  // Meka 渠道的版本兼容下限在 Meka 自己的版本空间里表达。恒发 `0.0.0` 时协议把它当
  // versionless(无条件放行),服务端版本兼容门会整体失效,连正式包也被当成 dev 占位;
  // 所以这里必须证明读取器真的接到了 Meka 请求头上,而不是落到构造默认值。
  it('reports the real client version on the Meka channel instead of 0.0.0', async () => {
    sources.serverApiFetch
      .mockResolvedValueOnce({ schemaVersion: 2, plugins: [], nextCursor: null })
      .mockResolvedValueOnce({
        url: 'https://mcp-router.test.invalid/api/plugin-assets/release-1?expires=1&sig=test',
        expiresAt: '2026-07-23T00:05:00.000Z',
        sha256: 'a'.repeat(64),
        sizeBytes: 42,
      })
      .mockResolvedValueOnce({ schemaVersion: 2, plugins: [], nextCursor: null });
    const api = new MekaPluginMarketApi(() => '2.4.1');

    await api.listAll();
    await api.download(PLUGIN_A, 'release-1');
    // 同一轮里跑一遍 Cindy 渠道:证明版本头由各渠道**各自的**读取器决定,
    // Meka 的改动没有牵动上游渠道。
    await new PluginMarketApi(undefined, () => '9.9.9').listAll();

    const mekaVersions = sources.serverApiFetch.mock.calls
      .slice(0, 2)
      .map((call) => call[1]?.headers?.['x-cindy-version']);
    expect(mekaVersions).toEqual(['2.4.1', '2.4.1']);
    expect(mekaVersions).not.toContain('0.0.0');
    expect(sources.serverApiFetch.mock.calls[2]?.[1]).toMatchObject({
      headers: { 'x-cindy-version': '9.9.9' },
    });
  });

  // 版本读取器是构造第二个参数,不能被误当成配置检查器:isConfigured() 仍只认
  // MCPRouter 绑定状态(mekaConfigured() 覆写)。
  it('keeps the Meka configured check on the Router binding, not on the version reader', async () => {
    sources.mekaRegistryFails = true;
    await expect(new MekaPluginMarketApi(() => '2.4.1').isConfigured()).resolves.toBe(false);

    sources.mekaRegistryFails = false;
    await expect(new MekaPluginMarketApi(() => '2.4.1').isConfigured()).resolves.toBe(true);
  });

  it('accepts Meka Plugin details that declare the Host confirm slot', async () => {
    const item = summary(PLUGIN_A, 'meka-p4');
    sources.serverApiFetch.mockResolvedValue({
      schemaVersion: 2,
      plugin: {
        ...item,
        currentRelease: {
          ...item.currentRelease,
          manifest: {
            schemaVersion: 2,
            id: item.ghostId,
            name: item.name,
            version: item.currentRelease.version,
            kind: 'chip',
            entry: 'main.js',
            slots: ['tool', 'confirm'],
            tools: [{ name: 'submit', description: 'Submit confirmed files' }],
          },
        },
      },
    });

    await expect(
      new MekaPluginMarketApi(pluginClientVersionReader('meka')).detail(PLUGIN_A),
    ).resolves.toMatchObject({
      currentRelease: { manifest: { slots: ['tool', 'confirm'] } },
    });
    expect(sources.serverApiFetch).toHaveBeenCalledWith(
      `/api/plugins/${PLUGIN_A}`,
      expect.objectContaining({ token: 'meka-client-key' }),
    );
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
    const api = new MekaPluginMarketApi(pluginClientVersionReader('meka'));

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
    const api = new MekaPluginMarketApi(pluginClientVersionReader('meka'));

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
    const api = new MekaPluginMarketApi(pluginClientVersionReader('meka'));

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

  it('surfaces currentOrganization from the completed list response', async () => {
    const fetcher = pagedFetcher(
      {
        plugins: [summary(PLUGIN_A, 'alpha')],
        nextCursor: PLUGIN_A,
        currentOrganization: { organizationId: 'org-acme', pluginPrefix: 'acme' },
      },
      {
        plugins: [summary(PLUGIN_B, 'beta')],
        nextCursor: null,
        currentOrganization: { organizationId: 'org-acme', pluginPrefix: 'acme' },
      },
    );

    await expect(new PluginMarketApi(fetcher).listAll()).resolves.toMatchObject({
      plugins: [{ id: PLUGIN_A }, { id: PLUGIN_B }],
      currentOrganization: { organizationId: 'org-acme', pluginPrefix: 'acme' },
    });
  });

  // 服务端是否每页都重复下发 currentOrganization 没有写进契约。若它只在首页带,
  // 逐页覆盖会让后续页的 null 抹掉身份事实,多页目录的组织就永远缓存不到前缀。
  // 上面那条用例两页都带了值,所以在"每页重复"的假设下必过、抓不到这个问题。
  it('keeps the first non-null currentOrganization across later pages that omit it', async () => {
    const fetcher = pagedFetcher(
      {
        plugins: [summary(PLUGIN_A, 'alpha')],
        nextCursor: PLUGIN_A,
        currentOrganization: { organizationId: 'org-acme', pluginPrefix: 'acme' },
      },
      {
        plugins: [summary(PLUGIN_B, 'beta')],
        nextCursor: null,
        currentOrganization: null,
      },
    );

    await expect(new PluginMarketApi(fetcher).listAll()).resolves.toMatchObject({
      plugins: [{ id: PLUGIN_A }, { id: PLUGIN_B }],
      currentOrganization: { organizationId: 'org-acme', pluginPrefix: 'acme' },
    });
  });

  it('keeps a null currentOrganization as a personal-identity fact', async () => {
    const fetcher = pagedFetcher({
      plugins: [summary(PLUGIN_A, 'alpha')],
      nextCursor: null,
      currentOrganization: null,
    });

    await expect(new PluginMarketApi(fetcher).listAll()).resolves.toMatchObject({
      currentOrganization: null,
    });
  });
});
