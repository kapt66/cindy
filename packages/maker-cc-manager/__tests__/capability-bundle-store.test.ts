import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CapabilityBundleStore,
  type CapabilityBundleStoreOptions,
  resolvePathInsideRoot,
} from '../src/capability-bundle-store.js';
import { RpcClient } from '../src/client.js';
import { wireSdkHandlers } from '../src/sdk-handlers.js';
import { ManagerServer, type ManagerLogger } from '../src/server.js';
import { SessionRegistry } from '../src/session-registry.js';

const silentLogger: ManagerLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface Harness {
  root: string;
  cacheRoot: string;
  server: ManagerServer;
  socket: net.Socket;
  client: RpcClient;
  store: CapabilityBundleStore;
}

const harnesses: Harness[] = [];

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function sha256Bytes(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function makeIpcPath(): string {
  const id = `cc-mgr-bundle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), `${id}.sock`);
}

async function createHarness(options: CapabilityBundleStoreOptions = {}): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-mgr-bundle-test-'));
  const cacheRoot = path.join(root, 'cache');
  const socketPath = makeIpcPath();
  const server = new ManagerServer({
    socketPath,
    logger: silentLogger,
  });
  const registry = new SessionRegistry({
    sdkQueryFactory: () => {
      throw new Error('SDK query is not used by bundle tests');
    },
  });
  const store = new CapabilityBundleStore(cacheRoot, silentLogger, options);
  wireSdkHandlers(server, registry, { bundleStore: store });
  await server.start();
  const socket = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const client = new RpcClient(socket);
  await client.hello();
  const harness = { root, cacheRoot, server, socket, client, store };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.client.dispose();
    harness.socket.destroy();
    await harness.server.stop();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
});
describe('capability bundle RPC', () => {
  it('re-materializes a stale projection-only revision (Phase 4 union completeness)', async () => {
    // 0.0.4 时代物化的缓存只有 projection、没有 catalog.json。自 0.0.5 起
    // 完整性判据要求 bundle root 有 catalog.json——旧缓存判 miss 重新物化,
    // 否则 Codex 的 registerRevisionFromBundle 会 ENOENT。
    const harness = await createHarness();
    const revisionHash = sha256('stale-projection-only-revision');
    const pluginJson = '{"name":"stale"}\n';
    const staleDir = path.join(harness.cacheRoot, revisionHash, 'claude-plugin', '.claude-plugin');
    await fs.mkdir(staleDir, { recursive: true });
    await fs.writeFile(path.join(staleDir, 'plugin.json'), pluginJson, 'utf8');

    const catalogJson = '[]\n';
    const ensured = await harness.client.bundleEnsure(revisionHash, [
      { relPath: '.claude-plugin/plugin.json', content: pluginJson, digest: sha256(pluginJson) },
      { relPath: 'catalog.json', content: catalogJson, digest: sha256(catalogJson) },
    ]);
    expect(await fs.readFile(path.join(ensured.pluginPath, 'catalog.json'), 'utf8'))
      .toBe(catalogJson);
    await harness.client.bundleRelease(revisionHash);
  });

  it('fails closed with BUNDLE_MATERIALIZE_FAILED on digest mismatch', async () => {
    const harness = await createHarness();
    const revisionHash = sha256('bad-digest-revision');
    await expect(harness.client.bundleEnsure(revisionHash, [{
      relPath: '.claude-plugin/plugin.json',
      content: '{"name":"meka"}\n',
      digest: sha256('different bytes'),
    }])).rejects.toMatchObject({
      rpcError: { code: 'BUNDLE_MATERIALIZE_FAILED' },
    });
    await expect(fs.stat(path.join(harness.cacheRoot, revisionHash))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('round-trips binary bundle files from canonical base64', async () => {
    const harness = await createHarness();
    const revisionHash = sha256('binary-revision');
    const pluginJson = '{"name":"binary"}\n';
    const catalogJson = '[]\n';
    const binary = Buffer.from([0, 255, 1, 128]);
    const ensured = await harness.client.bundleEnsure(revisionHash, [
      {
        relPath: '.claude-plugin/plugin.json',
        content: pluginJson,
        digest: sha256(pluginJson),
      },
      {
        relPath: 'assets/sample.bin',
        contentBase64: binary.toString('base64'),
        digest: sha256Bytes(binary),
      },
      {
        relPath: 'catalog.json',
        content: catalogJson,
        digest: sha256(catalogJson),
      },
    ]);

    await expect(
      fs.readFile(path.join(ensured.pluginPath, 'assets', 'sample.bin')),
    ).resolves.toEqual(binary);
  });

  it('rejects non-canonical base64 payloads', async () => {
    const harness = await createHarness();
    await expect(
      harness.client.bundleEnsure(sha256('bad-base64'), [
        {
          relPath: 'assets/sample.bin',
          contentBase64: 'AA',
          digest: sha256Bytes(Buffer.from([0])),
        },
      ]),
    ).rejects.toMatchObject({
      rpcError: { code: 'BUNDLE_MATERIALIZE_FAILED' },
    });
  });

  it('deduplicates without rewriting, retains at zero, and sweeps only after expiry', async () => {
    let now = Date.now();
    const harness = await createHarness({ retentionMs: 1_000, now: () => now });
    const revisionHash = sha256('dedup-revision');
    const originalContent = '{"name":"original"}\n';
    const changedContent = '{"name":"must-not-rewrite"}\n';
    const catalogJson = '[]\n';

    const [first, second] = await Promise.all([
      harness.client.bundleEnsure(revisionHash, [
        {
          relPath: '.claude-plugin/plugin.json',
          content: originalContent,
          digest: sha256(originalContent),
        },
        { relPath: 'catalog.json', content: catalogJson, digest: sha256(catalogJson) },
      ]),
      harness.client.bundleEnsure(revisionHash, [
        {
          relPath: '.claude-plugin/plugin.json',
          content: changedContent,
          digest: sha256(changedContent),
        },
        { relPath: 'catalog.json', content: catalogJson, digest: sha256(catalogJson) },
      ]),
    ]);

    const expectedPluginPath = path.join(harness.cacheRoot, revisionHash, 'claude-plugin');
    expect(first.pluginPath).toBe(expectedPluginPath);
    expect(second.pluginPath).toBe(expectedPluginPath);
    expect(await fs.readFile(path.join(expectedPluginPath, '.claude-plugin', 'plugin.json'), 'utf8'))
      .toBe(originalContent);
    expect((await fs.readdir(harness.cacheRoot)).filter((name) => name.startsWith('.staging-')))
      .toEqual([]);

    await expect(harness.client.bundleRelease(revisionHash)).resolves.toEqual({
      released: true,
      removed: false,
    });
    await expect(fs.stat(expectedPluginPath)).resolves.toBeDefined();

    await expect(harness.client.bundleRelease(revisionHash)).resolves.toEqual({
      released: true,
      removed: false,
    });
    await expect(fs.stat(path.join(harness.cacheRoot, revisionHash))).resolves.toBeDefined();

    const resumed = await harness.client.bundleEnsure(revisionHash, [
      {
        relPath: '.claude-plugin/plugin.json',
        content: changedContent,
        digest: sha256(changedContent),
      },
      { relPath: 'catalog.json', content: catalogJson, digest: sha256(catalogJson) },
    ]);
    expect(resumed.pluginPath).toBe(expectedPluginPath);
    expect(await fs.readFile(path.join(expectedPluginPath, '.claude-plugin', 'plugin.json'), 'utf8'))
      .toBe(originalContent);
    await expect(harness.client.bundleRelease(revisionHash)).resolves.toEqual({
      released: true,
      removed: false,
    });

    now += 999;
    await expect(harness.store.sweepExpired()).resolves.toEqual([]);
    await expect(fs.stat(expectedPluginPath)).resolves.toBeDefined();
    now += 1;
    await expect(harness.store.sweepExpired()).resolves.toEqual([revisionHash]);
    await expect(fs.stat(path.join(harness.cacheRoot, revisionHash))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(harness.client.bundleRelease(revisionHash)).resolves.toEqual({
      released: false,
      removed: false,
    });
  });

  it('isolates the same revision across per-worker cache roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-mgr-worker-isolation-'));
    const workerARoot = path.join(root, 'worker-a');
    const workerBRoot = path.join(root, 'worker-b');
    const workerA = new CapabilityBundleStore(workerARoot, silentLogger, { retentionMs: 0 });
    const workerB = new CapabilityBundleStore(workerBRoot, silentLogger, { retentionMs: 0 });
    const revisionHash = sha256('shared-frozen-revision');
    const pluginJson = '{"name":"per-worker-isolation"}\n';
    const skillBody = '---\nname: isolated-skill\n---\nKeep this worker-local copy readable.\n';
    const files = [
      {
        relPath: '.claude-plugin/plugin.json',
        content: pluginJson,
        digest: sha256(pluginJson),
      },
      {
        relPath: 'skills/isolated-skill/SKILL.md',
        content: skillBody,
        digest: sha256(skillBody),
      },
      {
        relPath: 'catalog.json',
        content: '[]\n',
        digest: sha256('[]\n'),
      },
    ];

    try {
      const ensuredA = await workerA.ensure({ revisionHash, files });
      const ensuredB = await workerB.ensure({ revisionHash, files });

      expect(ensuredA.pluginPath).toBe(path.join(workerARoot, revisionHash, 'claude-plugin'));
      expect(ensuredB.pluginPath).toBe(path.join(workerBRoot, revisionHash, 'claude-plugin'));
      expect(ensuredB.pluginPath).not.toBe(ensuredA.pluginPath);
      expect(await fs.readFile(
        path.join(ensuredB.pluginPath, 'skills', 'isolated-skill', 'SKILL.md'),
        'utf8',
      )).toBe(skillBody);

      await expect(workerA.release(revisionHash)).resolves.toEqual({
        released: true,
        removed: true,
      });
      await expect(fs.stat(path.join(workerARoot, revisionHash))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      // Worker B has its own materialized bytes and ref-count namespace. A's
      // to-zero deletion cannot break B's projected Skill/read_skill input.
      await expect(fs.stat(ensuredB.pluginPath)).resolves.toBeDefined();
      expect(await fs.readFile(
        path.join(ensuredB.pluginPath, '.claude-plugin', 'plugin.json'),
        'utf8',
      )).toBe(pluginJson);
      expect(await fs.readFile(
        path.join(ensuredB.pluginPath, 'skills', 'isolated-skill', 'SKILL.md'),
        'utf8',
      )).toBe(skillBody);

      await expect(workerB.release(revisionHash)).resolves.toEqual({
        released: true,
        removed: true,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects lexical and realpath escapes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-mgr-path-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-mgr-path-outside-'));
    try {
      await expect(resolvePathInsideRoot(root, '../outside.txt')).rejects.toMatchObject({
        code: 'BUNDLE_MATERIALIZE_FAILED',
      });
      const linkPath = path.join(root, 'escape');
      await fs.symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(resolvePathInsideRoot(root, 'escape/file.txt')).rejects.toMatchObject({
        code: 'BUNDLE_MATERIALIZE_FAILED',
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
