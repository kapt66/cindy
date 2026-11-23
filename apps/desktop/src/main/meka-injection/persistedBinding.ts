/**
 * Meka 运行时注入的**持久化绑定数据源**（注入层 `deps.readPersistedSession` 的共享实现）。
 *
 * 形态 A 的 `applyMekaRuntimeConfig` 需要 `deps.readPersistedSession` 才能在冷启动时把
 * sessions 行 hydrate 成绑定。桌面 `bootstrapSessionOnce`、IM / 官方 hook 冷启动、Goal 恢复
 * 与 scheduler 重建统一复用这里的实现，避免各写一份查询。
 *
 * 这**不是**第二个注入入口：注入只有一个入口 `./index.js` 的 `applyMekaRuntimeConfig`，
 * 本文件只产出它的 deps 数据（只读、不判定身份、不写任何东西）。身份判定统一走
 * `../../shared/mekaAssistantSession.js` 的 `isMekaAssistantSession` /
 * `hasMekaAssistantBinding`（绑定成对是唯一真源，`workspaceKind` 只是展示归类）。
 *
 * 规则正本：`docs/dev-rules/meka-assistant-session-binding.md`。
 */

import { and, eq, isNull } from 'drizzle-orm';

import { getCurrentDbClientSnapshot, getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { resolveSessionWorkspaceBinding } from '../localDb/workspaceBindingResolver.js';
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

/**
 * 启动前的持久化身份读取 + **按本地工作区补一次身份**。
 *
 * 创建侧统一收口后，新行应当已经带绑定；这里覆盖历史普通行、旧版本建出的行以及任何
 * 漏接入创建缝的入口：启动时如果行未绑定、且工作区是本机 Meka 项目目录，就把成对绑定
 * 写回同一行，之后注入按持久化身份进行。只处理本地工作区（remoteHostId 跳过），不批量
 * 回填；已绑定行零写入。
 *
 * 注入层的数据源用这个函数，保证「任何口径启动会话」都在启动前完成身份收口。
 */
export async function ensurePersistedMekaSessionBinding(
  sessionId: string,
): Promise<PersistedMekaSessionBinding | null> {
  const owner = getCurrentDbClientSnapshot();
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      workspaceKind: sessions.workspaceKind,
      workingDir: sessions.workingDir,
      projectDir: sessions.projectDir,
      remoteHostId: sessions.remoteHostId,
      mekaProjectId: sessions.mekaProjectId,
      mekaRoleId: sessions.mekaRoleId,
      mekaRole: sessions.mekaRole,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return null;
  if (row.mekaProjectId && row.mekaRoleId) {
    return {
      workspaceKind: row.workspaceKind,
      mekaProjectId: row.mekaProjectId,
      mekaRoleId: row.mekaRoleId,
      mekaRole: row.mekaRole,
    };
  }
  // 半绑定/远端会话不在这里补：半绑定交给写入侧或迁移显式修，远端路径属于另一台电脑。
  if (row.mekaProjectId || row.mekaRoleId || row.remoteHostId) {
    return {
      workspaceKind: row.workspaceKind,
      mekaProjectId: row.mekaProjectId,
      mekaRoleId: row.mekaRoleId,
      mekaRole: row.mekaRole,
    };
  }
  const resolution = await resolveSessionWorkspaceBinding({
    workingDir: row.workingDir,
    projectDir: row.projectDir,
    remoteHostId: null,
    agentDeviceId: null,
  });
  if (!resolution) {
    return {
      workspaceKind: row.workspaceKind,
      mekaProjectId: null,
      mekaRoleId: null,
      mekaRole: row.mekaRole,
    };
  }
  // 解析期间换了账号：不能把旧账号的项目/角色写进新账号的库。
  if (owner && getCurrentDbClientSnapshot() !== owner) {
    throw new Error('账号已变化，无法升级 Meka 会话身份');
  }
  const updated = await db
    .update(sessions)
    .set({
      workspaceKind: 'project',
      projectDir: resolution.workspacePath,
      mekaProjectId: resolution.projectId,
      mekaRoleId: resolution.roleId,
      updatedAt: Date.now(),
    })
    .where(and(
      eq(sessions.id, sessionId),
      isNull(sessions.mekaProjectId),
      isNull(sessions.mekaRoleId),
    ))
    .returning({ mekaProjectId: sessions.mekaProjectId, mekaRoleId: sessions.mekaRoleId });
  if (updated[0]?.mekaProjectId && updated[0].mekaRoleId) {
    return {
      workspaceKind: 'project',
      mekaProjectId: updated[0].mekaProjectId,
      mekaRoleId: updated[0].mekaRoleId,
      mekaRole: row.mekaRole,
    };
  }
  // 条件 UPDATE 没写中：并发下另一路刚写了身份。以库里实际值为准，绝不返回和行不一致的绑定。
  const after = await readPersistedMekaSessionBinding(sessionId);
  return after ?? null;
}
