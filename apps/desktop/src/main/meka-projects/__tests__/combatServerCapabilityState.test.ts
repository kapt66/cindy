import { beforeEach, describe, expect, it } from 'vitest';

import {
  beginCombatServerCapabilityDispatch,
  COMBAT_SERVER_WORKER_READ_LIMIT,
  consumeCombatServerWorkerReadBudget,
  consumeTrustedCombatServerCapabilityReport,
  getTrustedCombatServerWorkerRemoteHost,
  hasTrustedCombatServerCapabilityReport,
  recordCombatServerCapabilityAutoBridge,
  rollbackCombatServerCapabilityAutoBridge,
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

  it('accepts natural-language legacy export evidence and an explicit residual question', () => {
    const acceptedOptions = vendorOptions();
    expect(
      beginCombatServerCapabilityDispatch({
        leadSessionId: 'lead-natural-language',
        vendorOptions: acceptedOptions,
        kind: 'create_worker',
        task: [
          '[SAGA2_SERVER_EXPLORATION_READ_ONLY]',
          '[SAGA2_MODULE_FIRST]',
          '老版 Unity 导出已按 skill_id=1021 执行，结构化回执明确目标技能模块资产不存在：新建场景。',
          '本次业务原子能力矩阵：当前敌人、伤害、延迟、重复与终止。',
          '请在当前远端 HEAD 核实这些符号的定义、注册与执行分支。',
        ].join('\n'),
        remoteHostId: 'mcpr:server-1',
      }),
    ).toBe(true);

    const completedOptions = vendorOptions();
    expect(
      beginCombatServerCapabilityDispatch({
        leadSessionId: 'lead-no-residual-question',
        vendorOptions: completedOptions,
        kind: 'create_worker',
        task: [
          '[SAGA2_SERVER_EXPLORATION_READ_ONLY]',
          '[SAGA2_MODULE_FIRST]',
          '老版 Unity 导出已确认目标技能模块资产不存在。',
          '原子能力矩阵：伤害、锁定、等待与重复。',
          '普通伤害模块已核实 entryTypeDamageHit。',
        ].join('\n'),
        remoteHostId: 'mcpr:server-1',
      }),
    ).toBe(false);
  });

  it('rolls a failed dispatch back to an explicit retry state', () => {
    const options = vendorOptions();
    const task =
      '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capability matrix residual gap';
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
    expect(getTrustedCombatServerWorkerRemoteHost('lead-1', 'worker-1')).toBe('mcpr:server-1');
    expect(getTrustedCombatServerWorkerRemoteHost('lead-1', 'worker-session-1')).toBe(
      'mcpr:server-1',
    );
  });

  it('ties the report to the accepted worker and consumes it exactly once', () => {
    const options = vendorOptions();
    const task =
      '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capability matrix residual gap';
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
    expect(consumeTrustedCombatServerCapabilityReport({ leadSessionId: 'lead-1', report })).toEqual(
      { ok: true },
    );
    expect(consumeTrustedCombatServerCapabilityReport({ leadSessionId: 'lead-1', report })).toEqual(
      { ok: false, reason: 'not-ready' },
    );
  });

  it('clears an in-flight receipt when environment recovery restarts', () => {
    const options = vendorOptions();
    const task =
      '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capability matrix residual gap';
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

  it('rolls an accepted report receipt back to pending when delivery is reverted', () => {
    const options = vendorOptions();
    const task =
      '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capability matrix residual gap';
    const report = {
      supportStatus: 'supported',
      readOnlyConfirmed: true,
      repository: 'saga2-server',
      head: 'abcdef1',
    };
    beginCombatServerCapabilityDispatch({
      leadSessionId: 'lead-1',
      vendorOptions: options,
      kind: 'create_worker',
      task,
      remoteHostId: 'mcpr:server-1',
    });
    settleCombatServerCapabilityDispatch({
      leadSessionId: 'lead-1',
      kind: 'create_worker',
      task,
      accepted: true,
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
    });
    const message = `[Auto-bridged: worker 完成但未调 send_to_lead]\n\n${JSON.stringify(report)}`;
    expect(
      recordCombatServerCapabilityAutoBridge({
        leadSessionId: 'lead-1',
        workerId: 'worker-1',
        workerSessionId: 'worker-session-1',
        message,
        accepted: true,
      }),
    ).toBe('report-ready');

    expect(
      rollbackCombatServerCapabilityAutoBridge({
        leadSessionId: 'lead-1',
        workerId: 'worker-1',
        workerSessionId: 'worker-session-1',
        message,
      }),
    ).toBe(true);
    expect(options).toMatchObject({
      mekaCombatServerCapabilityStatus: 'pending',
      mekaCombatPhase: 'server-capability-check',
    });
    expect(hasTrustedCombatServerCapabilityReport('lead-1')).toBe(false);
  });

  it('settles the same dispatch across line-ending and boundary-whitespace normalization', () => {
    const options = vendorOptions();
    const task =
      '[SAGA2_SERVER_EXPLORATION_READ_ONLY]\n[SAGA2_MODULE_FIRST]\nskill-entry-model atomic capability matrix residual gap';
    expect(
      beginCombatServerCapabilityDispatch({
        leadSessionId: 'lead-1',
        vendorOptions: options,
        kind: 'create_worker',
        task: `  ${task.replace(/\n/g, '\r\n')}  `,
        remoteHostId: 'mcpr:server-1',
      }),
    ).toBe(true);
    expect(
      settleCombatServerCapabilityDispatch({
        leadSessionId: 'lead-1',
        kind: 'create_worker',
        task,
        accepted: true,
        workerId: 'worker-1',
        workerSessionId: 'worker-session-1',
      }),
    ).toBe(true);
    expect(options).toMatchObject({
      mekaCombatServerCapabilityStatus: 'pending',
      mekaCombatPhase: 'server-capability-check',
    });
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

    const task =
      '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capability matrix residual gap';
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

  it('keeps a worker read budget deterministic and resettable', () => {
    const results = Array.from({ length: COMBAT_SERVER_WORKER_READ_LIMIT + 1 }, () =>
      consumeCombatServerWorkerReadBudget('worker-session-1'),
    );
    expect(results.at(-2)).toMatchObject({
      allowed: true,
      used: COMBAT_SERVER_WORKER_READ_LIMIT,
      remaining: 0,
    });
    expect(results.at(-1)).toMatchObject({
      allowed: false,
      used: COMBAT_SERVER_WORKER_READ_LIMIT,
      remaining: 0,
    });
    resetCombatServerCapabilityStateForTests();
    expect(consumeCombatServerWorkerReadBudget('worker-session-1')).toMatchObject({
      allowed: true,
      used: 1,
    });
  });
});
