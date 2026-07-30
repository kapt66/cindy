import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ net: { fetch: fetchMock } }));

import { downloadVerifiedPlugin } from '../download';

const files: string[] = [];

afterEach(() => {
  fetchMock.mockReset();
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
});
function target(): string {
  const file = path.join(
    os.tmpdir(),
    `cindy-plugin-download-${process.pid}-${Date.now()}-${Math.random()}.cindy`,
  );
  files.push(file);
  return file;
}

function expected(bytes: Buffer) {
  return {
    sizeBytes: bytes.byteLength,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

describe('downloadVerifiedPlugin', () => {
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
      expect.objectContaining({ redirect: 'error', cache: 'no-store' }),
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
      downloadVerifiedPlugin('https://downloads.example.test/a', {
        ...expected(bytes),
        sha256: '0'.repeat(64),
      }, file),
    ).rejects.toThrow('SHA-256');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps the default 8 MiB ceiling before starting a download', async () => {
    const file = target();

    await expect(
      downloadVerifiedPlugin(
        'https://downloads.example.test/a',
        {
          sizeBytes: 8 * 1024 * 1024 + 1,
          sha256: '0'.repeat(64),
        },
        file,
      ),
    ).rejects.toThrow('包大小超限');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });

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
      downloadVerifiedPlugin(
        'https://downloads.example.test/a',
        expected(bytes),
        target(),
      ),
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
