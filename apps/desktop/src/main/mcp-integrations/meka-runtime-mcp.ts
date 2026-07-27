import type { CodexHttpMcpServerConfig, McpProvider, McpProviderContext } from '@cindy/maker-core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { MekaRoleMcpEntry } from '../../shared/meka-projects.js';
import { getMekaRouterService } from '../meka-settings/ipc.js';

const ROUTER_PROVIDER_IDS = new Set(['mcp-router', 'project-agent', 'meka-design']);
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
  mekaMcpProviderIds?: unknown;
  mekaMcpInlineConfigs?: unknown;
}

function options(context: McpProviderContext): MekaRuntimeVendorOptions {
  return (context.vendorOptions ?? {}) as MekaRuntimeVendorOptions;
}

function selectedProviderIds(context: McpProviderContext): Set<string> {
  const value = options(context).mekaMcpProviderIds;
  return new Set(
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
  );
}

function projectId(context: McpProviderContext): string | null {
  const value = options(context).mekaProjectId;
  return typeof value === 'string' && value.trim() ? value : null;
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

function createRouterServer(context: McpProviderContext): McpServer {
  const server = new McpServer({ name: 'mcp_router', version: '1.0.0' });
  const selectedProjectId = projectId(context);
  const service = getMekaRouterService();

  server.tool('list_tools', '列出当前 Meka 项目允许使用的 MCPRouter 工具。', {}, async () => {
    if (!selectedProjectId)
      return jsonResult({ ok: false, error: 'Meka project is missing' }, true);
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
      if (!selectedProjectId)
        return jsonResult({ ok: false, error: 'Meka project is missing' }, true);
      try {
        const result = await service.callProjectTool(
          selectedProjectId,
          name,
          args,
          ({ toolName, args: authorizedArgs, risk }) =>
            authorizeHighRiskCall?.({
              sessionId: context.sessionId,
              providerId: 'mcp-router',
              toolName,
              args: authorizedArgs,
              risk,
            }) ?? Promise.resolve(false),
        );
        return {
          content: result.content as Array<{ type: 'text'; text: string }>,
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (error) {
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
      if (!selectedProjectId)
        return jsonResult({ ok: false, error: 'Meka project is missing' }, true);
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
      try {
        const [instances, boundIds] = await Promise.all([
          service.listInstances(),
          selectedProjectId ? service.listProjectBindings(selectedProjectId) : Promise.resolve([]),
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
      try {
        return jsonResult({ ok: true, templates: await service.listTemplates() });
      } catch (error) {
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
      try {
        return jsonResult({ ok: true, instance: await service.createInstance(templateId, name) });
      } catch (error) {
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
      if (!selectedProjectId)
        return jsonResult({ ok: false, error: 'Meka project is missing' }, true);
      try {
        const current = await service.listProjectBindings(selectedProjectId);
        await service.setProjectBindings(selectedProjectId, [...new Set([...current, instanceId])]);
        return jsonResult({ ok: true, projectId: selectedProjectId, instanceId });
      } catch (error) {
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
    if (options(context).source !== 'meka') return false;
    const selected = selectedProviderIds(context);
    return [...ROUTER_PROVIDER_IDS].some((id) => selected.has(id));
  },
  toClaudeSdkConfig(context) {
    return {
      type: 'sdk' as const,
      name: 'mcp_router',
      instance: createRouterServer(context),
    };
  },
};

class InlineMekaMcpProvider implements McpProvider {
  constructor(readonly name: string) {}

  isEnabled(context: McpProviderContext): boolean {
    return options(context).source === 'meka' && inlineConfig(context, this.name) !== null;
  }

  toClaudeSdkConfig(context: McpProviderContext): unknown | null {
    const config = inlineConfig(context, this.name);
    if (!config) return null;
    if (config.transport === 'stdio') {
      return {
        type: 'stdio',
        command: config.command,
        args: config.args ?? [],
      };
    }
    return { type: config.transport, url: config.url };
  }

  toCodexMcpConfig(context: McpProviderContext): CodexHttpMcpServerConfig | null {
    const config = inlineConfig(context, this.name);
    if (!config || config.transport !== 'http' || !config.url) return null;
    return { type: 'http', url: new URL(config.url).href.replace(/\\/g, '%5C') };
  }
}

export function registerMekaRuntimeMcpArrays(...arrays: McpProvider[][]): void {
  for (const array of arrays) {
    if (!registeredArrays.includes(array)) registeredArrays.push(array);
    if (!array.includes(routerProvider)) array.push(routerProvider);
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
      if (!ROUTER_PROVIDER_IDS.has(entry.providerId)) {
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
