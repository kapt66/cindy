import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn(() => process.cwd()),
  },
}));

const hello = vi.fn(async () => ({
  protocolVersion: 3,
  // **远端 daemon 自报的值**——它不参与「客户端要求什么版本」的断言,只是模拟一个老 daemon。
  // 客户端的**要求**来自真实 pin(见下方 mock 的 `...actual` 透传),两者必须区分开:
  // 早先这里把客户端要求的版本也写死成 '0.0.7',于是真实 pin 漂到 0.0.10 之后这个用例
  // 依然全绿,什么都守不住(缺口记录见 `meka-whitelist-verification.md` WL-4.1.6)。
  bundleVersion: '0.0.7',
  capabilityMcpUrl: 'http://127.0.0.1:43210/mcp/lizi_capabilities',
  capabilityMcpToken: 'daemon-token',
}));
const bundleEnsure = vi.fn(async () => ({ pluginPath: '/remote/cache/revision' }));
const revisionRegister = vi.fn(async () => ({ registered: true as const }));
const threadRegister = vi.fn(async () => ({ registered: true as const }));
const threadUnregister = vi.fn(async () => ({ unregistered: true }));
const bundleRelease = vi.fn(async () => ({ released: true, removed: false }));
const rpcOptions: unknown[] = [];

vi.mock('@cindy/maker-cc-manager', async (importOriginal) => {
  // `...actual` 把 **真实的** `CC_MGR_BUNDLE_VERSION` 透传进来:客户端发送的 bundle 版本
  // 必须等于仓库当前 pin,而不是本文件里再抄一份字面量 —— 抄一份就等于把「客户端送的是
  // 真实 pin」这条唯一要守的事变成了自证。
  const actual = await importOriginal<typeof import('@cindy/maker-cc-manager')>();
  return {
    ...actual,
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
  };
});

const listInstances = vi.fn(async () => [
  {
    id: 'instance-1',
    instanceId: 'instance-1',
    agentType: 'codex',
    workingDir: '/workspace/project',
    supported: true,
    available: true,
  },
]);
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

import { CC_MGR_BUNDLE_VERSION } from '@cindy/maker-cc-manager';

import {
  bindSessionRemoteCodex,
  buildRemoteCodexBridgeHeader,
  ensureRemoteCodexCapability,
  probeRemoteCodexCapability,
  releaseSessionRemoteCodexCapability,
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
    bundleVersion: '0.0.7',
    capabilityMcpUrl: 'http://127.0.0.1:43210/mcp/lizi_capabilities',
    capabilityMcpToken: 'daemon-token',
  });
});

describe('MCPRouter Codex capability control', () => {
  it('mock 透传拿到的是真实 pin（否则两侧会一起变成 undefined 而自证）', () => {
    // 上面那条断言的守护价值依赖「测试读到的常量 = 生产代码读到的常量」。
    // 若 `...actual` 被删掉或 importOriginal 失效,两侧会**一起**变成 undefined,
    // 断言便会假绿 —— 这条用形状把它钉住(不复述具体版本号,避免再引入一份副本)。
    expect(CC_MGR_BUNDLE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('sends the capability protocol 3 requirement with the real pin, and builds a gateway-only spawn header', async () => {
    const header = await buildRemoteCodexBridgeHeader('instance-1');

    expect(rpcOptions).toContainEqual(
      expect.objectContaining({
        // capability 通道要求 protocol ≥ 3(服务端按 protocol 隔离能力,见 server.ts),
        // 这是客户端**自己**的通道要求,不是远端自报值。
        protocolVersion: 3,
        // bundle 版本必须是仓库当前真实 pin —— 这条断言是「客户端送的是真实 pin」的唯一守护,
        // 所以它读常量,不写字面量。
        bundleVersion: CC_MGR_BUNDLE_VERSION,
        enforceBundleVersion: true,
      }),
    );
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
    await expect(
      ensureRemoteCodexCapability('instance-1', {
        revisionHash: 'revision-1',
        files: [],
      }),
    ).resolves.toBe('/remote/cache/revision');
    expect(bundleEnsure).toHaveBeenCalledWith('revision-1', [], expect.anything());
    expect(revisionRegister).toHaveBeenCalledWith('revision-1', expect.anything());
    expect(bundleEnsure.mock.invocationCallOrder[0]).toBeLessThan(
      revisionRegister.mock.invocationCallOrder[0]!,
    );
  });

  it('probes the exact remote capability runtime without materializing a bundle', async () => {
    await expect(probeRemoteCodexCapability('instance-1')).resolves.toBeUndefined();
    expect(hello).toHaveBeenCalledTimes(1);
    expect(bundleEnsure).not.toHaveBeenCalled();
    expect(revisionRegister).not.toHaveBeenCalled();
  });

  it('releases the retained bundle when revision registration fails', async () => {
    revisionRegister.mockRejectedValueOnce(new Error('registration failed'));

    await expect(
      ensureRemoteCodexCapability('instance-1', {
        revisionHash: 'revision-1',
        files: [],
      }),
    ).rejects.toThrow('registration failed');

    expect(bundleRelease).toHaveBeenCalledWith('revision-1', expect.anything());
  });

  it('routes thread registration to the remote daemon for a bound session', async () => {
    bindSessionRemoteCodex('session-1', {
      instanceId: 'instance-1',
      revisionHash: 'revision-1',
    });
    const localRegister = vi.fn();
    const localUnregister = vi.fn();

    routeCodexThreadRegister({ threadId: 'thread-1', sessionId: 'session-1' }, localRegister);
    await vi.waitFor(() => {
      expect(threadRegister).toHaveBeenCalledWith('thread-1', 'revision-1', expect.anything());
    });
    routeCodexThreadUnregister('thread-1', localUnregister);
    await vi.waitFor(() => {
      expect(threadUnregister).toHaveBeenCalledWith('thread-1', expect.anything());
    });
    expect(localRegister).not.toHaveBeenCalled();
    expect(localUnregister).not.toHaveBeenCalled();
  });

  it('releases the retained bundle once when its session closes', async () => {
    bindSessionRemoteCodex('session-1', {
      instanceId: 'instance-1',
      revisionHash: 'revision-1',
    });

    await releaseSessionRemoteCodexCapability('session-1');
    await releaseSessionRemoteCodexCapability('session-1');

    expect(bundleRelease).toHaveBeenCalledTimes(1);
    expect(bundleRelease).toHaveBeenCalledWith('revision-1', expect.anything());
  });

  it('fails closed when the gateway key is unavailable', async () => {
    readKey.mockReturnValue(null);
    await expect(buildRemoteCodexBridgeHeader('instance-1')).rejects.toThrow(
      'REMOTE_CODEX_GATEWAY_KEY_REQUIRED',
    );
    expect(hello).not.toHaveBeenCalled();
  });
});
