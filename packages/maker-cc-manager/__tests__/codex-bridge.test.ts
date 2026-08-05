/**
 * codex-bridge 单元测试 — header 解析、env 剥离/合并、字节中继、fail-closed。
 *
 * 不 spawn 真实 codex：spawnFn 注入假 child（EventEmitter + 内存 stdio），
 * 断言 bridge 传给 spawn 的参数与双向字节流行为。
 */

import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { CODEX_BRIDGE_HEADER_KEY, runCodexBridge } from '../src/codex-bridge.js';

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function makeStderrCapture(): { stderr: Writable; text: () => string } {
  let buf = '';
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString('utf8');
      cb();
    },
  });
  return { stderr, text: () => buf };
}

function headerLine(header: unknown): string {
  return `${JSON.stringify({ [CODEX_BRIDGE_HEADER_KEY]: header })}\n`;
}

describe('runCodexBridge', () => {
  it('fails closed when CC_MGR_CODEX_BIN is missing', async () => {
    const { stderr, text } = makeStderrCapture();
    const code = await runCodexBridge({
      stdin: Readable.from([]),
      stdout: new PassThrough(),
      stderr,
      env: {},
    });
    expect(code).toBe(2);
    expect(text()).toContain('CC_MGR_CODEX_BIN');
  });

  it('rejects a stream whose first line is not the bridge header', async () => {
    const { stderr, text } = makeStderrCapture();
    const code = await runCodexBridge({
      stdin: Readable.from(['{"method":"initialize","id":1}\n']),
      stdout: new PassThrough(),
      stderr,
      env: { CC_MGR_CODEX_BIN: '/fake/codex' },
    });
    expect(code).toBe(2);
    expect(text()).toContain(CODEX_BRIDGE_HEADER_KEY);
  });

  it('rejects an invalid header version', async () => {
    const { stderr, text } = makeStderrCapture();
    const code = await runCodexBridge({
      stdin: Readable.from([headerLine({ version: 2 })]),
      stdout: new PassThrough(),
      stderr,
      env: { CC_MGR_CODEX_BIN: '/fake/codex' },
    });
    expect(code).toBe(2);
    expect(text()).toContain('version');
  });

  it('spawns app-server with header cwd/args, strips stale gateway env, merges header env', async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const { stderr } = makeStderrCapture();
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const done = runCodexBridge({
      stdin,
      stdout,
      stderr,
      env: {
        CC_MGR_CODEX_BIN: '/fake/codex',
        CODEX_HOME: '/remote/managed-codex-home',
        OPENAI_API_KEY: 'stale-host-key',
        OPENAI_BASE_URL: 'https://stale-host.example',
      },
      spawnFn,
    });

    stdin.write(headerLine({
      version: 1,
      cwd: '/remote/workspace',
      env: { XDT_CODEX_API_KEY: 'desktop-key', LIZI_MCP_TOKEN: 'tok' },
      extraArgs: ['-c', 'model_provider="tapsvc"'],
    }));

    await vi.waitFor(() => {
      expect(spawnFn).toHaveBeenCalledTimes(1);
    });
    const [bin, args, opts] = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
      string,
      string[],
      { cwd?: string; env: NodeJS.ProcessEnv },
    ];
    expect(bin).toBe('/fake/codex');
    expect(args).toEqual(['app-server', '-c', 'model_provider="tapsvc"']);
    expect(opts.cwd).toBe('/remote/workspace');
    // desktop 显式递来的生效；远端残留被剥离；mcp-router 注入的 CODEX_HOME 保留。
    expect(opts.env.XDT_CODEX_API_KEY).toBe('desktop-key');
    expect(opts.env.LIZI_MCP_TOKEN).toBe('tok');
    expect(opts.env.OPENAI_API_KEY).toBeUndefined();
    expect(opts.env.OPENAI_BASE_URL).toBeUndefined();
    expect(opts.env.CODEX_HOME).toBe('/remote/managed-codex-home');
    expect(opts.env.CC_MGR_CODEX_BIN).toBe('/fake/codex');

    child.emit('exit', 0, null);
    await expect(done).resolves.toBe(0);
  });

  it('relays bytes after the header line in both directions', async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const { stderr } = makeStderrCapture();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let stdoutBytes = Buffer.alloc(0);
    stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = Buffer.concat([stdoutBytes, chunk]);
    });
    let childStdinBytes = Buffer.alloc(0);
    child.stdin.on('data', (chunk: Buffer) => {
      childStdinBytes = Buffer.concat([childStdinBytes, chunk]);
    });

    const done = runCodexBridge({
      stdin,
      stdout,
      stderr,
      env: { CC_MGR_CODEX_BIN: '/fake/codex' },
      spawnFn,
    });

    // header 与首个协议帧在同一个 chunk 到达——剩余字节不得丢失。
    stdin.write(`${headerLine({ version: 1 })}{"method":"initialize","id":1}\n`);
    await vi.waitFor(() => {
      expect(childStdinBytes.toString('utf8')).toBe('{"method":"initialize","id":1}\n');
    });

    stdin.write('{"method":"thread/start","id":2}\n');
    child.stdout.write('{"id":1,"result":{}}\n');
    await vi.waitFor(() => {
      expect(childStdinBytes.toString('utf8')).toContain('thread/start');
      expect(stdoutBytes.toString('utf8')).toBe('{"id":1,"result":{}}\n');
    });

    child.emit('exit', 0, null);
    await expect(done).resolves.toBe(0);
  });

  it('forwards stdin EOF to the app-server instead of killing it', async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const { stderr } = makeStderrCapture();
    const stdin = new PassThrough();
    let stdinEnded = false;
    // Writable 侧的结束事件是 'finish'（'end' 是 Readable 侧事件）。
    child.stdin.on('finish', () => {
      stdinEnded = true;
    });

    const done = runCodexBridge({
      stdin,
      stdout: new PassThrough(),
      stderr,
      env: { CC_MGR_CODEX_BIN: '/fake/codex' },
      spawnFn,
    });

    stdin.end(headerLine({ version: 1 }));
    await vi.waitFor(() => {
      expect(stdinEnded).toBe(true);
    });
    expect(child.kill).not.toHaveBeenCalled();

    child.emit('exit', 0, null);
    await expect(done).resolves.toBe(0);
  });
});
