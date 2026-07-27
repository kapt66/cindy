const REQUEST_TIMEOUT_MS = 15_000;
const CLIENT_KEY_NAME = 'xdt-maker-meka';

type FetchLike = typeof fetch;

export interface RouterClientDeps {
  fetchImpl?: FetchLike;
}

function normalizeBaseUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MCPRouter URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) throw new Error('MCPRouter URL must not contain credentials');
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

async function request(
  deps: RouterClientDeps,
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await (deps.fetchImpl ?? fetch)(`${normalizeBaseUrl(baseUrl)}${pathname}`, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readError(response: Response, operation: string): Promise<Error> {
  const text = await response.text().catch(() => '');
  return new Error(
    `MCPRouter ${operation} failed (${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
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
