/**
 * MCPRouter 失败原因分类。
 *
 * 读取链(`auth()` → `listOwnedMekaPlugins`)里有几种后果完全不同、下一步动作也不同的
 * 失败:未配置/凭证不全、session 过期或无权限、Router 不支持该管理接口、网络不可达
 * 或超时、回包形状不合法。Renderer 需要按原因给出不同引导(重新连接 / 升级 MCPRouter /
 * 检查网络 / 重试),所以这里把它们映射成固定的 IPC 错误码
 * (`shared/ipc-errors.ts` 的 `MEKA_ROUTER_ERROR_CODES`)。
 *
 * 补充信息(`detail`)只放**可公开**的 HTTP 状态码与端点路径:不得带 token、cookie、
 * 完整 base URL 的查询串或响应体原文——这些一旦进了 UI 文案／日志就是凭证泄漏面。
 */

import type { MekaRouterErrorCode } from '../../shared/ipc-errors.js';
import { MekaRouterRequestError, MekaRouterResponseInvalidError } from './routerClient.js';

/** `auth()` 找不到完整 MCPRouter 绑定(地址／session／client key 任一缺失)时抛出。 */
export class MekaRouterNotConfiguredError extends Error {
  constructor() {
    super('MCPRouter is not configured');
    this.name = 'MekaRouterNotConfiguredError';
  }
}

/** 已登记原因之外的 HTTP 失败(如 5xx/4xx 其它状态)回落到通用 `INTERNAL`。 */
export type MekaRouterFailureCode = MekaRouterErrorCode | 'INTERNAL';

export interface MekaRouterFailure {
  /** 可区分的 IPC 错误码;未登记的状态码回落 `INTERNAL`。 */
  code: MekaRouterFailureCode;
  /** 可读补充信息:HTTP 状态码与端点路径,不含任何凭证或响应体。 */
  detail: string;
}

/** 网络层错误的常见判定词(Chromium `net.fetch` 与 Node fetch 的措辞不同)。 */
const NETWORK_FAILURE_PATTERN =
  /fetch failed|network|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|aborted|timed? ?out|net::ERR_/i;

function statusCodeOf(error: unknown): number | null {
  if (error instanceof MekaRouterRequestError) return error.status;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/**
 * 把读取链上抛出的任意错误映射成固定原因。
 *
 * `endpoint` 只传路径(如 `/api/meka-plugins`),调用方不得把带查询串的完整 URL 传进来。
 */
export function classifyMekaRouterFailure(
  error: unknown,
  endpoint: string,
): MekaRouterFailure {
  if (error instanceof MekaRouterNotConfiguredError) {
    return { code: 'MEKA_ROUTER_NOT_CONFIGURED', detail: `MCPRouter is not configured (${endpoint})` };
  }
  const status = statusCodeOf(error);
  if (status !== null) {
    if (status === 401 || status === 403) {
      return {
        code: 'MEKA_ROUTER_SESSION_EXPIRED',
        detail: `MCPRouter session expired or has no permission (HTTP ${status}) at ${endpoint}`,
      };
    }
    if (status === 404 || status === 405) {
      return {
        code: 'MEKA_ROUTER_ENDPOINT_UNSUPPORTED',
        detail: `MCPRouter does not support ${endpoint} (HTTP ${status})`,
      };
    }
    return { code: 'INTERNAL', detail: `MCPRouter ${endpoint} failed (HTTP ${status})` };
  }
  if (error instanceof MekaRouterResponseInvalidError) {
    return {
      code: 'MEKA_ROUTER_RESPONSE_INVALID',
      detail: `MCPRouter returned an invalid response from ${endpoint}`,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (NETWORK_FAILURE_PATTERN.test(message)) {
    return { code: 'MEKA_ROUTER_UNREACHABLE', detail: `MCPRouter is unreachable at ${endpoint}` };
  }
  return { code: 'INTERNAL', detail: `MCPRouter ${endpoint} failed` };
}

/**
 * 抛出带分类码的普通 Error。
 *
 * 不用 `createIpcError`:IPC handler 的 `throwMekaDevPluginError` 会按 `.code` 重新抛
 * `[CODE] detail`,这里再拼一次前缀会得到双层前缀。message 就是给用户的补充信息。
 */
export function toMekaRouterFailureError(
  error: unknown,
  endpoint: string,
): Error & { code: MekaRouterFailureCode } {
  const failure = classifyMekaRouterFailure(error, endpoint);
  const wrapped = new Error(failure.detail) as Error & { code: MekaRouterFailureCode };
  wrapped.code = failure.code;
  return wrapped;
}
