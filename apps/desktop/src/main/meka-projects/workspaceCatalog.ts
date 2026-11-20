/**
 * 把 Meka 项目投影成「普通项目目录」条目，供 IM / 伙伴的项目清单使用。
 *
 * 外部（IM 机器人、伙伴关联项目）只认本机目录，不新增协议字段；这里只做目录投影，
 * 是否把会话升级成 Meka 助理会话由创建时的绑定解析决定。
 */

import { normalizeWorkingDirForStorage, workingDirComparisonKey } from '../../shared/workingDir.js';
import { listMekaProjectsForRuntime } from '../localDb/ipc/mekaProjects.js';
import { createLogger } from '../logger.js';

const log = createLogger('meka-workspace-catalog');

export interface MekaProjectWorkspaceEntry {
  projectId: string;
  /** 侧栏/项目清单里显示的名字（项目 displayName）。 */
  name: string;
  /** 规范化后的本机绝对目录（Meka 项目工作区根）。 */
  path: string;
  /** 没有任何活跃任务；排序时统一排在同 lastUsedAt 的项目之后。 */
  lastUsedAtMs: number;
}

/**
 * 列出可投影给外部项目清单的 Meka 项目目录。
 *
 * 配置不可用、没有目录、重复目录的项目都跳过：前者无法启动，后两者会让外部选择器
 * 出现两个同名/同目录条目。
 */
export async function listMekaProjectWorkspaceEntries(): Promise<MekaProjectWorkspaceEntry[]> {
  let projects: Awaited<ReturnType<typeof listMekaProjectsForRuntime>>;
  try {
    projects = await listMekaProjectsForRuntime();
  } catch (error) {
    log.warn('failed to list Meka projects for workspace catalog', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const seen = new Set<string>();
  const out: MekaProjectWorkspaceEntry[] = [];
  for (const project of projects) {
    if (project.configUnavailable) continue;
    const workspacePath = normalizeWorkingDirForStorage(project.path);
    if (!workspacePath) continue;
    const key = workingDirComparisonKey(workspacePath, { windows: process.platform === 'win32' });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      projectId: project.id,
      name: project.displayName?.trim() || project.name,
      path: workspacePath,
      lastUsedAtMs: 0,
    });
  }
  return out;
}
