// 回归锁定 2026-11-02 会话事故的等待契约：
// - 报告入队即取走（同一条只交付一次）；
// - worker 已收敛但报告不在队列（已被直发/插话送达）时立即返回，不白等；
// - turn 已结束时不撤回报告；
// - 队列不可用时立即失败，不无限轮询。
import { describe, expect, it } from 'vitest';

import {
  waitForWorkerReportFromQueue,
  type OrcaWaitForWorkerReportDeps,
} from '../orcaWaitForWorkerReport.js';

function baseDeps(
  overrides: Partial<OrcaWaitForWorkerReportDeps> = {},
): OrcaWaitForWorkerReportDeps {
  return {
    listQueuedReports: () => [],
    cancelQueuedReport: async () => 'cancelled',
    readWorkerSettled: async () => ({ isWorking: false, queuedCount: 0 }),
    readWorkerSnapshot: async () => ({
      status: 'idle',
      sessionStatus: 'idle',
      idleMs: 100,
      isWorking: false,
      queuedCount: 0,
      result: 'latest output',
    }),
    now: () => 0,
    sleep: async () => {},
    ...overrides,
  };
}

describe('waitForWorkerReportFromQueue', () => {
  it('returns the queued report immediately and hands the model-facing text', async () => {
    const cancelled: string[] = [];
    const outcome = await waitForWorkerReportFromQueue(
      baseDeps({
        listQueuedReports: () => [{ clientId: 'c-1', text: '[From Orca Worker developer] done' }],
        cancelQueuedReport: async (clientId) => {
          cancelled.push(clientId);
          return 'cancelled';
        },
      }),
      { workerSessionId: 's-1', timeoutMs: 300_000 },
    );
    expect(outcome).toMatchObject({
      ok: true,
      outcome: 'reported',
      text: '[From Orca Worker developer] done',
      clientId: 'c-1',
    });
    expect(cancelled).toEqual(['c-1']);
  });

  it('keeps waiting while the report has not landed yet, then returns it', async () => {
    let clock = 0;
    let polls = 0;
    const outcome = await waitForWorkerReportFromQueue(
      baseDeps({
        listQueuedReports: () => (polls++ >= 3 ? [{ clientId: 'c-2', text: 'finished' }] : []),
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
      { workerSessionId: 's-1', timeoutMs: 300_000, pollIntervalMs: 250, statusIntervalMs: 10_000 },
    );
    expect(outcome).toMatchObject({ ok: true, outcome: 'reported', text: 'finished' });
  });

  it('returns already_delivered once the worker settled and no report showed up', async () => {
    let clock = 0;
    const outcome = await waitForWorkerReportFromQueue(
      baseDeps({
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
      { workerSessionId: 's-1', timeoutMs: 300_000, pollIntervalMs: 250, statusIntervalMs: 250 },
    );
    expect(outcome).toMatchObject({ ok: true, outcome: 'already_delivered' });
    expect(clock).toBeLessThan(5_000);
  });

  it('never consumes the report after the turn ended', async () => {
    let cancelCalls = 0;
    const outcome = await waitForWorkerReportFromQueue(
      baseDeps({
        isTurnActive: () => false,
        listQueuedReports: () => [{ clientId: 'c-3', text: 'late' }],
        cancelQueuedReport: async () => {
          cancelCalls += 1;
          return 'cancelled';
        },
      }),
      { workerSessionId: 's-1', timeoutMs: 300_000 },
    );
    expect(outcome).toMatchObject({ ok: true, outcome: 'turn_ended' });
    expect(cancelCalls).toBe(0);
  });

  it('retries when the queued item was consumed in a race, then reports the next one', async () => {
    let attempts = 0;
    let clock = 0;
    const outcome = await waitForWorkerReportFromQueue(
      baseDeps({
        listQueuedReports: () => (clock >= 250 ? [{ clientId: 'c-4', text: 'second report' }] : []),
        cancelQueuedReport: async () => {
          attempts += 1;
          return attempts === 1 ? 'retry' : 'cancelled';
        },
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
      { workerSessionId: 's-1', timeoutMs: 300_000, pollIntervalMs: 250, statusIntervalMs: 10_000 },
    );
    expect(outcome).toMatchObject({ ok: true, outcome: 'reported', text: 'second report' });
  });

  it('fails fast when the queue is unavailable', async () => {
    const outcome = await waitForWorkerReportFromQueue(
      baseDeps({
        listQueuedReports: () => [{ clientId: 'c-5', text: 'x' }],
        cancelQueuedReport: async () => 'fatal',
      }),
      { workerSessionId: 's-1', timeoutMs: 300_000 },
    );
    expect(outcome).toMatchObject({ ok: false, errorCode: 'QUEUE_UNAVAILABLE' });
  });

  it('returns timeout with the worker snapshot when the worker keeps running', async () => {
    let clock = 0;
    const outcome = await waitForWorkerReportFromQueue(
      baseDeps({
        readWorkerSettled: async () => ({ isWorking: true, queuedCount: 1 }),
        readWorkerSnapshot: async () => ({
          status: 'running',
          sessionStatus: 'running',
          idleMs: null,
          isWorking: true,
          queuedCount: 1,
          result: 'partial output',
        }),
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
      { workerSessionId: 's-1', timeoutMs: 1_000, pollIntervalMs: 250, statusIntervalMs: 250 },
    );
    expect(outcome).toMatchObject({
      ok: true,
      outcome: 'timeout',
      snapshot: { status: 'running', isWorking: true, queuedCount: 1, result: 'partial output' },
    });
    expect(clock).toBeGreaterThanOrEqual(1_000);
  });
});
