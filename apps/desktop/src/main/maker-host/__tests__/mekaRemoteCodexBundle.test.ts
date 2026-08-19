import { describe, expect, it } from 'vitest';

import { buildMekaRemoteCodexBundle } from '../meka-remote-codex-bundle';

describe('buildMekaRemoteCodexBundle', () => {
  it('projects the exact immutable snapshot bytes for a remote Worker', () => {
    const snapshot = {
      revision: 'a'.repeat(64),
      pluginPath: 'C:/local-only/claude-plugin',
      files: [
        { relativePath: 'catalog.json', contentBase64: 'W10K', digest: 'b'.repeat(64) },
        {
          relativePath: 'skills/alpha/assets/icon.png',
          contentBase64: 'AP8=',
          digest: 'c'.repeat(64),
        },
      ],
    };
    const bundle = buildMekaRemoteCodexBundle(snapshot);

    expect(bundle.revisionHash).toBe(snapshot.revision);
    expect(bundle.files).toEqual([
      { relPath: 'catalog.json', contentBase64: 'W10K', digest: 'b'.repeat(64) },
      { relPath: 'skills/alpha/assets/icon.png', contentBase64: 'AP8=', digest: 'c'.repeat(64) },
    ]);
    expect(JSON.stringify(bundle)).not.toContain(snapshot.pluginPath);
  });

  it('preserves file ordering and binary payloads without recomputing a revision', () => {
    const bundle = buildMekaRemoteCodexBundle({
      revision: 'd'.repeat(64),
      pluginPath: '/local/plugin',
      files: [
        { relativePath: 'skills/zeta/SKILL.md', contentBase64: 'IyBaZXRh', digest: 'e'.repeat(64) },
        {
          relativePath: 'skills/alpha/SKILL.md',
          contentBase64: 'IyBBbHBoYQ==',
          digest: 'f'.repeat(64),
        },
      ],
    });

    expect(bundle.revisionHash).toBe('d'.repeat(64));
    expect(bundle.files.map((file) => file.relPath)).toEqual([
      'skills/zeta/SKILL.md',
      'skills/alpha/SKILL.md',
    ]);
    expect(bundle.files[0]!.contentBase64).toBe('IyBaZXRh');
  });
});
