import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveSessionIdentityForCreate } from '../sessionIdentity';
import { setWorkspaceBindingResolver } from '../workspaceBindingResolver';

const resolution = {
  projectId: 'saga2',
  roleId: 'saga2-default-role',
  workspacePath: 'C:/Workspace/saga2/saga2_project',
};

afterEach(() => setWorkspaceBindingResolver(null));

describe('resolveSessionIdentityForCreate', () => {
  it('uses an explicit pair before path resolution', async () => {
    const resolver = vi.fn(async () => resolution);
    setWorkspaceBindingResolver(resolver);

    await expect(resolveSessionIdentityForCreate({
      workspaceKind: 'meka',
      workingDir: 'C:/Workspace/saga2/saga2_project',
      projectDir: null,
      mekaProjectId: 'custom',
      mekaRoleId: 'custom-role',
    })).resolves.toEqual({
      workspaceKind: 'project',
      mekaProjectId: 'custom',
      mekaRoleId: 'custom-role',
      projectDir: null,
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects a half binding instead of creating a half identity row', async () => {
    await expect(resolveSessionIdentityForCreate({
      workspaceKind: 'project',
      workingDir: '/repo',
      projectDir: null,
      mekaProjectId: 'saga2',
      mekaRoleId: null,
    })).rejects.toThrow('both a project and a role');
  });

  it('binds a local agentDevice workspace by path', async () => {
    const resolver = vi.fn(async () => resolution);
    setWorkspaceBindingResolver(resolver);

    await expect(resolveSessionIdentityForCreate({
      workspaceKind: 'project',
      workingDir: 'C:/Workspace/saga2/saga2_project',
      projectDir: null,
      agentDeviceId: 'device-b',
    })).resolves.toMatchObject({
      workspaceKind: 'project',
      mekaProjectId: 'saga2',
      mekaRoleId: 'saga2-default-role',
      projectDir: resolution.workspacePath,
    });
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('never resolves a remote workspace through the local project registry', async () => {
    const resolver = vi.fn(async () => resolution);
    setWorkspaceBindingResolver(resolver);

    await expect(resolveSessionIdentityForCreate({
      workspaceKind: 'project',
      workingDir: '/data/remote/workspace',
      projectDir: null,
      remoteHostId: 'mcpr:instance',
    })).resolves.toEqual({
      workspaceKind: 'project',
      mekaProjectId: null,
      mekaRoleId: null,
      projectDir: null,
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('keeps a legacy meka kind only when no project path matches', async () => {
    setWorkspaceBindingResolver(async () => null);

    await expect(resolveSessionIdentityForCreate({
      workspaceKind: 'meka',
      workingDir: '/legacy/fallback',
      projectDir: null,
    })).resolves.toEqual({
      workspaceKind: 'meka',
      mekaProjectId: null,
      mekaRoleId: null,
      projectDir: null,
    });
  });
});
