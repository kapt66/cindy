/**
 * Stdio MCP server spawned on a remote host. It forwards tools/list and
 * tools/call to the desktop-owned in-process MCP instance through cc-mgr.
 * stdout is the MCP transport and must never be used for logging.
 */

import net from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { RpcClient } from './client.js';
import { METHODS, type McpTunnelCallParams } from './protocol.js';

export interface McpShimOptions {
  socket: string;
  sessionId: string;
  serverName: string;
}

const SHIM_RPC_TIMEOUT_MS = 130_000;

export async function runMcpShim(opts: McpShimOptions): Promise<void> {
  const socket = net.createConnection(opts.socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const client = new RpcClient(socket, {
    clientId: `mcp-shim:${opts.serverName}:${opts.sessionId}`,
    onError: (error) => console.error(`[mcp-shim] daemon socket error: ${error.message}`),
  });
  await client.hello({ timeoutMs: 15_000 });

  const callDaemon = async (
    operation: McpTunnelCallParams['operation'],
    extra: Pick<McpTunnelCallParams, 'name' | 'arguments'>,
  ): Promise<unknown> => client.request(METHODS.MCP_TUNNEL_CALL, {
    sessionId: opts.sessionId,
    server: opts.serverName,
    operation,
    ...(extra.name !== undefined ? { name: extra.name } : {}),
    ...(extra.arguments !== undefined ? { arguments: extra.arguments } : {}),
  } satisfies McpTunnelCallParams, { timeoutMs: SHIM_RPC_TIMEOUT_MS });

  const server = new Server(
    { name: opts.serverName, version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(
    ListToolsRequestSchema,
    async () => await callDaemon('listTools', {}) as { tools: [] },
  );
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => {
      try {
        return await callDaemon('callTool', {
          name: request.params.name,
          arguments: request.params.arguments ?? {},
        }) as { content: [] };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `mcp tunnel call failed: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  transport.onclose = () => process.exit(0);
  socket.on('close', () => process.exit(0));
}
