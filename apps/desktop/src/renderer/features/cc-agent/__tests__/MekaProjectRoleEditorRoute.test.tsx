// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  MekaProject,
  MekaProjectFile,
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

function installApi(initialProjects: MekaProject[]) {
  let projects = initialProjects;
  const showOpenDirectoryDialog = vi.fn(
    async (): Promise<{ canceled: boolean; path?: string }> => ({
      canceled: false,
      path: 'C:/projects/selected',
    }),
  );
  const createProject = vi.fn(async (input: { displayName: string; path: string }) => {
    const created = { ...projectSummary(), displayName: input.displayName, path: input.path };
    projects = [created];
    return created;
  });
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
  const saveProject = vi.fn(async ({ project }: { project: MekaProjectFile }) => project);
  const api = {
    localDb: {
      mekaProjects: {
        list: vi.fn(async () => projects),
        create: createProject,
        delete: vi.fn(),
      },
      mekaRoles: {
        create: createRole,
        update: vi.fn(),
        delete: vi.fn(),
        readManifest: vi.fn(async (id: string) => (id === 'role-new' ? roleManifest() : null)),
      },
      mekaProjectMetadata: {
        loadProject: vi.fn(async (id: string) => projectFile(id)),
        list: vi.fn(async () => []),
        saveProject,
        discover: vi.fn(async () => []),
        gitRemote: vi.fn(async () => null),
      },
      mekaSkillCatalog: { list: vi.fn(async () => []) },
    },
  };
  const electronApi = {
    ...api,
    showOpenDirectoryDialog,
  };
  (window as unknown as { electronAPI: typeof electronApi }).electronAPI = electronApi;
  return { createProject, createRole, saveProject, showOpenDirectoryDialog };
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

  it('opens a full project draft and only persists it on Save', async () => {
    const api = installApi([]);
    renderRoute();

    await screen.findByText('meka.empty');
    fireEvent.click(screen.getAllByRole('button', { name: 'meka.newProject' })[0]);

    expect(screen.getByRole('heading', { name: 'meka.newProject' })).toBeTruthy();
    expect(api.createProject).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('meka.projectName'), {
      target: { value: 'Configured project' },
    });
    fireEvent.change(screen.getByLabelText('meka.projectPath'), {
      target: { value: 'C:/projects/configured' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'meka.save' }));

    await waitFor(() => expect(api.createProject).toHaveBeenCalledTimes(1));
    expect(api.saveProject).toHaveBeenCalledWith({
      projectId: 'project-a',
      project: expect.objectContaining({
        projectId: 'project-a',
        basic: expect.objectContaining({
          displayName: 'Configured project',
          path: 'C:/projects/configured',
        }),
      }),
    });
  });

  it('selects a directory for a new project and keeps saved project paths immutable', async () => {
    const newProjectApi = installApi([]);
    renderRoute();

    await screen.findByText('meka.empty');
    fireEvent.click(screen.getAllByRole('button', { name: 'meka.newProject' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'meka.chooseDirectory' }));

    await waitFor(() => expect(newProjectApi.showOpenDirectoryDialog).toHaveBeenCalledTimes(1));
    expect((screen.getByLabelText('meka.projectPath') as HTMLInputElement).value).toBe(
      'C:/projects/selected',
    );
    newProjectApi.showOpenDirectoryDialog.mockResolvedValueOnce({ canceled: true });
    fireEvent.click(screen.getByRole('button', { name: 'meka.chooseDirectory' }));
    await waitFor(() => expect(newProjectApi.showOpenDirectoryDialog).toHaveBeenCalledTimes(2));
    expect((screen.getByLabelText('meka.projectPath') as HTMLInputElement).value).toBe(
      'C:/projects/selected',
    );

    cleanup();
    const savedProjectApi = installApi([projectSummary()]);
    renderRoute('/?projectId=project-a');
    expect((await screen.findByLabelText('meka.projectPath') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'meka.chooseDirectory' })).toBeNull();
    expect(savedProjectApi.showOpenDirectoryDialog).not.toHaveBeenCalled();
  });

  it('leaves a new project draft without persisting when cancelled', async () => {
    const api = installApi([]);
    renderRoute();

    await screen.findByText('meka.empty');
    fireEvent.click(screen.getAllByRole('button', { name: 'meka.newProject' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'logic.confirm.cancel' }));

    expect(await screen.findByText('meka.empty')).toBeTruthy();
    expect(api.createProject).not.toHaveBeenCalled();
  });

  it('opens the full role editor and only creates the role on Save', async () => {
    const api = installApi([projectSummary()]);
    renderRoute('/?projectId=project-a');

    fireEvent.click(await screen.findByRole('button', { name: 'meka.newRole' }));

    expect(api.createRole).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('meka.roleName'), {
      target: { value: 'New role' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'meka.saveRole' }));

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
});
