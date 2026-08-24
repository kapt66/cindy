import { describe, expect, it, vi } from 'vitest';

import {
  formatCombatEnvironmentGateReceipt,
  runCombatEnvironmentGate,
} from '../combatEnvironmentGate.js';

const p4Info = '... clientName saga2-client\n... clientRoot C:\\Workspace\\saga2\\saga2_project\n';
const p4Where =
  '... depotFile //saga2/saga2_project/saga2_unity/...\n... path C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\...\n';
const p4Client = '... Root C:\\Workspace\\saga2\\saga2_project\n';

function readyDeps() {
  return {
    p4: { p4RootPath: 'C:\\Workspace\\saga2\\saga2_project' },
    execFile: vi
      .fn()
      .mockResolvedValueOnce({ stdout: p4Info, stderr: '' })
      .mockResolvedValueOnce({ stdout: p4Where, stderr: '' })
      .mockResolvedValueOnce({ stdout: p4Client, stderr: '' })
      .mockResolvedValueOnce({ stdout: '... permMax write\n', stderr: '' }),
    readFile: vi.fn(async () =>
      JSON.stringify({
        projectRoot: 'C:/Workspace/saga2/saga2_project/saga2_unity',
        mcpUrl: 'http://127.0.0.1:7788/mcp',
        unityPid: 1234,
      }),
    ),
    isProcessRunning: vi.fn(() => true),
    fetch: vi.fn(async () => new Response(JSON.stringify({ status: 'healthy' }), { status: 200 })),
    listProjectBindings: vi.fn(async () => ['server-1']),
    listInstances: vi.fn(async () => [
      {
        id: 'server-1',
        instanceId: 'server-1',
        projectId: 'saga2',
        projectName: 'SAGA2 Server',
        projectDescription: 'server repository',
        agentType: 'codex',
        agentMode: 'ask',
        status: 'ready',
        workspaceRef: null,
        supported: true,
        available: true,
        remoteHostId: 'mcpr:server-1',
        workingDir: '/not-exposed',
      },
    ]),
    probeRemoteCodexCapability: vi.fn(async () => undefined),
    projectId: 'saga2',
    now: () => new Date('2026-08-19T00:00:00.000Z'),
  };
}

describe('SAGA2 combat environment gate', () => {
  it('requires current evidence from every path and returns a credential-safe receipt', async () => {
    const gate = await runCombatEnvironmentGate(readyDeps());

    expect(gate.ready).toBe(true);
    expect(gate.p4.status).toBe('ready');
    expect(gate.unityMcp.status).toBe('ready');
    expect(gate.mcpr.status).toBe('ready');
    const receipt = formatCombatEnvironmentGateReceipt(gate);
    expect(receipt).toContain('ready: true');
    expect(receipt).toContain('list_remote_directory');
    expect(receipt).toContain('use the real root read as evidence');
    expect(receipt).toContain('only when the read returns a user-action fallback');
    expect(receipt).toContain('without a fixed environment-status preamble');
    expect(receipt).not.toContain('After reporting the ready result');
    expect(receipt).toContain('远程项目可作为只读参考工作面');
    expect(receipt).toContain('创建 MCPR Agent/Worker 时再单独检查');
    expect(receipt).not.toContain('原生 Skill 投递');
    expect(receipt).not.toContain('127.0.0.1');
    expect(receipt).not.toContain('mcpr:server-1');
  });

  it('reports degraded exploration when one path is unavailable', async () => {
    const deps = readyDeps();
    deps.listInstances = vi.fn(async () => []);

    const gate = await runCombatEnvironmentGate(deps);

    expect(gate.ready).toBe(false);
    expect(gate.mcpr).toMatchObject({ status: 'blocked' });
    const receipt = formatCombatEnvironmentGateReceipt(gate);
    expect(receipt).toContain('DEGRADED EXPLORATION CONTRACT');
    expect(receipt).toContain('list_remote_directory');
    expect(receipt).toContain('report only a fallbackUserAction');
    expect(receipt).not.toContain('report the role, all three statuses, and each next action');
    expect(receipt).not.toContain('在 MCPRouter 中连接并绑定');
  });

  it('keeps the remote project reference available when the Worker runtime is incompatible', async () => {
    const deps = readyDeps();
    deps.probeRemoteCodexCapability = vi.fn(async () => {
      throw new Error(
        '[INVALID_BUNDLE_VERSION] client bundle 0.0.7 does not match server bundle 0.0.6',
      );
    });

    const gate = await runCombatEnvironmentGate(deps);

    expect(gate.ready).toBe(true);
    expect(gate.mcpr).toMatchObject({
      status: 'ready',
      summary: 'MCPRouter 已连接，且 SAGA2 服务器远程项目可作为只读参考工作面',
    });
    expect(deps.probeRemoteCodexCapability).not.toHaveBeenCalled();
    const receipt = formatCombatEnvironmentGateReceipt(gate);
    expect(receipt).toContain('创建 MCPR Agent/Worker 时再单独检查');
    expect(receipt).toContain('远程项目可作为只读参考工作面');
    expect(receipt).toContain('ready: true');
  });

  it('rejects a reachable UnityMCP that advertises a different project', async () => {
    const deps = readyDeps();
    deps.readFile = vi.fn(async () =>
      JSON.stringify({
        projectRoot: 'C:/OtherProject',
        mcpUrl: 'http://127.0.0.1:7788/mcp',
        unityPid: 1234,
      }),
    );

    const gate = await runCombatEnvironmentGate(deps);

    expect(gate.ready).toBe(false);
    expect(gate.unityMcp).toMatchObject({
      status: 'blocked',
      summary: 'UnityMCP 已发现但项目不匹配',
    });
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});
