import { describe, expect, it, vi } from 'vitest';

import {
  formatCombatEnvironmentGateReceipt,
  runCombatEnvironmentGate,
} from '../combatEnvironmentGate.js';

const p4Info = '... clientName saga2-client\n... clientRoot C:\\Workspace\\saga2\\saga2_project\n';
const p4Where =
  '... depotFile //saga2/saga2_project/saga2_unity/...\n... path C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\...\n';
const p4Client = '... Root C:\\Workspace\\saga2\\saga2_project\n';

function deps() {
  return {
    p4: { p4RootPath: 'C:\\Workspace\\saga2\\saga2_project' },
    execFile: vi
      .fn()
      .mockResolvedValueOnce({ stdout: p4Info, stderr: '' })
      .mockResolvedValueOnce({ stdout: p4Where, stderr: '' })
      .mockResolvedValueOnce({ stdout: p4Client, stderr: '' })
      .mockResolvedValueOnce({ stdout: '... permMax write\n', stderr: '' }),
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
  it('reports P4, official Unity CLI and MCPRouter status without legacy Unity transport', async () => {
    const gate = await runCombatEnvironmentGate(deps());
    expect(gate.ready).toBe(true);
    expect(gate.p4.status).toBe('ready');
    expect(gate.unityCli.status).toBe('ready');
    expect(gate.mcpr.status).toBe('ready');
    const receipt = formatCombatEnvironmentGateReceipt(gate);
    expect(receipt).toContain('unityCli');
    expect(receipt).toContain('unity_inspect');
  });

  it('keeps exploration degraded only when a concrete dependency is unavailable', async () => {
    const input = deps();
    input.listInstances = vi.fn(async () => []);
    const gate = await runCombatEnvironmentGate(input);
    expect(gate.ready).toBe(false);
    expect(gate.mcpr.status).toBe('blocked');
    expect(gate.unityCli.status).toBe('ready');
  });
});
