import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn(() => process.cwd()),
  },
}));

/**
 * `protocol/hello` 的模拟响应。
 *
 * capability 两个字段声明成**可选**：真实 daemon 在旧 bundle 上可能不声明 capability MCP，
 * 而「不声明 ⇒ fail closed」正是本模块要守的失败面（PSB / MCPR 各自的归因码）。
 */
const hello = vi.fn(async (): Promise<{
  protocolVersion: number;
  // **远端 daemon 自报的值**——它不参与「客户端要求什么版本」的断言,只是模拟一个老 daemon。
  // 客户端的**要求**来自真实 pin(见下方 mock 的 `...actual` 透传),两者必须区分开:
  // 早先这里把客户端要求的版本也写死成 '0.0.7',于是真实 pin 漂到 0.0.10 之后这个用例
  // 依然全绿,什么都守不住(缺口记录见 `meka-whitelist-verification.md` WL-4.1.6)。
  bundleVersion: string;
  capabilityMcpUrl?: string;
  capabilityMcpToken?: string;
}> => ({
  protocolVersion: 3,
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
  buildTunnelRemoteCodexBridgeHeader,
  ensureRemoteCodexCapability,
  probeRemoteCodexCapability,
  releaseSessionRemoteCodexCapability,
  releaseTunnelCodexControlChannel,
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

/**
 * PSB 远程工作区（`psb:` transport）复用同一个控制面步骤，只是控制通道从 PSB 的
 * `mode=cc-mgr` 隧道来、缓存键换成完整 `psb:<sessionId>`。它不查 MCPRouter 实例表
 * （PSB 会话不是 MCPRouter 实例），也不下发 `cwd`（PSB 的远端目录由会话决定，Cindy 侧的
 * workingDir 是虚拟路径）。
 */
describe('PSB Codex capability control', () => {
  /** 控制通道只需要能被 `bridgeStreamToDuplex` 接起来的字节流句柄形状（其余方法不被调用）。 */
  const psbStream = {
    write: () => true,
    end: () => undefined,
    kill: () => undefined,
    onStdoutBytes: () => () => undefined,
    onStdout: () => () => undefined,
    onStderr: () => () => undefined,
    onDrain: () => () => undefined,
    onClose: () => () => undefined,
    onError: () => () => undefined,
  };
  const openControlStream = vi.fn(async () => psbStream);

  beforeEach(() => {
    openControlStream.mockClear();
  });

  it('builds the same gateway-key header over the PSB control tunnel, without a cwd', async () => {
    const header = await buildTunnelRemoteCodexBridgeHeader({
      remoteHostId: 'psb:session-1',
      openControlStream,
    });

    expect(openControlStream).toHaveBeenCalledTimes(1);
    expect(listInstances).not.toHaveBeenCalled();
    expect(header).toMatchObject({
      version: 1,
      env: {
        XDT_CODEX_API_KEY: 'gateway-key',
        LIZI_MCP_TOKEN: 'daemon-token',
      },
    });
    // 虚拟 workingDir 不得作为远端路径下发。
    expect(header.cwd).toBeUndefined();
    expect(header.extraArgs).toContain(
      'mcp_servers.lizi_capabilities.bearer_token_env_var="LIZI_MCP_TOKEN"',
    );

    // 第二条 header 复用同一条控制通道（缓存键 = 完整 remoteHostId）。
    await buildTunnelRemoteCodexBridgeHeader({ remoteHostId: 'psb:session-1', openControlStream });
    expect(openControlStream).toHaveBeenCalledTimes(1);
  });

  it('attributes a missing capability endpoint to PSB, not to MCPRouter', async () => {
    hello.mockResolvedValueOnce({
      protocolVersion: 3,
      bundleVersion: '0.0.7',
      // 远端 cc-mgr 没声明 capability MCP：必须 fail closed，且归因到 PSB。
    });

    await expect(
      buildTunnelRemoteCodexBridgeHeader({ remoteHostId: 'psb:session-1', openControlStream }),
    ).rejects.toThrow('[PSB_CAPABILITY_UNAVAILABLE]');
  });

  it('keeps the MCPRouter attribution for malformed `mcpr:` control targets', async () => {
    hello.mockResolvedValueOnce({ protocolVersion: 3, bundleVersion: '0.0.7' });

    await expect(
      buildTunnelRemoteCodexBridgeHeader({ remoteHostId: 'mcpr:', openControlStream }),
    ).rejects.toThrow('[MCPR_CAPABILITY_UNAVAILABLE]');
  });

  /**
   * 会话退休 / 重绑 / 停止：控制通道（`mode=cc-mgr`）按 `psb:<sessionId>` 缓存，只有流自己
   * close 才会被清。不显式释放会留下一条没人认领的长连接（PSB 侧按会话统计活动隧道）。
   * 这里钉住「释放一次 → 缓存清空 → 下一次 hello 重新打开」，以及重复释放幂等。
   */
  it('releases the cached PSB control tunnel on retirement and reopens it next time', async () => {
    const end = vi.fn();
    const kill = vi.fn();
    const opener = vi.fn(async () => ({ ...psbStream, end, kill }));

    await buildTunnelRemoteCodexBridgeHeader({
      remoteHostId: 'psb:session-2',
      openControlStream: opener,
    });
    expect(opener).toHaveBeenCalledTimes(1);

    await releaseTunnelCodexControlChannel('psb:session-2');
    expect(end).toHaveBeenCalledTimes(1);
    // 幂等：通道已释放，第二次释放不重复关流、也不抛错。
    await releaseTunnelCodexControlChannel('psb:session-2');
    expect(end).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();

    // 缓存已清：下一次 hello 必须重新打开一条干净通道。
    await buildTunnelRemoteCodexBridgeHeader({
      remoteHostId: 'psb:session-2',
      openControlStream: opener,
    });
    expect(opener).toHaveBeenCalledTimes(2);
  });

  /**
   * 释放与重开的时间窗：旧流 onClose 迟到时，缓存里可能已经插入了同 key 的新通道。
   * 旧 close 若无条件 `channels.delete(key)` 会把新条目删掉，导致下一次 hello 白白重开。
   */
  it('ignores a delayed close from a released older channel (does not evict the newer cache entry)', async () => {
    const closeHandlers: Array<() => void> = [];
    const opener = vi.fn(async () => ({
      ...psbStream,
      end: vi.fn(),
      kill: vi.fn(),
      onClose: (callback: (info: { code: number | null; signal: string | null }) => void) => {
        closeHandlers.push(() => callback({ code: 1000, signal: null }));
        return () => undefined;
      },
    }));

    await buildTunnelRemoteCodexBridgeHeader({
      remoteHostId: 'psb:session-close-race',
      openControlStream: opener,
    });
    // 控制通道自己注册一个 onClose（索引 0），bridgeStreamToDuplex 可能再注册一个；用
    // 「每开一条通道就多几个 handler」判断，取第一条（本模块的守卫）来触发迟到 close。
    const handlersPerChannel = closeHandlers.length;
    expect(handlersPerChannel).toBeGreaterThanOrEqual(1);

    await releaseTunnelCodexControlChannel('psb:session-close-race');
    await buildTunnelRemoteCodexBridgeHeader({
      remoteHostId: 'psb:session-close-race',
      openControlStream: opener,
    });
    expect(closeHandlers.length).toBe(handlersPerChannel * 2);

    // 旧通道的 close 此刻才到：不能删掉新通道的缓存条目。
    closeHandlers[0]!();
    await buildTunnelRemoteCodexBridgeHeader({
      remoteHostId: 'psb:session-close-race',
      openControlStream: opener,
    });
    expect(opener).toHaveBeenCalledTimes(2);
  });

  /**
   * hello / capability 校验失败时这条流没有进入缓存，不会被任何 close 事件收尸；
   * 不 kill 就会「每次重试泄漏一条隧道」。
   */
  it('kills the control stream when the hello handshake fails instead of leaking it', async () => {
    const kill = vi.fn();
    hello.mockRejectedValueOnce(new Error('stream closed before hello'));
    const opener = vi.fn(async () => ({ ...psbStream, kill }));

    await expect(
      buildTunnelRemoteCodexBridgeHeader({
        remoteHostId: 'psb:session-hello-fail',
        openControlStream: opener,
      }),
    ).rejects.toThrow(/stream closed before hello/);

    expect(kill).toHaveBeenCalledTimes(1);
  });
});
