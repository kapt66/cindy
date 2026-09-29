import { EventEmitter } from 'node:events';

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

export function buildMcprTunnelUrl(
  baseUrl: string,
  instanceId: string,
  mode: 'cc-mgr' | 'codex-appserver' = 'cc-mgr',
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
  // **两种 mode 都要带**：`codex-appserver` 并不是「另一份运行时」—— 服务端那条分支是
  // `cc-mgr codex-bridge`（`ccMgrDaemon.startBridge`），跑的仍是同一个 cc-mgr bundle，
  // 且同样要过 `assertCcMgrBundlePin`。只在 cc-mgr 模式声明版本会让 Codex 的
  // MCPRouter 会话继续撞 `[INVALID_BUNDLE_VERSION]`。
  //
  // 版本值来自 `CC_MGR_BUNDLE_VERSION` —— 与 `protocol/hello` 断言的值**同一份来源**；
  // 绝不能在这里另写一个字面量。老服务端只读 `mode`，未知参数被忽略（已核实），因此这个
  // 加法对老服务端天然兼容。
  const params = new URLSearchParams();
  if (mode !== 'cc-mgr') params.set('mode', mode);
  params.set('bundleVersion', CC_MGR_BUNDLE_VERSION);
  url.search = params.toString();
  url.hash = '';
  return url.toString();
}

export async function openMcprTunnel(
  remoteHostId: string,
  deps: {
    getAuth?: () => Promise<{ baseUrl: string; sessionToken: string }>;
    WebSocketCtor?: WebSocketConstructor;
    mode?: 'cc-mgr' | 'codex-appserver';
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
