import type { McpProvider, McpProviderContext } from '@cindy/maker-core';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { MekaRoleMcpEntry } from '../../shared/meka-projects.js';
import {
  combatEnvironmentAvailability,
  formatCombatEnvironmentGateReceipt,
  runCombatEnvironmentGate,
} from '../meka-projects/combatEnvironmentGate.js';
import { probeRemoteCodexCapability } from '../maker-host/mcpr-codex-capability.js';
import { getMekaP4SettingsService, getMekaRouterService } from '../meka-settings/ipc.js';
import {
  evaluateCombatToolExecution,
  isCombatWorkflowPolicyActive,
} from '../meka-projects/combatWorkflowPolicy.js';
import {
  consumeTrustedCombatServerCapabilityReport,
  resetCombatServerCapabilityFlow,
} from '../meka-projects/combatServerCapabilityState.js';

const ROUTER_PROVIDER_IDS = new Set(['mcp-router', 'project-agent']);
const MEKA_DESIGN_PROVIDER_ID = 'meka-design';
const COMBAT_WORKFLOW = 'saga2-combat-development-v1';
const registeredArrays: McpProvider[][] = [];
const registeredInlineIds = new Set<string>();
let authorizeHighRiskCall:
  | ((input: {
      sessionId?: string;
      providerId: string;
      toolName: string;
      args: Record<string, unknown>;
      risk: string;
    }) => Promise<boolean>)
  | null = null;
let promptRouterLogin: (() => boolean) | null = null;

interface MekaRuntimeVendorOptions extends Record<string, unknown> {
  source?: unknown;
  mekaProjectId?: unknown;
  mekaRoleId?: unknown;
  mekaMcpProviderIds?: unknown;
  mekaMcpInlineConfigs?: unknown;
  mekaWorkflow?: unknown;
  mekaCombatEnvironmentReady?: unknown;
  mekaCombatEnvironmentChecks?: unknown;
  mekaCombatPhase?: unknown;
  mekaCombatServerCapabilityStatus?: unknown;
}

const serverCapabilityReportSchema = z
  .object({
    supportStatus: z.enum(['supported', 'unsupported', 'uncertain']),
    readOnlyConfirmed: z.literal(true),
    repository: z.string().trim().min(1),
    head: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{7,64}$/i),
    codeEvidence: z.array(z.string().trim().min(1)).min(1),
    capabilityGap: z.string().trim().min(1),
    programmerAction: z.string().trim().min(1),
    affectedSurfaces: z.array(z.string().trim().min(1)).min(1),
    validationSuggestion: z.string().trim().min(1),
  })
  .strict();

const INCOMPLETE_REPORT_VALUE =
  /^(?:unknown|tbd|todo|pending|not run|未知|待确认|待定|未确定|未执行|未取得(?:回执)?|未获得(?:回执)?|未返回(?:回执)?|未核实)(?:\s*|[：:].*)$/i;

function isConcreteReportText(value: string): boolean {
  return value.trim().length > 0 && !INCOMPLETE_REPORT_VALUE.test(value) && !/^<.*>$/.test(value);
}

function validateServerCapabilityReport(
  report: z.infer<typeof serverCapabilityReportSchema>,
): string[] {
  const problems: string[] = [];
  for (const [field, value] of [
    ['repository', report.repository],
    ['head', report.head],
    ['validationSuggestion', report.validationSuggestion],
  ] as const) {
    if (!isConcreteReportText(value)) problems.push(field);
  }
  if (!report.codeEvidence.every(isConcreteReportText)) problems.push('codeEvidence');
  if (!report.affectedSurfaces.every(isConcreteReportText)) problems.push('affectedSurfaces');
  const noGap = /^(?:none|无|无需|not-applicable|n\/a)$/i;
  if (report.supportStatus === 'supported') {
    if (!noGap.test(report.capabilityGap)) problems.push('capabilityGap');
    if (!noGap.test(report.programmerAction)) problems.push('programmerAction');
  } else {
    if (!isConcreteReportText(report.capabilityGap) || noGap.test(report.capabilityGap)) {
      problems.push('capabilityGap');
    }
    if (!isConcreteReportText(report.programmerAction) || noGap.test(report.programmerAction)) {
      problems.push('programmerAction');
    }
  }
  return problems;
}

function options(context: McpProviderContext): MekaRuntimeVendorOptions {
  const activeContext = context.getSessionContext?.() ?? context;
  return (activeContext.vendorOptions ?? {}) as MekaRuntimeVendorOptions;
}

function selectedProviderIds(context: McpProviderContext): Set<string> {
  const value = options(context).mekaMcpProviderIds;
  return new Set(
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
  );
}

function projectId(context: McpProviderContext): string | null {
  if (!isMekaRouterSelected(context)) return null;
  const value = options(context).mekaProjectId;
  return typeof value === 'string' && value.trim() ? value : null;
}

function activeSessionId(context: McpProviderContext): string | undefined {
  return context.getSessionContext?.()?.sessionId ?? context.sessionId;
}

function isCodexBridgeBootstrapContext(context: McpProviderContext): boolean {
  return (
    context.agentKind === 'codex' &&
    !context.sessionId &&
    typeof context.getSessionContext === 'function'
  );
}

function isMekaRouterSelected(context: McpProviderContext): boolean {
  if (options(context).source !== 'meka') return false;
  const selected = selectedProviderIds(context);
  return [...ROUTER_PROVIDER_IDS].some((id) => selected.has(id));
}

function isMekaDesignSelected(context: McpProviderContext): boolean {
  return (
    options(context).source === 'meka' && selectedProviderIds(context).has(MEKA_DESIGN_PROVIDER_ID)
  );
}

function inlineConfig(
  context: McpProviderContext,
  id: string,
): Extract<MekaRoleMcpEntry, { transport: unknown }> | null {
  const value = options(context).mekaMcpInlineConfigs;
  if (!Array.isArray(value)) return null;
  const found = value.find(
    (entry): entry is Extract<MekaRoleMcpEntry, { transport: unknown }> =>
      typeof entry === 'object' &&
      entry !== null &&
      'transport' in entry &&
      (entry as { id?: unknown }).id === id,
  );
  return found ?? null;
}

function jsonResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

const SENSITIVE_ROUTER_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'key',
  'refresh_token',
  'secret',
  'token',
]);

function redactSensitiveRouterUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      return [...url.searchParams.keys()].some((key) =>
        SENSITIVE_ROUTER_QUERY_KEYS.has(key.toLowerCase()),
      )
        ? '[REDACTED_ENDPOINT]'
        : candidate;
    } catch {
      return candidate;
    }
  });
}

function sanitizeRouterToolValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(redactSensitiveRouterUrls(value));
  }
  if (Array.isArray(value)) return value.map(sanitizeRouterToolValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeRouterToolValue(entry)]),
    );
  }
  return value;
}

function markCombatEnvironmentUnavailable(
  context: McpProviderContext,
  dependency: 'unityMcp' | 'mcpr' = 'mcpr',
): void {
  const runtimeOptions = options(context);
  if (!isCombatWorkflowPolicyActive({ vendorOptions: runtimeOptions })) return;
  runtimeOptions.mekaCombatEnvironmentReady = false;
  const current =
    runtimeOptions.mekaCombatEnvironmentChecks &&
    typeof runtimeOptions.mekaCombatEnvironmentChecks === 'object'
      ? (runtimeOptions.mekaCombatEnvironmentChecks as Record<string, unknown>)
      : {};
  runtimeOptions.mekaCombatEnvironmentChecks = {
    ...current,
    [dependency]: {
      status: 'blocked',
      summary:
        dependency === 'unityMcp' ? 'UnityMCP 工具连接或传输失败' : 'MCPRouter 工具连接或传输失败',
      nextAction:
        dependency === 'unityMcp'
          ? '确认目标 Unity 工程及 UnityMCP 服务可用后重新检查'
          : '恢复 MCPRouter 连接、项目绑定和远端 Runtime 后重新检查',
    },
  };
  if (dependency === 'mcpr') {
    resetCombatServerCapabilityFlow({
      leadSessionId: activeSessionId(context),
      vendorOptions: runtimeOptions,
      phase: 'environment-recovery',
    });
  } else {
    runtimeOptions.mekaCombatPhase = 'degraded-exploration';
  }
}

function combatDependencyFailureMessage(dependency: 'unityMcp' | 'mcpr', error?: unknown): string {
  const label = dependency === 'unityMcp' ? 'UnityMCP' : 'MCPRouter';
  const reason =
    error instanceof Error ? error.message : error ? String(error) : `${label} 返回错误`;
  const safeReason = redactSensitiveText(redactSensitiveRouterUrls(reason));
  const solution =
    dependency === 'unityMcp'
      ? '确认目标 Unity 工程已打开且 UnityMCP 服务健康，然后运行 check_combat_environment 刷新状态'
      : '恢复 MCPRouter 连接与项目绑定；若为 Runtime 版本不匹配，升级并重启远端 Runtime，然后运行 check_combat_environment 刷新状态';
  return `本次工具调用实际依赖 ${label}，当前调用失败，但任务不会被冻结。原因：${safeReason}。解决方案：${solution}。不依赖 ${label} 的工作可以继续。`;
}

type McprRecoveryCode =
  | 'MCPR_NOT_CONNECTED'
  | 'MCPR_AUTH_REQUIRED'
  | 'MCPR_PROJECT_NOT_BOUND'
  | 'MCPR_RUNTIME_INCOMPATIBLE'
  | 'MCPR_UNAVAILABLE';

function classifyMcprFailure(reason: string, configured: boolean | null): McprRecoveryCode {
  if (configured === false || /not configured|未配置|未连接/i.test(reason)) {
    return 'MCPR_NOT_CONNECTED';
  }
  if (
    /\b401\b|unauthori[sz]ed|authentication|auth(?:entication)? expired|登录|认证/i.test(reason)
  ) {
    return 'MCPR_AUTH_REQUIRED';
  }
  if (/project binding|项目绑定|未找到可用.*远程项目|bound=0/i.test(reason)) {
    return 'MCPR_PROJECT_NOT_BOUND';
  }
  if (/version|protocol|capability|unsupported|版本|协议|能力不支持/i.test(reason)) {
    return 'MCPR_RUNTIME_INCOMPATIBLE';
  }
  return 'MCPR_UNAVAILABLE';
}

function mcprRecoveryAction(code: McprRecoveryCode): string {
  switch (code) {
    case 'MCPR_NOT_CONNECTED':
      return '打开 Cindy 的“设置 → Meka 助理”，选择“连接 MCPRouter”并完成登录；连接成功后回到当前任务重试。';
    case 'MCPR_AUTH_REQUIRED':
      return '打开 Cindy 的“设置 → Meka 助理”，重新连接 MCPRouter 以刷新登录状态；不要在任务消息中发送账号、密码或令牌。';
    case 'MCPR_PROJECT_NOT_BOUND':
      return 'MCPRouter 已连接。先调用 list_remote_instances 查找可用实例并由用户确认后调用 bind_remote_instance；若没有实例，再调用 list_remote_project_templates，并由用户确认后创建和绑定。';
    case 'MCPR_RUNTIME_INCOMPATIBLE':
      return '由 MCPRouter 部署方升级并重启目标 Runtime；客户端无法代替部署方升级。完成后回到当前任务重试。';
    case 'MCPR_UNAVAILABLE':
      return '检查当前网络，并在 Cindy 的“设置 → Meka 助理”确认 MCPRouter 连接；必要时重新连接，恢复后回到当前任务重试。';
  }
}

function promptForRouterLogin(code: McprRecoveryCode): {
  attempted: boolean;
  opened: boolean;
} {
  if (code !== 'MCPR_NOT_CONNECTED' && code !== 'MCPR_AUTH_REQUIRED') {
    return { attempted: false, opened: false };
  }
  if (!promptRouterLogin) return { attempted: false, opened: false };
  try {
    return { attempted: true, opened: promptRouterLogin() };
  } catch {
    return { attempted: true, opened: false };
  }
}

function promptedMcprRecoveryAction(code: McprRecoveryCode, opened: boolean): string {
  if (!opened) return mcprRecoveryAction(code);
  return code === 'MCPR_AUTH_REQUIRED'
    ? 'Cindy 已打开 MCPRouter 登录框（也可从“设置 → Meka 助理”进入）。请重新登录以刷新认证；完成后回到当前任务重试原工具。不要在任务消息中发送账号、密码或令牌。'
    : 'Cindy 已打开 MCPRouter 登录框（也可从“设置 → Meka 助理”进入）。请完成登录或注册；连接成功后回到当前任务重试原工具。';
}

function createRouterServer(context: McpProviderContext): McpServer {
  const server = new McpServer({ name: 'mcp_router', version: '1.0.0' });
  const service = getMekaRouterService();

  const routerFailureResult = async (error: unknown, retryTool: string) => {
    markCombatEnvironmentUnavailable(context);
    const rawReason =
      error instanceof Error ? error.message : error ? String(error) : 'MCPRouter 返回错误';
    const reason = redactSensitiveText(redactSensitiveRouterUrls(rawReason));
    let configured: boolean | null = null;
    try {
      configured = (await service.getConnectionStatus()).configured;
    } catch {
      // The original dependency error remains authoritative if local settings cannot be read.
    }
    const reasonCode = classifyMcprFailure(reason, configured);
    const loginPrompt = promptForRouterLogin(reasonCode);
    const userAction = promptedMcprRecoveryAction(reasonCode, loginPrompt.opened);
    return jsonResult(
      {
        ok: false,
        blockedDependency: 'MCPRouter',
        blockedScope: 'current-tool-call',
        reasonCode,
        reason,
        recovery: {
          diagnosisAttempted: 'inspected-local-connection-state',
          requiresUserAction: true,
          userAction,
          retryTool,
          loginPromptAttempted: loginPrompt.attempted,
          loginPromptOpened: loginPrompt.opened,
        },
        independentWorkCanContinue: true,
        message: `本次工具调用实际依赖 MCPRouter，当前调用失败，但任务不会被冻结。原因：${reason}。解决方案：${userAction}。不依赖 MCPRouter 的工作可以继续。`,
      },
      true,
    );
  };

  server.tool(
    'diagnose_mcp_router_connection',
    '检查 Cindy 本地是否已配置 MCPRouter 连接；不联网，也不返回 endpoint、用户名或凭证。未配置时打开现有登录框。',
    {},
    async () => {
      if (!projectId(context)) {
        return jsonResult({ ok: false, error: 'Meka project MCP is not enabled' }, true);
      }
      try {
        const { configured } = await service.getConnectionStatus();
        const loginPrompt = configured
          ? { attempted: false, opened: false }
          : promptForRouterLogin('MCPR_NOT_CONNECTED');
        return jsonResult({
          ok: true,
          dependency: 'MCPRouter',
          status: configured ? 'configured' : 'not-configured',
          readyForRemoteCalls: configured,
          recovery: configured
            ? null
            : {
                reasonCode: 'MCPR_NOT_CONNECTED',
                requiresUserAction: true,
                userAction: promptedMcprRecoveryAction(
                  'MCPR_NOT_CONNECTED',
                  loginPrompt.opened,
                ),
                loginPromptAttempted: loginPrompt.attempted,
                loginPromptOpened: loginPrompt.opened,
              },
          nextAction: configured
            ? '本地连接材料完整；重试原远程工具。若仍失败，按该工具回执处理网络、认证或 Runtime 问题。'
            : promptedMcprRecoveryAction('MCPR_NOT_CONNECTED', loginPrompt.opened),
        });
      } catch (error) {
        return routerFailureResult(error, 'diagnose_mcp_router_connection');
      }
    },
  );

  server.tool(
    'check_combat_environment',
    '重新检查 SAGA2 战斗开发所需的 P4、UnityMCP 和 MCPRouter 三条链路。只返回不含凭证的结构化回执。',
    {},
    async () => {
      const selectedProjectId = projectId(context);
      const runtimeOptions = options(context);
      if (!selectedProjectId || !isCombatWorkflowPolicyActive({ vendorOptions: runtimeOptions })) {
        return jsonResult({ ok: false, error: 'SAGA2 combat workflow is not enabled' }, true);
      }
      try {
        const p4 = await getMekaP4SettingsService().get();
        const gate = await runCombatEnvironmentGate({
          p4,
          listInstances: () => service.listInstances(),
          listProjectBindings: (id) => service.listProjectBindings(id),
          probeRemoteCodexCapability,
          projectId: selectedProjectId,
        });
        let mcprRecovery:
          | {
              reasonCode: McprRecoveryCode;
              userAction: string;
              retryTool: 'check_combat_environment';
              loginPromptAttempted: boolean;
              loginPromptOpened: boolean;
            }
          | undefined;
        if (gate.mcpr.status === 'blocked') {
          let configured: boolean | null = null;
          try {
            configured = (await service.getConnectionStatus()).configured;
          } catch {
            // The gate evidence remains authoritative if local settings cannot be read.
          }
          const reasonCode = classifyMcprFailure(
            `${gate.mcpr.summary}\n${gate.mcpr.evidence ?? ''}`,
            configured,
          );
          const loginPrompt = promptForRouterLogin(reasonCode);
          mcprRecovery = {
            reasonCode,
            userAction: promptedMcprRecoveryAction(reasonCode, loginPrompt.opened),
            retryTool: 'check_combat_environment',
            loginPromptAttempted: loginPrompt.attempted,
            loginPromptOpened: loginPrompt.opened,
          };
        }
        runtimeOptions.mekaCombatEnvironmentReady = gate.ready;
        runtimeOptions.mekaCombatEnvironmentChecks = combatEnvironmentAvailability(gate);
        resetCombatServerCapabilityFlow({
          leadSessionId: activeSessionId(context),
          vendorOptions: runtimeOptions,
          phase: gate.ready ? 'exploration' : 'environment-recovery',
        });
        const observedWorkflow =
          typeof runtimeOptions.mekaWorkflow === 'string' ? runtimeOptions.mekaWorkflow : null;
        runtimeOptions.mekaWorkflow = COMBAT_WORKFLOW;
        const roleContext = {
          projectId: selectedProjectId,
          roleId: 'combat-development',
          displayName: '战斗开发',
          workflow: COMBAT_WORKFLOW,
          workflowRecoveredFromRole: observedWorkflow !== COMBAT_WORKFLOW,
        };
        return jsonResult({
          ok: true,
          roleContext,
          gate,
          ...(mcprRecovery ? { mcprRecovery } : {}),
          receipt: formatCombatEnvironmentGateReceipt(gate, roleContext),
        });
      } catch (error) {
        markCombatEnvironmentUnavailable(context, 'mcpr');
        return jsonResult(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          true,
        );
      }
    },
  );

  server.tool(
    'validate_server_capability_report',
    '校验 MCPR 服务器 Worker 的只读能力核查报告；不授权或记录任何服务器修改。',
    { serverCapabilityReport: serverCapabilityReportSchema },
    async ({ serverCapabilityReport }) => {
      const runtimeOptions = options(context);
      if (!isCombatWorkflowPolicyActive({ vendorOptions: runtimeOptions })) {
        return jsonResult({ ok: false, error: 'SAGA2 combat workflow is not enabled' }, true);
      }
      const problems = validateServerCapabilityReport(serverCapabilityReport);
      const valid = problems.length === 0;
      if (!valid) {
        return jsonResult(
          {
            ok: false,
            error: `Server capability report is incomplete: ${problems.join(', ')}`,
          },
          true,
        );
      }
      const trusted = consumeTrustedCombatServerCapabilityReport({
        leadSessionId: activeSessionId(context),
        report: serverCapabilityReport,
      });
      if (!trusted.ok) {
        return jsonResult(
          {
            ok: false,
            error:
              trusted.reason === 'report-mismatch'
                ? 'Server capability report does not match the auto-bridged Worker result'
                : 'No trusted auto-bridged Worker report is ready for validation',
          },
          true,
        );
      }
      runtimeOptions.mekaCombatServerCapabilityStatus = serverCapabilityReport.supportStatus;
      const implementationBlocked = serverCapabilityReport.supportStatus !== 'supported';
      if (implementationBlocked) runtimeOptions.mekaCombatPhase = 'server-programmer-handoff';
      return jsonResult({
        ok: true,
        supportStatus: serverCapabilityReport.supportStatus,
        reportValidated: true,
        implementationBlocked,
      });
    },
  );

  server.tool('list_tools', '列出当前 Meka 项目允许使用的 MCPRouter 工具。', {}, async () => {
    const selectedProjectId = projectId(context);
    if (!selectedProjectId)
      return jsonResult({ ok: false, error: 'Meka project MCP is not enabled' }, true);
    try {
      const tools = await service.listProjectTools(selectedProjectId);
      return jsonResult({
        ok: true,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          annotations: tool.annotations,
        })),
      });
    } catch (error) {
      return routerFailureResult(error, 'list_tools');
    }
  });

  server.tool(
    'call_tool',
    '调用 list_tools 返回的 MCPRouter 工具。',
    {
      name: z.string(),
      args: z.record(z.string(), z.unknown()).default({}),
    },
    async ({ name, args }) => {
      const selectedProjectId = projectId(context);
      if (!selectedProjectId)
        return jsonResult({ ok: false, error: 'Meka project MCP is not enabled' }, true);
      const sessionId = activeSessionId(context);
      if (!sessionId) return jsonResult({ ok: false, error: 'Meka session is not active' }, true);
      try {
        const workflowDecision = await evaluateCombatToolExecution({
          sessionId,
          workingDir: context.getSessionContext?.()?.workingDir ?? context.workingDir,
          vendorOptions: options(context),
          toolName: 'mcp__mcp_router__call_tool',
          input: { name, args },
          action: { kind: 'mcp' },
        });
        if (workflowDecision.behavior === 'deny') {
          return jsonResult({ ok: false, error: workflowDecision.reason }, true);
        }
        const result = await service.callProjectTool(
          selectedProjectId,
          name,
          args,
          ({ toolName, args: authorizedArgs, risk }) =>
            authorizeHighRiskCall?.({
              sessionId: activeSessionId(context),
              providerId: 'mcp-router',
              toolName,
              args: authorizedArgs,
              risk,
            }) ?? Promise.resolve(false),
        );
        if (result.isError) {
          const reason = result.content
            .flatMap((entry) => {
              if (!entry || typeof entry !== 'object') return [];
              const candidate = entry as { type?: unknown; text?: unknown };
              return candidate.type === 'text' && typeof candidate.text === 'string'
                ? [candidate.text]
                : [];
            })
            .join('\n')
            .slice(0, 2_000);
          return routerFailureResult(
            reason || 'MCPRouter project tool returned an error',
            'call_tool',
          );
        }
        return sanitizeRouterToolValue({
          content: result.content,
        }) as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
      } catch (error) {
        return routerFailureResult(error, 'call_tool');
      }
    },
  );

  server.tool(
    'list_project_remote_instances',
    '列出当前 Meka 项目已绑定的远程项目实例。',
    {},
    async () => {
      const selectedProjectId = projectId(context);
      if (!selectedProjectId)
        return jsonResult({ ok: false, error: 'Meka project MCP is not enabled' }, true);
      try {
        const [boundIds, instances] = await Promise.all([
          service.listProjectBindings(selectedProjectId),
          service.listInstances(),
        ]);
        const bound = new Set(boundIds);
        return jsonResult({
          ok: true,
          instances: instances
            .filter((entry) => bound.has(entry.id))
            .map((entry) => ({
              instanceId: entry.id,
              projectName: entry.projectName,
              projectDescription: entry.projectDescription,
              availability: entry.available
                ? 'available'
                : entry.supported
                  ? 'unavailable'
                  : 'unsupported',
              remoteHostId: entry.remoteHostId,
            })),
        });
      } catch (error) {
        return routerFailureResult(error, 'list_project_remote_instances');
      }
    },
  );

  server.tool(
    'list_remote_instances',
    '列出 MCPRouter 中当前用户的全部远程项目实例。',
    {},
    async () => {
      const selectedProjectId = projectId(context);
      if (!selectedProjectId)
        return jsonResult({ ok: false, error: 'Meka project MCP is not enabled' }, true);
      try {
        const [instances, boundIds] = await Promise.all([
          service.listInstances(),
          service.listProjectBindings(selectedProjectId),
        ]);
        const bound = new Set(boundIds);
        return jsonResult({
          ok: true,
          instances: instances.map((entry) => ({
            instanceId: entry.id,
            projectName: entry.projectName,
            projectDescription: entry.projectDescription,
            availability: entry.available
              ? 'available'
              : entry.supported
                ? 'unavailable'
                : 'unsupported',
            remoteHostId: entry.remoteHostId,
            boundToThisProject: bound.has(entry.id),
          })),
        });
      } catch (error) {
        return routerFailureResult(error, 'list_remote_instances');
      }
    },
  );

  server.tool(
    'list_remote_project_templates',
    '列出 MCPRouter 可创建的远程项目模板。',
    {},
    async () => {
      if (!projectId(context))
        return jsonResult({ ok: false, error: 'Meka project MCP is not enabled' }, true);
      try {
        return jsonResult({ ok: true, templates: await service.listTemplates() });
      } catch (error) {
        return routerFailureResult(error, 'list_remote_project_templates');
      }
    },
  );

  server.tool(
    'create_remote_instance',
    '用户明确确认后，基于模板创建或复用远程项目实例。',
    { templateId: z.string(), name: z.string() },
    async ({ templateId, name }) => {
      if (!projectId(context))
        return jsonResult({ ok: false, error: 'Meka project MCP is not enabled' }, true);
      try {
        return jsonResult({ ok: true, instance: await service.createInstance(templateId, name) });
      } catch (error) {
        return routerFailureResult(error, 'create_remote_instance');
      }
    },
  );

  server.tool(
    'bind_remote_instance',
    '用户明确确认后，将远程项目实例绑定到当前 Meka 项目。',
    { instanceId: z.string() },
    async ({ instanceId }) => {
      const selectedProjectId = projectId(context);
      if (!selectedProjectId)
        return jsonResult({ ok: false, error: 'Meka project MCP is not enabled' }, true);
      try {
        const current = await service.listProjectBindings(selectedProjectId);
        await service.setProjectBindings(selectedProjectId, [...new Set([...current, instanceId])]);
        return jsonResult({ ok: true, projectId: selectedProjectId, instanceId });
      } catch (error) {
        return routerFailureResult(error, 'bind_remote_instance');
      }
    },
  );

  return server;
}

const routerProvider: McpProvider = {
  name: 'mcp_router',
  isEnabled(context) {
    // Codex owns one process-global HTTP bridge. Its server factories are
    // collected before any thread exists, so keep the Meka facade registered
    // at that bootstrap boundary and resolve the real thread context inside
    // each tool call. Claude still uses the ordinary per-session gate.
    return isCodexBridgeBootstrapContext(context) || isMekaRouterSelected(context);
  },
  toClaudeSdkConfig(context) {
    return {
      type: 'sdk' as const,
      name: 'mcp_router',
      instance: createRouterServer(context),
    };
  },
};

function createMekaDesignProxyServer(context: McpProviderContext): McpServer {
  const server = new Server(
    { name: 'meka_design', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  async function withRemoteClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const endpoint = getMekaRouterService().getMekaDesignEndpoint();
    if (!endpoint || !isMekaDesignSelected(context)) {
      throw new Error('MekaDesign MCP is not enabled for this session');
    }
    const client = new Client({ name: 'cindy-meka-design-proxy', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
      return await run(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!isMekaDesignSelected(context) || getMekaRouterService().getMekaDesignEndpoint() === null) {
      return { tools: [] };
    }
    return withRemoteClient((client) => client.listTools());
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await withRemoteClient((client) =>
        client.callTool({
          name: request.params.name,
          arguments: request.params.arguments ?? {},
        }),
      );
    } catch {
      return jsonResult({ ok: false, error: 'MekaDesign MCP call failed or is unavailable' }, true);
    }
  });

  return server as unknown as McpServer;
}

const mekaDesignProvider: McpProvider = {
  name: 'meka_design',
  isEnabled(context) {
    // Keep the session-gated proxy in Codex's frozen process-global provider set even when
    // MekaDesign is configured later. Claude still evaluates the endpoint per session.
    if (isCodexBridgeBootstrapContext(context)) return true;
    return getMekaRouterService().getMekaDesignEndpoint() !== null && isMekaDesignSelected(context);
  },
  toClaudeSdkConfig(context) {
    if (isCodexBridgeBootstrapContext(context)) {
      return {
        type: 'sdk' as const,
        name: 'meka_design',
        instance: createMekaDesignProxyServer(context),
      };
    }
    const url = getMekaRouterService().getMekaDesignEndpoint();
    return url ? { type: 'http' as const, url } : null;
  },
};

class InlineMekaMcpProvider implements McpProvider {
  constructor(readonly name: string) {}

  isEnabled(context: McpProviderContext): boolean {
    if (isCodexBridgeBootstrapContext(context)) return true;
    return options(context).source === 'meka' && inlineConfig(context, this.name) !== null;
  }

  private createHttpProxy(context: McpProviderContext): McpServer {
    const server = new Server(
      { name: this.name, version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    const withClient = async <T>(run: (client: Client) => Promise<T>): Promise<T> => {
      const config = inlineConfig(context, this.name);
      if (!config || config.transport !== 'http' || !config.url) {
        throw new Error(`Meka MCP ${this.name} is not enabled for this session`);
      }
      const client = new Client({ name: `cindy-meka-${this.name}-proxy`, version: '1.0.0' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(config.url)));
        return await run(client);
      } finally {
        await client.close().catch(() => undefined);
      }
    };
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        return await withClient((client) => client.listTools());
      } catch (error) {
        const dependency = this.name === 'unity-editor' ? 'unityMcp' : 'mcpr';
        markCombatEnvironmentUnavailable(context, dependency);
        throw new Error(combatDependencyFailureMessage(dependency, error));
      }
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        if (isCombatWorkflowPolicyActive({ vendorOptions: options(context) })) {
          const sessionId = activeSessionId(context);
          if (!sessionId) {
            return jsonResult({ ok: false, error: 'Meka session is not active' }, true);
          }
          const decision = await evaluateCombatToolExecution({
            sessionId,
            workingDir: context.getSessionContext?.()?.workingDir ?? context.workingDir,
            vendorOptions: options(context),
            toolName: `mcp__${this.name}__${request.params.name}`,
            input: { name: request.params.name, args: request.params.arguments ?? {} },
            action: { kind: 'mcp' },
          });
          if (decision.behavior === 'deny') {
            return jsonResult({ ok: false, error: decision.reason }, true);
          }
        }
        return await withClient((client) =>
          client.callTool({
            name: request.params.name,
            arguments: request.params.arguments ?? {},
          }),
        );
      } catch (error) {
        const runtimeOptions = options(context);
        const dependency = this.name === 'unity-editor' ? 'unityMcp' : 'mcpr';
        if (isCombatWorkflowPolicyActive({ vendorOptions: runtimeOptions })) {
          markCombatEnvironmentUnavailable(context, dependency);
        }
        return jsonResult(
          { ok: false, error: combatDependencyFailureMessage(dependency, error) },
          true,
        );
      }
    });
    return server as unknown as McpServer;
  }

  toClaudeSdkConfig(context: McpProviderContext): unknown | null {
    const config = inlineConfig(context, this.name);
    if (!config && !isCodexBridgeBootstrapContext(context)) return null;
    if (!config) {
      return {
        type: 'sdk' as const,
        name: this.name,
        instance: this.createHttpProxy(context),
      };
    }
    if (config.transport === 'stdio') {
      return {
        type: 'stdio',
        command: config.command,
        args: config.args ?? [],
      };
    }
    if (!config.url) return null;
    return {
      type: 'sdk' as const,
      name: this.name,
      instance: this.createHttpProxy(context),
    };
  }
}

export function registerMekaRuntimeMcpArrays(...arrays: McpProvider[][]): void {
  for (const array of arrays) {
    if (!registeredArrays.includes(array)) registeredArrays.push(array);
    if (!array.includes(routerProvider)) array.push(routerProvider);
    if (!array.includes(mekaDesignProvider)) array.push(mekaDesignProvider);
  }
}

export function setMekaRuntimeHighRiskAuthorizer(authorizer: typeof authorizeHighRiskCall): void {
  authorizeHighRiskCall = authorizer;
}

export function setMekaRuntimeRouterLoginPrompter(prompter: typeof promptRouterLogin): void {
  promptRouterLogin = prompter;
}

export function prepareMekaRuntimeMcp(entries: readonly MekaRoleMcpEntry[]): {
  providerIds: string[];
  inlineConfigs: Array<Extract<MekaRoleMcpEntry, { transport: unknown }>>;
} {
  const providerIds: string[] = [];
  const inlineConfigs: Array<Extract<MekaRoleMcpEntry, { transport: unknown }>> = [];
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    if ('providerId' in entry) {
      if (
        !ROUTER_PROVIDER_IDS.has(entry.providerId) &&
        entry.providerId !== MEKA_DESIGN_PROVIDER_ID
      ) {
        throw new Error(`unknown Meka MCP provider: ${entry.providerId}`);
      }
      providerIds.push(entry.providerId);
      continue;
    }
    if (entry.env && Object.keys(entry.env).length > 0) {
      throw new Error(`Meka MCP ${entry.id} requires unresolved secret references`);
    }
    inlineConfigs.push(entry);
    if (registeredInlineIds.has(entry.id)) continue;
    const provider = new InlineMekaMcpProvider(entry.id);
    for (const array of registeredArrays) array.push(provider);
    registeredInlineIds.add(entry.id);
  }
  return { providerIds: [...new Set(providerIds)], inlineConfigs };
}

export function resetMekaRuntimeMcpRegistryForTests(): void {
  registeredArrays.length = 0;
  registeredInlineIds.clear();
  authorizeHighRiskCall = null;
  promptRouterLogin = null;
}
