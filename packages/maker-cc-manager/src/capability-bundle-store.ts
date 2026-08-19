import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type {
  BundleEnsureParams,
  BundleEnsureResult,
  BundleFile,
  BundleReleaseResult,
} from './protocol.js';
import type { ManagerLogger } from './server.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
export const DEFAULT_BUNDLE_RETENTION_MS = 24 * 60 * 60 * 1_000;

const noopLogger: ManagerLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Structured fail-closed error returned for invalid or failed materialization. */
export class BundleMaterializeError extends Error {
  readonly code = 'BUNDLE_MATERIALIZE_FAILED' as const;

  constructor(message: string, readonly data?: Record<string, unknown>) {
    super(message);
    this.name = 'BundleMaterializeError';
  }
}
export interface CapabilityBundleStoreOptions {
  /** Time a zero-reference revision remains reusable before sweep removes it. */
  retentionMs?: number;
  /** Injectable wall clock for deterministic retention tests. */
  now?: () => number;
}

/** True when child is parent itself or is lexically nested below it. */
function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Resolve the deepest existing ancestor so not-yet-created write targets remain checkable. */
async function realpathNearestExisting(inputPath: string): Promise<string> {
  let current = inputPath;
  for (;;) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new BundleMaterializeError('bundle path has no accessible ancestor');
      }
      current = parent;
    }
  }
}

/**
 * Resolve a path beneath an existing root with lexical and realpath containment.
 * This mirrors the snapshot path guard: a symlinked existing ancestor may not
 * redirect a future write outside the root.
 */
export async function resolvePathInsideRoot(root: string, inputPath: string): Promise<string> {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new BundleMaterializeError('bundle cache root is empty');
  }
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new BundleMaterializeError('bundle relative path is empty');
  }

  const rootAbs = path.resolve(root);
  const targetAbs = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootAbs, inputPath);
  if (!isInside(rootAbs, targetAbs)) {
    throw new BundleMaterializeError('bundle path escapes the capability cache root');
  }

  let rootReal: string;
  try {
    rootReal = await fs.realpath(rootAbs);
  } catch {
    throw new BundleMaterializeError('bundle cache root does not exist or is inaccessible');
  }
  const ancestorReal = await realpathNearestExisting(targetAbs);
  if (!isInside(rootReal, ancestorReal)) {
    throw new BundleMaterializeError('bundle path escapes the capability cache through a symlink');
  }
  return targetAbs;
}

/** Validate a caller-supplied plugin-relative path before touching the filesystem. */
function validateRelPath(relPath: unknown): asserts relPath is string {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.includes('\0')) {
    throw new BundleMaterializeError('bundle file relPath must be a non-empty string');
  }
  // The projection contract uses POSIX paths on every platform. Rejecting a
  // backslash avoids it becoming a separator only after reaching Windows.
  if (relPath.includes('\\') || path.posix.isAbsolute(relPath)) {
    throw new BundleMaterializeError('bundle file relPath must be a relative POSIX path');
  }
  const segments = relPath.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new BundleMaterializeError('bundle file relPath contains an unsafe path segment');
  }
}

/** Validate all immutable bundle bytes before creating a staging directory. */
function validateFiles(files: unknown): asserts files is BundleFile[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new BundleMaterializeError('bundle files must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const file of files) {
    if (typeof file !== 'object' || file === null) {
      throw new BundleMaterializeError('bundle file must be an object');
    }
    const candidate = file as Partial<BundleFile>;
    validateRelPath(candidate.relPath);
    if (seen.has(candidate.relPath)) {
      throw new BundleMaterializeError('bundle contains duplicate relPath', { relPath: candidate.relPath });
    }
    seen.add(candidate.relPath);
    const hasText = typeof candidate.content === 'string';
    const hasBase64 = typeof candidate.contentBase64 === 'string';
    if (hasText === hasBase64 || !SHA256_RE.test(candidate.digest ?? '')) {
      throw new BundleMaterializeError('bundle file content or digest is invalid', {
        relPath: candidate.relPath,
      });
    }
    const content = hasText
      ? Buffer.from(candidate.content!, 'utf8')
      : Buffer.from(candidate.contentBase64!, 'base64');
    if (hasBase64 && content.toString('base64') !== candidate.contentBase64) {
      throw new BundleMaterializeError('bundle file base64 payload is not canonical', {
        relPath: candidate.relPath,
      });
    }
    const actualDigest = createHash('sha256').update(content).digest('hex');
    if (actualDigest !== candidate.digest) {
      throw new BundleMaterializeError('bundle file digest mismatch', {
        relPath: candidate.relPath,
      });
    }
  }
}

/** Return true only for a real directory; missing and non-directory paths are false. */
async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

/** Return true only for a real file; missing and non-file paths are false. */
async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Daemon-local immutable capability bundle cache with in-process reference counts.
 * Operations are serialized so concurrent ensure/release calls cannot race the
 * filesystem rename against a to-zero removal.
 */
export class CapabilityBundleStore {
  readonly cacheRoot: string;
  private readonly logger: ManagerLogger;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly refCounts = new Map<string, number>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    cacheRoot: string,
    logger: ManagerLogger = noopLogger,
    options: CapabilityBundleStoreOptions = {},
  ) {
    this.cacheRoot = path.resolve(cacheRoot);
    this.logger = logger;
    this.retentionMs = options.retentionMs ?? DEFAULT_BUNDLE_RETENTION_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.retentionMs) || this.retentionMs < 0) {
      throw new Error('capability bundle retentionMs must be a non-negative finite number');
    }
  }

  /** Validate, atomically materialize/deduplicate, and retain one revision. */
  async ensure(params: BundleEnsureParams): Promise<BundleEnsureResult> {
    return await this.runExclusive(async () => await this.ensureExclusive(params));
  }

  /** Release one revision reference and best-effort delete it at zero. */
  async release(revisionHash: string): Promise<BundleReleaseResult> {
    return await this.runExclusive(async () => await this.releaseExclusive(revisionHash));
  }

  /** Remove zero-reference revisions whose persisted retention timestamp expired. */
  async sweepExpired(): Promise<string[]> {
    return await this.runExclusive(async () => await this.sweepExpiredExclusive());
  }

  /** Resolve a complete retained bundle root for daemon-side capability hosting. */
  async resolveExistingBundleRoot(revisionHash: string): Promise<string> {
    return await this.runExclusive(async () => {
      if (!SHA256_RE.test(revisionHash)) {
        throw new BundleMaterializeError('bundle revisionHash must be a SHA-256 hex digest');
      }
      await fs.mkdir(this.cacheRoot, { recursive: true });
      const revisionDirectory = await resolvePathInsideRoot(this.cacheRoot, revisionHash);
      const pluginPath = await resolvePathInsideRoot(
        this.cacheRoot,
        path.join(revisionHash, 'claude-plugin'),
      );
      if (!(await this.isCompleteExistingRevision(revisionDirectory, pluginPath))) {
        throw new BundleMaterializeError('capability bundle revision is missing or incomplete');
      }
      return pluginPath;
    });
  }

  /** Serialize operations while preserving each caller's typed result. */
  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let unlock!: () => void;
    this.operationQueue = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
    }
  }

  /** Materialize one bundle while holding the store operation lock. */
  private async ensureExclusive(params: BundleEnsureParams): Promise<BundleEnsureResult> {
    try {
      if (!SHA256_RE.test(params.revisionHash)) {
        throw new BundleMaterializeError('bundle revisionHash must be a SHA-256 hex digest');
      }
      if (params.catalogDigest !== undefined && !SHA256_RE.test(params.catalogDigest)) {
        throw new BundleMaterializeError('bundle catalogDigest must be a SHA-256 hex digest');
      }
      validateFiles(params.files);

      await fs.mkdir(this.cacheRoot, { recursive: true });
      const revisionDirectory = await resolvePathInsideRoot(this.cacheRoot, params.revisionHash);
      const pluginPath = await resolvePathInsideRoot(
        this.cacheRoot,
        path.join(params.revisionHash, 'claude-plugin'),
      );

      if (await this.isCompleteExistingRevision(revisionDirectory, pluginPath)) {
        const refCount = this.incrementRefCount(params.revisionHash);
        this.logger.debug('capability bundle cache hit', { revisionHash: params.revisionHash, refCount });
        return { pluginPath };
      }

      const stagingDirectory = await fs.mkdtemp(
        path.join(this.cacheRoot, `.staging-${params.revisionHash}-`),
      );
      const stagingPluginPath = path.join(stagingDirectory, 'claude-plugin');
      try {
        await fs.mkdir(stagingPluginPath, { recursive: true });
        for (const file of params.files) {
          const targetPath = await resolvePathInsideRoot(stagingPluginPath, file.relPath);
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          const content =
            file.content !== undefined
              ? Buffer.from(file.content, 'utf8')
              : Buffer.from(file.contentBase64!, 'base64');
          await fs.writeFile(targetPath, content);
        }

        try {
          await fs.rename(stagingDirectory, revisionDirectory);
        } catch (error) {
          // Another serialized process cannot race us, but a second daemon may
          // share the same cache root. Reuse only a complete winning target.
          if (await this.isCompleteExistingRevision(revisionDirectory, pluginPath)) {
            // complete target won the race; fall through to the ref-count below
          } else {
            // 不完整/陈旧目标挡路（0.0.4 时代 projection-only 缓存、或上次
            // 物化中途崩溃的残目）。rename 不能覆盖非空目录（Windows EPERM /
            // POSIX ENOTEMPTY）——缓存条目可弃,删掉重试一次。
            await fs.rm(revisionDirectory, { recursive: true, force: true });
            try {
              await fs.rename(stagingDirectory, revisionDirectory);
            } catch {
              throw error;
            }
          }
        }
      } finally {
        await fs.rm(stagingDirectory, { recursive: true, force: true });
      }

      if (!(await this.isCompleteExistingRevision(revisionDirectory, pluginPath))) {
        throw new BundleMaterializeError('materialized bundle is incomplete');
      }
      const refCount = this.incrementRefCount(params.revisionHash);
      this.logger.info('capability bundle materialized', { revisionHash: params.revisionHash, refCount });
      return { pluginPath };
    } catch (error) {
      const materializeError = error instanceof BundleMaterializeError
        ? error
        : new BundleMaterializeError((error as Error)?.message ?? 'bundle materialization failed');
      this.logger.warn('capability bundle materialization failed', {
        revisionHash: params?.revisionHash,
        error: materializeError.message,
      });
      throw materializeError;
    }
  }

  /** Release one bundle while holding the store operation lock. */
  private async releaseExclusive(revisionHash: string): Promise<BundleReleaseResult> {
    if (!SHA256_RE.test(revisionHash)) {
      throw new BundleMaterializeError('bundle revisionHash must be a SHA-256 hex digest');
    }
    const current = this.refCounts.get(revisionHash) ?? 0;
    if (current === 0) return { released: false, removed: false };

    const remaining = current - 1;
    if (remaining > 0) {
      this.refCounts.set(revisionHash, remaining);
      this.logger.debug('capability bundle released', { revisionHash, refCount: remaining });
      return { released: true, removed: false };
    }

    this.refCounts.delete(revisionHash);
    try {
      await fs.mkdir(this.cacheRoot, { recursive: true });
      const revisionDirectory = await resolvePathInsideRoot(this.cacheRoot, revisionHash);
      const releasedAt = this.now();
      const releasedAtDate = new Date(releasedAt);
      await fs.utimes(revisionDirectory, releasedAtDate, releasedAtDate);
      this.logger.info('capability bundle retained at zero references', {
        revisionHash,
        refCount: 0,
        retentionMs: this.retentionMs,
      });
      const removed = await this.sweepExpiredExclusive(releasedAt);
      return { released: true, removed: removed.includes(revisionHash) };
    } catch (error) {
      this.logger.warn('capability bundle retention update failed', {
        revisionHash,
        error: (error as Error)?.message ?? String(error),
      });
      return { released: true, removed: false };
    }
  }

  /** Sweep while holding the store operation lock. Directory mtime is the persisted zero-time. */
  private async sweepExpiredExclusive(now = this.now()): Promise<string[]> {
    await fs.mkdir(this.cacheRoot, { recursive: true });
    const removed: string[] = [];
    const entries = await fs.readdir(this.cacheRoot, { withFileTypes: true });
    for (const entry of entries) {
      const revisionHash = entry.name;
      if (!entry.isDirectory() || !SHA256_RE.test(revisionHash)) continue;
      if ((this.refCounts.get(revisionHash) ?? 0) > 0) continue;

      try {
        const revisionDirectory = await resolvePathInsideRoot(this.cacheRoot, revisionHash);
        const stat = await fs.stat(revisionDirectory);
        if (now - stat.mtimeMs < this.retentionMs) continue;
        await fs.rm(revisionDirectory, { recursive: true, force: true });
        removed.push(revisionHash);
        this.logger.info('expired capability bundle removed', {
          revisionHash,
          retentionMs: this.retentionMs,
        });
      } catch (error) {
        this.logger.warn('expired capability bundle removal failed', {
          revisionHash,
          error: (error as Error)?.message ?? String(error),
        });
      }
    }
    return removed;
  }

  /** Confirm an existing revision is a contained directory with a plugin directory. */
  private async isCompleteExistingRevision(
    revisionDirectory: string,
    pluginPath: string,
  ): Promise<boolean> {
    if (!(await isDirectory(revisionDirectory))) return false;
    // Re-run the realpath containment check after discovering the path. This
    // rejects a pre-existing revision symlink that redirects outside cacheRoot.
    await resolvePathInsideRoot(this.cacheRoot, pluginPath);
    if (!(await isDirectory(pluginPath))) return false;
    // Phase 4 union invariant: bundle/ensure 自 0.0.5 起要求文件集同时覆盖
    // Claude projection 与 Codex catalog（catalog.json 在 bundle root）。
    // 0.0.4 时代物化的 projection-only 缓存不再视为完整——判 miss 走重新物化,
    // 否则 Codex 的 registerRevisionFromBundle 会读不到 catalog.json 而 ENOENT。
    // 安全前提: hello 的 bundle pin 保证只有同版本 desktop 能对话本 daemon,
    // 而 0.0.5 desktop 总是发送 union 文件集。
    return await isFile(path.join(pluginPath, 'catalog.json'));
  }

  /** Increment and return the retained reference count for a revision. */
  private incrementRefCount(revisionHash: string): number {
    const next = (this.refCounts.get(revisionHash) ?? 0) + 1;
    this.refCounts.set(revisionHash, next);
    return next;
  }
}
