import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PluginInstanceRecord, PluginInstanceReceiptFact } from '../pluginInstanceRegistry';
import type { PluginMarketAuthorizationLookup, PluginMarketInstallationRecord } from '../../plugin-market/ledger';
import { projectPluginPublishingSource } from '../pluginPublishingSource';

const record: PluginInstanceRecord = { instanceKey: '_root__example', contentRelId: '_ns/_root/example',
  ghostId: 'example', namespace: null, namespaceState: 'confirmed', source: 'manual', pluginId: null,
  receiptRevision: 'revision', packageSha256: 'a'.repeat(64), active: true };
const receipt: PluginInstanceReceiptFact = { ghostId: 'example', hasNamespace: true, namespace: null,
  revision: 'revision', packageSha256: 'a'.repeat(64) };
const market: PluginMarketInstallationRecord = { pluginId: 'public-id', ghostId: 'example', namespace: null,
  releaseId: 'release', version: '1.0.0', sha256: 'a'.repeat(64), scope: 'public', organizationId: null,
  source: 'market', installed: true, updatedAt: '2026-10-20T00:00:00.000Z' };
// Meka 渠道（`meka-ledger.v1.json`）的同类记录：MCPR 装的插件只写这一份账本。
const mekaMarket: PluginMarketInstallationRecord = { ...market, pluginId: 'meka-public-id' };

/** 懒读取器的替身：调用即返回固定的第二渠道账本事实。 */
const mekaLedger = (lookup: PluginMarketAuthorizationLookup) => () => lookup;

describe('publishing provenance does not grant authorship', () => {
  it('permits a verified local package path but refuses unreadable evidence and legacy guesses', () => {
    expect(projectPluginPublishingSource(record, receipt, { kind: 'absent' })).toEqual({ kind: 'local', source: 'manual' });
    expect(projectPluginPublishingSource(record, undefined, { kind: 'absent' }).kind).toBe('unavailable');
    expect(projectPluginPublishingSource(record, receipt, { kind: 'invalid' }).kind).toBe('unavailable');
    expect(projectPluginPublishingSource({ ...record, source: 'legacy' }, receipt, { kind: 'absent' }).kind).toBe('unavailable');
    expect(projectPluginPublishingSource(record, { ...receipt, revision: 'replacement' }, { kind: 'absent' }).kind).toBe('unavailable');
  });
  it.each(['git-market', 'local-market'] as const)('does not turn %s installation into first publication', source => {
    expect(projectPluginPublishingSource(record, receipt, { kind: 'found', record: { ...market, source } }).kind).toBe('unavailable');
  });
  it('requires the exact public market identity and approved bytes, independently of publishing ACL', () => {
    const installed = { ...record, source: 'market' as const, pluginId: market.pluginId };
    expect(projectPluginPublishingSource(installed, receipt, { kind: 'found', record: market })).toEqual({ kind: 'public-market', pluginId: market.pluginId });
    expect(projectPluginPublishingSource({ ...installed, pluginId: 'other' }, receipt, { kind: 'found', record: market }).kind).toBe('unavailable');
    expect(projectPluginPublishingSource(installed, receipt, { kind: 'absent' }).kind).toBe('unavailable');
    expect(projectPluginPublishingSource(installed, receipt, { kind: 'found', record: { ...market, scope: 'personal' } }).kind).toBe('unavailable');
  });
});


it('projects local authoring identity without treating it as an enterprise or a market source', () => {
  const local = { ...record, namespace: 'local', instanceKey: '_ns__local__example', contentRelId: '_ns/local/example' };
  expect(projectPluginPublishingSource(local, { ...receipt, namespace: 'local' }, { kind: 'absent' }))
    .toEqual({ kind: 'local', source: 'manual' });
  expect(projectPluginPublishingSource(local, receipt, { kind: 'absent' }).kind).toBe('unavailable');
});

/**
 * Bug 依据：`publishingSource` 原先只读 Cindy 账本，MCPR（Meka 渠道）安装的插件在
 * Cindy 账本无记录 → 实例 `source:'manual'` 被判成 `local` → 详情页出现「发布插件」
 * 按钮。来源事实必须把 Meka 账本也作为一等事实，且市场安装不得再退回 local。
 */
describe('Meka 渠道账本参与发布来源判定', () => {
  it('Cindy 账本无记录、Meka 账本有匹配的已安装记录 → 市场安装，不是 local、不是 unavailable', () => {
    expect(projectPluginPublishingSource(record, receipt, { kind: 'absent' },
      mekaLedger({ kind: 'found', record: mekaMarket })))
      .toEqual({ kind: 'public-market', pluginId: 'meka-public-id', channel: 'meka' });
    // Meka 渠道的 personal 可见范围同样来自市场（自然人 id 不是组织身份）。
    expect(projectPluginPublishingSource(record, receipt, { kind: 'absent' },
      mekaLedger({ kind: 'found', record: { ...mekaMarket, scope: 'personal', organizationId: 'user-1' } })))
      .toEqual({ kind: 'public-market', pluginId: 'meka-public-id', channel: 'meka' });
  });

  it('Meka 账本 invalid 或读取抛错都 fail-closed 成 unavailable，不退回 local', () => {
    expect(projectPluginPublishingSource(record, receipt, { kind: 'absent' },
      mekaLedger({ kind: 'invalid' }))).toEqual({ kind: 'unavailable' });
    expect(projectPluginPublishingSource(record, receipt, { kind: 'absent' },
      () => { throw new Error('meka ledger unreadable'); })).toEqual({ kind: 'unavailable' });
    // Cindy 账本损坏时同样不因 Meka 记录而放行。
    expect(projectPluginPublishingSource(record, receipt, { kind: 'invalid' },
      mekaLedger({ kind: 'found', record: mekaMarket }))).toEqual({ kind: 'unavailable' });
  });

  it('两边都无记录时 manual 仍是本地安装语义', () => {
    expect(projectPluginPublishingSource(record, receipt, { kind: 'absent' }, mekaLedger({ kind: 'absent' })))
      .toEqual({ kind: 'local', source: 'manual' });
  });

  it('Meka 记录对不上这次已批准安装时既不当市场安装也不退回 local', () => {
    const mismatches: PluginMarketInstallationRecord[] = [
      { ...mekaMarket, installed: false },
      { ...mekaMarket, sha256: 'b'.repeat(64) },
      { ...mekaMarket, ghostId: 'another-ghost' },
      { ...mekaMarket, source: 'git-market' },
      { ...mekaMarket, scope: 'organization', organizationId: 'org-1' },
      { ...mekaMarket, namespace: 'acme' },
    ];
    for (const mismatch of mismatches) {
      expect(projectPluginPublishingSource(record, receipt, { kind: 'absent' },
        mekaLedger({ kind: 'found', record: mismatch })).kind).toBe('unavailable');
    }
    // 显式 Forge 自测安装与 local namespace 的本地开发副本保持原判据，不被市场账本覆盖。
    expect(projectPluginPublishingSource({ ...record, source: 'agent-forge' }, receipt, { kind: 'absent' },
      mekaLedger({ kind: 'found', record: mekaMarket }))).toEqual({ kind: 'local', source: 'agent-forge' });
    expect(projectPluginPublishingSource({ ...record, namespace: 'local' }, { ...receipt, namespace: 'local' },
      { kind: 'absent' }, mekaLedger({ kind: 'found', record: mekaMarket })))
      .toEqual({ kind: 'local', source: 'manual' });
  });

  it('Cindy 账本已有记录时不读 Meka 账本（两渠道优先级）', () => {
    let reads = 0;
    const source = projectPluginPublishingSource({ ...record, source: 'market', pluginId: market.pluginId },
      receipt, { kind: 'found', record: market },
      () => { reads += 1; return { kind: 'found', record: mekaMarket }; });
    expect(source).toEqual({ kind: 'public-market', pluginId: market.pluginId });
    expect(reads).toBe(0);
  });
});

/**
 * Guard（跨文件契约）：两处生产投影都必须把 Meka 渠道账本作为第二来源事实。
 * 只改 `projectPluginPublishingSource` 而不接线时单测全绿、线上按钮照旧出现；
 * 列表（快照）与详情（逐实例）任意一处漏接，两边来源判定就会各说一套。
 */
describe('生产接线把 Meka 渠道账本接进两处来源投影', () => {
  it('sourcesForInstance 与 prepareListingSources 都注入 Meka 账本事实', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).toContain('readMekaMarketInstallation(record.ghostId, record.namespace)');
    expect(source).toContain('createMekaLedgerListingLookup()');
  });
});
