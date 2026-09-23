import { createHash } from 'node:crypto';
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

/**
 * `agents-md` / `rule` items are delivered to the runtime as address + bounded description
 * references (`MekaProjectReference`), so the description has to be produced deterministically at
 * scan time. `skill` / `mcp` keep their pre-existing `describe()` behavior untouched.
 */
describe('Meka project reference descriptions', () => {
  const primaryRoot = path.resolve('meka-description-root');

  async function discoverSingle(
    sourcePath: string,
    content: string,
  ): Promise<Record<string, unknown>> {
    fileBrowser.listAllFiles.mockResolvedValue({ files: [sourcePath] });
    fileBrowser.readFile.mockResolvedValue({ content });
    const discovered = await discoverLocalMekaProjectMetadata(primaryRoot, 'rg');
    expect(discovered).toHaveLength(1);
    return discovered[0] as unknown as Record<string, unknown>;
  }

  it('prefers the frontmatter description over the title and the body heading', async () => {
    const item = await discoverSingle(
      'AGENTS.md',
      [
        '---',
        'description: Frontmatter description wins',
        'title: Frontmatter title loses',
        '---',
        '',
        '# Body heading loses',
        '',
        'First body paragraph loses.',
      ].join('\n'),
    );

    expect(item).toMatchObject({
      itemType: 'agents-md',
      name: 'AGENTS.md',
      description: 'Frontmatter description wins',
    });
  });

  it('falls back to the frontmatter title when there is no description', async () => {
    const item = await discoverSingle(
      'saga2_unity/AGENTS.md',
      [
        '---',
        'title: 世界观治理入口',
        '---',
        '',
        '# 正文标题不参与',
        '',
        '首段也不参与。',
      ].join('\n'),
    );

    expect(item).toMatchObject({
      itemType: 'agents-md',
      name: 'AGENTS.md',
      description: '世界观治理入口',
    });
  });

  it('falls back to the first ATX heading of the body', async () => {
    const item = await discoverSingle('rules.md', '# 项目规则\n\n正文段落不应成为描述。\n');

    expect(item).toMatchObject({
      itemType: 'rule',
      name: 'rules.md',
      description: '项目规则',
    });
  });

  it('falls back to the first sentence of the first paragraph for plain text', async () => {
    const item = await discoverSingle('.cursorrules', '第一句说明。第二句说明。\n');

    expect(item).toMatchObject({
      itemType: 'rule',
      name: '.cursorrules',
      description: '第一句说明。',
    });
  });

  it('bounds a long description to 297 code points plus an ellipsis', async () => {
    const item = await discoverSingle('AGENTS.md', `${'规'.repeat(350)}\n`);

    expect(item.description).toBe(`${'规'.repeat(297)}...`);
    expect((item.description as string).length).toBe(300);
  });

  it('writes no description for an empty file or a body that is only a fenced code block', async () => {
    const empty = await discoverSingle('AGENTS.md', '');
    expect(empty).not.toHaveProperty('description');

    const codeOnly = await discoverSingle(
      '.cursorrules',
      ['```ts', 'const value = 1;', '```'].join('\n'),
    );
    expect(codeOnly).not.toHaveProperty('description');
  });

  it('keeps the content fingerprint over the raw body only', async () => {
    const content = '---\ndescription: 有描述\n---\n\n# 标题\n';
    const item = await discoverSingle('AGENTS.md', content);

    expect(item.description).toBe('有描述');
    // The description is derived metadata, not content: folding it into the fingerprint would
    // make the runtime reference list unstable whenever prose changes.
    expect(item.contentFingerprint).toBe(
      createHash('sha256').update(content, 'utf8').digest('hex'),
    );
  });

  it('leaves the skill branch on its own name/description rules', async () => {
    const withFrontmatter = await discoverSingle(
      'skills/remote/SKILL.md',
      [
        '---',
        'name: remote-skill',
        'description: 远程技能说明',
        '---',
        '',
        '# 远程技能标题',
      ].join('\n'),
    );
    expect(withFrontmatter).toMatchObject({
      itemType: 'skill',
      name: 'remote-skill',
      description: '远程技能说明',
    });

    // Without frontmatter the skill keeps its directory-derived name, and the agents-md/rule
    // description probe (heading / first paragraph) must NOT be applied to it.
    const withoutFrontmatter = await discoverSingle(
      'skills/writer/SKILL.md',
      '# 写作技能标题\n\n正文首段。\n',
    );
    expect(withoutFrontmatter).toMatchObject({ itemType: 'skill', name: 'writer' });
    expect(withoutFrontmatter).not.toHaveProperty('description');
  });
});
