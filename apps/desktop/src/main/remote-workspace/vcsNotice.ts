/**
 * PSB 工作区**版本控制检查通知**（CINDY-RW-10）—— main 侧的安全边界与有界缓存。
 *
 * ## 两代口径（2026-11-26 20:4x 再更正）
 *
 * **0.1.180 起（主路径）**：占用 / 释放**恒成功**，2xx 响应里带**建议性** `data.vcs`
 * （`advisory:true`）。Cindy 把它变成非阻塞提示（「一键清理 / 继续」），不再有 409 拒绝。
 *
 * **旧版 PSB（<0.1.180，兼容路径）**：仍可能返回 `409 WORKSPACE_VCS_*` +
 * `error.details.vcs`。这条路径保留（用户可能还连着旧部署），按错误处置：`retry` /
 * 旧 `revert-*` 动作。
 *
 * ## 为什么需要这一层
 *
 * 两种形态都带 `actions[]`，里面给了 `method` / `path` / `body`。Cindy 的产品口径是
 * **按 actions 原样执行、不自己拼路径**；但这意味着 main 会去请求一个**服务端给的 URL**，
 * 所以必须在执行前做本地校验，不能盲信：
 *
 * 1. 路径必须是 `/api/cindy/remote/workspaces/<同一个 workspaceId>/…`（不能跨工作区）；
 * 2. 禁止绝对 URL / 协议 / 反斜杠 / `..` / 片段（`#`）/ 控制字符 —— 拼 URL 前就拒绝；
 * 3. 禁止 `force` 查询参数：**没有 force 分支**（旧 `force-release` 已删除），即使服务端
 *    下发也不执行；
 * 4. body 只接受 `revert` / `projectIds` / `confirm`，其余键整条 action 丢弃；
 * 5. kind 与 HTTP 方法必须匹配（`inspect-vcs` 只读 GET、`clean-workspace` 只 POST…），
 *    `continue` 不发请求。
 *
 * 白名单与形状解析在 `shared/psb-workspace-vcs.ts`（main / renderer 共用）；本文件只加
 * **和 workspaceId 绑定**的安全校验、执行前复核与缓存。
 *
 * ## 缓存为什么必须有界
 *
 * 一个进程里可能开过很多工作区；notice 只是「最近一次检查的处置提示」，不是事实账本。
 * 保留最近 32 个工作区（Map 的插入顺序即 LRU）：成功占用 / 成功释放 / 清理或继续后立刻清除。
 * 渲染层读不到时按普通 PSB 失败处理（`message` 里仍有 `messageZh`）。
 */

import type {
  WorkspaceVcsAction,
  WorkspaceVcsActionKind,
  WorkspaceVcsActionMethod,
  WorkspaceVcsNotice,
  WorkspaceVcsOperation,
} from '../../shared/psb-workspace-vcs.js';
import {
  WORKSPACE_VCS_ACTION_BODY_KEYS,
  WORKSPACE_VCS_ACTION_METHODS,
  WORKSPACE_VCS_WORKSPACES_PATH_PREFIX,
  findWorkspaceVcsAction,
  parseWorkspaceVcsNotice,
  workspaceVcsActionNeedsRequest,
} from '../../shared/psb-workspace-vcs.js';

/** 缓存上限：只保留最近被拒的工作区处置提示（见文件头）。 */
export const PSB_WORKSPACE_VCS_NOTICE_LIMIT = 32;

const MAX_DESCRIPTION_ZH = 500;
const MAX_PROJECT_IDS = 256;
const MAX_CONFIRM_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnsafeChars(value: string): boolean {
  // 控制字符 / 空白 / 反斜杠 / URL 片段：合法 PSB 路径里都不该出现。
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f\s\\#]/.test(value);
}

/**
 * 一个处置动作的**固定目标**（相对 PSB 站点的路径 + 方法）。
 *
 * ## 为什么不再采信服务端下发的 method/path
 *
 * 旧实现「按服务端给的 method/path 原样执行」，只校验路径是否在同一工作区前缀下——这留下了
 * 两个洞：①`retry` 允许任意 HTTP 方法；②只拒绝字面 `..`，而 `%2e%2e` 会被 URL 解析器归一化到
 * 命名空间之外（带 Bearer 的请求就被打到别的路由上）。安全边界不能建立在「服务端给的值会
 * 守规矩」之上。
 *
 * 现在每个 `kind` 只有一个固定的 method + path（由本文件拼、只含 `encodeURIComponent(id)`）；
 * 服务端下发的形状只用来**确认这是一条能执行的 action**（服务端若给出不同路径/方法，整条丢弃，
 * 绝不先按它的值发一次再纠正）。白名单之外的 kind 根本不会出现在 cache 里。
 *
 * 旧版 409 的 `revert-then-*` 同样固定成 PSB 的既有路由；`retry` 需要知道「重试哪个操作」，
 * 由产生 notice 的入口（`operation`）决定。
 */
export function workspaceVcsActionTarget(
  workspaceId: string,
  kind: WorkspaceVcsActionKind,
  operation: WorkspaceVcsOperation,
): { readonly method: WorkspaceVcsActionMethod; readonly path: string } | null {
  const id = workspaceId.trim();
  if (!id) return null;
  const base = `${WORKSPACE_VCS_WORKSPACES_PATH_PREFIX}${encodeURIComponent(id)}`;
  switch (kind) {
    case 'continue':
      return null;
    case 'inspect-vcs':
      return { method: 'GET', path: `${base}/vcs` };
    case 'clean-workspace':
    case 'revert-vcs':
      return { method: 'POST', path: `${base}/vcs/revert` };
    case 'revert-then-occupy':
      return { method: 'POST', path: `${base}/occupy` };
    case 'revert-then-release':
      return { method: 'DELETE', path: `${base}/occupy` };
    case 'retry':
      // retry 的语义是「重新执行被检查拦下的那个操作」：占用（含 ensure 自动占用）重试占用，
      // 释放重试释放。方向不能猜——猜错会把用户的「释放」变成「占用」。
      return operation === 'release'
        ? { method: 'DELETE', path: `${base}/occupy` }
        : { method: 'POST', path: `${base}/occupy` };
  }
}

/** action 允许的 HTTP 方法（与共享契约同口径；只用于形状校验，执行时用固定目标）。 */
const REMOTE_ACTION_METHODS: readonly string[] = WORKSPACE_VCS_ACTION_METHODS;

/**
 * 服务端路径的**形状**校验（纵深防御，不决定执行目标）。
 *
 * - 必须以工作区路径前缀开头；
 * - 第一段解码后必须**等于同一个 workspaceId**（跨工作区一票否决）；
 * - 任何一段解码后是 `.` / `..`（含 `%2e%2e`）直接拒绝：URL 归一化会把它们吃掉，
 *   只查字面 `..` 会漏；
 * - 不允许 `force` 查询参数（更正版没有 force 分支）。
 */
export function isAllowedWorkspaceVcsActionPath(workspaceId: string, path: string): boolean {
  const id = workspaceId.trim();
  if (!id || typeof path !== 'string' || !path.startsWith(WORKSPACE_VCS_WORKSPACES_PATH_PREFIX)) {
    return false;
  }
  if (!path.startsWith('/') || path.includes('://') || hasUnsafeChars(path) || path.includes('..')) {
    return false;
  }
  const rest = path.slice(WORKSPACE_VCS_WORKSPACES_PATH_PREFIX.length);
  const queryAt = rest.indexOf('?');
  const pathPart = queryAt >= 0 ? rest.slice(0, queryAt) : rest;
  const segments = pathPart.split('/');
  const workspaceSegment = segments[0] ?? '';
  if (!workspaceSegment) return false;
  let decodedWorkspace: string;
  try {
    decodedWorkspace = decodeURIComponent(workspaceSegment);
    for (const segment of segments) {
      const decoded = decodeURIComponent(segment);
      if (decoded === '.' || decoded === '..') return false;
    }
  } catch {
    return false;
  }
  if (decodedWorkspace !== id) return false;
  // 动作段不能为空（`/workspaces/<id>` 本身不是可执行动作）。
  if (segments.length < 2 || segments.slice(1).join('/').length === 0) return false;
  const query = queryAt >= 0 ? rest.slice(queryAt + 1) : '';
  // 无 force 分支：服务端即使下发也不执行。
  if (/(?:^|&)force(?:=|&|$)/i.test(query)) return false;
  return true;
}

/**
 * body 白名单：只接受 `revert` / `projectIds` / `confirm`。
 *
 * 返回 `undefined` = 没有 body；`null` = 有 body 但不合法（调用方丢弃整条 action）。
 */
export function sanitizeWorkspaceVcsActionBody(
  value: unknown,
): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !(WORKSPACE_VCS_ACTION_BODY_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  const body: Record<string, unknown> = {};
  if (value['revert'] !== undefined) {
    if (typeof value['revert'] !== 'boolean') return null;
    body['revert'] = value['revert'];
  }
  if (value['projectIds'] !== undefined) {
    const list = value['projectIds'];
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PROJECT_IDS) return null;
    const ids: (number | string)[] = [];
    for (const entry of list) {
      if (typeof entry === 'number' && Number.isFinite(entry)) ids.push(entry);
      else if (typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 64) {
        ids.push(entry.trim());
      } else {
        return null;
      }
    }
    body['projectIds'] = ids;
  }
  if (value['confirm'] !== undefined) {
    const confirm = value['confirm'];
    if (typeof confirm !== 'string' || confirm.length === 0 || confirm.length > MAX_CONFIRM_LENGTH) {
      return null;
    }
    body['confirm'] = confirm;
  }
  return body;
}

/** 取路径的 pathname 部分（去掉 query），用于和服务端给的固定路径比较。 */
function pathnameOf(path: string): string {
  const queryAt = path.indexOf('?');
  return queryAt >= 0 ? path.slice(0, queryAt) : path;
}

/**
 * 执行前的最后一道校验：kind / method / 同工作区路径 / body 白名单。
 *
 * 目标 method/path 一律用 {@link workspaceVcsActionTarget} 的固定值（**不采信服务端**）；
 * 服务端下发的形状只用于确认「这是一条已知 action」：method 与目标不一致、pathname 与固定
 * 路径不一致、或路径形状越界（跨工作区 / `..` / encoded dot / `force`）→ 整条丢弃。
 *
 * 返回 `null` 表示这条 action 不能执行（丢弃，不猜）。
 */
export function sanitizeWorkspaceVcsAction(
  workspaceId: string,
  action: WorkspaceVcsAction | null | undefined,
  operation: WorkspaceVcsOperation,
): WorkspaceVcsAction | null {
  if (!action) return null;
  const descriptionZh =
    typeof action.descriptionZh === 'string' ? action.descriptionZh.trim() : undefined;
  const base = {
    kind: action.kind,
    ...(descriptionZh && descriptionZh.length <= MAX_DESCRIPTION_ZH
      ? { descriptionZh }
      : {}),
  };
  // `continue` 不发请求：没有 method/path/body，也绝不能带（带了说明载荷不对，整条丢弃）。
  if (!workspaceVcsActionNeedsRequest(action.kind)) {
    return action.method === undefined && action.path === undefined && action.body === undefined
      ? base
      : null;
  }
  const target = workspaceVcsActionTarget(workspaceId, action.kind, operation);
  if (!target) return null;
  if (!action.method || !action.path) return null;
  if (!REMOTE_ACTION_METHODS.includes(action.method) || action.method !== target.method) return null;
  if (!isAllowedWorkspaceVcsActionPath(workspaceId, action.path)) return null;
  // 服务端路径必须就是那条固定路径（query 允许保留：`?project=1` 这类只作范围提示；
  // 危险参数已在 `isAllowedWorkspaceVcsActionPath` 里拒绝）。
  if (pathnameOf(action.path) !== target.path) return null;
  const body = sanitizeWorkspaceVcsActionBody(action.body);
  if (body === null) return null;
  return {
    ...base,
    // 执行目标固定成本地拼的值：即使服务端路径带 query，也只执行这条 canonical 路径。
    method: target.method,
    path: target.path,
    ...(body === undefined || Object.keys(body).length === 0 ? {} : { body }),
  };
}

/**
 * 服务端载荷 → 可缓存 / 可下发的 notice；不合法返回 `null`。
 *
 * `workspaceId` 用于逐条 action 的路径绑定校验：不属于这个工作区的动作直接丢弃（不留按钮）。
 * `operation` 是产生 notice 的入口（决定 `retry` 的重试方向）。
 */
export function sanitizeWorkspaceVcsNotice(
  workspaceId: string,
  value: unknown,
  operation: WorkspaceVcsOperation,
): WorkspaceVcsNotice | null {
  const parsed = parseWorkspaceVcsNotice(value);
  if (!parsed) return null;
  const actions: WorkspaceVcsAction[] = [];
  const seen = new Set<WorkspaceVcsActionKind>();
  for (const action of parsed.actions) {
    const sanitized = sanitizeWorkspaceVcsAction(workspaceId, action, operation);
    if (!sanitized || seen.has(sanitized.kind)) continue;
    seen.add(sanitized.kind);
    actions.push(sanitized);
  }
  return { ...parsed, actions };
}

export interface WorkspaceVcsNoticeEntry {
  readonly notice: WorkspaceVcsNotice;
  readonly operation: WorkspaceVcsOperation;
}

export interface WorkspaceVcsNoticeCache {
  /**
   * 记录 / 刷新某工作区的 notice。返回 `false` 表示载荷不合法（未写入；调用方按普通失败处理）。
   */
  remember(workspaceId: string, value: unknown, operation: WorkspaceVcsOperation): boolean;
  /** 读当前 notice（`null` = 没有）。 */
  read(workspaceId: string): WorkspaceVcsNotice | null;
  /** 读当前 notice + 产生它的入口（推送事件要用 `operation`）。 */
  readEntry(workspaceId: string): WorkspaceVcsNoticeEntry | null;
  /** 取某个可执行动作（main 执行处置动作时用；未缓存 / 没有该 kind → `null`）。 */
  findAction(workspaceId: string, kind: WorkspaceVcsActionKind): WorkspaceVcsAction | null;
  /** 清除（成功占用 / 成功释放 / 还原成功之后）。返回是否真的清掉了。 */
  clear(workspaceId: string): boolean;
  /** 当前缓存条数（测试 / 诊断）。 */
  size(): number;
}

export function createWorkspaceVcsNoticeCache(
  options: { limit?: number } = {},
): WorkspaceVcsNoticeCache {
  const limit = Math.max(1, options.limit ?? PSB_WORKSPACE_VCS_NOTICE_LIMIT);
  const entries = new Map<string, WorkspaceVcsNoticeEntry>();

  function touch(workspaceId: string): void {
    const current = entries.get(workspaceId);
    if (!current) return;
    entries.delete(workspaceId);
    entries.set(workspaceId, current);
    while (entries.size > limit) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  return {
    remember(workspaceId, value, operation) {
      const id = workspaceId.trim();
      if (!id) return false;
      const notice = sanitizeWorkspaceVcsNotice(id, value, operation);
      if (!notice) return false;
      entries.delete(id);
      entries.set(id, { notice, operation });
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return true;
    },
    read(workspaceId) {
      const id = workspaceId.trim();
      const entry = entries.get(id) ?? null;
      if (!entry) return null;
      touch(id);
      return entry.notice;
    },
    readEntry(workspaceId) {
      const id = workspaceId.trim();
      const entry = entries.get(id) ?? null;
      if (!entry) return null;
      touch(id);
      return entry;
    },
    findAction(workspaceId, kind) {
      const id = workspaceId.trim();
      const entry = entries.get(id);
      if (!entry) return null;
      const action = findWorkspaceVcsAction(entry.notice, kind);
      // 执行前按产生 notice 的入口再收敛一次（`retry` 的方向由 operation 决定）。
      return sanitizeWorkspaceVcsAction(id, action, entry.operation);
    },
    clear(workspaceId) {
      return entries.delete(workspaceId.trim());
    },
    size() {
      return entries.size;
    },
  };
}
