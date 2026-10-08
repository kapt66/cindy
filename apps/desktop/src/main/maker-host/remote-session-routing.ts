import { MCPR_REMOTE_HOST_PREFIX } from '../../shared/meka-router.js';

export type RemoteSessionTransport = 'local' | 'ssh' | 'mcpr';

/** 远端会话可能承载的引擎(与 maker-core 的 AgentKind 同集,单独声明一是为了本模块纯函数化)。 */
export type RemoteAgentKind = 'claude-code' | 'codex' | 'pi';

/**
 * Keep session transport selection ahead of any SSH-only preflight or recovery.
 * MCPRouter ids are logical tunnel identities, not entries in the SSH pool.
 */
export function classifyRemoteSessionTransport(
  remoteHostId: string | null | undefined,
): RemoteSessionTransport {
  if (!remoteHostId) return 'local';
  // Keep malformed `mcpr:` values on the MCPRouter error path instead of
  // misclassifying them as SSH hosts and reporting SSH_HOST_NOT_FOUND.
  return remoteHostId.startsWith(MCPR_REMOTE_HOST_PREFIX) ? 'mcpr' : 'ssh';
}

/**
 * Resolve the credential source owned by a remote Codex transport.
 *
 * MCPRouter's codex-appserver bridge receives only the Cindy AI Gateway key;
 * Desktop OAuth is deliberately never copied to it. SSH keeps its established
 * fallback behavior because its isolated CODEX_HOME owns that host's auth.
 */
export function resolveRemoteCodexCredentialMode(
  remoteHostId: string,
): 'gateway-key' | undefined {
  return classifyRemoteSessionTransport(remoteHostId) === 'mcpr'
    ? 'gateway-key'
    : undefined;
}

/**
 * MCPRouter 现在承载 `claude-code` / `codex` / `pi` 三个引擎,因此这里**没有**引擎级静态门禁。
 *
 * 2026-10-09 起 MCPRouter 新增 `mode=pi` 隧道(`openMcprTunnel(..., { mode: 'pi' })`):
 * runtime 把隧道接到 `pi-manager bridge --socket <受管 socket>` 的 stdio,客户端这一侧的 Pi
 * 协议与 SSH 路径逐字节同源,差别只是字节从哪来(见 `docs/dev-rules/pi-harness.md`
 * 「MCPRouter 远端(MCPR)」)。
 *
 * 历史:2026-09-29 这里曾有一个 `assertMcprHostSupportsAgent('pi', …)` 静态门禁(类型化
 * `MCPR_AGENT_UNSUPPORTED`)。它解决的问题是**归因**——没有它时 `mcpr:<id>` 会被送进
 * `getRemoteSshPool()`,被报成 `remote SSH host "mcpr:<id>" not found in pool`。现在的做法
 * 改为在每个远端钩子内部按 transport 分派(数据面走隧道、控制面走 runtime 能力),
 * 事实不成立时给出的是**能力级**失败,而不是把「这个组合没有实现」当成引擎与 transport
 * 的永久不兼容再拦一次。SSH 路径的既有语义(claude/codex/pi 全部可用)一字未改。
 */
