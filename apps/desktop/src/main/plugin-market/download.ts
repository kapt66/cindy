import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import { net } from 'electron';

const MAX_PLUGIN_BYTES = 8 * 1024 * 1024;

export interface PluginDownloadOptions {
  /**
   * Channel-specific compressed package ceiling. Callers may only raise this
   * after validating the release manifest against the host runtime contract.
   */
  maxBytes?: number;
  /**
   * Best-effort observer for renderer status. Observer failures must never
   * change the verified download result.
   */
  onProgress?: (progress: { downloadedBytes: number; totalBytes: number }) => void;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      null,
    );
    if (bytesWritten <= 0) throw new Error('Plugin 下载临时文件写入失败');
    offset += bytesWritten;
  }
}

function reportProgress(
  observer: PluginDownloadOptions['onProgress'],
  downloadedBytes: number,
  totalBytes: number,
): void {
  try {
    observer?.({ downloadedBytes, totalBytes });
  } catch {
    // Progress is presentation-only; renderer teardown must not cancel install.
  }
}

/** 下载并校验 `.cindy` 原始字节，写入调用方提供的临时路径。 */
export async function downloadVerifiedPlugin(
  url: string,
  expected: { sizeBytes: number; sha256: string },
  targetPath: string,
  options: PluginDownloadOptions = {},
): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_PLUGIN_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`Plugin 下载上限无效: ${maxBytes}`);
  }
  if (expected.sizeBytes <= 0 || expected.sizeBytes > maxBytes) {
    throw new Error(`Plugin 包大小超限: ${expected.sizeBytes}`);
  }
  const response = await net.fetch(url, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Plugin 下载失败 (${response.status})`);
  if (!response.body) throw new Error('Plugin 下载响应体为空');
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) !== expected.sizeBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new Error('Plugin 下载 Content-Length 与 Release 不一致');
  }

  const reader = response.body.getReader();
  let handle: FileHandle | null = null;
  let createdTarget = false;
  let verified = false;
  let size = 0;
  let reportedPercent = -1;
  const hash = crypto.createHash('sha256');
  try {
    handle = await fs.promises.open(targetPath, 'wx', 0o600);
    createdTarget = true;
    reportProgress(options.onProgress, 0, expected.sizeBytes);
    reportedPercent = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expected.sizeBytes || size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Plugin 下载字节数超过 Release 声明');
      }
      hash.update(value);
      await writeAll(handle, value);
      const nextPercent = Math.floor((size / expected.sizeBytes) * 100);
      if (nextPercent !== reportedPercent) {
        reportProgress(options.onProgress, size, expected.sizeBytes);
        reportedPercent = nextPercent;
      }
    }
    if (size !== expected.sizeBytes) throw new Error('Plugin 下载字节数与 Release 不一致');
    if (hash.digest('hex') !== expected.sha256) {
      throw new Error('Plugin 下载 SHA-256 校验失败');
    }
    await handle.close();
    handle = null;
    if (reportedPercent !== 100) {
      reportProgress(options.onProgress, size, expected.sizeBytes);
    }
    verified = true;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    if (createdTarget && !verified) {
      await fs.promises.rm(targetPath, { force: true }).catch(() => undefined);
    }
  }
}
