/**
 * Lead 侧"取回 worker 报告"的等待算法。
 *
 * 背景（2026-11-02 真实会话 34311731）：Lead 派单给 MCPRouter 远端 worker 后，
 * 用 `bash sleep 60` + `sleep 45` 轮询，worker 28 秒就完成、`send_to_lead` 立即
 * 返回 `queued:true`；但报告排在 Lead 自己的输入队列里，只有 Lead 当前 turn
 * 结束才会被消费，于是 sleep 只是把报告送达时间往后拖。
 *
 * 这里提供与"推送"互补的**拉取**语义：worker 的报告一进 Lead 自己的队列就
 * 直接取出来返回给当前 turn，并把它从队列里摘掉（同一条报告只交付一次）。
 * 不改变默认的异步推送（不默认插话），也不依赖模型自觉结束 turn。
 *
 * 三种提前收敛（避免"白等满超时"）：
 * - reported：报告在队列里，已取出；
 * - already_delivered：worker 已停止且队列连续两次为空（报告已被直发/插话送达）；
 * - turn_ended：发起等待的 turn 已结束（报告会按正常推送送达，不撤回）。
 */

export interface OrcaQueuedWorkerReport {
  clientId: string;
  /** 交给模型的正文：优先 `text`（带 `[From Orca Worker …]` 来源前缀），不要 JSON 信封。 */
  text: string;
}

export type OrcaCancelQueuedReportResult = 'cancelled' | 'retry' | 'fatal';

export interface OrcaWorkerSnapshot {
  status: string;
  sessionStatus: string;
  idleMs: number | null;
  isWorking: boolean;
  queuedCount: number;
  result: string;
}

export interface OrcaWaitForWorkerReportDeps {
  /** 读取 Lead 自己队列里（权威快照）来自指定 worker session 的报告，按到达顺序。 */
  listQueuedReports: (workerSessionId: string) => OrcaQueuedWorkerReport[];
  /** 撤回一条排队报告。`fatal` 表示队列不可用，应立即失败而不是继续轮询。 */
  cancelQueuedReport: (clientId: string) => Promise<OrcaCancelQueuedReportResult>;
  /** 轻量状态探测（每 statusIntervalMs 一次），用于判断"报告已经送过了"。 */
  readWorkerSettled: () => Promise<{ isWorking: boolean; queuedCount: number }>;
  /** 完整快照（仅在收敛/超时读一次）。 */
  readWorkerSnapshot: () => Promise<OrcaWorkerSnapshot>;
  /** 发起等待的 turn 是否还活着；turn 结束后绝不撤回报告。 */
  isTurnActive?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type OrcaWaitForWorkerReportOutcome =
  | {
      ok: true;
      outcome: 'reported';
      text: string;
      clientId: string;
      waitedMs: number;
    }
  | {
      ok: true;
      outcome: 'already_delivered' | 'turn_ended' | 'timeout';
      waitedMs: number;
      snapshot: OrcaWorkerSnapshot;
    }
  | { ok: false; errorCode: string; message: string };

export const ORCA_WAIT_FOR_WORKER_DEFAULT_TIMEOUT_MS = 300_000;
/**
 * 上限必须低于 harness 的 MCP 请求超时（Codex `MCP_TIMEOUT_SEC` 与 Pi
 * `REMOTE_MCP_REQUEST_TIMEOUT_MS` 都是 600s），否则模型拿到的是宿主超时错误，
 * 而不是这里的优雅超时回执。
 */
export const ORCA_WAIT_FOR_WORKER_MAX_TIMEOUT_MS = 540_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_STATUS_INTERVAL_MS = 750;
/** worker 已停且队列为空需要连续观察到几次才判定"报告已送达"。 */
const SETTLED_STREAK_TO_RETURN = 2;

export async function waitForWorkerReportFromQueue(
  deps: OrcaWaitForWorkerReportDeps,
  options: {
    workerSessionId: string;
    timeoutMs: number;
    pollIntervalMs?: number;
    statusIntervalMs?: number;
  },
): Promise<OrcaWaitForWorkerReportOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const statusIntervalMs = Math.max(
    pollIntervalMs,
    options.statusIntervalMs ?? DEFAULT_STATUS_INTERVAL_MS,
  );
  const timeoutMs = Math.max(0, options.timeoutMs);
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let nextStatusAt = startedAt;
  let settledStreak = 0;

  const snapshotOutcome = async (
    outcome: 'already_delivered' | 'turn_ended' | 'timeout',
  ): Promise<OrcaWaitForWorkerReportOutcome> => ({
    ok: true,
    outcome,
    waitedMs: now() - startedAt,
    snapshot: await deps.readWorkerSnapshot(),
  });

  for (;;) {
    // turn 已经结束（用户 Stop / 交互结束）：报告交给正常推送，绝不撤回。
    if (deps.isTurnActive && !deps.isTurnActive()) {
      return snapshotOutcome('turn_ended');
    }

    const report = deps.listQueuedReports(options.workerSessionId)[0];
    if (report) {
      const cancelled = await deps.cancelQueuedReport(report.clientId);
      if (cancelled === 'cancelled') {
        return {
          ok: true,
          outcome: 'reported',
          text: report.text,
          clientId: report.clientId,
          waitedMs: now() - startedAt,
        };
      }
      if (cancelled === 'fatal') {
        return { ok: false, errorCode: 'QUEUE_UNAVAILABLE', message: 'lead 输入队列当前不可用' };
      }
      // retry：队列项刚好被 turn 消费（竞态），继续等；下一轮状态探测会收敛。
    }

    if (now() >= nextStatusAt) {
      nextStatusAt = now() + statusIntervalMs;
      const settled = await deps.readWorkerSettled();
      if (!settled.isWorking && settled.queuedCount === 0) {
        settledStreak += 1;
        if (settledStreak >= SETTLED_STREAK_TO_RETURN) {
          return snapshotOutcome('already_delivered');
        }
      } else {
        settledStreak = 0;
      }
    }

    if (now() >= deadline) {
      return snapshotOutcome('timeout');
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
}
