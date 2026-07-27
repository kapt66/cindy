import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { MekaP4Settings } from '../../../../shared/meka-settings';
import type { MekaRouterInstance } from '../../../../shared/meka-router';
import type { WorkerInfo } from './useWorkers';

function normalizePath(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/u, '').toLocaleLowerCase();
}

function basename(value: string | null | undefined): string {
  const normalized = (value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/u, '');
  return normalized.split('/').pop() ?? normalized;
}

export function useWorkerDirectoryLabels(
  workers: WorkerInfo[],
  enabled: boolean,
): ReadonlyMap<string, string> {
  const { t } = useTranslation();
  const [p4, setP4] = useState<MekaP4Settings | null>(null);
  const [instances, setInstances] = useState<MekaRouterInstance[]>([]);
  const hasRemoteWorker = enabled && workers.some((worker) => worker.remoteHostId?.startsWith('mcpr:'));

  useEffect(() => {
    if (!enabled || workers.length === 0) {
      setP4(null);
      return;
    }
    let cancelled = false;
    void window.electronAPI.mekaSettings.getP4()
      .then((value) => {
        if (!cancelled) setP4(value);
      })
      .catch(() => {
        if (!cancelled) setP4(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, workers.length]);

  useEffect(() => {
    if (!hasRemoteWorker) {
      setInstances([]);
      return;
    }
    let cancelled = false;
    void window.electronAPI.mekaSettings.router.listInstances()
      .then((value) => {
        if (!cancelled) setInstances(value);
      })
      .catch(() => {
        if (!cancelled) setInstances([]);
      });
    return () => {
      cancelled = true;
    };
  }, [hasRemoteWorker]);

  return useMemo(() => {
    const labels = new Map<string, string>();
    if (!enabled) return labels;
    const root = normalizePath(p4?.p4RootPath);
    const extras = new Map(
      (p4?.extraDirs ?? []).map((directory) => [normalizePath(directory), basename(directory)]),
    );
    for (const worker of workers) {
      if (worker.remoteHostId?.startsWith('mcpr:')) {
        const instance = instances.find(
          (candidate) => candidate.remoteHostId === worker.remoteHostId,
        );
        labels.set(
          worker.workerId,
          t('orca.workerList.dir.remote', {
            name: instance?.projectName || instance?.instanceId || worker.remoteHostId.slice(5),
          }),
        );
        continue;
      }
      const workerPath = normalizePath(worker.workingDir);
      if (root && workerPath === root) {
        labels.set(worker.workerId, t('orca.workerList.dir.p4Root'));
        continue;
      }
      const extra = extras.get(workerPath);
      labels.set(
        worker.workerId,
        extra ?? t('orca.workerList.dir.local', { name: basename(worker.workingDir) }),
      );
    }
    return labels;
  }, [enabled, instances, p4, t, workers]);
}
