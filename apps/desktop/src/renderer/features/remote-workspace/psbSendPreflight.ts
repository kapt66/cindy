/**
 * PSB 远程工作区任务的**发送前占用预检**（2026-11-27 用户复测口径）。
 *
 * ## 为什么要有预检（用户截图里的坏体验）
 *
 * 旧链路：消息先进对话（乐观气泡）→ 主进程占用闸门返回 `PSB_WORKSPACE_NOT_OCCUPIED` →
 * 渲染层**失败后**才弹确认框。用户看到的是「先发出去、再失败、对话里留一条『回复未完成』」。
 * 用户要求：发送前就先判断工作区占用；未占用先问，**取消就完全不发送**（不排队、不落库、
 * 不出现失败气泡，草稿 / 附件保留）；确认则先显式占用，成功后才发送。
 *
 * ## 判定顺序（与主进程 `workspaceLock` 的权威判据同源）
 *
 * 每次发送前读一次 `psbRemote.sessionStatus({ sessionId })`（**不用本地缓存**：工作区可能在
 * 上一次检查后被交接给别人），拿 `workspace.occupancy` + 共享可写判据 `psbWorkspaceWritable`
 * （`requireAgentRuntime: false`，发送不是「开新 Agent 会话」）：
 *
 *   1. **不能写**（被他人占用 / 客户端离线 / 工作区未就绪）→ `blocked(workspace)`：不发送，
 *      调用方用既有 `PSB_*` 文案给一句可行动提示；**不产生失败气泡**。
 *   2. **由我占用**（且可写）→ `proceed(occupiedByPreflight: false)`：直接发送，不弹确认。
 *   3. **空闲**（且可写）→ 复用既有 occupyRequired 确认框：确认并占用成功 →
 *      `proceed(occupiedByPreflight: true)`；用户取消 → `cancelled`（静默、不发送）；
 *      占用失败 → `blocked(occupy-failed)`（带原始失败，调用方按既有文案给可行动提示）。
 *   4. **读不到（含 3s 读预算超时）/ 没有 PSB 桥 / 非 `psb:` 目标** → 返回 `null` 或
 *      `proceed`（**不预检、不拦截**）：交给主进程权威闸门按现状处理（主进程读不到时仍会拒绝
 *      发送并给可行动失败；预检层的网络抖动 / 慢网络不该把本来能发的消息挡掉，也不该让用户
 *      点发送后长时间没有反应）。
 *
 * ## 与「失败后确认」的关系
 *
 * 主进程闸门仍是**最终权威**：预检通过后被抢 / 被交接仍会失败。那种情况由 store 既有的
 * `PSB_WORKSPACE_NOT_OCCUPIED` 失败后确认兜底处理。但同一发送里预检已经**显式占用成功**时，
 * store 不再重复弹第二次确认（用户刚点过「占用」，再问一遍就是噪音）——见 `makerChatStore`
 * 的 `psbPreflightOccupied`。
 *
 * ## 纯函数边界
 *
 * 本文件不 import React / store；桥与确认框都从外部注入（确认走 `occupyRequired` 的注册式
 * resolver，测试可注册替身）。返回 `null` 是**同步**的（非 `psb:` 任务连一次 await 都不引入），
 * 只有真正需要预检时才返回 Promise。
 */

import {
  psbWorkspaceWritable,
  type PsbRemoteWorkspace,
  type PsbSessionStatusResult,
} from '../../../shared/psb-remote-workspace';

import type { PsbRemoteBridge } from './bridge';
import { psbWorkspaceRowDisplayName } from './dialog/psbWorkspaceDisplay';
import { requestPsbOccupyConfirmationForWorkspace } from './occupyRequired';
import { remoteWorkspacePsbSessionId } from './sidebar/isRemoteWorkspaceSession';

/** 预检读占用事实只需要这个读口（测试替身 / 窄桥都能注入；占用走注册式确认宿主）。 */
export type PsbSendPreflightBridge = Pick<PsbRemoteBridge, 'sessionStatus'>;

/**
 * 预检读 `sessionStatus` 的等待上限。
 *
 * 主进程的 PSB HTTP 超时是 20s/次，而一次 `sessionStatus` = 2 次 HTTP；不设上限的话，PSB 不可达
 * 时用户点发送后**几十秒没有反应**（预检横在乐观气泡之前）。超时按「读不到」处理：不拦截，
 * 照常交给主进程权威闸门（消息先上屏，主进程读不到时仍会拒绝并给可行动失败）。
 * 正常网络下一次 `sessionStatus` 远低于这个值。
 */
export const PSB_SEND_PREFLIGHT_READ_TIMEOUT_MS = 3_000;

/** 预检拦下发送的原因：工作区事实（他人占用 / 离线 / 未就绪）或占用动作失败。 */
export type PsbSendPreflightBlocked =
  | {
      readonly cause: 'workspace';
      /** 共享单表给出的文案键（`remoteWorkspace.error.*` / `remoteWorkspace.input.*`）。 */
      readonly messageKey: string;
      /** 被他人占用时的占用人名（其余情况为空串）。 */
      readonly personName: string;
    }
  | {
      readonly cause: 'occupy-failed';
      /** 占用请求的原始失败（`null` = 本端根本没有桥，拿不到失败原因）。 */
      readonly error: unknown;
    };

/** 预检结论（`null` 以外的返回值）。 */
export type PsbSendPreflightOutcome =
  | {
      readonly kind: 'proceed';
      /**
       * `true` = 这次发送前**刚刚显式占用成功**。
       *
       * store 据此在随后主进程闸门仍拒绝（竞态：预检后被抢 / 被交接）时跳过「失败后确认」，
       * 避免同一次发送弹两次确认框。
       */
      readonly occupiedByPreflight: boolean;
    }
  /** 用户在确认框里取消：静默不发送（草稿 / 附件保留，没有任何失败提示）。 */
  | { readonly kind: 'cancelled' }
  /** 预检拦下发送：调用方给一句可行动提示，不发送、不产生失败气泡。 */
  | { readonly kind: 'blocked'; readonly blocked: PsbSendPreflightBlocked };

export interface PsbSendPreflightInput {
  /** 本地会话的远端身份（`psb:<PSB sessionId>`；其它 transport / `null` → 返回 `null`）。 */
  readonly remoteHostId: string | null | undefined;
  /** PSB 桥；缺失（旧 preload / 副窗 / 单测）→ 返回 `null`，交给主进程兜底。 */
  readonly bridge: PsbSendPreflightBridge | null | undefined;
}

/**
 * 启动一次发送前预检。
 *
 * @returns `null` = 不需要 / 无法预检（非 `psb:` 目标、拿不到 PSB 会话 id、没有桥），调用方
 *   **直接按原链路发送**，由主进程权威闸门兜底；否则返回预检结论。
 *
 * 返回 `null` 是同步的，调用方可据此保持非 psb 发送路径零 await、零 PSB 请求。
 */
export function startPsbSendPreflight(
  input: PsbSendPreflightInput,
): Promise<PsbSendPreflightOutcome> | null {
  // `psb:` 之后是 PSB 不透明会话 id；非 psb / 畸形 `psb:` 一律不预检（主进程会按自己的
  // transport 分类处理，预检层不猜）。
  const psbSessionId = remoteWorkspacePsbSessionId(input.remoteHostId);
  if (!psbSessionId) return null;
  const bridge = input.bridge;
  if (!bridge) return null;
  return runPsbSendPreflight({ psbSessionId, bridge });
}

async function runPsbSendPreflight(input: {
  psbSessionId: string;
  bridge: PsbSendPreflightBridge;
}): Promise<PsbSendPreflightOutcome> {
  let workspace: PsbRemoteWorkspace;
  try {
    const status = await readSessionStatusWithBudget(input.bridge, input.psbSessionId);
    // 超时等价于读不到（见 `PSB_SEND_PREFLIGHT_READ_TIMEOUT_MS`）。
    if (status === 'timeout') return { kind: 'proceed', occupiedByPreflight: false };
    workspace = status.workspace;
  } catch {
    // 读不到（网络 / 鉴权 / 会话已不存在）：**不在预检层拦截**。主进程闸门是权威读口，
    // 它的失败文案比这里的兜底可行动；预检只是为了消掉「先失败再确认」的坏体验。
    return { kind: 'proceed', occupiedByPreflight: false };
  }
  if (!workspace) return { kind: 'proceed', occupiedByPreflight: false };

  // 与主进程 workspaceLock 同一判据（`psbWorkspaceWritable`，`requireAgentRuntime:false`）：
  // 被他人占用 / 客户端离线 / 工作区未就绪都在发送前拦下，并给同一张单表里的可行动文案。
  // 判据排在「byMe 放行」之前是有意的：**由我占用但离线 / 未就绪**时主进程闸门同样会拒绝，
  // 提前拦下才不会又变成「先发出去、再失败」。
  const writable = psbWorkspaceWritable(workspace, { requireAgentRuntime: false });
  if (!writable.ok) {
    return {
      kind: 'blocked',
      blocked: {
        cause: 'workspace',
        messageKey: writable.messageKey ?? 'remoteWorkspace.error.unknown',
        personName: writable.personName,
      },
    };
  }
  // 已由我占用：直接发送（占用锁本来就是我的，重占一次没有意义，也不弹确认）。
  if (workspace.occupancy.byMe) return { kind: 'proceed', occupiedByPreflight: false };

  const attempted = await requestPsbOccupyConfirmationForWorkspace({
    workspaceId: workspace.id,
    // 显示名与选择弹窗 / 草稿胶囊 / 管理页同源（工作区实例名 = 目录名优先，缺失回退标题）。
    workspaceName: psbWorkspaceRowDisplayName(workspace),
  });
  // 没有确认宿主（旧 preload / 副窗 / 单测）：不在预检层拦住，交给主进程权威闸门按现状处理。
  if (!attempted) return { kind: 'proceed', occupiedByPreflight: false };
  if (attempted.status === 'occupied') return { kind: 'proceed', occupiedByPreflight: true };
  if (attempted.status === 'declined') return { kind: 'cancelled' };
  return { kind: 'blocked', blocked: { cause: 'occupy-failed', error: attempted.error } };
}

/**
 * 读一次 `sessionStatus`，最多等 `PSB_SEND_PREFLIGHT_READ_TIMEOUT_MS`。
 *
 * 超时返回 `'timeout'` 而不是 reject：超时不是「不能写」，按「读不到」放行给主进程权威闸门。
 */
async function readSessionStatusWithBudget(
  bridge: PsbSendPreflightBridge,
  sessionId: string,
): Promise<PsbSessionStatusResult | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      bridge.sessionStatus({ sessionId }),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), PSB_SEND_PREFLIGHT_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
