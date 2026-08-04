import { isIP } from 'node:net';

import type { MekaPluginVisibility } from '../../shared/mekaDevPlugin.js';
import type { MekaSkillVisibility } from '../../shared/mekaSkillMarket.js';
import { PRODUCTION_MEKA_MCPROUTER_URL } from './config.js';

const REQUEST_TIMEOUT_MS = 15_000;
const UPLOAD_REQUEST_TIMEOUT_MS = 60_000;
const CLIENT_KEY_NAME = 'xdt-maker-meka';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RouterClientDeps {
  fetchImpl?: FetchLike;
}

export class MekaRouterRequestError extends Error {
  /** Maps HTTP statuses that the IPC layer can explain without losing detail. */
  readonly code: 'PERMISSION_DENIED' | 'ALREADY_EXISTS' | undefined;

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MekaRouterRequestError';
    this.code =
      status === 401 ? 'PERMISSION_DENIED' : status === 409 ? 'ALREADY_EXISTS' : undefined;
  }
}

export interface ManagedMekaPlugin {
  id: string;
  ghostId: string;
  visibility: MekaPluginVisibility;
  sharedUsernames: string[];
  currentRelease: {
    id: string;
    version: string;
    sha256: string;
    sizeBytes: number;
    publishedAt: string;
  };
}

export interface ManagedMekaSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: MekaSkillVisibility;
  sharedUsernames: string[];
  currentRelease: {
    id: string;
    version: string;
    sha256: string;
    sizeBytes: number;
    uncompressedSizeBytes: number;
    publishDescription?: string;
    publishedAt: string;
  };
}

interface ProxyMekaSkillUpload {
  mode: 'proxy';
  maxBytes: number;
}

interface DirectMekaSkillUpload {
  mode: 'direct';
  maxBytes: number;
  uploadId: string;
  url: string;
  expiresAt: string;
  headers: Record<string, string>;
}

function normalizeBaseUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MCPRouter URL must use HTTPS');
  }
  if (url.username || url.password) throw new Error('MCPRouter URL must not contain credentials');
  // MCPRouter has completed its domain + HTTPS migration. Any previously saved
  // HTTP or raw-IP origin now resolves to the single production Router so
  // credentials are never sent over plaintext transport or to a certificate
  // hostname mismatch.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol === 'http:' || isIP(hostname) !== 0) {
    return new URL(PRODUCTION_MEKA_MCPROUTER_URL).toString().replace(/\/$/, '');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function normalizeMcpEndpointUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MCP endpoint URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('MCP endpoint URL must not contain URL credentials');
  }
  // Query parameters may carry endpoint-scoped authorization (for example
  // MekaDesign's ?key=mcp_XXX), so unlike an MCPRouter base URL they must survive.
  url.hash = '';
  return url.toString();
}

async function fetchWithTimeout(
  deps: RouterClientDeps,
  input: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await (deps.fetchImpl ?? fetch)(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function request(
  deps: RouterClientDeps,
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  return fetchWithTimeout(deps, `${normalizeBaseUrl(baseUrl)}${pathname}`, init, timeoutMs);
}

async function readError(response: Response, operation: string): Promise<MekaRouterRequestError> {
  const text = await response.text().catch(() => '');
  return new MekaRouterRequestError(
    `MCPRouter ${operation} failed (${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
    response.status,
  );
}

function sessionHeaders(sessionToken: string): Record<string, string> {
  return {
    cookie: `session=${sessionToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
}

export function createMekaRouterClient(deps: RouterClientDeps = {}) {
  return {
    normalizeBaseUrl,
    normalizeMcpEndpointUrl,

    async login(baseUrl: string, username: string, password: string): Promise<string> {
      const response = await request(deps, baseUrl, '/api/auth/login', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) throw await readError(response, 'login');
      const cookie = response.headers.get('set-cookie') ?? '';
      const token = cookie.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
      if (!token) throw new Error('MCPRouter login did not return a session cookie');
      return token;
    },

    async ensureClientKey(baseUrl: string, token: string): Promise<string> {
      const list = await request(deps, baseUrl, '/api/keys?type=client', {
        headers: sessionHeaders(token),
      });
      if (!list.ok) throw await readError(list, 'list client keys');
      const keys = (await list.json()) as Array<{ name?: string; key?: string }>;
      const existing = Array.isArray(keys)
        ? keys.find((entry) => entry.name === CLIENT_KEY_NAME && typeof entry.key === 'string')
        : undefined;
      if (existing?.key) return existing.key;
      const created = await request(deps, baseUrl, '/api/keys', {
        method: 'POST',
        headers: sessionHeaders(token),
        body: JSON.stringify({ name: CLIENT_KEY_NAME, type: 'client' }),
      });
      if (!created.ok) throw await readError(created, 'create client key');
      const body = (await created.json()) as { key?: string };
      if (!body.key) throw new Error('MCPRouter client-key response is invalid');
      return body.key;
    },

    async listOwnedMekaPlugins(
      baseUrl: string,
      sessionToken: string,
    ): Promise<ManagedMekaPlugin[]> {
      const response = await request(deps, baseUrl, '/api/meka-plugins', {
        headers: sessionHeaders(sessionToken),
      });
      if (!response.ok) throw await readError(response, 'list owned Meka Plugins');
      const body = (await response.json()) as unknown;
      if (!Array.isArray(body)) throw new Error('MCPRouter owned Plugin response is invalid');
      return body as ManagedMekaPlugin[];
    },

    async uploadMekaPlugin(
      baseUrl: string,
      sessionToken: string,
      bytes: Uint8Array,
      pluginResourceId: string | null,
    ): Promise<ManagedMekaPlugin> {
      const body = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(body).set(bytes);
      const response = await request(
        deps,
        baseUrl,
        pluginResourceId
          ? `/api/meka-plugins/${encodeURIComponent(pluginResourceId)}/releases`
          : '/api/meka-plugins/upload',
        {
          method: 'POST',
          headers: {
            cookie: `session=${sessionToken}`,
            accept: 'application/json',
            'content-type': 'application/vnd.cindy.plugin',
          },
          body,
        },
        UPLOAD_REQUEST_TIMEOUT_MS,
      );
      if (!response.ok) throw await readError(response, 'upload Meka Plugin');
      return (await response.json()) as ManagedMekaPlugin;
    },

    async setMekaPluginAccess(
      baseUrl: string,
      sessionToken: string,
      pluginResourceId: string,
      visibility: MekaPluginVisibility,
      sharedUsernames: string[],
    ): Promise<ManagedMekaPlugin> {
      const response = await request(
        deps,
        baseUrl,
        `/api/meka-plugins/${encodeURIComponent(pluginResourceId)}/access`,
        {
          method: 'PATCH',
          headers: sessionHeaders(sessionToken),
          body: JSON.stringify({ visibility, sharedUsernames }),
        },
      );
      if (!response.ok) throw await readError(response, 'update Meka Plugin access');
      return (await response.json()) as ManagedMekaPlugin;
    },

    async listOwnedMekaSkills(baseUrl: string, sessionToken: string): Promise<ManagedMekaSkill[]> {
      const response = await request(deps, baseUrl, '/api/meka-skills', {
        headers: sessionHeaders(sessionToken),
      });
      if (!response.ok) throw await readError(response, 'list owned Meka Skills');
      const body = (await response.json()) as unknown;
      if (!Array.isArray(body)) throw new Error('MCPRouter owned Skill response is invalid');
      return body as ManagedMekaSkill[];
    },

    async uploadMekaSkill(
      baseUrl: string,
      sessionToken: string,
      bytes: Uint8Array,
      skillResourceId: string | null,
      publishDescription: string,
    ): Promise<ManagedMekaSkill> {
      const preparationResponse = await request(deps, baseUrl, '/api/meka-skills/uploads', {
        method: 'POST',
        headers: sessionHeaders(sessionToken),
        body: JSON.stringify({
          sizeBytes: bytes.byteLength,
          ...(skillResourceId ? { skillId: skillResourceId } : {}),
        }),
      });
      if (!preparationResponse.ok) {
        throw await readError(preparationResponse, 'prepare Meka Skill upload');
      }
      const preparation = (await preparationResponse.json()) as
        ProxyMekaSkillUpload | DirectMekaSkillUpload;
      if (bytes.byteLength > preparation.maxBytes) {
        throw new Error(`Meka Skill package exceeds ${preparation.maxBytes} bytes`);
      }
      const body = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(body).set(bytes);
      if (preparation.mode === 'proxy') {
        const publishQuery = publishDescription
          ? `?publishDescription=${encodeURIComponent(publishDescription)}`
          : '';
        const response = await request(
          deps,
          baseUrl,
          skillResourceId
            ? `/api/meka-skills/${encodeURIComponent(skillResourceId)}/releases${publishQuery}`
            : `/api/meka-skills/upload${publishQuery}`,
          {
            method: 'POST',
            headers: {
              cookie: `session=${sessionToken}`,
              accept: 'application/json',
              'content-type': 'application/vnd.cindy.skill+zip',
            },
            body,
          },
          UPLOAD_REQUEST_TIMEOUT_MS,
        );
        if (!response.ok) throw await readError(response, 'upload Meka Skill');
        return (await response.json()) as ManagedMekaSkill;
      }
      const uploaded = await fetchWithTimeout(
        deps,
        preparation.url,
        {
          method: 'PUT',
          headers: preparation.headers,
          body,
          credentials: 'omit',
        },
        UPLOAD_REQUEST_TIMEOUT_MS,
      );
      if (!uploaded.ok) throw await readError(uploaded, 'upload Meka Skill to RustFS');
      const finalized = await request(
        deps,
        baseUrl,
        `/api/meka-skills/uploads/${encodeURIComponent(preparation.uploadId)}/finalize`,
        {
          method: 'POST',
          headers: sessionHeaders(sessionToken),
          body: JSON.stringify({
            ...(skillResourceId ? { skillId: skillResourceId } : {}),
            ...(publishDescription ? { publishDescription } : {}),
          }),
        },
        UPLOAD_REQUEST_TIMEOUT_MS,
      );
      if (!finalized.ok) throw await readError(finalized, 'finalize Meka Skill upload');
      return (await finalized.json()) as ManagedMekaSkill;
    },

    async setMekaSkillAccess(
      baseUrl: string,
      sessionToken: string,
      skillResourceId: string,
      visibility: MekaSkillVisibility,
      sharedUsernames: string[],
    ): Promise<ManagedMekaSkill> {
      const response = await request(
        deps,
        baseUrl,
        `/api/meka-skills/${encodeURIComponent(skillResourceId)}/access`,
        {
          method: 'PATCH',
          headers: sessionHeaders(sessionToken),
          body: JSON.stringify({ visibility, sharedUsernames }),
        },
      );
      if (!response.ok) throw await readError(response, 'update Meka Skill access');
      return (await response.json()) as ManagedMekaSkill;
    },

    async deleteMekaSkill(
      baseUrl: string,
      sessionToken: string,
      skillResourceId: string,
    ): Promise<void> {
      const response = await request(
        deps,
        baseUrl,
        `/api/meka-skills/${encodeURIComponent(skillResourceId)}`,
        {
          method: 'DELETE',
          headers: sessionHeaders(sessionToken),
        },
      );
      if (!response.ok) throw await readError(response, 'delete Meka Skill');
    },

    async listTools(baseUrl: string, clientKey: string) {
      const endpoint = `/mcp/${encodeURIComponent(clientKey)}`;
      const headers: Record<string, string> = {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      };
      const init = await request(deps, baseUrl, endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: CLIENT_KEY_NAME, version: '1' },
          },
        }),
      });
      if (!init.ok) throw await readError(init, 'initialize MCP');
      const sessionId = init.headers.get('mcp-session-id');
      if (sessionId) headers['mcp-session-id'] = sessionId;
      await request(deps, baseUrl, endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      const tools: unknown[] = [];
      let cursor: string | undefined;
      let requestId = 2;
      do {
        const listed = await request(deps, baseUrl, endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
            method: 'tools/list',
            params: cursor ? { cursor } : {},
          }),
        });
        if (!listed.ok) throw await readError(listed, 'list MCP tools');
        const body = (await listed.json()) as {
          result?: { tools?: unknown[]; nextCursor?: string };
        };
        if (Array.isArray(body.result?.tools)) tools.push(...body.result.tools);
        cursor = body.result?.nextCursor;
        requestId += 1;
      } while (cursor);
      return tools;
    },

    async callTool(
      baseUrl: string,
      clientKey: string,
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ content: unknown[]; isError?: boolean }> {
      const endpoint = `/mcp/${encodeURIComponent(clientKey)}`;
      const headers: Record<string, string> = {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      };
      const initialized = await request(deps, baseUrl, endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: CLIENT_KEY_NAME, version: '1' },
          },
        }),
      });
      if (!initialized.ok) throw await readError(initialized, 'initialize MCP');
      const sessionId = initialized.headers.get('mcp-session-id');
      if (sessionId) headers['mcp-session-id'] = sessionId;
      const notified = await request(deps, baseUrl, endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      if (!notified.ok) throw await readError(notified, 'finish MCP initialization');
      const response = await request(deps, baseUrl, endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      if (!response.ok) throw await readError(response, `call MCP tool ${name}`);
      const payload = (await response.json()) as {
        error?: { message?: string };
        result?: { content?: unknown[]; isError?: boolean };
      };
      if (payload.error) throw new Error(payload.error.message ?? `MCP tool ${name} failed`);
      return {
        content: Array.isArray(payload.result?.content) ? payload.result.content : [],
        ...(payload.result?.isError === true ? { isError: true } : {}),
      };
    },

    async listRoutes(baseUrl: string, token: string) {
      const response = await request(deps, baseUrl, '/api/routes', {
        headers: sessionHeaders(token),
      });
      if (!response.ok) throw await readError(response, 'list routes');
      const body = await response.json();
      return Array.isArray(body) ? body : [];
    },

    async setRoute(baseUrl: string, token: string, routeId: string, enabled: boolean) {
      const response = await request(deps, baseUrl, `/api/routes/${encodeURIComponent(routeId)}`, {
        method: 'PUT',
        headers: sessionHeaders(token),
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw await readError(response, 'update route');
    },

    async discover(
      baseUrl: string,
      token: string,
      endpoint: string,
      metadata?: { clientName?: string; clientDescription?: string },
    ) {
      const response = await request(deps, baseUrl, '/api/routes/discover', {
        method: 'POST',
        headers: sessionHeaders(token),
        body: JSON.stringify({ endpoint, protocol: 'http', ...metadata }),
      });
      if (!response.ok) throw await readError(response, 'discover MekaDesign');
    },

    async deleteEndpointRoutes(baseUrl: string, token: string, endpoint: string) {
      const routes = (await this.listRoutes(baseUrl, token)) as Array<{
        id?: string;
        endpoint?: string;
      }>;
      for (const route of routes) {
        if (route.endpoint !== endpoint || !route.id) continue;
        const response = await request(
          deps,
          baseUrl,
          `/api/routes/${encodeURIComponent(route.id)}`,
          { method: 'DELETE', headers: sessionHeaders(token) },
        );
        if (!response.ok) throw await readError(response, 'delete MekaDesign route');
      }
    },

    async listInstances(baseUrl: string, token: string) {
      const response = await request(deps, baseUrl, '/api/project-agent-instances', {
        headers: sessionHeaders(token),
      });
      if (!response.ok) throw await readError(response, 'list project instances');
      const body = await response.json();
      return Array.isArray(body) ? body : [];
    },

    async listTemplates(baseUrl: string, token: string) {
      const response = await request(deps, baseUrl, '/api/projects', {
        headers: sessionHeaders(token),
      });
      if (!response.ok) throw await readError(response, 'list project templates');
      const body = await response.json();
      return Array.isArray(body) ? body : [];
    },

    async findOrCreateInstance(baseUrl: string, token: string, projectId: string, name: string) {
      const response = await request(deps, baseUrl, '/api/project-agent-instances/find-or-create', {
        method: 'POST',
        headers: sessionHeaders(token),
        body: JSON.stringify({ projectId, name }),
      });
      if (!response.ok) throw await readError(response, 'create project instance');
      return response.json();
    },

    async logout(baseUrl: string, token: string) {
      await request(deps, baseUrl, '/api/auth/logout', {
        method: 'POST',
        headers: sessionHeaders(token),
      }).catch(() => undefined);
    },
  };
}

export type MekaRouterClient = ReturnType<typeof createMekaRouterClient>;
