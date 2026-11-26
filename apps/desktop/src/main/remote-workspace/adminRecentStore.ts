/**
 * 「远程工作区」管理页的**本机记录**：最近使用过的工作区 + `PSB 会话 → 工作区`映射 +
 * 每个工作区自己的**内部观看端会话 id**。
 *
 * ## 落点与为什么是这样
 *
 * 落点是本机 profile 的一个小 JSON（生产实现在 `adminRuntime.ts`，走既有的
 * `createOverrideSettingsFile`：原子替换 + 跨进程锁，不新增 DB 列、不需要 migration）。
 *
 * 为什么必须落盘：管理页是**工作区级**、与用户任务解耦。解开「当前打开的任务」之后，
 * 「管理哪个工作区」就必须有一个与任务无关的来源，否则重启后没有任何线索，页面只能退化成
 * 空提示态。为什么不用 DB 新列：加列要 migration（会阻断 dev 实例，也让发版多一道协调），
 * 而这份记录是**可丢的展示偏好** —— 丢了只是回到空提示态，不会损坏用户数据。
 *
 * ## 三条记录各自的用途
 *
 * 1. `lastWorkspaceId`：没有远程任务（或任务不是远程的）时页面的默认对象。
 * 2. `sessions[psbSessionId] = workspaceId`：当前任务的 PSB 会话**读不到时**（终态后 PSB
 *    可能直接 404/403，记录已清）仍然能回答「这个任务属于哪个工作区」。这张表有上限
 *    （`PSB_ADMIN_RECENT_SESSION_LIMIT`），最近的排前面、超出淘汰最旧的 —— 用户数据的量级
 *    不该让这个文件无限增长。
 * 3. `viewers[workspaceId] = viewerSessionId`：该工作区**我们自己创建的内部观看端会话** id。
 *    这是「重启后复用同一条内部会话」的唯一依据：PSB 的 `listSessions(workspaceId)` 会返回
 *    同工作区**其他人**的会话，按标题前缀认领会认到别人的会话上（审查发现），所以绝不能
 *    再按标题认领；只认这里记下的 id。
 *
 * ## 写纪律
 *
 * 所有写入口**幂等且只在值变化时落盘**。管理页的读路径（`adminContext`）确实会调用一次
 * `rememberWorkspace`（否则「最近使用」永远不会更新，页面是只读的），但值不变时 0 次写，
 * 因此写次数**不随轮询/刷新次数增长**，符合工程约定 §8.2 的意图。读路径**不会**创建 PSB
 * 会话、也不会占用工作区（2026-11-26 审查：写前占用闸门落地后，读路径建会话 = 打开页签就
 * 静默占用空闲工作区）。
 */

/** 会话映射表的容量上限。用户切换工作区的频率远到不了这里。 */
export const PSB_ADMIN_RECENT_SESSION_LIMIT = 32;

/** 观看端会话映射的容量上限（一个工作区一条；多设备 / 多工作区来回用也远到不了）。 */
export const PSB_ADMIN_RECENT_VIEWER_LIMIT = 16;

/** 一条 `PSB 会话 → 工作区`记录。 */
export interface PsbAdminSessionEntry {
  readonly sessionId: string;
  readonly workspaceId: string;
}

/** 一条 `工作区 → 内部观看端 PSB 会话`记录（只记我们自己创建的那些）。 */
export interface PsbAdminViewerEntry {
  readonly workspaceId: string;
  readonly sessionId: string;
}

/** 管理页的本机记录（`sessions` / `viewers` 最近的在最前）。 */
export interface PsbAdminRecentWorkspaceState {
  readonly lastWorkspaceId: string | null;
  readonly sessions: readonly PsbAdminSessionEntry[];
  readonly viewers: readonly PsbAdminViewerEntry[];
}

/** 落盘用的扁平形状（生产实现在读回时交给 `normalizePsbAdminRecentState`）。 */
export interface PsbAdminRecentWorkspaceFile {
  lastWorkspaceId: string | null;
  sessions: PsbAdminSessionEntry[];
  viewers: PsbAdminViewerEntry[];
}

/** 读写本机文件的端口（生产 = `createOverrideSettingsFile`；单测注入内存实现）。 */
export interface PsbAdminRecentWorkspaceIo {
  /** 读已存的原始值；文件不存在 / 解析失败时返回 `null`（不要把错误抛给调用方）。 */
  read(): unknown;
  /** 覆盖写整份记录。 */
  write(next: PsbAdminRecentWorkspaceFile): void;
}

export interface PsbAdminRecentWorkspaceStore {
  read(): PsbAdminRecentWorkspaceState;
  /** 该 PSB 会话已知属于哪个工作区（不知道时 `null`）。 */
  workspaceIdForSession(psbSessionId: string): string | null;
  /** 记一个最近使用的工作区（值不变时 0 次写）。 */
  rememberWorkspace(workspaceId: string): void;
  /** 记一条会话→工作区映射（同值时 0 次写；超出上限淘汰最旧）。 */
  rememberSessionWorkspace(psbSessionId: string, workspaceId: string): void;
  /** 该工作区自己那条内部观看端会话 id（没记过 / 已清掉时 `null`）。 */
  viewerSessionIdForWorkspace(workspaceId: string): string | null;
  /** 记该工作区的内部观看端会话 id（同值时 0 次写；超出上限淘汰最旧）。 */
  rememberViewerSession(workspaceId: string, sessionId: string): void;
  /** 该内部观看端会话已终态 / 已不存在：丢掉记录，下一次启动会重新找/建。 */
  forgetViewerSession(workspaceId: string): void;
  /** 工作区已不可见（被删 / 无权限）：丢掉指向它的记录。 */
  forgetWorkspace(workspaceId: string): void;
}

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/**
 * 把任意原始值收敛成安全记录：坏数据当空、按 `sessionId` / `workspaceId` 去重（先出现的优先，
 * 因为写入时最近的在前）、超出上限截断。**不抛异常** —— 一份偏好文件读坏不该让页面开不出来。
 */
export function normalizePsbAdminRecentState(raw: unknown): PsbAdminRecentWorkspaceState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { lastWorkspaceId: null, sessions: [], viewers: [] };
  }
  const record = raw as Record<string, unknown>;
  const list = Array.isArray(record['sessions']) ? record['sessions'] : [];
  const seen = new Set<string>();
  const sessions: PsbAdminSessionEntry[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const sessionId = trimmed(row['sessionId']);
    const workspaceId = trimmed(row['workspaceId']);
    if (!sessionId || !workspaceId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    sessions.push({ sessionId, workspaceId });
    if (sessions.length >= PSB_ADMIN_RECENT_SESSION_LIMIT) break;
  }
  const viewerList = Array.isArray(record['viewers']) ? record['viewers'] : [];
  const seenWorkspaces = new Set<string>();
  const viewers: PsbAdminViewerEntry[] = [];
  for (const entry of viewerList) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const workspaceId = trimmed(row['workspaceId']);
    const sessionId = trimmed(row['sessionId']);
    if (!workspaceId || !sessionId || seenWorkspaces.has(workspaceId)) continue;
    seenWorkspaces.add(workspaceId);
    viewers.push({ workspaceId, sessionId });
    if (viewers.length >= PSB_ADMIN_RECENT_VIEWER_LIMIT) break;
  }
  return { lastWorkspaceId: trimmed(record['lastWorkspaceId']), sessions, viewers };
}

/** 读/写都经端口的记录实现；所有方法同步（一次管理页 invoke 内不会并发）。 */
export function createPsbAdminRecentWorkspaceStore(
  io: PsbAdminRecentWorkspaceIo,
): PsbAdminRecentWorkspaceStore {
  function read(): PsbAdminRecentWorkspaceState {
    try {
      return normalizePsbAdminRecentState(io.read());
    } catch {
      // 端口实现本该自己吞掉错误；这里再兜一层，保证读路径不会因为偏好文件而失败。
      return { lastWorkspaceId: null, sessions: [], viewers: [] };
    }
  }

  function persist(next: PsbAdminRecentWorkspaceState): void {
    io.write({
      lastWorkspaceId: next.lastWorkspaceId,
      sessions: [...next.sessions],
      viewers: [...next.viewers],
    });
  }

  return {
    read,
    workspaceIdForSession(psbSessionId) {
      const key = psbSessionId.trim();
      if (!key) return null;
      return read().sessions.find((entry) => entry.sessionId === key)?.workspaceId ?? null;
    },
    rememberWorkspace(workspaceId) {
      const next = trimmed(workspaceId);
      if (!next) return;
      const current = read();
      if (current.lastWorkspaceId === next) return;
      persist({ lastWorkspaceId: next, sessions: current.sessions, viewers: current.viewers });
    },
    rememberSessionWorkspace(psbSessionId, workspaceId) {
      const sessionId = trimmed(psbSessionId);
      const target = trimmed(workspaceId);
      if (!sessionId || !target) return;
      const current = read();
      if (current.sessions.find((entry) => entry.sessionId === sessionId)?.workspaceId === target) {
        return;
      }
      const sessions = [
        { sessionId, workspaceId: target },
        ...current.sessions.filter((entry) => entry.sessionId !== sessionId),
      ].slice(0, PSB_ADMIN_RECENT_SESSION_LIMIT);
      persist({ lastWorkspaceId: current.lastWorkspaceId, sessions, viewers: current.viewers });
    },
    viewerSessionIdForWorkspace(workspaceId) {
      const key = trimmed(workspaceId);
      if (!key) return null;
      return read().viewers.find((entry) => entry.workspaceId === key)?.sessionId ?? null;
    },
    rememberViewerSession(workspaceId, sessionId) {
      const target = trimmed(workspaceId);
      const viewer = trimmed(sessionId);
      if (!target || !viewer) return;
      const current = read();
      if (current.viewers.find((entry) => entry.workspaceId === target)?.sessionId === viewer) return;
      const viewers = [
        { workspaceId: target, sessionId: viewer },
        ...current.viewers.filter((entry) => entry.workspaceId !== target),
      ].slice(0, PSB_ADMIN_RECENT_VIEWER_LIMIT);
      persist({ lastWorkspaceId: current.lastWorkspaceId, sessions: current.sessions, viewers });
    },
    forgetViewerSession(workspaceId) {
      const target = trimmed(workspaceId);
      if (!target) return;
      const current = read();
      const viewers = current.viewers.filter((entry) => entry.workspaceId !== target);
      if (viewers.length === current.viewers.length) return;
      persist({ lastWorkspaceId: current.lastWorkspaceId, sessions: current.sessions, viewers });
    },
    forgetWorkspace(workspaceId) {
      const target = trimmed(workspaceId);
      if (!target) return;
      const current = read();
      const sessions = current.sessions.filter((entry) => entry.workspaceId !== target);
      const viewers = current.viewers.filter((entry) => entry.workspaceId !== target);
      const lastWorkspaceId = current.lastWorkspaceId === target ? null : current.lastWorkspaceId;
      if (
        sessions.length === current.sessions.length &&
        viewers.length === current.viewers.length &&
        lastWorkspaceId === current.lastWorkspaceId
      ) {
        return;
      }
      persist({ lastWorkspaceId, sessions, viewers });
    },
  };
}
