import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const fileBrowser = vi.hoisted(() => ({
  listAllFiles: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('@cindy/file-browser-core', () => fileBrowser);

import {
  discoverLocalMekaProjectMetadata,
  inferMekaSubProjectPath,
  mergeDiscoveredMekaProjectMetadata,
} from '../metadataScanner';

describe('inferMekaSubProjectPath', () => {
  it('preserves project annotations while refreshing discovered fields', () => {
    const current = {
      schemaVersion: 1 as const,
      projectId: 'saga2',
      basic: { displayName: 'SAGA2', path: 'saga2' },
      metadata: [
        {
          sourcePath: 'skills/remote/SKILL.md',
          itemType: 'skill' as const,
          name: 'remote-old',
          contentFingerprint: 'old',
          subProjectPath: 'skills',
          disciplines: ['程序'],
          domains: ['工程基建'],
          enabled: false,
          displayName: '远程项目操作',
          description: '人工维护的中文说明',
          notes: '默认关闭',
        },
      ],
    };

    expect(
      mergeDiscoveredMekaProjectMetadata(current, [
        {
          sourcePath: 'skills/remote/SKILL.md',
          itemType: 'skill',
          name: 'remote-new',
          description: 'New English description',
          contentFingerprint: 'new',
          subProjectPath: 'skills',
        },
      ]).metadata,
    ).toEqual([
      expect.objectContaining({
        name: 'remote-new',
        contentFingerprint: 'new',
        disciplines: ['程序'],
        domains: ['工程基建'],
        enabled: false,
        displayName: '远程项目操作',
        description: '人工维护的中文说明',
        notes: '默认关闭',
      }),
    ]);
  });

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
    expect(fileBrowser.listAllFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        globs: expect.arrayContaining([
          '**/AGENTS.md',
          '**/SKILL.md',
          '**/.mcp.json',
          '**/.p4ignore',
          expect.stringContaining('Library'),
        ]),
      }),
    );
  });

  it('fails closed instead of replacing metadata from a truncated discovery', async () => {
    const primary = path.resolve('meka-primary');
    fileBrowser.readFile.mockClear();
    fileBrowser.listAllFiles.mockResolvedValue({
      files: ['AGENTS.md'],
      truncated: true,
      elapsedMs: 1,
    });

    await expect(discoverLocalMekaProjectMetadata(primary, 'rg')).rejects.toThrow(
      /metadata scan was truncated/,
    );
    expect(fileBrowser.readFile).not.toHaveBeenCalled();
  });
});
