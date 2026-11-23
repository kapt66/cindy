/**
 * 把会话工作区根解析成 Meka 助理绑定（2026-11-20）。
 *
 * 只认 Meka 项目注册表解析出的工作目录，不在这里判断 P4 等业务细节：项目路径由
 * `meka_projects` 注册项 / `resolveMekaProjectWorkspacePath` 决定。
 *
 * 规则正本：`docs/dev-rules/meka-assistant-session-binding.md` §2。
 */

import { mekaDefaultRoleId } from '../../shared/meka-projects.js';
import { normalizeWorkingDirForStorage, workingDirComparisonKey } from '../../shared/workingDir.js';
import { listMekaProjectsForRuntime } from '../localDb/ipc/mekaProjects.js';
import { createLogger } from '../logger.js';
import type {
  WorkspaceBindingResolveInput,
  WorkspaceBindingResolution,
} from '../localDb/workspaceBindingResolver.js';

const log = createLogger('meka-workspace-binding');

function pathKey(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  return workingDirComparisonKey(String(raw), { windows: process.platform === 'win32' });
}

function resolutionFor(
  project: { id: string; path?: string | null },
  workspacePath: string,
): WorkspaceBindingResolution {
  return {
    projectId: project.id,
    // 隐式路径只给默认角色；显式选择角色仍只能从桌面 Meka 创建入口进入。
    roleId: mekaDefaultRoleId(project.id),
    workspacePath,
  };
}

/**
 * 解析一个未显式绑定会话的工作区。
 *
 * - `projectDir` 是显式项目归属，优先于 `workingDir`；
 * - 只做**精确匹配**（规范化后相等），不做子目录/前缀推断；
 * - 远端工作区不解析（路径属于执行的电脑）；`agentDeviceId` 只改变 Agent 执行位置，
 *   任务工作区仍在本机，创建侧统一身份 helper 不把它传给本函数，因此仍按本机目录解析；
 * - 配置不可用的项目不参与，避免把普通任务拖进必然失败的 Meka 启动。
 */
export async function resolveMekaWorkspaceBinding(
  input: WorkspaceBindingResolveInput,
): Promise<WorkspaceBindingResolution | null> {
  if (input.remoteHostId || input.agentDeviceId) return null;

  const projectDirKey = pathKey(input.projectDir);
  const workingDirKey = pathKey(input.workingDir);
  if (!projectDirKey && !workingDirKey) return null;

  let projects: Awaited<ReturnType<typeof listMekaProjectsForRuntime>>;
  try {
    projects = await listMekaProjectsForRuntime();
  } catch (error) {
    log.warn('failed to list Meka projects for workspace binding', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const candidates = [projectDirKey, workingDirKey].filter(
    (key): key is string => key !== null,
  );
  if (candidates.length === 0) return null;

  // 候选按优先级排列：显式项目归属（projectDir）先于运行目录（workingDir）。
  // 两者同时命中不同项目时，projectDir 决定身份。
  for (const candidate of candidates) {
    for (const project of projects) {
      if (project.configUnavailable) continue;
      const workspacePath = normalizeWorkingDirForStorage(project.path);
      if (!workspacePath) continue;
      const key = pathKey(workspacePath);
      if (!key) continue;
      if (key === candidate) return resolutionFor(project, workspacePath);
    }
  }
  return null;
}
