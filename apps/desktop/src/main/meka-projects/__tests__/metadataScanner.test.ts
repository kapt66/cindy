import { createHash } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const fileBrowser = vi.hoisted(() => ({
  listAllFiles: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('@cindy/file-browser-core', () => fileBrowser);

/** 别名漂移告警的取证窗口：每个漂移的 `CLAUDE.md` 都必须在这里留下**恰好一条** warn。 */
const logging = vi.hoisted(() => ({ warnings: [] as Array<{ message: string; meta?: unknown }> }));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((message: string, meta?: unknown) => {
      logging.warnings.push({ message, meta });
    }),
    error: vi.fn(),
    fatal: vi.fn(),
  }),
}));

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

/**
 * 扫描期的 `CLAUDE.md` / `AGENTS.md` 别名漂移**检测**：这是「内容副本已经落后」唯一能被看见的
 * 地方（真实事故见 `docs/product-rules/meka-project-metadata-governance.md` §6）。检测只告警、
 * 不改任何 manifest 字段 —— 用例同时钉住「两者都没被改写」这件事。
 */
describe('Meka project CLAUDE.md alias drift', () => {
  const primaryRoot = path.resolve('meka-alias-root');

  /**
   * 复用扫描器的 `listAllFiles` / `readFile` mock：`files` 决定同目录是否存在 `AGENTS.md`。
   * 没有提供正文的路径按真实 `readFile` 的口径抛错（扫描不该靠读不到的文件继续）。
   */
  async function discoverFiles(
    files: readonly string[],
    contents: Readonly<Record<string, string>>,
  ): Promise<Awaited<ReturnType<typeof discoverLocalMekaProjectMetadata>>> {
    logging.warnings.length = 0;
    // 读盘次数按**本次**扫描计账：spy 在文件里是共享的，不清就只剩累计值。
    fileBrowser.readFile.mockClear();
    fileBrowser.listAllFiles.mockResolvedValue({ files: [...files] });
    fileBrowser.readFile.mockImplementation(async (_root: string, sourcePath: string) => {
      const content = contents[sourcePath];
      if (content === undefined) throw new Error(`missing file: ${sourcePath}`);
      return { content };
    });
    return discoverLocalMekaProjectMetadata(primaryRoot, 'rg');
  }

  it('stays silent when CLAUDE.md is byte-identical to its sibling AGENTS.md', async () => {
    const shared = '# 项目规则\n\n正文。\n';

    await discoverFiles(['AGENTS.md', 'CLAUDE.md'], { 'AGENTS.md': shared, 'CLAUDE.md': shared });

    expect(logging.warnings).toHaveLength(0);
  });

  it('stays silent for a bare @AGENTS.md include with LF, blank lines and outer whitespace', async () => {
    const aliases = ['@AGENTS.md', '@AGENTS.md\n', '\n@AGENTS.md\n\n', '  @AGENTS.md  '];

    for (const claude of aliases) {
      await discoverFiles(['AGENTS.md', 'CLAUDE.md'], {
        'AGENTS.md': '# 项目规则\n',
        'CLAUDE.md': claude,
      });
      expect(logging.warnings).toHaveLength(0);
    }
  });

  it('stays silent for a bare @AGENTS.md include written with CRLF line endings', async () => {
    await discoverFiles(['AGENTS.md', 'CLAUDE.md'], {
      'AGENTS.md': '# 项目规则\r\n',
      'CLAUDE.md': '@AGENTS.md\r\n',
    });

    expect(logging.warnings).toHaveLength(0);
  });

  it('stays silent for a bare @AGENTS.md include that carries a UTF-8 BOM', async () => {
    await discoverFiles(['AGENTS.md', 'CLAUDE.md'], {
      'AGENTS.md': '# 项目规则\r\n',
      'CLAUDE.md': '\uFEFF@AGENTS.md\r\n',
    });

    expect(logging.warnings).toHaveLength(0);
  });

  it('warns once, naming both absolute paths and both byte sizes', async () => {
    const agents = `# 项目规则\n\n${'硬规则正文。'.repeat(40)}\n`;
    const claude = '# 项目规则\n\n旧副本。\n';

    const discovered = await discoverFiles(['design/AGENTS.md', 'design/CLAUDE.md'], {
      'design/AGENTS.md': agents,
      'design/CLAUDE.md': claude,
    });

    expect(logging.warnings).toHaveLength(1);
    const warning = logging.warnings[0]!;
    expect(warning.message).toContain('@AGENTS.md');
    expect(warning.message).toContain('notes');
    expect(warning.meta).toEqual({
      root: primaryRoot,
      claudePath: path.join(primaryRoot, 'design', 'CLAUDE.md'),
      agentsPath: path.join(primaryRoot, 'design', 'AGENTS.md'),
      claudeBytes: Buffer.byteLength(claude, 'utf8'),
      agentsBytes: Buffer.byteLength(agents, 'utf8'),
    });
    // 大小必须来自各自的实际正文，否则告警会把读者引向错误的方向感（谁落后）。
    expect(Buffer.byteLength(agents, 'utf8')).not.toBe(Buffer.byteLength(claude, 'utf8'));

    // 两个候选项各读一次：别名检测复用扫描期已读到的正文，没有为比对再读一遍盘。
    expect(fileBrowser.readFile).toHaveBeenCalledTimes(2);

    // 只检测：两侧条目照旧携带**自己**的指纹与描述。把副本改成权威副本的指纹，等于让
    // 运行期再也看不出这一条是另一份文件。
    const alias = discovered.find((item) => item.sourcePath === 'design/CLAUDE.md')!;
    const authority = discovered.find((item) => item.sourcePath === 'design/AGENTS.md')!;
    expect(alias.contentFingerprint).toBe(createHash('sha256').update(claude, 'utf8').digest('hex'));
    expect(alias.description).toBe('项目规则');
    expect(authority.contentFingerprint).toBe(
      createHash('sha256').update(agents, 'utf8').digest('hex'),
    );
  });

  it('still warns when the include line carries extra content', async () => {
    // 「几乎是指针」= 内容副本：多写一句说明就不再等价，之后必然各自漂移。
    await discoverFiles(['AGENTS.md', 'CLAUDE.md'], {
      'AGENTS.md': '# 项目规则\n',
      'CLAUDE.md': '@AGENTS.md\n\n补充说明。\n',
    });

    expect(logging.warnings).toHaveLength(1);
  });

  it('never compares against an AGENTS.md outside the same directory', async () => {
    // 根目录有 AGENTS.md、子目录的 CLAUDE.md 与它不同：不同目录不是别名关系。
    await discoverFiles(['AGENTS.md', 'design/CLAUDE.md'], {
      'AGENTS.md': '# 根规则\n',
      'design/CLAUDE.md': '# 设计规则\n\n完全不同的正文。\n',
    });
    expect(logging.warnings).toHaveLength(0);

    // 同目录没有 AGENTS.md 时，CLAUDE.md 是合法独立条目。
    await discoverFiles(['solo/CLAUDE.md', 'solo/SKILL.md'], {
      'solo/CLAUDE.md': '# 独立规则\n',
      'solo/SKILL.md': '# 技能\n',
    });
    expect(logging.warnings).toHaveLength(0);
  });

  it('never triggers on an agents-md item whose basename is not exactly CLAUDE.md', async () => {
    // AGENTS.md 自己永不充当被检查的别名侧，即使同目录另有内容不同的规则文件。
    await discoverFiles(['AGENTS.md', 'rules.md'], {
      'AGENTS.md': '# 规则正本\n',
      'rules.md': '# 规则副本\n',
    });
    expect(logging.warnings).toHaveLength(0);

    // 大小写不同的 `claude.md` 根本不是被发现清单里的条目（也不该为它读盘）。
    const discovered = await discoverFiles(['AGENTS.md', 'claude.md'], {
      'AGENTS.md': '# 规则正本\n',
      'claude.md': '# 另一份副本\n',
    });
    expect(logging.warnings).toHaveLength(0);
    expect(discovered.map((item) => item.sourcePath)).toEqual(['AGENTS.md']);
    expect(fileBrowser.readFile).toHaveBeenCalledTimes(1);
    expect(fileBrowser.readFile).toHaveBeenCalledWith(primaryRoot, 'AGENTS.md');
  });

  it('emits exactly one warning per divergent CLAUDE.md', async () => {
    await discoverFiles(
      ['a/AGENTS.md', 'a/CLAUDE.md', 'b/AGENTS.md', 'b/CLAUDE.md', 'c/AGENTS.md', 'c/CLAUDE.md'],
      {
        'a/AGENTS.md': '# A\n',
        'a/CLAUDE.md': '# A 旧副本\n',
        'b/AGENTS.md': '# B\n',
        'b/CLAUDE.md': '# B 旧副本\n',
        'c/AGENTS.md': '# C\n',
        'c/CLAUDE.md': '# C\n',
      },
    );

    expect(logging.warnings).toHaveLength(2);
    expect(
      logging.warnings.map((warning) => (warning.meta as { claudePath: string }).claudePath),
    ).toEqual([path.join(primaryRoot, 'a', 'CLAUDE.md'), path.join(primaryRoot, 'b', 'CLAUDE.md')]);
  });
});
