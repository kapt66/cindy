/**
 * Meka 运行时注入的**持久化绑定数据源**（注入层 `deps.readPersistedSession` 的共享实现）。
 *
 * 形态 A 的 `applyMekaRuntimeConfig` 需要 `deps.readPersistedSession` 才能在冷启动时把
 * sessions 行 hydrate 成绑定。桌面 `bootstrapSessionOnce` 目前仍内联着同一段查询（本轮按
 * 范围不动 `maker-ipc/register.ts`）；IM / 官方 hook 的冷启动补注入复用这里的实现，避免再
 * 长出第三份拷贝。
 *
 * 这**不是**第二个注入入口：注入只有一个入口 `./index.js` 的 `applyMekaRuntimeConfig`，
 * 本文件只产出它的 deps 数据（只读、不判定身份、不写任何东西）。身份判定统一走
 * `../../shared/mekaAssistantSession.js` 的 `isMekaAssistantSession` /
 * `hasMekaAssistantBinding`（绑定成对是唯一真源，`workspaceKind` 只是展示归类）。
 *
 * 规则正本：`docs/dev-rules/meka-assistant-session-binding.md`。
 */

import { eq } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import type { PersistedMekaSessionBinding } from './mekaInjectionTypes.js';

/**
 * 读一条 sessions 行的 Meka 绑定字段。
 *
 * - 返回 `null`：行不存在（调用方按「非 Meka / 无绑定」处理，零写入）。
 * - 只投影注入层需要的绑定列，不读整行：会话归属、路径、模型等仍由各调用方自己从
 *   自己的快照取，本函数不做第二套会话投影。
 *
 * hydrate 结果会被注入层回填到 create opts（`MekaSessionBindingPatch`），因此列必须与
 * `PersistedMekaSessionBinding` 一一对应，不回填派生值。
 */
export async function readPersistedMekaSessionBinding(
  sessionId: string,
): Promise<PersistedMekaSessionBinding | null> {
  const [row] = await getDbClient()
    .drizzle.select({
      workspaceKind: sessions.workspaceKind,
      mekaProjectId: sessions.mekaProjectId,
      mekaRoleId: sessions.mekaRoleId,
      mekaRole: sessions.mekaRole,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row ?? null;
}
