/**
 * 测试价值
 * - 生产入口与可观察结果：`isMekaAssistantSession` / `hasMekaAssistantBinding` 是跨层唯一的
 *   Meka 助理会话身份判定；侧栏分组、启动注入、IM／hook 冷启动都按它决定用户是否得到 Meka
 *   提示词／角色能力。判错会让新会话丢失身份，或让普通任务被灌进 Meka 注入。
 * - Bug／规则依据：`docs/dev-rules/meka-assistant-session-binding.md` §1（2026-11-20 起身份
 *   只由持久化绑定 `(mekaProjectId, mekaRoleId)` 决定，`workspaceKind='meka'` 仅旧数据兼容）。
 * - 现有覆盖缺口：改动前身份就是 `workspaceKind==='meka'`，没有任何测试保护「普通 kind + 成对
 *   绑定算 Meka」「半绑定不算身份」这两个新分支。
 * - 最小失败输入：`{ workspaceKind: 'project', mekaProjectId: 'p', mekaRoleId: 'r' }` 旧实现
 *   返回 false（新会话丢身份）；`{ workspaceKind: 'project', mekaProjectId: 'p' }` 若被当成
 *   身份则开始注入一个没有角色的 Meka 会话。
 * - tier：unit（纯函数，无 I/O）。
 */
import { describe, expect, it } from 'vitest';

import {
  hasMekaAssistantBinding,
  isMekaAssistantSession,
} from '../mekaAssistantSession.js';

describe('isMekaAssistantSession', () => {
  it.each([
    ['complete binding with an ordinary kind', { workspaceKind: 'project', mekaProjectId: 'p', mekaRoleId: 'r' }, true],
    ['complete binding with the dialogue kind', { workspaceKind: 'dialogue', mekaProjectId: 'p', mekaRoleId: 'r' }, true],
    ['legacy meka kind without binding', { workspaceKind: 'meka', mekaProjectId: null, mekaRoleId: null }, true],
    ['legacy role marker only', { workspaceKind: null, mekaRole: 'planner' }, true],
    ['ordinary task', { workspaceKind: 'project', mekaProjectId: null, mekaRoleId: null, mekaRole: null }, false],
    ['half binding (project only)', { workspaceKind: 'project', mekaProjectId: 'p', mekaRoleId: null }, false],
    ['half binding (role only)', { workspaceKind: 'project', mekaProjectId: null, mekaRoleId: 'r' }, false],
    ['missing session', null, false],
  ] as const)('classifies %s as Meka assistant', (_name, session, expected) => {
    expect(isMekaAssistantSession(session)).toBe(expected);
  });
});

describe('hasMekaAssistantBinding', () => {
  it('requires both ids, not just one', () => {
    expect(hasMekaAssistantBinding({ mekaProjectId: 'p', mekaRoleId: 'r' })).toBe(true);
    expect(hasMekaAssistantBinding({ mekaProjectId: 'p' })).toBe(false);
    expect(hasMekaAssistantBinding({ mekaRoleId: 'r' })).toBe(false);
    expect(hasMekaAssistantBinding({ mekaRole: 'planner' })).toBe(false);
    expect(hasMekaAssistantBinding(undefined)).toBe(false);
  });
});
