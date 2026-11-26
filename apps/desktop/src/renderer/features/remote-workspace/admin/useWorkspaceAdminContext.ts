/**
 * 「远程工作区」页的数据源：**工作区级** `adminContext`，与当前任务的 Agent 状态无关。
 *
 * - 页面只读主进程解析好的工作区上下文（当前打开任务的 psb 会话，任何状态 → 最近使用的
 *   远程工作区 → 空）。不调 `sessionStatus`、不读当前任务的 PSB 会话状态：Agent 结束 /
 *   删除 / 切换都不影响本页。
 * - 刷新口径与仓库既有做法一致：**页签可见时**进入页面立即读一次；`onAdminContextChanged`
 *   推送时直接替换；窗口重新聚焦 / 页面可见时补读；页面可见时后台每 30s 一次（推送是第一条
 *   路径，轮询是兜底）。页签不可见（`enabled=false`）**不发**任何 IPC（旧实现只清了 interval，
 *   切回来时既不立即补读、挂载时也会先打一发）。
 * - 读取失败保留上一次上下文（一次网络抖动不把页面打回空态）；从未读到过才进入
 *   `failed`，让用户看到「读取失败」+ 重试，而不是一直「正在读取」。
 *
 * **stale 不是 failed / empty**（2026-11-26 真机事故）：main 在 PSB 读不到但有本机快照时会返回
 * `stale: true` 的上下文，这里照旧进入 `ready` —— 固定信息（名称 / 模板 / 机器）必须继续显示，
 * 由 `RemoteWorkspaceAdminPanel` 用降级说明条与「无法获取」表达状态未知。`empty` 只表示
 * main 明确返回 `context: null`（本机完全没有线索）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { PsbWorkspaceAdminContext } from '../../../../shared/psb-workspace-admin';
import {
  normalizeWorkspaceAdminContext,
  tryGetPsbWorkspaceAdminBridge,
  type PsbWorkspaceAdminBridge,
} from './psbWorkspaceAdminBridge';

/** 后台刷新间隔：占用 / 在线 / 桌面会话不是高频数据，与既有状态轮询同档。 */
export const WORKSPACE_ADMIN_CONTEXT_REFRESH_MS = 30_000;

/**
 * `loading` = 首次读取中；`ready` = 有工作区；`empty` = 主进程明确说没有可用工作区；
 * `failed` = 读过但失败且没有任何上下文；`unavailable` = preload 没有管理桥（旧版本）。
 */
export type WorkspaceAdminContextStatus = 'loading' | 'ready' | 'empty' | 'failed' | 'unavailable';

export interface WorkspaceAdminContextState {
  /** 当前工作区上下文；`status !== 'ready'` 时为 `null`。 */
  readonly context: PsbWorkspaceAdminContext | null;
  readonly status: WorkspaceAdminContextStatus;
  /**
   * 用户触发重读（失败态的重试按钮 / 动作成功后的刷新）。
   *
   * 返回 Promise：动作路径要等「事实刷新完」再解锁 busy、再弹成功 toast（r4 P2：
   * busy 在 `onChanged()` 后立即清空，刷新没回来用户就能重复点）。
   */
  readonly refresh: () => Promise<void>;
}

/**
 * @param input.localSessionId 当前打开任务的本地 id（空串 = 没有打开任务）。只作为主进程
 *   解析「优先跟随哪个任务」的提示；页面本身不拿它做任何门禁。
 * @param input.enabled 页签可见时才读取 / 轮询（全局页签被切走时 `active=false`）。
 */
export function useWorkspaceAdminContext(input: {
  readonly localSessionId: string;
  readonly enabled?: boolean;
}): WorkspaceAdminContextState {
  const localSessionId = input.localSessionId.trim();
  const enabled = input.enabled !== false;
  /** 推送过滤用的最新本地任务 id（委托/切任务后立即生效，不必等重订阅）。 */
  const localSessionIdRef = useRef(localSessionId);
  localSessionIdRef.current = localSessionId;
  const [context, setContext] = useState<PsbWorkspaceAdminContext | null>(null);
  const [status, setStatus] = useState<WorkspaceAdminContextStatus>('loading');
  const [refreshToken, setRefreshToken] = useState(0);
  const generation = useRef(0);
  const contextRef = useRef<PsbWorkspaceAdminContext | null>(null);
  contextRef.current = context;

  const load = useCallback((bridge: PsbWorkspaceAdminBridge | null): Promise<void> => {
    if (!bridge) {
      setStatus('unavailable');
      return Promise.resolve();
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return Promise.resolve();
    }
    const token = ++generation.current;
    return bridge
      .adminContext({ localSessionId })
      .then((next) => {
        if (token !== generation.current) return;
        const normalized = normalizeWorkspaceAdminContext(next);
        setContext(normalized);
        setStatus(normalized ? 'ready' : 'empty');
      })
      .catch(() => {
        if (token !== generation.current) return;
        // 有旧上下文就继续用（网络抖动不把页面打回空态）；否则给出可重试的失败态。
        setStatus(contextRef.current ? 'ready' : 'failed');
      });
  }, [localSessionId]);

  // 首次挂载（可见时）/ 页签重新可见 / 切换当前任务 / 用户点重试：立即重读一次，
  // 并让迟到的旧结果失效。页签不可见时不发 IPC。
  useEffect(() => {
    if (!enabled) return;
    const bridge = tryGetPsbWorkspaceAdminBridge();
    if (!bridge) {
      setStatus('unavailable');
      return;
    }
    generation.current += 1;
    void load(bridge);
  }, [enabled, load, refreshToken]);

  // 主进程推送：工作区变了（跟随当前任务 / 最近使用工作区 / 占用在线变化）直接替换。
  //
  // 这是**广播**（所有受信窗口都收到）：main 侧现在按 `localSessionId` 分桶推送（每个窗口只
  // 收到属于自己任务的事件），旧 main 仍可能广播全部。按载荷里的 `localSessionId` 再过滤一
  // 次：不匹配就丢弃，避免本页被另一个任务的工作区覆盖、进而把页头占用 / 观看端的写操作带到
  // 别人的工作区上。`null`（没有任务线索的兜底解析）与旧 main 不带该字段时都照旧接受。
  useEffect(() => {
    const bridge = tryGetPsbWorkspaceAdminBridge();
    if (!bridge) {
      setStatus('unavailable');
      return undefined;
    }
    return bridge.onAdminContextChanged((next) => {
      const eventSessionId = next.localSessionId ?? null;
      if (eventSessionId !== null && eventSessionId !== localSessionIdRef.current) return;
      const normalized = normalizeWorkspaceAdminContext(next);
      setContext(normalized);
      setStatus(normalized ? 'ready' : 'empty');
    });
  }, []);

  // 可见时补读 + 轮询：推送丢失 / 页面长时间停在同一工作区时的兜底发现路径。
  useEffect(() => {
    if (!enabled) return undefined;
    const bridge = tryGetPsbWorkspaceAdminBridge();
    if (!bridge) return undefined;
    const onFocus = () => void load(bridge);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void load(bridge);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const timer = window.setInterval(() => void load(bridge), WORKSPACE_ADMIN_CONTEXT_REFRESH_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(timer);
    };
  }, [enabled, load]);

  /** 显式重读（失败重试 / 动作成功后的刷新）；返回「这次刷新完成」的 Promise。 */
  const refresh = useCallback(async (): Promise<void> => {
    const bridge = tryGetPsbWorkspaceAdminBridge();
    if (!bridge) {
      setStatus('unavailable');
      return;
    }
    generation.current += 1;
    await load(bridge);
  }, [load]);

  return { context, status, refresh };
}
