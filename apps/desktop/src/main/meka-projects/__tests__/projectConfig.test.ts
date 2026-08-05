import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { MekaProjectFile, MekaRoleManifestFile } from '../../../shared/meka-projects.js';
import {
  createProjectConfigExclusive,
  normalizeMekaProjectFile,
  normalizeMekaRoleManifest,
  readBuiltinRoleManifest,
  readEffectiveProjectConfig,
  saveProjectConfig,
} from '../projectConfig.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'meka-project-config-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function projectFile(projectId: string, root: string): MekaProjectFile {
  return {
    schemaVersion: 1,
    projectId,
    basic: { displayName: 'Demo', path: root },
    metadata: [],
  };
}

describe('Meka project.json boundary', () => {
  it('loads bundled SAGA2 and persists its editable project override beside the P4 root', async () => {
    const root = await tempRoot();
    const locator = {
      projectId: 'saga2',
      isBuiltin: true,
      projectRoot: root,
      appIsPackaged: false,
    };
    const loaded = await readEffectiveProjectConfig(locator);

    expect(loaded).toMatchObject({
      projectId: 'saga2',
      basic: { displayName: 'SAGA2', workflowType: 'jira' },
    });
    expect(loaded?.metadata.length).toBeGreaterThan(30);
    await saveProjectConfig(locator, {
      ...loaded!,
      basic: { ...loaded!.basic, displayName: 'SAGA2 Local' },
    });
    await expect(readEffectiveProjectConfig(locator)).resolves.toMatchObject({
      basic: { displayName: 'SAGA2 Local' },
    });
    expect(
      JSON.parse(await readFile(path.join(root, '.meka', 'project.json'), 'utf8')),
    ).toMatchObject({ projectId: 'saga2', basic: { displayName: 'SAGA2 Local' } });
  });

  it('uses a SAGA2 project file as the only project source and materializes builtin roles', async () => {
    const root = await tempRoot();
    const configDirectory = path.join(root, '.meka');
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      path.join(configDirectory, 'project.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        projectId: 'saga2',
        basic: {
          displayName: 'Project-owned SAGA2',
          path: 'stale-path',
          disciplines: ['通用'],
          domains: [],
        },
        metadata: [],
        roleDefaults: { skills: [] },
      })}\n`,
      'utf8',
    );

    const loaded = await readEffectiveProjectConfig({
      projectId: 'saga2',
      isBuiltin: true,
      projectRoot: root,
      appIsPackaged: false,
    });

    expect(loaded?.basic.displayName).toBe('Project-owned SAGA2');
    expect(loaded?.basic.path).toBe(path.resolve(root));
    expect(loaded?.metadata).toEqual([]);
    expect(loaded?.builtinRoles).toHaveLength(6);
    const persisted = JSON.parse(
      await readFile(path.join(configDirectory, 'project.json'), 'utf8'),
    ) as MekaProjectFile;
    expect(persisted.metadata).toEqual([]);
    expect(persisted.builtinRoles).toHaveLength(6);
  });

  it('creates exclusively, normalizes vocabularies, and round-trips atomically', async () => {
    const root = await tempRoot();
    const additionalRoot = await tempRoot();
    const locator = { projectId: 'demo', isBuiltin: false, projectRoot: root, appIsPackaged: true };
    await createProjectConfigExclusive(locator, {
      ...projectFile('demo', root),
      basic: {
        ...projectFile('demo', root).basic,
        additionalPaths: [additionalRoot, additionalRoot],
        disciplines: ['程序', '通用', '程序'],
      },
      metadata: [{ rootPath: additionalRoot, sourcePath: 'AGENTS.md', itemType: 'agents-md' }],
    });
    await expect(
      createProjectConfigExclusive(locator, projectFile('demo', root)),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    const loaded = await readEffectiveProjectConfig(locator);
    expect(loaded?.basic.disciplines).toEqual(['通用', '程序']);
    expect(loaded?.basic.additionalPaths).toEqual([path.normalize(additionalRoot)]);
    expect(loaded?.metadata).toEqual([
      expect.objectContaining({
        rootPath: path.normalize(additionalRoot),
        sourcePath: 'AGENTS.md',
        itemType: 'agents-md',
      }),
    ]);

    await saveProjectConfig(locator, {
      ...loaded!,
      basic: { ...loaded!.basic, displayName: 'Next' },
    });
    expect(
      JSON.parse(await readFile(path.join(root, '.meka', 'project.json'), 'utf8')),
    ).toMatchObject({ projectId: 'demo', basic: { displayName: 'Next' } });
  });

  it('rejects path traversal and a mismatched project identity', () => {
    const root = 'C:\\demo';
    expect(() =>
      normalizeMekaProjectFile(
        {
          ...projectFile('demo', root),
          metadata: [{ sourcePath: '../secret', itemType: 'rule' }],
        },
        'demo',
      ),
    ).toThrow(/canonical relative POSIX path/);
    expect(() => normalizeMekaProjectFile(projectFile('other', root), 'demo')).toThrow(
      /projectId mismatch/,
    );
  });
});

describe('Meka role manifest boundary', () => {
  const base: MekaRoleManifestFile = {
    schemaVersion: 1,
    id: 'role-a',
    projectId: 'demo',
    name: 'role-a',
    displayName: '程序',
    skills: [],
    promptFragments: [],
    mcp: [],
  };

  it('keeps secret references but rejects raw MCP credentials', () => {
    expect(
      normalizeMekaRoleManifest(
        {
          ...base,
          mcp: [
            {
              id: 'server',
              transport: 'stdio',
              command: 'node',
              env: { TOKEN: '{{secret:gitlab.token}}' },
            },
          ],
        },
        'role-a',
        'demo',
      ).mcp,
    ).toHaveLength(1);

    expect(() =>
      normalizeMekaRoleManifest(
        {
          ...base,
          mcp: [{ id: 'server', transport: 'stdio', command: 'node', env: { TOKEN: 'raw-token' } }],
        },
        'role-a',
        'demo',
      ),
    ).toThrow(/must use \{\{secret:name\}\}/);
  });

  it('rejects role/project identity substitution', () => {
    expect(() => normalizeMekaRoleManifest(base, 'role-b', 'demo')).toThrow(/role id mismatch/);
    expect(() => normalizeMekaRoleManifest(base, 'role-a', 'other')).toThrow(
      /role projectId mismatch/,
    );
  });

  it('loads an immutable builtin role manifest from application resources', async () => {
    await expect(readBuiltinRoleManifest('combat-debug', 'saga2')).resolves.toMatchObject({
      id: 'combat-debug',
      projectId: 'saga2',
      displayName: '战斗调试',
    });
  });
});
