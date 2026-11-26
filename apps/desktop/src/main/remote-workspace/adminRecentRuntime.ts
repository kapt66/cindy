/**
 * 「远程工作区」管理页本机记录的**生产装配单例**（`<userData>/psb-remote-workspace-admin.json`）。
 *
 * ## 为什么单独一个模块
 *
 * 这份记录现在有**两个写入方**：
 *
 * 1. 管理页服务（`adminService`）：实时读成功时刷新「最近使用」与固定信息快照；
 * 2. PSB 远程服务（`index.ts`）：工作区会话启动那一刻（`createSession`）与占用成功时落盘
 *    固定信息快照 —— 用户口径是「会话启动的时候这些数据就应该保存，且是固定的」。
 *
 * `index.ts` 被 `adminRuntime.ts` 依赖（管理页拿 PSB 服务），如果 `index.ts` 反过来 import
 * `adminRuntime` 就成环。所以把「文件 + store 单例 + 快照记录函数」下沉到本模块：两边都只依赖
 * 它，不互相依赖，也不会各自 `createOverrideSettingsFile` 出两个实例 —— 两个实例各自缓存整份
 * JSON、覆盖式写入，会互相丢更新。
 *
 * 走既有 `createOverrideSettingsFile`：原子替换 + 跨进程锁 + 大小上限，不新增 DB 列 / migration；
 * 读失败与写失败都只记 warn（丢了只是页面退回旧行为，不影响任务与 PSB）。
 */

import type { PsbRemoteWorkspace } from '../../shared/psb-remote-workspace.js';
import { createLogger } from '../logger.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { userDataPath } from '../userDataPath.js';
import {
  PSB_ADMIN_RECENT_STATE_VERSION,
  createPsbAdminRecentWorkspaceStore,
  normalizePsbAdminRecentState,
  type PsbAdminRecentWorkspaceFile,
  type PsbAdminRecentWorkspaceIo,
  type PsbAdminRecentWorkspaceStore,
} from './adminRecentStore.js';

/** 本机记录文件名（`<userData>/psb-remote-workspace-admin.json`）。 */
export const PSB_ADMIN_RECENT_WORKSPACE_FILE = 'psb-remote-workspace-admin.json';

const log = createLogger('psb-remote-admin');

/** 生产读写的端口（走 override settings 文件：原子替换、跨进程锁、有大小上限）。 */
function createRecentWorkspaceIo(): PsbAdminRecentWorkspaceIo {
  const defaults: PsbAdminRecentWorkspaceFile = {
    version: PSB_ADMIN_RECENT_STATE_VERSION,
    lastWorkspaceId: null,
    sessions: [],
    // JSON 键 2026-11-26 由 `viewers` 改为 `desktopSessions`：值从「内部观看端 Agent 会话」
    // 变成「桌面访问会话 id」，语义已变，按新键读即自然丢弃旧数据（见 `adminRecentStore`）。
    desktopSessions: [],
    // 固定信息快照（2026-11-26 真机事故后新增）：旧文件没有该键 → 空表。
    workspaceSnapshots: [],
  };
  const file = createOverrideSettingsFile<PsbAdminRecentWorkspaceFile>({
    filePath: () => userDataPath(PSB_ADMIN_RECENT_WORKSPACE_FILE),
    defaults,
    normalize: (raw) => {
      const state = normalizePsbAdminRecentState(raw);
      return {
        version: state.version,
        lastWorkspaceId: state.lastWorkspaceId,
        sessions: [...state.sessions],
        desktopSessions: [...state.desktopSessions],
        workspaceSnapshots: [...state.workspaceSnapshots],
      };
    },
    log,
    label: 'psb-remote-admin',
    // 一份偏好文件不该被无界分配：容量上限在 `adminRecentStore` 里也有（32 映射 / 16 快照）。
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
      // 偏好写失败**不能**冒泡到管理页的读/动作路径：丢了只是「最近使用 / 固定信息」不准，
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

let storeSingleton: PsbAdminRecentWorkspaceStore | null = null;

/**
 * 进程内单例（管理页服务与 PSB 远程服务共用）。
 *
 * 两个写入方必须共享这一个实例：`createOverrideSettingsFile` 在内存里缓存整份 JSON 并整份
 * 写回，两个实例会互相覆盖掉对方刚写的字段（最近使用 / 契约里的 `desktopSessions`）。
 */
export function getPsbAdminRecentWorkspaceStore(): PsbAdminRecentWorkspaceStore {
  if (!storeSingleton) storeSingleton = createPsbAdminRecentWorkspaceStore(createRecentWorkspaceIo());
  return storeSingleton;
}

/** 工作区固定信息的观测值（`PsbRemoteWorkspace` 的子集；便于只传需要的字段）。 */
export type PsbWorkspaceObservation = Pick<
  PsbRemoteWorkspace,
  'id' | 'title' | 'templateTitle' | 'clientName' | 'clientOnline' | 'directoryName' | 'state'
>;

/**
 * 记一次「本机看到了这个工作区的固定信息」（PSB 实时行读成功的所有写入点共用）。
 *
 * 幂等：固定字段不变时 0 次写（`savedAt` 保留最早确认的时间）。同时把「最近使用」推进到
 * 这个工作区，保证重启后没有任务打开时页面也能用快照兜底。
 */
export function recordPsbWorkspaceSeen(workspace: PsbWorkspaceObservation): void {
  try {
    const store = getPsbAdminRecentWorkspaceStore();
    store.rememberWorkspaceSnapshot({
      workspaceId: workspace.id,
      title: workspace.title,
      templateTitle: workspace.templateTitle,
      clientName: workspace.clientName,
      clientOnline: workspace.clientOnline,
      directoryName: workspace.directoryName,
      state: workspace.state,
    });
    store.rememberWorkspace(workspace.id);
  } catch (error) {
    log.warn('psb admin: recording the workspace snapshot failed', {
      workspaceId: workspace.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 记一条 `PSB 会话 → 工作区`映射（会话启动那一刻写一次）。
 *
 * 这是「PSB 读不到时用快照兜底」的关键一环：重启后本机会话行只有 `psb:<sessionId>`，
 * 靠这条映射才能找到会话当初跑在哪个工作区的快照（否则只能退化成会话标题 / 目录名）。
 */
export function recordPsbSessionWorkspace(psbSessionId: string, workspaceId: string): void {
  try {
    getPsbAdminRecentWorkspaceStore().rememberSessionWorkspace(psbSessionId, workspaceId);
  } catch (error) {
    log.warn('psb admin: recording the session-workspace mapping failed', {
      psbSessionId,
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 释放单例（测试 / 账号边界）；下一次 `getPsbAdminRecentWorkspaceStore()` 重新装配。 */
export function disposePsbAdminRecentWorkspaceStore(): void {
  storeSingleton = null;
}
