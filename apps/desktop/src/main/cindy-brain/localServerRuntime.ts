import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { extract as extractTar, list as listTar } from 'tar';

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

export interface LocalServerArtifactDescriptor {
  fileName: string;
  size: number;
  sha256: string;
  expiresAt: number;
  files?: Array<{ path: string; size: number; sha256: string }>;
}

export interface LocalServerRuntimeSource {
  instanceId: string;
  taskId: string;
  artifact: LocalServerArtifactDescriptor;
  runtimeContract?: Record<string, unknown>;
}

export interface PreparedLocalServerRuntime {
  runDir: string;
  manifest: Record<string, unknown>;
}

export interface LocalServerRuntimeDeps {
  tempRoot: () => string;
  downloadArtifact: (instanceId: string, taskId: string, relativePath?: string) => Promise<Response>;
}

function validOpaqueId(value: string): boolean {
  return /^[-A-Za-z0-9._]{1,128}$/.test(value);
}

function validSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function isUnsafeArchivePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return true;
  if (segments.at(-1) === '') segments.pop();
  return segments.some(segment => segment === '..' || segment === '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readManifest(runDir: string): Promise<Record<string, unknown>> {
  const manifestPath = path.join(runDir, '.mcp-runtime', 'runtime-manifest.json');
  const stat = await fs.stat(manifestPath);
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error('Runtime manifest is invalid');
  const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (!isRecord(parsed) || parsed.apiVersion !== 1) throw new Error('Runtime manifest is invalid');
  return parsed;
}

/** Main-only artifact preparation; paths never cross the plugin bridge. */
export class LocalServerRuntime {
  constructor(private readonly deps: LocalServerRuntimeDeps) {}

  async prepare(source: LocalServerRuntimeSource): Promise<PreparedLocalServerRuntime> {
    if (!validOpaqueId(source.instanceId) || !validOpaqueId(source.taskId)) throw new Error('Invalid local server identity');
    if (!source.artifact || !Number.isSafeInteger(source.artifact.size) || source.artifact.size < 1 ||
      source.artifact.size > MAX_ARTIFACT_BYTES || !validSha256(source.artifact.sha256)) {
      throw new Error('Build artifact metadata is invalid');
    }

    const root = path.resolve(this.deps.tempRoot());
    await fs.mkdir(root, { recursive: true });
    const runDir = await fs.mkdtemp(path.join(root, `runtime-${source.instanceId}-${source.taskId}-`));
    const archivePath = path.join(runDir, 'artifact.tar.gz');
    try {
      if (source.artifact.files?.length) {
        const indexedSize = source.artifact.files.reduce((total, file) => total + file.size, 0);
        if (indexedSize !== source.artifact.size || source.artifact.files.length > 4096) {
          throw new Error('Build artifact index is inconsistent');
        }
        for (const file of source.artifact.files) {
          if (isUnsafeArchivePath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !validSha256(file.sha256)) {
            throw new Error('Build artifact file metadata is invalid');
          }
          const target = path.resolve(runDir, ...file.path.replace(/\\/g, '/').split('/'));
          if (!target.startsWith(`${runDir}${path.sep}`)) throw new Error('Invalid build artifact path');
          await fs.mkdir(path.dirname(target), { recursive: true });
          await this.downloadFile(source.instanceId, source.taskId, file.path, file, target);
        }
        const aggregateHash = createHash('sha256')
          .update(source.artifact.files.slice().sort((a, b) => a.path.localeCompare(b.path)).map(file => `${file.path}\0${file.sha256}\0${file.size}`).join('\n'))
          .digest('hex');
        if (aggregateHash !== source.artifact.sha256.toLowerCase()) throw new Error('Build artifact index digest mismatch');
        const manifest = source.runtimeContract ?? await readManifest(runDir);
        return { runDir, manifest };
      }
      const response = await this.deps.downloadArtifact(source.instanceId, source.taskId);
      if (!response.ok || !response.body) throw new Error('Build artifact download failed');
      const output = fs.open(archivePath, 'wx', 0o600);
      const handle = await output;
      const hash = createHash('sha256');
      let bytes = 0;
      try {
        for await (const chunk of Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.byteLength;
          if (bytes > source.artifact.size || bytes > MAX_ARTIFACT_BYTES) throw new Error('Build artifact exceeds declared size');
          hash.update(data);
          await handle.write(data);
        }
      } finally {
        await handle.close();
      }
      if (bytes !== source.artifact.size || hash.digest('hex') !== source.artifact.sha256.toLowerCase()) {
        throw new Error('Build artifact digest or size mismatch');
      }

      await listTar({ file: archivePath, strict: true, onentry: entry => {
        if (isUnsafeArchivePath(entry.path) || entry.type === 'SymbolicLink' || entry.type === 'Link') {
          throw new Error('Build artifact contains an unsafe archive entry');
        }
      }});
      await extractTar({ file: archivePath, cwd: runDir, strict: true, preservePaths: false });
      const manifest = source.runtimeContract ?? await readManifest(runDir);
      await fs.rm(archivePath, { force: true });
      return { runDir, manifest };
    } catch (error) {
      await fs.rm(runDir, { recursive: true, force: true });
      throw error;
    }
  }

  async cleanup(runDir: string): Promise<void> {
    const root = path.resolve(this.deps.tempRoot());
    const resolved = path.resolve(runDir);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Invalid local runtime directory');
    await fs.rm(resolved, { recursive: true, force: true });
  }

  private async downloadFile(
    instanceId: string,
    taskId: string,
    relativePath: string,
    expected: { size: number; sha256: string },
    target: string,
  ): Promise<void> {
    const response = await this.deps.downloadArtifact(instanceId, taskId, relativePath);
    if (!response.ok || !response.body) throw new Error('Build artifact file download failed');
    const handle = await fs.open(target, 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.byteLength;
        if (bytes > expected.size || bytes > MAX_ARTIFACT_BYTES) throw new Error(`Build artifact file exceeds declared size: ${relativePath}`);
        hash.update(data);
        await handle.write(data);
      }
    } finally {
      await handle.close();
    }
    if (bytes !== expected.size || hash.digest('hex') !== expected.sha256.toLowerCase()) {
      throw new Error(`Build artifact file digest or size mismatch: ${relativePath}`);
    }
  }
}

export function localServerRuntimeTempRoot(userDataPath: string): string {
  return path.join(userDataPath, 'local-server-runtimes');
}
