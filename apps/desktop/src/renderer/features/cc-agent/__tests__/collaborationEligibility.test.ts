import { describe, expect, it } from 'vitest';

import {
  canShowCollabToggleForDraft,
  canShowCollabToggleForSession,
  isLocalCollabWorkspaceKind,
} from '../lib/collaborationEligibility';

describe('collaboration eligibility', () => {
  it.each([
    ['project', true],
    ['meka', true],
    ['dialogue', false],
    [null, false],
    [undefined, false],
  ] as const)('classifies %s as local=%s', (workspaceKind, expected) => {
    expect(isLocalCollabWorkspaceKind(workspaceKind)).toBe(expected);
  });

  it.each([
    ['project', null],
    ['project', 'lead'],
    ['meka', null],
    ['meka', 'lead'],
  ] as const)('shows an existing %s session with role %s', (workspaceKind, orcaRole) => {
    expect(canShowCollabToggleForSession({
      workspaceKind,
      workingDir: 'C:\\workspace',
      remoteHostId: null,
      orcaRole,
    })).toBe(true);
  });

  it.each([
    ['dialogue', { workspaceKind: 'dialogue', workingDir: 'C:\\dialogue', remoteHostId: null, orcaRole: null }],
    ['remote project', { workspaceKind: 'project', workingDir: 'C:\\repo', remoteHostId: 'ssh-1', orcaRole: null }],
    ['remote Meka', { workspaceKind: 'meka', workingDir: '/workspace', remoteHostId: 'mcpr:1', orcaRole: null }],
    ['missing cwd', { workspaceKind: 'meka', workingDir: null, remoteHostId: null, orcaRole: null }],
    ['Worker', { workspaceKind: 'meka', workingDir: 'C:\\meka', remoteHostId: null, orcaRole: 'worker' }],
  ] as const)('hides an existing %s session', (_label, session) => {
    expect(canShowCollabToggleForSession(session)).toBe(false);
  });

  it.each([
    ['local project', { workspaceKind: 'project', workingDir: 'C:\\repo', remoteHostId: null, deviceLinkDeviceId: null }],
    ['Meka before cwd allocation', { workspaceKind: 'meka', workingDir: null, remoteHostId: null, deviceLinkDeviceId: null }],
  ] as const)('shows a %s draft', (_label, draft) => {
    expect(canShowCollabToggleForDraft(draft)).toBe(true);
  });

  it.each([
    ['dialogue', { workspaceKind: 'dialogue', workingDir: null, remoteHostId: null, deviceLinkDeviceId: null }],
    ['project without cwd', { workspaceKind: 'project', workingDir: null, remoteHostId: null, deviceLinkDeviceId: null }],
    ['remote project', { workspaceKind: 'project', workingDir: 'C:\\repo', remoteHostId: 'ssh-1', deviceLinkDeviceId: null }],
    ['device-link Meka', { workspaceKind: 'meka', workingDir: null, remoteHostId: null, deviceLinkDeviceId: 'device-1' }],
  ] as const)('hides a %s draft', (_label, draft) => {
    expect(canShowCollabToggleForDraft(draft)).toBe(false);
  });
});
