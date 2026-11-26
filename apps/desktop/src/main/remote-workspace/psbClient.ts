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
} from '../../shared/psb-remote-workspace.js';
import {
  PSB_CINDY_WS,
  PSB_CINDY_ROUTES,
  PSB_ERROR_CODES,
  parsePsbProjectTemplate,
  parsePsbRemoteClient,
  parsePsbRemoteSession,
  parsePsbRemoteWorkspace,
  parsePsbSessionStreamStatus,
} from '../../shared/psb-remote-workspace.js';
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

function psbFailureFromResponse(input: {
  status: number;
  code: string;
  message: string;
  details: unknown;
}): PsbRemoteFailure {
  const occupiedName = readOccupiedByName(input.details);
  const messageKey = psbMessageKeyForErrorCode(input.code);
  return {
    code: input.code,
    messageKey,
    // 占用失败的 `message` **只放占用人名**（拿不到就空串）：IPC 只能跨进程带 code+message，
    // 渲染层据此回填 `{{name}}`；混进 PSB 的中文原文会让「人名」变成一整句话。
    message:
      messageKey === 'remoteWorkspace.error.occupiedByOther'
        ? (occupiedName ?? '')
        : input.message,
  };
}

function unreachableFailure(detail: string): PsbRemoteFailure {
  return {
    code: 'PSB_UNREACHABLE',
    messageKey: 'remoteWorkspace.error.unreachable',
    message: detail,
  };
}

interface ResponseEnvelope {
  readonly data?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown; readonly details?: unknown };
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
  }): Promise<PsbRemoteWorkspace[]>;
  listClients(): Promise<PsbRemoteClient[]>;
  listProjectTemplates(): Promise<PsbProjectTemplate[]>;
  createWorkspace(input: PsbCreateWorkspaceRequest): Promise<PsbRemoteWorkspace>;
  getWorkspace(workspaceId: string): Promise<PsbRemoteWorkspace>;
  occupyWorkspace(workspaceId: string): Promise<PsbRemoteWorkspace>;
  releaseWorkspace(workspaceId: string): Promise<PsbRemoteWorkspace>;
  listSessions(workspaceId: string): Promise<PsbRemoteSession[]>;
  createSession(input: PsbCreateSessionRequest): Promise<{
    session: PsbRemoteSession;
    workspace: PsbRemoteWorkspace;
  }>;
  getSession(sessionId: string): Promise<{
    session: PsbRemoteSession;
    workspace: PsbRemoteWorkspace;
  }>;
  stopSession(sessionId: string): Promise<void>;
  getStreamStatus(sessionId: string): Promise<PsbSessionStreamStatus>;
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

      if (status === 401 || status === 403) {
        const code =
          typeof envelope?.error?.code === 'string'
            ? envelope.error.code
            : status === 401
              ? PSB_ERROR_CODES.authRequired
              : 'FORBIDDEN';
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
            message:
              typeof envelope?.error?.message === 'string' ? envelope.error.message : '',
            details: envelope?.error?.details,
          }),
          status,
        );
      }

      if (!outcome.response.ok) {
        const code =
          typeof envelope?.error?.code === 'string' ? envelope.error.code : `HTTP_${status}`;
        throw new PsbClientError(
          psbFailureFromResponse({
            status,
            code,
            message:
              typeof envelope?.error?.message === 'string' ? envelope.error.message : '',
            details: envelope?.error?.details,
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
        parse: (data) => {
          if (typeof data !== 'object' || data === null) return null;
          const row = data as Record<string, unknown>;
          return parsePsbRemoteWorkspace(row['workspace'] ?? row);
        },
      });
    },
    async releaseWorkspace(workspaceId) {
      return call('release-workspace', PSB_CINDY_ROUTES.occupy(workspaceId), {
        method: 'DELETE',
        parse: (data) => {
          if (typeof data !== 'object' || data === null) return null;
          const row = data as Record<string, unknown>;
          return parsePsbRemoteWorkspace(row['workspace'] ?? row);
        },
      });
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
        },
        parse: parseSessionRow,
      });
      const workspace = await requireWorkspaceById(session.workspaceId, 'create-session');
      return { session, workspace };
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
