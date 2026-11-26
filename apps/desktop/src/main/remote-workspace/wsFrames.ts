/**
 * PSB 两条 WebSocket 通道（agent-tunnel 与串流观看端）共用的字节工具与字节流句柄。
 *
 * ## 为什么单独抽出来
 *
 * 这两条通道、以及 MCPRouter 的 `agent-tunnel`（`main/maker-host/mcpr-tunnel.ts`）此前各自
 * 抄了一份 `toBuffer`，`ExecStreamHandle` 的包装也几乎逐行相同。副本漂移的后果不是编译错误而是
 * 行为差异：一处把 `ArrayBuffer` 当 `Buffer` 处理、一处把文本帧混进业务字节流，最终表现为
 * 「同一个 PSB 版本，隧道偶尔解析不出帧」。帧语义（哪些帧算业务字节）属于通道协议，必须由
 * 调用方显式声明；**字节搬运本身只有一份**。
 *
 * ## 边界
 *
 * 本模块只做三件事：`RawData → Buffer` 归一、跨 IPC 的 `ArrayBuffer` 拷贝、把一条已经
 * 建立的 WS 包装成 `ExecStreamHandle`。鉴权、URL、失败分类、握手顺序仍留在各自的通道实现里
 * （它们的差异是协议事实，不该被抽象掉）。
 *
 * `mcpr-tunnel.ts` 与 PSB 的两条通道（`psbTunnel.ts`、`streamViewer.ts`）都走本模块：
 * MCPR 用 `createExecByteStream(socket, { classifyError, classifyClose, closedErrorCodes: [4003, 4004] })`
 * 加 `toBuffer`，PSB 的 agent-tunnel 额外声明 `binaryOnly`（文本帧是 `agent-tunnel.ready`
 * 控制面）与就绪前缓冲（`initialFrames` / `bufferUntilSubscribed`）。
 */

import { EventEmitter } from 'node:events';

import type { RawData } from 'ws';
import type { ExecStreamHandle } from '@cindy/maker-remote-ssh';

/** `ws` 的 OPEN 常量（不 import `ws` 运行时：本模块也要能在只用结构类型的上下文里加载）。 */
const WS_OPEN = 1;

/**
 * `ws` 发送/接收面的最小结构（单测注入假实现，生产就是 `ws`）。
 *
 * 放在这里而不是各文件各写一份：`message` 的 `isBinary` 参数是「文本帧不是业务字节」这条
 * 协议的判据，类型漂移会让调用方误以为所有帧都该转发。
 */
export type PsbWebSocketLike = {
  readyState: number;
  binaryType?: string;
  send(data: string | Buffer, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?: () => void;
  on(event: 'open', callback: () => void): unknown;
  on(event: 'message', callback: (data: RawData, isBinary: boolean) => void): unknown;
  on(event: 'close', callback: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', callback: (error: Error) => void): unknown;
};

/** WS 帧 → Buffer（`ws` 的 `RawData` 三种形态：Buffer / ArrayBuffer / Buffer[]）。 */
export function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data.map(toBuffer));
  return Buffer.from(data);
}

/**
 * WS 帧 → 可跨 IPC 传递的 `ArrayBuffer`。
 *
 * **必须拷贝**：`nodebuffer` 的底层是 Buffer 池，复用同一段内存会被后续帧覆写；渲染层拿到的
 * 是异步处理的结构化克隆，不拷贝就会出现「画面偶发撕裂 / 花屏」这类无法归因的问题。
 */
export function toArrayBuffer(data: RawData): ArrayBuffer {
  const buffer = toBuffer(data);
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}

export interface ExecByteStreamOptions {
  /** 网络层错误 → 通道自己的可归因错误（只在域内包一层，不把外层码吞掉）。 */
  classifyError(error: Error): Error;
  /** 关闭码 → 通道自己的可归因错误（`onError` 的载荷，`onClose` 仍带原始码）。 */
  classifyClose(code: number, reason: Buffer): Error;
  /**
   * 这些关闭码在 `onClose` 之前再发一次 `onError`（例：PSB 的 4003 鉴权被拒 / 4004 未就绪）。
   * 缺省 `[]`：关闭就是关闭。
   */
  closedErrorCodes?: readonly number[];
  /**
   * 只把 **binary** 帧当业务字节（PSB agent-tunnel 的文本帧是控制面
   * `agent-tunnel.ready`，混进 JSONL/exec 输出会让解析层撞到「非 JSON 帧」）。
   * 缺省 `false`（MCPRouter 的隧道没有控制帧，全部帧都是业务字节）。
   */
  binaryOnly?: boolean;
  /**
   * 握手期已经收到的字节（按序），在调用方**第一次订阅 stdout** 时回放。
   *
   * 为什么不能在 `createExecByteStream` 返回时直接 emit：`openPsbTunnel` 是 `await` 返回的，
   * 调用方拿到句柄后才挂监听；握手期（wait for `agent-tunnel.ready`）的服务端帧如果立刻
   * emit，就会在「没有监听者」的窗口里被丢掉——表现为「连接成功但首帧缺失」。
   */
  initialFrames?: readonly Buffer[];
  /**
   * 首个订阅者出现前的 stdout 帧先缓冲（与 `initialFrames` 同一个窗口）。缺省 `false`：
   * 没有监听者就丢弃（与旧行为一致）。上限 {@link EXEC_STREAM_BUFFERED_BYTES}，超出丢最旧的
   * 并回调 `onBufferedOverflow`（调用方决定如何告警）。
   */
  bufferUntilSubscribed?: boolean;
  /** 缓冲区丢帧时的回调（只在真的丢弃时调用一次，直到恢复缓冲额度）。 */
  onBufferedOverflow?: (dropped: { frames: number; bytes: number }) => void;
}

/** 握手期回放缓冲的上限（1 MiB）：一条 PSB 隧道在就绪前正常只有几百字节的握手帧。 */
export const EXEC_STREAM_BUFFERED_BYTES = 1024 * 1024;

/**
 * 把一条已经建立（或正在建立）的 WS 包装成 `ExecStreamHandle`。
 *
 * 先挂监听再交给调用方（`resolve`）是有意为之：握手期到达的帧不能丢。调用方若需要
 * 缓冲握手期数据，应自己先挂 `message` 监听并在交给本函数前回放（见 `psbTunnel.ts`）。
 */
export function createExecByteStream(
  socket: PsbWebSocketLike,
  options: ExecByteStreamOptions,
): ExecStreamHandle {
  const events = new EventEmitter();
  let closed = false;
  const closedErrorCodes = options.closedErrorCodes ?? [];
  /** 首个订阅者出现前的缓冲（见 `bufferUntilSubscribed` / `initialFrames` 的说明）。 */
  const buffered: Buffer[] = [...(options.initialFrames ?? [])];
  let bufferedBytes = buffered.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  let droppedFrames = 0;
  let droppedBytes = 0;
  let subscribed = false;

  function emitStdout(chunk: Buffer): void {
    if (options.bufferUntilSubscribed === true && !subscribed) {
      buffered.push(chunk);
      bufferedBytes += chunk.byteLength;
      while (bufferedBytes > EXEC_STREAM_BUFFERED_BYTES && buffered.length > 0) {
        const dropped = buffered.shift();
        if (!dropped) break;
        bufferedBytes -= dropped.byteLength;
        droppedFrames += 1;
        droppedBytes += dropped.byteLength;
      }
      if (droppedFrames > 0) {
        const report = { frames: droppedFrames, bytes: droppedBytes };
        droppedFrames = 0;
        droppedBytes = 0;
        options.onBufferedOverflow?.(report);
      }
      return;
    }
    events.emit('stdout', chunk);
  }

  /** 首个订阅者出现时把缓冲按序回放一次（多个订阅者只回放给第一个消费者）。 */
  function flushBuffered(): void {
    if (subscribed) return;
    subscribed = true;
    if (buffered.length === 0) return;
    const chunks = buffered.splice(0, buffered.length);
    bufferedBytes = 0;
    for (const chunk of chunks) events.emit('stdout', chunk);
  }

  socket.on('message', (data, isBinary) => {
    if (options.binaryOnly === true && isBinary === false) return;
    emitStdout(toBuffer(data));
  });
  socket.on('error', (error) => events.emit('stream-error', options.classifyError(error)));
  socket.on('close', (code, reason) => {
    if (closed) return;
    closed = true;
    if (closedErrorCodes.includes(code)) {
      events.emit('stream-error', options.classifyClose(code, reason));
    }
    events.emit('close', { code, signal: reason.length > 0 ? reason.toString('utf8') : null });
  });
  return {
    write(data) {
      if (socket.readyState !== WS_OPEN) {
        throw options.classifyError(new Error('tunnel is not open'));
      }
      socket.send(data, (error) => {
        if (error) events.emit('stream-error', options.classifyError(error));
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
      flushBuffered();
      return () => events.off('stdout', callback);
    },
    onStdout(callback) {
      const onBytes = (chunk: Buffer) => callback(chunk.toString('utf8'));
      events.on('stdout', onBytes);
      flushBuffered();
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
