import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ userData: '' }));

/** 运行期 warn 的取证窗口：派生 skill 被跳过时必须留下可观察的 warn。 */
const logging = vi.hoisted(() => ({ warnings: [] as Array<{ message: string; meta?: unknown }> }));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => state.userData),
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((message: string, meta?: unknown) => {
      logging.warnings.push({ message, meta });
    }),
    error: vi.fn(),
  }),
}));

import type { MekaRuntimeSkill } from '../runtimeConfig.js';
import {
  hasMekaSkillSnapshotEntries,
  materializeMekaSkillSnapshot,
} from '../skillSnapshot.js';

const roots: string[] = [];

async function createSkill(
  id: string,
  body: string,
  options: { description?: string; binary?: Buffer } = {},
): Promise<MekaRuntimeSkill> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `meka-snapshot-${id}-`));
  roots.push(root);
  const content = `---\nname: source-${id}\ndescription: source description\n---\n\n${body}\n`;
  await fs.writeFile(path.join(root, 'SKILL.md'), content, 'utf8');
  await fs.mkdir(path.join(root, 'references'), { recursive: true });
  await fs.writeFile(path.join(root, 'references', 'guide.md'), `guide for ${id}\n`, 'utf8');
  if (options.binary) {
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'assets', 'sample.bin'), options.binary);
  }
  return {
    id,
    name: `Role ${id}`,
    description: options.description ?? `Role description for ${id}`,
    content,
    sourceDirectory: root,
    sourceEntryPath: path.join(root, 'SKILL.md'),
  };
}

beforeEach(async () => {
  state.userData = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-meka-snapshot-user-data-'));
  roots.push(state.userData);
  logging.warnings.length = 0;
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/**
 * 一个「收集必然失败」的 skill 目录（**跨平台**触发点，不需要 symlink 权限）：`root` 下同时存在
 * `SKILL.md` 与另一个根级入口文件 ⇒ walk 遇到根 `SKILL.md` 而它不是 `sourceEntryPath` ⇒
 * `collectSkillFiles` 抛 `Meka Skill source contains an ambiguous root SKILL.md`。
 *
 * 真实世界的对应物就是复审点名的两类坏目录：`SKILL.md` 落在项目根（⇒ 源目录是整个项目树，递归
 * 几乎必然超限）与目录里含 symlink；两者走的是同一条抛出路径。
 */
async function createUnsnapshottableSkill(
  id: string,
  options: { derivedOnly?: boolean } = {},
): Promise<MekaRuntimeSkill> {
  const skill = await createSkill(id, 'Ambiguous entry body.');
  skill.sourceEntryPath = path.join(skill.sourceDirectory, 'instructions.md');
  skill.content = 'Legacy entry body.\n';
  await fs.writeFile(skill.sourceEntryPath, skill.content, 'utf8');
  return options.derivedOnly ? { ...skill, derivedOnly: true } : skill;
}

/** 读出快照里的 `catalog.json`：catalog 条目与文件**必须同进同退**（跳过的 skill 不许留条目）。 */
function snapshotCatalog(snapshot: {
  files: readonly { relativePath: string; contentBase64: string }[];
}): Array<{ skillId: string; relPath: string }> {
  const entry = snapshot.files.find((file) => file.relativePath === 'catalog.json');
  if (!entry) throw new Error('catalog.json is missing from the snapshot');
  return JSON.parse(Buffer.from(entry.contentBase64, 'base64').toString('utf8')) as Array<{
    skillId: string;
    relPath: string;
  }>;
}

describe('materializeMekaSkillSnapshot', () => {
  it('freezes the full Skill directory and rewrites only catalog metadata', async () => {
    const binary = Buffer.from([0, 255, 1, 128]);
    const skill = await createSkill('alpha', 'Keep the instruction body.', { binary });

    const snapshot = await materializeMekaSkillSnapshot('session-full-directory', [skill]);

    expect(snapshot).not.toBeNull();
    const pluginPath = snapshot!.pluginPath;
    const frozenSkill = await fs.readFile(
      path.join(pluginPath, 'skills', 'alpha', 'SKILL.md'),
      'utf8',
    );
    expect(matter(frozenSkill).data).toMatchObject({
      name: 'alpha',
      description: 'Role description for alpha',
    });
    expect(frozenSkill).toContain('\n\nKeep the instruction body.\n');
    expect(
      await fs.readFile(path.join(pluginPath, 'skills', 'alpha', 'references', 'guide.md'), 'utf8'),
    ).toBe('guide for alpha\n');
    expect(
      await fs.readFile(path.join(pluginPath, 'skills', 'alpha', 'assets', 'sample.bin')),
    ).toEqual(binary);
    expect(snapshot!.files.map((file) => file.relativePath)).toContain(
      '.claude-plugin/plugin.json',
    );
  });

  it('preserves structured frontmatter while replacing role-facing metadata', async () => {
    const skill = await createSkill('metadata', 'Structured instructions.');
    skill.content = [
      '---',
      'name: source-metadata',
      'description: |',
      '  Original line one.',
      '  Original line two.',
      'allowed-tools:',
      '  - Read',
      'metadata:',
      '  owner: meka',
      '---',
      '',
      'Structured instructions.',
      '',
    ].join('\n');
    await fs.writeFile(skill.sourceEntryPath, skill.content, 'utf8');

    const snapshot = await materializeMekaSkillSnapshot('session-frontmatter', [skill]);
    const frozen = matter(
      await fs.readFile(
        path.join(snapshot!.pluginPath, 'skills', 'metadata', 'SKILL.md'),
        'utf8',
      ),
    );

    expect(frozen.data).toEqual({
      name: 'metadata',
      description: 'Role description for metadata',
      'allowed-tools': ['Read'],
      metadata: { owner: 'meka' },
    });
    expect(frozen.content).toContain('Structured instructions.');
  });

  it('normalizes a legacy role-selected Markdown entry to root SKILL.md', async () => {
    const skill = await createSkill('legacy', 'Unused source Skill entry.');
    await fs.rm(path.join(skill.sourceDirectory, 'SKILL.md'));
    skill.sourceEntryPath = path.join(skill.sourceDirectory, 'instructions.md');
    skill.content = 'Legacy role-selected instructions.\n';
    await fs.writeFile(skill.sourceEntryPath, skill.content, 'utf8');

    const snapshot = await materializeMekaSkillSnapshot('session-legacy', [skill]);

    await expect(
      fs.readFile(path.join(snapshot!.pluginPath, 'skills', 'legacy', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('Legacy role-selected instructions.');
    await expect(
      fs.stat(path.join(snapshot!.pluginPath, 'skills', 'legacy', 'instructions.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the first task binding after role sources change or disappear', async () => {
    const original = await createSkill('stable', 'Original instructions.');
    const first = await materializeMekaSkillSnapshot('session-stable', [original]);
    await fs.rm(original.sourceDirectory, { recursive: true, force: true });

    const changed = await createSkill('changed', 'Changed instructions.');
    const resumed = await materializeMekaSkillSnapshot('session-stable', [changed]);
    const otherTask = await materializeMekaSkillSnapshot('session-new', [changed]);

    expect(resumed).toEqual(first);
    expect(otherTask!.revision).not.toBe(first!.revision);
    expect(
      await fs.readFile(path.join(resumed!.pluginPath, 'skills', 'stable', 'SKILL.md'), 'utf8'),
    ).toContain('Original instructions.');
  });

  it('freezes an empty catalog so later role edits affect only new tasks', async () => {
    const empty = await materializeMekaSkillSnapshot('session-empty', []);
    const added = await createSkill('later', 'Later instructions.');
    const resumed = await materializeMekaSkillSnapshot('session-empty', [added]);
    const newTask = await materializeMekaSkillSnapshot('session-after-edit', [added]);

    expect(resumed).toEqual(empty);
    expect(hasMekaSkillSnapshotEntries(empty!)).toBe(false);
    expect(empty!.files.some((file) => file.relativePath.startsWith('skills/'))).toBe(false);
    expect(hasMekaSkillSnapshotEntries(newTask!)).toBe(true);
    expect(newTask!.files.some((file) => file.relativePath === 'skills/later/SKILL.md')).toBe(true);
  });

  it('publishes one immutable winner for concurrent first starts', async () => {
    const left = await createSkill('left', 'Left instructions.');
    const right = await createSkill('right', 'Right instructions.');

    const [first, second] = await Promise.all([
      materializeMekaSkillSnapshot('session-race', [left]),
      materializeMekaSkillSnapshot('session-race', [right]),
    ]);

    expect(first!.revision).toBe(second!.revision);
    expect(first!.pluginPath).toBe(second!.pluginPath);
  });

  it('allocates unique stable directories after normalized and hash-suffix collisions', async () => {
    const firstId = 'same.id';
    const collidingSuffix = createHash('sha256').update(firstId).digest('hex').slice(0, 8);
    const skills = await Promise.all([
      createSkill(firstId, 'First instructions.'),
      createSkill('same-id', 'Second instructions.'),
      createSkill(`same-id-${collidingSuffix}`, 'Third instructions.'),
    ]);

    const snapshot = await materializeMekaSkillSnapshot('session-name-collision', skills);
    const skillEntries = snapshot!.files
      .map((file) => file.relativePath)
      .filter((relativePath) => /^skills\/[^/]+\/SKILL\.md$/.test(relativePath));

    expect(skillEntries).toHaveLength(3);
    expect(new Set(skillEntries)).toHaveLength(3);
  });

  it('fails closed when a bound snapshot is missing or modified', async () => {
    const skill = await createSkill('tamper', 'Frozen instructions.');
    const snapshot = await materializeMekaSkillSnapshot('session-tamper', [skill]);
    const skillPath = path.join(snapshot!.pluginPath, 'skills', 'tamper', 'SKILL.md');
    await fs.writeFile(skillPath, 'modified', 'utf8');

    await expect(materializeMekaSkillSnapshot('session-tamper', [])).rejects.toThrow(
      /changed after materialization/,
    );

    await fs.rm(path.dirname(snapshot!.pluginPath), { recursive: true, force: true });
    await expect(materializeMekaSkillSnapshot('session-tamper', [])).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects files added outside the immutable snapshot manifest', async () => {
    const skill = await createSkill('extra', 'Frozen instructions.');
    const snapshot = await materializeMekaSkillSnapshot('session-extra', [skill]);
    await fs.mkdir(path.join(snapshot!.pluginPath, 'skills', 'injected'), { recursive: true });
    await fs.writeFile(
      path.join(snapshot!.pluginPath, 'skills', 'injected', 'SKILL.md'),
      'Injected instructions.',
      'utf8',
    );

    await expect(materializeMekaSkillSnapshot('session-extra', [])).rejects.toThrow(
      /outside its immutable manifest/,
    );
  });

  it.runIf(process.platform !== 'win32')(
    'rejects symbolic links in Skill directories',
    async () => {
      const skill = await createSkill('linked', 'Linked instructions.');
      await fs.symlink(
        path.join(skill.sourceDirectory, 'references', 'guide.md'),
        path.join(skill.sourceDirectory, 'linked-guide.md'),
      );

      await expect(materializeMekaSkillSnapshot('session-linked', [skill])).rejects.toThrow(
        /do not follow symbolic links/,
      );
    },
  );

  /**
   * 缺陷 2（P1）的核心回归：**派生** skill（只由全量开关 / 内置 catalog 铺底而来）收集失败时
   * 只跳过它自己。默认角色出厂即全量选中包内 catalog 与全部 enabled 的项目元数据，所以一个坏
   * skill 目录（`SKILL.md` 落在项目根 ⇒ 源目录是整棵树；或目录含 symlink）在改动后会把该项目
   * **所有新建会话**顶成 `INVALID_PARAMS`。
   */
  it('skips a derived Skill whose source directory cannot be collected and keeps the rest', async () => {
    const broken = await createUnsnapshottableSkill('derived-broken', { derivedOnly: true });
    const good = await createSkill('derived-good', 'Good instructions.');

    const snapshot = await materializeMekaSkillSnapshot('session-derived-skip', [broken, good]);

    expect(snapshot).not.toBeNull();
    const paths = snapshot!.files.map((file) => file.relativePath);
    expect(paths).toContain('skills/derived-good/SKILL.md');
    expect(paths).toContain('skills/derived-good/references/guide.md');
    // 跳过的 skill 在快照里**完全不存在**：没有文件……
    expect(paths.some((relativePath) => relativePath.startsWith('skills/derived-broken'))).toBe(
      false,
    );
    // ……也没有 catalog 条目（否则 catalog 会指向一个没有 SKILL.md 的目录）。
    expect(snapshotCatalog(snapshot!).map((entry) => entry.skillId)).toEqual(['derived-good']);
    expect(hasMekaSkillSnapshotEntries(snapshot!)).toBe(true);
    expect(
      logging.warnings.some((warning) =>
        warning.message.includes('skipping a derived Meka Skill'),
      ),
    ).toBe(true);
  });

  it('still fails closed for an author-selected Skill whose source directory cannot be collected', async () => {
    const broken = await createUnsnapshottableSkill('explicit-broken');
    const good = await createSkill('explicit-good', 'Good instructions.');

    // 同一份坏目录，但这次是作者显式选择（没有 `derivedOnly`）⇒ 原样抛出，绝不静默降级。
    await expect(
      materializeMekaSkillSnapshot('session-explicit-throw', [broken, good]),
    ).rejects.toThrow(/ambiguous root SKILL\.md/);
  });

  it.runIf(process.platform !== 'win32')(
    'skips a derived Skill whose directory contains a symbolic link',
    async () => {
      const linked = await createSkill('derived-linked', 'Linked instructions.');
      await fs.symlink(
        path.join(linked.sourceDirectory, 'references', 'guide.md'),
        path.join(linked.sourceDirectory, 'linked-guide.md'),
      );
      const good = await createSkill('linked-good', 'Good instructions.');

      const snapshot = await materializeMekaSkillSnapshot('session-derived-linked', [
        { ...linked, derivedOnly: true },
        good,
      ]);

      expect(snapshot!.files.map((file) => file.relativePath)).toContain(
        'skills/linked-good/SKILL.md',
      );
      expect(
        snapshot!.files.some((file) => file.relativePath.startsWith('skills/derived-linked/')),
      ).toBe(false);
      expect(snapshotCatalog(snapshot!).map((entry) => entry.skillId)).toEqual(['linked-good']);
      expect(
        logging.warnings.some((warning) =>
          warning.message.includes('skipping a derived Meka Skill'),
        ),
      ).toBe(true);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'still rejects a symbolic link in an author-selected Skill directory',
    async () => {
      const linked = await createSkill('explicit-linked', 'Linked instructions.');
      await fs.symlink(
        path.join(linked.sourceDirectory, 'references', 'guide.md'),
        path.join(linked.sourceDirectory, 'linked-guide.md'),
      );
      const good = await createSkill('explicit-linked-good', 'Good instructions.');

      await expect(
        materializeMekaSkillSnapshot('session-explicit-linked', [good, linked]),
      ).rejects.toThrow(/do not follow symbolic links/);
    },
  );

  /**
   * 排除名单（`METADATA_SCAN_EXCLUDED_DIRECTORIES`，与项目扫描器**同一份**）在快照 walk 里也生效：
   * `.git` / `node_modules` 这类目录一律不下降。否则每个新会话都要为整棵依赖树遍历 + 哈希，而
   * `.git` 里几乎必然有 symlink —— 那就是「一个坏目录打死全部新会话」。
   */
  it('never descends into the directories excluded by the project scan', async () => {
    const skill = await createSkill('excluded-dirs', 'Body.');
    await fs.mkdir(path.join(skill.sourceDirectory, '.git', 'objects'), { recursive: true });
    await fs.writeFile(
      path.join(skill.sourceDirectory, '.git', 'objects', 'pack.md'),
      'packed\n',
      'utf8',
    );
    // `.git` 里的另一个 `SKILL.md`：一旦下降就会被收进快照（下面按路径断言它不存在）。
    await fs.writeFile(path.join(skill.sourceDirectory, '.git', 'SKILL.md'), '# nested\n', 'utf8');
    await fs.mkdir(path.join(skill.sourceDirectory, 'node_modules', 'dep'), { recursive: true });
    await fs.writeFile(
      path.join(skill.sourceDirectory, 'node_modules', 'dep', 'index.md'),
      'dep\n',
      'utf8',
    );
    // 平台允许时再往排除目录里放一个 symlink：不支持（Windows 无开发者模式）时忽略这一项，
    // 上面的普通文件已经足以证明「不下降」。
    await fs
      .symlink(
        path.join(skill.sourceDirectory, 'references', 'guide.md'),
        path.join(skill.sourceDirectory, '.git', 'linked-guide.md'),
      )
      .catch(() => undefined);

    const snapshot = await materializeMekaSkillSnapshot('session-excluded-dirs', [skill]);

    const paths = snapshot!.files.map((file) => file.relativePath);
    expect(paths).toContain('skills/excluded-dirs/SKILL.md');
    expect(paths).toContain('skills/excluded-dirs/references/guide.md');
    expect(
      paths.filter(
        (relativePath) => relativePath.includes('.git') || relativePath.includes('node_modules'),
      ),
    ).toEqual([]);
  });
});
