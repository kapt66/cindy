import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { getPiExtraSpawnConfig, shutdownPiEnvironment } from '../piEnvironment';
import {
  beginCombatServerCapabilityDispatch,
  recordCombatServerCapabilityAutoBridge,
  resetCombatServerCapabilityStateForTests,
  settleCombatServerCapabilityDispatch,
} from '../../meka-projects/combatServerCapabilityState.js';

const runtimeSource = readFileSync(
  resolve(process.cwd(), 'src/main/mcp-integrations/meka-runtime-mcp.ts'),
  'utf8',
);

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
  await shutdownPiEnvironment();
});

describe('Meka runtime MCP remote instance projection', () => {
  it('keeps Unity start recovery in the Host flow instead of Agent chat questions', () => {
    expect(runtimeSource).toContain('不要调用 ask_user_question，也不要在聊天正文询问启动');
    expect(runtimeSource).toContain('直接调用 Meka Unity 的 unity_execute(action=open)');
    expect(runtimeSource).not.toContain('先询问用户是否由 Cindy 帮忙启动 Unity');
  });

  it('reads the bound remote project through first-party tools without exposing or accepting instance ids', async () => {
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
    const directoryTool = tools.tools.find((tool) => tool.name === 'list_remote_directory');
    expect(directoryTool?.inputSchema).not.toHaveProperty('properties.instanceId');
    expect(tools.tools.some((tool) => tool.name === 'ensure_remote_project_reference')).toBe(false);
    const result = await client.callTool({ name: 'list_remote_directory', arguments: {} });

    expect(result).not.toHaveProperty('isError');
    expect(JSON.stringify(result)).toContain('AGENTS.md');
    expect(routerService.callProjectCapability).toHaveBeenCalledWith('saga2', 'git.tree', {
      instanceId: 'server-1',
    });
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
    expect(routerService.callProjectCapability).toHaveBeenCalledWith('saga2', 'git.tree', {
      instanceId: 'server-1',
    });

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
    expect(routerService.callProjectCapability).toHaveBeenCalledWith('saga2', 'git.tree', {
      instanceId: 'server-1',
    });

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
    expect(routerService.callProjectCapability).toHaveBeenCalledWith('saga2', 'git.tree', {
      instanceId: 'server-1',
    });

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
        mekaCombatTargetSkillId: '1019',
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

  it('guards direct Router tools before their handlers run in a ready combat task', async () => {
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const provider = providers.find((candidate) => candidate.name === 'mcp_router');
    const context = {
      agentKind: 'codex' as const,
      workingDir: 'C:\\Workspace\\saga2\\saga2_project',
      sessionId: 'combat-direct-router-policy-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: 'combat-development',
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaMcpProviderIds: ['mcp-router'],
        mekaCombatTargetSkillId: '1020',
        mekaCombatTargetSkillIdState: 'confirmed',
        mekaCombatTargetExportCompleted: true,
        mekaCombatEnvironmentReady: true,
        mekaCombatPhase: 'exploration',
        mekaCombatServerCapabilityStatus: 'supported',
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'combat-direct-router-policy-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'check_combat_environment', arguments: {} });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('禁止立即重复调用');
    expect(p4Service.get).not.toHaveBeenCalled();
    expect(routerService.listInstances).not.toHaveBeenCalled();

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
        // 非战斗角色样本：共享默认角色（`saga2-default-role`）。「通用开发」已退役。
        mekaRoleId: 'saga2-default-role',
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
        mekaCombatTargetSkillId: '1019',
        // 诱饵：vendorOptions 里的显示名是**非战斗角色**的名字（默认角色），权威值必须来自角色清单。
        mekaRoleDisplayName: '默认角色',
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
    // 诱饵显示名（默认角色）不得出现在权威回执里：roleContext 一律来自角色清单。
    expect(JSON.stringify(payload)).not.toContain('默认角色');
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
        mekaCombatTargetSkillId: '1019',
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
    expect(listed).toMatchObject({ isError: true });
    expect(listedText).toContain('禁止调用 list_tools');
    expect(routerService.listProjectTools).not.toHaveBeenCalled();

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
        mekaCombatTargetSkillId: '1019',
        mekaMcpProviderIds: ['mcp-router'],
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatEnvironmentReady: true,
        mekaCombatTargetExportCompleted: true,
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
        mekaCombatTargetSkillId: '1019',
        mekaMcpProviderIds: ['mcp-router'],
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatEnvironmentReady: true,
        mekaCombatTargetExportCompleted: true,
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
        mekaCombatTargetSkillId: '1019',
        mekaMcpProviderIds: ['mcp-router'],
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatTargetExportCompleted: true,
      },
    };
    const config = provider?.toClaudeSdkConfig?.(context) as { instance: McpServer };
    const client = new Client({ name: 'combat-capability-report-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);
    const base = {
      targetSkillId: 1019,
      supportStatus: 'supported',
      readOnlyConfirmed: true,
      repository: 'saga2-server',
      head: 'abcdef1',
      codeEvidence: [
        { path: 'server/module.ts', symbols: ['entryTypeDamageHit'], details: 'consumer' },
      ],
      capabilityGap: '无运行时原子能力缺口；当前模块组合可以表达需求。',
      programmerAction: '无需服务器程序改动；Lead 可继续本地配置。',
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
    const wrongTarget = await client.callTool({
      name: 'validate_server_capability_report',
      arguments: { serverCapabilityReport: { ...base, targetSkillId: 1020 } },
    });
    expect(wrongTarget).toMatchObject({ isError: true });
    expect(JSON.stringify(wrongTarget)).toContain('targetSkillId');
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
        mekaCombatTargetSkillId: '1019',
        mekaMcpProviderIds: ['mcp-router'],
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatEnvironmentReady: true,
        mekaCombatTargetExportCompleted: true,
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
      sessionId: 'observed-default-role-session',
      vendorOptions: {
        source: 'meka',
        mekaProjectId: 'saga2',
        // 普通（非战斗）角色样本：共享默认角色。「通用开发」已退役。
        mekaRoleId: 'saga2-default-role',
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
        mekaCombatTargetSkillId: '1019',
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
        mekaCombatTargetSkillId: '1019',
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

/**
 * Meka 运行时 MCP 的 **Pi 桥接线**。
 *
 * 矩阵把 `pi.runtimeMcp` 声明为 true 之后，真正决定「Pi 拿不拿得到」的是进程级 bridge 的
 * **工厂阶段**：`piEnvironment.doStart` 用空 vendorOptions 调 `isEnabled`，只有在这里返回
 * true 的 provider 才会进 bridge 的 server 工厂表；之后再怎么声明 `mekaMcpProviderIds`
 * 都补不回来（这正是 Pi 之前静默缺失的机制）。所以本组用例必须走**真** bridge + 真 HTTP，
 * 而不是只断言 provider 对象上的 `isEnabled`。
 */
describe('Meka runtime MCP 在进程级 Pi 桥里可用', () => {
  const INIT_BODY = (id: number) => JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'meka-pi-bridge-test', version: '1.0.0' },
    },
  });

  async function readRpcText(resp: Response): Promise<unknown> {
    const text = await resp.text();
    const payload = text
      .split(/\r?\n/)
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    return JSON.parse(payload ?? text);
  }

  it('mcp_router / meka_design 进入 Pi bridge，并按会话 vendorOptions 裁决工具可用性', async () => {
    routerService.listProjectBindings.mockResolvedValue(['instance-1']);
    routerService.listInstances.mockResolvedValue([
      {
        id: 'instance-1',
        projectId: 'saga2',
        projectName: 'SAGA2 Server',
        projectDescription: 'saga2 server project',
        available: true,
        supported: true,
        remoteHostId: 'mcpr:instance-1',
      },
    ]);

    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    // Pi 会话的可变 vendorOptions 就是 bridge 里注册的那份引用（同 codex）：
    // 同一个会话后续改变选择时，工具侧必须按最新值裁决。
    const vendorOptions: Record<string, unknown> = {
      source: 'meka',
      mekaProjectId: 'saga2',
      mekaMcpProviderIds: ['mcp-router'],
    };

    const config = await getPiExtraSpawnConfig(providers, noopLogger(), {
      sessionId: 'meka-pi-session',
      workingDir: 'C:\\p4',
      vendorOptions,
    });

    const servers = config?.mcpBridge?.servers ?? [];
    expect(servers.map((server) => server.name)).toContain('mcp_router');
    // meka_design 与 codex 同语义：工厂阶段就留在 facade 里，端点缺失时工具面为空。
    expect(servers.map((server) => server.name)).toContain('meka_design');

    const router = servers.find((server) => server.name === 'mcp_router')!;
    const headers = {
      authorization: `Bearer ${config!.mcpBridge!.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(router.url, { method: 'POST', headers, body: INIT_BODY(1) });
    expect(initResp.status).toBe(200);
    const mcpSessionId = initResp.headers.get('mcp-session-id') ?? '';
    await initResp.text();

    const enabled = await fetch(router.url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': mcpSessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_project_remote_instances', arguments: {} },
      }),
    });
    expect(enabled.status).toBe(200);
    expect(JSON.stringify(await readRpcText(enabled))).toContain('mcpr:instance-1');
    expect(routerService.listProjectBindings).toHaveBeenCalledWith('saga2');
    // 会话 URL 带 `?session=`：身份经 bridge 路由注入，工具侧才能读到 vendorOptions。
    expect(new URL(router.url).searchParams.get('session')).toBe('meka-pi-session');

    // 同一会话改成不选 mcp-router（例如概览角色）：工具立刻按新值拒绝，不再触达 Router。
    vendorOptions.mekaMcpProviderIds = [];
    const disabled = await fetch(router.url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': mcpSessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_project_remote_instances', arguments: {} },
      }),
    });
    expect(disabled.status).toBe(200);
    expect(JSON.stringify(await readRpcText(disabled))).toContain('Meka project MCP is not enabled');
    expect(routerService.listProjectBindings).toHaveBeenCalledTimes(1);

    config!.disposeSessionCtx!();
    // 会话注销后 `?session=` 未命中 → bridge fail-closed 401（与 codex 同机制）。
    const after = await fetch(router.url, { method: 'POST', headers, body: INIT_BODY(4) });
    expect(after.status).toBe(401);
    await after.text();
  });

  it('普通（非 Meka）Pi 会话保留 facade 但工具不可用 —— 与 codex 同形态，不是每会话增删 server', async () => {
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);

    const config = await getPiExtraSpawnConfig(providers, noopLogger(), {
      sessionId: 'ordinary-pi-session',
      workingDir: 'C:\\ordinary',
      vendorOptions: {},
    });

    const servers = config?.mcpBridge?.servers ?? [];
    const router = servers.find((server) => server.name === 'mcp_router');
    expect(router).toBeDefined();

    const headers = {
      authorization: `Bearer ${config!.mcpBridge!.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(router!.url, { method: 'POST', headers, body: INIT_BODY(1) });
    const mcpSessionId = initResp.headers.get('mcp-session-id') ?? '';
    await initResp.text();
    const result = await fetch(router!.url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': mcpSessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'diagnose_mcp_router_connection', arguments: {} },
      }),
    });
    expect(JSON.stringify(await readRpcText(result))).toContain('Meka project MCP is not enabled');
    expect(routerService.getConnectionStatus).not.toHaveBeenCalled();

    config!.disposeSessionCtx!();
  });

  it('Pi 的工厂阶段 ctx 与 codex 同构，会话 ctx 不享受 bootstrap 放行', () => {
    const providers: McpProvider[] = [];
    registerMekaRuntimeMcpArrays(providers);
    const routerProvider = providers.find((candidate) => candidate.name === 'mcp_router')!;
    const mekaDesign = providers.find((candidate) => candidate.name === 'meka_design')!;

    const piBootstrap = {
      agentKind: 'pi' as const,
      workingDir: '',
      vendorOptions: {},
      getSessionContext: () => ({
        agentKind: 'pi' as const,
        workingDir: 'C:\\ordinary',
        sessionId: 'ordinary-pi-session',
        vendorOptions: {},
      }),
    };
    expect(routerProvider.isEnabled?.(piBootstrap)).toBe(true);

    // 工厂阶段 ctx 之外（带 sessionId / 无 getSessionContext）一律回到按 vendorOptions 的
    // 普通判定：Pi 会话不会因为「harness 是 pi」就默认拿到 Meka 工具。
    const piSession = {
      agentKind: 'pi' as const,
      workingDir: 'C:\\ordinary',
      sessionId: 'ordinary-pi-session',
      vendorOptions: {},
    };
    expect(routerProvider.isEnabled?.(piSession)).toBe(false);
    expect(mekaDesign.isEnabled?.(piSession)).toBe(false);

    const mekaSession = {
      ...piSession,
      vendorOptions: { source: 'meka', mekaProjectId: 'saga2', mekaMcpProviderIds: ['mcp-router'] },
    };
    expect(routerProvider.isEnabled?.(mekaSession)).toBe(true);
  });
});
