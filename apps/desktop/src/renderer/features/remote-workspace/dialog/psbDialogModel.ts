/**
 * 「新建远程工作区会话」弹窗的纯函数层：失败归因、去重键。
 *
 * 放在组件外地两个理由：
 *   1. 失败归因（PSB 错误码 → `remoteWorkspace.error.*` 文案键）是**产品口径**，
 *      不该只藏在 JSX 的条件分支里；
 *   2. 这些函数没有 React / Electron 依赖，可以被单测直接钉住（弹窗行为测试与草稿页
 *      懒建会话的失败提示都复用它们）。
 *
 * 渲染层**不判 HTTP 码**：PSB 的业务失败由 main 收敛成 `PsbRemoteFailure` 形状或
 * 既有 `IpcError`（`[CODE] message`），这里只做「读形状 → 文案键」的映射；未知码
 * 保留原始码做诊断，文案落通用失败（见 docs/dev-rules/psb-remote-session-transport.md §3）。
 *
 * **引擎不在这里**：产品要求新建远程工作区只选/建工作区，Harness 与模型在草稿页
 * 按既有链路选择；弹窗与交接载荷都不携带 agentKind。
 */

import type { MakerVendor } from '@/lib/ccAgent.types';
import { extractIpcError } from '@/utils/ipcError';

import {
  psbWorkspaceHealth,
  type PsbAgentKind,
  type PsbRemoteWorkspace,
  type PsbWorkspaceHealth,
} from '../../../../shared/psb-remote-workspace';

/**
 * 弹窗成功回调的载荷（工作区级，**没有** sessionId / agentKind）。
 *
 * 侧栏与草稿页都按这五个字段交接；PSB 会话在草稿页首条消息发送时才懒创建。
 */
export interface RemoteWorkspacePickerCreated {
  workspaceId: string;
  clientId: string;
  clientName: string;
  workspaceTitle: string;
  directoryName: string | null;
}

/**
 * 工作区实例 id 的短显示形态：保留前 8 位（PSB id 形态不在 Cindy 侧解析，只截断显示）。
 *
 * 选择器（弹窗、草稿页位置渠道下拉、项目胶囊）必须共用这一份截断口径，否则同一个工作区
 * 在三处显示成三个名字。
 */
export function shortPsbWorkspaceId(workspaceId: string): string {
  const value = workspaceId.trim();
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

/** 工作区选择器的显示名输入（弹窗行 / 下拉行 / 项目胶囊共用）。 */
export interface PsbWorkspaceDisplayParts {
  clientName: string;
  workspaceId: string;
  workspaceTitle?: string;
}

/**
 * 工作区选择器的**显示名**口径（2026-11-25 用户实机反馈）：
 *
 *   `<客户端名>-<工作区短 id>`，例如 `打包机-9c747178`。
 *
 * 模板名（`saga2_project` 这类）辨识度太低，不能当选择器主标题；缺客户端名时退回短 id；
 * 两者都没有（理论上 id 必填，仅手改脏数据）才退回工作区标题。
 */
export function psbWorkspaceDisplayName(parts: PsbWorkspaceDisplayParts): string {
  const shortId = shortPsbWorkspaceId(parts.workspaceId);
  const clientName = parts.clientName.trim();
  if (clientName && shortId) return `${clientName}-${shortId}`;
  return shortId || parts.workspaceTitle?.trim() || parts.workspaceId;
}

/** PSB 工作区行 → 选择器显示名（唯一映射：弹窗 / 下拉 / 项目胶囊同源）。 */
export function psbWorkspaceRowDisplayName(workspace: PsbRemoteWorkspace): string {
  return psbWorkspaceDisplayName({
    clientName: workspace.clientName,
    workspaceId: workspace.id,
    workspaceTitle: workspace.title,
  });
}

/**
 * 工作区行的**唯一**次要信息（单行、去重）：优先目录名 —— 它才是本机上唯一区分同名工作区的
 * 那一份目录；没有目录名时才退回标题 / 模板名，且同一字符串只出现一次。
 *
 * 历史上这里同时渲染 `title` 与 `directoryName`，同名时变成「saga2_project saga2_project」
 * 两遍；模板名再叠进来会三遍。所以次要行固定由本函数产出，调用方不得再自行拼接。
 *
 * 「目录」前缀走 i18n（`remoteWorkspace.dialog.directorySecondary`），**不在这里写死中文**：
 * 这个函数被 12 个 locale 的弹窗与草稿页下拉共用，写死中文会让非中文界面出现中文行。
 * 目录名本身不是文案（PSB 的服务端事实），只作为 `{{directory}}` 插入。
 */
export function psbWorkspaceSecondaryText(
  workspace: PsbRemoteWorkspace,
  t: (key: string, options?: Record<string, string>) => string,
): string | null {
  const directory = workspace.directoryName?.trim() ?? '';
  if (directory) return t('remoteWorkspace.dialog.directorySecondary', { directory });
  const title = workspace.title.trim();
  if (title) return title;
  const template = workspace.templateTitle?.trim() ?? '';
  return template || null;
}

/** PSB 工作区行 → 交给调用方的工作区级载荷（弹窗与草稿页工作区下拉共用唯一映射）。 */
export function psbWorkspaceCreatedPayload(
  workspace: PsbRemoteWorkspace,
): RemoteWorkspacePickerCreated {
  return {
    workspaceId: workspace.id,
    clientId: workspace.clientId,
    clientName: workspace.clientName,
    workspaceTitle: workspace.title,
    directoryName: workspace.directoryName,
  };
}

/**
 * 不可用行的**可行动原因**。用户需要看到「为什么这台不能用」，而不是列表里凭空少一行
 * （docs/product-rules/psb-remote-workspace-sessions.md §2.2）；可用行返回 null。
 */
export function psbWorkspaceUnavailableReason(
  workspace: PsbRemoteWorkspace,
  health: PsbWorkspaceHealth,
  t: (key: string, options?: Record<string, string>) => string,
): string | null {
  if (health.canStartSession) return null;
  if (health.tone === 'warn') {
    const name = workspace.occupancy.personName.trim();
    return name
      ? t('remoteWorkspace.error.occupiedByOther', { name })
      : t('remoteWorkspace.badge.occupied');
  }
  return t(health.badgeKey);
}

/** 行状态用共享的健康判定（弹窗与草稿页工作区下拉必须给出同一结论）。 */
export function psbWorkspaceRowHealth(workspace: PsbRemoteWorkspace): PsbWorkspaceHealth {
  return psbWorkspaceHealth(workspace);
}

/** 草稿 vendor → PSB 会话的 agentKind（首条消息懒建会话时按草稿当前选择换算）。 */
export function vendorToPsbAgentKind(vendor: MakerVendor): PsbAgentKind {
  if (vendor === 'codex') return 'codex';
  if (vendor === 'pi') return 'pi';
  return 'claude-code';
}

/**
 * PSB 错误码 → 文案键。用「包含」而不是精确等值：main 侧可能把 PSB 原始码套进
 * 自己的命名空间（如 `PSB_WORKSPACE_OCCUPIED_BY_OTHER`），精确等值会在前后缀变化时
 * 静默退回「操作失败」。未知码落 `error.unknown`，原始 message 作为诊断行展示。
 */
const FAILURE_MESSAGE_KEYS: readonly (readonly [RegExp, string])[] = [
  [/AUTH_EXPIRED|AUTH_INVALID/, 'remoteWorkspace.error.authExpired'],
  [/AUTH_REQUIRED/, 'remoteWorkspace.error.auth'],
  [/ORG_REQUIRED|NOT_IN_ORG/, 'remoteWorkspace.error.orgRequired'],
  [/IDENTITY_NOT_LINKED/, 'remoteWorkspace.error.identityNotLinked'],
  [/OCCUPIED_BY_OTHER/, 'remoteWorkspace.error.occupiedByOther'],
  [/CLIENT_OFFLINE/, 'remoteWorkspace.error.clientOffline'],
  [/NOT_FOUND/, 'remoteWorkspace.error.notFound'],
  [/UNREACHABLE|TIMEOUT|NETWORK/, 'remoteWorkspace.error.unreachable'],
];

export function psbFailureMessageKey(code: string | null | undefined): string {
  if (code) {
    for (const [pattern, key] of FAILURE_MESSAGE_KEYS) {
      if (pattern.test(code)) return key;
    }
  }
  return 'remoteWorkspace.error.unknown';
}

/** 失败里能直接拿到的占用人名（PSB `details` 里有；没有就靠刷新列表补）。 */
export interface PsbFailureInfo {
  readonly code: string | null;
  readonly messageKey: string;
  readonly message: string | null;
  readonly personName: string | null;
}

function readPersonName(details: unknown): string | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const value = (details as { personName?: unknown }).personName;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 把任意 IPC 失败收敛成可展示的失败信息。顺序：
 *   1. 结构化 `{ code, messageKey, message, details? }`（`PsbRemoteFailure` 形状，含占用人名）；
 *   2. 既有 `[CODE] message` 的 IpcError；
 *   3. 兜底：错误自身的 message 只做诊断，不直接当用户文案（可能是英文技术串）。
 */
export function readPsbFailure(err: unknown): PsbFailureInfo {
  if (err && typeof err === 'object') {
    const record = err as {
      code?: unknown;
      messageKey?: unknown;
      message?: unknown;
      details?: unknown;
    };
    const code = typeof record.code === 'string' && record.code ? record.code : null;
    const explicitKey =
      typeof record.messageKey === 'string' && record.messageKey ? record.messageKey : null;
    if (code || explicitKey) {
      return {
        code,
        messageKey: explicitKey ?? psbFailureMessageKey(code),
        message: typeof record.message === 'string' && record.message ? record.message : null,
        personName: readPersonName(record.details),
      };
    }
  }
  const ipc = extractIpcError(err);
  if (ipc) {
    return {
      code: ipc.code,
      messageKey: psbFailureMessageKey(ipc.code),
      message: ipc.message || null,
      // 占用失败的人名**只能**经 message 跨进程（IPC 只带 code+message）；main 侧对
      // `occupiedByOther` 已把 message 收敛成「占用人名，拿不到则空串」，所以这里可以直接
      // 按码回填 personName——否则草稿页的 toast 只剩「使用中」，把"正被谁占用"丢了。
      personName:
        ipc.code === 'PSB_WORKSPACE_OCCUPIED_BY_OTHER' && ipc.message.trim()
          ? ipc.message.trim()
          : null,
    };
  }
  const message =
    err instanceof Error ? err.message : typeof err === 'string' && err ? err : null;
  return { code: null, messageKey: 'remoteWorkspace.error.unknown', message, personName: null };
}

/**
 * 失败 → 一句可读文案（toast / 内联提示共用的口径）。
 *
 * 占用失败要带占用人名（PSB 409 的 `details.personName`）；拿不到人名时退回「使用中」，
 * 而不是把空 `{{name}}` 填进模板。
 */
export function psbFailureText(
  failure: PsbFailureInfo,
  t: (key: string, options?: Record<string, string>) => string,
): string {
  if (failure.messageKey === 'remoteWorkspace.error.occupiedByOther' && !failure.personName) {
    return t('remoteWorkspace.badge.occupied');
  }
  if (failure.messageKey === 'remoteWorkspace.error.occupiedByOther') {
    return t(failure.messageKey, { name: failure.personName ?? '' });
  }
  return t(failure.messageKey);
}

/**
 * PSB 会话创建的去重键（每次发送尝试生成一次；重试沿用同一个键）。
 *
 * 双击/重试时同一个键只应建出一条 PSB 会话；渲染层还有在途守卫，这里是第二道
 * （PSB 侧据此去重）。
 */
export function createPsbClientRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `psb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
