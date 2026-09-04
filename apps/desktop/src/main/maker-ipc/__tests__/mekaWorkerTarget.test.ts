import { describe, expect, it, vi } from 'vitest';

import {
  createMekaWorkerTargetResolver,
  resolveUniqueBoundMekaServerTarget,
} from '../mekaWorkerTarget';

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
  remoteHostId: null,
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
  it('resolves only one bound, available, capability-ready server target', async () => {
    const router = {
      listProjectBindings: vi.fn(async () => ['server-1', 'client-1', 'server-2']),
      listInstances: vi.fn(async () => [
        {
          id: 'server-1',
          instanceId: 'saga2-server-primary',
          projectId: 'remote-server',
          projectName: 'SAGA2 Server',
          projectDescription: null,
          agentType: 'codex',
          agentMode: 'ask',
          status: 'running',
          workspaceRef: '/server',
          supported: true,
          available: true,
          remoteHostId: 'mcpr:server-1',
          workingDir: '/server',
        },
        {
          id: 'client-1',
          instanceId: 'saga2-client',
          projectId: 'remote-client',
          projectName: 'SAGA2 Client',
          projectDescription: null,
          agentType: 'codex',
          agentMode: 'ask',
          status: 'running',
          workspaceRef: '/client',
          supported: true,
          available: true,
          remoteHostId: 'mcpr:client-1',
          workingDir: '/client',
        },
        {
          id: 'server-2',
          instanceId: 'saga2-server-backup',
          projectId: 'remote-server',
          projectName: 'SAGA2 Server Backup',
          projectDescription: null,
          agentType: 'codex',
          agentMode: 'ask',
          status: 'running',
          workspaceRef: '/server-backup',
          supported: true,
          available: true,
          remoteHostId: 'mcpr:server-2',
          workingDir: '/server-backup',
        },
      ]),
    };
    const probeCodexCapability = vi.fn(async (instanceId: string) => {
      if (instanceId === 'server-2') throw new Error('runtime unavailable');
    });
    const probeClaudeCapability = vi.fn(async () => undefined);

    await expect(
      resolveUniqueBoundMekaServerTarget({
        router,
        projectId: 'saga2',
        probeCodexCapability,
        probeClaudeCapability,
      }),
    ).resolves.toEqual({ remoteHostId: 'mcpr:server-1', workerAgent: 'codex' });
    expect(probeCodexCapability).toHaveBeenCalledTimes(2);
    expect(probeCodexCapability).not.toHaveBeenCalledWith('client-1');
    expect(probeClaudeCapability).not.toHaveBeenCalled();
  });

  it('selects a capability-ready Claude server with its matching Worker agent', async () => {
    const router = {
      listProjectBindings: vi.fn(async () => ['server-claude']),
      listInstances: vi.fn(async () => [
        {
          id: 'server-claude',
          instanceId: 'zhouwenkang/saga2-server',
          projectId: 'remote-server',
          projectName: 'SAGA2服务器',
          projectDescription: null,
          agentType: 'claude',
          agentMode: 'ask',
          status: 'ready',
          workspaceRef: '/server',
          supported: true,
          available: true,
          remoteHostId: 'mcpr:server-claude',
          workingDir: '/server',
        },
      ]),
    };
    const probeClaudeCapability = vi.fn(async () => undefined);
    const probeCodexCapability = vi.fn(async () => undefined);

    await expect(
      resolveUniqueBoundMekaServerTarget({
        router,
        projectId: 'saga2',
        probeCodexCapability,
        probeClaudeCapability,
      }),
    ).resolves.toEqual({
      remoteHostId: 'mcpr:server-claude',
      workerAgent: 'claude-code',
    });
    expect(probeClaudeCapability).toHaveBeenCalledWith('server-claude');
    expect(probeCodexCapability).not.toHaveBeenCalled();
  });

  it('returns unavailable when more than one bound server passes capability hello', async () => {
    const instances = ['server-claude', 'server-codex'].map((id, index) => ({
      id,
      instanceId: id,
      projectId: 'remote-server',
      projectName: `SAGA2 Server ${index + 1}`,
      projectDescription: null,
      agentType: index === 0 ? 'claude' : 'codex',
      agentMode: 'ask',
      status: 'ready',
      workspaceRef: `/server-${index + 1}`,
      supported: true,
      available: true,
      remoteHostId: `mcpr:${id}`,
      workingDir: `/server-${index + 1}`,
    }));

    await expect(
      resolveUniqueBoundMekaServerTarget({
        router: {
          listProjectBindings: vi.fn(async () => instances.map((instance) => instance.id)),
          listInstances: vi.fn(async () => instances),
        },
        projectId: 'saga2',
        probeCodexCapability: vi.fn(async () => undefined),
        probeClaudeCapability: vi.fn(async () => undefined),
      }),
    ).resolves.toBeNull();
  });

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

  it('resolves a bound, available Claude or Codex MCPRouter instance', async () => {
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
    ).resolves.toEqual({
      ok: true,
      workingDir: '/workspace/project',
      remoteHostId: 'mcpr:instance-1',
    });
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
