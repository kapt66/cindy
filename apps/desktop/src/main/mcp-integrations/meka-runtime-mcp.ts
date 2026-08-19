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
  formatCombatEnvironmentGateReceipt,
  runCombatEnvironmentGate,
} from '../meka-projects/combatEnvironmentGate.js';
import { probeRemoteCodexCapability } from '../maker-host/mcpr-codex-capability.js';
import { getMekaP4SettingsService, getMekaRouterService } from '../meka-settings/ipc.js';
import {
  evaluateCombatToolExecution,
  isCombatEnvironmentRecoveryControlTool,
  isCombatWorkflowPolicyActive,
} from '../meka-projects/combatWorkflowPolicy.js';

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

interface MekaRuntimeVendorOptions extends Record<string, unknown> {
  source?: unknown;
  mekaProjectId?: unknown;
  mekaRoleId?: unknown;
  mekaMcpProviderIds?: unknown;
  mekaMcpInlineConfigs?: unknown;
  mekaWorkflow?: unknown;
  mekaCombatEnvironmentReady?: unknown;
  mekaCombatPhase?: unknown;
  mekaCombatServerReceiptRequired?: unknown;
  mekaCombatServerReceiptValidated?: unknown;
}

const serverWorkflowReceiptSchema = z
  .object({
    skillName: z.string().trim().min(1),
    skillLoaded: z.boolean(),
    role: z.string().trim().min(1),
    status: z.enum(['already-supported', 'implemented', 'partial', 'blocked']),
    repository: z.string().trim().min(1),
    head: z.string().trim().min(1),
    baseBranch: z.string().trim().min(1),
    workBranch: z.string().trim().min(1),
    codeEvidence: z.array(z.string().trim().min(1)).min(1),
    excelChanges: z.object({
      status: z.enum(['changed', 'pending-caller', 'not-applicable', 'blocked']),
      evidence: z.string().trim().min(1),
    }),
    generatedArtifacts: z.object({
      status: z.enum(['changed', 'verified', 'pending-caller', 'not-applicable', 'blocked']),
      evidence: z.string().trim().min(1),
    }),
    validation: z.array(z.string().trim().min(1)).min(1),
    runtimeVerification: z.string().trim().min(1),
    remainingIntegration: z.array(z.string().trim().min(1)),
  })
  .strict();

const INCOMPLETE_RECEIPT_VALUE =
  /(?:\b(?:unknown|tbd|todo|pending|blocked|not run)\b|当前|未知|待确认|待定|未确定|未执行|阻塞)/i;

function isConcreteReceiptText(value: string): boolean {
  return value.trim().length > 0 && !INCOMPLETE_RECEIPT_VALUE.test(value) && !/^<.*>$/.test(value);
}

function validateCompletedServerWorkflow(
  receipt: z.infer<typeof serverWorkflowReceiptSchema>,
): string[] {
  const problems: string[] = [];
  if (receipt.skillName !== 'battle-designer-server-development') {
    problems.push('skillName');
  }
  if (!receipt.skillLoaded) problems.push('skillLoaded');
  if (receipt.role !== 'combat-designer') problems.push('role');
  if (!['already-supported', 'implemented'].includes(receipt.status)) problems.push('status');
  for (const [field, value] of [
    ['repository', receipt.repository],
    ['head', receipt.head],
    ['baseBranch', receipt.baseBranch],
    ['runtimeVerification', receipt.runtimeVerification],
  ] as const) {
    if (!isConcreteReceiptText(value)) problems.push(field);
  }
  if (receipt.status === 'implemented') {
    if (!isConcreteReceiptText(receipt.workBranch) || receipt.workBranch === receipt.baseBranch) {
      problems.push('workBranch');
    }
  } else if (
    !isConcreteReceiptText(receipt.workBranch) &&
    !/^(?:not-applicable|n\/a)$/i.test(receipt.workBranch)
  ) {
    problems.push('workBranch');
  }
  if (!receipt.codeEvidence.every(isConcreteReceiptText)) problems.push('codeEvidence');
  if (!receipt.validation.every(isConcreteReceiptText)) problems.push('validation');
  if (receipt.excelChanges.status === 'blocked') problems.push('excelChanges.status');
  if (!isConcreteReceiptText(receipt.excelChanges.evidence)) problems.push('excelChanges.evidence');
  if (receipt.generatedArtifacts.status === 'blocked') problems.push('generatedArtifacts.status');
  if (!isConcreteReceiptText(receipt.generatedArtifacts.evidence)) {
    problems.push('generatedArtifacts.evidence');
  }
  if (!receipt.remainingIntegration.every(isConcreteReceiptText)) {
    problems.push('remainingIntegration');
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

function markCombatEnvironmentUnavailable(context: McpProviderContext): void {
  const runtimeOptions = options(context);
  if (!isCombatWorkflowPolicyActive({ vendorOptions: runtimeOptions })) return;
  runtimeOptions.mekaCombatEnvironmentReady = false;
  runtimeOptions.mekaCombatPhase = 'environment-recovery';
}

function createRouterServer(context: McpProviderContext): McpServer {
  const server = new McpServer({ name: 'mcp_router', version: '1.0.0' });
  const service = getMekaRouterService();

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
        runtimeOptions.mekaCombatEnvironmentReady = gate.ready;
        runtimeOptions.mekaCombatPhase = gate.ready ? 'exploration' : 'environment-recovery';
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
          receipt: formatCombatEnvironmentGateReceipt(gate, roleContext),
        });
      } catch (error) {
        markCombatEnvironmentUnavailable(context);
        return jsonResult(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          true,
        );
      }
    },
  );

  server.tool(
    'validate_server_workflow_receipt',
    '校验战斗策划发起的服务器任务是否真实加载指定 Skill，并记录完整跨仓回执。',
    { serverWorkflow: serverWorkflowReceiptSchema },
    async ({ serverWorkflow }) => {
      const runtimeOptions = options(context);
      if (!isCombatWorkflowPolicyActive({ vendorOptions: runtimeOptions })) {
        return jsonResult({ ok: false, error: 'SAGA2 combat workflow is not enabled' }, true);
      }
      const problems = validateCompletedServerWorkflow(serverWorkflow);
      const valid = problems.length === 0;
      runtimeOptions.mekaCombatServerReceiptValidated = valid;
      if (!valid) {
        return jsonResult(
          {
            ok: false,
            error: `Server workflow receipt is blocked or incomplete: ${problems.join(', ')}`,
          },
          true,
        );
      }
      return jsonResult({
        ok: true,
        skillName: serverWorkflow.skillName,
        status: serverWorkflow.status,
        receiptValidated: true,
      });
    },
  );

  server.tool('list_tools', '列出当前 Meka 项目允许使用的 MCPRouter 工具。', {}, async () => {
    const selectedProjectId = projectId(context);
    if (!selectedProjectId)
      return jsonResult({ ok: false, error: 'Meka project MCP is not enabled' }, true);
    const runtimeOptions = options(context);
    if (
      isCombatWorkflowPolicyActive({ vendorOptions: runtimeOptions }) &&
      runtimeOptions.mekaCombatEnvironmentReady !== true
    ) {
      return jsonResult({
        ok: true,
        environmentRecoveryOnly: true,
        tools: [],
        allowedActions: ['check_combat_environment', 'list_project_remote_instances'],
        forbiddenActions: [
          'load_skill',
          'read_project_files',
          'scan_all_tools',
          'call_ghost_or_worker',
          'call_generic_router_control_plane',
        ],
        nextAction:
          '不要加载 Skill、扫描工具或请求权限。只调用一次 check_combat_environment；若仍是远程 Runtime 版本/协议不匹配，说明需由部署方升级并重启后结束回合。',
      });
    }
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
      markCombatEnvironmentUnavailable(context);
      return jsonResult(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        true,
      );
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
      try {
        const workflowDecision = await evaluateCombatToolExecution({
          agentKind: context.agentKind,
          sessionId: activeSessionId(context),
          workingDir: context.getSessionContext?.()?.workingDir ?? context.workingDir,
          vendorOptions: options(context),
          toolName: 'mcp__mcp_router__call_tool',
          input: { name, args },
          action: { kind: 'mcp' },
        });
        if (workflowDecision.behavior === 'deny') {
          return jsonResult({ ok: false, error: workflowDecision.reason }, true);
        }
        const runtimeOptions = options(context);
        if (
          isCombatWorkflowPolicyActive({ vendorOptions: runtimeOptions }) &&
          runtimeOptions.mekaCombatEnvironmentReady !== true &&
          isCombatEnvironmentRecoveryControlTool(name)
        ) {
          return jsonResult({
            ok: true,
            environmentRecoveryOnly: true,
            upstreamCalled: false,
            nextAction:
              '不要重试通用控制面，也不要加载 Skill或请求提权。仅用 check_combat_environment 复检；远端 runtime 升级需由部署方完成。',
          });
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
        if (result.isError) markCombatEnvironmentUnavailable(context);
        return sanitizeRouterToolValue({
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        }) as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
      } catch (error) {
        markCombatEnvironmentUnavailable(context);
        return jsonResult(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          true,
        );
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
        markCombatEnvironmentUnavailable(context);
        return jsonResult(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          true,
        );
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
        markCombatEnvironmentUnavailable(context);
        return jsonResult(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          true,
        );
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
        markCombatEnvironmentUnavailable(context);
        return jsonResult(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          true,
        );
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
        markCombatEnvironmentUnavailable(context);
        return jsonResult(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          true,
        );
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
        markCombatEnvironmentUnavailable(context);
        return jsonResult(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          true,
        );
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
        markCombatEnvironmentUnavailable(context);
        throw error;
      }
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        if (isCombatWorkflowPolicyActive({ vendorOptions: options(context) })) {
          const decision = await evaluateCombatToolExecution({
            agentKind: context.agentKind,
            sessionId: activeSessionId(context),
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
        if (isCombatWorkflowPolicyActive({ vendorOptions: runtimeOptions })) {
          runtimeOptions.mekaCombatEnvironmentReady = false;
          runtimeOptions.mekaCombatPhase = 'environment-recovery';
        }
        return jsonResult(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
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
}
