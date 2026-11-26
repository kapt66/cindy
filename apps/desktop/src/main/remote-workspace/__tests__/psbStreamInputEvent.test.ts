/**
 * 串流输入事件的 IPC 边界校验（`validatePsbStreamInputEvent`）。
 *
 * 测试价值
 * - 生产入口与可观察结果：`main/remote-workspace/ipc.ts` 的 `readStreamInputEvent` 在产生任何
 *   副作用之前调用本函数；拒绝即 `INVALID_PARAMS`，渲染层拿不到「已转发」的假成功。
 * - Bug／规则依据：输入帧进的是**PSB 共享中继**（网页观看端与 Cindy 同一条），服务端没有
 *   只读/仲裁闸门，单帧上限 4KiB，未知 `kind` 会被计成非法消息。规则见
 *   `docs/dev-rules/psb-remote-session-transport.md` §12.2 / §12.5。
 * - 现有覆盖缺口：`streamViewer.test.ts` 只覆盖 WS 下发与归因，从来不校验**上行事件**
 *   的形状；渲染层一次 bug（把任意对象塞进 `event`）没有任何运行期证据能拦住。
 * - 最小失败输入：`{kind:'input'}`（把外层 kind 当内层）、`{kind:'pointermove', pad:<超大>}`
 *   （完整帧 4097 字节）、`null` / 数组；以及恰好 4096 字节的边界事件必须放行。
 * - tier：unit（纯函数，无 IO / 无 Electron）。
 * - 实测耗时：单文件 `<1s`（含 vitest 启动）。
 */

import { describe, expect, it } from 'vitest';

import {
  PSB_STREAM_INPUT_KINDS,
  PSB_STREAM_INPUT_MAX_FRAME_BYTES,
  validatePsbStreamInputEvent,
} from '../../../shared/psb-workspace-admin';

/** 造一条完整上行帧恰好 `totalBytes` 字节的 `keydown` 事件（纯 ASCII，字符数=字节数）。 */
function keydownOfFrameBytes(totalBytes: number): Record<string, unknown> {
  const base = JSON.stringify({ kind: 'input', event: { kind: 'keydown', pad: '' } });
  return { kind: 'keydown', pad: 'x'.repeat(totalBytes - base.length) };
}

describe('PSB 串流输入事件校验', () => {
  it('允许协议里的每一种 kind，并原样返回事件（不做字段裁剪）', () => {
    for (const kind of PSB_STREAM_INPUT_KINDS) {
      const event = { kind, x: 1, y: 2, button: 0, key: 'a', code: 'KeyA', deltaX: 0, deltaY: 1 };
      const validation = validatePsbStreamInputEvent(event);
      expect(validation, `${kind} 应被接受`).toMatchObject({ ok: true });
      if (validation.ok) expect(validation.event).toBe(event);
    }
  });

  it('拒绝非对象与未知 kind（外层 {kind:input} 混进来也算未知）', () => {
    for (const raw of [null, undefined, 'pointermove', 42, [], [{ kind: 'pointermove' }]]) {
      expect(validatePsbStreamInputEvent(raw).ok).toBe(false);
    }
    const outerKind = validatePsbStreamInputEvent({ kind: 'input', event: {} });
    expect(outerKind).toMatchObject({ ok: false });
    if (!outerKind.ok) expect(outerKind.reason).toContain('event.kind must be one of');
  });

  it('完整帧 4096 字节放行，4097 字节拒绝（限制的是整帧而不是内层对象）', () => {
    const exact = validatePsbStreamInputEvent(
      keydownOfFrameBytes(PSB_STREAM_INPUT_MAX_FRAME_BYTES),
    );
    expect(exact.ok).toBe(true);

    const over = validatePsbStreamInputEvent(
      keydownOfFrameBytes(PSB_STREAM_INPUT_MAX_FRAME_BYTES + 1),
    );
    expect(over).toMatchObject({ ok: false });
    if (!over.ok) expect(over.reason).toContain(String(PSB_STREAM_INPUT_MAX_FRAME_BYTES));
  });

  it('不可 JSON 序列化的事件被拒绝（不是先转发再失败）', () => {
    const cyclic: Record<string, unknown> = { kind: 'pointermove' };
    cyclic['self'] = cyclic;

    expect(validatePsbStreamInputEvent(cyclic)).toMatchObject({ ok: false });
  });
});
