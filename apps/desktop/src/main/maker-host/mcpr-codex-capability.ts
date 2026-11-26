/**
 * Control-plane support for tunnel-hosted Codex workers (`mcpr:` / `psb:`).
 *
 * A regular cc-mgr tunnel carries bundle and thread-routing RPC. A second
 * `codex-appserver` tunnel carries only Codex app-server NDJSON.
 *
 * The control channel itself is **transport-agnostic**: it only needs a byte stream. MCPRouter
 * opens it with `openMcprTunnel('mcpr:<id>')`; PSB remote-workspace sessions open the same mode
 * on their own tunnel and get the same capability MCP endpoint from the remote cc-mgr bundle
 * (same frame contract, see `docs/dev-rules/psb-remote-session-transport.md` §2). Callers that
 * are not MCPRouter instances inject the opener through
 * {@link buildTunnelRemoteCodexBridgeHeader} instead of duplicating the hello/RPC logic.
 */

import { CC_MGR_BUNDLE_VERSION, RpcClient } from '@cindy/maker-cc-manager';
import type { BundleFile, HelloResult } from '@cindy/maker-cc-manager';
import type { ExecStreamHandle } from '@cindy/maker-remote-ssh';

import { createLogger } from '../logger.js';
import {
  CODEX_MCP_TOKEN_ENV,
  CODEX_MCP_TIMEOUT_SEC,
  codexTomlString,
} from '../mcp-integrations/codexEnvironment.js';
import { getMekaRouterService } from '../meka-settings/ipc.js';
import { readClaudeApiKey } from './auth-adapters.js';
import {
  bridgeStreamToDuplex,
  RPC_REQUEST_TIMEOUT_MS,
} from './cc-manager-client.js';
import {
  buildCodexGatewayBaseUrl,
  buildCodexProxySpawnArgs,
  CODEX_GATEWAY_ENV_KEY,
} from './codex-gateway-config.desktop.js';
import { openMcprTunnel } from './mcpr-tunnel.js';
import { classifyRemoteSessionTransport } from './remote-session-routing.js';

const log = createLogger('mcpr-codex-capability');
const CAPABILITY_SERVER_NAME = 'lizi_capabilities';
const MCPR_CODEX_PROTOCOL_VERSION = 3;

interface RemoteCodexControlChannel {
  client: RpcClient;
  stream: ExecStreamHandle;
  hello: HelloResult;
  closeState: {
    info: { code: number | null; signal: string | null } | null;
  };
}

/**
 * 控制通道的打开方式：由调用方决定"从哪条隧道来"，本模块只关心字节流。
 *
 * `remoteHostId` 是完整隧道身份（`mcpr:<id>` / `psb:<sessionId>`），同时用作缓存键与归因
 * 标签——两种 transport 的身份空间可能重名，绝不能只用裸 instanceId / sessionId 当键。
 */
interface RemoteCodexControlTarget {
  remoteHostId: string;
  openControlStream: () => Promise<ExecStreamHandle>;
}

const channels = new Map<string, Promise<RemoteCodexControlChannel>>();

function enrichStreamClosedError(
  error: unknown,
  remoteHostId: string,
  closeInfo: { code: number | null; signal: string | null } | null,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!/stream closed/i.test(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  const detail = closeInfo
    ? `tunnel closed code=${closeInfo.code ?? '?'}${closeInfo.signal ? ` reason=${closeInfo.signal}` : ''}`
    : 'tunnel closed before close-frame details were captured';
  return new Error(`${message} [${remoteHostId}: ${detail}]`);
}

/** MCPRouter 实例的控制通道目标（既有行为：默认 `mode=cc-mgr` 隧道）。 */
function mcprControlTarget(instanceId: string): RemoteCodexControlTarget {
  return {
    remoteHostId: `mcpr:${instanceId}`,
    openControlStream: () => openMcprTunnel(`mcpr:${instanceId}`),
  };
}

async function getControlChannel(
  target: RemoteCodexControlTarget,
): Promise<RemoteCodexControlChannel> {
  const existing = channels.get(target.remoteHostId);
  if (existing) return await existing;

  const opening = (async (): Promise<RemoteCodexControlChannel> => {
    const stream = await target.openControlStream();
    const closeState: RemoteCodexControlChannel['closeState'] = { info: null };
    stream.onClose((info) => {
      closeState.info = info;
      // 只删**自己那一条**：`releaseTunnelCodexControlChannel` 会先摘掉旧 entry 再关旧流；
      // 若这期间同一 key 已经插入了新通道，旧流的迟到 close 不能把新条目删掉（否则下一次
      // hello 会无谓地重开一条隧道）。身份比较用同一个 `opening` 对象。
      if (channels.get(target.remoteHostId) === opening) channels.delete(target.remoteHostId);
    });
    try {
      const client = new RpcClient(bridgeStreamToDuplex(stream), {
        protocolVersion: MCPR_CODEX_PROTOCOL_VERSION,
        bundleVersion: CC_MGR_BUNDLE_VERSION,
        enforceBundleVersion: true,
        clientId: 'cindy-meka-remote-codex',
      });
      let hello: HelloResult;
      try {
        hello = await client.hello({ timeoutMs: RPC_REQUEST_TIMEOUT_MS });
      } catch (error) {
        throw enrichStreamClosedError(error, target.remoteHostId, closeState.info);
      }
      if (!hello.capabilityMcpUrl || !hello.capabilityMcpToken) {
        // 归因码跟着 transport 走：PSB 会话上冒出 `[MCPR_*]` 会把运维指向错误的系统。
        throw new Error(
          classifyRemoteSessionTransport(target.remoteHostId) === 'psb'
            ? '[PSB_CAPABILITY_UNAVAILABLE] cc-mgr did not advertise a capability MCP endpoint'
            : '[MCPR_CAPABILITY_UNAVAILABLE] cc-mgr did not advertise a capability MCP endpoint',
        );
      }
      log.info('remote Codex control channel open', {
        remoteHostId: target.remoteHostId,
        bundleVersion: hello.bundleVersion,
      });
      return { client, stream, hello, closeState };
    } catch (error) {
      // hello / capability 校验失败时这条流没有进入缓存，不会被任何 close 事件收尸；
      // 不在这里 kill 就会「每次失败重试泄漏一条隧道」（PSB 侧按会话统计活动隧道）。
      try {
        stream.kill();
      } catch {
        // best-effort：已经断开的流 kill 失败不影响原始归因。
      }
      throw error;
    }
  })();

  channels.set(target.remoteHostId, opening);
  try {
    return await opening;
  } catch (error) {
    channels.delete(target.remoteHostId);
    throw error;
  }
}

export interface RemoteCodexCapabilityBundle {
  revisionHash: string;
  files: readonly BundleFile[];
}

/**
 * 主动释放某个隧道身份的控制通道（PSB 会话退休 / 重绑 / 停止路径）。
 *
 * ## 为什么需要显式释放
 *
 * 控制通道是**长连接**：`getControlChannel` 把它按 `remoteHostId` 缓存，只在**流自己 close**
 * 时删缓存。PSB 会话的生命周期由 Cindy 结束（stop / 发送前重建），服务端不会因为本地会话
 * 退休就替我们关这条 `mode=cc-mgr` 隧道——不显式释放会在缓存里留下一条没人认领的长连接，
 * PSB 侧按会话统计活动隧道，后续 stop / commit 类动作会被它牵住（与 MCPR 同型的故障面）。
 *
 * ## PSB 侧是否代关（假设）
 *
 * 这里**假设但不依赖** PSB 在会话停止时回收该会话的所有隧道：本函数是幂等的「先自己关」，
 * 服务端若已经关了，`end()` 只会走到已经 closed 的流上（实现里是 best-effort）。
 * 反过来说，若 PSB 并不代关，这条释放就是唯一让隧道消失的路径。
 */
export async function releaseTunnelCodexControlChannel(remoteHostId: string): Promise<void> {
  const pending = channels.get(remoteHostId);
  if (!pending) return;
  // 先删缓存：之后任何一次 hello 都会重新打开一条干净通道，而不是复用正在关闭的旧连接。
  channels.delete(remoteHostId);
  let channel: RemoteCodexControlChannel;
  try {
    channel = await pending;
  } catch {
    // 打开失败的 promise 已在 getControlChannel 内部清缓存并上报原因，无需再处理。
    return;
  }
  try {
    channel.stream.end();
  } catch (error) {
    try {
      channel.stream.kill();
    } catch {
      // best-effort：流已不可写也不能让释放路径抛错。
    }
    log.warn('remote Codex control channel end failed; killed the stream instead', {
      remoteHostId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  log.info('remote Codex control channel released', { remoteHostId });
}

/**
 * Verify the exact remote capability runtime before a workflow reports a tunnel-hosted Codex
 * target as ready. The hello handshake enforces protocol/bundle compatibility and capability
 * MCP presence.
 */
export async function probeRemoteCodexCapability(instanceId: string): Promise<void> {
  await getControlChannel(mcprControlTarget(instanceId));
}

export async function ensureRemoteCodexCapability(
  instanceId: string,
  bundle: RemoteCodexCapabilityBundle,
): Promise<string> {
  const { client, closeState } = await getControlChannel(mcprControlTarget(instanceId));
  let retained = false;
  try {
    const ensured = await client.bundleEnsure(bundle.revisionHash, bundle.files, {
      timeoutMs: RPC_REQUEST_TIMEOUT_MS,
    });
    retained = true;
    await client.capabilityRevisionRegister(bundle.revisionHash, {
      timeoutMs: RPC_REQUEST_TIMEOUT_MS,
    });
    return ensured.pluginPath;
  } catch (error) {
    if (retained) {
      await client
        .bundleRelease(bundle.revisionHash, {
          timeoutMs: RPC_REQUEST_TIMEOUT_MS,
        })
        .catch((releaseError) => {
          log.warn('remote Codex capability rollback release failed', {
            instanceId,
            revisionHash: bundle.revisionHash,
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          });
        });
    }
    throw enrichStreamClosedError(error, `mcpr:${instanceId}`, closeState.info);
  }
}

export async function releaseRemoteCodexCapability(
  instanceId: string,
  revisionHash: string,
): Promise<void> {
  try {
    const { client } = await getControlChannel(mcprControlTarget(instanceId));
    await client.bundleRelease(revisionHash, { timeoutMs: RPC_REQUEST_TIMEOUT_MS });
  } catch (error) {
    log.warn('remote Codex capability release failed', {
      instanceId,
      revisionHash,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function registerRemoteCodexThread(
  instanceId: string,
  threadId: string,
  revisionHash: string,
): Promise<void> {
  const { client } = await getControlChannel(mcprControlTarget(instanceId));
  await client.capabilityThreadRegister(threadId, revisionHash, {
    timeoutMs: RPC_REQUEST_TIMEOUT_MS,
  });
}

async function unregisterRemoteCodexThread(instanceId: string, threadId: string): Promise<void> {
  try {
    const { client } = await getControlChannel(mcprControlTarget(instanceId));
    await client.capabilityThreadUnregister(threadId, {
      timeoutMs: RPC_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    log.warn('remote Codex thread unregister failed', {
      instanceId,
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface SessionRemoteCodexHandle {
  instanceId: string;
  revisionHash: string;
}

const remoteCodexBySession = new Map<string, SessionRemoteCodexHandle>();
const remoteCodexByThread = new Map<string, SessionRemoteCodexHandle & { sessionId: string }>();

export function bindSessionRemoteCodex(
  sessionId: string,
  handle: SessionRemoteCodexHandle,
): SessionRemoteCodexHandle | undefined {
  const previous = remoteCodexBySession.get(sessionId);
  remoteCodexBySession.set(sessionId, handle);
  return previous;
}

export function unbindSessionRemoteCodex(sessionId: string): SessionRemoteCodexHandle | undefined {
  const handle = remoteCodexBySession.get(sessionId);
  remoteCodexBySession.delete(sessionId);
  for (const [threadId, binding] of remoteCodexByThread) {
    if (binding.sessionId === sessionId) remoteCodexByThread.delete(threadId);
  }
  return handle;
}

/** Drop a session binding and release the daemon's matching bundle reference. */
export async function releaseSessionRemoteCodexCapability(sessionId: string): Promise<void> {
  const handle = unbindSessionRemoteCodex(sessionId);
  if (!handle) return;
  await releaseRemoteCodexCapability(handle.instanceId, handle.revisionHash);
}

export function routeCodexThreadRegister(
  args: {
    threadId: string;
    sessionId: string;
    capabilityRevisionHash?: string;
  },
  localRegister: () => void,
): void {
  const handle = remoteCodexBySession.get(args.sessionId);
  if (!handle) {
    localRegister();
    return;
  }
  remoteCodexByThread.set(args.threadId, { ...handle, sessionId: args.sessionId });
  void registerRemoteCodexThread(
    handle.instanceId,
    args.threadId,
    args.capabilityRevisionHash ?? handle.revisionHash,
  ).catch((error) => {
    remoteCodexByThread.delete(args.threadId);
    log.warn('remote Codex thread register failed; capability routing disabled', {
      sessionId: args.sessionId,
      threadId: args.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function routeCodexThreadUnregister(threadId: string, localUnregister: () => void): void {
  const handle = remoteCodexByThread.get(threadId);
  remoteCodexByThread.delete(threadId);
  if (!handle) {
    localUnregister();
    return;
  }
  void unregisterRemoteCodexThread(handle.instanceId, threadId);
}

export interface CodexBridgeSpawnHeader {
  version: 1;
  cwd?: string;
  env?: Record<string, string>;
  extraArgs?: string[];
}

export interface TunnelCodexBridgeHeaderInput {
  /** 完整隧道身份(`mcpr:<id>` / `psb:<sessionId>`),同时作为控制通道缓存键与归因标签。 */
  remoteHostId: string;
  /**
   * 远端 app-server 的工作目录。
   *
   * 只有 MCPRouter 能回答(MCPR 实例记录里带 `workingDir`);PSB 远程工作区的目录由 PSB 会话
   * 决定,Cindy 侧的 `workingDir` 是虚拟路径,**不得**当远端路径下发(见
   * `shared/psb-remote-workspace.ts` 文件头第 3 条约束)。缺省 = 让远端 runtime 用会话自己的
   * 工作区(`codex-bridge` 的 header `cwd?` 是可选字段)。
   */
  cwd?: string;
  openControlStream: () => Promise<ExecStreamHandle>;
}

/**
 * 在任意 agent-tunnel 上构建 Codex bridge spawn header(与 MCPRouter 同一套步骤)。
 *
 * 步骤:取控制通道(`mode=cc-mgr`)→ hello 自报的 capability MCP → 把「本机 AI Gateway key +
 * capability token + 网关 provider 参数」装进首行 header。远端只拿 key,不拿 OAuth——这是
 * `resolveRemoteCodexCredentialMode` 判 `'gateway-key'` 的同一份口径
 * (`docs/dev-rules/mcpr-remote-session-routing.md` §4)。
 */
export async function buildTunnelRemoteCodexBridgeHeader(
  input: TunnelCodexBridgeHeaderInput,
): Promise<CodexBridgeSpawnHeader> {
  const gatewayKey = readClaudeApiKey();
  if (!gatewayKey) {
    throw new Error(
      '[REMOTE_CODEX_GATEWAY_KEY_REQUIRED] Remote Codex Worker requires an AI Gateway API key',
    );
  }

  const { hello } = await getControlChannel({
    remoteHostId: input.remoteHostId,
    openControlStream: input.openControlStream,
  });
  return {
    version: 1,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    env: {
      [CODEX_GATEWAY_ENV_KEY]: gatewayKey,
      [CODEX_MCP_TOKEN_ENV]: hello.capabilityMcpToken!,
    },
    extraArgs: [
      ...buildCodexProxySpawnArgs(buildCodexGatewayBaseUrl(), 'env-key'),
      '-c',
      `mcp_servers.${CAPABILITY_SERVER_NAME}.url=${codexTomlString(hello.capabilityMcpUrl!)}`,
      '-c',
      `mcp_servers.${CAPABILITY_SERVER_NAME}.bearer_token_env_var=${codexTomlString(CODEX_MCP_TOKEN_ENV)}`,
      '-c',
      `mcp_servers.${CAPABILITY_SERVER_NAME}.startup_timeout_sec=${CODEX_MCP_TIMEOUT_SEC}`,
      '-c',
      `mcp_servers.${CAPABILITY_SERVER_NAME}.tool_timeout_sec=${CODEX_MCP_TIMEOUT_SEC}`,
    ],
  };
}

/**
 * Remote Codex is deliberately gateway-key only. Desktop OAuth state and its
 * loopback proxy are never copied to another machine.
 */
export async function buildRemoteCodexBridgeHeader(
  instanceId: string,
): Promise<CodexBridgeSpawnHeader> {
  const target = (await getMekaRouterService().listInstances()).find(
    // `instanceId` here is parsed from `mcpr:<remoteHostId>`. The host ID is
    // built from the API record's stable `id`, not its display/name field.
    (instance) => instance.id === instanceId && instance.supported && instance.available,
  );
  if (!target) {
    throw new Error(
      `[MCPR_INSTANCE_NOT_READY] MCPRouter Worker target is unavailable: mcpr:${instanceId}`,
    );
  }

  const control = mcprControlTarget(instanceId);
  return buildTunnelRemoteCodexBridgeHeader({
    remoteHostId: control.remoteHostId,
    cwd: target.workingDir,
    openControlStream: control.openControlStream,
  });
}

export function resetMcprCodexCapabilityForTests(): void {
  channels.clear();
  remoteCodexBySession.clear();
  remoteCodexByThread.clear();
}
