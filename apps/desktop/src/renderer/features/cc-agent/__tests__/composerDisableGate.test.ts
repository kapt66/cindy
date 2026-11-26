// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：会话页 composer 的禁用判据（`composerIsDisabled` /
 *   `composerSettingsAreLocked`），是 `CCAgentSessionView` 传给 ChatInput 的 `disabled` /
 *   `settingsLocked` 的唯一来源。
 * - Bug／规则依据：device-link 远端交接期间（数十秒的 await）composer 必须保持禁用；
 *   PSB 远程工作区被他人占用 / 客户端离线 / 工作区未就绪时输入置灰（产品 §2.4）。
 *   旧实现靠对 JSX 表达式做源码正则守卫，新增一个门禁就要逐字改测试，行为本身没被验证。
 * - 现有覆盖缺口：原 `remoteSessionSyncInvariants` / `newMakerOrcaCreateOrder` 的源码断言只
 *   能证明「某三个条件仍出现在表达式里」，证明不了禁用结果。
 * - 最小失败输入：远端交接在途但 `disabled` 为 false → 用户补发的消息插到草稿首条之前；
 *   PSB 被占用时仍可输入 → 发出去没有接收方。
 * - tier：unit（纯函数矩阵，无渲染）。
 */
import { describe, expect, it } from 'vitest';

import {
  composerIsDisabled,
  composerSettingsAreLocked,
  type ComposerGateInput,
} from '../lib/composerDisableGate';

const base: ComposerGateInput = {
  readOnly: false,
  remoteHandoffPreparing: false,
  sessionSource: null,
  psbInputBlocked: false,
};

describe('composer disable gate', () => {
  it('keeps the composer enabled only when no external condition holds', () => {
    expect(composerIsDisabled(base)).toBe(false);
    expect(composerSettingsAreLocked({ ...base, queueEditing: false })).toBe(false);
  });

  it('disables the composer for the whole remote handoff', () => {
    // 远端交接（device-link 建目标 / 首条 pending 消费）的整段 await 期间必须禁用。
    expect(composerIsDisabled({ ...base, remoteHandoffPreparing: true })).toBe(true);
  });

  it('disables the composer while a PSB workspace blocks input', () => {
    // 被他人占用、客户端离线、工作区未就绪、会话终态：输入发出去也没有接收方。
    expect(composerIsDisabled({ ...base, psbInputBlocked: true })).toBe(true);
    expect(composerSettingsAreLocked({ ...base, psbInputBlocked: true, queueEditing: false })).toBe(true);
  });

  it('keeps readOnly and review sessions locked without breaking the matrix', () => {
    expect(composerIsDisabled({ ...base, readOnly: true })).toBe(true);
    expect(composerIsDisabled({ ...base, sessionSource: 'review' })).toBe(true);
    expect(composerSettingsAreLocked({ ...base, queueEditing: true })).toBe(true);
    // 队列编辑只锁设置，不锁「继续输入」。
    expect(composerIsDisabled({ ...base, queueEditing: true } as ComposerGateInput)).toBe(false);
  });
});
