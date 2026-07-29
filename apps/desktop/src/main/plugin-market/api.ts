import {
  parseGetPluginResponse,
  parseListPluginsResponse,
  parsePluginDownloadResponse,
  type GetPluginResponse,
  type ListPluginsResponse,
  type PluginDownloadResponse,
} from '@cindy/plugin-protocol';

import { getClientEndpoint } from '../clientEndpointsService.js';
import { getMekaRouterService } from '../meka-settings/ipc.js';
import { serverApiFetch, type ApiFetchOptions } from '../serverApiClient.js';

type Fetcher = <T>(
  apiPath: string,
  options: Omit<ApiFetchOptions, 'baseUrl'>,
) => Promise<T>;

const defaultFetcher: Fetcher = (apiPath, options) =>
  serverApiFetch(apiPath, {
    ...options,
    baseUrl: getClientEndpoint('pluginApiBaseUrl'),
  });

async function defaultConfigured(): Promise<boolean> {
  return Boolean(getClientEndpoint('pluginApiBaseUrl'));
}

const AUTHENTICATED_PLUGIN_PREFIX = '/api/plugins';
const PUBLIC_PLUGIN_PREFIX = '/api/public/plugins';

function mekaDeliveryPath(apiPath: string, authenticated: boolean): string {
  if (
    apiPath !== AUTHENTICATED_PLUGIN_PREFIX &&
    !apiPath.startsWith(`${AUTHENTICATED_PLUGIN_PREFIX}/`) &&
    !apiPath.startsWith(`${AUTHENTICATED_PLUGIN_PREFIX}?`)
  ) {
    throw new Error('Unexpected MCPRouter plugin delivery path');
  }
  return authenticated
    ? apiPath
    : `${PUBLIC_PLUGIN_PREFIX}${apiPath.slice(AUTHENTICATED_PLUGIN_PREFIX.length)}`;
}

const mekaFetcher: Fetcher = async (apiPath, options) => {
  const { baseUrl, clientKey } = await getMekaRouterService().getPluginRegistryAccess();
  return serverApiFetch(mekaDeliveryPath(apiPath, clientKey !== null), {
    ...options,
    baseUrl,
    ...(clientKey ? { token: clientKey } : {}),
    skipAutoRefresh: true,
    redactErrorDetails: true,
  });
};

async function mekaConfigured(): Promise<boolean> {
  try {
    await getMekaRouterService().getPluginRegistryAccess();
    return true;
  } catch {
    return false;
  }
}

/** plugin-server 普通客户端 API；每个响应都经过共享 v2 parser fail-closed。 */
export class PluginMarketApi {
  private readonly fetcher: Fetcher;
  private readonly configured: () => Promise<boolean>;

  constructor(fetcher: Fetcher = defaultFetcher, configured?: () => Promise<boolean>) {
    this.fetcher = fetcher;
    this.configured =
      configured ?? (fetcher === defaultFetcher ? defaultConfigured : async () => true);
  }

  isConfigured(): Promise<boolean> {
    return this.configured();
  }

  async listAll(query?: string): Promise<ListPluginsResponse['plugins']> {
    const plugins: ListPluginsResponse['plugins'] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const search = new URLSearchParams({ scope: 'all', limit: '100' });
      if (query?.trim()) search.set('query', query.trim());
      if (cursor) search.set('cursor', cursor);
      const response = parseListPluginsResponse(
        await this.fetcher<unknown>(`/api/plugins?${search.toString()}`, {
          cache: 'no-store',
        }),
      );
      for (const plugin of response.plugins) {
        if (seen.has(plugin.id)) continue;
        seen.add(plugin.id);
        plugins.push(plugin);
      }
      if (!response.nextCursor) return plugins;
      if (response.nextCursor === cursor) throw new Error('Plugin 市场分页游标未前进');
      cursor = response.nextCursor;
    }
    throw new Error('Plugin 市场分页超过安全上限');
  }

  async detail(pluginId: string): Promise<GetPluginResponse['plugin']> {
    return parseGetPluginResponse(
      await this.fetcher<unknown>(`/api/plugins/${encodeURIComponent(pluginId)}`, {
        cache: 'no-store',
      }),
    ).plugin;
  }

  async download(
    pluginId: string,
    releaseId: string,
  ): Promise<PluginDownloadResponse> {
    const response = await this.fetcher<unknown>(
      `/api/plugins/${encodeURIComponent(pluginId)}/releases/${encodeURIComponent(releaseId)}/download`,
      { cache: 'no-store' },
    );
    return parsePluginDownloadResponse(response);
  }
}

/**
 * MCPRouter-backed Meka distribution channel. It deliberately shares the v2
 * parser with the Cindy market while selecting an anonymous public surface or
 * an authenticated user-visible surface from the current Router binding.
 */
export class MekaPluginMarketApi extends PluginMarketApi {
  constructor() {
    super(mekaFetcher, mekaConfigured);
  }
}
