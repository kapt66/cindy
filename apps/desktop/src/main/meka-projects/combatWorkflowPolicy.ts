import {
  classifyShellCommand,
  type HostToolExecutionContext,
  type HostToolExecutionDecision,
} from '@cindy/maker-core';

import { runCombatEnvironmentGate } from './combatEnvironmentGate.js';
import {
  beginCombatServerCapabilityDispatch,
  COMBAT_MODULE_FIRST_MARKER,
  getTrustedCombatServerWorkerRemoteHost,
  hasTrustedCombatServerCapabilityReport,
  isModuleFirstCombatServerExplorationTask,
  isCombatServerExplorationTask,
  resetCombatServerCapabilityFlow,
} from './combatServerCapabilityState.js';
import { parseMcprRemoteHostId, type MekaRouterInstance } from '../../shared/meka-router.js';
import { getMekaP4SettingsService, getMekaRouterService } from '../meka-settings/ipc.js';
import { probeRemoteCodexCapability } from '../maker-host/mcpr-codex-capability.js';

const WORKFLOW = 'saga2-combat-development-v1';
const SERVER_WORKER_WORKFLOW = 'saga2-combat-server-worker-v1';
const READ_ONLY_MCP_TOOL_NAMES =
  /^(?:check_|get_|list_|read_|search_|find_|inspect_|query_|validate_|describe_|status$)/i;
const READ_ONLY_CUSTOM_FUNCTIONS =
  /^(?:get_|list_|read_|search_|find_|inspect_|query_|validate_|describe_)/i;
const READ_ONLY_UNITY_EDITOR_ACTIONS = new Set([
  'telemetry_ping',
  'get_status',
  'get_current_context',
]);
const READ_ONLY_ROUTER_CONTROL_TOOLS = new Set([
  'mcp_list_instances',
  'mcp_instance_tools',
  'mcp_list_servers',
  'mcp_list_resources',
]);

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
  mekaCombatPlanApproved?: unknown;
  mekaCombatPhase?: unknown;
  mekaCombatServerCapabilityStatus?: unknown;
};

function combatOptions(value: Record<string, unknown>): CombatVendorOptions {
  return value as CombatVendorOptions;
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
  const changeMode = fields.get('changeMode') ?? '';
  const invalidFields = required.filter((field) => {
    const value = fields.get(field) ?? '';
    if (!value) return false;
    if (field === 'remainingUnknowns' && /^(?:none|无)$/i.test(value)) return false;
    return PLACEHOLDER_VALUE.test(value) || /^<.*>$/.test(value);
  });
  const invalidTarget =
    invalidFields.includes('targetSkillId') || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(target);
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
        '方案尚未满足 SAGA2 战斗开发审批契约。请补充 [SAGA2_COMBAT_SOLUTION] 回执：targetSkillId 必须是用户确认的具体 ID，changeMode 必须是 create/rebuild/incremental，surfaces 必须列出实际实现面，moduleEvidence 必须引用 skill-entry-model 节点/字段，capabilityMatrix 必须逐项列出原子能力结论，evidence、validation 和 remainingUnknowns 不能使用占位内容。',
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

function mcpParts(toolName: string): { server: string; tool: string } | null {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.slice(5).split('__');
    return parts.length >= 2 ? { server: parts[0]!, tool: parts.slice(1).join('__') } : null;
  }
  if (toolName.startsWith('mcp:')) return { server: toolName.slice(4), tool: '' };
  return null;
}

function effectiveMcpTarget(
  toolName: string,
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
  if (tool === 'manage_editor') {
    const outer = record(input);
    return READ_ONLY_UNITY_EDITOR_ACTIONS.has(text(outer?.action));
  }
  if (tool !== 'execute_custom_tool') return false;
  const outer = record(input);
  const parameters = record(outer?.parameters);
  return READ_ONLY_CUSTOM_FUNCTIONS.test(text(parameters?.function));
}

async function isRouterReadOnly(projectId: string, tool: string, input: unknown): Promise<boolean> {
  if (tool === 'check_combat_environment' || tool.startsWith('list_'))
    return true;
  if (tool !== 'call_tool') return false;
  const inner = progressiveInnerCall(input);
  if (!inner) return false;
  if (READ_ONLY_ROUTER_CONTROL_TOOLS.has(inner.name)) return true;
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
    return text(args.ghost_id) === 'meka-p4' && text(args.tool) === 'p4_status';
  }
  if (target.server === 'unity-editor') return isUnityReadOnly(target.tool, context.input);
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
      'list_tools',
      'list_project_remote_instances',
      'list_remote_instances',
      'list_remote_project_templates',
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
  return /\/meka-skill-snapshots\/revisions\/[a-f0-9]{32,256}\/claude-plugin\/skills\/[a-z0-9-]+\/SKILL\.md$/i.test(
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
    classifyShellCommand(posixPayload, [workingDir], reviewOptions) === 'auto-approve'
  )
    return true;
  if (
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

function combatServerDispatchRequest(context: HostToolExecutionContext): {
  kind: 'create_worker' | 'send_to_worker';
  task: string;
  requestedWorkerRef?: string;
  remoteHostId?: string;
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
  if (target.tool === 'create_worker' && text(args.agent) !== 'codex') return null;
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
      ? { remoteHostId }
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
      : getTrustedCombatServerWorkerRemoteHost(
          context.sessionId,
          dispatch.requestedWorkerRef,
        );
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
  await probeRemoteCodexCapability(instanceId);
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
  return /^(?:get_|list_|start_team$)/i.test(target.tool) || combatServerDispatchRequest(context) !== null;
}

function isServerWorkerReportBridge(context: HostToolExecutionContext): boolean {
  if (context.action.kind !== 'mcp') return false;
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server !== 'orca_worker_bridge' || target.tool !== 'send_to_lead') return false;
  const args = mcpToolArguments(context.input);
  return Boolean(text(args.worker_id) && text(args.message));
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
): Promise<boolean> {
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
    options.mekaCombatPhase = gate.ready ? 'execution' : 'environment-recovery';
  }
  return gate.ready;
}

function deny(reason: string): HostToolExecutionDecision {
  return { behavior: 'deny', reason };
}

export async function evaluateCombatToolExecution(
  context: HostToolExecutionContext,
): Promise<HostToolExecutionDecision> {
  if (!isCombatToolPolicyActive(context)) return { behavior: 'allow' };
  const options = combatOptions(context.vendorOptions);
  if (isCombatServerWorkerPolicyActive(context)) {
    if (context.action.kind === 'session-state' || context.action.kind === 'read') {
      return { behavior: 'allow' };
    }
    if (context.action.kind === 'exec') {
      if (
        isCombatReadOnlyExec(
          context.action.command,
          context.workingDir,
          context.action.cwd,
          context.action.cwdUnknown,
          'linux',
        )
      )
        return { behavior: 'allow' };
    }
    if (isServerWorkerReportBridge(context)) return { behavior: 'allow' };
    return deny(
      '战斗开发服务器 Worker 永久只读，仅允许文件读取、Host 可证明只读的命令，以及精确的 orca_worker_bridge.send_to_lead 报告回传；禁止修改文件、创建分支、改 Excel、生成文件或调用其它 MCP。能力不足时请停止并返回程序实现报告。',
    );
  }
  if (context.remoteHostId) {
    return deny('战斗开发主任务必须运行在本机 SAGA2 P4/Unity 工作区；服务器访问请使用 MCPRouter。');
  }

  if (context.action.kind === 'session-state') {
    return { behavior: 'allow' };
  }
  if (options.mekaWorkflow !== WORKFLOW || options.mekaCombatEnvironmentReady !== true) {
    if (context.action.kind === 'mcp' && isEnvironmentRecoveryMcp(context)) {
      return { behavior: 'allow' };
    }
    if (context.action.kind === 'exec' && isEnvironmentDiagnosticCommand(context.action.command)) {
      return { behavior: 'allow' };
    }
    return deny(
      '这是 Host 的战斗环境恢复阶段限制，不是用户拒绝或授权不足。不得加载 Skill/AGENTS.md、读取业务文件、扫描工具全集或换 sandbox_permissions 重试。只允许统一环境复检和必要的安全实例投影；报告恢复步骤后结束回合。',
    );
  }
  if (
    options.mekaCombatServerCapabilityStatus === 'unsupported' ||
    options.mekaCombatServerCapabilityStatus === 'uncertain'
  ) {
    return deny(
      '服务器能力核查已要求程序介入。当前战斗开发实现必须停止，只向用户返回简短程序交接报告；不得继续读取或修改客户端、配置或服务器内容。',
    );
  }
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
      `服务器能力核查必须先完成 ${COMBAT_MODULE_FIRST_MARKER} 模块优先取证：读取 skill-entry-model 模块图/导出与同类配置，列出原子能力矩阵，并只把剩余服务器语义作为核查问题；不得用“没有完整专用函数”替代模块组合判断。`,
    );
  }
  if (context.action.kind === 'read') return { behavior: 'allow' };
  if (context.action.kind === 'exec') {
    if (
      isCombatReadOnlyExec(
        context.action.command,
        context.workingDir,
        context.action.cwd,
        context.action.cwdUnknown,
      )
    )
      return { behavior: 'allow' };
  }
  if (context.action.kind === 'mcp') {
    try {
      if (await isReadOnlyMcpCall(context)) return { behavior: 'allow' };
    } catch {
      options.mekaCombatEnvironmentReady = false;
      resetCombatServerCapabilityFlow({
        leadSessionId: context.sessionId,
        vendorOptions: context.vendorOptions,
        phase: 'environment-recovery',
      });
      return deny('MCPRouter 只读探查失败，已回到环境恢复阶段；请重新检查 P4、UnityMCP 和 MCPR。');
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

  if (options.mekaCombatPlanApproved !== true) {
    return deny('战斗开发仍处于只读探索/澄清/方案阶段。请通过方案审批后再执行写操作。');
  }
  if (!(await refreshEnvironment(options))) {
    return deny('P4、UnityMCP 或 MCPRouter 环境复检失败，已回到环境恢复阶段；恢复三项后重新检查。');
  }
  return { behavior: 'allow' };
}
