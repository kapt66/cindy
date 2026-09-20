import type { AgentKind } from '@cindy/maker-core';
import { describe, expect, it } from 'vitest';

import {
  MEKA_AGENT_CAPABILITIES,
  MEKA_AGENT_KINDS,
  mekaRuntimeMcpAgentKinds,
} from '../agentMatrix.js';

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
  });

  it('能力值与裁决逐项一致（Pi 两列都是 D1 的有意 false）', () => {
    expect(MEKA_AGENT_CAPABILITIES['claude-code']).toEqual({
      skillSnapshot: true,
      runtimeMcp: true,
    });
    expect(MEKA_AGENT_CAPABILITIES.codex).toEqual({ skillSnapshot: true, runtimeMcp: true });
    // D1：Pi **有意**不支持技能快照与 Meka 运行时 MCP。改动这两行 = 改产品裁决。
    expect(MEKA_AGENT_CAPABILITIES.pi).toEqual({ skillSnapshot: false, runtimeMcp: false });
  });

  it('runtimeMcp 支持集合正好是 claude-code + codex（Pi 必须不在其中）', () => {
    expect([...mekaRuntimeMcpAgentKinds()].sort()).toEqual(['claude-code', 'codex']);
    expect(mekaRuntimeMcpAgentKinds()).not.toContain('pi');
  });
});
