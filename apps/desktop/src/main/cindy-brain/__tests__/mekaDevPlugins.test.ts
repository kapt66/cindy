import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import type { WatcherHostEventsHandler } from '../../watcher-host/WatcherHostClient';
import {
  MekaDevPluginManager,
  mekaDevRuntimeId,
  type MekaDevPluginError,
  type MekaDevPluginManagerDeps,
} from '../mekaDevPlugins';

const manifest = (version = '1.0.0'): GhostManifest => ({
  schemaVersion: 2,
  id: 'demo-plugin',
  name: 'Meka Dev Demo',
  version,
  kind: 'chip',
  entry: 'main.js',
  command: 'demo',
  slots: ['tool'],
  tools: [{ name: 'demo', description: 'demo' }],
});

describe('MekaDevPluginManager', () => {
  let workDir: string;
  let sourceDir: string;
  let currentManifest: GhostManifest;
  let installedIds: Set<string>;
  let onEvents: WatcherHostEventsHandler | null;
  let unsubscribeWatcher: ReturnType<typeof vi.fn>;
  let deps: MekaDevPluginManagerDeps;

  beforeEach(async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-meka-dev-plugin-test-'));
    sourceDir = path.join(workDir, 'source');
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'ghost.json'), '{}');
    currentManifest = manifest();
    installedIds = new Set();
    onEvents = null;
    unsubscribeWatcher = vi.fn(async () => undefined);

    const readPackageManifest = async (cindyPath: string): Promise<GhostManifest> => {
      const zip = await JSZip.loadAsync(await fs.promises.readFile(cindyPath));
      return JSON.parse(await zip.file('ghost.json')!.async('text')) as GhostManifest;
    };
    const installedGhost = (packageManifest: GhostManifest): InstalledGhost => ({
      manifest: packageManifest,
      dir: path.join(workDir, 'installed', packageManifest.id),
      enabled: true,
    });
    deps = {
      getRegistryPath: () => path.join(workDir, 'owner', '.meka-dev-plugins.json'),
      getTempRoot: () => path.join(workDir, 'temp'),
      packDirectory: vi.fn(async (_dir, { outputDir }) => {
        await fs.promises.mkdir(outputDir, { recursive: true });
        const cindyPath = path.join(outputDir, `${currentManifest.id}.cindy`);
        const zip = new JSZip();
        zip.file('ghost.json', JSON.stringify(currentManifest));
        zip.file('main.js', '// development Plugin');
        zip.file('cindy-signatures.json', '{}');
        await fs.promises.writeFile(cindyPath, await zip.generateAsync({ type: 'nodebuffer' }));
        return { ok: true as const, cindyPath, manifest: currentManifest };
      }),
      inspectPackage: vi.fn(async (cindyPath) => ({
        manifest: await readPackageManifest(cindyPath),
        trust: {
          level: 'unverified' as const,
          publisherSigned: false,
          publisherVerified: false,
          reviewed: false,
        },
      })),
      installPackage: vi.fn(async (cindyPath) => {
        const zip = await JSZip.loadAsync(await fs.promises.readFile(cindyPath));
        expect(zip.file('cindy-signatures.json')).toBeNull();
        const packageManifest = await readPackageManifest(cindyPath);
        installedIds.add(packageManifest.id);
        return installedGhost(packageManifest);
      }),
      updatePackage: vi.fn(async (cindyPath, expectedId) => {
        const packageManifest = await readPackageManifest(cindyPath);
        expect(packageManifest.id).toBe(expectedId);
        return installedGhost(packageManifest);
      }),
      uninstallPackage: vi.fn(async (id) => {
        installedIds.delete(id);
      }),
      isInstalled: (id) => installedIds.has(id),
      subscribe: vi.fn(async (_dir, _ignore, events) => {
        onEvents = events;
        return { unsubscribe: unsubscribeWatcher };
      }),
      onContentReloaded: vi.fn(),
      onChanged: vi.fn(),
    };
  });

  afterEach(async () => {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  });

  it('登记目录、持久化 owner 级注册表，并监听变更自动更新', async () => {
    const manager = new MekaDevPluginManager(deps);
    const result = await manager.install(
      sourceDir,
      (await manager.inspect(sourceDir)).packageSha256,
    );
    const runtimeId = mekaDevRuntimeId('demo-plugin');

    expect(result.item).toMatchObject({
      runtimeId,
      pluginId: 'demo-plugin',
      sourceDir: await fs.promises.realpath(sourceDir),
      status: 'watching',
    });
    expect(result.ghost.manifest.id).toBe(runtimeId);
    expect(result.ghost.manifest.command).toMatch(/^demo-dev-/);
    expect(deps.installPackage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.promises.readFile(deps.getRegistryPath(), 'utf8'))).toEqual({
      version: 2,
      plugins: [
        {
          runtimeId,
          pluginId: 'demo-plugin',
          sourceDir: await fs.promises.realpath(sourceDir),
        },
      ],
    });
    expect(installedIds.has('demo-plugin')).toBe(false);
    expect(installedIds.has(runtimeId)).toBe(true);

    currentManifest = manifest('1.0.1');
    onEvents?.([{ type: 'update', path: path.join(sourceDir, 'main.js') }]);
    await vi.waitFor(() => expect(deps.updatePackage).toHaveBeenCalledTimes(1), {
      timeout: 2_000,
    });
    await vi.waitFor(
      async () =>
        expect(await manager.list()).toMatchObject([
          { runtimeId, pluginId: 'demo-plugin', status: 'watching' },
        ]),
      { timeout: 2_000 },
    );
    expect(deps.onContentReloaded).toHaveBeenCalledTimes(2);
  });

  it('自动更新失败时保留已安装副本，并将开发条目标记为错误', async () => {
    const manager = new MekaDevPluginManager(deps);
    await manager.install(sourceDir, (await manager.inspect(sourceDir)).packageSha256);
    vi.mocked(deps.updatePackage).mockRejectedValueOnce(new Error('broken source'));

    onEvents?.([{ type: 'update', path: path.join(sourceDir, 'main.js') }]);
    await vi.waitFor(
      async () =>
        expect(await manager.list()).toMatchObject([
          {
            runtimeId: mekaDevRuntimeId('demo-plugin'),
            pluginId: 'demo-plugin',
            status: 'error',
            error: 'broken source',
          },
        ]),
      { timeout: 2_000 },
    );
    expect(installedIds.has(mekaDevRuntimeId('demo-plugin'))).toBe(true);
    expect(deps.uninstallPackage).not.toHaveBeenCalled();
  });

  it('同 ID 正式安装与开发副本共存，开发副本不改变正式安装状态', async () => {
    installedIds.add('demo-plugin');
    const manager = new MekaDevPluginManager(deps);
    const result = await manager.install(
      sourceDir,
      (await manager.inspect(sourceDir)).packageSha256,
    );

    expect(result.item).toMatchObject({
      pluginId: 'demo-plugin',
      runtimeId: mekaDevRuntimeId('demo-plugin'),
    });
    expect(installedIds.has('demo-plugin')).toBe(true);
    expect(installedIds.has(mekaDevRuntimeId('demo-plugin'))).toBe(true);
    expect(deps.installPackage).toHaveBeenCalledTimes(1);
    expect(deps.updatePackage).not.toHaveBeenCalled();
    expect(deps.uninstallPackage).not.toHaveBeenCalled();
  });

  it('打包发布时保留源码身份，不泄漏开发运行时 ID 与 command 别名', async () => {
    const manager = new MekaDevPluginManager(deps);
    const installed = await manager.install(
      sourceDir,
      (await manager.inspect(sourceDir)).packageSha256,
    );

    const packaged = await manager.package(installed.item.runtimeId);
    const zip = await JSZip.loadAsync(packaged.bytes);
    const packagedManifest = JSON.parse(
      await zip.file('ghost.json')!.async('text'),
    ) as GhostManifest;

    expect(packagedManifest.id).toBe('demo-plugin');
    expect(packagedManifest.command).toBe('demo');
    expect(zip.file('cindy-signatures.json')).not.toBeNull();
  });

  it('将曾占用原始 ID 的 v1 开发登记迁移为独立运行时身份', async () => {
    const registryPath = deps.getRegistryPath();
    await fs.promises.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.promises.writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: 'demo-plugin', sourceDir: await fs.promises.realpath(sourceDir) }],
      }),
    );
    installedIds.add('demo-plugin');
    const manager = new MekaDevPluginManager(deps);
    await manager.list();

    await vi.waitFor(() => {
      expect(installedIds.has(mekaDevRuntimeId('demo-plugin'))).toBe(true);
      expect(installedIds.has('demo-plugin')).toBe(false);
    });
    await vi.waitFor(async () => {
      expect(JSON.parse(await fs.promises.readFile(registryPath, 'utf8'))).toEqual({
        version: 2,
        plugins: [
          {
            runtimeId: mekaDevRuntimeId('demo-plugin'),
            pluginId: 'demo-plugin',
            sourceDir: await fs.promises.realpath(sourceDir),
          },
        ],
      });
    });
  });

  it('移除登记时停止监听并卸载开发副本', async () => {
    const manager = new MekaDevPluginManager(deps);
    const installed = await manager.install(
      sourceDir,
      (await manager.inspect(sourceDir)).packageSha256,
    );
    await manager.remove(installed.item.runtimeId);

    expect(deps.uninstallPackage).toHaveBeenCalledWith(mekaDevRuntimeId('demo-plugin'));
    expect(await manager.list()).toEqual([]);
  });

  it('移除前排空进行中的自动同步，避免卸载后被重新装回', async () => {
    const manager = new MekaDevPluginManager(deps);
    const installed = await manager.install(
      sourceDir,
      (await manager.inspect(sourceDir)).packageSha256,
    );
    const originalUpdate = vi.mocked(deps.updatePackage).getMockImplementation()!;
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    vi.mocked(deps.updatePackage).mockImplementationOnce(async (...args) => {
      await updateGate;
      return originalUpdate(...args);
    });

    onEvents?.([{ type: 'update', path: path.join(sourceDir, 'main.js') }]);
    await vi.waitFor(() => expect(deps.updatePackage).toHaveBeenCalledTimes(1), {
      timeout: 2_000,
    });

    const removal = manager.remove(installed.item.runtimeId);
    await Promise.resolve();
    expect(deps.uninstallPackage).not.toHaveBeenCalled();

    releaseUpdate();
    await removal;

    expect(installedIds.has(installed.item.runtimeId)).toBe(false);
    expect(await manager.list()).toEqual([]);
  });

  it('rejects a source directory that changes after approval', async () => {
    const manager = new MekaDevPluginManager(deps);
    const inspection = await manager.inspect(sourceDir);
    currentManifest = manifest('2.0.0');

    await expect(manager.install(sourceDir, inspection.packageSha256)).rejects.toMatchObject({
      code: 'source-changed',
    } satisfies Partial<MekaDevPluginError>);
    expect(deps.installPackage).not.toHaveBeenCalled();
  });

  it('stops old-owner watchers when the host suspends the registry', async () => {
    const manager = new MekaDevPluginManager(deps);
    await manager.install(sourceDir, (await manager.inspect(sourceDir)).packageSha256);

    await manager.suspend();

    expect(unsubscribeWatcher).toHaveBeenCalledTimes(1);
    expect(deps.onChanged).toHaveBeenLastCalledWith([]);
  });
});
