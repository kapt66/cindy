import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => state.userData),
  },
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
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

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
});
