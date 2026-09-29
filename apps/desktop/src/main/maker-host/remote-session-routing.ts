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

/** `MCPR_AGENT_UNSUPPORTED` 的 wire 码;渲染层按前缀识别并给可操作文案。 */
export const MCPR_AGENT_UNSUPPORTED_CODE = 'MCPR_AGENT_UNSUPPORTED';

/**
 * MCPRouter 隧道承载不了的引擎。
 *
 * **为什么要有这个类型化错误,而不是让调用点各自 `throw new Error(...)`**:
 * Pi 的远端钩子在 2026-09-29 实测里把 `mcpr:<id>` 直接喂给 `getRemoteSshPool()`,
 * 于是「MCPRouter 不支持 Pi」这件事被报成
 * `remote SSH host "mcpr:<id>" not found in pool — connect it first under Settings → Remote`,
 * 再被 lazy-create 的 catch-all 套上 `LAZY_CREATE_FAILED`。错误的 transport 归因会让用户
 * 去 Settings → Remote 找一个永远不会存在的 SSH 主机。带 `code` 的类型化错误让
 * 上层(preflight IPC / 日志)都能按事实分类,而不是解析自由文本。
 */
export class McprUnsupportedAgentError extends Error {
  readonly code = MCPR_AGENT_UNSUPPORTED_CODE;

  constructor(
    readonly agentKind: RemoteAgentKind,
    readonly remoteHostId: string,
  ) {
    super(
      `[${MCPR_AGENT_UNSUPPORTED_CODE}] MCPRouter remote sessions host the claude-code and codex engines only; `
        + `"${agentKind}" cannot run on "${remoteHostId}"`,
    );
    this.name = 'McprUnsupportedAgentError';
  }
}

/**
 * MCPRouter 侧的引擎门禁：`mcpr:<instance.id>` 只承载 `claude-code` / `codex`。
 *
 * 两条事实合起来才成立,改任何一条都要重判这个函数:
 *   1. MCPRouter 的 project-agent-instances 只把 `agentType` 为 `claude` / `codex` 的实例判为
 *      可用(`meka-settings/routerService.ts` 的 `normalizeInstance`);
 *   2. Pi 的远端形态只有 SSH(`maker-pi-manager` daemon + `SshPiDaemonTransport`,
 *      见 `docs/dev-rules/pi-harness.md`「SSH 远端能力」)。
 *
 * 因此 Pi + `mcpr:` 不是「暂时坏了」而是**没有实现**的组合:它必须在读取 SSH pool 之前
 * 就以这个错误失败,而不是退化成 SSH host 查询。非 mcpr(本地 / SSH)直接放行。
 */
export function assertMcprHostSupportsAgent(
  agentKind: RemoteAgentKind,
  remoteHostId: string,
): void {
  if (classifyRemoteSessionTransport(remoteHostId) !== 'mcpr') return;
  if (agentKind === 'claude-code' || agentKind === 'codex') return;
  throw new McprUnsupportedAgentError(agentKind, remoteHostId);
}
