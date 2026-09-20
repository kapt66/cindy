import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import { GHOST_MANIFEST_FILE, validateGhostManifest } from '../../../shared/ghost';
import type { WatcherHostEventsHandler } from '../../watcher-host/WatcherHostClient';
import { GHOST_SIGNATURE_FILE } from '../ghostSignature';
import {
  MekaDevPluginManager,
  mekaDevRuntimeId,
  packMekaDevPluginSource,
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
      approval: { state: 'legacy-unapproved' },
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
        const buf = await zip.generateAsync({ type: 'nodebuffer' });
        await fs.promises.writeFile(cindyPath, buf);
        return { ok: true as const, cindyPath, manifest: currentManifest, buf };
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

  it('按源码 pluginId 提供开发 runtime ID 解析', async () => {
    const manager = new MekaDevPluginManager(deps);
    const runtimeId = mekaDevRuntimeId('demo-plugin');
    expect(manager.runtimeIdFor('demo-plugin')).toBeNull();
    await manager.install(sourceDir, (await manager.inspect(sourceDir)).packageSha256);
    expect(manager.runtimeIdFor('demo-plugin')).toBe(runtimeId);
    expect(manager.runtimeIdFor('missing-plugin')).toBeNull();
  });

  it('用户选择的开发目录无需活动任务 workdir 即可打包，并继续拒绝 Host 受管根', async () => {
    await fs.promises.writeFile(path.join(sourceDir, 'ghost.json'), JSON.stringify(manifest()));
    await fs.promises.writeFile(path.join(sourceDir, 'main.js'), '// development Plugin');
    const outputDir = path.join(workDir, 'packed');

    await expect(
      packMekaDevPluginSource(sourceDir, { outputDir, forbiddenRootDirs: [] }),
    ).resolves.toMatchObject({
      ok: true,
      manifest: { id: 'demo-plugin' },
    });
    await expect(
      fs.promises.stat(path.join(outputDir, 'demo-plugin-1.0.0.cindy')),
    ).resolves.toBeTruthy();

    await expect(
      packMekaDevPluginSource(sourceDir, {
        outputDir,
        forbiddenRootDirs: [sourceDir],
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'SOURCE_IS_INSTALLED_PLUGIN',
    });
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

  it('启动恢复时先同步已登记源码，不继续使用上次安装的旧快照', async () => {
    const registryPath = deps.getRegistryPath();
    const runtimeId = mekaDevRuntimeId('demo-plugin');
    await fs.promises.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.promises.writeFile(
      registryPath,
      JSON.stringify({
        version: 2,
        plugins: [
          { runtimeId, pluginId: 'demo-plugin', sourceDir: await fs.promises.realpath(sourceDir) },
        ],
      }),
    );
    installedIds.add(runtimeId);
    currentManifest = manifest('1.0.1');
    const manager = new MekaDevPluginManager(deps);

    await expect(manager.syncRegistered()).resolves.toMatchObject([
      { runtimeId, pluginId: 'demo-plugin', status: 'watching' },
    ]);

    expect(deps.updatePackage).toHaveBeenCalledTimes(1);
    expect(deps.onContentReloaded).toHaveBeenCalledWith(runtimeId);
    expect(deps.subscribe).toHaveBeenCalledTimes(1);
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

    // `list()` 只完成命名空间装载;真正的迁移(装新 runtimeId → 卸 legacy → 落盘 v2)在
    // 同步链里跑,由 `scheduleSync(…, 0)` 的 debounce 触发。**不能用 `vi.waitFor` 等它**:
    // waitFor 默认只等 1000ms,而这条链要做 zip 打包 + 真实文件 IO,CI 负载机器上会超
    // (2026-09-20 实测 flake)。`syncRegistered()` 会先取消 pending 的 debounce 再 await
    // 同一条同步链,是确定性的完成信号,不依赖时序。
    await manager.syncRegistered();

    expect(installedIds.has(mekaDevRuntimeId('demo-plugin'))).toBe(true);
    expect(installedIds.has('demo-plugin')).toBe(false);
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

  it('真实打包派生开发身份后仍是合法作者清单，且只改身份字段', async () => {
    // 回归:派生包曾被写入 **归一化** 清单(v2 的 slots 已被投影成运行时能力字段),
    // 于是 `validateGhostManifest` 按作者清单拒绝它,从目录加载直接报
    // 「无法生成独立开发身份:schemaVersion 2 的 slots 必须是数组」。
    const sourceManifestRaw = {
      ...manifest(),
      slots: ['tool', 'panel', 'notify'],
      panel: { html: 'panel.html' },
    };
    await fs.promises.writeFile(
      path.join(sourceDir, GHOST_MANIFEST_FILE),
      `${JSON.stringify(sourceManifestRaw, null, 2)}\n`,
    );
    await fs.promises.writeFile(path.join(sourceDir, 'main.js'), '// development Plugin');
    await fs.promises.writeFile(path.join(sourceDir, 'panel.html'), '<!doctype html>');

    const derived: Buffer[] = [];
    const realDeps: MekaDevPluginManagerDeps = {
      ...deps,
      packDirectory: (dir, { outputDir }) =>
        packMekaDevPluginSource(dir, { outputDir, forbiddenRootDirs: [] }),
      // 装包入口(inspectDevelopmentPackage → GhostManager.inspect)对 zip 里的
      // ghost.json 跑的正是 validateGhostManifest,这里用同一道门,不放水。
      inspectPackage: async (cindyPath) => {
        const zip = await JSZip.loadAsync(await fs.promises.readFile(cindyPath));
        const parsed = validateGhostManifest(
          JSON.parse(await zip.file(GHOST_MANIFEST_FILE)!.async('text')),
        );
        if (!parsed.ok) throw new Error(`派生包作者清单非法:${parsed.reason}`);
        return {
          manifest: parsed.manifest,
          trust: {
            level: 'unverified' as const,
            publisherSigned: false,
            publisherVerified: false,
            reviewed: false,
          },
        };
      },
      installPackage: vi.fn(async (cindyPath): Promise<InstalledGhost> => {
        derived.push(await fs.promises.readFile(cindyPath));
        const zip = await JSZip.loadAsync(await fs.promises.readFile(cindyPath));
        const parsed = validateGhostManifest(
          JSON.parse(await zip.file(GHOST_MANIFEST_FILE)!.async('text')),
        );
        if (!parsed.ok) throw new Error(`派生包作者清单非法:${parsed.reason}`);
        installedIds.add(parsed.manifest.id);
        return {
          manifest: parsed.manifest,
          dir: path.join(workDir, 'installed', parsed.manifest.id),
          enabled: true,
          approval: { state: 'legacy-unapproved' },
        };
      }),
    };
    const manager = new MekaDevPluginManager(realDeps);
    const runtimeId = mekaDevRuntimeId('demo-plugin');
    await manager.install(sourceDir, (await manager.inspect(sourceDir)).packageSha256);

    expect(installedIds.has(runtimeId)).toBe(true);
    const zip = await JSZip.loadAsync(derived[0]!);
    const written = JSON.parse(await zip.file(GHOST_MANIFEST_FILE)!.async('text')) as Record<
      string,
      unknown
    >;
    // 只改身份:作者声明的卡槽与能力详单原样保留,不因归一化往返而缩水。
    expect(written).toEqual({
      ...sourceManifestRaw,
      id: runtimeId,
      command: expect.stringMatching(/^demo-dev-[0-9a-f]{6}$/),
    });
    expect(zip.file(GHOST_SIGNATURE_FILE)).toBeNull();
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
