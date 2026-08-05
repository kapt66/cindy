import { beforeEach, describe, expect, it, vi } from 'vitest';

const hello = vi.fn(async () => ({
  protocolVersion: 3,
  bundleVersion: '0.0.6',
  capabilityMcpUrl: 'http://127.0.0.1:43210/mcp/lizi_capabilities',
  capabilityMcpToken: 'daemon-token',
}));
const bundleEnsure = vi.fn(async () => ({ pluginPath: '/remote/cache/revision' }));
const revisionRegister = vi.fn(async () => ({ registered: true as const }));
const threadRegister = vi.fn(async () => ({ registered: true as const }));
const threadUnregister = vi.fn(async () => ({ unregistered: true }));
const bundleRelease = vi.fn(async () => ({ released: true, removed: false }));
const rpcOptions: unknown[] = [];

vi.mock('@cindy/maker-cc-manager', () => ({
  RpcClient: class {
    constructor(_stream: unknown, options: unknown) {
      rpcOptions.push(options);
    }
    hello = hello;
    bundleEnsure = bundleEnsure;
    capabilityRevisionRegister = revisionRegister;
    capabilityThreadRegister = threadRegister;
    capabilityThreadUnregister = threadUnregister;
    bundleRelease = bundleRelease;
  },
}));

const listInstances = vi.fn(async () => [{
  id: 'instance-1',
  instanceId: 'instance-1',
  agentType: 'codex',
  workingDir: '/workspace/project',
  supported: true,
  available: true,
}]);
vi.mock('../../meka-settings/ipc.js', () => ({
  getMekaRouterService: () => ({ listInstances }),
}));

const readKey = vi.fn((): string | null => 'gateway-key');
vi.mock('../auth-adapters.js', () => ({
  readClaudeApiKey: () => readKey(),
}));

vi.mock('../mcpr-tunnel.js', () => ({
  openMcprTunnel: vi.fn(async () => ({
    write: () => undefined,
    end: () => undefined,
    kill: () => undefined,
    onStdoutBytes: () => () => undefined,
    onClose: () => () => undefined,
    onError: () => () => undefined,
  })),
}));

import {
  bindSessionRemoteCodex,
  buildRemoteCodexBridgeHeader,
  ensureRemoteCodexCapability,
  resetMcprCodexCapabilityForTests,
  routeCodexThreadRegister,
  routeCodexThreadUnregister,
} from '../mcpr-codex-capability';

beforeEach(() => {
  resetMcprCodexCapabilityForTests();
  rpcOptions.length = 0;
  vi.clearAllMocks();
  readKey.mockReturnValue('gateway-key');
  hello.mockResolvedValue({
    protocolVersion: 3,
    bundleVersion: '0.0.6',
    capabilityMcpUrl: 'http://127.0.0.1:43210/mcp/lizi_capabilities',
    capabilityMcpToken: 'daemon-token',
  });
});

describe('MCPRouter Codex capability control', () => {
  it('pins protocol 3 / bundle 0.0.6 and builds a gateway-only spawn header', async () => {
    const header = await buildRemoteCodexBridgeHeader('instance-1');

    expect(rpcOptions).toContainEqual(expect.objectContaining({
      protocolVersion: 3,
      bundleVersion: '0.0.6',
      enforceBundleVersion: true,
    }));
    expect(header).toMatchObject({
      version: 1,
      cwd: '/workspace/project',
      env: {
        XDT_CODEX_API_KEY: 'gateway-key',
        LIZI_MCP_TOKEN: 'daemon-token',
      },
    });
    expect(header.extraArgs).toContain(
      'mcp_servers.lizi_capabilities.bearer_token_env_var="LIZI_MCP_TOKEN"',
    );
    expect(header.extraArgs?.join(' ')).not.toContain('daemon-token');
  });

  it('matches the stable API id when it differs from the display instance id', async () => {
    const target = {
      id: 'stable-instance-id',
      instanceId: 'display-name',
      agentType: 'codex',
      workingDir: '/workspace/project',
      supported: true,
      available: true,
    };
    listInstances.mockResolvedValueOnce([target]).mockResolvedValueOnce([target]);

    await expect(buildRemoteCodexBridgeHeader('stable-instance-id')).resolves.toMatchObject({
      cwd: '/workspace/project',
    });
    await expect(buildRemoteCodexBridgeHeader('display-name')).rejects.toThrow(
      'MCPR_INSTANCE_NOT_READY',
    );
  });

  it('ensures the bundle before registering the revision', async () => {
    await ensureRemoteCodexCapability('instance-1', {
      revisionHash: 'revision-1',
      files: [],
    });
    expect(bundleEnsure).toHaveBeenCalledWith('revision-1', [], expect.anything());
    expect(revisionRegister).toHaveBeenCalledWith('revision-1', expect.anything());
    expect(bundleEnsure.mock.invocationCallOrder[0]).toBeLessThan(
      revisionRegister.mock.invocationCallOrder[0]!,
    );
  });

  it('routes thread registration to the remote daemon for a bound session', async () => {
    bindSessionRemoteCodex('session-1', {
      instanceId: 'instance-1',
      revisionHash: 'revision-1',
    });
    const localRegister = vi.fn();
    const localUnregister = vi.fn();

    routeCodexThreadRegister(
      { threadId: 'thread-1', sessionId: 'session-1' },
      localRegister,
    );
    await vi.waitFor(() => {
      expect(threadRegister).toHaveBeenCalledWith(
        'thread-1',
        'revision-1',
        expect.anything(),
      );
    });
    routeCodexThreadUnregister('thread-1', localUnregister);
    await vi.waitFor(() => {
      expect(threadUnregister).toHaveBeenCalledWith('thread-1', expect.anything());
    });
    expect(localRegister).not.toHaveBeenCalled();
    expect(localUnregister).not.toHaveBeenCalled();
  });

  it('fails closed when the gateway key is unavailable', async () => {
    readKey.mockReturnValue(null);
    await expect(buildRemoteCodexBridgeHeader('instance-1')).rejects.toThrow(
      'REMOTE_CODEX_GATEWAY_KEY_REQUIRED',
    );
    expect(hello).not.toHaveBeenCalled();
  });
});
