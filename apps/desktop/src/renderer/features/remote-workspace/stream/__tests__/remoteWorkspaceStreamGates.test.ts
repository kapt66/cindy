/**
 * 测试价值
 * - 生产入口与可观察结果：`psbSessionInputAllowed()`（共享判据，会话页输入框置灰的**唯一**
 *   依据）、`shouldShowRemoteWorkspaceAdminEntry()`（`features/remote-workspace/stream/
 *   psbStreamSession.ts`，决定「远程工作区」入口在哪些会话出现）与
 *   `remoteWorkspacePsbSessionId()`（`sidebar/isRemoteWorkspaceSession.ts`，页面访问哪个
 *   PSB 会话的唯一身份解析；`psbStreamSessionId` 别名已删）。
 * - Bug / 规则依据：产品正本 `docs/product-rules/psb-remote-workspace-sessions.md` §2.4
 *   （**只有**他人占用 / 客户端离线 / 工作区未就绪三种情况置灰；PSB 会话终态不锁输入，
 *   发送时透明重建）与验收第 7 条、§6（`psb:` 前缀是唯一判据）；共享契约
 *   `shared/psb-remote-workspace.ts` 的 `psbSessionInputAllowed` 注释。
 * - 现有覆盖缺口：用户可见回归是「远程任务终态时输入框锁死、橙条说任务已结束」——旧判据
 *   把终态也当阻断原因，本文件钉住它不再阻断。
 * - 最小失败输入：把 `stopped` / `failed` 会话重新加回阻断分支（终态又锁死一个没结束的任务）、
 *   把 `mcpr:` / SSH 会话也当远程工作区（界面出现打不开的按钮）、把 `psb:` 畸形值（空 id）
 *   当真、优先级写反（离线先于他人占用 → 显示错误原因）。
 * - tier：unit（纯函数，node 环境）。
 */

import { describe, expect, it } from 'vitest';

import {
  psbSessionInputAllowed,
  type PsbRemoteSession,
  type PsbWorkspaceOccupancy,
} from '../../../../../shared/psb-remote-workspace';
import {
  shouldShowRemoteWorkspaceAdminEntry,
} from '../psbStreamSession';
import { remoteWorkspacePsbSessionId } from '../../sidebar/isRemoteWorkspaceSession';

const NO_OCCUPANCY: PsbWorkspaceOccupancy = {
  occupied: false,
  byMe: false,
  personId: null,
  personName: '',
  occupiedAt: null,
};

const OCCUPIED_BY_OTHER: PsbWorkspaceOccupancy = {
  occupied: true,
  byMe: false,
  personId: '42',
  personName: 'Someone',
  occupiedAt: 1,
};

function session(patch: Partial<PsbRemoteSession> = {}): PsbRemoteSession {
  return {
    id: 'psb-session',
    workspaceId: 'workspace-1',
    clientId: 'client-1',
    title: null,
    agentKind: 'claude-code',
    status: 'running',
    statusMessage: null,
    createdAt: '',
    updatedAt: '',
    createdBy: { personId: null, personName: '', source: 'cindy' },
    webUrl: null,
    ...patch,
  };
}

describe('psbSessionInputAllowed', () => {
  it('allows input only while the session and its workspace are both usable', () => {
    expect(
      psbSessionInputAllowed({
        session: session({ status: 'running' }),
        workspace: { state: 'ready', clientOnline: true, usable: true, unusableReason: null, occupancy: NO_OCCUPANCY },
      }),
    ).toEqual({ allowed: true, reason: null });
    // 自己占用 = 允许输入（自己占的工作区可以继续开第二条会话）。
    expect(
      psbSessionInputAllowed({
        session: session({ status: 'idle' }),
        workspace: {
          state: 'ready',
          clientOnline: true,
          usable: true,
          unusableReason: null,
          occupancy: { ...OCCUPIED_BY_OTHER, byMe: true, personId: '7' },
        },
      }),
    ).toEqual({ allowed: true, reason: null });
  });

  it.each(['stopped', 'failed'] as const)(
    'does not block input for a terminal PSB session (%s): the next send rebuilds it',
    (status) => {
      // 「这个任务已经结束」不是真实状态：本地任务还在，主进程会透明重建 PSB 会话。
      expect(
        psbSessionInputAllowed({
          session: session({ status }),
          workspace: { state: 'ready', clientOnline: true, usable: true, unusableReason: null, occupancy: NO_OCCUPANCY },
        }),
      ).toEqual({ allowed: true, reason: null });
    },
  );

  it.each([
    [
      'occupied by someone else',
      session(),
      'remoteWorkspace.error.workspaceOccupied',
      { state: 'ready' as const, clientOnline: true, usable: true, unusableReason: null, occupancy: OCCUPIED_BY_OTHER },
    ],
    [
      'client offline',
      session(),
      'remoteWorkspace.error.clientOffline',
      { state: 'ready' as const, clientOnline: false, usable: true, unusableReason: null, occupancy: NO_OCCUPANCY },
    ],
    [
      'workspace not ready',
      session(),
      'remoteWorkspace.input.workspaceNotReady',
      { state: 'provisioning' as const, clientOnline: true, usable: true, unusableReason: null, occupancy: NO_OCCUPANCY },
    ],
  ])('blocks input with a reason: %s', (_name, currentSession, expectedReason, workspace) => {
    expect(psbSessionInputAllowed({ session: currentSession, workspace })).toEqual({
      allowed: false,
      reason: expectedReason,
    });
  });

  it('PSB 权威字段优先：usable=false + unusableReason 决定阻断原因（本地字段看起来可用也以它为准）', () => {
    expect(
      psbSessionInputAllowed({
        session: session(),
        workspace: {
          state: 'ready',
          clientOnline: true,
          usable: false,
          unusableReason: 'client-offline',
          occupancy: NO_OCCUPANCY,
        },
      }),
    ).toEqual({ allowed: false, reason: 'remoteWorkspace.error.clientOffline' });
  });

  it('reports the first blocking cause in a stable order (occupied → offline → pending)', () => {    // 被他人占用优先于离线：用户要先看到"谁在占"。
    expect(
      psbSessionInputAllowed({
        session: session(),
        workspace: { state: 'ready', clientOnline: false, usable: true, unusableReason: null, occupancy: OCCUPIED_BY_OTHER },
      }).reason,
    ).toBe('remoteWorkspace.error.workspaceOccupied');
    // 离线优先于未就绪：离线时"未就绪"没有信息量。
    expect(
      psbSessionInputAllowed({
        session: session(),
        workspace: { state: 'provisioning', clientOnline: false, usable: true, unusableReason: null, occupancy: NO_OCCUPANCY },
      }).reason,
    ).toBe('remoteWorkspace.error.clientOffline');
  });
});

describe('shouldShowRemoteWorkspaceAdminEntry / remoteWorkspacePsbSessionId', () => {
  it.each([
    ['psb session', 'session-1', 'psb:abc123', true],
    ['mcpr remote project', 'session-1', 'mcpr:instance-1', false],
    ['ssh host', 'session-1', 'build-box', false],
    ['local session', 'session-1', null, false],
    ['psb without id', 'session-1', 'psb:', false],
    ['missing local session id', null, 'psb:abc123', false],
  ])('renders the admin entry only for a psb session: %s', (_name, sessionId, remoteHostId, expected) => {
    expect(shouldShowRemoteWorkspaceAdminEntry({ sessionId, remoteHostId })).toBe(expected);
    if (expected) {
      expect(remoteWorkspacePsbSessionId(remoteHostId)).toBe('abc123');
    }
  });
});
