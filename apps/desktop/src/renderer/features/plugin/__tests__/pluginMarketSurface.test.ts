/**
 * Regression coverage for routing shared Plugin market operations by page surface.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { pluginMarketApiForSurface, type PluginMarketSurfaceApi } from '../lib/pluginMarketSurface';

const pageSource = readFileSync(resolve(__dirname, '..', 'GhostPluginPage.tsx'), 'utf8');

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

  it('keeps shared operations in the dual-surface page behind the selected API', () => {
    const channelBypasses =
      pageSource.match(
        /window\.electronAPI\.(?:pluginMarket|mekaPluginMarket)\.(?:snapshot|detail|uninstall|markLocalInstall)/g,
      ) ?? [];

    expect(channelBypasses).toEqual([]);
  });
});
