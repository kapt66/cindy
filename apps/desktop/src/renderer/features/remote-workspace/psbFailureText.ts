/**
 * PSB 远程工作区的**失败文案出口**（渲染层唯一实现，2026-11-26 独立审查归并）。
 *
 * ## 为什么需要它（2026-11-26 真机事故）
 *
 * 真机里点远程工作区的按钮（在网页打开 / 占用 / 启动串流）会弹「操作失败，请稍后重试。」，
 * 而 main 明明已经给出了 `PSB_*` 命名空间失败码与 PSB 可读原文 —— 旧实现有几处自己 catch 后
 * 直接写死通用文案（`RemoteWorkspaceRowDecor` 的两处 toast、`RemoteWorkspaceAdminActions`
 * 的兜底），把「工作区不存在 / 连不上 PSB / 被他人占用 / 工作区未就绪」这些**可行动**的信息
 * 全丢掉了。更进一步：弹窗与草稿页各有一套同名实现、码表也不一样，同一个失败在两个入口
 * 可以显示成两句话。现在只保留这一份。
 *
 * 映射顺序（越靠前越权威）：
 *   1. 共享契约的 `[CODE] message` → `PSB_IPC_FAILURE_MESSAGE_KEYS` 的本地化文案
 *      （被他人占用时 `message` 是占用人名，插进文案；拿不到名字退回无名字的同一句
 *      `remoteWorkspace.error.workspaceOccupied`——**不再各入口自己判空**）；
 *   2. 其它已知 IPC 码 → `ipcError.<CODE>` 文案（仓库统一的跨进程错误文案表）；
 *   3. main 透传的 PSB / 本机可读原文（诊断行；只有它时就照实显示，比通用文案可行动）；
 *   4. 真正无法归因时才用通用「操作失败，请稍后重试。」。
 *
 * 输入可以是三类形状，调用方不需要先分类：
 *   - 原始 IPC 错误（`[PSB_*] detail` 的 Error / 带 code 的 Error）；
 *   - 推送载荷里的 `PsbRemoteFailure`（code + messageKey + message）；
 *   - 渲染层 UI state 用的结构化 `PsbFailureLike`（由 `dialog/psbFailure.ts` 的
 *     `readPsbFailure` 产出，多一个 `personName`）。
 *
 * 不展示 `[CODE] ` 这类机器包装串：它没有可读信息，只会让用户以为出了更严重的问题。
 * 有结构化的可翻译键时也不把 PSB 中文原文当正文（原文只作为 `description` 诊断行由
 * 调用方决定是否展示）。
 */

import type { TFunction } from 'i18next';

import { extractIpcError } from '../../../shared/ipcError';
import {
  psbFailureMessageKeyForIpcCode,
  psbStreamAccessFailureCopyForIpcCode,
  type PsbStreamAccessFailureState,
} from '../../../shared/psb-remote-workspace';

/**
 * 渲染层 UI state 里的失败形状（`dialog/psbFailure.ts` 的 `readPsbFailure` 产出）。
 *
 * 只描述文本层需要的字段：`code` 用于继续查共享码表，`messageKey` 是已归因的键，
 * `message` 是 PSB / 本机原文（诊断行），`personName` 是占用失败的人名。
 */
export interface PsbFailureLike {
  readonly code?: string | null;
  readonly messageKey?: string | null;
  readonly message?: string | null;
  readonly personName?: string | null;
}

const OCCUPIED_KEY = 'remoteWorkspace.error.occupiedByOther';
const OCCUPIED_WITHOUT_NAME_KEY = 'remoteWorkspace.error.workspaceOccupied';
const UNKNOWN_KEY = 'remoteWorkspace.error.unknown';

/** Electron `ipcRenderer.invoke` 失败会把 main 错误包成 `Error invoking remote method 'x': Error: ...`。 */
const IPC_INVOCATION_WRAPPER_RE =
  /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/;
/** `[CODE] body` 或 `CODE: body` 的机器包装：只留 body。 */
const FAILURE_CODE_PREFIX_RE = /^\s*(?:\[[A-Z0-9_]+\]|[A-Z][A-Z0-9_]*:)\s*/;

/**
 * 去掉机器包装前缀（Electron 调用包装 + `[CODE] ` / `CODE: `），只留可读原文。
 *
 * 为什么还要剥 Electron 包装：IPC 错误跨进程会被 `invoke` 包一层，渲染层认不出码名
 * （旧 main / 新子码）时若原样展示，用户会看到 `Error invoking remote method 'psb…': …`
 * 这种机器串——它既不可行动，也会让人以为出了更严重的故障。
 */
export function stripPsbFailureCodePrefix(message: string): string {
  return message
    .trim()
    .replace(IPC_INVOCATION_WRAPPER_RE, '')
    .replace(FAILURE_CODE_PREFIX_RE, '')
    .trim();
}

function isFailureLike(value: unknown): value is PsbFailureLike {
  if (!value || typeof value !== 'object' || value instanceof Error) return false;
  const record = value as Record<string, unknown>;
  const hasCode = typeof record.code === 'string' && record.code.length > 0;
  const hasKey = typeof record.messageKey === 'string' && record.messageKey.length > 0;
  const hasName = typeof record.personName === 'string' && record.personName.length > 0;
  // `message` 可以为空（拿不到 PSB 原文 / 占用人名时就是空）——是否是结构化失败只由
  // code / messageKey / personName 判定。
  return hasCode || hasKey || hasName;
}

function readDetail(value: string | null | undefined): string | null {
  const detail = stripPsbFailureCodePrefix(value ?? '');
  return detail.length > 0 ? detail : null;
}

/** 结构化失败 → 一句话（唯一映射点；main / 共享契约之外没有第二张码表）。 */
function textForFailure(t: TFunction, failure: PsbFailureLike): string {
  const code = failure.code?.trim() || null;
  const detail = readDetail(failure.message);
  // 码表优先于调用方给的 messageKey：同一个 `code` 在 main / 渲染层必须显示同一句
  // （共享契约 `psbFailureMessageKeyForIpcCode` 是唯一映射点）。
  const key =
    (code ? psbFailureMessageKeyForIpcCode(code) : null) ??
    (failure.messageKey?.trim() || null);

  if (key === OCCUPIED_KEY) {
    // 占用失败的人名有两个来源：结构化 `personName` 与 IPC `message`（main 已把
    // `occupiedByOther` 的 message 收敛成「人名 / 空串」）。两处都空 → 无名字的同一句。
    const name = failure.personName?.trim() || detail;
    return name ? t(OCCUPIED_KEY, { name }) : t(OCCUPIED_WITHOUT_NAME_KEY);
  }
  if (key && key !== UNKNOWN_KEY) return t(key);

  // 非 PSB 的本地 IPC 码：仓库统一错误文案表里有可读句子就用它。
  if (code) {
    const localized = t(`ipcError.${code}`, { defaultValue: '' });
    if (localized) return localized;
    // PSB 已知码但共享表里没有文案（新码 / 旧客户端）：PSB 原文比通用文案可行动。
    if (detail) return detail;
    return t(UNKNOWN_KEY);
  }
  // 结构化失败但没有任何可翻译键（code/key 都不认识）：正文落通用文案，原始 message 只作
  // 诊断行由调用方决定是否展示——不把英文技术串当用户正文。
  return t(key ?? UNKNOWN_KEY);
}

function textForUnknownInput(t: TFunction, error: unknown): string {
  const ipc = extractIpcError(error);
  if (ipc) return textForFailure(t, { code: ipc.code, message: ipc.message });
  if (isFailureLike(error)) return textForFailure(t, error);
  if (error instanceof Error) return readDetail(error.message) ?? t(UNKNOWN_KEY);
  if (typeof error === 'string') return readDetail(error) ?? t(UNKNOWN_KEY);
  return t(UNKNOWN_KEY);
}

/**
 * 把任意失败收敛成一句可展示、可行动的话（toast / 错误条共用）。
 *
 * @param t `useTranslation().t`（或同签名的翻译函数）
 * @param error 原始 IPC 错误 / `PsbRemoteFailure` / `PsbFailureLike`；无法归因时给通用文案
 */
export function psbFailureText(t: TFunction, error: unknown): string {
  return textForUnknownInput(t, error);
}

/* ==================== 订阅串流：没有 running 桌面访问（409） ==================== */

/**
 * 「没有 running 桌面访问」三档状态（值来自共享契约，`most：none`）。
 *
 * 仅作 `PsbStreamAccessFailureNotice` 的字段类型再导出：状态词与「下一步动作」的唯一投影在
 * `shared/psb-remote-workspace.ts`（`psbStreamAccessFailureCopyForIpcCode`），渲染层不再
 * 手写第三张码表。
 */
export type { PsbStreamAccessFailureState };

/**
 * 串流启动失败中「工作区访问没在运行」的专用说明（横幅用）。
 *
 * 为什么单独一个结构而不是继续用 `psbFailureText`：这一档除了文案还要**两个动作**——
 * 去 PSB 网页启动访问（附链接/按钮）与 `starting` 时自动重试一次。判断依据只有 main 给的
 * IPC 码，渲染层**不解析 message**（message 是 PSB 原文，跨语言、可能被截断）。
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

/**
 * 从「启动串流」的 invoke 失败里取「没有 running 桌面访问」的说明；其它码返回 `null`。
 *
 * 文案键与「下一步动作」都来自共享单表（`psbStreamAccessFailureCopyForIpcCode`）：main 的
 * 失败形状与渲染层横幅消费同一个投影，新增一档只改共享契约。
 *
 * 返回 `null` 时调用方仍走 `psbFailureText`（鉴权 / 网络 / 不支持串流等既有路径）。
 */
export function psbStreamAccessFailureNotice(
  t: TFunction,
  error: unknown,
): PsbStreamAccessFailureNotice | null {
  const ipc = extractIpcError(error);
  if (!ipc) return null;
  const copy = psbStreamAccessFailureCopyForIpcCode(ipc.code);
  if (!copy) return null;
  const detail = ipc.message.trim();
  const text = t(copy.messageKey);
  return {
    state: copy.state,
    text,
    // PSB 中文原话作为诊断行：只在与本地化正文不同时显示（英文界面下两者必然不同）。
    detail: detail.length > 0 && detail !== text ? detail : null,
    offerOpenWeb: copy.offerOpenWeb,
    retryOnce: copy.retryOnce,
  };
}
