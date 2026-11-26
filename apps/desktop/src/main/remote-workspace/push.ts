/**
 * PSB 远程工作区的推送事件（main → renderer）。
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
 *
 * ## 串流帧只定向给「正在看这条串流」的窗口
 *
 * 串流帧/光标是**高带宽、且属于某一条观看**的数据：多窗口时只有启动该观看的那个窗口需要它
 * （另一个窗口可能在看别的工作区，广播只会白占 IPC 与解码预算，也会让两个窗口各自解码同一路
 * 画面）。所以帧与光标按 `sessionId` 定向投递给 owner（登记见
 * {@link registerPsbAdminStreamOwner}，计数语义见 `streamOwners.ts`）；状态/关闭/错误与工作区
 * 上下文变化是**低带宽、多窗口都要知道**的事实，继续广播。
 *
 * 例外是**本端主动关闭**的 `closed`（`client-stopped` / `superseded`）：它描述的是「这条观看
 * 连接被本端停掉/替换」，只对**正在看这条连接的窗口**有意义。广播给所有窗口会把只是打开着同一
 * 工作区页面的窗口也判成「串流被关闭」（2026-11-27 复审 P1「多窗口误杀」；stale 恢复路径内部
 * 收尸补发的 `closed(client-stopped)` 就是实例）。所以这两类 token 也只发给该 `sessionId` 的
 * owner；没有 owner 时**不发给任何人**（最后一个观看者已经走了，没有窗口需要收敛）。
 *
 * 没有登记 owner 时（例如只在 main 内部启动的观看 / 单测）帧与光标回退为广播：宁可多发给受信
 * 窗口，也不能让唯一消费者收不到帧。
 */

import { BrowserWindow, webContents } from 'electron';

import {
  PSB_REMOTE_CHANNELS,
  type PsbPendingWorkspaceReleasesResult,
  type PsbSessionsReboundEvent,
  type PsbStreamEvent,
  type PsbWorkspaceChangedEvent,
} from '../../shared/psb-remote-workspace.js';
import {
  PSB_ADMIN_CHANNELS,
  type PsbWorkspaceAdminContextChangedEvent,
} from '../../shared/psb-workspace-admin.js';
import type { PsbWorkspaceVcsNoticeEvent } from '../../shared/psb-workspace-vcs.js';
import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { createPsbStreamOwnerRegistry } from './streamOwners.js';

function broadcastToTrustedWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!isTrustedAppRendererWindow(win)) continue;
    win.webContents.send(channel, payload);
  }
}

/** 只发给一个 webContents（仍要求它属于受信 renderer 窗口；窗口已销毁就丢弃）。 */
function sendToTrustedWebContents(
  webContentsId: number,
  channel: string,
  payload: unknown,
): void {
  const contents = webContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed()) return;
  const win = BrowserWindow.fromWebContents(contents);
  if (!win || !isTrustedAppRendererWindow(win)) return;
  contents.send(channel, payload);
}

/* ------------------------- 串流帧 owner 定向投递 ------------------------- */

/**
 * 管理页观看端的 owner 账本：`viewerSessionId → Set<webContentsId>`。
 *
 * 与 `ipc.ts` 的「谁启动/停止观看」账本分开维护：推送层只关心**发到哪**，停止语义在 IPC 层。
 * 两处都用 `createPsbStreamOwnerRegistry`，键的拼法保持一致（见 `ipc.ts` 的
 * `adminStreamOwnerKey`）。
 */
const adminStreamFrameOwners = createPsbStreamOwnerRegistry();

/** 管理页观看端启动后登记帧 owner（一个窗口可能同时看多个工作区）。 */
export function registerPsbAdminStreamOwner(viewerSessionId: string, ownerId: number): void {
  adminStreamFrameOwners.add(viewerSessionId, ownerId);
}

/** 管理页观看端停止 / 窗口销毁时注销帧 owner。 */
export function releasePsbAdminStreamOwner(viewerSessionId: string, ownerId: number): void {
  adminStreamFrameOwners.remove(viewerSessionId, ownerId);
}

/** 窗口销毁兜底：把它登记的帧 owner 全部清掉（返回被清空的 viewerSessionId）。 */
export function releasePsbStreamFrameOwnersForWebContents(ownerId: number): string[] {
  return adminStreamFrameOwners.removeOwner(ownerId);
}

/* ------------------------------ 广播入口 ------------------------------ */

/** 某个工作区的占用 / 在线 / 会话数快照变了（多窗口同步，例如设置窗口与主窗都开着列表）。 */
export function broadcastPsbWorkspaceChanged(event: PsbWorkspaceChangedEvent): void {
  broadcastToTrustedWindows(PSB_REMOTE_CHANNELS.WORKSPACE_CHANGED, event);
}

/**
 * 某工作区在占用 / 解除占用时被版本控制检查拒绝（CINDY-RW-10 更正版）。
 *
 * 为什么必须推：`ipcMain.handle` 抛错跨进程只保留 code + message，`details.vcs` 里的
 * `projects` / `actions` 带不过去。main 在抛错**之前**广播这份 notice，渲染层据此渲染
 * 「查看详情 / 还原后重试 / 重试检查」；推送与 invoke 失败的到达顺序不可依赖，渲染层还会用
 * `WORKSPACE_VCS_NOTICE_GET` 兜底读一次（同一个有界缓存）。
 */
export function broadcastPsbWorkspaceVcsNotice(event: PsbWorkspaceVcsNoticeEvent): void {
  broadcastToTrustedWindows(PSB_REMOTE_CHANNELS.WORKSPACE_VCS_NOTICE, event);
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
 * main 的「待释放工作区占用」账本变了（失败入账 / 重试成功出账 / 退出前重试）。
 *
 * 为什么必须推：失败可能来自 main 自己的终态扫描（任务在别的窗口归档 / 后台回收），
 * 渲染层没有参与那次调用、拿不到 invoke 结果；它只能靠这条推送知道「远端锁可能还在」。
 * 载荷是**完整快照**而不是增量：多窗口、乱序到达时按快照覆盖是幂等收敛的。
 */
export function broadcastPsbPendingReleasesChanged(
  event: PsbPendingWorkspaceReleasesResult,
): void {
  broadcastToTrustedWindows(PSB_REMOTE_CHANNELS.PENDING_RELEASES_CHANGED, event);
}

/**
 * 「远程工作区」管理页：当前工作区上下文变了（工作区 / 占用 / 桌面会话状态 / 观看端绑定）。
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

/** 本端主动关闭的稳定 token（`streamViewer` 的 `StreamCloseIntent` 子集）：只对观看者有意义。 */
const LOCAL_INTENT_STREAM_CLOSE_REASONS: ReadonlySet<string> = new Set([
  'client-stopped',
  'superseded',
]);

/**
 * 「远程工作区」管理页：**观看端绑定会话**的串流事件（帧 / 状态 / 光标 / 关闭 / 错误）。
 *
 * 只转发管理页自己绑定的那条会话的事件；载荷里的 `sessionId` 就是上下文里的
 * `viewerSessionId`。帧与光标是定向的（见文件头）：只发给登记过 owner 的窗口；状态 / 关闭 /
 * 错误继续广播，让任何展示该工作区的窗口都能收敛状态。
 *
 * 例外是本端主动关闭（`client-stopped` / `superseded`）：只发给该观看连接的 owner，没有 owner
 * 时丢弃（见文件头「本端主动关闭」）。
 */
export function broadcastPsbAdminStreamEvent(event: PsbStreamEvent): void {
  if (event.type === 'frame' || event.type === 'cursor') {
    const owners = adminStreamFrameOwners.owners(event.sessionId);
    if (owners.length > 0) {
      for (const ownerId of owners) {
        sendToTrustedWebContents(ownerId, PSB_ADMIN_CHANNELS.STREAM_EVENT, event);
      }
      return;
    }
  }
  if (
    event.type === 'closed' &&
    event.reason !== null &&
    LOCAL_INTENT_STREAM_CLOSE_REASONS.has(event.reason)
  ) {
    // 本端主动关闭：只通知正在看这条连接的窗口。没有 owner = 最后一个观看者已经离开，
    // 没有窗口需要这条事件；广播会让「只是把同一工作区页面开在别的窗口」的人看到一次伪关闭。
    for (const ownerId of adminStreamFrameOwners.owners(event.sessionId)) {
      sendToTrustedWebContents(ownerId, PSB_ADMIN_CHANNELS.STREAM_EVENT, event);
    }
    return;
  }
  broadcastToTrustedWindows(PSB_ADMIN_CHANNELS.STREAM_EVENT, event);
}
