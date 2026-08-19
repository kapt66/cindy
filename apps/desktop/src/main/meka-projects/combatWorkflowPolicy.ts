import {
  classifyShellCommand,
  type HostToolExecutionContext,
  type HostToolExecutionDecision,
} from '@cindy/maker-core';

import { runCombatEnvironmentGate } from './combatEnvironmentGate.js';
import { getMekaP4SettingsService, getMekaRouterService } from '../meka-settings/ipc.js';
import { probeRemoteCodexCapability } from '../maker-host/mcpr-codex-capability.js';

const WORKFLOW = 'saga2-combat-development-v1';
const SERVER_WORKER_WORKFLOW = 'saga2-combat-server-worker-v1';
const SERVER_EXPLORATION_MARKER = '[SAGA2_SERVER_EXPLORATION_READ_ONLY]';
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const approvedLeadSessions = new Map<string, number>();
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
  mekaCombatServerReceiptRequired?: unknown;
  mekaCombatServerReceiptValidated?: unknown;
  orcaLeadSessionId?: unknown;
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

function pruneApprovals(now = Date.now()): void {
  for (const [sessionId, approvedAt] of approvedLeadSessions) {
    if (now - approvedAt > APPROVAL_TTL_MS) approvedLeadSessions.delete(sessionId);
  }
}

function approvedLeadSession(options: CombatVendorOptions): boolean {
  pruneApprovals();
  const leadSessionId = text(options.orcaLeadSessionId);
  return Boolean(leadSessionId && approvedLeadSessions.has(leadSessionId));
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
  const surfaces = context.plan?.match(/^surfaces:\s*(.+)$/im)?.[1] ?? '';
  const needsServer = /server|服务器/i.test(surfaces);
  options.mekaCombatServerReceiptRequired = needsServer;
  options.mekaCombatServerReceiptValidated = !needsServer;
  if (context.sessionId) {
    pruneApprovals();
    approvedLeadSessions.set(context.sessionId, Date.now());
  }
}

/** Test and account-boundary helper; approvals are intentionally process-local. */
export function resetCombatPlanApprovals(): void {
  approvedLeadSessions.clear();
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
  const invalidSurfaces =
    !/(?:^|[\s,，/+|])(?:module|timeline|table|export|client|server)(?:$|[\s,，/+|])/i.test(
      surfaces,
    );
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
        '方案尚未满足 SAGA2 战斗开发审批契约。请补充 [SAGA2_COMBAT_SOLUTION] 回执：targetSkillId 必须是用户确认的具体 ID，changeMode 必须是 create/rebuild/incremental，surfaces 必须列出实际实现面，evidence、validation 和 remainingUnknowns 不能使用占位内容。',
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
    if (
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
  if (tool === 'check_combat_environment' || tool.startsWith('list_')) return true;
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

function orcaExplorationInfrastructure(context: HostToolExecutionContext): boolean {
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server !== 'cindy_orca') return false;
  if (/^(?:get_|list_|start_team$)/i.test(target.tool)) return true;
  if (target.tool !== 'create_worker' && target.tool !== 'send_to_worker') return false;
  const args = mcpToolArguments(context.input);
  const task = text(args.initial_task) || text(args.message) || text(args.task);
  const remoteHostId = text(args.remote_host_id);
  return (
    task.includes(SERVER_EXPLORATION_MARKER) &&
    (target.tool === 'send_to_worker' || remoteHostId.startsWith('mcpr:'))
  );
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
    if (context.action.kind === 'mcp') {
      try {
        if (await isReadOnlyMcpCall(context)) return { behavior: 'allow' };
      } catch {
        options.mekaCombatEnvironmentReady = false;
        options.mekaCombatPhase = 'environment-recovery';
        return deny(
          'MCPRouter 只读探查失败，已回到环境恢复阶段；请重新检查 P4、UnityMCP 和 MCPR。',
        );
      }
    }
    if (!approvedLeadSession(options)) {
      return deny('服务器 Worker 仍处于方案前只读探索阶段；本地 Lead 方案批准前禁止修改远端仓库。');
    }
    if (!(await refreshEnvironment(options, false))) {
      return deny('本地 Lead 的 P4、UnityMCP 或 MCPRouter 复检失败；服务器修改已暂停。');
    }
    return { behavior: 'allow' };
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
      options.mekaCombatPhase = 'environment-recovery';
      return deny('MCPRouter 只读探查失败，已回到环境恢复阶段；请重新检查 P4、UnityMCP 和 MCPR。');
    }
  }
  if (context.action.kind === 'mcp' && orcaExplorationInfrastructure(context)) {
    return { behavior: 'allow' };
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
