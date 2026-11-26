/**
 * 「远程工作区」入口 / 页面的身份判定（纯函数）。
 *
 * 远程工作区会话的唯一判据是 `remoteHostId` 以 `psb:` 开头（产品正本
 * `docs/product-rules/psb-remote-workspace-sessions.md` §6），完整值形如
 * `psb:<PSB sessionId>`。这些 helper 不碰 IPC / DOM，便于单测覆盖
 * 「哪些会话出现「远程工作区」按钮」「页面该用哪个 PSB 会话 id」。
 */

import { parsePsbRemoteHostId } from '../../../../shared/psb-remote-workspace';

/** `psb:<id>` → PSB 会话 id；非 psb 或畸形值 → `null`。 */
export function psbStreamSessionId(remoteHostId: string | null | undefined): string | null {
  return parsePsbRemoteHostId(remoteHostId);
}

/**
 * 会话页标题栏是否出现「远程工作区」入口。
 *
 * 两条都要成立：有打开的任务（右侧栏页签与页面都挂在任务上下文里）、远端身份是 `psb:`。
 * 其它远端（`mcpr:`、SSH host）与本地会话一律不出现 —— 它们没有 PSB 远程工作区。
 */
export function shouldShowRemoteWorkspaceAdminEntry(input: {
  readonly sessionId: string | null | undefined;
  readonly remoteHostId: string | null | undefined;
}): boolean {
  return Boolean(input.sessionId) && psbStreamSessionId(input.remoteHostId) !== null;
}
