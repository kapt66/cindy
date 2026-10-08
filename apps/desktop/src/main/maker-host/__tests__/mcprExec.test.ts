/**
 * MCPRouter 隧道上的两种新 mode 的**客户端 wire** 回归（2026-10-09 冻结形状）：
 *
 *   - `mode=exec`：单连接单次执行，语义等价 SSH 的 `remoteHost.exec`
 *     （`{stdout, stderr, exitCode}`）。Pi 与 Claude 的远端 file ops 与 pi 二进制探针都走它。
 *   - `mode=pi`：`buildMcprTunnelUrl` 只声明 mode，不再带 cc-mgr 的 `bundleVersion`
 *     （pi 不消费 cc-mgr 产物；声明它会让服务端白做一次 bundle 物化）。
 *
 * 冻结的帧形状（与 MCPRouter 侧逐字对齐）：
 *   请求首行 `{"version":1,"cmd":"bash","args":["-c","<script>"],"cwd"?,"env"?,"stdinBase64"?,"timeoutMs"?}`
 *   流帧 `{"stream":"stdout"|"stderr","dataBase64":"..."}`
 *   末行 `{"exitCode":n|null,"signal":string|null,"durationMs":n}`
 *   错误 `{"error":{"code":"…","message":"…"}}`
 *
 * 这些断言是**跨仓契约的客户端一侧**：形状变了就必须两边一起改，所以逐字钉住。
 */

import type { ExecStreamHandle } from '@cindy/maker-remote-ssh';
import { describe, expect, it, vi } from 'vitest';

import { buildMcprTunnelUrl, mcprExec } from '../mcpr-tunnel';

/** 最小假通道：记录写入、可按测试需要注入 stdout / close / error。 */
function fakeStream() {
  const writes: string[] = [];
  const stdoutListeners = new Set<(chunk: Buffer) => void>();
  const closeListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  let killed = false;
  const handle: ExecStreamHandle = {
    write(data) {
      writes.push(typeof data === 'string' ? data : data.toString('utf8'));
      return true;
    },
    end() { /* no-op */ },
    kill() { killed = true; },
    onStdout() { return () => undefined; },
    onStdoutBytes(cb) { stdoutListeners.add(cb); return () => stdoutListeners.delete(cb); },
    onStderr() { return () => undefined; },
    onDrain() { return () => undefined; },
    onClose(cb) { closeListeners.add(cb); return () => closeListeners.delete(cb); },
    onError(cb) { errorListeners.add(cb); return () => errorListeners.delete(cb); },
  };
  return {
    handle,
    writes,
    get killed() { return killed; },
    lines(): string[] { return writes.join('').split('\n').filter((line) => line.trim().length > 0); },
    /** 等请求行写出（= 客户端已注册好 stdout 监听，此前的 emit 会丢帧）。 */
    async ready(): Promise<void> {
      await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0));
    },
    emit(line: string) { for (const cb of [...stdoutListeners]) cb(Buffer.from(line, 'utf8')); },
    emitRaw(chunk: Buffer) { for (const cb of [...stdoutListeners]) cb(chunk); },
    emitClose(info: { code: number | null; signal: string | null } = { code: 0, signal: null }) {
      for (const cb of [...closeListeners]) cb(info);
    },
    emitError(error: Error) { for (const cb of [...errorListeners]) cb(error); },
  };
}

/** 写出驱动：单条请求(测试里 injectable 的 openStream 只被调用一次)。 */
function singleStream() {
  const stream = fakeStream();
  const openStream = vi.fn(async () => stream.handle);
  return { stream, openStream };
}

describe('buildMcprTunnelUrl 的 mode 声明', () => {
  it('pi / exec 只声明 mode（不带 cc-mgr bundleVersion）', () => {
    expect(buildMcprTunnelUrl('https://router.example', 'inst 1', 'pi')).toBe(
      'wss://router.example/api/project-agent-instances/inst%201/agent-tunnel?mode=pi',
    );
    expect(buildMcprTunnelUrl('https://router.example', 'inst 1', 'exec')).toBe(
      'wss://router.example/api/project-agent-instances/inst%201/agent-tunnel?mode=exec',
    );
  });

  it('cc-mgr / codex-appserver 仍带 bundleVersion（既有行为不变）', () => {
    expect(buildMcprTunnelUrl('https://router.example', 'i', 'cc-mgr')).not.toContain('mode=');
    expect(buildMcprTunnelUrl('https://router.example', 'i', 'cc-mgr')).toContain('bundleVersion=');
    expect(buildMcprTunnelUrl('https://router.example', 'i', 'codex-appserver')).toContain('mode=codex-appserver');
    expect(buildMcprTunnelUrl('https://router.example', 'i', 'codex-appserver')).toContain('bundleVersion=');
  });
});

describe('mcprExec（mode=exec 客户端）', () => {
  it('首行是冻结形状的请求（cmd/args/stdinBase64/timeoutMs，内容不进 argv）', async () => {
    const { stream, openStream } = singleStream();
    const pending = mcprExec('mcpr:i1', {
      cmd: 'bash',
      args: ['-c', 'cat > /tmp/f'],
      stdin: 'SECRET-CONTENT',
      timeoutMs: 5_000,
    }, { openStream });
    await stream.ready();
    const request = JSON.parse(stream.lines()[0]) as Record<string, unknown>;
    expect(request).toMatchObject({
      version: 1,
      cmd: 'bash',
      args: ['-c', 'cat > /tmp/f'],
      timeoutMs: 5_000,
    });
    expect(Buffer.from(String(request.stdinBase64), 'base64').toString('utf8')).toBe('SECRET-CONTENT');
    // 内容只在 stdinBase64 里，请求行本身不含明文（防 ps / 日志泄漏）。
    expect(stream.writes[0]).not.toContain('SECRET-CONTENT');
    stream.emit(`${JSON.stringify({ exitCode: 0, signal: null, durationMs: 3 })}\n`);
    await expect(pending).resolves.toMatchObject({ stdout: '', stderr: '', exitCode: 0, durationMs: 3 });
  });

  it('流帧按 stdout / stderr 分流，末帧给 exitCode / signal', async () => {
    const { stream, openStream } = singleStream();
    const pending = mcprExec('mcpr:i1', { cmd: 'bash', args: ['-c', 'x'] }, { openStream });
    await stream.ready();
    stream.emit(`${JSON.stringify({ stream: 'stdout', dataBase64: Buffer.from('out-1').toString('base64') })}\n`);
    stream.emit(`${JSON.stringify({ stream: 'stderr', dataBase64: Buffer.from('err-1').toString('base64') })}\n`);
    stream.emit(`${JSON.stringify({ stream: 'stdout', dataBase64: Buffer.from('out-2').toString('base64') })}\n`);
    stream.emit(`${JSON.stringify({ exitCode: 44, signal: null, durationMs: 12 })}\n`);
    await expect(pending).resolves.toMatchObject({ stdout: 'out-1out-2', stderr: 'err-1', exitCode: 44 });
    // 非零 exitCode 是**正常**返回（调用方按 SSH 的 exitCode 语义处理），不是 error。
  });

  it('多字节 UTF-8 跨 chunk 不损坏（StringDecoder 持有半个字符）', async () => {
    const { stream, openStream } = singleStream();
    const pending = mcprExec('mcpr:i1', { cmd: 'bash', args: ['-c', 'x'] }, { openStream });
    await stream.ready();
    const frame = `${JSON.stringify({ stream: 'stdout', dataBase64: Buffer.from('中文-😀').toString('base64') })}\n`;
    const bytes = Buffer.from(frame, 'utf8');
    // 在「中」的第二个字节之间切断：任何 `chunk.toString('utf8')` 的实现在这里都会产生
    // U+FFFD，从而破坏 JSON 帧本身（base64 之前就坏了）。
    const cut = bytes.indexOf(Buffer.from('中', 'utf8')) + 1;
    stream.emitRaw(bytes.subarray(0, cut));
    stream.emitRaw(bytes.subarray(cut));
    stream.emit(`${JSON.stringify({ exitCode: 0, signal: null, durationMs: 1 })}\n`);
    await expect(pending).resolves.toMatchObject({ stdout: '中文-😀', exitCode: 0 });
  });

  it('error 行 → 带 code 的类型化失败', async () => {
    const { stream, openStream } = singleStream();
    const pending = mcprExec('mcpr:i1', { cmd: 'bash', args: ['-c', 'x'] }, { openStream });
    await stream.ready();
    stream.emit(`${JSON.stringify({ error: { code: 'EXEC_DENIED', message: 'not permitted' } })}\n`);
    await expect(pending).rejects.toThrow('[EXEC_DENIED] not permitted');
    expect(stream.killed).toBe(true);
  });

  // wire v1 加性字段：服务端输出触顶 16 MiB 时末帧带 `truncated:true`。**必须当失败**——
  // file ops 里一次被截断的 `readFile` 若被当成完整文件，会静默污染 agentHome / 技能正文，
  // 事后极难回溯。
  it('末帧 truncated:true → 抛 [MCPR_EXEC_TRUNCATED]，绝不把截断输出当完整结果', async () => {
    const { stream, openStream } = singleStream();
    const pending = mcprExec('mcpr:i1', { cmd: 'bash', args: ['-c', 'cat big'] }, { openStream });
    await stream.ready();
    stream.emit(`${JSON.stringify({ stream: 'stdout', dataBase64: Buffer.from('partial').toString('base64') })}\n`);
    stream.emit(`${JSON.stringify({ exitCode: 0, signal: null, durationMs: 9, truncated: true })}\n`);
    // 截断是失败：即使 exitCode 是 0 也不能 resolve 出 stdout（错误文本带 exitCode 供诊断）。
    await expect(pending).rejects.toThrow(/\[MCPR_EXEC_TRUNCATED\].*exitCode=0/);
    expect(stream.killed).toBe(true);
  });

  it('末帧不带 truncated（或为 false）→ 正常返回；未知字段一律忽略', async () => {
    const { stream, openStream } = singleStream();
    const pending = mcprExec('mcpr:i1', { cmd: 'bash', args: ['-c', 'x'] }, { openStream });
    await stream.ready();
    stream.emit(`${JSON.stringify({ stream: 'stdout', dataBase64: Buffer.from('ok').toString('base64') })}\n`);
    // 加性演进基线：未来的未知字段(以及显式 false)都不能让解析失败。
    stream.emit(`${JSON.stringify({
      exitCode: 0,
      signal: null,
      durationMs: 2,
      truncated: false,
      someFutureField: { nested: true },
    })}\n`);
    await expect(pending).resolves.toMatchObject({ stdout: 'ok', exitCode: 0, durationMs: 2 });
  });

  it('末帧之前连接关闭 → MCPR_EXEC_ABORTED（不伪造 exitCode 0）', async () => {
    const { stream, openStream } = singleStream();
    const pending = mcprExec('mcpr:i1', { cmd: 'bash', args: ['-c', 'x'] }, { openStream });
    await stream.ready();
    stream.emitClose({ code: 4010, signal: null });
    await expect(pending).rejects.toThrow(/\[MCPR_EXEC_ABORTED\]/);
  });

  it('客户端预算到点 → MCPR_EXEC_TIMEOUT（并关掉连接）', async () => {
    const { stream, openStream } = singleStream();
    const pending = mcprExec('mcpr:i1', { cmd: 'bash', args: ['-c', 'x'], timeoutMs: 10 }, { openStream });
    await expect(pending).rejects.toThrow(/\[MCPR_EXEC_TIMEOUT\]/);
    expect(stream.killed).toBe(true);
  });

  it('tunnel 打不开时不静默成功（openStream 的错误原样上浮）', async () => {
    const openStream = vi.fn(async () => {
      throw new Error('[MCPR_TUNNEL_UNREACHABLE] tunnel closed');
    });
    await expect(
      mcprExec('mcpr:i1', { cmd: 'bash', args: ['-c', 'x'] }, { openStream }),
    ).rejects.toThrow(/\[MCPR_TUNNEL_UNREACHABLE\]/);
  });
});
