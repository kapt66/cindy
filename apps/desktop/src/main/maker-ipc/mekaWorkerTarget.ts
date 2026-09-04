import type { AgentKind } from '@cindy/maker-core';
import path from 'node:path';

import { parseMcprRemoteHostId } from '../../shared/meka-router.js';
import type { MekaP4SettingsService } from '../meka-settings/service.js';
import type { MekaRouterService } from '../meka-settings/routerService.js';
import { createLogger } from '../logger.js';
import type { OrcaLeadSessionSnapshot } from './orcaWorkerCreationService.js';

const log = createLogger('meka-worker-target');

export interface MekaWorkerTargetInput {
  lead: OrcaLeadSessionSnapshot;
  agent: AgentKind;
  requestedWorkingDir?: string;
  requestedRemoteHostId?: string;
}

export type MekaWorkerTargetResult =
  | { ok: true; workingDir: string; remoteHostId?: string }
  | { ok: false; errorCode: 'INVALID_PARAMS' | 'NOT_FOUND'; message: string };

function looksLikeMekaServer(projectName: string, projectDescription: string | null): boolean {
  return /server|服务器|saga2[-_ ]?server/i.test(`${projectName} ${projectDescription ?? ''}`);
}

export interface MekaCombatServerWorkerTarget {
  remoteHostId: string;
  workerAgent: Extract<AgentKind, 'claude-code' | 'codex'>;
}

function workerAgentForInstance(
  agentType: string,
): MekaCombatServerWorkerTarget['workerAgent'] | null {
  if (agentType === 'claude') return 'claude-code';
  if (agentType === 'codex') return 'codex';
  return null;
}

export async function resolveUniqueBoundMekaServerTarget(deps: {
  router: Pick<MekaRouterService, 'listProjectBindings' | 'listInstances'>;
  projectId: string;
  probeCodexCapability: (instanceId: string) => Promise<void>;
  probeClaudeCapability: (instanceId: string) => Promise<void>;
}): Promise<MekaCombatServerWorkerTarget | null> {
  const [bindings, instances] = await Promise.all([
    deps.router.listProjectBindings(deps.projectId),
    deps.router.listInstances(),
  ]);
  const candidates = instances.flatMap((instance) => {
    const workerAgent = workerAgentForInstance(instance.agentType);
    return bindings.includes(instance.id) &&
      instance.supported &&
      instance.available &&
      looksLikeMekaServer(instance.projectName, instance.projectDescription) &&
      workerAgent
      ? [{ instance, workerAgent }]
      : [];
  });
  const probed = await Promise.allSettled(
    candidates.map(async ({ instance, workerAgent }) => {
      if (workerAgent === 'claude-code') await deps.probeClaudeCapability(instance.id);
      else await deps.probeCodexCapability(instance.id);
      return { remoteHostId: instance.remoteHostId, workerAgent };
    }),
  );
  const ready = probed.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  for (const [index, result] of probed.entries()) {
    if (result.status === 'fulfilled') continue;
    const candidate = candidates[index];
    log.warn('bound Meka server capability hello failed', {
      projectId: deps.projectId,
      instanceId: candidate?.instance.id ?? '<unknown>',
      workerAgent: candidate?.workerAgent ?? '<unknown>',
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
  }
  return ready.length === 1 ? ready[0]! : null;
}

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
