import { randomUUID } from 'node:crypto';
import { sessionCreateToRow } from './mapper.js';
import { getDbClient, getCurrentDbClientSnapshot } from './client/current.js';
import { sessions } from './schema.js';
import { ensureDialogueWorkspaceDir } from './dialogueWorkspace.js';
import { ensureProjectGitInitialized } from '../git-snapshot/projectGitBootstrap.js';
import { readGitSafetySettings } from '../maker-host/git-safety-settings-store.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import { resolveSessionWorkspaceBinding } from './workspaceBindingResolver.js';

export type SessionOpenBody = NonNullable<Parameters<typeof sessionCreateToRow>[1]>;
export type OpenedSessionRow = ReturnType<typeof sessionCreateToRow> & { model: string };
type ModelAdmission = (body: SessionOpenBody) => Promise<SessionOpenBody>;
let admitModel: ModelAdmission | null = null;

/** Host installs its ordinary model catalog once; UI, tools, companions and plugins share it. */
export function setSessionOpeningModelAdmission(admission: ModelAdmission): void {
  admitModel = admission;
}

function agentRunsOnOtherDevice(body: SessionOpenBody): boolean {
  return typeof body.agentDeviceId === 'string' && body.agentDeviceId.trim().length > 0;
}

/** Project git bootstrap of a newly opened task (deferred to the first send for unsent tasks). */
export async function ensureOpenedProjectGit(row: {
  id: string;
  workingDir: string | null | undefined;
  workspaceKind: string | null | undefined;
  remoteHostId: string | null | undefined;
}): Promise<void> {
  const safety = readGitSafetySettings();
  await ensureProjectGitInitialized({ workingDir: row.workingDir, workspaceKind: row.workspaceKind,
    remoteHostId: row.remoteHostId ?? null, sessionId: row.id,
    autoSnapshotEnabled: safety.autoSnapshotEnabled,
    autoInitProjectGit: safety.autoInitProjectGit, source: 'session-open' });
}

/**
 * Open a normal Cindy Session. No messages are sent and no callback Agent is started.
 * Entry adapters authorize the caller/directory. A companion may atomically commit
 * its own receipt with the Session, while its timeline and completion signal remain outside.
 */
export async function openSession<T = void>(input: {
  id?: string;
  now?: number;
  body: SessionOpenBody;
  source?: OpenedSessionRow['source'];
  /** Background task (plugin `agent.hiddenTasks`): committed hidden in the same INSERT. */
  hiddenAt?: number;
  /** Unsent task opened while the user types: project git bootstrap waits for the first send. */
  deferGitInit?: boolean;
  assertCurrent?: () => void;
  /** Sample effective authority after async preparation, directly before committing. */
  finalize?: () => Pick<SessionOpenBody, 'permissionMode' | 'parentSessionId'>;
  onPersistenceStarted?: () => void;
}, commit?: (row: OpenedSessionRow, assertCurrent: () => void) => Promise<T>): Promise<{ row: OpenedSessionRow; value: T }> {
  const owner = getCurrentDbClientSnapshot();
  const assertCurrent = () => {
    if (!owner || getCurrentDbClientSnapshot() !== owner) throw new Error('账号已变化，请重新新建任务');
    input.assertCurrent?.();
  };
  assertCurrent();
  const db = getDbClient().drizzle;
  const id = input.id ?? randomUUID();
  const now = input.now ?? Date.now();
  if (!admitModel) throw new Error('任务模型服务尚未就绪，请稍后重试');
  // Remote model admission belongs to the execution host. Preserve the existing remote path.
  // Agent 在另一台电脑运行的任务同理：模型与来源来自那台，由那台启动时按它的目录校验。
  let selected = input.body.remoteHostId || agentRunsOnOtherDevice(input.body)
    ? input.body
    : await admitModel({ ...input.body });
  assertCurrent();
  let workspaceKind = selected.workspaceKind ?? 'project';
  const explicitDir = normalizeWorkingDirForStorage(selected.workingDir) ?? undefined;
  let workingDir = workspaceKind === 'dialogue' && !explicitDir
    ? ensureDialogueWorkspaceDir(id, now) : explicitDir;
  // 隐式 Meka 助理绑定（2026-11-20）：工作区根等于已注册 Meka 项目路径时，新会话按项目
  // 默认角色绑定。显式绑定优先；远程 / 跨设备任务不参与。规则见
  // docs/dev-rules/meka-assistant-session-binding.md §2。
  const hasExplicitMekaBinding = Boolean(selected.mekaProjectId || selected.mekaRoleId);
  if (
    !hasExplicitMekaBinding &&
    workspaceKind !== 'meka' &&
    !selected.remoteHostId &&
    !agentRunsOnOtherDevice(selected)
  ) {
    const resolution = await resolveSessionWorkspaceBinding({
      workingDir: workingDir ?? null,
      projectDir: normalizeWorkingDirForStorage(selected.projectDir) ?? null,
    });
    assertCurrent();
    if (resolution) {
      selected = {
        ...selected,
        mekaProjectId: resolution.projectId,
        mekaRoleId: resolution.roleId,
        projectDir: resolution.workspacePath,
        workspaceKind: 'project',
      };
      workspaceKind = 'project';
      workingDir = workingDir ?? resolution.workspacePath;
    }
  }
  const prepared = { ...selected, workspaceKind, workingDir };
  if (!input.deferGitInit) {
    await ensureOpenedProjectGit({ id, workingDir, workspaceKind, remoteHostId: prepared.remoteHostId ?? null });
    assertCurrent();
  }
  const mapped = sessionCreateToRow(id, { ...prepared, ...input.finalize?.() }, now);
  if (!mapped.model) throw new Error('任务模型不可用，请重新选择');
  const row = { ...mapped, model: mapped.model, ...(input.source ? { source: input.source } : {}),
    ...(input.hiddenAt !== undefined ? { hiddenAt: input.hiddenAt } : {}) };
  input.onPersistenceStarted?.();
  let value: T;
  if (commit) value = await commit(row, assertCurrent);
  else { await db.insert(sessions).values(row).run(); value = undefined as T; }
  assertCurrent();
  return { row, value };
}
