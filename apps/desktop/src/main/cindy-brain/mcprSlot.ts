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

export type McprLocalServerService = {
  configure?(instanceId: string, inputId?: string, value?: string): Promise<unknown>;
  prepare(instanceId: string, taskId: string, programId?: string): Promise<unknown>;
  describe?(instanceId: string): Promise<unknown>;
  start(instanceId: string, taskId?: string, programId?: string): Promise<unknown>;
  startAll?(instanceId: string, taskId?: string): Promise<unknown>;
  status(instanceId: string, programId?: string): Promise<unknown>;
  stop(instanceId: string, programId?: string): Promise<unknown>;
  logs(instanceId: string, programId?: string): Promise<unknown>;
};

export interface McprSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  getService(): McprService;
  getLocalServerService?: () => McprLocalServerService | null;
  openLoginWindow?: () => void;
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
      if (status.remote !== 'authenticated') this.deps.openLoginWindow?.();
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
    if (payload.operation === 'local') {
      const local = this.deps.getLocalServerService?.();
      const localRoutes = ['server-runtime.build.start', 'server-runtime.build.artifact', 'server-runtime.run.start'];
      if (!local || !localRoutes.some(route => ghost.manifest.mcpr?.routes.some(pattern => mcprRouteMatches(pattern, route))) || !isRecord(payload.input)) {
        return { operation: 'call', result: failure('INVALID_REQUEST', '本地服务器能力不可用或参数无效') };
      }
      const action = payload.input.action;
      const instanceId = typeof payload.input.instanceId === 'string' ? payload.input.instanceId : '';
      const taskId = typeof payload.input.taskId === 'string' ? payload.input.taskId : '';
      const programId = typeof payload.input.programId === 'string' ? payload.input.programId : undefined;
      const inputId = typeof payload.input.inputId === 'string' ? payload.input.inputId : undefined;
      const value = typeof payload.input.value === 'string' ? payload.input.value : undefined;
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(instanceId) || (taskId && !/^[A-Za-z0-9._-]{1,128}$/.test(taskId)) ||
        (programId && !/^[A-Za-z0-9._-]{1,64}$/.test(programId)) || (inputId && !/^[A-Za-z0-9._-]{1,64}$/.test(inputId)) ||
        (value !== undefined && (value.length > 4096 || value.includes('\0'))) || !['configure', 'describe', 'prepare', 'start', 'start-all', 'status', 'stop', 'stop-all', 'logs'].includes(String(action))) {
        return { operation: 'call', result: failure('INVALID_REQUEST', '本地服务器参数无效') };
      }
      try {
        const result = action === 'configure' ? await (local.configure ? local.configure(instanceId, inputId, value) : Promise.reject(new Error('本地服务器配置能力不可用')))
          : action === 'describe' ? await (local.describe ? local.describe(instanceId) : local.status(instanceId))
          : action === 'prepare' ? await (programId ? local.prepare(instanceId, taskId, programId) : local.prepare(instanceId, taskId))
            : action === 'start' ? await (programId ? local.start(instanceId, taskId || undefined, programId) : local.start(instanceId, taskId || undefined))
              : action === 'start-all' ? await (local.startAll ? local.startAll(instanceId, taskId || undefined) : local.start(instanceId, taskId || undefined))
                : action === 'status' ? await local.status(instanceId, programId)
                  : action === 'stop' ? await local.stop(instanceId, programId)
                    : action === 'stop-all' ? await local.stop(instanceId)
                    : await local.logs(instanceId, programId);
        return { operation: 'call', result: { ok: true, contractVersion: MCPR_CAPABILITY_CONTRACT_VERSION, route: 'local-server', output: result } };
      } catch (error) {
        return { operation: 'call', result: failure('INVALID_INPUT', error instanceof Error ? error.message : '本地服务器操作失败') };
      }
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
      route === 'server-runtime.build.contract' ||
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
