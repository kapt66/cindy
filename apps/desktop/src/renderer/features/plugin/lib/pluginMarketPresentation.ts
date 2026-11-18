/**
 * Maps server authorization scope into the client-facing source taxonomy.
 *
 * Scope is the source of truth for visibility and publishing authority. Whether a
 * public Plugin is installed by default is an installation policy, not a source.
 * An installed Ghost without a matching market record remains local.
 */
import type { GhostInstallApproval } from '../../../../shared/ghost';
import {
  createPluginLogicalIdentity,
  findInstalledGhostByIdentity,
  hasDeliveryNamespace,
  installedGhostStoragePart,
} from '../../../../shared/pluginIdentity';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';
import type { PluginMarketSurface } from './pluginMarketSurface';

/**
 * `personal-meka` 只表示「Meka 渠道的 personal scope」，不等于「仅自己」：MCPRouter 的
 * private 与 shared 都被协议投影成 personal，客户端目前无法区分两者。
 */
export type PluginPresentationOrigin =
  | 'public'
  | 'organization'
  | 'local'
  | 'custom'
  | 'personal-meka';

/** Public contributors stay anonymous even when an older payload includes an author. */
export function pluginPresentationAuthor(
  item: Pick<PluginMarketItem, 'scope' | 'sourceType' | 'publisherKind' | 'author'>,
): string | null {
  return item.sourceType === 'server' && item.scope === 'public' && item.publisherKind !== 'official'
    ? null : item.author;
}

export type PluginCatalogPresentationItem<TInstalled> =
  { kind: 'installed'; item: TInstalled } | { kind: 'market'; item: PluginMarketItem };

export function pluginPresentationOrigin(
  item: Pick<PluginMarketItem, 'scope' | 'sourceType'> | null | undefined,
  surface: PluginMarketSurface = 'plugins',
): PluginPresentationOrigin {
  // 自定义市场（Git / 本地源）归 'custom'，与服务端 scope 正交。
  if (item && item.sourceType !== 'server') return 'custom';
  if (item?.scope === 'public' || item?.scope === 'organization') {
    return item.scope;
  }
  // Cindy 渠道：personal 发布刻意不暴露给客户端，taxonomy 保持封闭（旧/新服务端返回也不放行）。
  // Meka 渠道：MCPRouter 的可见性只有 private / public / shared，协议把它投影成 personal
  // （见 `main/plugin-market/api.ts` 的 `mekaDetailParseOptions`），它不是「从本机安装」，
  // 所以不能再落到 'local'。private 与 shared 在协议里分不开，只能显示中性文案
  // （`personal-meka`），要分开必须由协议补字段，客户端不得猜。
  if (item?.scope === 'personal' && surface === 'meka') return 'personal-meka';
  return 'local';
}

/**
 * Main's install state is authoritative for the update affordance.
 *
 * A same-version `update-available` item can be a legacy-adopted install whose
 * bytes have not been verified against the market release. Version equality
 * alone cannot suppress that replacement path; same-release metadata refreshes
 * are already reported as `installed` by Main.
 */
export function pluginUpdateForInstalledVersion(
  item: PluginMarketItem | null | undefined,
): PluginMarketItem | null {
  return item?.installState === 'update-available' ? item : null;
}

/**
 * Whether the market install flow may run against an already-installed Plugin.
 *
 * A pending release is the usual case. The same release is also allowed when the
 * installation record is incomplete: reinstalling that exact release restores
 * the Host receipt. Without an approved baseline Main cannot prove the previous
 * permissions, so it asks the user as for a first install. A verified install at
 * the current release has nothing to recover.
 */
export function marketReviewTargetsInstalledGhost(
  item: Pick<PluginMarketItem, 'installState'> | null | undefined,
  approvalState: GhostInstallApproval['state'] | undefined,
): boolean {
  if (item?.installState === 'update-available') return true;
  return (
    item?.installState === 'installed' &&
    approvalState !== undefined &&
    approvalState !== 'approved'
  );
}

/**
 * Where an unverifiable install is recovered. Market-owned installs redownload
 * the bound release; anything else needs the user to point at a `.cindy` package.
 * Both routes revalidate real bytes and restore the installation record without
 * creating a separate capability authorization flow.
 */
export function ghostReapprovalRoute(
  item: Pick<PluginMarketItem, 'installState'> | null | undefined,
): 'market' | 'local-package' {
  return item?.installState === 'installed' || item?.installState === 'update-available'
    ? 'market'
    : 'local-package';
}

/**
 * Bind a market row to the installed instance it is allowed to update.
 *
 * An explicit namespace must hit that logical identity. A legacy row
 * (missing namespace) binds the physical root, including an
 * in-place stamped plugin whose storage part is still the bare ghostId. It must
 * not fall through to a `_ns/...` twin.
 */
export function findInstalledGhostForMarketItem<
  T extends {
    manifest: { id: string };
    dir?: string;
    namespace?: string | null;
  },
>(ghosts: readonly T[], item: Pick<PluginMarketItem, 'ghostId' | 'namespace'>): T | undefined {
  const sameId = ghosts.filter((ghost) => ghost.manifest.id === item.ghostId);
  if (sameId.length === 0) return undefined;
  if (hasDeliveryNamespace(item)) {
    return findInstalledGhostByIdentity(
      sameId,
      createPluginLogicalIdentity(item.namespace, item.ghostId),
    );
  }
  return sameId.find((ghost) => installedGhostStoragePart(ghost) === item.ghostId);
}

/** True when this market row is the update/origin route for this installed instance. */
export function marketItemMatchesInstalledGhost(
  item: Pick<PluginMarketItem, 'ghostId' | 'namespace'>,
  ghost: { manifest: { id: string }; dir?: string; namespace?: string | null },
): boolean {
  if (item.ghostId !== ghost.manifest.id) return false;
  if (hasDeliveryNamespace(item) && hasDeliveryNamespace(ghost)) {
    return item.namespace === ghost.namespace;
  }
  if (hasDeliveryNamespace(item) && item.namespace !== null) return false;
  return installedGhostStoragePart(ghost) === item.ghostId;
}

export function marketItemForInstalledGhost(
  items: readonly PluginMarketItem[],
  ghost: { manifest: { id: string }; dir?: string; namespace?: string | null },
): PluginMarketItem | null {
  return items.find((item) =>
    (item.installState === 'installed' || item.installState === 'update-available') &&
    marketItemMatchesInstalledGhost(item, ghost)) ?? null;
}

/**
 * Keeps the complete catalog in server order while rendering an installed card
 * for market records already owned by this client. Local-only installs have no
 * server position, so they remain visible after the ordered market catalog.
 */
export function orderPluginCatalogItems<TInstalled extends { id: string }>(
  marketItems: readonly PluginMarketItem[],
  installedItems: readonly TInstalled[],
  availableMarketItems: readonly PluginMarketItem[],
): PluginCatalogPresentationItem<TInstalled>[] {
  const installedByGhostId = new Map(installedItems.map((item) => [item.id, item]));
  const availableByPluginId = new Map(availableMarketItems.map((item) => [item.pluginId, item]));
  const emittedInstalledIds = new Set<string>();
  const ordered: PluginCatalogPresentationItem<TInstalled>[] = [];

  for (const marketItem of marketItems) {
    const availableItem = availableByPluginId.get(marketItem.pluginId);
    if (
      availableItem &&
      (marketItem.installState === 'not-installed' || marketItem.installState === 'conflict')
    ) {
      ordered.push({ kind: 'market', item: availableItem });
    }
    if (
      marketItem.installState !== 'installed' &&
      marketItem.installState !== 'update-available' &&
      marketItem.installState !== 'conflict'
    ) {
      continue;
    }
    const installedItem = installedByGhostId.get(marketItem.ghostId);
    if (!installedItem || emittedInstalledIds.has(installedItem.id)) continue;
    emittedInstalledIds.add(installedItem.id);
    ordered.push({ kind: 'installed', item: installedItem });
  }

  for (const installedItem of installedItems) {
    if (emittedInstalledIds.has(installedItem.id)) continue;
    ordered.push({ kind: 'installed', item: installedItem });
  }
  return ordered;
}

/** 目录不按名字推测账号依赖；包确认和运行时根据真实声明处理。 */
export function canOfferMarketInstall(
  mode: 'signed-out' | 'local' | 'cloud',
  _ghostId: string,
): boolean {
  if (mode === 'signed-out') return false;
  return true;
}
