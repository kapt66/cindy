/**
 * PSB 工作区**占用闸门**：写操作前确保「这个工作区是我锁定（占用）的」。
 *
 * ## 为什么需要它（Cindy 侧口径，2026-11-26）
 *
 * PSB 服务端会对工作区写操作做占用闸门：**不属于自己的锁定就拒绝写入**。Cindy 因此在
 * 「开新会话 / 启动串流 / 发送消息」之前都必须自己确认，而不是等 PSB 拒绝后再把一句不可
 * 行动的失败转给用户。三条入口共用这一个助手，口径只有一处：
 *
 * - 已由自己占用 → 放行。
 * - 工作区空闲 → **不自动占用**（2026-11-27 用户复测口径：**任何工作区占用都必须由用户
 *   确认**）。缺省返回 `occupy-required`；只有显式用户动作的调用点（例如用户已确认的选择 /
 *   占用流程）才可传 `allowAutoOccupy: true`，此时才幂等占用一次。
 * - 被他人占用 → `occupied-by-other`（带占用人名，供文案插值）。
 * - 客户端离线 / 工作区不可用（未就绪、已不可见）→ 对应 reason，让调用方给可行动的下一步。
 * - 网络 / 鉴权失败 → **原样抛**（沿用 `PSB_*` 映射），不静默当成「可以写」。
 *
 * ## 读口
 *
 * 状态一律从工作区行判断。**不要**打 `GET /workspaces/:id`：那条路由在 Cindy JWT 白名单里不放行，
 * 恒 403（2026-11-26 真机，见 `psbClient.readWorkspaceWebUrl`）。
 *
 * 真实请求数（不要按「一次」估）：
 *
 * - `ensure()` 不命中缓存 → **1 次列表 HTTP**（`GET /api/cindy/remote/workspaces`）；
 * - `ensureForSession()` 不命中缓存 → **2 次 HTTP**：PSB 没有「读单个工作区」路由，读会话行
 *   （`GET …/sessions/:id`）拿到 `workspaceId` 之后必须再读一次列表才能拿到占用/在线/usable
 *   ——会话行只带工作区 id，不带工作区快照（`psbClient.getSession` 的实现里写明了这一点）；
 * - 命中乐观有效期 → **0 次**（仅**非权威**调用方；发送闸门不适用，见下条）。
 * - `allowAutoOccupy: false` 且工作区空闲 → **0 次占用请求**（只有读口那 1/2 次 HTTP）。
 *
 * 调用方已经手上有新鲜工作区行时（例如管理页刚读的列表），用 `snapshot` 传进来即可把
 * 上面两次请求都省掉。
 *
 * ## 缓存与新鲜度（权威校验与 TTL 是两套口径）
 *
 * 只有**成功锁定**会被记住（`PSB_WORKSPACE_LOCK_TTL_MS`，默认 1.5s）；失败一律不缓存。
 *
 * - **发送闸门必须权威**（2026-11-27 用户口径）：会话创建后工作区可能被交接给别人，所以
 *   **每条用户消息发送前**都按 `requireAuthoritative: true` 读一次 PSB 会话行 + 一次工作区列表
 *   （共 2 次 HTTP，原因见「读口」）再判断；无人占用 → `occupy-required`（**不**自动占用）。
 *   **不允许**用本地快照 / 乐观缓存替代这次读取——用户要的是「发送前我确实仍占着这个工作区」，
 *   不是「1.5s 前是」。
 * - **其它调用方**保留乐观有效期：工作区级 `ensure()`（发送前重建的建会话、启动串流、管理页占用
 *   等既有路径）与 `ensureForSession()` 的**缺省**分支都按 TTL 命中零请求（生产上
 *   `ensureForSession` 目前只有发送闸门调用，且固定传 `requireAuthoritative`）。
 * - 权威读取失败（网络 / 鉴权）**原样抛**，发送路径据此**不发送**：无法确认就不是「可以写」。
 */

import { createIpcError } from '../../shared/ipc-errors.js';
import type {
  PsbRemoteFailure,
  PsbRemoteWorkspace,
  PsbSessionStatusResult,
} from '../../shared/psb-remote-workspace.js';
import { PSB_ERROR_CODES, psbWorkspaceWritable } from '../../shared/psb-remote-workspace.js';
import { PsbClientError } from './psbClient.js';
import type { PsbWorkspaceOperationOutcome } from './psbClient.js';

/** 成功锁定的乐观有效期。见文件头「缓存与新鲜度」。 */
export const PSB_WORKSPACE_LOCK_TTL_MS = 1_500;

export type PsbWorkspaceLockSnapshot = Pick<
  PsbRemoteWorkspace,
  'id' | 'state' | 'clientOnline' | 'occupancy' | 'usable' | 'unusableReason'
>;

export type PsbWorkspaceLockResult =
  /** 工作区此刻由当前身份占用（可能是本次显式允许的自动占用）。 */
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'occupied-by-other'; readonly personName: string }
  /**
   * 工作区空闲，但本次调用**不是用户的显式占用动作**（`allowAutoOccupy: false` 的缺省口径）。
   *
   * 占用闸门**没有**发出任何占用请求：渲染层据此弹「需要占用这个工作区」确认框，用户确认后
   * 走显式占用（`psb-remote:occupy-workspace`）再重试发起的那次动作。
   */
  | { readonly ok: false; readonly reason: 'occupy-required' }
  | { readonly ok: false; readonly reason: 'offline' }
  | {
      readonly ok: false;
      readonly reason: 'workspace-unavailable';
      /** `true` = 工作区已不可见（被删 / 无权限）；`false` = 可见但未就绪（`state` 给了原因）。 */
      readonly missing: boolean;
      readonly state: string | null;
    };

export interface PsbWorkspaceLockLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface PsbWorkspaceLockPorts {
  /** 工作区列表（读口只认列表，见文件头「读口」的请求数说明）。 */
  listWorkspaces(): Promise<PsbRemoteWorkspace[]>;
  /** 占用工作区（PSB 侧幂等：已由自己占用时原样返回）。0.1.180 起响应可能带建议性 VCS 通知。 */
  occupyWorkspace(workspaceId: string): Promise<PsbWorkspaceOperationOutcome>;
  /**
   * 读一条 PSB 会话（`ensureForSession` 用）。
   *
   * 注意**成本是 2 次 HTTP**：会话行只带 `workspaceId`，占用/在线/usable 必须再从工作区列表取
   * （生产实现 = `psbClient.getSession`，它内部先读会话行、再读列表）。乐观有效期内不会调用它。
   * 缺省时 `ensureForSession` 抛错（装配漏了就是这个 bug）。
   */
  readSession?(psbSessionId: string): Promise<PsbSessionStatusResult>;
  logger?: PsbWorkspaceLockLogger;
}

export interface PsbWorkspaceLockEnsureOptions {
  /** 调用方刚读到的、**足够新**的工作区快照（优先于列表/缓存）。 */
  readonly snapshot?: PsbWorkspaceLockSnapshot | null;
  /**
   * 工作区空闲时是否允许闸门**替用户占用**。缺省 `false`（2026-11-27 用户复测口径：
   * 所有工作区占用都必须由用户通过弹窗确认，禁止任何默认/自动占用）。
   *
   * 只有**显式用户动作**（用户已确认的占用 / 选择流程）的调用点才可以传 `true`；发送 /
   * 启动串流 / 建会话这类隐式写路径必须保持 `false`，空闲时返回 `occupy-required`，
   * 由渲染层弹确认框、用户确认后再走显式占用入口。
   */
  readonly allowAutoOccupy?: boolean;
}

export interface PsbWorkspaceLockEnsureSessionOptions {
  /**
   * `true` = **跳过**乐观缓存，每次都读一次权威事实（PSB 会话行 + 工作区行）。
   *
   * 发送路径（`preparePsbWorkspaceLock`）固定用它：用户口径是「**每条消息发送前**都必须确认
   * 工作区此刻由我占用」，会话创建后被交接出去时不能凭本地缓存继续以为还是我的。
   * 其它调用方省略该字段，保留 `PSB_WORKSPACE_LOCK_TTL_MS` 的乐观有效期。
   */
  readonly requireAuthoritative?: boolean;
  /**
   * 工作区空闲时是否允许闸门**替用户占用**。缺省 `false`，语义与
   * {@link PsbWorkspaceLockEnsureOptions.allowAutoOccupy} 相同；发送闸门必须保持 `false`。
   */
  readonly allowAutoOccupy?: boolean;
}

export interface PsbWorkspaceLock {
  /**
   * 确保工作区由当前身份占用；`allowAutoOccupy` 时才可能自动占用一次。
   *
   * 返回结果描述「为什么不能写」；**网络/鉴权失败以异常抛出**（不静默）。
   */
  ensure(
    workspaceId: string,
    options?: PsbWorkspaceLockEnsureOptions,
  ): Promise<PsbWorkspaceLockResult>;
  /**
   * 发送前闸门（按 PSB 会话定位工作区）。
   *
   * - 缺省（**非权威**）：乐观有效期内命中「已知工作区 + 已确认锁定」→ 零请求放行；否则读一次
   *    （`readSession`，自带工作区快照）再判断。保留给不走「每条消息权威校验」的调用方。
   * - `requireAuthoritative: true`（**发送路径**）：跳过乐观缓存，每次都读一次会话行判定；
   *   读完按事实更新缓存，读出的占用不是「由我占用」时先清掉本地乐观缓存。
   *
   * **会话行读不到（404/403）按异常抛出**：发送路径会先走发送前重建，重建后的新会话 id 再进来。
   */
  ensureForSession(
    psbSessionId: string,
    options?: PsbWorkspaceLockEnsureSessionOptions,
  ): Promise<PsbWorkspaceLockResult>;
  /** 该工作区是否在乐观有效期内已被确认由我锁定（**非权威**发送路径用它避开多余请求）。 */
  isFresh(workspaceId: string): boolean;
  /** 占用状态被本地动作改变（占用 / 释放）后失效缓存。 */
  invalidate(workspaceId: string): void;
  clear(): void;
}

export function createPsbWorkspaceLock(
  ports: PsbWorkspaceLockPorts,
  options: { ttlMs?: number; now?: () => number } = {},
): PsbWorkspaceLock {
  const ttlMs = options.ttlMs ?? PSB_WORKSPACE_LOCK_TTL_MS;
  const now = options.now ?? (() => Date.now());
  /** workspaceId → 乐观有效期截止时间。只记「已确认由我锁定」，不记失败。 */
  const lockedUntil = new Map<string, number>();

  function rememberLocked(workspaceId: string): void {
    const expiry = now() + ttlMs;
    lockedUntil.delete(workspaceId);
    lockedUntil.set(workspaceId, expiry);
    // 表很小，但还是给个上限：频繁切换工作区的进程不该无限增长。
    while (lockedUntil.size > 32) {
      const oldest = lockedUntil.keys().next();
      if (oldest.done) break;
      lockedUntil.delete(oldest.value);
    }
  }

  function isFresh(workspaceId: string): boolean {
    const expiry = lockedUntil.get(workspaceId);
    if (expiry === undefined) return false;
    if (expiry <= now()) {
      lockedUntil.delete(workspaceId);
      return false;
    }
    return true;
  }

  /** 占用动作本身抛 PSB 失败时，把可归因的两种收敛成结果，其余原样抛。 */
  function lockFailureFromError(error: unknown): PsbWorkspaceLockResult | null {
    if (!(error instanceof PsbClientError)) return null;
    switch (error.failure.code) {
      case 'WORKSPACE_OCCUPIED_BY_OTHER':
        // `psbClient` 已把该失败的 message 收敛成「占用人名 / 空串」，可直接给文案插值。
        return {
          ok: false,
          reason: 'occupied-by-other',
          personName: (error.failure.message ?? '').trim(),
        };
      case 'CLIENT_OFFLINE':
        return { ok: false, reason: 'offline' };
      case 'NOT_FOUND':
      case 'FORBIDDEN':
        return { ok: false, reason: 'workspace-unavailable', missing: true, state: null };
      default:
        return null;
    }
  }

  async function decideFrom(
    workspace: PsbWorkspaceLockSnapshot | null,
    workspaceId: string,
    allowAutoOccupy: boolean,
  ): Promise<PsbWorkspaceLockResult> {
    if (!workspace) {
      return { ok: false, reason: 'workspace-unavailable', missing: true, state: null };
    }
    // 「能不能写」的唯一判据（`shared/psb-remote-workspace.ts` 的 `psbWorkspaceWritable`）：
    // 与渲染层禁用态、发送前重建共用同一套 usable / 在线 / 状态 / 占用口径。这里传
    // `requireAgentRuntime:false`：占用闸门是**工作区级写**入口（建会话 / 启串流 / 发送共用），
    // 「这台机器没装某个 Harness」不应该把与它无关的写操作（例如启动串流）一起锁死；
    // 需要 Agent 运行时的调用方（发送前重建）会在自己的入口按严格口径再判一次。
    const writability = psbWorkspaceWritable(workspace, { requireAgentRuntime: false });
    if (!writability.ok) {
      switch (writability.reason) {
        case 'occupied-by-other':
          return {
            ok: false,
            reason: 'occupied-by-other',
            personName: writability.personName,
          };
        case 'client-offline':
          return { ok: false, reason: 'offline' };
        case 'agent-unsupported':
          // `requireAgentRuntime:false` 不会走到这里；保留分支让新增原因时 typecheck 提醒。
          break;
        case 'workspace-not-ready':
        case null:
          break;
      }
      return {
        ok: false,
        reason: 'workspace-unavailable',
        missing: false,
        state: writability.state,
      };
    }
    if (workspace.occupancy.occupied) {
      // writable.ok 已排除「被他人占用」；这里只剩「已由自己占用」的可写行。
      rememberLocked(workspaceId);
      return { ok: true };
    }

    // 未占用：**只有调用方显式允许**（用户已确认的占用 / 选择流程）才自动占用。
    // 隐式写路径（发送 / 启动串流 / 建会话）在这里停下，交给渲染层让用户确认：
    // 不发任何 `POST …/occupy`，也不记乐观缓存（用户还没答应）。
    if (!allowAutoOccupy) return { ok: false, reason: 'occupy-required' };

    // 用户已确认 → 幂等占用（PSB 幂等；并发下最坏是别人先占到，下面按返回行重新判定）。
    let occupied: PsbWorkspaceOperationOutcome;
    try {
      occupied = await ports.occupyWorkspace(workspaceId);
    } catch (error) {
      const mapped = lockFailureFromError(error);
      if (mapped) return mapped;
      throw error;
    }
    if (occupied.workspace.occupancy.byMe) {
      ports.logger?.info('psb workspace lock: occupied the workspace before a write', {
        workspaceId,
      });
      rememberLocked(workspaceId);
      return { ok: true };
    }
    return {
      ok: false,
      reason: 'occupied-by-other',
      personName: occupied.workspace.occupancy.personName.trim(),
    };
  }

  /**
   * psb 会话 id → 工作区 id（会话所属工作区在会话生命周期内不变）。
   *
   * 有界：连续跑很多远程任务也不该让进程内存随会话数增长。
   */
  const sessionWorkspaceIds = new Map<string, string>();

  function rememberSessionWorkspace(psbSessionId: string, workspaceId: string): void {
    sessionWorkspaceIds.delete(psbSessionId);
    sessionWorkspaceIds.set(psbSessionId, workspaceId);
    while (sessionWorkspaceIds.size > 64) {
      const oldest = sessionWorkspaceIds.keys().next();
      if (oldest.done) break;
      sessionWorkspaceIds.delete(oldest.value);
    }
  }

  return {
    async ensure(workspaceId, ensureOptions) {
      const id = workspaceId.trim();
      if (!id) throw createIpcError('INVALID_PARAMS', 'workspaceId is required');
      const snapshot = ensureOptions?.snapshot ?? null;
      const allowAutoOccupy = ensureOptions?.allowAutoOccupy === true;
      if (!snapshot && isFresh(id)) return { ok: true };
      if (snapshot) {
        // 快照即使超过乐观有效期也要用：它比缓存新（调用方刚读的），用它判断不额外花请求。
        return decideFrom(snapshot, id, allowAutoOccupy);
      }
      const workspaces = await ports.listWorkspaces();
      const found = workspaces.find((entry) => entry.id === id) ?? null;
      return decideFrom(found, id, allowAutoOccupy);
    },
    async ensureForSession(psbSessionId, ensureOptions) {
      const sessionId = psbSessionId.trim();
      if (!sessionId) throw createIpcError('INVALID_PARAMS', 'psbSessionId is required');
      // 非权威调用方（发送前重建 / 启动串流等）：乐观有效期内且知道工作区 → 零请求放行。
      // 发送路径（requireAuthoritative）跳过这一段，每次读权威事实。
      if (ensureOptions?.requireAuthoritative !== true) {
        const known = sessionWorkspaceIds.get(sessionId) ?? null;
        if (known && isFresh(known)) return { ok: true };
      }
      const readSession = ports.readSession;
      if (!readSession) {
        throw createIpcError(
          'INTERNAL',
          'the PSB workspace lock is missing its session reader (wiring bug)',
        );
      }
      // 读一次 PSB 会话（+ 一次工作区列表，见端口注释）：它给出此刻的占用事实与工作区。
      const status = await readSession(sessionId);
      rememberSessionWorkspace(sessionId, status.workspace.id);
      // 权威事实不是「由我占用」（无人占用 / 被他人占用 / 未就绪）→ 先清掉该工作区的乐观缓存，
      // 否则非权威调用方会在 TTL 内继续拿「1.5s 前是我的」放行，交接后仍以为锁还在。
      if (!status.workspace.occupancy.byMe) lockedUntil.delete(status.workspace.id);
      return decideFrom(
        status.workspace,
        status.workspace.id,
        ensureOptions?.allowAutoOccupy === true,
      );
    },
    isFresh,
    invalidate(workspaceId) {
      lockedUntil.delete(workspaceId.trim());
    },
    clear() {
      lockedUntil.clear();
      sessionWorkspaceIds.clear();
    },
  };
}

/**
 * 锁定失败 → 可跨 IPC 的失败形状。
 *
 * 只把四种**可行动**失败收成 `PsbClientError`（IPC 层映射成 `PSB_*` 码，渲染层按码取文案）：
 * 需要用户确认占用（工作区空闲且本次不允许自动占用）、被他人占用（带人名）、客户端离线、
 * 工作区不可用/未就绪。网络与鉴权失败不经过这里 —— 它们在 `ensure` 里已经原样抛出。
 */
export function psbWorkspaceLockFailureError(
  result: Exclude<PsbWorkspaceLockResult, { ok: true }>,
): PsbClientError {
  const failure: PsbRemoteFailure = (() => {
    switch (result.reason) {
      case 'occupy-required':
        // 与 PSB 2026-11-27 的守卫契约同码同形（`403 WORKSPACE_NOT_OCCUPIED`）：本机在发请求
        // 之前就给出同一语义，渲染层对两条来源只有一条处置（弹确认框 → 显式占用 → 重试）。
        // message 留空（文案由 messageKey 决定）。
        return {
          code: PSB_ERROR_CODES.workspaceNotOccupied,
          messageKey: 'remoteWorkspace.error.occupyRequired',
          message: null,
        };
      case 'occupied-by-other':
        return {
          code: 'WORKSPACE_OCCUPIED_BY_OTHER',
          messageKey: 'remoteWorkspace.error.occupiedByOther',
          // 与 `psbClient` 的占用失败同口径：message 只放占用人名，渲染层据此回填 `{{name}}`。
          message: result.personName,
        };
      case 'offline':
        return {
          code: 'CLIENT_OFFLINE',
          messageKey: 'remoteWorkspace.error.clientOffline',
          message: null,
        };
      case 'workspace-unavailable':
        return result.missing
          ? {
              code: 'NOT_FOUND',
              messageKey: 'remoteWorkspace.admin.staleMissingTitle',
              message: null,
            }
          : {
              code: 'WORKSPACE_NOT_READY',
              messageKey: 'remoteWorkspace.input.workspaceNotReady',
              // PSB 的 state 值（planned/provisioning/…）是内部枚举：文案由 messageKey 决定，
              // main 不再把内部状态值当用户可读原文下发（诊断看日志）。
              message: null,
            };
    }
  })();
  return new PsbClientError(failure, null);
}

/** `ensure` 结果 → 「不能写」的异常（成功时返回 `null`）。 */
export function psbWorkspaceLockFailure(result: PsbWorkspaceLockResult): PsbClientError | null {
  return result.ok ? null : psbWorkspaceLockFailureError(result);
}
