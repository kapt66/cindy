/** Shared market operations exposed by both the Cindy and Meka distribution channels. */
export type PluginMarketSurfaceApi = Pick<
  Window['electronAPI']['pluginMarket'],
  'snapshot' | 'detail' | 'uninstall' | 'markLocalInstall'
>;

export type PluginMarketSurface = 'plugins' | 'meka';

interface PluginMarketChannels {
  pluginMarket: PluginMarketSurfaceApi;
  mekaPluginMarket: PluginMarketSurfaceApi;
}

/** Keep every shared market operation on the channel selected by the current page surface. */
export function pluginMarketApiForSurface(
  surface: PluginMarketSurface,
  channels: PluginMarketChannels,
): PluginMarketSurfaceApi {
  return surface === 'meka' ? channels.mekaPluginMarket : channels.pluginMarket;
}
