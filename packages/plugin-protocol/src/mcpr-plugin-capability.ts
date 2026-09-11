/**
 * Cindy <-> MCPRouter plugin capability contract.
 *
 * This module contains only the logical route declaration rules. The Host owns
 * transport and authentication; MCPRouter owns the route registry. Plugins may
 * only send routes declared in their manifest.
 */

export const MCPR_CAPABILITY_CONTRACT_VERSION = 1 as const;

export const MCPR_ROUTE_PATTERN_RE = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*(?:\.\*)?$/;
export const MCPR_MAX_ROUTE_PATTERNS = 32;
export const MCPR_MAX_ROUTE_LENGTH = 128;
export const MCPR_MAX_INPUT_BYTES = 256 * 1024;

export const MCPR_FIXED_ROUTES = ['mcp.tools.list', 'mcp.tools.call'] as const;
export type McprFixedRoute = (typeof MCPR_FIXED_ROUTES)[number];
export type McprRoutePattern = string;

export const MCPR_SCOPES = ['account', 'current-project', 'selected-instance'] as const;
export type McprScope = (typeof MCPR_SCOPES)[number];

export const MCPR_HOST_OPERATIONS = ['status', 'configure-login'] as const;
export type McprHostOperation = (typeof MCPR_HOST_OPERATIONS)[number];

export const MCPR_STATUS_STATES = [
  'authenticated',
  'unauthenticated',
  'expired',
  'unavailable',
] as const;
export type McprRemoteStatus = (typeof MCPR_STATUS_STATES)[number];

export interface McprStatus {
  contractVersion: typeof MCPR_CAPABILITY_CONTRACT_VERSION;
  configured: boolean;
  remote: McprRemoteStatus;
  checkedAt: string;
}

export const MCPR_CONFIGURE_LOGIN_OUTCOMES = ['connected', 'cancelled', 'failed'] as const;
export type McprConfigureLoginOutcome = (typeof MCPR_CONFIGURE_LOGIN_OUTCOMES)[number];

export interface McprConfigureLoginResult {
  outcome: McprConfigureLoginOutcome;
  status: McprStatus;
  code?: Extract<McprErrorCode, 'AUTH_REQUIRED' | 'AUTH_UNAVAILABLE' | 'INTERNAL'>;
}

export interface McprCallRequest {
  contractVersion: typeof MCPR_CAPABILITY_CONTRACT_VERSION;
  route: string;
  input: unknown;
  scope?: McprScope;
  callId?: string;
}

export interface McprCallSuccess {
  ok: true;
  contractVersion: typeof MCPR_CAPABILITY_CONTRACT_VERSION;
  route: string;
  output: unknown;
  requestId?: string;
}

export const MCPR_ERROR_CODES = [
  'ROUTE_NOT_DECLARED',
  'ROUTE_NOT_FOUND',
  'INVALID_REQUEST',
  'INVALID_INPUT',
  'SCOPE_REQUIRED',
  'FORBIDDEN',
  'AUTH_REQUIRED',
  'AUTH_EXPIRED',
  'AUTH_UNAVAILABLE',
  'RISK_CONFIRMATION_REQUIRED',
  'RATE_LIMITED',
  'TIMEOUT',
  'INTERNAL',
] as const;
export type McprErrorCode = (typeof MCPR_ERROR_CODES)[number];

export interface McprCallFailure {
  ok: false;
  contractVersion: typeof MCPR_CAPABILITY_CONTRACT_VERSION;
  code: McprErrorCode;
  message: string;
  requestId?: string;
  retryAfterMs?: number;
}

export type McprCallResponse = McprCallSuccess | McprCallFailure;

export type McprPluginRequest =
  | { operation: 'status' }
  | { operation: 'configure-login' }
  | { operation: 'call'; request: McprCallRequest };

export type McprPluginResponse =
  | { operation: 'status'; status: McprStatus }
  | { operation: 'configure-login'; result: McprConfigureLoginResult }
  | { operation: 'call'; result: McprCallResponse };

export function isMcprRoutePattern(value: unknown): value is McprRoutePattern {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MCPR_MAX_ROUTE_LENGTH &&
    MCPR_ROUTE_PATTERN_RE.test(value)
  );
}

export function mcprRouteMatches(pattern: McprRoutePattern, route: string): boolean {
  if (pattern === route) return true;
  return pattern.endsWith('.*') && route.startsWith(`${pattern.slice(0, -2)}.`);
}

export function isMcprScope(value: unknown): value is McprScope {
  return typeof value === 'string' && (MCPR_SCOPES as readonly string[]).includes(value);
}
