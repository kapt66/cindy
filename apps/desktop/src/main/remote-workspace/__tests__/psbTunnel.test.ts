/**
 * psbTunnel 单测 —— 握手拒绝原因、就绪帧等待、bin/文本分流、4004 的结构化原因。
 *
 * 测试价值
 * - 生产入口与可观察结果：`openPsbTunnel('psb:<sessionId>')` 是 psb: 会话唯一的字节通道入口。
 *   它决定「什么时候把句柄交给调用方（发首帧）」与「哪些帧算业务字节」，两者出错的表现分别是
 *   间歇 4004 与 `non-JSON frame`——都是 2026-11-26 联调真实踩到过的问题。
 * - Bug／规则依据：`docs/dev-rules/psb-remote-session-transport.md` §10.4/§10.7 与 PSB
 *   `协作需求.md` §14.1（ready 帧 + isBinary 分流 + 4004 JSON cause）。
 * - 现有覆盖缺口：此前的 `classifyPsbHandshakeStatus` 只覆盖状态码分类；就绪帧与 4004 结构化
 *   原因是本轮新增契约。
 * - 最小失败输入：Upgrade 400 + body；只有文本 ready 帧、没有 binary；超时无 ready；
 *   4004 + `{"cause":"ATTACH_TIMEOUT"}` / `{"cause":"SESSION_STOPPED"}`。
 * - tier：unit（假 WebSocket 构造器，无真实网络）。
 * - 实测耗时：单独运行 < 1s。
 */

import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PsbTunnelError,
  classifyPsbClose,
  openPsbTunnel,
  readPsbTunnelReadyFrameCapability,
  resetPsbTunnelReadyFrameProbeForTest,
} from '../psbTunnel';
import type { PsbTunnelTokenResult } from '../psbTunnel';

class FakeSocket extends EventEmitter {
  /** 本次用例里真实交给隧道层的 socket（断言「失败发生在建连之前」）。 */
  static instances: FakeSocket[] = [];

  readyState = 1;
  binaryType?: string;
  url = 'wss://unused';
  terminate = () => {
    this.readyState = 3;
  };
  send(): void {}
  close(): void {}
}

interface SocketScript {
  /** `open` 之后依次投递的帧；`binary=false` 表示文本（控制面）。 */
  frames?: Array<{ data: string | Buffer; binary: boolean }>;
  /** 直接拒绝的 Upgrade（status + body）。 */
  reject?: { status: number; body: string };
}

function createSocketCtor(socket: FakeSocket, script: SocketScript) {
  return class {
    constructor(_url: string) {
      FakeSocket.instances.push(socket);
      queueMicrotask(() => {
        if (script.reject) {
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
            resume: () => void;
          };
          response.statusCode = script.reject.status;
          response.resume = () => {};
          socket.emit('unexpected-response', {}, response);
          setImmediate(() => {
            response.emit('data', Buffer.from(script.reject!.body, 'utf8'));
            response.emit('end');
          });
          return;
        }
        socket.emit('open');
        const frames = script.frames ?? [];
        let delay = 0;
        for (const frame of frames) {
          delay += 1;
          setTimeout(() => {
            socket.emit('message', Buffer.from(frame.data), frame.binary);
          }, delay);
        }
      });
      return socket;
    }
  } as never;
}

function baseDeps(socket: FakeSocket, script: SocketScript, extra: Record<string, unknown> = {}) {
  return {
    getToken: async () => ({ ok: true as const, token: 'token' }),
    WebSocketCtor: createSocketCtor(socket, script),
    ...extra,
  };
}

describe('openPsbTunnel — 握手拒绝与就绪帧', () => {
  beforeEach(() => {
    // 能力探测是进程级状态：每个用例从「未知」开始，避免顺序依赖。
    resetPsbTunnelReadyFrameProbeForTest();
    FakeSocket.instances = [];
  });

  it('Upgrade 400：错误里带 PSB 的 body 原因', async () => {
    const socket = new FakeSocket();
    await expect(
      openPsbTunnel(
        'psb:session-1',
        baseDeps(socket, {
          reject: {
            status: 400,
            body: '{"error":{"code":"BAD_REQUEST","message":"mode 必须是 cc-mgr / codex-appserver / pi / exec 之一（收到 codex）。"}}',
          },
        }),
      ),
    ).rejects.toThrow(/\[PSB_TUNNEL_UNREACHABLE\] handshake failed \(400\): .*mode 必须是/);
  });

  it('没有 body 时按状态码分类（不造出空冒号）', async () => {
    const socket = new FakeSocket();
    await expect(
      openPsbTunnel('psb:session-1', baseDeps(socket, { reject: { status: 404, body: '' } })),
    ).rejects.toThrow(/^\[PSB_SESSION_NOT_FOUND\] session is not visible to this account$/);
  });

  it('等到 agent-tunnel.ready 才把句柄交出去；文本帧不进业务字节流', async () => {
    const socket = new FakeSocket();
    const opened = openPsbTunnel(
      'psb:session-1',
      baseDeps(socket, {
        frames: [
          { data: '{"type":"agent-tunnel.ready","sessionId":"session-1","mode":"pi","at":1,"waitedMs":5}', binary: false },
          { data: 'hello-bytes', binary: true },
        ],
      }),
    );
    const handle = await opened;
    const received: string[] = [];
    handle.onStdout((chunk) => received.push(chunk));
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 只有 binary 帧被当成业务输出；ready 文本帧不出现。
    expect(received.join('')).toBe('hello-bytes');
  });

  it('超时没有 ready 帧时按老行为继续（老服务端兼容）', async () => {
    const socket = new FakeSocket();
    const handle = await openPsbTunnel(
      'psb:session-1',
      baseDeps(socket, { frames: [{ data: 'early-bytes', binary: true }] }, { readyTimeoutMs: 10 }),
    );
    expect(handle).toBeTruthy();
    // 一次探测后判定「这个服务端不发 ready 帧」：后续连接不再白等（见下一条用例）。
    expect(readPsbTunnelReadyFrameCapability()).toBe('unsupported');
  });

  it('就绪前到达的 binary 帧不丢：句柄交给调用方、首个订阅者出现时按序回放', async () => {
    const socket = new FakeSocket();
    const handle = await openPsbTunnel(
      'psb:session-1',
      baseDeps(socket, {
        frames: [
          // 服务端在 ready 之前就发了业务首帧（cc-mgr hello / pi RPC 输出）。
          { data: 'early-bytes', binary: true },
          { data: '{"type":"agent-tunnel.ready","mode":"cc-mgr"}', binary: false },
        ],
      }),
    );
    const received: string[] = [];
    handle.onStdout((chunk) => received.push(chunk));
    // 回放是同步的（首个订阅者出现时按序 emit）。
    expect(received.join('')).toBe('early-bytes');
    expect(readPsbTunnelReadyFrameCapability()).toBe('supported');
  });

  it('探测到老服务端不支持 ready 帧后，后续连接在 open 时立即交句柄（不再固定等 5s）', async () => {
    // 第一次：等不到 ready → 判定 unsupported。
    const first = new FakeSocket();
    await openPsbTunnel(
      'psb:session-1',
      baseDeps(first, {}, { readyTimeoutMs: 5 }),
    );
    expect(readPsbTunnelReadyFrameCapability()).toBe('unsupported');

    // 第二次：即使把兜底超时设成 5s，也必须在 open 时立即返回（探测结果被复用）。
    const second = new FakeSocket();
    const opened = openPsbTunnel('psb:session-2', baseDeps(second, {}));
    const raced = await Promise.race([
      opened.then(() => 'opened' as const),
      new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 60);
        timer.unref?.();
      }),
    ]);
    expect(raced).toBe('opened');
  });

  it('就绪前业务字节超过 1MiB：丢最旧的帧，且只 warn 一次（不静默丢业务字节）', async () => {
    // 服务端出站缓冲也有 1MiB 上限：握手期就灌超过它说明对端行为异常 / 首帧丢失，必须留证据。
    // 逐帧 warn 会被刷屏，所以只报第一次（累计帧数在 fields 里）。
    const socket = new FakeSocket();
    const warn = vi.fn();
    const chunk = 512 * 1024;
    const handle = await openPsbTunnel('psb:session-1', {
      ...baseDeps(
        socket,
        {
          frames: [
            { data: Buffer.alloc(chunk, 1), binary: true },
            { data: Buffer.alloc(chunk, 2), binary: true },
            { data: Buffer.alloc(chunk, 3), binary: true },
          ],
        },
        { readyTimeoutMs: 40 },
      ),
      logger: { warn },
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('pre-ready');
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      sessionId: 'session-1',
      mode: 'cc-mgr',
      limitBytes: 1024 * 1024,
      frames: 1,
    });

    // 句柄拿到的是「丢最旧之后」的缓冲：总字节不超过上限，且保留的是最新的两帧。
    let total = 0;
    handle.onStdoutBytes((bytes) => {
      total += bytes.byteLength;
    });
    expect(total).toBe(2 * chunk);
  });

  it('取 token 失败按身份归因（不再一律 AUTH_REQUIRED）：未登录/非企业组织 vs 签发通道失败', async () => {
    const cases: ReadonlyArray<{
      readonly token: PsbTunnelTokenResult;
      readonly code: string;
      readonly messageKey: string;
    }> = [
      {
        token: { ok: false, kind: 'signed-out', reasonKey: 'remoteWorkspace.status.needLogin' },
        code: 'PSB_AUTH_REQUIRED',
        messageKey: 'remoteWorkspace.status.needLogin',
      },
      {
        token: { ok: false, kind: 'need-org', reasonKey: 'remoteWorkspace.status.needOrg' },
        code: 'PSB_AUTH_REQUIRED',
        messageKey: 'remoteWorkspace.status.needOrg',
      },
      {
        // 旧装配只给 reasonKey（不带 kind）：error.auth = 签发通道失败，按网络失败归因。
        token: { ok: false, reasonKey: 'remoteWorkspace.error.auth' },
        code: 'PSB_TUNNEL_UNREACHABLE',
        messageKey: 'remoteWorkspace.error.unreachable',
      },
    ];
    for (const item of cases) {
      const socket = new FakeSocket();
      const error = await openPsbTunnel(
        'psb:session-1',
        baseDeps(socket, {}, { getToken: async () => item.token }),
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(PsbTunnelError);
      expect((error as PsbTunnelError).code).toBe(item.code);
      expect((error as PsbTunnelError).failure?.messageKey).toBe(item.messageKey);
      // 失败发生在建连之前：socket 构造器没有被调用（没有占名额的连接）。
      expect(FakeSocket.instances).toHaveLength(0);
    }
  });
});

describe('classifyPsbClose — 4004 的结构化原因', () => {
  it('ATTACH_TIMEOUT：保留不重试诊断字段', () => {
    const error = classifyPsbClose(
      4004,
      Buffer.from(
        '{"reasonCode":"TUNNEL_NOT_READY","cause":"ATTACH_TIMEOUT","waitMs":10000,"bufferedBytes":0,"limitBytes":1048576}',
      ),
    );
    expect(error.message).toContain('[PSB_SESSION_NOT_READY]');
    expect(error.message).toContain('ATTACH_TIMEOUT');
    expect(error.message).toContain('waitMs=10000');
    expect(error.message).toContain('limit=1048576');
  });

  it('SESSION_STOPPED / CLIENT_OFFLINE 各自成独立码（语义上不该按"未就绪"重试）', () => {
    expect(classifyPsbClose(4004, Buffer.from('{"cause":"SESSION_STOPPED"}')).message).toContain(
      '[PSB_SESSION_STOPPED]',
    );
    expect(classifyPsbClose(4004, Buffer.from('{"cause":"CLIENT_OFFLINE"}')).message).toContain(
      '[PSB_CLIENT_OFFLINE]',
    );
  });

  it('非 JSON 原因保持原中文透传（非排队期）', () => {
    const error = classifyPsbClose(4004, Buffer.from('会话已停止。'));
    expect(error.message).toBe('[PSB_SESSION_NOT_READY] session runtime is not ready: 会话已停止。');
  });
});
