import { hasDeliveryNamespace, isOrganizationPluginNamespace } from '../../shared/pluginIdentity.js';
import type { InstalledGhost } from '../../shared/ghost.js';
import type { PluginMarketAuthorizationLookup, PluginMarketInstallationRecord } from '../plugin-market/ledger.js';
import type { PluginInstanceRecord, PluginInstanceReceiptFact } from './pluginInstanceRegistry.js';

/**
 * 第二来源渠道（Meka 渠道 `meka-ledger.v1.json`）的只读查询。
 *
 * **懒执行**：只有 Cindy 账本对这条实例完全没有记录时才会被调用；Cindy 账本已有记录
 * 时不会多读一份账本。抛错按 `invalid`（fail-closed）处理。
 */
export type ChannelMarketLookupReader = () => PluginMarketAuthorizationLookup;

/**
 * Rebuilt from existing Host facts; never grants authorship or changes installation state.
 *
 * 来源事实按渠道合并：先读 Cindy 账本（`ledger.v1.json`），只有它**没有这条实例的记录**
 * 时才把第二条分发渠道（Meka，`meka-ledger.v1.json`）当来源事实。任一侧账本
 * `invalid`（文件存在但不可读／不合法）都必须 fail-closed 成 `unavailable`——账本损坏
 * 不是「无记录」，不得借此退回 `local` 的作者语义。命中 Meka 渠道市场安装时投影成
 * `public-market` + `channel:'meka'`：与 Cindy 市场安装同属「市场安装」，绝不再判成
 * `local`（否则 MCPR 装的插件会出现「发布插件」按钮，并被本地分享／本地更新覆盖）。
 */
export function projectPluginPublishingSource(
  record: PluginInstanceRecord,
  receipt: PluginInstanceReceiptFact | null | undefined,
  lookup: PluginMarketAuthorizationLookup,
  readChannelMarket?: ChannelMarketLookupReader,
): NonNullable<InstalledGhost['publishingSource']> {
  const unavailable = { kind: 'unavailable' } as const;
  if (!record.active || record.namespaceState !== 'confirmed' || isOrganizationPluginNamespace(record.namespace) ||
    !receipt || !receipt.hasNamespace || receipt.namespace !== record.namespace || receipt.ghostId !== record.ghostId ||
    receipt.revision !== record.receiptRevision || receipt.packageSha256 !== record.packageSha256 ||
    lookup.kind === 'invalid') return unavailable;
  // 没有任何市场记录时的既有本地语义：只有 manual / agent-forge 是本机作者包，
  // `legacy` 等来源在账本事实缺失时仍然是 unavailable。
  const localSource = (): NonNullable<InstalledGhost['publishingSource']> =>
    record.source === 'manual' || record.source === 'agent-forge'
      ? { kind: 'local', source: record.source } : unavailable;
  const market = lookup.kind === 'found' ? lookup.record : null;
  if (market) {
    if (market.scope !== 'public' || market.organizationId !== null) return unavailable;
    if (market.installed && market.source !== 'market' && market.source !== 'legacy-adopted') return unavailable;
    if (record.source === 'manual' || record.source === 'agent-forge') return localSource();
    if (record.source === 'market' && market.installed && market.namespace === null &&
      market.pluginId === record.pluginId && market.sha256 === receipt.packageSha256)
      return { kind: 'public-market', pluginId: market.pluginId };
    return unavailable;
  }
  // Cindy 账本无记录。只有 root namespace 的 manual 实例可能是 Meka 渠道安装：本地
  // 作者 namespace（`local`）的实例与显式 Forge 自测安装保持原判据，不再多读账本。
  if (record.namespace !== null || record.source !== 'manual') return localSource();
  if (!readChannelMarket) return localSource();
  let channelLookup: PluginMarketAuthorizationLookup;
  try {
    channelLookup = readChannelMarket();
  } catch {
    return unavailable;
  }
  // 账本存在但不可读不是「无记录」：不得退回 local 的发布入口。
  if (channelLookup.kind === 'invalid') return unavailable;
  const channelMarket = channelLookup.kind === 'found' ? channelLookup.record : null;
  if (!channelMarket) return localSource();
  // 账本里有这条 ghost 的记录但对不上这次已批准安装：来源不可确认。fail-closed 成
  // unavailable——既不冒充市场安装，也不退回 local 的作者语义。
  const pluginId = channelMarketPluginId(record, receipt, channelMarket);
  return pluginId === null ? unavailable : { kind: 'public-market', pluginId, channel: 'meka' };
}

/**
 * Meka 渠道记录是否就是这条已批准安装的来源事实。
 *
 * Meka 渠道只把插件装到 root namespace，可见范围是 `public` / `personal`；`public` 不带
 * 组织，`personal` 带自然人 id（不是组织身份），组织 scope 的记录不属于该渠道；不带
 * namespace 的旧记录视为 root。实例注册表只由 Cindy 账本参与扫描，所以 Meka 渠道安装的
 * 实例是 `source:'manual'`、`pluginId:null`——来源事实只能取账本记录，并用已批准 receipt
 * 的 ghostId 与包 sha256 对齐。已经绑定了别的 pluginId 的实例说明身份冲突，拒绝。
 */
function channelMarketPluginId(
  record: PluginInstanceRecord,
  receipt: PluginInstanceReceiptFact,
  market: PluginMarketInstallationRecord,
): string | null {
  if (market.installed !== true || market.source !== 'market') return null;
  if (market.ghostId !== record.ghostId) return null;
  // Meka 渠道只分发 root 安装：`public` 不带组织，`personal` 带自然人 id（不是组织
  // 身份）；组织 scope 的记录不属于该渠道。
  if (market.scope === 'organization') return null;
  if (market.scope === 'public' && market.organizationId !== null) return null;
  if (hasDeliveryNamespace(market) && market.namespace !== null) return null;
  if (!market.pluginId || !receipt.packageSha256) return null;
  if (market.sha256 !== receipt.packageSha256) return null;
  if (record.pluginId !== null && record.pluginId !== market.pluginId) return null;
  return market.pluginId;
}
