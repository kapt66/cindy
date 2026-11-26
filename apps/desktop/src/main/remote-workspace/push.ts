/**
 * PSB 远程工作区的两个推送事件（main → renderer）。
 *
 * ## 为什么单独一个文件
 *
 * 服务装配（`index.ts`）与 IPC handler（`ipc.ts`）都要发推送；把广播放这里，两处都依赖它，
 * 而不是让服务反过来依赖 IPC 模块（那会形成 `ipc → index → ipc` 的循环）。
 *
 * ## 出站推送也是授权边界
 *
 * `trustedAppRenderer.ts` 的文件头明确：拿 `BrowserWindow.getAllWindows()` 无条件广播，等于把载荷
 * 发给所有窗口，包括已经导航到别处的那些。串流帧是用户屏幕内容、工作区行是远端机器与占用人信息，
 * 因此这里只发给**仍加载 Cindy 自有 renderer 的受信窗口**（与入站 IPC 同一判据）。
 */

import { BrowserWindow } from 'electron';

import {
  PSB_REMOTE_CHANNELS,
  type PsbSessionsReboundEvent,
  type PsbStreamEvent,
  type PsbWorkspaceChangedEvent,
} from '../../shared/psb-remote-workspace.js';
import {
  PSB_ADMIN_CHANNELS,
  type PsbWorkspaceAdminContextChangedEvent,
} from '../../shared/psb-workspace-admin.js';
import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';

function broadcastToTrustedWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!isTrustedAppRendererWindow(win)) continue;
    win.webContents.send(channel, payload);
  }
}

/** 串流事件（帧 / 状态 / 光标 / 关闭 / 错误）。载荷只在这里出 main，渲染层按 `sessionId` 过滤。 */
export function broadcastPsbStreamEvent(event: PsbStreamEvent): void {
  broadcastToTrustedWindows(PSB_REMOTE_CHANNELS.STREAM_EVENT, event);
}

/** 某个工作区的占用 / 在线 / 会话数快照变了（多窗口同步，例如设置窗口与主窗都开着列表）。 */
export function broadcastPsbWorkspaceChanged(event: PsbWorkspaceChangedEvent): void {
  broadcastToTrustedWindows(PSB_REMOTE_CHANNELS.WORKSPACE_CHANGED, event);
}

/**
 * 某个本地任务在发送时透明重建了 PSB 会话（`remoteHostId` 已落库）。
 *
 * 载荷只有 id 与前后身份，没有工作区快照（工作区没变）。渲染层收到后刷新该任务的
 * 远程派生数据即可；事件里的 `remoteHostId` 已是持久化真值，不依赖
 * `sessions:patched` 的到达顺序。
 */
export function broadcastPsbSessionsRebound(event: PsbSessionsReboundEvent): void {
  broadcastToTrustedWindows(PSB_REMOTE_CHANNELS.SESSIONS_REBOUND, event);
}

/**
 * 「远程工作区」管理页：当前工作区上下文变了（工作区 / 占用 / 桌面会话状态 / 内部观看端会话）。
 *
 * 载荷与 `adminContext` 的 invoke 结果同形，外加 `localSessionId`（这次解析用的本地任务 id）。
 * 这是**广播**：多窗口各自打开不同任务时，渲染层按 `localSessionId` 过滤，不匹配就丢弃
 * （见 `shared/psb-workspace-admin.ts` 的 `PsbWorkspaceAdminContextChangedEvent`）。
 * 只在 main「刚拿到新事实」时发（值没变不发），main 不轮询 PSB —— 与 `WORKSPACE_CHANGED`
 * 同一条取舍。
 */
export function broadcastPsbAdminContextChanged(
  event: PsbWorkspaceAdminContextChangedEvent,
): void {
  broadcastToTrustedWindows(PSB_ADMIN_CHANNELS.CONTEXT_CHANGED, event);
}

/**
 * 「远程工作区」管理页：**内部观看端会话**的串流事件（帧 / 状态 / 光标 / 关闭 / 错误）。
 *
 * 只转发内部会话的事件（用户任务会话的串流走 `PSB_REMOTE_CHANNELS.STREAM_EVENT`）；
 * 载荷里的 `sessionId` 就是上下文里的 `viewerSessionId`，渲染层按它过滤。
 */
export function broadcastPsbAdminStreamEvent(event: PsbStreamEvent): void {
  broadcastToTrustedWindows(PSB_ADMIN_CHANNELS.STREAM_EVENT, event);
}
