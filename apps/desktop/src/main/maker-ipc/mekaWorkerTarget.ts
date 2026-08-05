import type { AgentKind } from '@cindy/maker-core';
import path from 'node:path';

import { parseMcprRemoteHostId } from '../../shared/meka-router.js';
import type { MekaP4SettingsService } from '../meka-settings/service.js';
import type { MekaRouterService } from '../meka-settings/routerService.js';
import type { OrcaLeadSessionSnapshot } from './orcaWorkerCreationService.js';

export interface MekaWorkerTargetInput {
  lead: OrcaLeadSessionSnapshot;
  agent: AgentKind;
  requestedWorkingDir?: string;
  requestedRemoteHostId?: string;
}

export type MekaWorkerTargetResult =
  | { ok: true; workingDir: string; remoteHostId?: string }
  | { ok: false; errorCode: 'INVALID_PARAMS' | 'NOT_FOUND'; message: string };

export function createMekaWorkerTargetResolver(deps: {
  p4: Pick<MekaP4SettingsService, 'get'>;
  router: Pick<MekaRouterService, 'listProjectBindings' | 'listInstances'>;
}) {
  const normalizeLocalPath = (value: string) => {
    const normalized = path.resolve(value);
    return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
  };

  return async function resolveMekaWorkerTarget(
    input: MekaWorkerTargetInput,
  ): Promise<MekaWorkerTargetResult> {
    const { lead, agent, requestedWorkingDir, requestedRemoteHostId } = input;
    if (lead.workspaceKind !== 'meka') {
      if (requestedWorkingDir !== undefined || requestedRemoteHostId !== undefined) {
        return {
          ok: false,
          errorCode: 'INVALID_PARAMS',
          message: 'custom Worker targets are only supported for Meka sessions',
        };
      }
      return {
        ok: true,
        workingDir: lead.workingDir ?? '',
        ...(lead.remoteHostId ? { remoteHostId: lead.remoteHostId } : {}),
      };
    }
    if (!lead.mekaProjectId) {
      return {
        ok: false,
        errorCode: 'INVALID_PARAMS',
        message: 'Meka Lead session has no project binding',
      };
    }

    if (requestedRemoteHostId) {
      if (agent !== 'claude-code' && agent !== 'codex') {
        return {
          ok: false,
          errorCode: 'INVALID_PARAMS',
          message: 'MCPRouter Workers support Claude Code and Codex only',
        };
      }
      const instanceId = parseMcprRemoteHostId(requestedRemoteHostId);
      if (!instanceId) {
        return {
          ok: false,
          errorCode: 'INVALID_PARAMS',
          message: 'invalid MCPRouter Worker target',
        };
      }
      try {
        const [bindings, instances] = await Promise.all([
          deps.router.listProjectBindings(lead.mekaProjectId),
          deps.router.listInstances(),
        ]);
        if (!bindings.includes(instanceId)) {
          return {
            ok: false,
            errorCode: 'INVALID_PARAMS',
            message: `MCPRouter instance ${instanceId} is not bound to this Meka project`,
          };
        }
        const instance = instances.find((candidate) => candidate.id === instanceId);
        if (!instance) {
          return {
            ok: false,
            errorCode: 'NOT_FOUND',
            message: `MCPRouter instance ${instanceId} was not found`,
          };
        }
        if (!instance.supported || !instance.available) {
          return {
            ok: false,
            errorCode: 'INVALID_PARAMS',
            message: `MCPRouter instance ${instanceId} is unavailable or unsupported`,
          };
        }
        return {
          ok: true,
          workingDir: instance.workingDir,
          remoteHostId: instance.remoteHostId,
        };
      } catch (error) {
        return {
          ok: false,
          errorCode: 'INVALID_PARAMS',
          message: error instanceof Error ? error.message : 'MCPRouter is unavailable',
        };
      }
    }

    const p4 = await deps.p4.get();
    if (!p4.p4RootPath) {
      return {
        ok: false,
        errorCode: 'INVALID_PARAMS',
        message: 'Configure the Meka P4 root before creating a Worker',
      };
    }
    const allowedLocalDirectories = [p4.p4RootPath, ...p4.extraDirs];
    const requestedLocalDirectory = requestedWorkingDir ?? p4.p4RootPath;
    const requestedKey = normalizeLocalPath(requestedLocalDirectory);
    const allowed = allowedLocalDirectories.some(
      (directory) => normalizeLocalPath(directory) === requestedKey,
    );
    if (!allowed) {
      return {
        ok: false,
        errorCode: 'INVALID_PARAMS',
        message: 'Meka local Workers must use the configured P4 root or a recognized subfolder',
      };
    }
    return { ok: true, workingDir: requestedLocalDirectory };
  };
}
