import { describe, expect, it, vi } from 'vitest';

import type { CcManagerByteStream } from '../cc-manager-client';
import { createMcprCodexTransport } from '../codex-remote-transport';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

interface FakeStream extends CcManagerByteStream {
  written: string[];
  ended: boolean;
  emitBytes(chunk: Buffer): void;
  emitClose(): void;
}

function fakeStream(): FakeStream {
  const byteHandlers = new Set<(chunk: Buffer) => void>();
  const closeHandlers = new Set<
    (info: { code: number | null; signal: string | null }) => void
  >();
  const errorHandlers = new Set<(error: Error) => void>();
  const stream: FakeStream = {
    written: [],
    ended: false,
    write(data) {
      stream.written.push(String(data));
    },
    end(data) {
      if (data !== undefined) stream.written.push(String(data));
      stream.ended = true;
    },
    kill() {},
    onStdoutBytes(handler) {
      byteHandlers.add(handler);
      return () => byteHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    onError(handler) {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    emitBytes(chunk) {
      for (const handler of byteHandlers) handler(chunk);
    },
    emitClose() {
      for (const handler of closeHandlers) handler({ code: 1000, signal: null });
    },
  };
  return stream;
}

describe('createMcprCodexTransport', () => {
  it('writes the spawn header first and drains queued NDJSON writes', async () => {
    const stream = fakeStream();
    const transport = createMcprCodexTransport({
      instanceId: 'instance-1',
      buildHeader: async () => ({
        version: 1,
        cwd: '/workspace/project',
        env: { XDT_CODEX_API_KEY: 'secret' },
      }),
      logger,
      openStream: async () => stream,
    });

    const pending = transport.writeLine('{"id":1,"method":"initialize"}');
    await vi.waitFor(() => expect(stream.written).toHaveLength(2));
    await pending;

    expect(JSON.parse(stream.written[0]!)).toEqual({
      $codexBridge: {
        version: 1,
        cwd: '/workspace/project',
        env: { XDT_CODEX_API_KEY: 'secret' },
      },
    });
    expect(stream.written[1]).toBe('{"id":1,"method":"initialize"}\n');
  });

  it('preserves UTF-8 characters split across arbitrary byte chunks', async () => {
    const stream = fakeStream();
    const transport = createMcprCodexTransport({
      instanceId: 'instance-1',
      buildHeader: async () => ({ version: 1 }),
      logger,
      openStream: async () => stream,
    });
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));
    await vi.waitFor(() => expect(stream.written).toHaveLength(1));

    const line = JSON.stringify({ id: 1, result: { content: '远程技能内容' } });
    const bytes = Buffer.from(`${line}\n`, 'utf8');
    for (let index = 0; index < bytes.length; index += 1) {
      stream.emitBytes(bytes.subarray(index, index + 1));
    }
    expect(lines).toEqual([line]);
  });

  it('fails closed before opening the tunnel when header construction fails', async () => {
    const openStream = vi.fn(async () => fakeStream());
    const transport = createMcprCodexTransport({
      instanceId: 'instance-1',
      buildHeader: async () => {
        throw new Error('[REMOTE_CODEX_GATEWAY_KEY_REQUIRED] no key');
      },
      logger,
      openStream,
    });
    const reasons: string[] = [];
    transport.onClose((info) => reasons.push(info.reason));

    await vi.waitFor(() => expect(reasons).toHaveLength(1));
    expect(reasons[0]).toContain('GATEWAY_KEY_REQUIRED');
    expect(openStream).not.toHaveBeenCalled();
    await expect(transport.writeLine('{}')).rejects.toThrow('after close');
  });

  it('ends the byte stream and rejects later writes after close', async () => {
    const stream = fakeStream();
    const transport = createMcprCodexTransport({
      instanceId: 'instance-1',
      buildHeader: async () => ({ version: 1 }),
      logger,
      openStream: async () => stream,
    });
    await vi.waitFor(() => expect(stream.written).toHaveLength(1));
    await transport.close();
    expect(stream.ended).toBe(true);
    await expect(transport.writeLine('{}')).rejects.toThrow('after close');
  });
});
