/**
 * Meka development Plugin registry.
 *
 * The selected source directory stays the source of truth. Each accepted change
 * is packed into a temporary .cindy file and then handed to the normal atomic
 * Ghost install/update path, so development mode does not create a second
 * runtime or weaken the package validator.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';

import type { MekaDevPluginInspection, MekaDevPluginItem } from '../../shared/mekaDevPlugin.js';
import {
  validateGhostManifest,
  type GhostManifest,
  type GhostTrustInfo,
  type InstalledGhost,
} from '../../shared/ghost.js';
import type { ForgePackResult } from './forge.js';
import { GHOST_SIGNATURE_FILE } from './ghostSignature.js';
import type {
  WatcherHostEventsHandler,
  WatcherHostErrorHandler,
  WatcherHostSubscription,
} from '../watcher-host/WatcherHostClient.js';

const REGISTRY_VERSION = 2;
const SYNC_DEBOUNCE_MS = 350;

interface StoredDevPlugin {
  runtimeId: string;
  pluginId: string;
  sourceDir: string;
  /** v1 开发副本曾直接占用原始 ID；迁移成功后清除此字段。 */
  legacyRuntimeId?: string;
}

interface StoredRegistry {
  version: 2;
  plugins: StoredDevPlugin[];
}

interface LiveDevPlugin extends StoredDevPlugin {
  status: MekaDevPluginItem['status'];
  error?: string;
  updatedAt?: number;
}

/** 32 字符 Ghost ID 内保留可读原 ID 与稳定摘要；正式插件 ID 永远不被占用。 */
export function mekaDevRuntimeId(pluginId: string): string {
  const prefix = 'meka-dev-';
  const digest = crypto.createHash('sha256').update(pluginId).digest('hex').slice(0, 8);
  const readableLength = 32 - prefix.length - digest.length - 1;
  return `${prefix}${pluginId.slice(0, readableLength)}-${digest}`;
}

function mekaDevCommand(command: string, runtimeId: string): string {
  const suffix = `-dev-${runtimeId.slice(-6)}`;
  return `${command.slice(0, 32 - suffix.length)}${suffix}`;
}

export type MekaDevPluginSubscribe = (
  dir: string,
  ignore: string[],
  onEvents: WatcherHostEventsHandler,
  onError: WatcherHostErrorHandler,
) => Promise<WatcherHostSubscription>;

export interface MekaDevPluginManagerDeps {
  getRegistryPath: () => string;
  getTempRoot: () => string;
  packDirectory: (sourceDir: string, options: { outputDir: string }) => Promise<ForgePackResult>;
  inspectPackage: (cindyPath: string) => Promise<{
    manifest: InstalledGhost['manifest'];
    trust: GhostTrustInfo;
  }>;
  installPackage: (cindyPath: string) => Promise<InstalledGhost>;
  updatePackage: (cindyPath: string, expectedId: string) => Promise<InstalledGhost>;
  uninstallPackage: (id: string) => Promise<void>;
  isInstalled: (id: string) => boolean;
  subscribe: MekaDevPluginSubscribe;
  onContentReloaded: (id: string) => void;
  onChanged?: (items: MekaDevPluginItem[]) => void;
  log?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

export class MekaDevPluginError extends Error {
  constructor(
    readonly code:
      | 'invalid-directory'
      | 'invalid-plugin'
      | 'source-changed'
      | 'already-installed'
      | 'source-conflict'
      | 'not-found'
      | 'internal',
    message: string,
  ) {
    super(message);
    this.name = 'MekaDevPluginError';
  }
}

export class MekaDevPluginManager {
  private registryPath: string | null = null;
  private records = new Map<string, LiveDevPlugin>();
  private subscriptions = new Map<string, WatcherHostSubscription>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private syncChains = new Map<string, Promise<void>>();
  private namespaceChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: MekaDevPluginManagerDeps) {}

  async list(): Promise<MekaDevPluginItem[]> {
    await this.ensureNamespace();
    return this.snapshot();
  }

  async inspect(sourceDir: string): Promise<MekaDevPluginInspection> {
    const realSourceDir = await this.resolveSourceDir(sourceDir);
    return this.withPackedDirectory(realSourceDir, async (packed) => {
      const inspected = await this.deps.inspectPackage(packed.cindyPath);
      return {
        sourceDir: realSourceDir,
        manifest: inspected.manifest,
        trust: inspected.trust,
        packageSha256: await this.fingerprintPackageContents(packed.cindyPath),
      };
    });
  }

  async install(
    sourceDir: string,
    expectedPackageSha256: string,
  ): Promise<{ ghost: InstalledGhost; item: MekaDevPluginItem }> {
    await this.ensureNamespace();
    const realSourceDir = await this.resolveSourceDir(sourceDir);
    return this.withPackedDirectory(realSourceDir, async (packed) => {
      const inspected = await this.deps.inspectPackage(packed.cindyPath);
      const packageSha256 = await this.fingerprintPackageContents(packed.cindyPath);
      if (packageSha256 !== expectedPackageSha256) {
        throw new MekaDevPluginError(
          'source-changed',
          '开发目录在确认后发生了变化，请重新选择并确认',
        );
      }
      const pluginId = inspected.manifest.id;
      const runtimeId = mekaDevRuntimeId(pluginId);
      const existingRecord = [...this.records.values()].find(
        (record) => record.pluginId === pluginId,
      );
      if (existingRecord && existingRecord.sourceDir !== realSourceDir) {
        throw new MekaDevPluginError('source-conflict', `插件 ${pluginId} 已绑定到另一个开发目录`);
      }
      if (!existingRecord && this.deps.isInstalled(runtimeId)) {
        throw new MekaDevPluginError(
          'already-installed',
          `开发运行时 ID ${runtimeId} 已被其它插件占用`,
        );
      }

      const developmentPackage = await this.createDevelopmentPackage(
        packed,
        runtimeId,
        path.dirname(packed.cindyPath),
      );
      const ghost =
        existingRecord && this.deps.isInstalled(runtimeId)
          ? await this.deps.updatePackage(developmentPackage.cindyPath, runtimeId)
          : await this.deps.installPackage(developmentPackage.cindyPath);
      const record: LiveDevPlugin = {
        runtimeId,
        pluginId,
        sourceDir: realSourceDir,
        status: 'watching',
        updatedAt: Date.now(),
        ...(existingRecord?.legacyRuntimeId
          ? { legacyRuntimeId: existingRecord.legacyRuntimeId }
          : {}),
      };
      this.records.set(runtimeId, record);
      await this.persistRegistry();
      if (record.legacyRuntimeId) {
        try {
          await this.deps.uninstallPackage(record.legacyRuntimeId);
          delete record.legacyRuntimeId;
          await this.persistRegistry();
        } catch (error) {
          this.deps.log?.warn('legacy Meka development Plugin cleanup deferred', {
            runtimeId,
            legacyRuntimeId: record.legacyRuntimeId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await this.watch(record);
      this.deps.onContentReloaded(runtimeId);
      this.emitChanged();
      this.deps.log?.info('Meka development Plugin installed', {
        runtimeId,
        pluginId,
        sourceDir: realSourceDir,
      });
      return { ghost, item: this.toItem(record) };
    });
  }

  async remove(runtimeId: string): Promise<void> {
    await this.ensureNamespace();
    const record = this.records.get(runtimeId);
    if (!record) {
      throw new MekaDevPluginError('not-found', `开发插件 ${runtimeId} 未登记`);
    }
    await this.stopWatching(runtimeId);
    try {
      await this.deps.uninstallPackage(runtimeId);
    } catch (error) {
      await this.watch(record).catch(() => undefined);
      throw error;
    }
    this.records.delete(runtimeId);
    await this.persistRegistry();
    this.emitChanged();
    this.deps.log?.info('Meka development Plugin removed', {
      runtimeId,
      pluginId: record.pluginId,
    });
  }

  /**
   * Build a distributable package from the original source identity.
   *
   * Development runtime IDs and command aliases are host-only derivations and
   * must never leak into a package saved locally or published to MCPRouter.
   */
  async package(runtimeId: string): Promise<{
    bytes: Buffer;
    manifest: GhostManifest;
  }> {
    await this.ensureNamespace();
    const record = this.records.get(runtimeId);
    if (!record) {
      throw new MekaDevPluginError('not-found', `开发插件 ${runtimeId} 未登记`);
    }
    return this.withPackedDirectory(record.sourceDir, async (packed) => {
      if (packed.manifest.id !== record.pluginId) {
        throw new MekaDevPluginError(
          'invalid-plugin',
          `开发目录的插件 ID 已从 ${record.pluginId} 改为 ${packed.manifest.id}；请移除后重新登记`,
        );
      }
      return {
        bytes: await fs.promises.readFile(packed.cindyPath),
        manifest: packed.manifest,
      };
    });
  }

  private async ensureNamespace(): Promise<void> {
    const nextPath = path.resolve(this.deps.getRegistryPath());
    this.namespaceChain = this.namespaceChain
      .catch(() => undefined)
      .then(async () => {
        if (this.registryPath === nextPath) return;
        await this.stopAllWatchers();
        this.registryPath = nextPath;
        this.records = await this.readRegistry(nextPath);
        for (const record of this.records.values()) {
          await this.watch(record).catch((error) => {
            this.markError(record.runtimeId, error);
          });
          this.scheduleSync(record.runtimeId, 0);
        }
        this.emitChanged();
      });
    return this.namespaceChain;
  }

  private async readRegistry(registryPath: string): Promise<Map<string, LiveDevPlugin>> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.promises.readFile(registryPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      this.deps.log?.warn('Meka development Plugin registry unreadable', {
        registryPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return new Map();
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { plugins?: unknown }).plugins)) {
      this.deps.log?.warn('Meka development Plugin registry ignored: invalid shape', {
        registryPath,
      });
      return new Map();
    }
    const version = (raw as { version?: unknown }).version;
    if (version !== 1 && version !== REGISTRY_VERSION) {
      this.deps.log?.warn('Meka development Plugin registry ignored: unsupported version', {
        registryPath,
        version,
      });
      return new Map();
    }
    const records = new Map<string, LiveDevPlugin>();
    for (const value of (raw as { plugins: unknown[] }).plugins) {
      if (!value || typeof value !== 'object') continue;
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.sourceDir !== 'string' || !path.isAbsolute(candidate.sourceDir)) {
        continue;
      }
      if (version === 1) {
        if (typeof candidate.id !== 'string') continue;
        const runtimeId = mekaDevRuntimeId(candidate.id);
        records.set(runtimeId, {
          runtimeId,
          pluginId: candidate.id,
          sourceDir: path.resolve(candidate.sourceDir),
          legacyRuntimeId: candidate.id,
          status: 'watching',
        });
        continue;
      }
      if (
        typeof candidate.runtimeId !== 'string' ||
        typeof candidate.pluginId !== 'string' ||
        candidate.runtimeId !== mekaDevRuntimeId(candidate.pluginId)
      ) {
        continue;
      }
      records.set(candidate.runtimeId, {
        runtimeId: candidate.runtimeId,
        pluginId: candidate.pluginId,
        sourceDir: path.resolve(candidate.sourceDir),
        ...(typeof candidate.legacyRuntimeId === 'string'
          ? { legacyRuntimeId: candidate.legacyRuntimeId }
          : {}),
        status: 'watching',
      });
    }
    return records;
  }

  private async persistRegistry(): Promise<void> {
    if (!this.registryPath) return;
    const registry: StoredRegistry = {
      version: REGISTRY_VERSION,
      plugins: [...this.records.values()]
        .map(({ runtimeId, pluginId, sourceDir, legacyRuntimeId }) => ({
          runtimeId,
          pluginId,
          sourceDir,
          ...(legacyRuntimeId ? { legacyRuntimeId } : {}),
        }))
        .sort((a, b) => a.runtimeId.localeCompare(b.runtimeId)),
    };
    await fs.promises.mkdir(path.dirname(this.registryPath), { recursive: true });
    const tempPath = `${this.registryPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.promises.writeFile(tempPath, `${JSON.stringify(registry, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await fs.promises.rename(tempPath, this.registryPath);
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async resolveSourceDir(sourceDir: string): Promise<string> {
    if (typeof sourceDir !== 'string' || !path.isAbsolute(sourceDir)) {
      throw new MekaDevPluginError('invalid-directory', '请选择插件目录');
    }
    let realSourceDir: string;
    try {
      realSourceDir = await fs.promises.realpath(path.resolve(sourceDir));
      const stat = await fs.promises.stat(realSourceDir);
      if (!stat.isDirectory()) throw new Error('not a directory');
    } catch (error) {
      throw new MekaDevPluginError(
        'invalid-directory',
        `插件目录不可用：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (realSourceDir === path.parse(realSourceDir).root) {
      throw new MekaDevPluginError('invalid-directory', '不能把磁盘根目录登记为开发插件');
    }
    return realSourceDir;
  }

  private async withPackedDirectory<T>(
    sourceDir: string,
    consume: (packed: Extract<ForgePackResult, { ok: true }>) => Promise<T>,
  ): Promise<T> {
    await fs.promises.mkdir(this.deps.getTempRoot(), { recursive: true });
    const tempDir = await fs.promises.mkdtemp(
      path.join(this.deps.getTempRoot(), 'meka-dev-plugin-'),
    );
    try {
      const packed = await this.deps.packDirectory(sourceDir, { outputDir: tempDir });
      if (!packed.ok) {
        throw new MekaDevPluginError('invalid-plugin', packed.message);
      }
      return await consume(packed);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async createDevelopmentPackage(
    packed: Extract<ForgePackResult, { ok: true }>,
    runtimeId: string,
    outputDir: string,
  ): Promise<Extract<ForgePackResult, { ok: true }>> {
    const developmentManifest: GhostManifest = {
      ...packed.manifest,
      id: runtimeId,
      ...(packed.manifest.command
        ? { command: mekaDevCommand(packed.manifest.command, runtimeId) }
        : {}),
    };
    const validated = validateGhostManifest(developmentManifest);
    if (!validated.ok) {
      throw new MekaDevPluginError('invalid-plugin', `无法生成独立开发身份：${validated.reason}`);
    }
    try {
      const zip = await JSZip.loadAsync(await fs.promises.readFile(packed.cindyPath));
      zip.file('ghost.json', `${JSON.stringify(validated.manifest, null, 2)}\n`);
      // Host 派生 runtime id / command 后，源码包签名不再对应实际字节。
      // 源码快照已在改写前通过 GhostManager.inspect；派生包必须移除失效签名，
      // 再由安装入口按未签名开发快照重新做完整包校验，不能携带一份必然失真的信任声明。
      zip.remove(GHOST_SIGNATURE_FILE);
      const cindyPath = path.join(
        outputDir,
        `${validated.manifest.id}-${validated.manifest.version}.cindy`,
      );
      await fs.promises.writeFile(
        cindyPath,
        await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
      );
      return {
        ok: true,
        cindyPath,
        manifest: validated.manifest,
      };
    } catch (error) {
      throw new MekaDevPluginError(
        'invalid-plugin',
        `生成开发插件包失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * JSZip writes per-entry timestamps, so hashing the generated archive bytes
   * would reject an unchanged directory after a second pack. Bind approval to
   * the sorted entry names and exact entry bytes instead.
   */
  private async fingerprintPackageContents(cindyPath: string): Promise<string> {
    const zip = await JSZip.loadAsync(await fs.promises.readFile(cindyPath));
    const entries = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .sort((a, b) => a.name.localeCompare(b.name));
    const fingerprint = await Promise.all(
      entries.map(async (entry) => [
        entry.name,
        crypto
          .createHash('sha256')
          .update(await entry.async('nodebuffer'))
          .digest('hex'),
      ]),
    );
    return crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
  }

  private async watch(record: LiveDevPlugin): Promise<void> {
    const current = this.subscriptions.get(record.runtimeId);
    if (current) return;
    const ignore = [
      path.join(record.sourceDir, '.git'),
      path.join(record.sourceDir, 'node_modules'),
    ];
    const subscription = await this.deps.subscribe(
      record.sourceDir,
      ignore,
      (events) => {
        if (
          events.some(
            (event) =>
              !event.path.toLowerCase().endsWith('.cindy') &&
              !event.path.toLowerCase().endsWith('.tmp'),
          )
        ) {
          this.scheduleSync(record.runtimeId);
        }
      },
      (message) => {
        this.markError(record.runtimeId, new Error(message));
      },
    );
    if (!this.records.has(record.runtimeId)) {
      await subscription.unsubscribe().catch(() => undefined);
      return;
    }
    this.subscriptions.set(record.runtimeId, subscription);
  }

  private scheduleSync(id: string, delay = SYNC_DEBOUNCE_MS): void {
    const previous = this.debounceTimers.get(id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(id);
      const previousChain = this.syncChains.get(id) ?? Promise.resolve();
      const chain = previousChain
        .then(() => this.sync(id))
        .catch((error) => this.markError(id, error))
        .finally(() => {
          if (this.syncChains.get(id) === chain) this.syncChains.delete(id);
        });
      this.syncChains.set(id, chain);
    }, delay);
    timer.unref?.();
    this.debounceTimers.set(id, timer);
  }

  private async sync(runtimeId: string): Promise<void> {
    const record = this.records.get(runtimeId);
    if (!record) return;
    record.status = 'syncing';
    delete record.error;
    this.emitChanged();
    await this.withPackedDirectory(record.sourceDir, async (packed) => {
      if (packed.manifest.id !== record.pluginId) {
        throw new MekaDevPluginError(
          'source-conflict',
          `开发目录的插件 ID 已从 ${record.pluginId} 改为 ${packed.manifest.id}；请移除后重新登记`,
        );
      }
      const developmentPackage = await this.createDevelopmentPackage(
        packed,
        runtimeId,
        path.dirname(packed.cindyPath),
      );
      if (this.deps.isInstalled(runtimeId)) {
        await this.deps.updatePackage(developmentPackage.cindyPath, runtimeId);
      } else {
        await this.deps.installPackage(developmentPackage.cindyPath);
      }
      if (record.legacyRuntimeId) {
        await this.deps.uninstallPackage(record.legacyRuntimeId);
        delete record.legacyRuntimeId;
        await this.persistRegistry();
      }
    });
    record.status = 'watching';
    record.updatedAt = Date.now();
    delete record.error;
    this.deps.onContentReloaded(runtimeId);
    this.emitChanged();
  }

  private markError(id: string, error: unknown): void {
    const record = this.records.get(id);
    if (!record) return;
    record.status = 'error';
    record.error = error instanceof Error ? error.message : String(error);
    this.emitChanged();
    this.deps.log?.warn('Meka development Plugin sync failed', {
      runtimeId: id,
      pluginId: record.pluginId,
      sourceDir: record.sourceDir,
      error: record.error,
    });
  }

  private async stopWatching(id: string): Promise<void> {
    const timer = this.debounceTimers.get(id);
    if (timer) clearTimeout(timer);
    this.debounceTimers.delete(id);
    const subscription = this.subscriptions.get(id);
    this.subscriptions.delete(id);
    await subscription?.unsubscribe().catch(() => undefined);
    // unsubscribe() may flush one final watcher callback. Clear any debounce it
    // scheduled, then drain the already-running/queued sync chain before the
    // caller uninstalls the runtime. This makes removal the final mutation and
    // prevents an in-flight sync from reinstalling an orphaned development copy.
    const trailingTimer = this.debounceTimers.get(id);
    if (trailingTimer) clearTimeout(trailingTimer);
    this.debounceTimers.delete(id);
    await this.syncChains.get(id);
  }

  private async stopAllWatchers(): Promise<void> {
    await Promise.all([...this.records.keys()].map((id) => this.stopWatching(id)));
    await Promise.allSettled(this.syncChains.values());
    this.syncChains.clear();
  }

  private snapshot(): MekaDevPluginItem[] {
    return [...this.records.values()]
      .map((record) => this.toItem(record))
      .sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
  }

  private toItem(record: LiveDevPlugin): MekaDevPluginItem {
    return {
      runtimeId: record.runtimeId,
      pluginId: record.pluginId,
      sourceDir: record.sourceDir,
      status: record.status,
      ...(record.error ? { error: record.error } : {}),
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    };
  }

  private emitChanged(): void {
    this.deps.onChanged?.(this.snapshot());
  }

  /**
   * Stop every old-owner watcher before the application commits a new data
   * owner. The next list/install call reloads the new owner's registry.
   */
  async suspend(): Promise<void> {
    this.namespaceChain = this.namespaceChain
      .catch(() => undefined)
      .then(async () => {
        await this.stopAllWatchers();
        this.registryPath = null;
        this.records.clear();
        this.emitChanged();
      });
    await this.namespaceChain;
  }
}
