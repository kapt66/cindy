import os from 'node:os';
import path from 'node:path';

import type { MekaRoleMcpEntry } from '../../shared/meka-projects.js';
import {
  resolveMekaRuntimeConfig,
  resolveMekaPlatformRuntimeSkills,
  type MekaRuntimeConfig,
  type MekaRuntimeSkill,
} from '../meka-projects/runtimeConfig.js';
import {
  hasMekaSkillSnapshotEntries,
  materializeMekaSkillSnapshot,
  type MekaSkillSnapshot,
} from '../meka-projects/skillSnapshot.js';
import { prepareMekaRuntimeMcp } from '../mcp-integrations/meka-runtime-mcp.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { MakerSessionCreateOpts } from './sessionRequest.js';
import {
  invalidateCombatTargetBinding,
  refreshCombatTargetBinding,
} from '../meka-projects/combatWorkflowPolicy.js';

interface MekaCombatServerWorkerTarget {
  remoteHostId: string;
  workerAgent: 'claude-code' | 'codex';
}

export interface PersistedMekaSessionBinding {
  workspaceKind: MakerSessionCreateOpts['workspaceKind'];
  mekaProjectId: string | null;
  mekaRoleId: string | null;
  mekaRole: Exclude<MakerSessionCreateOpts['mekaRole'], undefined>;
}

export interface ApplyMekaRuntimeConfigDeps {
  resolveRuntimeConfig?: (projectId: string, roleId: string) => Promise<MekaRuntimeConfig>;
  resolvePlatformSkills?: () => Promise<MekaRuntimeSkill[]>;
  prepareRuntimeMcp?: (entries: readonly MekaRoleMcpEntry[]) => {
    providerIds: string[];
    inlineConfigs: Array<Extract<MekaRoleMcpEntry, { transport: unknown }>>;
  };
  materializeSkillSnapshot?: (
    sessionId: string,
    skills: readonly MekaRuntimeConfig['skills'][number][],
  ) => Promise<MekaSkillSnapshot | null>;
  readPersistedSession?: (sessionId: string) => Promise<PersistedMekaSessionBinding | null>;
  resolveCombatServerTarget?: (projectId: string) => Promise<MekaCombatServerWorkerTarget | null>;
}

export interface AppliedMekaRuntimeConfig {
  didApply: boolean;
  mcpProviderIds: string[];
  inlineMcpCount: number;
  skillsCount: number;
  platformSkillsCount: number;
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
    platformSkillsCount: 0,
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

export type CombatSkillIdParseResult =
  | { state: 'missing' }
  | { state: 'valid'; skillId: string }
  | { state: 'ambiguous'; skillIds: string[] };

function normalizePositiveDecimal(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  return raw;
}

/**
 * Only accept an ID that the user labels as a skill. Unlabelled numbers may be
 * damage, duration or count values and must never become the mutation target.
 */
export function parseCombatSkillIdFromUserPrompt(prompt: unknown): CombatSkillIdParseResult {
  if (typeof prompt !== 'string' || !prompt.trim()) return { state: 'missing' };
  const ids = new Set<string>();
  const standalone = prompt.trim().match(/^#?\s*([1-9]\d*)\s*[。.!！]?$/);
  const standaloneId = normalizePositiveDecimal(standalone?.[1]);
  if (standaloneId) ids.add(standaloneId);
  const patterns = [
    /技能\s*(?:ID|Id|id|编号)\s*(?:就是|是|为|[:：=])?\s*#?\s*(\d+)\b/g,
    /技能\s*#?\s*(\d+)\b/g,
    // Chinese UI/task shorthand commonly places the number before the noun:
    // “检查下1009技能”. The adjacent “技能” label keeps ordinary numbers
    // such as damage, duration, and repeat counts out of the target binding.
    /(?:^|[^\d])([1-9]\d*)\s*技能/g,
  ];
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const normalized = normalizePositiveDecimal(match[1]);
      if (normalized) ids.add(normalized);
    }
  }
  const skillIds = [...ids];
  if (skillIds.length === 0) return { state: 'missing' };
  if (skillIds.length > 1) return { state: 'ambiguous', skillIds };
  return { state: 'valid', skillId: skillIds[0]! };
}

export function combatSkillIdVendorPatchFromUserPrompt(
  prompt: unknown,
): Record<string, unknown> | null {
  const parsed = parseCombatSkillIdFromUserPrompt(prompt);
  if (parsed.state === 'missing') return null;
  if (parsed.state === 'ambiguous') {
    return {
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'ambiguous',
      mekaCombatTargetSkillIds: parsed.skillIds,
    };
  }
  return {
    mekaCombatTargetSkillId: parsed.skillId,
    mekaCombatTargetSkillIdState: 'confirmed',
    mekaCombatTargetSkillIds: undefined,
  };
}

export interface CombatFollowupRuntimeContext {
  vendorOptionsPatch: Record<string, unknown>;
  promptSection: string | null;
}

function applyCombatSkillIdToVendorOptions(
  vendorOptions: Record<string, unknown>,
  prompt: unknown,
  sessionId?: string,
): Record<string, unknown> {
  const patch = combatSkillIdVendorPatchFromUserPrompt(prompt);
  if (!patch) return vendorOptions;
  const nextTarget = patch.mekaCombatTargetSkillId;
  const targetChanged =
    typeof nextTarget === 'string' && nextTarget !== vendorOptions.mekaCombatTargetSkillId;
  if (typeof nextTarget === 'string') refreshCombatTargetBinding(sessionId, nextTarget);
  else invalidateCombatTargetBinding(sessionId);
  return {
    ...vendorOptions,
    ...patch,
    ...(targetChanged
      ? {
          mekaCombatServerCapabilityStatus: 'unchecked',
          mekaCombatPlanApproved: false,
          mekaCombatReferenceSkillId: undefined,
          mekaCombatTargetExportAttempted: undefined,
          mekaCombatTargetExportCompleted: undefined,
        }
      : {}),
  };
}

function combatTargetPrompt(vendorOptions: Record<string, unknown>): string | null {
  const target = vendorOptions.mekaCombatTargetSkillId;
  if (typeof target !== 'string' || !/^[1-9]\d*$/.test(target)) return null;
  return [
    '[SAGA2_COMBAT_TARGET]',
    `targetSkillId: ${target}`,
    '这是当前任务由用户确认并由 Host 绑定的唯一技能 ID。续聊和 Worker 回传不得清空、替换或重新推断它；最终结果必须原样使用该值。',
    '[/SAGA2_COMBAT_TARGET]',
  ].join('\n');
}

function combatProjectPathsPrompt(workingDir: unknown): string | null {
  if (typeof workingDir !== 'string' || !workingDir.trim()) return null;
  const resolvedWorkingDir = path.resolve(workingDir);
  const unityClientRoot =
    path.basename(resolvedWorkingDir).toLowerCase() === 'saga2_unity'
      ? resolvedWorkingDir
      : path.join(resolvedWorkingDir, 'saga2_unity');
  const projectRoot =
    path.basename(resolvedWorkingDir).toLowerCase() === 'saga2_unity'
      ? path.dirname(resolvedWorkingDir)
      : resolvedWorkingDir;
  const unityAgentsPath = path.join(unityClientRoot, 'AGENTS.md');
  const legacyModuleProtocolCodecPath = path.join(
    unityClientRoot,
    'Assets',
    'Editor',
    'SkillEditor',
    'Common',
    'Editor',
    'Exporter',
    'Execute',
    'Impl',
    'Type',
    'SkillModuleProtocolCodec.cs',
  );
  return [
    '[SAGA2_PROJECT_PATHS]',
    `projectRoot: ${projectRoot}`,
    `unityClientRoot: ${unityClientRoot}`,
    `legacyModuleJsonTempRoot: ${os.tmpdir()}`,
    `unityAgentsPath: ${unityAgentsPath}`,
    `legacyModuleProtocolCodecPath: ${legacyModuleProtocolCodecPath}`,
    `unityAgentsReadCommand: Get-Content -LiteralPath '${unityAgentsPath}'`,
    `legacyModuleProtocolCodecReadCommand: Get-Content -LiteralPath '${legacyModuleProtocolCodecPath}'`,
    '以上路径和读取命令由 Host 从当前任务 workingDir 解析。读取两个权威文件时必须逐字使用对应 ReadCommand，不得根据 projectRoot 二次拼接、缩短或猜测另一套 SAGA2 路径；Unity CLI status 返回的 projectPath 必须与 unityClientRoot 一致。start_team 和 create_worker 不需要工作区发现，禁止调用 get_workspace_info。',
    '[/SAGA2_PROJECT_PATHS]',
  ].join('\n');
}

function combatServerTargetPrompt(target: MekaCombatServerWorkerTarget | null): string {
  return [
    '[SAGA2_COMBAT_SERVER_TARGET]',
    ...(target
      ? [
          'status: ready',
          `serverRemoteHostId: ${target.remoteHostId}`,
          `serverWorkerAgent: ${target.workerAgent}`,
          '以上值是 Host 对当前 SAGA2 项目绑定、在线状态、实例 Agent 类型和 capability hello 核验后的唯一服务器 Worker 目标。create_worker 的 remote_host_id 和 agent 必须分别原样使用。',
        ]
      : [
          'status: unavailable',
          'Host 未找到唯一且 capability-ready 的 SAGA2 服务器 Worker 目标。禁止调用 get_workspace_info 或自行拼接 mcpr 实例 ID；不得派发或绕过服务器核查。',
        ]),
    '[/SAGA2_COMBAT_SERVER_TARGET]',
  ].join('\n');
}

export async function prepareCombatFollowupRuntimeContext(input: {
  prompt: unknown;
  projectId: string;
  workingDir: unknown;
  sessionId?: string;
  resolveCombatServerTarget?: (projectId: string) => Promise<MekaCombatServerWorkerTarget | null>;
}): Promise<CombatFollowupRuntimeContext | null> {
  const targetPatch = combatSkillIdVendorPatchFromUserPrompt(input.prompt);
  if (!targetPatch) return null;

  const targetSkillId = targetPatch.mekaCombatTargetSkillId;
  if (typeof targetSkillId !== 'string' || !/^[1-9]\d*$/.test(targetSkillId)) {
    return {
      vendorOptionsPatch: {
        ...targetPatch,
        mekaCombatServerRemoteHostId: undefined,
        mekaCombatServerWorkerAgent: undefined,
        mekaCombatServerCapabilityStatus: 'unchecked',
        mekaCombatPlanApproved: false,
        mekaCombatReferenceSkillId: undefined,
        mekaCombatTargetExportAttempted: undefined,
        mekaCombatTargetExportCompleted: undefined,
      },
      promptSection: null,
    };
  }
  let serverTarget: MekaCombatServerWorkerTarget | null = null;
  if (input.resolveCombatServerTarget) {
    try {
      serverTarget = await input.resolveCombatServerTarget(input.projectId);
    } catch {
      serverTarget = null;
    }
  }
  const vendorOptionsPatch = {
    ...targetPatch,
    mekaCombatServerRemoteHostId: serverTarget?.remoteHostId,
    mekaCombatServerWorkerAgent: serverTarget?.workerAgent,
    mekaCombatServerCapabilityStatus: 'unchecked',
    mekaCombatPlanApproved: false,
    mekaCombatReferenceSkillId: undefined,
    mekaCombatTargetExportAttempted: undefined,
    mekaCombatTargetExportCompleted: undefined,
  };
  const sections = [
    combatTargetPrompt(vendorOptionsPatch),
    combatProjectPathsPrompt(input.workingDir),
    combatServerTargetPrompt(serverTarget),
  ].filter((section): section is string => Boolean(section));
  return {
    vendorOptionsPatch,
    promptSection: sections.join('\n\n'),
  };
}

async function injectCombatServerTarget(
  opts: MakerSessionCreateOpts,
  deps: ApplyMekaRuntimeConfigDeps,
  projectId: string,
): Promise<void> {
  const options = (opts.vendorOptions ?? {}) as Record<string, unknown>;
  if (
    typeof options.mekaCombatTargetSkillId !== 'string' ||
    !/^[1-9]\d*$/.test(options.mekaCombatTargetSkillId) ||
    !deps.resolveCombatServerTarget
  ) {
    return;
  }
  let target: MekaCombatServerWorkerTarget | null = null;
  try {
    target = await deps.resolveCombatServerTarget(projectId);
  } catch {
    target = null;
  }
  opts.vendorOptions = {
    ...options,
    mekaCombatServerRemoteHostId: target?.remoteHostId,
    mekaCombatServerWorkerAgent: target?.workerAgent,
  };
  opts.userPrompt = prependPromptSection(opts.userPrompt, combatServerTargetPrompt(target));
}

function removeCombatStartupGate(prompt: string): string {
  return prompt.replace(
    /## 0\. 环境恢复\n\n任务启动时先读取 `\[SAGA2_COMBAT_ENVIRONMENT_GATE\]`。[\s\S]*?不得换 SSH、本地服务器路径或其它工具绕过。\n\n/i,
    '## 0. 依赖按需处理\n\n仅在实际调用 P4、Meka Unity 官方 CLI 或 MCPRouter 工具时处理对应依赖；单项依赖失败只阻止该次调用，继续其它不相关工作。\n\n',
  );
}

const COMBAT_SERVER_WORKER_PROMPT = [
  '[SAGA2_COMBAT_REMOTE_SERVER_WORKER]',
  '当前任务是 MCPR 服务器仓 Worker，不是本地战斗开发 Lead。跳过本地主任务的 P4/Meka Unity CLI 启动门禁。',
  '先读取远端仓库 AGENTS.md，只读核查当前 HEAD 的现有服务器能力；不要加载战斗策划服务器 Skill。',
  '整个任务永久只读：只允许文件读取和 Host 可证明只读的命令；禁止修改文件、创建或切换分支、改 Excel、生成文件或调用业务/项目 MCP。',
  '命令只使用单一 git show、git grep、git status 或 git diff 只读查询；不要使用 Read、rg、变量、管道、重定向、命令串联或脚本包装，也不要读取 Claude 自动保存的超长工具输出。需要多项证据时逐条调用并直接消费当前 Git 命令回执。',
  '6 次预算的默认顺序固定为：第 1 次 `git show HEAD:AGENTS.md`；第 2 次 `git show -s --format=%H HEAD`；第 3 次用 `git grep -l -E <精确符号表达式> HEAD -- internal/battle` 只取得当前 HEAD 中的真实路径。第 4-6 次对这些真实路径分别使用 `git grep -n -C 24 -E <精确符号表达式> HEAD -- <path>` 读取直接消费者附近的小段上下文；不要用 `git show` 打开大型实现文件。所有 `git grep` 都必须显式写 `HEAD`。查询只包含 Lead 任务列出的精确 typ 数字、枚举名和数据函数名，禁止加入 `time`、`target`、`skill`、`damage`、`next`、`trigger` 或中文描述等通用词；没有真实路径时不得猜文件名。禁止先用空查询读取 AGENTS，禁止在命中具体消费者前读取架构总览或通用生命周期文件。',
  'Lead 已在任务正文提供 [SAGA2_MODULE_FIRST] 的目标技能老版导出、模块证据和原子能力矩阵；只核查其中依赖当前服务器解释的窄语义。没有完整专用函数不等于模块组合不支持：模块图已覆盖的能力必须按 supported 处理，只有具体原子语义缺少运行时消费者时才返回 unsupported，证据冲突或读取失败才返回 uncertain。',
  '结束时必须把 serverCapabilityReport 作为唯一一次完整终态回复输出：targetSkillId（与 Lead 绑定值一致的正整数）、supportStatus、readOnlyConfirmed、repository、head、codeEvidence、capabilityGap、programmerAction、affectedSurfaces、validationSuggestion。不要搜索或重试 orca_worker_bridge；Orca 会把终态回复自动桥接给 Lead。',
  '报告字段类型必须严格固定：codeEvidence、affectedSurfaces 为数组；capabilityGap、programmerAction、validationSuggestion 为非空字符串。即使没有能力缺口，capabilityGap 也必须写字符串（例如“无服务器能力缺口；仍需按建议完成验证”），不得写 []、null 或省略。',
  'head 必须是当前仓库真实 Git SHA。必须完成核查并返回最终报告；不得用“未取得回执”、占位值或普通进度消息代替。',
  '若能力不支持或证据不足，supportStatus 使用 unsupported 或 uncertain，并明确要求 Lead 停止当前实现、把简短报告交给服务器程序。',
  '[/SAGA2_COMBAT_REMOTE_SERVER_WORKER]',
].join('\n');

const MEKA_PLATFORM_MCP: MekaRoleMcpEntry = {
  id: 'mcp-router',
  providerId: 'mcp-router',
  enabled: true,
};

const COMBAT_EXECUTION_AUTHORIZATION_PROMPT = [
  '[SAGA2_COMBAT_EXECUTION_AUTHORIZATION]',
  '用户明确要求实施战斗技能或关卡配置时，本轮请求已经包含实施授权。内部完成方案、字段和证据检查后直接执行，不要要求额外的方案审批卡或二次确认。',
  'Host 仍会强制 P4 工作区、服务器只读、范围边界、禁止手改 JSON/.asset，以及只通过 Meka Unity 官方 Unity CLI；依赖故障要修复工具链后继续。',
  '[/SAGA2_COMBAT_EXECUTION_AUTHORIZATION]',
].join('\n');

const COMBAT_CONTROLLER_SKILL_ENTRY = 'skills/combat-skill-configuration/SKILL.md';
const COMBAT_CONTROLLER_SKILL_MARKER = '[SAGA2_COMBAT_CONTROLLER_SKILL]';

function combatControllerSkillPrompt(snapshot: MekaSkillSnapshot | null): string | null {
  const entry = snapshot?.files.find((file) => file.relativePath === COMBAT_CONTROLLER_SKILL_ENTRY);
  if (!entry) return null;
  const content = Buffer.from(entry.contentBase64, 'base64').toString('utf8').trim();
  if (!content) return null;
  return [
    COMBAT_CONTROLLER_SKILL_MARKER,
    '以下是当前任务冻结的唯一战斗总控 Skill 正文，由 Host 直接注入。按正文执行，不要再读取、枚举或发现任何 SKILL.md。',
    content,
    '[/SAGA2_COMBAT_CONTROLLER_SKILL]',
  ].join('\n');
}

function injectCombatControllerSkill(
  opts: MakerSessionCreateOpts,
  snapshot: MekaSkillSnapshot | null,
): void {
  if ((opts.userPrompt ?? '').includes(COMBAT_CONTROLLER_SKILL_MARKER)) return;
  const prompt = combatControllerSkillPrompt(snapshot);
  if (prompt) opts.userPrompt = prependPromptSection(opts.userPrompt, prompt);
}

function mergePlatformSkills(
  current: readonly MekaRuntimeSkill[],
  platform: readonly MekaRuntimeSkill[],
): MekaRuntimeSkill[] {
  const merged = new Map(current.map((skill) => [skill.id, skill]));
  for (const skill of platform) merged.set(skill.id, skill);
  return [...merged.values()];
}

function mergePlatformMcp(current: readonly MekaRoleMcpEntry[]): MekaRoleMcpEntry[] {
  if (current.some((entry) => 'providerId' in entry && entry.providerId === 'mcp-router')) {
    return [...current];
  }
  return [MEKA_PLATFORM_MCP, ...current];
}

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
  const currentUserPrompt = opts.userPrompt;
  const materializeSnapshot = deps.materializeSkillSnapshot ?? materializeMekaSkillSnapshot;
  const existingVendorOptions = opts.vendorOptions as Record<string, unknown> | undefined;
  if (existingVendorOptions?.mekaRuntimeResolved === true) {
    if (
      existingVendorOptions.mekaWorkflow === 'saga2-combat-development-v1' &&
      typeof existingVendorOptions.mekaCombatServerCapabilityStatus !== 'string'
    ) {
      opts.vendorOptions = {
        ...existingVendorOptions,
        mekaCombatServerCapabilityStatus: 'unchecked',
      };
    }
    // Session resume skips full runtime resolution. Preserve the combat role's
    // execution contract on that path as well, otherwise resumed drafts fall
    // back to the legacy plan-approval gate.
    if (
      existingVendorOptions.mekaWorkflow === 'saga2-combat-development-v1' &&
      existingVendorOptions.mekaCombatExecutionMode !== 'autonomous-user-request'
    ) {
      if (!(opts.userPrompt ?? '').includes('[SAGA2_COMBAT_EXECUTION_AUTHORIZATION]')) {
        opts.userPrompt = prependPromptSection(
          opts.userPrompt,
          COMBAT_EXECUTION_AUTHORIZATION_PROMPT,
        );
      }
      opts.vendorOptions = {
        ...(opts.vendorOptions ?? existingVendorOptions),
        mekaCombatExecutionMode: 'autonomous-user-request',
      };
    }
    if (existingVendorOptions.mekaWorkflow === 'saga2-combat-development-v1') {
      opts.vendorOptions = applyCombatSkillIdToVendorOptions(
        (opts.vendorOptions ?? existingVendorOptions) as Record<string, unknown>,
        currentUserPrompt,
        opts.id,
      );
      const targetPrompt = combatTargetPrompt(opts.vendorOptions as Record<string, unknown>);
      if (targetPrompt && !(opts.userPrompt ?? '').includes('[SAGA2_COMBAT_TARGET]')) {
        opts.userPrompt = prependPromptSection(opts.userPrompt, targetPrompt);
      }
      const projectPathsPrompt = combatProjectPathsPrompt(opts.workingDir);
      if (projectPathsPrompt && !(opts.userPrompt ?? '').includes('[SAGA2_PROJECT_PATHS]')) {
        opts.userPrompt = prependPromptSection(opts.userPrompt, projectPathsPrompt);
      }
      await injectCombatServerTarget(opts, deps, 'saga2');
    }
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
    if (existingVendorOptions.mekaWorkflow === 'saga2-combat-development-v1') {
      injectCombatControllerSkill(opts, skillSnapshot);
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
  const resolvePlatformSkills = deps.resolvePlatformSkills ?? resolveMekaPlatformRuntimeSkills;
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
  let platformSkills: MekaRuntimeSkill[] = [];
  if (!isCombatServerWorker) {
    try {
      platformSkills = await resolvePlatformSkills();
    } catch (error) {
      throwIpcError(
        'INVALID_PARAMS',
        `Meka platform capabilities failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const runtimeMcpEntries = isCombatServerWorker ? [] : mergePlatformMcp(runtime.mcp);
  const runtimeSkills = isCombatServerWorker
    ? []
    : mergePlatformSkills(runtime.skills, platformSkills);

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
    const runtimePrompt = removeCombatStartupGate(runtime.promptText.trim());
    if (runtimePrompt) {
      opts.userPrompt = prependPromptSection(opts.userPrompt, runtimePrompt);
    }
    opts.userPrompt = prependPromptSection(opts.userPrompt, roleContextPrompt(runtime));
    if (runtime.workflow === 'saga2-combat-development-v1') {
      opts.userPrompt = prependPromptSection(
        opts.userPrompt,
        COMBAT_EXECUTION_AUTHORIZATION_PROMPT,
      );
    }
  }

  if (isCombatServerWorker) {
    opts.userPrompt = prependPromptSection(opts.userPrompt, COMBAT_SERVER_WORKER_PROMPT);
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
    ...(runtime.workflow === 'saga2-combat-development-v1' || isCombatServerWorker
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
    ...(runtime.workflow === 'saga2-combat-development-v1'
      ? {
          mekaCombatExecutionMode: 'autonomous-user-request',
          mekaCombatServerCapabilityStatus: 'unchecked',
        }
      : {}),
  };
  if (runtime.workflow === 'saga2-combat-development-v1' && !isCombatServerWorker) {
    opts.vendorOptions = applyCombatSkillIdToVendorOptions(
      opts.vendorOptions as Record<string, unknown>,
      currentUserPrompt,
      opts.id,
    );
    const targetPrompt = combatTargetPrompt(opts.vendorOptions as Record<string, unknown>);
    if (targetPrompt) opts.userPrompt = prependPromptSection(opts.userPrompt, targetPrompt);
    const projectPathsPrompt = combatProjectPathsPrompt(opts.workingDir);
    if (projectPathsPrompt)
      opts.userPrompt = prependPromptSection(opts.userPrompt, projectPathsPrompt);
    await injectCombatServerTarget(opts, deps, runtime.projectId);
    injectCombatControllerSkill(opts, skillSnapshot);
  }

  return {
    didApply: true,
    mcpProviderIds: mcp.providerIds,
    inlineMcpCount: mcp.inlineConfigs.length,
    skillsCount: runtimeSkills.length,
    platformSkillsCount: platformSkills.length,
    skillSnapshot,
    workflow: runtime.workflow ?? null,
    workflowRecoveredFromRole: runtime.workflowRecoveredFromRole,
    combatEnvironmentReady: null,
  };
}
