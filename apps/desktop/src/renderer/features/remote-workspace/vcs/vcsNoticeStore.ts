/**
 * 版本控制检查通知的渲染层 store（CINDY-RW-10）。
 *
 * ## 数据从哪来
 *
 * 1. **推送**：main 在占用 / 释放时拿到 0.1.180 的 advisory（`data.vcs`）或旧版 409
 *    `details.vcs` 后广播 `WORKSPACE_VCS_NOTICE`；本 store 由 `ensureWorkspaceVcsNoticeBridge`
 *    安装**唯一一条**订阅（没有 React 组件时也要接得住，所以是 module 级单例）。
 * 2. **兜底读**：invoke 失败 / advisory 与 UI 动作竞争时，调用 `hydrateWorkspaceVcsNotice()`
 *    读一次 main 的有界缓存（`workspaceVcsNotice`）。推送与 invoke 失败的先后顺序不可依赖。
 * 3. **本地清除**：用户点「继续」、清理已被接受、成功占用 / 释放后（main 也会广播 `null`）。
 *
 * ## 为什么模块级 store 而不是 Context
 *
 * 同一份 notice 要在侧栏横幅、对话框、管理页三处同时显示；弹窗卸载重挂后不能丢。Context 会
 * 引入「谁挂 Provider」的接线问题（副窗口 / 设置窗口都可能没有），module store + `useSyncExternalStore`
 * 与仓库其它跨窗口状态（`remoteWorkspaceStatusStore`）同口径。
 *
 * ## 安全
 *
 * store 只保存**已由 main 校验过**的 notice（action 路径绑定同一工作区、body 白名单）；
 * 渲染层**不解析也不拼** method/path/body，只按 `kind` 调 `runWorkspaceVcsAction`。
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { PsbRemoteBridge } from '../bridge';
import { tryGetPsbRemoteBridge } from '../bridge';
import type {
  PsbWorkspaceVcsNoticeEvent,
  WorkspaceVcsNotice,
  WorkspaceVcsOperation,
} from '../../../../shared/psb-workspace-vcs';

/** store 里的一条通知（带来源入口，决定 retry 文案与是否 advisory）。 */
export interface WorkspaceVcsNoticeState {
  readonly workspaceId: string;
  readonly operation: WorkspaceVcsOperation;
  readonly notice: WorkspaceVcsNotice;
}

const entries = new Map<string, WorkspaceVcsNoticeState>();
const listeners = new Set<() => void>();

/**
 * 缓存一份不可变快照：`useSyncExternalStore` 的 `getSnapshot` 必须返回**同一引用**直到数据变化，
 * 否则每次 render 都会判定「变了」并死循环。
 */
let snapshot: readonly WorkspaceVcsNoticeState[] = [];

function rebuildSnapshot(): void {
  snapshot = Object.freeze([...entries.values()]);
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* 单个订阅者异常不影响其它 UI */
    }
  }
}

/** 推送载荷 → store。`notice:null` = main 解除了该工作区的通知。 */
export function ingestWorkspaceVcsNoticeEvent(
  event: PsbWorkspaceVcsNoticeEvent | null | undefined,
): void {
  if (!event || typeof event.workspaceId !== 'string' || !event.workspaceId) return;
  if (event.notice) {
    entries.set(event.workspaceId, {
      workspaceId: event.workspaceId,
      operation: event.operation,
      notice: event.notice,
    });
  } else {
    if (!entries.delete(event.workspaceId)) return;
  }
  rebuildSnapshot();
}

/** 读某工作区当前通知（非 React 环境用；组件用 `useWorkspaceVcsNotice`）。 */
export function readWorkspaceVcsNoticeState(
  workspaceId: string | null | undefined,
): WorkspaceVcsNoticeState | null {
  if (!workspaceId) return null;
  return entries.get(workspaceId) ?? null;
}

/** 当前所有通知（全局宿主的「最近一条」横幅用）。 */
export function readWorkspaceVcsNoticeStates(): readonly WorkspaceVcsNoticeState[] {
  return snapshot;
}

/** 订阅 store（返回退订函数；`useSyncExternalStore` 与宿主都可直接用）。 */
export function subscribeWorkspaceVcsNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 本地清除（用户点「继续」/ 宿主主动关闭）。不等 main 广播，避免按钮看起来没反应。 */
export function clearWorkspaceVcsNoticeState(workspaceId: string): void {
  if (entries.delete(workspaceId)) rebuildSnapshot();
}

/** 单测隔离：清空全部状态与订阅安装标记。 */
export function resetWorkspaceVcsNoticeStoreForTest(): void {
  entries.clear();
  listeners.clear();
  bridgeUnsubscribe = null;
  snapshot = Object.freeze([]);
}

let bridgeUnsubscribe: (() => void) | null = null;

/**
 * 安装 main → renderer 的 notice 推送订阅（幂等；多个组件各自调用也只会挂一条）。
 *
 * preload 缺方法（旧 preload / 单测）时返回 no-op：页面降级成「没有提示」而不是崩。
 */
export function ensureWorkspaceVcsNoticeBridge(bridge?: PsbRemoteBridge | null): () => void {
  if (bridgeUnsubscribe) return () => undefined;
  const target = bridge ?? tryGetPsbRemoteBridge();
  if (!target || typeof target.onWorkspaceVcsNotice !== 'function') return () => undefined;
  try {
    bridgeUnsubscribe = target.onWorkspaceVcsNotice((event) => {
      ingestWorkspaceVcsNoticeEvent(event);
    });
  } catch {
    bridgeUnsubscribe = null;
    return () => undefined;
  }
  return () => {
    bridgeUnsubscribe?.();
    bridgeUnsubscribe = null;
  };
}

/**
 * 兜底读一次 main 的有界缓存（推送可能还没到；invoke 失败后必须读，否则 actions 丢失）。
 *
 * 返回读到的通知（`null` = main 没有通知 / 桥不可用）。读到的内容会同步进 store。
 */
export async function hydrateWorkspaceVcsNotice(
  workspaceId: string,
  bridge?: PsbRemoteBridge | null,
): Promise<WorkspaceVcsNotice | null> {
  const target = bridge ?? tryGetPsbRemoteBridge();
  if (!target || typeof target.workspaceVcsNotice !== 'function') return null;
  try {
    const result = await target.workspaceVcsNotice({ workspaceId });
    const notice = result?.notice ?? null;
    if (!notice) {
      clearWorkspaceVcsNoticeState(workspaceId);
      return null;
    }
    // 兜底读不知道「哪个入口」产生的；沿用已有 state 的 operation，缺省按 ensure（自动占用）。
    const existing = entries.get(workspaceId);
    entries.set(workspaceId, {
      workspaceId,
      operation: existing?.operation ?? 'ensure',
      notice,
    });
    rebuildSnapshot();
    return notice;
  } catch {
    return null;
  }
}

/** 组件用：某工作区的通知（自动安装推送订阅 + 首次无数据时兜底读一次）。 */
export function useWorkspaceVcsNotice(
  workspaceId: string | null | undefined,
): WorkspaceVcsNoticeState | null {
  const all = useSyncExternalStore(
    subscribeWorkspaceVcsNotices,
    readWorkspaceVcsNoticeStates,
    readWorkspaceVcsNoticeStates,
  );
  useEffect(() => {
    const dispose = ensureWorkspaceVcsNoticeBridge();
    if (workspaceId && !entries.has(workspaceId)) void hydrateWorkspaceVcsNotice(workspaceId);
    return dispose;
  }, [workspaceId]);
  return useMemo(
    () => all.find((entry) => entry.workspaceId === workspaceId) ?? null,
    [all, workspaceId],
  );
}

/** 组件用：全部通知（全局横幅展示最近一条，管理页可列出全部）。 */
export function useWorkspaceVcsNotices(): readonly WorkspaceVcsNoticeState[] {
  const all = useSyncExternalStore(
    subscribeWorkspaceVcsNotices,
    readWorkspaceVcsNoticeStates,
    readWorkspaceVcsNoticeStates,
  );
  useEffect(() => ensureWorkspaceVcsNoticeBridge(), []);
  return all;
}
