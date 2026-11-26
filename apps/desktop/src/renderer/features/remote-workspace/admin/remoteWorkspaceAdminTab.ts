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
 *   - 调用的界面能给出显式落点时（「+」菜单 / 空面板的那排标签栏）用它 —— 在插件窗口那排
 *     点「+」，新页就落在同一排；这是唯一能让「点 + 的那排」与常量默认边分开的输入；
 *   - 否则有全局插件页签时，取第一个插件页签所在的组；
 *   - 都没有时，取停靠面板插件的缺省边 `left`（`globalTabs.defaultGroupForGhost`：
 *     未声明 `panel.position` 的停靠面板默认停左侧，也就是用户看到的「插件窗口区」）。
 * 该组在布局树里的 pane 由 `tabGroupPanes` 按「组里有可见页签」自动插入（`ensurePaneInTree`），
 * 所以**只在最终落到右侧组**（`right`，即原来的可折叠右侧栏）时才请求展开它。
 *
 * **组只写一次**：落点先收敛成 `targetGroup`，`addRemoteWorkspaceAdminTab({ groupId })` 是唯一
 * 写组的地方（新页签先落组再持久化，已有页签按同一入口挪组）；之后的 dock 展开判定也用这个
 * 最终组。调用方**不得**在返回后再 `setTabGroup` 覆盖 —— 那样 dock 判定会按旧组执行，
 * 用户会在「左排点 +」时看到右侧 dock 被无谓展开。
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
import { getTabGroupAssignments } from '@/features/right-sidebar/tabGroups';
import type { TabGroupId } from '@/features/right-sidebar/tabGroups';

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
  /**
   * 用户点「+」/ 空面板快捷入口的那排标签栏所在组（显式落点）。
   *
   * 缺省 = 跟随插件窗口那排（`preferredRemoteWorkspaceAdminGroup()`）。传了值就是「用户在这排
   * 点的，页就放在这排」，包括把已经打开的页签挪过来（放置记忆让位给当次显式手势）。
   */
  readonly targetGroup?: TabGroupId;
}

/**
 * 打开（或聚焦）「远程工作区」页签。
 *
 * - 已有这一页（不论它在哪个组）且有显式落点 → 挪到显式组；没有显式落点时只聚焦，不把它搬回
 *   默认组（用户拖走的放置记忆优先）；
 * - 还没有 → 在最终组新建，并设为当前全局激活页签（组内高亮跟着走）；
 * - 只打开页面，**不**开始串流：启动 / 停止是页面里的显式动作。
 */
export function openRemoteWorkspaceAdminTab(input: OpenRemoteWorkspaceAdminTabInput = {}): void {
  const existing = findRemoteWorkspaceAdminTab();
  const preferred = preferredRemoteWorkspaceAdminGroup();
  // 最终组在**打开之前**收敛：唯一一次写组发生在 `addRemoteWorkspaceAdminTab` 里，
  // 下面的 dock 判定也只看这个值（不允许调用方事后再改组）。
  const targetGroup: TabGroupId =
    input.targetGroup ??
    // 没有显式落点：已有页签的显式放置优先，其次是插件窗口那排（旧中间态按右侧 dock 打开的
    // 页签因此会在下一次点击时回到插件标签栏）。
    (existing ? (getTabGroupAssignments()[existing.id] ?? preferred) : preferred);
  // 新页签先落组再持久化（首帧就在目标组）；已有页签同一入口按需挪组，组写入只有这一处。
  addRemoteWorkspaceAdminTab({ groupId: targetGroup });
  setActiveGlobalTabId(REMOTE_WORKSPACE_ADMIN_TAB_ID);
  // 右侧组是唯一「可折叠的 dock」：落到那里才需要显式展开；边组（左 / 上 / 下）的 pane
  // 由页签在场自动出现（`tabGroupPanes`），不要因为本页签去弹右侧栏。
  if (targetGroup !== 'right') return;
  requestRightSidebarVisibility('open', {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    userInitiated: input.userInitiated !== false,
  });
}
