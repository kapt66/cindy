import { describe, expect, it, vi } from 'vitest';

import { createMekaWorkerTargetResolver } from '../mekaWorkerTarget';

const mekaLead = {
  id: 'lead-1',
  agentKind: 'claude-code' as const,
  workingDir: 'C:\\legacy',
  workspaceKind: 'meka' as const,
  mekaProjectId: 'project-1',
  model: 'claude-sonnet-4-6',
  effort: 'high',
  permissionMode: 'default',
  fastMode: false,
  providerId: null,
};

function createResolver(
  overrides: {
    p4RootPath?: string | null;
    extraDirs?: string[];
    bindings?: string[];
    available?: boolean;
    supported?: boolean;
  } = {},
) {
  return createMekaWorkerTargetResolver({
    p4: {
      get: vi.fn(async () => ({
        p4RootPath: overrides.p4RootPath === undefined ? 'C:\\P4' : overrides.p4RootPath,
        subfolders: [],
        extraDirs: overrides.extraDirs ?? [],
        readOnlyBecauseFutureSchema: false,
      })),
    },
    router: {
      listProjectBindings: vi.fn(async () => overrides.bindings ?? ['instance-1']),
      listInstances: vi.fn(async () => [
        {
          id: 'instance-1',
          instanceId: 'worker-one',
          projectId: 'remote-project',
          projectName: 'Remote project',
          projectDescription: null,
          agentType: 'claude',
          agentMode: 'ask',
          status: overrides.available === false ? 'stopped' : 'running',
          workspaceRef: '/workspace/project',
          supported: overrides.supported !== false,
          available: overrides.available !== false && overrides.supported !== false,
          remoteHostId: 'mcpr:instance-1',
          workingDir: '/workspace/project',
        },
      ]),
    },
  });
}

describe('Meka Worker target resolver', () => {
  it('uses the configured P4 root and rejects a forged local directory', async () => {
    const resolve = createResolver({
      extraDirs: ['C:\\P4\\saga2_unity', 'C:\\P4\\saga2_pm'],
    });

    await expect(
      resolve({
        lead: mekaLead,
        agent: 'codex',
        requestedWorkingDir: 'C:\\P4',
      }),
    ).resolves.toEqual({ ok: true, workingDir: 'C:\\P4' });

    await expect(
      resolve({
        lead: mekaLead,
        agent: 'codex',
        requestedWorkingDir: 'C:\\P4\\saga2_unity',
      }),
    ).resolves.toEqual({ ok: true, workingDir: 'C:\\P4\\saga2_unity' });

    await expect(
      resolve({
        lead: mekaLead,
        agent: 'codex',
        requestedWorkingDir: 'C:\\P4\\saga2_pm',
      }),
    ).resolves.toEqual({ ok: true, workingDir: 'C:\\P4\\saga2_pm' });

    await expect(
      resolve({
        lead: mekaLead,
        agent: 'codex',
        requestedWorkingDir: 'C:\\other',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
  });

  it('resolves only a bound, available Claude MCPRouter instance', async () => {
    const resolve = createResolver();

    await expect(
      resolve({
        lead: mekaLead,
        agent: 'claude-code',
        requestedRemoteHostId: 'mcpr:instance-1',
        requestedWorkingDir: '/forged',
      }),
    ).resolves.toEqual({
      ok: true,
      workingDir: '/workspace/project',
      remoteHostId: 'mcpr:instance-1',
    });

    await expect(
      resolve({
        lead: mekaLead,
        agent: 'codex',
        requestedRemoteHostId: 'mcpr:instance-1',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
  });

  it('rejects unbound and unavailable remote instances', async () => {
    await expect(
      createResolver({ bindings: [] })({
        lead: mekaLead,
        agent: 'claude-code',
        requestedRemoteHostId: 'mcpr:instance-1',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });

    await expect(
      createResolver({ available: false })({
        lead: mekaLead,
        agent: 'claude-code',
        requestedRemoteHostId: 'mcpr:instance-1',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
  });

  it('does not allow custom targets on ordinary Cindy sessions', async () => {
    const resolve = createResolver();
    await expect(
      resolve({
        lead: { ...mekaLead, workspaceKind: 'project', mekaProjectId: null },
        agent: 'codex',
        requestedWorkingDir: 'C:\\other',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
  });
});
