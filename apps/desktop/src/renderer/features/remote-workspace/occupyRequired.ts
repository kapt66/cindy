/**
 * 「这个工作区还没被你占用」→ **用户确认后显式占用**的唯一渲染层实现（2026-11-27 用户复测）。
 *
 * ## 为什么要这一层
 *
 * 用户口径：**所有工作区占用都必须由用户通过弹窗确认，禁止任何默认/自动占用**。main 侧的
 * 占用闸门因此在隐式写路径（发送消息 / 启动串流 / 新建会话）上不再替用户占用，而是返回
 * `PSB_WORKSPACE_NOT_OCCUPIED`（与 PSB 2026-11-27 守卫契约 `403 WORKSPACE_NOT_OCCUPIED`
 * 同码同形）。渲染层必须把这条失败变成**可执行的两步**：
 *
 *   1. 弹确认框（工作区名 + 「占用后其他人无法使用，直到你释放 / 结束任务」）；
 *   2. 用户确认 → 显式占用（`psb-remote:occupy-workspace`，VCS advisory 照旧走既有通知）
 *      → 由调用方**重试发起的那次动作**（发送 / 启动串流）。
 *
 * 同一段文案、同一个确认框、同一条占用请求只在这里；各入口不得自己再写一份（否则「确认后
 * 占用失败」在不同入口会给出不同的话，甚至静默不占用）。
 *
 * ## 两种调用形态
 *
 * - **直接调用**（启动串流这类「手上就有 workspaceId + 名称」的入口）：`confirmAndOccupyPsbWorkspace`。
 * - **注册式**（发送消息：失败发生在 `makerChatStore` 的 enqueue 里，store 没有 React 上下文）：
 *   `registerPsbOccupyConfirmationResolver` 由挂载在 App 的宿主组件注册，
 *   `requestPsbOccupyConfirmationForSession` 让 store 在确认期间挂起这次发送，确认成功后自己重试。
 *   没有宿主（旧 preload / 副窗 / 单测）时返回 `false`：失败照旧落到错误横幅，**不会**静默占用。
 *
 * ## 失败语义
 *
 * 占用本身失败（被抢 / 离线 / 未就绪 / 网络）一律回 `'failed'`：调用方**不得**重试发起的动作，
 * 而是把本次失败按既有 `PSB_*` 文案展示（被抢时有占用人名）。用户取消 → `'declined'`：
 * 不占用、不发动作，草稿 / 输入保留（由调用方的既有恢复路径负责）。
 */

import type { TFunction } from 'i18next';

import { extractIpcError } from '@/utils/ipcError';

import { tryGetPsbRemoteBridge } from './bridge';
import { psbFailureText } from './psbFailureText';

/**
 * 「需要先占用」的跨 IPC 失败码。
 *
 * 与共享单表 `PSB_FAILURE_DESCRIPTORS.PSB_WORKSPACE_NOT_OCCUPIED` 的键同名；用字面量而不是
 * 从表里反查，是因为这里需要的是**码名**而不是描述符（表键就是唯一来源，改名会 typecheck 失败
 * ——本文件没有 import 表，所以配了一条渲染层单测钉住字面量与单表一致）。
 */
export const PSB_OCCUPY_REQUIRED_IPC_CODE = 'PSB_WORKSPACE_NOT_OCCUPIED';

/** 确认框文案键（复用选择流程已有的 `remoteWorkspace.dialog.confirmOccupy.*`，12 locale 已齐）。 */
export const PSB_OCCUPY_CONFIRM_KEYS = {
  title: 'remoteWorkspace.dialog.confirmOccupy.title',
  body: 'remoteWorkspace.dialog.confirmOccupy.body',
  confirm: 'remoteWorkspace.dialog.confirmOccupy.confirm',
  cancel: 'remoteWorkspace.dialog.confirmOccupy.cancel',
} as const;

/** 这个失败是不是「工作区还没被你占用」。 */
export function isPsbOccupyRequiredFailure(error: unknown): boolean {
  const ipc = extractIpcError(error);
  if (ipc) return ipc.code === PSB_OCCUPY_REQUIRED_IPC_CODE;
  // 还没被包装成结构化 IPC 错误的形态（主进程内抛出的 `PsbClientError` / 裸字符串）：
  // 只认稳定码名，不解析文案。
  const text =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return text.includes(`[${PSB_OCCUPY_REQUIRED_IPC_CODE}]`);
}

/**
 * 占用这一步需要的最小桥形状。
 *
 * 用结构最小接口而不是整张 `PsbRemoteBridge`：管理页拿到的是它自己的窄桥
 * （`PsbWorkspaceAdminBridge`），发送路径拿到的是完整桥，两者都有 `occupyWorkspace`；
 * 这里只依赖真正用到的那个方法，不必为「有没有别的管理方法」而变化。
 */
export interface PsbOccupyWorkspacePort {
  occupyWorkspace(input: { workspaceId: string }): Promise<unknown>;
}

/** 确认为「占用」这一步的结果；调用方据此决定是否重试发起的那次动作。 */
export type PsbOccupyConfirmationOutcome = 'occupied' | 'declined' | 'failed';

export interface PsbOccupyConfirmParams {
  /** 已本地化的 `t`（调用方持有当前语言）。 */
  readonly t: TFunction;
  /** `useConfirmDialog().confirm`：复用 Cindy 的模态队列 / 焦点陷阱 / 主题。 */
  readonly confirm: (options: {
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<boolean>;
  /** 工作区显示名（空串时用中性标题，不编造名字）。 */
  readonly workspaceName: string;
  /** 占用成功后：调用方重试发起的那次动作。失败态的文案由调用方用 `psbFailureText` 展示。 */
  readonly workspaceId: string;
  readonly bridge?: PsbOccupyWorkspacePort | null;
}

/** 「需要占用」确认框的本地化文案（标题带工作区名；没有名字时退化为通用问句）。 */
export function psbOccupyConfirmCopy(
  t: TFunction,
  workspaceName: string,
): { title: string; description: string; confirmText: string; cancelText: string } {
  const name = workspaceName.trim();
  return {
    title: name
      ? t(PSB_OCCUPY_CONFIRM_KEYS.title, { name })
      : t('remoteWorkspace.admin.actionOccupy'),
    description: t(PSB_OCCUPY_CONFIRM_KEYS.body),
    confirmText: t(PSB_OCCUPY_CONFIRM_KEYS.confirm),
    cancelText: t(PSB_OCCUPY_CONFIRM_KEYS.cancel),
  };
}

/**
 * 弹确认框 → 用户确认后显式占用。
 *
 * 不负责重试动作本身（那是调用方的事实：发送 / 启动串流各有自己的通道）；也不负责展示占用
 * 失败文案（同样由调用方接既有 `psbFailureText`）。
 */
export async function confirmAndOccupyPsbWorkspace(
  params: PsbOccupyConfirmParams,
): Promise<PsbOccupyConfirmationOutcome> {
  const workspaceId = params.workspaceId.trim();
  const bridge = params.bridge ?? tryGetPsbRemoteBridge();
  // 没有桥 = 旧 preload / 非主窗：不能假装占用成功（那会让调用方重试一次必然失败的写入）。
  if (!workspaceId || !bridge) return 'failed';

  const approved = await params.confirm(psbOccupyConfirmCopy(params.t, params.workspaceName));
  if (!approved) return 'declined';

  try {
    await bridge.occupyWorkspace({ workspaceId });
  } catch {
    // 失败原因（被抢 / 离线 / 网络）由调用方接既有文案表展示：这里不再读一遍错误。
    return 'failed';
  }
  return 'occupied';
}

/* ---------------- 注册式：让「发送」在确认期间挂起并自行重试 ---------------- */

/**
 * `sessionId → 用户是否同意并已成功占用`。
 *
 * 宿主组件挂载时注册、卸载时注销；返回 `true` 表示**此刻工作区确实由用户占用**（可以重试）。
 */
export type PsbOccupyConfirmationResolver = (sessionId: string) => Promise<boolean>;

/**
 * `{workspaceId, workspaceName} → 用户是否同意并已成功占用`。
 *
 * 给**还没有本地任务**的入口用（新建 / 懒建 PSB 会话：那时只有工作区事实，没有 sessionId）。
 */
export type PsbOccupyWorkspaceConfirmationResolver = (input: {
  workspaceId: string;
  workspaceName: string;
}) => Promise<boolean>;

let confirmationResolver: PsbOccupyConfirmationResolver | null = null;
let workspaceConfirmationResolver: PsbOccupyWorkspaceConfirmationResolver | null = null;

/** 注册宿主（App 主窗挂载一次）；返回注销函数。 */
export function registerPsbOccupyConfirmationResolver(
  resolver: PsbOccupyConfirmationResolver,
): () => void {
  confirmationResolver = resolver;
  return () => {
    if (confirmationResolver === resolver) confirmationResolver = null;
  };
}

/** 注册「按工作区」确认宿主（与上面同一宿主组件注册）；返回注销函数。 */
export function registerPsbOccupyWorkspaceConfirmationResolver(
  resolver: PsbOccupyWorkspaceConfirmationResolver,
): () => void {
  workspaceConfirmationResolver = resolver;
  return () => {
    if (workspaceConfirmationResolver === resolver) workspaceConfirmationResolver = null;
  };
}

/**
 * 请求用户确认占用（store 在 enqueue 被 `PSB_WORKSPACE_NOT_OCCUPIED` 拒绝时调用）。
 *
 * 没有宿主 / 宿主异常 → `false`（发送失败落到错误横幅，不静默占用、也不假装成功）。
 */
export async function requestPsbOccupyConfirmationForSession(
  sessionId: string,
): Promise<boolean> {
  const resolver = confirmationResolver;
  if (!resolver) return false;
  try {
    return await resolver(sessionId);
  } catch {
    return false;
  }
}

/**
 * 请求用户确认占用（**还没有本地任务**的入口：懒建 PSB 会话）。
 *
 * 没有宿主 / 宿主异常 → `false`：调用方按原失败返回（不静默占用）。
 */
export async function requestPsbOccupyConfirmationForWorkspace(input: {
  workspaceId: string;
  workspaceName: string;
}): Promise<boolean> {
  const resolver = workspaceConfirmationResolver;
  if (!resolver) return false;
  try {
    return await resolver(input);
  } catch {
    return false;
  }
}

/**
 * 用 main 的 `adminContext` 解析「这条本地任务的工作区」（发送路径唯一可用的 workspaceId 来源）。
 *
 * 渲染层不持有 workspaceId（那是主进程的事实，见 `bridge.releaseWorkspaceForSession` 注释），
 * 所以这里读 main 已经算好的上下文；`workspaceIdKnown === false`（只有占位身份）时给 `null`
 * —— 拿占位 id 去占用只会得到一条不可行动失败。
 */
export async function resolvePsbWorkspaceForOccupyConfirmation(
  bridge: { adminContext(input: { localSessionId: string }): Promise<{ context: unknown }> } | null | undefined,
  localSessionId: string | null | undefined,
): Promise<{ workspaceId: string; workspaceName: string } | null> {
  if (!bridge || !localSessionId) return null;
  try {
    const result = await bridge.adminContext({ localSessionId });
    const context = result.context as {
      workspaceId?: unknown;
      title?: unknown;
      workspaceIdKnown?: unknown;
    } | null;
    if (!context || context.workspaceIdKnown === false) return null;
    const workspaceId = typeof context.workspaceId === 'string' ? context.workspaceId.trim() : '';
    if (!workspaceId) return null;
    return {
      workspaceId,
      workspaceName: typeof context.title === 'string' ? context.title.trim() : '',
    };
  } catch {
    return null;
  }
}

/** 失败 → 一行可展示文案（占用失败 / 取消后的动作失败统一入口；不新增第二张码表）。 */
export function psbOccupyFailureText(t: TFunction, error: unknown): string {
  return psbFailureText(t, error);
}
