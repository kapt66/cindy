import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  buildMcprRemoteHostId,
  isMekaRouterInstanceAvailable,
  type MekaRouterInstance,
  type MekaRouterRoute,
  type MekaRouterSettingsView,
  type MekaRouterTemplate,
  type MekaRouterTool,
} from '../../shared/meka-router.js';
import type {
  MekaDevPluginUploadInfo,
  MekaDevPluginUploadResult,
  MekaPluginVisibility,
} from '../../shared/mekaDevPlugin.js';
import { createMekaRouterClient, type MekaRouterClient } from './routerClient.js';
import { classifyMekaRouterToolRisk, type MekaToolRisk } from './mekaRiskPolicy.js';
import { DEFAULT_MEKA_MCPROUTER_URL } from './config.js';

type JsonRecord = Record<string, unknown>;

function publishError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

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

function opaqueEndpointId(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

function hasLegacyMekaDesignKey(endpoint: string): boolean {
  try {
    return new URL(endpoint).searchParams.get('key')?.startsWith('mcp_') === true;
  } catch {
    return false;
  }
}

function findMekaDesignEndpoint(
  routes: unknown[],
  preferredEndpoint: string | null,
  legacyConfigured: boolean,
): string | null {
  const records = routes.filter(isRecord);
  const allEndpoints = [
    ...new Set(
      records
        .map((route) => text(route.endpoint))
        .filter((endpoint): endpoint is string => endpoint !== null),
    ),
  ];
  const namedEndpoints = [
    ...new Set(
      records
        .filter((route) => text(route.clientName)?.toLowerCase() === 'mekadesign')
        .map((route) => text(route.endpoint))
        .filter((endpoint): endpoint is string => endpoint !== null),
    ),
  ];
  if (preferredEndpoint && namedEndpoints.includes(preferredEndpoint)) return preferredEndpoint;
  if (namedEndpoints.length > 0) return namedEndpoints[0];
  if (!legacyConfigured) return null;
  if (preferredEndpoint && allEndpoints.includes(preferredEndpoint)) return preferredEndpoint;
  // XDMaker registered routes before MCPRouter accepted clientName metadata, while its encrypted
  // endpoint cannot migrate into Cindy Meka. Only recover the unique legacy MekaDesign key shape.
  const legacyEndpoints = allEndpoints.filter(hasLegacyMekaDesignKey);
  return legacyEndpoints.length === 1 ? legacyEndpoints[0] : null;
}

function findMekaDesignToolNames(
  routes: unknown[],
  preferredEndpoint: string | null,
  legacyConfigured: boolean,
): Set<string> {
  const designEndpoint = findMekaDesignEndpoint(routes, preferredEndpoint, legacyConfigured);
  return new Set(
    routes
      .filter(isRecord)
      .filter(
        (route) =>
          text(route.clientName)?.toLowerCase() === 'mekadesign' ||
          (!!designEndpoint && text(route.endpoint) === designEndpoint),
      )
      .map((route) => text(route.toolName))
      .filter((toolName): toolName is string => toolName !== null),
  );
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
    const configuredBaseUrl = text(raw.routerUrl);
    const baseUrl = configuredBaseUrl ? client.normalizeBaseUrl(configuredBaseUrl) : null;
    const token = deps.vault.read(SECRET_KEYS.sessionToken);
    const clientKey = deps.vault.read(SECRET_KEYS.clientKey);
    if (!baseUrl || !token || !clientKey) throw new Error('MCPRouter is not configured');
    return { baseUrl, token, clientKey };
  }

  async function syncMekaDesignFromRouter(
    raw: JsonRecord,
    baseUrl: string,
    token: string,
  ): Promise<{ designUrl: string | null; routerUrl: string | null; conflict: boolean }> {
    const previousUrl = deps.vault.read(SECRET_KEYS.mekaDesignUrl);
    const routes = await client.listRoutes(baseUrl, token);
    const routerUrl = findMekaDesignEndpoint(
      routes,
      previousUrl,
      raw.mekadesignConfigured === true,
    );
    if (raw.mekaDesignRouterSyncSuppressed === true && !previousUrl) {
      return { designUrl: null, routerUrl, conflict: false };
    }
    if (previousUrl && routerUrl && previousUrl !== routerUrl) {
      return { designUrl: previousUrl, routerUrl, conflict: true };
    }
    const syncedUrl = previousUrl ?? routerUrl;
    const syncedConfigured = syncedUrl !== null;
    if (previousUrl === syncedUrl && (raw.mekadesignConfigured === true) === syncedConfigured) {
      return { designUrl: syncedUrl, routerUrl, conflict: false };
    }
    try {
      if (syncedUrl) deps.vault.store(SECRET_KEYS.mekaDesignUrl, syncedUrl);
      await save({ ...raw, mekadesignConfigured: syncedConfigured });
      return { designUrl: syncedUrl, routerUrl, conflict: false };
    } catch (error) {
      if (previousUrl) deps.vault.store(SECRET_KEYS.mekaDesignUrl, previousUrl);
      else deps.vault.remove(SECRET_KEYS.mekaDesignUrl);
      throw error;
    }
  }

  async function saveMekaDesignEndpoint(raw: JsonRecord, url: string): Promise<void> {
    const previousUrl = deps.vault.read(SECRET_KEYS.mekaDesignUrl);
    deps.vault.store(SECRET_KEYS.mekaDesignUrl, url);
    try {
      await save({
        ...raw,
        mekadesignConfigured: true,
        mekaDesignRouterSyncSuppressed: false,
      });
    } catch (error) {
      if (previousUrl) deps.vault.store(SECRET_KEYS.mekaDesignUrl, previousUrl);
      else deps.vault.remove(SECRET_KEYS.mekaDesignUrl);
      throw error;
    }
  }

  return {
    async getSettings(): Promise<MekaRouterSettingsView> {
      const raw = await load();
      const configuredBaseUrl = text(raw.routerUrl);
      const routerUrl = configuredBaseUrl ? client.normalizeBaseUrl(configuredBaseUrl) : null;
      const token = deps.vault.read(SECRET_KEYS.sessionToken);
      const clientKey = deps.vault.read(SECRET_KEYS.clientKey);
      let designUrl = deps.vault.read(SECRET_KEYS.mekaDesignUrl);
      let mekaDesignConfigured = raw.mekadesignConfigured === true && !!designUrl;
      let mekaDesignConflict = false;
      let mekaDesignConflictId: string | null = null;
      if (
        routerUrl &&
        token &&
        clientKey &&
        !(typeof raw.schemaVersion === 'number' && raw.schemaVersion > 1)
      ) {
        try {
          const synced = await syncMekaDesignFromRouter(raw, routerUrl, token);
          designUrl = synced.designUrl;
          mekaDesignConflict = synced.conflict;
          mekaDesignConflictId =
            synced.conflict && synced.designUrl && synced.routerUrl
              ? opaqueEndpointId(`${synced.designUrl}\0${synced.routerUrl}`)
              : null;
          mekaDesignConfigured = designUrl !== null;
        } catch {
          // Settings remain usable with the last local state while MCPRouter is unavailable.
        }
      }
      return {
        configured: !!routerUrl && !!token && !!clientKey,
        routerUrl,
        defaultRouterUrl: DEFAULT_MEKA_MCPROUTER_URL,
        routerUsername: text(raw.routerUsername),
        mekaDesignConfigured,
        mekaDesignUrl: designUrl,
        mekaDesignConflict,
        mekaDesignConflictId,
      };
    },

    async connect(routerUrl: string, username: string, password: string): Promise<void> {
      const baseUrl = client.normalizeBaseUrl(routerUrl.trim() || DEFAULT_MEKA_MCPROUTER_URL);
      const normalizedUsername = username.trim();
      if (!normalizedUsername || !password) throw new Error('MCPRouter credentials are required');
      const token = await client.login(baseUrl, normalizedUsername, password);
      const clientKey = await client.ensureClientKey(baseUrl, token);
      const raw = await load();
      const existingMekaDesignUrl = deps.vault.read(SECRET_KEYS.mekaDesignUrl);
      let mekaDesignUrl: string | null = null;
      let routeDiscoverySucceeded = false;
      try {
        const routes = await client.listRoutes(baseUrl, token);
        routeDiscoverySucceeded = true;
        mekaDesignUrl = findMekaDesignEndpoint(
          routes,
          existingMekaDesignUrl,
          raw.mekadesignConfigured === true,
        );
      } catch {
        // Router login remains valid when optional MekaDesign route discovery is unavailable.
      }
      const effectiveMekaDesignUrl =
        existingMekaDesignUrl ??
        (raw.mekaDesignRouterSyncSuppressed === true ? null : mekaDesignUrl);
      try {
        deps.vault.store(SECRET_KEYS.password, password);
        deps.vault.store(SECRET_KEYS.sessionToken, token);
        deps.vault.store(SECRET_KEYS.clientKey, clientKey);
        if (effectiveMekaDesignUrl) {
          deps.vault.store(SECRET_KEYS.mekaDesignUrl, effectiveMekaDesignUrl);
        }
        await save({
          ...raw,
          routerUrl: baseUrl,
          routerUsername: normalizedUsername,
          mekadesignConfigured:
            effectiveMekaDesignUrl !== null ||
            (!routeDiscoverySucceeded && raw.mekadesignConfigured === true),
        });
      } catch (error) {
        for (const key of [SECRET_KEYS.password, SECRET_KEYS.sessionToken, SECRET_KEYS.clientKey]) {
          deps.vault.remove(key);
        }
        if (existingMekaDesignUrl) {
          deps.vault.store(SECRET_KEYS.mekaDesignUrl, existingMekaDesignUrl);
        } else {
          deps.vault.remove(SECRET_KEYS.mekaDesignUrl);
        }
        throw error;
      }
    },

    async disconnect(): Promise<void> {
      const raw = await load();
      const configuredBaseUrl = text(raw.routerUrl);
      const baseUrl = configuredBaseUrl ? client.normalizeBaseUrl(configuredBaseUrl) : null;
      const token = deps.vault.read(SECRET_KEYS.sessionToken);
      if (baseUrl && token) await client.logout(baseUrl, token);
      for (const key of [SECRET_KEYS.password, SECRET_KEYS.sessionToken, SECRET_KEYS.clientKey]) {
        deps.vault.remove(key);
      }
      await save({
        ...raw,
        routerUrl: null,
        routerUsername: null,
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
      const { baseUrl, token, clientKey } = await auth();
      const raw = await load();
      const bindings = isRecord(raw.projectRemoteInstanceIds) ? raw.projectRemoteInstanceIds : {};
      const selected = bindings[projectId];
      const allowed = new Set(
        Array.isArray(selected)
          ? selected.filter((item): item is string => typeof item === 'string')
          : [],
      );
      const [tools, routes] = await Promise.all([
        client.listTools(baseUrl, clientKey),
        client.listRoutes(baseUrl, token),
      ]);
      const mekaDesignTools = findMekaDesignToolNames(
        routes,
        deps.vault.read(SECRET_KEYS.mekaDesignUrl),
        raw.mekadesignConfigured === true,
      );
      return tools.filter(isRecord).filter((tool) => {
        if (mekaDesignTools.has(text(tool.name) ?? '')) return false;
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
      const { baseUrl, token, clientKey } = await auth();
      const raw = await load();
      const bindings = isRecord(raw.projectRemoteInstanceIds) ? raw.projectRemoteInstanceIds : {};
      const selected = bindings[projectId];
      const allowed = new Set(
        Array.isArray(selected)
          ? selected.filter((item): item is string => typeof item === 'string')
          : [],
      );
      const [toolRows, routes] = await Promise.all([
        client.listTools(baseUrl, clientKey),
        client.listRoutes(baseUrl, token),
      ]);
      const mekaDesignTools = findMekaDesignToolNames(
        routes,
        deps.vault.read(SECRET_KEYS.mekaDesignUrl),
        raw.mekadesignConfigured === true,
      );
      if (mekaDesignTools.has(name)) {
        throw new Error('MekaDesign tools are available only through the direct MekaDesign MCP');
      }
      const tools = toolRows.filter(isRecord);
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
      const raw = await load();
      await saveMekaDesignEndpoint(raw, url);
    },

    async useMekaDesignFromRouter(conflictId: string): Promise<void> {
      const { baseUrl, token } = await auth();
      const raw = await load();
      const routes = await client.listRoutes(baseUrl, token);
      const url = findMekaDesignEndpoint(routes, null, raw.mekadesignConfigured === true);
      if (!url) throw new Error('MCPRouter does not have a MekaDesign address');
      const currentUrl = deps.vault.read(SECRET_KEYS.mekaDesignUrl);
      if (!currentUrl || opaqueEndpointId(`${currentUrl}\0${url}`) !== conflictId) {
        throw new Error('MekaDesign address conflict changed; refresh settings and confirm again');
      }
      await saveMekaDesignEndpoint(raw, url);
    },

    async disconnectMekaDesign(): Promise<void> {
      const raw = await load();
      const previousUrl = deps.vault.read(SECRET_KEYS.mekaDesignUrl);
      deps.vault.remove(SECRET_KEYS.mekaDesignUrl);
      try {
        await save({
          ...raw,
          mekadesignConfigured: false,
          mekaDesignRouterSyncSuppressed: true,
        });
      } catch (error) {
        if (previousUrl) deps.vault.store(SECRET_KEYS.mekaDesignUrl, previousUrl);
        throw error;
      }
    },

    getMekaDesignEndpoint(): string | null {
      return deps.vault.read(SECRET_KEYS.mekaDesignUrl);
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

    async getMekaPluginUploadInfo(
      pluginId: string,
      version: string,
    ): Promise<MekaDevPluginUploadInfo> {
      const { baseUrl, token } = await auth();
      const existing = (await client.listOwnedMekaPlugins(baseUrl, token)).find(
        (plugin) => plugin.ghostId === pluginId,
      );
      return {
        pluginId,
        version,
        existing: existing
          ? {
              pluginResourceId: existing.id,
              currentReleaseId: existing.currentRelease.id,
              currentVersion: existing.currentRelease.version,
              visibility: existing.visibility,
              sharedUsernames: existing.sharedUsernames,
            }
          : null,
      };
    },

    /**
     * Publish one immutable .cindy Release and then synchronize its access
     * settings through MCPRouter's owner-management API. Retrying a release
     * whose version is already current only retries access synchronization.
     */
    async uploadMekaPlugin(
      bytes: Uint8Array,
      pluginId: string,
      version: string,
      visibility: MekaPluginVisibility,
      sharedUsernames: string[],
      expectedCurrentReleaseId: string | null,
    ): Promise<MekaDevPluginUploadResult> {
      const { baseUrl, token } = await auth();
      const normalizedSharedUsernames = [
        ...new Set(sharedUsernames.map((username) => username.trim()).filter(Boolean)),
      ];
      if (visibility === 'shared' && normalizedSharedUsernames.length === 0) {
        throw publishError('INVALID_PARAMS', 'Shared visibility requires at least one username.');
      }
      const existing = (await client.listOwnedMekaPlugins(baseUrl, token)).find(
        (plugin) => plugin.ghostId === pluginId,
      );
      if ((existing?.currentRelease.id ?? null) !== expectedCurrentReleaseId) {
        throw publishError(
          'PRECONDITION_FAILED',
          'The MCPRouter Plugin changed after the upload preview was loaded.',
        );
      }

      const releasePublished = existing?.currentRelease.version !== version;
      const published = releasePublished
        ? await client.uploadMekaPlugin(baseUrl, token, bytes, existing?.id ?? null)
        : existing;
      if (!published) {
        throw publishError('INTERNAL', 'MCPRouter did not return the published Plugin.');
      }
      await client.setMekaPluginAccess(
        baseUrl,
        token,
        published.id,
        visibility,
        visibility === 'shared' ? normalizedSharedUsernames : [],
      );
      return {
        pluginId,
        version,
        visibility,
        releasePublished,
      };
    },

    /**
     * Resolve the registry origin independently from Router authentication.
     * A complete binding adds its persistent client key; session tokens and
     * saved passwords never enter plugin delivery.
     */
    async getPluginRegistryAccess(): Promise<{
      baseUrl: string;
      clientKey: string | null;
    }> {
      const raw = await load();
      const configuredBaseUrl = text(raw.routerUrl);
      const baseUrl = client.normalizeBaseUrl(configuredBaseUrl ?? DEFAULT_MEKA_MCPROUTER_URL);
      const token = deps.vault.read(SECRET_KEYS.sessionToken);
      const clientKey = deps.vault.read(SECRET_KEYS.clientKey);
      return {
        baseUrl,
        // connect() stores secrets before atomically saving their matching
        // origin. Never send a newly provisioned key to the default origin
        // during that short persistence window.
        clientKey: configuredBaseUrl && token && clientKey ? clientKey : null,
      };
    },
  };
}

export type MekaRouterService = ReturnType<typeof createMekaRouterService>;
