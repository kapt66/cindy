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
 * ## 孤儿会话（2026-11-26 独立审查修复）
 *
 * 「建会话成功」不等于「这条草稿接手了它」：从 createSession 落地到调用方把 `sessionId` 写回
 * 草稿之间，目标可能被换掉/提交。旧实现在 gate 判过之后就清掉去重键、回调静默 return，
 * 结果远端留下一条**没人引用的 PSB 会话**，而重试因为去重键已清会再建第二条。
 * 现在：
 *   · `onSessionCreated` 返回**是否采纳**（真正写进草稿才返回 true）；
 *   · 未采纳 → 尽力 `stopSession`，并**保留去重键**（重试时 PSB 按同一键拿回同一条会话，
 *     不会多建一条；用户彻底放弃则 `reset()` 清键）；
 *   · 目标在等待期间被换掉（`isCurrentTarget()` 为 false）同样保留去重键。
 *
 * 这一层不依赖 React/Electron：bridge 与当前目标检查都由调用方注入，单测可以直接钉住
 * 「成功 / 失败 / 在途合并 / 目标已变 / 回调不采纳」五条分支。
 */

import type { NewMakerDraftPsbTarget } from '@/state/newMakerDraft';

import {
  buildPsbRemoteHostId,
  buildPsbVirtualWorkingDir,
  type PsbAgentKind,
} from '../../../../shared/psb-remote-workspace';
import type { PsbRemoteBridge } from '../bridge';
import { readPsbFailure, type PsbFailureInfo } from '../dialog/psbFailure';
import { createPsbClientRequestId } from '../dialog/psbSessionIdentity';
import {
  isPsbOccupyRequiredFailure,
  requestPsbOccupyConfirmationForWorkspace,
} from '../occupyRequired';
import { releasePsbWorkspaceOccupancy } from './psbPendingReleaseLedger';

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
  /**
   * 在途期间草稿目标已被换掉 / 调用方拒绝了这条会话：刚建出的会话已尽力停掉（或保留给
   * 同去重键的重试复用），调用方直接放弃这次发送。
   */
  | { reason: 'stale' }
  /** 没有 PSB 桥（旧 preload / 非主窗口）：无法建远端会话。 */
  | { reason: 'unavailable' };

export type PsbEnsureResult =
  | { ok: true; session: PsbDraftSession }
  | ({ ok: false } & PsbEnsureFailure);

export interface PsbSessionEnsureInput {
  target: NewMakerDraftPsbTarget;
  agentKind: PsbAgentKind;
  /** PSB 会话标题（仅 PSB 侧展示；通常取首条消息的短标题）。 */
  title?: string | null;
  getBridge: () => PsbRemoteBridge | null;
  /** 结果落地前重新读草稿，确认仍指向同一个工作区（用户可能在等待期间换了目标）。 */
  isCurrentTarget: () => boolean;
  /**
   * 会话建出后立刻回写草稿（持久化 sessionId，供重试复用）。
   *
   * **必须返回是否真的采纳**：返回 false（例如目标在回调这一帧已经变了）时本层会停掉这条
   * 会话并保留去重键，避免远端留下没人引用的会话。
   */
  onSessionCreated: (sessionId: string) => boolean;
}

export interface PsbSessionGate {
  ensure(input: PsbSessionEnsureInput): Promise<PsbEnsureResult>;
  /** 目标变化 / 放弃草稿时清掉在途缓存与去重键。 */
  reset(): void;
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
        return { ok: true, session: psbSessionOfTarget(target, target.sessionId) };
      }
      // 双击/并发：共享第一次请求的结果，避免建出两条 PSB 会话。
      if (inFlight) return inFlight;
      const bridge = getBridge();
      if (!bridge) return { ok: false, reason: 'unavailable' };

      clientRequestId ??= createPsbClientRequestId();
      const requestId = clientRequestId;
      const workspaceId = target.workspaceId;
      const ticket: object = {};
      // 懒建也一样受「占用必须由用户确认」约束（2026-11-27 用户复测）：main 的 createSession
      // 占用闸门在空闲时不替用户占用，而是返回 `PSB_WORKSPACE_NOT_OCCUPIED`。这里请求用户
      // 确认并显式占用成功后**重试同一次建会话**（同一 `clientRequestId`，PSB 侧仍去重）；
      // 取消 / 占用失败 → 按原失败返回，不建会话、不静默占用。
      const createSessionOnce = async (
        retrying: boolean,
      ): Promise<Awaited<ReturnType<PsbRemoteBridge['createSession']>>> => {
        try {
          return await bridge.createSession({
            workspaceId,
            agentKind,
            clientRequestId: requestId,
            ...(title?.trim() ? { title: title.trim() } : {}),
          });
        } catch (error) {
          if (!retrying && isPsbOccupyRequiredFailure(error)) {
            const approved = await requestPsbOccupyConfirmationForWorkspace({
              workspaceId,
              workspaceName: target.workspaceTitle ?? '',
            });
            if (approved) return createSessionOnce(true);
          }
          throw error;
        }
      };
      const session = (async (): Promise<PsbEnsureResult> => {
        try {
          const created = await createSessionOnce(false);
          const sessionId = created.session.id;
          if (!isCurrentTarget()) {
            // 目标已被换掉：这条会话没人接手，尽力停掉避免远端残留无名进程。
            // **不去重键**：重试仍用同一个键，PSB 会拿回同一条会话而不是再建一条。
            void bridge.stopSession({ sessionId }).catch(() => undefined);
            return { ok: false, reason: 'stale' };
          }
          // 回调可能在这之间发现目标已经不可写（React 状态/草稿被换掉）：只有真正采纳才清键。
          const adopted = onSessionCreated(sessionId) !== false;
          if (!adopted) {
            void bridge.stopSession({ sessionId }).catch(() => undefined);
            return { ok: false, reason: 'stale' };
          }
          clientRequestId = null;
          return { ok: true, session: psbSessionOfTarget(target, sessionId) };
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
  };
}

/**
 * 放弃草稿 / 换目标时归还远端资源（尽力而为，失败不阻塞离开，但**不静默**）。
 *
 * 顺序是**先停会话、再释放占用**：PSB 的协作锁在语义上是「工作区正在被我使用」，
 * 如果并发发出 `release` 与 `stop`，服务端可能先看到「仍有运行中会话」而拒绝释放，
 * 结果是锁留在用户名下（占用没有 TTL，只能去 PSB 网页手动解）。stop 最多等 3s，
 * 避免远端卡住时把「离开草稿」也拖住。
 *
 * stop 超时/失败之后仍然会释放（远端可能已在收尸）；release 仍失败则记进
 * `draft/psbPendingReleaseLedger.ts` 的账本——旧实现只 `log.warn`，用户完全不知道锁还留着。
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
    // 释放失败由账本记账（可被常驻提示条 / 重试入口消费），不再只是一行日志。
    releasePsbWorkspaceOccupancy(bridge, target.workspaceId, 'abandon draft'),
  );
}
