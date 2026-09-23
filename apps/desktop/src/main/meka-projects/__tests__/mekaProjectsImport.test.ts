import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MekaProjectFile, MekaRoleManifestFile } from '../../../shared/meka-projects.js';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  importedFile: null as MekaProjectFile | null,
  savedFile: null as MekaProjectFile | null,
  createdProject: null as Record<string, unknown> | null,
  projectRows: [] as Array<Record<string, unknown>>,
  failProjectId: null as string | null,
  roleRows: [] as Array<Record<string, unknown>>,
  createRole: vi.fn(),
  ensureDefaultRole: vi.fn(),
  ensureDefaultRoleRow: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => 'C:\\CindyMekaTest' },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

vi.mock('../../meka-settings/ipc.js', () => ({
  getMekaP4SettingsService: () => ({ get: async () => ({ p4RootPath: 'C:\\Workspace\\saga2' }) }),
}));

vi.mock('../projectConfig.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projectConfig.js')>();
  return {
    ...actual,
    createProjectConfigExclusive: vi.fn(),
    readProjectConfigAtRoot: vi.fn(async (_root: string, targetProjectId?: string) =>
      h.importedFile && targetProjectId
        ? {
            ...h.importedFile,
            projectId: targetProjectId,
            builtinRoles: h.importedFile.builtinRoles?.map((role) => ({
              ...role,
              projectId: targetProjectId,
            })),
          }
        : h.importedFile,
    ),
    readProjectConfigState: vi.fn(async (locator: { projectId: string }) => {
      if (locator.projectId === h.failProjectId) throw new Error('projectId mismatch');
      return {
        file:
          locator.projectId === 'saga2'
            ? {
                schemaVersion: 1,
                projectId: 'saga2',
                basic: { name: 'saga2', displayName: 'SAGA2', path: 'C:\\Workspace\\saga2' },
                metadata: [],
              }
            : h.savedFile,
        source: locator.projectId === 'saga2' ? 'builtin' : 'project',
      };
    }),
    resolveCustomRoleManifestPath: (roleId: string) => `C:\\roles\\${roleId}.json`,
    resolveProjectConfigPath: () => 'C:\\project.json',
    saveProjectConfig: vi.fn(async (_locator: unknown, file: MekaProjectFile) => {
      h.savedFile = file;
      return file;
    }),
  };
});

vi.mock('../../localDb/ipc/mekaRoles.js', () => ({
  createMekaRole: h.createRole,
  // `ensureDefaultMekaRole` no longer exists in the module, but it stays mocked on purpose:
  // if it is ever re-added and called for a fresh project, the call lands here and the
  // `not.toHaveBeenCalled()` assertions below fail loudly instead of throwing an opaque
  // TypeError from an undefined import.
  ensureDefaultMekaRole: h.ensureDefaultRole,
  ensureMekaDefaultRoleRow: h.ensureDefaultRoleRow,
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM meka_projects')) {
        return h.projectRows.length > 0
          ? h.projectRows
          : [
              {
                id: 'saga2',
                name: 'saga2',
                path: 'saga2',
                tags: '[]',
                is_builtin: 1,
                sort_order: 0,
                created_at: null,
                updated_at: null,
              },
            ];
      }
      if (sql.includes('FROM meka_roles')) {
        if (params[0] === 'saga2') {
          // The bundled SAGA2 catalog after the consolidation: the shared default role plus the
          // still-packaged combat role. `general-development` is retired and is deliberately NOT
          // part of this fixture any more.
          return [
            {
              id: 'saga2-default-role',
              project_id: 'saga2',
              name: 'saga2-default-role',
              display_name: '默认角色',
              description: null,
              tags: '["builtin","default"]',
              file_path: 'meka/roles/saga2-default-role.json',
              is_builtin: 1,
              content_digest: null,
              sort_order: -1,
              created_at: null,
              updated_at: null,
            },
            {
              id: 'combat-development',
              project_id: 'saga2',
              name: 'combat-development',
              display_name: '战斗开发',
              description: null,
              tags: '[]',
              file_path: 'meka/roles/combat-development.json',
              is_builtin: 1,
              content_digest: null,
              sort_order: 0,
              created_at: null,
              updated_at: null,
            },
          ];
        }
        return h.roleRows.filter((row) => row.project_id === params[0]);
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    queryOne: async (_sql: string, params: unknown[] = []) =>
      h.createdProject?.id === params[0] ? h.createdProject : undefined,
    exec: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO meka_projects')) {
        h.createdProject = {
          id: params[0],
          name: params[1],
          path: params[2],
          tags: params[3],
          is_builtin: 0,
          sort_order: 0,
          created_at: params[4],
          updated_at: params[5],
        };
      }
    },
  }),
}));

import {
  MEKA_PROJECT_CREATE,
  MEKA_PROJECT_LIST,
  registerMekaProjectsIpc,
} from '../../localDb/ipc/mekaProjects.js';

function role(id: string, displayName: string): MekaRoleManifestFile {
  return {
    schemaVersion: 1,
    id,
    projectId: 'saga2',
    name: id,
    displayName,
    tags: [],
    policyProviderRefs: [],
    rules: [],
    skills: [],
    promptFragments: [],
    mcp: [],
    projectMetadataSelection: [],
  };
}

describe('Meka copied project import', () => {
  beforeEach(() => {
    h.handlers.clear();
    h.savedFile = null;
    h.createdProject = null;
    h.projectRows = [];
    h.failProjectId = null;
    h.roleRows = [];
    h.importedFile = null;
    h.createRole.mockReset();
    h.ensureDefaultRole.mockReset();
    h.ensureDefaultRoleRow.mockReset();
    h.createRole.mockImplementation(async (input: Record<string, unknown>) => {
      const roleFile = input.roleFile as MekaRoleManifestFile;
      const id = `cloned-role-${h.roleRows.length + 1}`;
      const row = {
        id,
        project_id: input.projectId,
        name: id,
        display_name: roleFile.displayName,
        description: roleFile.description ?? null,
        tags: JSON.stringify(roleFile.tags ?? []),
        file_path: `meka-roles/${id}.json`,
        is_builtin: 0,
        content_digest: null,
        sort_order: input.sortOrder,
        created_at: 1,
        updated_at: 1,
      };
      h.roleRows.push(row);
      return {
        id,
        projectId: input.projectId,
        name: id,
        displayName: roleFile.displayName,
        description: roleFile.description ?? null,
        tags: roleFile.tags ?? [],
        filePath: row.file_path,
        isBuiltin: false,
        contentDigest: null,
        sortOrder: input.sortOrder,
        createdAt: 1,
        updatedAt: 1,
      };
    });
    registerMekaProjectsIpc();
  });

  it('renames a copied SAGA2 project and materializes every role snapshot', async () => {
    const root = path.join(path.parse(process.cwd()).root, 'Workspace', 'saga2_project_git');
    h.importedFile = {
      schemaVersion: 1,
      projectId: 'target-project',
      basic: { name: 'saga2', displayName: 'SAGA2', path: root },
      metadata: [],
      builtinRoles: [
        role('combat-development', '战斗开发'),
        role('general-development', '通用开发'),
      ],
    };
    const handler = h.handlers.get(MEKA_PROJECT_CREATE)!;

    const created = (await handler({}, { path: root, displayName: 'SAGA2' })) as {
      id: string;
      displayName: string;
      roles: Array<{ id: string; displayName: string; isBuiltin: boolean }>;
    };

    expect(created.displayName).toBe('saga2_project_git');
    // Ordering follows the bundled catalog: `combat-development` is still a packaged role, while
    // the retired `general-development` snapshot has no catalog entry and sorts last.
    expect(created.roles.map((item) => item.displayName)).toEqual(['战斗开发', '通用开发']);
    expect(h.ensureDefaultRole).not.toHaveBeenCalled();
    expect(h.createRole).toHaveBeenCalledTimes(2);
    expect(h.createRole.mock.calls.map((call) => call[0].sortOrder)).toEqual([0, 1]);
    expect(h.savedFile).toMatchObject({
      projectId: created.id,
      basic: { name: 'saga2_project_git', displayName: 'saga2_project_git', path: root },
    });
    expect(h.savedFile?.builtinRoles?.map((item) => item.id)).toEqual([
      'cloned-role-1',
      'cloned-role-2',
    ]);
    expect(h.savedFile?.builtinRoles?.every((item) => item.projectId === created.id)).toBe(true);

    // A retired-role snapshot is user data, not a catalog entry: the import must clone it into a
    // freshly identified custom role and keep the name the user saw. No retirement sweep runs on
    // this path, so the snapshot can never be dropped here.
    expect(
      h.createRole.mock.calls.map((call) => (call[0].roleFile as MekaRoleManifestFile).id).sort(),
    ).toEqual(['combat-development', 'general-development']);
    const clonedGeneralRole = h.roleRows.find((row) => row.display_name === '通用开发');
    expect(clonedGeneralRole).toBeDefined();
    expect(clonedGeneralRole?.is_builtin).toBe(0);
    expect(clonedGeneralRole?.id).not.toBe('general-development');
    expect(new Set(h.savedFile?.builtinRoles?.map((item) => item.displayName))).toEqual(
      new Set(['战斗开发', '通用开发']),
    );
  });

  it('keeps SAGA2 visible when another registered project has an unreadable config', async () => {
    h.projectRows = [
      {
        id: 'saga2',
        name: 'saga2',
        path: 'saga2',
        tags: '[]',
        is_builtin: 1,
        sort_order: 0,
        created_at: null,
        updated_at: null,
      },
      {
        id: 'broken-project',
        name: 'Broken project',
        path: 'C:\\Workspace\\broken-project',
        tags: '[]',
        is_builtin: 0,
        sort_order: 1,
        created_at: null,
        updated_at: null,
      },
    ];
    h.failProjectId = 'broken-project';
    h.roleRows = [
      {
        id: 'broken-role',
        project_id: 'broken-project',
        name: 'broken-role',
        display_name: '保留角色',
        description: null,
        tags: '[]',
        file_path: 'meka-roles/broken-role.json',
        is_builtin: 0,
        content_digest: null,
        sort_order: 0,
        created_at: null,
        updated_at: null,
      },
    ];

    const projects = (await h.handlers.get(MEKA_PROJECT_LIST)!({})) as Array<{
      id: string;
      configUnavailable: boolean;
      roles: Array<{ id: string }>;
    }>;

    expect(projects.map((project) => project.id)).toEqual(['saga2', 'broken-project']);
    expect(projects[1].roles.map((role) => role.id)).toEqual(['broken-role']);
    // The builtin project still resolves its bundled configuration; the unreadable one must be
    // reported so the Renderer can offer removing it instead of showing a stuck project.
    expect(projects.map((project) => project.configUnavailable)).toEqual([false, true]);
  });

  it('hydrates bundled roles when a copied SAGA2 project file has no role snapshots', async () => {
    const root = path.join(path.parse(process.cwd()).root, 'Workspace', 'saga2_project_git');
    h.importedFile = {
      schemaVersion: 1,
      projectId: 'saga2',
      basic: { name: 'saga2', displayName: 'SAGA2', path: root },
      metadata: [],
    };

    const created = (await h.handlers.get(MEKA_PROJECT_CREATE)!(
      {},
      {
        path: root,
        displayName: 'SAGA2',
      },
    )) as { id: string };

    expect(h.ensureDefaultRole).not.toHaveBeenCalled();
    // Only `combat-development` is still packaged; the retired `general-development` manifest file
    // is gone, so the bundled fallback yields exactly one role snapshot.
    expect(h.createRole).toHaveBeenCalledTimes(1);
    expect(h.savedFile?.builtinRoles).toHaveLength(1);
    expect(h.savedFile?.builtinRoles?.map((item) => item.displayName)).toEqual(['战斗开发']);
    expect(h.savedFile?.builtinRoles?.every((item) => item.projectId === created.id)).toBe(true);
  });

  it('imports a copied config even when an older registered project cannot be inspected', async () => {
    const root = path.join(path.parse(process.cwd()).root, 'Workspace', 'copied-project');
    h.projectRows = [
      {
        id: 'saga2',
        name: 'saga2',
        path: 'saga2',
        tags: '[]',
        is_builtin: 1,
        sort_order: 0,
        created_at: null,
        updated_at: null,
      },
      {
        id: 'broken-project',
        name: 'Broken project',
        path: 'C:\\Workspace\\broken-project',
        tags: '[]',
        is_builtin: 0,
        sort_order: 1,
        created_at: null,
        updated_at: null,
      },
    ];
    h.failProjectId = 'broken-project';
    h.importedFile = {
      schemaVersion: 1,
      projectId: 'source-project',
      basic: { name: 'source-project', displayName: 'Copied project', path: root },
      metadata: [],
    };
    h.ensureDefaultRole.mockResolvedValue({ id: 'default-role' });

    const created = (await h.handlers.get(MEKA_PROJECT_CREATE)!(
      {},
      {
        path: root,
        displayName: 'Copied project',
      },
    )) as { id: string };

    expect(created.id).not.toBe('source-project');
    expect(h.savedFile?.projectId).toBe(created.id);
  });

  it('flags a registered project whose project file disappeared as config-unavailable', async () => {
    const root = path.join(path.parse(process.cwd()).root, 'Workspace', 'vanished-project');
    h.projectRows = [
      {
        id: 'vanished-project',
        name: 'Vanished project',
        path: root,
        tags: '[]',
        is_builtin: 0,
        sort_order: 1,
        created_at: null,
        updated_at: null,
      },
    ];
    // `h.savedFile` stays null: the registration exists but no project-owned file can be read.
    const projects = (await h.handlers.get(MEKA_PROJECT_LIST)!({})) as Array<{
      id: string;
      displayName: string;
      configUnavailable: boolean;
    }>;

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: 'vanished-project',
      displayName: 'Vanished project',
      configUnavailable: true,
    });
  });

  it('registers a freshly created project under the name the user sees', async () => {
    const root = path.join(path.parse(process.cwd()).root, 'Workspace', 'brand-new-project');
    h.ensureDefaultRole.mockResolvedValue({ id: 'default-role' });

    const created = (await h.handlers.get(MEKA_PROJECT_CREATE)!(
      {},
      { path: root, displayName: 'Brand New Project' },
    )) as { id: string; displayName: string };

    // The generated id stays out of `meka_projects.name`: that column is the display fallback
    // used once the project file is gone, so a deleted directory must not surface as an id.
    expect(h.createdProject?.name).toBe('Brand New Project');
    expect(created.id).not.toBe('Brand New Project');
    expect(created.displayName).toBe('Brand New Project');
    // The shared default role must exist right away, not only after the next restart's seed,
    // and it is the project's ONLY role: the legacy empty editable "通用" role is gone, so a
    // brand-new project cannot show two near-identical empty roles.
    expect(h.ensureDefaultRoleRow).toHaveBeenCalledWith(created.id);
    expect(h.ensureDefaultRole).not.toHaveBeenCalled();
    expect(h.createRole).not.toHaveBeenCalled();
  });
});
