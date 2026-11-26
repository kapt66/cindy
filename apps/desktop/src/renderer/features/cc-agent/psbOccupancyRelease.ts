/**
 * 本地任务结束 → 归还 PSB 远程工作区占用（**渲染层兼容层**）。
 *
 * ## 为什么需要这一层
 *
 * PSB 的「占用」是写操作协作锁，**没有 TTL**：谁占着，别人就改不了那个工作区，只能去 PSB
 * 网页手动解除。Cindy 之前只在「放弃草稿」时归还（`releasePsbDraftTarget`），而**成功发出
 * 首条消息之后**占用被本地会话接手，从此没有任何释放路径：归档、删除任务、退出应用都不还
 * —— 一条已经结束的任务会永久锁住那台远端工作区。
 *
 * ## 权威在 main（2026-11-27 审查 s5/s8 P1）
 *
 * 释放的事实判断与**触发**都归 main：归档 / 删除落库后，main 的终态 observer
 * （`localDb/ipc/sessions.ts` 的 `setTerminalSessionStatusObserver`）已经发起释放，main 同时掌握
 * 「这条本地会话 → PSB 会话 → 工作区」的账本、其它会话的活动状态和「同一工作区还有没有别的
 * 任务」，因此也只有它能正确回答「现在能不能解锁」。渲染层若也为同一次归档再报一次，就是
 * **一次归档两轮 PSB 请求**，还会和 main 的账本双记账。
 *
 * 所以本模块从「生命周期触发层」降级为**旧 main 的兼容账本**：
 *   - 新 main（`psbBridgeHasMethod(bridge, 'releaseWorkspaceForSession')` 为真）→ 渲染层零调用
 *     （`releasePsbOccupancyForEndedSession` 直接返回 `'main-authority'`），连本地账本都不写；
 *   - 旧 main / 旧 preload（没有这条 IPC）→ 记下「这条任务结束了」的未送达事件，等升级后由
 *     `flushPsbSessionReleases` 在启动 / 页面重新可见时补投一次；main 侧按本地会话 id 幂等。
 *
 * ## 幂等
 *
 * `releaseWorkspaceForSession` 必须幂等（main 侧按本地会话 id 去重）：同一会话被归档后又删除、
 * 或页面卸载与用户动作同时触发，都不会重复释放别人的/自己的占用。本模块的账本只保证
 * 「**事件至少送达一次**」，不判断占用最终状态——那是 main 的事实。
 */
import {
  parsePsbRemoteHostId,
  type PsbPendingWorkspaceReleaseInfo,
  type PsbPendingWorkspaceReleasesRetryResult,
} from '../../../shared/psb-remote-workspace';
import {
  psbBridgeHasMethod,
  tryGetPsbRemoteBridge,
  type PsbRemoteBridge,
} from '@/features/remote-workspace/bridge';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';

const log = createLogger('psbOccupancyRelease');

/** 结束本地任务的原因（main 只用它做归因 / 日志，不改变释放判据）。 */
export type PsbOccupancyReleaseReason =
  | 'session-archived'
  | 'session-deleted'
  | 'session-stopped'
  | 'app-quit';

/** 一次释放义务：本地会话 + 由它派生的 PSB 会话身份。 */
export interface PsbOccupancyReleaseRecord {
  localSessionId: string | null;
  psbSessionId: string | null;
  reason: PsbOccupancyReleaseReason;
  enqueuedAt: number;
  /** 已尝试投递次数（main 未就绪 / 网络失败都会累加）。 */
  attempts: number;
  /** 下次允许重投的时间（简单指数退避，最多 5 分钟）。 */
  nextAttemptAt: number;
  /** 入账时的数据 owner；账号切换后不把上一账号的义务投给新账号。 */
  dataOwnerId: string | null;
}

/**
 * main 提供的释放端口（main 的 `releasePsbWorkspaceForSession`，
 * `main/maker-host/psb-workspace-session-release.ts`）。
 *
 * 入参**与 main 逐字一致**，不做第二套枚举/字段映射：本地会话 id + 会话行远端身份
 * （`psb:<id>`）+ 终态原因。main 自己读 PSB 会话行、确认占用者、幂等释放，并把失败记进
 * **它自己的**账本（`pendingWorkspaceReleases` / `retryPendingWorkspaceReleases`）；渲染层
 * 只在「旧 main 没有终态 observer」时用这份账本保证「结束事件至少送达 main 一次」。
 *
 * 这个方法本身也是**能力探测位**：存在 = 新 main 自己拥有会话结束释放（`main-authority`），
 * 渲染层不再为同一次归档重复上报（见文件头）。
 */
export interface PsbOccupancyReleaseDeps {
  /** 默认读 `window.electronAPI.psbRemote`（测试注入）。 */
  getBridge?: () => PsbRemoteBridge | null;
  logWarn?: (message: string, error: unknown) => void;
}

export type PsbOccupancyReleaseOutcome =
  /** 已交给 main（释放完成 / 幂等无操作 / main 已把失败记进它自己的账本待重试）。 */
  | 'released'
  /** 新 main 自己拥有会话结束释放（终态 observer）：渲染层零调用，也不入本地账本。 */
  | 'main-authority'
  /** main 端口尚未就绪（旧 preload / 主进程早期启动）：留在账本里，下次启动重投。 */
  | 'pending-port'
  /** IPC 投递本身失败（旧 preload 的通道异常等）：留在账本里退避重试。 */
  | 'retained'
  /** 没有 PSB 身份（不是远程工作区任务）。 */
  | 'not-psb'
  /** 旧实现留下的记录没有本地会话 id（无法交给 main）：淘汰并留痕，不永久 pending。 */
  | 'dropped';

const STORAGE_KEY = 'xdt.desktop.psb-session-release.v1';
/** 账本上限：只保留最近的结束事件，避免无限增长（同一会话只保留一条）。 */
const MAX_RECORDS = 32;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

interface StoredLedger {
  records: readonly PsbOccupancyReleaseRecord[];
}

function currentOwnerId(): string | null {
  try {
    return getDataOwnerGeneration().dataOwnerId;
  } catch {
    return null;
  }
}

function readStorage(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(records: readonly PsbOccupancyReleaseRecord[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ records } satisfies StoredLedger));
  } catch {
    // 落盘失败（隐私模式 / 配额）时只能保留内存态：本次运行内仍会重试。
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseStoredRecord(value: unknown): PsbOccupancyReleaseRecord | null {
  if (!isRecord(value)) return null;
  const reason = value.reason;
  if (
    reason !== 'session-archived'
    && reason !== 'session-deleted'
    && reason !== 'session-stopped'
    && reason !== 'app-quit'
  ) {
    return null;
  }
  const localSessionId = typeof value.localSessionId === 'string' ? value.localSessionId : null;
  const psbSessionId = typeof value.psbSessionId === 'string' ? value.psbSessionId : null;
  if (!localSessionId && !psbSessionId) return null;
  return {
    localSessionId,
    psbSessionId,
    reason,
    enqueuedAt: typeof value.enqueuedAt === 'number' ? value.enqueuedAt : Date.now(),
    attempts: typeof value.attempts === 'number' && value.attempts >= 0 ? value.attempts : 0,
    nextAttemptAt: typeof value.nextAttemptAt === 'number' ? value.nextAttemptAt : 0,
    dataOwnerId: typeof value.dataOwnerId === 'string' ? value.dataOwnerId : null,
  };
}

function loadRecords(): PsbOccupancyReleaseRecord[] {
  const raw = readStorage();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.records)) return [];
    return parsed.records
      .map(parseStoredRecord)
      .filter((record): record is PsbOccupancyReleaseRecord => record != null);
  } catch {
    return [];
  }
}

function recordKey(record: Pick<PsbOccupancyReleaseRecord, 'localSessionId' | 'psbSessionId'>): string {
  return record.localSessionId ?? `psb:${record.psbSessionId ?? ''}`;
}

function persist(records: readonly PsbOccupancyReleaseRecord[]): void {
  writeStorage(records.slice(0, MAX_RECORDS));
}

/** 读当前账本（诊断 / 测试 / 未来「N 个远程工作区可能仍被你占用」提示条用）。 */
export function listPsbSessionReleases(): readonly PsbOccupancyReleaseRecord[] {
  return loadRecords();
}

/** 从会话行派生释放义务；不是 PSB 远程工作区任务时返回 `null`。 */
export function psbOccupancyReleaseRecordOfSession(
  session: { id?: string | null; remoteHostId?: string | null } | null | undefined,
  reason: PsbOccupancyReleaseReason,
): PsbOccupancyReleaseRecord | null {
  if (!session) return null;
  const psbSessionId = parsePsbRemoteHostId(session.remoteHostId ?? null);
  if (!psbSessionId) return null;
  if (!session.id) return null;
  const now = Date.now();
  return {
    localSessionId: session.id,
    psbSessionId,
    reason,
    enqueuedAt: now,
    attempts: 0,
    nextAttemptAt: 0,
    dataOwnerId: currentOwnerId(),
  };
}

let bridgeOverride: (() => PsbRemoteBridge | null) | null = null;

function defaultBridge(): PsbRemoteBridge | null {
  // 走 bridge.ts 的单一入口（不在组件/模块里各自解构 electronAPI）。
  return tryGetPsbRemoteBridge();
}

function resolveBridge(deps: PsbOccupancyReleaseDeps): PsbRemoteBridge | null {
  return (deps.getBridge ?? bridgeOverride ?? defaultBridge)();
}

/**
 * 当前 main 是否**自己拥有**「会话结束释放」（终态 observer）。
 *
 * 能力探测位是 `releaseWorkspaceForSession`：它和 main 的终态 observer 在同一次装配里注册
 * （`maker-ipc/register.ts` + `remote-workspace/ipc.ts`），旧 build（没有 observer）也就没有这条
 * IPC。探测为真时渲染层不再为归档 / 删除上报 —— 那是同一次动作的第二轮 PSB 请求。
 *
 * 已知边界：`main` 端口未装配时同一条 IPC 仍会应答 `not-wired`；那种「有 IPC 无 observer」只
 * 可能出现在开发期的半装配进程，发布形态里两者同生同灭。
 */
export function psbMainOwnsSessionEndRelease(deps: PsbOccupancyReleaseDeps = {}): boolean {
  return psbBridgeHasMethod(resolveBridge(deps), 'releaseWorkspaceForSession');
}

/**
 * 这些失败码表示「占用已经不在自己名下 / 工作区已不存在」：没有可释放的东西，
 * 记日志后按完成处理，不留在账本里反复重试。
 */
function isTerminalReleaseFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    message.includes('NOT_FOUND')
    || message.includes('WORKSPACE_OCCUPIED_BY_OTHER')
    || message.includes('AUTH_INVALID')
    || message.includes('AUTH_EXPIRED')
    || message.includes('AUTH_REQUIRED')
  );
}

/** 入账（同会话去重，保留最新原因），返回写入后的账本。 */
function enqueuePsbSessionRelease(
  record: PsbOccupancyReleaseRecord | null,
): readonly PsbOccupancyReleaseRecord[] {
  if (!record) return loadRecords();
  const key = recordKey(record);
  const records = loadRecords();
  const existing = records.find((candidate) => recordKey(candidate) === key);
  const merged: PsbOccupancyReleaseRecord = {
    ...record,
    enqueuedAt: existing?.enqueuedAt ?? record.enqueuedAt,
    // 新事件重新获得立即投递的机会（用户刚结束这条任务）。
    attempts: existing?.attempts ?? 0,
    nextAttemptAt: 0,
  };
  persist([merged, ...records.filter((candidate) => recordKey(candidate) !== key)]);
  return loadRecords();
}

function removeRecord(key: string): readonly PsbOccupancyReleaseRecord[] {
  const remaining = loadRecords().filter((record) => recordKey(record) !== key);
  persist(remaining);
  return remaining;
}

function bumpAttempt(record: PsbOccupancyReleaseRecord): void {
  const attempts = record.attempts + 1;
  const key = recordKey(record);
  const next = loadRecords().map((candidate) => (
    recordKey(candidate) === key
      ? {
          ...candidate,
          attempts,
          nextAttemptAt: Date.now() + Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS),
        }
      : candidate
  ));
  persist(next);
}

async function deliver(
  record: PsbOccupancyReleaseRecord,
  deps: PsbOccupancyReleaseDeps,
): Promise<PsbOccupancyReleaseOutcome> {
  const bridge = resolveBridge(deps);
  if (!bridge) return 'pending-port';
  if (!psbBridgeHasMethod(bridge, 'releaseWorkspaceForSession')) {
    // 旧 preload（新渲染层 + 未重启的旧 main）：留账，不假装释放成功，下次启动补投。
    return 'pending-port';
  }
  if (!record.localSessionId) {
    // 旧实现存下的记录只有 `psbSessionId`：main 的入参需要本地会话 id（幂等键 + 隧道释放），
    // 没有它既不能投递也无法重建 —— 留在账本里就是永久 `pending-port`。淘汰并留痕。
    const warn = deps.logWarn ?? ((message: string, cause: unknown) => log.warn(message, cause));
    warn(
      '[psb] dropping a legacy release record without a local session id',
      new Error(
        `[PSB_RELEASE_DROPPED] psbSessionId=${
          record.psbSessionId ?? ''
        } reason=${record.reason} attempts=${record.attempts}`,
      ),
    );
    return 'dropped';
  }
  try {
    // 与 main（`releasePsbWorkspaceForSession`）的入参逐字一致，不做第二套字段映射。
    const result: unknown = await bridge.releaseWorkspaceForSession({
      sessionId: record.localSessionId,
      remoteHostId: record.psbSessionId ? `psb:${record.psbSessionId}` : null,
      reason: record.reason,
    });
    // 旧 main（返回 `void`）与测试替身按「已送达」处理：新 main 才带结果形状。
    const wire = result && typeof result === 'object'
      ? (result as { ok?: unknown; reason?: unknown; failureCode?: unknown; message?: unknown })
      : null;
    if (wire?.reason === 'not-wired') {
      // main 的释放端口还没装配（启动早期 / Node Host）：留账，下次启动补投。
      return 'pending-port';
    }
    if (wire?.ok === false) {
      // 事件已送达 main，且失败已记进**main 的**待释放账本（它负责重试）。清掉本地待投记录，
      // 不为同一件事排第二份重试；只留一条日志便于把「远端锁可能还在」和这次操作对上。
      const warn = deps.logWarn ?? ((message: string, cause: unknown) => log.warn(message, cause));
      warn(
        '[psb] main retained the workspace release failure for retry',
        new Error(
          `${typeof wire.failureCode === 'string' ? wire.failureCode : 'PSB_RELEASE_FAILED'}: ${
            typeof wire.message === 'string' ? wire.message : ''
          }`,
        ),
      );
    }
    return 'released';
  } catch (error) {
    if (isTerminalReleaseFailure(error)) {
      const warn = deps.logWarn ?? ((message: string, cause: unknown) => log.warn(message, cause));
      warn('[psb] workspace occupancy was already free; nothing to release', error);
      return 'released';
    }
    return 'retained';
  }
}

/**
 * 报告「这条本地任务结束了」。**新 main 下是零副作用的 no-op**（`'main-authority'`）。
 *
 * - 新 main（终态 observer 拥有释放）→ 不写本地账本、不发 IPC；顺带清掉该会话可能残留的
 *   历史待投记录（旧 build 存下的），保证同一件事不会被投第二次；
 * - 旧 main / 旧 preload → 入账并按能力投递：`pending-port` 留账，升级后由
 *   `flushPsbSessionReleases` 在启动 / 页面可见时补投一次，不需要用户重新操作。
 */
export async function releasePsbOccupancyForEndedSession(
  record: PsbOccupancyReleaseRecord | null,
  deps: PsbOccupancyReleaseDeps = {},
): Promise<PsbOccupancyReleaseOutcome> {
  if (!record) return 'not-psb';
  if (psbMainOwnsSessionEndRelease(deps)) {
    // 单权威在 main：同一归档动作已由终态 observer 发起释放，渲染层再报一次就是第二轮
    // PSB 请求 + 与 main 账本双记账。只做一次本地清理（旧版本留下的同会话记录）。
    removeRecord(recordKey(record));
    return 'main-authority';
  }
  enqueuePsbSessionRelease(record);
  const outcome = await deliver(record, deps);
  if (outcome === 'released' || outcome === 'dropped') {
    removeRecord(recordKey(record));
    return outcome;
  }
  if (outcome === 'retained') {
    bumpAttempt(record);
    const warn = deps.logWarn ?? ((message: string, cause: unknown) => log.warn(message, cause));
    warn(
      '[psb] releasing workspace occupancy failed; queued for retry',
      new Error(`[PSB_RELEASE_${outcome.toUpperCase()}] ${record.localSessionId ?? record.psbSessionId ?? ''}`),
    );
  }
  return outcome;
}

/**
 * 重投账本里到期的结束事件（应用启动 / 页面重新可见 / 显式重试时调用一次）。
 *
 * 新 main 下这个账本**不会新增**记录（`releasePsbOccupancyForEndedSession` 直接
 * `'main-authority'`），这里只会把**旧 build 存下的**未送达事件补投一次；升级后第一次启动
 * 就是那些事件的唯一投递机会。`'dropped'` = 没有本地会话 id 的旧记录被淘汰（投不出去）。
 *
 * 只投**属于当前数据 owner** 且已到退避时间的记录；不看窗口聚焦之类的高频时机，
 * 不做后台轮询（工程契约 §3.2：写操作不偷偷自动重试）。
 */
export async function flushPsbSessionReleases(
  deps: PsbOccupancyReleaseDeps = {},
): Promise<{ attempted: number; released: number; retained: number }> {
  const owner = currentOwnerId();
  const now = Date.now();
  const due = loadRecords().filter((record) => (
    (!record.dataOwnerId || record.dataOwnerId === owner)
    && record.nextAttemptAt <= now
  ));
  let released = 0;
  let retained = 0;
  for (const record of due) {
    const outcome = await deliver(record, deps);
    if (outcome === 'released' || outcome === 'dropped') {
      removeRecord(recordKey(record));
      released += 1;
    } else {
      bumpAttempt(record);
      retained += 1;
    }
  }
  return { attempted: due.length, released, retained };
}

/* ============ main 的待释放账本：读取 / 推送订阅 / 显式重试（常驻提示条数据源） ============ */

/**
 * 渲染层持有的「main 待释放账本」快照。
 *
 * 为什么只读 main 的账本：释放失败的**事实**在 main（它掌握本地会话 → PSB 会话 → 工作区
 * 的换算，以及还有没有别的任务在用这个工作区）。渲染层另记一份只会出现「两本账不一致」：
 * 用户看到一条提示，点重试却打在一个已经没用的 workspaceId 上。
 *
 * 这里只是 **main 快照的缓存 + 订阅**，不产生新事实；UI 由
 * `remote-workspace/release/PsbPendingReleaseNotice.tsx` 消费：它通过
 * `release/pendingReleaseNoticeStore.ts` 合并本快照与工作区级账本渲染常驻提示条，重试按钮
 * 只调**一个**入口 `retryPendingPsbReleasesEverywhere()`（内部再分别调本模块的
 * `retryPendingWorkspaceReleasesInMain()` 与工作区级账本的 `retryPsbPendingReleases()`）。
 */
let mainPendingReleases: readonly PsbPendingWorkspaceReleaseInfo[] = [];
const mainPendingListeners = new Set<() => void>();

function setMainPendingReleases(next: readonly PsbPendingWorkspaceReleaseInfo[]): void {
  mainPendingReleases = next;
  for (const listener of [...mainPendingListeners]) {
    try {
      listener();
    } catch {
      // 订阅方异常不影响其它订阅方。
    }
  }
}

/** 最近一次从 main 读到的待释放项（稳定引用：没变化时返回同一个数组）。 */
export function listPendingWorkspaceReleasesFromMain(): readonly PsbPendingWorkspaceReleaseInfo[] {
  return mainPendingReleases;
}

/** 订阅 main 账本快照变化（推送 / 主动刷新 / 重试成功后触发）。 */
export function subscribePendingWorkspaceReleases(listener: () => void): () => void {
  mainPendingListeners.add(listener);
  return () => {
    mainPendingListeners.delete(listener);
  };
}

/** 读一次 main 的待释放账本（只读；旧 preload 缺方法时保持空快照）。 */
export async function refreshPendingWorkspaceReleases(
  deps: PsbOccupancyReleaseDeps = {},
): Promise<readonly PsbPendingWorkspaceReleaseInfo[]> {
  const bridge = (deps.getBridge ?? bridgeOverride ?? defaultBridge)();
  if (!psbBridgeHasMethod(bridge, 'pendingWorkspaceReleases')) return mainPendingReleases;
  try {
    const snapshot = await bridge.pendingWorkspaceReleases();
    setMainPendingReleases(snapshot.releases);
  } catch (error) {
    const warn = deps.logWarn ?? ((message: string, cause: unknown) => log.warn(message, cause));
    warn('[psb] reading the pending workspace releases failed', error);
  }
  return mainPendingReleases;
}

/**
 * 显式重试 main 的待释放账本（用户点「重试解除占用」时调用一次）。
 *
 * 不做后台自动重试（工程契约 §3.2）：只有用户动作 / 应用退出（main 自己）会重试。
 * **不要**在界面里为它单独摆一个重试按钮：提示条只有一个统一入口
 * `retryPendingPsbReleasesEverywhere()`（本函数 + 工作区级账本各重试一次）。
 * 返回值是重试后的完整账本；旧 preload 缺方法时返回 `null`。
 */
export async function retryPendingWorkspaceReleasesInMain(
  deps: PsbOccupancyReleaseDeps = {},
): Promise<PsbPendingWorkspaceReleasesRetryResult | null> {
  const bridge = (deps.getBridge ?? bridgeOverride ?? defaultBridge)();
  if (!psbBridgeHasMethod(bridge, 'retryPendingWorkspaceReleases')) return null;
  try {
    const result = await bridge.retryPendingWorkspaceReleases();
    setMainPendingReleases(result.releases);
    return result;
  } catch (error) {
    const warn = deps.logWarn ?? ((message: string, cause: unknown) => log.warn(message, cause));
    warn('[psb] retrying the pending workspace releases failed', error);
    return null;
  }
}

/**
 * 常驻监听 main 的待释放账本（常驻提示条宿主挂载时调用一次）。
 *
 * 启动先读一次快照（补上「上次运行失败、main 记账」的项），再订阅推送；返回取消订阅。
 * 只在主窗接（副窗没有会话生命周期，多窗订阅只会让同一提示条渲染多份）：调用点是
 * `release/PsbPendingReleaseNotice` 的宿主 effect，App 不再重复订阅。
 */
export function watchPendingWorkspaceReleases(
  deps: PsbOccupancyReleaseDeps = {},
): () => void {
  const bridge = (deps.getBridge ?? bridgeOverride ?? defaultBridge)();
  if (!psbBridgeHasMethod(bridge, 'onPendingWorkspaceReleasesChanged')) {
    return () => undefined;
  }
  const unsubscribe = bridge.onPendingWorkspaceReleasesChanged((event) => {
    setMainPendingReleases(event.releases);
  });
  void refreshPendingWorkspaceReleases(deps).catch(() => undefined);
  return unsubscribe;
}

export const __testing = {
  /** 测试注入桥（生产永远读 window.electronAPI.psbRemote）。 */
  setBridge(getter: (() => PsbRemoteBridge | null) | null): void {
    bridgeOverride = getter;
  },
  storageKey: STORAGE_KEY,
  reset(): void {
    mainPendingReleases = [];
    mainPendingListeners.clear();
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  },
};


