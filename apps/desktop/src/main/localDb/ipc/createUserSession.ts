/** Ordinary task creation, shared by local IPC and authenticated Host clients.
 * Entry adapters validate caller identity; this service owns identical task data,
 * draft lifecycle, directory grants and model admission on every launcher. */
import { eq } from 'drizzle-orm';
import { getCurrentDbClientSnapshot, getDbClient } from '../client/current.js';
import { sessions } from '../schema.js';
import { ensureMekaWorkspaceDir, resolveMekaProjectWorkspacePath } from '../mekaWorkspace.js';
import { getMekaProjectById } from './mekaProjects.js';
import { getFormalProvider } from '../../meka-formal/registry.js';
import { registerBuiltInFormalProviders } from '../../meka-formal/providers.js';
import { getMekaP4SettingsService } from '../../meka-settings/ipc.js';
import { openSession } from '../sessionOpening.js';
import { sessionCreateToRow, sessionToCamel, normalizeRemoteHostId } from '../mapper.js';
import { ensureDialogueWorkspaceDir } from '../dialogueWorkspace.js';
import { resolveBusinessSessionId } from '../../sessionIds.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import { isRetainableProjectSession } from '../../../shared/sessionSource.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import { assertRendererSessionSourceAllowed } from './sessionSourceGuard.js';
import { consumeWritableDirectoryPickerGrants, WritableDirectoryPickerGrantError } from '../../maker-ipc/writableDirectoryPickerGrant.js';
import { forgetProvisionalSession, isProvisionalSession, markProvisionalSession } from '../provisionalSessions.js';
import { upsertRecentWorkdir } from './recentWorkdirsCore.js';
import { managedWorktreeRoot } from '../../worktree/managedResourcePath.js';
import { withWorktreeResourceLocks } from '../../worktree/resourceLock.js';
import { createLogger } from '../../logger.js';

const log = createLogger('local-db-sessions');
export interface UserSessionCreatePorts {
  senderId: number;
  userDataDir: string;
  notifyPluginSessionCreated(input: { sessionId: string; workdir?: string }): void;
}

export async function withWorktreeMutation<T>(resources: string[], task: () => Promise<T>): Promise<T> {
  try {
    return await withWorktreeResourceLocks(resources, task);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code && error instanceof Error && error.message.startsWith(`[${code}]`)) throw error;
    log.warn('worktree mutation postponed', { code: code ?? 'unavailable' });
    throwIpcError(
      'PRECONDITION_FAILED',
      'Worktree is busy or its recovery record could not be saved',
    );
  }
}

export async function createUserSession(body: unknown, ports: UserSessionCreatePorts) {
    const owner = getCurrentDbClientSnapshot();
    const assertOwner = () => {
      if (!owner || getCurrentDbClientSnapshot() !== owner) throwIpcError('PRECONDITION_FAILED', 'Account changed; create the task again');
    };
    assertOwner();
    const db = owner!.client.drizzle;
    const now = Date.now();
    const bodyObj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const id = resolveBusinessSessionId(bodyObj.id);
    // 未发送任务（新建页开始输入时先建出来，见 provisionalSessions.ts）：只给本机普通任务，
    // 延后的创建副作用在第一次发送转正时补做。
    const { provisional: provisionalFlag, ...bodyWithoutProvisional } = bodyObj;
    const provisional = provisionalFlag === true;
    if (provisional && (
      bodyObj.remoteHostId || bodyObj.agentDeviceId || bodyObj.orcaRole || bodyObj.source !== undefined
      || (Array.isArray(bodyObj.writableDirs) && bodyObj.writableDirs.length > 0)
    )) {
      throwIpcError('INVALID_PARAMS', 'only ordinary local tasks can be opened before the first send');
    }
    const createBody = bodyWithoutProvisional as Parameters<typeof sessionCreateToRow>[1];
    // M16: agentKind 白名单校验（防止 renderer 传非法值）
    const ALLOWED_AGENT_KINDS = new Set<string>(['cc', 'codex', 'pi']);
    if (bodyObj.agentKind !== undefined && !ALLOWED_AGENT_KINDS.has(bodyObj.agentKind as string)) {
      throwIpcError('INVALID_PARAMS', `invalid agentKind: ${String(bodyObj.agentKind)}`);
    }
    if (
      bodyObj.title !== undefined &&
      (typeof bodyObj.title !== 'string' || bodyObj.title.length > 200)
    ) {
      throwIpcError('INVALID_PARAMS', 'title must be a string no longer than 200 characters');
    }
    const ALLOWED_WORKSPACE_KINDS = new Set<string>(['project', 'dialogue', 'meka']);
    if (
      bodyObj.workspaceKind !== undefined &&
      !ALLOWED_WORKSPACE_KINDS.has(bodyObj.workspaceKind as string)
    ) {
      throwIpcError('INVALID_PARAMS', `invalid workspaceKind: ${String(bodyObj.workspaceKind)}`);
    }
    const ALLOWED_ORCA_ROLES = new Set<string>(['lead', 'worker']);
    if (
      bodyObj.orcaRole !== undefined &&
      bodyObj.orcaRole !== null &&
      !ALLOWED_ORCA_ROLES.has(bodyObj.orcaRole as string)
    ) {
      throwIpcError('INVALID_PARAMS', `invalid orcaRole: ${String(bodyObj.orcaRole)}`);
    }
    // Agent 在同账号另一台电脑运行：只接受设备 id 形态的值(与 maker:create-session 同一规则)。
    if (
      bodyObj.agentDeviceId !== undefined &&
      bodyObj.agentDeviceId !== null &&
      (typeof bodyObj.agentDeviceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(bodyObj.agentDeviceId))
    ) {
      throwIpcError('INVALID_PARAMS', 'agentDeviceId must be a device id');
    }
    const workspaceKind =
      (createBody?.workspaceKind as 'project' | 'dialogue' | 'meka' | undefined) ?? 'project';
    let validatedCreateBody = createBody;
    const mekaProjectId =
      typeof createBody?.mekaProjectId === 'string' ? createBody.mekaProjectId.trim() : '';
    const mekaRoleId =
      typeof createBody?.mekaRoleId === 'string' ? createBody.mekaRoleId.trim() : '';
    const hasMekaProjectRole = mekaProjectId.length > 0 && mekaRoleId.length > 0;
    let mekaProjectWorkingDir: string | null = null;
    if (workspaceKind === 'meka' && !hasMekaProjectRole) {
      throwIpcError('INVALID_PARAMS', 'Meka session requires a project and role');
    }
    if (workspaceKind === 'meka' && hasMekaProjectRole) {
      const project = await getMekaProjectById(mekaProjectId);
      if (!project) {
        throwIpcError('MEKA_PROJECT_NOT_FOUND', `Meka project ${mekaProjectId} not found`);
      }
      const role = await getDbClient().queryOne<{ project_id: string }>(
        'SELECT project_id FROM meka_roles WHERE id = ?',
        [mekaRoleId],
      );
      if (!role || role.project_id !== project.id) {
        throwIpcError('INVALID_PARAMS', 'Meka role does not belong to the selected project');
      }
      try {
        mekaProjectWorkingDir = await resolveMekaProjectWorkspacePath(project.path, {
          readP4RootPath: async () => (await getMekaP4SettingsService().get()).p4RootPath,
        });
      } catch (error) {
        throwIpcError(
          'PRECONDITION_FAILED',
          error instanceof Error ? error.message : 'Meka project path cannot be resolved',
        );
      }
      const requestedExtraDirs = Array.isArray(createBody?.extraDirs)
        ? createBody.extraDirs.filter((item): item is string => typeof item === 'string')
        : [];
      validatedCreateBody = {
        ...createBody,
        extraDirs: [...new Set([...(project.additionalPaths ?? []), ...requestedExtraDirs])],
      };
      if (createBody?.isFormal === true) {
        registerBuiltInFormalProviders();
        const formal = createBody?.formal;
        const provider = getFormalProvider(formal?.type);
        if (
          !provider ||
          project.formalWorkflowEnabled !== true ||
          project.workflowType !== provider.type
        ) {
          throwIpcError('INVALID_PARAMS', 'formal workflow does not match the selected project');
        }
        const normalizedContent = provider.validateContent(formal?.content);
        const parsedLink = formal ? provider.parseLink(formal.link, project) : null;
        if (!formal || !normalizedContent || !parsedLink || parsedLink.ref !== formal.ref) {
          throwIpcError('INVALID_PARAMS', 'formal workflow snapshot is invalid');
        }
        validatedCreateBody = {
          ...validatedCreateBody,
          formal: {
            type: provider.type,
            link: parsedLink.webUrl,
            ref: parsedLink.ref,
            content: normalizedContent,
          },
        };
      }
    } else if (createBody?.isFormal === true) {
      throwIpcError('INVALID_PARAMS', 'formal workflow requires a registered Meka project');
    }
    const explicitWorkingDir =
      normalizeWorkingDirForStorage(
        typeof validatedCreateBody?.workingDir === 'string' ? validatedCreateBody.workingDir : null,
      ) ?? undefined;
    assertRendererSessionSourceAllowed({
      source: bodyObj.source,
      workingDir: explicitWorkingDir,
      remoteHostId: createBody?.remoteHostId,
      userData: ports.userDataDir,
    });
    const workingDir =
      workspaceKind === 'dialogue' && !explicitWorkingDir
        ? ensureDialogueWorkspaceDir(id, now)
        : workspaceKind === 'meka'
          ? (mekaProjectWorkingDir ?? ensureMekaWorkspaceDir(id, now))
          : explicitWorkingDir;
    if (workspaceKind === 'dialogue' && !explicitWorkingDir) {
      log.info('[localDb] allocated dialogue workspace', { sessionId: id, workingDir });
    }
    const requestedWritableDirs = createBody?.writableDirs ?? [];
    if (
      !Array.isArray(requestedWritableDirs) ||
      !requestedWritableDirs.every((dir) => typeof dir === 'string')
    ) {
      throwIpcError('INVALID_PARAMS', 'writableDirs must be string[]');
    }
    const requestedRemoteHostId = normalizeRemoteHostId(createBody?.remoteHostId);
    if (requestedRemoteHostId && requestedWritableDirs.length > 0) {
      throwIpcError(
        'PRECONDITION_FAILED',
        'remote writable directories can only be revoked from an existing task',
      );
    }
    if (!requestedRemoteHostId && requestedWritableDirs.length > 0) {
      try {
        await consumeWritableDirectoryPickerGrants({
          scopeId: id,
          senderId: ports.senderId,
          requestedDirs: requestedWritableDirs,
          previousDirs: [],
        });
      } catch (error) {
        throwIpcError(
          error instanceof WritableDirectoryPickerGrantError ? error.code : 'PRECONDITION_FAILED',
          error instanceof Error ? error.message : 'Writable directory authorization failed',
        );
      }
    }
    // 未发送任务在写入之前就登记：行一出现，任务列表 / 控制端 / IM / hook 的过滤就已生效。
    assertOwner();
    const markedProvisional = provisional && !isProvisionalSession(id);
    if (markedProvisional) {
      // Only a dialogue folder allocated here is ours to tidy up if the task is discarded.
      const managedDir = workspaceKind === 'dialogue' && !explicitWorkingDir ? workingDir : undefined;
      markProvisionalSession(id, now, managedDir);
    }
    let insertRow: Awaited<ReturnType<typeof openSession>>['row'];
    let row: typeof sessions.$inferSelect | undefined;
    try {
      ({ row: insertRow } = await openSession({ id, now, assertCurrent: assertOwner,
        body: { ...validatedCreateBody, workspaceKind, workingDir },
        ...(provisional ? { deferGitInit: true } : {}),
      }, async (prepared, assertCurrent) => {
        const resource = !prepared.remoteHostId && prepared.workingDir
          ? managedWorktreeRoot(prepared.workingDir) : null;
        const insert = async () => { assertCurrent(); await db.insert(sessions).values(prepared); };
        if (resource) await withWorktreeMutation([resource], insert);
        else await insert();
      }));
      [row] = await db.select().from(sessions).where(eq(sessions.id, id));
      assertOwner();
    } catch (error) {
      if (markedProvisional) forgetProvisionalSession(id);
      throw error;
    }
    if (!row) throwIpcError('NOT_FOUND', 'Session 创建后查询失败');
    if (provisional) {
      log.info('provisional session opened', { sessionId: id, workspaceKind: insertRow.workspaceKind });
      return sessionToCamel({ ...row, messageCount: 0 });
    }
    // recent-workdirs: 项目目录走 sidebar 分组,要进"最近"列表;dialogue 目录是
    // app-managed 临时 cwd,跟用户选过的项目目录语义不同,不污染最近列表。
    // 失败仅日志,不阻断创建流程。
    //
    // remote 项目排除:recent_workdirs 表只有 path 主键、无 host 维度,若把 remote
    // 路径写进去,后续 New Maker 项目下拉选中它时会丢失 host、按本机路径创建出一个
    // 错误的本地会话(指向本机不存在的同名目录)。在 host-aware 最近项目(给该表加
    // remote_host_id 列 + picker 区分 local/remote)落地前,remote 项目一律不进最近列表。
    if (
      (insertRow.workspaceKind === 'project' || insertRow.workspaceKind === 'meka') &&
      insertRow.workingDir &&
      !insertRow.remoteHostId &&
      isRetainableProjectSession(insertRow)
    ) {
      void upsertRecentWorkdir(insertRow.projectDir ?? insertRow.workingDir, now);
    }
    // 订阅槽①旁路通知(fire-and-forget,动态 import 防环):意识旁听会话创建。
    // 资格过滤(用户主会话)与订阅者快路径都在 cindy-brain 内部,这里零判断。
    ports.notifyPluginSessionCreated({ sessionId: id, ...(row.workingDir ? { workdir: row.workingDir } : {}) });
    // 新建 session 必然无 message，直接拼 0，免一次 join。
    return sessionToCamel({ ...row, messageCount: 0 });
}
