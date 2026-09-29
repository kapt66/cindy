import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 包内角色清单目录的取样点。默认仍是**真实**资源目录（随包已不再附带任何角色清单文件，
 * `resources/meka/roles/` 整个目录都不存在 ⇒ T3 的空目录）；只有需要覆盖「项目快照与包内清单
 * 合并、退役角色过滤」的用例才把它指向临时目录里的夹具清单 —— 那是这些机制唯一还能被驱动的
 * 输入（真实包内已没有任何角色文件）。
 */
const h = vi.hoisted(() => ({ rolesRoot: null as string | null }));

vi.mock('../resourcePaths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../resourcePaths.js')>();
  return {
    ...actual,
    bundledMekaRolesRoot: () => h.rolesRoot ?? actual.bundledMekaRolesRoot(),
  };
});

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
  readBuiltinRoleManifestOrProjectDefault,
  readBundledRoleManifests,
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

/**
 * 在临时目录里造一份「随包角色清单」夹具，并把它接到 `bundledMekaRolesRoot()` 上。
 * 只有需要非空包内 catalog 的用例才调用；`afterEach` 会把它复位回真实资源目录。
 */
async function useBundledRoleCatalog(
  manifests: readonly MekaRoleManifestFile[],
): Promise<string> {
  const root = await tempRoot();
  h.rolesRoot = root;
  for (const manifest of manifests) {
    await writeFile(path.join(root, `${manifest.id}.json`), `${JSON.stringify(manifest)}\n`, 'utf8');
  }
  return root;
}

afterEach(async () => {
  h.rolesRoot = null;
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
      // The bundled baseline ships without a formal workflow: `workflowType` is the source of
      // truth and `formalWorkflowEnabled` is derived from it by normalizeMekaProjectFile, so
      // `none` here also means the project has no formal-workflow entry.
      basic: { displayName: 'SAGA2', workflowType: 'none', formalWorkflowEnabled: false },
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

  it('uses a SAGA2 project file as the authoritative project source', async () => {
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
    // The packaged role catalog is empty now (the `roles/` directory is not shipped any more), so
    // nothing can be merged into — or re-materialized on top of — the project-owned file: a project
    // file that declares no roles stays declaring none.
    expect(loaded?.builtinRoles).toBeUndefined();
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
    // 退役过滤只在「包内确实有角色清单」时才启动（`mergeBundledRoleFallbacks` 的空 catalog 早退），
    // 而随包已不再附带任何角色文件 ⇒ 这条机制的唯一输入就是夹具清单。夹具角色同时充当
    // 「项目快照优先于包内清单」的对照项。
    const bundledRole = roleManifest('bundled-sample-role', 'saga2');
    await useBundledRoleCatalog([bundledRole]);
    const bundled = await readEffectiveProjectConfig(locator);
    // The project file of an older build can still carry snapshots of roles that are retired now.
    // They must be filtered out of the *effective* configuration instead of being re-materialized
    // as ghost built-in roles: `general-development` is a retired default-role alias, and
    // `combat-config` is a retired id with a fixed replacement.
    const overriddenRole = {
      ...bundled!.builtinRoles!.find((role) => role.id === 'bundled-sample-role')!,
      displayName: 'Project-owned bundle',
    };
    const retiredMappingRole = roleManifest('combat-config', 'saga2');
    const retiredDefaultRoleAlias = {
      ...roleManifest('general-development', 'saga2'),
      displayName: 'Project-owned development',
      prompt: '# Project-owned development',
    };
    const customRole = roleManifest('custom-role', 'saga2');
    const configPath = path.join(root, '.meka', 'project.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...bundled,
        builtinRoles: [overriddenRole, retiredMappingRole, retiredDefaultRoleAlias, customRole],
      })}\n`,
      'utf8',
    );

    const loaded = await readEffectiveProjectConfig(locator);

    expect(loaded?.builtinRoles?.map((role) => role.id)).toEqual([
      'bundled-sample-role',
      'custom-role',
    ]);
    // A project-owned snapshot of a still-bundled role wins over the packaged manifest.
    expect(loaded?.builtinRoles?.find((role) => role.id === 'bundled-sample-role')?.displayName).toBe(
      'Project-owned bundle',
    );
    // The role the user actually owns outside the bundled catalog is preserved as it was written.
    expect(loaded?.builtinRoles?.find((role) => role.id === 'custom-role')).toMatchObject(
      customRole,
    );
    // Reading never rewrites the file: the retired snapshots stay on disk until an explicit save.
    const persisted = JSON.parse(await readFile(configPath, 'utf8')) as MekaProjectFile;
    expect(persisted.builtinRoles?.map((role) => role.id)).toEqual([
      'bundled-sample-role',
      'combat-config',
      'general-development',
      'custom-role',
    ]);
  });

  it('leaves retired built-in role snapshots alone in a non-SAGA2 project, including on save', async () => {
    const root = await tempRoot();
    const locator = {
      projectId: 'portable-project',
      isBuiltin: false,
      projectRoot: root,
      appIsPackaged: false,
    };
    const retiredDefaultRoleAlias = {
      ...roleManifest('general-development', 'portable-project'),
      displayName: 'Imported development',
      prompt: '# Imported development',
    };
    const retiredMappingRole = roleManifest('combat-config', 'portable-project');
    const configPath = path.join(root, '.meka', 'project.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...projectFile('portable-project', root),
        builtinRoles: [retiredDefaultRoleAlias, retiredMappingRole],
      })}\n`,
      'utf8',
    );

    const loaded = await readEffectiveProjectConfig(locator);

    // The retirement filter is deliberately scoped to the bundled project (`saga2`). Outside it
    // these ids may be user data (a hand-written file, an imported project), so neither reading
    // nor saving may drop them — silent deletion is the data-loss path the scope guard prevents.
    expect(loaded?.builtinRoles?.map((role) => role.id)).toEqual([
      'general-development',
      'combat-config',
    ]);
    expect(loaded?.builtinRoles?.[0]).toMatchObject({
      projectId: 'portable-project',
      displayName: 'Imported development',
      prompt: '# Imported development',
    });

    await saveProjectConfig(locator, {
      ...loaded!,
      basic: { ...loaded!.basic, displayName: 'Renamed portable' },
    });

    const persisted = JSON.parse(await readFile(configPath, 'utf8')) as MekaProjectFile;
    expect(persisted.basic.displayName).toBe('Renamed portable');
    expect(persisted.builtinRoles?.map((role) => role.id)).toEqual([
      'general-development',
      'combat-config',
    ]);
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
    // 参照角色来自「已登记项目的角色行」，与包内清单无关：这里用共享默认角色 + 一个中性角色行，
    // 覆盖的仍是同一条排序契约（先按 id 命中，再按显示名命中）。
    const references = [
      roleSummary('saga2-default-role', '默认角色', 0),
      roleSummary('legacy-bundled-role', '遗留内置角色', 1),
    ];
    const copiedRoles = [
      roleManifest('copied-bundled', 'copied-project'),
      roleManifest('copied-default', 'copied-project'),
    ];
    copiedRoles[0].displayName = '遗留内置角色';
    copiedRoles[1].displayName = '默认角色';

    expect(
      sortImportedRoleManifests(copiedRoles, references).map((role) => role.displayName),
    ).toEqual(['默认角色', '遗留内置角色']);
    expect(
      sortImportedRoleManifests(
        [roleManifest('legacy-bundled-role', 'saga2'), roleManifest('saga2-default-role', 'saga2')],
        references,
      ).map((role) => role.id),
    ).toEqual(['saga2-default-role', 'legacy-bundled-role']);
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
    await useBundledRoleCatalog([roleManifest('bundled-sample-role', 'saga2')]);
    const base = await readEffectiveProjectConfig(locator);
    expect(base?.builtinRoles?.map((role) => role.id)).toEqual(['bundled-sample-role']);
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
    expect(state.file?.builtinRoles?.map((role) => role.id)).toEqual(['bundled-sample-role']);
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

  it('loads an immutable builtin role manifest from the packaged role catalog', async () => {
    // 严格读取的**成功**路径：包内角色清单文件存在时照旧原样读出（随包已不再附带任何角色文件，
    // 因此用夹具目录代表「包里确实有这份清单」的唯一形态）。
    await useBundledRoleCatalog([
      { ...roleManifest('bundled-sample-role', 'saga2'), displayName: '夹具内置角色' },
    ]);
    await expect(readBuiltinRoleManifest('bundled-sample-role', 'saga2')).resolves.toMatchObject({
      id: 'bundled-sample-role',
      projectId: 'saga2',
      displayName: '夹具内置角色',
    });
  });

  it('ships no editable bundled role: the packaged role catalog reads as empty, not as an error', async () => {
    // T3 容错：随包已不再附带任何角色清单文件，`resources/meka/roles/` 目录整个不存在（git 不跟踪
    // 空目录）⇒ `readdir` 的 ENOENT 必须被当成「没有内置角色」。若这里重新抛错，存量内置角色行的
    // 会话解析与面板读清单会一起硬失败。
    const bundled = await readBundledRoleManifests('saga2');
    expect(bundled).toEqual([]);
    // 同一个空目录口径与项目 id 无关：任何项目都取不到包内角色清单。
    await expect(readBundledRoleManifests('portable-project')).resolves.toEqual([]);

    // 严格读取**不**放宽：文件缺失仍然硬失败。这条路径是消费者用来发现「包内清单没了」的判据，
    // 回落只存在于 `readBuiltinRoleManifestOrProjectDefault`（T2），不能顺手把严格版也改成降级。
    await expect(readBuiltinRoleManifest('combat-development', 'saga2')).rejects.toThrow(
      /builtin Meka role combat-development not found/,
    );
    await expect(readBuiltinRoleManifest('saga2-default-role', 'saga2')).rejects.toThrow(
      /builtin Meka role saga2-default-role not found/,
    );
  });

  it('falls back to the project default role when a builtin role manifest is missing (T2)', async () => {
    // T2 容错：`seedBuiltinMekaProjects` 只 upsert、从不删除不在注册表里的行，所以存量库里会留下
    // 指向已删清单的内置角色行（`combat-development` 就是必然的那一个）。回落到该项目的默认角色，
    // 而不是抛错 —— 这条边界同时覆盖会话解析（`runtimeConfig.resolveRoleFile`）与面板读清单
    // （`localDb/ipc/mekaRoles.readRoleManifest`），两者共用同一个入口。
    await expect(
      readBuiltinRoleManifestOrProjectDefault('combat-development', 'saga2'),
    ).resolves.toMatchObject({
      id: 'saga2-default-role',
      projectId: 'saga2',
      displayName: '默认角色',
      useProjectDefaults: true,
    });
    // 请求的 id 本身就是默认角色时同样可用：出厂清单由内存函数提供，从不落盘。
    await expect(
      readBuiltinRoleManifestOrProjectDefault('saga2-default-role', 'saga2'),
    ).resolves.toMatchObject({ id: 'saga2-default-role' });
  });
});
