import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

import WebSocket, { type RawData } from 'ws';
import type { ExecStreamHandle } from '@cindy/maker-remote-ssh';

import { CC_MGR_BUNDLE_VERSION } from '@cindy/maker-cc-manager';

import { parseMcprRemoteHostId } from '../../shared/meka-router.js';
import { getMekaRouterService } from '../meka-settings/ipc.js';

type WebSocketLike = {
  readyState: number;
  binaryType?: string;
  send(data: string | Buffer, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?: () => void;
  on(event: 'open', callback: () => void): unknown;
  on(event: 'message', callback: (data: RawData) => void): unknown;
  on(event: 'close', callback: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', callback: (error: Error) => void): unknown;
  on(
    event: 'unexpected-response',
    callback: (_request: unknown, response: { statusCode?: number; resume(): void }) => void,
  ): unknown;
};

type WebSocketConstructor = new (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocketLike;

/**
 * MCPRouter agent-tunnel 的 mode。
 *
 *   - `cc-mgr` / `codex-appserver`:cc-mgr bundle 的两种形态(控制通道 / Codex app-server
 *     字节流),都由 cc-mgr 那份产物承载,因此都要带 `bundleVersion` 声明(见 §4.1 / WL-4.1.10);
 *   - `pi`:pi-manager 的通道(runtime 把隧道接到 `pi-manager bridge --socket <受管 socket>`
 *     的 stdio)。先跑 pi-manager 既有 RPC(`protocol/hello` + `pi/ensure`)交启动身份,
 *     之后同一条连接就是该 session 的 pi JSONL(与 SSH 路径逐字节同源);
 *   - `exec`:单连接单次执行(等价 SSH 的 `remoteHost.exec`),Pi/Claude 的远端 file ops
 *     与二进制探针走它。
 *
 * `pi` / `exec` **不带** `bundleVersion`:它们不消费 cc-mgr 产物,声明一个 cc-mgr 版本
 * 只会让服务端白做一次 bundle 物化(而 pi/exec 需要的是 pi 运行时资产,由 `pi` CDN 段交付)。
 */
export type McprTunnelMode = 'cc-mgr' | 'codex-appserver' | 'pi' | 'exec';

/** 消费 cc-mgr 产物的两种 mode(只有它们要声明 cc-mgr bundle 版本)。 */
const CC_MGR_BACKED_TUNNEL_MODES: ReadonlySet<McprTunnelMode> = new Set(['cc-mgr', 'codex-appserver']);

export function buildMcprTunnelUrl(
  baseUrl: string,
  instanceId: string,
  mode: McprTunnelMode = 'cc-mgr',
): string {
  const url = new URL(baseUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else throw new Error('MCPRouter tunnel requires HTTP or HTTPS');
  url.pathname = `/api/project-agent-instances/${encodeURIComponent(instanceId)}/agent-tunnel`;
  // 开隧道时就声明本机要求的 cc-mgr manager 版本 —— cc-mgr 的版本闸门在 `protocol/hello`
  // 里精确比对，而**服务端子进程必须在握手之前就已经是正确版本**，所以这个要求不能等到
  // hello 才给（鸡生蛋）。服务端据此从 CDN 按版本物化 bundle 并重启子进程；做不到时回退
  // 镜像内那份，由 hello 给出可诊断的版本错配（见 docs/dev-rules/mcpr-remote-session-routing.md §4.1）。
  //
  // cc-mgr / codex-appserver 两种 mode 都要带：`codex-appserver` 并不是「另一份运行时」——
  // 服务端那条分支是 `cc-mgr codex-bridge`（`ccMgrDaemon.startBridge`），跑的仍是同一个
  // cc-mgr bundle，且同样要过 `assertCcMgrBundlePin`。只在 cc-mgr 模式声明版本会让 Codex 的
  // MCPRouter 会话继续撞 `[INVALID_BUNDLE_VERSION]`。
  //
  // 版本值来自 `CC_MGR_BUNDLE_VERSION` —— 与 `protocol/hello` 断言的值**同一份来源**；
  // 绝不能在这里另写一个字面量。老服务端只读 `mode`，未知参数被忽略（已核实），因此这个
  // 加法对老服务端天然兼容。
  const params = new URLSearchParams();
  if (mode !== 'cc-mgr') params.set('mode', mode);
  if (CC_MGR_BACKED_TUNNEL_MODES.has(mode)) params.set('bundleVersion', CC_MGR_BUNDLE_VERSION);
  url.search = params.toString();
  url.hash = '';
  return url.toString();
}

export async function openMcprTunnel(
  remoteHostId: string,
  deps: {
    getAuth?: () => Promise<{ baseUrl: string; sessionToken: string }>;
    WebSocketCtor?: WebSocketConstructor;
    mode?: McprTunnelMode;
  } = {},
): Promise<ExecStreamHandle> {
  const instanceId = parseMcprRemoteHostId(remoteHostId);
  if (!instanceId) throw new Error('[MCPR_INSTANCE_INVALID] invalid MCPRouter host id');
  const auth = await (deps.getAuth ?? (() => getMekaRouterService().getTunnelAuth()))();
  const Ctor = deps.WebSocketCtor ?? (WebSocket as unknown as WebSocketConstructor);
  const socket = new Ctor(buildMcprTunnelUrl(auth.baseUrl, instanceId, deps.mode), {
    headers: { cookie: `session=${auth.sessionToken}` },
  });
  socket.binaryType = 'nodebuffer';

  return new Promise<ExecStreamHandle>((resolve, reject) => {
    let opened = false;
    const fail = (error: Error) => {
      if (opened) return;
      opened = true;
      try {
        socket.terminate?.();
      } catch {
        /* no-op */
      }
      reject(error);
    };
    socket.on('open', () => {
      if (opened) return;
      opened = true;
      resolve(toByteStream(socket));
    });
    socket.on('error', (error) => fail(classifyError(error)));
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      fail(
        new Error(
          response.statusCode === 401 || response.statusCode === 403
            ? `[MCPR_TUNNEL_AUTH] authentication rejected (${response.statusCode})`
            : `[MCPR_TUNNEL_UNREACHABLE] handshake failed (${response.statusCode ?? 0})`,
        ),
      );
    });
    socket.on('close', (code, reason) => fail(classifyClose(code, reason)));
  });
}

function toByteStream(socket: WebSocketLike): ExecStreamHandle {
  const events = new EventEmitter();
  let closed = false;
  socket.on('message', (data) => events.emit('stdout', toBuffer(data)));
  socket.on('error', (error) => events.emit('stream-error', classifyError(error)));
  socket.on('close', (code, reason) => {
    if (closed) return;
    closed = true;
    if (code === 4003 || code === 4004) events.emit('stream-error', classifyClose(code, reason));
    events.emit('close', { code, signal: reason.length ? reason.toString('utf8') : null });
  });
  return {
    write(data) {
      if (socket.readyState !== WebSocket.OPEN)
        throw new Error('[MCPR_TUNNEL_UNREACHABLE] tunnel closed');
      socket.send(data, (error) => {
        if (error) events.emit('stream-error', classifyError(error));
      });
      return true;
    },
    end(data) {
      if (data !== undefined) this.write(data);
      socket.close(1000, 'client end');
    },
    kill() {
      if (socket.terminate) socket.terminate();
      else socket.close(1000, 'client kill');
    },
    onStdoutBytes(callback) {
      events.on('stdout', callback);
      return () => events.off('stdout', callback);
    },
    onStdout(callback) {
      const onBytes = (chunk: Buffer) => callback(chunk.toString('utf8'));
      events.on('stdout', onBytes);
      return () => events.off('stdout', onBytes);
    },
    onStderr(callback) {
      events.on('stderr', callback);
      return () => events.off('stderr', callback);
    },
    onDrain(callback) {
      events.on('drain', callback);
      return () => events.off('drain', callback);
    },
    onClose(callback) {
      events.on('close', callback);
      return () => events.off('close', callback);
    },
    onError(callback) {
      events.on('stream-error', callback);
      return () => events.off('stream-error', callback);
    },
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data.map(toBuffer));
  return Buffer.from(data);
}

function classifyError(error: Error): Error {
  return error.message.startsWith('[MCPR_')
    ? error
    : new Error(`[MCPR_TUNNEL_UNREACHABLE] ${error.message}`);
}

function classifyClose(code: number, reason: Buffer): Error {
  const detail = reason.length ? `: ${reason.toString('utf8')}` : '';
  if (code === 4003) return new Error(`[MCPR_TUNNEL_AUTH] authentication rejected${detail}`);
  if (code === 4004)
    return new Error(`[MCPR_INSTANCE_NOT_READY] project instance is not ready${detail}`);
  return new Error(`[MCPR_TUNNEL_UNREACHABLE] tunnel closed (${code})${detail}`);
}

/* ============================== mode=exec（隧道内执行） ============================== */

/**
 * MCPRouter `mode=exec`：单连接单次执行，语义等价 SSH 的 `remoteHost.exec`
 * （`bash -c <cmd>` → `{stdout, stderr, exitCode}`）。
 *
 * **wire（与 MCPRouter 侧冻结的形状，v1）**：
 *   - 客户端首行(且仅一行) NDJSON 请求：
 *     `{"version":1,"cmd":"bash","args":["-c","<script>"],"cwd"?,"env"?,"stdinBase64"?,"timeoutMs"?}`
 *   - 服务端 0..N 行流帧：`{"stream":"stdout"|"stderr","dataBase64":"..."}`
 *   - 末行：`{"exitCode":<n|null>,"signal":<string|null>,"durationMs":<n>,"truncated"?:true}`
 *     —— `truncated:true` 是**加性可选**字段：只在服务端输出触顶其 16 MiB 上限时出现，
 *     正常路径不出现。客户端把它当**失败**（`[MCPR_EXEC_TRUNCATED]`），绝不把截断输出当
 *     完整数据返回（见下）。末行的**未知字段一律忽略**（加性演进基线）。
 *   - 失败行：`{"error":{"code":"…","message":"…"}}`（非零 exitCode 是**正常**返回，
 *     不是 error 行 —— 调用方按 exitCode 语义处理，与 SSH 一致）
 *
 * 语义边界（服务端保证，客户端不重复实现）：命令在**该实例容器内**、以 runtime 同一
 * 非 root 用户执行。客户端**不**加路径/命令白名单 —— 真正的边界是容器与用户身份，
 * 客户端加白名单既拦不住也会偏离「只换字节通道」的口径。
 *
 * 单次执行 = 一条连接：调用结束（无论成功/失败）后隧道一律关闭，不做连接复用
 * （对齐 SSH 每次 `exec` 一条 channel 的既有语义，也避免把长连接的存活语义引入控制面）。
 */
export interface McprExecRequest {
  cmd: string;
  args?: readonly string[];
  /** 实例内绝对路径;缺省 = runtime 该实例用户的 HOME(与 SSH exec 的登录 shell cwd 对齐)。 */
  cwd?: string;
  env?: Record<string, string>;
  /** 经 stdin 投递的内容(file ops 写文件走这里,不进命令行)。 */
  stdin?: string;
  timeoutMs?: number;
}

export interface McprExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs?: number;
}

/**
 * 末帧（wire v1）的字段。**加性演进基线**：
 *   - 必有：`exitCode`（`number | null`）；可选：`signal`（`string | null`）、`durationMs`（number）；
 *   - 加性可选：`truncated`（`true` = 服务端输出触顶其 16 MiB 上限）；
 *   - **未知字段一律忽略**（只读下面这几个键，不因新字段报错）。
 * `truncated` 不进 `McprExecResult`：出现时 `mcprExec` 直接抛 `[MCPR_EXEC_TRUNCATED]`，
 * 调用方永远拿不到被截断的结果（见下）。
 */
interface McprExecFinalFrame {
  exitCode?: unknown;
  signal?: unknown;
  durationMs?: unknown;
  truncated?: unknown;
}

interface McprExecStreamFrame extends McprExecFinalFrame {
  stream?: unknown;
  dataBase64?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/** 默认执行预算（与 SSH file ops 的 10s/15s/30s 分级一致：调用方按需覆盖）。 */
const MCPR_EXEC_DEFAULT_TIMEOUT_MS = 30_000;

export async function mcprExec(
  remoteHostId: string,
  request: McprExecRequest,
  deps: {
    openStream?: (remoteHostId: string) => Promise<ExecStreamHandle>;
  } = {},
): Promise<McprExecResult> {
  const openStream = deps.openStream
    ?? ((hostId: string) => openMcprTunnel(hostId, { mode: 'exec' }));
  const handle = await openStream(remoteHostId);
  const timeoutMs = request.timeoutMs ?? MCPR_EXEC_DEFAULT_TIMEOUT_MS;

  const requestLine = JSON.stringify({
    version: 1,
    cmd: request.cmd,
    ...(request.args ? { args: [...request.args] } : {}),
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(request.env ? { env: request.env } : {}),
    ...(request.stdin !== undefined
      ? { stdinBase64: Buffer.from(request.stdin, 'utf8').toString('base64') }
      : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
  });

  return await new Promise<McprExecResult>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let remainder = '';
    const decoder = new StringDecoder('utf8');
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        finish(new Error(`[MCPR_EXEC_TIMEOUT] instance exec timed out after ${timeoutMs}ms`));
      }, timeoutMs)
      : undefined;
    timer?.unref?.();

    const finish = (error?: Error, result?: McprExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        handle.kill();
      } catch {
        /* best-effort：连接可能已被对端关闭 */
      }
      if (error) reject(error);
      else resolve(result!);
    };

    const consumeLine = (line: string): void => {
      if (settled || line.trim().length === 0) return;
      let frame: McprExecStreamFrame;
      try {
        frame = JSON.parse(line) as McprExecStreamFrame;
      } catch {
        finish(new Error('[MCPR_EXEC_PROTOCOL] instance exec returned a non-JSON frame'));
        return;
      }
      if (frame.error) {
        const code = typeof frame.error.code === 'string' ? frame.error.code : 'MCPR_EXEC_FAILED';
        const message = typeof frame.error.message === 'string' ? frame.error.message : 'instance exec failed';
        finish(new Error(`[${code}] ${message}`));
        return;
      }
      if (typeof frame.dataBase64 === 'string') {
        const chunk = Buffer.from(frame.dataBase64, 'base64').toString('utf8');
        if (frame.stream === 'stderr') stderr += chunk;
        else stdout += chunk;
        return;
      }
      if ('exitCode' in frame) {
        // wire v1 加性字段：服务端输出触顶 16 MiB 时置 `true`（正常路径**不出现**）。
        // **截断输出绝不能当完整数据交给调用方**：file ops 里一次被截断的 `readFile`
        // 会被当成完整文件写回/比对（agentHome、技能正文、settings 快照），静默污染且事后
        // 极难回溯。因此这里按失败处理，缺省（字段缺失或非 true）= 未截断。
        if (frame.truncated === true) {
          finish(new Error(
            '[MCPR_EXEC_TRUNCATED] instance exec output hit the runtime limit and was truncated'
              + ` (exitCode=${typeof frame.exitCode === 'number' ? frame.exitCode : 'null'})`,
          ));
          return;
        }
        finish(undefined, {
          stdout,
          stderr,
          exitCode: typeof frame.exitCode === 'number' ? frame.exitCode : null,
          signal: typeof frame.signal === 'string' ? frame.signal : null,
          ...(typeof frame.durationMs === 'number' ? { durationMs: frame.durationMs } : {}),
        });
      }
    };

    handle.onStdoutBytes((chunk: Buffer) => {
      remainder += decoder.write(chunk);
      let newline = remainder.indexOf('\n');
      while (newline !== -1) {
        const line = remainder.slice(0, newline).replace(/\r$/, '');
        remainder = remainder.slice(newline + 1);
        consumeLine(line);
        if (settled) return;
        newline = remainder.indexOf('\n');
      }
    });
    handle.onError((error: Error) => finish(classifyError(error)));
    handle.onClose((info: { code: number | null; signal: string | null }) => {
      // 末帧之前关闭 = 执行未收敛（与 SSH 的「channel 中途关闭」同语义，不伪造 exitCode 0）。
      const tail = remainder.trim();
      if (tail) consumeLine(tail);
      finish(new Error(
        info.signal
          ? `[MCPR_EXEC_ABORTED] instance exec connection closed (signal=${info.signal})`
          : `[MCPR_EXEC_ABORTED] instance exec connection closed before a result frame (exit code=${info.code ?? 'null'})`,
      ));
    });

    try {
      handle.write(`${requestLine}\n`);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
