// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：`admin/psbAdminStreamInput.ts`（「远程连接」页输入通道的唯一入口）。
 *   可观察结果：
 *   ① 桥上有 `adminStreamInput` 才返回通道；缺方法（旧 preload / 通道未落地）返回 `null`，
 *      页面据此降级为「只读观看」，不崩、不静默发不出去；
 *   ② 串行发送器按调用顺序把事件交给主进程（IPC invoke 的完成顺序不保证，而远端注入是顺序执行
 *      的：按下 / 抬起乱序会变成「按了没放」）；
 *   ③ 单条发送失败只回调错误，不打断后续输入；`dispose()` 之后不再接新事件，但已排队的事件仍要
 *      发完（卸载时补发的 keyup / pointerup 必须送达）。
 * - Bug / 规则依据：用户 2026-11-26 口径「输入只通过工作区级 `adminStreamInput` 发」；主进程批次
 *   负责通道与 preload，渲染层按契约先声明本地类型并降级。
 * - 现有覆盖缺口：此前串流只读，没有任何输入发送器；本文件钉住通道探测与保序 / 降级。
 * - 最小失败输入：桥缺方法时页面仍按可交互渲染；并发发送导致 pointerup 先于 pointerdown 到达；
 *   dispose 把已排队的释放事件一起丢掉。
 * - tier：unit（jsdom，无需 Electron / 真实 PSB）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PsbStreamInputEvent } from '../../stream/psbStreamInput';
import { createPsbStreamInputSender, tryGetAdminStreamInputBridge } from '../psbAdminStreamInput';

function installBridge(psbRemote: unknown): void {
  Object.assign(window, { electronAPI: { psbRemote } });
}

beforeEach(() => {
  installBridge({});
});

afterEach(() => {
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('tryGetAdminStreamInputBridge', () => {
  it('returns the channel only when the preload exposes adminStreamInput', () => {
    const adminStreamInput = vi.fn().mockResolvedValue(undefined);
    installBridge({ adminStreamInput });
    expect(tryGetAdminStreamInputBridge()?.adminStreamInput).toBe(adminStreamInput);

    installBridge({});
    expect(tryGetAdminStreamInputBridge()).toBeNull();

    installBridge({ adminStreamInput: 'not-a-function' });
    expect(tryGetAdminStreamInputBridge()).toBeNull();

    delete (window as { electronAPI?: unknown }).electronAPI;
    expect(tryGetAdminStreamInputBridge()).toBeNull();
  });
});

describe('createPsbStreamInputSender', () => {
  it('preserves send order even when the underlying invokes resolve out of order', async () => {
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    };
    const received: string[] = [];
    const resolveQueue: Array<() => void> = [];
    const send = vi.fn(
      (input: { workspaceId: string; event: Record<string, unknown> }) =>
        new Promise<void>((resolve) => {
          resolveQueue.push(() => {
            received.push(String(input.event.kind));
            resolve();
          });
        }),
    );
    const sender = createPsbStreamInputSender({ workspaceId: 'ws-a', send });

    sender.send({ kind: 'pointerdown', x: 1, y: 2, button: 0 });
    sender.send({ kind: 'pointerup', x: 1, y: 2, button: 0 });
    sender.send({ kind: 'keydown', key: 'a', code: 'KeyA' });

    // 第一条还没完成时，后面的事件不会并发进入 IPC（否则主进程可能乱序注入）。
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);
    expect(send).toHaveBeenCalledWith({
      workspaceId: 'ws-a',
      event: { kind: 'pointerdown', x: 1, y: 2, button: 0 },
    });

    // 只放行第一条：第二条才会进入 IPC，仍然排队等自己的完成。
    resolveQueue.shift()?.();
    await settle();
    expect(received).toEqual(['pointerdown']);
    expect(send).toHaveBeenCalledTimes(2);

    resolveQueue.shift()?.();
    await settle();
    expect(received).toEqual(['pointerdown', 'pointerup']);

    resolveQueue.shift()?.();
    await settle();
    expect(received).toEqual(['pointerdown', 'pointerup', 'keydown']);
  });

  it('keeps the chain alive after a failed send and reports it', async () => {
    const onSendError = vi.fn();
    const sent: PsbStreamInputEvent[] = [];
    const sender = createPsbStreamInputSender({
      workspaceId: 'ws-a',
      send: async (input) => {
        if (input.event.kind === 'pointerdown') throw new Error('stream not active');
        sent.push(input.event as unknown as PsbStreamInputEvent);
      },
      onSendError,
    });
    sender.send({ kind: 'pointerdown', x: 0, y: 0, button: 0 });
    sender.send({ kind: 'keyup', key: 'a', code: 'KeyA' });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(onSendError).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ kind: 'keyup', key: 'a', code: 'KeyA' }]);
  });

  it('flushes already queued events after dispose but ignores new ones', async () => {
    const sent: string[] = [];
    const sender = createPsbStreamInputSender({
      workspaceId: 'ws-a',
      send: async (input) => {
        sent.push(String(input.event.kind));
      },
    });
    sender.send({ kind: 'keyup', key: 'Shift', code: 'ShiftLeft' });
    sender.dispose();
    sender.send({ kind: 'keyup', key: 'a', code: 'KeyA' });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    // 卸载时补发的释放事件仍然要送达；dispose 之后新增的事件不再排队。
    expect(sent).toEqual(['keyup']);
  });
});
