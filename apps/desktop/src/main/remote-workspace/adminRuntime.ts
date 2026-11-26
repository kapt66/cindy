/**
 * 「远程工作区」管理页服务的**生产装配**（宿主依赖都在这里）。
 *
 * 服务本体（`adminService.ts`）刻意不 import Electron / DB / 真实 PSB 客户端，单测直接注入
 * 内存 fake；本文件是它唯一的宿主接线点：
 *
 *   - PSB 远程端口 → `getPsbRemoteService()` 单例（账号边界会换实例，服务自己按实例身份失效）；
 *   - 「当前打开任务」的会话行快照 → localDb（懒加载，见下）：`remoteHostId` 解析工作区，
 *     `title` / `workingDir` 是历史会话在 PSB 读不到时的固定信息种子；
 *   - 最近使用记录 + 固定信息快照 → 本机 profile 的小 JSON（单例在 `adminRecentRuntime.ts`，
 *     与 `index.ts` 的工作区会话启动写入点共用同一个实例）；
 *   - 两条推送 → `push.ts`（只发受信窗口）。
 */

import { randomUUID } from 'node:crypto';

import { createLogger } from '../logger.js';
import {
  PSB_ADMIN_RECENT_WORKSPACE_FILE,
  getPsbAdminRecentWorkspaceStore,
} from './adminRecentRuntime.js';
import {
  createPsbWorkspaceAdminService,
  type PsbAdminLocalSessionHint,
  type PsbWorkspaceAdminService,
  type PsbWorkspaceAdminServiceDeps,
} from './adminService.js';
import { getPsbRemoteService } from './index.js';
import { broadcastPsbAdminContextChanged, broadcastPsbAdminStreamEvent } from './push.js';

export { PSB_ADMIN_RECENT_WORKSPACE_FILE };

const log = createLogger('psb-remote-admin');

/**
 * 当前打开任务的 PSB 会话行快照。
 *
 * 懒加载 localDb 的会话行快照模块：本模块在启动期随 `registerPsbRemoteIpc()` 一起被求值，
 * 静态 import DB 客户端会把 `localDb` 整张模块图拉进 PSB 的加载链；真正需要读库只在
 * 管理页打开时发生。
 */
type SessionSnapshotModule = typeof import('../localDb/sessionDispatchSnapshot.js');
let sessionSnapshotModule: Promise<SessionSnapshotModule> | null = null;

async function readSessionRowSnapshot(
  localSessionId: string,
): Promise<Awaited<ReturnType<SessionSnapshotModule['getSessionRowSnapshot']>>> {
  sessionSnapshotModule ??= import('../localDb/sessionDispatchSnapshot.js');
  const { getSessionRowSnapshot } = await sessionSnapshotModule;
  return getSessionRowSnapshot(localSessionId);
}

async function readLocalSessionRemoteHostId(localSessionId: string): Promise<string | null> {
  const row = await readSessionRowSnapshot(localSessionId);
  const value = row?.remoteHostId;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * 本机会话行的固定信息线索（2026-11-26 真机事故：历史会话没有快照时也要能显示「当初是哪个
 * 工作区」）。`title` 是任务标题、`workingDir` 是 `/psb-remote/<目录名>` 虚拟路径 —— 都不是
 * PSB 工作区的权威名称，但足以让页面不退化成空态，并明确标注是降级信息。
 */
async function readLocalSessionHint(
  localSessionId: string,
): Promise<PsbAdminLocalSessionHint | null> {
  const row = await readSessionRowSnapshot(localSessionId);
  if (!row) return null;
  const remoteHostId =
    typeof row.remoteHostId === 'string' && row.remoteHostId.trim()
      ? row.remoteHostId.trim()
      : null;
  const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : null;
  const workingDir =
    typeof row.workingDir === 'string' && row.workingDir.trim() ? row.workingDir.trim() : null;
  if (!remoteHostId && !title && !workingDir) return null;
  return { remoteHostId, title, workingDir };
}

function createDefaultDeps(): PsbWorkspaceAdminServiceDeps {
  return {
    resolveRemote: () => getPsbRemoteService(),
    readLocalSessionRemoteHostId,
    readLocalSessionHint,
    // 与 `index.ts`（工作区会话启动 / 占用成功时的快照写入）共用同一个 store 实例：
    // 两个实例各自缓存整份 JSON、覆盖写，会互相丢更新。
    store: getPsbAdminRecentWorkspaceStore(),
    emitContextChanged: broadcastPsbAdminContextChanged,
    emitStreamEvent: broadcastPsbAdminStreamEvent,
    log,
    // 只有「工作区级订阅不可用 → 过渡回退到内部 Agent 会话」这一条路径会真正创建会话，
    // 所以幂等键也只为它生成（每次真正发起创建新生成一个）。
    createRequestId: () => randomUUID(),
  };
}

let adminSingleton: PsbWorkspaceAdminService | null = null;

/**
 * 进程内单例。
 *
 * 与 `getPsbRemoteService()` 同一条懒装配规则：账号边界会 dispose 掉 PSB 服务，管理页下次
 * 动作拿到的是新实例；服务内部按「PSB 服务实例身份变化」自己清空内部会话绑定与推送基线，
 * 因此这里不需要额外的账号边界钩子。
 */
export function getPsbWorkspaceAdminService(): PsbWorkspaceAdminService {
  if (!adminSingleton) adminSingleton = createPsbWorkspaceAdminService(createDefaultDeps());
  return adminSingleton;
}

/** 释放单例（账号边界 / 单测）。幂等；远端内部会话不在这里停（见 `adminService` 的 dispose）。 */
export function disposePsbWorkspaceAdminService(): void {
  const current = adminSingleton;
  adminSingleton = null;
  current?.dispose();
}
