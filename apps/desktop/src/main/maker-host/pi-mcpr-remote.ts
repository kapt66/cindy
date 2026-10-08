/**
 * MCPRouter(`mcpr:<instance.id>`)上的 Pi 远端实现 —— **唯一接缝**。
 *
 * 三条冻结契约(2026-10-09 裁决,见 `docs/dev-rules/pi-harness.md`「MCPRouter 远端(MCPR)」):
 *
 *   1. **数据面**:agent-tunnel `mode=pi`。客户端先在这条隧道上跑 pi-manager 的**既有 RPC**
 *      (`protocol/hello` → `pi/ensure(sessionId, cmd, env, envHash)`),ensure 响应之后的字节
 *      就是该 session 的 pi JSONL —— 与 SSH 路径(`pi-manager bridge --socket <session sock>`
 *      的 stdio)逐字节同源,因此 Pi 协议实现共用 `pi-remote-transport.ts` 的共享核心。
 *   2. **控制面/文件面**:agent-tunnel `mode=exec`(见 `mcpr-tunnel.ts` 的 `mcprExec`)。
 *      语义等价 SSH 的 `remoteHost.exec`(实例容器内、runtime 同一非 root 用户),所以
 *      Pi 与 Claude 的远端 file ops **原样复用** `createRemotePiFileOps` 的那批 bash 脚本,
 *      区别只是 exec 从哪条通道来。客户端**不**加路径/命令白名单。
 *   3. **不新增 wire 协议**:`mode=pi` 上的 RPC 是 pi-manager 既有的;`packages/maker-pi-manager`
 *      一字未改(AGENTS.md 的跨端 wire 规则)。
 *
 * 本模块是「字节/执行从哪来」的收敛点:万一 MCPRouter 侧把数据面改成「第二条 `mode=pi`
 * 隧道」或把进程控制挪到别处,只需要改 `openMcprPiSessionChannel` / `createMcprPiExecHost`
 * 这两个函数,上层钩子与本文件的其余部分不变。
 */

import {
  encodeMessage,
  isRpcMessage,
  isRpcResponse,
  PROTOCOL_VERSION,
  type PiEnsureParams,
  type PiEnsureResult,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
} from '@cindy/maker-pi-manager';
import type { ExecStreamHandle } from '@cindy/maker-remote-ssh';

import { mcprExec, openMcprTunnel, type McprTunnelMode } from './mcpr-tunnel.js';
import {
  buildPiLaunchCommand,
  computePiLaunchEnvHash,
  createPiTransportFromProvider,
  createRemotePiFileOps,
  sanitizePiEnsureEnv,
  type PiByteChannelProvider,
  type PiRemoteExecHost,
} from './pi-remote-transport.js';
import type { PiRemoteFileOps, PiTransport } from '@cindy/maker-core';

interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/** 隧道开启方式(测试注入点;生产 = `openMcprTunnel`)。 */
export type McprTunnelOpener = (
  remoteHostId: string,
  mode: McprTunnelMode,
) => Promise<ExecStreamHandle>;

const defaultOpenTunnel: McprTunnelOpener = (remoteHostId, mode) =>
  openMcprTunnel(remoteHostId, { mode });

/* ============================ 文件面 / 二进制路径（mode=exec） ============================ */

/**
 * MCPRouter 实例内的 exec 宿主 —— 与 SSH 的 `RemoteHost` 在本接口上同形。
 *
 * SSH 的 `remoteHost.exec(cmd)` 是把整条命令交给远端登录 shell;这里把同一条命令包成
 * `bash -c <cmd>` 送进隧道(`createRemotePiFileOps` 传进来的本来就是 `bash -c '…'` 形状,
 * 嵌套 bash 语义不变:`$HOME` 仍在远端展开、内容仍走 stdin)。
 */
export function createMcprPiExecHost(
  remoteHostId: string,
  deps: { openTunnel?: McprTunnelOpener } = {},
): PiRemoteExecHost {
  return {
    id: remoteHostId,
    async exec(command, opts) {
      const result = await mcprExec(remoteHostId, {
        cmd: 'bash',
        args: ['-c', command],
        ...(opts?.input !== undefined ? { stdin: opts.input } : {}),
        ...(opts?.env ? { env: opts.env } : {}),
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      }, deps.openTunnel ? { openStream: (hostId) => deps.openTunnel!(hostId, 'exec') } : {});
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
  };
}

/**
 * Pi 的远端 agentHome 文件原语(与 SSH **同一份实现**,只换 exec 取道)。
 *
 * 逐条对应(method → 底层动作,与 `createRemotePiFileOps` 一致):
 *   - `mkdirp` → `bash -c` 里 `$HOME` 展开 + `mkdir -p`(纯 exec)
 *   - `writeFile` → `mkdir -p dirname` + `(umask 077 && cat > "$P")`(**内容经 stdin**,不进 argv)
 *   - `stat` → `LC_ALL=C stat -L -c '%F' | -f '%HT'`,区分 MISSING / EACCES / FILE / DIR
 *   - `readFile` / `readFileTail` → `head -c N` / `tail -c N`(N ≤ 4 MiB)
 *   - `sha256File` → `sha256sum` → `shasum -a 256` → `openssl dgst -sha256`
 *   - `rm` → `rm [-rf]`
 *   - `listDir` → `ls -1`
 */
export function createMcprPiFileOps(
  remoteHostId: string,
  deps: { openTunnel?: McprTunnelOpener } = {},
): PiRemoteFileOps {
  return createRemotePiFileOps(createMcprPiExecHost(remoteHostId, deps));
}

/**
 * 远端 pi 二进制路径(每次现解析,**不缓存**)。
 *
 * **为什么仍然要一条 exec 探针**:maker-core 需要这个**路径值**本身 ——
 * `planModeExtPath = dirname(binaryPath)/examples/extensions/plan-mode/index.ts`
 * (`packages/maker-core/src/agents/pi/index.ts` 的 `effectivePiBinaryPath`),还要作为
 * `transport.remoteBinaryPath` 给子代理 spawn env。协议侧 `pi/ensure` 的响应形状是既有的
 * `{sessionId, sockPath, isReattach}`,不给路径;因此**优先级**是:
 *   1. runtime 注入的环境变量 `CINDY_PI_AGENT_BIN`(runtime 本来就知道路径,零协议新增);
 *   2. 实例 PATH 上的 `pi`(`command -v`);
 *   3. 与 SSH 安装布局同约定的 `$HOME/.xdt-server/v1/pi/pi`。
 * 三条都取不到(不可执行)才抛 `[MCPR_PI_BINARY_MISSING]`,与 SSH 的
 * `pi not installed on remote host …` 同语义 —— 不静默回落到本机路径(那会让子代理在实例里
 * spawn 一个不存在的路径、并静默禁用 plan 模式)。
 *
 * 与 SSH 的 per-host cache 不同,这里**刻意不缓存**:调用点是「每次 startSession 一次」级别
 * (不便宜但可忽略),而实例的 pi 物化路径可能随 runtime 重发而变 —— 缓存住旧路径会让会话
 * 一直失败到重启 Cindy,代价比一次 exec 大得多。
 */
export async function resolveMcprPiBinaryPath(
  remoteHostId: string,
  deps: { openTunnel?: McprTunnelOpener; execHost?: PiRemoteExecHost } = {},
): Promise<string> {
  const host = deps.execHost ?? createMcprPiExecHost(remoteHostId, deps);
  const script = [
    'P="${CINDY_PI_AGENT_BIN:-}"',
    'if [ -z "$P" ]; then P="$(command -v pi 2>/dev/null || true)"; fi',
    'if [ -z "$P" ]; then P="$HOME/.xdt-server/v1/pi/pi"; fi',
    'if [ ! -x "$P" ]; then printf \'MISSING\\n\'; exit 44; fi',
    'printf \'%s\\n\' "$P"',
  ].join('\n');
  const result = await host.exec(`bash -c ${shellQuote(script)}`, {
    timeoutMs: 15_000,
    label: 'mcpr-pi-binary-probe',
  });
  const path = result.stdout.trim().split(/\r?\n/).pop() ?? '';
  if (result.exitCode !== 0 || !path || path === 'MISSING') {
    throw new Error(
      `[MCPR_PI_BINARY_MISSING] the MCPRouter instance ${remoteHostId} did not expose an executable pi runtime `
        + '(checked CINDY_PI_AGENT_BIN, PATH, $HOME/.xdt-server/v1/pi/pi)',
    );
  }
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/* ============================ 数据面（mode=pi） ============================ */

export interface McprPiSessionChannelOptions {
  remoteHostId: string;
  /** 启动身份(sessionId / cmd / env / envHash / restart)—— 与 SSH ensure 的参数同形。 */
  ensure: PiEnsureParams;
  logger: Logger;
  /** 探针 / ensure 请求的响应等待预算(默认 30s,与 SSH pi-manager RPC 一致)。 */
  requestTimeoutMs?: number;
  openTunnel?: McprTunnelOpener;
}

export interface McprPiSessionChannel {
  /** ensure 之后同一条隧道的字节流(= 该 session 的 pi JSONL)。 */
  handle: ExecStreamHandle;
  sockPath: string;
  isReattach: boolean;
}

/**
 * 打开一条 `mode=pi` 隧道,跑完 pi-manager 既有 RPC 的 hello + `pi/ensure`,然后把
 * **同一条连接**交给 Pi 协议核心当 JSONL 字节流。
 *
 * 阶段切换规则(客户端侧):收到 `pi/ensure` 的响应帧之后,该连接上剩余(以及后续)的字节
 * 全是 pi JSONL。为做到字节级保真,阶段 1 的分帧在 **Buffer** 上做:只解析到 `\n` 的完整行,
 * 剩下的原始字节(可能含半个 UTF-8 字符)原样交给阶段 2,不经过字符串往返。
 */
export async function openMcprPiSessionChannel(
  opts: McprPiSessionChannelOptions,
): Promise<McprPiSessionChannel> {
  const openTunnel = opts.openTunnel ?? defaultOpenTunnel;
  const handle = await openTunnel(opts.remoteHostId, 'pi');
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;

  let phase: 'rpc' | 'jsonl' = 'rpc';
  // 显式标注(而不是靠 `Buffer.alloc(0)` 推断):@types/node 把 `Buffer` 参数化成
  // `Buffer<ArrayBufferLike>`,而通道回调给的是同一族 —— 不标注会在赋值处报方差错。
  let buffer: Buffer = Buffer.alloc(0);
  let leftover: Buffer = Buffer.alloc(0);
  /** 阶段切换后、装饰器建立前的落盘字节(交接时补进去)。 */
  let pendingJsonl: Buffer = Buffer.alloc(0);
  let handedOff = false;
  /** `pi/ensure` 的请求 id —— 它的响应帧就是两个阶段的切换点。 */
  let pendingEnsureId: number | null = null;
  /**
   * 阶段读写一律经函数：TS 的控制流分析会在闭包创建处把 `phase` 窄化成 `'rpc'` 字面量，
   * 于是闭包里的 `phase === 'jsonl'` 会被判「两种类型无重叠」（TS2367）。
   */
  const inJsonlPhase = (): boolean => (phase as 'rpc' | 'jsonl') === 'jsonl';
  const enterJsonlPhase = (): void => { phase = 'jsonl'; };
  const jsonlListeners = new Set<(chunk: Buffer) => void>();
  const failedListeners = new Set<(error: Error) => void>();
  let closedError: Error | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();

  const failAll = (error: Error): void => {
    closedError = error;
    for (const [, entry] of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    for (const listener of failedListeners) {
      try { listener(error); } catch { /* listener should not throw */ }
    }
  };

  const request = (method: string, params: unknown): { id: number; result: Promise<unknown> } => {
    const id = nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = requestTimeoutMs > 0
        ? setTimeout(() => {
          pending.delete(id);
          reject(new Error(`[MCPR_PI_RPC_TIMEOUT] ${method} timed out after ${requestTimeoutMs}ms`));
        }, requestTimeoutMs)
        : undefined;
      timer?.unref?.();
      pending.set(id, { resolve, reject, ...(timer ? { timer } : {}) });
      try {
        handle.write(encodeMessage({ type: 'request', id, method, params } as RpcRequest));
      } catch (error) {
        pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return { id, result };
  };

  const consumeRpcLine = (line: string): void => {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      // 坏帧不致命:阶段 1 只关心自己那两个响应(与 pi-manager RpcClient 的容忍口径一致)。
      opts.logger.warn('mcpr pi rpc: ignored non-JSON frame on the pi tunnel');
      return;
    }
    if (!isRpcMessage(frame) || !isRpcResponse(frame as RpcMessage)) return;
    const response = frame as RpcResponse;
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (response.error) {
      const error = new Error(`[${response.error.code}] ${response.error.message}`);
      (error as Error & { code?: string }).code = response.error.code;
      entry.reject(error);
      return;
    }
    entry.resolve(response.result);
    // **阶段切换就在读帧处发生**,不能等 `await request(...)` 的续体:`ensure` 响应与首批
    // pi 字节可能在同一个 WS 帧里到达,续体要等到本函数返回控制权才会跑 —— 那时剩下的
    // 字节已经被下面的行循环当「阶段 1 的无关键」丢掉了(实测:`ensure 响应 + 首个事件`
    // 同帧时首个事件消失)。
    if (pendingEnsureId !== null && response.id === pendingEnsureId) {
      pendingEnsureId = null;
      enterJsonlPhase();
    }
  };

  handle.onStdoutBytes((chunk: Buffer) => {
    if (inJsonlPhase()) {
      // 交接前(装饰器尚未建立)先攒着,交接时一次性补进去,顺序不变。
      if (!handedOff) {
        pendingJsonl = pendingJsonl.length === 0 ? chunk : Buffer.concat([pendingJsonl, chunk]);
        return;
      }
      for (const listener of jsonlListeners) {
        try { listener(chunk); } catch { /* listener should not throw */ }
      }
      return;
    }
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    let newline = buffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      buffer = buffer.subarray(newline + 1);
      if (line.trim().length > 0) consumeRpcLine(line);
      if (inJsonlPhase()) {
        // 该行之后的所有字节都是 pi JSONL(含本来就在 buffer 里的那些)。
        leftover = buffer;
        buffer = Buffer.alloc(0);
        return;
      }
      newline = buffer.indexOf(0x0a);
    }
  });
  handle.onError((error: Error) => failAll(error));
  handle.onClose((info: { code: number | null; signal: string | null }) => {
    failAll(new Error(
      info.signal
        ? `[MCPR_PI_TUNNEL_CLOSED] pi tunnel closed (signal=${info.signal})`
        : `[MCPR_PI_TUNNEL_CLOSED] pi tunnel closed (exit code=${info.code ?? 'null'})`,
    ));
  });

  try {
    const hello = await request('protocol/hello', {
      protocolVersion: PROTOCOL_VERSION,
      clientId: 'cindy-meka-remote-pi',
    }).result as { protocolVersion?: number } | undefined;
    if (hello?.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `[MCPR_PI_PROTOCOL_MISMATCH] pi-manager protocol ${String(hello?.protocolVersion)} does not match client ${PROTOCOL_VERSION}`,
      );
    }
    const ensureCall = request('pi/ensure', opts.ensure);
    // 记下 id:它的响应帧是阶段切换点(见 consumeRpcLine / 读帧循环)。
    pendingEnsureId = ensureCall.id;
    const ensured = await ensureCall.result as PiEnsureResult | undefined;
    if (!ensured || typeof ensured.sockPath !== 'string') {
      throw new Error('[MCPR_PI_ENSURE_INVALID] pi/ensure did not return a session socket');
    }
    // 兜底切换(主路径在读帧处):此刻之后写入的字节都属于 pi JSONL。
    if (!inJsonlPhase()) {
      leftover = buffer;
      buffer = Buffer.alloc(0);
      enterJsonlPhase();
    }
    handedOff = true;
    const initial = leftover.length === 0
      ? pendingJsonl
      : (pendingJsonl.length === 0 ? leftover : Buffer.concat([leftover, pendingJsonl]));
    pendingJsonl = Buffer.alloc(0);
    opts.logger.debug('mcpr pi session ensured', {
      remoteHostId: opts.remoteHostId,
      isReattach: ensured.isReattach === true,
      prefetchedBytes: initial.length,
    });
    return {
      handle: withPrefetchedBytes(handle, initial, jsonlListeners, failedListeners, closedError),
      sockPath: ensured.sockPath,
      isReattach: ensured.isReattach === true,
    };
  } catch (error) {
    try { handle.kill(); } catch { /* best-effort */ }
    throw error;
  }
}

/**
 * 把「阶段 1 已经读到的原始字节」补回字节流,再原样委托给真 handle。
 *
 * 首块经 `queueMicrotask` 投放:共享核心在 `open()` resolve 之后同步注册
 * `onStdoutBytes`;microtask 在下一轮 I/O 事件之前执行,因此首块一定排在后续
 * 真实网络块之前,顺序不乱。
 */
function withPrefetchedBytes(
  handle: ExecStreamHandle,
  initial: Buffer,
  jsonlListeners: Set<(chunk: Buffer) => void>,
  failedListeners: Set<(error: Error) => void>,
  earlyError: Error | null,
): ExecStreamHandle {
  const bytesListeners = new Set<(chunk: Buffer) => void>();
  const textListeners = new Set<(chunk: string) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  let flushed = false;
  const flush = (): void => {
    if (flushed) return;
    flushed = true;
    if (initial.length === 0) return;
    for (const listener of bytesListeners) listener(initial);
    const text = initial.toString('utf8');
    for (const listener of textListeners) listener(text);
  };
  // 阶段 1 的订阅者(由 openMcprPiSessionChannel 注册)把后续块转发给本装饰器的听众。
  jsonlListeners.add((chunk) => {
    for (const listener of bytesListeners) listener(chunk);
    const text = chunk.toString('utf8');
    for (const listener of textListeners) listener(text);
  });
  failedListeners.add((error) => {
    for (const listener of errorListeners) listener(error);
  });

  return {
    write: (data) => handle.write(data),
    end: (data) => handle.end(data),
    kill: () => handle.kill(),
    onStdoutBytes(callback) {
      bytesListeners.add(callback);
      queueMicrotask(flush);
      return () => { bytesListeners.delete(callback); };
    },
    onStdout(callback) {
      textListeners.add(callback);
      queueMicrotask(flush);
      return () => { textListeners.delete(callback); };
    },
    onStderr: (callback) => handle.onStderr(callback),
    onDrain: (callback) => handle.onDrain(callback),
    onClose: (callback) => handle.onClose(callback),
    onError(callback) {
      errorListeners.add(callback);
      if (earlyError) callback(earlyError);
      return () => { errorListeners.delete(callback); };
    },
    ...(handle.pause ? { pause: () => handle.pause!() } : {}),
    ...(handle.resume ? { resume: () => handle.resume!() } : {}),
  };
}

/* ============================ 钩子级实现（index.ts 直接调） ============================ */

export interface McprPiTransportOptions {
  remoteHostId: string;
  /** 已解析的实例内 pi 二进制路径(plan-mode 扩展 / 子代理 env 需要)。 */
  remoteBinaryPath: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
  sessionId?: string | null;
  logger: Logger;
  handshakeTimeoutMs?: number;
  openTunnel?: McprTunnelOpener;
}

/**
 * 建 MCPRouter 上的 Pi transport:ensure(与 SSH 同一个启动方式)→ 同一条隧道作为 JSONL
 * 字节流 → 交给共享协议核心。`hostProxyForwards` 不适用(实例没有到控制端的反向转发)。
 */
export function createMcprPiTransport(opts: McprPiTransportOptions): PiTransport {
  const env = sanitizePiEnsureEnv(opts.env);
  const command = buildPiLaunchCommand({
    cwd: opts.cwd,
    binaryPath: opts.remoteBinaryPath,
    args: [...opts.args],
  });
  const envHash = computePiLaunchEnvHash({ env, command, cwd: opts.cwd });
  const sessionId = opts.sessionId ?? undefined;
  const provider: PiByteChannelProvider = {
    transportId: opts.remoteHostId,
    remoteBinaryPath: opts.remoteBinaryPath,
    envViaStdin: undefined,
    async open() {
      const channel = await openMcprPiSessionChannel({
        remoteHostId: opts.remoteHostId,
        ensure: {
          sessionId: sessionId ?? opts.remoteHostId.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 128),
          cmd: command,
          env,
          envHash,
          restart: true,
        },
        logger: opts.logger,
        ...(opts.openTunnel ? { openTunnel: opts.openTunnel } : {}),
      });
      return channel.handle;
    },
  };
  return createPiTransportFromProvider(
    { logger: opts.logger, ...(opts.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: opts.handshakeTimeoutMs } : {}) },
    provider,
  );
}

/**
 * MCPRouter 上没有「Agent 流量走本地 Proxy」的 `tunnel` 形态(pref 的隧道模式要求控制端到
 * 实例的**反向**转发,agent-tunnel 只有正向字节流)。因此这里返回 `null`(不注入代理 env)
 * —— 实例按自己的网络直连,与 MCPR 的 Claude 分支(`remoteCcQueryFactory` 的 mcpr 早返回)
 * 同一口径。**这不是新增拒绝**:pref 是 Cindy 的可选加速项,缺它不影响 Pi 启动与原生能力;
 * 也不改变 Pi 的 provider/凭证策略(沿用 SSH 语义)。
 */
export function resolveMcprPiAgentProxyEnv(): null {
  return null;
}

/**
 * MCPRouter 上不投影 Cindy 的 in-process MCP bridge。
 *
 * 原因:那批 server 是**控制端 loopback** 上的 HTTP 端点,SSH 靠 `-R` 反向转发把它送到远端,
 * 而 agent-tunnel 只有正向字节流(Claude 走的是 cc-mgr 自己的 capability MCP 回呼,Pi 没有
 * 对应通道)。**不**把 loopback URL 原样交给实例:实例上的 `127.0.0.1` 是它自己的回环,
 * 拿控制端的端口去连会打到实例上的无关服务(既错又有安全面)。
 * 影响面:用户显式配置的**外部 HTTP/Streamable HTTP MCP 仍直连可用**(piEnvironment 的
 * 该分支不受影响),少的是 Cindy 自有工具投影(ghost / cindy_memory / orca / 电脑驱动等)。
 * 后续补法:runtime 侧提供 capability MCP 端点(与 cc-mgr 同形),届时改本函数即可。
 */
export function shouldSkipMcprPiMcpBridge(): boolean {
  return true;
}

/** `rewriteRemotePiMcpBridgeUrl` 的兜底:隧道形态没有可用于改写的反向转发目标。 */
export function mcprPiMcpBridgeUnavailable(remoteHostId: string): never {
  throw new Error(
    `[MCPR_PI_MCP_BRIDGE_UNAVAILABLE] MCPRouter sessions do not project the controller's in-process MCP bridge `
      + `(remote=${remoteHostId}); external HTTP MCP servers keep working`,
  );
}
