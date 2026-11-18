import { afterEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { pluginCatalogMemory, pluginCatalogOwnerKey, readLocalPluginSnapshot, resetPluginCatalogMemoryForTest } from '../lib/pluginCatalogMemory';
import { schedulePluginCatalogPrewarm } from '../lib/prewarmPluginCatalog';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetPluginCatalogMemoryForTest(); });

// Unit: login preheat must use the page's exact owner/language bucket, and must
// not scan/count a market the user has not opened. The navigation suite only
// exercises mounted routes and cannot cover idle work or owner changes.
it('prewarms installed data and recommendations once per owner, sharing the page bucket', async () => {
  vi.useFakeTimers();
  setDataOwnerGeneration('warm-owner', 31);
  const snapshot = vi.fn(async () => ({ items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] }));
  const recommendations = vi.fn(async () => []);
  const query = vi.fn();
  vi.stubGlobal('window', { electronAPI: { pluginMarket: { snapshot, recommendations, query }, setApplicationMenuLocale: vi.fn().mockResolvedValue(undefined) } });
  const input = { mode: 'cloud' as const, ownerId: 'warm-owner', generation: 31, locale: 'en' };
  schedulePluginCatalogPrewarm(input);
  await vi.advanceTimersByTimeAsync(300);
  await vi.dynamicImportSettled();
  const memory = pluginCatalogMemory(pluginCatalogOwnerKey(input.mode, input.ownerId, input.generation, input.locale), 'local', 'plugins');
  expect(memory.snapshot?.items).toEqual([]);
  expect(memory.todayLoaded).toBe(true);
  expect(snapshot).toHaveBeenCalledOnce();
  expect(recommendations).toHaveBeenCalledOnce();
  expect(query).not.toHaveBeenCalled();
  schedulePluginCatalogPrewarm(input);
  await vi.runOnlyPendingTimersAsync();
  expect(snapshot).toHaveBeenCalledOnce();
});

it('does not fetch or publish data after the owner changes before idle execution', async () => {
  vi.useFakeTimers();
  setDataOwnerGeneration('outgoing-owner', 41);
  const snapshot = vi.fn();
  vi.stubGlobal('window', { electronAPI: { pluginMarket: { snapshot } } });
  schedulePluginCatalogPrewarm({ mode: 'cloud', ownerId: 'outgoing-owner', generation: 41, locale: 'en' });
  setDataOwnerGeneration(null, 42);
  await vi.runOnlyPendingTimersAsync();
  expect(snapshot).not.toHaveBeenCalled();
});

// Unit / §6.74: the Meka page's catalog must come from the Meka channel, and the
// per-surface memory slot must keep both caches apart. Before the fix every surface
// read `pluginMarket.snapshot` and the second page could reuse the first one's data.
it('reads each surface from its own market channel with separate snapshot caches', async () => {
  const cindySnapshot = vi.fn(async () => ({ items: [], unavailableReason: null, customSourceNames: ['cindy'], unavailableCustomSourceNames: [] }));
  const mekaSnapshot = vi.fn(async () => ({ items: [], unavailableReason: null, customSourceNames: ['meka'], unavailableCustomSourceNames: [] }));
  vi.stubGlobal('window', { electronAPI: {
    pluginMarket: { snapshot: cindySnapshot },
    mekaPluginMarket: { snapshot: mekaSnapshot },
  } });
  const cindy = pluginCatalogMemory('surface-owner', 'local', 'plugins');
  const meka = pluginCatalogMemory('surface-owner', 'local', 'meka');
  expect(meka).not.toBe(cindy);
  expect((await readLocalPluginSnapshot(meka)).customSourceNames).toEqual(['meka']);
  expect((await readLocalPluginSnapshot(cindy)).customSourceNames).toEqual(['cindy']);
  expect(mekaSnapshot).toHaveBeenCalledOnce();
  expect(cindySnapshot).toHaveBeenCalledOnce();
  // 重读各自走本 surface 的缓存，不会串到另一渠道。
  expect(await readLocalPluginSnapshot(meka)).toBe(meka.snapshot);
  expect(await readLocalPluginSnapshot(cindy)).toBe(cindy.snapshot);
  expect(mekaSnapshot).toHaveBeenCalledOnce();
  expect(cindySnapshot).toHaveBeenCalledOnce();
});

// Unit / Codex C1: Main reports source failures alongside successful custom
// results. Prewarm-only empty snapshots missed the warm-cache rejection and
// loss of partial data. The read entry must retain only failed source items.
it('accepts successful custom sources while retaining unavailable source projections', async () => {
  const memory = pluginCatalogMemory('partial-sources', 'local', 'plugins');
  type Item = NonNullable<typeof memory.snapshot>['items'][number];
  const item = (id: string, source: string | null, version = '1.0.0'): Item => ({ pluginId: id, ghostId: id, name: id,
    description: null, author: null, scope: 'public', organizationId: null, defaultInstall: false,
    releaseId: id, version, publishedAt: '2026-11-01T00:00:00Z', icon: null, installState: 'not-installed', enabled: null,
    sourceType: source === null ? 'server' : 'local-market', sourceMarketName: source });
  const official = item('official', null), failed = item('failed', 'unreachable');
  memory.snapshot = { items: [official, item('updated', 'working'), failed, item('removed', 'deleted')],
    unavailableReason: null, customSourceNames: ['working', 'unreachable', 'deleted'], unavailableCustomSourceNames: [] };
  const next = { items: [item('updated', 'working', '2.0.0'), item('added', 'new-source')],
    unavailableReason: 'official offline', customSourceNames: ['working', 'unreachable', 'new-source'],
    unavailableCustomSourceNames: ['unreachable'] };
  const snapshot = vi.fn().mockResolvedValue(next);
  vi.stubGlobal('window', { electronAPI: { pluginMarket: { snapshot } } });
  const result = await readLocalPluginSnapshot(memory, true);
  expect(result.items).toEqual([official, failed, ...next.items]);
  expect(result.items[0]).toBe(official);
  expect(result.items[1]).toBe(failed);
  expect(result.customSourceNames).toEqual(next.customSourceNames);
  expect(result.unavailableReason).toBe('official offline');
  memory.snapshot = result;
  expect(await readLocalPluginSnapshot(memory, true)).toBe(result);
  snapshot.mockResolvedValue({ ...next, items: [item('official', null, '3.0.0')],
    unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] });
  const recovered = await readLocalPluginSnapshot(memory, true);
  expect(recovered.items.map(item => item.pluginId)).toEqual(['official']);
  expect(recovered.items[0].version).toBe('3.0.0');
});

// Unit / C1 convergence: locale sync can read immediately after a forced
// request settles but before the page publishes it. A fresh timestamp must
// never make that second reader receive the previous snapshot.
it('publishes a completed snapshot with its freshness before a warm reader can reuse it', async () => {
  const memory = pluginCatalogMemory('atomic-snapshot', 'local', 'plugins');
  memory.snapshot = { items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] };
  const next = { ...memory.snapshot, customSourceNames: ['changed-off-page'] };
  const snapshot = vi.fn().mockResolvedValue(next);
  vi.stubGlobal('window', { electronAPI: { pluginMarket: { snapshot } } });
  const updated = await readLocalPluginSnapshot(memory, true);
  expect(await readLocalPluginSnapshot(memory)).toBe(updated);
  expect(snapshot).toHaveBeenCalledOnce();
});
