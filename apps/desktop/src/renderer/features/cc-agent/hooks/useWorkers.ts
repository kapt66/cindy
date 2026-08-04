/**
 * useWorkers — 读取 renderer 进程内唯一的 Orca worker 投影。
 */

import { useCallback } from 'react';
import { createLogger } from '@/lib/logger';
import { orcaWorkflowsFor } from '@/lib/makerTransport';
import { type OrcaWorkerStatus } from '../../../../shared/orca-worker-status';

import {
  clearWorkerProjectionStore,
  getActiveWorkerCount,
  refreshWorkerCreationState,
  revalidateWorkersProjection,
  useWorkerProjection,
  useWorkerProjectionOwner,
} from './workerProjectionStore';

const log = createLogger('useWorkers');

export interface WorkerInfo {
  workerId: string;
  sessionId: string;
  role: string;
  agent: 'claude-code' | 'codex' | 'pi';
  model: string;
  effort: string | null;
  label: string | null;
  workingDir?: string | null;
  remoteHostId?: string | null;
  status: OrcaWorkerStatus;
  focused: boolean;
  idleSince: string | null;
}

const DEFAULT_SOFT_LIMIT = 5;
const DEFAULT_HARD_LIMIT = 8;

interface WorkersSnapshot {
  workers: WorkerInfo[];
  softLimit: number;
  hardLimit: number;
}

export interface WorkersRefreshResult {
  leadSessionId: string;
  requestId: number;
  status: 'applied' | 'failed';
  workers: WorkerInfo[];
}

export interface WorkerCreationRefreshResult {
  status: 'applied' | 'failed';
  workers: WorkerInfo[];
  hardLimit: number | null;
}

const DEFAULT_SNAPSHOT: WorkersSnapshot = {
  workers: [],
  softLimit: DEFAULT_SOFT_LIMIT,
  hardLimit: DEFAULT_HARD_LIMIT,
};
const workersCache = new Map<string, WorkersSnapshot>();
const workersRequestSeq = new Map<string, number>();
const settingsRequestSeq = new Map<string, number>();
const latestWorkersRequest = new Map<string, Promise<WorkersRefreshResult>>();
const latestWorkersResult = new Map<string, WorkersRefreshResult>();
const cacheSubscribers = new Map<string, Set<() => void>>();

function mapWorkerRecord(raw: Record<string, unknown>): WorkerInfo {
  const session = raw.session as Record<string, unknown> | undefined;
  return {
    workerId: raw.id as string,
    sessionId: raw.sessionId as string,
    role: (raw.role as string) ?? 'developer',
    agent: session?.agentKind === 'codex' ? 'codex' : 'claude-code',
    model: (session?.model as string) ?? 'claude-sonnet-4-6',
    effort: (session?.effort as string | null) ?? null,
    label: (raw.label as string | null) ?? null,
    workingDir:
      typeof session?.workingDir === 'string' && session.workingDir
        ? session.workingDir
        : null,
    remoteHostId:
      typeof session?.remoteHostId === 'string' && session.remoteHostId
        ? session.remoteHostId
        : null,
    status: (raw.status as WorkerInfo['status']) ?? 'idle',
    focused: (raw.focused as boolean) ?? false,
    idleSince: (raw.idleSince as string | null) ?? null,
  };
}

function readCachedSnapshot(leadSessionId: string | undefined): WorkersSnapshot {
  if (!leadSessionId) return DEFAULT_SNAPSHOT;
  return workersCache.get(leadSessionId) ?? DEFAULT_SNAPSHOT;
}

function writeCachedSnapshot(
  leadSessionId: string,
  patch: Partial<WorkersSnapshot>,
): WorkersSnapshot {
  const current = workersCache.get(leadSessionId) ?? DEFAULT_SNAPSHOT;
  const next = { ...current, ...patch };
  workersCache.set(leadSessionId, next);
  cacheSubscribers.get(leadSessionId)?.forEach((listener) => listener());
  return next;
}

function nextRequestId(sequences: Map<string, number>, leadSessionId: string): number {
  const next = (sequences.get(leadSessionId) ?? 0) + 1;
  sequences.set(leadSessionId, next);
  return next;
}

function subscribeCachedSnapshot(leadSessionId: string, listener: () => void): () => void {
  const listeners = cacheSubscribers.get(leadSessionId) ?? new Set<() => void>();
  listeners.add(listener);
  cacheSubscribers.set(leadSessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) cacheSubscribers.delete(leadSessionId);
  };
}

async function refreshWorkersSnapshot(leadSessionId: string): Promise<WorkersRefreshResult> {
  const requestId = nextRequestId(workersRequestSeq, leadSessionId);
  const request = orcaWorkflowsFor(leadSessionId)
    .listWorkersByLead(leadSessionId)
    .then((records) => {
      const workers = (records as unknown as Array<Record<string, unknown>>).map(mapWorkerRecord);
      if (workersRequestSeq.get(leadSessionId) === requestId) {
        writeCachedSnapshot(leadSessionId, { workers });
        const result = { leadSessionId, requestId, status: 'applied' as const, workers };
        latestWorkersResult.set(leadSessionId, result);
        return result;
      }
      return null;
    })
    .catch((err) => {
      if (workersRequestSeq.get(leadSessionId) === requestId) {
        log.warn('listWorkersByLead failed', err instanceof Error ? err.message : String(err));
        const result = {
          leadSessionId,
          requestId,
          status: 'failed' as const,
          workers: readCachedSnapshot(leadSessionId).workers,
        };
        latestWorkersResult.set(leadSessionId, result);
        return result;
      }
      return null;
    })
    .then(async (result): Promise<WorkersRefreshResult> => {
      if (result) return result;
      // 本请求已被同 Lead 的更新请求 supersede。等待当前最新请求收敛后返回其明确
      // 结果，让调用方不会把 stale 完成误当成“最新列表确认不含目标 worker”。
      const latest = latestWorkersRequest.get(leadSessionId);
      if (latest && latest !== request) return latest;
      return (
        latestWorkersResult.get(leadSessionId) ?? {
          leadSessionId,
          requestId: workersRequestSeq.get(leadSessionId) ?? requestId,
          status: 'failed',
          workers: readCachedSnapshot(leadSessionId).workers,
        }
      );
    });
  latestWorkersRequest.set(leadSessionId, request);
  void request.finally(() => {
    if (latestWorkersRequest.get(leadSessionId) === request) {
      latestWorkersRequest.delete(leadSessionId);
    }
  });
  return request;
}

async function refreshSettingsSnapshot(leadSessionId: string): Promise<void> {
  const requestId = nextRequestId(settingsRequestSeq, leadSessionId);
  try {
    const settings = await orcaWorkflowsFor(leadSessionId).getCollaborationSettings();
    if (settingsRequestSeq.get(leadSessionId) !== requestId) return;
    const s = settings as Record<string, unknown> | undefined;
    if (!s) return;
    const patch: Partial<WorkersSnapshot> = {};
    if (typeof s.workerSoftLimit === 'number') patch.softLimit = s.workerSoftLimit;
    if (typeof s.workerHardLimit === 'number') patch.hardLimit = s.workerHardLimit;
    if (Object.keys(patch).length > 0) writeCachedSnapshot(leadSessionId, patch);
  } catch {
    // 设置读取失败沿用缓存 / 默认限额，不影响 worker 主视图。
  }
}

export function clearWorkersCache(leadSessionId?: string): void {
  clearWorkerProjectionStore(leadSessionId);
}

export function useWorkers(leadSessionId: string | undefined) {
  useWorkerProjectionOwner(leadSessionId);
  const snapshot = useWorkerProjection(leadSessionId);

  const refresh = useCallback(async (): Promise<WorkersRefreshResult | null> => {
    if (!leadSessionId) return null;
    return revalidateWorkersProjection(leadSessionId);
  }, [leadSessionId]);

  const refreshCreationState = useCallback(async (): Promise<WorkerCreationRefreshResult> => {
    if (!leadSessionId) return { status: 'failed', workers: [], hardLimit: null };
    return refreshWorkerCreationState(leadSessionId);
  }, [leadSessionId]);

  const { workers, softLimit, hardLimit } = snapshot;
  const focusedWorker = workers.find((w) => w.focused) ?? workers[0] ?? null;
  const activeWorkerCount = getActiveWorkerCount(workers);

  return {
    workers,
    focusedWorker,
    activeWorkerCount,
    softLimit,
    hardLimit,
    refresh,
    refreshCreationState,
  };
}
