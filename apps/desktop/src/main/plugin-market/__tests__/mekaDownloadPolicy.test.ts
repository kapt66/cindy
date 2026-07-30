import { describe, expect, it } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost';
import {
  MEKA_NODE_PLUGIN_MAX_DOWNLOAD_BYTES,
  resolveMekaPluginMaxDownloadBytes,
} from '../mekaDownloadPolicy';

describe('Meka plugin download policy', () => {
  it('keeps ordinary Meka plugins on the shared default ceiling', () => {
    expect(resolveMekaPluginMaxDownloadBytes({} as GhostManifest)).toBeUndefined();
  });

  it('allows validated Node plugins up to the runtime package ceiling', () => {
    const manifest = {
      node: {
        entry: 'node/worker.cjs',
        protocol: 'mcp-stdio',
        lifecycle: 'on-demand',
      },
    } as GhostManifest;

    expect(resolveMekaPluginMaxDownloadBytes(manifest))
      .toBe(MEKA_NODE_PLUGIN_MAX_DOWNLOAD_BYTES);
    expect(MEKA_NODE_PLUGIN_MAX_DOWNLOAD_BYTES).toBe(128 * 1024 * 1024);
  });
});
