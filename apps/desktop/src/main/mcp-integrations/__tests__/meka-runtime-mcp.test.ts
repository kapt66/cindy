import type { Logger, McpProvider } from '@cindy/maker-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerService = vi.hoisted(() => ({
  listInstances: vi.fn(),
  listProjectBindings: vi.fn(),
  listProjectTools: vi.fn(),
  callProjectTool: vi.fn(),
  listTemplates: vi.fn(),
  createInstance: vi.fn(),
  setProjectBindings: vi.fn(),
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
} from '../meka-runtime-mcp';
import { getCodexExtraSpawnConfig, shutdownCodexEnvironment } from '../codexEnvironment';

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
  for (const mock of Object.values(routerService)) mock.mockReset();
  routerService.getMekaDesignEndpoint.mockReturnValue(null);
  p4Service.get.mockReset();
});

afterEach(async () => {
  await shutdownCodexEnvironment();
});

describe('Meka runtime MCP remote instance projection', () => {
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

  it('keeps blocked combat recovery away from the raw Router control plane', async () => {
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
    expect(listedText).toContain('environmentRecoveryOnly');
    expect(listedText).toContain('load_skill');
    expect(listedText).toContain('check_combat_environment');
    expect(listedText).not.toContain('mcp_list_instances');
    expect(routerService.listProjectTools).not.toHaveBeenCalled();

    const direct = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'mcp_list_instances', args: {} },
    });
    expect(JSON.stringify(direct)).toContain('upstreamCalled');
    expect(JSON.stringify(direct)).toContain('false');
    expect(JSON.stringify(direct)).toContain('不要加载 Skill');
    expect(routerService.callProjectTool).not.toHaveBeenCalled();

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

  it('validates only a complete combat server workflow receipt', async () => {
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
    const client = new Client({ name: 'combat-receipt-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);
    const base = {
      skillName: 'battle-designer-server-development',
      skillLoaded: true,
      role: 'combat-designer',
      status: 'implemented',
      repository: 'saga2-server',
      head: 'abc',
      baseBranch: 'develop',
      workBranch: 'combat/123',
      codeEvidence: ['server/module.ts'],
      excelChanges: { status: 'changed', evidence: 'export.json' },
      generatedArtifacts: { status: 'verified', evidence: 'artifact.json' },
      validation: ['unit tests passed'],
      runtimeVerification: 'verified in unit tests',
      remainingIntegration: [],
    };
    const accepted = await client.callTool({
      name: 'validate_server_workflow_receipt',
      arguments: { serverWorkflow: base },
    });
    expect(JSON.stringify(accepted)).toContain('receiptValidated');
    expect(accepted).not.toHaveProperty('isError');
    const blocked = await client.callTool({
      name: 'validate_server_workflow_receipt',
      arguments: { serverWorkflow: { ...base, skillLoaded: false } },
    });
    expect(blocked).toMatchObject({ isError: true });
    const blockedBranch = await client.callTool({
      name: 'validate_server_workflow_receipt',
      arguments: { serverWorkflow: { ...base, workBranch: 'blocked' } },
    });
    expect(blockedBranch).toMatchObject({ isError: true });
    const blockedArtifact = await client.callTool({
      name: 'validate_server_workflow_receipt',
      arguments: {
        serverWorkflow: {
          ...base,
          generatedArtifacts: { status: 'blocked', evidence: '等待导出' },
        },
      },
    });
    expect(blockedArtifact).toMatchObject({ isError: true });
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
