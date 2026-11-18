/**
 * Regression coverage for routing shared Plugin market operations by page surface.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { pluginMarketApiForSurface, type PluginMarketSurfaceApi } from '../lib/pluginMarketSurface';

const pluginRoot = resolve(__dirname, '..');
const pageSource = readFileSync(resolve(pluginRoot, 'GhostPluginPage.tsx'), 'utf8');

function libSources(directory: string, prefix = 'lib'): Array<{ file: string; source: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return libSources(path, `${prefix}/${entry.name}`);
    return /\.(ts|tsx)$/.test(entry.name)
      ? [{ file: `${prefix}/${entry.name}`, source: readFileSync(path, 'utf8') }]
      : [];
  });
}

const pageAndLibSources = [
  { file: 'GhostPluginPage.tsx', source: pageSource },
  ...libSources(resolve(pluginRoot, 'lib')),
];

/**
 * Every remaining direct `window.electronAPI.<channel>.<method>` call needs a reason
 * here. Shared market operations must go through `pluginMarketApiForSurface`; an
 * undocumented direct call is how the Meka page's catalog snapshot silently read Cindy.
 */
const ALLOWED_DIRECT_CHANNEL_CALLS: Record<string, readonly string[]> = {
  // 安装按 surface 显式分流（Meka 走 mekaPluginMarket.install）；前台刷新订阅与分页查询
  // 只属于 plugins 面（Meka 渲染分支不渲染分页浏览），其余是 Meka 渠道专属能力。
  'GhostPluginPage.tsx': [
    'pluginMarket.install',
    'pluginMarket.onUpdateConsentHoldsChanged',
    'pluginMarket.query',
    'mekaPluginMarket.install',
    'mekaPluginMarket.onInstallProgress',
    'mekaPluginMarket.installedGhostIds',
  ],
  // Meka 渠道没有 recommendations 端点；推荐位只在 plugins 面渲染。
  'lib/pluginCatalogMemory.ts': ['pluginMarket.recommendations'],
  // 批量更新的 Cindy 默认适配器；Meka 面总会传入自己的 updateAllMarketApi。
  'lib/updateAllController.ts': ['pluginMarket.detail', 'pluginMarket.install'],
  // Meka 渠道没有本地图标批量读取端点，图标批量读取只服务 Cindy 面。
  'lib/usePluginMarketIcon.ts': ['pluginMarket.localIcons'],
};

const directChannelCalls = pageAndLibSources.flatMap(({ file, source }) =>
  [...source.matchAll(/window\.electronAPI\.(pluginMarket|mekaPluginMarket)\s*\.\s*(\w+)/g)].map(
    (match) => ({ file, channel: match[1]!, method: match[2]! }),
  ),
);

function apiWithDetail(detail: PluginMarketSurfaceApi['detail']): PluginMarketSurfaceApi {
  return {
    snapshot: vi.fn(),
    detail,
    uninstall: vi.fn(),
    markLocalInstall: vi.fn(),
  };
}

describe('Plugin market surface routing', () => {
  it.each([
    ['plugins', 'cindy'],
    ['meka', 'meka'],
  ] as const)('routes the %s surface to the %s market API', (surface, expectedChannel) => {
    const cindyDetail = vi.fn<PluginMarketSurfaceApi['detail']>();
    const mekaDetail = vi.fn<PluginMarketSurfaceApi['detail']>();
    const channels = {
      pluginMarket: apiWithDetail(cindyDetail),
      mekaPluginMarket: apiWithDetail(mekaDetail),
    };

    const selected = pluginMarketApiForSurface(surface, channels);

    expect(selected.detail).toBe(expectedChannel === 'meka' ? mekaDetail : cindyDetail);
  });

  it('keeps every direct channel call on an explicit, documented allowlist', () => {
    const undocumented = directChannelCalls.filter(
      ({ file, channel, method }) => !ALLOWED_DIRECT_CHANNEL_CALLS[file]?.includes(`${channel}.${method}`),
    );

    expect(undocumented).toEqual([]);
  });

  it('never reads the catalog snapshot outside the surface adapter', () => {
    // 目录快照是 §6.74 的直接症状：任何一处直读（无论哪条渠道）都会让页面拿错目录。
    expect(directChannelCalls.filter(({ method }) => method === 'snapshot')).toEqual([]);
    expect(Object.values(ALLOWED_DIRECT_CHANNEL_CALLS).flat()).not.toContain('pluginMarket.snapshot');
    expect(Object.values(ALLOWED_DIRECT_CHANNEL_CALLS).flat()).not.toContain('mekaPluginMarket.snapshot');
  });

  it('preserves the complete update transaction when adapting Meka installs', () => {
    expect(pageSource).toContain(
      'install: (pluginId, options) => installFromActiveMarket(pluginId, options)',
    );
  });
});
