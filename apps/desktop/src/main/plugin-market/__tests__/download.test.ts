import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES } from '@cindy/plugin-protocol';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ net: { fetch: fetchMock } }));

import { downloadVerifiedPlugin } from '../download';

const files: string[] = [];

afterEach(() => {
  fetchMock.mockReset();
  vi.useRealTimers();
  for (const file of files.splice(0)) fs.rmSync(file, { force: true, recursive: true });
});
function target(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-plugin-download-'));
  files.push(dir);
  return path.join(dir, 'package.cindy');
}

function expected(bytes: Buffer) {
  return {
    sizeBytes: bytes.byteLength,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

describe('downloadVerifiedPlugin', () => {
  it('accepts a package above the former 8 MiB market limit', async () => {
    const bytes = Buffer.alloc(9 * 1024 * 1024, 7);
    fetchMock.mockResolvedValue(new Response(bytes));
    const file = target();
    await downloadVerifiedPlugin('https://downloads.example.test/a', expected(bytes), file);
    // 不对数百万个字节逐项执行断言，仍核验完整大小和 SHA-256。
    expect(expected(fs.readFileSync(file))).toEqual(expected(bytes));
  });

  it('rejects over 128 MiB before starting a download', async () => {
    await expect(
      downloadVerifiedPlugin(
        'https://downloads.example.test/a',
        {
          sizeBytes: PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES + 1,
          sha256: '0'.repeat(64),
        },
        target(),
      ),
    ).rejects.toMatchObject({ code: 'GHOST_FILE_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows the exact archive limit to reach the download boundary', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      downloadVerifiedPlugin(
        'https://downloads.example.test/a',
        {
          sizeBytes: PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES,
          sha256: '0'.repeat(64),
        },
        target(),
      ),
    ).rejects.toMatchObject({ code: 'GHOST_DOWNLOAD_FAILED' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([0, -1, NaN, 1.5])('rejects invalid release size %s', async (sizeBytes) => {
    await expect(
      downloadVerifiedPlugin(
        'https://downloads.example.test/a',
        {
          sizeBytes,
          sha256: '0'.repeat(64),
        },
        target(),
      ),
    ).rejects.toMatchObject({ code: 'GHOST_FILE_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not overwrite or remove an existing target', async () => {
    const bytes = Buffer.from('new');
    const file = target();
    fs.writeFileSync(file, 'existing');
    fetchMock.mockResolvedValue(new Response(bytes));
    await expect(
      downloadVerifiedPlugin('https://downloads.example.test/a', expected(bytes), file),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.readFileSync(file, 'utf8')).toBe('existing');
  });

  it('removes a truncated download', async () => {
    const file = target();
    fetchMock.mockResolvedValue(new Response(Buffer.from('short')));
    await expect(
      downloadVerifiedPlugin(
        'https://downloads.example.test/a',
        expected(Buffer.from('longer')),
        file,
      ),
    ).rejects.toMatchObject({ code: 'GHOST_FILE_INVALID' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('sanitizes native network errors including signed URLs', async () => {
    fetchMock.mockRejectedValue(new Error('net::ERR_FAILED https://private.test/?secret=signed'));
    const file = target();
    await expect(
      downloadVerifiedPlugin('https://downloads.example.test/a', expected(Buffer.from('a')), file),
    ).rejects.toMatchObject({
      code: 'GHOST_DOWNLOAD_FAILED',
      message: expect.not.stringContaining('signed'),
    });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('times out while waiting for headers', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const file = target();
    const result = expect(
      downloadVerifiedPlugin('https://downloads.example.test/a', expected(Buffer.from('a')), file),
    ).rejects.toMatchObject({ code: 'GHOST_DOWNLOAD_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
    expect(fs.existsSync(file)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes a partial download when the response stalls', async () => {
    vi.useFakeTimers();
    let pulls = 0;
    fetchMock.mockImplementation((_url, { signal }) =>
      Promise.resolve(
        new Response(
          new ReadableStream(
            {
              start(controller) {
                signal.addEventListener('abort', () => controller.error(new Error('aborted')), {
                  once: true,
                });
              },
              pull(controller) {
                if (++pulls === 1) controller.enqueue(Buffer.from('a'));
              },
            },
            { highWaterMark: 0 },
          ),
        ),
      ),
    );
    const file = target();
    const result = expect(
      downloadVerifiedPlugin('https://downloads.example.test/a', expected(Buffer.from('ab')), file),
    ).rejects.toMatchObject({ code: 'GHOST_DOWNLOAD_TIMEOUT' });
    await vi.waitFor(() => expect(pulls).toBe(2));
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
    expect(fs.existsSync(file)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues beyond 60 seconds while receiving chunks and hashes them in order', async () => {
    vi.useFakeTimers();
    let pulls = 0;
    fetchMock.mockImplementation((_url, { signal }) =>
      Promise.resolve(
        new Response(
          new ReadableStream(
            {
              start(controller) {
                signal.addEventListener('abort', () => controller.error(new Error('aborted')), {
                  once: true,
                });
              },
              pull(controller) {
                const chunk = ++pulls;
                return new Promise<void>((resolve) =>
                  setTimeout(() => {
                    controller.enqueue(Buffer.from(String(chunk)));
                    if (chunk === 3) controller.close();
                    resolve();
                  }, 30_000),
                );
              },
            },
            { highWaterMark: 0 },
          ),
        ),
      ),
    );
    const file = target();
    const result = downloadVerifiedPlugin(
      'https://downloads.example.test/a',
      expected(Buffer.from('123')),
      file,
    );
    for (let i = 1; i <= 3; i++) {
      await vi.waitFor(() => expect(pulls).toBe(i));
      await vi.advanceTimersByTimeAsync(30_000);
    }
    await result;
    expect(fs.readFileSync(file, 'utf8')).toBe('123');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts at 120 seconds even when download progress keeps resetting the idle timer', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let abortedAt = 0;
    let pulls = 0;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    fetchMock.mockImplementation((_url, { signal }) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              start(controller) {
                streamController = controller;
                signal.addEventListener(
                  'abort',
                  () => {
                    abortedAt = Date.now();
                    controller.error(new Error('aborted'));
                  },
                  { once: true },
                );
              },
              pull() {
                pulls++;
              },
            },
            { highWaterMark: 0 },
          ),
        ),
      ),
    );
    const file = target();
    const result = expect(
      downloadVerifiedPlugin(
        'https://downloads.example.test/a',
        expected(Buffer.from('1234')),
        file,
      ),
    ).rejects.toMatchObject({ code: 'GHOST_DOWNLOAD_TIMEOUT' });
    for (let i = 1; i <= 3; i++) {
      await vi.waitFor(() => expect(pulls).toBe(i));
      await vi.advanceTimersByTimeAsync(30_000);
      streamController.enqueue(Buffer.from(String(i)));
    }
    await vi.waitFor(() => expect(pulls).toBe(4));
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(abortedAt - startedAt).toBe(120_000);
    expect(fs.existsSync(file)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('writes only bytes matching the release size and SHA-256', async () => {
    const bytes = Buffer.from('verified plugin bytes');
    fetchMock.mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      }),
    );
    const file = target();

    await downloadVerifiedPlugin('https://downloads.example.test/a', expected(bytes), file);

    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://downloads.example.test/a',
      expect.objectContaining({
        redirect: 'error',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('reports bounded byte progress without letting observer failures abort the download', async () => {
    const bytes = Buffer.from('verified plugin bytes');
    fetchMock.mockResolvedValue(new Response(bytes, { status: 200 }));
    const progress = vi.fn().mockImplementationOnce(() => {
      throw new Error('renderer closed');
    });
    const file = target();

    await downloadVerifiedPlugin(
      'https://downloads.example.test/a',
      expected(bytes),
      file,
      { onProgress: progress },
    );

    expect(progress).toHaveBeenNthCalledWith(1, {
      downloadedBytes: 0,
      totalBytes: bytes.byteLength,
    });
    expect(progress).toHaveBeenLastCalledWith({
      downloadedBytes: bytes.byteLength,
      totalBytes: bytes.byteLength,
    });
    expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it('rejects a SHA mismatch without writing the target', async () => {
    const bytes = Buffer.from('tampered');
    fetchMock.mockResolvedValue(new Response(bytes, { status: 200 }));
    const file = target();

    await expect(
      downloadVerifiedPlugin(
        'https://downloads.example.test/a',
        {
          ...expected(bytes),
          sha256: '0'.repeat(64),
        },
        file,
      ),
    ).rejects.toThrow('SHA-256');
    expect(fs.existsSync(file)).toBe(false);
  });

  // 共享下载器的缺省上限已随上游从 8 MiB 提到 128 MiB（见上面的
  // `accepts a package above the former 8 MiB market limit`）。渠道自己的收紧上限
  // 不是靠缺省表达的，而是由渠道显式注入 `maxBytes` —— 普通 Meka 插件的 8 MiB 口径在
  // `mekaDownloadPolicy.ts` 与其单测里锁定，这里只验证注入本身仍然生效。
  it('streams a package above 8 MiB when a trusted channel supplies a larger ceiling', async () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
    fetchMock.mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      }),
    );
    const file = target();

    await downloadVerifiedPlugin(
      'https://downloads.example.test/a',
      expected(bytes),
      file,
      { maxBytes: 9 * 1024 * 1024 },
    );

    expect(fs.statSync(file).size).toBe(bytes.byteLength);
    expect(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'))
      .toBe(expected(bytes).sha256);
  });

  it('stops when the stream exceeds the declared release size', async () => {
    const bytes = Buffer.from('larger-than-declared');
    fetchMock.mockResolvedValue(new Response(bytes, { status: 200 }));
    const file = target();

    await expect(
      downloadVerifiedPlugin(
        'https://downloads.example.test/a',
        { sizeBytes: 3, sha256: '0'.repeat(64) },
        file,
      ),
    ).rejects.toThrow('超过');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('cancels the response body when Content-Length mismatches the release', async () => {
    const bytes = Buffer.from('mismatched length');
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength + 1) },
    });
    const cancel = vi.spyOn(response.body!, 'cancel');
    fetchMock.mockResolvedValue(response);

    await expect(
      downloadVerifiedPlugin('https://downloads.example.test/a', expected(bytes), target()),
    ).rejects.toThrow('Content-Length');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not delete or replace a pre-existing target', async () => {
    const bytes = Buffer.from('verified plugin bytes');
    fetchMock.mockResolvedValue(new Response(bytes, { status: 200 }));
    const file = target();
    fs.writeFileSync(file, 'existing');

    await expect(
      downloadVerifiedPlugin(
        'https://downloads.example.test/a',
        expected(bytes),
        file,
      ),
    ).rejects.toThrow();

    expect(fs.readFileSync(file, 'utf8')).toBe('existing');
  });
});
