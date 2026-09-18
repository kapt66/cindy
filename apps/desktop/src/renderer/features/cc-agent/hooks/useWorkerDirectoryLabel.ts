import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { MekaP4Settings } from '../../../../shared/meka-settings';
import type { MekaRouterInstance } from '../../../../shared/meka-router';
import type { WorkerInfo } from './useWorkers';

/**
 * transport 判定的**已知分歧点**（未改，等 shared 层纯函数）。
 *
 * main 侧的 `classifyRemoteSessionTransport`
 * (`src/main/maker-host/remote-session-routing.ts`) 是 `remoteHostId` 的唯一
 * transport 分类入口（`'local' | 'ssh' | 'mcpr'`）。renderer **不得**直接 import
 * main 模块（`docs/dev-rules/architecture-invariants.md` 的依赖方向），而 shared 层
 * 目前只有 `parseMcprRemoteHostId` / `MCPR_REMOTE_HOST_PREFIX`，没有等价的
 * transport 分类纯函数：`parseMcprRemoteHostId('mcpr:')` 返回 `null`（畸形值被判成
 * 非 mcpr），与 `startsWith(MCPR_REMOTE_HOST_PREFIX)` 不等价，直接换用会把畸形
 * `mcpr:` 的 worker 错标成「本地」。
 *
 * 因此本文件两处仍按 `mcpr:` 前缀判定（既有形态，仅用于显示标签），不为这一条
 * 新建跨进程依赖。**建议另立任务**：在 shared 层新增纯函数
 * `classifyRemoteSessionTransport`（与 main 侧同名同语义，含 malformed `mcpr:`
 * 仍归 'mcpr'），main 侧改为 re-export，renderer 与本文件一并改用它 —— 届时全仓
 * 只剩一个分类实现。参见 `docs/dev-rules/mcpr-remote-session-routing.md` §2。
 */

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
