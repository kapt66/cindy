import { describe, expect, it } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost';
import { MAX_BASIC_CINDY_FILE_BYTES } from '../../cindy-brain/GhostManager';
import {
  MEKA_NODE_PLUGIN_MAX_DOWNLOAD_BYTES,
  MEKA_PLUGIN_MAX_DOWNLOAD_BYTES,
  resolveMekaPluginMaxDownloadBytes,
} from '../mekaDownloadPolicy';

describe('Meka plugin download policy', () => {
  it('pins ordinary Meka plugins to the basic package ceiling', () => {
    // 显式注入而不是落到共享下载器的缺省值：上游把缺省提到 128 MiB 后，返回 undefined
    // 会让普通 Meka 插件的下载上限静默放宽。
    expect(resolveMekaPluginMaxDownloadBytes({} as GhostManifest))
      .toBe(MEKA_PLUGIN_MAX_DOWNLOAD_BYTES);
  });

  it('keeps the ordinary ceiling equal to the install-time basic package ceiling', () => {
    expect(MEKA_PLUGIN_MAX_DOWNLOAD_BYTES).toBe(MAX_BASIC_CINDY_FILE_BYTES);
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
