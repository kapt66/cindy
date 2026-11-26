/**
 * 「远程连接」页的**串流会话状态机**（CINDY-RW-10 渲染层收口，2026-11-26 独立审查 r4）。
 *
 * ## 为什么单独一个 hook
 *
 * 旧实现把「启动 / 停止 / 订阅 / 等首帧 / 失败 / 关闭 / 自动重试 / 可见性释放 / 卸载」压在
 * 1087 行组件与 5 个布尔里（`subscribed` / `streaming` / `starting` / `stopping` / `failure`），
 * 组合爆炸后每次改动都要对账「哪几个布尔不可能同时为真」。这里改成**显式联合状态**：
 *
 * ```
 * idle ──start──▶ starting ──accepted──▶ connecting ──active:false──▶ waiting-frame
 *                    │                        │                              │
 *                    └──failed──▶ error       └────────frame──────▶ streaming ◀┘
 * idle ◀──stopped── stopping ◀──stop（用户 / 页签不可见 / 卸载）
 * error ◀──stream error / 输入通道断开
 * ```
 *
 * - `starting`：用户点「启动」，正在读状态 + 调 `adminStreamStart`；
 * - `connecting`：订阅已建立、还没收到首帧（UI「已连接，等待画面…」）；
 * - `waiting-frame`：已订阅、PSB 状态明确说此刻没有采集在跑（`active:false`），仍在等首帧；
 * - `streaming`：本端收到过帧（**只由 `frame` 事件进入**，PSB 的 `active` 不参与）；
 * - `stopping`：停止请求进行中；
 * - `error`：本轮失败（失败条显示本轮原因；进页时的历史 `lastErrorZh` 只进详情，不产错误条）。
 *
 * ## 生命周期不变量
 *
 * 1. **只自动停止，不自动启动**：进入页面 / 页签重新可见都不开播；页签不可见时释放观看名额。
 * 2. **卸载后不写状态**：`mountedRef` 令牌守卫全部异步续体（`reducer` 派发也先检查），卸载时
 *    只发一次 `adminStreamStop` 释放名额，不做任何 UI 写入。**`starting` 相位卸载也要释放**：
 *    那时 `STREAM_START` 可能还在 PSB 里飞、main 尚未登记 owner，stop 先到会被记成
 *    「启动在途的停止请求」，由 main 在启动落定时直接收尾（`ipc.ts` 的 pending-release 标记）。
 * 3. **多窗口收敛**：主进程在工作区级 stop 后保留观看端绑定，另一个窗口不会收到帧。主进程的
 *    `closed` 补发是主路径；这里再兜一层：绑定从「有」变「无 / 换了」时回 `idle`，以及首帧
 *    超时 watchdog 读一次状态，读不到绑定就回 `idle`（不循环、不自动重连）。
 *    **`closed(superseded)` 是非终态**：main 的观看端被同会话新连接替换时旧 socket 会补发它，
 *    但新 socket 继续往同一个 `sessionId` 送帧，所以这里保留相位、不清屏、不提示。
 * 4. **owner 不泄漏**：事件驱动的结束（`closed` / `error` / 绑定失效 / 输入通道断开 / 播放器
 *    失败）都必须向 main 发一次「仅释放 owner」请求 —— 复用 `adminStreamStop`（main 按
 *    「最后离开者」判据决定是否真的停流，幂等）。否则窗口已经回到 `idle`，停止路径会提前
 *    return（没有可停的东西），main 的 owner 引用计数永远不归零 → 最后一个窗口停止时流不停。
 * 5. **语言切换不重订阅**：事件订阅与状态读取不依赖 `t`；文案经 `translateRef` 取当下语言。
 * 6. **输入通道失败**：节流后提示一次并回 `idle`（画面已经不可用，继续当作在播只会冻住）。
 */

import { useCallback, useEffect, useReducer, useRef, type RefObject } from 'react';
import type { TFunction } from 'i18next';

import {
  readPsbAdminStreamStatus,
  type PsbWorkspaceAdminStreamStatus,
} from '../../../../shared/psb-workspace-admin';
import type { PsbStreamEvent } from '../../../../shared/psb-remote-workspace';
import {
  psbFailureText,
  psbStreamAccessFailureNotice,
  type PsbStreamAccessFailureState,
} from '../psbFailureText';
import { canManuallyStartPsbStream, shouldReleasePsbStreamOnLeave } from './psbStreamLifecycle';
import {
  normalizeWorkspaceAdminStreamStart,
  normalizeWorkspaceAdminStreamStatus,
  type PsbWorkspaceAdminBridge,
} from './psbWorkspaceAdminBridge';

/** 显式联合状态（见文件头状态图）。 */
export type AdminStreamPhase =
  | 'idle'
  | 'starting'
  | 'connecting'
  | 'waiting-frame'
  | 'streaming'
  | 'stopping'
  | 'error';

/** 已建立订阅（含等待首帧）的相位：停止 / 释放只在它上面发生。 */
export function adminStreamPhaseConnected(phase: AdminStreamPhase): boolean {
  return phase === 'connecting' || phase === 'waiting-frame' || phase === 'streaming';
}

/**
 * `starting` 竞态的自动重试间隔（约 2s）。
 *
 * 只在「工作区访问正在启动」时用一次：Unity / 虚拟桌面通常几秒内就就绪，用户点「启动」后干等
 * 不如自动再试一次；不循环（第二次仍失败就停在可行动文案上，由用户决定）。
 */
export const STARTING_RETRY_DELAY_MS = 2_000;

/** 首帧 watchdog：订阅建立后这么久还没有任何帧，读一次状态确认绑定是否还有效。 */
export const FIRST_FRAME_TIMEOUT_MS = 20_000;

/** 输入通道失败提示节流：指针事件会成串失败，只提示第一条。 */
export const INPUT_FAILURE_THROTTLE_MS = 5_000;

/**
 * 串流失败横幅的内容。
 *
 * 三块分开存，是为了让「可行动文案 / PSB 原文（诊断行）/ 在网页启动访问」各就各位：
 * 旧实现只有一句字符串，所有失败都只能显示成「串流失败：操作失败，请稍后重试。」。
 */
export interface StreamFailureBanner {
  /** 主要文案（已本地化，可行动）。 */
  readonly text: string;
  /** PSB 原文（诊断行；`null` = 没有 / 与正文重复）。 */
  readonly detail: string | null;
  /** 横幅归属的状态（只有「没有 running 桌面访问」三档会有值）。 */
  readonly accessState?: PsbStreamAccessFailureState | null;
  /** 是否给「在网页启动访问」按钮（`starting` / `stopping` 的正确动作是等）。 */
  readonly offerOpenWeb?: boolean;
}

interface StreamSessionState {
  readonly phase: AdminStreamPhase;
  readonly status: PsbWorkspaceAdminStreamStatus | null;
  /** 本轮失败（只有本轮动作 / 事件产生；进页时的历史 `lastErrorZh` 不进这里）。 */
  readonly failure: StreamFailureBanner | null;
  /** 观看被 PSB 主动关闭时的中性原话（不是错误条）。 */
  readonly closedNote: string | null;
}

type StreamSessionAction =
  | { readonly type: 'start-request' }
  | {
      readonly type: 'start-accepted';
      readonly status: PsbWorkspaceAdminStreamStatus | null;
    }
  | { readonly type: 'start-failed'; readonly failure: StreamFailureBanner }
  | { readonly type: 'status'; readonly status: PsbWorkspaceAdminStreamStatus }
  | { readonly type: 'frame' }
  | { readonly type: 'stop-request' }
  | { readonly type: 'stopped'; readonly failure: StreamFailureBanner | null }
  | { readonly type: 'closed'; readonly note: string | null }
  | { readonly type: 'stream-error'; readonly failure: StreamFailureBanner }
  | { readonly type: 'remote-stopped' };

const INITIAL_STATE: StreamSessionState = {
  phase: 'idle',
  status: null,
  failure: null,
  closedNote: null,
};

function reduceSession(
  state: StreamSessionState,
  action: StreamSessionAction,
): StreamSessionState {
  switch (action.type) {
    case 'start-request':
      return { ...state, phase: 'starting', failure: null, closedNote: null };
    case 'start-accepted':
      return {
        ...state,
        // 启动返回时 PSB 已明确「采集没在跑」→ 直接进入 `waiting-frame`（等采集开始）；
        // 否则是普通 `connecting`（等首帧）。两者 UI 都显示「已连接，等待画面…」。
        phase: action.status?.active === false ? 'waiting-frame' : 'connecting',
        status: action.status ?? state.status,
        failure: null,
      };
    case 'start-failed':
      return { ...state, phase: 'error', failure: action.failure };
    case 'status': {
      // 状态推送只更新事实与「等待画面」的细分相位：`streaming` 只由帧进入，
      // `active:false` 也不能把已经在播的画面切回未连接（旧实现的两种误判）。
      const next = { ...state, status: action.status };
      if (state.phase === 'connecting' && !action.status.active) {
        return { ...next, phase: 'waiting-frame' };
      }
      return next;
    }
    case 'frame':
      if (state.phase === 'connecting' || state.phase === 'waiting-frame') {
        return { ...state, phase: 'streaming', failure: null };
      }
      if (state.phase === 'streaming') return state;
      // idle / starting / stopping / error 的迟到帧丢弃（不能把已结束的会话画回来）。
      return state;
    case 'stop-request':
      return { ...state, phase: 'stopping' };
    case 'stopped':
      return { phase: 'idle', status: state.status, failure: action.failure, closedNote: null };
    case 'closed':
      return { phase: 'idle', status: state.status, failure: null, closedNote: action.note };
    case 'stream-error':
      return { ...state, phase: 'error', failure: action.failure };
    case 'remote-stopped':
      // 别的窗口停掉 / 绑定失效：静默回未启动（不产错误条，避免误报成这一轮的失败）。
      return { phase: 'idle', status: state.status, failure: null, closedNote: null };
  }
}

/** 串流事件的错误文案：优先 main 给的已本地化 key，其次 PSB 原文，最后通用兜底。 */
function eventFailureMessage(
  t: TFunction,
  failure: Extract<PsbStreamEvent, { type: 'error' }>['failure'],
): string {
  const key = failure.messageKey?.trim();
  if (key) {
    const localized = t(key, { defaultValue: '' });
    if (localized) return localized;
  }
  const message = failure.message?.trim();
  if (message) return message;
  return t('remoteWorkspace.error.unknown');
}

export interface AdminStreamSessionInput {
  readonly bridge: PsbWorkspaceAdminBridge | null;
  readonly workspaceId: string;
  /** stale 时启动 / 停止的可行动原因 key（`null` = 工作区事实可用）。 */
  readonly blockedActionKey: string | null;
  /** 当前 PSB 观看端绑定（`context.viewerSessionId`）：跨窗口 stop / 重绑时用来回 `idle`。 */
  readonly contextViewerSessionId: string | null;
  /** 页签是否可见（不可见时释放观看名额；可见也不自动开播）。 */
  readonly visible: boolean;
  /** 首帧到达（组件送进播放器 + 计数）。 */
  readonly onFrame: (payload: ArrayBuffer) => void;
  /** 清画面（停止 / closed / 错误 / 卸载前的本端复位；不碰远端）。 */
  readonly onClearPicture: () => void;
  /** 文案取当下语言（切语言不重订阅 / 不重开播）。 */
  readonly translate: () => TFunction;
}

export interface AdminStreamSession {
  readonly phase: AdminStreamPhase;
  readonly status: PsbWorkspaceAdminStreamStatus | null;
  readonly failure: StreamFailureBanner | null;
  readonly closedNote: string | null;
  /** 本工作区观看端绑定会话 id（用于过滤串流事件；未知时 `null`）。 */
  readonly viewerSessionIdRef: RefObject<string | null>;
  /** 用户显式启动（`auto:true` 只由「访问正在启动」的一次自动重试用）。 */
  readonly start: (options?: { readonly auto?: boolean }) => void;
  /** 用户显式停止 / 页签不可见释放（幂等）。 */
  readonly stop: () => void;
  /** 「在网页启动访问」：复用既有 `openWebWorkspace`，失败时把真实原因写回横幅。 */
  readonly openWebForAccess: () => void;
  /** 输入通道发送失败：节流提示 + 回 `idle`（画面已不可用）。 */
  readonly reportInputError: (error: unknown) => void;
  /** 播放器自身失败（WebCodecs 不可用 / 解码错误）：进入本轮错误态。 */
  readonly reportFailure: (text: string) => void;
}

export function useAdminStreamSession(input: AdminStreamSessionInput): AdminStreamSession {
  const { bridge, workspaceId, blockedActionKey, contextViewerSessionId, visible } = input;
  const [state, dispatch] = useReducer(reduceSession, INITIAL_STATE);
  const phaseRef = useRef<AdminStreamPhase>(state.phase);
  phaseRef.current = state.phase;
  const mountedRef = useRef(true);
  const stoppingRef = useRef(false);
  const viewerSessionIdRef = useRef<string | null>(contextViewerSessionId);
  /** `starting` 自动重试定时器（卸载 / 再次点击 / 停止时清掉）。 */
  const retryTimerRef = useRef<number | null>(null);
  /** 本次用户点「启动」是否已经自动重试过（每轮用户操作最多一次）。 */
  const retriedStartingRef = useRef(false);
  const lastInputFailureAtRef = useRef(0);

  /** 回调经 ref 取最新：事件订阅 / 定时器不因闭包或依赖变化重挂。 */
  const onFrameRef = useRef(input.onFrame);
  onFrameRef.current = input.onFrame;
  const onClearPictureRef = useRef(input.onClearPicture);
  onClearPictureRef.current = input.onClearPicture;
  const translateRef = useRef(input.translate);
  translateRef.current = input.translate;
  /** 卸载 / 相位检查后仍要能派发（mounted 令牌统一在派发处判）。 */
  const emit = useCallback(
    (action: StreamSessionAction) => {
      if (!mountedRef.current) return;
      dispatch(action);
    },
    [],
  );

  const clearStartingRetry = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  /** `streaming` 的 ref：HUD / 交互 / watchdog 用，不必因 state 变化重挂监听。 */
  const resetViewer = useCallback(() => {
    viewerSessionIdRef.current = null;
    onClearPictureRef.current();
  }, []);

  /**
   * 「本端不再是观看者」：向 main 发一次**仅释放 owner** 的请求。
   *
   * 复用 `adminStreamStop`（工作区级 stop 的语义就是「这个窗口不看了」）：
   *   - main 按「最后离开者」判据决定是否真的停流 —— 别的窗口还在看时只减计数，不会误停；
   *   - 幂等：重复调用只是再减一次（`Set` 语义）。
   *
   * **不能省**：一旦本端已回到 `idle`，用户点「停止」的路径会提前 return（没有可停的东西），
   * 不会再发任何 IPC；owner 引用计数就永久残留，最后一个窗口停止时流也不会停
   * （2026-11-27 复审 P1「多窗口误杀 / owner 泄漏」）。
   */
  const releaseOwnership = useCallback(() => {
    if (!bridge) return;
    void bridge.adminStreamStop({ workspaceId }).catch(() => {
      /* 释放请求失败没有可展示的地方：main 侧窗口销毁兜底会在窗口消失时清账。 */
    });
  }, [bridge, workspaceId]);

  /* -------------------------------- 启动 -------------------------------- */

  const start = useCallback(
    async (options?: { readonly auto?: boolean }) => {
      const phase = phaseRef.current;
      if (!bridge || phase === 'starting' || phase === 'stopping') return;
      if (adminStreamPhaseConnected(phase)) return;
      // 用户亲自点「启动」= 新一轮尝试：允许再自动重试一次（自动重试自己不会重置这个标记）。
      if (!options?.auto) {
        retriedStartingRef.current = false;
        clearStartingRetry();
      }
      // stale：先给「工作区已不可见 / 连不上」的可行动原因，不发一次注定失败的写请求。
      // 页面每 30s / 聚焦时会重读上下文，PSB 恢复后按钮自然回到可用。
      if (blockedActionKey) {
        emit({
          type: 'start-failed',
          failure: {
            text: translateRef.current()(blockedActionKey),
            detail: null,
          },
        });
        return;
      }
      emit({ type: 'start-request' });
      try {
        const next = normalizeWorkspaceAdminStreamStatus(
          await bridge.adminStreamStatus({ workspaceId }),
        );
        if (!mountedRef.current) return;
        if (next) emit({ type: 'status', status: next });
        if (next && !next.capability) {
          // 状态可能刚被推送刷新成 capability:false（按钮的禁用态来自上一次渲染）：用户点了
          // 「启动」却什么都不发生是最糟的反馈，这里给一条能照做的原因。
          emit({
            type: 'start-failed',
            failure: {
              text: translateRef.current()('remoteWorkspace.session.streamUnsupported'),
              detail: null,
            },
          });
          return;
        }
        const started = normalizeWorkspaceAdminStreamStart(
          await bridge.adminStreamStart({ workspaceId }),
        );
        if (!mountedRef.current) {
          // 卸载之后才落定的启动（starting 相位卸载）：cleanup 已经发过一次 stop；这里再发一次
          // 是幂等的，用来兜住「启动先完成、卸载的 stop 后到」的顺序 —— owner 与刚起来的连接
          // 都必须由 main 收掉，不能留成没人认领的观看。
          releaseOwnership();
          return;
        }
        if (!started) {
          emit({
            type: 'start-failed',
            failure: {
              text: translateRef.current()('remoteWorkspace.session.streamFailed', {
                message: translateRef.current()('remoteWorkspace.error.unknown'),
              }),
              detail: null,
            },
          });
          return;
        }
        if (started.viewerSessionId) viewerSessionIdRef.current = started.viewerSessionId;
        // 订阅成功 ≠ 有画面：进入 `connecting`（「已连接，等待画面…」），
        // 「串流中」只能由首帧（`frame` 事件）进入，PSB 的 `active` 不参与该判定。
        emit({ type: 'start-accepted', status: started.status });
        clearStartingRetry();
      } catch (rawFailure) {
        if (!mountedRef.current) return;
        // `input.translate` 是「取当下语言的 t」的 getter（不是 t 本身）：先取再调用，
        // 否则把 key 当参数传给 getter 会得到 t 函数本身（2026-11-26 自测发现的真 bug）。
        const t = translateRef.current();
        const notice = psbStreamAccessFailureNotice(t, rawFailure);
        if (notice) {
          emit({
            type: 'start-failed',
            failure: {
              text: notice.text,
              detail: notice.detail,
              accessState: notice.state,
              offerOpenWeb: notice.offerOpenWeb,
            },
          });
          // `starting` 竞态：访问正在启动，等它落定后自动再试一次；不循环。
          if (notice.retryOnce && !retriedStartingRef.current) {
            retriedStartingRef.current = true;
            clearStartingRetry();
            retryTimerRef.current = window.setTimeout(() => {
              retryTimerRef.current = null;
              void startRef.current?.({ auto: true });
            }, STARTING_RETRY_DELAY_MS);
          }
          return;
        }
        emit({
          type: 'start-failed',
          failure: {
            text: t('remoteWorkspace.session.streamFailed', {
              message: psbFailureText(t, rawFailure),
            }),
            detail: null,
          },
        });
      }
    },
    [blockedActionKey, bridge, clearStartingRetry, emit, releaseOwnership, workspaceId],
  );
  /** 自动重试定时器必须调用**最新**的 `start`：存到 ref，避免定时器闭包捕获旧版本。 */
  const startRef = useRef<typeof start | null>(null);
  startRef.current = start;

  /* -------------------------------- 停止 -------------------------------- */

  const stopInternal = useCallback(
    async (options: { readonly updateUi: boolean }): Promise<void> => {
      clearStartingRetry();
      if (!bridge || stoppingRef.current) return;
      const phase = phaseRef.current;
      if (phase === 'idle' || phase === 'error' || phase === 'stopping') {
        // 已经没有本端订阅：清掉残留画面即可（幂等）。
        if (options.updateUi) onClearPictureRef.current();
        return;
      }
      stoppingRef.current = true;
      if (options.updateUi) emit({ type: 'stop-request' });
      let failure: StreamFailureBanner | null = null;
      try {
        await bridge.adminStreamStop({ workspaceId });
      } catch {
        // 失败也给一条中性、可行动的话；画面与状态照下面无条件复位（不残留旧帧）。
        failure = {
          text: translateRef.current()('remoteWorkspace.session.stopFailed'),
          detail: null,
        };
      } finally {
        stoppingRef.current = false;
        resetViewer();
        if (options.updateUi) emit({ type: 'stopped', failure });
      }
    },
    [bridge, clearStartingRetry, emit, resetViewer, workspaceId],
  );

  const stop = useCallback(() => {
    void stopInternal({ updateUi: true });
  }, [stopInternal]);

  /* --------------------------- 串流事件订阅 --------------------------- */

  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onAdminStreamEvent((event) => {
      if (!mountedRef.current) return;
      const viewerSessionId = viewerSessionIdRef.current;
      // 已知观看端会话 id 时只吃本会话的事件，避免旧会话收尾事件画到新画面里。
      if (viewerSessionId && event.sessionId && event.sessionId !== viewerSessionId) return;
      // 宿主光标形状由 `usePsbStreamCursor` 独立消费（同一条广播允许多个监听者）：
      // 它不是画面生命周期事件，落进下面的 error 兜底会被误报成串流失败。
      if (event.type === 'cursor') return;
      if (event.type === 'frame') {
        // 帧只属于「正在连接 / 等待画面 / 已在播」的相位：停止后 / 卸载前后的迟到帧不能画回画布。
        if (!adminStreamPhaseConnected(phaseRef.current)) return;
        emit({ type: 'frame' });
        onFrameRef.current(event.payload);
        return;
      }
      if (event.type === 'status') {
        // 事件里的 status 已是 PSB wire DTO；共用读口做一次形状归一（未知形状 → 丢弃，保留旧快照）。
        const next = readPsbAdminStreamStatus(event.status);
        if (next) emit({ type: 'status', status: next });
        return;
      }
      if (event.type === 'closed') {
        // 已经被替换的旧连接（main 的观看端被同会话新连接替换）：新连接继续往**同一个**
        // sessionId 送帧，所以这不是终态 —— 保留相位、不清屏、不提示、也不释放 owner。
        // 只有真正结束（远端关闭 / 用户停止 / 别处停掉）才回未启动。
        if (event.reason === 'superseded') return;
        const current = phaseRef.current;
        // 本端已经不在观看（idle）或这正是本端发起的停止（stopping）：closed 是预期收尾，
        // 不再额外汇总成一条「被关闭」说明（否则用户自己点停止也会看到一条提示）。
        if (current === 'idle' || current === 'stopping') {
          resetViewer();
          return;
        }
        resetViewer();
        // 观看已经结束：向 main 释放 owner（最后离开者才真的停流）。不在这里请求的话，
        // 本端回到 idle 后停止路径会提前 return，owner 计数永远不归零。
        releaseOwnership();
        const messageZh = event.detail?.messageZh?.trim() ?? null;
        emit({ type: 'closed', note: messageZh });
        return;
      }
      // error：错误断开不一定会让 main 复位「已订阅」，本端必须自己清屏并进入 error。
      // idle / stopping 下的迟到错误不是「本轮失败」：不产红条（cut 掉已结束会话的收尾噪音）。
      if (!adminStreamPhaseConnected(phaseRef.current)) return;
      resetViewer();
      releaseOwnership();
      const t = translateRef.current();
      emit({
        type: 'stream-error',
        failure: {
          text: t('remoteWorkspace.session.streamFailed', {
            message: eventFailureMessage(t, event.failure),
          }),
          detail: null,
        },
      });
    });
    // 不依赖 `t`：语言切换不能重订阅（旧实现把 t 放进依赖，切语言就重挂事件）。
  }, [bridge, emit, releaseOwnership, resetViewer]);

  /* ----------------------- 进页读一次状态（不产错误条） ----------------------- */

  useEffect(() => {
    // stale 时 main 没有可信的绑定可读（工作区已不可见 / PSB 读不到）：不发这次 IPC。
    if (!bridge || blockedActionKey) return undefined;
    let live = true;
    void bridge
      .adminStreamStatus({ workspaceId })
      .then((result) => {
        if (!live || !mountedRef.current) return;
        const normalized = normalizeWorkspaceAdminStreamStatus(result);
        if (!normalized) return;
        if (result.viewerSessionId) viewerSessionIdRef.current = result.viewerSessionId;
        // 历史 `lastErrorZh` 只进详情 / 空态提示，不产错误条：这一轮还没有任何动作失败（r4 P1）。
        emit({ type: 'status', status: normalized });
      })
      .catch(() => {
        // 连通性错误留给「启动」这个显式动作去报，打开分类时静默。
      });
    return () => {
      live = false;
    };
  }, [blockedActionKey, bridge, emit, workspaceId]);

  /* ----------------------- 页签不可见：释放观看名额 ----------------------- */

  const connected = adminStreamPhaseConnected(state.phase);
  useEffect(() => {
    if (
      !shouldReleasePsbStreamOnLeave({
        visible,
        connected,
        stopping: state.phase === 'stopping',
      })
    ) {
      return;
    }
    void stopInternal({ updateUi: true });
  }, [connected, state.phase, stopInternal, visible]);

  /* --------------------- 多窗口收敛：绑定变化 / 首帧 watchdog --------------------- */

  const previousBindingRef = useRef(contextViewerSessionId);
  useEffect(() => {
    const previous = previousBindingRef.current;
    previousBindingRef.current = contextViewerSessionId;
    if (previous === contextViewerSessionId) return;
    const phase = phaseRef.current;
    if (!adminStreamPhaseConnected(phase)) return;
    // 绑定从「有」变「无 / 换成了别的观看端」：本端不再拥有这条画面（另一个窗口停止 / 重绑）。
    const ours = viewerSessionIdRef.current;
    if (contextViewerSessionId === null || (ours !== null && contextViewerSessionId !== ours)) {
      clearStartingRetry();
      resetViewer();
      // 绑定已经不属于这条连接：main 的 owner 账本里本窗口这一票也必须退掉，否则最后一个
      // 窗口停止时计数不归零、流不停（2026-11-27 复审 P1）。
      releaseOwnership();
      emit({ type: 'remote-stopped' });
    }
  }, [
    clearStartingRetry,
    contextViewerSessionId,
    emit,
    releaseOwnership,
    resetViewer,
  ]);

  useEffect(() => {
    if (state.phase !== 'connecting' && state.phase !== 'waiting-frame') return undefined;
    if (!bridge) return undefined;
    const timer = window.setTimeout(() => {
      if (!mountedRef.current) return;
      const phase = phaseRef.current;
      if (phase !== 'connecting' && phase !== 'waiting-frame') return;
      // 首帧迟迟不到：读一次状态确认绑定是否还有效。读不到 = 本端绑定已不存在
      // （另一个窗口停止 / 主进程断连），静默回 idle；读到了就继续等（可能桌面正在启动）。
      void bridge
        .adminStreamStatus({ workspaceId })
        .then((result) => {
          if (!mountedRef.current) return;
          const current = phaseRef.current;
          if (current !== 'connecting' && current !== 'waiting-frame') return;
          const next = normalizeWorkspaceAdminStreamStatus(result);
          if (!next) {
            resetViewer();
            // 绑定已经不存在（另一个窗口停止 / 主进程断连）：本端观看结束，退掉 owner。
            releaseOwnership();
            emit({ type: 'remote-stopped' });
            return;
          }
          if (result.viewerSessionId) viewerSessionIdRef.current = result.viewerSessionId;
          emit({ type: 'status', status: next });
        })
        .catch(() => {
          /* 读不到状态也可能只是 PSB 抖动：保持等待，不再重试。 */
        });
    }, FIRST_FRAME_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [bridge, emit, releaseOwnership, resetViewer, state.phase, workspaceId]);

  /* --------------------------- 输入失败（节流） --------------------------- */

  const reportInputError = useCallback(
    (error: unknown) => {
      const now = Date.now();
      if (now - lastInputFailureAtRef.current < INPUT_FAILURE_THROTTLE_MS) return;
      lastInputFailureAtRef.current = now;
      // 输入通道失败通常意味着观看端已断：回 idle、清画面、退掉 owner，用统一失败文案说清原因。
      if (!adminStreamPhaseConnected(phaseRef.current)) return;
      clearStartingRetry();
      resetViewer();
      releaseOwnership();
      emit({
        type: 'stream-error',
        failure: { text: psbFailureText(translateRef.current(), error), detail: null },
      });
    },
    [clearStartingRetry, emit, releaseOwnership, resetViewer],
  );

  /* ---------------------------- 在网页启动访问 ---------------------------- */

  const reportFailure = useCallback(
    (text: string) => {
      // 播放器自身失败（WebCodecs 不可用 / 解码错误）= 本端没有可用画面：退掉 owner，
      // 免得一条没人能看的观看连接继续占着 PSB 名额（最后离开者才真的停流）。
      resetViewer();
      releaseOwnership();
      emit({ type: 'stream-error', failure: { text, detail: null } });
    },
    [emit, releaseOwnership, resetViewer],
  );

  const openWebForAccess = useCallback(() => {
    if (!bridge) return;
    void bridge.openWebWorkspace({ workspaceId }).catch((error: unknown) => {
      if (!mountedRef.current) return;
      emit({
        type: 'stream-error',
        failure: { text: psbFailureText(translateRef.current(), error), detail: null },
      });
    });
  }, [bridge, emit, workspaceId]);

  /* ------------------------------- 卸载 ------------------------------- */

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 只发一次释放请求，不写状态（旧实现卸载后仍有 setState 无守护）。
      clearStartingRetry();
      if (!bridge) return;
      // `starting` 也要释放：这时 `STREAM_START` 可能还在 PSB 里飞、main 尚未登记 owner，
      // 但启动一旦落定就会登记 —— main 把这次 stop 记成「启动在途的停止请求」，在启动落定时
      // 直接收尾（`ipc.ts` 的 pending-release 标记）。旧实现只在 connected 相位发 stop，
      // starting 卸载就留下一条僵尸观看订阅（owner 与观看名额都不还）。
      const phase = phaseRef.current;
      if (!adminStreamPhaseConnected(phase) && phase !== 'starting') return;
      void bridge.adminStreamStop({ workspaceId }).catch(() => {
        /* 页面已经不在：错误留给 main 的断连兜底，这里没有可展示的地方。 */
      });
    };
  }, [bridge, clearStartingRetry, workspaceId]);

  return {
    phase: state.phase,
    status: state.status,
    failure: state.failure,
    closedNote: state.closedNote,
    viewerSessionIdRef,
    start: (options) => {
      void start(options);
    },
    stop,
    openWebForAccess,
    reportInputError,
    reportFailure,
  };
}

/** 组件侧的可点性判据（纯函数在 `psbStreamLifecycle.ts`，这里只补上状态机的相位）。 */
export function adminStreamStartDisabled(input: {
  readonly bridgeReady: boolean;
  readonly playerAvailable: boolean;
  readonly capable: boolean;
  readonly phase: AdminStreamPhase;
}): boolean {
  if (input.phase === 'starting' || input.phase === 'stopping') return true;
  if (adminStreamPhaseConnected(input.phase)) return true;
  return !canManuallyStartPsbStream({
    bridgeReady: input.bridgeReady,
    playerAvailable: input.playerAvailable,
    capable: input.capable,
    starting: false,
  });
}

/** 停止按钮是否可用：已连接且不在启动 / 停止中。 */
export function adminStreamStopDisabled(input: {
  readonly bridgeReady: boolean;
  readonly phase: AdminStreamPhase;
}): boolean {
  if (!input.bridgeReady) return true;
  if (input.phase === 'stopping' || input.phase === 'starting') return true;
  return !adminStreamPhaseConnected(input.phase);
}
