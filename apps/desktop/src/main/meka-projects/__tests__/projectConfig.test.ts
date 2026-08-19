import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  MekaProjectFile,
  MekaRole,
  MekaRoleManifestFile,
} from '../../../shared/meka-projects.js';
import {
  cloneMekaRoleManifestForProject,
  createProjectConfigExclusive,
  normalizeMekaProjectFile,
  normalizeMekaRoleManifest,
  readBuiltinRoleManifest,
  readEffectiveProjectConfig,
  readProjectConfigAtRoot,
  readProjectConfigState,
  renameImportedProjectOnConflict,
  saveProjectConfig,
  sortImportedRoleManifests,
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

function roleManifest(id: string, projectId: string): MekaRoleManifestFile {
  return {
    schemaVersion: 1,
    id,
    projectId,
    name: id,
    displayName: id,
    policyProviderRefs: [],
    rules: [],
    skills: [],
    promptFragments: [],
    mcp: [],
    projectMetadataSelection: [],
  };
}

function roleSummary(id: string, displayName: string, sortOrder: number): MekaRole {
  return {
    id,
    projectId: 'saga2',
    name: id,
    displayName,
    description: null,
    tags: [],
    filePath: `meka/roles/${id}.json`,
    isBuiltin: true,
    contentDigest: null,
    sortOrder,
    createdAt: null,
    updatedAt: null,
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

  it('uses a SAGA2 project file as the authoritative project source with bundled role fallback', async () => {
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
    expect(loaded?.builtinRoles).toHaveLength(2);
    const persisted = JSON.parse(
      await readFile(path.join(configDirectory, 'project.json'), 'utf8'),
    ) as MekaProjectFile;
    expect(persisted.metadata).toEqual([]);
    expect(persisted.builtinRoles).toBeUndefined();
  });

  it('accepts a UTF-8 BOM in a project-owned configuration', async () => {
    const root = await tempRoot();
    const configPath = path.join(root, '.meka', 'project.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `\uFEFF${JSON.stringify({
        ...projectFile('saga2', root),
        basic: { displayName: 'SAGA2 with BOM', path: root },
      })}\n`,
      'utf8',
    );

    const state = await readProjectConfigState({
      projectId: 'saga2',
      isBuiltin: true,
      projectRoot: root,
      appIsPackaged: false,
    });

    expect(state.source).toBe('project');
    expect(state.file?.basic.displayName).toBe('SAGA2 with BOM');
  });

  it('prefers project-owned role snapshots, removes retired SAGA2 roles, and preserves custom roles', async () => {
    const root = await tempRoot();
    const locator = {
      projectId: 'saga2',
      isBuiltin: true,
      projectRoot: root,
      appIsPackaged: false,
    };
    const bundled = await readEffectiveProjectConfig(locator);
    const overriddenRole = {
      ...bundled!.builtinRoles!.find((role) => role.id === 'general-development')!,
      displayName: 'Project-owned development',
      includeAllProjectMetadata: undefined,
    };
    const retiredRole = roleManifest('combat-config', 'saga2');
    const customRole = roleManifest('custom-role', 'saga2');
    const configPath = path.join(root, '.meka', 'project.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...bundled,
        builtinRoles: [overriddenRole, retiredRole, customRole],
      })}\n`,
      'utf8',
    );

    const loaded = await readEffectiveProjectConfig(locator);

    expect(loaded?.builtinRoles?.map((role) => role.id)).toEqual([
      'combat-development',
      'general-development',
      'custom-role',
    ]);
    expect(
      loaded?.builtinRoles?.find((role) => role.id === 'general-development')?.displayName,
    ).toBe('Project-owned development');
    expect(
      loaded?.builtinRoles?.find((role) => role.id === 'general-development')
        ?.includeAllProjectMetadata,
    ).toBe(true);
    const persisted = JSON.parse(await readFile(configPath, 'utf8')) as MekaProjectFile;
    expect(persisted.builtinRoles).toHaveLength(3);
  });

  it.each(['', path.resolve(path.sep, 'previous-checkout')])(
    'anchors portable project files to the selected directory when path is %j',
    async (storedPath) => {
      const root = await tempRoot();
      const configDirectory = path.join(root, '.meka');
      await mkdir(configDirectory, { recursive: true });
      const configPath = path.join(configDirectory, 'project.json');
      await writeFile(
        configPath,
        `${JSON.stringify({
          schemaVersion: 1,
          projectId: 'portable-project',
          basic: {
            displayName: 'Portable project',
            path: storedPath,
            additionalPaths: [root],
          },
          metadata: [],
        })}\n`,
        'utf8',
      );

      const loaded = await readProjectConfigAtRoot(root);

      expect(loaded?.basic.path).toBe(path.resolve(root));
      expect(loaded?.basic.additionalPaths).toBeUndefined();
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
        basic: { path: storedPath },
      });

      await saveProjectConfig(
        {
          projectId: 'portable-project',
          isBuiltin: false,
          projectRoot: root,
          appIsPackaged: true,
        },
        loaded!,
      );
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
        basic: { path: path.resolve(root) },
      });
    },
  );

  it('reidentifies a copied project file and every embedded role for a new registration', async () => {
    const root = await tempRoot();
    const configDirectory = path.join(root, '.meka');
    await mkdir(configDirectory, { recursive: true });
    const configPath = path.join(configDirectory, 'project.json');
    await writeFile(
      configPath,
      `${JSON.stringify({
        schemaVersion: 1,
        projectId: 'source-project',
        basic: {
          displayName: 'Copied project',
          path: path.resolve(path.sep, 'source-checkout'),
        },
        metadata: [],
        builtinRoles: [
          roleManifest('copied-role', 'source-project'),
          roleManifest('previously-mismatched-role', 'other-project'),
        ],
      })}\n`,
      'utf8',
    );

    const inspected = await readProjectConfigAtRoot(root);
    expect(inspected).toMatchObject({
      projectId: 'source-project',
      basic: { path: path.resolve(root) },
    });
    expect(inspected?.builtinRoles?.map((role) => role.projectId)).toEqual([
      'source-project',
      'source-project',
    ]);

    const imported = await readProjectConfigAtRoot(root, 'target-project');
    expect(imported).toMatchObject({
      projectId: 'target-project',
      basic: { path: path.resolve(root) },
    });
    expect(imported?.builtinRoles?.map((role) => role.projectId)).toEqual([
      'target-project',
      'target-project',
    ]);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      projectId: 'source-project',
      basic: { path: path.resolve(path.sep, 'source-checkout') },
    });
  });

  it('clones imported role content under fresh project and role identities', () => {
    const source = {
      ...roleManifest('saga2-role', 'saga2'),
      displayName: '战斗配置',
      tags: [],
      prompt: 'Keep the imported role content.',
      skills: [{ id: 'combat-skill', path: 'skills/combat-skill' }],
    } satisfies MekaRoleManifestFile;

    expect(cloneMekaRoleManifestForProject(source, 'copied-project', 'copied-role')).toEqual({
      ...source,
      id: 'copied-role',
      projectId: 'copied-project',
      name: 'copied-role',
    });
  });

  it('uses the directory name when an imported display name is already registered', () => {
    const root = path.join(path.parse(process.cwd()).root, 'Workspace', 'saga2_project_git');
    const source = {
      ...projectFile('copied-project', root),
      basic: { displayName: 'SAGA2', path: root },
    };

    const renamed = renameImportedProjectOnConflict(source, root, ['saga2']);
    expect(renamed.basic).toMatchObject({
      name: 'saga2_project_git',
      displayName: 'saga2_project_git',
    });

    const suffixed = renameImportedProjectOnConflict(source, root, ['SAGA2', 'saga2_project_git']);
    expect(suffixed.basic.displayName).toBe('saga2_project_git (2)');
    expect(renameImportedProjectOnConflict(source, root, ['Another project'])).toBe(source);
  });

  it('restores source role order by id and then display name for copied role ids', () => {
    const references = [
      roleSummary('general-development', '通用开发', 0),
      roleSummary('combat-development', '战斗开发', 1),
    ];
    const copiedRoles = [
      roleManifest('copied-combat', 'copied-project'),
      roleManifest('copied-general', 'copied-project'),
    ];
    copiedRoles[0].displayName = '战斗开发';
    copiedRoles[1].displayName = '通用开发';

    expect(
      sortImportedRoleManifests(copiedRoles, references).map((role) => role.displayName),
    ).toEqual(['通用开发', '战斗开发']);
    expect(
      sortImportedRoleManifests(
        [roleManifest('combat-development', 'saga2'), roleManifest('general-development', 'saga2')],
        references,
      ).map((role) => role.id),
    ).toEqual(['general-development', 'combat-development']);
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

  it('normalizes a copied project identity in memory without rewriting on read', async () => {
    const root = await tempRoot();
    const configPath = path.join(root, '.meka', 'project.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...projectFile('saga2', root),
        basic: { displayName: 'Copied SAGA2', path: 'saga2' },
        builtinRoles: [roleManifest('copied-role', 'saga2')],
      })}\n`,
      'utf8',
    );

    const locator = {
      projectId: 'copied-project',
      isBuiltin: false,
      projectRoot: root,
      appIsPackaged: false,
    };
    const state = await readProjectConfigState(locator);

    expect(state.file).toMatchObject({
      projectId: 'copied-project',
      basic: { path: path.resolve(root) },
    });
    expect(state.file?.builtinRoles?.[0]?.projectId).toBe('copied-project');
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      projectId: 'saga2',
      basic: { path: 'saga2' },
      builtinRoles: [{ projectId: 'saga2' }],
    });
  });

  it('normalizes stale embedded role identities without rewriting on read', async () => {
    const root = await tempRoot();
    const configPath = path.join(root, '.meka', 'project.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...projectFile('copied-project', root),
        builtinRoles: [roleManifest('copied-role', 'source-project')],
      })}\n`,
      'utf8',
    );

    const state = await readProjectConfigState({
      projectId: 'copied-project',
      isBuiltin: false,
      projectRoot: root,
      appIsPackaged: false,
    });

    expect(state.file?.builtinRoles?.[0]?.projectId).toBe('copied-project');
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      projectId: 'copied-project',
      builtinRoles: [{ projectId: 'source-project' }],
    });
  });

  it('reidentifies a copied builtin override in memory while retaining all bundled roles', async () => {
    const root = await tempRoot();
    const locator = {
      projectId: 'saga2',
      isBuiltin: true,
      projectRoot: root,
      appIsPackaged: false,
    };
    const base = await readEffectiveProjectConfig(locator);
    expect(base?.builtinRoles).toHaveLength(2);
    const configPath = path.join(root, '.meka', 'project.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...base,
        projectId: 'source-project',
        builtinRoles: base!.builtinRoles!.map((role) => ({ ...role, projectId: 'source-project' })),
      })}\n`,
      'utf8',
    );

    const state = await readProjectConfigState(locator);

    expect(state.source).toBe('project');
    expect(state.file?.projectId).toBe('saga2');
    expect(state.file?.builtinRoles).toHaveLength(2);
    expect(state.file?.builtinRoles?.every((role) => role.projectId === 'saga2')).toBe(true);
    const persisted = JSON.parse(await readFile(configPath, 'utf8')) as MekaProjectFile;
    expect(persisted.projectId).toBe('source-project');
    expect(persisted.builtinRoles?.every((role) => role.projectId === 'source-project')).toBe(true);
  });

  it('preserves malformed project JSON until bundled fallback is explicitly saved', async () => {
    const root = await tempRoot();
    const configPath = path.join(root, '.meka', 'project.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    const malformed = '{"schemaVersion":1,"projectId":"saga2"';
    await writeFile(configPath, malformed, 'utf8');

    const locator = {
      projectId: 'saga2',
      isBuiltin: true,
      projectRoot: root,
      appIsPackaged: false,
    };
    const state = await readProjectConfigState(locator);

    expect(state.source).toBe('builtin');
    expect(state.file).toMatchObject({
      projectId: 'saga2',
      basic: { displayName: 'SAGA2' },
      builtinRoles: expect.any(Array),
    });
    expect(await readFile(configPath, 'utf8')).toBe(malformed);

    await saveProjectConfig(locator, {
      ...state.file!,
      basic: { ...state.file!.basic, displayName: 'Recovered SAGA2' },
    });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      projectId: 'saga2',
      basic: { displayName: 'Recovered SAGA2' },
    });
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
    await expect(readBuiltinRoleManifest('combat-development', 'saga2')).resolves.toMatchObject({
      id: 'combat-development',
      projectId: 'saga2',
      displayName: '战斗开发',
    });
  });
});
