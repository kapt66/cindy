/** Read-only control-plane probe for an MCPRouter-hosted Claude Code worker. */

import { Duplex } from 'node:stream';

import { CC_MGR_BUNDLE_VERSION, RpcClient } from '@cindy/maker-cc-manager';
import type { ExecStreamHandle } from '@cindy/maker-remote-ssh';

import { openMcprTunnel } from './mcpr-tunnel.js';

const PROBE_TIMEOUT_MS = 15_000;

function probeStreamToDuplex(stream: ExecStreamHandle): Duplex {
  const duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      try {
        stream.write(chunk);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    destroy(error, callback) {
      try {
        stream.kill();
      } catch {
        /* tunnel already closed */
      }
      callback(error);
    },
  });
  stream.onStdoutBytes((chunk) => duplex.push(chunk));
  stream.onClose(() => duplex.destroy());
  stream.onError((error) => duplex.destroy(error));
  return duplex;
}

/**
 * Verify that the bound instance exposes a compatible cc-manager protocol.
 * This opens only the control tunnel and performs protocol/hello; it does not
 * create a Claude session or run any repository command.
 */
export async function probeRemoteClaudeCapability(instanceId: string): Promise<void> {
  const stream = await openMcprTunnel(`mcpr:${instanceId}`);
  const client = new RpcClient(probeStreamToDuplex(stream), {
    bundleVersion: CC_MGR_BUNDLE_VERSION,
    clientId: 'cindy-meka-remote-claude-probe',
  });
  try {
    await client.hello({ timeoutMs: PROBE_TIMEOUT_MS });
  } finally {
    client.dispose();
    try {
      stream.kill();
    } catch {
      /* tunnel already closed */
    }
  }
}
