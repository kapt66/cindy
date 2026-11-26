/**
 * 「远程工作区」管理页的**本机记录**：最近使用过的工作区 + `PSB 会话 → 工作区`映射 +
 * 每个工作区自己的**观看端绑定会话**（正常 = 桌面访问会话 id）+ 每个工作区的**固定信息快照**
 * （2026-11-26 真机事故后新增）。
 *
 * ## 落点与为什么是这样
 *
 * 落点是本机 profile 的一个小 JSON（生产实现在 `adminRecentRuntime.ts`，走既有的
 * `createOverrideSettingsFile`：原子替换 + 跨进程锁，不新增 DB 列、不需要 migration）。
 *
 * 为什么必须落盘：管理页是**工作区级**、与用户任务解耦。解开「当前打开的任务」之后，
 * 「管理哪个工作区」就必须有一个与任务无关的来源，否则重启后没有任何线索，页面只能退化成
 * 空提示态。为什么不用 DB 新列：加列要 migration（会阻断 dev 实例，也让发版多一道协调），
 * 而这份记录是**可丢的展示偏好** —— 丢了只是回到空提示态，不会损坏用户数据。
 *
 * ## 四条记录各自的用途
 *
 * 1. `lastWorkspaceId`：没有远程任务（或任务不是远程的）时页面的默认对象。
 * 2. `sessions[psbSessionId] = workspaceId`：当前任务的 PSB 会话**读不到时**（终态后 PSB
 *    可能直接 404/403，记录已清）仍然能回答「这个任务属于哪个工作区」。这张表有上限
 *    （`PSB_ADMIN_RECENT_SESSION_LIMIT`），最近的排前面、超出淘汰最旧的。
 * 3. `desktopSessions[workspaceId] = sessionId`：该工作区**观看端当前绑定**的会话 id。
 *    正常形态是 PSB 工作区级 `stream/subscribe` 返回的**桌面访问会话** id（不是 agent 会话），
 *    观看端 WS 与 `stream/status` 都按它走；过渡回退（旧 PSB）时是内部 Agent 会话 id。
 *
 *    为什么必须落盘：`stream/status` 挂在会话路径上，读「桌面会话状态」必须有一条会话 id。
 *    应用重启后内存绑定全丢，只有本机记录能让页面**只读**地问一次 PSB，而不必为了读状态去
 *    订阅 / 建会话（那会顺带占用名额、旧实现还会建出用户不需要的 Agent 会话）。
 *
 *    > **2026-11-26 语义变更**：JSON 键由 `viewers` 改为 `desktopSessions`，值也从「我们自己
 *    > 创建的内部观看端 Agent 会话」变成「桌面访问会话」。旧值指向已废弃的绕行会话，按新键
 *    > 读即自然丢弃 —— 不迁移、不复用旧 Agent 会话（那份数据正是用户事故里不该存在的行）。
 *
 * 4. `workspaceSnapshots[workspaceId]`（2026-11-26 真机事故后新增）：该工作区的**固定信息**
 *    快照（名称 / 模板 / 机器名 / 目录名 / PSB 状态词）。用户口径：这些信息在会话启动时是
 *    固定的、不会有变更；但设备会掉线、工作区会被移除，所以不能只靠服务器即时读取。写入点
 *    是「PSB 实时行读成功」（`adminContext` / `createSession` / 占用成功）；读不到时
 *    `adminService` 用快照构造 `stale: true` 的上下文，页头照旧显示固定信息，**只有本机完全
 *    没有快照才回到空提示态**。
 *
 *    > 只存固定字段，**不存占用 / 在线 / 桌面会话**这类易变状态：stale 时界面要显示
 *    > 「无法获取」，把过期占用者当成事实比空着更糟。`clientOnline` 只作诊断保存，stale 时
 *    > 不作为展示事实。
 *
 * ## 写纪律
 *
 * 所有写入口**幂等且只在值变化时落盘**。管理页的读路径（`adminContext`）确实会调用一次
 * `rememberWorkspace`（否则「最近使用」永远不会更新，页面是只读的），但值不变时 0 次写，
 * 因此写次数**不随轮询/刷新次数增长**，符合工程约定 §8.2 的意图。快照写入同理：30s 轮询里
 * 固定信息不变就 0 次写（`savedAt` 保留第一次确认的时间）。读路径**不会**创建 PSB
 * 会话、**不订阅**、也不会占用工作区（2026-11-26 审查：写前占用闸门落地后，读路径建会话 =
 * 打开页签就静默占用空闲工作区）。
 */

/** 记录 schema 版本（加性字段；旧文件没有 `version` 时按当前版本读，不迁移不丢数据）。 */
export const PSB_ADMIN_RECENT_STATE_VERSION = 1;

/** 会话映射表的容量上限。用户切换工作区的频率远到不了这里。 */
export const PSB_ADMIN_RECENT_SESSION_LIMIT = 32;

/** 观看端绑定映射的容量上限（一个工作区一条；多设备 / 多工作区来回用也远到不了）。 */
export const PSB_ADMIN_RECENT_DESKTOP_SESSION_LIMIT = 16;

/** 固定信息快照的容量上限（一个工作区一条；超出淘汰最久没确认的那条）。 */
export const PSB_ADMIN_WORKSPACE_SNAPSHOT_LIMIT = 16;

/** 一条 `PSB 会话 → 工作区`记录。 */
export interface PsbAdminSessionEntry {
  readonly sessionId: string;
  readonly workspaceId: string;
}

/** 一条 `工作区 → 观看端绑定会话`记录（桌面访问会话 id；过渡回退时是内部 Agent 会话 id）。 */
export interface PsbAdminDesktopSessionEntry {
  readonly workspaceId: string;
  readonly sessionId: string;
}

/**
 * 一个工作区的**固定信息**快照（2026-11-26 真机事故后新增）。
 *
 * 只存工作区创建后不再变化的字段；**不存**占用 / 在线 / 桌面会话这类易变状态（stale 时
 * 界面显示「无法获取」，不能把过期状态当事实）。
 */
export interface PsbAdminWorkspaceSnapshot {
  readonly workspaceId: string;
  /** PSB 工作区 title（例如 `saga2_project`）；老历史数据里可能退化成会话标题。 */
  readonly title: string;
  readonly templateTitle: string | null;
  readonly clientName: string;
  /** 写快照时 PSB 说机器在不在线；`null` = 当时也没读到。只作诊断，stale 时不当展示事实。 */
  readonly clientOnline: boolean | null;
  readonly directoryName: string | null;
  readonly state: string | null;
  /** 本机落盘时间（ISO 8601）。固定字段不变时**不刷新** —— 它表示这份信息何时被确认。 */
  readonly savedAt: string;
}

/** 写一条固定信息快照的输入（`savedAt` 缺省 = 现在；单测可注入固定时间）。 */
export interface PsbAdminWorkspaceSnapshotInput {
  readonly workspaceId: string;
  readonly title: string;
  readonly templateTitle?: string | null;
  readonly clientName: string;
  readonly clientOnline?: boolean | null;
  readonly directoryName?: string | null;
  readonly state?: string | null;
  readonly savedAt?: string;
}

/** 管理页的本机记录（`sessions` / `desktopSessions` / `workspaceSnapshots` 最近的在最前）。 */
export interface PsbAdminRecentWorkspaceState {
  readonly version: number;
  readonly lastWorkspaceId: string | null;
  readonly sessions: readonly PsbAdminSessionEntry[];
  readonly desktopSessions: readonly PsbAdminDesktopSessionEntry[];
  readonly workspaceSnapshots: readonly PsbAdminWorkspaceSnapshot[];
}

/** 落盘用的扁平形状（生产实现在读回时交给 `normalizePsbAdminRecentState`）。 */
export interface PsbAdminRecentWorkspaceFile {
  /** 旧文件没有该字段（按当前版本读）；写入时总会带上。 */
  version?: number;
  lastWorkspaceId: string | null;
  sessions: PsbAdminSessionEntry[];
  desktopSessions: PsbAdminDesktopSessionEntry[];
  workspaceSnapshots?: PsbAdminWorkspaceSnapshot[];
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
  /** 该工作区观看端绑定的会话 id（桌面访问会话；没记过 / 已清掉时 `null`）。 */
  desktopSessionIdForWorkspace(workspaceId: string): string | null;
  /** 记该工作区的观看端绑定会话（同值时 0 次写；超出上限淘汰最旧）。 */
  rememberDesktopSession(workspaceId: string, sessionId: string): void;
  /** 该工作区的**固定信息快照**（没记过 / 已淘汰时 `null`）。 */
  workspaceSnapshot(workspaceId: string): PsbAdminWorkspaceSnapshot | null;
  /** 按目录名找固定信息快照（历史会话兜底：`/psb-remote/<目录>` 能对上同一个工作区）。 */
  workspaceSnapshotByDirectoryName(directoryName: string): PsbAdminWorkspaceSnapshot | null;
  /** 最近确认过的那条固定信息快照（连「最近使用」都没有时的最后兜底）。 */
  latestWorkspaceSnapshot(): PsbAdminWorkspaceSnapshot | null;
  /**
   * 记一条工作区固定信息快照（同值 0 次写；超出上限淘汰最旧）。
   *
   * @returns 是否真的落盘（`false` = 值没变 / 输入不可用）。
   */
  rememberWorkspaceSnapshot(input: PsbAdminWorkspaceSnapshotInput): boolean;
  /**
   * 丢掉指向该工作区的**易变**记录（会话映射 + 观看端绑定），**保留** `lastWorkspaceId` 与
   * 固定信息快照。
   *
   * 注意管理页「工作区已不可见」的路径目前只清观看端绑定（`forgetDesktopSession`）：
   * `会话→工作区`映射是「这个任务当初在哪个工作区」的历史事实，留着它下次解析才能找回
   * 快照并继续显示（见 `adminService` 的 stale 口径）。本方法留给需要更彻底清理易变记录
   * 的调用方（例如以后确认账号边界不可恢复时）。
   */
  forgetWorkspaceVolatile(workspaceId: string): void;
  /** 绑定已失效（桌面访问会话被重建 / 已不存在）：丢掉记录，下一次启动会重新订阅。 */
  forgetDesktopSession(workspaceId: string): void;
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
 *
 * 只认新键 `desktopSessions`：旧版本的 `viewers`（内部观看端 Agent 会话）不读、不迁移，
 * 语义已经作废（见文件头）。
 *
 * `workspaceSnapshots` 是加性字段：旧文件没有它 → 空表（页面回到「没有快照」的旧行为，
 * 下一次实时读取会重新写入）；单条坏行只丢那一行，不影响其它记录。
 */
export function normalizePsbAdminRecentState(raw: unknown): PsbAdminRecentWorkspaceState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      version: PSB_ADMIN_RECENT_STATE_VERSION,
      lastWorkspaceId: null,
      sessions: [],
      desktopSessions: [],
      workspaceSnapshots: [],
    };
  }
  const record = raw as Record<string, unknown>;
  const rawVersion = record['version'];
  const version =
    typeof rawVersion === 'number' && Number.isFinite(rawVersion) && rawVersion > 0
      ? Math.trunc(rawVersion)
      : PSB_ADMIN_RECENT_STATE_VERSION;
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
  const bindingList = Array.isArray(record['desktopSessions']) ? record['desktopSessions'] : [];
  const seenWorkspaces = new Set<string>();
  const desktopSessions: PsbAdminDesktopSessionEntry[] = [];
  for (const entry of bindingList) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const workspaceId = trimmed(row['workspaceId']);
    const sessionId = trimmed(row['sessionId']);
    if (!workspaceId || !sessionId || seenWorkspaces.has(workspaceId)) continue;
    seenWorkspaces.add(workspaceId);
    desktopSessions.push({ workspaceId, sessionId });
    if (desktopSessions.length >= PSB_ADMIN_RECENT_DESKTOP_SESSION_LIMIT) break;
  }
  const snapshotList = Array.isArray(record['workspaceSnapshots'])
    ? record['workspaceSnapshots']
    : [];
  const seenSnapshotWorkspaces = new Set<string>();
  const workspaceSnapshots: PsbAdminWorkspaceSnapshot[] = [];
  for (const entry of snapshotList) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    // 固定信息快照按 `workspaceId` 幂等：同 id 只保留第一条（最近确认的在最前）。
    const workspaceId = trimmed(row['workspaceId']);
    const title = typeof row['title'] === 'string' ? row['title'] : null;
    const clientName = typeof row['clientName'] === 'string' ? row['clientName'] : null;
    if (!workspaceId || title === null || clientName === null) continue;
    if (!title.trim() && !clientName.trim()) continue;
    if (seenSnapshotWorkspaces.has(workspaceId)) continue;
    seenSnapshotWorkspaces.add(workspaceId);
    const clientOnline =
      typeof row['clientOnline'] === 'boolean' ? row['clientOnline'] : null;
    workspaceSnapshots.push({
      workspaceId,
      title: title.trim(),
      templateTitle: trimmed(row['templateTitle']),
      clientName: clientName.trim(),
      clientOnline,
      directoryName: trimmed(row['directoryName']),
      state: trimmed(row['state']),
      savedAt: trimmed(row['savedAt']) ?? new Date(0).toISOString(),
    });
    if (workspaceSnapshots.length >= PSB_ADMIN_WORKSPACE_SNAPSHOT_LIMIT) break;
  }
  return {
    version,
    lastWorkspaceId: trimmed(record['lastWorkspaceId']),
    sessions,
    desktopSessions,
    workspaceSnapshots,
  };
}

/** 读/写都经端口的记录实现；所有方法同步（一次管理页 invoke 内不会并发）。 */
export function createPsbAdminRecentWorkspaceStore(
  io: PsbAdminRecentWorkspaceIo,
): PsbAdminRecentWorkspaceStore {
  function emptyState(): PsbAdminRecentWorkspaceState {
    return {
      version: PSB_ADMIN_RECENT_STATE_VERSION,
      lastWorkspaceId: null,
      sessions: [],
      desktopSessions: [],
      workspaceSnapshots: [],
    };
  }

  function read(): PsbAdminRecentWorkspaceState {
    try {
      return normalizePsbAdminRecentState(io.read());
    } catch {
      // 端口实现本该自己吞掉错误；这里再兜一层，保证读路径不会因为偏好文件而失败。
      return emptyState();
    }
  }

  function persist(next: PsbAdminRecentWorkspaceState): void {
    // 每次写整份记录（`createOverrideSettingsFile` 的 `writePatch` 是覆盖写）：漏一个字段
    // 就会把该字段的数据静默清空，所以这里显式列全（含加性字段）。
    io.write({
      version: PSB_ADMIN_RECENT_STATE_VERSION,
      lastWorkspaceId: next.lastWorkspaceId,
      sessions: [...next.sessions],
      desktopSessions: [...next.desktopSessions],
      workspaceSnapshots: [...next.workspaceSnapshots],
    });
  }

  /** 把任意输入收敛成固定信息快照；没有可展示的固定字段时返回 `null`（不值得占容量）。 */
  function normalizeSnapshot(
    input: PsbAdminWorkspaceSnapshotInput,
  ): PsbAdminWorkspaceSnapshot | null {
    const workspaceId = trimmed(input.workspaceId);
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const clientName = typeof input.clientName === 'string' ? input.clientName.trim() : '';
    if (!workspaceId || (!title && !clientName)) return null;
    return {
      workspaceId,
      title,
      templateTitle: trimmed(input.templateTitle ?? null),
      clientName,
      clientOnline: typeof input.clientOnline === 'boolean' ? input.clientOnline : null,
      directoryName: trimmed(input.directoryName ?? null),
      state: trimmed(input.state ?? null),
      savedAt: trimmed(input.savedAt ?? null) ?? new Date().toISOString(),
    };
  }

  /** 固定字段是否相同（相同 = 不落盘，保留原来的 `savedAt`）。 */
  function sameSnapshotFields(
    left: PsbAdminWorkspaceSnapshot,
    right: PsbAdminWorkspaceSnapshot,
  ): boolean {
    return (
      left.title === right.title &&
      left.templateTitle === right.templateTitle &&
      left.clientName === right.clientName &&
      left.clientOnline === right.clientOnline &&
      left.directoryName === right.directoryName &&
      left.state === right.state
    );
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
      persist({ ...current, lastWorkspaceId: next });
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
      persist({ ...current, sessions });
    },
    desktopSessionIdForWorkspace(workspaceId) {
      const key = trimmed(workspaceId);
      if (!key) return null;
      return (
        read().desktopSessions.find((entry) => entry.workspaceId === key)?.sessionId ?? null
      );
    },
    rememberDesktopSession(workspaceId, sessionId) {
      const target = trimmed(workspaceId);
      const session = trimmed(sessionId);
      if (!target || !session) return;
      const current = read();
      if (
        current.desktopSessions.find((entry) => entry.workspaceId === target)?.sessionId === session
      ) {
        return;
      }
      const desktopSessions = [
        { workspaceId: target, sessionId: session },
        ...current.desktopSessions.filter((entry) => entry.workspaceId !== target),
      ].slice(0, PSB_ADMIN_RECENT_DESKTOP_SESSION_LIMIT);
      persist({ ...current, desktopSessions });
    },
    workspaceSnapshot(workspaceId) {
      const key = trimmed(workspaceId);
      if (!key) return null;
      return read().workspaceSnapshots.find((entry) => entry.workspaceId === key) ?? null;
    },
    workspaceSnapshotByDirectoryName(directoryName) {
      const key = trimmed(directoryName);
      if (!key) return null;
      return read().workspaceSnapshots.find((entry) => entry.directoryName === key) ?? null;
    },
    latestWorkspaceSnapshot() {
      return read().workspaceSnapshots[0] ?? null;
    },
    rememberWorkspaceSnapshot(input) {
      const snapshot = normalizeSnapshot(input);
      if (!snapshot) return false;
      const current = read();
      const existing =
        current.workspaceSnapshots.find((entry) => entry.workspaceId === snapshot.workspaceId) ??
        null;
      // 固定信息没变 = 0 次写：30s 轮询 / 反复打开页面不会造成写放大（写纪律见文件头）。
      if (existing && sameSnapshotFields(existing, snapshot)) return false;
      const workspaceSnapshots = [
        snapshot,
        ...current.workspaceSnapshots.filter(
          (entry) => entry.workspaceId !== snapshot.workspaceId,
        ),
      ].slice(0, PSB_ADMIN_WORKSPACE_SNAPSHOT_LIMIT);
      persist({ ...current, workspaceSnapshots });
      return true;
    },
    forgetWorkspaceVolatile(workspaceId) {
      const target = trimmed(workspaceId);
      if (!target) return;
      const current = read();
      const sessions = current.sessions.filter((entry) => entry.workspaceId !== target);
      const desktopSessions = current.desktopSessions.filter(
        (entry) => entry.workspaceId !== target,
      );
      if (
        sessions.length === current.sessions.length &&
        desktopSessions.length === current.desktopSessions.length
      ) {
        return;
      }
      persist({ ...current, sessions, desktopSessions });
    },
    forgetDesktopSession(workspaceId) {
      const target = trimmed(workspaceId);
      if (!target) return;
      const current = read();
      const desktopSessions = current.desktopSessions.filter(
        (entry) => entry.workspaceId !== target,
      );
      if (desktopSessions.length === current.desktopSessions.length) return;
      persist({ ...current, desktopSessions });
    },
    forgetWorkspace(workspaceId) {
      const target = trimmed(workspaceId);
      if (!target) return;
      const current = read();
      const sessions = current.sessions.filter((entry) => entry.workspaceId !== target);
      const desktopSessions = current.desktopSessions.filter(
        (entry) => entry.workspaceId !== target,
      );
      const lastWorkspaceId = current.lastWorkspaceId === target ? null : current.lastWorkspaceId;
      if (
        sessions.length === current.sessions.length &&
        desktopSessions.length === current.desktopSessions.length &&
        lastWorkspaceId === current.lastWorkspaceId
      ) {
        return;
      }
      // 固定信息快照**不删**：工作区被删 / 无权限时页面仍要显示「当初是哪个工作区」。
      persist({ ...current, lastWorkspaceId, sessions, desktopSessions });
    },
  };
}
