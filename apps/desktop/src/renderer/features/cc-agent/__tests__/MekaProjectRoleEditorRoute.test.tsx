// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  MekaProject,
  MekaProjectFile,
  MekaProjectMetadata,
  MekaSkillCatalogEntry,
  MekaRoleManifestFile,
} from '../../../../shared/meka-projects';
import { MekaProjectRoleEditorRoute } from '../MekaProjectRoleEditorRoute';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/features/plugin/PluginManagementLayout', () => ({
  PluginManagementLayout: ({
    children,
    headerActions,
  }: {
    children: React.ReactNode;
    headerActions?: React.ReactNode;
  }) => (
    <div>
      {headerActions}
      {children}
    </div>
  ),
  PluginManagementPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../MekaProjectRemoteInstances', () => ({
  MekaProjectRemoteInstances: () => null,
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/mekaProjectsRolesBus', () => ({
  emitMekaProjectsRolesChanged: vi.fn(),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

function projectFile(projectId: string, displayName = 'Project A'): MekaProjectFile {
  return {
    schemaVersion: 1,
    projectId,
    basic: { displayName, path: 'C:/projects/a', disciplines: ['通用'], domains: [] },
    metadata: [],
  };
}

function projectSummary(roles: MekaProject['roles'] = []): MekaProject {
  return {
    id: 'project-a',
    name: 'project-a',
    displayName: 'Project A',
    description: null,
    path: 'C:/projects/a',
    tags: [],
    isBuiltin: false,
    configSource: 'project',
    sortOrder: 0,
    createdAt: null,
    updatedAt: null,
    roles,
  };
}

function roleManifest(): MekaRoleManifestFile {
  return {
    schemaVersion: 1,
    projectId: 'project-a',
    id: 'role-new',
    name: 'role-new',
    displayName: 'New role',
    description: '',
    prompt: '',
    policyProviderRefs: [],
    rules: [],
    skills: [],
    promptFragments: [],
    mcp: [],
    projectMetadataSelection: [],
  };
}

function installApi(
  initialProjects: MekaProject[],
  options: {
    metadata?: MekaProjectMetadata[];
    catalog?: MekaSkillCatalogEntry[];
    inspectFile?: MekaProjectFile | null;
  } = {},
) {
  let projects = initialProjects;
  const showOpenDirectoryDialog = vi.fn(
    async (): Promise<{ canceled: boolean; path?: string }> => ({
      canceled: false,
      path: 'C:/projects/selected',
    }),
  );
  const createProject = vi.fn(
    async (input: { displayName: string; path: string; additionalPaths?: readonly string[] }) => {
      const created = { ...projectSummary(), displayName: input.displayName, path: input.path };
      projects = [created];
      return created;
    },
  );
  const createRole = vi.fn(
    async (_input: {
      projectId: string;
      roleFile: Omit<MekaRoleManifestFile, 'id' | 'name' | 'projectId'>;
    }) => {
      void _input;
      const manifest = roleManifest();
      const summary = {
        id: manifest.id,
        projectId: manifest.projectId,
        name: manifest.name,
        displayName: manifest.displayName,
        description: manifest.description ?? null,
        tags: [],
        filePath: 'role-new.json',
        isBuiltin: false,
        contentDigest: null,
        sortOrder: 1,
        createdAt: null,
        updatedAt: null,
      };
      projects = projects.map((project) =>
        project.id === 'project-a' ? { ...project, roles: [...project.roles, summary] } : project,
      );
      return summary;
    },
  );
  const saveProject = vi.fn(async ({ project }: { project: MekaProjectFile }) => {
    projects = projects.map((item) =>
      item.id === project.projectId ? { ...item, configSource: 'project' as const } : item,
    );
    return project;
  });
  const resetBuiltin = vi.fn(async () => projects[0]);
  const showOpenDirectory = vi.fn(async () => ({
    success: true,
    path: 'C:/projects/shared',
  }));
  const api = {
    dialog: { showOpenDirectory },
    localDb: {
      mekaProjects: {
        list: vi.fn(async () => projects),
        inspectPath: vi.fn(async () => options.inspectFile ?? null),
        create: createProject,
        resetBuiltin,
        delete: vi.fn(),
      },
      mekaRoles: {
        create: createRole,
        update: vi.fn(),
        delete: vi.fn(),
        readManifest: vi.fn(async (id: string) =>
          id ? { ...roleManifest(), id, name: id } : null,
        ),
      },
      mekaProjectMetadata: {
        loadProject: vi.fn(async (id: string) => projectFile(id)),
        list: vi.fn(async () => options.metadata ?? []),
        saveProject,
        discover: vi.fn(async () => []),
        gitRemote: vi.fn(async () => null),
      },
      mekaSkillCatalog: { list: vi.fn(async () => options.catalog ?? []) },
    },
  };
  const electronApi = {
    ...api,
    showOpenDirectoryDialog,
  };
  (window as unknown as { electronAPI: typeof electronApi }).electronAPI = electronApi;
  return {
    createProject,
    createRole,
    saveProject,
    updateRole: api.localDb.mekaRoles.update,
    resetBuiltin,
    showOpenDirectoryDialog,
    showOpenDirectory,
  };
}

function renderRoute(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <MekaProjectRoleEditorRoute />
    </MemoryRouter>,
  );
}

describe('Meka project and role create states', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('creates a project from its name and ordered directory list', async () => {
    const api = installApi([]);
    renderRoute();

    await screen.findByText('meka.empty');
    fireEvent.click(screen.getAllByRole('button', { name: 'meka.newProject' })[0]);

    expect(screen.getByRole('heading', { name: 'meka.newProject' })).toBeTruthy();
    expect(api.createProject).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('meka.projectName'), {
      target: { value: 'Configured project' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'meka.choosePrimaryDirectory' }));
    await screen.findByText('C:/projects/selected');
    fireEvent.click(screen.getByRole('button', { name: 'meka.createProjectAction' }));

    await waitFor(() => expect(api.createProject).toHaveBeenCalledTimes(1));
    expect(api.createProject).toHaveBeenCalledWith({
      displayName: 'Configured project',
      path: 'C:/projects/selected',
      additionalPaths: [],
    });
    expect(api.saveProject).not.toHaveBeenCalled();
  });

  it('selects a directory for a new project and keeps saved project paths immutable', async () => {
    const newProjectApi = installApi([]);
    renderRoute();

    await screen.findByText('meka.empty');
    fireEvent.click(screen.getAllByRole('button', { name: 'meka.newProject' })[0]);
    fireEvent.change(screen.getByLabelText('meka.projectName'), {
      target: { value: 'Selected project' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'meka.choosePrimaryDirectory' }));

    await waitFor(() => expect(newProjectApi.showOpenDirectoryDialog).toHaveBeenCalledTimes(1));
    expect(screen.getByText('C:/projects/selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'meka.createProjectAction' }));
    await waitFor(() => expect(newProjectApi.createProject).toHaveBeenCalledTimes(1));

    cleanup();
    const savedProjectApi = installApi([projectSummary()]);
    renderRoute('/?projectId=project-a');
    expect(((await screen.findByLabelText('meka.projectPath')) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'meka.chooseDirectory' })).toBeNull();
    expect(savedProjectApi.showOpenDirectoryDialog).not.toHaveBeenCalled();
  });

  it('uses an existing project file instead of overwriting dialog values', async () => {
    const existing = {
      ...projectFile('portable-project', 'Portable project'),
      basic: {
        ...projectFile('portable-project', 'Portable project').basic,
        additionalPaths: ['C:/projects/reference'],
      },
    };
    const api = installApi([], { inspectFile: existing });
    renderRoute();

    await screen.findByText('meka.empty');
    fireEvent.click(screen.getAllByRole('button', { name: 'meka.newProject' })[0]);
    fireEvent.change(screen.getByLabelText('meka.projectName'), {
      target: { value: 'Ignored name' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'meka.choosePrimaryDirectory' }));

    expect(await screen.findByDisplayValue('Portable project')).toBeTruthy();
    expect(screen.getByText('C:/projects/reference')).toBeTruthy();
    expect(screen.getByText('meka.existingProjectConfigDetected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'meka.createProjectAction' }));

    await waitFor(() => expect(api.createProject).toHaveBeenCalledTimes(1));
    expect(api.createProject).toHaveBeenCalledWith({
      displayName: 'Portable project',
      path: 'C:/projects/selected',
      additionalPaths: ['C:/projects/reference'],
    });
  });

  it('leaves a new project draft without persisting when cancelled', async () => {
    const api = installApi([]);
    renderRoute();

    await screen.findByText('meka.empty');
    fireEvent.click(screen.getAllByRole('button', { name: 'meka.newProject' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'logic.confirm.cancel' })[0]);

    expect(await screen.findByText('meka.empty')).toBeTruthy();
    expect(api.createProject).not.toHaveBeenCalled();
  });

  it('persists additional project paths selected from the project information editor', async () => {
    const api = installApi([projectSummary()]);
    renderRoute('/?projectId=project-a');

    await screen.findByRole('heading', { name: 'meka.projectBasicInfo' });
    fireEvent.click(screen.getByRole('button', { name: 'meka.addAdditionalPath' }));
    await screen.findByText('C:/projects/shared');
    fireEvent.click(screen.getByRole('button', { name: 'meka.save' }));

    await waitFor(() => expect(api.saveProject).toHaveBeenCalledTimes(1));
    expect(api.saveProject).toHaveBeenCalledWith({
      projectId: 'project-a',
      project: expect.objectContaining({
        basic: expect.objectContaining({ additionalPaths: ['C:/projects/shared'] }),
      }),
    });
  });

  it('persists project rules and MCP defaults into project.json', async () => {
    const api = installApi([projectSummary()]);
    renderRoute('/?projectId=project-a');

    await screen.findByRole('heading', { name: 'meka.projectBasicInfo' });
    fireEvent.click(screen.getByRole('button', { name: 'meka.addRule' }));
    fireEvent.change(screen.getByPlaceholderText('meka.mcpJsonPlaceholder'), {
      target: {
        value:
          '{"mcpServers":{"project-agent":{"command":"npx","args":["-y","@example/mcp-server"],"env":{"TOKEN":"{{secret:project-token}}"}}}}',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'meka.parseMcpJson' }));
    fireEvent.click(screen.getByRole('button', { name: 'meka.save' }));

    await waitFor(() => expect(api.saveProject).toHaveBeenCalledTimes(1));
    expect(api.saveProject).toHaveBeenCalledWith({
      projectId: 'project-a',
      project: expect.objectContaining({
        roleDefaults: expect.objectContaining({
          rules: [expect.objectContaining({ text: 'meka.newRuleText', enabled: true })],
          mcp: [
            {
              id: 'project-agent',
              transport: 'stdio',
              command: 'npx',
              args: ['-y', '@example/mcp-server'],
              enabled: true,
              env: { TOKEN: '{{secret:project-token}}' },
            },
          ],
        }),
      }),
    });
  });

  it('edits bundled roles from a project file and can reset the builtin project', async () => {
    const builtinRole = {
      id: 'general-development',
      projectId: 'saga2',
      name: 'general-development',
      displayName: 'General development',
      description: null,
      tags: [],
      filePath: 'meka/roles/general-development.json',
      isBuiltin: true,
      contentDigest: null,
      sortOrder: 0,
      createdAt: null,
      updatedAt: null,
    };
    const sagaProject: MekaProject = {
      ...projectSummary([builtinRole]),
      id: 'saga2',
      name: 'saga2',
      displayName: 'SAGA2',
      isBuiltin: true,
      configSource: 'project',
    };
    const api = installApi([sagaProject]);
    renderRoute('/?projectId=saga2');

    fireEvent.click(await screen.findByRole('button', { name: 'General development' }));
    expect(((await screen.findByLabelText('meka.roleName')) as HTMLInputElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'meka.projectDetails' }));
    fireEvent.click(await screen.findByRole('button', { name: 'meka.resetBuiltinProjectAction' }));

    await waitFor(() => expect(api.resetBuiltin).toHaveBeenCalledWith('saga2'));
  });

  it('allows editing bundled roles before a project file exists', async () => {
    const builtinRole = {
      id: 'general-development',
      projectId: 'saga2',
      name: 'general-development',
      displayName: 'General development',
      description: null,
      tags: [],
      filePath: 'meka/roles/general-development.json',
      isBuiltin: true,
      contentDigest: null,
      sortOrder: 0,
      createdAt: null,
      updatedAt: null,
    };
    const api = installApi([
      {
        ...projectSummary([builtinRole]),
        id: 'saga2',
        name: 'saga2',
        displayName: 'SAGA2',
        isBuiltin: true,
        configSource: 'builtin',
      },
    ]);
    renderRoute('/?projectId=saga2');

    fireEvent.click(await screen.findByRole('button', { name: 'General development' }));
    const roleName = (await screen.findByLabelText('meka.roleName')) as HTMLInputElement;
    expect(
      (screen.getByRole('button', { name: 'logic.confirm.cancel' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect((screen.getByRole('button', { name: 'meka.saveRole' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(roleName.disabled).toBe(false);
    fireEvent.change(roleName, { target: { value: 'Edited development' } });
    fireEvent.click(screen.getByRole('button', { name: 'meka.saveRole' }));

    await waitFor(() => expect(api.updateRole).toHaveBeenCalledTimes(1));
  });

  it('keeps project actions enabled and materializes bundled fallback on explicit Save', async () => {
    const api = installApi([
      {
        ...projectSummary(),
        id: 'saga2',
        name: 'saga2',
        isBuiltin: true,
        configSource: 'builtin',
      },
    ]);
    renderRoute('/?projectId=saga2');

    expect(await screen.findByText('meka.configurationSourceBuiltin')).toBeTruthy();
    const name = (await screen.findByLabelText('meka.projectName')) as HTMLInputElement;
    const cancel = screen.getByRole('button', { name: 'logic.confirm.cancel' });
    const save = screen.getByRole('button', { name: 'meka.save' });
    expect(name.disabled).toBe(false);
    await waitFor(() => {
      expect((cancel as HTMLButtonElement).disabled).toBe(false);
      expect((save as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.change(name, { target: { value: 'Recovered SAGA2' } });
    fireEvent.click(cancel);
    expect(name.value).toBe('Project A');
    fireEvent.click(save);

    await waitFor(() => expect(api.saveProject).toHaveBeenCalledTimes(1));
    expect(api.saveProject).toHaveBeenCalledWith(
      expect.objectContaining({
        project: expect.objectContaining({
          basic: expect.objectContaining({ displayName: 'Project A' }),
        }),
      }),
    );
    expect(await screen.findByText('meka.configurationSourceProject')).toBeTruthy();
  });

  it('opens the full role editor and only creates the role on Save', async () => {
    const api = installApi([projectSummary()]);
    renderRoute('/?projectId=project-a');

    fireEvent.click(await screen.findByRole('button', { name: 'meka.newRole' }));

    expect(api.createRole).not.toHaveBeenCalled();
    const save = screen.getByRole('button', { name: 'meka.saveRole' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(api.createRole).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('meka.roleName'), {
      target: { value: 'New role' },
    });
    fireEvent.click(save);

    await waitFor(() => expect(api.createRole).toHaveBeenCalledTimes(1));
    expect(api.createRole.mock.calls[0]?.[0]).toEqual({
      projectId: 'project-a',
      roleFile: expect.not.objectContaining({
        id: expect.anything(),
        name: expect.anything(),
        projectId: expect.anything(),
      }),
    });
  });

  it('returns from a new role draft without persisting when cancelled', async () => {
    const api = installApi([projectSummary()]);
    renderRoute('/?projectId=project-a');

    fireEvent.click(await screen.findByRole('button', { name: 'meka.newRole' }));
    fireEvent.click(screen.getByRole('button', { name: 'logic.confirm.cancel' }));

    expect(await screen.findByRole('heading', { name: 'meka.projectBasicInfo' })).toBeTruthy();
    expect(api.createRole).not.toHaveBeenCalled();
  });

  it('restores discipline and domain bulk selection for role resources', async () => {
    const role = {
      id: 'role-existing',
      projectId: 'project-a',
      name: 'role-existing',
      displayName: 'Existing role',
      description: null,
      tags: [],
      filePath: 'role-existing.json',
      isBuiltin: false,
      contentDigest: null,
      sortOrder: 0,
      createdAt: null,
      updatedAt: null,
    };
    const metadata: MekaProjectMetadata[] = [
      {
        projectId: 'project-a',
        itemType: 'skill',
        sourcePath: 'skills/program.md',
        rootPath: 'C:/projects/shared',
        subProjectPath: null,
        name: 'program.md',
        contentFingerprint: 'program',
        disciplines: ['程序'],
        domains: ['战斗'],
        enabled: true,
      },
    ];
    const catalog: MekaSkillCatalogEntry[] = [
      {
        skillId: 'skill-program',
        category: '程序',
        subCategory: '战斗',
        description: 'program skill',
        filePath: 'program/SKILL.md',
      },
      {
        skillId: 'skill-design',
        category: '策划',
        subCategory: '系统',
        description: 'design skill',
        filePath: 'design/SKILL.md',
      },
    ];
    const api = installApi([projectSummary([role])], { metadata, catalog });
    renderRoute('/?projectId=project-a&roleId=role-existing');

    fireEvent.click(await screen.findByRole('button', { name: 'Existing role' }));
    await screen.findByDisplayValue('New role');
    fireEvent.click(screen.getByRole('button', { name: '程序' }));
    fireEvent.click(screen.getByRole('button', { name: 'meka.saveRole' }));

    await waitFor(() => expect(api.createRole).not.toHaveBeenCalled());
    expect(api.updateRole).toHaveBeenCalledWith(
      expect.objectContaining({
        roleFile: expect.objectContaining({
          skills: expect.arrayContaining([{ skillId: 'skill-program', enabled: true }]),
          projectMetadataSelection: expect.arrayContaining([
            {
              rootPath: 'C:/projects/shared',
              sourcePath: 'skills/program.md',
              itemType: 'skill',
              enabled: true,
            },
          ]),
        }),
      }),
    );
    expect(api.updateRole).not.toHaveBeenCalledWith(
      expect.objectContaining({
        roleFile: expect.objectContaining({
          skills: expect.arrayContaining([{ skillId: 'skill-design', enabled: true }]),
        }),
      }),
    );
  });
});
