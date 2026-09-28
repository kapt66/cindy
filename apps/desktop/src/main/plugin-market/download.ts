import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import { net } from 'electron';
import { PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES } from '@cindy/plugin-protocol';

import { createIpcError } from '../../shared/ipc-errors.js';

const PLUGIN_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const PLUGIN_DOWNLOAD_TOTAL_TIMEOUT_MS = 120_000;

export interface PluginDownloadOptions {
  /**
   * 渠道注入的下载上限。缺省时与上游一致，按「尚未识别真实包类型」的
   * 128 MiB 协议上限限流；下载后由共用安装器按真实包类型（普通沙箱包
   * 8 MiB / Node 包 128 MiB）再校验。
   */
  maxBytes?: number;
  onProgress?: (progress: { downloadedBytes: number; totalBytes: number }) => void;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset, null);
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
  const channelMaxBytes = options.maxBytes ?? PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES;
  if (!Number.isSafeInteger(channelMaxBytes) || channelMaxBytes <= 0) {
    throw new Error(`Plugin 下载上限无效: ${channelMaxBytes}`);
  }
  if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes <= 0) {
    throw createIpcError('GHOST_FILE_INVALID', 'Plugin Release size is invalid');
  }
  if (expected.sizeBytes > PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES) {
    throw createIpcError('GHOST_FILE_INVALID', 'Plugin archive exceeds 128 MiB');
  }
  if (expected.sizeBytes > channelMaxBytes) {
    throw createIpcError('GHOST_FILE_INVALID', `Plugin 包大小超限: ${expected.sizeBytes}`);
  }
  const controller = new AbortController();
  const totalTimer = setTimeout(() => controller.abort(), PLUGIN_DOWNLOAD_TOTAL_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), PLUGIN_DOWNLOAD_IDLE_TIMEOUT_MS);
  };
  const network = async <T>(operation: Promise<T>): Promise<T> => {
    try {
      return await operation;
    } catch {
      throw createIpcError(
        controller.signal.aborted ? 'GHOST_DOWNLOAD_TIMEOUT' : 'GHOST_DOWNLOAD_FAILED',
        controller.signal.aborted ? 'Plugin download timed out' : 'Plugin download failed',
      );
    }
  };
  resetIdleTimer();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let file: fs.promises.FileHandle | undefined;
  let complete = false;
  try {
    const response = await network(
      net.fetch(url, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      }),
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw createIpcError('GHOST_DOWNLOAD_FAILED', `Plugin download HTTP ${response.status}`);
    }
    if (!response.body)
      throw createIpcError('GHOST_DOWNLOAD_FAILED', 'Plugin response body is empty');
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) !== expected.sizeBytes) {
      await response.body.cancel().catch(() => undefined);
      throw createIpcError('GHOST_FILE_INVALID', 'Plugin 下载 Content-Length 与 Release 不一致');
    }

    reader = response.body.getReader();
    resetIdleTimer();
    file = await fs.promises.open(targetPath, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let size = 0;
    reportProgress(options.onProgress, 0, expected.sizeBytes);
    let reportedPercent = 0;
    while (true) {
      if (controller.signal.aborted)
        throw createIpcError('GHOST_DOWNLOAD_TIMEOUT', 'Plugin download timed out');
      const { done, value } = await network(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > expected.sizeBytes || size > channelMaxBytes) {
        throw createIpcError('GHOST_FILE_INVALID', 'Plugin 下载字节数超过 Release 声明');
      }
      if (value.byteLength > 0) {
        resetIdleTimer();
        hash.update(value);
        await writeAll(file, value);
        const nextPercent = Math.floor((size / expected.sizeBytes) * 100);
        if (nextPercent !== reportedPercent) {
          reportProgress(options.onProgress, size, expected.sizeBytes);
          reportedPercent = nextPercent;
        }
      }
    }
    if (controller.signal.aborted)
      throw createIpcError('GHOST_DOWNLOAD_TIMEOUT', 'Plugin download timed out');
    if (size !== expected.sizeBytes)
      throw createIpcError('GHOST_FILE_INVALID', 'Plugin 下载字节数与 Release 不一致');
    if (hash.digest('hex') !== expected.sha256)
      throw createIpcError('GHOST_FILE_INVALID', 'Plugin 下载 SHA-256 校验失败');
    await file.close();
    complete = true;
    if (reportedPercent !== 100) reportProgress(options.onProgress, size, expected.sizeBytes);
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(timer);
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    if (file && !complete) {
      await file.close().catch(() => undefined);
      await fs.promises.rm(targetPath, { force: true });
    }
  }
}
