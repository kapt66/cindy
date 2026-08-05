import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MekaProjectFile, MekaRoleManifestFile } from '../../../shared/meka-projects.js';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  importedFile: null as MekaProjectFile | null,
  savedFile: null as MekaProjectFile | null,
  createdProject: null as Record<string, unknown> | null,
  roleRows: [] as Array<Record<string, unknown>>,
  createRole: vi.fn(),
  ensureDefaultRole: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => 'C:\\CindyMekaTest' },
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
    readProjectConfigState: vi.fn(async (locator: { projectId: string }) => ({
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
    })),
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
  ensureDefaultMekaRole: h.ensureDefaultRole,
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM meka_projects')) {
        return [
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
          return [
            {
              id: 'general-development',
              project_id: 'saga2',
              name: 'general-development',
              display_name: '通用开发',
              description: null,
              tags: '[]',
              file_path: 'meka/roles/general-development.json',
              is_builtin: 1,
              content_digest: null,
              sort_order: 0,
              created_at: null,
              updated_at: null,
            },
            {
              id: 'combat-config',
              project_id: 'saga2',
              name: 'combat-config',
              display_name: '战斗配置',
              description: null,
              tags: '[]',
              file_path: 'meka/roles/combat-config.json',
              is_builtin: 1,
              content_digest: null,
              sort_order: 2,
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
    h.roleRows = [];
    h.importedFile = null;
    h.createRole.mockReset();
    h.ensureDefaultRole.mockReset();
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
      builtinRoles: [role('combat-config', '战斗配置'), role('general-development', '通用开发')],
    };
    const handler = h.handlers.get(MEKA_PROJECT_CREATE)!;

    const created = (await handler({}, { path: root, displayName: 'SAGA2' })) as {
      id: string;
      displayName: string;
      roles: Array<{ displayName: string }>;
    };

    expect(created.displayName).toBe('saga2_project_git');
    expect(created.roles.map((item) => item.displayName)).toEqual(['通用开发', '战斗配置']);
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
  });
});
