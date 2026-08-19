/**
 * Control-plane support for MCPRouter-hosted Codex workers.
 *
 * A regular cc-mgr tunnel carries bundle and thread-routing RPC. A second
 * `codex-appserver` tunnel carries only Codex app-server NDJSON.
 */

import { CC_MGR_BUNDLE_VERSION, RpcClient } from '@cindy/maker-cc-manager';
import type { BundleFile, HelloResult } from '@cindy/maker-cc-manager';

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
  type CcManagerByteStream,
} from './cc-manager-client.js';
import {
  buildCodexGatewayBaseUrl,
  buildCodexProxySpawnArgs,
  CODEX_GATEWAY_ENV_KEY,
} from './codex-gateway-config.js';
import { openMcprTunnel } from './mcpr-tunnel.js';

const log = createLogger('mcpr-codex-capability');
const CAPABILITY_SERVER_NAME = 'lizi_capabilities';
const MCPR_CODEX_PROTOCOL_VERSION = 3;

interface McprControlChannel {
  client: RpcClient;
  stream: CcManagerByteStream;
  hello: HelloResult;
  closeState: {
    info: { code: number | null; signal: string | null } | null;
  };
}

const channels = new Map<string, Promise<McprControlChannel>>();

function enrichStreamClosedError(
  error: unknown,
  instanceId: string,
  closeInfo: { code: number | null; signal: string | null } | null,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!/stream closed/i.test(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  const detail = closeInfo
    ? `tunnel closed code=${closeInfo.code ?? '?'}${closeInfo.signal ? ` reason=${closeInfo.signal}` : ''}`
    : 'tunnel closed before close-frame details were captured';
  return new Error(`${message} [${instanceId}: ${detail}]`);
}

async function getMcprControlChannel(instanceId: string): Promise<McprControlChannel> {
  const existing = channels.get(instanceId);
  if (existing) return await existing;

  const opening = (async (): Promise<McprControlChannel> => {
    const stream = await openMcprTunnel(`mcpr:${instanceId}`);
    const closeState: McprControlChannel['closeState'] = { info: null };
    stream.onClose((info) => {
      closeState.info = info;
      channels.delete(instanceId);
    });
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
      throw enrichStreamClosedError(error, instanceId, closeState.info);
    }
    if (!hello.capabilityMcpUrl || !hello.capabilityMcpToken) {
      throw new Error(
        '[MCPR_CAPABILITY_UNAVAILABLE] cc-mgr did not advertise a capability MCP endpoint',
      );
    }
    log.info('MCPRouter Codex control channel open', {
      instanceId,
      bundleVersion: hello.bundleVersion,
    });
    return { client, stream, hello, closeState };
  })();

  channels.set(instanceId, opening);
  try {
    return await opening;
  } catch (error) {
    channels.delete(instanceId);
    throw error;
  }
}

export interface RemoteCodexCapabilityBundle {
  revisionHash: string;
  files: readonly BundleFile[];
}

export async function ensureRemoteCodexCapability(
  instanceId: string,
  bundle: RemoteCodexCapabilityBundle,
): Promise<string> {
  const { client, closeState } = await getMcprControlChannel(instanceId);
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
      await client.bundleRelease(bundle.revisionHash, {
        timeoutMs: RPC_REQUEST_TIMEOUT_MS,
      }).catch((releaseError) => {
        log.warn('remote Codex capability rollback release failed', {
          instanceId,
          revisionHash: bundle.revisionHash,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
        });
      });
    }
    throw enrichStreamClosedError(error, instanceId, closeState.info);
  }
}

export async function releaseRemoteCodexCapability(
  instanceId: string,
  revisionHash: string,
): Promise<void> {
  try {
    const { client } = await getMcprControlChannel(instanceId);
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
  const { client } = await getMcprControlChannel(instanceId);
  await client.capabilityThreadRegister(threadId, revisionHash, {
    timeoutMs: RPC_REQUEST_TIMEOUT_MS,
  });
}

async function unregisterRemoteCodexThread(
  instanceId: string,
  threadId: string,
): Promise<void> {
  try {
    const { client } = await getMcprControlChannel(instanceId);
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
const remoteCodexByThread = new Map<
  string,
  SessionRemoteCodexHandle & { sessionId: string }
>();

export function bindSessionRemoteCodex(
  sessionId: string,
  handle: SessionRemoteCodexHandle,
): SessionRemoteCodexHandle | undefined {
  const previous = remoteCodexBySession.get(sessionId);
  remoteCodexBySession.set(sessionId, handle);
  return previous;
}

export function unbindSessionRemoteCodex(
  sessionId: string,
): SessionRemoteCodexHandle | undefined {
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

export function routeCodexThreadUnregister(
  threadId: string,
  localUnregister: () => void,
): void {
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
    (instance) => instance.id === instanceId
      && instance.supported
      && instance.available,
  );
  if (!target) {
    throw new Error(
      `[MCPR_INSTANCE_NOT_READY] MCPRouter Worker target is unavailable: mcpr:${instanceId}`,
    );
  }

  const gatewayKey = readClaudeApiKey();
  if (!gatewayKey) {
    throw new Error(
      '[REMOTE_CODEX_GATEWAY_KEY_REQUIRED] Remote Codex Worker requires an AI Gateway API key',
    );
  }

  const { hello } = await getMcprControlChannel(instanceId);
  return {
    version: 1,
    cwd: target.workingDir,
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

export function resetMcprCodexCapabilityForTests(): void {
  channels.clear();
  remoteCodexBySession.clear();
  remoteCodexByThread.clear();
}
