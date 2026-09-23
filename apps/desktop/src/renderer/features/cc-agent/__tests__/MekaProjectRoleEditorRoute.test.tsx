// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  MekaProject,
  MekaProjectFile,
  MekaProjectMetadata,
  MekaRole,
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
    configUnavailable: false,
    sortOrder: 0,
    createdAt: null,
    updatedAt: null,
    roles,
  };
}

function roleManifest(overrides: Partial<MekaRoleManifestFile> = {}): MekaRoleManifestFile {
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
    ...overrides,
  };
}

/**
 * The only editable bundled role left: `general-development` was retired together with its
 * resource file, so bundled-role editing is asserted against `combat-development`. The shared
 * default role cannot stand in for it because it is read-only by contract.
 */
function combatRole(): MekaRole {
  return {
    id: 'combat-development',
    projectId: 'saga2',
    name: 'combat-development',
    displayName: '战斗开发',
    description: '设计、配置、调试并验证客户端与服务器共同执行的战斗技能',
    tags: [],
    filePath: 'meka/roles/combat-development.json',
    isBuiltin: true,
    contentDigest: null,
    sortOrder: 0,
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * A project-owned (therefore editable) role, used to show that the inherited-source notice comes
 * from the manifest rather than from the shared default role.
 */
function editableRole(): MekaRole {
  return {
    id: 'role-inherited',
    projectId: 'project-a',
    name: 'role-inherited',
    displayName: 'Inherited role',
    description: null,
    tags: [],
    filePath: 'role-inherited.json',
    isBuiltin: false,
    contentDigest: null,
    sortOrder: 1,
    createdAt: null,
    updatedAt: null,
  };
}

/** The shared built-in default role of `projectId`: factory-inclusive, read-only, undeletable. */
function defaultRole(projectId = 'saga2'): MekaRole {
  const id = `${projectId}-default-role`;
  return {
    id,
    projectId,
    name: id,
    displayName: '默认角色',
    description: null,
    tags: ['builtin', 'default'],
    filePath: `meka/roles/${id}.json`,
    isBuiltin: true,
    contentDigest: null,
    sortOrder: -1,
    createdAt: null,
    updatedAt: null,
  };
}

function installApi(
  initialProjects: MekaProject[],
  options: {
    metadata?: MekaProjectMetadata[];
    catalog?: MekaSkillCatalogEntry[];
    inspectFile?: MekaProjectFile | null;
    /** Manifest Main returns for any role id; tests put the fields under assertion here. */
    roleFile?: Partial<MekaRoleManifestFile>;
    /**
     * The display-only keys `meka-role:read-manifest` attaches to the expanded manifest, exactly as
     * Main computes them. Not a field of `MekaRoleManifestFile`: the panel reads it off the draft
     * while nothing persists it, so the fixture carries it outside that type on purpose.
     */
    derivedEntryKeys?: {
      rules: string[];
      skills: string[];
      mcp: string[];
      metadata: string[];
    };
    /** Mirrors Main, where both reads resolve through the same project file lookup. */
    projectFileMissing?: boolean;
  } = {},
) {
  const projectFileRead = () => {
    if (!options.projectFileMissing) return undefined;
    throw new Error('[NOT_FOUND] project.json not found');
  };
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
        readManifest: vi.fn(async (id: string) => {
          if (!id) return null;
          const manifest = { ...roleManifest(options.roleFile), id, name: id };
          // Mirrors Main, which attaches the display-only derived keys to the read result only.
          return options.derivedEntryKeys
            ? { ...manifest, derivedEntryKeys: options.derivedEntryKeys }
            : manifest;
        }),
      },
      mekaProjectMetadata: {
        loadProject: vi.fn(async (id: string) => projectFileRead() ?? projectFile(id)),
        list: vi.fn(async () => projectFileRead() ?? options.metadata ?? []),
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
    deleteProject: api.localDb.mekaProjects.delete,
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

/**
 * The row wrapper `<div>` of one entry inside a resource list, so a query can be scoped to that row
 * instead of to the whole panel (which renders several `meka.remove` buttons at once).
 */
function listRowOf(element: HTMLElement): HTMLElement {
  const row = element.closest('div');
  if (!row) throw new Error('resource row not found');
  return row;
}

/**
 * The read-only panel renders "inherited source" state for every resource area: the manifest may
 * carry `useProjectDefaults`, `includeAllProjectMetadata` and/or `includeAllBundledSkills`, and all
 * three are expanded at resolve time rather than spelled out in the role's own lists. The notice is
 * manifest-driven, so it also shows up on a project-owned (editable) role, and it never pretends
 * those flags are toggles.
 */
const INHERITED_SOURCE_NOTICE_TEST_IDS = [
  'meka-role-inherited-sources-rules',
  'meka-role-inherited-sources-skills',
  'meka-role-inherited-sources-mcp',
] as const;

const INHERITED_ROLE_FILE = {
  projectId: 'project-a',
  displayName: 'Inherited role',
} as const;

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
    const sagaProject: MekaProject = {
      ...projectSummary([combatRole()]),
      id: 'saga2',
      name: 'saga2',
      displayName: 'SAGA2',
      isBuiltin: true,
      configSource: 'project',
    };
    const api = installApi([sagaProject]);
    renderRoute('/?projectId=saga2');

    fireEvent.click(await screen.findByRole('button', { name: '战斗开发' }));
    expect(((await screen.findByLabelText('meka.roleName')) as HTMLInputElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'meka.projectDetails' }));
    fireEvent.click(await screen.findByRole('button', { name: 'meka.resetBuiltinProjectAction' }));

    await waitFor(() => expect(api.resetBuiltin).toHaveBeenCalledWith('saga2'));
  });

  it('allows editing bundled roles before a project file exists', async () => {
    const api = installApi([
      {
        ...projectSummary([combatRole()]),
        id: 'saga2',
        name: 'saga2',
        displayName: 'SAGA2',
        isBuiltin: true,
        configSource: 'builtin',
      },
    ]);
    renderRoute('/?projectId=saga2');

    fireEvent.click(await screen.findByRole('button', { name: '战斗开发' }));
    const roleName = (await screen.findByLabelText('meka.roleName')) as HTMLInputElement;
    expect(roleName.disabled).toBe(false);
    // No edit yet: the header offers neither Save nor Cancel.
    expect(screen.queryByRole('button', { name: 'logic.confirm.cancel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'meka.saveRole' })).toBeNull();
    fireEvent.change(roleName, { target: { value: 'Edited combat development' } });
    fireEvent.click(screen.getByRole('button', { name: 'meka.saveRole' }));

    await waitFor(() => expect(api.updateRole).toHaveBeenCalledTimes(1));
  });

  it('discards role edits on Cancel and keeps the saved manifest otherwise', async () => {
    const api = installApi([
      {
        ...projectSummary([combatRole()]),
        id: 'saga2',
        name: 'saga2',
        displayName: 'SAGA2',
        isBuiltin: true,
        configSource: 'builtin',
      },
    ]);
    renderRoute('/?projectId=saga2');

    fireEvent.click(await screen.findByRole('button', { name: '战斗开发' }));
    const roleName = (await screen.findByLabelText('meka.roleName')) as HTMLInputElement;
    const loadedName = roleName.value;
    fireEvent.change(roleName, { target: { value: 'Edited combat development' } });
    expect(screen.getByRole('button', { name: 'meka.saveRole' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'logic.confirm.cancel' }));

    // Cancel drops the draft and the header returns to its no-edit state.
    await waitFor(() =>
      expect((screen.getByLabelText('meka.roleName') as HTMLInputElement).value).toBe(loadedName),
    );
    expect(screen.queryByRole('button', { name: 'meka.saveRole' })).toBeNull();
    expect(api.updateRole).not.toHaveBeenCalled();
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
    expect(name.disabled).toBe(false);
    // Nothing changed since load, so there is no edit to save or cancel.
    expect(screen.queryByRole('button', { name: 'logic.confirm.cancel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'meka.save' })).toBeNull();

    fireEvent.change(name, { target: { value: 'Recovered SAGA2' } });
    const cancel = await screen.findByRole('button', { name: 'logic.confirm.cancel' });
    const save = screen.getByRole('button', { name: 'meka.save' });
    fireEvent.click(cancel);
    expect(name.value).toBe('Project A');
    // Cancelling returns to the no-edit state as well.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'meka.save' })).toBeNull());

    fireEvent.change(name, { target: { value: 'Recovered SAGA2' } });
    fireEvent.click(screen.getByRole('button', { name: 'meka.save' }));

    await waitFor(() => expect(api.saveProject).toHaveBeenCalledTimes(1));
    expect(api.saveProject).toHaveBeenCalledWith(
      expect.objectContaining({
        project: expect.objectContaining({
          basic: expect.objectContaining({ displayName: 'Recovered SAGA2' }),
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

  it('shows the shared default role as read-only with no way to save it', async () => {
    const api = installApi(
      [
        {
          ...projectSummary([defaultRole()]),
          id: 'saga2',
          name: 'saga2',
          displayName: 'SAGA2',
          isBuiltin: true,
          configSource: 'builtin',
        },
      ],
      {
        // The real default-role manifest: a behavior prompt, all three inherited sources and empty
        // explicit lists (the sources are expanded at resolve time, not spelled out here).
        roleFile: {
          projectId: 'saga2',
          displayName: '默认角色',
          prompt: 'Default role prompt',
          useProjectDefaults: true,
          includeAllProjectMetadata: true,
          includeAllBundledSkills: true,
          rules: [{ id: 'rule-1', text: 'Inherited rule', enabled: true }],
          mcp: [{ id: 'meka-design', providerId: 'meka-design', enabled: true }],
        },
      },
    );
    renderRoute('/?projectId=saga2');

    fireEvent.click(await screen.findByRole('button', { name: '默认角色' }));

    // Factory-inclusive but inert: every field the panel renders is disabled.
    expect(((await screen.findByLabelText('meka.roleName')) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((screen.getByLabelText('meka.description') as HTMLTextAreaElement).disabled).toBe(true);
    for (const field of screen.getAllByRole('textbox')) {
      expect((field as HTMLInputElement | HTMLTextAreaElement).disabled).toBe(true);
    }
    for (const field of screen.getAllByRole('checkbox')) {
      expect((field as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.getByText('meka.defaultRoleDescription')).toBeTruthy();
    // Factory-inclusive means all three inherited sources are reported in every resource area, even
    // though the default role's own lists stay empty.
    for (const testId of INHERITED_SOURCE_NOTICE_TEST_IDS) {
      expect(screen.getByTestId(testId)).toBeTruthy();
    }
    // A genuinely read-only role is the only place the note may claim read-only, so this is where
    // the wording without the editable caveat is asserted.
    expect(screen.getAllByText('meka.roleInheritedSourcesNote')).toHaveLength(3);
    expect(screen.queryAllByText('meka.roleInheritedSourcesNoteEditable')).toHaveLength(0);
    // Every source is badged once per resource area (rules, skills, MCP) on the real default role.
    for (const label of [
      'meka.roleInheritsProjectDefaults',
      'meka.roleIncludesAllProjectMetadata',
      'meka.roleIncludesAllBundledSkills',
    ]) {
      expect(screen.getAllByText(label)).toHaveLength(3);
    }
    // No Save even after a programmatic change attempt, and no delete for a built-in role.
    expect(screen.queryByRole('button', { name: 'meka.saveRole' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'meka.deleteRole' })).toBeNull();
    // A read-only panel has no draft to discard, so it must not offer Cancel either.
    expect(screen.queryByRole('button', { name: 'logic.confirm.cancel' })).toBeNull();
    expect(api.updateRole).not.toHaveBeenCalled();
  });

  it('shows no buttons after switching from a new-role draft to the read-only default role', async () => {
    installApi([
      {
        ...projectSummary([defaultRole()]),
        id: 'saga2',
        name: 'saga2',
        displayName: 'SAGA2',
        isBuiltin: true,
        configSource: 'builtin',
      },
    ]);
    renderRoute('/?projectId=saga2');

    // Start a new role (a genuinely pending draft), then select the read-only default role.
    fireEvent.click(await screen.findByRole('button', { name: 'meka.newRole' }));
    fireEvent.click(await screen.findByRole('button', { name: '默认角色' }));

    await screen.findByLabelText('meka.roleName');
    expect(screen.queryByRole('button', { name: 'meka.saveRole' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'logic.confirm.cancel' })).toBeNull();
    // LIMIT: this asserts the settled state — the abandoned new-role draft must not leave a
    // Cancel/Save behind. The single render frame between the click and the role effect is
    // also covered by `canCancelDraft`'s `!roleReadOnly`, but is not observable here because
    // testing-library flushes effects before it returns.
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
        displayName: '程序技能',
        category: '程序',
        subCategory: '战斗',
        description: 'program skill',
        filePath: 'program/SKILL.md',
      },
      {
        skillId: 'skill-design',
        displayName: '策划技能',
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
    expect(screen.getByText('程序技能')).toBeTruthy();
    expect(screen.queryByText('skill-program')).toBeNull();
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

describe('Meka project whose configuration is unavailable', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('marks the project in the list and identifies it by its registered path', async () => {
    installApi([
      { ...projectSummary(), configUnavailable: true, path: 'C:/workspace/moved-away' },
    ]);
    renderRoute();

    await screen.findByText('meka.configUnavailable');
    expect(screen.getByText('C:/workspace/moved-away')).toBeTruthy();
  });

  it('explains the failure and removes the registration from the stuck detail page', async () => {
    const api = installApi([{ ...projectSummary(), configUnavailable: true }], {
      projectFileMissing: true,
    });
    renderRoute('/?projectId=project-a');

    await screen.findByText('meka.configUnavailableTitle');
    expect(screen.getByText('meka.configUnavailableDescription')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'meka.removeProjectRegistrationAction' }),
    );

    await waitFor(() => expect(api.deleteProject).toHaveBeenCalledWith('project-a'));
  });

  it('keeps a built-in project read-only instead of offering removal', async () => {
    installApi([
      {
        ...projectSummary(),
        isBuiltin: true,
        configSource: 'builtin',
        configUnavailable: true,
      },
    ], { projectFileMissing: true });
    renderRoute('/?projectId=project-a');

    await screen.findByText('meka.configUnavailableTitle');
    expect(
      screen.queryByRole('button', { name: 'meka.removeProjectRegistrationAction' }),
    ).toBeNull();
  });
});

describe('Meka role inherited-source visibility', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('reports all three inherited sources in every resource area without offering a toggle', async () => {
    installApi([projectSummary([editableRole()])], {
      roleFile: {
        ...INHERITED_ROLE_FILE,
        useProjectDefaults: true,
        includeAllProjectMetadata: true,
        includeAllBundledSkills: true,
      },
    });
    renderRoute('/?projectId=project-a&roleId=role-inherited');

    fireEvent.click(await screen.findByRole('button', { name: 'Inherited role' }));
    await screen.findByLabelText('meka.roleName');

    for (const testId of INHERITED_SOURCE_NOTICE_TEST_IDS) {
      const notice = await screen.findByTestId(testId);
      // All three sources are reported as read-only state, once per resource area.
      expect(within(notice).getByText('meka.roleInheritsProjectDefaults').tagName).toBe('SPAN');
      expect(within(notice).getByText('meka.roleIncludesAllProjectMetadata').tagName).toBe('SPAN');
      expect(within(notice).getByText('meka.roleIncludesAllBundledSkills').tagName).toBe('SPAN');
      // Declared order is the contract: project defaults, then project metadata, then the bundled
      // catalog. The panel reads them top-to-bottom, so a reshuffle is a user-visible regression.
      expect(
        within(notice)
          .getAllByText(/^meka\.roleIncludes|^meka\.roleInherits/)
          .map((badge) => badge.textContent),
      ).toEqual([
        'meka.roleInheritsProjectDefaults',
        'meka.roleIncludesAllProjectMetadata',
        'meka.roleIncludesAllBundledSkills',
      ]);
      // The explanation has to be readable on screen, not hidden in a tooltip. This role is
      // project-owned and therefore editable, so the note is the variant without the read-only
      // clause; the read-only wording is asserted on the shared default role instead.
      expect(within(notice).getByText('meka.roleInheritedSourcesNoteEditable')).toBeTruthy();
      // Read-only state, not an implied toggle: the notice itself carries no control and no
      // pressed state even though this role is editable and the panel uses `aria-pressed` chips
      // for its real selections elsewhere.
      expect(within(notice).queryAllByRole('checkbox')).toHaveLength(0);
      expect(within(notice).queryAllByRole('button')).toHaveLength(0);
      expect(notice.querySelectorAll('[aria-pressed]').length).toBe(0);
    }
  });

  it('reports only the project-defaults source when the manifest sets just that one', async () => {
    installApi([projectSummary([editableRole()])], {
      roleFile: {
        ...INHERITED_ROLE_FILE,
        useProjectDefaults: true,
        includeAllProjectMetadata: false,
        includeAllBundledSkills: false,
      },
    });
    renderRoute('/?projectId=project-a&roleId=role-inherited');

    fireEvent.click(await screen.findByRole('button', { name: 'Inherited role' }));
    await screen.findByLabelText('meka.roleName');
    await screen.findByTestId('meka-role-inherited-sources-rules');
    expect(screen.getAllByText('meka.roleInheritsProjectDefaults')).toHaveLength(3);
    expect(screen.queryAllByText('meka.roleIncludesAllProjectMetadata')).toHaveLength(0);
    expect(screen.queryAllByText('meka.roleIncludesAllBundledSkills')).toHaveLength(0);
    for (const testId of INHERITED_SOURCE_NOTICE_TEST_IDS) {
      expect(screen.getByTestId(testId)).toBeTruthy();
    }
  });

  it('reports only the all-metadata source when the manifest sets just that one', async () => {
    installApi([projectSummary([editableRole()])], {
      roleFile: {
        ...INHERITED_ROLE_FILE,
        useProjectDefaults: false,
        includeAllProjectMetadata: true,
        includeAllBundledSkills: false,
      },
    });
    renderRoute('/?projectId=project-a&roleId=role-inherited');

    fireEvent.click(await screen.findByRole('button', { name: 'Inherited role' }));
    await screen.findByLabelText('meka.roleName');
    await screen.findByTestId('meka-role-inherited-sources-rules');
    expect(screen.getAllByText('meka.roleIncludesAllProjectMetadata')).toHaveLength(3);
    expect(screen.queryAllByText('meka.roleInheritsProjectDefaults')).toHaveLength(0);
    expect(screen.queryAllByText('meka.roleIncludesAllBundledSkills')).toHaveLength(0);
    for (const testId of INHERITED_SOURCE_NOTICE_TEST_IDS) {
      expect(screen.getByTestId(testId)).toBeTruthy();
    }
  });

  it('reports only the bundled-skills source when the manifest sets just that one', async () => {
    installApi([projectSummary([editableRole()])], {
      roleFile: {
        ...INHERITED_ROLE_FILE,
        useProjectDefaults: false,
        includeAllProjectMetadata: false,
        includeAllBundledSkills: true,
      },
    });
    renderRoute('/?projectId=project-a&roleId=role-inherited');

    fireEvent.click(await screen.findByRole('button', { name: 'Inherited role' }));
    await screen.findByLabelText('meka.roleName');

    // Regression lock for the third source: the bundled catalog alone has to open every notice,
    // exactly once per resource area. When the notice's render condition only looked at the two
    // project-wide flags this whole case rendered nothing, so each assertion below is the guard.
    for (const testId of INHERITED_SOURCE_NOTICE_TEST_IDS) {
      const notice = await screen.findByTestId(testId);
      expect(within(notice).getAllByText('meka.roleIncludesAllBundledSkills')).toHaveLength(1);
      expect(within(notice).getByText('meka.roleIncludesAllBundledSkills').tagName).toBe('SPAN');
      expect(within(notice).queryByText('meka.roleInheritsProjectDefaults')).toBeNull();
      expect(within(notice).queryByText('meka.roleIncludesAllProjectMetadata')).toBeNull();
      // Read-only state, not an implied toggle: same shape as the all-three case above.
      expect(within(notice).queryAllByRole('checkbox')).toHaveLength(0);
      expect(within(notice).queryAllByRole('button')).toHaveLength(0);
      expect(notice.querySelectorAll('[aria-pressed]').length).toBe(0);
    }
    expect(screen.getAllByText('meka.roleIncludesAllBundledSkills')).toHaveLength(3);
    expect(screen.queryAllByText('meka.roleInheritsProjectDefaults')).toHaveLength(0);
    expect(screen.queryAllByText('meka.roleIncludesAllProjectMetadata')).toHaveLength(0);
  });

  it('renders no inherited-source notice when the manifest declares none of the three sources', async () => {
    installApi([projectSummary([editableRole()])], {
      roleFile: {
        ...INHERITED_ROLE_FILE,
        useProjectDefaults: false,
        includeAllProjectMetadata: false,
        includeAllBundledSkills: false,
      },
    });
    renderRoute('/?projectId=project-a&roleId=role-inherited');

    fireEvent.click(await screen.findByRole('button', { name: 'Inherited role' }));
    await screen.findByLabelText('meka.roleName');
    // The role is loaded and its empty resource list is on screen, so a missing notice is the
    // manifest's answer rather than a panel that never rendered.
    expect(screen.getByText('meka.rulesEmpty')).toBeTruthy();
    for (const testId of INHERITED_SOURCE_NOTICE_TEST_IDS) {
      expect(screen.queryByTestId(testId)).toBeNull();
    }
    expect(screen.queryByText('meka.roleInheritedSourcesNote')).toBeNull();
  });
});

/**
 * P1: the remove button on a switch-derived row was a dead control. The panel dropped the entry from
 * the draft, the save succeeded, and the runtime laid the entry back down from the project's
 * `roleDefaults` / the bundled catalog — so the row returned. Main now reports which keys it derived
 * (`derivedEntryKeys` on the `read-manifest` result) and the panel offers no removal for them, while
 * keeping the checkbox, which is the exclusion an `enabled: false` selection really performs.
 */
describe('Meka role switch-derived entries cannot be removed', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('hides the remove button on derived rules, skills and MCP while keeping their checkbox', async () => {
    installApi([projectSummary([editableRole()])], {
      roleFile: {
        ...INHERITED_ROLE_FILE,
        useProjectDefaults: true,
        includeAllProjectMetadata: true,
        includeAllBundledSkills: true,
        rules: [
          { id: 'derived-rule', text: 'Derived rule text', enabled: true },
          { id: 'own-rule', text: 'Own rule text', enabled: true },
        ],
        skills: [
          { skillId: 'derived-skill', enabled: true },
          { skillId: 'own-skill', enabled: true },
        ],
        mcp: [
          { id: 'derived-mcp', providerId: 'derived-mcp', enabled: true },
          { id: 'own-mcp', providerId: 'own-mcp', enabled: true },
        ],
      },
      derivedEntryKeys: {
        rules: ['derived-rule'],
        skills: ['derived-skill'],
        mcp: ['derived-mcp'],
        metadata: ['\u0000AGENTS.md\u0000agents-md'],
      },
    });
    renderRoute('/?projectId=project-a&roleId=role-inherited');

    fireEvent.click(await screen.findByRole('button', { name: 'Inherited role' }));
    await screen.findByLabelText('meka.roleName');

    // Rules (`rule.id`): the derived row has no trash but keeps the checkbox that excludes it.
    const derivedRuleRow = listRowOf(screen.getByDisplayValue('Derived rule text'));
    const ownRuleRow = listRowOf(screen.getByDisplayValue('Own rule text'));
    expect(within(derivedRuleRow).queryByRole('button', { name: 'meka.remove' })).toBeNull();
    expect(within(derivedRuleRow).getByRole('checkbox')).toBeTruthy();
    expect(within(ownRuleRow).getByRole('button', { name: 'meka.remove' })).toBeTruthy();

    // MCP (`entry.id`): same split. The panel has no `excludeDefaults` writer, so the checkbox is
    // the only exclusion the runtime would have honoured for the derived row.
    const derivedMcpRow = listRowOf(screen.getByText('derived-mcp'));
    const ownMcpRow = listRowOf(screen.getByText('own-mcp'));
    expect(within(derivedMcpRow).queryByRole('button', { name: 'meka.remove' })).toBeNull();
    expect(within(derivedMcpRow).getByRole('checkbox')).toBeTruthy();
    expect(within(ownMcpRow).getByRole('button', { name: 'meka.remove' })).toBeTruthy();

    // Skills (`isLegacySkill ? id : skillId`): with an empty catalog every skill id is "unknown"
    // and renders under `meka.legacySkillReferences`, where the derived one is un-removable too.
    const derivedSkillRow = listRowOf(screen.getByText('derived-skill'));
    const ownSkillRow = listRowOf(screen.getByText('own-skill'));
    expect(within(derivedSkillRow).queryByRole('button', { name: 'meka.remove' })).toBeNull();
    expect(within(derivedSkillRow).getByRole('checkbox')).toBeTruthy();
    expect(within(ownSkillRow).getByRole('button', { name: 'meka.remove' })).toBeTruthy();
  });
});

/**
 * The copy path the `MEKA_BUILTIN_READ_ONLY` message points users at ("copy it to a project role
 * instead"). The copy keeps all three switches, so the runtime still absorbs the same sources, but
 * it is project-owned and fully editable — which is why the notice must switch to the editable key
 * instead of inheriting the read-only one from the original.
 */
describe('Meka role copy of the shared default role', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('lands an editable role that keeps the three inherited sources and their editable note', async () => {
    const api = installApi([projectSummary([defaultRole('project-a')])], {
      roleFile: {
        projectId: 'project-a',
        displayName: '默认角色',
        useProjectDefaults: true,
        includeAllProjectMetadata: true,
        includeAllBundledSkills: true,
        rules: [{ id: 'rule-1', text: 'Inherited rule', enabled: true }],
        mcp: [{ id: 'meka-design', providerId: 'meka-design', enabled: true }],
      },
    });
    renderRoute('/?projectId=project-a');

    fireEvent.click(await screen.findByRole('button', { name: '默认角色' }));
    // The original is the read-only shared contract: no editable field and no save entry.
    const originalName = (await screen.findByLabelText('meka.roleName')) as HTMLInputElement;
    expect(originalName.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'meka.saveRole' })).toBeNull();

    // Copy is a create → reload → re-read chain, so it is settled inside `act` before asserting: the
    // panel swaps the read-only original for the new draft only after that chain resolves.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'meka.copyRole' }));
    });
    await act(async () => {});

    expect(api.createRole).toHaveBeenCalledTimes(1);
    // Dropping a switch here would silently change what the copy mounts, so the copy keeps all three.
    expect(api.createRole.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        projectId: 'project-a',
        roleFile: expect.objectContaining({
          useProjectDefaults: true,
          includeAllProjectMetadata: true,
          includeAllBundledSkills: true,
        }),
      }),
    );

    // Project-owned, therefore editable: the fields are live, the exclusion checkboxes are usable,
    // and an edit produces the Save entry a read-only role can never offer.
    await waitFor(() =>
      expect((screen.getByLabelText('meka.roleName') as HTMLInputElement).disabled).toBe(false),
    );
    expect((screen.getByLabelText('meka.description') as HTMLTextAreaElement).disabled).toBe(false);
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const checkbox of checkboxes) expect(checkbox.disabled).toBe(false);
    for (const testId of INHERITED_SOURCE_NOTICE_TEST_IDS) {
      const notice = screen.getByTestId(testId);
      expect(within(notice).getByText('meka.roleInheritedSourcesNoteEditable')).toBeTruthy();
      expect(within(notice).queryByText('meka.roleInheritedSourcesNote')).toBeNull();
    }
    fireEvent.change(screen.getByLabelText('meka.roleName'), {
      target: { value: 'Copy of the default role' },
    });
    expect(screen.getByRole('button', { name: 'meka.saveRole' })).toBeTruthy();
    // The copy chain's tail (the reload that re-lists the project) settles after the assertions.
    await act(async () => {});
  });
});
