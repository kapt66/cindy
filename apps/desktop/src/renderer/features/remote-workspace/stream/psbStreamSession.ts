/**
 * 「远程工作区」页签入口的判定（会话页标题行是否出现该按钮）。
 *
 * ## 身份解析只有一份
 *
 * `psb:` 前缀的判定与 PSB 会话 id 解析的唯一实现在
 * `sidebar/isRemoteWorkspaceSession.ts`（`remoteWorkspacePsbSessionId`，内部走共享契约
 * `parsePsbRemoteHostId`）。本文件**不再自己包一层同名解析**：2026-11-26 独立审查发现
 * `psbStreamSessionId` 与 `remoteWorkspacePsbSessionId` 是两个行为完全相同的包装，调用方
 * 按目录各取一个，改一处就漂一处。最后一个调用点（`cc-agent/CCAgentSessionView.tsx`）已迁移
 * 到 `remoteWorkspacePsbSessionId`，别名 `psbStreamSessionId` **已删除**。
 */

import { remoteWorkspacePsbSessionId } from '../sidebar/isRemoteWorkspaceSession';

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
  return Boolean(input.sessionId) && remoteWorkspacePsbSessionId(input.remoteHostId) !== null;
}
