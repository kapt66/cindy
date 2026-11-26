/**
 * 测试价值
 * - 生产入口与可观察结果：`admin/psbStreamLifecycle.ts`（「远程连接」页串流生命周期的唯一判据）。
 *   可观察结果是「进入页面不会自己开播 / 离开页面会释放名额」这条用户路径：
 *   ① 页签不可见且已连接 → 释放（`shouldReleasePsbStreamOnLeave` 为 true）；
 *   ② 页签可见 / 未连接 / 正在停止 → 不重复释放；
 *   ③ 手动「启动」的可点条件：桥就绪 + 播放器可用 + PSB 支持串流 + 不在启动中。
 * - Bug / 规则依据：用户 2026-11-26 改口「切到远程连接页不要自动打开串流，一律手动启动」，
 *   唯一保留的自动行为是离开页面释放观看名额；产品正本
 *   `docs/product-rules/psb-remote-workspace-sessions.md` §2.4。
 * - 现有覆盖缺口：旧 `psbAutoStream` 判据含「可见 + 远端 running → start」，与改口后的语义相反；
 *   本文件替换它，只钉「手动启动可点性」与「离开释放」。
 * - 最小失败输入：进入页面因 `desktopSession:running` 自动调 `adminStreamStart`；页签不可见仍
 *   占着观看名额；启动中重复点启动；缺播放器/桥时仍允许启动。
 * - tier：unit（纯函数，node 环境）。
 */

import { describe, expect, it } from 'vitest';

import {
  canManuallyStartPsbStream,
  shouldReleasePsbStreamOnLeave,
  type PsbManualStartState,
  type PsbStreamLeaveState,
} from '../psbStreamLifecycle';

function startState(patch: Partial<PsbManualStartState> = {}): PsbManualStartState {
  return {
    bridgeReady: true,
    playerAvailable: true,
    capable: true,
    starting: false,
    ...patch,
  };
}

function leaveState(patch: Partial<PsbStreamLeaveState> = {}): PsbStreamLeaveState {
  return { visible: true, connected: false, stopping: false, ...patch };
}

describe('canManuallyStartPsbStream', () => {
  it('allows a manual start when the bridge, player and stream capability are ready', () => {
    expect(canManuallyStartPsbStream(startState())).toBe(true);
  });

  it('blocks a manual start while starting, without a bridge, without a player, or when incapable', () => {
    expect(canManuallyStartPsbStream(startState({ starting: true }))).toBe(false);
    expect(canManuallyStartPsbStream(startState({ bridgeReady: false }))).toBe(false);
    expect(canManuallyStartPsbStream(startState({ playerAvailable: false }))).toBe(false);
    expect(canManuallyStartPsbStream(startState({ capable: false }))).toBe(false);
  });
});

describe('shouldReleasePsbStreamOnLeave', () => {
  it('releases the viewing slot only when the page becomes invisible while connected', () => {
    expect(shouldReleasePsbStreamOnLeave(leaveState({ visible: false, connected: true }))).toBe(true);
    // 没连上就不需要释放（没有名额可释放）。
    expect(shouldReleasePsbStreamOnLeave(leaveState({ visible: false, connected: false }))).toBe(
      false,
    );
    // 页签可见时不释放（用户还在看）。
    expect(shouldReleasePsbStreamOnLeave(leaveState({ visible: true, connected: true }))).toBe(false);
    // 已在停止中：不重复发 stop。
    expect(
      shouldReleasePsbStreamOnLeave(leaveState({ visible: false, connected: true, stopping: true })),
    ).toBe(false);
  });
});
