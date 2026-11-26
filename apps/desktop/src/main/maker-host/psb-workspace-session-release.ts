/**
 * PSB 工作区占用的**会话结束释放**端口。
 *
 * ## 为什么需要它（用户要求 + 审查 r6/r7 + 二轮审查 s2/s5/s8）
 *
 * PSB 的工作区占用（协作锁）是**写权限**：占用者之外的写入会被服务端拒绝。Cindy 现有的
 * 释放入口全是「用户在工作区页面上手动点」；用户把远程任务归档 / 删除、退出应用之后，
 * 那把锁仍挂在自己名下 —— 别的同事（或自己的另一台设备）想接手同一工作区时会被
 * `PSB_WORKSPACE_OCCUPIED_BY_OTHER` 挡住，而工作区里其实已经没有任务在跑。
 * 所以「任务结束」必须等价于「释放占用」。
 *
 * ## 口径（main 是唯一权威）
 *
 *  - **单权威**：归档 / 删除的释放由 main 的终态 observer（`localDb/ipc/sessions.ts` 的
 *    `setTerminalSessionStatusObserver` → `maker-ipc/register.ts`）发起。渲染层不再对同一个
 *    动作重复上报 —— 一次归档只会有一轮 PSB 请求（`sessionStatus` + `release`）。渲染层
 *    只保留「旧 main / 旧 preload 没有终态释放」的兼容账本（见 `psbOccupancyRelease.ts`）。
 *  - **工作区级、不是会话级**：同一工作区可以有多条自己的任务。归档其中一条时，只要还有
 *    **活动**（`sessions.status = 'active'`）的 `psb:` 任务落在同一个工作区，就**跳过释放且不
 *    入账**（`reason:'workspace-in-use'`）—— 提前解锁会让别人接手正在使用的工作区。判据只能
 *    在 main 算：它同时掌握会话表、会话→工作区的本机映射和 PSB 状态。
 *  - **幂等**：先读 PSB 会话行确认占用者，只有「由我占用」才发释放；重复调用、并发调用、
 *    工作区已被释放都是 no-op。释放请求本身在 PSB 侧也是幂等的。
 *  - **可重试**：失败（网络 / 鉴权 / 服务端 5xx）不吞掉——记进有界的进程内账本
 *    （`listPendingWorkspaceReleases` / `retryPendingWorkspaceReleases`），下一次会话结束
 *    或显式重试时再试。**账本只有一份**（这里）：渲染层只缓存 main 的快照，不另记一份释放。
 *  - **不阻断主流程**：归档 / 删除 / 退出都不是「因为释放失败就不做」的动作。调用方拿到
 *    `ok:false` 只用于记账与提示。
 *  - **只对 `psb:` 生效**：本地 / SSH / MCPRouter 会话在这里一律 no-op（它们没有 PSB 工作区锁）。
 *
 * ## 账本（二轮审查 s2 P1：重试不能依赖 PSB 会话行）
 *
 * `PsbPendingWorkspaceReleaseInfo.workspaceId` 在**读会话行成功的那一刻**就记下来；重试优先
 * 按 workspaceId 直接 `releaseWorkspace`，不再为每条账本各打一次 `sessionStatus`：
 *
 *  - PSB 会话 404（会话已终态 / 已读不到）时工作区锁仍可归还；
 *  - 只有 `workspaceId` 未知（读会话行就失败）才回退到「读会话行」路径；
 *  - `NOT_FOUND` / `FORBIDDEN` 是**终止**归因（工作区或会话已经不存在，再试没有结果）：
 *    按工作区重试时记 `workspace-missing`、按会话回退时记 `session-missing`，条目出账并留日志；
 *    `WORKSPACE_OCCUPIED_BY_OTHER`（别人已经接手）同样出账——本机已经没有可释放的东西。
 *
 * **重试前的两道复核**（2026-11-27 终局复审 P1，不能把待释放义务静默丢掉）：
 *
 *  1. **会话是否又被恢复成活动任务**：归档 → 入账 → 用户在界面上恢复该任务 → 点提示条重试，
 *     此时锁正被恢复的任务合法占用。重试入口按 `localSessionId` 复核活动 psb 任务（
 *     `ledgerSessionActivity`）：`active` 只出账、不释放也不收隧道；读不到活动列表（`unknown`）
 *     保留条目。渲染层的恢复路径不负责清账本，所以判据必须在这里。
 *  2. **同工作区是否还有别的活动任务**：只有 `mapping` / `session-status` 的确证结论才出账；
 *     `unknown`（读不到本机映射且 PSB 会话行读失败）**保留条目**——「无法确认在用」不是
 *     「别人在用」，旧实现按 `inUse:true` 直接出账会同时丢掉义务与提示条。
 *
 * 账本条目带 **dataOwner 印记**（`activeOwnerScopeKey()`）：切号之后新身份不能替旧账号归还
 * 工作区（那是越权），账号边界 / teardown（`disposePsbRemoteService`）直接清账本。
 *
 * ## 顺序
 *
 * 先读状态（拿 workspaceId + 占用者）→ 同工作区还有活动任务就只结束本会话的隧道 → 只在我
 * 占用时释放 → 失效三处本地事实（会话状态快照、工作区占用缓存、本会话登记的隧道），让下一条
 * 发送/下一次打开管理页看到释放后的真相。
 */

import {
  parsePsbRemoteHostId,
  type PsbPendingWorkspaceReleaseInfo,
  type PsbRemoteFailure,
  type PsbSessionReleaseReason,
  type PsbSessionStatusResult,
} from '../../shared/psb-remote-workspace.js';

/**
 * 触发释放的终态来源（诊断 / 账本用；不影响行为）。
 *
 * 类型与 `PSB_SESSION_RELEASE_REASONS`（共享契约，IPC 入参校验同一份）同源：渲染层与 main
 * 共用一套原因字面量，新增原因只改共享契约一处。
 */
export type { PsbSessionReleaseReason };

export type PsbWorkspaceReleaseOutcome =
  /** 不是 PSB 会话，或工作区本来就不由我占用 —— 都是成功（幂等）。 */
  | {
      readonly ok: true;
      readonly released: boolean;
      /**
       * `not-wired` = 桌面装配还没装上端口（Node Host / 启动早期）；
       * `not-psb` = 不是 PSB 会话；
       * `workspace-in-use` = 同一工作区还有别的活动任务，这次跳过且**不入账**。
       */
      readonly reason: 'not-psb' | 'not-wired' | 'not-held' | 'released' | 'workspace-in-use';
    }
  /** 读不到会话 / 释放请求失败：记进账本，可重试。 */
  | {
      readonly ok: false;
      readonly code: 'PSB_RELEASE_FAILED';
      readonly message: string;
      /** 失败分类（PSB 命名空间码优先，便于上层归因）。 */
      readonly failureCode: string | null;
    };

/** 待重试的一条释放；`key` 让同一工作区的多次失败只留一条（重试语义幂等）。 */
export type PsbPendingWorkspaceRelease = PsbPendingWorkspaceReleaseInfo;

/** 一条**活动**的 psb 任务（同工作区检查用；不含它自己）。 */
export interface PsbActiveSessionRef {
  readonly sessionId: string;
  readonly psbSessionId: string;
}

export interface PsbWorkspaceReleaseLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface PsbWorkspaceReleasePorts {
  /** 读 PSB 会话行（`getPsbRemoteService().sessionStatus`）。 */
  readSessionStatus(psbSessionId: string): Promise<PsbSessionStatusResult>;
  /** 释放工作区占用（`getPsbRemoteService().releaseWorkspace`；PSB 侧幂等）。 */
  releaseWorkspace(workspaceId: string): Promise<void>;
  /** 事实变了：丢掉该会话的状态快照（`psb-session-status`）。 */
  invalidateSessionStatus(psbSessionId: string): void;
  /**
   * 事实变了：丢掉该工作区的占用缓存。缺省不传 = 释放接口自己已失效缓存
   * （`PsbRemoteService.releaseWorkspace` 内部会 `workspaceLock.invalidate`）。
   */
  invalidateWorkspaceLock?(workspaceId: string): void;
  /** 释放该会话登记的隧道（会话结束不再需要长连接，PSB 侧按活动隧道统计）。 */
  releaseTransports(input: { sessionId: string; remoteHostId: string }): Promise<void>;
  /**
   * 本机所有**活动**的 psb 任务（`sessions.status='active'`）。释放前用它回答
   * 「同一个工作区还有没有别的任务在用」。缺省不传 = 无法判断（不做额外封锁，保持旧行为）。
   */
  listActivePsbSessions?(): Promise<ReadonlyArray<PsbActiveSessionRef>>;
  /** `psbSessionId → workspaceId`（本机持久化的会话→工作区映射；不知道时 `null`）。 */
  workspaceIdForPsbSession?(psbSessionId: string): string | null;
  /** 当前账号 / 会话作用域（`activeOwnerScopeKey()`）：给账本条目盖 dataOwner 印记。 */
  currentDataOwnerScope?(): string | null;
  log: PsbWorkspaceReleaseLogger;
  now?(): number;
}

export interface PsbWorkspaceReleaseRequest {
  /** 本地 Maker 会话 id。 */
  readonly sessionId: string;
  /** 本地会话行的远端身份（`psb:<sessionId>` 才处理）。 */
  readonly remoteHostId: string | null | undefined;
  readonly reason: PsbSessionReleaseReason;
}

export interface PsbWorkspaceReleaseOptions {
  /**
   * 应用退出：本机所有活动任务都在结束，跳过「同工作区还有别的活动任务」检查。
   *
   * 否则退出时同一工作区里的多条活动任务会互相把对方当成「还有人在用」，谁都不释放。
   */
  readonly ignoreOtherActiveSessions?: boolean;
}

const MAX_PENDING = 64;

/** 账本里的一条：跨 IPC 的 DTO + 只留在 main 的账号印记。 */
interface StoredPendingRelease {
  /**
   * 本地会话 id（重试时要按它释放隧道；`info.key` 是 `sessionId\0reason` 的复合键，不拆）。
   *
   * 不跨 IPC：渲染层只需要 key 做幂等，不需要再拿到一个本地 id 去自己发请求。
   */
  readonly localSessionId: string;
  readonly info: PsbPendingWorkspaceReleaseInfo;
  /**
   * 入账时的账号 / 会话作用域（`activeOwnerScopeKey()`）。
   *
   * 切号之后新身份**不能**替旧账号归还工作区（服务端会把释放当成别人的锁）：重试前比对，
   * 不一致就出账。`null` = 入账时还读不到作用域（启动早期 / 无 Electron 的单测），不拦。
   */
  readonly dataOwnerScope: string | null;
}

let ports: PsbWorkspaceReleasePorts | null = null;
const pending = new Map<string, StoredPendingRelease>();

/**
 * 账本变更监听（main 内部接线 → 推送 `PENDING_RELEASES_CHANGED`）。
 *
 * 广播必须由**账本自己**发：失败可能来自 main 的终态扫描（归档发生在别的窗口 / 后台回收），
 * 渲染层并没有参与那次调用，收不到 invoke 结果，只能靠推送。监听器同步调用、逐个吞异常
 * （一个窗口的 webContents 已销毁不能拖垮释放主流程）。
 */
type PendingReleasesListener = (releases: readonly PsbPendingWorkspaceRelease[]) => void;
const pendingListeners = new Set<PendingReleasesListener>();

export function onPendingWorkspaceReleasesChanged(
  listener: PendingReleasesListener,
): () => void {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

function notifyPendingChanged(): void {
  if (pendingListeners.size === 0) return;
  const snapshot = listPendingWorkspaceReleases();
  for (const listener of [...pendingListeners]) {
    try {
      listener(snapshot);
    } catch {
      // 推送失败不影响释放主流程（下一个变更点会再推一次完整快照）。
    }
  }
}

/** 装配层（`maker-ipc/register.ts`）注入 PSB 服务；未装配时本模块整体 no-op。 */
export function installPsbWorkspaceReleasePorts(next: PsbWorkspaceReleasePorts | null): void {
  ports = next;
}

export function resetPsbWorkspaceReleaseForTests(): void {
  ports = null;
  pending.clear();
  pendingListeners.clear();
}

/** 待重试的释放（诊断 / 渲染层常驻提示条的数据源）。 */
export function listPendingWorkspaceReleases(): PsbPendingWorkspaceRelease[] {
  return [...pending.values()].map((entry) => entry.info);
}

/** 失败是否仍在账本里（幂等判据：同一 key 不重复记）。 */
export function hasPendingWorkspaceRelease(key: string): boolean {
  return pending.has(key);
}

/**
 * 清空账本（账号边界 / `disposePsbRemoteService` teardown）。
 *
 * 旧账号的待释放项只能用旧身份归还，新身份重试是越权；teardown / 切号时直接出账，
 * 由旧账号下一次登录后的新会话结束重新收集（占用方仍是旧身份，PSB 侧锁不受影响）。
 */
export function clearPendingWorkspaceReleases(): void {
  if (pending.size === 0) return;
  pending.clear();
  notifyPendingChanged();
}

function failureCodeOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const failure = (error as { failure?: unknown }).failure as PsbRemoteFailure | undefined;
  if (failure && typeof failure.code === 'string') return failure.code;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * `NOT_FOUND` / `FORBIDDEN`：会话或工作区已经不存在（PSB 对「已终态 / 记录不存在 / 非归属人」
 * 统一给这两种码，不泄漏存在性）。再重试也不会有结果。
 */
const TERMINAL_MISSING_FAILURE_CODES = new Set(['NOT_FOUND', 'FORBIDDEN']);

/**
 * 没有可释放的东西：工作区/会话没了，或别人已经接手了这把锁。
 * 与「网络 / 鉴权 / 5xx」区分开，后者保留在账本里等下一次重试。
 */
const TERMINAL_RELEASE_FAILURE_CODES = new Set([
  ...TERMINAL_MISSING_FAILURE_CODES,
  'WORKSPACE_OCCUPIED_BY_OTHER',
]);

function pendingKey(request: Pick<PsbWorkspaceReleaseRequest, 'sessionId' | 'reason'>): string {
  return `${request.sessionId}\0${request.reason}`;
}

function currentOwnerScope(wired: PsbWorkspaceReleasePorts): string | null {
  try {
    return wired.currentDataOwnerScope?.() ?? null;
  } catch {
    return null;
  }
}

/** 同一条 key 的账本条目（副作用：入账、保留已读到的 workspaceId、把最新的错误写进去）。 */
function recordPendingFailure(input: {
  key: string;
  request: PsbWorkspaceReleaseRequest;
  failureCode: string | null;
  message: string;
  workspaceId: string | null;
  now: number;
  wired: PsbWorkspaceReleasePorts;
}): StoredPendingRelease {
  const { key, request, wired } = input;
  const previous = pending.get(key);
  const psbSessionId = parsePsbRemoteHostId(request.remoteHostId) ?? '';
  const entry: StoredPendingRelease = {
    localSessionId: request.sessionId,
    info: {
      key,
      psbSessionId,
      remoteHostId: request.remoteHostId ?? '',
      // 以前读到过的工作区不能因为这一次没读到就丢掉：重试优先按它直接释放。
      workspaceId: input.workspaceId ?? previous?.info.workspaceId ?? null,
      reason: request.reason,
      attempt: (previous?.info.attempt ?? 0) + 1,
      lastError: input.message,
      failureCode: input.failureCode,
      updatedAt: input.now,
    },
    dataOwnerScope: previous?.dataOwnerScope ?? currentOwnerScope(wired),
  };
  pending.set(key, entry);
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }
  notifyPendingChanged();
  return entry;
}

/** 用新的 attempt / 错误覆盖一条已有账本条目（保留 dataOwner 印记与已读到的 workspaceId）。 */
function rewritePendingFailure(input: {
  key: string;
  previous: StoredPendingRelease;
  failureCode: string | null;
  message: string;
  workspaceId: string | null;
  now: number;
}): StoredPendingRelease {
  const entry: StoredPendingRelease = {
    localSessionId: input.previous.localSessionId,
    info: {
      ...input.previous.info,
      workspaceId: input.workspaceId ?? input.previous.info.workspaceId,
      attempt: input.previous.info.attempt + 1,
      lastError: input.message,
      failureCode: input.failureCode,
      updatedAt: input.now,
    },
    dataOwnerScope: input.previous.dataOwnerScope,
  };
  pending.set(input.key, entry);
  notifyPendingChanged();
  return entry;
}

function dropPending(key: string): boolean {
  const removed = pending.delete(key);
  if (removed) notifyPendingChanged();
  return removed;
}

interface WorkspaceInUseCheck {
  readonly inUse: boolean;
  /** 结论来自哪条证据（日志 / 诊断用）。 */
  readonly checked: 'no-other-active' | 'mapping' | 'session-status' | 'unknown';
}

/**
 * 「同一个工作区还有没有别的活动任务在用」。
 *
 * 证据优先级：本机持久化的 `psbSessionId → workspaceId` 映射（创建 PSB 会话那一刻落盘）→
 * 读一次该会话的 PSB 状态（映射被容量淘汰 / 旧记录时）。读不到就**保守按在用处理**：
 * 提前解锁会让别人接手正在跑任务的工作区，比多留一会儿锁严重得多（退出时由
 * `ignoreOtherActiveSessions` 兜底，见 `releaseActivePsbWorkspacesForQuit`）。
 */
async function workspaceInUseByOtherActiveSession(
  wired: PsbWorkspaceReleasePorts,
  workspaceId: string,
  self: { readonly sessionId: string; readonly psbSessionId: string },
): Promise<WorkspaceInUseCheck> {
  if (!wired.listActivePsbSessions) return { inUse: false, checked: 'unknown' };
  let siblings: ReadonlyArray<PsbActiveSessionRef>;
  try {
    siblings = await wired.listActivePsbSessions();
  } catch (error) {
    wired.log.warn('psb workspace release: listing active psb tasks failed; keeping the workspace lock', {
      workspaceId,
      sessionId: self.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { inUse: true, checked: 'unknown' };
  }
  let checked: WorkspaceInUseCheck['checked'] = 'no-other-active';
  for (const sibling of siblings) {
    if (sibling.sessionId === self.sessionId) continue;
    const mapped = wired.workspaceIdForPsbSession?.(sibling.psbSessionId) ?? null;
    if (mapped !== null) {
      checked = 'mapping';
      if (mapped === workspaceId) return { inUse: true, checked };
      continue;
    }
    // 映射未知（旧记录 / 超出本机记录容量）：读一次它的 PSB 会话行来确认工作区归属。
    try {
      const status = await wired.readSessionStatus(sibling.psbSessionId);
      checked = 'session-status';
      if (status.workspace.id === workspaceId) return { inUse: true, checked };
    } catch (error) {
      wired.log.warn(
        'psb workspace release: cannot verify whether another active task uses this workspace; keeping the lock',
        {
          workspaceId,
          sessionId: self.sessionId,
          siblingSessionId: sibling.sessionId,
          siblingPsbSessionId: sibling.psbSessionId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return { inUse: true, checked: 'unknown' };
    }
  }
  return { inUse: false, checked };
}

/**
 * 账本里的这条会话**是否又被恢复成活动任务**（2026-11-27 终局复审 P1）。
 *
 * 为什么必须在重试入口复核：归档时释放失败 → 条目入账；用户随后在界面上**恢复**这条任务
 * （会话行重新 `status='active'`，它在 PSB 侧重新占着同一把锁），再点提示条「重试」——
 * 渲染层的恢复任务不负责清账本，重试若只按账本里的 `workspaceId` 直连 `releaseWorkspace`，
 * 解掉的正是这条任务正在使用的锁（下一次写入就被自己的释放坑掉）。
 *
 * 判据只看本机的活动 `psb:` 任务列表（`listActivePsbSessions`，就是「会话结束」判据的同一份
 * 事实）：**按 localSessionId 命中即视为恢复**（不比对 psbSessionId —— 会话重新绑定到哪条
 * 远端会话不影响「这条任务还活着」；锁仍可能被它用着，宁可不出账释放）。
 *
 *  - `active`：本次「任务结束」归因已失效 → 调用方只出账，不释放、也不收隧道；
 *  - `ended`：仍是终态，按旧路径重试（端口未装配时也走这里：无法核对 = 保持旧行为，不把
 *    整个账本卡死）；
 *  - `unknown`：列出活动任务失败，无法排除「已恢复」→ 调用方保留条目等下一次重试（同一口径
 *    见 `workspaceInUseByOtherActiveSession` 的 unknown）。
 */
async function ledgerSessionActivity(
  wired: PsbWorkspaceReleasePorts,
  localSessionId: string,
): Promise<'ended' | 'active' | 'unknown'> {
  if (!wired.listActivePsbSessions) return 'ended';
  try {
    const active = await wired.listActivePsbSessions();
    return active.some((entry) => entry.sessionId === localSessionId) ? 'active' : 'ended';
  } catch {
    return 'unknown';
  }
}

async function releaseSessionTransports(
  wired: PsbWorkspaceReleasePorts,
  request: PsbWorkspaceReleaseRequest,
): Promise<void> {
  await wired
    .releaseTransports({ sessionId: request.sessionId, remoteHostId: request.remoteHostId ?? '' })
    .catch(() => undefined);
}

/** 本机持久化的 `psbSessionId → workspaceId`（读不到就 `null`，不抛）。 */
function knownWorkspaceIdFor(
  wired: PsbWorkspaceReleasePorts,
  psbSessionId: string,
): string | null {
  try {
    return wired.workspaceIdForPsbSession?.(psbSessionId) ?? null;
  } catch {
    return null;
  }
}

type AttemptResult =
  | { readonly kind: 'ok'; readonly outcome: PsbWorkspaceReleaseOutcome }
  | {
      readonly kind: 'failed';
      readonly message: string;
      readonly failureCode: string | null;
      /** 失败那一步**已知**的工作区 id（读会话行成功过就有）；重试据此直接释放。 */
      readonly workspaceId: string | null;
    };

/** 真正的一次尝试（不读写账本）：调用方决定失败是入账（会话结束）还是保留/淘汰（重试）。 */
async function attemptRelease(input: {
  wired: PsbWorkspaceReleasePorts;
  psbSessionId: string;
  request: PsbWorkspaceReleaseRequest;
  options?: PsbWorkspaceReleaseOptions;
}): Promise<AttemptResult> {
  const { wired, psbSessionId, request, options } = input;
  let workspaceId: string | null = null;
  try {
    const status = await wired.readSessionStatus(psbSessionId);
    const workspace = status.workspace;
    workspaceId = workspace.id;
    if (!workspace.occupancy.occupied || !workspace.occupancy.byMe) {
      // 已经空出来（或被人接手）：占用口径已达成，不再发释放。
      wired.invalidateSessionStatus(psbSessionId);
      await releaseSessionTransports(wired, request);
      return { kind: 'ok', outcome: { ok: true, released: false, reason: 'not-held' } };
    }
    if (!options?.ignoreOtherActiveSessions) {
      const use = await workspaceInUseByOtherActiveSession(wired, workspace.id, {
        sessionId: request.sessionId,
        psbSessionId,
      });
      if (use.inUse) {
        // 工作区还是「我们」在用的（只是这条任务结束了）：锁留到最后一个任务结束。
        // 本会话的隧道照样收掉（任务已终态，不再需要长连接），锁不受影响。
        await releaseSessionTransports(wired, request);
        wired.log.info('psb workspace release skipped: another active task still uses the workspace', {
          sessionId: request.sessionId,
          psbSessionId,
          workspaceId: workspace.id,
          reason: request.reason,
          checked: use.checked,
        });
        return { kind: 'ok', outcome: { ok: true, released: false, reason: 'workspace-in-use' } };
      }
    }
    await wired.releaseWorkspace(workspace.id);
    wired.invalidateSessionStatus(psbSessionId);
    wired.invalidateWorkspaceLock?.(workspace.id);
    wired.log.info('psb workspace released at session end', {
      sessionId: request.sessionId,
      psbSessionId,
      workspaceId: workspace.id,
      reason: request.reason,
    });
    await releaseSessionTransports(wired, request);
    return { kind: 'ok', outcome: { ok: true, released: true, reason: 'released' } };
  } catch (error) {
    const failureCode = failureCodeOf(error);
    const message = error instanceof Error ? error.message : String(error);
    // 会话行读不到（含 404）时，本机持久化的「会话→工作区」映射仍能让我们按工作区归还这把锁；
    // 记进账本，重试就不必再依赖 PSB 会话行（见文件头「账本」）。
    const resolvedWorkspaceId = workspaceId ?? knownWorkspaceIdFor(wired, psbSessionId);
    wired.log.warn('psb workspace release at session end failed (kept for retry)', {
      sessionId: request.sessionId,
      psbSessionId,
      workspaceId: resolvedWorkspaceId,
      reason: request.reason,
      failureCode,
      error: message,
    });
    return { kind: 'failed', message, failureCode, workspaceId: resolvedWorkspaceId };
  }
}

/**
 * 会话结束 → 释放它占用的 PSB 工作区。
 *
 * 幂等且可重试；**不抛异常**（终态清理路径不该因为远端不可达而失败）。返回值描述结果，
 * 失败时已记进账本。
 */
export async function releasePsbWorkspaceForSession(
  request: PsbWorkspaceReleaseRequest,
  options?: PsbWorkspaceReleaseOptions,
): Promise<PsbWorkspaceReleaseOutcome> {
  const psbSessionId = parsePsbRemoteHostId(request.remoteHostId);
  if (!psbSessionId) {
    return { ok: true, released: false, reason: 'not-psb' };
  }
  const wired = ports;
  if (!wired) {
    // 未装配（Node Host / 单测 / 早期启动）：不制造假失败，也不记账。
    return { ok: true, released: false, reason: 'not-wired' };
  }
  const now = wired.now ?? (() => Date.now());
  const key = pendingKey(request);
  const attempt = await attemptRelease({ wired, psbSessionId, request, options });
  if (attempt.kind === 'ok') {
    // 本次释放成功（或本来就不需要释放）：账本少一条，推送一次让常驻提示条收敛。
    dropPending(key);
    return attempt.outcome;
  }
  recordPendingFailure({
    key,
    request,
    failureCode: attempt.failureCode,
    message: attempt.message,
    workspaceId: attempt.workspaceId,
    now: now(),
    wired,
  });
  return {
    ok: false,
    code: 'PSB_RELEASE_FAILED',
    message: attempt.message,
    failureCode: attempt.failureCode,
  };
}

/**
 * 重试一条账本条目；返回「是否已出账（本次解决 / 淘汰）」。
 *
 * 顺序（二轮审查 s2 P1 + 终局复审 P1）：
 *   1. 账号边界变了 → 出账（新身份不能替旧账号归还）；
 *   2. 会话又被恢复成活动任务 → 只出账（见 `ledgerSessionActivity`）；活动任务列表读不到 →
 *      保留条目（无法排除已恢复）；
 *   3. 已知 workspaceId → 直接 `releaseWorkspace`，**不读 PSB 会话行**（会话 404 也能归还）。
 *      同工作区还有别的活动任务时出账（那条任务结束时自会释放）；「无法确认在用」（unknown）
 *      保留条目，不算「别人在用」；
 *      `NOT_FOUND` / `FORBIDDEN` / 被他人占用 → 终止归因、出账；
 *   4. workspaceId 未知 → 回退「读会话行」的完整路径；读到的 workspaceId 写回账本供下次直连，
 *      会话 404 且没有 workspaceId → 无法定位锁，出账并留 `session-missing` 归因。
 */
async function retryPendingRelease(input: {
  key: string;
  entry: StoredPendingRelease;
  options?: PsbWorkspaceReleaseOptions;
}): Promise<boolean> {
  const { key, options } = input;
  const wired = ports;
  if (!wired) return false;
  const current = pending.get(key);
  if (!current) return true;
  const now = wired.now ?? (() => Date.now());

  const currentScope = currentOwnerScope(wired);
  if (
    current.dataOwnerScope !== null
    && currentScope !== null
    && current.dataOwnerScope !== currentScope
  ) {
    dropPending(key);
    wired.log.warn('psb pending workspace release dropped at an account boundary', {
      key,
      psbSessionId: current.info.psbSessionId,
      attribution: 'owner-changed',
    });
    return true;
  }

  const request: PsbWorkspaceReleaseRequest = {
    sessionId: current.localSessionId,
    remoteHostId: current.info.remoteHostId || null,
    reason: current.info.reason,
  };

  // 「这条会话又 active 了」必须在任何释放动作之前复核（终局复审 P1）：归档 → 入账 → 用户恢复
  // 该任务 → 点提示条重试，此时锁正被恢复的任务合法占用。见 `ledgerSessionActivity`。
  const ledgersActivity = await ledgerSessionActivity(wired, current.localSessionId);
  if (ledgersActivity === 'active') {
    // 只出账：这次「任务结束」已不成立，不释放工作区，也不收隧道（隧道正被恢复的任务用着）。
    // 等它下一次真的结束时，`releasePsbWorkspaceForSession` 会重新发起一轮释放。
    dropPending(key);
    wired.log.info('psb pending workspace release resolved: the session is active again', {
      key,
      sessionId: current.localSessionId,
      psbSessionId: current.info.psbSessionId,
      workspaceId: current.info.workspaceId,
    });
    return true;
  }
  if (ledgersActivity === 'unknown') {
    // 连「本机还有哪些活动 psb 任务」都读不到：无法排除会话已恢复，保留条目等下一次重试。
    wired.log.warn(
      'psb pending workspace release kept: cannot verify whether the session is active again',
      { key, sessionId: current.localSessionId, psbSessionId: current.info.psbSessionId },
    );
    return false;
  }

  if (current.info.workspaceId) {
    const workspaceId = current.info.workspaceId;
    if (!options?.ignoreOtherActiveSessions) {
      const use = await workspaceInUseByOtherActiveSession(wired, workspaceId, {
        sessionId: request.sessionId,
        psbSessionId: current.info.psbSessionId,
      });
      if (use.inUse) {
        if (use.checked === 'unknown') {
          // 「无法确认在用」≠「别人在用」（终局复审 P1）：只凭 `inUse:true` 就 dropPending 会把
          // 待释放义务和提示条一起静默丢掉（锁留在自己名下，谁也不知道）。只有 mapping /
          // session-status 确证有人在用才出账；证据不足时保留条目，下一次重试再核。
          wired.log.warn(
            'psb pending workspace release kept: cannot verify whether another active task uses the workspace',
            { key, workspaceId, checked: use.checked },
          );
          return false;
        }
        // 工作区仍在用（这条任务早已结束）：锁由最后一个任务结束时交还，本条出账。
        await releaseSessionTransports(wired, request);
        dropPending(key);
        wired.log.info('psb pending workspace release resolved: the workspace is used by another active task', {
          key,
          workspaceId,
          checked: use.checked,
        });
        return true;
      }
    }
    try {
      await wired.releaseWorkspace(workspaceId);
      wired.invalidateSessionStatus(current.info.psbSessionId);
      wired.invalidateWorkspaceLock?.(workspaceId);
      // 任务早已结束：这条重试成功时把它的隧道也收掉（重复调用是幂等的）。
      await releaseSessionTransports(wired, request);
      dropPending(key);
      wired.log.info('psb pending workspace release retried by workspace id', {
        key,
        workspaceId,
        attempt: current.info.attempt + 1,
      });
      return true;
    } catch (error) {
      const failureCode = failureCodeOf(error);
      const message = error instanceof Error ? error.message : String(error);
      if (failureCode && TERMINAL_RELEASE_FAILURE_CODES.has(failureCode)) {
        // 终止归因：工作区已不存在（NOT_FOUND / FORBIDDEN）或已被别人接手。
        dropPending(key);
        wired.log.warn('psb pending workspace release dropped: attribution=workspace-unavailable', {
          key,
          workspaceId,
          failureCode,
          attribution: failureCode === 'WORKSPACE_OCCUPIED_BY_OTHER' ? 'occupied-by-other' : 'workspace-missing',
          error: message,
        });
        return true;
      }
      rewritePendingFailure({
        key,
        previous: current,
        failureCode,
        message,
        workspaceId,
        now: now(),
      });
      return false;
    }
  }

  const attempt = await attemptRelease({
    wired,
    psbSessionId: current.info.psbSessionId,
    request,
    options,
  });
  if (attempt.kind === 'ok') {
    dropPending(key);
    return true;
  }
  if (attempt.failureCode && TERMINAL_MISSING_FAILURE_CODES.has(attempt.failureCode)) {
    // 没有 workspaceId 就无法定位该还哪把锁：会话 404 后只能出账并把归因写清楚。
    dropPending(key);
    wired.log.warn('psb pending workspace release evicted: attribution=session-missing', {
      key,
      psbSessionId: current.info.psbSessionId,
      failureCode: attempt.failureCode,
      error: attempt.message,
    });
    return true;
  }
  // 本次读到了 workspaceId 就写回账本：下一次重试直接按工作区释放。
  rewritePendingFailure({
    key,
    previous: current,
    failureCode: attempt.failureCode,
    message: attempt.message,
    workspaceId: attempt.workspaceId,
    now: now(),
  });
  return false;
}

/**
 * 应用退出 / 账号边界 / 用户显式重试：把账本里所有待重试的释放再试一次（尽力而为）。
 *
 * 不做后台轮询（工程契约 §3.2：重试只由真实动作或退出触发）。
 */
export async function retryPendingWorkspaceReleases(
  options?: PsbWorkspaceReleaseOptions,
): Promise<{
  attempted: number;
  released: number;
  failed: number;
}> {
  const snapshot = [...pending.entries()];
  let released = 0;
  let failed = 0;
  for (const [key, entry] of snapshot) {
    const resolved = await retryPendingRelease({ key, entry, options });
    if (resolved) released += 1;
    else failed += 1;
  }
  return { attempted: snapshot.length, released, failed };
}

/**
 * 应用退出：把**当前仍占用 PSB 工作区的活动任务**逐个交还。
 *
 * 退出后本机的「占有者」身份就不存在了，但 PSB 侧那把锁还挂着 —— 同事/另一台设备
 * 接手同一工作区时会被 `PSB_WORKSPACE_OCCUPIED_BY_OTHER` 挡住。
 *
 * 并行发出所有释放（每个都是一次会话读 + 一次释放），由退出协调器给整体预算；
 * 来不及完成的那些只会留在账本里（进程退出即丢），所以这里**不**做串行重试。
 * 单条失败已经被 `releasePsbWorkspaceForSession` 记进账本并打日志。
 *
 * **退出时所有活动任务都在结束**：跳过「同工作区还有别的活动任务」检查，否则同一工作区里
 * 的多条任务会互相认为对方还在用，谁都不释放。
 */
export async function releaseActivePsbWorkspacesForQuit(input: {
  listActiveSessions(): Promise<ReadonlyArray<{
    readonly sessionId: string;
    readonly remoteHostId: string | null;
  }>>;
}): Promise<{ attempted: number; released: number; failed: number }> {
  if (!ports) return { attempted: 0, released: 0, failed: 0 };
  let sessions: ReadonlyArray<{ sessionId: string; remoteHostId: string | null }>;
  try {
    sessions = await input.listActiveSessions();
  } catch {
    return { attempted: 0, released: 0, failed: 0 };
  }
  const targets = sessions.filter((entry) => parsePsbRemoteHostId(entry.remoteHostId) !== null);
  const outcomes = await Promise.all(targets.map((entry) => releasePsbWorkspaceForSession({
    sessionId: entry.sessionId,
    remoteHostId: entry.remoteHostId,
    reason: 'app-quit',
  }, { ignoreOtherActiveSessions: true })));
  let released = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    if (!outcome.ok) failed += 1;
    else if (outcome.released) released += 1;
  }
  return { attempted: targets.length, released, failed };
}
