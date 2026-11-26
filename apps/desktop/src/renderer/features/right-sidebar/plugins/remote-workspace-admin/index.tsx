/**
 * 远程工作区「远程工作区」页签 plugin。
 *
 * 形态：**全局页签**（不跟任务、不按会话分桶，见 `../../globalTabs.ts` 的
 * `REMOTE_WORKSPACE_ADMIN_TAB_KIND`）—— 同一时刻全局至多一个、切任务留在原位，
 * 因为页面描述的对象是**远程工作区**本身（当前打开任务的 psb 会话 → 最近使用的工作区），
 * 与任务是否结束无关（产品正本 `docs/product-rules/psb-remote-workspace-sessions.md` §2.4）。
 *
 * 两个入口，效果完全一样（都走 `openRemoteWorkspaceAdminTab`）：
 *   1. 远程工作区会话标题行「…」之后的「远程工作区」文字按钮；
 *   2. 右侧栏标签栏「+」的创建菜单项。
 * 关闭时不需要 `onBeforeClose`：全局页签的关闭不经过 `store.closeTab`，观看名额由页面
 * 卸载清理释放（见 `RemoteWorkspaceAdminConnection`）。
 */

import { MonitorCog } from 'lucide-react';
import type { TFunction } from 'i18next';

import { REMOTE_WORKSPACE_ADMIN_TAB_KIND } from '../../globalTabs';
import { RemoteWorkspaceAdminPanel } from '@/features/remote-workspace/admin/RemoteWorkspaceAdminPanel';
import type { RemoteWorkspaceAdminTabState } from '@/features/remote-workspace/admin/RemoteWorkspaceAdminPanel';
import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';

function RemoteWorkspaceAdminTabPillTitle({ t }: { state: unknown; t: TFunction }) {
  return <>{t('remoteWorkspace.admin.title')}</>;
}

function RemoteWorkspaceAdminTabPillIcon() {
  return <MonitorCog size={13} />;
}

const plugin: TabKindPlugin<RemoteWorkspaceAdminTabState> = {
  kind: REMOTE_WORKSPACE_ADMIN_TAB_KIND,
  menu: {
    kind: REMOTE_WORKSPACE_ADMIN_TAB_KIND,
    labelKey: 'remoteWorkspace.admin.title',
    icon: MonitorCog,
    order: 13,
    enabled: true,
    // 进「+」菜单：用户在任意任务里都能手动加这一页（没有远程工作区时进空态）。
    singleton: true,
  },
  TabPillTitle: RemoteWorkspaceAdminTabPillTitle,
  TabPillIcon: RemoteWorkspaceAdminTabPillIcon,
  TabBody: RemoteWorkspaceAdminPanel,
  // 页签状态恒为空：显示哪个工作区由主进程解析，不落盘。
  defaultState: () => ({}) as RemoteWorkspaceAdminTabState,
  hydrateState: () => ({}) as RemoteWorkspaceAdminTabState,
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
