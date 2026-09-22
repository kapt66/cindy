import type { AgentKind } from '@cindy/maker-core';
import { describe, expect, it } from 'vitest';

import {
  MEKA_AGENT_CAPABILITIES,
  MEKA_AGENT_KINDS,
  mekaRuntimeMcpAgentKinds,
} from '../mekaAgentMatrix.js';

/**
 * 穷尽性第二道锁：`Record<AgentKind, true>` 让 maker-core 新增 `AgentKind` 时**这里
 * 也编译失败**，强迫维护者回来面对矩阵与断言（矩阵本身是
 * `Readonly<Record<AgentKind, ...>>`，漏填直接编译失败）。
 */
const ALL_AGENT_KINDS: Readonly<Record<AgentKind, true>> = {
  'claude-code': true,
  codex: true,
  pi: true,
};

describe('Meka agent 能力矩阵', () => {
  it('对每一个 AgentKind 都有显式条目', () => {
    expect([...MEKA_AGENT_KINDS].sort()).toEqual(Object.keys(ALL_AGENT_KINDS).sort());
    expect(MEKA_AGENT_KINDS).toHaveLength(3);
  });

  it('键集合不可变（矩阵是真相源，不允许运行期就地改写）', () => {
    expect(Object.isFrozen(MEKA_AGENT_KINDS)).toBe(true);
    // 只冻结数组容器是不够的：矩阵对象与每个能力条目都必须一并冻结，否则
    // `as`／`any` 就能在运行期改写矩阵，让注册期断言与矩阵脱钩。
    expect(Object.isFrozen(MEKA_AGENT_CAPABILITIES)).toBe(true);
    for (const agentKind of MEKA_AGENT_KINDS) {
      expect(Object.isFrozen(MEKA_AGENT_CAPABILITIES[agentKind])).toBe(true);
    }
  });

  it('能力值与裁决逐项一致（三个 AgentKind 都是完整 Meka 能力）', () => {
    expect(MEKA_AGENT_CAPABILITIES['claude-code']).toEqual({
      skillSnapshot: true,
      runtimeMcp: true,
    });
    expect(MEKA_AGENT_CAPABILITIES.codex).toEqual({ skillSnapshot: true, runtimeMcp: true });
    // Pi 的两列在 2026-09-21 由「D1 有意 false」翻转为 true：runtimeMcp 走与 codex
    // 同形态的进程级 bridge，skillSnapshot 走 pi 既有的显式 `--skill` 通道。
    // 改动这两行 = 改产品裁决，必须同时改本断言与 docs/dev-rules/meka-injection-layer.md。
    expect(MEKA_AGENT_CAPABILITIES.pi).toEqual({ skillSnapshot: true, runtimeMcp: true });
  });

  it('runtimeMcp 支持集合覆盖全部 AgentKind（Pi 现在在集合里）', () => {
    expect([...mekaRuntimeMcpAgentKinds()].sort()).toEqual(['claude-code', 'codex', 'pi']);
    expect(mekaRuntimeMcpAgentKinds()).toContain('pi');
  });
});

