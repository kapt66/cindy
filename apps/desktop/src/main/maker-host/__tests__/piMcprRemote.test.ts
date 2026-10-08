/**
 * `pi-mcpr-remote.ts` —— MCPRouter 上 Pi 远端能力的**唯一接缝**回归。
 *
 * 覆盖三件事：
 *   1. **file ops 复用**:`mcpr:` 的 Pi/Claude file ops 走 `mode=exec` 隧道，跑的
 *      是**与 SSH 同一份** `createRemotePiFileOps` bash 脚本（不是第二份实现）；
 *      文件内容只经 stdinBase64，不进命令行。
 *   2. **启动身份**:`createMcprPiTransport` 在 `mode=pi` 隧道上先发 pi-manager 既有的
 *      `protocol/hello` + `pi/ensure(cmd,env,envHash)`（与 SSH 同形），ensure 响应之后的
 *      字节就是 pi JSONL —— 包括「响应行之后已缓冲的字节」必须一并交给 Pi 协议核心。
 *   3. **二进制路径**:优先读 runtime 注入的 `CINDY_PI_AGENT_BIN`，缺失才退 PATH/布局约定；
 *      都不可执行时给类型化 marker，不静默回落本机路径。
 */

import { PROTOCOL_VERSION } from '@cindy/maker-pi-manager';
import type { ExecStreamHandle } from '@cindy/maker-remote-ssh';
import { describe, expect, it, vi } from 'vitest';

import {
  createMcprPiExecHost,
  createMcprPiFileOps,
  createMcprPiTransport,
  mcprPiMcpBridgeUnavailable,
  openMcprPiSessionChannel,
  resolveMcprPiBinaryPath,
  shouldSkipMcprPiMcpBridge,
  type McprTunnelOpener,
} from '../pi-mcpr-remote';

/** 最小假通道（与 `mcprExec.test.ts` 同形，按需注入 stdout / close / error）。 */
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
    async ready(minLines = 1): Promise<void> {
      await vi.waitFor(() => expect(this.lines().length).toBeGreaterThanOrEqual(minLines));
    },
    emitRaw(chunk: Buffer) { for (const cb of [...stdoutListeners]) cb(chunk); },
    emit(line: string) { for (const cb of [...stdoutListeners]) cb(Buffer.from(line, 'utf8')); },
    emitError(error: Error) { for (const cb of [...errorListeners]) cb(error); },
  };
}

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

/** 记录每条通道的 mode,便于断言「每次都新开一条 exec 隧道」。 */
function recordingOpener() {
  const streams: ReturnType<typeof fakeStream>[] = [];
  const modes: string[] = [];
  const opener: McprTunnelOpener = vi.fn(async (_hostId: string, mode) => {
    modes.push(mode);
    const stream = fakeStream();
    streams.push(stream);
    return stream.handle;
  });
  return { opener, streams, modes };
}

/** 读某条通道的请求行。 */
function execRequest(stream: ReturnType<typeof fakeStream>): Record<string, unknown> {
  const line = stream.lines()[0];
  expect(line, '隧道上应写出请求行').toBeTruthy();
  return JSON.parse(line) as Record<string, unknown>;
}

/** 结束一条 exec 通道（否则调用方会等末帧超时）。 */
function finishExec(stream: ReturnType<typeof fakeStream>, exitCode = 0, stdout = ''): void {
  if (stdout) {
    stream.emit(`${JSON.stringify({ stream: 'stdout', dataBase64: Buffer.from(stdout).toString('base64') })}\n`);
  }
  stream.emit(`${JSON.stringify({ exitCode, signal: null, durationMs: 1 })}\n`);
}

describe('Pi 远端 file ops：走 mode=exec，复用 SSH 那批脚本', () => {
  it('每个方法都是 `bash -c <同一份脚本>`，且每条 exec 各开一条隧道', async () => {
    const { opener, streams, modes } = recordingOpener();
    const ops = createMcprPiFileOps('mcpr:i1', { openTunnel: opener });

    const mkdirp = ops.mkdirp('$HOME/.xdt-server/v1/pi-agent-home/run-tmp/s1');
    await streams[0].ready();
    const mkdirReq = execRequest(streams[0]);
    expect(mkdirReq).toMatchObject({ version: 1, cmd: 'bash' });
    expect((mkdirReq.args as string[])[0]).toBe('-c');
    expect((mkdirReq.args as string[])[1]).toContain('mkdir -p');
    expect((mkdirReq.args as string[])[1]).toContain("'$HOME/.xdt-server/v1/pi-agent-home/run-tmp/s1'");
    finishExec(streams[0]);
    await mkdirp;

    const write = ops.writeFile('$HOME/agentHome/models.json', '{"a":1}', 0o600);
    await streams[1].ready();
    const writeReq = execRequest(streams[1]);
    const writeScript = (writeReq.args as string[])[1];
    expect(writeScript).toContain('(umask 077 && cat >');
    expect(writeScript).toContain('chmod 600');
    expect(Buffer.from(String(writeReq.stdinBase64), 'base64').toString('utf8')).toBe('{"a":1}');
    expect(streams[1].writes[0]).not.toContain('"a":1');
    finishExec(streams[1]);
    await write;

    const stat = ops.stat('$HOME/agentHome/settings.json');
    await streams[2].ready();
    expect((execRequest(streams[2]).args as string[])[1]).toContain('LC_ALL=C stat -L');
    finishExec(streams[2], 0, 'FILE\n');
    await expect(stat).resolves.toEqual({ isFile: true });

    const read = ops.readFile('$HOME/agentHome/keep.json', 4096);
    await streams[3].ready();
    expect((execRequest(streams[3]).args as string[])[1]).toContain('head -c 4096');
    finishExec(streams[3], 0, 'kept');
    await expect(read).resolves.toBe('kept');

    const tail = ops.readFileTail!('$HOME/agentHome/sessions/s.jsonl', 2048);
    await streams[4].ready();
    expect((execRequest(streams[4]).args as string[])[1]).toContain('tail -c 2048');
    finishExec(streams[4], 0, 'tail');
    await expect(tail).resolves.toBe('tail');

    const sha = ops.sha256File('$HOME/skills/x/SKILL.md');
    await streams[5].ready();
    expect((execRequest(streams[5]).args as string[])[1]).toContain('sha256sum');
    finishExec(streams[5], 0, `${'a'.repeat(64)}\n`);
    await expect(sha).resolves.toBe('a'.repeat(64));

    const rm = ops.rm('$HOME/agentHome/run-tmp/s1', { recursive: true });
    await streams[6].ready();
    expect((execRequest(streams[6]).args as string[])[1]).toContain('rm -rf');
    finishExec(streams[6]);
    await rm;

    const list = ops.listDir('$HOME/.claude/skills');
    await streams[7].ready();
    expect((execRequest(streams[7]).args as string[])[1]).toContain('ls -1');
    finishExec(streams[7], 0, 'a\nb\n');
    await expect(list).resolves.toEqual(['a', 'b']);

    // 每次都走 exec 模式、每次都新开一条(单连接单次执行),不复用隧道。
    expect(modes).toEqual(Array(8).fill('exec'));
  });

  it('exec 宿主把整条命令包成 bash -c（与 SSH 的登录 shell 语义对齐）', async () => {
    const { opener, streams } = recordingOpener();
    const host = createMcprPiExecHost('mcpr:i1', { openTunnel: opener });
    expect(host.id).toBe('mcpr:i1');
    const pending = host.exec("bash -c 'mkdir -p /tmp/x'", { timeoutMs: 12_345, input: 'in', label: 'l' });
    await streams[0].ready();
    const request = execRequest(streams[0]);
    expect(request.args).toEqual(['-c', "bash -c 'mkdir -p /tmp/x'"]);
    expect(request.timeoutMs).toBe(12_345);
    expect(Buffer.from(String(request.stdinBase64), 'base64').toString('utf8')).toBe('in');
    finishExec(streams[0], 0, 'ok');
    await expect(pending).resolves.toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
  });

  it('exec 失败按 exitCode 上浮（file ops 的调用方自己决定语义）', async () => {
    const { opener, streams } = recordingOpener();
    const ops = createMcprPiFileOps('mcpr:i1', { openTunnel: opener });
    const pending = ops.mkdirp('/nope');
    await streams[0].ready();
    finishExec(streams[0], 1);
    await expect(pending).rejects.toThrow(/remote mkdir failed \(exit 1\)/);
  });
});

describe('Pi 二进制路径：runtime 注入优先，缺失显式失败', () => {
  it('runtime 注入的 CINDY_PI_AGENT_BIN 直接可用（探针含该变量）', async () => {
    const { opener, streams } = recordingOpener();
    const pending = resolveMcprPiBinaryPath('mcpr:i1', { openTunnel: opener });
    await streams[0].ready();
    const script = (execRequest(streams[0]).args as string[])[1];
    expect(script).toContain('CINDY_PI_AGENT_BIN');
    expect(script).toContain('command -v pi');
    expect(script).toContain('$HOME/.xdt-server/v1/pi/pi');
    finishExec(streams[0], 0, '/opt/cindy/pi/pi\n');
    await expect(pending).resolves.toBe('/opt/cindy/pi/pi');
  });

  it('三条来源都取不到 → [MCPR_PI_BINARY_MISSING]（不回落本机路径）', async () => {
    const { opener, streams } = recordingOpener();
    const pending = resolveMcprPiBinaryPath('mcpr:i2', { openTunnel: opener });
    await streams[0].ready();
    finishExec(streams[0], 44, 'MISSING\n');
    await expect(pending).rejects.toThrow(/\[MCPR_PI_BINARY_MISSING\]/);
  });

  it('每次都现解析（不缓存）：旧路径被缓存住会让会话一直失败到重启 Cindy', async () => {
    const first = recordingOpener();
    const pending = resolveMcprPiBinaryPath('mcpr:i1', { openTunnel: first.opener });
    await first.streams[0].ready();
    finishExec(first.streams[0], 0, '/opt/pi-old\n');
    await expect(pending).resolves.toBe('/opt/pi-old');

    const second = recordingOpener();
    const again = resolveMcprPiBinaryPath('mcpr:i1', { openTunnel: second.opener });
    await second.streams[0].ready();
    finishExec(second.streams[0], 0, '/opt/pi-new\n');
    await expect(again).resolves.toBe('/opt/pi-new');
    expect(second.streams).toHaveLength(1);
  });
});

describe('mode=pi 数据面：hello + pi/ensure 之后同一条隧道就是 JSONL', () => {
  it('ensure 请求与 SSH 同形；响应之后的字节（含已缓冲）交给 Pi 协议核心', async () => {
    const stream = fakeStream();
    const opener: McprTunnelOpener = async (_hostId, mode) => {
      expect(mode).toBe('pi');
      return stream.handle;
    };

    const channelPromise = openMcprPiSessionChannel({
      remoteHostId: 'mcpr:i1',
      ensure: {
        sessionId: 's1',
        cmd: 'cd "/inst/wd" || exit 1\nexec "$HOME/.xdt-server/v1/pi/pi" \'--mode\' \'rpc\'',
        env: { CINDY_PI_API_KEY: 'k' },
        envHash: 'hash-1',
        restart: true,
      },
      logger,
      openTunnel: opener,
    });

    // 首帧必须是 pi-manager 既有的 protocol/hello。
    await stream.ready(1);
    const hello = JSON.parse(stream.lines()[0]) as Record<string, unknown>;
    expect(hello).toMatchObject({ type: 'request', id: 1, method: 'protocol/hello' });
    expect(hello.params).toMatchObject({ protocolVersion: PROTOCOL_VERSION, clientId: 'cindy-meka-remote-pi' });
    stream.emit(`${JSON.stringify({ type: 'response', id: 1, result: { protocolVersion: PROTOCOL_VERSION } })}\n`);

    await stream.ready(2);
    const ensure = JSON.parse(stream.lines()[1]) as Record<string, unknown>;
    expect(ensure).toMatchObject({ type: 'request', id: 2, method: 'pi/ensure' });
    expect(ensure.params).toMatchObject({
      sessionId: 's1',
      env: { CINDY_PI_API_KEY: 'k' },
      envHash: 'hash-1',
      restart: true,
    });

    // ensure 响应与首个 pi 事件**同一批字节**到达：响应行之后的部分必须原样交接。
    stream.emit(
      `${JSON.stringify({ type: 'response', id: 2, result: { sessionId: 's1', sockPath: '/inst/socks/s1.pi.sock', isReattach: true } })}\n`
      + `${JSON.stringify({ type: 'event', event: 'ready' })}\n`,
    );

    const channel = await channelPromise;
    expect(channel).toMatchObject({ sockPath: '/inst/socks/s1.pi.sock', isReattach: true });
    const lines: string[] = [];
    channel.handle.onStdoutBytes((chunk) => lines.push(chunk.toString('utf8')));
    // 已缓冲的那行(与 ensure 响应同一批字节到达)必须先被交出去,不能被丢掉。
    await vi.waitFor(() => expect(lines.join('')).toContain('"event":"ready"'));
    // 后续帧继续直通同一条连接。
    stream.emit(`${JSON.stringify({ type: 'event', event: 'later' })}\n`);
    await vi.waitFor(() => expect(lines.join('')).toContain('"event":"later"'));
  });

  it('ensure 失败 → 报错并关掉隧道（不留下半开连接）', async () => {
    const stream = fakeStream();
    const opener: McprTunnelOpener = async () => stream.handle;
    const pending = openMcprPiSessionChannel({
      remoteHostId: 'mcpr:i1',
      ensure: { sessionId: 's1', cmd: 'x', env: {}, envHash: 'h', restart: true },
      logger,
      openTunnel: opener,
    });
    await stream.ready(1);
    stream.emit(`${JSON.stringify({ type: 'response', id: 1, result: { protocolVersion: PROTOCOL_VERSION } })}\n`);
    await stream.ready(2);
    stream.emit(`${JSON.stringify({ type: 'response', id: 2, error: { code: 'INVALID_PARAMS', message: 'bad env' } })}\n`);
    await expect(pending).rejects.toThrow('[INVALID_PARAMS] bad env');
    expect(stream.killed).toBe(true);
  });
});

describe('createMcprPiTransport：启动身份与 SSH 一致（envHash 覆盖 cmd+env+cwd）', () => {
  function buildTransport(opts: { cwd?: string; env?: Record<string, string>; args?: string[] }) {
    const { opener, streams, modes } = recordingOpener();
    const transport = createMcprPiTransport({
      remoteHostId: 'mcpr:i1',
      remoteBinaryPath: '$HOME/.xdt-server/v1/pi/pi',
      args: opts.args ?? ['--mode', 'rpc', '--session-dir', '$HOME/.xdt-server/v1/pi-agent-home/sessions'],
      cwd: opts.cwd ?? '/inst/wd',
      env: opts.env ?? { CINDY_PI_API_KEY: 'k', UNSET: undefined },
      sessionId: 's1',
      logger,
      openTunnel: opener,
    });
    return { transport, streams, modes };
  }

  it('cmd 是 cd + exec（$HOME 用双引号活动展开），env 过滤 undefined', async () => {
    const { transport, streams, modes } = buildTransport({});
    await vi.waitFor(() => expect(streams.length).toBe(1));
    await streams[0].ready(1);
    expect(modes).toEqual(['pi']);
    const hello = JSON.parse(streams[0].lines()[0]) as Record<string, unknown>;
    expect(hello.method).toBe('protocol/hello');
    streams[0].emit(`${JSON.stringify({ type: 'response', id: 1, result: { protocolVersion: PROTOCOL_VERSION } })}\n`);
    await streams[0].ready(2);
    const ensure = JSON.parse(streams[0].lines()[1]) as { params: Record<string, unknown> };
    expect(ensure.params.sessionId).toBe('s1');
    expect(ensure.params.cmd).toBe(
      'cd "/inst/wd" || exit 1\n'
      + 'exec "$HOME/.xdt-server/v1/pi/pi" \'--mode\' \'rpc\' \'--session-dir\' "$HOME/.xdt-server/v1/pi-agent-home/sessions"',
    );
    expect(ensure.params.env).toEqual({ CINDY_PI_API_KEY: 'k' });
    // 收到 ensure 响应后,该隧道即 pi JSONL:一行事件必须经共享核心冒泡到 onLine。
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));
    streams[0].emit(`${JSON.stringify({ type: 'response', id: 2, result: { sessionId: 's1', sockPath: '/s', isReattach: false } })}\n`);
    streams[0].emit(`${JSON.stringify({ type: 'event', event: 'ready' })}\n`);
    await vi.waitFor(() => expect(lines).toContain('{"type":"event","event":"ready"}'));
  });

  it('同一个 spawn 身份两次构造得到同一个 envHash；改 cwd 则不同', async () => {
    const hashes: string[] = [];
    for (const cwd of ['/inst/wd', '/inst/wd', '/inst/other']) {
      const { transport, streams } = buildTransport({ cwd });
      await vi.waitFor(() => expect(streams.length).toBe(1));
      await streams[0].ready(1);
      streams[0].emit(`${JSON.stringify({ type: 'response', id: 1, result: { protocolVersion: PROTOCOL_VERSION } })}\n`);
      await streams[0].ready(2);
      hashes.push(String((JSON.parse(streams[0].lines()[1]) as { params: { envHash: string } }).params.envHash));
      // 放 ensure 响应让 open() 收敛,再关掉 transport(不留半开的 pending promise)。
      streams[0].emit(`${JSON.stringify({ type: 'response', id: 2, result: { sessionId: 's1', sockPath: '/s', isReattach: true } })}\n`);
      await transport.close('test');
    }
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  it('不安全的 env 值在建立隧道之前就 fail-closed（sanitize 与 SSH 同一份）', () => {
    const opener: McprTunnelOpener = async () => {
      throw new Error('should not open a tunnel');
    };
    expect(() => createMcprPiTransport({
      remoteHostId: 'mcpr:i1',
      remoteBinaryPath: '$HOME/pi/pi',
      args: [],
      cwd: '/inst/wd',
      env: { CINDY_PI_API_KEY: 'bad\nvalue' },
      sessionId: 's1',
      logger,
      openTunnel: opener,
    })).toThrow(/unsafe env entry/);
  });
});

describe('MCPRouter 上的 MCP 投影口径', () => {
  it('in-process bridge 跳过；真被调用时报类型化 marker（不交 loopback URL）', () => {
    expect(shouldSkipMcprPiMcpBridge()).toBe(true);
    expect(() => mcprPiMcpBridgeUnavailable('mcpr:i1')).toThrow(/\[MCPR_PI_MCP_BRIDGE_UNAVAILABLE\]/);
  });
});
