/**
 * PSB 会话状态的**进程内快照 store** —— 发送前判定的唯一读口。
 *
 * ## 解决什么（审查 r7 P1）
 *
 * PSB 会话状态（`GET /api/cindy/remote/sessions/:id`）此前在**每次发送**都被读一次，而且是
 * 两条独立判定各读一次：发送前透明重建（终态/404 才重绑）与占用闸门。控制面抖动一下，
 * 健康会话就被判成「读不到 → 发送失败」；正常路径也白白两条 GET。可观测事实是：
 * 一次连续对话的消息间隔远小于「远端会话有可能变成终态」的时间尺度，而 PSB 的终态
 * （`stopped` / `failed`）**永不逆转**——所以短 TTL 的乐观快照不会把「还活着」误判成
 * 「活的」，最坏只是把「刚死」晚几秒发现；那几秒里的发送会在**建隧道**时拿到
 * `[PSB_SESSION_STOPPED]` 这类可行动失败，下一次发送照样透明重绑。
 *
 * ## 口径（三条，缺一条都会把抖动重新变成用户可见失败）
 *
 *  1. **TTL**：`PSB_SESSION_STATUS_TTL_MS` 内的快照直接复用，不重复请求。
 *  2. **事件失效**：重绑、停止会话、隧道报出终态/不存在、工作区占用变化都调
 *     `invalidate`/`record`，让快照跟着事实走，而不是干等 TTL 过期。
 *  3. **fail-open**：读失败（网络 / 鉴权 / 协议错）**不**是判定结果 —— 调用方继续这一轮，
 *     真正的终态由建隧道时的 `PSB_*` 码报出。这与「读不到就发送失败」相反，也是本模块
 *     存在的理由：控制面抖动不能把健康会话判失败。
 *
 * 读失败若还有**旧快照**，一并交回（`stale`）：发送前重建可以据此按上次看到的事实
 * 继续决策，而不是完全失明。
 *
 * ## 边界
 *
 * - 只缓存 PSB 会话行（纯数据，无凭据）；进程内存，不落盘（重启后第一次读重新取）。
 * - 有界：`MAX_ENTRIES` 之外的旧条目按插入序淘汰——连续跑很多远程任务不该让内存随会话数涨。
 * - 这里不 import Electron / DB / PSB 客户端：读取实现由装配层注入（`register.ts`），
 *   渲染层侧栏、管理页读口可以共用同一个实例（见 `getPsbSessionStatusStore`）。
 */

import {
  psbSessionNeedsRebind,
  type PsbRemoteFailure,
  type PsbSessionStatus,
  type PsbSessionStatusResult,
} from '../../shared/psb-remote-workspace.js';

/** 快照乐观有效期。见文件头「口径」第 1 条：终态不可逆，晚发现几秒只影响自动重建的时点。 */
export const PSB_SESSION_STATUS_TTL_MS = 10_000;

const MAX_ENTRIES = 64;

export interface PsbSessionStatusSnapshot {
  readonly status: PsbSessionStatusResult;
  /** 取到快照的时刻（unix ms）。 */
  readonly fetchedAt: number;
}

export type PsbSessionStatusLookup =
  /** 有可用快照（`fresh` = 在 TTL 内；`false` = 调用方显式放宽了 maxAge）。 */
  | { readonly ok: true; readonly snapshot: PsbSessionStatusSnapshot; readonly fresh: boolean }
  /** PSB 明确说这条会话记录不存在 / 不可见（404/403）—— 唯一还需要重建的触发条件。 */
  | { readonly ok: false; readonly kind: 'missing' }
  /**
   * 读不到（网络 / 鉴权 / 协议错）。**不是**判定结果：调用方必须 fail-open 继续，
   * `stale` 是上一次已知快照（可能过期，但仍是最近的事实）。
   */
  | {
      readonly ok: false;
      readonly kind: 'unavailable';
      readonly failure: PsbRemoteFailure | null;
      readonly stale: PsbSessionStatusSnapshot | null;
    };

export interface PsbSessionStatusLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface PsbSessionStatusStoreDeps {
  /** 真正打 PSB 的读口（装配层注入 `getPsbRemoteService().sessionStatus`）。 */
  read(psbSessionId: string): Promise<PsbSessionStatusResult>;
  /**
   * 把读取异常分类成「明确不存在」/「读不到」。
   *
   * 缺省实现只看 `PsbClientError` 的 `failure.code`（`NOT_FOUND` / `FORBIDDEN`）：
   * 与 `maker-ipc/register.ts` 的发送前重建同一口径（404/403 = PSB 明确说没有这条记录），
   * 其余失败一律当作「读不到」。
   */
  classifyError?(error: unknown): { missing: true } | { missing: false; failure: PsbRemoteFailure | null };
  now?(): number;
  ttlMs?: number;
  logger?: PsbSessionStatusLogger | null;
  maxEntries?: number;
}

export interface PsbSessionStatusStore {
  /**
   * 读某 PSB 会话的快照。
   *
   * `maxAgeMs: 0` = 强制刷新（发送前重建在「上一次读到终态」之后需要确认）；
   * 缺省用 TTL。读失败不抛异常，而是返回 `unavailable`（调用方 fail-open）。
   */
  read(psbSessionId: string, options?: { readonly maxAgeMs?: number }): Promise<PsbSessionStatusLookup>;
  /** 只查缓存，不发请求（侧栏 / 诊断用）。 */
  peek(psbSessionId: string): PsbSessionStatusSnapshot | null;
  /** 用一次已知的会话行覆盖快照（例如刚创建 / 刚重绑 / 推送通知带回了新状态）。 */
  record(status: PsbSessionStatusResult, at?: number): void;
  /** 事实变了（重绑 / 停止 / 终态 / 占用变化）：丢掉这条快照。 */
  invalidate(psbSessionId: string): void;
  /** 账号边界 / 退出：整体清空。 */
  clear(): void;
}

/**
 * 会话处于终态（或不复存在）才值得重建。判定事实来自共享契约的 `psbSessionNeedsRebind`：
 * 本模块只把它作为「快照 → 要不要重绑」的读口，不另写一份状态枚举。
 */
export function psbSessionStatusNeedsRebind(
  status: PsbSessionStatus | null | undefined,
): boolean {
  return psbSessionNeedsRebind(status);
}

/**
 * 读不到会话状态时的**可行动失败**形状（不是终态判定）。
 *
 * 调用方在「必须给出一个 PSB 失败码」的路径上用它：读不到不等于会话已死，但本轮也确实
 * 无法确认远端身份，所以给的是「远端暂时不可确认」的可重试失败，而不是伪造一个终态。
 */
export function psbStatusUnavailableFailure(failure: PsbRemoteFailure | null): PsbRemoteFailure {
  return failure ?? {
    code: 'PSB_STATUS_UNAVAILABLE',
    messageKey: 'remoteWorkspace.error.clientOffline',
    message: null,
  };
}

/* ============================== 进程级单例 ============================== */

let store: PsbSessionStatusStore | null = null;

/**
 * 装配层（`maker-ipc/register.ts` 的 bootstrap 段）注入唯一读口。
 *
 * 用 setter 而不是 import 具体服务：maker-host 不能反向依赖 `remote-workspace` 的装配
 * （依赖方向见 architecture-invariants），而且这也让本模块可以被单测零依赖地驱动。
 */
export function installPsbSessionStatusStore(deps: PsbSessionStatusStoreDeps): PsbSessionStatusStore {
  store = createPsbSessionStatusStore(deps);
  return store;
}

/** 已装配的 store；未装配（Node Host / 单元测试）返回 `null`，调用方按「没有快照」处理。 */
export function getPsbSessionStatusStore(): PsbSessionStatusStore | null {
  return store;
}

/** 只重置进程级单例（测试 / 账号边界）。 */
export function resetPsbSessionStatusStoreForTests(): void {
  store = null;
}

/* ============================== 实现 ============================== */

export function createPsbSessionStatusStore(
  deps: PsbSessionStatusStoreDeps,
): PsbSessionStatusStore {
  const ttlMs = Math.max(0, deps.ttlMs ?? PSB_SESSION_STATUS_TTL_MS);
  const maxEntries = Math.max(1, deps.maxEntries ?? MAX_ENTRIES);
  const now = deps.now ?? (() => Date.now());
  /** psbSessionId → 快照。插入序即淘汰序。 */
  const entries = new Map<string, PsbSessionStatusSnapshot>();
  /** psbSessionId → 进行中的读取（并发发送共享同一次请求）。 */
  const inFlight = new Map<string, Promise<PsbSessionStatusLookup>>();

  const remember = (psbSessionId: string, snapshot: PsbSessionStatusSnapshot): void => {
    entries.delete(psbSessionId);
    entries.set(psbSessionId, snapshot);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  const classify = deps.classifyError ?? ((error: unknown) => {
    const failure = readPsbFailure(error);
    return failure && (failure.code === 'NOT_FOUND' || failure.code === 'FORBIDDEN')
      ? ({ missing: true } as const)
      : ({ missing: false, failure } as const);
  });

  async function load(psbSessionId: string): Promise<PsbSessionStatusLookup> {
    const startedAt = now();
    try {
      const status = await deps.read(psbSessionId);
      const snapshot: PsbSessionStatusSnapshot = { status, fetchedAt: startedAt };
      remember(psbSessionId, snapshot);
      return { ok: true, snapshot, fresh: true };
    } catch (error) {
      const verdict = classify(error);
      if (verdict.missing) {
        // 明确不存在 = 权威事实：清掉旧快照，避免下一次又拿「上次还活着」当依据。
        entries.delete(psbSessionId);
        return { ok: false, kind: 'missing' };
      }
      deps.logger?.warn('psb session status unavailable (continuing this turn)', {
        psbSessionId,
        failureCode: verdict.failure?.code ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        kind: 'unavailable',
        failure: verdict.failure,
        stale: entries.get(psbSessionId) ?? null,
      };
    }
  }

  return {
    async read(psbSessionId, options) {
      const id = psbSessionId.trim();
      if (!id) return { ok: false, kind: 'missing' };
      const maxAgeMs = Math.max(0, options?.maxAgeMs ?? ttlMs);
      const cached = entries.get(id);
      if (cached && maxAgeMs > 0 && now() - cached.fetchedAt < maxAgeMs) {
        return { ok: true, snapshot: cached, fresh: true };
      }
      const running = inFlight.get(id);
      if (running) return running;
      const attempt = load(id).finally(() => {
        if (inFlight.get(id) === attempt) inFlight.delete(id);
      });
      inFlight.set(id, attempt);
      const lookup = await attempt;
      if (lookup.ok) return lookup;
      if (lookup.kind === 'unavailable') {
        // 读失败但还有旧快照：交回它，让调用方能按最近一次事实继续（fail-open 的输入）。
        // 再取一次缓存：等待期间可能已有并发读取刷新过快照。
        return { ...lookup, stale: lookup.stale ?? entries.get(id) ?? null };
      }
      return lookup;
    },
    peek(psbSessionId) {
      return entries.get(psbSessionId.trim()) ?? null;
    },
    record(status, at) {
      const id = status.session.id.trim();
      if (!id) return;
      remember(id, { status, fetchedAt: at ?? now() });
    },
    invalidate(psbSessionId) {
      entries.delete(psbSessionId.trim());
    },
    clear() {
      entries.clear();
      inFlight.clear();
    },
  };
}

/**
 * 从读取异常里取 PSB 失败字段。
 *
 * 用结构判断而不是 `instanceof PsbClientError`：maker-host 不该 import 传输层实现类
 * （`remote-workspace/psbClient`），而错误对象上稳定携带 `failure` 字段。
 */
function readPsbFailure(error: unknown): PsbRemoteFailure | null {
  if (!error || typeof error !== 'object') return null;
  const failure = (error as { failure?: unknown }).failure;
  if (!failure || typeof failure !== 'object') return null;
  const record = failure as Record<string, unknown>;
  if (typeof record['code'] !== 'string') return null;
  return failure as PsbRemoteFailure;
}
