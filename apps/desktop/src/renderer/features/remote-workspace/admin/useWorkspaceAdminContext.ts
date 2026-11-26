/**
 * 「远程工作区」页的数据源：**工作区级** `adminContext`，与当前任务的 Agent 状态无关。
 *
 * - 页面只读主进程解析好的工作区上下文（当前打开任务的 psb 会话，任何状态 → 最近使用的
 *   远程工作区 → 空）。不调 `sessionStatus`、不读当前任务的 PSB 会话状态：Agent 结束 /
 *   删除 / 切换都不影响本页。
 * - 刷新口径与仓库既有做法一致：进入页面读一次；`onAdminContextChanged` 推送时直接替换；
 *   窗口重新聚焦 / 页面可见时补读；页面可见时后台每 30s 一次（推送是第一条路径，轮询是
 *   兜底）。页面不可见时不发请求。
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
  /** 用户触发重读（失败态的重试按钮）。 */
  readonly refresh: () => void;
}

/**
 * @param input.localSessionId 当前打开任务的本地 id（空串 = 没有打开任务）。只作为主进程
 *   解析「优先跟随哪个任务」的提示；页面本身不拿它做任何门禁。
 * @param input.enabled 页签可见时才轮询（全局页签被切走时 `active=false`）。
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

  const load = useCallback((bridge: PsbWorkspaceAdminBridge | null) => {
    if (!bridge) {
      setStatus('unavailable');
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const token = ++generation.current;
    void bridge
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

  // 首次挂载 / 切换当前任务 / 用户点重试：重读一次，并让迟到的旧结果失效。
  useEffect(() => {
    const bridge = tryGetPsbWorkspaceAdminBridge();
    if (!bridge) {
      setStatus('unavailable');
      return;
    }
    generation.current += 1;
    load(bridge);
  }, [load, refreshToken]);

  // 主进程推送：工作区变了（跟随当前任务 / 最近使用工作区 / 占用在线变化）直接替换。
  //
  // 这是**广播**（所有受信窗口都收到）：main 只有一份「最近一次读取用的本地任务 id」，
  // 其它窗口（主窗 / 独立页签窗口 / 设置窗）发起的读取会让后续推送属于它的任务。所以按
  // 载荷里的 `localSessionId` 过滤：不匹配就丢弃，避免本页被另一个任务的工作区覆盖、
  // 进而把页头占用 / 观看端的写操作带到别人的工作区上。`null`（没有任务线索的兜底解析）
  // 与旧 main 不带该字段时都照旧接受。
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
    const onFocus = () => load(bridge);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') load(bridge);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const timer = window.setInterval(() => load(bridge), WORKSPACE_ADMIN_CONTEXT_REFRESH_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(timer);
    };
  }, [enabled, load]);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  return { context, status, refresh };
}
