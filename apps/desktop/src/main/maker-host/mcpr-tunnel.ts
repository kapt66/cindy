import { EventEmitter } from 'node:events';

import WebSocket, { type RawData } from 'ws';

import { parseMcprRemoteHostId } from '../../shared/meka-router.js';
import { getMekaRouterService } from '../meka-settings/ipc.js';
import type { CcManagerByteStream } from './cc-manager-client.js';

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
  on(event: 'unexpected-response', callback: (_request: unknown, response: { statusCode?: number; resume(): void }) => void): unknown;
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
  url.search = mode === 'cc-mgr' ? '' : `?mode=${encodeURIComponent(mode)}`;
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
): Promise<CcManagerByteStream> {
  const instanceId = parseMcprRemoteHostId(remoteHostId);
  if (!instanceId) throw new Error('[MCPR_INSTANCE_INVALID] invalid MCPRouter host id');
  const auth = await (deps.getAuth ?? (() => getMekaRouterService().getTunnelAuth()))();
  const Ctor = deps.WebSocketCtor ?? (WebSocket as unknown as WebSocketConstructor);
  const socket = new Ctor(buildMcprTunnelUrl(auth.baseUrl, instanceId, deps.mode), {
    headers: { cookie: `session=${auth.sessionToken}` },
  });
  socket.binaryType = 'nodebuffer';

  return new Promise<CcManagerByteStream>((resolve, reject) => {
    let opened = false;
    const fail = (error: Error) => {
      if (opened) return;
      opened = true;
      try { socket.terminate?.(); } catch { /* no-op */ }
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
      fail(new Error(
        response.statusCode === 401 || response.statusCode === 403
          ? `[MCPR_TUNNEL_AUTH] authentication rejected (${response.statusCode})`
          : `[MCPR_TUNNEL_UNREACHABLE] handshake failed (${response.statusCode ?? 0})`,
      ));
    });
    socket.on('close', (code, reason) => fail(classifyClose(code, reason)));
  });
}

function toByteStream(socket: WebSocketLike): CcManagerByteStream {
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
      if (socket.readyState !== WebSocket.OPEN) throw new Error('[MCPR_TUNNEL_UNREACHABLE] tunnel closed');
      socket.send(data, (error) => {
        if (error) events.emit('stream-error', classifyError(error));
      });
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
  if (code === 4004) return new Error(`[MCPR_INSTANCE_NOT_READY] project instance is not ready${detail}`);
  return new Error(`[MCPR_TUNNEL_UNREACHABLE] tunnel closed (${code})${detail}`);
}
