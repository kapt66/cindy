import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcClient } from '../src/client.js';
import {
  METHODS,
  SERVER_METHODS,
  type McpTunnelCallParams,
} from '../src/protocol.js';
import { wireSdkHandlers } from '../src/sdk-handlers.js';
import { ManagerServer } from '../src/server.js';
import {
  SessionRegistry,
  type SdkQueryFactory,
  type SdkQueryLike,
} from '../src/session-registry.js';

interface Context {
  server: ManagerServer;
  socketPath: string;
  captured: Array<Record<string, unknown>>;
}

let context: Context | null = null;
const clients: Array<{ socket: net.Socket; client: RpcClient }> = [];

function makeIpcPath(): string {
  const unique = `cc-mgr-tunnel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${unique}`
    : path.join(os.tmpdir(), `${unique}.sock`);
}

function fakeFactory(captured: Array<Record<string, unknown>>): SdkQueryFactory {
  return (options): SdkQueryLike => {
    captured.push({ mcpServers: options.mcpServers });
    async function* messages(): AsyncGenerator<unknown> {
      yield { type: 'system', subtype: 'init', session_id: 'fake-sdk-id' };
      for await (const _message of options.inputStream) {
        // Keep the fake SDK session alive.
      }
    }
    const iterator = messages();
    return {
      [Symbol.asyncIterator]: () => iterator,
      async interrupt() {},
      async setModel() {},
      async setPermissionMode() {},
      async applyFlagSettings() {},
    };
  };
}

async function connectClient(): Promise<RpcClient> {
  const socket = net.connect(context!.socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const client = new RpcClient(socket);
  await client.hello({ timeoutMs: 5_000 });
  clients.push({ socket, client });
  return client;
}

beforeEach(async () => {
  const socketPath = makeIpcPath();
  const captured: Array<Record<string, unknown>> = [];
  const registry = new SessionRegistry({ sdkQueryFactory: fakeFactory(captured) });
  const server = new ManagerServer({
    socketPath,
    managerVersion: 'test',
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
  wireSdkHandlers(server, registry, { daemonSocketPath: socketPath });
  await server.start();
  context = { server, socketPath, captured };
});

afterEach(async () => {
  for (const { socket, client } of clients.splice(0)) {
    client.dispose();
    socket.destroy();
  }
  if (context) await context.server.stop();
  context = null;
});

describe('remote in-process MCP tunnel', () => {
  it('projects declared server names as remote stdio shims', async () => {
    const desktop = await connectClient();
    await desktop.request(METHODS.QUERY_START, {
      sessionId: 'session-1',
      cwd: '/repo',
      model: 'fake',
      env: {},
      tunneledMcpServers: ['orca_worker_bridge'],
    });

    const servers = context!.captured[0]!.mcpServers as Record<string, {
      type: string;
      command: string;
      args: string[];
    }>;
    expect(servers.orca_worker_bridge.type).toBe('stdio');
    expect(servers.orca_worker_bridge.command).toBe(process.execPath);
    expect(servers.orca_worker_bridge.args.slice(1)).toEqual([
      'mcp-shim',
      '--socket', context!.socketPath,
      '--session', 'session-1',
      '--server', 'orca_worker_bridge',
    ]);
  });

  it('routes shim calls to the attached desktop and returns its result', async () => {
    const desktop = await connectClient();
    desktop.setRequestHandler(SERVER_METHODS.MCP_TUNNEL_CALL, async (params) => {
      const request = params as McpTunnelCallParams;
      return request.operation === 'listTools'
        ? { tools: [{ name: 'send_to_lead', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: JSON.stringify(request.arguments) }] };
    });
    await desktop.request(METHODS.QUERY_START, {
      sessionId: 'session-2',
      cwd: '/repo',
      model: 'fake',
      env: {},
      tunneledMcpServers: ['orca_worker_bridge'],
    });

    const shim = await connectClient();
    const result = await shim.request(METHODS.MCP_TUNNEL_CALL, {
      sessionId: 'session-2',
      server: 'orca_worker_bridge',
      operation: 'callTool',
      name: 'send_to_lead',
      arguments: { message: 'done' },
    } satisfies McpTunnelCallParams);
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"message":"done"}' }],
    });
  });

  it('rejects undeclared names and collisions', async () => {
    const desktop = await connectClient();
    await desktop.request(METHODS.QUERY_START, {
      sessionId: 'session-3',
      cwd: '/repo',
      model: 'fake',
      env: {},
      tunneledMcpServers: ['orca_worker_bridge'],
    });
    const shim = await connectClient();
    await expect(shim.request(METHODS.MCP_TUNNEL_CALL, {
      sessionId: 'session-3',
      server: 'not_declared',
      operation: 'listTools',
    } satisfies McpTunnelCallParams)).rejects.toThrow(/did not declare/);

    await expect(desktop.request(METHODS.QUERY_START, {
      sessionId: 'session-4',
      cwd: '/repo',
      model: 'fake',
      env: {},
      mcpServers: {
        orca_worker_bridge: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
      },
      tunneledMcpServers: ['orca_worker_bridge'],
    })).rejects.toThrow(/conflicts/);
  });
});
