/**
 * 「远程工作区」管理页服务的**生产装配**（宿主依赖都在这里）。
 *
 * 服务本体（`adminService.ts`）刻意不 import Electron / DB / 真实 PSB 客户端，单测直接注入
 * 内存 fake；本文件是它唯一的宿主接线点：
 *
 *   - PSB 远程端口 → `getPsbRemoteService()` 单例（账号边界会换实例，服务自己按实例身份失效）；
 *   - 「当前打开任务的 `remoteHostId`」→ localDb 的会话行快照（懒加载，见下）；
 *   - 最近使用记录 → 本机 profile 的小 JSON（原子替换 + 跨进程锁，不新增 DB 列/migration）；
 *   - 两条推送 → `push.ts`（只发受信窗口）。
 */

import { randomUUID } from 'node:crypto';

import { createLogger } from '../logger.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { userDataPath } from '../userDataPath.js';
import {
  normalizePsbAdminRecentState,
  createPsbAdminRecentWorkspaceStore,
  type PsbAdminRecentWorkspaceFile,
  type PsbAdminRecentWorkspaceIo,
  type PsbAdminRecentWorkspaceStore,
} from './adminRecentStore.js';
import {
  createPsbWorkspaceAdminService,
  type PsbWorkspaceAdminService,
  type PsbWorkspaceAdminServiceDeps,
} from './adminService.js';
import { getPsbRemoteService } from './index.js';
import { broadcastPsbAdminContextChanged, broadcastPsbAdminStreamEvent } from './push.js';

/** 本机记录文件名（`<userData>/psb-remote-workspace-admin.json`）。 */
export const PSB_ADMIN_RECENT_WORKSPACE_FILE = 'psb-remote-workspace-admin.json';

const log = createLogger('psb-remote-admin');

/**
 * 「当前打开任务的 PSB 会话」→ `remoteHostId`。
 *
 * 懒加载 localDb 的会话行快照模块：本模块在启动期随 `registerPsbRemoteIpc()` 一起被求值，
 * 静态 import DB 客户端会把 `localDb` 整张模块图拉进 PSB 的加载链；真正需要读库只在
 * 管理页打开时发生。
 */
type SessionSnapshotModule = typeof import('../localDb/sessionDispatchSnapshot.js');
let sessionSnapshotModule: Promise<SessionSnapshotModule> | null = null;

async function readLocalSessionRemoteHostId(localSessionId: string): Promise<string | null> {
  sessionSnapshotModule ??= import('../localDb/sessionDispatchSnapshot.js');
  const { getSessionRowSnapshot } = await sessionSnapshotModule;
  const row = await getSessionRowSnapshot(localSessionId);
  const value = row?.remoteHostId;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** 本机记录的读写端口（走既有的 override settings 文件：原子替换、跨进程锁、有大小上限）。 */
function createRecentWorkspaceIo(): PsbAdminRecentWorkspaceIo {
  const defaults: PsbAdminRecentWorkspaceFile = {
    lastWorkspaceId: null,
    sessions: [],
    viewers: [],
  };
  const file = createOverrideSettingsFile<PsbAdminRecentWorkspaceFile>({
    filePath: () => userDataPath(PSB_ADMIN_RECENT_WORKSPACE_FILE),
    defaults,
    normalize: (raw) => {
      const state = normalizePsbAdminRecentState(raw);
      return {
        lastWorkspaceId: state.lastWorkspaceId,
        sessions: [...state.sessions],
        viewers: [...state.viewers],
      };
    },
    log,
    label: 'psb-remote-admin',
    // 一份偏好文件不该被无界分配：容量上限在 `adminRecentStore` 里也有（32 条映射）。
    maxBytes: 64 * 1024,
  });
  return {
    read: () => {
      try {
        return file.read();
      } catch (error) {
        log.warn('psb admin: reading the recent-workspace record failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    write: (next) => {
      // 偏好写失败**不能**冒泡到管理页的读/动作路径：丢了只是「最近使用」不准，
      // 页面本身照常工作（见 `adminRecentStore` 的写纪律）。
      try {
        file.writePatch(next);
      } catch (error) {
        log.warn('psb admin: writing the recent-workspace record failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

function createRecentWorkspaceStore(): PsbAdminRecentWorkspaceStore {
  return createPsbAdminRecentWorkspaceStore(createRecentWorkspaceIo());
}

function createDefaultDeps(): PsbWorkspaceAdminServiceDeps {
  return {
    resolveRemote: () => getPsbRemoteService(),
    readLocalSessionRemoteHostId,
    store: createRecentWorkspaceStore(),
    emitContextChanged: broadcastPsbAdminContextChanged,
    emitStreamEvent: broadcastPsbAdminStreamEvent,
    log,
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
