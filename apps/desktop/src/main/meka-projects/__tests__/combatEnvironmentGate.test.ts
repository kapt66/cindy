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
    expect(receipt).toContain('first user-visible assistant message');
    expect(receipt).toContain('战斗开发');
    expect(receipt).toContain('before loading any Skill');
    expect(receipt).not.toContain('127.0.0.1');
    expect(receipt).not.toContain('mcpr:server-1');
  });

  it('blocks the complete gate when one required path is unavailable', async () => {
    const deps = readyDeps();
    deps.listInstances = vi.fn(async () => []);

    const gate = await runCombatEnvironmentGate(deps);

    expect(gate.ready).toBe(false);
    expect(gate.mcpr).toMatchObject({ status: 'blocked' });
    expect(formatCombatEnvironmentGateReceipt(gate)).toContain('BLOCKED TURN CONTRACT');
  });

  it('blocks before exploration when the bound server cannot deliver native Skills', async () => {
    const deps = readyDeps();
    deps.probeRemoteCodexCapability = vi.fn(async () => {
      throw new Error(
        '[INVALID_BUNDLE_VERSION] client bundle 0.0.7 does not match server bundle 0.0.6',
      );
    });

    const gate = await runCombatEnvironmentGate(deps);

    expect(gate.ready).toBe(false);
    expect(gate.mcpr).toMatchObject({
      status: 'blocked',
      summary:
        'MCPRouter 已连接，但远端 Agent Runtime 与当前客户端不兼容（客户端 0.0.7，远端 0.0.6）',
      evidence: 'cc-manager bundle mismatch: client=0.0.7; server=0.0.6',
    });
    const receipt = formatCombatEnvironmentGateReceipt(gate);
    expect(receipt).toContain('客户端 0.0.7，远端 0.0.6');
    expect(receipt).toContain('without any tool call');
    expect(receipt).toContain('Do not load Skills or AGENTS.md');
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
