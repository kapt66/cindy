import os from 'node:os';
import path from 'node:path';

import {
  classifyShellCommand,
  type HostToolExecutionContext,
  type HostToolExecutionDecision,
} from '@cindy/maker-core';

import {
  combatEnvironmentAvailability,
  runCombatEnvironmentGate,
  type CombatEnvironmentGateResult,
} from './combatEnvironmentGate.js';
import {
  beginCombatServerCapabilityDispatch,
  COMBAT_MODULE_FIRST_MARKER,
  consumeCombatServerWorkerReadBudget,
  consumeCombatLeadEvidenceBudget,
  COMBAT_LEAD_EVIDENCE_READ_LIMIT,
  getTrustedCombatServerWorkerRemoteHost,
  hasTrustedCombatServerCapabilityReport,
  isModuleFirstCombatServerExplorationTask,
  isCombatServerExplorationTask,
  resetCombatServerCapabilityFlow,
} from './combatServerCapabilityState.js';
import { parseMcprRemoteHostId, type MekaRouterInstance } from '../../shared/meka-router.js';
import { getMekaP4SettingsService, getMekaRouterService } from '../meka-settings/ipc.js';
import { probeRemoteCodexCapability } from '../maker-host/mcpr-codex-capability.js';
import { probeRemoteClaudeCapability } from '../maker-host/mcpr-claude-capability.js';

const WORKFLOW = 'saga2-combat-development-v1';
const SERVER_WORKER_WORKFLOW = 'saga2-combat-server-worker-v1';
const completedTargetExportBySession = new Map<string, string>();
const attemptedTargetExportBySession = new Map<string, string>();
const boundCombatTargetBySession = new Map<string, string>();
const READ_ONLY_MCP_TOOL_NAMES =
  /^(?:check_|get_|list_|read_|search_|find_|inspect_|query_|validate_|describe_|status$)/i;
const READ_ONLY_UNITY_CLI_ACTIONS = new Set([
  'status',
  'list',
  'doctor',
  'editors',
  'projects',
  'releases',
  'env',
  'license',
  'diagnose',
]);
const READ_ONLY_ROUTER_CONTROL_TOOLS = new Set([
  'mcp_list_instances',
  'mcp_instance_tools',
  'mcp_list_servers',
  'mcp_list_resources',
]);
const READ_ONLY_ROUTER_PROJECT_TOOLS = new Set([
  'projects.list',
  'project-instances.list',
  'git.preview',
  'git.tree',
  'git.read',
  'git.search',
  'git.diff',
  'git.log',
  'git.branches',
  'git.show',
]);

function isKnownReadOnlyRouterProjectTool(tool: string): boolean {
  return READ_ONLY_ROUTER_PROJECT_TOOLS.has(tool);
}

export function isCombatEnvironmentRecoveryControlTool(name: string): boolean {
  return READ_ONLY_ROUTER_CONTROL_TOOLS.has(name);
}
const READ_ONLY_GLOBAL_MCP_TOOLS = new Set(['ghost_list']);
const PLACEHOLDER_VALUE =
  /(?:\b(?:unknown|tbd|todo|none yet|current|selected)\b|当前(?:选择|选中|窗口)?|未知|待确认|待定|稍后|未确定|占位)/i;

type CombatVendorOptions = Record<string, unknown> & {
  source?: unknown;
  mekaProjectId?: unknown;
  mekaRoleId?: unknown;
  mekaWorkflow?: unknown;
  mekaCombatEnvironmentReady?: unknown;
  mekaCombatEnvironmentChecks?: unknown;
  mekaCombatPlanApproved?: unknown;
  /** User explicitly requested an in-scope combat implementation. */
  mekaCombatExecutionMode?: unknown;
  mekaCombatPhase?: unknown;
  mekaCombatServerCapabilityStatus?: unknown;
  mekaCombatTargetSkillId?: unknown;
  mekaCombatTargetSkillIdState?: unknown;
  mekaCombatTargetExportAttempted?: unknown;
  mekaCombatTargetExportCompleted?: unknown;
};

function combatOptions(value: Record<string, unknown>): CombatVendorOptions {
  return value as CombatVendorOptions;
}

function hasCompletedCombatTargetExport(context: HostToolExecutionContext): boolean {
  const options = combatOptions(context.vendorOptions);
  const target = text(options.mekaCombatTargetSkillId);
  return (
    options.mekaCombatTargetExportCompleted === true ||
    (Boolean(target) && completedTargetExportBySession.get(context.sessionId) === target)
  );
}

function hasAttemptedCombatTargetExport(context: HostToolExecutionContext): boolean {
  const options = combatOptions(context.vendorOptions);
  const target = text(options.mekaCombatTargetSkillId);
  return (
    options.mekaCombatTargetExportAttempted === true ||
    (Boolean(target) && attemptedTargetExportBySession.get(context.sessionId) === target)
  );
}

export function resetCombatTargetExportStateForTests(): void {
  completedTargetExportBySession.clear();
  attemptedTargetExportBySession.clear();
  boundCombatTargetBySession.clear();
}

/** Any non-unique target ends the current evidence generation. */
export function invalidateCombatTargetBinding(sessionId: string | undefined): void {
  const session = sessionId?.trim();
  if (!session) return;
  completedTargetExportBySession.delete(session);
  attemptedTargetExportBySession.delete(session);
  boundCombatTargetBySession.delete(session);
}

/**
 * A follow-up target change starts a new evidence generation. This invalidates
 * the in-memory fallback maps as well as the vendor-option flags, preventing a
 * later switch back to an older skill from reusing stale export evidence.
 */
export function refreshCombatTargetBinding(
  sessionId: string | undefined,
  targetSkillId: string,
): void {
  const session = sessionId?.trim();
  const target = targetSkillId.trim();
  if (!session || !/^[1-9]\d*$/.test(target)) return;
  const previous = boundCombatTargetBySession.get(session);
  if (previous && previous !== target) {
    completedTargetExportBySession.delete(session);
    attemptedTargetExportBySession.delete(session);
  }
  boundCombatTargetBySession.set(session, target);
}

export function isCombatWorkflowPolicyActive(context: {
  vendorOptions: Record<string, unknown>;
}): boolean {
  const options = combatOptions(context.vendorOptions);
  return (
    options.source === 'meka' &&
    options.mekaProjectId === 'saga2' &&
    options.mekaWorkflow !== SERVER_WORKER_WORKFLOW &&
    (options.mekaWorkflow === WORKFLOW || options.mekaRoleId === 'combat-development')
  );
}

function isCombatServerWorkerPolicyActive(context: {
  vendorOptions: Record<string, unknown>;
}): boolean {
  const options = combatOptions(context.vendorOptions);
  return (
    options.source === 'meka' &&
    options.mekaProjectId === 'saga2' &&
    options.mekaWorkflow === SERVER_WORKER_WORKFLOW
  );
}

export function isCombatToolPolicyActive(context: {
  vendorOptions: Record<string, unknown>;
}): boolean {
  return isCombatWorkflowPolicyActive(context) || isCombatServerWorkerPolicyActive(context);
}

export function markCombatPlanApproved(context: {
  vendorOptions: Record<string, unknown>;
  plan?: string;
  sessionId?: string;
}): void {
  if (!isCombatWorkflowPolicyActive(context)) return;
  const options = combatOptions(context.vendorOptions);
  options.mekaCombatPlanApproved = true;
  options.mekaCombatPhase = 'solution-approved';
}

export function evaluateCombatPlanReview(context: {
  vendorOptions: Record<string, unknown>;
  plan: string;
}): { behavior: 'allow' } | { behavior: 'deny'; reason: string } {
  if (!isCombatWorkflowPolicyActive(context)) return { behavior: 'allow' };
  const envelope = context.plan.match(
    /\[SAGA2_COMBAT_SOLUTION\]([\s\S]*?)\[\/SAGA2_COMBAT_SOLUTION\]/,
  )?.[1];
  const required = [
    'targetSkillId',
    'changeMode',
    'surfaces',
    'moduleEvidence',
    'capabilityMatrix',
    'evidence',
    'validation',
    'remainingUnknowns',
  ];
  const fields = new Map<string, string>();
  if (envelope) {
    for (const match of envelope.matchAll(/^([A-Za-z][A-Za-z0-9]*):\s*(\S.*)$/gm)) {
      fields.set(match[1]!, match[2]!.trim());
    }
  }
  const missing = required.filter((field) => !fields.get(field));
  const target = fields.get('targetSkillId') ?? '';
  const confirmedTarget = text(combatOptions(context.vendorOptions).mekaCombatTargetSkillId);
  const changeMode = fields.get('changeMode') ?? '';
  const invalidFields = required.filter((field) => {
    const value = fields.get(field) ?? '';
    if (!value) return false;
    if (field === 'remainingUnknowns' && /^(?:none|无)$/i.test(value)) return false;
    return PLACEHOLDER_VALUE.test(value) || /^<.*>$/.test(value);
  });
  const invalidTarget =
    invalidFields.includes('targetSkillId') ||
    !/^[1-9]\d*$/.test(target) ||
    !confirmedTarget ||
    target !== confirmedTarget;
  const invalidChangeMode = !['create', 'rebuild', 'incremental'].includes(changeMode);
  const surfaces = fields.get('surfaces') ?? '';
  const includesServerImplementation = /(?:^|[\s,，/+|])(?:server|服务器)(?:$|[\s,，/+|])/i.test(
    surfaces,
  );
  const invalidSurfaces =
    !/(?:^|[\s,，/+|])(?:module|timeline|table|export|client)(?:$|[\s,，/+|])/i.test(surfaces);
  const serverCapabilityStatus = text(
    combatOptions(context.vendorOptions).mekaCombatServerCapabilityStatus,
  );
  if (includesServerImplementation) {
    return {
      behavior: 'deny',
      reason:
        '战斗开发服务器 Worker 仅用于只读能力核查，server/服务器不能作为本轮实施面。若现有能力不足，请提交简短程序交接报告并结束当前实现；服务器程序应在独立开发流程中处理。',
    };
  }
  if (serverCapabilityStatus === 'unsupported' || serverCapabilityStatus === 'uncertain') {
    return {
      behavior: 'deny',
      reason:
        '服务器能力报告已标记当前实现为阻断状态。请停止提交实施方案，向用户返回程序交接报告。',
    };
  }
  if (
    serverCapabilityStatus === 'dispatching' ||
    serverCapabilityStatus === 'pending' ||
    serverCapabilityStatus === 'report-ready' ||
    serverCapabilityStatus === 'retry-required'
  ) {
    return {
      behavior: 'deny',
      reason:
        '服务器只读能力核查尚未由 Host 完整结算。请先完成真实 Worker 派发、auto-bridge 回传和 validate_server_capability_report 一次性消费；失败时重新检查环境并重试，不得代写报告或提交实施方案。',
    };
  }
  if (serverCapabilityStatus !== 'supported') {
    return {
      behavior: 'deny',
      reason:
        '当前技能尚未在本轮取得 Host 验证的服务器 supported 回执。请先基于当前技能导出和客户端消费者形成 [SAGA2_MODULE_FIRST] 原子能力矩阵，派发只读 MCPR 服务器 Worker，并消费 validate_server_capability_report；历史结论或本地代码不能替代当前远端 HEAD。',
    };
  }
  if (
    !envelope ||
    missing.length > 0 ||
    invalidFields.length > 0 ||
    invalidTarget ||
    invalidChangeMode ||
    invalidSurfaces
  ) {
    return {
      behavior: 'deny',
      reason:
        '方案尚未满足 SAGA2 战斗开发审批契约。请补充 [SAGA2_COMBAT_SOLUTION] 回执：targetSkillId 必须是用户确认的具体 ID，changeMode 必须是 create/rebuild/incremental，surfaces 必须列出实际实现面，moduleEvidence 必须引用当前目标技能的老版导出回执、节点/字段或明确不存在结论，capabilityMatrix 必须逐项列出原子能力结论，evidence、validation 和 remainingUnknowns 不能使用占位内容。',
    };
  }
  return { behavior: 'allow' };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePositiveDecimal(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  return raw;
}

function serializedToolTarget(context: HostToolExecutionContext): string {
  const parts: Array<string | undefined> = [
    context.action.kind === 'read' || context.action.kind === 'file-write'
      ? context.action.path
      : undefined,
    context.action.kind === 'exec' ? context.action.command : undefined,
  ];
  try {
    parts.push(JSON.stringify(context.input));
  } catch {
    // Cyclic input cannot carry trusted target evidence.
  }
  return parts.filter((part): part is string => typeof part === 'string').join('\n');
}

function explicitCombatSkillIds(context: HostToolExecutionContext): string[] {
  const payload = serializedToolTarget(context);
  const ids = new Set<string>();
  const patterns = [
    /skill_entry_model_(\d+)(?:_static)?\.json/gi,
    /targetSkillId\s*(?:=|:|：)\s*#?\s*(\d+)\b/gi,
    /(?:skill[_-]?id|技能\s*(?:ID|Id|id|编号)?)\s*(?:=|:|：|是|为|\\?"|')*\s*#?\s*(\d+)\b/g,
    /--skill[_-]?id(?:=|\s+)(\d+)\b/gi,
    /(?:^|[\\/])(\d+)\.(?:import|export|static)\.json\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of payload.matchAll(pattern)) {
      const normalized = normalizePositiveDecimal(match[1]);
      if (normalized) ids.add(normalized);
    }
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (
          typeof value[index] === 'string' &&
          /^legacy_module_(?:prepare_asset|import_json|export_json)$/i.test(value[index]) &&
          normalizePositiveDecimal(value[index + 1])
        ) {
          ids.add(normalizePositiveDecimal(value[index + 1])!);
        }
        if (
          typeof value[index] === 'string' &&
          /^--?skill[_-]?id$/i.test(value[index]) &&
          normalizePositiveDecimal(value[index + 1])
        ) {
          ids.add(normalizePositiveDecimal(value[index + 1])!);
        }
        visit(value[index]);
      }
      return;
    }
    const object = record(value);
    if (!object) return;
    for (const [key, entry] of Object.entries(object)) {
      if (/^skill[_-]?id$/i.test(key)) {
        const normalized = normalizePositiveDecimal(entry);
        if (normalized) ids.add(normalized);
      }
      visit(entry);
    }
  };
  visit(context.input);
  return [...ids].filter((id) => /^[1-9]\d*$/.test(id));
}

function combatSkillTargetReason(context: HostToolExecutionContext): string | null {
  const options = combatOptions(context.vendorOptions);
  const target = text(options.mekaCombatTargetSkillId);
  if (!/^[1-9]\d*$/.test(target)) {
    return options.mekaCombatTargetSkillIdState === 'ambiguous'
      ? '当前消息提供了多个技能 ID。请先让用户明确本轮只生成、修改或检查哪一个正整数技能 ID；确认前不得读取项目或调用工具。'
      : '当前任务缺少用户明确提供的正整数技能 ID。请只询问要生成、修改或检查的技能 ID；获得 ID 前不得读取项目或调用 Unity CLI、MCPRouter、P4。';
  }
  const referenceMarker = serializedToolTarget(context).match(
    /\[SAGA2_REFERENCE_SKILL_ID:\s*([1-9]\d*)\s*\]/i,
  );
  if (referenceMarker?.[1]) {
    return `本轮目标技能 ID 是 ${target}，但当前工具请求显式引用了 ${referenceMarker[1]}。一个任务只允许一个目标技能 ID；请移除参考技能 marker，只对 ${target} 取证。`;
  }
  const explicitIds = explicitCombatSkillIds(context);
  const mismatched = explicitIds.filter((id) => id !== target);
  if (mismatched.length > 0) {
    return `本轮目标技能 ID 是 ${target}，但当前工具请求显式引用了 ${mismatched.join('、')}。请停止该调用并只对 ${target} 取证；不得借用其它技能的静态结果冒充当前技能证据。`;
  }
  if (
    /legacy_module_(?:prepare_asset|import_json|export_json)/i.test(
      serializedToolTarget(context),
    ) &&
    !explicitIds.includes(target)
  ) {
    return `老版模块编辑器准备、导入和导出必须显式传入本轮技能 ID ${target}，不得依赖当前打开或选中的技能。`;
  }
  return null;
}

function legacyModuleJsonCommand(
  context: HostToolExecutionContext,
): { command: string; jsonPath: string | null; projectPath: string | null } | null {
  const target = effectiveMcpTarget(context.toolName, context.input);
  let args: Record<string, unknown> | null = null;
  if (target?.server === 'meka-unity' && target.tool === 'unity_execute') {
    args = mcpToolArguments(context.input);
  } else if (target?.server === 'cindy' && target.tool === 'ghost_call') {
    const unityCall = ghostUnityCall(context.input);
    if (unityCall?.tool === 'unity_execute') args = unityCall.args;
  }
  if (!args || text(args.action) !== 'command' || !Array.isArray(args.arguments)) return null;
  const values = args.arguments.map((value) => String(value));
  const commandIndex = values.findIndex((value) =>
    /^legacy_module_(?:import|export)_json$/i.test(value),
  );
  if (commandIndex < 0) return null;
  const command = values[commandIndex]!;
  const tail = values.slice(commandIndex + 1);
  for (let index = 0; index < tail.length; index += 1) {
    if (/^--?path$/i.test(tail[index]!)) {
      return {
        command,
        jsonPath: tail[index + 1] ?? null,
        projectPath: text(args.projectPath) || null,
      };
    }
    const inline = tail[index]!.match(/^--?path=(.+)$/i);
    if (inline) {
      return {
        command,
        jsonPath: inline[1] ?? null,
        projectPath: text(args.projectPath) || null,
      };
    }
  }
  const positional: string[] = [];
  for (let index = 0; index < tail.length; index += 1) {
    const value = tail[index]!;
    if (/^--?/.test(value)) {
      if (!value.includes('=')) index += 1;
      continue;
    }
    positional.push(value);
  }
  return {
    command,
    jsonPath: positional[1] ?? null,
    projectPath: text(args.projectPath) || null,
  };
}

function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = path.resolve(root);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function combatUnityProjectRoot(context: HostToolExecutionContext): string {
  const workingDir = path.resolve(context.workingDir);
  const segments = workingDir.split(path.sep);
  const unityIndex = segments.findIndex((segment) => segment.toLowerCase() === 'saga2_unity');
  return unityIndex >= 0
    ? segments.slice(0, unityIndex + 1).join(path.sep)
    : path.join(workingDir, 'saga2_unity');
}

function legacyModuleJsonPathReason(context: HostToolExecutionContext): string | null {
  const call = legacyModuleJsonCommand(context);
  if (!call) return null;
  const expectedProjectPath = combatUnityProjectRoot(context);
  if (!call.projectPath || path.resolve(call.projectPath) !== path.resolve(expectedProjectPath)) {
    return `${call.command} 必须显式使用 Host 注入的 Unity 工程路径 ${expectedProjectPath}；不得省略 projectPath、使用当前选择或连接其它常驻 Unity 实例。`;
  }
  if (
    !call.jsonPath ||
    !path.isAbsolute(call.jsonPath) ||
    path.extname(call.jsonPath).toLowerCase() !== '.json'
  ) {
    return `${call.command} 必须使用绝对 .json 路径。导入源和回读导出只能放在操作系统临时目录或 saga2_unity 内。`;
  }
  if (
    !isPathInside(call.jsonPath, os.tmpdir()) &&
    !isPathInside(call.jsonPath, combatUnityProjectRoot(context))
  ) {
    return `${call.command} 的 JSON 路径超出授权范围。禁止写入 saga2_json、saga2_design 或其它目录；请改用操作系统临时目录或 saga2_unity。`;
  }
  return null;
}

function mcpParts(toolName: string | undefined): { server: string; tool: string } | null {
  if (!toolName) return null;
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.slice(5).split('__');
    return parts.length >= 2 ? { server: parts[0]!, tool: parts.slice(1).join('__') } : null;
  }
  if (toolName.startsWith('mcp:')) {
    const parts = toolName.slice(4).split(':');
    return parts.length >= 2
      ? { server: parts[0]!, tool: parts.slice(1).join(':') }
      : { server: parts[0]!, tool: '' };
  }
  return null;
}

function effectiveMcpTarget(
  toolName: string | undefined,
  input: unknown,
): { server: string; tool: string } | null {
  const target = mcpParts(toolName);
  if (!target) return null;
  if (target.tool) return target;
  const outer = record(input);
  const toolParams = record(outer?.toolParams);
  let inferredTool = text(outer?.toolName) || text(outer?.name);
  // Codex code-mode MCP approvals can omit `_meta.tool_name` while preserving
  // the complete arguments in `_meta.tool_params`. Infer only schema-unique
  // first-party wrappers; every other unknown action remains blocked.
  if (
    !inferredTool &&
    target.server === 'cindy' &&
    text(toolParams?.ghost_id) &&
    text(toolParams?.tool)
  ) {
    inferredTool = 'ghost_call';
  }
  if (!inferredTool && target.server === 'mcp_router' && text(toolParams?.name)) {
    inferredTool = 'call_tool';
  }
  if (!inferredTool && target.server === 'cindy_orca') {
    if (Array.isArray(toolParams?.workers)) {
      inferredTool = 'create_workers';
    } else if (
      text(toolParams?.initial_task) &&
      text(toolParams?.remote_host_id) &&
      text(toolParams?.role) &&
      text(toolParams?.agent) &&
      text(toolParams?.label)
    ) {
      inferredTool = 'create_worker';
    } else if (
      text(toolParams?.message) &&
      (text(toolParams?.worker_id) || text(toolParams?.session_id))
    ) {
      inferredTool = 'send_to_worker';
    }
  }
  if (!inferredTool) return null;
  return {
    ...target,
    tool: inferredTool,
  };
}

function mcpToolArguments(input: unknown): Record<string, unknown> {
  const outer = record(input) ?? {};
  return record(outer.toolParams) ?? outer;
}

function progressiveInnerCall(
  input: unknown,
): { name: string; args: Record<string, unknown> } | null {
  const outer = record(input);
  if (!outer) return null;
  const directName = text(outer.name);
  if (directName) return { name: directName, args: record(outer.args) ?? {} };
  const params = record(outer.toolParams);
  const nestedName = text(params?.name);
  return nestedName ? { name: nestedName, args: record(params?.args) ?? {} } : null;
}

function isUnityReadOnly(tool: string, input: unknown): boolean {
  if (READ_ONLY_MCP_TOOL_NAMES.test(tool)) return true;
  const outer = record(input);
  if (tool === 'unity_inspect') {
    return READ_ONLY_UNITY_CLI_ACTIONS.has(text(outer?.action));
  }
  if (tool !== 'unity_execute' || text(outer?.action) !== 'command') return false;
  const args = Array.isArray(outer?.arguments) ? outer.arguments : [];
  return text(args[0]) === 'legacy_module_export_json';
}

function ghostUnityCall(input: unknown): { tool: string; args: Record<string, unknown> } | null {
  const args = mcpToolArguments(input);
  if (text(args.ghost_id) !== 'meka-unity') return null;
  const tool = text(args.tool);
  return tool ? { tool, args: record(args.args) ?? {} } : null;
}

function isDesignPlanningPath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.includes('/saga2_design/planning/') || normalized.endsWith('/saga2_design/planning')
  );
}

function isPlanningMutation(context: HostToolExecutionContext): boolean {
  if (context.action.kind === 'file-write' && isDesignPlanningPath(context.action.path))
    return true;
  if (context.action.kind !== 'mcp') return false;
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server !== 'cindy' || target.tool !== 'ghost_call') return false;
  const args = mcpToolArguments(context.input);
  if (text(args.ghost_id) !== 'meka-p4') return false;
  const p4Args = record(args.args) ?? {};
  return Object.values(p4Args).some(isDesignPlanningPath);
}

function isUnityOpenRequest(context: HostToolExecutionContext): boolean {
  if (context.action.kind !== 'mcp') return false;
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server === 'meka-unity' && target.tool === 'unity_execute') {
    return text(mcpToolArguments(context.input).action) === 'open';
  }
  if (target?.server === 'cindy' && target.tool === 'ghost_call') {
    const unityCall = ghostUnityCall(context.input);
    return unityCall?.tool === 'unity_execute' && text(unityCall.args.action) === 'open';
  }
  return false;
}

async function isRouterReadOnly(projectId: string, tool: string, input: unknown): Promise<boolean> {
  if (tool === 'check_combat_environment' || READ_ONLY_MCP_TOOL_NAMES.test(tool)) return true;
  if (tool !== 'call_tool') return false;
  const inner = progressiveInnerCall(input);
  if (!inner) return false;
  if (READ_ONLY_ROUTER_CONTROL_TOOLS.has(inner.name)) return true;
  if (isKnownReadOnlyRouterProjectTool(inner.name)) return true;
  const tools = await getMekaRouterService().listProjectTools(projectId);
  const definition = tools.find((candidate) => text(candidate.name) === inner.name);
  const annotations = record(definition?.annotations);
  if (annotations?.readOnlyHint === true || annotations?.read_only === true) return true;
  if (annotations?.destructiveHint === true) return false;
  return READ_ONLY_MCP_TOOL_NAMES.test(inner.name);
}

async function isReadOnlyMcpCall(context: HostToolExecutionContext): Promise<boolean> {
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (!target) return false;
  if (target.server === 'cindy' && READ_ONLY_GLOBAL_MCP_TOOLS.has(target.tool)) return true;
  if (target.server === 'cindy' && target.tool === 'ghost_call') {
    const args = mcpToolArguments(context.input);
    if (text(args.ghost_id) === 'meka-p4' && text(args.tool) === 'p4_status') return true;
    const unityCall = ghostUnityCall(context.input);
    return unityCall ? isUnityReadOnly(unityCall.tool, unityCall.args) : false;
  }
  if (target.server === 'meka-unity') return isUnityReadOnly(target.tool, context.input);
  if (target.server === 'mcp_router') {
    return isRouterReadOnly('saga2', target.tool, context.input);
  }
  return READ_ONLY_MCP_TOOL_NAMES.test(target.tool);
}

function isEnvironmentRecoveryMcp(context: HostToolExecutionContext): boolean {
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server !== 'mcp_router') return false;
  if (
    [
      'check_combat_environment',
      'diagnose_mcp_router_connection',
      'list_tools',
      'list_project_remote_instances',
      'list_remote_instances',
      'list_remote_project_templates',
      'list_remote_directory',
      'read_remote_file',
      'search_remote_files',
      'create_remote_instance',
      'bind_remote_instance',
    ].includes(target.tool)
  ) {
    return true;
  }
  const inner = target.tool === 'call_tool' ? progressiveInnerCall(context.input) : null;
  return Boolean(inner && isCombatEnvironmentRecoveryControlTool(inner.name));
}

function isEnvironmentDiagnosticCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ').toLowerCase();
  return /^(?:where(?:\.exe)? p4|where(?:\.exe)? unity|p4 (?:-ztag )?(?:info|where|client -o|protects\b|login -s\b)|get-process\b|test-netconnection\b|netstat\b)/.test(
    normalized,
  );
}

type CombatEnvironmentDependency = 'p4' | 'unityCli' | 'mcpr';

function combatToolDependency(
  context: HostToolExecutionContext,
): CombatEnvironmentDependency | null {
  if (context.action.kind === 'file-write') return 'p4';
  if (context.action.kind === 'exec') {
    if (isEnvironmentDiagnosticCommand(context.action.command)) return null;
    const normalized = context.action.command
      .trim()
      .replace(/^['"]+/, '')
      .toLowerCase();
    if (/^(?:p4\b|p4\.exe\b)/.test(normalized)) return 'p4';
    return null;
  }
  if (context.action.kind !== 'mcp') return null;
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (!target) return null;
  if (target.server === 'meka-unity') return 'unityCli';
  if (target.server === 'cindy' && target.tool === 'ghost_call') {
    const args = mcpToolArguments(context.input);
    if (text(args.ghost_id) === 'meka-p4') return 'p4';
    return ghostUnityCall(context.input) ? 'unityCli' : null;
  }
  if (target.server === 'mcp_router') {
    return isCombatEnvironmentCheck(context) ? null : 'mcpr';
  }
  if (target.server === 'cindy_orca' && combatServerDispatchRequest(context)) return 'mcpr';
  return null;
}

function blockedDependencyReason(
  options: CombatVendorOptions,
  dependency: CombatEnvironmentDependency,
): string | null {
  const checks = record(options.mekaCombatEnvironmentChecks);
  const check = record(checks?.[dependency]);
  const status = text(check?.status);
  if (status === 'ready') return null;
  if (status !== 'blocked' && options.mekaWorkflow === WORKFLOW) return null;

  const label = dependency === 'p4' ? 'P4' : dependency === 'unityCli' ? 'Unity CLI' : 'MCPRouter';
  const summary = text(check?.summary) || `${label} 当前状态尚未完成校验`;
  const nextAction =
    text(check?.nextAction) || '调用 mcp_router.check_combat_environment 刷新三条链路状态后重试';
  return `当前工具实际依赖 ${label}，因此只阻止本次调用，不冻结整个任务。原因：${summary}。解决方案：${nextAction}。不依赖 ${label} 的探索、澄清和其它工具仍可继续。`;
}

function readOnlySelectStringPayload(command: string): string | null {
  const match = command.match(
    /^"[^"]*[\\/](?:pwsh|powershell)(?:\.exe)?"\s+-command\s+"([\s\S]*)"\s*$/i,
  );
  const payload = match?.[1]?.trim();
  if (!payload || !/^select-string\b/i.test(payload)) return null;
  if (/\b(?:env|variable|function|registry):/i.test(payload)) return null;

  let singleQuoted = false;
  let shellReviewPayload = '';
  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index];
    if (char === "'") {
      if (singleQuoted && payload[index + 1] === "'") {
        shellReviewPayload += "''";
        index += 1;
        continue;
      }
      singleQuoted = !singleQuoted;
      shellReviewPayload += char;
      continue;
    }
    if (!singleQuoted && /["`$;&|><(){}]/.test(char)) return null;
    // POSIX shell review removes quotes before some checks. PowerShell treats
    // these characters as literal data inside single quotes, so mask them to
    // avoid misclassifying a regex such as '预警|伤害' as a shell pipeline.
    shellReviewPayload += singleQuoted && /[`$;&|><(){}]/.test(char) ? '_' : char;
  }
  if (singleQuoted) return null;
  return shellReviewPayload;
}

function isMekaSkillSnapshotEntrypoint(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, '/');
  if (/[?*;|><`$(){}]/.test(normalized) || normalized.split('/').includes('..')) return false;
  return /\/meka-skill-snapshots\/revisions\/[a-f0-9]{32,256}\/claude-plugin\/skills\/combat-skill-configuration\/SKILL\.md$/i.test(
    normalized,
  );
}

function powerShellCommandPayload(command: string): string | null {
  const wrapper = command.match(
    /^"[^"]*[\\/](?:pwsh|powershell)(?:\.exe)?"\s+-command\s+([\s\S]+)$/i,
  );
  const payload = wrapper?.[1]?.trim() ?? '';
  return payload && !/[\r\n]/.test(payload) ? payload : null;
}

function isReadOnlySkillSnapshotProbe(command: string): boolean {
  const payload = powerShellCommandPayload(command);
  if (!payload) return false;

  // Codex may read a selected Skill through this generated PowerShell shape in
  // order to emit both its line count and complete content. Keep the allowance
  // narrower than general PowerShell: one snapshot SKILL.md read, then two
  // outputs from the same local variable, with no pipeline or extra command.
  const probe = payload.match(
    /^['"]*\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Get-Content\s+(?:-Raw\s+)?-LiteralPath\s+['"]+([^'";\r\n]+)['"]+\s*;\s*['"]*\$\1\.Length\s*;\s*\$\1['"]*$/i,
  );
  return Boolean(probe?.[2] && isMekaSkillSnapshotEntrypoint(probe[2]));
}

function isReadOnlySkillSnapshotDirectRead(command: string): boolean {
  const wrappedPayload = powerShellCommandPayload(command);
  const payload =
    wrappedPayload?.startsWith('"') && wrappedPayload.endsWith('"')
      ? wrappedPayload.slice(1, -1).trim()
      : (wrappedPayload ?? command.trim());
  const probe = payload.match(/^\s*Get-Content(?:\s+-Raw)?\s+['"]([^'"\r\n]+)['"]\s*$/i);
  return Boolean(probe?.[1] && isMekaSkillSnapshotEntrypoint(probe[1]));
}

function isReadOnlySkillSnapshotLineCount(command: string): boolean {
  const payload = powerShellCommandPayload(command);
  if (!payload) return false;
  const batch = payload.match(
    /^['"]*\$paths\s*=\s*@\(([\s\S]*?)\)\s*;\s*foreach\s*\(\s*['"]*\$p\s+in\s+\$paths\s*\)\s*\{\s*if\s*\(\s*Test-Path\s+\$p\s*\)\s*\{\s*\$m\s*=\s*Get-Content\s+\$p\s*\|\s*Measure-Object\s+-Line\s*;\s*Write-Output\s+['"]*\$p`t\$\(\$m\.Lines\)['"]*\s*\}\s*\}['"]*$/i,
  );
  const pathList = batch?.[1];
  if (!pathList) return false;

  const paths: string[] = [];
  const remainder = pathList.replace(/['"]+([^'"\r\n]+)['"]+/g, (_match, candidate: string) => {
    paths.push(candidate);
    return '';
  });
  return (
    paths.length > 0 &&
    paths.length <= 32 &&
    /^[\s,]*$/.test(remainder) &&
    paths.every(isMekaSkillSnapshotEntrypoint)
  );
}

function isReadOnlySkillSnapshotCount(command: string): boolean {
  const payload = powerShellCommandPayload(command);
  if (!payload) return false;
  const probe = payload.match(
    /^['"]*\(\s*Get-Content\s+(?:-Raw\s+)?-LiteralPath\s+['"]+([^'";\r\n]+)['"]+\s*\)\.Count['"]*$/i,
  );
  return Boolean(probe?.[1] && isMekaSkillSnapshotEntrypoint(probe[1]));
}

function posixShellCommandPayload(command: string): string | null {
  const wrapper = command.match(
    /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|sh)\s+-(?:c|lc)\s+'([^'\r\n]*)'\s*$/i,
  );
  const payload = wrapper?.[1]?.trim();
  return payload || null;
}

function isStrictReadOnlyGitGrep(command: string): boolean {
  if (/[;&<>`\r\n]/.test(command) || /\$\(/.test(command)) return false;
  return /^git\s+grep(?:\s+(?:-n|-E|-I|-l|--full-name|--no-color|-C\s+(?:[0-9]|[1-3][0-9]|40)|--context=(?:[0-9]|[1-3][0-9]|40))){0,7}\s+(?:[A-Za-z0-9_.*+?^,:=\\/-]+|['"][A-Za-z0-9_.*+?^|()[\]{}\\,:=/-]+['"])\s+HEAD\s+--\s+(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+(?:\s+(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+)*$/i.test(
    command,
  );
}

function isStrictCombatServerReadOnlyExec(command: string): boolean {
  const payload = posixShellCommandPayload(command) ?? command.trim();
  if (/[;&<>`\r\n]/.test(payload) || /\$\(/.test(payload)) return false;
  if (isStrictReadOnlyGitGrep(payload)) return true;
  return (
    /^git\s+show\s+-s\s+--format=%H\s+HEAD$/i.test(payload) ||
    /^git\s+show\s+HEAD:(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+(?:\s+HEAD:(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+)*$/i.test(
      payload,
    ) ||
    /^git\s+status(?:\s+--short)?$/i.test(payload) ||
    /^git\s+diff(?:\s+--(?:stat|name-only|name-status))?(?:\s+--\s+(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+(?:\s+(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+)*)?$/i.test(
      payload,
    )
  );
}

function isCombatReadOnlyExec(
  command: string,
  workingDir: string,
  cwd?: string,
  cwdUnknown?: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const reviewOptions = {
    ...(cwd ? { cwd } : {}),
    ...(cwdUnknown ? { cwdUnknown: true } : {}),
    platform,
  };
  if (classifyShellCommand(command, [workingDir], reviewOptions) === 'auto-approve') return true;
  const posixPayload = posixShellCommandPayload(command);
  if (
    posixPayload &&
    (classifyShellCommand(posixPayload, [workingDir], reviewOptions) === 'auto-approve' ||
      isStrictReadOnlyGitGrep(posixPayload))
  )
    return true;
  if (
    isReadOnlySkillSnapshotDirectRead(command) ||
    isReadOnlySkillSnapshotProbe(command) ||
    isReadOnlySkillSnapshotLineCount(command) ||
    isReadOnlySkillSnapshotCount(command)
  )
    return true;
  const selectStringPayload = readOnlySelectStringPayload(command);
  if (!selectStringPayload) return false;
  const normalized = selectStringPayload.replace(/^select-string\b/i, 'grep');
  return classifyShellCommand(normalized, [workingDir], reviewOptions) === 'auto-approve';
}

function isTargetedCombatClientReadPath(
  context: HostToolExecutionContext,
  requestedPath: string,
): boolean {
  if (/[?*[\]]/.test(requestedPath)) return false;
  const baseDir =
    context.action.kind === 'exec' && context.action.cwd ? context.action.cwd : context.workingDir;
  const absolutePath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(baseDir, requestedPath);
  const unityRoot = combatUnityProjectRoot(context);
  if (!isPathInside(absolutePath, unityRoot) || isForbiddenCombatClientEvidence(absolutePath)) {
    return false;
  }
  const relative = path.relative(unityRoot, absolutePath).replace(/\\/g, '/').toLowerCase();
  if (!relative || relative.split('/').includes('..')) return false;
  if (/(?:^|\/)\.agents(?:\/|$)/.test(relative)) return false;
  return (
    relative === 'agents.md' ||
    (relative.startsWith('assets/scripts/hot/') && path.extname(relative) === '.cs') ||
    (relative.startsWith('assets/editor/skilleditor/common/') && path.extname(relative) === '.cs')
  );
}

function targetedSelectStringPath(command: string): string | null {
  const payload = exactPowerShellReadPayload(command);
  if (!/^Select-String\b/i.test(payload) || /[\r\n]/.test(payload)) return null;

  let singleQuoted = false;
  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index];
    if (char === "'") {
      if (singleQuoted && payload[index + 1] === "'") {
        index += 1;
        continue;
      }
      singleQuoted = !singleQuoted;
      continue;
    }
    if (!singleQuoted && /["`$;&|><(){}]/.test(char)) return null;
  }
  if (singleQuoted) return null;

  const optionPattern = /(?:^|\s)-(Path|LiteralPath|Pattern)\s+'((?:''|[^'])*)'/gi;
  const options = [...payload.matchAll(optionPattern)];
  const paths = options.filter((match) => /^(?:Path|LiteralPath)$/i.test(match[1] ?? ''));
  const patterns = options.filter((match) => /^Pattern$/i.test(match[1] ?? ''));
  if (paths.length !== 1 || patterns.length !== 1 || !paths[0]?.[2]) return null;

  const remainder = payload
    .replace(/^Select-String\b/i, '')
    .replace(optionPattern, ' ')
    .trim();
  if (
    remainder !== '' &&
    !/^(?:(?:-(?:SimpleMatch|CaseSensitive|List|AllMatches|Quiet|NoEmphasis))|(?:-Context\s+\d{1,3}\s*,\s*\d{1,3})|(?:-Encoding\s+(?:ascii|bigendianunicode|bigendianutf32|oem|unicode|utf7|utf8|utf8bom|utf8nobom|utf32)))(?:\s+(?=-)|\s*$)*$/i.test(
      remainder,
    )
  ) {
    return null;
  }
  return paths[0][2].replace(/''/g, "'");
}

function isTargetedCombatClientPowerShellRead(context: HostToolExecutionContext): boolean {
  if (context.action.kind !== 'exec') return false;
  const directReadPath = exactPowerShellReadPath(context.action.command);
  if (directReadPath && isTargetedCombatClientReadPath(context, directReadPath)) return true;
  const selectStringPath = targetedSelectStringPath(context.action.command);
  return Boolean(selectStringPath && isTargetedCombatClientReadPath(context, selectStringPath));
}

/**
 * Design documents are a read-only source, but bulk-reading them defeats the
 * combat workflow's evidence budget and can consume the entire context.
 * Keep targeted searches available while rejecting full-file/batch scans.
 */
function isBroadCombatDesignExplorationCommand(command: string): boolean {
  if (!/saga2_design/i.test(command)) return false;
  return (
    /Get-Content\b/i.test(command) ||
    /(?:-Recurse|Get-ChildItem\b[^\r\n]*(?:-Filter\s+\*\.md|-File\b))/i.test(command) ||
    /(?:Select-String\b[^\r\n]*-Path\s+[^\r\n]*\$files|foreach\s*\([^\r\n]*\$files)/i.test(command)
  );
}

function isBroadCombatSkillExplorationCommand(command: string): boolean {
  if (
    !/(?:saga2_unity[\\/]\.agents[\\/]skills|\.codex[\\/]plugins|\.claude[\\/]skills)/i.test(
      command,
    )
  )
    return false;
  if (
    /(?:\.agents[\\/]skills|\.codex[\\/]plugins|\.claude[\\/]skills)/i.test(command) &&
    /SKILL\.md/i.test(command)
  )
    return true;
  return /(?:Get-ChildItem|rg\s+--files|find\s+|dir\s+)[^\r\n]*(?:-Recurse|\.agents[\\/]skills)/i.test(
    command,
  );
}

function isBroadCombatWorkspaceEnumeration(command: string): boolean {
  return /(?:rg\s+--files|Get-ChildItem|dir\s+|find\s+)[^\r\n]*\b(?:saga2_unity|saga2_json)(?:\b|[\\/])/i.test(
    command,
  );
}

function isBroadCombatClientSearch(command: string): boolean {
  if (!/(?:^|\s)(?:rg|Select-String)\b/i.test(command)) return false;
  const normalized = command.replace(/\\/g, '/');
  return (
    /saga2_unity\/Assets(?:[\s'"]|$)/i.test(normalized) ||
    /saga2_unity\/Assets\/Editor\/SkillEditor\/Module(?:[\s'"]|$)/i.test(normalized)
  );
}

function isBroadCombatDesignReadPath(filePath: string | undefined): boolean {
  if (!filePath || !/saga2_design[\\/]/i.test(filePath)) return false;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/01-治理规范-governance/')) return true;
  return normalized.endsWith('/skill.md');
}

function isUnrelatedCombatSkillReadPath(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    /(?:^|\/)(?:\.agents\/skills|\.codex|\.claude)(?:\/|$)/.test(normalized) &&
    /(?:^|\/)skill\.md$/.test(normalized)
  );
}

function isForbiddenCombatClientEvidence(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.includes('/modulev2/') ||
    normalized.includes('modulev2') ||
    normalized.includes('module_v2') ||
    /(?:^|\/)skill_entry_model_editor\.json(?:$|[\s'";,])/i.test(normalized)
  );
}

function isKnownAgentsFileEnumeration(command: string): boolean {
  return (
    /(?:rg\s+--files|get-childitem|dir\s+|find\s+)[^\r\n]*\bagents\.md\b/i.test(command) ||
    /\bagents\.md\b[^\r\n]*(?:rg\s+--files|get-childitem|dir\s+|find\s+)/i.test(command)
  );
}

function isDisallowedCombatAgentsRead(command: string): boolean {
  if (!/\bAGENTS\.md\b/i.test(command)) return false;
  if (isKnownAgentsFileEnumeration(command)) return true;
  const normalized = command.replace(/[\\/]+/g, '/');
  return !/saga2_unity\/AGENTS\.md/i.test(normalized);
}

function exactPowerShellReadPayload(command: string): string {
  const wrapped = powerShellCommandPayload(command);
  if (!wrapped) return command.trim();
  return wrapped.startsWith('"') && wrapped.endsWith('"') ? wrapped.slice(1, -1).trim() : wrapped;
}

function exactPowerShellReadPath(command: string): string | null {
  const payload = exactPowerShellReadPayload(command);
  if (/[;|&<>`\r\n]/.test(payload)) return null;
  const normalizedPayload = payload.replace(/\\{2,}/g, '\\').trim();
  return (
    normalizedPayload.match(
      /^Get-Content(?:\s+-(?:Raw|LiteralPath)){0,2}\s+['"]([^'"]+)['"](?:\s+-Raw)?$/i,
    )?.[1] ?? null
  );
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function expectedLegacyModuleProtocolCodecPath(context: HostToolExecutionContext): string {
  return path.join(
    combatUnityProjectRoot(context),
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
}

function authoritativeCombatReadPathReason(context: HostToolExecutionContext): string | null {
  if (context.action.kind !== 'exec') return null;
  const requestedPath = exactPowerShellReadPath(context.action.command);
  if (!requestedPath) return null;
  const normalized = requestedPath.replace(/\\/g, '/').toLowerCase();
  const isUnityAgents = normalized.endsWith('/saga2_unity/agents.md');
  const isLegacyProtocol = normalized.endsWith(
    '/saga2_unity/assets/editor/skilleditor/common/editor/exporter/execute/impl/type/skillmoduleprotocolcodec.cs',
  );
  if (!isUnityAgents && !isLegacyProtocol) return null;
  const expectedPath = isUnityAgents
    ? path.join(combatUnityProjectRoot(context), 'AGENTS.md')
    : expectedLegacyModuleProtocolCodecPath(context);
  return sameResolvedPath(requestedPath, expectedPath)
    ? null
    : `战斗任务的权威客户端文件必须使用 Host 从当前 workingDir 解析的绝对路径 ${expectedPath}；不得缩短、猜测或改写目录。`;
}

function isKnownUnityAgentsRead(context: HostToolExecutionContext): boolean {
  const payload = exactPowerShellReadPayload(
    context.action.kind === 'exec' ? context.action.command : '',
  );
  if (isKnownAgentsFileEnumeration(payload)) return false;
  const requestedPath = exactPowerShellReadPath(payload);
  return Boolean(
    requestedPath &&
    sameResolvedPath(requestedPath, path.join(combatUnityProjectRoot(context), 'AGENTS.md')),
  );
}

function isKnownLegacyModuleProtocolCodecRead(context: HostToolExecutionContext): boolean {
  const requestedPath = exactPowerShellReadPath(
    context.action.kind === 'exec' ? context.action.command : '',
  );
  return Boolean(
    requestedPath &&
    sameResolvedPath(requestedPath, expectedLegacyModuleProtocolCodecPath(context)),
  );
}

function isCodexCodeModeContainer(command: string): boolean {
  const normalized = command.trim();
  return (
    /^(?:const|let)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*await\s+tools\.[A-Za-z0-9_]+\s*\(/.test(
      normalized,
    ) && /\btext\s*\(/.test(normalized)
  );
}

/**
 * Synchronous Codex exec guard. Native command approval and item-start events
 * cannot await the broader MCP policy, so this keeps combat Shell constrained
 * to the same target and evidence boundaries without changing other roles.
 */
export function evaluateCombatShellCommandExecution(
  context: HostToolExecutionContext,
): HostToolExecutionDecision {
  if (context.action.kind !== 'exec' || !isCombatToolPolicyActive(context)) {
    return { behavior: 'allow' };
  }
  if (isCombatServerWorkerPolicyActive(context)) {
    return isStrictCombatServerReadOnlyExec(context.action.command)
      ? { behavior: 'allow' }
      : deny(
          '战斗开发服务器 Worker 的 Shell 只允许单条 git show、git grep、git status 或 git diff 只读命令；禁止 rg、管道、重定向、命令串联和脚本写入。请缩小到当前原子能力的直接消费者。',
        );
  }

  const options = combatOptions(context.vendorOptions);
  const targetReason = combatSkillTargetReason(context);
  if (targetReason) return deny(targetReason);
  if (context.remoteHostId) {
    return deny('战斗开发主任务必须运行在本机 SAGA2 P4/Unity 工作区；服务器访问请使用 MCPRouter。');
  }
  // Codex Code Mode is surfaced as a commandExecution item even though this
  // JavaScript only orchestrates brokered tools. Each nested tool call reaches
  // this policy again with its real command/input, so do not classify the
  // container source itself as an operating-system shell command.
  if (isCodexCodeModeContainer(context.action.command)) return { behavior: 'allow' };
  if (isForbiddenCombatClientEvidence(context.action.command)) {
    return deny(
      '战斗配置流程完全不使用新模块编辑器相关实现或共享 skill_entry_model_editor.json。请只读取老版模块协议与当前技能的直接运行时消费者。',
    );
  }
  if (
    !hasCompletedCombatTargetExport(context) &&
    !hasAttemptedCombatTargetExport(context) &&
    !isCombatSkillEntrypointRead(context)
  ) {
    return deny(
      `第一条项目内容证据必须是老版模块编辑器对目标技能 ${text(options.mekaCombatTargetSkillId)} 的 legacy_module_export_json 结构化回执。导出前 Shell 只能读取已注入的总控 Skill。`,
    );
  }
  if (isBroadCombatDesignExplorationCommand(context.action.command)) {
    return deny(
      '战斗开发禁止批量或全文读取 saga2_design。请只针对当前未决业务规则做一次定向检索。',
    );
  }
  if (isBroadCombatSkillExplorationCommand(context.action.command)) {
    return deny('战斗开发禁止枚举或读取其它 Agent Skill；请使用已注入的总控 Skill。');
  }
  if (
    isBroadCombatWorkspaceEnumeration(context.action.command) ||
    isBroadCombatClientSearch(context.action.command)
  ) {
    return deny(
      '战斗开发禁止枚举或搜索整个客户端资产目录。请读取已知协议文件，或把检索限定到一个直接消费者目录。',
    );
  }
  if (isDisallowedCombatAgentsRead(context.action.command)) {
    return deny(
      '战斗任务路径和根规则已由 Host 注入；禁止枚举或读取工作区根 AGENTS.md。目标导出后只允许读取已知的 saga2_unity/AGENTS.md。',
    );
  }
  const authoritativeReadPathReason = authoritativeCombatReadPathReason(context);
  if (authoritativeReadPathReason) return deny(authoritativeReadPathReason);
  if (isKnownUnityAgentsRead(context)) return { behavior: 'allow' };
  if (isKnownLegacyModuleProtocolCodecRead(context)) {
    return { behavior: 'allow' };
  }
  if (isTargetedCombatClientPowerShellRead(context)) {
    return { behavior: 'allow' };
  }
  if (
    isCombatReadOnlyExec(
      context.action.command,
      context.workingDir,
      context.action.cwd,
      context.action.cwdUnknown,
    )
  ) {
    return { behavior: 'allow' };
  }
  return deny(
    '战斗开发的 Shell 只用于单条、可证明只读且范围明确的客户端证据查询。配置写入必须走 Meka P4、Meka Unity 官方 CLI 和老版模块编辑器入口。',
  );
}

function combatDiscoveryMcpReason(context: HostToolExecutionContext): string | null {
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (!target) return null;
  if (target.server === 'cindy_orca' && target.tool === 'get_workspace_info') {
    return '战斗任务的 projectRoot 与 unityClientRoot 已由 Host 注入；禁止调用 get_workspace_info。请直接使用注入路径。';
  }
  if (target.server === 'cindy' && (target.tool === 'ghost_info' || target.tool === 'ghost_list')) {
    return '战斗任务所需的 Meka Unity 与 Meka P4 已由角色配置直接暴露；禁止调用 ghost_info 或 ghost_list 重新发现插件。请直接调用目标工具。';
  }
  if (target.server === 'cindy' && target.tool === 'ghost_call') {
    const args = mcpToolArguments(context.input);
    if (text(args.tool) === 'list_tools') {
      return 'Meka Unity 和 Meka P4 没有战斗流程可用的动态 list_tools 入口。请直接按总控 Skill 调用 unity_inspect、unity_execute 或目标 P4 工具，不得重试工具发现。';
    }
  }
  if (target.tool === 'list_tools') {
    return '战斗任务禁止调用 list_tools 枚举能力。所需 Unity、P4、MCPRouter 和 Orca 接口已经直接暴露；请按总控 Skill 的固定证据顺序调用。';
  }
  return null;
}

function isRedundantCombatEnvironmentCheck(
  context: HostToolExecutionContext,
  options: CombatVendorOptions,
): boolean {
  if (!isCombatEnvironmentCheck(context)) return false;
  return (
    options.mekaCombatEnvironmentReady === true &&
    text(options.mekaCombatPhase) !== 'environment-recovery' &&
    text(options.mekaCombatServerCapabilityStatus) !== 'retry-required'
  );
}

function isTargetLegacyModuleExport(context: HostToolExecutionContext): boolean {
  const call = legacyModuleJsonCommand(context);
  if (!call || !/^legacy_module_export_json$/i.test(call.command)) return false;
  const target = text(combatOptions(context.vendorOptions).mekaCombatTargetSkillId);
  return Boolean(target && explicitCombatSkillIds(context).includes(target));
}

/**
 * Record target export evidence only after the transport has returned a
 * successful structured result. Preflight authorization is not evidence that
 * Unity actually exported the requested skill.
 */
export function markCombatTargetExportCompleted(context: HostToolExecutionContext): void {
  if (!isCombatWorkflowPolicyActive(context) || !isTargetLegacyModuleExport(context)) return;
  const options = combatOptions(context.vendorOptions);
  const target = text(options.mekaCombatTargetSkillId);
  refreshCombatTargetBinding(context.sessionId, target);
  options.mekaCombatTargetExportCompleted = true;
  completedTargetExportBySession.set(context.sessionId, target);
}

/** Record that the target export reached the Unity bridge, even when Unity
 * returned a structured failure (for example, no Pipeline instance). This
 * lets the lead preserve the failure evidence and continue independent
 * server-only review without treating the failed export as success. */
export function markCombatTargetExportAttempted(context: HostToolExecutionContext): void {
  if (!isCombatWorkflowPolicyActive(context) || !isTargetLegacyModuleExport(context)) return;
  const options = combatOptions(context.vendorOptions);
  const target = text(options.mekaCombatTargetSkillId);
  refreshCombatTargetBinding(context.sessionId, target);
  options.mekaCombatTargetExportAttempted = true;
  attemptedTargetExportBySession.set(context.sessionId, target);
}

function isUnityStatusInspection(context: HostToolExecutionContext): boolean {
  if (context.action.kind !== 'mcp') return false;
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server === 'meka-unity' && target.tool === 'unity_inspect') {
    return text(mcpToolArguments(context.input).action) === 'status';
  }
  if (target?.server === 'cindy' && target.tool === 'ghost_call') {
    const call = ghostUnityCall(context.input);
    return call?.tool === 'unity_inspect' && text(call.args.action) === 'status';
  }
  return false;
}

function unityStatusProjectPathReason(context: HostToolExecutionContext): string | null {
  if (!isUnityStatusInspection(context)) return null;
  const target = effectiveMcpTarget(context.toolName, context.input);
  const args =
    target?.server === 'cindy' && target.tool === 'ghost_call'
      ? ghostUnityCall(context.input)?.args
      : mcpToolArguments(context.input);
  const expectedProjectPath = combatUnityProjectRoot(context);
  const requestedProjectPath = text(args?.projectPath);
  return requestedProjectPath &&
    path.resolve(requestedProjectPath) === path.resolve(expectedProjectPath)
    ? null
    : `unity_inspect(action=status) 必须显式使用 Host 注入的 Unity 工程路径 ${expectedProjectPath}，避免连接到其它常驻 Unity 实例。`;
}

function isCombatSkillEntrypointRead(context: HostToolExecutionContext): boolean {
  if (context.action.kind === 'read') {
    const normalized = (context.action.path ?? '').replace(/\\/g, '/').toLowerCase();
    return normalized.endsWith('/combat-skill-configuration/skill.md');
  }
  return (
    context.action.kind === 'exec' &&
    (isReadOnlySkillSnapshotDirectRead(context.action.command) ||
      isReadOnlySkillSnapshotProbe(context.action.command))
  );
}

function combatServerDispatchRequest(context: HostToolExecutionContext): {
  kind: 'create_worker' | 'send_to_worker';
  task: string;
  requestedWorkerRef?: string;
  remoteHostId?: string;
  workerAgent?: 'claude-code' | 'codex';
} | null {
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (
    target?.server !== 'cindy_orca' ||
    (target.tool !== 'create_worker' && target.tool !== 'send_to_worker')
  ) {
    return null;
  }
  const args = mcpToolArguments(context.input);
  const task = text(args.initial_task) || text(args.message) || text(args.task);
  const remoteHostId = text(args.remote_host_id);
  const requestedWorkerAgent = text(args.agent);
  if (
    target.tool === 'create_worker' &&
    requestedWorkerAgent !== 'claude-code' &&
    requestedWorkerAgent !== 'codex'
  ) {
    return null;
  }
  const workerAgent =
    requestedWorkerAgent === 'claude-code' || requestedWorkerAgent === 'codex'
      ? requestedWorkerAgent
      : undefined;
  if (
    !isModuleFirstCombatServerExplorationTask(task) ||
    (target.tool === 'create_worker' && !remoteHostId.startsWith('mcpr:'))
  ) {
    return null;
  }
  return {
    kind: target.tool,
    task,
    ...(target.tool === 'create_worker'
      ? { remoteHostId, workerAgent }
      : { requestedWorkerRef: text(args.target_session_id) }),
  };
}

function looksLikeCombatServer(instance: MekaRouterInstance): boolean {
  return /server|服务器|saga2[-_ ]?server/i.test(
    `${instance.projectName} ${instance.projectDescription ?? ''}`,
  );
}

async function authorizeCombatServerDispatch(
  context: HostToolExecutionContext,
  dispatch: NonNullable<ReturnType<typeof combatServerDispatchRequest>>,
): Promise<string | null> {
  const remoteHostId =
    dispatch.kind === 'create_worker'
      ? dispatch.remoteHostId
      : getTrustedCombatServerWorkerRemoteHost(context.sessionId, dispatch.requestedWorkerRef);
  const instanceId = parseMcprRemoteHostId(remoteHostId);
  if (!instanceId) return null;

  const router = getMekaRouterService();
  const [bindings, instances] = await Promise.all([
    router.listProjectBindings('saga2'),
    router.listInstances(),
  ]);
  const instance = instances.find((candidate) => candidate.id === instanceId);
  if (!bindings.includes(instanceId) || !instance?.available || !looksLikeCombatServer(instance)) {
    return null;
  }
  if (dispatch.kind === 'create_worker') {
    const expectedRemoteHostId = text(context.vendorOptions.mekaCombatServerRemoteHostId);
    const expectedWorkerAgent = text(context.vendorOptions.mekaCombatServerWorkerAgent);
    const actualWorkerAgent = instance.agentType === 'claude' ? 'claude-code' : instance.agentType;
    if (
      remoteHostId !== expectedRemoteHostId ||
      dispatch.workerAgent !== expectedWorkerAgent ||
      dispatch.workerAgent !== actualWorkerAgent
    ) {
      return null;
    }
  }
  if (instance.agentType === 'claude') await probeRemoteClaudeCapability(instanceId);
  else if (instance.agentType === 'codex') await probeRemoteCodexCapability(instanceId);
  else return null;
  return remoteHostId ?? null;
}

async function beginAuthorizedCombatServerDispatch(
  context: HostToolExecutionContext,
  dispatch: NonNullable<ReturnType<typeof combatServerDispatchRequest>>,
): Promise<boolean> {
  const remoteHostId = await authorizeCombatServerDispatch(context, dispatch);
  if (!remoteHostId) return false;
  return beginCombatServerCapabilityDispatch({
    leadSessionId: context.sessionId,
    vendorOptions: context.vendorOptions,
    ...dispatch,
    remoteHostId,
  });
}

function isUnscopedServerExplorationRequest(context: HostToolExecutionContext): boolean {
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (
    target?.server !== 'cindy_orca' ||
    (target.tool !== 'create_worker' && target.tool !== 'send_to_worker')
  ) {
    return false;
  }
  const args = mcpToolArguments(context.input);
  const task = text(args.initial_task) || text(args.message) || text(args.task);
  return isCombatServerExplorationTask(task) && !isModuleFirstCombatServerExplorationTask(task);
}

function orcaExplorationInfrastructure(context: HostToolExecutionContext): boolean {
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server !== 'cindy_orca') return false;
  return (
    /^(?:get_|list_|start_team$)/i.test(target.tool) ||
    combatServerDispatchRequest(context) !== null
  );
}

function isServerCapabilityReportValidation(context: HostToolExecutionContext): boolean {
  if (context.action.kind !== 'mcp') return false;
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server !== 'mcp_router') return false;
  if (target.tool === 'validate_server_capability_report') return true;
  return (
    target.tool === 'call_tool' &&
    progressiveInnerCall(context.input)?.name === 'validate_server_capability_report'
  );
}

function isCombatEnvironmentCheck(context: HostToolExecutionContext): boolean {
  if (context.action.kind !== 'mcp') return false;
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server !== 'mcp_router') return false;
  if (target.tool === 'check_combat_environment') return true;
  return (
    target.tool === 'call_tool' &&
    progressiveInnerCall(context.input)?.name === 'check_combat_environment'
  );
}

function isBatchedWorkerCreation(context: HostToolExecutionContext): boolean {
  const target = effectiveMcpTarget(context.toolName, context.input);
  return target?.server === 'cindy_orca' && target.tool === 'create_workers';
}

async function refreshEnvironment(
  options: CombatVendorOptions,
  updateLocalState = true,
): Promise<CombatEnvironmentGateResult> {
  const router = getMekaRouterService();
  const gate = await runCombatEnvironmentGate({
    p4: await getMekaP4SettingsService().get(),
    listInstances: () => router.listInstances(),
    listProjectBindings: (projectId) => router.listProjectBindings(projectId),
    probeRemoteCodexCapability,
    projectId: 'saga2',
  });
  if (updateLocalState) {
    options.mekaCombatEnvironmentReady = gate.ready;
    options.mekaCombatEnvironmentChecks = combatEnvironmentAvailability(gate);
    options.mekaCombatPhase = gate.ready ? 'execution' : 'environment-recovery';
  }
  return gate;
}

function deny(reason: string): HostToolExecutionDecision {
  return { behavior: 'deny', reason };
}

function shouldBoundLeadEvidence(context: HostToolExecutionContext): boolean {
  const options = combatOptions(context.vendorOptions);
  if (options.mekaCombatPlanApproved === true) return false;
  if (text(options.mekaCombatPhase) === 'execution') return false;
  return options.mekaCombatEnvironmentReady === true;
}

function leadEvidenceBudgetDecision(
  context: HostToolExecutionContext,
): HostToolExecutionDecision | null {
  if (!shouldBoundLeadEvidence(context)) return null;
  const budget = consumeCombatLeadEvidenceBudget(context.sessionId);
  if (budget.allowed) return null;
  return deny(
    `本地战斗 Lead 已达到最多 ${COMBAT_LEAD_EVIDENCE_READ_LIMIT} 次只读证据调用。请停止搜索，基于已有证据输出当前技能的业务结论；证据不足时标记无法保证或 uncertain，不得重复读取或改用其它技能。`,
  );
}

export async function evaluateCombatToolExecution(
  context: HostToolExecutionContext,
): Promise<HostToolExecutionDecision> {
  if (!isCombatToolPolicyActive(context)) return { behavior: 'allow' };
  const options = combatOptions(context.vendorOptions);
  if (isCombatServerWorkerPolicyActive(context)) {
    if (context.action.kind === 'session-state') {
      return { behavior: 'allow' };
    }
    if (context.action.kind === 'read') {
      return deny(
        '战斗开发服务器 Worker 只能通过单条 git show、git grep、git status 或 git diff 查询当前 HEAD；禁止 Read/文件读取工具，包括读取 Claude 自动保存的超长工具输出。请缩窄 git grep 后直接读取其返回的真实路径。',
      );
    }
    if (context.action.kind === 'exec') {
      if (isStrictCombatServerReadOnlyExec(context.action.command)) {
        const budget = consumeCombatServerWorkerReadBudget(context.sessionId);
        if (!budget.allowed) {
          return deny(
            '服务器 Worker 已达到本轮最多 6 次只读证据调用。请停止搜索，基于已有证据输出唯一的 serverCapabilityReport JSON；证据不足时使用 uncertain，不得继续调用工具。',
          );
        }
        return { behavior: 'allow' };
      }
    }
    return deny(
      '战斗开发服务器 Worker 永久只读，仅允许单条 git show、git grep、git status 或 git diff 查询。终态报告必须作为本轮唯一最终回复，由 Orca auto-bridge 回传；禁止 Read、orca_worker_bridge 和其它 MCP，禁止修改文件、创建分支、改 Excel或生成文件。',
    );
  }
  if (context.action.kind !== 'session-state') {
    const targetReason = combatSkillTargetReason(context);
    if (targetReason) return deny(targetReason);
    const jsonPathReason = legacyModuleJsonPathReason(context);
    if (jsonPathReason) return deny(jsonPathReason);
  }
  if (context.remoteHostId) {
    return deny('战斗开发主任务必须运行在本机 SAGA2 P4/Unity 工作区；服务器访问请使用 MCPRouter。');
  }

  if (isPlanningMutation(context)) {
    return deny(
      '当前任务暂不允许修改 saga2_design/planning。该目录仅作为只读需求来源；请把需要调整的内容记录到 Cindy 审查文档，实施面限定在 saga2_unity、Cindy 或 Cindy 插件。',
    );
  }

  // Startup recovery is owned by the Meka Unity plugin. Its tool contract
  // requires the Agent to obtain explicit user agreement before calling open.
  // Keep this environment action available before the combat plan is approved.
  if (isUnityOpenRequest(context)) return { behavior: 'allow' };

  if (context.action.kind === 'session-state') {
    return { behavior: 'allow' };
  }
  if (context.action.kind === 'mcp') {
    const discoveryReason = combatDiscoveryMcpReason(context);
    if (discoveryReason) return deny(discoveryReason);
    if (isRedundantCombatEnvironmentCheck(context, options)) {
      return deny(
        'Host 启动门禁已确认当前 P4、Unity CLI 与 MCPRouter 环境 ready；禁止立即重复调用 check_combat_environment。只有真实传输失败进入 environment-recovery，或服务器 Worker 标记 retry-required 后才复检。',
      );
    }
    if (
      isEnvironmentRecoveryMcp(context) &&
      (options.mekaCombatEnvironmentReady !== true ||
        text(options.mekaCombatPhase) === 'environment-recovery' ||
        text(options.mekaCombatServerCapabilityStatus) === 'retry-required')
    ) {
      return { behavior: 'allow' };
    }
  }
  if (
    context.action.kind === 'exec' &&
    isEnvironmentDiagnosticCommand(context.action.command) &&
    (options.mekaCombatEnvironmentReady !== true ||
      text(options.mekaCombatPhase) === 'environment-recovery')
  ) {
    return { behavior: 'allow' };
  }
  const requestedEvidence =
    context.action.kind === 'read'
      ? context.action.path
      : context.action.kind === 'exec'
        ? context.action.command
        : context.action.kind === 'file-write'
          ? context.action.path
          : undefined;
  if (isForbiddenCombatClientEvidence(requestedEvidence)) {
    return deny(
      '战斗配置流程完全不使用 ModuleV2 或共享 skill_entry_model_editor.json。请只通过老版模块编辑器对当前技能执行 legacy_module_export_json / legacy_module_import_json，并读取最窄的运行时消费者。',
    );
  }
  const statusProjectPathReason = unityStatusProjectPathReason(context);
  if (statusProjectPathReason) return deny(statusProjectPathReason);
  const targetExport = isTargetLegacyModuleExport(context);
  if (
    !hasCompletedCombatTargetExport(context) &&
    !hasAttemptedCombatTargetExport(context) &&
    !targetExport &&
    !isUnityStatusInspection(context) &&
    !isCombatSkillEntrypointRead(context)
  ) {
    return deny(
      `第一条项目内容证据必须是老版模块编辑器对目标技能 ${text(options.mekaCombatTargetSkillId)} 的 legacy_module_export_json 结构化回执。导出尝试前只允许读取已注入的总控 Skill 和调用 unity_inspect(action=status)；不得读取 AGENTS、客户端源码、资产目录、参考技能或服务器。`,
    );
  }
  const dependency = combatToolDependency(context);
  const dependencyReason = dependency ? blockedDependencyReason(options, dependency) : null;
  if (dependencyReason) return deny(dependencyReason);
  const serverCapabilityStatus = text(options.mekaCombatServerCapabilityStatus);
  if (
    serverCapabilityStatus === 'dispatching' ||
    serverCapabilityStatus === 'pending' ||
    serverCapabilityStatus === 'report-ready' ||
    serverCapabilityStatus === 'retry-required'
  ) {
    if (isCombatEnvironmentCheck(context)) return { behavior: 'allow' };
    if (
      serverCapabilityStatus === 'report-ready' &&
      isServerCapabilityReportValidation(context) &&
      hasTrustedCombatServerCapabilityReport(context.sessionId)
    ) {
      return { behavior: 'allow' };
    }
    if (serverCapabilityStatus === 'retry-required') {
      const retry = combatServerDispatchRequest(context);
      if (retry) {
        try {
          if (await beginAuthorizedCombatServerDispatch(context, retry)) {
            return { behavior: 'allow' };
          }
        } catch {
          options.mekaCombatEnvironmentReady = false;
          resetCombatServerCapabilityFlow({
            leadSessionId: context.sessionId,
            vendorOptions: context.vendorOptions,
            phase: 'environment-recovery',
          });
          return deny('MCPR 目标能力复检失败，已回到环境恢复阶段；请重新检查三条环境链路。');
        }
      }
    }
    return deny(
      serverCapabilityStatus === 'report-ready'
        ? 'Host 已收到服务器 Worker 的 auto-bridge 终态报告。只能原样调用 validate_server_capability_report；不得改写或代写报告。'
        : serverCapabilityStatus === 'retry-required'
          ? '服务器 Worker 派发或报告回传未完成。请重新调用 check_combat_environment；环境 ready 后重新派发带只读标记的 MCPR Worker，不得绕过服务器核查继续实施。'
          : '服务器只读 Worker 正在派发或运行。立即结束当前回合并等待 Orca auto-bridge 自动回传；等待期间禁止继续探索或主动轮询。若 MCPR 断开，可直接调用 check_combat_environment 回到环境恢复。',
    );
  }
  if (context.action.kind === 'mcp' && isBatchedWorkerCreation(context)) {
    return deny(
      'SAGA2 服务器能力核查必须使用单个带只读标记的 MCPR create_worker 或已有 Worker 的 send_to_worker；禁止用 create_workers 绕过 Host 可信回执状态。',
    );
  }
  if (context.action.kind === 'mcp' && isUnscopedServerExplorationRequest(context)) {
    return deny(
      `服务器能力核查必须先完成 ${COMBAT_MODULE_FIRST_MARKER} 模块优先取证：记录当前目标技能的老版导出回执（现有模块图或明确不存在）、协议字段和原子能力矩阵，并只把剩余服务器语义作为核查问题；不得读取其它技能或用“没有完整专用函数”替代模块组合判断。`,
    );
  }
  if (context.action.kind === 'read') {
    if (isBroadCombatDesignReadPath(context.action.path)) {
      return deny(
        '战斗开发禁止读取 saga2_design 治理长文档或整份策划 Skill。请只读取当前业务缺口对应的具体语义文件；证据不足时停止探索并交付业务结论。',
      );
    }
    if (isUnrelatedCombatSkillReadPath(context.action.path)) {
      return deny(
        '战斗开发禁止读取其它 Agent Skill。已注入的 combat-skill-configuration 是唯一总控 Skill；请直接导出目标技能并读取当前配置、客户端消费者或服务器窄语义。',
      );
    }
    return leadEvidenceBudgetDecision(context) ?? { behavior: 'allow' };
  }
  if (context.action.kind === 'exec') {
    if (isBroadCombatDesignExplorationCommand(context.action.command)) {
      return deny(
        '战斗开发禁止批量或全文读取 saga2_design。请只针对当前未决业务规则做一次定向检索；证据不足时停止探索并按可实现、无法保证、待确认业务选择交付。',
      );
    }
    if (isBroadCombatSkillExplorationCommand(context.action.command)) {
      return deny(
        '战斗开发禁止递归枚举项目 Skill 或读取外部 Skill 文档。请使用已注入的战斗 Skill，并直接读取当前配置/消费者的最小证据。',
      );
    }
    if (isBroadCombatWorkspaceEnumeration(context.action.command)) {
      return deny(
        '战斗开发禁止枚举整个客户端或配置仓库。请针对当前技能的文件、字段或消费者做精确检索，证据不足时直接交付业务结论。',
      );
    }
    if (isBroadCombatClientSearch(context.action.command)) {
      return deny(
        '战斗开发禁止搜索整个客户端资产目录或编辑器实现目录。请读取已知的老版协议文件，或把检索限定到一个直接运行时消费者目录。',
      );
    }
    if (isDisallowedCombatAgentsRead(context.action.command)) {
      return deny(
        '战斗任务的路径和根规则已经由 Host 注入。禁止枚举或读取工作区根 AGENTS.md；目标技能导出后只读取已知的 saga2_unity/AGENTS.md。',
      );
    }
    if (
      isCombatReadOnlyExec(
        context.action.command,
        context.workingDir,
        context.action.cwd,
        context.action.cwdUnknown,
      ) ||
      isTargetedCombatClientPowerShellRead(context)
    )
      return leadEvidenceBudgetDecision(context) ?? { behavior: 'allow' };
  }
  if (context.action.kind === 'mcp') {
    try {
      if (await isReadOnlyMcpCall(context)) {
        return leadEvidenceBudgetDecision(context) ?? { behavior: 'allow' };
      }
    } catch {
      options.mekaCombatEnvironmentReady = false;
      resetCombatServerCapabilityFlow({
        leadSessionId: context.sessionId,
        vendorOptions: context.vendorOptions,
        phase: 'environment-recovery',
      });
      return deny('MCPRouter 只读探查失败，已回到环境恢复阶段；请重新检查 P4、Unity CLI 和 MCPR。');
    }
    const target = effectiveMcpTarget(context.toolName, context.input);
    if (target?.server === 'mcp_router') {
      return deny(
        '战斗开发中的 MCPRouter 只允许环境恢复和只读查询；服务器修改、服务管理或其它有副作用的 Router 调用必须停止并交给服务器程序。',
      );
    }
    if (target?.server === 'cindy_orca') {
      const dispatch = combatServerDispatchRequest(context);
      if (dispatch) {
        try {
          if (await beginAuthorizedCombatServerDispatch(context, dispatch)) {
            return { behavior: 'allow' };
          }
        } catch {
          options.mekaCombatEnvironmentReady = false;
          resetCombatServerCapabilityFlow({
            leadSessionId: context.sessionId,
            vendorOptions: context.vendorOptions,
            phase: 'environment-recovery',
          });
          return deny('MCPR 目标能力复检失败，已回到环境恢复阶段；请重新检查三条环境链路。');
        }
        return deny(
          '服务器核查 Worker 必须位于当前 SAGA2 已绑定、在线且 capability-ready 的 MCPR 服务器实例；已有 Worker 只有在本任务中经过 Host 验证后才能复用。',
        );
      }
      if (orcaExplorationInfrastructure(context)) return { behavior: 'allow' };
      return deny(
        '战斗开发禁止创建本地 Worker、批量 Worker 或执行未识别的 Orca 变更；服务器核查只能使用 Host 验证的单个只读 MCPR Worker。',
      );
    }
  }
  if (context.action.kind === 'network' && options.mekaCombatEnvironmentReady === true) {
    return { behavior: 'allow' };
  }

  if (serverCapabilityStatus !== 'supported') {
    return deny(
      '当前技能尚未取得 Host 验证的服务器 supported 回执，只允许当前技能导出、客户端只读取证、环境恢复和只读 MCPR Worker 派发。完成 auto-bridge 回传并调用 validate_server_capability_report 前，禁止 P4 写入、资产创建、老版模块导入及其它实施操作；历史结论或本地代码不能替代当前远端 HEAD。',
    );
  }

  if (
    options.mekaCombatPlanApproved !== true &&
    options.mekaCombatExecutionMode !== 'autonomous-user-request'
  ) {
    return deny('战斗开发仍处于只读探索/澄清/方案阶段。请通过方案审批后再执行写操作。');
  }
  if (
    options.mekaCombatServerCapabilityStatus === 'unsupported' ||
    options.mekaCombatServerCapabilityStatus === 'uncertain'
  ) {
    return deny(
      '当前操作依赖的服务器能力尚不支持或证据不确定，因此只阻止本次实施调用。请按服务器能力报告完成程序交接或补齐证据；不涉及该缺口的探索和方案工作仍可继续。',
    );
  }
  if (dependency) {
    await refreshEnvironment(options);
    const refreshedReason = blockedDependencyReason(options, dependency);
    if (refreshedReason) return deny(refreshedReason);
  }
  return { behavior: 'allow' };
}
