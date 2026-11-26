/**
 * PSB 协作锁「释放失败」的账本（渲染层；2026-11-26 独立审查修复）。
 *
 * ## 为什么需要它
 *
 * 占用没有 TTL（PSB 侧事实，产品 §2.5）：放弃草稿 / 换目标 / 在途取消时如果 `releaseWorkspace`
 * 失败，锁会一直留在当前用户名下，用户只能去 PSB 网页手动解锁。旧实现只 `log.warn`，用户
 * 完全不知道「远端占用可能还在」。产品 §2.7 要求：**不阻塞离开，但不能静默**——给非阻塞提示 +
 * 常驻提示条。
 *
 * 消费面（本模块只记账 + 提供重试，不自己画 UI）：
 *   - 释放路径（`draft/psbDraftSession.ts` 的放弃草稿、`dialog/usePsbWorkspaceSelection.ts`
 *     的在途取消）失败时 `recordPsbPendingRelease`；
 *   - 常驻提示条 `release/PsbPendingReleaseNotice.tsx` 通过 `release/pendingReleaseNoticeStore.ts`
 *     合并本账本（key = workspaceId）与 main 账本（key = 会话 + 原因）展示「N 个待释放项」并
 *     给**唯一一个**重试入口：`retryPendingPsbReleasesEverywhere()`（本文件重试 + main 账本重试）。
 *   - 状态栏 / 未来设置页仍可单独用 `listPsbPendingReleases()` + `subscribePsbPendingReleases()`。
 *
 * 两本账本**不合并**（产品 §2.5）：本文件只覆盖渲染层直接调 `releaseWorkspace` 的**工作区级**
 * 失败；会话结束释放的失败归 main 账本。提示条只是把两个数据源**合并展示**，各自的重试仍调用
 * 各自的事实来源。
 *
 * 写操作不自动重试（工程契约 §3.2）：本模块不在窗口聚焦等时机偷偷重放，只在调用方显式
 * `retryPsbPendingReleases()`（提示条的「重试」按钮 / 统一入口）时执行一次。
 */

import { createLogger } from '@/lib/logger';

import type { PsbRemoteBridge } from '../bridge';
import { readPsbFailure, type PsbFailureInfo } from '../dialog/psbFailure';

const log = createLogger('RemoteWorkspaceRelease');

/** 提示条正文（首次失败 / 尚未重试）：说明锁可能仍在，并给「重试 / 稍后」。 */
export const PSB_PENDING_RELEASE_NOTICE_KEY = 'remoteWorkspace.draft.releasePending';

/** 提示条正文（用户已显式重试、账本仍有条目）：说明占用可能仍未解除。 */
export const PSB_PENDING_RELEASE_RETAINED_KEY = 'remoteWorkspace.draft.releaseRetained';

/** 账本容量上限：只覆盖最近放弃的草稿，超出后丢最早一条（不无限增长）。 */
const MAX_PENDING_RELEASES = 16;

/** 一次释放失败：同一个工作区只保留一条，重复失败累加 `attempts`。 */
export interface PsbPendingReleaseEntry {
  readonly workspaceId: string;
  /** 第一次失败时间（ms）。 */
  readonly firstFailedAt: number;
  /** 最近一次失败时间（ms）。 */
  readonly lastFailedAt: number;
  /** 连续失败次数（重试成功后整条移除）。 */
  readonly attempts: number;
  /** 最近一次失败的归一化事实（诊断行来自 PSB / 本机，不含凭据）。 */
  readonly failure: PsbFailureInfo;
}

let entries: readonly PsbPendingReleaseEntry[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 稳定快照（没有变化时返回同一引用，可直接喂 `useSyncExternalStore`）。 */
export function listPsbPendingReleases(): readonly PsbPendingReleaseEntry[] {
  return entries;
}

export function subscribePsbPendingReleases(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 记一次释放失败（幂等：同一工作区累计次数并刷新最近错误）。 */
export function recordPsbPendingRelease(workspaceId: string, error: unknown): void {
  const id = workspaceId.trim();
  if (!id) return;
  const now = Date.now();
  const previous = entries.find((entry) => entry.workspaceId === id);
  const next: PsbPendingReleaseEntry = {
    workspaceId: id,
    firstFailedAt: previous?.firstFailedAt ?? now,
    lastFailedAt: now,
    attempts: (previous?.attempts ?? 0) + 1,
    failure: readPsbFailure(error),
  };
  const withoutPrevious = entries.filter((entry) => entry.workspaceId !== id);
  entries = [next, ...withoutPrevious].slice(0, MAX_PENDING_RELEASES);
  emit();
}

/** 释放成功（或用户已手动解锁后确认）时移除该工作区的记账。 */
export function clearPsbPendingRelease(workspaceId: string): void {
  const id = workspaceId.trim();
  if (!id || !entries.some((entry) => entry.workspaceId === id)) return;
  entries = entries.filter((entry) => entry.workspaceId !== id);
  emit();
}

/**
 * 释放一个工作区的占用，失败时记账并保持调用方非阻塞。
 *
 * 返回 `true` = 已释放；`false` = 失败（已记账，UI 可提示「到 PSB 网页解除占用」）。
 * 不抛错：调用点都在离开/取消路径上，抛错只会把「离开」也拖住。
 */
export async function releasePsbWorkspaceOccupancy(
  bridge: PsbRemoteBridge | null,
  workspaceId: string,
  reason: string,
): Promise<boolean> {
  if (!bridge) {
    recordPsbPendingRelease(workspaceId, null);
    return false;
  }
  try {
    await bridge.releaseWorkspace({ workspaceId });
    clearPsbPendingRelease(workspaceId);
    return true;
  } catch (error) {
    recordPsbPendingRelease(workspaceId, error);
    log.warn(`psb: release workspace failed (${reason}); user may still hold the lock`, error);
    return false;
  }
}

/**
 * 显式重试账本里的释放（用户点「重试解除占用」时调用）。
 *
 * 只做一次、不排后台重试；仍失败的工作区留在账本里（调用方据此刷新提示）。
 * 返回仍未成功的工作区 id（空数组 = 全部释放成功）。
 */
export async function retryPsbPendingReleases(
  getBridge: () => PsbRemoteBridge | null,
): Promise<readonly string[]> {
  const bridge = getBridge();
  if (!bridge) return entries.map((entry) => entry.workspaceId);
  const pending = [...entries];
  for (const entry of pending) {
    try {
      await bridge.releaseWorkspace({ workspaceId: entry.workspaceId });
      clearPsbPendingRelease(entry.workspaceId);
    } catch (error) {
      recordPsbPendingRelease(entry.workspaceId, error);
      log.warn('psb: retry release workspace failed', error);
    }
  }
  return entries.map((entry) => entry.workspaceId);
}

/** 单测用：清空账本与订阅（生产代码靠成功释放 / 显式清除）。 */
export function resetPsbPendingReleasesForTest(): void {
  entries = [];
  listeners.clear();
}
