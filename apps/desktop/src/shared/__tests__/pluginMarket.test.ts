import { describe, expect, it } from 'vitest';

import { isPluginMarketInstallProgress } from '../pluginMarket';

describe('isPluginMarketInstallProgress', () => {
  it('accepts a bounded install progress payload', () => {
    expect(
      isPluginMarketInstallProgress({
        operationId: '2b3fe88f-ef65-4389-a84c-62f626657e85',
        pluginId: 'caaaaaaaaaaaaaaaaaaaaaaaa',
        phase: 'downloading',
        downloadedBytes: 42,
        totalBytes: 100,
      }),
    ).toBe(true);
  });

  it('rejects invalid phases and byte ranges', () => {
    expect(
      isPluginMarketInstallProgress({
        operationId: '2b3fe88f-ef65-4389-a84c-62f626657e85',
        pluginId: 'caaaaaaaaaaaaaaaaaaaaaaaa',
        phase: 'complete',
        downloadedBytes: 101,
        totalBytes: 100,
      }),
    ).toBe(false);
  });
});
