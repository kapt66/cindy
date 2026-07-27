import type { McpProvider } from '@cindy/maker-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routerService = vi.hoisted(() => ({
  listInstances: vi.fn(),
  listProjectBindings: vi.fn(),
}));

vi.mock('../../meka-settings/ipc.js', () => ({
  getMekaRouterService: () => routerService,
}));

import {
  registerMekaRuntimeMcpArrays,
  resetMekaRuntimeMcpRegistryForTests,
} from '../meka-runtime-mcp';

beforeEach(() => {
  resetMekaRuntimeMcpRegistryForTests();
  routerService.listInstances.mockReset();
  routerService.listProjectBindings.mockReset();
});

describe('Meka runtime MCP remote instance projection', () => {
  it('never exposes a remote instance physical working directory', async () => {
    routerService.listInstances.mockResolvedValue([{
      id: 'instance-1',
      projectName: 'SAGA2 Server',
      projectDescription: 'server repository',
      available: true,
      supported: true,
      remoteHostId: 'mcpr:instance-1',
      workingDir: '/private/managed/workspaces/saga2-server',
      workspaceRef: 'internal-ref',
    }]);
    routerService.listProjectBindings.mockResolvedValue(['instance-1']);

    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'claude-code' as const,
      workingDir: 'C:\\p4',
      sessionId: 'session-1',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaMcpProviderIds: ['mcp-router'],
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'meka-runtime-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      config.instance.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const all = await client.callTool({ name: 'list_remote_instances', arguments: {} });
    const bound = await client.callTool({
      name: 'list_project_remote_instances',
      arguments: {},
    });
    const serialized = JSON.stringify({ all, bound });
    expect(serialized).toContain('mcpr:instance-1');
    expect(serialized).toContain('SAGA2 Server');
    expect(serialized).not.toContain('/private/managed/workspaces');
    expect(serialized).not.toContain('internal-ref');

    await client.close();
    await config.instance.close();
  });
});
