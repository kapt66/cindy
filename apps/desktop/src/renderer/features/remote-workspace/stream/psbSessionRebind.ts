/**
 * PSB 远程会话「发送时透明重建」的渲染层状态源。
 *
 * ## 为什么需要它
 *
 * 远程工作区任务的 PSB 会话进入终态（`stopped` / `failed`）后，主进程**不再锁死任务**：
 * 用户下一条消息发出时，主进程在同一工作区新建一个 PSB 会话并把本地任务重绑过去，然后推送
 * `psbRemote.sessionsRebound`（契约见 `shared/psb-remote-workspace.ts`）。于是同一个本地任务
 * id 的远端身份变成一个新值，而本地会话行 / 侧栏缓存的 `remoteHostId` 可能还没刷新。
 *
 * 渲染层不能靠「等会话行 patch 到达」来决定用哪个远端身份（patch 可能晚到、也可能这条路径
 * 根本不广播），否则输入判据、「远程工作区」页与串流面板会继续指向已经结束的旧会话，表现为
 * 「任务结束了」这类死路。所以在渲染层留一份**按本地会话 id 索引的重绑覆盖**：
 *
 *   - 有效 `remoteHostId` = 重绑事件里的新身份（覆盖） ?? 会话行上的原值；
 *   - 同一条重绑还带一条**可关掉的轻提示**（`noticeDismissed`），告诉用户远程会话换新了、
 *     本轮上下文可能不延续 —— 这必须是淡提示而不是警告条，也不改变「任务还在」的事实。
 *
 * ## 边界
 *
 * - 只接受形如 `psb:<id>` 的新身份（畸形 payload 直接丢弃，不让脏值派生到路由/文件操作上）；
 * - 覆盖只在会话行上的身份仍等于「重绑前」或「重绑后」时生效：会话绑定若被别的路径改成
 *   第三个值，以会话行为准，不把旧覆盖扣上去；
 * - 推送订阅在组件侧按需建立（`usePsbSessionRebind`），没有 preload 桥时静默降级
 *   （旧 preload / 单测 / 非主窗口），与 `bridge.ts` 的既有口径一致。
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import {
  parsePsbRemoteHostId,
  type PsbSessionsReboundEvent,
} from '../../../../shared/psb-remote-workspace';
import { tryGetPsbRemoteBridge } from '../bridge';

/** 一次重绑：本地任务不变，PSB 侧换了新会话。 */
export interface PsbSessionRebind {
  readonly localSessionId: string;
  /** 重绑前的远端身份（`psb:<旧会话 id>`，事件原值，仅用于判断覆盖是否仍然适用）。 */
  readonly previousRemoteHostId: string;
  /** 重绑后的远端身份（`psb:<新会话 id>`，主进程已落库）。 */
  readonly remoteHostId: string;
  /** 用户是否已经关掉这条轻提示（同一个新身份被重复推送时不重置）。 */
  readonly noticeDismissed: boolean;
}

let rebinds: ReadonlyMap<string, PsbSessionRebind> = new Map();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ReadonlyMap<string, PsbSessionRebind> {
  return rebinds;
}

/**
 * 主进程推送 → 覆盖表。参数是 preload 透传的 payload。
 *
 * 畸形 payload（缺本地会话 id / 新身份不是 `psb:`）直接忽略：这类值一旦写进覆盖表，会让
 * 输入判据与串流面板去访问一个不存在的会话，比「停在旧状态」更难排查。
 */
export function applyPsbSessionsRebound(event: PsbSessionsReboundEvent): void {
  const localSessionId = event.localSessionId?.trim() ?? '';
  const remoteHostId = event.remoteHostId?.trim() ?? '';
  if (!localSessionId || parsePsbRemoteHostId(remoteHostId) === null) return;
  const previous = rebinds.get(localSessionId);
  // 同一条重绑被重复推送（重连、窗口恢复）：保留用户已经关掉提示的状态。
  const noticeDismissed =
    previous && previous.remoteHostId === remoteHostId ? previous.noticeDismissed : false;
  if (
    previous &&
    previous.remoteHostId === remoteHostId &&
    previous.previousRemoteHostId === (event.previousRemoteHostId?.trim() ?? '') &&
    previous.noticeDismissed === noticeDismissed
  ) {
    return;
  }
  const next = new Map(rebinds);
  next.set(localSessionId, {
    localSessionId,
    previousRemoteHostId: event.previousRemoteHostId?.trim() ?? '',
    remoteHostId,
    noticeDismissed,
  });
  rebinds = next;
  emit();
}

/** 关掉某条重绑的轻提示（提示是「一次性通知」，不值得长期占位）。 */
export function dismissPsbSessionRebindNotice(localSessionId: string): void {
  const current = rebinds.get(localSessionId);
  if (!current || current.noticeDismissed) return;
  const next = new Map(rebinds);
  next.set(localSessionId, { ...current, noticeDismissed: true });
  rebinds = next;
  emit();
}

/**
 * 该本地会话当前应使用的远端身份 + 轻提示状态。
 *
 * 覆盖只在「会话行上的身份仍是重绑前 / 重绑后」时生效；会话行的值若被别的路径改成第三个值，
 * 以会话行为准。`remoteHostId` 入参为 `null` / 非 `psb:` 时不产生覆盖。
 */
export interface PsbSessionRebindState {
  /** 有效远端身份：重绑后的新值优先，否则原样返回入参。 */
  readonly remoteHostId: string | null;
  /** 最近一次重绑（没有则 `null`）。 */
  readonly rebind: PsbSessionRebind | null;
  /** 是否要显示那条轻提示（重绑发生且用户还没关掉）。 */
  readonly noticeVisible: boolean;
  readonly dismissNotice: () => void;
}

function resolveRemoteHostId(
  rebind: PsbSessionRebind | null,
  remoteHostId: string | null | undefined,
): { readonly remoteHostId: string | null; readonly applies: boolean } {
  const current = remoteHostId?.trim() || null;
  if (!rebind || current === null) return { remoteHostId: current, applies: false };
  const applies =
    current === rebind.previousRemoteHostId || current === rebind.remoteHostId;
  return { remoteHostId: applies ? rebind.remoteHostId : current, applies };
}

export function usePsbSessionRebind(
  localSessionId: string | null | undefined,
  remoteHostId: string | null | undefined,
): PsbSessionRebindState {
  const store = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // 推送订阅按需建立：这个 hook 只在远程工作区任务页 / 「远程工作区」页出现时挂载。
  // 没有桥（旧 preload / 单测 / 非主窗口）就不订阅，保持「未知」而不是崩。
  useEffect(() => {
    const bridge = tryGetPsbRemoteBridge();
    const subscribeRebound = bridge?.onSessionsRebound;
    if (typeof subscribeRebound !== 'function') return undefined;
    return subscribeRebound(applyPsbSessionsRebound);
  }, []);

  const localId = localSessionId?.trim() || null;
  const rebind = localId ? store.get(localId) ?? null : null;
  const resolved = resolveRemoteHostId(rebind, remoteHostId);
  const dismissNotice = useCallback(() => {
    if (localId) dismissPsbSessionRebindNotice(localId);
  }, [localId]);

  return {
    remoteHostId: resolved.remoteHostId,
    rebind,
    // 覆盖已经被别的路径取代（会话行身份是第三个值）时不再显示这条提示：
    // 提示说的是「你现在连的是新会话」，而那时已经不是。
    noticeVisible: resolved.applies && rebind !== null && !rebind.noticeDismissed,
    dismissNotice,
  };
}
