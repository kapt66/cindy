import { describe, expect, it } from 'vitest';

import {
  parseFormalContentJson,
  sessionCreateToRow,
  sessionPatchToRow,
  sessionToCamel,
} from '../mapper';

describe('Meka session mapper', () => {
  it('freezes the project, role and provider-neutral formal requirement on create', () => {
    const content = { title: 'Fix login', description: 'Windows fails' };
    const row = sessionCreateToRow('s1', {
      workspaceKind: 'meka',
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
      workspaceKind: 'meka',
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
      mekaProjectId: 'project-a',
      mekaRoleId: 'developer',
      isFormal: true,
      formal: { type: 'jira', ref: 'APP-7', content },
    });
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
