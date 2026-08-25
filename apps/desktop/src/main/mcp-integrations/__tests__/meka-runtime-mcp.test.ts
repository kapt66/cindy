import type { Logger, McpProvider } from '@cindy/maker-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerService = vi.hoisted(() => ({
  listInstances: vi.fn(),
  listProjectBindings: vi.fn(),
  listProjectTools: vi.fn(),
  callProjectCapability: vi.fn(),
  callProjectTool: vi.fn(),
  listTemplates: vi.fn(),
  createInstance: vi.fn(),
  setProjectBindings: vi.fn(),
  getConnectionStatus: vi.fn(),
  reconnectStored: vi.fn(),
  getMekaDesignEndpoint: vi.fn(),
}));

const p4Service = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../meka-settings/ipc.js', () => ({
  getMekaRouterService: () => routerService,
  getMekaP4SettingsService: () => p4Service,
}));

import {
  registerMekaRuntimeMcpArrays,
  resetMekaRuntimeMcpRegistryForTests,
  setMekaRuntimeRouterLoginPrompter,
} from '../meka-runtime-mcp';
import { getCodexExtraSpawnConfig, shutdownCodexEnvironment } from '../codexEnvironment';
import {
  beginCombatServerCapabilityDispatch,
  recordCombatServerCapabilityAutoBridge,
  resetCombatServerCapabilityStateForTests,
  settleCombatServerCapabilityDispatch,
} from '../../meka-projects/combatServerCapabilityState.js';

function noopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

beforeEach(() => {
  resetMekaRuntimeMcpRegistryForTests();
  resetCombatServerCapabilityStateForTests();
  for (const mock of Object.values(routerService)) mock.mockReset();
  routerService.getConnectionStatus.mockResolvedValue({ configured: true });
  routerService.reconnectStored.mockResolvedValue(false);
  routerService.callProjectCapability.mockResolvedValue({
    ok: true,
    contractVersion: 1,
    route: 'git.tree',
    output: { commitSha: 'a'.repeat(40), path: '', entries: [], truncated: false },
  });
  routerService.getMekaDesignEndpoint.mockReturnValue(null);
  p4Service.get.mockReset();
});

afterEach(async () => {
  await shutdownCodexEnvironment();
});

describe('Meka runtime MCP remote instance projection', () => {
  it('reads the bound remote project through first-party tools without exposing or accepting instance ids', async () => {
    routerService.listProjectBindings.mockResolvedValue(['server-1']);
    routerService.listInstances.mockResolvedValue([{
      id: 'server-1',
      projectId: 'saga2',
      projectName: 'SAGA2 Server',
      projectDescription: 'saga2 server project',
      available: true,
      supported: true,
      remoteHostId: 'mcpr:server-1',
    }]);
    routerService.callProjectCapability.mockResolvedValue({
      ok: true,
      contractVersion: 1,
      route: 'git.tree',
      output: {
        commitSha: 'a'.repeat(40),
        path: '',
        entries: [{ name: 'AGENTS.md', path: 'AGENTS.md', type: 'file', size: 128 }],
        truncated: false,
      },
    });
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'codex' as const,
      workingDir: 'C:\\p4',
      sessionId: 'remote-directory-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaMcpProviderIds: ['mcp-router'],
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'remote-directory-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    const directoryTool = tools.tools.find(tool => tool.name === 'list_remote_directory');
    expect(directoryTool?.inputSchema).not.toHaveProperty('properties.instanceId');
    expect(tools.tools.some(tool => tool.name === 'ensure_remote_project_reference')).toBe(false);
    const result = await client.callTool({ name: 'list_remote_directory', arguments: {} });

    expect(result).not.toHaveProperty('isError');
    expect(JSON.stringify(result)).toContain('AGENTS.md');
    expect(routerService.callProjectCapability).toHaveBeenCalledWith(
      'saga2',
      'git.tree',
      { instanceId: 'server-1' },
    );
    expect(routerService.listProjectTools).not.toHaveBeenCalled();

    await client.close();
    await config.instance.close();
  });

  it('reports a missing remote-read route as a Router deployment mismatch', async () => {
    routerService.listProjectBindings.mockResolvedValue(['server-1']);
    routerService.listInstances.mockResolvedValue([
      {
        id: 'server-1',
        projectId: 'saga2',
        projectName: 'SAGA2 Server',
        projectDescription: 'saga2 server project',
        available: true,
        supported: true,
        remoteHostId: 'mcpr:server-1',
      },
    ]);
    routerService.callProjectCapability.mockResolvedValue({
      ok: false,
      contractVersion: 1,
      code: 'ROUTE_NOT_FOUND',
      message: 'MCPRouter route not found: git.tree',
    });
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'codex' as const,
      workingDir: 'C:\\p4',
      sessionId: 'remote-directory-route-missing-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaMcpProviderIds: ['mcp-router'],
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'remote-directory-route-missing-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'list_remote_directory', arguments: {} });
    const serialized = JSON.stringify(result);
    expect(result).toMatchObject({ isError: true });
    expect(serialized).toContain('MCPR_CAPABILITY_NOT_DEPLOYED');
    expect(serialized).toContain('无需修改 Cindy 设置或 SSH 配置');
    expect(serialized).not.toContain('检查当前网络');

    await client.close();
    await config.instance.close();
  });

  it('automatically reconnects, creates from the unique server template, and binds it', async () => {
    routerService.listProjectBindings.mockResolvedValue([]);
    routerService.listInstances
      .mockRejectedValueOnce(new Error('MCPRouter is not configured'))
      .mockResolvedValueOnce([]);
    routerService.getConnectionStatus.mockResolvedValue({ configured: false });
    routerService.reconnectStored.mockResolvedValue(true);
    routerService.listTemplates.mockResolvedValue([
      { id: 'template-server', name: 'SAGA2 Server', description: 'saga2 server project' },
    ]);
    routerService.createInstance.mockResolvedValue({
      id: 'server-1',
      projectName: 'SAGA2 Server',
      projectDescription: 'saga2 server project',
      available: true,
      supported: true,
      remoteHostId: 'mcpr:server-1',
    });
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'claude-code' as const,
      workingDir: 'C:\\p4',
      sessionId: 'auto-project-reference-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaMcpProviderIds: ['mcp-router'],
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'auto-project-reference-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'list_remote_directory', arguments: {} });
    expect(result).not.toHaveProperty('isError');
    expect(routerService.createInstance).toHaveBeenCalledWith('template-server', 'saga2-server');
    expect(routerService.setProjectBindings).toHaveBeenCalledWith('saga2', ['server-1']);
    expect(routerService.callProjectCapability).toHaveBeenCalledWith(
      'saga2',
      'git.tree',
      { instanceId: 'server-1' },
    );

    await client.close();
    await config.instance.close();
  });

  it('waits for interactive login, then continues template creation and binding', async () => {
    routerService.listProjectBindings.mockResolvedValue([]);
    routerService.listInstances
      .mockRejectedValueOnce(new Error('MCPRouter is not configured'))
      .mockResolvedValueOnce([]);
    routerService.getConnectionStatus.mockResolvedValue({ configured: false });
    routerService.reconnectStored.mockResolvedValue(false);
    routerService.listTemplates.mockResolvedValue([
      { id: 'template-server', name: 'SAGA2 Server', description: 'saga2 server project' },
    ]);
    routerService.createInstance.mockResolvedValue({
      id: 'server-1',
      projectName: 'SAGA2 Server',
      projectDescription: 'saga2 server project',
      available: true,
      supported: true,
      remoteHostId: 'mcpr:server-1',
    });
    const login = vi.fn(async () => ({ opened: true, outcome: 'connected' as const }));
    setMekaRuntimeRouterLoginPrompter(login);
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'codex' as const,
      workingDir: 'C:\\p4',
      sessionId: 'interactive-login-project-reference-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaMcpProviderIds: ['mcp-router'],
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'interactive-login-reference-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'list_remote_directory', arguments: {} });
    expect(result).not.toHaveProperty('isError');
    expect(login).toHaveBeenCalledOnce();
    expect(routerService.createInstance).toHaveBeenCalledWith('template-server', 'saga2-server');
    expect(routerService.setProjectBindings).toHaveBeenCalledWith('saga2', ['server-1']);
    expect(routerService.callProjectCapability).toHaveBeenCalledWith(
      'saga2',
      'git.tree',
      { instanceId: 'server-1' },
    );

    await client.close();
    await config.instance.close();
  });

  it('automatically binds the single existing matching server instance', async () => {
    routerService.listProjectBindings.mockResolvedValue([]);
    routerService.listInstances.mockResolvedValue([
      {
        id: 'server-1',
        projectId: 'saga2',
        projectName: 'SAGA2 Server',
        projectDescription: 'server repository',
        available: true,
        supported: true,
        remoteHostId: 'mcpr:server-1',
      },
    ]);
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'claude-code' as const,
      workingDir: 'C:\\p4',
      sessionId: 'auto-bind-reference-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaMcpProviderIds: ['mcp-router'],
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'auto-bind-reference-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'list_remote_directory', arguments: {} });
    expect(result).not.toHaveProperty('isError');
    expect(routerService.setProjectBindings).toHaveBeenCalledWith('saga2', ['server-1']);
    expect(routerService.createInstance).not.toHaveBeenCalled();
    expect(routerService.callProjectCapability).toHaveBeenCalledWith(
      'saga2',
      'git.tree',
      { instanceId: 'server-1' },
    );

    await client.close();
    await config.instance.close();
  });

  it('falls back without changing bindings when multiple server instances match', async () => {
    routerService.listProjectBindings.mockResolvedValue([]);
    routerService.listInstances.mockResolvedValue(
      ['server-a', 'server-b'].map((id) => ({
        id,
        projectId: 'saga2',
        projectName: `SAGA2 Server ${id}`,
        projectDescription: 'server repository',
        available: true,
        supported: true,
        remoteHostId: `mcpr:${id}`,
      })),
    );
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'claude-code' as const,
      workingDir: 'C:\\p4',
      sessionId: 'ambiguous-project-reference-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaMcpProviderIds: ['mcp-router'],
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'ambiguous-project-reference-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'list_remote_directory', arguments: {} });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('MCPR_PROJECT_SELECTION_REQUIRED');
    expect(serialized).toContain('fallbackUserAction');
    expect(serialized).not.toContain('"instanceId"');
    expect(serialized).not.toContain('"remoteHostId"');
    expect(serialized).not.toContain('mcpr:');
    expect(routerService.setProjectBindings).not.toHaveBeenCalled();
    expect(routerService.createInstance).not.toHaveBeenCalled();

    await client.close();
    await config.instance.close();
  });

  it('exposes the combat environment gate only for the combat workflow', async () => {
    p4Service.get.mockResolvedValue({ p4RootPath: null });
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const combatContext = {
      agentKind: 'claude-code' as const,
      workingDir: 'C:\\p4',
      sessionId: 'combat-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: 'combat-development',
        mekaMcpProviderIds: ['mcp-router'],
        mekaWorkflow: 'saga2-combat-development-v1',
      },
    };
    const config = provider?.toClaudeSdkConfig?.(combatContext) as { instance: McpServer };
    const client = new Client({ name: 'combat-gate-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);
    const blocked = await client.callTool({ name: 'check_combat_environment', arguments: {} });
    expect(JSON.stringify(blocked)).toContain('P4 工作区未配置');
    await client.close();
    await config.instance.close();
  });

  it('treats a combat environment recheck outside the combat workflow as advisory', async () => {
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'claude-code' as const,
      workingDir: 'C:\\p4',
      sessionId: 'general-role-combat-gate-advisory-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: 'general-development',
        mekaMcpProviderIds: ['mcp-router'],
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'combat-gate-advisory-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'check_combat_environment', arguments: {} });
    const payload = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as Record<string, unknown>;
    expect(result).not.toHaveProperty('isError');
    expect(payload).toMatchObject({
      ok: true,
      status: 'advisory',
      workflowActive: false,
      dependencyChecksRun: false,
      blockedScope: null,
      independentWorkCanContinue: true,
    });
    expect(JSON.stringify(payload)).toContain('这不是任务级阻断');
    expect(p4Service.get).not.toHaveBeenCalled();
    expect(routerService.listInstances).not.toHaveBeenCalled();
    expect(routerService.listProjectBindings).not.toHaveBeenCalled();

    await client.close();
    await config.instance.close();
  });

  it('checks the environment from the combat role binding when workflow metadata is missing', async () => {
    p4Service.get.mockResolvedValue({ p4RootPath: null });
    routerService.listInstances.mockResolvedValue([]);
    routerService.listProjectBindings.mockResolvedValue([]);
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'claude-code' as const,
      workingDir: 'C:\\p4',
      sessionId: 'combat-role-fallback-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: 'combat-development',
        mekaRoleDisplayName: '通用开发',
        mekaMcpProviderIds: ['mcp-router'],
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'combat-role-fallback-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'check_combat_environment', arguments: {} });
    const payload = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as Record<string, unknown>;
    expect(result).not.toHaveProperty('isError');
    expect(payload).toMatchObject({
      roleContext: {
        projectId: 'saga2',
        roleId: 'combat-development',
        displayName: '战斗开发',
        workflow: 'saga2-combat-development-v1',
        workflowRecoveredFromRole: true,
      },
    });
    expect(JSON.stringify(payload)).not.toContain('通用开发');
    expect(context.vendorOptions).toMatchObject({
      mekaWorkflow: 'saga2-combat-development-v1',
      mekaCombatEnvironmentReady: false,
      mekaCombatPhase: 'environment-recovery',
    });

    await client.close();
    await config.instance.close();
  });

  it('treats the aggregate warning as advisory until a Router tool is actually used', async () => {
    routerService.listProjectTools.mockResolvedValue([
      { name: 'mcp_list_instances', annotations: { readOnlyHint: true } },
    ]);
    routerService.callProjectTool.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ instances: [] }) }],
    });
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'codex' as const,
      workingDir: 'C:\\p4',
      sessionId: 'combat-recovery-safe-projection-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: 'combat-development',
        mekaMcpProviderIds: ['mcp-router'],
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatEnvironmentReady: false,
        mekaCombatPhase: 'environment-recovery',
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'combat-recovery-safe-projection-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.callTool({ name: 'list_tools', arguments: {} });
    const listedText = JSON.stringify(listed);
    expect(listedText).toContain('mcp_list_instances');
    expect(listedText).not.toContain('environmentRecoveryOnly');
    expect(routerService.listProjectTools).toHaveBeenCalledWith('saga2');

    const direct = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'mcp_list_instances', args: {} },
    });
    expect(JSON.stringify(direct)).toContain('instances');
    expect(routerService.callProjectTool).toHaveBeenCalledWith(
      'saga2',
      'mcp_list_instances',
      {},
      expect.any(Function),
    );

    await client.close();
    await config.instance.close();
  });

  it('returns the dependency reason and recovery solution when the actual Router call fails', async () => {
    routerService.listProjectTools.mockResolvedValue([
      { name: 'read_server_status', annotations: { readOnlyHint: true } },
    ]);
    routerService.callProjectTool.mockResolvedValue({
      content: [{ type: 'text', text: 'remote runtime unavailable' }],
      isError: true,
    });
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'codex' as const,
      workingDir: 'C:\\p4',
      sessionId: 'combat-router-failure-solution-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: 'combat-development',
        mekaMcpProviderIds: ['mcp-router'],
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatEnvironmentReady: true,
        mekaCombatEnvironmentChecks: {
          mcpr: { status: 'ready', summary: 'MCPRouter ready' },
        },
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'combat-router-failure-solution-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'read_server_status', args: {} },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('本次工具调用实际依赖 MCPRouter');
    expect(serialized).toContain('解决方案');
    expect(serialized).toContain('任务不会被冻结');
    expect(context.vendorOptions).toMatchObject({
      mekaCombatEnvironmentReady: false,
      mekaCombatEnvironmentChecks: {
        mcpr: { status: 'blocked' },
      },
    });

    await client.close();
    await config.instance.close();
  });

  it('redacts sensitive Router endpoints before returning tool content to the Agent', async () => {
    routerService.listProjectTools.mockResolvedValue([
      { name: 'read_server_status', annotations: { readOnlyHint: true } },
    ]);
    routerService.callProjectTool.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            instanceId: 'http://10.20.30.40:1050/api/mcp?key=mcp_fake_secret_value',
            authorization: 'Bearer fake-secret-token-value',
          }),
        },
      ],
    });
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'codex' as const,
      workingDir: 'C:\\p4',
      sessionId: 'combat-router-redaction-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: 'combat-development',
        mekaMcpProviderIds: ['mcp-router'],
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatEnvironmentReady: true,
        mekaCombatPhase: 'exploration',
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'combat-router-redaction-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'read_server_status', args: {} },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('[REDACTED_ENDPOINT]');
    expect(serialized).not.toContain('10.20.30.40');
    expect(serialized).not.toContain('mcp_fake_secret_value');
    expect(serialized).not.toContain('fake-secret-token-value');

    await client.close();
    await config.instance.close();
  });

  it('validates and consumes only the actual auto-bridged combat server report', async () => {
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'claude-code' as const,
      workingDir: 'C:\\p4',
      sessionId: 'combat-receipt-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: 'combat-development',
        mekaMcpProviderIds: ['mcp-router'],
        mekaWorkflow: 'saga2-combat-development-v1',
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'combat-capability-report-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);
    const base = {
      supportStatus: 'supported',
      readOnlyConfirmed: true,
      repository: 'saga2-server',
      head: 'abcdef1',
      codeEvidence: ['server/module.ts'],
      capabilityGap: 'none',
      programmerAction: 'none',
      affectedSurfaces: ['skill module runtime'],
      validationSuggestion: 'verify exported module data against the current reader',
    };
    const trustReport = (report: Record<string, unknown>, suffix: string) => {
      const task = `[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capability matrix residual gap ${suffix}`;
      expect(
        beginCombatServerCapabilityDispatch({
          leadSessionId: context.sessionId,
          vendorOptions: context.vendorOptions,
          kind: 'create_worker',
          task,
          remoteHostId: 'mcpr:server-1',
        }),
      ).toBe(true);
      expect(
        settleCombatServerCapabilityDispatch({
          leadSessionId: context.sessionId,
          kind: 'create_worker',
          task,
          accepted: true,
          workerId: `worker-${suffix}`,
          workerSessionId: `worker-session-${suffix}`,
        }),
      ).toBe(true);
      expect(
        recordCombatServerCapabilityAutoBridge({
          leadSessionId: context.sessionId,
          workerId: `worker-${suffix}`,
          workerSessionId: `worker-session-${suffix}`,
          message: `[Auto-bridged: worker 完成但未调 send_to_lead]\n\n${JSON.stringify(report)}`,
          accepted: true,
        }),
      ).toBe('report-ready');
    };

    const rejectedWithoutWorker = await client.callTool({
      name: 'validate_server_capability_report',
      arguments: { serverCapabilityReport: base },
    });
    expect(rejectedWithoutWorker).toMatchObject({ isError: true });

    trustReport(base, 'supported');
    const accepted = await client.callTool({
      name: 'validate_server_capability_report',
      arguments: { serverCapabilityReport: base },
    });
    expect(JSON.stringify(accepted)).toContain('reportValidated');
    expect(JSON.stringify(accepted)).toContain('\\"implementationBlocked\\":false');
    expect(accepted).not.toHaveProperty('isError');
    const replayed = await client.callTool({
      name: 'validate_server_capability_report',
      arguments: { serverCapabilityReport: base },
    });
    expect(replayed).toMatchObject({ isError: true });

    const unsupportedReport = {
      ...base,
      supportStatus: 'unsupported',
      capabilityGap: 'dynamic world-space center is not consumed by the current module',
      programmerAction: 'Lead 立即停止当前实现并将报告交给服务器程序，补充随机点运行时消费。',
      affectedSurfaces: ['server runtime', 'local blocked: module/table/export/client'],
    };
    trustReport(unsupportedReport, 'unsupported');
    const mismatched = await client.callTool({
      name: 'validate_server_capability_report',
      arguments: { serverCapabilityReport: { ...unsupportedReport, head: '1234567' } },
    });
    expect(mismatched).toMatchObject({ isError: true });
    const unsupported = await client.callTool({
      name: 'validate_server_capability_report',
      arguments: { serverCapabilityReport: unsupportedReport },
    });
    expect(JSON.stringify(unsupported)).toContain('\\"implementationBlocked\\":true');
    expect(context.vendorOptions).toMatchObject({
      mekaCombatServerCapabilityStatus: 'unsupported',
      mekaCombatPhase: 'server-programmer-handoff',
    });

    await client.close();
    await config.instance.close();
  });

  it('returns an MCPR error and enters environment recovery when the remote call fails', async () => {
    routerService.listProjectTools.mockResolvedValue([
      { name: 'read_server_file', annotations: { readOnlyHint: true } },
    ]);
    routerService.callProjectTool.mockRejectedValue(new Error('MCPR connection lost'));
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'claude-code' as const,
      workingDir: 'C:\\p4',
      sessionId: 'combat-mcpr-failure-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: 'combat-development',
        mekaMcpProviderIds: ['mcp-router'],
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatEnvironmentReady: true,
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'combat-mcpr-failure-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'read_server_file', args: {} },
    });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('MCPR connection lost');
    expect(context.vendorOptions).toMatchObject({
      mekaCombatEnvironmentReady: false,
      mekaCombatPhase: 'environment-recovery',
    });

    await client.close();
    await config.instance.close();
  });

  it('does not mutate ordinary role state when an MCPR call fails', async () => {
    routerService.callProjectTool.mockRejectedValue(new Error('MCPR connection lost'));
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'claude-code' as const,
      workingDir: 'C:\\p4',
      sessionId: 'ordinary-mcpr-failure-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: 'general',
        mekaMcpProviderIds: ['mcp-router'],
        mekaCombatEnvironmentReady: true,
        mekaCombatPhase: 'unrelated',
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'ordinary-mcpr-failure-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'read_server_file', args: {} },
    });
    expect(result).toMatchObject({ isError: true });
    expect(context.vendorOptions).toMatchObject({
      mekaCombatEnvironmentReady: true,
      mekaCombatPhase: 'unrelated',
    });

    await client.close();
    await config.instance.close();
  });

  it('diagnoses an unconfigured Router for an ordinary role and returns an actionable retry', async () => {
    routerService.listInstances.mockRejectedValue(new Error('MCPRouter is not configured'));
    routerService.listProjectBindings.mockResolvedValue([]);
    routerService.getConnectionStatus.mockResolvedValue({ configured: false });
    const openLoginWindow = vi.fn(async () => ({ opened: true, outcome: 'cancelled' as const }));
    setMekaRuntimeRouterLoginPrompter(openLoginWindow);
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'codex' as const,
      workingDir: 'C:\\p4',
      sessionId: 'observed-general-development-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: 'general-development',
        mekaMcpProviderIds: ['mcp-router'],
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'ordinary-mcpr-recovery-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'list_project_remote_instances',
      arguments: {},
    });
    const serialized = JSON.stringify(result);
    expect(result).toMatchObject({ isError: true });
    expect(serialized).toContain('MCPR_NOT_CONNECTED');
    expect(serialized).toContain('MCPRouter 登录已取消');
    expect(serialized).toContain('list_project_remote_instances');
    expect(serialized).toContain('independentWorkCanContinue');
    expect(serialized).toContain('\\"loginPromptOpened\\":true');
    expect(serialized).toContain('cancelled');
    expect(serialized).not.toContain('check_combat_environment');
    expect(routerService.getConnectionStatus).toHaveBeenCalledOnce();
    expect(openLoginWindow).toHaveBeenCalledOnce();
    expect(context.vendorOptions).not.toHaveProperty('mekaCombatPhase');

    await client.close();
    await config.instance.close();
  });

  it('opens login during an explicit combat environment recheck when Router is unconfigured', async () => {
    routerService.listInstances.mockRejectedValue(new Error('MCPRouter is not configured'));
    routerService.listProjectBindings.mockResolvedValue([]);
    routerService.getConnectionStatus.mockResolvedValue({ configured: false });
    p4Service.get.mockResolvedValue({ p4RootPath: null });
    const openLoginWindow = vi.fn(async () => ({ opened: true, outcome: 'cancelled' as const }));
    setMekaRuntimeRouterLoginPrompter(openLoginWindow);
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'codex' as const,
      workingDir: 'C:\\p4',
      sessionId: 'combat-router-login-prompt-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: 'combat-development',
        mekaMcpProviderIds: ['mcp-router'],
        mekaWorkflow: 'saga2-combat-development-v1',
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'combat-router-login-prompt-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'check_combat_environment', arguments: {} });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('MCPR_NOT_CONNECTED');
    expect(serialized).toContain('\\"loginPromptOpened\\":true');
    expect(serialized).toContain('check_combat_environment');
    expect(openLoginWindow).toHaveBeenCalledOnce();

    await client.close();
    await config.instance.close();
  });

  it('guides project binding without opening login when Router credentials are present', async () => {
    routerService.listInstances.mockResolvedValue([]);
    routerService.listProjectBindings.mockResolvedValue([]);
    routerService.getConnectionStatus.mockResolvedValue({ configured: true });
    p4Service.get.mockResolvedValue({ p4RootPath: null });
    const openLoginWindow = vi.fn(async () => ({ opened: true, outcome: 'cancelled' as const }));
    setMekaRuntimeRouterLoginPrompter(openLoginWindow);
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'codex' as const,
      workingDir: 'C:\\p4',
      sessionId: 'combat-router-binding-recovery-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: 'combat-development',
        mekaMcpProviderIds: ['mcp-router'],
        mekaWorkflow: 'saga2-combat-development-v1',
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'combat-router-binding-recovery-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'check_combat_environment', arguments: {} });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('MCPR_PROJECT_NOT_BOUND');
    expect(serialized).toContain('list_remote_instances');
    expect(openLoginWindow).not.toHaveBeenCalled();

    await client.close();
    await config.instance.close();
  });

  it('projects only the safe local Router connection status', async () => {
    routerService.getConnectionStatus.mockResolvedValue({ configured: false });
    const openLoginWindow = vi.fn(async () => ({ opened: true, outcome: 'cancelled' as const }));
    setMekaRuntimeRouterLoginPrompter(openLoginWindow);
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'claude-code' as const,
      workingDir: 'C:\\p4',
      sessionId: 'router-diagnostic-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaMcpProviderIds: ['mcp-router'],
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'mcpr-local-diagnostic-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'diagnose_mcp_router_connection',
      arguments: {},
    });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('not-configured');
    expect(serialized).toContain('\\"loginPromptOpened\\":true');
    expect(serialized).toContain('cancelled');
    expect(serialized).toContain('MCPRouter 登录已取消');
    expect(serialized).not.toContain('routerUrl');
    expect(serialized).not.toContain('routerUsername');
    expect(result).not.toHaveProperty('isError');
    expect(openLoginWindow).toHaveBeenCalledOnce();

    await client.close();
    await config.instance.close();
  });

  it('exposes a configured MekaDesign endpoint without MCPRouter', () => {
    routerService.getMekaDesignEndpoint.mockReturnValue(
      'https://design.example/api/mcp?key=mcp_direct',
    );
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'meka_design');
    const context = {
      agentKind: 'claude-code' as const,
      workingDir: 'C:\\p4',
      sessionId: 'session-1',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaMcpProviderIds: ['meka-design'],
      },
    };

    expect(provider?.isEnabled?.(context)).toBe(true);
    expect(provider?.toClaudeSdkConfig?.(context)).toEqual({
      type: 'http',
      url: 'https://design.example/api/mcp?key=mcp_direct',
    });
    expect(routerService.listProjectTools).not.toHaveBeenCalled();
  });

  it('retains a session-gated MekaDesign proxy in the process-global Codex bridge', async () => {
    routerService.getMekaDesignEndpoint.mockReturnValue(
      'https://design.example/api/mcp?key=mcp_direct',
    );
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);

    const config = await getCodexExtraSpawnConfig({
      mcpProviders: providers,
      logger: noopLogger(),
    });

    expect(config.extraArgs).toContainEqual(
      expect.stringMatching(/^mcp_servers\.meka_design\.url=/),
    );

    const provider = providers.find((candidate) => candidate.name === 'meka_design');
    const bridgeContext = {
      agentKind: 'codex' as const,
      workingDir: '',
      vendorOptions: {},
      getSessionContext: () => ({
        agentKind: 'codex' as const,
        workingDir: 'C:\\ordinary',
        sessionId: 'ordinary-session',
        vendorOptions: {},
      }),
    };
    const providerConfig = provider?.toClaudeSdkConfig?.(bridgeContext) as {
      instance: McpServer;
    };
    const client = new Client({ name: 'meka-design-disabled-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      providerConfig.instance.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    await expect(client.listTools()).resolves.toEqual({ tools: [] });

    await client.close();
    await providerConfig.instance.close();
  });

  it('never exposes a remote instance physical working directory', async () => {
    routerService.listInstances.mockResolvedValue([
      {
        id: 'instance-1',
        projectName: 'SAGA2 Server',
        projectDescription: 'server repository',
        available: true,
        supported: true,
        remoteHostId: 'mcpr:instance-1',
        workingDir: '/private/managed/workspaces/saga2-server',
        workspaceRef: 'internal-ref',
      },
    ]);
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
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

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

  it('is retained when the process-global Codex bridge freezes its provider set', async () => {
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);

    const config = await getCodexExtraSpawnConfig({
      mcpProviders: providers,
      logger: noopLogger(),
    });

    expect(config.extraArgs).toContainEqual(
      expect.stringMatching(/^mcp_servers\.mcp_router\.url=/),
    );
    expect(config.extraArgs).toContainEqual(
      expect.stringMatching(/^mcp_servers\.meka_design\.url=/),
    );
  });

  it('keeps the process-global Codex facade and resolves the selected role at tool-call time', async () => {
    routerService.listInstances.mockResolvedValue([
      {
        id: 'instance-1',
        projectName: 'SAGA2 Server',
        projectDescription: 'server repository',
        available: true,
        supported: true,
        remoteHostId: 'mcpr:instance-1',
      },
    ]);
    routerService.listProjectBindings.mockResolvedValue(['instance-1']);

    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    let activeContext = {
      agentKind: 'codex' as const,
      workingDir: 'C:\\p4',
      sessionId: 'session-1',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaMcpProviderIds: ['mcp-router'],
      },
    };
    const bridgeContext = {
      agentKind: 'codex' as const,
      workingDir: '',
      vendorOptions: {},
      getSessionContext: () => activeContext,
    };

    expect(provider?.isEnabled?.(bridgeContext)).toBe(true);
    const config = provider?.toClaudeSdkConfig?.(bridgeContext) as { instance: McpServer };
    const client = new Client({ name: 'meka-runtime-codex-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const enabled = await client.callTool({
      name: 'list_project_remote_instances',
      arguments: {},
    });
    expect(JSON.stringify(enabled)).toContain('mcpr:instance-1');
    expect(routerService.listProjectBindings).toHaveBeenCalledWith('saga2');

    activeContext = {
      ...activeContext,
      sessionId: 'session-overview',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaMcpProviderIds: [],
      },
    };
    const disabled = await client.callTool({
      name: 'list_project_remote_instances',
      arguments: {},
    });
    expect(disabled).toMatchObject({ isError: true });
    expect(JSON.stringify(disabled)).toContain('Meka project MCP is not enabled');
    expect(routerService.listProjectBindings).toHaveBeenCalledTimes(1);

    await client.close();
    await config.instance.close();
  });
});
