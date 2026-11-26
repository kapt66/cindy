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

import { describe, expect, it } from 'vitest';

import { classifyPsbClose, openPsbTunnel } from '../psbTunnel';

class FakeSocket extends EventEmitter {
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
