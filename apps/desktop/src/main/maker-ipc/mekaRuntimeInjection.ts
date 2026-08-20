import type { MekaRoleMcpEntry } from '../../shared/meka-projects.js';
import {
  formatCombatEnvironmentGateReceipt,
  runCombatEnvironmentGate,
} from '../meka-projects/combatEnvironmentGate.js';
import {
  resolveMekaRuntimeConfig,
  type MekaRuntimeConfig,
} from '../meka-projects/runtimeConfig.js';
import {
  hasMekaSkillSnapshotEntries,
  materializeMekaSkillSnapshot,
  type MekaSkillSnapshot,
} from '../meka-projects/skillSnapshot.js';
import { prepareMekaRuntimeMcp } from '../mcp-integrations/meka-runtime-mcp.js';
import { getMekaP4SettingsService, getMekaRouterService } from '../meka-settings/ipc.js';
import { probeRemoteCodexCapability } from '../maker-host/mcpr-codex-capability.js';
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
  materializeSkillSnapshot?: (
    sessionId: string,
    skills: readonly MekaRuntimeConfig['skills'][number][],
  ) => Promise<MekaSkillSnapshot | null>;
  readPersistedSession?: (sessionId: string) => Promise<PersistedMekaSessionBinding | null>;
}

export interface AppliedMekaRuntimeConfig {
  didApply: boolean;
  mcpProviderIds: string[];
  inlineMcpCount: number;
  skillsCount: number;
  skillSnapshot: MekaSkillSnapshot | null;
  workflow: MekaRuntimeConfig['workflow'] | null;
  workflowRecoveredFromRole: boolean;
  combatEnvironmentReady: boolean | null;
}

function emptyResult(): AppliedMekaRuntimeConfig {
  return {
    didApply: false,
    mcpProviderIds: [],
    inlineMcpCount: 0,
    skillsCount: 0,
    skillSnapshot: null,
    workflow: null,
    workflowRecoveredFromRole: false,
    combatEnvironmentReady: null,
  };
}

function prependPromptSection(existing: unknown, section: string): string {
  const trimmedSection = section.trim();
  const existingPrompt = typeof existing === 'string' ? existing.trim() : '';
  return [trimmedSection, existingPrompt].filter(Boolean).join('\n\n');
}

const COMBAT_SERVER_WORKER_PROMPT = [
  '[SAGA2_COMBAT_REMOTE_SERVER_WORKER]',
  '当前任务是 MCPR 服务器仓 Worker，不是本地战斗开发 Lead。跳过本地主任务的 P4/UnityMCP 启动门禁。',
  '先读取远端仓库 AGENTS.md，只读核查当前 HEAD 的现有服务器能力；不要加载战斗策划服务器 Skill。',
  '整个任务永久只读：只允许文件读取和 Host 可证明只读的命令；禁止修改文件、创建或切换分支、改 Excel、生成文件或调用业务/项目 MCP。',
  '命令只使用单一 rg、rg --files、Get-Content 或 git status/diff/show 查询；不要使用变量、管道、重定向、命令串联或脚本包装。需要多项证据时逐条调用并用工具输出上限控制结果。',
  'Lead 已在任务正文提供 [SAGA2_MODULE_FIRST] 的 skill-entry-model 模块证据和原子能力矩阵；只核查其中标记为剩余服务器缺口的窄语义。没有完整专用函数不等于模块组合不支持：模块图已覆盖的能力必须按 supported 处理，只有具体剩余原子语义缺少运行时消费者时才返回 unsupported，证据冲突或读取失败才返回 uncertain。',
  '结束时必须把 serverCapabilityReport 作为唯一一次完整终态回复输出：supportStatus、readOnlyConfirmed、repository、head、codeEvidence、capabilityGap、programmerAction、affectedSurfaces、validationSuggestion。MCPR Codex 不暴露 orca_worker_bridge；不要搜索或重试该工具，Orca 会把终态回复自动桥接给 Lead。',
  'head 必须是当前仓库真实 Git SHA。必须完成核查并返回最终报告；不得用“未取得回执”、占位值或普通进度消息代替。',
  '若能力不支持或证据不足，supportStatus 使用 unsupported 或 uncertain，并明确要求 Lead 停止当前实现、把简短报告交给服务器程序。',
  '[/SAGA2_COMBAT_REMOTE_SERVER_WORKER]',
].join('\n');

function roleContextPrompt(runtime: MekaRuntimeConfig): string {
  return [
    '[MEKA_ROLE_CONTEXT]',
    `projectId: ${runtime.projectId}`,
    `roleId: ${runtime.roleId}`,
    `displayName: ${runtime.roleDisplayName}`,
    '这是当前任务的权威角色绑定。不得根据打开的窗口、缓存文件或其它项目角色推断或替换当前角色。',
    '[/MEKA_ROLE_CONTEXT]',
  ].join('\n');
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
  const materializeSnapshot = deps.materializeSkillSnapshot ?? materializeMekaSkillSnapshot;
  if ((opts.vendorOptions as Record<string, unknown> | undefined)?.mekaRuntimeResolved === true) {
    if (typeof opts.id !== 'string' || !opts.id.trim()) return emptyResult();
    let skillSnapshot: MekaSkillSnapshot | null;
    try {
      skillSnapshot = await materializeSnapshot(opts.id, []);
    } catch (error) {
      throwIpcError(
        'INVALID_PARAMS',
        `Meka native Skill snapshot failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (skillSnapshot && hasMekaSkillSnapshotEntries(skillSnapshot) && !opts.remoteHostId) {
      opts.nativeSkillPluginPath = skillSnapshot.pluginPath;
      opts.nativeSkillRevision = skillSnapshot.revision;
    }
    return { ...emptyResult(), skillSnapshot };
  }

  let workspaceKind = opts.workspaceKind;
  let projectId = opts.mekaProjectId ?? null;
  let roleId = opts.mekaRoleId ?? null;
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

  const isCombatServerWorker =
    runtime.workflow === 'saga2-combat-development-v1' &&
    Boolean(opts.remoteHostId) &&
    ((opts.vendorOptions as Record<string, unknown> | undefined)?.orcaRole === 'worker' ||
      opts.orcaRole === 'worker');
  const runtimeMcpEntries = isCombatServerWorker ? [] : runtime.mcp;
  const runtimeSkills = isCombatServerWorker ? [] : runtime.skills;

  let mcp: ReturnType<typeof prepareMcp>;
  try {
    mcp = prepareMcp(runtimeMcpEntries);
  } catch (error) {
    throwIpcError(
      'INVALID_PARAMS',
      `Meka project/role MCP configuration failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (typeof opts.id !== 'string' || !opts.id.trim()) {
    throwIpcError('INVALID_PARAMS', 'Meka native Skills require a persisted session id');
  }
  let skillSnapshot: MekaSkillSnapshot | null;
  try {
    skillSnapshot = await materializeSnapshot(opts.id, runtimeSkills);
  } catch (error) {
    throwIpcError(
      'INVALID_PARAMS',
      `Meka native Skill snapshot failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (skillSnapshot && hasMekaSkillSnapshotEntries(skillSnapshot) && !opts.remoteHostId) {
    opts.nativeSkillPluginPath = skillSnapshot.pluginPath;
    opts.nativeSkillRevision = skillSnapshot.revision;
  }

  if (!isCombatServerWorker) {
    const runtimePrompt = runtime.promptText.trim();
    if (runtimePrompt) {
      opts.userPrompt = prependPromptSection(opts.userPrompt, runtimePrompt);
    }
    opts.userPrompt = prependPromptSection(opts.userPrompt, roleContextPrompt(runtime));
  }

  let combatEnvironmentReceipt: string | undefined;
  let combatEnvironmentReady = false;
  if (runtime.workflow === 'saga2-combat-development-v1') {
    if (opts.agentKind !== 'claude-code' && opts.agentKind !== 'codex') {
      throwIpcError(
        'INVALID_PARAMS',
        'SAGA2 combat workflow enforcement currently requires Claude Code or Codex',
      );
    }
    if (opts.remoteHostId && !isCombatServerWorker) {
      throwIpcError(
        'INVALID_PARAMS',
        'SAGA2 combat development must run in the local P4/Unity workspace; use MCPRouter for server access',
      );
    }
    if (isCombatServerWorker) {
      opts.userPrompt = prependPromptSection(opts.userPrompt, COMBAT_SERVER_WORKER_PROMPT);
    } else {
      const [p4Settings, router] = await Promise.all([
        getMekaP4SettingsService().get(),
        Promise.resolve(getMekaRouterService()),
      ]);
      const gate = await runCombatEnvironmentGate({
        p4: p4Settings,
        listInstances: () => router.listInstances(),
        listProjectBindings: (selectedProjectId) => router.listProjectBindings(selectedProjectId),
        probeRemoteCodexCapability,
        projectId: runtime.projectId,
      });
      combatEnvironmentReady = gate.ready;
      combatEnvironmentReceipt = formatCombatEnvironmentGateReceipt(gate, {
        projectId: runtime.projectId,
        roleId: runtime.roleId,
        displayName: runtime.roleDisplayName,
        workflow: runtime.workflow,
        workflowRecoveredFromRole: runtime.workflowRecoveredFromRole,
      });
      opts.userPrompt = prependPromptSection(opts.userPrompt, combatEnvironmentReceipt);
      opts.planMode = true;
    }
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
    ...(runtime.workflow === 'saga2-combat-development-v1'
      ? { codexNativeSubagentsDisabled: true }
      : {}),
    ...(runtime.workflow
      ? {
          mekaWorkflow:
            runtime.workflow === 'saga2-combat-development-v1' &&
            Boolean(opts.remoteHostId) &&
            ((opts.vendorOptions as Record<string, unknown> | undefined)?.orcaRole === 'worker' ||
              opts.orcaRole === 'worker')
              ? 'saga2-combat-server-worker-v1'
              : runtime.workflow,
        }
      : {}),
    ...(runtime.workflow === 'saga2-combat-development-v1' && !isCombatServerWorker
      ? {
          mekaCombatEnvironmentReady: combatEnvironmentReady,
          mekaCombatPlanApproved: false,
          mekaCombatServerCapabilityStatus: 'unchecked',
          mekaCombatPhase: combatEnvironmentReady ? 'exploration' : 'environment-recovery',
        }
      : {}),
  };

  return {
    didApply: true,
    mcpProviderIds: mcp.providerIds,
    inlineMcpCount: mcp.inlineConfigs.length,
    skillsCount: runtimeSkills.length,
    skillSnapshot,
    workflow: runtime.workflow ?? null,
    workflowRecoveredFromRole: runtime.workflowRecoveredFromRole,
    combatEnvironmentReady:
      runtime.workflow === 'saga2-combat-development-v1' && !isCombatServerWorker
        ? combatEnvironmentReady
        : null,
  };
}
