import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  formatCombatEnvironmentGateReceipt,
  runCombatEnvironmentGate,
} from '../combatEnvironmentGate.js';

/**
 * The gate compares its configured root, the P4 `clientRoot`/`Root` and the
 * `where` mapping with the *host* `node:path` implementation, so the fixture
 * paths must be produced by that same implementation. Hard-coding
 * `C:\Workspace\saga2\saga2_project` only works on Windows: on the Linux CI
 * runner `\` is an ordinary filename character, `path.join` then emits a mixed
 * `C:\...\saga2_project/saga2_unity` mapping that no longer matches the `where`
 * output, and `checkP4` reports a client-root/mapping mismatch.
 *
 * The root is derived from the OS temp dir on purpose: that is an absolute path
 * on every platform, and it is guaranteed not to exist, so this suite can never
 * silently depend on a real SAGA2 checkout, a `p4` client or `P4CLIENT` env.
 */
const p4Root = path.join(os.tmpdir(), 'cindy-meka-combat-gate-fixture', 'saga2_project');
const p4UnityRoot = path.join(p4Root, 'saga2_unity');
/** A mapping that resolves outside the configured root; used by the negative case. */
const foreignUnityRoot = path.join(os.tmpdir(), 'cindy-meka-combat-gate-foreign', 'saga2_unity');

const p4Info = `... clientName saga2-client\n... clientRoot ${p4Root}\n`;
const p4Where =
  `... depotFile //saga2/saga2_project/saga2_unity/...\n` +
  `... path ${path.join(p4UnityRoot, '...')}\n`;
const p4Client = `... Root ${p4Root}\n`;
const p4Protects = '... permMax write\n';

function deps() {
  return {
    p4: { p4RootPath: p4Root },
    execFile: vi
      .fn()
      .mockResolvedValueOnce({ stdout: p4Info, stderr: '' })
      .mockResolvedValueOnce({ stdout: p4Where, stderr: '' })
      .mockResolvedValueOnce({ stdout: p4Client, stderr: '' })
      .mockResolvedValueOnce({ stdout: p4Protects, stderr: '' }),
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
  it('reports P4, official Unity CLI and MCPRouter status', async () => {
    const gate = await runCombatEnvironmentGate(deps());
    expect(gate.ready).toBe(true);
    expect(gate.p4.status).toBe('ready');
    expect(gate.unityCli.status).toBe('ready');
    expect(gate.mcpr.status).toBe('ready');
    const receipt = formatCombatEnvironmentGateReceipt(gate);
    expect(receipt).toContain('unityCli');
    expect(receipt).toContain('unity_inspect');
  });

  it('blocks P4 when the client mapping resolves outside the configured workspace', async () => {
    const input = deps();
    input.execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: p4Info, stderr: '' })
      .mockResolvedValueOnce({
        stdout:
          `... depotFile //saga2/saga2_project/saga2_unity/...\n` +
          `... path ${path.join(foreignUnityRoot, '...')}\n`,
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: p4Client, stderr: '' })
      .mockResolvedValueOnce({ stdout: p4Protects, stderr: '' });

    const gate = await runCombatEnvironmentGate(input);
    expect(gate.ready).toBe(false);
    expect(gate.p4.status).toBe('blocked');
    expect(gate.p4.evidence).toContain('does not match the configured SAGA2 workspace');
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
