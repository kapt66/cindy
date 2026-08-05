import { MCPR_REMOTE_HOST_PREFIX } from '../../shared/meka-router.js';

export type RemoteSessionTransport = 'local' | 'ssh' | 'mcpr';

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
