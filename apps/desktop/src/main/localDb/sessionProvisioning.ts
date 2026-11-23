import type { AgentKind, WorkspaceKind } from '@cindy/maker-core';

import { makerToDbAgentKind } from '../../shared/agentKindConversion.js';
import { getDbClient } from './client/current.js';
import { sessionCreateToRow } from './mapper.js';
import { sessions } from './schema.js';

/**
 * 启动前“先建行”的创建收口。
 *
 * Meka 身份必须随 sessions 行同一次 INSERT 落库；但 `maker.createSession` 只会把
 * `SessionMeta` 交给 storage adapter，拿不到调用方 opts 里的成对绑定（远端 Worker /
 * worktree / device-link 的工作区路径也不是本机 Meka 项目根，路径推断兜不住）。
 * 因此所有需要绑定身份的 bootstrap 入口在启动 Agent 之前先用本函数建行，随后
 * `maker.createSession({ id })` 命中已有行、只回写 sdkSessionId。
 *
 * 调用方必须先完成账号/路径/模型等校验；这里只做最后一次 mapper + INSERT，不再
 * 做模型准入或 git 初始化。
 */
export interface ProvisionedSessionInsert {
  id: string;
  agentKind: AgentKind;
  workspaceKind: WorkspaceKind;
  workingDir?: string | null;
  projectDir?: string | null;
  title?: string;
  model: string;
  providerId?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  fastMode?: boolean | 'ultrafast' | null;
  planModeEnabled?: boolean;
  parentSessionId?: string | null;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
  mekaProjectId?: string | null;
  mekaRoleId?: string | null;
  /** 'desktop' 是普通主进程来源；review 由 reviewMode 决定。 */
  source?: 'desktop' | 'review';
  extraDirs?: string[];
  writableDirs?: string[];
}

/**
 * 用创建侧已解析好的身份写一条 sessions 行。
 *
 * 幂等：id 已存在时 onConflictDoNothing，不覆盖现有行（调用方应先 read）；
 * 并发下两个启动流程只有先到的那一行生效，后续 make 复用同一行。
 */
export async function insertProvisionedSessionRow(
  input: ProvisionedSessionInsert,
): Promise<boolean> {
  const mapped = sessionCreateToRow(
    input.id,
    {
      title: input.title,
      workingDir: input.workingDir ?? undefined,
      projectDir: input.projectDir ?? null,
      workspaceKind: input.workspaceKind,
      model: input.model,
      effort: input.effort ?? undefined,
      permissionMode: input.permissionMode ?? undefined,
      fastMode: input.fastMode ?? undefined,
      planModeEnabled: input.planModeEnabled ?? false,
      agentKind: makerToDbAgentKind(input.agentKind),
      parentSessionId: input.parentSessionId ?? null,
      remoteHostId: input.remoteHostId ?? null,
      agentDeviceId: input.agentDeviceId ?? null,
      mekaProjectId: input.mekaProjectId ?? null,
      mekaRoleId: input.mekaRoleId ?? null,
      extraDirs: input.extraDirs,
      writableDirs: input.writableDirs,
    },
    Date.now(),
  );
  const inserted = await getDbClient()
    .drizzle.insert(sessions)
    .values({
      ...mapped,
      source: input.source ?? 'desktop',
      // 身份已经由调用方解析；有绑定就不再写旧的第三态 kind。
      workspaceKind: input.mekaProjectId && input.mekaRoleId ? 'project' : mapped.workspaceKind,
    })
    .onConflictDoNothing({ target: sessions.id })
    .returning({ id: sessions.id });
  return inserted.length > 0;
}
