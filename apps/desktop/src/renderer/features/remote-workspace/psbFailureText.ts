/**
 * PSB 远程工作区的**失败文案出口**（渲染层唯一映射）。
 *
 * ## 为什么需要它（2026-11-26 真机事故）
 *
 * 真机里点远程工作区的按钮（在网页打开 / 占用 / 启动串流）会弹「操作失败，请稍后重试。」，
 * 而 main 明明已经给出了 `PSB_*` 命名空间失败码与 PSB 可读原文 —— 旧实现有几处自己 catch 后
 * 直接写死通用文案（`RemoteWorkspaceRowDecor` 的两处 toast、`RemoteWorkspaceAdminActions`
 * 的兜底），把「工作区不存在 / 连不上 PSB / 被他人占用 / 工作区未就绪」这些**可行动**的信息
 * 全丢掉了。
 *
 * 映射顺序（越靠前越权威）：
 *   1. 共享契约的 `[CODE] message` → `PSB_IPC_FAILURE_MESSAGE_KEYS` 的本地化文案
 *      （被他人占用时 `message` 是占用人名，插进文案；拿不到名字退回「他人」）；
 *   2. 其它已知 IPC 码 → `ipcError.<CODE>` 文案（仓库统一的跨进程错误文案表）；
 *   3. main 透传的 PSB / 本机可读原文（诊断行；只有它时就照实显示，比通用文案可行动）；
 *   4. 真正无法归因时才用通用「操作失败，请稍后重试。」。
 *
 * 不展示 `[CODE] ` 这类机器包装串：它没有可读信息，只会让用户以为出了更严重的问题。
 */

import type { TFunction } from 'i18next';

import { extractIpcError } from '../../../shared/ipcError';
import {
  PSB_NO_RUNNING_SESSION_IPC_CODES,
  psbFailureMessageKeyForIpcCode,
} from '../../../shared/psb-remote-workspace';

/** 把任意失败收敛成一句可展示、可行动的话（toast / 错误条共用）。 */
export function psbFailureText(t: TFunction, error: unknown): string {
  const ipc = extractIpcError(error);
  if (ipc) {
    const key = psbFailureMessageKeyForIpcCode(ipc.code);
    const detail = ipc.message.trim();
    if (key === 'remoteWorkspace.error.occupiedByOther') {
      // 占用失败的可读信息是「谁占着」：main 把占用人名放在 message（拿不到则空串）。
      return t(key, {
        name: detail || t('remoteWorkspace.admin.occupancyTakenByOther'),
      });
    }
    if (key) return t(key);
    // 本机 IPC 码 / 新加的 PSB 子码：仓库统一错误文案表里有可读句子就用它。
    const localKey = `ipcError.${ipc.code}`;
    const localized = t(localKey, { defaultValue: '' });
    if (localized) return localized;
    if (detail) return detail;
  }
  const message = error instanceof Error ? error.message.trim() : '';
  if (message && !/^\[[A-Z0-9_]+\]/.test(message)) return message;
  return t('remoteWorkspace.error.unknown');
}

/* ==================== 订阅串流：没有 running 桌面访问（409） ==================== */

/** 「没有 running 桌面访问」三档状态（main 按 PSB `details.state` 翻成三条 IPC 码）。 */
export type PsbStreamAccessFailureState = 'none' | 'starting' | 'stopping';

/**
 * 串流启动失败中「工作区访问没在运行」的专用说明（横幅用）。
 *
 * 为什么单独一个结构而不是继续用 `psbFailureText`：这一档除了文案还要**两个动作**——
 * 去 PSB 网页启动访问（附链接/按钮）与 `starting` 时自动重试一次。判断依据只有 main 给的
 * IPC 码（`PSB_NO_RUNNING_SESSION_IPC_CODES`），渲染层**不解析 message**（message 是 PSB
 * 原文，跨语言、可能被截断）。
 */
export interface PsbStreamAccessFailureNotice {
  readonly state: PsbStreamAccessFailureState;
  /** 可行动文案（`remoteWorkspace.admin.streamAccess*`，已本地化）。 */
  readonly text: string;
  /** PSB 中文原话（诊断行；没有 / 与正文重复时为 `null`）。 */
  readonly detail: string | null;
  /** 是否值得给「在网页启动访问」入口（`starting` / `stopping` 的正确动作是等）。 */
  readonly offerOpenWeb: boolean;
  /** 竞态：访问正在启动，等一会儿重试一次通常就好。 */
  readonly retryOnce: boolean;
}

/** 三个码 → 文案键与下一步（唯一映射点；组件只消费结果）。 */
const STREAM_ACCESS_FAILURE_COPY: Record<
  string,
  { state: PsbStreamAccessFailureState; messageKey: string }
> = {
  [PSB_NO_RUNNING_SESSION_IPC_CODES.none]: {
    state: 'none',
    messageKey: 'remoteWorkspace.admin.streamAccessNone',
  },
  [PSB_NO_RUNNING_SESSION_IPC_CODES.starting]: {
    state: 'starting',
    messageKey: 'remoteWorkspace.admin.streamAccessStarting',
  },
  [PSB_NO_RUNNING_SESSION_IPC_CODES.stopping]: {
    state: 'stopping',
    messageKey: 'remoteWorkspace.admin.streamAccessStopping',
  },
};

/**
 * 从「启动串流」的 invoke 失败里取「没有 running 桌面访问」的说明；其它码返回 `null`。
 *
 * 返回 `null` 时调用方仍走 `psbFailureText`（鉴权 / 网络 / 不支持串流等既有路径）。
 */
export function psbStreamAccessFailureNotice(
  t: TFunction,
  error: unknown,
): PsbStreamAccessFailureNotice | null {
  const ipc = extractIpcError(error);
  if (!ipc) return null;
  const copy = STREAM_ACCESS_FAILURE_COPY[ipc.code];
  if (!copy) return null;
  const detail = ipc.message.trim();
  const text = t(copy.messageKey);
  return {
    state: copy.state,
    text,
    // PSB 中文原话作为诊断行：只在与本地化正文不同时显示（英文界面下两者必然不同）。
    detail: detail.length > 0 && detail !== text ? detail : null,
    offerOpenWeb: copy.state === 'none',
    retryOnce: copy.state === 'starting',
  };
}
