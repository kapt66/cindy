/**
 * 「远程工作区」页签的程序化入口（打开 / 聚焦）。
 *
 * 这个页签是**全局页签**（`features/right-sidebar/globalTabs.ts`，与插件页签同一份存储）：
 *   - 不跟任务分桶、切任务留在原位 —— 它的内容由主进程解析的**工作区**决定（当前任务的 psb
 *     会话任何状态 → 本机最近使用的工作区），与打开它的那个任务是否结束无关（产品正本
 *     `docs/product-rules/psb-remote-workspace-sessions.md` §2.4）；
 *   - 全局至多一个，固定 id，重复点击只切换激活位。
 *
 * ## 落在哪个容器（用户口径：跟插件窗口同一排标签）
 *
 * 「远程工作区」不是右侧栏那种可折叠的 dock，而是**页签组**（`tabGroups.ts`）里的一页。
 * 插件窗口（已装插件的停靠面板 / 主视图）默认落在哪个组，本页签就跟着落哪个组：
 *   - 有全局插件页签时，取第一个插件页签所在的组；
 *   - 没有插件页签时，取停靠面板插件的缺省边 `left`（`globalTabs.defaultGroupForGhost`：
 *     未声明 `panel.position` 的停靠面板默认停左侧，也就是用户看到的「插件窗口区」）。
 * 该组在布局树里的 pane 由 `tabGroupPanes` 按「组里有可见页签」自动插入（`ensurePaneInTree`），
 * 所以**不需要**打开右侧 dock；只有落到右侧组（`right`，即原来的可折叠右侧栏）时才请求展开它。
 *
 * 由于页签存放在 renderer 自有的 localStorage（不经 SQLite），这里**不需要** `ensureHydrated`，
 * 也不需要分离窗口的命令通道：`storage` 事件会让弹出的侧栏窗口自己看到这个页签。
 */

import {
  REMOTE_WORKSPACE_ADMIN_TAB_ID,
  addRemoteWorkspaceAdminTab,
  findRemoteWorkspaceAdminTab,
  preferredRemoteWorkspaceAdminGroup,
  setActiveGlobalTabId,
} from '@/features/right-sidebar/globalTabs';
import { requestRightSidebarVisibility } from '@/features/right-sidebar/lib/sidebarCommands';
import {
  getTabGroup,
  getTabGroupAssignments,
  setTabGroup,
} from '@/features/right-sidebar/tabGroups';

export interface OpenRemoteWorkspaceAdminTabInput {
  /**
   * 本次请求发生在哪个会话里（当前打开的会话 id）。
   *
   * 只在页签落到右侧组（可折叠的右侧栏）时用于 `requestRightSidebarVisibility`：
   * MainLayout 据此区分「当前会话的请求」和「别的会话的请求」。缺省 / null = 当前会话。
   */
  readonly sessionId?: string | null;
  /** 是不是用户当次手势直接要求的；缺省 true（「+」菜单与标题栏按钮都是）。 */
  readonly userInitiated?: boolean;
}

/**
 * 打开（或聚焦）「远程工作区」页签。
 *
 * - 已有这一页（不论它在哪个组）→ 只聚焦，不把它搬回默认组（用户拖走的放置记忆优先）；
 * - 还没有 → 与插件窗口同一组新建，并设为当前全局激活页签（组内高亮跟着走）；
 * - 只打开页面，**不**开始串流：启动 / 停止是页面里的显式动作。
 */
export function openRemoteWorkspaceAdminTab(
  input: OpenRemoteWorkspaceAdminTabInput = {},
): void {
  const existing = findRemoteWorkspaceAdminTab();
  if (existing) {
    // 没被用户显式放过组的（`tabGroups` 里没有条目 = 仍是缺省右侧组）当「还没放置」处理：
    // 挪到插件窗口那排。这样旧中间态按右侧 dock 打开的页签，下一次点击就回到插件标签栏；
    // 用户自己拖到某一边之后有条目，尊重他的放置，不再移动。
    const explicitGroup = getTabGroupAssignments()[existing.id];
    const preferred = preferredRemoteWorkspaceAdminGroup();
    if (explicitGroup === undefined && preferred !== 'right') {
      setTabGroup(existing.id, preferred);
    }
  }
  const targetGroup = existing
    ? getTabGroup(existing.id)
    : preferredRemoteWorkspaceAdminGroup();
  addRemoteWorkspaceAdminTab(existing ? undefined : { groupId: targetGroup });
  setActiveGlobalTabId(REMOTE_WORKSPACE_ADMIN_TAB_ID);
  // 右侧组是唯一「可折叠的 dock」：落到那里才需要显式展开；边组（左 / 上 / 下）的 pane
  // 由页签在场自动出现（`tabGroupPanes`），不要因为本页签去弹右侧栏。
  if (targetGroup !== 'right') return;
  requestRightSidebarVisibility('open', {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    userInitiated: input.userInitiated !== false,
  });
}
