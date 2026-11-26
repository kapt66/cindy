/**
 * PSB agent-tunnel —— 与 MCPRouter `agent-tunnel` **同一份帧契约**，只换地址与鉴权。
 *
 * ## 为什么是「同一份」
 *
 * Cindy 已经在用 MCPRouter 的隧道跑三种 Harness（`pi-mcpr-remote.ts` / `cc-manager-client.ts` /
 * `codex-remote-transport.ts`）；那些实现只依赖两件事：**一条字节流** 与 **`mode` 的选择**。
 * 远程工作区把 PSB 插在 Cindy 与客户端机器之间，但**协议一行没变**——所以这里只做：
 *
 *   - URL：`wss://<psb>/api/cindy/remote/sessions/<sessionId>/agent-tunnel?mode=…&bundleVersion=…`
 *   - 鉴权：`Authorization: Bearer <Cindy Connection JWT>`（不是 MCPRouter 的 `cookie: session=`）
 *   - 失败分类：把 PSB 的 HTTP 状态/关闭码收敛成**可归因**的 Cindy 错误码（`[PSB_*]` 前缀），
 *     上层（maker-host 的 lazy create / send 失败）才能给出"哪一边不对"的提示，而不是一句
 *     `LAZY_CREATE_FAILED`。
 *
 * ## 三条不变式
 *
 * 1. **`bundleVersion` 只在 cc-mgr / codex-appserver 上携带**（与 MCPR 同口径）：pi / exec 不消费
 *    cc-mgr 产物，声明版本只会让服务端白做一次物化。取值一律来自 `CC_MGR_BUNDLE_VERSION`，
 *    绝不在这里写第二份字面量。
 * 2. **连接是「一条隧道一次订阅」**：调用方拿到的 `ExecStreamHandle` 与 MCPR 那条逐方法同义
 *    （`write` / `end` / `kill` / `onStdoutBytes` / `onClose` / `onError`），因此
 *    `pi-mcpr-remote.ts` 里那套阶段切换逻辑可以原样接在这条流上。
 * 3. **失败不静默**：握手失败、鉴权被拒、会话终态、工作区被他人占用分别是不同的码——
 *    renderer 要用它们决定"重试 / 去占用 / 换客户端"，而不是一律"连接失败"。
 */

import { EventEmitter } from 'node:events';

import WebSocket, { type RawData } from 'ws';
import type { ExecStreamHandle } from '@cindy/maker-remote-ssh';

import { CC_MGR_BUNDLE_VERSION } from '@cindy/maker-cc-manager';

import {
  parsePsbRemoteHostId,
  psbTunnelNeedsBundleVersion,
  type PsbTunnelMode,
} from '../../shared/psb-remote-workspace.js';
import { psbWebSocketUrl } from './psbEndpoint.js';
import { psbAgentTunnelPath } from './psbClient.js';

type WebSocketLike = {
  readyState: number;
  binaryType?: string;
  send(data: string | Buffer, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?: () => void;
  on(event: 'open', callback: () => void): unknown;
  on(event: 'message', callback: (data: RawData, isBinary: boolean) => void): unknown;
  on(event: 'close', callback: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', callback: (error: Error) => void): unknown;
  on(
    event: 'unexpected-response',
    callback: (
      _request: unknown,
      response: {
        statusCode?: number;
        resume(): void;
        on(event: 'data', callback: (chunk: Buffer | string) => void): unknown;
        on(event: 'end', callback: () => void): unknown;
        on(event: 'error', callback: () => void): unknown;
      },
    ) => void,
  ): unknown;
};

/** Upgrade 被拒时读 body 的上限与兜底超时（只为拿到 PSB 的那句原因，不做重试）。 */
const PSB_TUNNEL_UPGRADE_BODY_LIMIT = 2048;
const PSB_TUNNEL_UPGRADE_BODY_TIMEOUT_MS = 2000;

/**
 * 就绪帧（PSB 0.1.159+）：Upgrade 成功后、业务字节之前的一条**文本帧**。
 *
 * PSB 的说明（协作需求 §14.1）：收到它再发首帧；`mode`/`sessionId`/`waitMs` 只作诊断。
 * 兼容：老服务端不发这条帧，所以等待是有超时的——超时后按老行为继续（新版服务端另有 1 MiB
 * 缓冲兜底，早发一首帧不会被拒）。
 */
const PSB_TUNNEL_READY_TYPE = 'agent-tunnel.ready';
/** 长连接会话（cc-mgr / codex-appserver / pi）给足客户端出站隧道建立的时间。 */
const PSB_TUNNEL_READY_TIMEOUT_MS = 5000;
/** 一次性 exec（文件操作/探针）要快：等不到就按老行为直接发。 */
const PSB_TUNNEL_READY_TIMEOUT_EXEC_MS = 1200;

/** 把 PSB 的拒绝原因附在分类错误后面（单行、截断；没有 body 就返回原错误）。 */
function withUpgradeDetail(error: Error, body: string): Error {
  const detail = body.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!detail) return error;
  return new Error(`${error.message}: ${detail}`);
}

/** 4004 的排队期原因（纯 JSON，PSB 0.1.159+）：`{reasonCode, cause, waitMs, bufferedBytes, limitBytes}`。 */
interface PsbTunnelNotReadyReason {
  reasonCode?: unknown;
  cause?: unknown;
  waitMs?: unknown;
  bufferedBytes?: unknown;
  limitBytes?: unknown;
}

function parseNotReadyReason(reason: Buffer): PsbTunnelNotReadyReason | null {
  if (reason.length === 0) return null;
  const text = reason.toString('utf8').trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as PsbTunnelNotReadyReason;
  } catch {
    return null;
  }
}



type WebSocketConstructor = new (
  url: string,
  options: {
    headers: Record<string, string>;
    agent?: unknown;
  },
) => WebSocketLike;

export interface PsbTunnelDeps {
  /** 取当前身份的 PSB Connection JWT（生产 = `getPsbConnectionToken(deps)` 的结果）。 */
  getToken?: () => Promise<{ ok: true; token: string } | { ok: false; reasonKey: string }>;
  WebSocketCtor?: WebSocketConstructor;
  /**
   * 按目标 URL 取 `ws` 的出站 agent（生产 = `createOutboundHttpAgent`，吃系统代理）。
   *
   * 为什么是按 URL 的回调而不是一个现成 agent：系统代理/ PAC 允许按目标选出口，而解析是
   * **异步**的。把 URL 交给调用方、允许返回 Promise，是为了让这条隧道与 main 里其它出网
   * （HTTP 走 `outboundFetch`、其它 WS 走 `createOutboundHttpAgent`）**同一份代理语义**，
   * 而不是"HTTP 走代理、隧道直连"这种一半一半的状态。
   */
  agentForUrl?: (url: string) => unknown | Promise<unknown>;
  /** 旧形状（同步无参工厂）：仅为兼容既有注入点保留，新代码用 `agentForUrl`。 */
  agent?: () => unknown;
  /**
   * 等 `agent-tunnel.ready` 的上限（毫秒）。生产不传：非 exec 5s、exec 1.2s。
   * 单测用它把「超时按老行为继续」压到几毫秒。
   */
  readyTimeoutMs?: number;
}

/**
 * 拼 agent-tunnel URL。导出给单测钉住。
 *
 * **`mode` 必须显式写**：MCPR 那条约定的缺省值是 `cc-mgr`（不写 = 服务端默认），但 PSB 的
 * Cindy 入口把 `mode` 当**必填**：`parseTunnelMode(undefined)` → 400「mode 必须是 … 之一
 * （收到 空）」。2026-11-26 联调因此让 cc-mgr 控制通道与 codex-appserver 的 bootstrap 全挂，
 * 只有 `pi`/`exec`（本来就写 mode）能通——不要照抄 MCPR「缺省不写」的习惯。
 *
 * **`readyFrame=1` 必须显式写（PSB 0.1.160+，opt-in 默认不发）**：PSB 的就绪文本帧
 * `agent-tunnel.ready` 只有客户端在 URL 上声明后才下发，服务端日志里显示 `readyFrame=false`
 * 就是不声明。不声明时每条长连接隧道都会固定等满 5s 的就绪兜底，exec 隧道等 1.2s——
 * 远程任务启动 / 文件操作会累计多等十几到几十秒（2026-11-26 审查）。服务端只认字面量 `1`；
 * 超时兜底（老服务端不发 ready）仍保留在 `openPsbTunnel`，两者互不替代。
 */
export function buildPsbTunnelUrl(sessionId: string, mode: PsbTunnelMode): string {
  const url = new URL(psbWebSocketUrl(psbAgentTunnelPath(sessionId)));
  const params = new URLSearchParams();
  params.set('mode', mode);
  if (psbTunnelNeedsBundleVersion(mode)) params.set('bundleVersion', CC_MGR_BUNDLE_VERSION);
  // PSB 0.1.160+：就绪帧是 opt-in，不写这一条服务端就不发（日志 `readyFrame=false`）。
  params.set('readyFrame', '1');
  url.search = params.toString();
  url.hash = '';
  return url.toString();
}

/**
 * 打开一条 PSB agent-tunnel，返回与 MCPR 同形的字节流句柄。
 *
 * `remoteHostId` 必须是 `psb:<PSB sessionId>`（由 `parsePsbRemoteHostId` 校验）；
 * 传进去的是会话身份，不是工作区身份——隧道永远是"某个会话"的通道。
 */
export async function openPsbTunnel(
  remoteHostId: string,
  deps: PsbTunnelDeps & { mode?: PsbTunnelMode } = {},
): Promise<ExecStreamHandle> {
  const sessionId = parsePsbRemoteHostId(remoteHostId);
  if (!sessionId) {
    throw new Error(
      `[PSB_SESSION_INVALID] invalid PSB remote host id (expected psb:<sessionId>): ${remoteHostId}`,
    );
  }
  const mode = deps.mode ?? 'cc-mgr';
  const auth = deps.getToken ? await deps.getToken() : null;
  if (!auth || !auth.ok) {
    throw new Error('[PSB_AUTH_REQUIRED] a Cindy connection token is required for the PSB tunnel');
  }
  const Ctor = deps.WebSocketCtor ?? (WebSocket as unknown as WebSocketConstructor);
  const url = buildPsbTunnelUrl(sessionId, mode);
  const agent = deps.agentForUrl ? await deps.agentForUrl(url) : deps.agent?.();
  const socket = new Ctor(url, {
    headers: { authorization: `Bearer ${auth.token}` },
    ...(agent === undefined ? {} : { agent }),
  });
  socket.binaryType = 'nodebuffer';

  return new Promise<ExecStreamHandle>((resolve, reject) => {
    let settled = false;
    let opened = false;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    const clearReadyTimer = (): void => {
      if (readyTimer !== null) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearReadyTimer();
      try {
        socket.terminate?.();
      } catch {
        /* best-effort：握手阶段失败时 socket 可能还没建立 */
      }
      reject(error);
    };
    /** 就绪（真实 ready 帧或超时兼容）后才把句柄交给调用方，避免在客户端隧道配对前发首帧。 */
    const proceed = (): void => {
      if (settled || !opened) return;
      settled = true;
      clearReadyTimer();
      resolve(toByteStream(socket));
    };
    socket.on('open', () => {
      if (settled || opened) return;
      opened = true;
      const timeoutMs =
        mode === 'exec' ? PSB_TUNNEL_READY_TIMEOUT_EXEC_MS : PSB_TUNNEL_READY_TIMEOUT_MS;
      readyTimer = setTimeout(proceed, Math.max(0, deps.readyTimeoutMs ?? timeoutMs));
      readyTimer.unref?.();
    });
    // 文本帧 = 控制面（PSB 0.1.159+ 的 `agent-tunnel.ready`）；业务字节必须是 binary。
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = toBuffer(data).toString('utf8').trim();
      if (text.startsWith('{') && text.includes(PSB_TUNNEL_READY_TYPE)) {
        clearReadyTimer();
        proceed();
      }
    });
    socket.on('error', (error) => fail(classifyPsbError(error)));
    socket.on('unexpected-response', (_request, response) => {
      // Upgrade 被拒时 PSB 会带一句可行动的中文原因（例如「mode 必须是 cc-mgr / codex-appserver /
      // pi / exec 之一（收到 …）」）。只拿状态码会让用户和联调都看不到真正原因（400 只剩
      // `handshake failed (400)`），所以这里读一小段 body 附在错误后面；读不到就按状态码分类。
      const status = response.statusCode;
      let body = '';
      let responseSettled = false;
      const finish = (): void => {
        if (responseSettled) return;
        responseSettled = true;
        response.resume();
        fail(withUpgradeDetail(classifyPsbHandshakeStatus(status), body));
      };
      const timer = setTimeout(finish, PSB_TUNNEL_UPGRADE_BODY_TIMEOUT_MS);
      timer.unref?.();
      response.on('data', (chunk: Buffer | string) => {
        if (body.length < PSB_TUNNEL_UPGRADE_BODY_LIMIT) body += chunk.toString();
      });
      response.on('end', () => {
        clearTimeout(timer);
        finish();
      });
      response.on('error', () => {
        clearTimeout(timer);
        finish();
      });
    });
    socket.on('close', (code, reason) => fail(classifyPsbClose(code, reason)));
  });
}

/**
 * 握手阶段的 HTTP 状态 → 可归因错误。
 *
 * 这些码与 PSB 契约（协作需求 §PSB-RW-08）一一对应：401/403 是身份问题、404 是会话不可见、
 * 409 是"会话/工作区此刻不能开隧道"（离线、非就绪、被他人占用、终态）。归因错了用户就会去做
 * 无效动作（重新登录一次解决不了"工作区被占用"）。
 */
export function classifyPsbHandshakeStatus(statusCode: number | undefined): Error {
  switch (statusCode) {
    case 401:
    case 403:
      return new Error(`[PSB_TUNNEL_AUTH] authentication rejected (${statusCode})`);
    case 404:
      return new Error('[PSB_SESSION_NOT_FOUND] session is not visible to this account');
    case 409:
      return new Error('[PSB_SESSION_NOT_READY] session or workspace is not ready for a tunnel');
    case 429:
      return new Error('[PSB_RATE_LIMITED] too many tunnel attempts');
    default:
      return new Error(`[PSB_TUNNEL_UNREACHABLE] handshake failed (${statusCode ?? 0})`);
  }
}

/** 关闭码 → 可归因错误。约定见 PSB 协作需求 §4.4.1（与 MCPR 口径一致）。 */
export function classifyPsbClose(code: number, reason: Buffer): Error {
  if (code === 4003) {
    const detail = reason.length > 0 ? `: ${reason.toString('utf8')}` : '';
    return new Error(`[PSB_TUNNEL_AUTH] authentication rejected${detail}`);
  }
  if (code === 4004) {
    const parsed = parseNotReadyReason(reason);
    if (parsed !== null) {
      const cause = typeof parsed.cause === 'string' ? parsed.cause : '';
      // 终态 / 离线不是"重试能好"的：给独立码，调用方（与用户文案）才能区分处置方式。
      if (cause === 'SESSION_STOPPED') {
        return new Error('[PSB_SESSION_STOPPED] session runtime stopped');
      }
      if (cause === 'CLIENT_OFFLINE') {
        return new Error('[PSB_CLIENT_OFFLINE] remote client is offline');
      }
      const pieces = [
        cause || (typeof parsed.reasonCode === 'string' ? parsed.reasonCode : ''),
        typeof parsed.waitMs === 'number' ? `waitMs=${parsed.waitMs}` : '',
        typeof parsed.bufferedBytes === 'number' ? `buffered=${parsed.bufferedBytes}` : '',
        typeof parsed.limitBytes === 'number' ? `limit=${parsed.limitBytes}` : '',
      ].filter((piece) => piece !== '');
      return new Error(
        `[PSB_SESSION_NOT_READY] tunnel not ready${pieces.length > 0 ? `: ${pieces.join(' ')}` : ''}`,
      );
    }
    const detail = reason.length > 0 ? `: ${reason.toString('utf8')}` : '';
    return new Error(`[PSB_SESSION_NOT_READY] session runtime is not ready${detail}`);
  }
  const detail = reason.length > 0 ? `: ${reason.toString('utf8')}` : '';
  return new Error(`[PSB_TUNNEL_UNREACHABLE] tunnel closed (${code})${detail}`);
}

function classifyPsbError(error: Error): Error {
  return error.message.startsWith('[PSB_')
    ? error
    : new Error(`[PSB_TUNNEL_UNREACHABLE] ${error.message}`);
}

function toByteStream(socket: WebSocketLike): ExecStreamHandle {
  const events = new EventEmitter();
  let closed = false;
  // 只有 binary 帧是业务字节流。文本帧是控制面（`agent-tunnel.ready` 等），不能混进 JSONL/exec 输出，
  // 否则解析层会撞到"非 JSON 帧"（PSB 协作需求 §14.1 的兼容要求）。
  socket.on('message', (data, isBinary) => {
    if (!isBinary) return;
    events.emit('stdout', toBuffer(data));
  });
  socket.on('error', (error) => events.emit('stream-error', classifyPsbError(error)));
  socket.on('close', (code, reason) => {
    if (closed) return;
    closed = true;
    if (code === 4003 || code === 4004) events.emit('stream-error', classifyPsbClose(code, reason));
    events.emit('close', { code, signal: reason.length > 0 ? reason.toString('utf8') : null });
  });
  return {
    write(data) {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error('[PSB_TUNNEL_UNREACHABLE] tunnel closed');
      }
      socket.send(data, (error) => {
        if (error) events.emit('stream-error', classifyPsbError(error));
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
