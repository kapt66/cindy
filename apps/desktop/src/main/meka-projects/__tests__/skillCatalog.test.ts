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
    // 夹具沿用随包唯一幸存的那条 skill 的三级形态（`通用/<子类>/<id>/SKILL.md`）。
    const skillRoot = path.join(root, '通用', 'platform', 'platform-capabilities');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      path.join(skillRoot, 'SKILL.md'),
      [
        '---',
        'name: platform-capabilities',
        'description: Platform capabilities',
        'metadata:',
        '  display-name: "平台外部能力"',
        '  purpose: Route repository work',
        '---',
        '# Platform',
      ].join('\n'),
      'utf8',
    );

    await expect(listMekaSkillCatalog(root)).resolves.toEqual([
      {
        skillId: 'platform-capabilities',
        displayName: '平台外部能力',
        category: '通用',
        subCategory: 'platform',
        description: 'Platform capabilities',
        purpose: 'Route repository work',
        filePath: '通用/platform/platform-capabilities/SKILL.md',
      },
    ]);
  });

  it('returns an empty catalog when the bundled root does not exist', async () => {
    const root = await createTempDir('meka-skill-catalog-missing-');
    await expect(listMekaSkillCatalog(path.join(root, 'missing'))).resolves.toEqual([]);
  });
});
