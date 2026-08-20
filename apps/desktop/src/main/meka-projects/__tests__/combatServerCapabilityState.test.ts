import { beforeEach, describe, expect, it } from 'vitest';

import {
  beginCombatServerCapabilityDispatch,
  consumeTrustedCombatServerCapabilityReport,
  getTrustedCombatServerWorkerRemoteHost,
  hasTrustedCombatServerCapabilityReport,
  recordCombatServerCapabilityAutoBridge,
  resetCombatServerCapabilityFlow,
  resetCombatServerCapabilityStateForTests,
  settleCombatServerCapabilityDispatch,
} from '../combatServerCapabilityState.js';

function vendorOptions(): Record<string, unknown> {
  return {
    source: 'meka',
    mekaProjectId: 'saga2',
    mekaRoleId: 'combat-development',
    mekaWorkflow: 'saga2-combat-development-v1',
    mekaCombatEnvironmentReady: true,
    mekaCombatServerCapabilityStatus: 'unchecked',
    mekaCombatPhase: 'exploration',
  };
}

describe('combat server capability trusted state', () => {
  beforeEach(() => {
    resetCombatServerCapabilityStateForTests();
  });

  it('rolls a failed dispatch back to an explicit retry state', () => {
    const options = vendorOptions();
    const task = '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capability matrix residual gap';
    expect(
      beginCombatServerCapabilityDispatch({
        leadSessionId: 'lead-1',
        vendorOptions: options,
        kind: 'create_worker',
        task,
        remoteHostId: 'mcpr:server-1',
      }),
    ).toBe(true);
    expect(options).toMatchObject({ mekaCombatServerCapabilityStatus: 'dispatching' });
    expect(
      settleCombatServerCapabilityDispatch({
        leadSessionId: 'lead-1',
        kind: 'create_worker',
        task,
        accepted: false,
        workerId: 'worker-1',
        workerSessionId: 'worker-session-1',
      }),
    ).toBe(true);
    expect(options).toMatchObject({
      mekaCombatServerCapabilityStatus: 'retry-required',
      mekaCombatPhase: 'server-capability-retry',
    });
    expect(getTrustedCombatServerWorkerRemoteHost('lead-1', 'worker-1')).toBe(
      'mcpr:server-1',
    );
    expect(getTrustedCombatServerWorkerRemoteHost('lead-1', 'worker-session-1')).toBe(
      'mcpr:server-1',
    );
  });

  it('ties the report to the accepted worker and consumes it exactly once', () => {
    const options = vendorOptions();
    const task = '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capability matrix residual gap';
    const report = {
      supportStatus: 'supported',
      readOnlyConfirmed: true,
      repository: 'saga2-server',
      head: 'abcdef1',
    };
    beginCombatServerCapabilityDispatch({
      leadSessionId: 'lead-1',
      vendorOptions: options,
      kind: 'send_to_worker',
      task,
      requestedWorkerRef: 'worker-session-1',
      remoteHostId: 'mcpr:server-1',
    });
    settleCombatServerCapabilityDispatch({
      leadSessionId: 'lead-1',
      kind: 'send_to_worker',
      task,
      accepted: true,
      workerSessionId: 'worker-session-1',
    });

    expect(
      recordCombatServerCapabilityAutoBridge({
        leadSessionId: 'lead-1',
        workerId: 'other-worker',
        workerSessionId: 'other-session',
        message: JSON.stringify(report),
        accepted: true,
      }),
    ).toBe('ignored');
    expect(hasTrustedCombatServerCapabilityReport('lead-1')).toBe(false);
    expect(
      recordCombatServerCapabilityAutoBridge({
        leadSessionId: 'lead-1',
        workerId: 'worker-1',
        workerSessionId: 'worker-session-1',
        message: `\`\`\`json\n${JSON.stringify({ serverCapabilityReport: report })}\n\`\`\``,
        accepted: true,
      }),
    ).toBe('report-ready');
    expect(hasTrustedCombatServerCapabilityReport('lead-1')).toBe(true);
    expect(
      consumeTrustedCombatServerCapabilityReport({
        leadSessionId: 'lead-1',
        report: { ...report, head: '1234567' },
      }),
    ).toEqual({ ok: false, reason: 'report-mismatch' });
    expect(
      consumeTrustedCombatServerCapabilityReport({ leadSessionId: 'lead-1', report }),
    ).toEqual({ ok: true });
    expect(
      consumeTrustedCombatServerCapabilityReport({ leadSessionId: 'lead-1', report }),
    ).toEqual({ ok: false, reason: 'not-ready' });
  });

  it('clears an in-flight receipt when environment recovery restarts', () => {
    const options = vendorOptions();
    const task = '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capability matrix residual gap';
    beginCombatServerCapabilityDispatch({
      leadSessionId: 'lead-1',
      vendorOptions: options,
      kind: 'create_worker',
      task,
      remoteHostId: 'mcpr:server-1',
    });
    resetCombatServerCapabilityFlow({
      leadSessionId: 'lead-1',
      vendorOptions: options,
      phase: 'environment-recovery',
    });
    expect(options).toMatchObject({
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatPhase: 'environment-recovery',
    });
    expect(hasTrustedCombatServerCapabilityReport('lead-1')).toBe(false);
  });

  it('rejects module-light dispatches and turns an accepted error terminal into retry-required', () => {
    const options = vendorOptions();
    expect(
      beginCombatServerCapabilityDispatch({
        leadSessionId: 'lead-1',
        vendorOptions: options,
        kind: 'create_worker',
        task: '[SAGA2_SERVER_EXPLORATION_READ_ONLY] inspect server',
        remoteHostId: 'mcpr:server-1',
      }),
    ).toBe(false);

    const task = '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capability matrix residual gap';
    expect(
      beginCombatServerCapabilityDispatch({
        leadSessionId: 'lead-1',
        vendorOptions: options,
        kind: 'create_worker',
        task,
        remoteHostId: 'mcpr:server-1',
      }),
    ).toBe(true);
    settleCombatServerCapabilityDispatch({
      leadSessionId: 'lead-1',
      kind: 'create_worker',
      task,
      accepted: true,
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
    });
    expect(
      recordCombatServerCapabilityAutoBridge({
        leadSessionId: 'lead-1',
        workerId: 'worker-1',
        workerSessionId: 'worker-session-1',
        message: JSON.stringify({ supportStatus: 'supported' }),
        accepted: true,
        terminalStatus: 'error',
      }),
    ).toBe('retry-required');
    expect(options).toMatchObject({
      mekaCombatServerCapabilityStatus: 'retry-required',
      mekaCombatPhase: 'server-capability-retry',
    });
    expect(hasTrustedCombatServerCapabilityReport('lead-1')).toBe(false);
  });
});
