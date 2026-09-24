import {
  CINDY_CLIENT_VERSION_HEADER,
  CINDY_PLUGIN_SPACE_HEADER,
  parseGetPluginResponse,
  parseListPluginsResponse,
  parsePluginDownloadResponse,
  type GetPluginResponse,
  type ListPluginsResponse,
  type PluginRemovalNotice,
  type PluginDownloadResponse,
} from '@cindy/plugin-protocol';

import { getClientEndpoint } from '../clientEndpointsService.js';
import { getMekaRouterService } from '../meka-settings/ipc.js';
import { createLogger } from '../logger.js';
import { serverApiFetch, type ApiFetchOptions } from '../serverApiClient.js';
import {
  PLUGIN_SPACE_HEADER_ENABLED,
  pluginSpaceHeaderValue,
  type PluginEdition,
} from './clientIdentity.js';

const log = createLogger('plugin-market-api');
const PLUGIN_MARKET_API_TIMEOUT_MS = 15_000;

type Fetcher = <T>(
  apiPath: string,
  options: Omit<ApiFetchOptions, 'baseUrl'>,
) => Promise<T>;

const defaultFetcher: Fetcher = (apiPath, options) =>
  serverApiFetch(apiPath, {
    ...options,
    baseUrl: () => getClientEndpoint('pluginApiBaseUrl'),
    // 插件市场的 path 都带用户装的插件 ID(`/api/plugins/<pluginId>[/releases/<id>/download]`),
    // 4xx/5xx 落进 serverApiClient 的日志会外泄第三方插件身份。redactErrorDetails 压掉响应
    // 详情,logLabel 用不含 ID 的路由模板代替真实 path(2026-08-06 review)。
    redactErrorDetails: true,
    logLabel: '/api/plugins',
  });

function mekaDeliveryPath(apiPath: string, authenticated: boolean): string {
  const prefix = '/api/plugins';
  if (!apiPath.startsWith(prefix)) throw new Error('Unexpected MCPRouter plugin delivery path');
  return authenticated ? apiPath : `/api/public/plugins${apiPath.slice(prefix.length)}`;
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
  private readonly configured: () => Promise<boolean>;
  private readonly versionReader: () => string;
  constructor(
    private readonly fetcher: Fetcher = defaultFetcher,
    // 默认值只为兼容既有构造签名（单测与"注入 fetcher 的假渠道"会走到它），不代表调用点
    // 可以省略版本：落到 `0.0.0` 等于把该渠道的版本兼容门整体关掉。两条正式渠道的构造点
    // 都必须传自己 edition 的身份读取器（`plugin-market/clientIdentity.ts`），由
    // `__tests__/pluginDistributionContract.test.ts` 的源码级断言兜住"退回无参构造"。
    getClientVersionOrConfigured: (() => string) | (() => Promise<boolean>) = () => '0.0.0',
  ) {
    this.versionReader = () => {
      const value = getClientVersionOrConfigured();
      return typeof value === 'string' ? value : '0.0.0';
    };
    this.configured = async () => {
      const value = getClientVersionOrConfigured();
      return typeof value === 'string' ? true : await value;
    };
  }

  isConfigured(): Promise<boolean> {
    return this.configured();
  }

  /**
   * 该渠道所属的 edition（`cindy` | `meka`）：**空间头取值的唯一来源**，不由请求内容或
   * 服务端自报渠道推断（设计文档 §3.6）。基类默认 `cindy`（上游线），Meka 渠道覆写成 `meka`。
   *
   * 做成覆写点而不是构造参数，是因为两条正式渠道的构造形态由 P1 门禁钉住
   * （`__tests__/pluginDistributionContract.test.ts` 断言 `service.ts` / `registerIpc.ts` 的
   * 构造调用逐字不变），空间头不该去动那两个已落地的构造点。
   */
  protected pluginEdition(): PluginEdition {
    return 'cindy';
  }

  private requestOptions(): Omit<ApiFetchOptions, 'baseUrl'> {
    const headers: Record<string, string> = {
      [CINDY_CLIENT_VERSION_HEADER]: this.versionReader(),
    };
    // 默认关闭：`PLUGIN_SPACE_HEADER_ENABLED === false` 时这一支不执行，请求与今天逐字节相同
    // （不新增任何头）。只有服务端按该头分区投影之后才允许打开——开关与门槛写在
    // `plugin-market/clientIdentity.ts`，与声明工件 `identity.spaceHeader` 双向绑定。
    if (PLUGIN_SPACE_HEADER_ENABLED) {
      headers[CINDY_PLUGIN_SPACE_HEADER] = pluginSpaceHeaderValue(this.pluginEdition());
    }
    return {
      cache: 'no-store',
      headers,
      timeoutMs: PLUGIN_MARKET_API_TIMEOUT_MS,
    };
  }

  async listAll(
    query?: string,
  ): Promise<Pick<ListPluginsResponse, 'plugins' | 'removals' | 'currentOrganization'>> {
    const plugins: ListPluginsResponse['plugins'] = [];
    const removalsByPluginId = new Map<string, PluginRemovalNotice>();
    let currentOrganization: ListPluginsResponse['currentOrganization'] = null;
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const search = new URLSearchParams({ scope: 'all', limit: '100' });
      if (query?.trim()) search.set('query', query.trim());
      if (cursor) search.set('cursor', cursor);
      const response = parseListPluginsResponse(
        await this.fetcher<unknown>(
          `/api/plugins?${search.toString()}`,
          this.requestOptions(),
        ),
      );
      for (const plugin of response.plugins) {
        if (seen.has(plugin.id)) continue;
        seen.add(plugin.id);
        plugins.push(plugin);
      }
      for (const removal of response.removals) {
        if (!removalsByPluginId.has(removal.pluginId)) {
          removalsByPluginId.set(removal.pluginId, removal);
        }
      }
      // 取**第一个非 null** 的值，不要每页覆盖。服务端是否每页都重复下发
      // `currentOrganization` 并没有写进契约(PLAN §6 没有这一条),若它只在首页带，
      // 逐页覆盖会让第二页的 null 把身份事实抹掉——多页目录的组织就永远缓存不到前缀。
      // 两种服务端行为下这个写法都对，且结果确定。
      currentOrganization ??= response.currentOrganization;
      if (!response.nextCursor) {
        // 在架优先(契约:通告与**任一页** plugins 有交集即作废)的作用域是
        // 未经 owner 过滤的完整目录,必须留在聚合层;挪到 service 的 owner
        // 视角之后,owner 不可见但在架的插件会被错误放行清理。
        const removals = [...removalsByPluginId.values()].filter((removal) => {
          if (!seen.has(removal.pluginId)) return true;
          log.warn('market removal ignored because plugin is active', {
            pluginId: removal.pluginId,
          });
          return false;
        });
        return { plugins, removals, currentOrganization };
      }
      if (response.nextCursor === cursor) throw new Error('Plugin 市场分页游标未前进');
      cursor = response.nextCursor;
    }
    throw new Error('Plugin 市场分页超过安全上限');
  }

  async detail(pluginId: string): Promise<GetPluginResponse['plugin']> {
    return parseGetPluginResponse(
      await this.fetcher<unknown>(
        `/api/plugins/${encodeURIComponent(pluginId)}`,
        this.requestOptions(),
      ),
    ).plugin;
  }

  async download(
    pluginId: string,
    releaseId: string,
  ): Promise<PluginDownloadResponse> {
    return parsePluginDownloadResponse(
      await this.fetcher<unknown>(
        `/api/plugins/${encodeURIComponent(pluginId)}/releases/${encodeURIComponent(releaseId)}/download`,
        this.requestOptions(),
      ),
    );
  }
}

/** MCPRouter-backed Meka distribution channel. */
export class MekaPluginMarketApi extends PluginMarketApi {
  /**
   * 身份读取器**必填**（没有默认值）：Meka 渠道的版本兼容下限在 Meka 自己的版本空间
   * （`cindy-meka`）里表达，恒发 `0.0.0` 会被协议判成 versionless 并无条件放行，服务端
   * 版本兼容门整体失效、连正式包也被当成 dev 占位。构造点必须显式提供身份，
   * 使"漏传 → 落到默认 `0.0.0`"在结构上不可能。
   *
   * 取值只有一个来源：`app.getVersion()` 只允许在 `plugin-market/clientIdentity.ts` 里被读，
   * 调用点（`plugin-market/registerIpc.ts` 的 `mekaService()`）传
   * `pluginClientVersionReader('meka')`；该形态由 `__tests__/pluginDistributionContract.test.ts`
   * 做源码级断言，防"退回无参构造"的静默回归。
   */
  constructor(identityVersionReader: () => string) {
    super(mekaFetcher, identityVersionReader);
  }

  /**
   * Meka 渠道属于 `meka` edition：开启空间头后，该渠道发出的是 `x-cindy-plugin-space: meka`
   * （上游渠道是 `cindy`）。取值只由这里的 edition 决定。
   */
  protected override pluginEdition(): PluginEdition {
    return 'meka';
  }

  isConfigured(): Promise<boolean> {
    return mekaConfigured();
  }
}
