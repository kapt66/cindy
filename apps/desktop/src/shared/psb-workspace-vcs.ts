/**
 * PSB 工作区版本控制检查（CINDY-RW-10）——共享契约。
 *
 * ## 事实来源（两代服务端口径并存，2026-11-26 20:4x 再更正）
 *
 * **PSB 0.1.180 起（当前口径）**：占用 / 解除占用**恒成功**（除权限、被他人占用、工作区不存在
 * 等原有错误）。成功响应（2xx）里带一份**建议性**的 `data.vcs`（`advisory:true`）：
 *
 * ```json
 * { "code": "WORKSPACE_VCS_DIRTY", "advisory": true, "dirty": true,
 *   "messageZh": "检测到未提交修改（2 个检出）",
 *   "projects": [{ "projectId": 1, "pathInWorkspace": ".", "kind": "p4", "changes": 3 }],
 *   "actions": [
 *     { "kind": "inspect-vcs", "method": "GET", "path": "…/vcs", "descriptionZh": "查看详情" },
 *     { "kind": "clean-workspace", "method": "POST", "path": "…/vcs/revert",
 *       "body": { "projectIds": [1], "confirm": "revert" }, "descriptionZh": "一键清理" },
 *     { "kind": "continue", "descriptionZh": "忽略提示，继续使用工作区" } ] }
 * ```
 *
 * `dirty:false` 时 `data.vcs` 可缺省；`planned`/`failed` 工作区视为干净、不提示。
 * `clean-workspace` 返回 **202 + operationId**，服务端在统一执行窗口里异步清理。
 * 旧 `revert-then-occupy` / `revert-then-release` 已取消。
 *
 * **旧版 PSB（<0.1.180）兼容路径**：仍可能返回 `409 WORKSPACE_VCS_*` +
 * `error.details.vcs`，actions 是旧形状（`inspect-vcs` / `revert-then-*` / `retry`，更早还有
 * `revert-vcs`）。这不是主路径，但**不能删**：用户可能连着旧部署。旧形状按「错误」处置，
 * 新形状按「建议」处置（非阻塞提示）。
 *
 * 两代共同底线：**没有 force 分支**（旧 `force-release` 已删除，收到也不执行、不渲染按钮）。
 *
 * ## 为什么 action 要白名单 + 只消费服务端给的 method/path/body
 *
 * `actions` 里的 `method` / `path` / `body` 由 PSB 给全（形状会随服务端演进，例如
 * `clean-workspace` 的还原细节）。Cindy **按原样执行**，不自己拼路径；但也绝不盲信：
 * 本文件只保留认识的 kind / 方法 / 路径形状，main 侧（`vcsNotice.ts`）还会校验路径属于
 * **同一个 workspaceId**、不含绝对地址 / `..` / `force`，body 只接受白名单键。
 */

/** 版本控制检查通知码（PSB 错误外壳 `error.code`，也是 advisory `code`）。 */
export const WORKSPACE_VCS_NOTICE_CODES = [
  'WORKSPACE_VCS_DIRTY',
  'WORKSPACE_VCS_UNAVAILABLE',
  'WORKSPACE_VCS_UNSUPPORTED',
] as const;

export type WorkspaceVcsNoticeCode = (typeof WORKSPACE_VCS_NOTICE_CODES)[number];

export function isWorkspaceVcsNoticeCode(value: unknown): value is WorkspaceVcsNoticeCode {
  return (
    typeof value === 'string' &&
    (WORKSPACE_VCS_NOTICE_CODES as readonly string[]).includes(value)
  );
}

/**
 * 可执行的处置动作。
 *
 * ## 0.1.180 advisory（主路径）
 * - `inspect-vcs`：`GET …/vcs`（查看未提交修改详情）
 * - `clean-workspace`：`POST …/vcs/revert`（可带 projectIds）→ **202 + operationId**，
 *   服务端在统一执行窗口里清理（不可撤销）
 * - `continue`：忽略提示，**不调接口**（没有 method/path）
 *
 * ## 旧版 409 兼容（<0.1.180）
 * - `revert-then-occupy`：`POST …/occupy` body `{revert:true}`（先还原、成功后才占用）
 * - `revert-then-release`：释放的等价形态（method/path/body 由 PSB 给全）
 * - `revert-vcs`：更早的 `POST …/vcs/revert`（旧 19:4x 之前的形状）
 * - `retry`：重新尝试检查
 *
 * `force-release` **不在这里**：没有 force 分支，收到也不执行。
 */
export const WORKSPACE_VCS_ACTION_KINDS = [
  'inspect-vcs',
  'clean-workspace',
  'continue',
  // 旧版 409 兼容动作（见上）。
  'revert-then-occupy',
  'revert-then-release',
  'revert-vcs',
  'retry',
] as const;

export type WorkspaceVcsActionKind = (typeof WORKSPACE_VCS_ACTION_KINDS)[number];

export function isWorkspaceVcsActionKind(value: unknown): value is WorkspaceVcsActionKind {
  return (
    typeof value === 'string' &&
    (WORKSPACE_VCS_ACTION_KINDS as readonly string[]).includes(value)
  );
}

/** 0.1.180 advisory 才能出现的动作（旧 409 notice 里出现也按兼容执行，只是不做主路径推断）。 */
export const WORKSPACE_VCS_ADVISORY_ACTION_KINDS = [
  'inspect-vcs',
  'clean-workspace',
  'continue',
] as const;

/** 旧版 409 兼容动作。 */
export const WORKSPACE_VCS_LEGACY_ACTION_KINDS = [
  'revert-then-occupy',
  'revert-then-release',
  'revert-vcs',
  'retry',
] as const;

/**
 * 已删除的 action：`force-release` 绕过检查（没有 force 分支）。收到也**不执行、不渲染按钮**。
 *
 * 单独导出是为了让测试能明确断言它被丢弃，而不是靠「不在白名单里」的间接推断。
 */
export const REMOVED_WORKSPACE_VCS_ACTION_KINDS = ['force-release'] as const;

/** 动作允许的 HTTP 方法（`continue` 不需要请求，单独处理）。 */
export const WORKSPACE_VCS_ACTION_METHODS = ['GET', 'POST', 'DELETE'] as const;

export type WorkspaceVcsActionMethod = (typeof WORKSPACE_VCS_ACTION_METHODS)[number];

export function isWorkspaceVcsActionMethod(value: unknown): value is WorkspaceVcsActionMethod {
  return (
    typeof value === 'string' &&
    (WORKSPACE_VCS_ACTION_METHODS as readonly string[]).includes(value)
  );
}

/**
 * action body 的唯一允许键（服务端还可能给 `force` 之类的旧形状——一律拒绝）。
 *
 * - `revert: true`：先还原再执行（旧版 `revert-then-*`）
 * - `projectIds`：参与还原 / 清理的检出
 * - `confirm`：服务端要求的确认标记（如 `"revert"`）
 */
export const WORKSPACE_VCS_ACTION_BODY_KEYS = ['revert', 'projectIds', 'confirm'] as const;

/** PSB 给出的版本控制检查路径前缀（与 `psb-remote-workspace.ts` 的 `PSB_CINDY_API_PREFIX` 同源）。 */
export const WORKSPACE_VCS_WORKSPACES_PATH_PREFIX = '/api/cindy/remote/workspaces/';

/** 一个检出的未提交修改摘要。 */
export interface WorkspaceVcsProject {
  /** PSB 项目 id（契约样例是数字；兼容文本 id）。 */
  readonly projectId: number | string;
  /** 检出在工作区里的相对路径（根目录是 `.`）。 */
  readonly pathInWorkspace: string;
  /** 版本控制类型（`p4` / `git` 这类 PSB 事实，Cindy 只展示）。 */
  readonly kind: string;
  /** 未提交修改数量。 */
  readonly changes: number;
}

/** PSB 给出的一个处置动作。 */
export interface WorkspaceVcsAction {
  readonly kind: WorkspaceVcsActionKind;
  /** `continue` 不需要请求，没有 method/path。 */
  readonly method?: WorkspaceVcsActionMethod;
  readonly path?: string;
  readonly body?: Readonly<Record<string, unknown>>;
  /**
   * PSB 的中文说明（可直接展示）。
   *
   * 同时是给用户看的**动作文案**：Cindy 有本地化的 `remoteWorkspace.vcs.action.*` 文案，但
   * PSB 若给了 `descriptionZh` 就优先用它（它更清楚服务端要做什么，例如清理的最终范围）。
   */
  readonly descriptionZh?: string;
}

/**
 * 一份版本控制检查通知（advisory `data.vcs` 或旧版 409 `error.details.vcs`）。
 *
 * - `advisory:true` = 0.1.180 的成功响应附带的**建议**（非阻塞提示，操作已生效）
 * - `advisory:false` = 旧版 409 拒绝（操作未生效，按错误处置）
 * - `dirty:true` 表示检出脏；`WORKSPACE_VCS_UNAVAILABLE` / `WORKSPACE_VCS_UNSUPPORTED`
 *   的 `dirty` 恒为 `false`，语义是「无法确认干净」（旧版 409 下同样是拒绝）。
 */
export interface WorkspaceVcsNotice {
  readonly code: WorkspaceVcsNoticeCode;
  /** 是否是 0.1.180 的成功响应建议（`false` = 旧版 409 拒绝）。 */
  readonly advisory: boolean;
  /** PSB 中文原话（可直接展示；Cindy 另有本地化兜底）。 */
  readonly messageZh: string;
  readonly dirty: boolean;
  readonly projects: readonly WorkspaceVcsProject[];
  readonly actions: readonly WorkspaceVcsAction[];
}

/** 产生 notice 的入口（渲染层据此决定 `retry` 重试哪个操作、提示文案）。 */
export const WORKSPACE_VCS_OPERATIONS = ['occupy', 'release', 'ensure'] as const;

export type WorkspaceVcsOperation = (typeof WORKSPACE_VCS_OPERATIONS)[number];

/**
 * main → renderer：某工作区的版本控制通知（缓存更新时广播；成功占用/释放后广播
 * `notice:null` 让提示条撤掉）。
 */
export interface PsbWorkspaceVcsNoticeEvent {
  readonly workspaceId: string;
  /** 这次 notice 是哪个入口产生的（清除事件沿用上一次的入口）。 */
  readonly operation: WorkspaceVcsOperation;
  /** `null` = 该工作区的通知已解除（成功占用 / 释放 / 清理已接受）。 */
  readonly notice: WorkspaceVcsNotice | null;
}

/** `WORKSPACE_VCS_NOTICE_GET` 的返回值（`null` = 该工作区当前没有 notice）。 */
export interface PsbWorkspaceVcsNoticeResult {
  readonly workspaceId: string;
  readonly notice: WorkspaceVcsNotice | null;
}

/** 渲染层请求执行一个处置动作（**只传 kind**，method/path/body 由 main 从服务端 notice 取）。 */
export interface PsbRunWorkspaceVcsActionRequest {
  readonly workspaceId: string;
  readonly kind: WorkspaceVcsActionKind;
  /**
   * 不可逆动作（`clean-workspace` / 各 `revert-*`）必须二次确认后显式传 `true`；main 缺这个
   * 标记就拒绝（即使 IPC 被绕过，也不能凭一个 kind 就触发还原）。
   */
  readonly confirm?: boolean;
}

/** `WORKSPACE_VCS_ACTION` 的返回值。 */
export interface PsbRunWorkspaceVcsActionResponse {
  readonly workspaceId: string;
  readonly kind: WorkspaceVcsActionKind;
  /** `true` = 服务端已接受（202，清理异步进行中）；其余动作通常 `false`。 */
  readonly accepted: boolean;
  /**
   * 异步执行 id（0.1.180 `clean-workspace` 的 202 响应带；拿不到为 `null`）。
   *
   * Cindy **不猜轮询端点**：渲染层据此提示「清理已开始，稍后刷新」，并给一个重新读工作区的
   * 刷新按钮（复用既有 `refreshWorkspaces`）。
   */
  readonly operationId: string | null;
  /**
   * PSB 的响应体（形状由服务端定义）：
   *
   * - `inspect-vcs`：未提交修改详情（渲染层按宽松结构展示，不在这里假定字段）
   * - 其余：通常为空
   */
  readonly data: unknown;
}

/* ============================== 解析（main / renderer 共用） ============================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 单个 notice 里最多保留多少条检出 / 动作：PSB 侧是有限集合，这里只防畸形载荷撑爆 IPC。 */
const MAX_PROJECTS = 64;
const MAX_ACTIONS = 8;

function readProjectId(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return null;
}

function parseProject(value: unknown): WorkspaceVcsProject | null {
  if (!isRecord(value)) return null;
  const projectId = readProjectId(value['projectId']);
  if (projectId === null) return null;
  const pathInWorkspace = readString(value['pathInWorkspace'])?.trim();
  if (!pathInWorkspace) return null;
  return {
    projectId,
    pathInWorkspace,
    kind: readString(value['kind'])?.trim() ?? '',
    changes:
      typeof value['changes'] === 'number' && Number.isFinite(value['changes'])
        ? Math.max(0, Math.trunc(value['changes']))
        : 0,
  };
}

function readActionBody(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === undefined) return {} as Readonly<Record<string, unknown>>;
  if (!isRecord(value)) return null;
  const body: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    // 白名单之外的键（`force` 之类）整条 action 丢弃：不做「只取认识的键、静默忽略其余」，
    // 否则服务端多给一个危险参数时 Cindy 会悄悄丢掉判断依据。
    if (!(WORKSPACE_VCS_ACTION_BODY_KEYS as readonly string[]).includes(key)) return null;
    body[key] = entry;
  }
  return body;
}

/** `continue` 之外的每个 kind 都必须有请求形状（method + 同源路径）。 */
export function workspaceVcsActionNeedsRequest(kind: WorkspaceVcsActionKind): boolean {
  return kind !== 'continue';
}

/**
 * 解析一条 action；形状不认识就返回 `null`（**丢弃**，不猜）。
 *
 * 这里只做形状白名单（kind / method / 相对路径 / body 键）；「路径是不是同一个工作区、
 * 有没有绝对地址 / `..` / force」属于 main 的安全边界，见 `main/remote-workspace/vcsNotice.ts`。
 */
export function parseWorkspaceVcsAction(value: unknown): WorkspaceVcsAction | null {
  if (!isRecord(value)) return null;
  const kind = value['kind'];
  if (!isWorkspaceVcsActionKind(kind)) return null;
  const descriptionZh = readString(value['descriptionZh'])?.trim();
  const base = {
    kind,
    ...(descriptionZh ? { descriptionZh } : {}),
  };
  if (!workspaceVcsActionNeedsRequest(kind)) {
    // `continue` 的语义是「不发任何请求」；带请求形状说明载荷不对，整条丢弃。
    if (value['method'] !== undefined || value['path'] !== undefined || value['body'] !== undefined) {
      return null;
    }
    return base;
  }
  const method = value['method'];
  if (!isWorkspaceVcsActionMethod(method)) return null;
  const path = readString(value['path'])?.trim();
  // 只接受绝对路径（相对路径会被拼到 PSB 站点根上，绝不接受 `http(s)://…`）。
  if (!path || !path.startsWith('/')) return null;
  const body = readActionBody(value['body']);
  if (body === null) return null;
  return {
    ...base,
    method,
    path,
    ...(body && Object.keys(body).length > 0 ? { body } : {}),
  };
}

/**
 * kind 与 HTTP 方法的对应关系（安全校验，不放宽）：
 *
 * - `inspect-vcs` 只能是 GET（它必须是只读的）
 * - `clean-workspace` / `revert-then-occupy` / `revert-vcs` 只能是 POST
 * - `revert-then-release` 允许 POST / DELETE（最终形状以 PSB 为准）
 * - `retry` 允许 GET / POST / DELETE（重新尝试检查 / 重新占用 / 重新释放）
 * - `continue` 不发请求
 */
export function workspaceVcsActionMethodAllowed(
  kind: WorkspaceVcsActionKind,
  method: WorkspaceVcsActionMethod | undefined,
): boolean {
  if (!workspaceVcsActionNeedsRequest(kind)) return method === undefined;
  if (!method) return false;
  switch (kind) {
    case 'inspect-vcs':
      return method === 'GET';
    case 'clean-workspace':
    case 'revert-then-occupy':
    case 'revert-vcs':
      return method === 'POST';
    case 'revert-then-release':
      return method === 'POST' || method === 'DELETE';
    case 'retry':
      return true;
    case 'continue':
      return false;
  }
}

/**
 * 解析一份 `WorkspaceVcsNotice`；`null` = 连错误码都不认识，调用方按普通失败 / 无提示处理。
 *
 * 校验口径：`code` 必须在白名单里；`messageZh` 必须是字符串（可以为空——旧服务端可能只给码，
 * 渲染层有本地化兜底）；`dirty` 非 `true` 一律按 `false`；`projects` / `actions` 里形状不对
 * 的条目**逐条丢弃**，不因此把整份 notice 判死（用户至少还能看到 `messageZh`）。
 */
export function parseWorkspaceVcsNotice(value: unknown): WorkspaceVcsNotice | null {
  if (!isRecord(value)) return null;
  const code = value['code'];
  if (!isWorkspaceVcsNoticeCode(code)) return null;
  const messageZh = readString(value['messageZh'])?.trim() ?? '';
  const projects: WorkspaceVcsProject[] = [];
  if (Array.isArray(value['projects'])) {
    for (const entry of value['projects']) {
      const project = parseProject(entry);
      if (project) projects.push(project);
      if (projects.length >= MAX_PROJECTS) break;
    }
  }
  const actions: WorkspaceVcsAction[] = [];
  if (Array.isArray(value['actions'])) {
    for (const entry of value['actions']) {
      const action = parseWorkspaceVcsAction(entry);
      if (!action) continue;
      if (!workspaceVcsActionMethodAllowed(action.kind, action.method)) continue;
      // 同一个 kind 只保留第一条：服务端重复下发时不要出现两个一样的按钮。
      if (actions.some((existing) => existing.kind === action.kind)) continue;
      actions.push(action);
      if (actions.length >= MAX_ACTIONS) break;
    }
  }
  const advisory = value['advisory'] === true;
  return {
    code,
    advisory,
    messageZh,
    // 只有 DIRTY 才可能是脏；UNAVAILABLE / UNSUPPORTED 的语义是「无法确认」，不是「脏」。
    dirty: value['dirty'] === true,
    projects,
    actions,
  };
}

/**
 * 某个 kind 是否在本 notice 里可执行（用于渲染按钮；main 执行前还会再校验一次）。
 */
export function findWorkspaceVcsAction(
  notice: WorkspaceVcsNotice | null | undefined,
  kind: WorkspaceVcsActionKind,
): WorkspaceVcsAction | null {
  if (!notice) return null;
  return notice.actions.find((action) => action.kind === kind) ?? null;
}

/** 不可逆动作（清理 / 还原）：UI 必须先二次确认，main 必须收到 `confirm:true`。 */
export function workspaceVcsActionIsIrreversible(kind: WorkspaceVcsActionKind): boolean {
  return (
    kind === 'clean-workspace' ||
    kind === 'revert-then-occupy' ||
    kind === 'revert-then-release' ||
    kind === 'revert-vcs'
  );
}

/** 动作的本地化文案键（PSB 没给 `descriptionZh` 时用它）。 */
export function workspaceVcsActionMessageKey(kind: WorkspaceVcsActionKind): string {
  return `remoteWorkspace.vcs.action.${kind}`;
}

/** 通知码的本地化标题键（PSB 没给 `messageZh` 时用它）。 */
export function workspaceVcsNoticeMessageKey(code: WorkspaceVcsNoticeCode): string {
  switch (code) {
    case 'WORKSPACE_VCS_DIRTY':
      return 'remoteWorkspace.vcs.dirty';
    case 'WORKSPACE_VCS_UNAVAILABLE':
      return 'remoteWorkspace.vcs.unavailable';
    case 'WORKSPACE_VCS_UNSUPPORTED':
      return 'remoteWorkspace.vcs.unsupported';
  }
}

/**
 * 从 PSB 的 2xx 响应体里取 advisory `vcs`（0.1.180）。
 *
 * 兼容两种外壳：`data.vcs`（契约样例）与 `data.workspace.vcs`（工作区行内嵌）；`dirty:false`
 * 或缺失时返回 `null`（契约允许缺省，不把「干净」当成一份要提示的 notice）。
 */
export function readAdvisoryWorkspaceVcs(data: unknown): WorkspaceVcsNotice | null {
  if (!isRecord(data)) return null;
  const candidates: unknown[] = [data['vcs']];
  const workspace = data['workspace'];
  if (isRecord(workspace)) candidates.push(workspace['vcs']);
  for (const candidate of candidates) {
    const notice = parseWorkspaceVcsNotice(candidate);
    if (notice && notice.dirty) return { ...notice, advisory: true };
  }
  return null;
}
