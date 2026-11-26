/**
 * 选择器（弹窗 / 草稿页下拉）的**失败状态模型**：把任意失败归一成可存进 React state 的形状。
 *
 * 它不是文案出口：文案只在根 `psbFailureText.ts` 一处实现（2026-11-26 独立审查归并），
 * 这里只做「读形状 → 结构化事实」：
 *   - 优先用共享契约的 `psbRemoteFailureFromIpcError` / `psbFailureMessageKeyForIpcCode`，
 *     **不允许**再建第二张正则码表（旧 `dialog/psbDialogModel.ts` 的
 *     `FAILURE_MESSAGE_KEYS` 已删除：它和共享码表对同一个 PSB 码可能给出不同文案）；
 *   - 占用失败的人名按共享约定从 IPC `message` 回填（main 已把 message 收敛为「人名 / 空串」），
 *     列表刷新补人名是调用方（`usePsbWorkspaceSelection`）的第二步；
 *   - 超时（本端等不到回应）不是 PSB 给的码，但给用户的可行动口径与「连不上 PSB」一致。
 */

import { extractIpcError } from '@/utils/ipcError';

import {
  psbFailureMessageKeyForIpcCode,
  psbRemoteFailureFromIpcError,
  type PsbRemoteFailure,
} from '../../../../shared/psb-remote-workspace';

export const PSB_FAILURE_UNKNOWN_KEY = 'remoteWorkspace.error.unknown';

/** 渲染层 UI state 里的失败事实（`psbFailureText(t, failure)` 直接消费）。 */
export interface PsbFailureInfo {
  /** PSB / IPC 失败码；无法归因为 `null`。 */
  readonly code: string | null;
  /** 共享码表给出的文案键；未知为 `remoteWorkspace.error.unknown`。 */
  readonly messageKey: string;
  /** PSB 原文 / 占用人名 / 本机诊断原文（诊断行；没有为 `null`）。 */
  readonly message: string | null;
  /** 仅「被他人占用」有：占用人名（拿不到为 `null`）。 */
  readonly personName: string | null;
}

/** 占用失败的人名：main 约定 `message` 里只放人名（拿不到为空串）。 */
const OCCUPIED_CODE = 'PSB_WORKSPACE_OCCUPIED_BY_OTHER';

function isPsbRemoteFailureShape(value: unknown): value is PsbRemoteFailure {
  if (!value || typeof value !== 'object' || value instanceof Error) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === 'string' &&
    record.code.length > 0 &&
    typeof record.messageKey === 'string' &&
    record.messageKey.length > 0
  );
}

function readPersonName(code: string | null, message: string | null): string | null {
  if (code !== OCCUPIED_CODE) return null;
  const name = message?.trim() ?? '';
  return name.length > 0 ? name : null;
}

/**
 * 任意失败 → 结构化失败事实。顺序：
 *   1. 推送载荷里的 `PsbRemoteFailure`（code + messageKey；不跨 IPC，但管理页/串流错误用它）；
 *   2. IPC 错误：先按共享 PSB 码表，再落「其它已知码 + PSB 原文」；
 *   3. 兜底只保留 message 作诊断，不让调用方拿技术串当正文。
 */
export function readPsbFailure(error: unknown): PsbFailureInfo {
  if (isPsbRemoteFailureShape(error)) {
    const message = typeof error.message === 'string' ? error.message : null;
    return {
      code: error.code,
      messageKey: error.messageKey,
      message,
      personName: readPersonName(error.code, message),
    };
  }

  const psb = psbRemoteFailureFromIpcError(error);
  if (psb) {
    return {
      code: psb.code,
      messageKey: psb.messageKey,
      message: psb.message,
      personName: readPersonName(psb.code, psb.message),
    };
  }

  const ipc = extractIpcError(error);
  if (ipc) {
    return {
      code: ipc.code,
      messageKey: psbFailureMessageKeyForIpcCode(ipc.code) ?? PSB_FAILURE_UNKNOWN_KEY,
      message: ipc.message || null,
      personName: readPersonName(ipc.code, ipc.message || null),
    };
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string' && error
        ? error
        : null;
  return {
    code: null,
    messageKey: PSB_FAILURE_UNKNOWN_KEY,
    message: message && message.trim() ? message : null,
    personName: null,
  };
}

/**
 * 失败的错误条「诊断行」：只在正文没消费这段 message 时展示（PSB 原文 / 本机技术串）。
 *
 * 占用失败时 message 就是占用人名，已经被正文插值消费；再当诊断行显示会变成「人名」重复。
 */
export function psbFailureDiagnosticText(failure: PsbFailureInfo): string | null {
  if (!failure.message) return null;
  if (failure.personName || failure.messageKey === 'remoteWorkspace.error.occupiedByOther') {
    return null;
  }
  return failure.message;
}

/** 列表刷新补到占用人名后，替换失败事实里的人名（`{{name}}` 只在根文案函数里插值）。 */
export function psbFailureWithPersonName(
  failure: PsbFailureInfo,
  personName: string | null,
): PsbFailureInfo {
  const name = personName?.trim() ?? '';
  if (!name || name === failure.personName) return failure;
  return { ...failure, personName: name };
}

/**
 * 本端等不到占用回应（超时）的失败事实。
 *
 * 不是 PSB 返回的码：给用户的可行动口径与「连不上 PSB」一致（检查网络后重试）。
 * 调用方在超时后仍要盯住原请求的落地：它可能稍后成功，那时必须把占用还回去
 * （见 `usePsbWorkspaceSelection`）。
 */
export function psbOccupyTimeoutFailure(): PsbFailureInfo {
  return {
    code: null,
    messageKey: 'remoteWorkspace.error.unreachable',
    message: null,
    personName: null,
  };
}
