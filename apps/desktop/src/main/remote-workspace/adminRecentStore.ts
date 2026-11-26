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
 * ## schema 演进（没有 `version` 字段，加性演进）
 *
 * 这份文件曾带一个顶层 `version`，但它**永远落不了盘**：写路径是 `createOverrideSettingsFile`
 * 的 `writePatch`，它会删掉与默认值相等的键，而 `version` 恒等于默认值（2026-11-26 审查）。
 * 一个「写了但永远读不到」的字段比没有更糟：它会让后来的人以为可以靠它做迁移。
 *
 * 现在的规则：**加性演进** ——
 *   - 新字段必须是可选的、读取方按「缺省 = 旧行为」归一（`workspaceSnapshots` 就是这样加的）；
 *   - 已有键的语义不得复用（语义变了就换新键，旧键不再读，例如 `viewers` → `desktopSessions`）；
 *   - 单条坏行只丢那一行，读坏整份文件回空记录，**不抛异常**；
 *   - 需要真正不兼容的迁移时再引入显式版本标记，并且必须是一个**与默认值不同**的键
 *     （否则又会被 `writePatch` 删掉）。
 *
 * ## 四条记录各自的用途
 *
 * 1. `lastWorkspaceId`：没有远程任务（或任务不是远程的）时页面的默认对象。
 * 2. `sessions[psbSessionId] = workspaceId`：当前任务的 PSB 会话**读不到时**（终态后 PSB
 *    可能直接 404/403，记录已清）仍然能回答「这个任务属于哪个工作区」。这张表有上限
 *    （`PSB_ADMIN_RECENT_SESSION_LIMIT`），最近的排前面、超出淘汰最旧的。
 *    **只在会话详情读成功时写入**：按目录名 / 标题的启发式匹配只留在内存（见 `adminService`），
 *    猜错了会被持久化成「这个任务永远属于那个工作区」，代价远大于一次列表请求。
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
 *    快照（名称 / 模板 / 机器名 / 目录名）。用户口径：这些信息在会话启动时是固定的、不会有
 *    变更；但设备会掉线、工作区会被移除，所以不能只靠服务器即时读取。写入点是「PSB 实时行
 *    读成功」（`adminContext` / `createSession` / 占用成功）；读不到时 `adminService` 用快照
 *    构造 `stale: true` 的上下文，页头照旧显示固定信息，**只有本机完全没有快照才回到空提示态**。
 *
 *    > **只存固定字段**（2026-11-26 审查修正）：旧实现把 `clientOnline` / `state` 也存进快照，
 *    > 结果这两个**每 30 秒都可能变**的字段被拿去参与「值没变就不写」的比较 —— 比较永远不等，
 *    > 每次读页面都整份重写文件。在线 / 工作区状态是**状态信息**，stale 时界面要显示「无法获取」，
 *    > 把过期值当事实比空着更糟，所以快照里不再有它们；`adminService` 的 stale 上下文也不再用。
 *
 *    > **两个时间分开**：`savedAt` = 这条快照第一次落盘（创建）的时间，`confirmedAt` = 最近一次
 *    > 落盘时固定信息被 PSB 确认的时间（固定字段变化会重写并推进它）。排序 / 「最近确认」一律用
 *    > `confirmedAt`，展示用的「保存在本机的时间」用 `savedAt`。坏行（两个时间都不可解析）直接
 *    > 丢弃，**不伪造 1970-01-01**：伪造出来的时间会让它被当成「最近确认」抢到兜底位。
 *
 * ## 写纪律
 *
 * 所有写入口**幂等且只在值变化时落盘**。管理页的读路径（`adminContext`）确实会调用一次
 * `rememberWorkspace`（否则「最近使用」永远不会更新，页面是只读的），但值不变时 0 次写，
 * 因此写次数**不随轮询/刷新次数增长**，符合工程约定 §8.2 的意图。快照写入同理：固定信息
 * 不变就 0 次写（`confirmedAt` 只在真正写盘的那一次推进，排序仍然以它为准）。读路径**不会**
 * 创建 PSB 会话、**不订阅**、也不会占用工作区（2026-11-26 审查：写前占用闸门落地后，读路径
 * 建会话 = 打开页签就静默占用空闲工作区）。
 */

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
  /** PSB 工作区 title（例如 `saga2_project`）。 */
  readonly title: string;
  readonly templateTitle: string | null;
  readonly clientName: string;
  readonly directoryName: string | null;
  /** 这条快照第一次落盘的时间（ISO 8601）；后续重写**不推进**它。 */
  readonly savedAt: string;
  /**
   * 固定信息最近一次被 PSB 确认（= 最近一次真正写盘）的时间（ISO 8601）。
   *
   * 与 `savedAt` 分开：固定字段变化 / 目录名首次拿到时会重写快照并推进它，而 `savedAt`
   * 始终是「这份记录什么时候开始存在」。排序与「最近确认」用这个字段。
   */
  readonly confirmedAt: string;
}

/** 写一条固定信息快照的输入（时间缺省 = 现在；单测可注入固定时间）。 */
export interface PsbAdminWorkspaceSnapshotInput {
  readonly workspaceId: string;
  readonly title: string;
  readonly templateTitle?: string | null;
  readonly clientName: string;
  readonly directoryName?: string | null;
  /** 第一次落盘时间（缺省 = 现在；已存在时以内存的 `savedAt` 为准）。 */
  readonly savedAt?: string;
  /** 本次确认时间（缺省 = `savedAt`，再缺省 = 现在）。 */
  readonly confirmedAt?: string;
}

/** 管理页的本机记录（`sessions` / `desktopSessions` / `workspaceSnapshots` 最近的在最前）。 */
export interface PsbAdminRecentWorkspaceState {
  readonly lastWorkspaceId: string | null;
  readonly sessions: readonly PsbAdminSessionEntry[];
  readonly desktopSessions: readonly PsbAdminDesktopSessionEntry[];
  /** 固定信息快照，按 `confirmedAt` 从新到旧（读取时就排序，不依赖文件里的顺序）。 */
  readonly workspaceSnapshots: readonly PsbAdminWorkspaceSnapshot[];
}

/**
 * 落盘用的扁平形状（生产实现在读回时交给 `normalizePsbAdminRecentState`）。
 *
 * **没有 `version` 字段**：见文件头「schema 演进」。旧文件里的 `version` 会被归一化时忽略。
 */
export interface PsbAdminRecentWorkspaceFile {
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
  /**
   * 最近确认过的那条固定信息快照（连「最近使用」都没有时的最后兜底）。
   *
   * 按 `confirmedAt` 排序挑选，**不依赖**文件里数组的顺序（旧文件 / 手改文件的顺序不可信）。
   */
  latestWorkspaceSnapshot(): PsbAdminWorkspaceSnapshot | null;
  /**
   * 记一条工作区固定信息快照。
   *
   * 固定字段（名称 / 模板 / 机器 / 目录名）完全相同时 **0 次写**（`savedAt` / `confirmedAt`
   * 保持上一次落盘的值）；固定字段有变化才写：`savedAt` 保留第一次的时间，`confirmedAt`
   * 推进到这一次。超出上限时淘汰 `confirmedAt` 最旧的那条。
   *
   * @returns 是否真的落盘（`false` = 值没变 / 输入不可用）。
   */
  rememberWorkspaceSnapshot(input: PsbAdminWorkspaceSnapshotInput): boolean;
  /** 绑定已失效（桌面访问会话被重建 / 已不存在）：丢掉记录，下一次启动会重新订阅。 */
  forgetDesktopSession(workspaceId: string): void;
}

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/**
 * 归一一个时间戳：能解析就统一成 `toISOString()`，否则 `null`。
 *
 * 统一成 ISO 是为了让「坏行 / 手改文件 / 时区后缀不同」的值在排序与比较里可比；
 * 解析不出来就是坏值，**不**回退到 1970（见文件头）。
 */
function isoTimestamp(value: unknown): { readonly iso: string; readonly ms: number } | null {
  const text = trimmed(value);
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return { iso: new Date(ms).toISOString(), ms };
}

/** 比较两条快照的新旧：`confirmedAt` 新的在前（相同时 `savedAt` 新的在前）。 */
function compareSnapshotsByRecency(
  left: PsbAdminWorkspaceSnapshot,
  right: PsbAdminWorkspaceSnapshot,
): number {
  const confirmed = Date.parse(right.confirmedAt) - Date.parse(left.confirmedAt);
  if (confirmed !== 0 && Number.isFinite(confirmed)) return confirmed;
  const saved = Date.parse(right.savedAt) - Date.parse(left.savedAt);
  return Number.isFinite(saved) ? saved : 0;
}

/** 按 `confirmedAt` 从新到旧排序的快照数组（不依赖输入顺序）。 */
function sortSnapshotsByRecency(
  snapshots: readonly PsbAdminWorkspaceSnapshot[],
): PsbAdminWorkspaceSnapshot[] {
  return [...snapshots].sort(compareSnapshotsByRecency);
}

/**
 * 把任意原始值收敛成安全记录：坏数据当空、按 `sessionId` / `workspaceId` 去重、超出上限截断。
 * **不抛异常** —— 一份偏好文件读坏不该让页面开不出来。
 *
 * 只认新键 `desktopSessions`：旧版本的 `viewers`（内部观看端 Agent 会话）不读、不迁移，
 * 语义已经作废（见文件头）。
 *
 * `workspaceSnapshots` 是加性字段：旧文件没有它 → 空表（页面回到「没有快照」的旧行为，
 * 下一次实时读取会重新写入）；单条坏行只丢那一行，不影响其它记录。快照按 `confirmedAt`
 * 从新到旧归一（文件顺序不可信；同一 `workspaceId` 的重复行保留 `confirmedAt` 最新的那条）。
 */
export function normalizePsbAdminRecentState(raw: unknown): PsbAdminRecentWorkspaceState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      lastWorkspaceId: null,
      sessions: [],
      desktopSessions: [],
      workspaceSnapshots: [],
    };
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
  /** `workspaceId → 该工作区当前见过的最新快照`（重复行取 confirmedAt 最新，而不是先出现的）。 */
  const snapshotByWorkspace = new Map<string, PsbAdminWorkspaceSnapshot>();
  for (const entry of snapshotList) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    // 固定信息快照按 `workspaceId` 幂等：同 id 只留一条（最近的确认时间胜出，见下）。
    const workspaceId = trimmed(row['workspaceId']);
    const title = typeof row['title'] === 'string' ? row['title'] : null;
    const clientName = typeof row['clientName'] === 'string' ? row['clientName'] : null;
    if (!workspaceId || title === null || clientName === null) continue;
    if (!title.trim() && !clientName.trim()) continue;
    const saved = isoTimestamp(row['savedAt']);
    const confirmed = isoTimestamp(row['confirmedAt']);
    // 两个时间都坏 = 坏行：直接丢，**不伪造 1970**（伪造值会抢到「最近确认」的兜底位）。
    if (!saved && !confirmed) continue;
    const savedAt = saved && (!confirmed || saved.ms <= confirmed.ms) ? saved.iso : confirmed!.iso;
    const confirmedAt =
      confirmed && (!saved || confirmed.ms >= saved.ms) ? confirmed.iso : saved!.iso;
    const next: PsbAdminWorkspaceSnapshot = {
      workspaceId,
      title: title.trim(),
      templateTitle: trimmed(row['templateTitle']),
      clientName: clientName.trim(),
      directoryName: trimmed(row['directoryName']),
      savedAt,
      confirmedAt,
    };
    const existing = snapshotByWorkspace.get(workspaceId);
    if (!existing || compareSnapshotsByRecency(next, existing) < 0) {
      snapshotByWorkspace.set(workspaceId, next);
    }
  }
  const workspaceSnapshots = sortSnapshotsByRecency([...snapshotByWorkspace.values()]).slice(
    0,
    PSB_ADMIN_WORKSPACE_SNAPSHOT_LIMIT,
  );
  return {
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
    const confirmedInput = isoTimestamp(input.confirmedAt);
    const savedInput = isoTimestamp(input.savedAt);
    const now = new Date();
    const confirmedAt = confirmedInput?.iso ?? savedInput?.iso ?? now.toISOString();
    const savedAt = savedInput?.iso ?? confirmedInput?.iso ?? now.toISOString();
    return {
      workspaceId,
      title,
      templateTitle: trimmed(input.templateTitle ?? null),
      clientName,
      directoryName: trimmed(input.directoryName ?? null),
      savedAt: Date.parse(savedAt) <= Date.parse(confirmedAt) ? savedAt : confirmedAt,
      confirmedAt: Date.parse(confirmedAt) >= Date.parse(savedAt) ? confirmedAt : savedAt,
    };
  }

  /** 固定字段是否相同（相同 = 不落盘；易变状态不参与比较，见文件头）。 */
  function sameSnapshotFields(
    left: PsbAdminWorkspaceSnapshot,
    right: PsbAdminWorkspaceSnapshot,
  ): boolean {
    return (
      left.title === right.title &&
      left.templateTitle === right.templateTitle &&
      left.clientName === right.clientName &&
      left.directoryName === right.directoryName
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
      // 显式按时间挑，不拿 `workspaceSnapshots[0]`：文件顺序可能来自旧版本 / 手改 / 部分写坏，
      // 「最近确认」只能由 `confirmedAt`（缺失时 `savedAt`）决定。
      const snapshots = read().workspaceSnapshots;
      let latest: PsbAdminWorkspaceSnapshot | null = null;
      for (const snapshot of snapshots) {
        if (!latest || compareSnapshotsByRecency(snapshot, latest) < 0) latest = snapshot;
      }
      return latest;
    },
    rememberWorkspaceSnapshot(input) {
      const snapshot = normalizeSnapshot(input);
      if (!snapshot) return false;
      const current = read();
      const existing =
        current.workspaceSnapshots.find((entry) => entry.workspaceId === snapshot.workspaceId) ??
        null;
      // 固定字段没变 = 0 次写：30s 轮询 / 反复打开页面不会造成写放大（写纪律见文件头）。
      // 易变状态（在线 / 工作区状态）已经不在快照里，不再参与比较。
      if (existing && sameSnapshotFields(existing, snapshot)) return false;
      const confirmedAt = snapshot.confirmedAt;
      const savedAt =
        existing && Date.parse(existing.savedAt) <= Date.parse(confirmedAt)
          ? existing.savedAt
          : confirmedAt;
      const workspaceSnapshots = sortSnapshotsByRecency([
        { ...snapshot, savedAt, confirmedAt },
        ...current.workspaceSnapshots.filter(
          (entry) => entry.workspaceId !== snapshot.workspaceId,
        ),
      ]).slice(0, PSB_ADMIN_WORKSPACE_SNAPSHOT_LIMIT);
      persist({ ...current, workspaceSnapshots });
      return true;
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
  };
}
