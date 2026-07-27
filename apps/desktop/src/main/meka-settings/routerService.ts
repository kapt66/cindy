import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  buildMcprRemoteHostId,
  isMekaRouterInstanceAvailable,
  type MekaRouterInstance,
  type MekaRouterRoute,
  type MekaRouterSettingsView,
  type MekaRouterTemplate,
  type MekaRouterTool,
} from '../../shared/meka-router.js';
import { createMekaRouterClient, type MekaRouterClient } from './routerClient.js';
import { classifyMekaRouterToolRisk, type MekaToolRisk } from './mekaRiskPolicy.js';
import { DEFAULT_MEKA_MCPROUTER_URL } from './config.js';

type JsonRecord = Record<string, unknown>;

export interface MekaRouterHighRiskAuthorization {
  (input: {
    toolName: string;
    args: Record<string, unknown>;
    risk: MekaToolRisk;
  }): Promise<boolean>;
}

const SECRET_KEYS = {
  password: 'meka.router.password',
  sessionToken: 'meka.router.sessionToken',
  clientKey: 'meka.router.clientKey',
  mekaDesignUrl: 'meka.mekadesign.url',
} as const;

export interface MekaSecretVault {
  read(key: string): string | null;
  store(key: string, value: string): void;
  remove(key: string): void;
}

export interface MekaRouterServiceDeps {
  configPath: string;
  vault: MekaSecretVault;
  client?: MekaRouterClient;
  readFile?: (filePath: string) => Promise<string | null>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  unlink?: (filePath: string) => Promise<void>;
  mkdir?: (directoryPath: string) => Promise<void>;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeInstance(raw: JsonRecord): MekaRouterInstance {
  const id = text(raw.id) ?? '';
  const instanceId = text(raw.instanceId) ?? id;
  const workspaceRef = text(raw.workspaceRef);
  const agentType = text(raw.agentType) ?? '';
  const status = text(raw.status);
  const supported = agentType === 'claude' && !!id;
  return {
    id,
    instanceId,
    projectId: text(raw.projectId),
    projectName: text(raw.projectName) ?? instanceId,
    projectDescription: text(raw.projectDescription),
    agentType,
    agentMode: text(raw.agentMode) ?? 'ask',
    status,
    workspaceRef,
    supported,
    available: supported && isMekaRouterInstanceAvailable(status),
    remoteHostId: id ? buildMcprRemoteHostId(id) : '',
    workingDir: workspaceRef ?? `/mcpr/${instanceId}`,
  };
}

export function createMekaRouterService(deps: MekaRouterServiceDeps) {
  const client = deps.client ?? createMekaRouterClient();
  const readFile =
    deps.readFile ??
    (async (filePath: string) => {
      try {
        return await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    });
  const writeFile =
    deps.writeFile ?? ((filePath, content) => fs.writeFile(filePath, content, 'utf8'));
  const rename = deps.rename ?? ((from, to) => fs.rename(from, to));
  const unlink =
    deps.unlink ??
    (async (filePath) => {
      try {
        await fs.unlink(filePath);
      } catch {
        /* best effort */
      }
    });
  const mkdir =
    deps.mkdir ??
    ((directoryPath) => fs.mkdir(directoryPath, { recursive: true }).then(() => undefined));
  let sequence = 0;

  async function load(): Promise<JsonRecord> {
    const content = await readFile(deps.configPath);
    if (!content) return {};
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : {};
  }

  async function save(raw: JsonRecord): Promise<void> {
    if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > 1) {
      throw new Error(`Meka settings schemaVersion ${raw.schemaVersion} is read-only`);
    }
    const next = {
      ...raw,
      schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
    };
    await mkdir(path.dirname(deps.configPath));
    const temp = `${deps.configPath}.tmp-router-${process.pid}-${++sequence}`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
    try {
      await rename(temp, deps.configPath);
    } catch (error) {
      await unlink(temp);
      throw error;
    }
  }

  async function auth(): Promise<{ baseUrl: string; token: string; clientKey: string }> {
    const raw = await load();
    const baseUrl = text(raw.routerUrl);
    const token = deps.vault.read(SECRET_KEYS.sessionToken);
    const clientKey = deps.vault.read(SECRET_KEYS.clientKey);
    if (!baseUrl || !token || !clientKey) throw new Error('MCPRouter is not configured');
    return { baseUrl, token, clientKey };
  }

  return {
    async getSettings(): Promise<MekaRouterSettingsView> {
      const raw = await load();
      const routerUrl = text(raw.routerUrl);
      const token = deps.vault.read(SECRET_KEYS.sessionToken);
      const clientKey = deps.vault.read(SECRET_KEYS.clientKey);
      const designUrl = deps.vault.read(SECRET_KEYS.mekaDesignUrl);
      return {
        configured: !!routerUrl && !!token && !!clientKey,
        routerUrl,
        defaultRouterUrl: DEFAULT_MEKA_MCPROUTER_URL,
        routerUsername: text(raw.routerUsername),
        mekaDesignConfigured: raw.mekadesignConfigured === true && !!designUrl,
        mekaDesignUrl: designUrl,
      };
    },

    async connect(routerUrl: string, username: string, password: string): Promise<void> {
      const baseUrl = client.normalizeBaseUrl(routerUrl.trim() || DEFAULT_MEKA_MCPROUTER_URL);
      const normalizedUsername = username.trim();
      if (!normalizedUsername || !password) throw new Error('MCPRouter credentials are required');
      const token = await client.login(baseUrl, normalizedUsername, password);
      const clientKey = await client.ensureClientKey(baseUrl, token);
      try {
        deps.vault.store(SECRET_KEYS.password, password);
        deps.vault.store(SECRET_KEYS.sessionToken, token);
        deps.vault.store(SECRET_KEYS.clientKey, clientKey);
        const raw = await load();
        await save({ ...raw, routerUrl: baseUrl, routerUsername: normalizedUsername });
      } catch (error) {
        deps.vault.remove(SECRET_KEYS.password);
        deps.vault.remove(SECRET_KEYS.sessionToken);
        deps.vault.remove(SECRET_KEYS.clientKey);
        throw error;
      }
    },

    async disconnect(): Promise<void> {
      const raw = await load();
      const baseUrl = text(raw.routerUrl);
      const token = deps.vault.read(SECRET_KEYS.sessionToken);
      if (baseUrl && token) await client.logout(baseUrl, token);
      for (const key of Object.values(SECRET_KEYS)) deps.vault.remove(key);
      await save({
        ...raw,
        routerUrl: null,
        routerUsername: null,
        mekadesignConfigured: false,
        routeEnabledCache: {},
      });
    },

    async listToolsAndRoutes(): Promise<{ tools: MekaRouterTool[]; routes: MekaRouterRoute[] }> {
      const { baseUrl, token, clientKey } = await auth();
      const [tools, routes] = await Promise.all([
        client.listTools(baseUrl, clientKey),
        client.listRoutes(baseUrl, token),
      ]);
      return {
        tools: tools
          .filter(isRecord)
          .map((tool) => ({
            name: text(tool.name) ?? '',
            ...(text(tool.description) ? { description: text(tool.description)! } : {}),
          }))
          .filter((tool) => tool.name),
        routes: routes
          .filter(isRecord)
          .map((route) => ({
            id: text(route.id) ?? '',
            toolName: text(route.toolName) ?? '',
            endpoint: text(route.endpoint) ?? '',
            clientName: text(route.clientName),
            clientDescription: text(route.clientDescription),
            enabled: route.enabled === true,
          }))
          .filter((route) => route.id),
      };
    },

    async listProjectTools(projectId: string): Promise<Array<Record<string, unknown>>> {
      const { baseUrl, clientKey } = await auth();
      const raw = await load();
      const bindings = isRecord(raw.projectRemoteInstanceIds) ? raw.projectRemoteInstanceIds : {};
      const selected = bindings[projectId];
      const allowed = new Set(
        Array.isArray(selected)
          ? selected.filter((item): item is string => typeof item === 'string')
          : [],
      );
      const tools = await client.listTools(baseUrl, clientKey);
      return tools.filter(isRecord).filter((tool) => {
        const annotations = isRecord(tool.annotations) ? tool.annotations : {};
        const instanceId = text(annotations.instanceId);
        return instanceId === null || allowed.has(instanceId);
      });
    },

    async callProjectTool(
      projectId: string,
      name: string,
      args: Record<string, unknown>,
      authorizeHighRisk?: MekaRouterHighRiskAuthorization,
    ): Promise<{ content: unknown[]; isError?: boolean }> {
      const { baseUrl, clientKey } = await auth();
      const raw = await load();
      const bindings = isRecord(raw.projectRemoteInstanceIds) ? raw.projectRemoteInstanceIds : {};
      const selected = bindings[projectId];
      const allowed = new Set(
        Array.isArray(selected)
          ? selected.filter((item): item is string => typeof item === 'string')
          : [],
      );
      const tools = (await client.listTools(baseUrl, clientKey)).filter(isRecord);
      const tool = tools.find((entry) => text(entry.name) === name);
      if (!tool) throw new Error(`MCPRouter tool is not available: ${name}`);
      const annotations = isRecord(tool.annotations) ? tool.annotations : {};
      const instanceId = text(annotations.instanceId);
      if (instanceId && !allowed.has(instanceId)) {
        throw new Error(`MCPRouter instance is not bound to project ${projectId}: ${instanceId}`);
      }
      const risk = classifyMekaRouterToolRisk(
        name,
        args,
        annotations.riskLevel ?? annotations.risk,
      );
      if (risk === 'high') {
        const allowedByUser = authorizeHighRisk
          ? await authorizeHighRisk({ toolName: name, args, risk })
          : false;
        if (!allowedByUser) {
          throw new Error('High-risk MCPRouter action requires explicit user approval');
        }
      }
      return client.callTool(baseUrl, clientKey, name, args);
    },

    async setRoute(routeId: string, enabled: boolean): Promise<void> {
      const { baseUrl, token } = await auth();
      await client.setRoute(baseUrl, token, routeId, enabled);
    },

    async connectMekaDesign(endpoint: string): Promise<void> {
      const url = client.normalizeMcpEndpointUrl(endpoint);
      const { baseUrl, token } = await auth();
      await client.discover(baseUrl, token, url, {
        clientName: 'MekaDesign',
        clientDescription: 'MekaDesign 设计平台 MCP 工具',
      });
      deps.vault.store(SECRET_KEYS.mekaDesignUrl, url);
      const raw = await load();
      await save({ ...raw, mekadesignConfigured: true });
    },

    async disconnectMekaDesign(): Promise<void> {
      const endpoint = deps.vault.read(SECRET_KEYS.mekaDesignUrl);
      const { baseUrl, token } = await auth();
      if (endpoint) await client.deleteEndpointRoutes(baseUrl, token, endpoint);
      deps.vault.remove(SECRET_KEYS.mekaDesignUrl);
      const raw = await load();
      await save({ ...raw, mekadesignConfigured: false });
    },

    async listInstances(): Promise<MekaRouterInstance[]> {
      const { baseUrl, token } = await auth();
      const rows = await client.listInstances(baseUrl, token);
      return rows
        .filter(isRecord)
        .map(normalizeInstance)
        .filter((instance) => instance.id);
    },

    async listTemplates(): Promise<MekaRouterTemplate[]> {
      const { baseUrl, token } = await auth();
      const rows = await client.listTemplates(baseUrl, token);
      return rows
        .filter(isRecord)
        .map((row) => ({
          id: text(row.id) ?? '',
          name: text(row.name) ?? text(row.slug) ?? '',
          description: text(row.description),
        }))
        .filter((template) => template.id && template.name);
    },

    async createInstance(templateId: string, name: string): Promise<MekaRouterInstance> {
      const normalizedName = name.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(normalizedName)) {
        throw new Error(
          'Instance name must be 2–64 letters, numbers, dots, dashes, or underscores',
        );
      }
      const { baseUrl, token } = await auth();
      const result = (await client.findOrCreateInstance(
        baseUrl,
        token,
        templateId.trim(),
        normalizedName,
      )) as JsonRecord;
      const rawInstance = isRecord(result.instance) ? result.instance : result;
      return normalizeInstance(rawInstance);
    },

    async listProjectBindings(projectId: string): Promise<string[]> {
      const raw = await load();
      const bindings = isRecord(raw.projectRemoteInstanceIds) ? raw.projectRemoteInstanceIds : {};
      const value = bindings[projectId];
      return Array.isArray(value)
        ? [
            ...new Set(
              value
                .filter((item): item is string => typeof item === 'string' && !!item.trim())
                .map((item) => item.trim()),
            ),
          ]
        : [];
    },

    async setProjectBindings(projectId: string, instanceIds: string[]): Promise<void> {
      const raw = await load();
      const bindings = isRecord(raw.projectRemoteInstanceIds)
        ? { ...raw.projectRemoteInstanceIds }
        : {};
      bindings[projectId] = [...new Set(instanceIds.map((id) => id.trim()).filter(Boolean))];
      await save({ ...raw, projectRemoteInstanceIds: bindings });
    },

    async getTunnelAuth(): Promise<{ baseUrl: string; sessionToken: string }> {
      const { baseUrl, token } = await auth();
      return { baseUrl, sessionToken: token };
    },
  };
}

export type MekaRouterService = ReturnType<typeof createMekaRouterService>;
