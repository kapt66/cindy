import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  createCapabilityBridgeMcpServer,
  createCapabilityMcpServer,
  type CapabilityMcpSkillEntry,
} from './capability-mcp-server.js';

import type { ManagerLogger } from './server.js';

const CAPABILITY_PATH = '/mcp/lizi_capabilities';
const INIT_BODY_MAX_BYTES = 1024 * 1024;

interface RevisionRegistration {
  revisionHash: string;
  snapshotRoot: string;
  entries: readonly CapabilityMcpSkillEntry[];
  createServer: () => McpServer;
}

interface CapabilityClientSession {
  client: Client;
}

interface SessionTransport {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
}

export interface CapabilityMcpRouterOptions {
  logger: ManagerLogger;
  port?: number;
  token?: string;
}

/**
 * Daemon-owned capability MCP facade for remote Codex app-server processes.
 *
 * The HTTP surface is process-global and stable, while tool calls are routed
 * by Codex's trusted `_meta.threadId` to one immutable revision registration.
 * Revision bytes remain in the daemon-local capability bundle cache.
 */
export class CapabilityMcpRouter {
  private readonly logger: ManagerLogger;
  private readonly requestedPort: number;
  readonly token: string;
  private readonly registrations = new Map<string, RevisionRegistration>();
  private readonly revisionByThread = new Map<string, string>();
  private readonly clients = new WeakMap<RevisionRegistration, Promise<CapabilityClientSession>>();
  private readonly transports = new Map<string, SessionTransport>();
  private httpServer: http.Server | null = null;
  private listeningPort: number | null = null;

  constructor(options: CapabilityMcpRouterOptions) {
    this.logger = options.logger;
    this.requestedPort = options.port ?? 0;
    this.token = options.token ?? randomBytes(32).toString('hex');
  }

  get port(): number {
    if (this.listeningPort === null) throw new Error('capability MCP router is not started');
    return this.listeningPort;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}${CAPABILITY_PATH}`;
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        this.logger.error('capability MCP request failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('Internal server error');
        }
      });
    });
    server.keepAliveTimeout = 0;
    server.headersTimeout = 0;
    server.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.requestedPort, '127.0.0.1', resolve);
    });
    this.httpServer = server;
    this.listeningPort = (server.address() as AddressInfo).port;
    this.logger.info('capability MCP router listening', { port: this.listeningPort });
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = null;
    this.listeningPort = null;
    for (const session of this.transports.values()) {
      await session.transport.close().catch(() => undefined);
    }
    this.transports.clear();
    this.revisionByThread.clear();
    this.registrations.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  registerRevision(
    revisionHash: string,
    snapshotRoot: string,
    entries: readonly CapabilityMcpSkillEntry[],
  ): void {
    const frozenEntries = entries.map((entry) => ({ ...entry }));
    const registration: RevisionRegistration = {
      revisionHash,
      snapshotRoot,
      entries: frozenEntries,
      createServer: () => createCapabilityMcpServer({
        snapshotRoot,
        entries: frozenEntries,
      }),
    };
    // Construct once now so duplicate ids and malformed metadata fail closed
    // at registration rather than during a later model tool call.
    registration.createServer();
    this.registrations.set(revisionHash, registration);
  }

  async registerRevisionFromBundle(revisionHash: string, bundleRoot: string): Promise<void> {
    const catalogPath = path.join(bundleRoot, 'catalog.json');
    const parsed = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) throw new Error('capability bundle catalog.json must be an array');
    const entries = parsed.map((value) => parseSkillEntry(value));
    this.registerRevision(revisionHash, bundleRoot, entries);
  }

  registerThread(threadId: string, revisionHash: string): void {
    if (!threadId.trim()) throw new Error('capability threadId is required');
    if (!this.registrations.has(revisionHash)) {
      throw new Error(`capability revision is not registered: ${revisionHash}`);
    }
    this.revisionByThread.set(threadId, revisionHash);
  }

  unregisterThread(threadId: string): boolean {
    return this.revisionByThread.delete(threadId);
  }

  unregisterRevision(revisionHash: string): void {
    this.registrations.delete(revisionHash);
    for (const [threadId, registeredRevision] of this.revisionByThread) {
      if (registeredRevision === revisionHash) this.revisionByThread.delete(threadId);
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress ?? '';
    if (!isLocalhost(remote)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    if (req.url !== CAPABILITY_PATH) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${this.token}`) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.end();
      return;
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;
    if (!sessionId) {
      await this.initializeSession(req, res);
      return;
    }
    const session = this.transports.get(sessionId);
    if (!session) {
      res.statusCode = 404;
      res.end('Unknown session');
      return;
    }

    let body: unknown;
    if (req.method === 'POST') {
      body = await readJsonBody(req);
      const calls = extractCapabilityToolCalls(body);
      if (calls) {
        const threadId = extractCodexThreadId(body);
        const revisionHash = threadId ? this.revisionByThread.get(threadId) : undefined;
        const registration = revisionHash ? this.registrations.get(revisionHash) : undefined;
        if (!registration) {
          writeToolResponses(res, calls.map((call) => ({
            id: call.id,
            result: skillUnavailableResult(),
          })), Array.isArray(body));
          return;
        }
        try {
          const revisionClient = await this.resolveRevisionClient(registration);
          const results = await Promise.all(calls.map(async (call) => ({
            id: call.id,
            result: await revisionClient.client.callTool({
              name: call.name,
              arguments: call.arguments,
            }),
          })));
          writeToolResponses(res, results, Array.isArray(body));
        } catch (error) {
          this.logger.warn('capability MCP revision dispatch failed', {
            threadId,
            revisionHash,
            error: error instanceof Error ? error.message : String(error),
          });
          writeToolResponses(res, calls.map((call) => ({
            id: call.id,
            result: skillUnavailableResult(),
          })), Array.isArray(body));
        }
        return;
      }
    }
    await session.transport.handleRequest(req, res, body);
  }

  private async initializeSession(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.statusCode = 400;
      res.end('Missing mcp-session-id');
      return;
    }
    const body = await readJsonBody(req, INIT_BODY_MAX_BYTES);
    if (!isInitializeRequest(body)) {
      res.statusCode = 400;
      res.end('Expected initialize request');
      return;
    }

    const mcpServer = createCapabilityBridgeMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newId) => {
        this.transports.set(newId, { transport, mcpServer });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.transports.delete(transport.sessionId);
    };
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private async resolveRevisionClient(
    registration: RevisionRegistration,
  ): Promise<CapabilityClientSession> {
    const existing = this.clients.get(registration);
    if (existing) return await existing;
    const connecting = (async () => {
      const server = registration.createServer();
      const client = new Client({ name: 'cc-mgr-capability-router', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return { client };
    })();
    this.clients.set(registration, connecting);
    try {
      return await connecting;
    } catch (error) {
      if (this.clients.get(registration) === connecting) this.clients.delete(registration);
      throw error;
    }
  }
}

function parseSkillEntry(value: unknown): CapabilityMcpSkillEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('capability catalog entry must be an object');
  }
  const entry = value as Record<string, unknown>;
  for (const key of ['packId', 'skillId', 'name', 'description', 'relPath'] as const) {
    if (typeof entry[key] !== 'string' || entry[key].length === 0) {
      throw new Error(`capability catalog entry ${key} must be a non-empty string`);
    }
  }
  return entry as unknown as CapabilityMcpSkillEntry;
}

async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer;
    received += buffer.length;
    if (received > maxBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim() ? JSON.parse(text) : undefined;
}

function extractCodexThreadId(body: unknown): string | undefined {
  const messages = Array.isArray(body) ? body : [body];
  let result: string | undefined;
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
    const params = (message as { params?: unknown }).params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
    const meta = (params as { _meta?: unknown })._meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
    const threadId = (meta as { threadId?: unknown }).threadId;
    if (typeof threadId !== 'string' || !threadId.trim()) return undefined;
    if (result && result !== threadId) return undefined;
    result = threadId;
  }
  return result;
}

interface CapabilityToolCall {
  id: string | number;
  name: 'list_skills' | 'read_skill';
  arguments: Record<string, unknown>;
}

function extractCapabilityToolCalls(body: unknown): CapabilityToolCall[] | null {
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return null;
  const calls: CapabilityToolCall[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    const request = message as { id?: unknown; method?: unknown; params?: unknown };
    if (request.method !== 'tools/call') return null;
    if (typeof request.id !== 'string' && typeof request.id !== 'number') return null;
    if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) return null;
    const params = request.params as { name?: unknown; arguments?: unknown };
    if (params.name !== 'list_skills' && params.name !== 'read_skill') return null;
    calls.push({
      id: request.id,
      name: params.name,
      arguments: params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments as Record<string, unknown>
        : {},
    });
  }
  return calls;
}

function skillUnavailableResult() {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ ok: false, errorCode: 'SKILL_UNAVAILABLE' }),
    }],
    isError: true as const,
  };
}

function writeToolResponses(
  res: http.ServerResponse,
  responses: Array<{ id: string | number; result: unknown }>,
  isBatch: boolean,
): void {
  const payload = responses.map(({ id, result }) => ({ jsonrpc: '2.0', id, result }));
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(isBatch ? payload : payload[0]));
}

function isLocalhost(remote: string): boolean {
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}
