/**
 * Window-level controller for the "update all plugins" batch flow.
 *
 * The controller owns only batch progress and serial execution. Main validates
 * every downloaded package against its market manifest before atomic placement.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { i18n } from '@/i18n';
import { toast } from '@/lib/toast';
import { readInstalledGhostsSnapshot } from '@/cindy-brain/useInstalledGhosts';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type {
  PluginMarketItem,
  PluginMarketDetail,
  PluginMarketInstallOptions,
  PluginMarketInstallResult,
} from '../../../../shared/pluginMarket';
import { ghostInstallApprovalToken } from '../../../../shared/ghost';
import { pluginMarketErrorKey } from './pluginMarketErrorKey';
import {
  batchSummary,
  buildUpdateAllRows,
  isBatchFinished,
  updateRow,
  type UpdateAllRow,
} from './updateAllModel';

export interface UpdateAllBatchState {
  rows: UpdateAllRow[] | null;
  running: boolean;
  channel: 'cindy' | 'meka' | null;
}

interface UpdateAllBatchHooks {
  /** 页面存在时刷新市场；页面卸载期间缺席，重新进入会全量刷新。 */
  refreshMarket?: () => Promise<void>;
  /** 当前页面对应的市场适配器；批次启动时捕获，避免离开页面后串到 Cindy 渠道。 */
  marketApi?: UpdateAllMarketApi;
}

export interface UpdateAllMarketApi {
  channel?: 'cindy' | 'meka';
  detail: (pluginId: string) => Promise<PluginMarketDetail>;
  install: (
    pluginId: string,
    options: PluginMarketInstallOptions,
  ) => Promise<PluginMarketInstallResult>;
}

let state: UpdateAllBatchState = { rows: null, running: false, channel: null };
let finishToastShown = false;
let hooks: UpdateAllBatchHooks = {};
let batchMarketApi: UpdateAllMarketApi | null = null;

function defaultMarketApi(): UpdateAllMarketApi {
  return {
    channel: 'cindy',
    detail: (pluginId) => window.electronAPI.pluginMarket.detail(pluginId),
    install: (pluginId, options) => window.electronAPI.pluginMarket.install(pluginId, options),
  };
}
let batchOwner: DataOwnerGeneration | null = null;
let batchGeneration = 0;
const listeners = new Set<() => void>();

function emit(next: UpdateAllBatchState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function beginGeneration(): number {
  batchGeneration += 1;
  return batchGeneration;
}

function batchOwnerCurrent(): boolean {
  return batchOwner !== null && isDataOwnerGenerationCurrent(batchOwner);
}

function isGenerationCurrent(generation: number): boolean {
  return generation === batchGeneration && batchOwnerCurrent();
}

function patchRow(generation: number, pluginId: string, patch: Partial<UpdateAllRow>): void {
  if (!isGenerationCurrent(generation) || state.rows === null) return;
  emit({ ...state, rows: updateRow(state.rows, pluginId, patch) });
}

function voidStaleBatch(): void {
  batchOwner = null;
  beginGeneration();
  finishToastShown = true;
  emit({ rows: null, running: false, channel: null });
}

export function subscribeUpdateAllBatch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUpdateAllBatchState(): UpdateAllBatchState {
  return state;
}

export function setUpdateAllBatchHooks(next: UpdateAllBatchHooks): () => void {
  hooks = next;
  return () => {
    if (hooks === next) hooks = {};
  };
}

async function refreshMarketIfMounted(): Promise<void> {
  try {
    await hooks.refreshMarket?.();
  } catch {
    // 批次结果不依赖刷新成功；重新进入页面会再取完整快照。
  }
}

function maybeFinishToast(): void {
  const rows = state.rows;
  if (!rows || rows.length === 0 || !isBatchFinished(rows) || finishToastShown) return;
  finishToastShown = true;
  const summary = batchSummary(rows);
  toast.success(
    i18n.t('settings.ghosts.updateAll.doneToast', {
      done: summary.done,
      rest: summary.skipped + summary.failed,
    }),
  );
}

export function startUpdateAllBatch(marketUpdates: readonly PluginMarketItem[]): void {
  if (state.running) return;
  const installedVersionById = new Map(
    readInstalledGhostsSnapshot().map((ghost) => [ghost.manifest.id, ghost.manifest.version]),
  );
  finishToastShown = false;
  batchOwner = getDataOwnerGeneration();
  batchMarketApi = hooks.marketApi ?? defaultMarketApi();
  const channel = batchMarketApi.channel ?? 'cindy';
  const generation = beginGeneration();
  emit({ rows: buildUpdateAllRows(marketUpdates, installedVersionById), running: false, channel });
  void runQueue(generation);
}

/** 串行执行，每个 install() 自己在 Main 中下载、校验并提交同一真实包。 */
async function runQueue(generation: number): Promise<void> {
  if (state.running || !isGenerationCurrent(generation)) return;
  emit({ ...state, running: true });
  try {
    for (;;) {
      if (generation !== batchGeneration) return;
      if (!batchOwnerCurrent()) {
        voidStaleBatch();
        return;
      }
      const next = state.rows?.find((row) => row.status === 'pending');
      if (!next) break;
      patchRow(generation, next.pluginId, { status: 'installing' });
      try {
        const detail = await batchMarketApi!.detail(next.pluginId);
        if (generation !== batchGeneration) return;
        if (!batchOwnerCurrent()) {
          voidStaleBatch();
          return;
        }
        if (detail.installState === 'installed') {
          patchRow(generation, next.pluginId, { status: 'done' });
          continue;
        }
        if (detail.installState !== 'update-available') {
          patchRow(generation, next.pluginId, { status: 'skipped' });
          continue;
        }
        const installed = readInstalledGhostsSnapshot().find(
          (ghost) => ghost.manifest.id === next.ghostId,
        );
        if (!installed) {
          patchRow(generation, next.pluginId, { status: 'skipped' });
          continue;
        }
        patchRow(generation, next.pluginId, {
          fromVersion: installed.manifest.version,
          toVersion: detail.version,
        });
        await batchMarketApi!.install(next.pluginId, {
          expectedReleaseId: detail.releaseId,
          expectedManifest: detail.manifest,
          expectedInstalledApproval: ghostInstallApprovalToken(installed.approval),
          allowSourceReplacement: false,
        });
        if (generation !== batchGeneration) return;
        if (!batchOwnerCurrent()) {
          voidStaleBatch();
          return;
        }
        patchRow(generation, next.pluginId, { status: 'done' });
      } catch (error) {
        if (generation !== batchGeneration) return;
        if (!batchOwnerCurrent()) {
          voidStaleBatch();
          return;
        }
        patchRow(generation, next.pluginId, {
          status: 'failed',
          errorText: i18n.t(pluginMarketErrorKey(error)),
        });
      }
    }
  } finally {
    await settleBatchTail(generation);
  }
}

async function settleBatchTail(generation: number): Promise<void> {
  if (generation !== batchGeneration) return;
  await refreshMarketIfMounted();
  if (generation !== batchGeneration) return;
  if (!batchOwnerCurrent()) {
    voidStaleBatch();
    return;
  }
  if (state.running) emit({ ...state, running: false });
  maybeFinishToast();
}

/** 页面外的已装/市场事实变化只用于收束尚未开始的行。 */
export function reconcileUpdateAllBatch(
  marketItems: readonly PluginMarketItem[] = [],
  channel: 'cindy' | 'meka' = 'cindy',
): void {
  if (state.rows === null) return;
  if (state.channel !== channel) return;
  if (!batchOwnerCurrent()) {
    voidStaleBatch();
    return;
  }
  const installStateByPluginId = new Map(
    marketItems.map((item) => [item.pluginId, item.installState]),
  );
  const installedById = new Map(
    readInstalledGhostsSnapshot().map((ghost) => [ghost.manifest.id, ghost.manifest]),
  );
  let rows = state.rows;
  let changed = false;
  for (const row of state.rows) {
    if (row.status !== 'pending') continue;
    const installed = installedById.get(row.ghostId);
    if (!installed) {
      rows = updateRow(rows, row.pluginId, { status: 'skipped' });
      changed = true;
    } else if (installStateByPluginId.get(row.pluginId) === 'installed') {
      rows = updateRow(rows, row.pluginId, { status: 'done' });
      changed = true;
    } else if (
      installStateByPluginId.has(row.pluginId) &&
      installStateByPluginId.get(row.pluginId) !== 'update-available'
    ) {
      rows = updateRow(rows, row.pluginId, { status: 'skipped' });
      changed = true;
    } else if (installed.version !== row.fromVersion) {
      rows = updateRow(rows, row.pluginId, { fromVersion: installed.version });
      changed = true;
    }
  }
  if (changed) emit({ ...state, rows });
}

/** 仅测试用：清空模块级批次状态。 */
export function __resetUpdateAllBatchForTest(): void {
  state = { rows: null, running: false, channel: null };
  finishToastShown = false;
  hooks = {};
  batchMarketApi = null;
  batchOwner = null;
  beginGeneration();
  listeners.clear();
}
