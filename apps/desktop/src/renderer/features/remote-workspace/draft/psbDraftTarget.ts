/**
 * 草稿页的「远程工作区目标」纯函数层。
 *
 * ## 为什么有独立一层
 *
 * 侧栏弹窗确认后只把**工作区级**事实交给草稿页（`onCreated` 载荷经 route state 的
 * `psbTarget` 字段交接）：工作区 id、客户端名、工作区标题、目录名。PSB 会话在首条消息
 * 发送时才懒创建，所以交接里**没有** sessionId / agentKind（引擎在草稿页按既有链路选）。
 *
 * 这些值都是**脏值安全**的：路由 state 会进浏览器历史，可能被旧版本写入或手改；
 * 校验不过就整块丢弃（宁可让用户重选一次，也不能让 `psb:` 变成一个来路不明的目标）。
 */

import type { NewMakerDraftPsbTarget } from '@/state/newMakerDraft';

import type { RemoteWorkspacePickerCreated } from '../dialog/psbDialogModel';

/** 侧栏 → 草稿页的交接载荷（history state 上的 `psbTarget` 字段）。工作区级，无会话 id。 */
export interface PsbDraftRouteTarget {
  workspaceId: string;
  clientId: string;
  clientName: string;
  workspaceTitle: string;
  directoryName: string | null;
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * `directoryName` 是 PSB 侧**一个目录名**（用于拼虚拟工作目录 `/psb-remote/<name>`），
 * 不是路径。history state 可能被旧版本写入或手改，**含 `/`、`\` 或 `..` 的值一律丢弃**
 * （`null`）：否则虚拟目录会出现多余层级、`..` 还能让显示/匹配逻辑跑出前缀语义。
 * 校验不过只丢掉这个展示字段，目标本身仍成立（调用方用工作区 id 兜底虚拟目录）。
 */
export function readPsbDirectoryName(value: unknown): string | null {
  const text = readText(value);
  if (!text) return null;
  if (text === '.' || text === '..') return null;
  if (text.includes('/') || text.includes('\\')) return null;
  if (text.includes('..')) return null;
  // 控制字符在路径/日志里都只会制造不可见歧义。
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  if (text.length > 255) return null;
  return text;
}

/**
 * 读交接载荷。`workspaceId` 必填（没有它无法占用/建会话）；展示字段可缺省——
 * 旧版本或手改的 history state 缺客户端名时，目标头退回「—」，但目标本身仍然成立。
 */
export function readPsbDraftRouteTarget(state: unknown): PsbDraftRouteTarget | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const raw = (state as { psbTarget?: unknown }).psbTarget;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const workspaceId = readText(record.workspaceId);
  if (!workspaceId) return null;
  const directoryName = readPsbDirectoryName(record.directoryName);
  return {
    workspaceId,
    clientId: readText(record.clientId),
    clientName: readText(record.clientName),
    workspaceTitle: readText(record.workspaceTitle),
    directoryName,
  };
}

/**
 * 一次性导航指令：应用后从当前 history entry 移除，避免浏览器后退到旧记录时再次应用。
 * 其它 route state（`workspacePrompt` 等）必须原样保留。
 */
export function consumePsbDraftRouteTarget(state: unknown): unknown {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  if (!Object.prototype.hasOwnProperty.call(state, 'psbTarget')) return state;
  const remaining = { ...(state as Record<string, unknown>) };
  delete remaining.psbTarget;
  return remaining;
}

/** 交接载荷 / 弹窗载荷 → 草稿目标（无 sessionId：会话在首条消息发送时懒创建）。 */
export function buildPsbDraftTarget(
  input: PsbDraftRouteTarget | RemoteWorkspacePickerCreated,
): NewMakerDraftPsbTarget {
  return {
    workspaceId: input.workspaceId,
    clientId: input.clientId,
    clientName: input.clientName,
    workspaceTitle: input.workspaceTitle,
    directoryName: input.directoryName,
    sessionId: null,
  };
}
