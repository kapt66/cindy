import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listMekaSkillCatalog } from '../skillCatalog.js';

describe('listMekaSkillCatalog', () => {
  const roots: string[] = [];
  const createTempDir = async (prefix: string) => {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  };

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('lists three-level bundled skills and reads their frontmatter', async () => {
    const root = await createTempDir('meka-skill-catalog-');
    const skillRoot = path.join(root, '通用', 'project', 'saga2-overview');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      path.join(skillRoot, 'SKILL.md'),
      [
        '---',
        'description: Saga2 overview',
        'purpose: Route repository work',
        '---',
        '# Saga2',
      ].join('\n'),
      'utf8',
    );

    await expect(listMekaSkillCatalog(root)).resolves.toEqual([
      {
        skillId: 'saga2-overview',
        category: '通用',
        subCategory: 'project',
        description: 'Saga2 overview',
        purpose: 'Route repository work',
        filePath: '通用/project/saga2-overview/SKILL.md',
      },
    ]);
  });

  it('returns an empty catalog when the bundled root does not exist', async () => {
    const root = await createTempDir('meka-skill-catalog-missing-');
    await expect(listMekaSkillCatalog(path.join(root, 'missing'))).resolves.toEqual([]);
  });
});
