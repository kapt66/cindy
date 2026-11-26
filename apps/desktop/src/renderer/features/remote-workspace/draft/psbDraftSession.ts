/**
 * 草稿页的「首条消息懒建 PSB 会话」与「放弃草稿归还远端资源」。
 *
 * ## 为什么懒建
 *
 * 产品口径（2026-11-25）：新建远程工作区时**不选引擎**，Harness/模型在草稿页按既有链路选。
 * 所以弹窗只占用工作区，PSB 会话必须等到用户真正发出第一句话、引擎已经确定时才创建：
 *
 *   · 引擎取发送那一帧草稿的 vendor（`vendorToPsbAgentKind`）；
 *   · 建会话失败 → 不建本地会话、停留草稿重试；
 *   · 重试复用同一个 `clientRequestId`（PSB 侧去重），成功后把 `sessionId` 回写草稿目标，
 *     后续重试/重发直接复用，不会产生第二条 PSB 会话。
 *
 * 这一层不依赖 React/Electron：bridge 与当前目标检查都由调用方注入，单测可以直接钉住
 * 「成功 / 失败 / 在途合并 / 目标已变」四条分支。
 */

import type { NewMakerDraftPsbTarget } from '@/state/newMakerDraft';

import {
  buildPsbRemoteHostId,
  buildPsbVirtualWorkingDir,
  type PsbAgentKind,
} from '../../../../shared/psb-remote-workspace';
import type { PsbRemoteBridge } from '../bridge';
import {
  createPsbClientRequestId,
  readPsbFailure,
  type PsbFailureInfo,
} from '../dialog/psbDialogModel';

/** 一个已确定身份的 PSB 会话（本地会话行要用它做 remoteHostId / 虚拟 workingDir）。 */
export interface PsbDraftSession {
  sessionId: string;
  remoteHostId: string;
  workingDir: string;
}

/** 放弃草稿时等远端 stop 的上限：超时就先释放占用（远端可能已在收尸，不再拖住离开）。 */
const PSB_DRAFT_STOP_TIMEOUT_MS = 3000;

/** 草稿目标 + PSB 会话 id → 本地会话行要写的身份（唯一拼装点）。 */
export function psbSessionOfTarget(
  target: Pick<NewMakerDraftPsbTarget, 'workspaceId' | 'directoryName'>,
  sessionId: string,
): PsbDraftSession {
  return {
    sessionId,
    remoteHostId: buildPsbRemoteHostId(sessionId),
    workingDir: buildPsbVirtualWorkingDir({
      workspaceId: target.workspaceId,
      directoryName: target.directoryName,
    }),
  };
}

export type PsbEnsureFailure =
  | { reason: 'failed'; failure: PsbFailureInfo }
  /** 在途期间草稿目标已被换掉：刚建出的会话已尽力停掉，调用方直接放弃这次发送。 */
  | { reason: 'stale' }
  /** 没有 PSB 桥（旧 preload / 非主窗口）：无法建远端会话。 */
  | { reason: 'unavailable' };

export type PsbEnsureResult =
  | { ok: true; session: PsbDraftSession; reused: boolean }
  | ({ ok: false } & PsbEnsureFailure);

export interface PsbSessionEnsureInput {
  target: NewMakerDraftPsbTarget;
  agentKind: PsbAgentKind;
  /** PSB 会话标题（仅 PSB 侧展示；通常取首条消息的短标题）。 */
  title?: string | null;
  getBridge: () => PsbRemoteBridge | null;
  /** 结果落地前重新读草稿，确认仍指向同一个工作区（用户可能在等待期间换了目标）。 */
  isCurrentTarget: () => boolean;
  /** 会话建出后立刻回写草稿（持久化 sessionId，供重试复用）。 */
  onSessionCreated: (sessionId: string) => void;
}

export interface PsbSessionGate {
  ensure(input: PsbSessionEnsureInput): Promise<PsbEnsureResult>;
  /** 目标变化 / 放弃草稿时清掉在途缓存与去重键。 */
  reset(): void;
  /** 当前这次发送尝试沿用的去重键（重试不变；成功后清空）。 */
  getClientRequestId(): string | null;
}

export function createPsbSessionGate(): PsbSessionGate {
  // 用「票号 + Promise」而不是裸 Promise：`reset()`（换目标/离开草稿）之后，旧请求的 finally
  // 仍然会跑；如果它无条件把 inFlight 清空，会把**新**请求在途的共享句柄清掉，下一次并发
  // ensure 就会再发一条 createSession（新 clientRequestId，PSB 的幂等键挡不住）→ 两条 PSB 会话。
  // 因此 finally 只在「这个句柄仍是我挂上去的那一个」时才清。
  let inFlight: Promise<PsbEnsureResult> | null = null;
  let inFlightTicket: object | null = null;
  // 经函数读取，避免 TS 把闭包里的 `inFlightTicket` 按「声明处为 null」收窄成 never。
  const heldTicket = (): object | null => inFlightTicket;
  let clientRequestId: string | null = null;

  return {
    async ensure(input) {
      const { target, agentKind, title, getBridge, isCurrentTarget, onSessionCreated } = input;
      // 已经建过（首条消息失败后重试 / 重新发送）：直接用同一条 PSB 会话，不再请求。
      if (target.sessionId) {
        return { ok: true, reused: true, session: psbSessionOfTarget(target, target.sessionId) };
      }
      // 双击/并发：共享第一次请求的结果，避免建出两条 PSB 会话。
      if (inFlight) return inFlight;
      const bridge = getBridge();
      if (!bridge) return { ok: false, reason: 'unavailable' };

      clientRequestId ??= createPsbClientRequestId();
      const requestId = clientRequestId;
      const workspaceId = target.workspaceId;
      const ticket: object = {};
      const session = (async (): Promise<PsbEnsureResult> => {
        try {
          const created = await bridge.createSession({
            workspaceId,
            agentKind,
            clientRequestId: requestId,
            ...(title?.trim() ? { title: title.trim() } : {}),
          });
          const sessionId = created.session.id;
          if (!isCurrentTarget()) {
            // 目标已被换掉：这条会话没人接手，尽力停掉避免远端残留无名进程。
            void bridge.stopSession({ sessionId }).catch(() => undefined);
            return { ok: false, reason: 'stale' };
          }
          clientRequestId = null;
          onSessionCreated(sessionId);
          return { ok: true, reused: false, session: psbSessionOfTarget(target, sessionId) };
        } catch (error) {
          return { ok: false, reason: 'failed', failure: readPsbFailure(error) };
        } finally {
          if (heldTicket() === ticket) {
            inFlight = null;
            inFlightTicket = null;
          }
        }
      })();
      inFlight = session;
      inFlightTicket = ticket;
      return session;
    },
    reset() {
      inFlight = null;
      clientRequestId = null;
    },
    getClientRequestId() {
      return clientRequestId;
    },
  };
}

/**
 * 放弃草稿 / 换目标时归还远端资源（尽力而为，失败只记日志，不阻塞离开）。
 *
 * 顺序是**先停会话、再释放占用**：PSB 的协作锁在语义上是「工作区正在被我使用」，
 * 如果并发发出 `release` 与 `stop`，服务端可能先看到「仍有运行中会话」而拒绝释放，
 * 结果是锁留在用户名下（占用没有 TTL，只能去 PSB 网页手动解）。stop 最多等 3s，
 * 避免远端卡住时把「离开草稿」也拖住。
 */
export function releasePsbDraftTarget(
  target: Pick<NewMakerDraftPsbTarget, 'workspaceId' | 'sessionId'> | null,
  deps: {
    getBridge: () => PsbRemoteBridge | null;
    logWarn?: (message: string, error: unknown) => void;
  },
): void {
  if (!target) return;
  const bridge = deps.getBridge();
  if (!bridge) return;
  const warn = deps.logWarn ?? (() => undefined);
  const stopSettled = target.sessionId
    ? Promise.race([
        bridge.stopSession({ sessionId: target.sessionId }).catch((error) => {
          warn('[psb] stop abandoned PSB session failed (ignored)', error);
        }),
        new Promise<void>((resolve) => {
          setTimeout(resolve, PSB_DRAFT_STOP_TIMEOUT_MS);
        }),
      ])
    : Promise.resolve();
  void stopSettled.then(() =>
    bridge.releaseWorkspace({ workspaceId: target.workspaceId }).catch((error) => {
      warn('[psb] release workspace on draft abandon failed (ignored)', error);
    }),
  );
}
