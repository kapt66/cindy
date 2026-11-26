import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { MekaP4Settings } from '../../../../shared/meka-settings';
import { MCPR_REMOTE_HOST_PREFIX, type MekaRouterInstance } from '../../../../shared/meka-router';
import { PSB_REMOTE_HOST_PREFIX } from '../../../../shared/psb-remote-workspace';
import type { WorkerInfo } from './useWorkers';

/**
 * transport 判定的**已知分歧点**（仅显示用途，等 shared 层纯函数）。
 *
 * main 侧的 `classifyRemoteSessionTransport`
 * (`src/main/maker-host/remote-session-routing.ts`) 是 `remoteHostId` 的唯一
 * transport 分类入口（`'local' | 'ssh' | 'mcpr' | 'psb'`）。renderer **不得**直接 import
 * main 模块（`docs/dev-rules/architecture-invariants.md` 的依赖方向），而 shared 层
 * 目前只有前缀常量与实例解析函数，没有等价的 transport 分类纯函数：
 * `parseMcprRemoteHostId('mcpr:')` / `parsePsbRemoteHostId('psb:')` 返回 `null`（畸形值被判成
 * 非隧道），与 `startsWith(前缀常量)` 不等价，直接换用会把畸形 `mcpr:` / `psb:` 的 worker
 * 错标成「本地」。
 *
 * 因此本文件仍按**共享前缀常量**判定（不是手写字面量），只用于显示标签，不为这一条新建
 * 跨进程依赖。**建议另立任务**：在 shared 层新增纯函数 `classifyRemoteSessionTransport`
 * （与 main 侧同名同语义，含 malformed 值仍归各自 transport），main 侧改为 re-export，
 * renderer 与本文件一并改用它 —— 届时全仓只剩一个分类实现。
 * 参见 `docs/dev-rules/psb-remote-session-transport.md` §1。与 transport 语义相关的行为
 * （探针、模型面、preflight）不在这里判，见 `lib/remoteCodexModelHost.ts` 的唯一判据。
 */

function isMcprRemoteHostId(value: string | null | undefined): boolean {
  return value?.startsWith(MCPR_REMOTE_HOST_PREFIX) === true;
}

function isPsbRemoteHostId(value: string | null | undefined): boolean {
  return value?.startsWith(PSB_REMOTE_HOST_PREFIX) === true;
}

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
  // 只有 MCPRouter worker 需要按 `listInstances()` 反查项目名；PSB 远程工作区的 worker
  // 显示的是「远程工作区」这一事实，不需要实例列表（也就不发这次 IPC）。
  const hasMcprWorker = enabled && workers.some((worker) => isMcprRemoteHostId(worker.remoteHostId));

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
    if (!hasMcprWorker) {
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
  }, [hasMcprWorker]);

  return useMemo(() => {
    const labels = new Map<string, string>();
    if (!enabled) return labels;
    const root = normalizePath(p4?.p4RootPath);
    const extras = new Map(
      (p4?.extraDirs ?? []).map((directory) => [normalizePath(directory), basename(directory)]),
    );
    for (const worker of workers) {
      // 先收成非空串再做前缀判定：两个 helper 是普通布尔判断（不是类型谓词），避免连续
      // 取反时把同一个联合类型收窄成 `never`。
      const remoteHostId = worker.remoteHostId ?? '';
      // PSB 远程工作区的目录是**远端工作区**：不显示 SSH 主机名，也不去反查 MCPR 实例
      // （那会显示成空白），只说清「这条 worker 的目录在远程工作区」。
      if (isPsbRemoteHostId(remoteHostId)) {
        labels.set(worker.workerId, t('remoteWorkspace.draft.location'));
        continue;
      }
      if (isMcprRemoteHostId(remoteHostId)) {
        const instance = instances.find(
          (candidate) => candidate.remoteHostId === remoteHostId,
        );
        labels.set(
          worker.workerId,
          t('orca.workerList.dir.remote', {
            name: instance?.projectName || instance?.instanceId || remoteHostId.slice(5),
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
