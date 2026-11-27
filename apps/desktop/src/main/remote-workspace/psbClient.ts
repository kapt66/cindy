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
  PsbWorkspaceAccessStartResult,
  PsbWorkspaceAccessState,
  PsbWorkspaceStreamSubscription,
  PsbFailureFields,
} from '../../shared/psb-remote-workspace.js';
import {
  PSB_CINDY_API_PREFIX,
  PSB_CINDY_WS,
  PSB_CINDY_ROUTES,
  PSB_CINDY_FAILURE_CODES,
  PSB_ERROR_CODES,
  PSB_FAILURE_DESCRIPTORS,
  PSB_FAILURE_UNKNOWN_MESSAGE_KEY,
  PSB_LOCAL_DIAGNOSTIC_CODES,
  PSB_NO_RUNNING_SESSION_CODE,
  isPsbWorkspaceAccessState,
  parsePsbProjectTemplate,
  parsePsbRemoteClient,
  parsePsbRemoteSession,
  parsePsbRemoteWorkspace,
  parsePsbSessionStreamStatus,
  parsePsbWorkspaceAccessStartResult,
  parsePsbWorkspaceStreamSubscription,
  psbFailureMessageKeyForPsbCode,
  psbNoRunningSessionIpcCode,
  psbNoRunningSessionMessageKey,
  readPsbFailureFields,
  readPsbWorkspaceAccessState,
  resolvePsbFailureCode,
} from '../../shared/psb-remote-workspace.js';
import { parseWorkspaceVcsNotice, readAdvisoryWorkspaceVcs } from '../../shared/psb-workspace-vcs.js';
import type { WorkspaceVcsNotice } from '../../shared/psb-workspace-vcs.js';
import { createIpcError } from '../../shared/ipc-errors.js';
import { getPsbConnectionToken, invalidatePsbConnectionToken, psbAuthFailure } from './psbAuth.js';
import type { PsbConnectionTokenPort } from './psbAuth.js';
import { PsbUrlRejectedError, resolvePsbUrl } from './psbEndpoint.js';

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
   * `ensureWorkspaceAccess` 轮询 `GET …/access` 到 `running` 的预算（CINDY-RW-17）。
   *
   * **总预算是 deadline 语义**（`totalMs`），不是「次数 × 单次超时」：每次请求的超时会被压到
   * 「剩余预算」以内，所以最坏等待时间恒为 `totalMs`。生产默认
   * {@link PSB_ACCESS_POLL_DEFAULT}（90s，覆盖 Unity / 虚拟桌面的冷启动）；单测注入
   * `intervalMs: 0` 与短 `totalMs` 避免真实等待（测试卫生要求不做 ≥100ms 真实等待）。
   */
  accessPoll?: { attempts?: number; intervalMs?: number; totalMs?: number };
}

/** 失败：`failure.messageKey` 是 i18n 键，`failure.message` 是 PSB 原文（兜底显示，不含凭据）。 */
export class PsbClientError extends Error {
  constructor(readonly failure: PsbRemoteFailure, readonly status: number | null) {
    // `message` 允许为 null（例如只给 i18n 键的失败）；Error.message 需要字符串，空串即"没有可读原文"。
    super(failure.message ?? '');
    this.name = 'PsbClientError';
  }
}

/**
 * 把 PSB 原始错误码翻成本地化文案键（§4b 失败单表的投影；客户端不手写 switch / 字面键）。
 *
 * 未知码落到通用文案，但原始码仍留在 `failure.code`（诊断用）。
 */
export function psbMessageKeyForErrorCode(code: string): string {
  return psbFailureMessageKeyForPsbCode(code) ?? PSB_FAILURE_UNKNOWN_MESSAGE_KEY;
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
  // CINDY-RW-17：业务码可能只出现在 `details.code`（外层是泛化的 FORBIDDEN / CONFLICT）。
  // 提升判据在共享契约（命中失败单表才算），两边只读这一份。
  const code = resolvePsbFailureCode(input) ?? input.code;
  const occupiedName = readOccupiedByName(input.details);
  const messageKey = psbMessageKeyForErrorCode(code);
  const vcs = readWorkspaceVcsNotice(input.details);
  return {
    code,
    messageKey,
    // 占用失败的 `message` **只放占用人名**（拿不到就空串）：IPC 只能跨进程带 code+message，
    // 渲染层据此回填 `{{name}}`；混进 PSB 的中文原文会让「人名」变成一整句话。
    //
    // 版本控制检查失败相反：`details.vcs.messageZh` 才是给用户看的事实（「工作区有未提交
    // 修改：2 个检出」），PSB 的 `error.message` 常常是空的，所以这里用它兜底。
    // 其它可行动失败（如 WORKSPACE_NOT_OCCUPIED / TOO_MANY_TUNNELS）的 `error.message` 是
    // PSB 的可读中文原话，保留为兜底 / 诊断行。
    message:
      messageKey === PSB_FAILURE_DESCRIPTORS.PSB_WORKSPACE_OCCUPIED_BY_OTHER.messageKey
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
    code: PSB_FAILURE_DESCRIPTORS.PSB_UNREACHABLE.psbCode,
    messageKey: PSB_FAILURE_DESCRIPTORS.PSB_UNREACHABLE.messageKey,
    message: detail,
  };
}

/** 处置动作允许的方法（与共享契约 `WORKSPACE_VCS_ACTION_METHODS` 同口径；这里独立兜底）。 */
const REMOTE_ACTION_METHODS: readonly string[] = ['GET', 'POST', 'DELETE'];

/**
 * 服务端给的 action 路径在**发请求前**的本地校验（第二道，第一道在 `vcsNotice.ts`）。
 *
 * 只允许 Cindy 命名空间的相对路径：绝对 URL / 协议 / 反斜杠 / `..` / `#` / 控制字符全部拒绝，
 * 且**按 URL 归一化后的结果**判定（`%2e%2e` 会被 URL 解析器当作 `..`，只查字面 `..` 会漏）。
 * 这条判断必须与 workspaceId 无关地生效——即使上层漏了工作区绑定校验，也不能被指去任意主机。
 */
export function isAllowedPsbRemoteActionPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 2_048) return false;
  if (!path.startsWith(`${PSB_CINDY_API_PREFIX}/`)) return false;
  // 归一化判据唯一来源：`resolvePsbUrl`（origin / 归一化 pathname / 命名空间三道）。
  try {
    resolvePsbUrl(path);
    return true;
  } catch {
    return false;
  }
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

/**
 * 从失败外壳取 `code` / `message` / `details`：**唯一实现在共享契约**
 * （`readPsbFailureFields`，`streamViewer` 的 WS 升级失败也用它）。
 *
 * 两种外壳都是 PSB 侧真实存在过的形状（Cindy 入口统一 `{error}`；0.1.180 的 access 路由
 * 在网页命名空间上见过平铺），所以两种都读——但**只读这两种**，不递归猜。
 */
function readFailureFields(envelope: ResponseEnvelope | null): PsbFailureFields {
  return readPsbFailureFields(envelope);
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
  /**
   * 新建会话。返回里的 `workspace` 是**创建前读到的**那一行：读工作区失败会发生在创建之前，
   * 绝不会「会话建好了却拿不到工作区，于是把 sessionId 丢掉」（见实现注释）。
   */
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
   * 选文案与是否重试（见 `readNoRunningSessionFailure`）。**不要**在这里自动拉访问：CINDY-RW-17
   * 起拉起访问是启动串流的**必经步骤**，由调用方先调 `ensureWorkspaceAccess`（失败带码）。
   */
  subscribeWorkspaceStream(workspaceId: string): Promise<PsbWorkspaceStreamSubscription>;
  /**
   * **幂等 ensure** 该工作区的桌面访问（CINDY-RW-17，PSB 0.1.183）。
   *
   * `POST /api/cindy/remote/workspaces/:id/access/start`：工作区空闲未占用 → 403
   * `WORKSPACE_NOT_OCCUPIED`（用户确认占用后重试）；被他人占用 → 409
   * `WORKSPACE_OCCUPIED_BY_OTHER`；成功 202（开始启动）/ 200（已在 starting 或 running，
   * `attached:true`）。解析见 {@link PsbWorkspaceAccessStartResult}。
   */
  startWorkspaceAccess(workspaceId: string): Promise<PsbWorkspaceAccessStartResult>;
  /**
   * 读该工作区桌面访问的当前状态（`GET …/access` 的 `data.access.state`）。
   *
   * `null` = PSB 没给 / 给了 Cindy 不认识的词（不猜成某个已知状态）。
   */
  readWorkspaceAccess(workspaceId: string): Promise<PsbWorkspaceAccessState | null>;
  /**
   * **网页同款状态机**确保桌面访问到 `running`：读 access → 终态（none/stopped/failed）
   * 才 `POST access/start` → 轮询 `GET access` 到 running。
   *
   * - `running` → 直接返回，**不 POST**；
   * - `starting` → 只轮询（不重复 POST，重复 POST 在 PSB 是幂等 attach，但没必要）；
   * - `stopping` → 先等它落定，再 POST start，再轮询；
   * - `none` / `stopped` / `failed` / 未知词 → POST start（幂等）→ 轮询到 running。
   *
   * ## fatal 语义（调用方决定是否致命）
   *
   * 本函数**不抛异常**，把失败收敛成可行动的失败码：403 `WORKSPACE_NOT_OCCUPIED` →
   * `reason:'not-occupied'`；409 `WORKSPACE_OCCUPIED_BY_OTHER` → `reason:'occupied-by-other'`；
   * 404/405/`UNIMPLEMENTED`（旧 PSB）→ `reason:'unsupported'`（调用方退回直接订阅）；
   * 预算用尽 → `reason:'timeout'`（`failure` 带 `PSB_STREAM_ACCESS_STARTING` 等可行动码）。
   * 调用方（`adminService.streamStart`）在启动串流这条路径上把它当**闸门**：除 `unsupported`
   * 外一律带码抛出。
   *
   * 轮询预算默认 {@link PSB_ACCESS_POLL_DEFAULT}（90s，覆盖 Unity / 虚拟桌面冷启动），
   * 单次请求超时被压到剩余预算内（总预算 = deadline）。
   */
  ensureWorkspaceAccess(workspaceId: string): Promise<PsbWorkspaceAccessEnsureOutcome>;
  stopSession(sessionId: string): Promise<void>;
  getStreamStatus(sessionId: string): Promise<PsbSessionStreamStatus>;
}

/**
 * `ensureWorkspaceAccess` 失败时的可归因分类（**调用方决定是否致命**）。
 *
 * - `unsupported`：旧 PSB 没有这条路由（404/405/`UNIMPLEMENTED`）→ **不致命**，退回直接订阅
 *   （订阅的 409 会给出可行动文案）；
 * - `not-occupied`：工作区空闲未占用（403 `WORKSPACE_NOT_OCCUPIED`）→ 由用户确认占用后重试；
 * - `occupied-by-other`：被他人占用（409）→ 等待 / 换工作区；
 * - `timeout`：预算内没到 `running`（`failure` 带按最后观察状态的 wait 文案码）；
 * - `failed`：其它业务 / 网络 / 协议失败（`failure` 为可归因形状或本地诊断码）。
 */
export type PsbWorkspaceAccessEnsureReason =
  | 'unsupported'
  | 'not-occupied'
  | 'occupied-by-other'
  | 'timeout'
  | 'failed';

export type PsbWorkspaceAccessEnsureOutcome =
  | {
      readonly ok: true;
      readonly state: 'running';
      /** `true` = 是这次调用把它从非 running 拉到 running（发出了 start 或等待它落定）。 */
      readonly startedByThisCall: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: PsbWorkspaceAccessEnsureReason;
      /** `unsupported` 时为 `null`；其余原因带可归因失败（跨 IPC 前由调用方 `PsbClientError` 抛出）。 */
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
 * `ensureWorkspaceAccess` 的**总预算**（生产默认，CINDY-RW-17）。
 *
 * `totalMs` 是硬 deadline：无论轮询次数与单次请求超时怎么配，整条「启动访问」最多占用这么久。
 * 90s 覆盖 Unity / 虚拟桌面的冷启动（旧值 5s 在真机上几乎必然超时，那时它还只是可选增强）；
 * `attempts` / `intervalMs` 只是节奏上限（短预算时提前结束）。
 */
export const PSB_ACCESS_POLL_DEFAULT = {
  attempts: 180,
  intervalMs: 500,
  totalMs: 90_000,
} as const;

/**
 * 「拉起访问」失败的归因：哪些算「旧 PSB 没有这条路由」（非致命、退回直接订阅）。
 *
 * 只有 404 / 405 与它们的等价业务码。**403 不再算**：CINDY-RW-17 起 Cindy Bearer 已放行，
 * 403 是 PSB 的业务守卫（`WORKSPACE_NOT_OCCUPIED`）或真实鉴权失败，必须原样交给上层。
 */
function isAccessEnsureRouteUnavailable(error: unknown): boolean {
  if (!(error instanceof PsbClientError)) return false;
  if (error.status === 404 || error.status === 405) return true;
  switch (error.failure.code) {
    case PSB_ERROR_CODES.notFound:
    case 'UNSUPPORTED':
    case 'NOT_IMPLEMENTED':
    case 'ROUTE_NOT_FOUND':
    case 'HTTP_404':
    case 'HTTP_405':
      return true;
    default:
      return false;
  }
}

/** 预算用尽 / access 落回非 running 时的可行动失败（复用「没有 running 访问」三档单表）。 */
function accessStateFailure(state: PsbWorkspaceAccessState | null): PsbRemoteFailure {
  return {
    code: psbNoRunningSessionIpcCode(state),
    messageKey: psbNoRunningSessionMessageKey(state),
    message: null,
    streamAccessState: state,
  };
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
    init: {
      method: string;
      body?: unknown;
      token: string;
      timeoutMs?: number;
    },
  ): Promise<{ response: Response; text: string }> {
    // URL 解析与越界判定只走 `resolvePsbUrl`（origin / 归一化 pathname / 命名空间三道）：
    // 外部下发的路径（VCS actions）不能靠字符串白名单拦，归一化会把 `%2e%2e` 变成 `..`。
    let url: string;
    try {
      url = resolvePsbUrl(path);
    } catch (error) {
      if (error instanceof PsbUrlRejectedError) {
        deps.logger.warn('psb request path was rejected before sending', {
          label: init.method,
          reason: error.reason,
        });
        throw new PsbClientError(
          {
            code: PSB_LOCAL_DIAGNOSTIC_CODES.protocol,
            messageKey: PSB_FAILURE_UNKNOWN_MESSAGE_KEY,
            message: `rejected PSB path (${error.reason})`,
          },
          null,
        );
      }
      throw error;
    }
    const budgetMs = Math.max(1, init.timeoutMs ?? timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    timer.unref?.();
    try {
      const response = await deps.fetch(url, {
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
      /** 订阅串流专用：把 409「没有 running 桌面访问」解析成结构化失败（见 `call` 的调用点）。 */
      mapNoRunningSession?: boolean;
      /**
       * 本次请求的超时上限（毫秒）。生产只有「拉起桌面访问」的轮询会传：它必须服从一个
       * **总预算**，不能让每次请求各自吃满 20s（见 `ensureWorkspaceAccess`）。
       */
      timeoutMs?: number;
    },
  ): Promise<T> {
    const method = options.method ?? 'GET';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const auth = await getPsbConnectionToken(deps);
      if (!auth.ok) {
        // 取 token 失败的归因只有一份（`psbAuthFailure`）：未登录 / 非企业组织 → AUTH_REQUIRED，
        // 签发通道抖动 → PSB_UNREACHABLE。**不失效缓存**（见 psbAuth 的说明）。
        throw new PsbClientError(psbAuthFailure(auth), null);
      }
      let outcome: { response: Response; text: string };
      try {
        outcome = await requestOnce(path, {
          method,
          ...(options.body === undefined ? {} : { body: options.body }),
          token: auth.token,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
      } catch (error) {
        // 已经是可归因失败（例如 URL 越界被判协议违约）：原样上抛，不再包成网络失败。
        if (error instanceof PsbClientError) throw error;
        if (error instanceof PsbResponseTooLargeError) {
          // 超限不是网络失败：用户查网络没有意义，按契约违约归因，也不重试。
          deps.logger.warn('psb response exceeded the size limit', {
            label,
            bytes: error.bytes,
            limit: PSB_HTTP_MAX_RESPONSE_BYTES,
          });
          throw new PsbClientError(
            {
              code: PSB_LOCAL_DIAGNOSTIC_CODES.protocol,
              messageKey: PSB_FAILURE_UNKNOWN_MESSAGE_KEY,
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
          fields.code ?? (status === 401 ? PSB_ERROR_CODES.authRequired : PSB_ERROR_CODES.forbidden);
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
      if (envelope === null || !('data' in envelope)) {
        deps.logger.warn('psb response is missing the data envelope', { label, status });
        throw new PsbClientError(
          {
            code: PSB_LOCAL_DIAGNOSTIC_CODES.protocol,
            messageKey: PSB_FAILURE_UNKNOWN_MESSAGE_KEY,
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
            code: PSB_LOCAL_DIAGNOSTIC_CODES.protocol,
            messageKey: PSB_FAILURE_UNKNOWN_MESSAGE_KEY,
            message: `unexpected payload from ${label}`,
          },
          status,
        );
      }
      return parsed;
    }
    // 循环只有两轮且第二轮不会 continue；走到这里说明重签后仍被判 401 却没有抛错，属实现错误。
    throw new PsbClientError(
      {
        code: PSB_LOCAL_DIAGNOSTIC_CODES.authLoop,
        messageKey: PSB_FAILURE_DESCRIPTORS.PSB_AUTH_REQUIRED.messageKey,
        message: null,
      },
      401,
    );
  }

  /**
   * 列表外壳解析：`{ data: { <key>: [...] } }`。
   *
   * **返回 `null` = 协议错**（外壳 / 键不是数组），由 `call` 统一抛 `PSB_PROTOCOL`：旧实现把
   * 缺键 / 畸形外壳静默变成 `[]`，界面显示「没有工作区」，而真实原因是服务端契约违约——
   * 这正是 2026-11-26 联调里「列表永远空」类问题的温床。单行格式不对（缺 id）仍按行丢弃，
   * 但会记一条 warn（行级容错与整表契约违约是两类事实）。
   */
  const readArray = <T,>(
    key: string,
    parseItem: (value: unknown) => T | null,
  ): ((data: unknown) => T[] | null) => {
    return (data: unknown): T[] | null => {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
      const list = (data as Record<string, unknown>)[key];
      if (!Array.isArray(list)) return null;
      const parsed: T[] = [];
      let dropped = 0;
      for (const entry of list) {
        const item = parseItem(entry);
        if (item === null) dropped += 1;
        else parsed.push(item);
      }
      if (dropped > 0) {
        deps.logger.warn('psb list contained rows that could not be parsed', {
          key,
          dropped,
          total: list.length,
        });
      }
      return parsed;
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
   * **真实请求数 = 1 次列表 HTTP**（调用方自己的会话请求另算）：`getSession` 实际是
   * 2 次请求（会话行 + 工作区列表），`createSession` 是 2 次（工作区列表 + 建会话，见该方法）。
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
          code: PSB_LOCAL_DIAGNOSTIC_CODES.protocol,
          messageKey: PSB_FAILURE_DESCRIPTORS.PSB_NOT_FOUND.messageKey,
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
      return call('list-workspaces', path, {
        parse: readArray('workspaces', parsePsbRemoteWorkspace),
      });
    },
    async listClients() {
      return call('list-clients', PSB_CINDY_ROUTES.clients, {
        parse: readArray('clients', parsePsbRemoteClient),
      });
    },
    async listProjectTemplates() {
      return call('list-templates', PSB_CINDY_ROUTES.projectTemplates, {
        parse: readArray('templates', parsePsbProjectTemplate),
      });
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
      return call('list-sessions', PSB_CINDY_ROUTES.sessions(workspaceId), {
        parse: readArray('sessions', parsePsbRemoteSession),
      });
    },
    /**
     * 新建会话。
     *
     * **先读工作区快照、再建会话**：PSB 的会话响应只有单行（不带工作区），而工作区行是
     * createSession 返回值的一部分。旧实现「先建、后补列表」在列表请求失败时会把**已经建好
     * 的 PSB 会话丢掉**（抛错 → 调用方认为没建成 → 远端留下一条没人认领的会话，本地也不落
     * `remoteHostId`）。现在查询失败发生在创建**之前**：读不到工作区就一个请求都不发；
     * 读到了就带着快照建，创建失败照常抛（不产生任何本地副作用）。
     *
     * 请求数：新建会话固定 2 次 HTTP（列表 + 创建）。会话创建是用户点一次的动作，不是热路径；
     * 用一次额外读换「绝不产生孤儿会话」是划算的。
     */
    async createSession(input) {
      const workspace = await requireWorkspaceById(input.workspaceId, 'create-session-preflight');
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
      if (session.workspaceId !== workspace.id) {
        // 服务端把会话建到了别的工作区：契约违约，但会话已经存在——不能在这里抛错把它变成
        // 「没建成」（否则又回到「丢 sessionId」）。保留创建前读到的工作区行并留诊断。
        deps.logger.warn('psb returned a session for a workspace other than requested', {
          requestedWorkspaceId: workspace.id,
          sessionWorkspaceId: session.workspaceId,
          sessionId: session.id,
        });
      }
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
    async startWorkspaceAccess(workspaceId) {
      // CINDY-RW-17 幂等 ensure 的写入口（Cindy 命名空间，Bearer 已放行）。
      // 202 = 开始启动；200 = 已 starting / running（`attached:true`）。业务失败
      // （403 WORKSPACE_NOT_OCCUPIED / 409 WORKSPACE_OCCUPIED_BY_OTHER）由调用方按可行动失败处理。
      return call('workspace-access-start', PSB_CINDY_ROUTES.accessStart(workspaceId), {
        method: 'POST',
        parse: parsePsbWorkspaceAccessStartResult,
      });
    },
    async readWorkspaceAccess(workspaceId) {
      const read = await call<{ state: PsbWorkspaceAccessState | null }>(
        'workspace-access-status',
        PSB_CINDY_ROUTES.workspaceAccess(workspaceId),
        { parse: (data) => ({ state: readPsbWorkspaceAccessState(data) }) },
      );
      return read.state;
    },
    /**
     * 网页同款「启动访问」状态机（CINDY-RW-17）。**永不抛异常**，失败收敛成可行动结果。
     *
     * 顺序刻意固定（与 Cindy 网页接入口径一致）：
     *   读 `GET …/access` → `running` 直接返回（不 POST）；`starting` 只轮询（不重复 POST）；
     *   `stopping` 等落定再 POST；`none` / `stopped` / `failed` / 未知词 POST `access/start`
     *   （幂等 ensure）→ 轮询到 `running`。
     *
     * 请求数：running / starting 只读；终态 = 1 次 POST + N 次读。所有请求的超时都被压到
     * 「剩余总预算」以内（见 {@link PSB_ACCESS_POLL_DEFAULT}，生产 90s 覆盖 Unity 冷启动）。
     */
    async ensureWorkspaceAccess(workspaceId) {
      const pollAttempts = Math.max(
        1,
        deps.accessPoll?.attempts ?? PSB_ACCESS_POLL_DEFAULT.attempts,
      );
      const pollIntervalMs = Math.max(
        0,
        deps.accessPoll?.intervalMs ?? PSB_ACCESS_POLL_DEFAULT.intervalMs,
      );
      const totalMs = Math.max(1, deps.accessPoll?.totalMs ?? PSB_ACCESS_POLL_DEFAULT.totalMs);
      const deadline = Date.now() + totalMs;
      /** 剩余预算；每次请求的超时都压到它以内，保证整条流程不越过 deadline。 */
      const remainingBudgetMs = (): number => Math.max(1, deadline - Date.now());
      /** 最后一次观察到的状态（预算用尽时据它选「等启动 / 等结束」文案）。 */
      let lastState: PsbWorkspaceAccessState | null = null;

      /** 一次 access 相关请求的结果。 */
      type AccessStep =
        | { readonly kind: 'state'; readonly state: PsbWorkspaceAccessState | null }
        | { readonly kind: 'unsupported' }
        | {
            readonly kind: 'blocked';
            readonly reason: 'not-occupied' | 'occupied-by-other';
            readonly failure: PsbRemoteFailure;
          }
        | { readonly kind: 'error'; readonly failure: PsbRemoteFailure };

      function classify(error: unknown): AccessStep {
        const failure = toPsbRemoteFailure(error);
        const unavailable = isAccessEnsureRouteUnavailable(error);
        deps.logger.info('psb workspace access request failed', {
          workspaceId,
          unavailable,
          code: failure.code,
          status: error instanceof PsbClientError ? error.status : null,
        });
        if (unavailable) return { kind: 'unsupported' };
        // PSB 的守卫契约：空闲未占用 / 被他人占用是两个不同下一步（确认占用 / 等对方释放）。
        if (failure.code === PSB_ERROR_CODES.workspaceNotOccupied) {
          return { kind: 'blocked', reason: 'not-occupied', failure };
        }
        if (failure.code === PSB_ERROR_CODES.occupiedByOther) {
          return { kind: 'blocked', reason: 'occupied-by-other', failure };
        }
        return { kind: 'error', failure };
      }

      /** 非 state 步骤 → 最终结果（state 步骤返回 `null`，由调用方继续状态机）。 */
      function settle(step: AccessStep): PsbWorkspaceAccessEnsureOutcome | null {
        if (step.kind === 'unsupported') return { ok: false, reason: 'unsupported', failure: null };
        if (step.kind === 'blocked') {
          return { ok: false, reason: step.reason, failure: step.failure };
        }
        if (step.kind === 'error') return { ok: false, reason: 'failed', failure: step.failure };
        return null;
      }

      async function readState(): Promise<AccessStep> {
        try {
          const read = await call<{ state: PsbWorkspaceAccessState | null }>(
            'workspace-access-status',
            PSB_CINDY_ROUTES.workspaceAccess(workspaceId),
            {
              timeoutMs: remainingBudgetMs(),
              parse: (data) => ({ state: readPsbWorkspaceAccessState(data) }),
            },
          );
          if (read.state !== null) lastState = read.state;
          return { kind: 'state', state: read.state };
        } catch (error) {
          return classify(error);
        }
      }

      async function startAccess(): Promise<AccessStep> {
        try {
          const result = await call<PsbWorkspaceAccessStartResult>(
            'workspace-access-start',
            PSB_CINDY_ROUTES.accessStart(workspaceId),
            {
              method: 'POST',
              timeoutMs: remainingBudgetMs(),
              parse: parsePsbWorkspaceAccessStartResult,
            },
          );
          const state = result.state ?? result.access?.state ?? null;
          if (state !== null) lastState = state;
          return { kind: 'state', state };
        } catch (error) {
          return classify(error);
        }
      }

      /** 在预算内按节奏等待；返回 `false` = 预算已用尽。 */
      async function sleepWithinBudget(): Promise<boolean> {
        if (Date.now() >= deadline) return false;
        if (pollIntervalMs > 0) {
          await waitForAccessPoll(Math.min(pollIntervalMs, remainingBudgetMs()));
        }
        return Date.now() < deadline;
      }

      /** 轮询到 running；终态 / 超时给可行动失败（不会在终态上继续空转到预算用尽）。 */
      async function pollToRunning(
        startedByThisCall: boolean,
      ): Promise<PsbWorkspaceAccessEnsureOutcome> {
        for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
          if (attempt > 0) {
            if (!(await sleepWithinBudget())) break;
          } else if (Date.now() >= deadline) {
            break;
          }
          const step = await readState();
          const settled = settle(step);
          if (settled) return settled;
          if (step.kind !== 'state') continue;
          if (step.state === 'running') {
            return { ok: true, state: 'running', startedByThisCall };
          }
          if (step.state === 'starting' || step.state === 'stopping' || step.state === null) {
            continue;
          }
          // none / stopped / failed：start 没有生效（访问被回收 / 启动失败），继续等不会变好。
          deps.logger.info('psb workspace access left the running path while polling', {
            workspaceId,
            state: step.state,
          });
          return { ok: false, reason: 'failed', failure: accessStateFailure(step.state) };
        }
        deps.logger.info('psb workspace access did not reach running within the poll budget', {
          workspaceId,
          attempts: pollAttempts,
          lastState,
        });
        return { ok: false, reason: 'timeout', failure: accessStateFailure(lastState) };
      }

      /**
       * 等 `stopping` 落定：running → 直接可用；落定到终态 → `null`（由调用方 POST start）；
       * 预算内没落定 → 可行动「正在结束」失败（不笼统报失败，也不重复 POST）。
       */
      async function waitUntilSettled(): Promise<PsbWorkspaceAccessEnsureOutcome | null> {
        for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
          if (!(await sleepWithinBudget())) break;
          const step = await readState();
          const settled = settle(step);
          if (settled) return settled;
          if (step.kind !== 'state') continue;
          if (step.state === 'stopping' || step.state === null) continue;
          if (step.state === 'running') {
            return { ok: true, state: 'running', startedByThisCall: false };
          }
          return null;
        }
        deps.logger.info('psb workspace access was still stopping when the poll budget ran out', {
          workspaceId,
          lastState,
        });
        return { ok: false, reason: 'timeout', failure: accessStateFailure(lastState ?? 'stopping') };
      }

      // ── 1) 先读 access（Cindy 口径：只有终态才 POST start）──
      const initial = await readState();
      const initialSettled = settle(initial);
      if (initialSettled) return initialSettled;
      if (initial.kind === 'state') {
        if (initial.state === 'running') {
          return { ok: true, state: 'running', startedByThisCall: false };
        }
        if (initial.state === 'starting') return pollToRunning(false);
        if (initial.state === 'stopping') {
          const waited = await waitUntilSettled();
          if (waited) return waited;
        }
      }

      // ── 2) 终态 / 未知状态词：幂等 start，再轮询到 running ──
      const started = await startAccess();
      const startedSettled = settle(started);
      if (startedSettled) return startedSettled;
      const startedState = started.kind === 'state' ? started.state : null;
      if (startedState === 'running') {
        return { ok: true, state: 'running', startedByThisCall: true };
      }
      if (startedState === 'stopping') {
        // start 撞上另一条正在停止的访问（PSB 幂等 ensure 只调用一次，不在这里重试 start）。
        const waited = await waitUntilSettled();
        if (waited) return waited;
      }
      return pollToRunning(true);
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
    code: PSB_LOCAL_DIAGNOSTIC_CODES.unknown,
    messageKey: PSB_FAILURE_UNKNOWN_MESSAGE_KEY,
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
    case PSB_ERROR_CODES.authRequired:
    case PSB_ERROR_CODES.authInvalid:
    case PSB_ERROR_CODES.authExpired:
    case PSB_ERROR_CODES.identityNotLinked:
    case PSB_FAILURE_DESCRIPTORS.PSB_UNREACHABLE.psbCode:
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
  return (
    error.failure.code === PSB_ERROR_CODES.notFound ||
    error.failure.code === PSB_ERROR_CODES.forbidden
  );
}

/** 隧道/串流 WS 地址（供 main 侧隧道与串流观看端使用，避免两处各拼一次）。 */
export function psbAgentTunnelPath(sessionId: string): string {
  return PSB_CINDY_WS.agentTunnel(sessionId);
}

export function psbStreamPath(sessionId: string): string {
  return PSB_CINDY_WS.stream(sessionId);
}
