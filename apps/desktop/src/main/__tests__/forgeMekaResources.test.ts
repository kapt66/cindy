import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertMekaResourceTree,
  assertPackagedMekaResources,
} from '../../../forge-meka-resources.js';

const desktopRoot = path.resolve(__dirname, '../../..');
const temporaryDirectories: string[] = [];

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-meka-resources-'));
  temporaryDirectories.push(root);
  const mekaRoot = path.join(root, 'meka');
  await Promise.all([
    mkdir(path.join(mekaRoot, 'projects', 'demo'), { recursive: true }),
    mkdir(path.join(mekaRoot, 'roles'), { recursive: true }),
    mkdir(path.join(mekaRoot, 'skills', 'common', 'demo', 'available'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(mekaRoot, 'projects', 'demo', 'project.json'), '{"fixture":"project"}\n'),
    writeFile(path.join(mekaRoot, 'roles', 'developer.json'), '{"fixture":"role"}\n'),
    writeFile(
      path.join(mekaRoot, 'skills', 'common', 'demo', 'available', 'SKILL.md'),
      '# Available\n',
    ),
  ]);
  return mekaRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('bundled Meka resource validation', () => {
  it('packages the unified Meka root instead of independent resource directories', async () => {
    const forgeSource = await readFile(path.join(desktopRoot, 'forge.config.ts'), 'utf8');
    expect(forgeSource).toContain("'resources/meka'");
    expect(forgeSource).not.toContain("'resources/meka-projects'");
    expect(forgeSource).not.toContain("'resources/meka-roles'");
    expect(forgeSource).not.toContain("'resources/meka-skills'");
  });

  it('accepts the repository resource tree', () => {
    expect(() => assertMekaResourceTree(path.join(desktopRoot, 'resources', 'meka'))).not.toThrow();
  });

  it('validates the copied process.resourcesPath/meka tree in a packaged layout', async () => {
    const sourceRoot = await createFixture();
    const buildPath = path.join(path.dirname(sourceRoot), 'packaged');
    await mkdir(path.join(buildPath, 'resources'), { recursive: true });
    await cp(sourceRoot, path.join(buildPath, 'resources', 'meka'), { recursive: true });

    expect(() => assertPackagedMekaResources(sourceRoot, buildPath, 'win32')).not.toThrow();
  });

  it('rejects a packaged tree that omits a source resource', async () => {
    const sourceRoot = await createFixture();
    const buildPath = path.join(path.dirname(sourceRoot), 'packaged');
    const packagedRoot = path.join(buildPath, 'resources', 'meka');
    await mkdir(path.dirname(packagedRoot), { recursive: true });
    await cp(sourceRoot, packagedRoot, { recursive: true });
    await unlink(path.join(packagedRoot, 'skills', 'common', 'demo', 'available', 'SKILL.md'));

    expect(() => assertPackagedMekaResources(sourceRoot, buildPath, 'win32')).toThrow(
      'missing: skills/common/demo/available/SKILL.md',
    );
  });

  it('rejects a packaged resource whose content differs from the source', async () => {
    const sourceRoot = await createFixture();
    const buildPath = path.join(path.dirname(sourceRoot), 'packaged');
    const packagedRoot = path.join(buildPath, 'resources', 'meka');
    await mkdir(path.dirname(packagedRoot), { recursive: true });
    await cp(sourceRoot, packagedRoot, { recursive: true });
    await writeFile(path.join(packagedRoot, 'roles', 'developer.json'), '{"changed":true}\n');

    expect(() => assertPackagedMekaResources(sourceRoot, buildPath, 'win32')).toThrow(
      'changed: roles/developer.json',
    );
  });
});
