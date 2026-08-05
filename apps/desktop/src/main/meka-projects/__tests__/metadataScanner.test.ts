import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const fileBrowser = vi.hoisted(() => ({
  listAllFiles: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('@cindy/file-browser-core', () => fileBrowser);

import { discoverLocalMekaProjectMetadata, inferMekaSubProjectPath } from '../metadataScanner';

describe('inferMekaSubProjectPath', () => {
  it('uses the closest Perforce owner', () => {
    const files = ['.p4ignore', 'game/.p4ignore', 'game/client/.p4ignore', 'game/client/AGENTS.md'];
    expect(inferMekaSubProjectPath('game/client/AGENTS.md', files)).toBe('game/client');
  });

  it('returns null outside a Perforce workspace', () => {
    expect(
      inferMekaSubProjectPath('packages/app/AGENTS.md', ['packages/app/AGENTS.md']),
    ).toBeNull();
  });

  it('discovers metadata from the primary and every additional project path', async () => {
    const primary = path.resolve('meka-primary');
    const additional = path.resolve('meka-additional');
    fileBrowser.listAllFiles.mockImplementation(async ({ workdir }: { workdir: string }) => ({
      files: workdir === primary ? ['AGENTS.md'] : ['rules.md'],
    }));
    fileBrowser.readFile.mockImplementation(async (_root: string, sourcePath: string) => ({
      content: `content:${sourcePath}`,
    }));

    const discovered = await discoverLocalMekaProjectMetadata(primary, 'rg', [additional]);

    expect(discovered).toEqual([
      expect.objectContaining({
        itemType: 'agents-md',
        sourcePath: 'AGENTS.md',
      }),
      expect.objectContaining({
        itemType: 'rule',
        sourcePath: 'rules.md',
        rootPath: additional,
      }),
    ]);
    expect(discovered[0]).not.toHaveProperty('rootPath');
    expect(fileBrowser.listAllFiles).toHaveBeenCalledTimes(2);
  });
});
