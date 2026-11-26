/**
 * PSB HTTP 客户端（main 进程）—— Cindy「远程工作区」的唯一出口。
 *
 * 契约正本在 PSB 仓根目录 `协作需求.md`（§4 接口附录）；本文件是它在 Cindy 侧的**唯一实现**：
 * 路径、外壳、错误码、重试策略都在这里收敛一次，renderer 只消费 `PsbRemoteFailure`（可翻译的键 + 原始码）。
 *
 * ## 三条不变式
 *
 * 1. **Bearer 只进请求头**：token 不进 URL、不进日志、不进 IPC 返回值。日志里最多出现
 *    "audience 已解析" 这类不含凭据的字段。
 * 2. **401 只重签一次**：`AUTH_INVALID` / `AUTH_EXPIRED` 说明内存缓存里那条 token 不能用了（时钟漂移、
 *    组织切换、云端轮换）。失效缓存 + 重新签发一次；再失败就是真的不能用了，不再循环
 *    （否则 401 会变成对云端签发接口的放大攻击）。
 * 3. **网络失败与业务失败分开**：`PSB_UNREACHABLE`（连不上 / 超时）与 PSB 返回的 `{error:{code}}`
 *    是两类事实——前者让用户查网络，后者让用户看工作区。混成一个码会让"为什么不能开会话"
 *    永远只有一句"操作失败"。
 */

import type { AuthState } from '../authManager.js';
import type {
  PsbAgentKind,
  PsbCreateSessionRequest,
  PsbCreateWorkspaceRequest,
  PsbProjectTemplate,
  PsbRemoteClient,
  PsbRemoteFailure,
  PsbRemoteSession,
  PsbRemoteWorkspace,
  PsbSessionStreamStatus,
  PsbWorkspaceAccessState,
  PsbWorkspaceStreamSubscription,
} from '../../shared/psb-remote-workspace.js';
import {
  PSB_CINDY_API_PREFIX,
  PSB_CINDY_WS,
  PSB_CINDY_ROUTES,
  PSB_CINDY_FAILURE_CODES,
  PSB_ERROR_CODES,
  PSB_NO_RUNNING_SESSION_CODE,
  PSB_WEB_ROUTES,
  isPsbWorkspaceAccessState,
  parsePsbProjectTemplate,
  parsePsbRemoteClient,
  parsePsbRemoteSession,
  parsePsbRemoteWorkspace,
  parsePsbSessionStreamStatus,
  parsePsbWorkspaceStreamSubscription,
  psbNoRunningSessionMessageKey,
} from '../../shared/psb-remote-workspace.js';
import { parseWorkspaceVcsNotice, readAdvisoryWorkspaceVcs } from '../../shared/psb-workspace-vcs.js';
import type { WorkspaceVcsNotice } from '../../shared/psb-workspace-vcs.js';
import { createIpcError } from '../../shared/ipc-errors.js';
import { getPsbConnectionToken, invalidatePsbConnectionToken } from './psbAuth.js';
import type { PsbConnectionTokenPort } from './psbAuth.js';
import { psbHttpUrl } from './psbEndpoint.js';

/** 单次 HTTP 调用的默认预算。列表类接口都不该更久；超时按网络失败处理。 */
const DEFAULT_HTTP_TIMEOUT_MS = 20_000;

/**
 * 单次 HTTP 响应体的读取上限（4 MiB）。
 *
 * PSB 的 Cindy 入口都是列表/单行 DTO，正常响应远小于它；无上限时一个畸形/异常大的响应会被
 * 整段读进 main 内存再进 JSON 解析。有 `content-length` 时在读取前就拒绝；chunked 响应只能
 * 读完后按字节数拒绝（仍会先分配一次，但不会进入解析与下发）。
 */
export const PSB_HTTP_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** 响应体超限：不是网络失败，调用方按 `PSB_PROTOCOL` 归因（不重试）。 */
class PsbResponseTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`PSB response is too large (${bytes} bytes, limit ${PSB_HTTP_MAX_RESPONSE_BYTES})`);
    this.name = 'PsbResponseTooLargeError';
  }
}

interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface PsbApiDeps {
  /** 出网实现（生产 = `outboundFetch`，走系统代理；单测注入假实现）。 */
  fetch(input: string, init: RequestInit): Promise<Response>;
  getAuthState(): AuthState;
  tokens: PsbConnectionTokenPort;
  logger: Logger;
  timeoutMs?: number;
  /**
   * 「拉起桌面访问」用的路径构造器。**生产不要传**（用共享契约的
   * `PSB_WEB_ROUTES.workspaceAccessStart`）；只在 PSB 改路由时由装配点覆盖一次，
   * 或单测里钉住路径。除此之外**不允许**在别处拼这条 URL。
   */
  workspaceAccessStartPath?: (workspaceId: string) => string;
  /**
   * `ensureWorkspaceAccess` 轮询 `GET …/access` 到 `running` 的预算。
   *
   * 生产默认 {@link PSB_ACCESS_POLL_DEFAULT}（约 3s）；单测注入 `intervalMs: 0` 避免真实等待
   * （测试卫生要求不做 ≥100ms 真实等待）。
   */
  accessPoll?: { attempts?: number; intervalMs?: number };
}

/** 失败：`failure.messageKey` 是 i18n 键，`failure.message` 是 PSB 原文（兜底显示，不含凭据）。 */
export class PsbClientError extends Error {
  constructor(readonly failure: PsbRemoteFailure, readonly status: number | null) {
    // `message` 允许为 null（例如只给 i18n 键的失败）；Error.message 需要字符串，空串即"没有可读原文"。
    super(failure.message ?? '');
    this.name = 'PsbClientError';
  }
}

/** 把 PSB 错误码翻译成 Cindy 的 i18n 键。未知码落到通用文案，但原始码仍留在 `failure.code`。 */
export function psbMessageKeyForErrorCode(code: string): string {
  switch (code) {
    case PSB_ERROR_CODES.authRequired:
    case PSB_ERROR_CODES.authInvalid:
      return 'remoteWorkspace.error.auth';
    case PSB_ERROR_CODES.authExpired:
      return 'remoteWorkspace.error.authExpired';
    case PSB_ERROR_CODES.identityNotLinked:
      return 'remoteWorkspace.error.identityNotLinked';
    case PSB_ERROR_CODES.occupiedByOther:
      return 'remoteWorkspace.error.occupiedByOther';
    case PSB_ERROR_CODES.clientOffline:
      return 'remoteWorkspace.error.clientOffline';
    case PSB_ERROR_CODES.notFound:
      return 'remoteWorkspace.error.notFound';
    // CINDY-RW-10：版本控制检查的三种拒绝各有下一步，绝不能落进「操作失败」。
    case PSB_ERROR_CODES.workspaceVcsDirty:
      return 'remoteWorkspace.vcs.dirty';
    case PSB_ERROR_CODES.workspaceVcsUnavailable:
      return 'remoteWorkspace.vcs.unavailable';
    case PSB_ERROR_CODES.workspaceVcsUnsupported:
      return 'remoteWorkspace.vcs.unsupported';
    // 没有 running 桌面访问（订阅 409）：具体文案按 `details.state` 选，见
    // `readNoRunningSessionFailure`；这里给 none 家族兜底（未知状态也落这一档）。
    case PSB_CINDY_FAILURE_CODES.streamNoRunningSession:
      return 'remoteWorkspace.admin.streamAccessNone';
    default:
      return 'remoteWorkspace.error.unknown';
  }
}

/** 被他人占用时，`details.name`（或 `occupiedByName`）里带占用人名，用于文案插值。 */
export function readOccupiedByName(details: unknown): string | null {
  if (typeof details !== 'object' || details === null) return null;
  const record = details as Record<string, unknown>;
  for (const key of ['name', 'occupiedByName', 'personName']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `details` 里给用户看的中文原话（PSB 两种拼写都见过：`messageZh` / `message`）。 */
function readDetailsMessageZh(details: unknown): string | null {
  if (!isRecord(details)) return null;
  const messageZh = details['messageZh'];
  if (typeof messageZh === 'string' && messageZh.trim()) return messageZh.trim();
  const message = details['message'];
  if (typeof message === 'string' && message.trim()) return message.trim();
  return null;
}

/**
 * 把「订阅串流时没有 running 桌面访问」的 409 收敛成 Cindy 的结构化失败。
 *
 * PSB 0.1.180 的形态（`packages/server/src/http/routes/cindy-remote-access.ts`）：
 * `409 { error: { code, message?, details: { code:'NO_RUNNING_SESSION', workspaceId, state } } }`
 * ——`details.state ∈ none/starting/stopping/stopped/failed`，`message` 是可行动中文。
 *
 * 这里只认这一个机器码；其它 409 仍走通用失败映射（不能让别的冲突被误标成「去网页启动」）。
 * `state` 未知时归一成 `null`（渲染层落「去网页启动」那一档），**不猜**。
 */
export function readNoRunningSessionFailure(input: {
  code: string;
  message: string;
  details: unknown;
}): PsbRemoteFailure | null {
  const detailsCode = isRecord(input.details) ? input.details['code'] : undefined;
  const isNoRunningSession =
    detailsCode === PSB_NO_RUNNING_SESSION_CODE || input.code === PSB_NO_RUNNING_SESSION_CODE;
  if (!isNoRunningSession) return null;
  const rawState = isRecord(input.details) ? input.details['state'] : undefined;
  const state: PsbWorkspaceAccessState | null = isPsbWorkspaceAccessState(rawState)
    ? rawState
    : null;
  const message = input.message.trim() || readDetailsMessageZh(input.details) || null;
  return {
    code: PSB_CINDY_FAILURE_CODES.streamNoRunningSession,
    messageKey: psbNoRunningSessionMessageKey(state),
    message,
    streamAccessState: state,
  };
}

function psbFailureFromResponse(input: {
  status: number;
  code: string;
  message: string;
  details: unknown;
  /**
   * 这是**订阅串流**的失败：把 409「没有 running 桌面访问」解析成结构化失败。
   *
   * 只在订阅那条调用上开启：其它端点的 409 有不同的含义（占用冲突等），不能让它们被
   * 误标成「去 PSB 网页启动访问」。
   */
  mapNoRunningSession?: boolean;
}): PsbRemoteFailure {
  if (input.status === 409 && input.mapNoRunningSession === true) {
    const noRunning = readNoRunningSessionFailure(input);
    if (noRunning) return noRunning;
  }
  const occupiedName = readOccupiedByName(input.details);
  const messageKey = psbMessageKeyForErrorCode(input.code);
  const vcs = readWorkspaceVcsNotice(input.details);
  return {
    code: input.code,
    messageKey,
    // 占用失败的 `message` **只放占用人名**（拿不到就空串）：IPC 只能跨进程带 code+message，
    // 渲染层据此回填 `{{name}}`；混进 PSB 的中文原文会让「人名」变成一整句话。
    //
    // 版本控制检查失败相反：`details.vcs.messageZh` 才是给用户看的事实（「工作区有未提交
    // 修改：2 个检出」），PSB 的 `error.message` 常常是空的，所以这里用它兜底。
    message:
      messageKey === 'remoteWorkspace.error.occupiedByOther'
        ? (occupiedName ?? '')
        : vcs
          ? input.message.trim() || vcs.messageZh
          : input.message,
    ...(vcs ? { vcs } : {}),
  };
}

/**
 * 从 PSB 错误 `details` 里读 `vcs`（CINDY-RW-10）。
 *
 * 只做形状解析；「路径是否属于同一工作区 / body 是否合法」由 `vcsNotice.ts` 在缓存与执行前
 * 校验（那需要 workspaceId）。这里返回 `undefined` 表示这次失败与版本控制检查无关。
 */
function readWorkspaceVcsNotice(details: unknown) {
  if (typeof details !== 'object' || details === null) return undefined;
  const raw = (details as Record<string, unknown>)['vcs'];
  if (raw === undefined) return undefined;
  return parseWorkspaceVcsNotice(raw) ?? undefined;
}

function unreachableFailure(detail: string): PsbRemoteFailure {
  return {
    code: 'PSB_UNREACHABLE',
    messageKey: 'remoteWorkspace.error.unreachable',
    message: detail,
  };
}

/** 处置动作允许的方法（与共享契约 `WORKSPACE_VCS_ACTION_METHODS` 同口径；这里独立兜底）。 */
const REMOTE_ACTION_METHODS: readonly string[] = ['GET', 'POST', 'DELETE'];

/**
 * 服务端给的 action 路径在**发请求前**的本地校验（第二道，第一道在 `vcsNotice.ts`）。
 *
 * 只允许 Cindy 命名空间的相对路径：绝对 URL / 协议 / 反斜杠 / `..` / `#` / 控制字符全部拒绝。
 * 这条判断必须与 workspaceId 无关地生效——即使上层漏了工作区绑定校验，也不能被指去任意主机。
 */
export function isAllowedPsbRemoteActionPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 2_048) return false;
  if (!path.startsWith(`${PSB_CINDY_API_PREFIX}/`)) return false;
  if (path.includes('://') || path.includes('\\') || path.includes('..') || path.includes('#')) {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f\s]/.test(path);
}

function assertRemoteAction(input: { method: string; path: string }): void {
  if (!REMOTE_ACTION_METHODS.includes(input.method)) {
    throw createIpcError('INVALID_PARAMS', `unsupported remote action method: ${input.method}`);
  }
  if (!isAllowedPsbRemoteActionPath(input.path)) {
    throw createIpcError('INVALID_PARAMS', 'remote action path is not an allowed PSB path');
  }
}

/**
 * 占用 / 释放响应解析：工作区行 + 建议性 VCS 通知（0.1.180）。
 *
 * 外壳兼容 `{ workspace, vcs }` 与「工作区行内嵌 `vcs`」；`vcs` 只在 `dirty:true` 时返回。
 */
function parseWorkspaceOperation(data: unknown): PsbWorkspaceOperationOutcome | null {
  if (typeof data !== 'object' || data === null) return null;
  const row = data as Record<string, unknown>;
  const workspace = parsePsbRemoteWorkspace(row['workspace'] ?? row);
  if (!workspace) return null;
  return { workspace, vcs: readAdvisoryWorkspaceVcs(row) };
}

/**
 * 从处置动作的响应体里取**异步执行 id**（0.1.180 `clean-workspace` 返回 202 + operationId）。
 *
 * 形状宽松（`operationId` / `operation.id` / `id`）：PSB 只需给出稳定标记，Cindy 不解析它，
 * 只用来说明「清理已开始」；**不猜轮询端点**（见 `shared/psb-workspace-vcs.ts`）。
 */
export function readWorkspaceVcsOperationId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const direct = record['operationId'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (typeof direct === 'number' && Number.isFinite(direct)) return String(direct);
  const operation = record['operation'];
  if (typeof operation === 'object' && operation !== null) {
    const nested = (operation as Record<string, unknown>)['id'];
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
    if (typeof nested === 'number' && Number.isFinite(nested)) return String(nested);
  }
  return null;
}

interface ResponseEnvelope {
  readonly data?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown; readonly details?: unknown };
  /**
   * 平铺失败外壳：`{ code, message?, details? }`（PSB 0.1.180 的 409 在 Cindy 入口上可能这样
   * 直接给，契约摘要写的是 `{ code/error, … }`）。只作为 `error` 缺席时的兜底，不猜第三种形状。
   */
  readonly code?: unknown;
  readonly message?: unknown;
  readonly details?: unknown;
}

interface FailureFields {
  readonly code: string | null;
  readonly message: string;
  readonly details: unknown;
}

/**
 * 从失败外壳取 `code` / `message` / `details`：`{ error: { … } }` 优先，平铺形态兜底。
 *
 * 两种都是 PSB 侧真实存在过的形状（Cindy 入口统一 `{error}`；0.1.180 的 access 路由在网页
 * 命名空间上见过平铺），所以两种都读——但**只读这两种**，不递归猜。
 */
function readFailureFields(envelope: ResponseEnvelope | null): FailureFields {
  const nested = envelope?.error;
  if (typeof nested === 'object' && nested !== null) {
    return {
      code: typeof nested.code === 'string' ? nested.code : null,
      message: typeof nested.message === 'string' ? nested.message : '',
      details: nested.details,
    };
  }
  return {
    code: typeof envelope?.code === 'string' ? envelope.code : null,
    message: typeof envelope?.message === 'string' ? envelope.message : '',
    details: envelope?.details,
  };
}

function parseEnvelope(text: string): ResponseEnvelope | null {
  if (text.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as ResponseEnvelope;
  } catch {
    return null;
  }
}

export interface PsbApi {
  listWorkspaces(input?: {
    clientId?: string;
    readyOnly?: boolean;
  }): Promise<PsbRemoteWorkspace[]>;  listClients(): Promise<PsbRemoteClient[]>;
  listProjectTemplates(): Promise<PsbProjectTemplate[]>;
  createWorkspace(input: PsbCreateWorkspaceRequest): Promise<PsbRemoteWorkspace>;
  getWorkspace(workspaceId: string): Promise<PsbRemoteWorkspace>;
  /**
   * 占用工作区（PSB 侧幂等）。
   *
   * 0.1.180 起占用**恒成功**（除权限 / 被他人占用 / 不存在等原有错误）；成功响应里可能带
   * 一份**建议性**版本控制通知（`data.vcs`，`advisory:true`）。旧版 PSB 仍可能用
   * `409 WORKSPACE_VCS_*` 拒绝，那条兼容路径由 `PsbClientError.failure.vcs` 承载。
   */
  occupyWorkspace(workspaceId: string): Promise<PsbWorkspaceOperationOutcome>;
  releaseWorkspace(workspaceId: string): Promise<PsbWorkspaceOperationOutcome>;
  /**
   * 执行 PSB 下发的一条处置动作（CINDY-RW-10 版本控制 notice 的 `actions[]`）。
   *
   * 这是**唯一**按「服务端给的 method/path」发请求的入口：调用方（`index.ts`）已用
   * `vcsNotice.ts` 校验过路径属于同一个工作区、body 在白名单内；这里再兜一次形状校验，
   * 绝不放行绝对 URL / 跨域 / 非 Cindy 命名空间。Bearer、401 单次重签、20s 超时与 4MiB
   * 响应上限与其它调用同一口径。
   *
   * 返回 `data` 原值（`inspect-vcs` 是详情对象，其余通常是 `null`）；业务失败照常抛
   * `PsbClientError`（带 `vcs` 时由调用方重新缓存）。
   */
  runRemoteAction(input: {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    body?: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
  listSessions(workspaceId: string): Promise<PsbRemoteSession[]>;
  createSession(input: PsbCreateSessionRequest): Promise<{
    session: PsbRemoteSession;
    workspace: PsbRemoteWorkspace;
  }>;
  getSession(sessionId: string): Promise<{
    session: PsbRemoteSession;
    workspace: PsbRemoteWorkspace;
  }>;
  /**
   * 订阅某工作区的串流（PSB 0.1.172 工作区级服务接口）。
   *
   * 只解析该工作区当前 `running` 的**桌面访问会话**并返回它的 id：**不创建任何 Agent 会话**。
   * 没有 running 访问会话时 PSB 回 **409**，body 里带
   * `error.details.code='NO_RUNNING_SESSION'` + `details.state`（none/starting/stopping/
   * stopped/failed）与可行动中文；本函数把它解析成
   * `failure.code='PSB_STREAM_NO_RUNNING_SESSION'` + `failure.streamAccessState`，调用方据此
   * 选文案与是否重试（见 `readNoRunningSessionFailure`）。**不要**在这里自动拉访问——Cindy
   * 现在还没有被放行的拉起入口（`ensureWorkspaceAccess` 是可选增强）。
   */
  subscribeWorkspaceStream(workspaceId: string): Promise<PsbWorkspaceStreamSubscription>;
  /**
   * **尽力**拉起该工作区的桌面访问（可选增强；失败一律非致命）。
   *
   * 语义（PSB 0.1.180）：`POST /api/remote/workspaces/:id/access/start` 是**幂等 ensure**
   * （200/202/409）；成功后轮询 `GET /api/cindy/remote/workspaces/:id/access` 直到 `running`
   * 或超时。它是 PSB 网页「远程控制 › 启动访问」那条链的机器形态。
   *
   * ## 为什么是「尽力」而不是闸门
   *
   * PSB 的 Cindy Bearer 白名单目前**没有放行** `/api/remote/**`（恒 403），PSB 台账记的是
   * 「Cindy 入口下一轮加」。所以本函数把 403/404/405/`UNSUPPORTED` 收敛成
   * `reason:'cindy-entry-not-open'` 的**非致命**结果，调用方继续走原有错误路径（订阅 409 会
   * 给出可行动文案）。**不抛异常**：一条未放行的增强接口不能把「启动串流」变成失败。
   *
   * 结果形状见 {@link PsbWorkspaceAccessEnsureOutcome}。
   */
  ensureWorkspaceAccess(workspaceId: string): Promise<PsbWorkspaceAccessEnsureOutcome>;
  stopSession(sessionId: string): Promise<void>;
  getStreamStatus(sessionId: string): Promise<PsbSessionStreamStatus>;
}

/**
 * 「尽力拉起桌面访问」的结果。
 *
 * 全是数据、没有异常：调用方只按 `ok` / `reason` 记日志，然后继续原来的启动流程。
 * `failure` 只在能归因时带上（`cindy-entry-not-open` 也带，便于把 403 与「真失败」分开写日志）。
 */
export type PsbWorkspaceAccessEnsureOutcome =
  | {
      readonly ok: true;
      readonly state: 'running';
      /** `true` = 是这次调用把它从非 running 拉到 running（轮询期间观察到的）。 */
      readonly startedByThisCall: boolean;
    }
  | {
      readonly ok: false;
      /**
       * - `cindy-entry-not-open`：Cindy 身份没被放行（403）/ 路由不存在（404/405/旧 PSB）；
       * - `timeout`：接口受理了，但轮询预算内没到 `running`（例如 Unity 还没就绪）；
       * - `failed`：其它业务 / 网络 / 协议失败（同样不阻断订阅）。
       */
      readonly reason: 'cindy-entry-not-open' | 'timeout' | 'failed';
      readonly failure: PsbRemoteFailure | null;
    };

/**
 * 占用 / 释放的返回值：工作区行 + （0.1.180）建议性版本控制通知。
 *
 * `vcs` 只在服务端说「检出脏」时是非空；`dirty:false` / 字段缺省都是 `null`（不提示）。
 */
export interface PsbWorkspaceOperationOutcome {
  readonly workspace: PsbRemoteWorkspace;
  readonly vcs: WorkspaceVcsNotice | null;
}

/**
 * `ensureWorkspaceAccess` 轮询预算（生产默认）。
 *
 * 约 3s：既够 Unity / 虚拟桌面把 `starting` 走完的常见时间，又不至于让用户点「启动」后等太久。
 * 超过预算不是错误，只是返回 `timeout` 让调用方继续走原路径（订阅 409 会带 `starting`，
 * 界面侧还有一次 ~2s 自动重试）。
 */
export const PSB_ACCESS_POLL_DEFAULT = { attempts: 6, intervalMs: 500 } as const;

/**
 * 从 `GET …/access`（或 `POST …/access/start`）的响应里读桌面访问状态。
 *
 * **响应形状 PSB 还没给最终示例**（`联动需求.md` 已登记要它），所以只认三种同义字段
 * （`state` / `desktopSession` / 嵌套 `access.state`），都是「访问实例自身状态」这一个概念；
 * 读不到 / 未知值一律 `null`，由调用方按「没拿到」处理，**不猜**。
 */
export function readWorkspaceAccessState(value: unknown): PsbWorkspaceAccessState | null {
  if (!isRecord(value)) return null;
  const nestedAccess = isRecord(value['access']) ? value['access']['state'] : undefined;
  for (const candidate of [value['state'], value['desktopSession'], nestedAccess]) {
    if (isPsbWorkspaceAccessState(candidate)) return candidate;
  }
  return null;
}

/**
 * 「拉起访问」失败的归因：哪些算「Cindy 入口还没开放」（非致命、不记 warn）。
 *
 * 403 = 白名单不放行（真机现状）；404/405 = 旧 PSB 没有这条路由；`UNSUPPORTED` /
 * `NOT_IMPLEMENTED` / `ROUTE_NOT_FOUND` 是 PSB 旧版本的等价回答。
 */
function isAccessEnsureRouteUnavailable(error: unknown): boolean {
  if (!(error instanceof PsbClientError)) return false;
  if (error.status === 403 || error.status === 404 || error.status === 405) return true;
  switch (error.failure.code) {
    case 'FORBIDDEN':
    case 'NOT_FOUND':
    case 'UNSUPPORTED':
    case 'NOT_IMPLEMENTED':
    case 'ROUTE_NOT_FOUND':
      return true;
    default:
      return false;
  }
}

/** 轮询间隔（尊重 `unref`：主进程退出时不该被一条等待拖住）。 */
function waitForAccessPoll(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function createPsbApi(deps: PsbApiDeps): PsbApi {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;

  async function requestOnce(
    path: string,
    init: { method: string; body?: unknown; token: string },
  ): Promise<{ response: Response; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await deps.fetch(psbHttpUrl(path), {
        method: init.method,
        headers: {
          authorization: `Bearer ${init.token}`,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });
      const text = await readResponseText(response);
      return { response, text };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 读响应体并强制上限：声明了过大的 `content-length` 时直接拒绝，不把 body 读进内存。 */
  async function readResponseText(response: Response): Promise<string> {
    const declaredHeader = response.headers?.get?.('content-length') ?? null;
    if (declaredHeader !== null) {
      const declared = Number(declaredHeader);
      if (Number.isFinite(declared) && declared > PSB_HTTP_MAX_RESPONSE_BYTES) {
        // 不读 body（读就等于先把攻击面分配出来）；best-effort 取消流，避免连接停在半读状态。
        await response.body?.cancel().catch(() => undefined);
        throw new PsbResponseTooLargeError(declared);
      }
    }
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > PSB_HTTP_MAX_RESPONSE_BYTES) throw new PsbResponseTooLargeError(bytes);
    return text;
  }

  /**
   * 带一次重签的请求。`parse` 决定成功响应的形状；`parse` 返回 `null` 视为协议错。
   */
  async function call<T>(
    label: string,
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'DELETE';
      body?: unknown;
      parse: (data: unknown) => T | null;
      allowEmptyResult?: boolean;
      /**
       * 允许**没有 `{ data }` 外壳**的成功响应（返回 `undefined`，不判协议错）。
       *
       * 只给「尽力拉起桌面访问」这两条**可选增强**接口用：PSB 0.1.180 的 access 路由还没有
       * 给最终响应示例（`联动需求.md` 已登记），202/200 可能是空对象或平铺对象。这里拿不到
       * `state` 只意味着「没观察到状态」，不该把一次 202 判成契约违约——调用方继续轮询 / 继续
       * 走原来的订阅路径。Cindy 命名空间的常规接口**不**开这个口子（外壳缺失必须响亮失败）。
       */
      allowMissingDataEnvelope?: boolean;
      /** 订阅串流专用：把 409「没有 running 桌面访问」解析成结构化失败（见 `call` 的调用点）。 */
      mapNoRunningSession?: boolean;
    },
  ): Promise<T> {
    const method = options.method ?? 'GET';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const auth = await getPsbConnectionToken(deps);
      if (!auth.ok) {
        throw new PsbClientError(
          { code: 'AUTH_REQUIRED', messageKey: auth.reasonKey, message: auth.detail },
          null,
        );
      }
      let outcome: { response: Response; text: string };
      try {
        outcome = await requestOnce(path, {
          method,
          ...(options.body === undefined ? {} : { body: options.body }),
          token: auth.token,
        });
      } catch (error) {
        if (error instanceof PsbResponseTooLargeError) {
          // 超限不是网络失败：用户查网络没有意义，按契约违约归因，也不重试。
          deps.logger.warn('psb response exceeded the size limit', {
            label,
            bytes: error.bytes,
            limit: PSB_HTTP_MAX_RESPONSE_BYTES,
          });
          throw new PsbClientError(
            {
              code: 'PSB_PROTOCOL',
              messageKey: 'remoteWorkspace.error.unknown',
              message: `response from ${label} is too large`,
            },
            null,
          );
        }
        const detail = error instanceof Error ? error.message : String(error);
        deps.logger.warn('psb request failed at the network layer', { label, detail });
        throw new PsbClientError(unreachableFailure(detail), null);
      }

      const envelope = parseEnvelope(outcome.text);
      const status = outcome.response.status;
      const fields = readFailureFields(envelope);

      if (status === 401 || status === 403) {
        const code =
          fields.code ?? (status === 401 ? PSB_ERROR_CODES.authRequired : 'FORBIDDEN');
        // 403 `IDENTITY_NOT_LINKED` 不是"token 坏了"，重签没有意义 —— 只有鉴权类 401 才重试。
        const retriable =
          attempt === 0 &&
          status === 401 &&
          (code === PSB_ERROR_CODES.authInvalid ||
            code === PSB_ERROR_CODES.authExpired ||
            code === PSB_ERROR_CODES.authRequired);
        if (retriable) {
          deps.logger.info('psb rejected the connection token; reissuing once', {
            label,
            code,
          });
          invalidatePsbConnectionToken(deps);
          continue;
        }
        throw new PsbClientError(
          psbFailureFromResponse({
            status,
            code,
            message: fields.message,
            details: fields.details,
            mapNoRunningSession: options.mapNoRunningSession,
          }),
          status,
        );
      }

      if (!outcome.response.ok) {
        const code = fields.code ?? `HTTP_${status}`;
        throw new PsbClientError(
          psbFailureFromResponse({
            status,
            code,
            message: fields.message,
            details: fields.details,
            mapNoRunningSession: options.mapNoRunningSession,
          }),
          status,
        );
      }

      if (options.allowEmptyResult === true && outcome.text.trim().length === 0) {
        return undefined as T;
      }
      // 外壳缺失 = 契约违约，必须响亮失败：PSB 的 Cindy 入口统一是 `{ data: … }`。
      // 2026-11-26 的联调就撞过这个坑——`stream/status` 少包一层 `data` 时，宽松的解析器把
      // `undefined` 静默回落成默认值（`capability:false` + 空错误），HTTP 200 却看不出任何异常，
      // 只能靠人肉比对 `/clients` 才发现。这里把「没有 data 键」当协议错抛出，同类问题不再被掩盖。
      // 例外只有显式开启 `allowMissingDataEnvelope` 的可选增强接口（见该选项的说明）。
      if (envelope === null || !('data' in envelope)) {
        if (options.allowMissingDataEnvelope === true) return undefined as T;
        deps.logger.warn('psb response is missing the data envelope', { label, status });
        throw new PsbClientError(
          {
            code: 'PSB_PROTOCOL',
            messageKey: 'remoteWorkspace.error.unknown',
            message: `missing data envelope from ${label}`,
          },
          status,
        );
      }
      const parsed = options.parse(envelope.data);
      if (parsed === null) {
        deps.logger.warn('psb returned an unexpected payload', { label, status });
        throw new PsbClientError(
          {
            code: 'PSB_PROTOCOL',
            messageKey: 'remoteWorkspace.error.unknown',
            message: `unexpected payload from ${label}`,
          },
          status,
        );
      }
      return parsed;
    }
    // 循环只有两轮且第二轮不会 continue；走到这里说明重签后仍被判 401 却没有抛错，属实现错误。
    throw new PsbClientError(
      { code: 'PSB_AUTH_LOOP', messageKey: 'remoteWorkspace.error.auth', message: null },
      401,
    );
  }

  const readArray = <T,>(
    key: string,
    parseItem: (value: unknown) => T | null,
  ): ((data: unknown) => T[]) => {
    return (data: unknown): T[] => {
      if (typeof data !== 'object' || data === null) return [];
      const list = (data as Record<string, unknown>)[key];
      if (!Array.isArray(list)) return [];
      return list.flatMap((entry) => {
        const parsed = parseItem(entry);
        return parsed === null ? [] : [parsed];
      });
    };
  };

  /**
   * 会话行解析：兼容两种外壳。
   *
   * PSB 的 Cindy 入口（`/api/cindy/remote/sessions…`）回答的是**单条会话行** `{ data: <row> }`
   * （见 PSB 仓 `packages/shared/src/cindy-remote.ts` 的 `CindyRemoteAgentSessionRow`），
   * 不夹带工作区。早期契约草稿写的是 `{ session, workspace }`，所以这里两种都认：
   * 先取 `data.session ?? data`，工作区统一按 `session.workspaceId` 从列表补（见
   * `requireWorkspaceById`）——**不要**让渲染层去处理"有时有工作区、有时没有"。
   */
  function parseSessionRow(data: unknown): PsbRemoteSession | null {
    if (typeof data !== 'object' || data === null) return null;
    const row = data as Record<string, unknown>;
    return parsePsbRemoteSession(row['session'] ?? row);
  }

  /**
   * 会话所属工作区：PSB 没有「读单个工作区」路由（只有列表），所以从列表里按 id 取。
   *
   * `unusableReason` / 占用是**列表的视角**，与创建/读会话时同一时刻的数据可能差几十毫秒；
   * 这一点可以接受（渲染层本来也在轮询），不允许的是"拿不到工作区就静默返回半个结果"。
   */
  async function requireWorkspaceById(
    workspaceId: string,
    label: string,
  ): Promise<PsbRemoteWorkspace> {
    const list = await call('list-workspaces-for-session', PSB_CINDY_ROUTES.workspaces, {
      parse: readArray('workspaces', parsePsbRemoteWorkspace),
    });
    const found = list.find((item) => item.id === workspaceId);
    if (!found) {
      deps.logger.warn('psb session references a workspace that is not in the visible list', {
        label,
        workspaceId,
      });
      throw new PsbClientError(
        {
          code: 'PSB_PROTOCOL',
          messageKey: 'remoteWorkspace.error.notFound',
          message: `workspace ${workspaceId} is not visible`,
        },
        null,
      );
    }
    return found;
  }

  return {
    async listWorkspaces(input) {
      const params = new URLSearchParams();
      if (input?.clientId) params.set('clientId', input.clientId);
      if (input?.readyOnly === true) params.set('readyOnly', '1');
      const query = params.toString();
      const path = query.length > 0
        ? `${PSB_CINDY_ROUTES.workspaces}?${query}`
        : PSB_CINDY_ROUTES.workspaces;
      return (await call('list-workspaces', path, {
        parse: readArray('workspaces', parsePsbRemoteWorkspace),
      })) as unknown as PsbRemoteWorkspace[];
    },
    async listClients() {
      return (await call('list-clients', PSB_CINDY_ROUTES.clients, {
        parse: readArray('clients', parsePsbRemoteClient),
      })) as unknown as PsbRemoteClient[];
    },
    async listProjectTemplates() {
      return (await call('list-templates', PSB_CINDY_ROUTES.projectTemplates, {
        parse: readArray('templates', parsePsbProjectTemplate),
      })) as unknown as PsbProjectTemplate[];
    },
    async createWorkspace(input) {
      return call('create-workspace', PSB_CINDY_ROUTES.workspaces, {
        method: 'POST',
        body: input,
        parse: (data) => {
          if (typeof data !== 'object' || data === null) return null;
          return parsePsbRemoteWorkspace((data as Record<string, unknown>)['workspace']);
        },
      });
    },
    async getWorkspace(workspaceId) {
      return call('get-workspace', PSB_CINDY_ROUTES.workspace(workspaceId), {
        parse: (data) => {
          if (typeof data !== 'object' || data === null) return null;
          const row = data as Record<string, unknown>;
          return parsePsbRemoteWorkspace(row['workspace'] ?? row);
        },
      });
    },
    async occupyWorkspace(workspaceId) {
      return call('occupy-workspace', PSB_CINDY_ROUTES.occupy(workspaceId), {
        method: 'POST',
        parse: parseWorkspaceOperation,
      });
    },
    async releaseWorkspace(workspaceId) {
      return call('release-workspace', PSB_CINDY_ROUTES.occupy(workspaceId), {
        method: 'DELETE',
        parse: parseWorkspaceOperation,
      });
    },
    async runRemoteAction(input) {
      assertRemoteAction(input);
      const result = (await call<{ value: unknown }>('workspace-vcs-action', input.path, {
        method: input.method,
        ...(input.body === undefined ? {} : { body: input.body }),
        allowEmptyResult: true,
        parse: (data) => ({ value: data }),
      })) as { value: unknown } | undefined;
      return result === undefined ? null : result.value;
    },
    async listSessions(workspaceId) {
      return (await call('list-sessions', PSB_CINDY_ROUTES.sessions(workspaceId), {
        parse: readArray('sessions', parsePsbRemoteSession),
      })) as unknown as PsbRemoteSession[];
    },
    async createSession(input) {
      const session = await call('create-session', PSB_CINDY_ROUTES.sessions(input.workspaceId), {
        method: 'POST',
        body: {
          agentKind: input.agentKind satisfies PsbAgentKind,
          ...(input.title === undefined ? {} : { title: input.title }),
          clientRequestId: input.clientRequestId,
          // 省略 = `agent`（用户任务）。只有过渡兜底的内部串流会话传 `internal`：PSB 默认
          // 不把它列进会话列表、不增加 `sessionCount`。其它值 PSB 会 400，所以这里不做猜测。
          ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        },
        parse: parseSessionRow,
      });
      const workspace = await requireWorkspaceById(session.workspaceId, 'create-session');
      return { session, workspace };
    },
    async subscribeWorkspaceStream(workspaceId) {
      // 工作区级服务接口：解析当前 running 桌面访问会话，返回 `{ sessionId, streamPath?, … }`。
      // 不传订阅参数（`subscriberId` 由观看端实例自己稳定生成并拼到 WS URL，见 `streamViewer`；
      // `errors=frame` 等参数本轮不加，保持与旧版逐字节一致）。
      //
      // `mapNoRunningSession`：没有 running 访问会话是 PSB 这里唯一的 409 形状（details.code
      // ='NO_RUNNING_SESSION' + details.state），要解析成可行动失败，而不是落回「操作失败」。
      return call(
        'stream-subscribe',
        PSB_CINDY_ROUTES.streamSubscribe(workspaceId),
        {
          method: 'POST',
          mapNoRunningSession: true,
          parse: (data) => parsePsbWorkspaceStreamSubscription(data),
        },
      );
    },
    /**
     * 尽力拉起桌面访问（幂等 ensure + 轮询到 running）。**永不抛异常**。
     *
     * 顺序刻意固定：先 POST 通用网页接口（PSB 侧网页链同一条），200/202 视为受理，然后轮询
     * Cindy 命名空间的 `GET …/access`。403/404/405（Cindy 白名单未放行 / 旧 PSB）→ 非致命
     * `cindy-entry-not-open`；轮询预算用尽 → `timeout`；其它 → `failed`。
     *
     * 这里**不**做失败缓存 / 熔断：它只在用户点「启动」且需要重新订阅时调用一次，频率与人工
     * 点击同阶，删掉复杂度比省一次 403 更值。
     */
    async ensureWorkspaceAccess(workspaceId) {
      const pollAttempts = Math.max(1, deps.accessPoll?.attempts ?? PSB_ACCESS_POLL_DEFAULT.attempts);
      const pollIntervalMs = Math.max(
        0,
        deps.accessPoll?.intervalMs ?? PSB_ACCESS_POLL_DEFAULT.intervalMs,
      );
      const startPath =
        deps.workspaceAccessStartPath?.(workspaceId) ??
        PSB_WEB_ROUTES.workspaceAccessStart(workspaceId);

      let startedState: PsbWorkspaceAccessState | null = null;
      try {
        const accepted = await call<{ state: PsbWorkspaceAccessState | null }>(
          'workspace-access-start',
          startPath,
          {
            method: 'POST',
            allowEmptyResult: true,
            allowMissingDataEnvelope: true,
            parse: (data) => ({ state: readWorkspaceAccessState(data) }),
          },
        );
        startedState = accepted?.state ?? null;
      } catch (error) {
        const unavailable = isAccessEnsureRouteUnavailable(error);
        deps.logger.info('psb workspace access ensure is not available; continuing without it', {
          workspaceId,
          unavailable,
          code: error instanceof PsbClientError ? error.failure.code : 'UNKNOWN',
          status: error instanceof PsbClientError ? error.status : null,
        });
        return {
          ok: false,
          reason: unavailable ? 'cindy-entry-not-open' : 'failed',
          failure: error instanceof PsbClientError ? error.failure : null,
        };
      }

      if (startedState === 'running') {
        return { ok: true, state: 'running', startedByThisCall: false };
      }
      if (
        startedState === 'none' ||
        startedState === 'stopped' ||
        startedState === 'failed'
      ) {
        // 幂等 ensure 回答「没有 running 也没有在启动」：PSB 的网页链可能要求人的确认，Cindy
        // 不在这里反复重试。继续走 subscribe，让它的 409 给用户可行动文案。
        deps.logger.info('psb workspace access ensure did not start the access', {
          workspaceId,
          state: startedState,
        });
        return { ok: false, reason: 'failed', failure: null };
      }

      for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
        if (attempt > 0 && pollIntervalMs > 0) await waitForAccessPoll(pollIntervalMs);
        let state: PsbWorkspaceAccessState | null;
        try {
          const read = await call<{ state: PsbWorkspaceAccessState | null }>(
            'workspace-access-status',
            PSB_CINDY_ROUTES.workspaceAccess(workspaceId),
            {
              allowMissingDataEnvelope: true,
              parse: (data) => ({ state: readWorkspaceAccessState(data) }),
            },
          );
          state = read?.state ?? null;
        } catch (error) {
          const unavailable = isAccessEnsureRouteUnavailable(error);
          deps.logger.info('psb workspace access status is not readable; continuing without it', {
            workspaceId,
            unavailable,
            code: error instanceof PsbClientError ? error.failure.code : 'UNKNOWN',
            status: error instanceof PsbClientError ? error.status : null,
          });
          return {
            ok: false,
            reason: unavailable ? 'cindy-entry-not-open' : 'failed',
            failure: error instanceof PsbClientError ? error.failure : null,
          };
        }
        if (state === 'running') {
          return { ok: true, state: 'running', startedByThisCall: true };
        }
        if (state === 'none' || state === 'stopped' || state === 'failed') break;
      }

      deps.logger.info('psb workspace access did not reach running within the poll budget', {
        workspaceId,
        attempts: pollAttempts,
        lastState: startedState,
      });
      return { ok: false, reason: 'timeout', failure: null };
    },
    async getSession(sessionId) {
      const session = await call('get-session', PSB_CINDY_ROUTES.session(sessionId), {
        parse: parseSessionRow,
      });
      const workspace = await requireWorkspaceById(session.workspaceId, 'get-session');
      return { session, workspace };
    },
    async stopSession(sessionId) {
      await call('stop-session', PSB_CINDY_ROUTES.session(sessionId), {
        method: 'DELETE',
        allowEmptyResult: true,
        parse: (data) => (data ?? {}),
      });
    },
    async getStreamStatus(sessionId) {
      return call('stream-status', PSB_CINDY_ROUTES.streamStatus(sessionId), {
        parse: (data) => parsePsbSessionStreamStatus(data),
      });
    },
  };
}

/** 交给渲染层的失败形状（IPC 错误里只出现在 `message` 与 payload，不抛异常对象本身）。 */
export function toPsbRemoteFailure(error: unknown): PsbRemoteFailure {
  if (error instanceof PsbClientError) return error.failure;
  return {
    code: 'PSB_UNKNOWN',
    messageKey: 'remoteWorkspace.error.unknown',
    message: error instanceof Error ? error.message : String(error),
  };
}

/* ============================== 工作区网页地址 ============================== */

/**
 * 「在网页打开」要用的工作区网页地址；**列表口优先**，单行口只作兜底。
 *
 * ## 为什么不能先读单行（2026-11-26 真机事故）
 *
 * PSB 的 Cindy 命名空间**只承诺列表路由**（PSB 仓 `协作需求.md` §4；他们文档也写明没有
 * 「读单个工作区」路由）。Cindy JWT 白名单里同样没有放行单行 GET，于是 `GET /workspaces/:id`
 * 恒返回 **403**（PSB 侧 `app.ts` 的 Cindy 白名单 → `这个 Cindy 身份不能访问该接口`）。
 * 旧实现把 404/405 当「单行路由不存在」兜底到列表、却把 403 当真实失败抛出，结果用户点
 * 「在网页打开」只看到一句误导的「找不到/操作失败」——**而列表里明明带着完整 `webUrl`**。
 *
 * 所以顺序固定为：**列表快照 → 单行兜底（旧服务端也许实现过）→ `null`**。
 *
 * ## 失败口径（不静默、也不误报）
 *
 * - 列表**鉴权 / 组织 / 网络**失败 → 原样抛：用户要看到真实原因（未登录、非企业组织、连不上），
 *   不能换成「找不到工作区」；
 * - 列表里没有这个工作区 → 再试单行；单行 **403 / 404 / 405** 都表示「单行路由不可用或工作区
 *   不可见」→ 返回 `null`，由调用方给「找不到工作区」的可行动错误；
 * - 其它失败（协议错等）→ 原样抛，交给上层当契约违约处理。
 */
export async function readWorkspaceWebUrl(
  api: PsbApi,
  workspaceId: string,
): Promise<string | null> {
  // ── 1) 列表口优先：这是 Cindy 命名空间**唯一承诺**的工作区读口 ──
  try {
    const workspaces = await api.listWorkspaces();
    const found = workspaces.find((entry) => entry.id === workspaceId);
    if (found) return found.webUrl ?? null;
  } catch (error) {
    if (isUserActionablePsbFailure(error)) throw error;
    // 列表读不了（协议错等）：单行口也许还能答，别在这里把整件事判死。
  }

  // ── 2) 单行 GET 兜底；403 与 404/405 同义（Cindy 白名单不放行这条路由） ──
  try {
    const workspace = await api.getWorkspace(workspaceId);
    return workspace.webUrl ?? null;
  } catch (error) {
    if (isSingleWorkspaceRouteUnavailable(error)) return null;
    throw error;
  }
}

/** 鉴权 / 组织 / 网络失败：这些必须让用户看到真实原因，不能兜底成「找不到工作区」。 */
function isUserActionablePsbFailure(error: unknown): boolean {
  if (!(error instanceof PsbClientError)) return false;
  switch (error.failure.code) {
    case 'AUTH_REQUIRED':
    case 'AUTH_INVALID':
    case 'AUTH_EXPIRED':
    case 'IDENTITY_NOT_LINKED':
    case 'PSB_UNREACHABLE':
      return true;
    default:
      return false;
  }
}

/**
 * 单行工作区路由「不可用」的形态：403 = Cindy 白名单不放行（真机事实）、404/405 = 路由不存在
 * 或工作区不可见。三种都按「这条读口没有答案」处理，不当作需要展示给用户的失败。
 */
function isSingleWorkspaceRouteUnavailable(error: unknown): boolean {
  if (!(error instanceof PsbClientError)) return false;
  if (error.status === 403 || error.status === 404 || error.status === 405) return true;
  return error.failure.code === 'NOT_FOUND' || error.failure.code === 'FORBIDDEN';
}

/** 隧道/串流 WS 地址（供 main 侧隧道与串流观看端使用，避免两处各拼一次）。 */
export function psbAgentTunnelPath(sessionId: string): string {
  return PSB_CINDY_WS.agentTunnel(sessionId);
}

export function psbStreamPath(sessionId: string): string {
  return PSB_CINDY_WS.stream(sessionId);
}
