import type { MekaRoleMcpEntry } from '../../shared/meka-projects.js';
import {
  isMekaManagedWorkspaceDir,
  materializeMekaRuntimeSkills,
  resolveMekaRuntimeConfig,
  type MekaRuntimeConfig,
} from '../meka-projects/runtimeConfig.js';
import { prepareMekaRuntimeMcp } from '../mcp-integrations/meka-runtime-mcp.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { MakerSessionCreateOpts } from './sessionRequest.js';

export interface PersistedMekaSessionBinding {
  workspaceKind: MakerSessionCreateOpts['workspaceKind'];
  mekaProjectId: string | null;
  mekaRoleId: string | null;
  mekaRole: Exclude<MakerSessionCreateOpts['mekaRole'], undefined>;
}

export interface ApplyMekaRuntimeConfigDeps {
  resolveRuntimeConfig?: (projectId: string, roleId: string) => Promise<MekaRuntimeConfig>;
  prepareRuntimeMcp?: (entries: readonly MekaRoleMcpEntry[]) => {
    providerIds: string[];
    inlineConfigs: Array<Extract<MekaRoleMcpEntry, { transport: unknown }>>;
  };
  isManagedWorkspaceDir?: (workingDir: string) => boolean;
  materializeRuntimeSkills?: (
    workingDir: string,
    skills: readonly MekaRuntimeConfig['skills'][number][],
  ) => Promise<void>;
  readPersistedSession?: (sessionId: string) => Promise<PersistedMekaSessionBinding | null>;
}

export interface AppliedMekaRuntimeConfig {
  didApply: boolean;
  mcpProviderIds: string[];
  inlineMcpCount: number;
  skillsCount: number;
  didMaterializeSkills: boolean;
  didInlineSkills: boolean;
}

function emptyResult(): AppliedMekaRuntimeConfig {
  return {
    didApply: false,
    mcpProviderIds: [],
    inlineMcpCount: 0,
    skillsCount: 0,
    didMaterializeSkills: false,
    didInlineSkills: false,
  };
}

function prependPromptSection(existing: unknown, section: string): string {
  const trimmedSection = section.trim();
  const existingPrompt = typeof existing === 'string' ? existing.trim() : '';
  return [trimmedSection, existingPrompt].filter(Boolean).join('\n\n');
}

/**
 * Materialize the current Meka project/role runtime contract into the native
 * maker.createSession options. This is intentionally a bootstrap-time snapshot:
 * changed role config affects the next start/resume, not an already-running turn.
 */
export async function applyMekaRuntimeConfig(
  opts: MakerSessionCreateOpts,
  deps: ApplyMekaRuntimeConfigDeps = {},
): Promise<AppliedMekaRuntimeConfig> {
  if ((opts.vendorOptions as Record<string, unknown> | undefined)?.mekaRuntimeResolved === true) {
    return emptyResult();
  }

  let workspaceKind = opts.workspaceKind;
  let projectId = opts.mekaProjectId ?? null;
  let roleId = opts.mekaRoleId ?? null;
  let legacyRole = opts.mekaRole ?? null;
  let hydratedPersistedSession = false;
  if (
    typeof opts.id === 'string' &&
    opts.id.length > 0 &&
    (!workspaceKind || workspaceKind === 'meka') &&
    deps.readPersistedSession
  ) {
    const persisted = await deps.readPersistedSession(opts.id);
    if (persisted) {
      hydratedPersistedSession = true;
      workspaceKind = persisted.workspaceKind;
      projectId = persisted.mekaProjectId;
      roleId = persisted.mekaRoleId;
      legacyRole = persisted.mekaRole;
      opts.workspaceKind = persisted.workspaceKind;
      opts.mekaProjectId = persisted.mekaProjectId;
      opts.mekaRoleId = persisted.mekaRoleId;
      opts.mekaRole = persisted.mekaRole;
    }
  }
  if (workspaceKind !== 'meka') return emptyResult();

  // Historical four-role Meka sessions intentionally retain their legacy role
  // column. Resolve it against today's bundled SAGA2 roles without rewriting DB.
  if (hydratedPersistedSession && projectId === 'saga2' && !roleId) {
    roleId = 'general-development';
    opts.mekaRoleId = roleId;
  }
  if (!projectId || !roleId) {
    throwIpcError('INVALID_PARAMS', 'Meka session requires a project and role');
  }

  const resolveRuntime = deps.resolveRuntimeConfig ?? resolveMekaRuntimeConfig;
  const prepareMcp = deps.prepareRuntimeMcp ?? prepareMekaRuntimeMcp;
  const isManagedDir = deps.isManagedWorkspaceDir ?? isMekaManagedWorkspaceDir;
  const materializeSkills = deps.materializeRuntimeSkills ?? materializeMekaRuntimeSkills;

  let runtime: MekaRuntimeConfig;
  try {
    runtime = await resolveRuntime(projectId, roleId);
  } catch (error) {
    throwIpcError(
      'INVALID_PARAMS',
      `Meka project/role configuration failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let mcp: ReturnType<typeof prepareMcp>;
  try {
    mcp = prepareMcp(runtime.mcp);
  } catch (error) {
    throwIpcError(
      'INVALID_PARAMS',
      `Meka project/role MCP configuration failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let didMaterializeSkills = false;
  if (runtime.skills.length > 0 && !opts.remoteHostId && isManagedDir(opts.workingDir)) {
    await materializeSkills(opts.workingDir, runtime.skills);
    didMaterializeSkills = true;
  }

  // Native agents discover materialized skills from app-managed workspaces. Real
  // project roots (for example SAGA2's P4 workspace) must not be mutated, so keep
  // the historical fallback: inline the selected Skill contracts into the frozen
  // session prompt instead of silently dropping them.
  const didInlineSkills = runtime.skills.length > 0 && !didMaterializeSkills;
  const runtimePrompt = [
    runtime.promptText.trim(),
    ...(didInlineSkills
      ? [
          '# Configured Meka Agent Skills',
          ...runtime.skills.map((skill) =>
            [`## ${skill.name} (${skill.id})`, skill.content.trim()].join('\n\n'),
          ),
        ]
      : []),
  ]
    .filter(Boolean)
    .join('\n\n');
  if (runtimePrompt) {
    opts.userPrompt = prependPromptSection(opts.userPrompt, runtimePrompt);
  }

  opts.vendorOptions = {
    ...(opts.vendorOptions ?? {}),
    source: 'meka',
    mekaRuntimeResolved: true,
    mekaProjectId: runtime.projectId,
    mekaRoleId: runtime.roleId,
    mekaMcpProviderIds: mcp.providerIds,
    mekaMcpInlineConfigs: mcp.inlineConfigs,
    mekaPolicyProviderRefs: runtime.policyProviderRefs,
  };

  return {
    didApply: true,
    mcpProviderIds: mcp.providerIds,
    inlineMcpCount: mcp.inlineConfigs.length,
    skillsCount: runtime.skills.length,
    didMaterializeSkills,
    didInlineSkills,
  };
}
