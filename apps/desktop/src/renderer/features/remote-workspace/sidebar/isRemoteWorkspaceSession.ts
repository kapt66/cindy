/**
 * 「远程工作区会话」身份判定 —— 渲染层的统一入口。
 *
 * ## 口径（产品正本：`docs/product-rules/psb-remote-workspace-sessions.md` §2.1 / §6）
 *
 * 一条会话是不是远程工作区会话，**只看** `remoteHostId` 是否以 `psb:` 开头（零迁移方案：
 * 复用既有的 `sessions.remote_host_id`，不新增列）。`psb:` 之后是 PSB 生成的会话 id，
 * Cindy 不解析、不拼接、不推导它的格式，因此这里只做前缀解析，且必须走共享契约的
 * `parsePsbRemoteHostId`（前缀字面量只允许出现在 `shared/psb-remote-workspace.ts` 一处）。
 *
 * 判定本体定义在 `shared/mekaAssistantSession.ts`（那里同时需要它来保证
 * `isMekaAssistantSession()` 不把 `psb:` 会话判成 Meka 助理会话 —— 跨层共用一份实现）。
 * 本文件是渲染层的入口：额外提供「取 PSB 会话 id」的窄函数，并在文档里固定侧栏四个过滤点
 * 的口径（漏一处会让同一个会话在两个归属位置重复出现，见
 * `docs/dev-rules/psb-remote-session-transport.md` §1 硬约束 1）：
 * 1. `CCAgentSidebarUpper` 的 `nonMekaSidebarSessions` / `nonMekaActivitySessions` /
 *    `unfilteredProjectSessions`（普通项目/对话树与置顶段）；
 * 2. `MekaAssistantSection.buildMekaProjectSessionGroups`（Meka 项目分组）；
 * 3. `lib/sidebarProjectVisibility.ts`（隐藏项目改写 dialogue 的例外）；
 * 4. `shared/mekaAssistantSession.ts`（跨层 Meka 身份判定）。
 *
 * 注意：远程工作区会话**不是** Meka 助理会话（它是普通任务，只是跑在远端工作区），
 * 也不要混进 Meka 项目分组。
 */

import { parsePsbRemoteHostId } from '../../../../shared/psb-remote-workspace';

export { isRemoteWorkspaceSession } from '../../../../shared/mekaAssistantSession';

/** 身份判定与 PSB 会话 id 解析只需要 `remoteHostId`（`Session` 满足该结构）。 */
export interface RemoteWorkspaceSessionIdentityLike {
  readonly remoteHostId?: string | null;
}

/**
 * 取 PSB 会话 id（`psb:` 之后的部分）；非远程工作区会话返回 `null`。
 *
 * 渲染层把它当**不透明键**用（`bridge.sessionStatus({ sessionId })` 的入参），
 * 不参与任何展示文案或路径拼接。
 */
export function remoteWorkspacePsbSessionId(
  session: RemoteWorkspaceSessionIdentityLike | null | undefined,
): string | null {
  return parsePsbRemoteHostId(session?.remoteHostId);
}
