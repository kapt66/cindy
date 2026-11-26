/**
 * 远程工作区侧栏状态 hook（把 `remoteWorkspaceStatusStore` 接到 React）。
 *
 * 订阅纪律（对应 `features/cc-agent/sidebar/SessionItem.tsx` 文件头的性能不变量）：
 * 快照函数返回的是缓存里的对象引用 —— 工作区内容没变时 store 保留旧引用，
 * `useSyncExternalStore` 因此不会因为一次轮询而重渲染该行。
 */

import { useSyncExternalStore } from 'react';

import type { PsbRemoteWorkspace } from '../../../../shared/psb-remote-workspace';
import {
  getRemoteWorkspaceSnapshot,
  resolveRemoteWorkspaceForSession,
  subscribeRemoteWorkspaceList,
  type RemoteWorkspaceSidebarSessionLike,
  type RemoteWorkspaceSidebarSnapshot,
} from './remoteWorkspaceStatusStore';

/** 工作区表版本 + 最近刷新失败态（侧栏节点空态用）。 */
export function useRemoteWorkspaceListSnapshot(): RemoteWorkspaceSidebarSnapshot {
  return useSyncExternalStore(
    subscribeRemoteWorkspaceList,
    getRemoteWorkspaceSnapshot,
    getRemoteWorkspaceSnapshot,
  );
}

/** 会话所属工作区；解析不出来（未加载 / 无映射）时为 `null`。 */
export function useRemoteWorkspaceForSession(
  session: RemoteWorkspaceSidebarSessionLike | null | undefined,
): PsbRemoteWorkspace | null {
  return useSyncExternalStore(
    subscribeRemoteWorkspaceList,
    () => resolveRemoteWorkspaceForSession(session),
    () => resolveRemoteWorkspaceForSession(session),
  );
}
