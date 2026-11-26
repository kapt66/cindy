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
 * ## 三条并发 / 生命周期不变量（2026-11-26 独立审查 r4 修复）
 *
 * 1. **顺序单调**：每条 entry 带单调递增 `revision`，每次「更新 / 删除 / 兜底写入」都
 *    `delete + set`（Map 插入序 = 更新时间序）。全局宿主取**最后一条**才是真正的「最近一条」，
 *    不会因为某个工作区的通知被原地更新而继续显示别的旧条目。
 * 2. **兜底读不覆盖更新的推送**：`hydrate` 在发请求前记下该工作区的修改序号；响应回来时
 *    序号已经变了（推送 / 本地清除 / 另一次兜底写入先到）就**不覆盖、不清除**，只返回当前
 *    本地状态。`notice:null` 也只在这段时间内没有任何更新时才清 —— 否则会把刚到的处置入口
 *    抹掉，用户再也没法点「一键清理 / 继续」。
 * 3. **订阅引用计数**：推送订阅由所有窗口组件共享。每个调用方拿到的释放函数只减自己的引用，
 *    最后一个调用方卸载时才真正退订（旧实现是「首个调用者拥有」：首个组件卸载后，后来者拿到的
 *    都是 no-op，页面再也收不到推送）。
 *
 * ## 工作区显示名
 *
 * 横幅要写「工作区名 · 提示」才能说清是哪个工作区。渲染层已有的工作区标题（管理页上下文、
 * 选择器 / 弹窗的工作区行）通过 `rememberWorkspaceVcsNoticeWorkspaceLabel()` 记进一个有界
 * 缓存；store 快照把标题一起带上，Host 不自己查接口、也不为显示名多发请求。
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

/** store 里的一条通知（带来源入口、全局顺序与工作区显示名）。 */
export interface WorkspaceVcsNoticeState {
  readonly workspaceId: string;
  readonly operation: WorkspaceVcsOperation;
  readonly notice: WorkspaceVcsNotice;
  /** 单调递增的修改序号：越大越新；宿主取最大者作为「最近一条」。 */
  readonly revision: number;
  /** 工作区显示名（渲染层已知标题；未知为 `null`，横幅只显示提示本身）。 */
  readonly workspaceLabel: string | null;
}

/** store 内部的不可变条目（不含显示名：显示名是可以后到的独立事实）。 */
interface WorkspaceVcsNoticeEntry {
  readonly workspaceId: string;
  readonly operation: WorkspaceVcsOperation;
  readonly notice: WorkspaceVcsNotice;
}

const entries = new Map<string, WorkspaceVcsNoticeEntry>();
/** 每个工作区最后一次修改的序号（删除也算一次修改：兜底读据此判断「期间有没有推送」）。 */
const workspaceRevisions = new Map<string, number>();
/** 工作区显示名（渲染层上报；有界，避免开过大量工作区的会话无限增长）。 */
const workspaceLabels = new Map<string, string>();
const listeners = new Set<() => void>();

/** 显示名缓存上限：横幅只需要当前工作区，多留一些应对切换 / 多窗口。 */
const MAX_WORKSPACE_LABELS = 64;

let revisionCounter = 0;

/**
 * 缓存一份不可变快照：`useSyncExternalStore` 的 `getSnapshot` 必须返回**同一引用**直到数据变化，
 * 否则每次 render 都会判定「变了」并死循环。
 */
let snapshot: readonly WorkspaceVcsNoticeState[] = [];

function buildSnapshot(): readonly WorkspaceVcsNoticeState[] {
  // Map 的插入序 = 每个 entry 的写入时间序（写入一律 delete + set），所以数组顺序就是
  // revision 升序；最后一条即「最近一条」。
  return Object.freeze(
    [...entries.values()].map((entry) => ({
      ...entry,
      revision: workspaceRevisions.get(entry.workspaceId) ?? 0,
      workspaceLabel: workspaceLabels.get(entry.workspaceId) ?? null,
    })),
  );
}

function notifyListeners(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* 单个订阅者异常不影响其它 UI */
    }
  }
}

function bumpRevision(workspaceId: string): void {
  revisionCounter += 1;
  workspaceRevisions.set(workspaceId, revisionCounter);
}

/** 写入 / 替换某工作区的通知（delete + set：更新也排到「最近一条」的位置）。 */
function setEntry(
  workspaceId: string,
  operation: WorkspaceVcsOperation,
  notice: WorkspaceVcsNotice,
): void {
  entries.delete(workspaceId);
  entries.set(workspaceId, { workspaceId, operation, notice });
  bumpRevision(workspaceId);
}

/** 推送载荷 → store。`notice:null` = main 解除了该工作区的通知。 */
export function ingestWorkspaceVcsNoticeEvent(
  event: PsbWorkspaceVcsNoticeEvent | null | undefined,
): void {
  if (!event || typeof event.workspaceId !== 'string' || !event.workspaceId) return;
  if (event.notice) {
    setEntry(event.workspaceId, event.operation, event.notice);
    notifyListeners();
    return;
  }
  // 删除也记一次修改：并发的兜底读看到序号变了，就不会再把旧 notice 写回来。
  entries.delete(event.workspaceId);
  bumpRevision(event.workspaceId);
  notifyListeners();
}

/** 读某工作区当前通知（非 React 环境用；组件用 `useWorkspaceVcsNotice`）。 */
export function readWorkspaceVcsNoticeState(
  workspaceId: string | null | undefined,
): WorkspaceVcsNoticeState | null {
  if (!workspaceId) return null;
  const entry = entries.get(workspaceId);
  if (!entry) return null;
  return {
    ...entry,
    revision: workspaceRevisions.get(workspaceId) ?? 0,
    workspaceLabel: workspaceLabels.get(workspaceId) ?? null,
  };
}

/** 当前所有通知（按修改时间升序；全局宿主的「最近一条」= 最后一条）。 */
export function readWorkspaceVcsNoticeStates(): readonly WorkspaceVcsNoticeState[] {
  return snapshot;
}

/** 最近一条通知（无通知时 `null`）。 */
export function readLatestWorkspaceVcsNoticeState(): WorkspaceVcsNoticeState | null {
  return snapshot.length > 0 ? snapshot[snapshot.length - 1]! : null;
}

/** 订阅 store（返回退订函数；`useSyncExternalStore` 与宿主都可直接用）。 */
export function subscribeWorkspaceVcsNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 记住某工作区的显示名（管理页上下文、选择器 / 弹窗的工作区行在拿到标题时调用）。
 *
 * 幂等；只在值变化且该工作区当前有通知时通知订阅者（显示名只用于横幅第一行）。
 * 容量有界：超过上限时淘汰最早写入的名字，避免一个进程开过很多工作区后无限增长。
 */
export function rememberWorkspaceVcsNoticeWorkspaceLabel(
  workspaceId: string | null | undefined,
  label: string | null | undefined,
): void {
  const id = workspaceId?.trim();
  const text = label?.trim();
  if (!id || !text) return;
  if (workspaceLabels.get(id) === text) return;
  workspaceLabels.delete(id);
  workspaceLabels.set(id, text);
  while (workspaceLabels.size > MAX_WORKSPACE_LABELS) {
    const oldest = workspaceLabels.keys().next();
    if (oldest.done) break;
    workspaceLabels.delete(oldest.value);
  }
  if (entries.has(id)) notifyListeners();
}

/** 本地清除（用户点「继续」/ 宿主主动关闭 / main 确认已清）。不等 main 广播，避免按钮看起来没反应。 */
export function clearWorkspaceVcsNoticeState(workspaceId: string): void {
  const id = workspaceId.trim();
  if (!id) return;
  const removed = entries.delete(id);
  // 即使本来没有条目也记一次修改：并发的兜底读看到序号变化后不会再写回旧 notice。
  bumpRevision(id);
  if (removed) notifyListeners();
}

/** 单测隔离：清空全部状态、显示名与订阅安装标记。 */
export function resetWorkspaceVcsNoticeStoreForTest(): void {
  entries.clear();
  workspaceRevisions.clear();
  workspaceLabels.clear();
  listeners.clear();
  bridgeSubscription?.unsubscribe();
  bridgeSubscription = null;
  bridgeSubscribers = 0;
  revisionCounter = 0;
  snapshot = Object.freeze([]);
}

/**
 * 唯一的推送订阅（module 级）；`bridgeSubscribers` 是引用计数。
 *
 * 不用「首个调用者拥有」的布尔标记：多个组件（宿主 + 管理页 + 选择器）可能在不同时刻挂载 /
 * 卸载，首个组件卸载后订阅必须保留给仍在挂载的组件，最后一个卸载时才真正退订。
 */
let bridgeSubscription: { readonly unsubscribe: () => void } | null = null;
let bridgeSubscribers = 0;

const NOOP_RELEASE = (): void => undefined;

/**
 * 安装 main → renderer 的 notice 推送订阅（引用计数；多个组件各自调用也只会挂一条底层订阅）。
 *
 * preload 缺方法（旧 preload / 单测）时返回 no-op：页面降级成「没有提示」而不是崩。
 */
export function ensureWorkspaceVcsNoticeBridge(bridge?: PsbRemoteBridge | null): () => void {
  const target = bridge ?? tryGetPsbRemoteBridge();
  if (!target || typeof target.onWorkspaceVcsNotice !== 'function') return NOOP_RELEASE;
  if (!bridgeSubscription) {
    try {
      bridgeSubscription = {
        unsubscribe: target.onWorkspaceVcsNotice((event) => {
          ingestWorkspaceVcsNoticeEvent(event);
        }),
      };
    } catch {
      bridgeSubscription = null;
      return NOOP_RELEASE;
    }
  }
  bridgeSubscribers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    bridgeSubscribers = Math.max(0, bridgeSubscribers - 1);
    if (bridgeSubscribers > 0) return;
    bridgeSubscription?.unsubscribe();
    bridgeSubscription = null;
  };
}

/**
 * 兜底读一次 main 的有界缓存（推送可能还没到；invoke 失败后必须读，否则 actions 丢失）。
 *
 * 返回读到的通知（`null` = main 没有通知 / 桥不可用 / 期间已有更新的本地状态）。读到的内容会
 * 按**单调合并**写进 store：请求期间该工作区发生过任何推送 / 清除，就以本地为准，不覆盖也不清除
 * （见文件头不变量 2）。读失败不抛错（推送仍会到），本地状态保持不变。
 */
export async function hydrateWorkspaceVcsNotice(
  workspaceId: string,
  bridge?: PsbRemoteBridge | null,
): Promise<WorkspaceVcsNotice | null> {
  const id = workspaceId.trim();
  if (!id) return null;
  const target = bridge ?? tryGetPsbRemoteBridge();
  if (!target || typeof target.workspaceVcsNotice !== 'function') return null;
  const startedRevision = workspaceRevisions.get(id) ?? 0;
  try {
    const result = await target.workspaceVcsNotice({ workspaceId: id });
    // 请求期间有推送 / 本地清除 / 另一次兜底写入：本地状态更新，不被这次迟到的读覆盖。
    if ((workspaceRevisions.get(id) ?? 0) !== startedRevision) {
      return readWorkspaceVcsNoticeState(id)?.notice ?? null;
    }
    const notice = result?.notice ?? null;
    if (!notice) {
      // 仅当这段时间内没有任何更新时才清；否则会把刚到的处置入口抹掉（r4 P1）。
      clearWorkspaceVcsNoticeState(id);
      return null;
    }
    // 兜底读不知道「哪个入口」产生的；沿用已有 state 的 operation，缺省按 ensure（自动占用）。
    const existing = entries.get(id);
    setEntry(id, existing?.operation ?? 'ensure', notice);
    notifyListeners();
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
  // 订阅安装与工作区切换拆成两个 effect：切工作区不能让引用计数 1→0→1 抖动
  // （中间那一瞬会真的退订，期间的推送就丢了）。
  useEffect(() => ensureWorkspaceVcsNoticeBridge(), []);
  useEffect(() => {
    if (workspaceId && !entries.has(workspaceId)) void hydrateWorkspaceVcsNotice(workspaceId);
  }, [workspaceId]);
  return useMemo(
    () => all.find((entry) => entry.workspaceId === workspaceId) ?? null,
    [all, workspaceId],
  );
}

/**
 * 组件用：全部通知（按修改时间升序）。全局宿主的「最近一条横幅」用
 * `readLatestWorkspaceVcsNoticeState` 或数组最后一项；切换工作区时各页面按 `workspaceId`
 * 过滤自己的那一条（`workspaceId` 参数传入时只返回该工作区的列表）。
 */
export function useWorkspaceVcsNotices(
  workspaceId?: string | null,
): readonly WorkspaceVcsNoticeState[] {
  const all = useSyncExternalStore(
    subscribeWorkspaceVcsNotices,
    readWorkspaceVcsNoticeStates,
    readWorkspaceVcsNoticeStates,
  );
  useEffect(() => ensureWorkspaceVcsNoticeBridge(), []);
  return useMemo(
    () => (workspaceId ? all.filter((entry) => entry.workspaceId === workspaceId) : all),
    [all, workspaceId],
  );
}
