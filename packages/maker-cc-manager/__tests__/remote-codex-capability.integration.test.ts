import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CapabilityBundleStore } from '../src/capability-bundle-store.js';
import { CapabilityMcpRouter } from '../src/capability-mcp-router.js';
import { RpcClient } from '../src/client.js';
import { wireSdkHandlers } from '../src/sdk-handlers.js';
import { ManagerServer, type ManagerLogger } from '../src/server.js';
import { SessionRegistry } from '../src/session-registry.js';

const logger: ManagerLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('remote Codex capability daemon route', () => {
  it('routes read_skill by trusted thread id through the daemon-hosted MCP server', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-mgr-remote-codex-'));
    const cacheRoot = path.join(root, 'cache');
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\cc-mgr-remote-codex-${process.pid}-${Date.now()}`
      : path.join(root, 'cc-mgr.sock');
    const capabilityRouter = new CapabilityMcpRouter({ logger });
    await capabilityRouter.start();
    const server = new ManagerServer({
      socketPath,
      logger,
      capabilityMcp: { url: capabilityRouter.url, token: capabilityRouter.token },
    });
    const store = new CapabilityBundleStore(cacheRoot, logger, { retentionMs: 0 });
    const registry = new SessionRegistry({
      sdkQueryFactory: () => {
        throw new Error('SDK query is not used by remote Codex capability tests');
      },
    });
    wireSdkHandlers(server, registry, { logger, bundleStore: store, capabilityRouter });
    await server.start();
    const socket = net.connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const client = new RpcClient(socket);
    cleanups.push(async () => {
      client.dispose();
      socket.destroy();
      await server.stop();
      await capabilityRouter.stop();
      await fs.rm(root, { recursive: true, force: true });
    });

    const hello = await client.hello();
    expect(hello.capabilityMcpUrl).toBe(capabilityRouter.url);
    expect(hello.capabilityMcpToken).toBe(capabilityRouter.token);

    const skillBody = '# Remote skill\n\nRead from the daemon cache.\n';
    const relPath = 'pack-a/skills/skill-a/SKILL.md';
    const catalog = JSON.stringify([{
      packId: 'pack-a',
      skillId: 'skill-a',
      name: 'Remote skill',
      description: 'Remote Codex route fixture',
      relPath,
    }]);
    const revisionHash = sha256(`${catalog}\0${skillBody}`);
    await client.bundleEnsure(revisionHash, [
      { relPath: 'catalog.json', content: catalog, digest: sha256(catalog) },
      { relPath, content: skillBody, digest: sha256(skillBody) },
    ]);
    await client.capabilityRevisionRegister(revisionHash);
    await client.capabilityThreadRegister('thread-remote', revisionHash);

    const headers = {
      authorization: `Bearer ${hello.capabilityMcpToken}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const init = await fetch(hello.capabilityMcpUrl!, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'remote-codex-test', version: '1.0.0' },
        },
      }),
    });
    expect(init.status).toBe(200);
    const mcpSessionId = init.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await init.text();

    const response = await fetch(hello.capabilityMcpUrl!, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': mcpSessionId! },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'read_skill',
          arguments: { packId: 'pack-a', skillId: 'skill-a' },
          _meta: { threadId: 'thread-remote' },
        },
      }),
    });
    expect(response.status).toBe(200);
    const payload = JSON.parse(await response.text()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(JSON.parse(payload.result.content[0]!.text)).toMatchObject({
      ok: true,
      skill: { packId: 'pack-a', skillId: 'skill-a', content: skillBody },
    });

    await expect(client.capabilityThreadUnregister('thread-remote')).resolves.toEqual({
      unregistered: true,
    });
    await expect(client.bundleRelease(revisionHash)).resolves.toEqual({
      released: true,
      removed: true,
    });
  });
});

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
