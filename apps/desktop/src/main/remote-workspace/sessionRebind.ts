/**
 * PSB 远程工作区会话的**发送前透明重建**（rebind）。
 *
 * ## 解决什么
 *
 * PSB 契约里 agent 会话的终态（`stopped` / `failed`）**永不逆转**：那个 PSB 会话
 * 本身不能再开隧道。但这不等于「用户的任务结束了」——本地任务、消息历史、工作区
 * 都还在，只是远端那一条 agent 会话落定了。本地任务的运行时停掉后下一条消息能透明
 * 重建，远程工作区的交互体验因此对齐本地：**用户下一条消息照常发，Cindy 在同一
 * 工作区新建一条 PSB 会话、把本地任务重绑过去，然后继续这一轮**。
 *
 * ## 什么时候重建（判据）
 *
 * 三条同时成立才重建：
 *
 *  1. 本地会话行的 `remoteHostId` 是 `psb:<id>`（唯一依据，见 `shared/psb-remote-workspace.ts`）；
 *  2. 当前**没有回合在跑**（在跑就绝不重建：那会把正在用的隧道换掉）；
 *  3. 该 PSB 会话已终态，**或** PSB 说它不存在（404/403 —— 记录已被清掉，只剩这一条路）。
 *
 * 工作区被他人占用 / 客户端离线 / 工作区未就绪 / 新建失败 ⇒ **不重绑**，把可行动的
 * `PSB_*` 失败码上抛（本地会话行与运行时保持原状，下次发送还能再试）。
 *
 * ## 幂等与并发
 *
 * 同一本地任务的并发发送共享**一次**重建（`inFlight` Map 按本地会话 id 串行化）：
 * 第二条发送 await 第一条的结果，不会建出第二条 PSB 会话。重建失败即刻从 Map 移除，
 * 所以失败后的下一条消息会重新尝试。
 *
 * ## 为什么先落库再关运行时
 *
 * 顺序是「新建 PSB 会话 → 本地会话行落新 `remoteHostId` → 关闭仍持旧身份的空闲
 * runtime → 推事件 → 调用方继续这一轮」。落库成功才算重绑成功；落库失败时会尽力
 * 回收刚建出来的 PSB 会话，本地行不动，因此失败不会把任务弄坏。调用方（发送事务）
 * 在拿到 `rebound` 后关 runtime 并让本次 lazy-create 用新身份开隧道。
 *
 * ## 本模块的纯度
 *
 * 只依赖 `shared/psb-remote-workspace.ts` 与 `shared/ipc-errors.ts` 的类型/纯函数，
 * 不 import Electron、DB、PSB 客户端：所有副作用（读库、PSB 调用、推送）都走注入的
 * deps，因此可以直接单测决策矩阵。
 */

import { createHash } from 'node:crypto';

import {
  buildPsbRemoteHostId,
  parsePsbRemoteHostId,
  psbIpcCodeForFailure,
  psbSessionNeedsRebind,
  psbWorkspaceWritable,
  type PsbCreateSessionRequest,
  type PsbCreateSessionResult,
  type PsbIpcFailureCode,
  type PsbRemoteFailure,
  type PsbRemoteWorkspace,
  type PsbSessionStatusResult,
  type PsbSessionsReboundEvent,
} from '../../shared/psb-remote-workspace.js';
import { createIpcError } from '../../shared/ipc-errors.js';

/* ============================== 1. deps 形状 ============================== */

/** 重建用到的本地会话行字段（DB 真值）。 */
export interface PsbSessionRebindRow {
  /** 本地会话行现在的远程身份；不是 `psb:` 前缀时本模块直接放弃。 */
  readonly remoteHostId: string | null;
  /** DB 形态（`'cc'` / `'codex'` / `'pi'`）—— 新 PSB 会话沿用同一引擎。 */
  readonly agentKind: string | null;
  /** 会话标题（PSB 侧只作展示；空值时用旧 PSB 会话标题兜底）。 */
  readonly title: string | null;
  /** 旧的原生会话 id：重绑后必须清掉，否则新 PSB 会话会去 resume 一个不存在的会话。 */
  readonly sdkSessionId: string | null;
  /**
   * 本地**已记录**的 PSB 工作区 id。
   *
   * 当前版本**没有落库字段**：类型就是 `null`（不是「可能为 null」），读库实现如实返回
   * `null`。工作区 id 的权威来源是旧 PSB 会话行（见 `rebindOnce` 第 2 步）；保留这个字段是为了
   * 将来加列后不必改本模块的决策逻辑（那时把类型放宽成 `string | null` 即可）。
   */
  readonly workspaceId: null;
}

/** PSB 侧读会话的结果：`missing` 只表示 PSB 明确说没有这条记录。 */
export type PsbRebindRemoteLookup =
  | { readonly kind: 'found'; readonly result: PsbSessionStatusResult }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly failure: PsbRemoteFailure };

export type PsbRebindCreateOutcome =
  | { readonly kind: 'created'; readonly result: PsbCreateSessionResult }
  | { readonly kind: 'failed'; readonly failure: PsbRemoteFailure };

export type PsbRebindListOutcome =
  | { readonly kind: 'listed'; readonly workspaces: readonly PsbRemoteWorkspace[] }
  | { readonly kind: 'failed'; readonly failure: PsbRemoteFailure };

export interface PsbSessionRebindLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface PsbSessionRebindDeps {
  readonly log: PsbSessionRebindLogger;
  /** 读本地会话行（单条 indexed select）。 */
  readSessionRow(sessionId: string): Promise<PsbSessionRebindRow | null>;
  /** 当前是否有回合在这个会话上跑（live runtime 的口径，不是 DB）。 */
  isTurnRunning(sessionId: string): boolean;
  /** 读 PSB 会话；`missing` = 404/403（记录不存在或不可见）。 */
  readRemoteSession(psbSessionId: string): Promise<PsbRebindRemoteLookup>;
  /** 按工作区 id 找一行工作区（缓存/占用/在线/就绪的判据来源）。 */
  listWorkspaces(): Promise<PsbRebindListOutcome>;
  /** 在同一工作区新建 PSB 会话（同一 agentKind / title）。 */
  createRemoteSession(input: PsbCreateSessionRequest): Promise<PsbRebindCreateOutcome>;
  /**
   * 落新身份（CAS：只有本地行仍是 `previousRemoteHostId` 时才写）。
   * `conflict` = 期间别人已经改过这一行；调用方按库里的现值继续。
   */
  persistRebind(input: {
    readonly sessionId: string;
    readonly previousRemoteHostId: string;
    readonly remoteHostId: string;
    readonly workspaceId: string;
    /** `true` = 连同 `sdk_session_id` 一起清空（本次重建总会要求清）。 */
    readonly clearNativeSession: boolean;
  }): Promise<'persisted' | 'conflict'>;
  /** 回收「建出来了但没落库」的 PSB 会话（尽力而为，失败只记日志）。 */
  stopRemoteSession(psbSessionId: string): Promise<void>;
  /** 广播 `SESSIONS_REBOUND`（落库成功之后才调）。 */
  emitRebound(event: PsbSessionsReboundEvent): void;
  /**
   * @deprecated 不再使用：去重键由 `(localSessionId, previousPsbSessionId)` **确定性派生**
   * （见 `deriveRebindRequestId`），重试/崩溃恢复会用同一个键，PSB 只建一条会话。
   * 字段保留只为兼容既有装配（`register.ts` 仍传一个零参工厂），调用方可以删掉它。
   */
  createRequestId?(): string;
}

/**
 * 重绑的去重键：由**本地任务 id + 旧 PSB 会话 id** 确定性派生。
 *
 * 为什么不能用随机值（旧实现每次 `randomUUID()`）：重绑是「新会话已建、本地行还没落库」
 * 之间可能失败/崩溃的两步操作。随机键在重试时会变成第二条 PSB 会话（孤儿 + 双份计费）；
 * 确定性键让 PSB 的 `clientRequestId` 去重真正生效——同一个旧身份的重试只会命中同一条会话。
 * 旧身份一变（首轮已落库成新 id），派生值随之改变，等价于一次全新的重建。
 */
export function deriveRebindRequestId(
  localSessionId: string,
  previousPsbSessionId: string,
): string {
  const digest = createHash('sha256')
    .update(`${localSessionId}\u0000${previousPsbSessionId}`)
    .digest('hex');
  return `psb-rebind-${digest.slice(0, 32)}`;
}

/* ============================== 2. 结果形状 ============================== */

export type PsbSessionRebindOutcome =
  /** 不是 `psb:` 会话（本地 / SSH / MCPRouter）：本次发送与重建无关。 */
  | { readonly kind: 'not-psb' }
  /** 是 `psb:` 会话，但这次不需要重建（会话还活着，或有回合在跑）。 */
  | {
      readonly kind: 'already-current';
      readonly remoteHostId: string;
      readonly reason: 'remote-session-alive' | 'turn-running';
    }
  /** 已在同一工作区新建 PSB 会话并重绑到本地任务，调用方继续本次发送。 */
  | {
      readonly kind: 'rebound';
      readonly previousRemoteHostId: string;
      readonly remoteHostId: string;
      readonly workspaceId: string;
    };

export interface PsbSessionRebindCoordinator {
  /**
   * 发送前调用。返回 `null` 表示调用方不需要做任何事（不是 psb 会话 / 本次无需重建）；
   * 返回 `{ previousRemoteHostId, remoteHostId }` 表示已重绑，调用方要关掉仍持旧身份的
   * 空闲 runtime，并让本次 bootstrap 用新的 `remoteHostId`。
   *
   * 失败（工作区被占用 / 离线 / 未就绪 / PSB 不可达 / 新建或落库失败）抛带 `PSB_*`
   * 或 `INTERNAL` 码的 IPC 错误：本地会话行与运行时都保持原状，下一条消息可以重试。
   */
  prepareForSend(
    sessionId: string,
  ): Promise<{ previousRemoteHostId: string; remoteHostId: string } | null>;
}

/* ============================== 3. 失败口径 ============================== */

function failureToIpcError(failure: PsbRemoteFailure): Error {
  const code: PsbIpcFailureCode | 'INTERNAL' = psbIpcCodeForFailure(failure) ?? 'INTERNAL';
  // 占用失败只带占用人名（与 `ipc.ts` 的既有口径一致，渲染层据此回填 `{{name}}`）。
  return createIpcError(code, failure.message ?? '');
}

/** 读会话失败里「PSB 说这条记录不存在/不可见」的形态（其余失败照原样上抛）。 */
function isMissingRemoteSession(failure: PsbRemoteFailure): boolean {
  if (failure.code === 'NOT_FOUND' || failure.code === 'FORBIDDEN') return true;
  return failure.messageKey === 'remoteWorkspace.admin.staleMissingTitle';
}

/**
 * 工作区此刻能不能开新会话；不能就抛**共享判据**给出的失败码。
 *
 * 判据来源是 `psbWorkspaceWritable(workspace, { requireAgentRuntime: true })`（与占用闸门、
 * 渲染层禁用态同一份）：发送前重建要新建 Agent 会话，因此「那台机器没装这个 Harness」也属于
 * 阻断原因。`message` 只带 PSB 原文/空串——中文文案在 i18n，main 不再直出句子；跨进程的
 * 语义由错误码携带（`PSB_*` 表）。
 */
function assertWorkspaceStartable(
  workspace: PsbRemoteWorkspace,
  log: PsbSessionRebindLogger,
  sessionId: string,
): void {
  const writability = psbWorkspaceWritable(workspace, { requireAgentRuntime: true });
  if (writability.ok) return;
  log.warn('psb rebind: the remote workspace is not writable right now', {
    sessionId,
    workspaceId: workspace.id,
    reason: writability.reason,
    state: writability.state,
  });
  // 占用失败的 message 只放占用人名（与 `psbClient` 同口径，渲染层回填 `{{name}}`）；
  // 其余原因没有可展示的 PSB 原文，留空，由码决定文案。
  const message = writability.reason === 'occupied-by-other' ? writability.personName : '';
  throw createIpcError(writability.ipcCode ?? 'INTERNAL', message);
}

/** DB 形态 → PSB 引擎。历史缺省（`'cc'` / 空值）一律 claude-code，与 `agentKindConversion` 同口径。 */
function psbAgentKindFromDb(agentKind: string | null): PsbCreateSessionRequest['agentKind'] {
  if (agentKind === 'codex') return 'codex';
  if (agentKind === 'pi') return 'pi';
  return 'claude-code';
}

/* ============================== 4. 协调器 ============================== */

export function createPsbSessionRebindCoordinator(
  deps: PsbSessionRebindDeps,
): PsbSessionRebindCoordinator {
  /** 本地会话 id → 进行中的一次重建（并发发送共享同一次）。 */
  const inFlight = new Map<string, Promise<PsbSessionRebindOutcome>>();

  async function rebindOnce(sessionId: string): Promise<PsbSessionRebindOutcome> {
    const row = await deps.readSessionRow(sessionId);
    if (!row) return { kind: 'not-psb' };
    const previousRemoteHostId = row.remoteHostId ?? '';
    const previousPsbSessionId = parsePsbRemoteHostId(previousRemoteHostId);
    if (!previousPsbSessionId) return { kind: 'not-psb' };

    if (deps.isTurnRunning(sessionId)) {
      // 在跑的回合正用着这条隧道：绝不换掉它。本次发送随后由事务自己报 SESSION_RUNNING。
      return { kind: 'already-current', remoteHostId: previousRemoteHostId, reason: 'turn-running' };
    }

    // ── 1) 读 PSB 会话：既判断要不要重建，也是工作区 id 的权威来源（重启后同样成立） ──
    let remote: PsbSessionStatusResult | null = null;
    let remoteMissing = false;
    const lookup = await deps.readRemoteSession(previousPsbSessionId);
    if (lookup.kind === 'failed') {
      if (!isMissingRemoteSession(lookup.failure)) throw failureToIpcError(lookup.failure);
      remoteMissing = true;
    } else if (lookup.kind === 'found') {
      remote = lookup.result;
    } else {
      remoteMissing = true;
    }

    if (remote && !psbSessionNeedsRebind(remote.session.status)) {
      return { kind: 'already-current', remoteHostId: previousRemoteHostId, reason: 'remote-session-alive' };
    }

    // ── 2) 解析工作区：权威来源只有旧 PSB 会话行自己的 workspaceId（本地没有这一列） ──
    const workspaceId = (remote?.session.workspaceId ?? '').trim();
    if (!workspaceId) {
      deps.log.warn('psb rebind: cannot resolve the remote workspace for this task', {
        sessionId,
        previousRemoteHostId,
        remoteMissing,
      });
      // main 不直出中文：语义由码携带（`PSB_NOT_FOUND` → 渲染层 i18n 文案），message 留空。
      throw createIpcError('PSB_NOT_FOUND', '');
    }
    let workspace: PsbRemoteWorkspace | null =
      remote && remote.workspace.id === workspaceId ? remote.workspace : null;
    if (!workspace) {
      const listed = await deps.listWorkspaces();
      if (listed.kind === 'failed') throw failureToIpcError(listed.failure);
      workspace = listed.workspaces.find((entry) => entry.id === workspaceId) ?? null;
    }
    if (!workspace) {
      // 工作区不在当前身份可见范围内：共享被取消 / 工作区被删 / 不是归属人。
      deps.log.warn('psb rebind: the remote workspace is not visible to this account', {
        sessionId,
        workspaceId,
        remoteMissing,
      });
      throw createIpcError('PSB_NOT_FOUND', '');
    }
    assertWorkspaceStartable(workspace, deps.log, sessionId);

    // ── 3) 同一工作区新建 PSB 会话（同一引擎 / 标题） ──
    const title = (row.title ?? '').trim() || (remote?.session.title ?? '').trim() || undefined;
    const created = await deps.createRemoteSession({
      workspaceId,
      agentKind: psbAgentKindFromDb(row.agentKind),
      // 确定性去重键（见 `deriveRebindRequestId`）：同一个旧身份的重试复用同一个键，
      // 崩溃/重试不会在 PSB 侧建出第二条孤儿会话。
      clientRequestId: deriveRebindRequestId(sessionId, previousPsbSessionId),
      ...(title === undefined ? {} : { title }),
    });
    if (created.kind === 'failed') throw failureToIpcError(created.failure);

    const newPsbSessionId = created.result.session.id;
    const remoteHostId = buildPsbRemoteHostId(newPsbSessionId);
    const cleanupCreated = async (reason: string): Promise<void> => {
      try {
        await deps.stopRemoteSession(newPsbSessionId);
      } catch (error) {
        deps.log.warn('psb rebind: failed to release the freshly created remote session', {
          sessionId,
          psbSessionId: newPsbSessionId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // ── 4) 先落库：成功才算重绑；失败回收刚建的 PSB 会话，本地状态不动 ──
    let persisted: 'persisted' | 'conflict';
    try {
      persisted = await deps.persistRebind({
        sessionId,
        previousRemoteHostId,
        remoteHostId,
        workspaceId,
        clearNativeSession: true,
      });
    } catch (error) {
      await cleanupCreated('persist-failed');
      throw createIpcError(
        'INTERNAL',
        `Failed to store the rebuilt remote session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (persisted === 'conflict') {
      // 期间有别的一方改了这行（另一实例 / 其它路径）。按库里的现值重来一次决策：
      // 已经指向新身份就让调用方继续（关旧 runtime + 用新身份），否则报可行动错误。
      await cleanupCreated('persist-conflict');
      const after = await deps.readSessionRow(sessionId);
      const afterRemoteHostId = after?.remoteHostId ?? '';
      const afterPsbSessionId = parsePsbRemoteHostId(afterRemoteHostId);
      deps.log.warn('psb rebind: another writer changed the remote identity first', {
        sessionId,
        previousRemoteHostId,
        remoteHostId: afterRemoteHostId || null,
      });
      if (afterPsbSessionId) {
        return {
          kind: 'rebound',
          previousRemoteHostId,
          remoteHostId: afterRemoteHostId,
          workspaceId,
        };
      }
      throw createIpcError('INTERNAL', 'The remote identity changed concurrently.');
    }

    deps.log.info('psb rebind: rebound the task to a freshly created remote session', {
      sessionId,
      previousRemoteHostId,
      remoteHostId,
      workspaceId,
      agentKind: psbAgentKindFromDb(row.agentKind),
      remoteSessionMissing: remoteMissing,
      clearedNativeSession: row.sdkSessionId !== null,
    });
    deps.emitRebound({
      localSessionId: sessionId,
      previousRemoteHostId,
      remoteHostId,
    });
    return { kind: 'rebound', previousRemoteHostId, remoteHostId, workspaceId };
  }

  return {
    async prepareForSend(sessionId) {
      const running = inFlight.get(sessionId);
      if (running) {
        // 并发发送共享同一次重建：等它，再按同一结果/失败前进，绝不建第二条会话。
        const shared = await running;
        return shared.kind === 'rebound'
          ? { previousRemoteHostId: shared.previousRemoteHostId, remoteHostId: shared.remoteHostId }
          : null;
      }
      const attempt = rebindOnce(sessionId).finally(() => {
        if (inFlight.get(sessionId) === attempt) inFlight.delete(sessionId);
      });
      inFlight.set(sessionId, attempt);
      const outcome = await attempt;
      return outcome.kind === 'rebound'
        ? { previousRemoteHostId: outcome.previousRemoteHostId, remoteHostId: outcome.remoteHostId }
        : null;
    },
  };
}
