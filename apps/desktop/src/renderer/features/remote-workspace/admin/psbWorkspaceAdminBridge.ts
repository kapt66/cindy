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

import { psbBridgeHasMethod, tryGetPsbRemoteBridge } from '../bridge';
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
  readPsbAdminStreamStatus,
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

/** 归一化后的串流状态；`null` = 此刻读不到（不等于 `capability:false`）。 */
export type WorkspaceAdminStreamStatus = PsbWorkspaceAdminStreamStatus;

/** 归一化后的启动结果：状态 + 观看端绑定会话 id（用于过滤串流事件）。 */
export interface WorkspaceAdminStreamStart {
  readonly status: PsbWorkspaceAdminStreamStatus;
  readonly viewerSessionId: string | null;
}

/**
 * 底层 preload 桥 → 管理桥子集的缓存（**引用稳定性**）。
 *
 * 为什么要缓存：组件每次渲染都会调 `tryGetPsbWorkspaceAdminBridge()` 取桥，再把它交给
 * hook / effect 当依赖（`useWorkspaceAdminContext`、`useAdminStreamSession` 的事件订阅与
 * 播放器 effect 都按 `bridge` 判等）。旧实现每次返回**新的对象字面量**，等于依赖每渲染都变
 * → effect 反复重挂；`useWorkspaceAdminContext` 的「读上下文 → setState」因此变成无限循环
 * （2026-11-27 集成时 `RemoteWorkspaceAdminPanel.test.tsx` 每条用例挂到超时）。
 *
 * 底层 preload 桥本身是单例（`window.electronAPI.psbRemote`），所以按它缓存即可：同一个底层桥
 * 永远拿到同一个 wrapper，方法集合的探测只在首次发生。
 */
const adminBridgeCache = new WeakMap<object, PsbWorkspaceAdminBridge>();

/**
 * 取工作区级管理桥；方法不全（旧 preload / 单测环境）返回 `null`。
 *
 * 逐个检查方法而不是只看对象存在：契约是加性落地的，旧 preload 可能已经有 `psbRemote`
 * （会话级串流那套）但还没有管理面。方法探测统一走 `psbBridgeHasMethod`（单点断言、
 * 方法名受编译期约束）。
 *
 * **返回对象的引用是稳定的**（见 `adminBridgeCache`）：调用点可以放心把它放进 effect 依赖。
 * 方法用箭头函数转发而不是直接引用：包装层不依赖 `this`，底层桥换实现也不会因为丢失绑定而坏。
 */
export function tryGetPsbWorkspaceAdminBridge(): PsbWorkspaceAdminBridge | null {
  const bridge = tryGetPsbRemoteBridge();
  if (!bridge) return null;
  const cached = adminBridgeCache.get(bridge);
  if (cached) return cached;
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
    if (!psbBridgeHasMethod(bridge, method)) return null;
  }
  // 逐个显式挑选而不是 `as unknown as` 双重断言：方法集合在编译期与 `PsbRemoteBridge` 绑定，
  // 少写一项 / 改了签名都会直接 typecheck 失败；探测已保证这些方法在运行期存在。
  const wrapper: PsbWorkspaceAdminBridge = {
    adminContext: (input) => bridge.adminContext(input),
    onAdminContextChanged: (handler) => bridge.onAdminContextChanged(handler),
    adminStreamStart: (input) => bridge.adminStreamStart(input),
    adminStreamStop: (input) => bridge.adminStreamStop(input),
    adminStreamStatus: (input) => bridge.adminStreamStatus(input),
    onAdminStreamEvent: (handler) => bridge.onAdminStreamEvent(handler),
    occupyWorkspace: (input) => bridge.occupyWorkspace(input),
    releaseWorkspace: (input) => bridge.releaseWorkspace(input),
    openWebWorkspace: (input) => bridge.openWebWorkspace(input),
  };
  adminBridgeCache.set(bridge, wrapper);
  return wrapper;
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
 * `capability:false`（那会让「启动」永远不可用）。形状校验统一走共享的
 * `readPsbAdminStreamStatus`（与 `STREAM_START` 同一条读口）。
 */
export function normalizeWorkspaceAdminStreamStatus(
  value: PsbWorkspaceAdminStreamStatusResult | null | undefined,
): PsbWorkspaceAdminStreamStatus | null {
  if (!value) return null;
  return readPsbAdminStreamStatus(value.status);
}

/** `STREAM_START` 结果 → 状态 + 观看端会话 id；形状不认识时返回 `null`。 */
export function normalizeWorkspaceAdminStreamStart(
  value: PsbWorkspaceAdminStreamStartResult | null | undefined,
): WorkspaceAdminStreamStart | null {
  if (!value) return null;
  const status = readPsbAdminStreamStatus(value.status);
  if (!status) return null;
  return {
    status,
    viewerSessionId:
      typeof value.viewerSessionId === 'string' && value.viewerSessionId
        ? value.viewerSessionId
        : null,
  };
}
