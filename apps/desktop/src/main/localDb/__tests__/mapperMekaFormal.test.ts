import { describe, expect, it } from 'vitest';

import {
  parseFormalContentJson,
  sessionCreateToRow,
  sessionPatchToRow,
  sessionToCamel,
} from '../mapper';

// 2026-11-20 起新会话不再写 `workspace_kind='meka'`：显式 Meka 创建的绑定列照写，行是普通
// kind（有项目目录 → project，兜底目录 → dialogue）。规则见
// docs/dev-rules/meka-assistant-session-binding.md §1/§5。
describe('Meka session mapper', () => {
  it('freezes the project, role and provider-neutral formal requirement on create', () => {
    const content = { title: 'Fix login', description: 'Windows fails' };
    const row = sessionCreateToRow('s1', {
      workspaceKind: 'project',
      workingDir: 'C:\\work',
      mekaProjectId: ' project-a ',
      mekaRoleId: ' developer ',
      isFormal: true,
      formal: {
        type: 'jira',
        link: 'https://example.atlassian.net/browse/APP-7',
        ref: 'APP-7',
        content,
      },
    }, 100);

    expect(row).toMatchObject({
      workspaceKind: 'project',
      mekaProjectId: 'project-a',
      mekaRoleId: 'developer',
      mekaRole: null,
      isFormal: 1,
      formalType: 'jira',
      formalRef: 'APP-7',
      formalContentJson: JSON.stringify(content),
    });

    const session = sessionToCamel({ ...row, messageCount: 0 } as Parameters<typeof sessionToCamel>[0]);
    expect(session).toMatchObject({
      workspaceKind: 'project',
      mekaProjectId: 'project-a',
      mekaRoleId: 'developer',
      isFormal: true,
      formal: { type: 'jira', ref: 'APP-7', content },
    });
  });

  it.each([
    ['project only', { mekaProjectId: 'project-a' }],
    ['role only', { mekaRoleId: 'developer' }],
  ] as const)('rejects a half binding instead of persisting a dangling identity (%s)', (_name, binding) => {
    expect(() =>
      sessionCreateToRow('half-bound', { workspaceKind: 'project', ...binding }, 0),
    ).toThrow('Meka session binding requires both a project and a role');
  });

  it('derives the formal workflow only from a complete binding', () => {
    const formal = { type: 'jira', link: 'https://example.atlassian.net/browse/APP-7', ref: 'APP-7', content: null };
    // 旧 kind 但没有绑定：身份不再是 'meka'，正式流程快照不得凭空派生。
    expect(sessionCreateToRow('legacy', {
      workspaceKind: 'meka',
      isFormal: true,
      formal,
    }, 0)).toMatchObject({ workspaceKind: 'meka', isFormal: 0, formalType: null });
  });

  it('keeps legacy roles only for unbound Meka sessions', () => {
    expect(sessionCreateToRow('legacy', {
      workspaceKind: 'meka',
      mekaRole: 'planner',
    }, 0).mekaRole).toBe('planner');
    expect(sessionCreateToRow('regular', {
      workspaceKind: 'project',
      mekaRole: 'planner',
    }, 0).mekaRole).toBeNull();
  });

  it('does not expose frozen identity through patch mapping', () => {
    const patch = sessionPatchToRow({
      isFormal: false,
      mekaProjectId: 'other',
    } as Parameters<typeof sessionPatchToRow>[0]);
    expect(patch).not.toHaveProperty('isFormal');
    expect(patch).not.toHaveProperty('mekaProjectId');
  });

  it('tolerates corrupt frozen content', () => {
    expect(parseFormalContentJson('{')).toBeNull();
    expect(parseFormalContentJson(null)).toBeNull();
  });
});
