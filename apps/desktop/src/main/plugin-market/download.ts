import { PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES } from '@cindy/plugin-protocol';
import { download, DownloadError } from '../downloader/index.js';
import { createIpcError } from '../../shared/ipc-errors.js';

export interface PluginDownloadOptions {
  /**
   * 渠道注入的下载上限。缺省时与上游一致，按「尚未识别真实包类型」的
   * 128 MiB 协议上限限流；下载后由共用安装器按真实包类型（普通沙箱包
   * 8 MiB / Node 包 128 MiB）再校验。
   */
  maxBytes?: number;
  onProgress?: (progress: { downloadedBytes: number; totalBytes: number }) => void;
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

/** Plugin policy only; transport, timeouts, byte limits and hashing are shared. */
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
  if (
    !Number.isSafeInteger(expected.sizeBytes) ||
    expected.sizeBytes <= 0 ||
    expected.sizeBytes > PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES ||
    !/^[a-f0-9]{64}$/i.test(expected.sha256)
  ) {
    throw createIpcError('GHOST_FILE_INVALID', 'Plugin Release size or SHA-256 is invalid');
  }
  if (expected.sizeBytes > channelMaxBytes) {
    throw createIpcError('GHOST_FILE_INVALID', `Plugin 包大小超限: ${expected.sizeBytes}`);
  }
  // 渠道收紧的上限先判，未识别包类型时仍按协议上限；进度只呈现，抛错不得中断安装。
  let reportedPercent = 0;
  reportProgress(options.onProgress, 0, expected.sizeBytes);
  try {
    await download({
      url,
      targetPath,
      sha256: expected.sha256,
      expectedSize: expected.sizeBytes,
      maxBytes: channelMaxBytes,
      redirect: 'error',
      resume: false,
      existingTarget: 'error',
      retry: { maxAttempts: 1 },
      timeout: { connectMs: 60_000, idleMs: 60_000, totalMs: 120_000 },
      ...(options.onProgress
        ? {
            onProgress: (event) => {
              const downloadedBytes = Math.min(event.loaded, expected.sizeBytes);
              const nextPercent = Math.floor((downloadedBytes / expected.sizeBytes) * 100);
              if (nextPercent === reportedPercent) return;
              reportedPercent = nextPercent;
              reportProgress(options.onProgress, downloadedBytes, expected.sizeBytes);
            },
          }
        : {}),
    });
    if (reportedPercent !== 100) {
      reportProgress(options.onProgress, expected.sizeBytes, expected.sizeBytes);
    }
  } catch (error) {
    if (error instanceof DownloadError) {
      if (error.code === 'EXISTS')
        throw Object.assign(new Error('Download target already exists'), { code: 'EEXIST' });
      if (error.code === 'TIMEOUT')
        throw createIpcError('GHOST_DOWNLOAD_TIMEOUT', 'Plugin download timed out');
      if (error.code === 'SIZE')
        throw createIpcError(
          'GHOST_FILE_INVALID',
          'Plugin 下载字节数或 Content-Length 与 Release 不一致，可能超过声明大小',
        );
      if (error.code === 'CHECKSUM')
        throw createIpcError('GHOST_FILE_INVALID', 'Plugin 下载 SHA-256 校验失败');
    }
    throw createIpcError('GHOST_DOWNLOAD_FAILED', 'Plugin download failed');
  }
}
