/**
 * 「远程工作区」页使用的**工作区级** PSB 管理桥（窄入口）。
 *
 * 契约与 IPC 面已由主进程批次落地，正本：
 *   - 形状 / 通道：`apps/desktop/src/shared/psb-workspace-admin.ts`
 *   - preload 桥签名：`features/remote-workspace/bridge.ts` 的 `PsbRemoteBridge`（本文件不重复定义）
 *
 * 本文件只做三件渲染层的事：
 *   1. 从 `tryGetPsbRemoteBridge()` 里挑出管理页要用的方法子集；
 *   2. 旧 preload / 单测环境缺方法时返回 `null`，让页面降级成「此版本暂不支持远程工作区」
 *      的提示态（保留顶部信息行与分类导航），而不是崩或静默失败；
 *   3. 把契约里的结果包装（`{ context }` / `{ status }` / `{ status, viewerSessionId }`）
 *      归一成组件直接消费的形状 —— 包装层是唯一可能变的地方，归一化收在这里，组件不感知。
 *      注意 `viewerSessionId` 是**观看端绑定会话** id：正常是 PSB 桌面访问会话 id，不是 agent
 *      会话 id；旧 PSB 的过渡回退才有内部 agent 会话。字段名保持不变（渲染层只做等值过滤）。
 */

import { tryGetPsbRemoteBridge } from '../bridge';
import type {
  PsbOccupyWorkspaceResult,
  PsbStreamEvent,
  PsbWorkspaceRefRequest,
} from '../../../../shared/psb-remote-workspace';
import type {
  PsbWorkspaceAdminContext,
  PsbWorkspaceAdminContextChangedEvent,
  PsbWorkspaceAdminContextResult,
  PsbWorkspaceAdminStreamStartResult,
  PsbWorkspaceAdminStreamStatus,
  PsbWorkspaceAdminStreamStatusResult,
} from '../../../../shared/psb-workspace-admin';
import {
  psbAdminContextAvailability,
  psbAdminContextIsStale,
} from '../../../../shared/psb-workspace-admin';

/** 页面真正消费的管理桥方法子集（来自正式 `PsbRemoteBridge`）。 */
export interface PsbWorkspaceAdminBridge {
  adminContext(input: { localSessionId: string }): Promise<PsbWorkspaceAdminContextResult>;
  onAdminContextChanged(
    handler: (event: PsbWorkspaceAdminContextChangedEvent) => void,
  ): () => void;
  adminStreamStart(input: { workspaceId: string }): Promise<PsbWorkspaceAdminStreamStartResult>;
  adminStreamStop(input: { workspaceId: string }): Promise<void>;
  adminStreamStatus(input: { workspaceId: string }): Promise<PsbWorkspaceAdminStreamStatusResult>;
  onAdminStreamEvent(handler: (event: PsbStreamEvent) => void): () => void;
  /** 页头的通用工作区操作（占用 / 解除占用 / 在网页打开）。 */
  occupyWorkspace(input: PsbWorkspaceRefRequest): Promise<PsbOccupyWorkspaceResult>;
  releaseWorkspace(input: PsbWorkspaceRefRequest): Promise<PsbOccupyWorkspaceResult>;
  openWebWorkspace(input: { workspaceId: string }): Promise<void>;
}

/** 归一化后的串流状态；`null` = 此刻读不到（不等于 `capable:false`）。 */
export type WorkspaceAdminStreamStatus = PsbWorkspaceAdminStreamStatus;

/** 归一化后的启动结果：状态 + 观看端绑定会话 id（用于过滤串流事件）。 */
export interface WorkspaceAdminStreamStart {
  readonly status: PsbWorkspaceAdminStreamStatus;
  readonly viewerSessionId: string | null;
}

/**
 * 取工作区级管理桥；方法不全（旧 preload / 单测环境）返回 `null`。
 *
 * 逐个检查方法而不是只看对象存在：契约是加性落地的，旧 preload 可能已经有 `psbRemote`
 * （会话级串流那套）但还没有管理面。
 */
export function tryGetPsbWorkspaceAdminBridge(): PsbWorkspaceAdminBridge | null {
  const bridge = tryGetPsbRemoteBridge();
  if (!bridge) return null;
  const candidate = bridge as unknown as Record<string, unknown>;
  const required = [
    'adminContext',
    'onAdminContextChanged',
    'adminStreamStart',
    'adminStreamStop',
    'adminStreamStatus',
    'onAdminStreamEvent',
    // 页头通用操作：缺这些方法时整页降级成「此版本暂不支持」，不渲染一组点了没反应的按钮。
    'occupyWorkspace',
    'releaseWorkspace',
    'openWebWorkspace',
  ] as const;
  for (const method of required) {
    if (typeof candidate[method] !== 'function') return null;
  }
  return bridge as unknown as PsbWorkspaceAdminBridge;
}

/**
 * `CONTEXT` invoke 结果 / `CONTEXT_CHANGED` 载荷 → 上下文（`null` = 没有可用工作区）。
 *
 * 两种载荷同形（都是 `{ context }`），这里统一解包并做最小运行时校验：缺 `workspaceId`
 * 的载荷按「没有工作区」处理，不把坏数据渲染成半张工作区卡片。
 *
 * 归一化同时给 `stale` / `availability` 补齐旧 main 缺省的语义（加性字段）：
 * `stale: true` 或 `availability !== 'live'` 都按降级上下文处理；旧 main 的载荷没有这两个
 * 字段时视为 live。**不要**因为 stale 把上下文丢掉 —— 固定信息（名称 / 模板 / 机器）正是
 * 要在读不到服务器时继续显示的（2026-11-26 真机事故）。
 */
export function normalizeWorkspaceAdminContext(
  value: PsbWorkspaceAdminContextResult | PsbWorkspaceAdminContextChangedEvent | null | undefined,
): PsbWorkspaceAdminContext | null {
  const context = value?.context ?? null;
  if (!context || typeof context.workspaceId !== 'string' || !context.workspaceId.trim()) {
    return null;
  }
  const availability = psbAdminContextAvailability(context);
  const stale = psbAdminContextIsStale(context);
  return {
    ...context,
    stale,
    availability,
    staleReason: context.staleReason ?? null,
    snapshotSavedAt: context.snapshotSavedAt ?? null,
    workspaceIdKnown: context.workspaceIdKnown !== false,
  };
}

/**
 * `STREAM_STATUS` 结果 → 状态。
 *
 * `null` 表示**此刻读不到 PSB 状态**，调用方保留自己的最后一份快照，不把它当
 * `capable:false`（那会让「启动」永远不可用）。
 */
export function normalizeWorkspaceAdminStreamStatus(
  value: PsbWorkspaceAdminStreamStatusResult | null | undefined,
): PsbWorkspaceAdminStreamStatus | null {
  return value?.status ?? null;
}

/** `STREAM_START` 结果 → 状态 + 观看端会话 id；形状不认识时返回 `null`。 */
export function normalizeWorkspaceAdminStreamStart(
  value: PsbWorkspaceAdminStreamStartResult | null | undefined,
): WorkspaceAdminStreamStart | null {
  if (!value || !value.status || typeof value.status.capable !== 'boolean') return null;
  return {
    status: value.status,
    viewerSessionId:
      typeof value.viewerSessionId === 'string' && value.viewerSessionId
        ? value.viewerSessionId
        : null,
  };
}
