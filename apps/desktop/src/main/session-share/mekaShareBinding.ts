/**
 * .cshare 里 Meka 绑定身份在**导入机**的再解析。
 *
 * 分享包只带身份(project/role id);项目与角色的配置内容、P4 绝对路径、MCPRouter
 * 凭证都不随包携带,导入端必须在本机重新解析出工作目录与额外只读目录。解析不出来
 * 就按普通任务降级——绝不半绑定:运行期(`meka-injection/mekaResolvePlan.ts`)对
 * `workspace_kind='meka'` 但缺 project/role 的行直接抛
 * `Meka session requires a project and role`。
 *
 * 解析口径逐条对齐 renderer 正常新建 Meka 任务(`localDb/ipc/sessions.ts` 的
 * `sessions:create`):同一个 `getMekaProjectById` 读项目(含 additionalPaths),
 * 同一个 `resolveMekaProjectWorkspacePath` 算工作目录(内置 SAGA2 项目走
 * meka-settings 的 P4 根目录),角色必须存在且属于该项目。
 */
import type { FormalSessionData } from '../../shared/meka-formal.js';

import type { DbClient } from '../localDb/client/DbClient.js';
import { getMekaProjectById } from '../localDb/ipc/mekaProjects.js';
import { resolveMekaProjectWorkspacePath } from '../localDb/mekaWorkspace.js';
import { createLogger } from '../logger.js';
import { getMekaP4SettingsService } from '../meka-settings/ipc.js';

import type {
  XdtshareMekaFormalSection,
  XdtshareMekaLegacyRole,
  XdtshareMekaManifest,
} from './xdtshareFormat.pure.js';

const log = createLogger('meka-share-binding');

/** 绑定无法在导入机恢复的原因(决定向导文案与导入后的 note key)。 */
export type ShareMekaUnavailableReason =
  /** 包里有 project id,但本机没有这个项目的注册。 */
  | 'project-missing'
  /** 项目在,但角色不存在或不属于该项目。 */
  | 'role-missing'
  /** 项目与角色都在,但工作目录解析不出来(内置项目未配置 P4 根目录等)。 */
  | 'workspace-unresolved'
  /** 遗留四角色会话:包里根本没有 project/role id,本机无法凭空补出绑定。 */
  | 'legacy-scope'
  /** 解析过程本身失败(项目配置读不出来、DB 不可用等)。 */
  | 'error';

/** 绑定解析结果里与向导展示相关的部分。 */
export interface ShareMekaBindingIdentity {
  projectId: string | null;
  roleId: string | null;
  legacyRole: XdtshareMekaLegacyRole | null;
  /** 本机项目显示名;项目不可用时为 null。 */
  projectName: string | null;
  /** 本机角色显示名;角色不可用时为 null。 */
  roleName: string | null;
}

export type ShareMekaBindingResolution =
  | { present: false }
  | ({
      present: true;
      status: 'bound';
      /** 本机解析出的工作目录(与新建 Meka 任务同一路径)。 */
      workingDir: string;
      /** 项目 additionalPaths:作为额外只读目录写入 sessions.extra_dirs。 */
      extraDirs: string[];
      /** 冻结的正式流程快照;非正式流程为 null。 */
      formal: FormalSessionData | null;
      /** 历史 meka_target_json 的 JSON 文本;包内没有时为 null。 */
      targetJson: string | null;
    } & ShareMekaBindingIdentity)
  | ({
      present: true;
      status: 'unavailable';
      reason: ShareMekaUnavailableReason;
    } & ShareMekaBindingIdentity);

/** 向导用的扁平预览形状(main 与 renderer 的镜像契约)。 */
export interface ShareMekaPreview {
  /** 包内是否带 Meka 绑定段(= 导出方是 Meka 任务)。 */
  present: boolean;
  status: 'bound' | 'unavailable';
  projectId: string | null;
  roleId: string | null;
  /** 包内的遗留四角色(0.0.11 之前的会话),仅供无法恢复时说明来源。 */
  legacyRole: XdtshareMekaLegacyRole | null;
  projectName: string | null;
  roleName: string | null;
  /** present=false 或绑定成功时为 'none'。 */
  reason: 'none' | ShareMekaUnavailableReason;
}

/** 非 Meka 包的预览值。 */
const NO_SHARE_MEKA_PREVIEW: ShareMekaPreview = {
  present: false,
  status: 'unavailable',
  projectId: null,
  roleId: null,
  legacyRole: null,
  projectName: null,
  roleName: null,
  reason: 'none',
};

/** 解析结果 → 向导预览。 */
export function toShareMekaPreview(resolution: ShareMekaBindingResolution): ShareMekaPreview {
  if (!resolution.present) return NO_SHARE_MEKA_PREVIEW;
  return {
    present: true,
    status: resolution.status,
    projectId: resolution.projectId,
    roleId: resolution.roleId,
    legacyRole: resolution.legacyRole,
    projectName: resolution.projectName,
    roleName: resolution.roleName,
    reason: resolution.status === 'bound' ? 'none' : resolution.reason,
  };
}

/**
 * 把包内 meka 段解析成本机绑定。**只读**:不写任何东西,commit 阶段拿到 bound
 * 结果后再落库。任何异常都归一为 `unavailable`——预览/导入不该因为一次读失败
 * 而整个失败(降级路径本来就要走)。
 *
 * `getDbClient` 刻意是延迟取值:非 Meka 包(manifest 没有 meka 段)连 DB 都不碰,
 * 老包的 inspect/预览行为一字不变。
 */
export async function resolveShareMekaBinding(
  section: XdtshareMekaManifest | undefined,
  deps: { getDbClient: () => DbClient },
): Promise<ShareMekaBindingResolution> {
  if (!section) return { present: false };
  const projectId = section.projectId ?? null;
  const roleId = section.roleId ?? null;
  const legacyRole = section.legacyRole ?? null;
  const identity = { projectId, roleId, legacyRole, projectName: null, roleName: null };
  if (!projectId || !roleId) {
    // 遗留四角色会话(0.0.11 之前建的任务)在库里就只有 meka_role,没有 project/role
    // id;本机无法补出绑定,而运行期不接受只有一边的行,因此只能按普通任务降级。
    return {
      present: true,
      ...identity,
      status: 'unavailable',
      reason:
        !projectId && !roleId && legacyRole
          ? 'legacy-scope'
          : projectId
            ? 'role-missing'
            : 'project-missing',
    };
  }
  try {
    const project = await getMekaProjectById(projectId);
    if (!project) {
      return { present: true, ...identity, status: 'unavailable', reason: 'project-missing' };
    }
    const projectName = project.displayName || project.name || projectId;
    const roleRow = await deps.getDbClient().queryOne<{
      projectId: string;
      name: string;
      displayName: string;
    }>(
      'SELECT project_id AS projectId, name, display_name AS displayName FROM meka_roles WHERE id = ? LIMIT 1',
      [roleId],
    );
    if (!roleRow || roleRow.projectId !== project.id) {
      return {
        present: true,
        ...identity,
        projectName,
        status: 'unavailable',
        reason: 'role-missing',
      };
    }
    const roleName = roleRow.displayName || roleRow.name || roleId;
    let workingDir: string | null = null;
    try {
      workingDir = await resolveMekaProjectWorkspacePath(project.path, {
        readP4RootPath: async () => (await getMekaP4SettingsService().get()).p4RootPath,
      });
    } catch (error) {
      // 内置项目在未配置 P4 根目录时直接抛错——与 sessions:create 的
      // PRECONDITION_FAILED 同一条件。分享导入不阻断,降级为普通任务。
      log.info('shared meka project workspace is not configured on this machine', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!workingDir) {
      return {
        present: true,
        ...identity,
        projectName,
        roleName,
        status: 'unavailable',
        reason: 'workspace-unresolved',
      };
    }
    return {
      present: true,
      ...identity,
      projectName,
      roleName,
      status: 'bound',
      workingDir,
      // additionalPaths 只在项目配置文件里(.meka/project.json),不随包携带:
      // 导入机按本地项目配置重新取,和新建任务时 sessions:create 的合并语义一致。
      extraDirs: [
        ...new Set(
          (project.additionalPaths ?? []).filter(
            (item): item is string => typeof item === 'string' && item.trim().length > 0,
          ),
        ),
      ],
      formal: normalizeSharedFormal(section.formal),
      targetJson: section.target === undefined ? null : JSON.stringify(section.target),
    };
  } catch (error) {
    log.warn('shared meka binding resolution failed', {
      projectId,
      roleId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { present: true, ...identity, status: 'unavailable', reason: 'error' };
  }
}

/** 与 `localDb/mapper.ts` 的 `normalizeFormalSessionData` 同口径:三段缺一即不算正式流程。 */
function normalizeSharedFormal(
  section: XdtshareMekaFormalSection | null | undefined,
): FormalSessionData | null {
  if (!section) return null;
  const type = section.type.trim();
  const link = section.link.trim();
  const ref = section.ref.trim();
  if (!type || !link || !ref) return null;
  return { type, link, ref, content: section.content ?? null };
}
