import { randomUUID } from 'node:crypto';

import type { InstalledGhost } from '../../shared/ghost.js';
import {
  isMcprScope,
  mcprRouteMatches,
  MCPR_CAPABILITY_CONTRACT_VERSION,
  MCPR_MAX_INPUT_BYTES,
  type McprCallFailure,
  type McprCallRequest,
  type McprCallResponse,
  type McprPluginResponse,
  type McprStatus,
} from '../../shared/mcpr-plugin-capability.js';

type McprService = {
  getPluginCapabilityStatus(): Promise<McprStatus>;
  callPluginCapability(request: McprCallRequest): Promise<McprCallResponse>;
};

export interface McprSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  getService(): McprService;
}

function failure(code: McprCallFailure['code'], message: string): McprCallFailure {
  return { ok: false, contractVersion: MCPR_CAPABILITY_CONTRACT_VERSION, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function serializedInputSize(input: unknown): number | null {
  try {
    const serialized = JSON.stringify(input);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : null;
  } catch {
    return null;
  }
}

/** mcpr slot: installed manifest gate -> shape/size gate -> authenticated Router call. */
export class GhostMcprSlot {
  constructor(private readonly deps: McprSlotDeps) {}

  async handleRequest(ghostId: string, payload: unknown): Promise<McprPluginResponse> {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.slots.includes('mcpr') || !ghost.manifest.mcpr) {
      return {
        operation: 'call',
        result: failure('FORBIDDEN', '插件未申请 MCPRouter 权限(mcpr 槽),或当前未启用'),
      };
    }
    if (!isRecord(payload)) {
      return {
        operation: 'call',
        result: failure('INVALID_REQUEST', 'mcpr-request 载荷必须是对象'),
      };
    }

    if (payload.operation === 'status') {
      return {
        operation: 'status',
        status: await this.deps.getService().getPluginCapabilityStatus(),
      };
    }
    if (payload.operation === 'configure-login') {
      const status = await this.deps.getService().getPluginCapabilityStatus();
      return {
        operation: 'configure-login',
        result:
          status.remote === 'authenticated'
            ? { outcome: 'connected', status }
            : {
                outcome: 'failed',
                status,
                code: status.remote === 'unavailable' ? 'AUTH_UNAVAILABLE' : 'AUTH_REQUIRED',
              },
      };
    }
    if (payload.operation !== 'call' || !isRecord(payload.request)) {
      return {
        operation: 'call',
        result: failure('INVALID_REQUEST', '未知或无效的 MCPRouter 操作'),
      };
    }

    const request = payload.request;
    const route = typeof request.route === 'string' ? request.route : null;
    if (
      request.contractVersion !== MCPR_CAPABILITY_CONTRACT_VERSION ||
      route === null ||
      !ghost.manifest.mcpr.routes.some((pattern) => mcprRouteMatches(pattern, route))
    ) {
      return {
        operation: 'call',
        result: failure('ROUTE_NOT_DECLARED', '插件未声明该 MCPRouter route'),
      };
    }
    if (request.scope !== undefined && !isMcprScope(request.scope)) {
      return { operation: 'call', result: failure('INVALID_REQUEST', 'MCPRouter scope 无效') };
    }
    if (
      request.callId !== undefined &&
      (typeof request.callId !== 'string' ||
        request.callId.length === 0 ||
        request.callId.length > 128)
    ) {
      return { operation: 'call', result: failure('INVALID_REQUEST', 'MCPRouter callId 无效') };
    }
    const inputBytes = serializedInputSize(request.input);
    if (inputBytes === null || inputBytes > MCPR_MAX_INPUT_BYTES) {
      return {
        operation: 'call',
        result: failure('INVALID_INPUT', 'MCPRouter input 必须是受限大小的 JSON'),
      };
    }

    try {
      const result = await this.deps.getService().callPluginCapability({
        contractVersion: MCPR_CAPABILITY_CONTRACT_VERSION,
        route,
        input: request.input,
        ...(request.scope !== undefined ? { scope: request.scope } : {}),
        // Router audit identifiers are Host-minted; plugin callId is only
        // shape-checked above and never trusted as a backend identity.
        callId: randomUUID(),
      });
      return { operation: 'call', result };
    } catch (error) {
      const status = isRecord(error) && typeof error.status === 'number' ? error.status : 0;
      const notConfigured =
        error instanceof Error && error.message === 'MCPRouter is not configured';
      return {
        operation: 'call',
        result: failure(
          status === 401 ? 'AUTH_EXPIRED' : notConfigured ? 'AUTH_REQUIRED' : 'AUTH_UNAVAILABLE',
          status === 401
            ? 'MCPRouter 登录已过期'
            : notConfigured
              ? 'MCPRouter 尚未配置'
              : 'MCPRouter 当前不可用',
        ),
      };
    }
  }
}
