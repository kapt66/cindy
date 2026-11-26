/**
 * PSB 工作区占用的**会话结束释放**（`maker-host/psb-workspace-session-release.ts`）。
 *
 * 规则依据：用户要求「会话结束也释放占用」+ 审查 r6/r7 —— 归档 / 删除 / 退出应用之后，
 * PSB 侧那把协作锁仍挂在自己名下，别人接手同一工作区会被 `PSB_WORKSPACE_OCCUPIED_BY_OTHER`
 * 挡住，而工作区里已经没有任务在跑。
 *
 * 口径：幂等（重复/并发/已被释放都是 no-op）、可重试（失败进账本，不吞）、不阻断主流程。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearPendingWorkspaceReleases,
  hasPendingWorkspaceRelease,
  installPsbWorkspaceReleasePorts,
  listPendingWorkspaceReleases,
  releaseActivePsbWorkspacesForQuit,
  releasePsbWorkspaceForSession,
  resetPsbWorkspaceReleaseForTests,
  retryPendingWorkspaceReleases,
  type PsbWorkspaceReleasePorts,
} from '../psb-workspace-session-release.js';
import type { PsbSessionStatusResult } from '../../../shared/psb-remote-workspace.js';

afterEach(() => {
  resetPsbWorkspaceReleaseForTests();
});

function status(input: {
  sessionId?: string;
  workspaceId?: string;
  byMe?: boolean;
  occupied?: boolean;
}): PsbSessionStatusResult {
  const sessionId = input.sessionId ?? 'psb-session';
  const workspaceId = input.workspaceId ?? 'ws-1';
  return {
    session: {
      id: sessionId,
      workspaceId,
      clientId: 'client-1',
      title: null,
      agentKind: 'claude-code',
      status: 'idle',
    },
    workspace: {
      id: workspaceId,
      title: 'ws',
      clientId: 'client-1',
      clientName: 'box',
      clientOnline: true,
      clientPlatform: null,
      state: 'ready',
      templateKey: null,
      templateTitle: null,
      directoryName: null,
      clientPath: null,
      occupancy: {
        occupied: input.occupied ?? true,
        byMe: input.byMe ?? true,
        personId: '7',
        personName: 'me',
        occupiedAt: 1,
      },
      usable: true,
      unusableReason: null,
      sessionCount: 1,
      webUrl: null,
      sessionsWebUrl: null,
    },
  } as unknown as PsbSessionStatusResult;
}

function ports(overrides: Partial<PsbWorkspaceReleasePorts> = {}) {
  const releaseWorkspace = vi.fn(async () => undefined);
  const invalidateSessionStatus = vi.fn();
  const releaseTransports = vi.fn(async () => undefined);
  const deps: PsbWorkspaceReleasePorts = {
    readSessionStatus: vi.fn(async (id: string) => status({ sessionId: id })),
    releaseWorkspace,
    invalidateSessionStatus,
    releaseTransports,
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  installPsbWorkspaceReleasePorts(deps);
  return { deps, releaseWorkspace, invalidateSessionStatus, releaseTransports };
}describe('releasePsbWorkspaceForSession', () => {
  it('releases the workspace the session holds and frees the tunnel entries', async () => {
    const { releaseWorkspace, invalidateSessionStatus, releaseTransports } = ports();

    const outcome = await releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    });

    expect(outcome).toEqual({ ok: true, released: true, reason: 'released' });
    expect(releaseWorkspace).toHaveBeenCalledWith('ws-1');
    expect(invalidateSessionStatus).toHaveBeenCalledWith('psb-session');
    expect(releaseTransports).toHaveBeenCalledWith({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
    });
    expect(listPendingWorkspaceReleases()).toEqual([]);
  });

  it('is idempotent: an already-released workspace is a no-op success', async () => {
    const { releaseWorkspace } = ports({
      readSessionStatus: async (id) => status({ sessionId: id, occupied: false, byMe: false }),
    });

    const outcome = await releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-deleted',
    });

    expect(outcome).toEqual({ ok: true, released: false, reason: 'not-held' });
    expect(releaseWorkspace).not.toHaveBeenCalled();
  });

  it('does nothing for non-psb sessions (local / SSH / MCPRouter have no PSB lock)', async () => {
    const { deps } = ports();
    for (const remoteHostId of [null, undefined, '', 'ssh-host-1', 'mcpr:instance-1']) {
      await expect(releasePsbWorkspaceForSession({
        sessionId: 'local-1',
        remoteHostId,
        reason: 'session-archived',
      })).resolves.toEqual({ ok: true, released: false, reason: 'not-psb' });
    }
    expect(deps.readSessionStatus).not.toHaveBeenCalled();
  });

  it('keeps a failed release for retry instead of swallowing it', async () => {
    let attempts = 0;
    const releaseWorkspace = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('[PSB_TUNNEL_UNREACHABLE] tunnel closed'), {
          failure: { code: 'TUNNEL_UNREACHABLE', messageKey: 'remoteWorkspace.error.clientOffline', message: null },
        });
      }
    });
    const { deps } = ports({ releaseWorkspace });

    const first = await releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    });
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error('unreachable');
    expect(first.code).toBe('PSB_RELEASE_FAILED');
    expect(first.failureCode).toBe('TUNNEL_UNREACHABLE');
    const pending = listPendingWorkspaceReleases();
    expect(pending).toHaveLength(1);
    // 读会话行成功过 → 账本记下 workspaceId，重试可直接按工作区释放（不再读 PSB 会话行）。
    expect(pending[0]).toMatchObject({
      reason: 'session-archived',
      attempt: 1,
      failureCode: 'TUNNEL_UNREACHABLE',
      workspaceId: 'ws-1',
    });
    expect(hasPendingWorkspaceRelease(pending[0]!.key)).toBe(true);
    expect(deps.log.warn).toHaveBeenCalled();

    // 账本重试使用同一条幂等入口：成功后条目消失。
    await expect(retryPendingWorkspaceReleases()).resolves.toEqual({
      attempted: 1,
      released: 1,
      failed: 0,
    });
    expect(listPendingWorkspaceReleases()).toEqual([]);
  });

  /* ---------------- 同一工作区还有别的活动任务：不提前解锁（二轮审查 s2 P1） ---------------- */

  it('does not unlock the workspace while another active task still uses it', async () => {
    const siblingWorkspaceId = 'ws-1';
    const readSessionStatus = vi.fn(async (id: string) => status({ sessionId: id }));
    const { releaseWorkspace, releaseTransports, deps } = ports({
      readSessionStatus,
      workspaceIdForPsbSession: (psbSessionId) => (psbSessionId === 'psb-sibling' ? siblingWorkspaceId : null),
      listActivePsbSessions: async () => [
        { sessionId: 'local-1', psbSessionId: 'psb-session' },
        { sessionId: 'local-2', psbSessionId: 'psb-sibling' },
      ],
    });

    const outcome = await releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    });

    expect(outcome).toEqual({ ok: true, released: false, reason: 'workspace-in-use' });
    expect(releaseWorkspace).not.toHaveBeenCalled();
    // 本会话已终态：它的隧道照常收掉，锁不受影响。
    expect(releaseTransports).toHaveBeenCalledWith({ sessionId: 'local-1', remoteHostId: 'psb:psb-session' });
    // 「有别的任务在用」不是失败：不入账（不入账 = 不会被当成待释放项反复重试）。
    expect(listPendingWorkspaceReleases()).toEqual([]);
    expect(deps.log.info).toHaveBeenCalledWith(
      'psb workspace release skipped: another active task still uses the workspace',
      expect.objectContaining({ workspaceId: 'ws-1', checked: 'mapping' }),
    );
  });

  it('still releases when the other active task belongs to a different workspace', async () => {
    const { releaseWorkspace } = ports({
      workspaceIdForPsbSession: () => 'ws-other',
      listActivePsbSessions: async () => [
        { sessionId: 'local-1', psbSessionId: 'psb-session' },
        { sessionId: 'local-2', psbSessionId: 'psb-other' },
      ],
    });
    await expect(releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    })).resolves.toEqual({ ok: true, released: true, reason: 'released' });
    expect(releaseWorkspace).toHaveBeenCalledWith('ws-1');
  });

  it('falls back to the sibling PSB status when the local session→workspace map has no entry', async () => {
    const readSessionStatus = vi.fn(async (id: string) => (
      id === 'psb-sibling' ? status({ sessionId: id, workspaceId: 'ws-1' }) : status({ sessionId: id })
    ));
    const { releaseWorkspace } = ports({
      readSessionStatus,
      workspaceIdForPsbSession: () => null,
      listActivePsbSessions: async () => [
        { sessionId: 'local-1', psbSessionId: 'psb-session' },
        { sessionId: 'local-2', psbSessionId: 'psb-sibling' },
      ],
    });
    await expect(releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-deleted',
    })).resolves.toEqual({ ok: true, released: false, reason: 'workspace-in-use' });
    expect(releaseWorkspace).not.toHaveBeenCalled();
    expect(readSessionStatus).toHaveBeenCalledWith('psb-sibling');
  });

  it('applies the same in-use check to ledger retries', async () => {
    // 先让释放失败入账（拿到 workspaceId）；此时还没有别的活动任务在用这个工作区。
    let siblings: Array<{ sessionId: string; psbSessionId: string }> = [];
    const releaseWorkspace = vi.fn(async () => {
      throw Object.assign(new Error('[PSB_TUNNEL_UNREACHABLE] tunnel closed'), {
        failure: {
          code: 'TUNNEL_UNREACHABLE',
          messageKey: 'remoteWorkspace.error.clientOffline',
          message: null,
        },
      });
    });
    ports({
      releaseWorkspace,
      workspaceIdForPsbSession: () => 'ws-1',
      listActivePsbSessions: async () => siblings,
    });
    await releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    });
    expect(listPendingWorkspaceReleases()).toHaveLength(1);
    releaseWorkspace.mockClear();

    // 重试前出现另一条活动任务（同一工作区）：账本重试同样不能提前解锁。
    siblings = [{ sessionId: 'local-2', psbSessionId: 'psb-sibling' }];
    await expect(retryPendingWorkspaceReleases()).resolves.toEqual({
      attempted: 1,
      released: 1,
      failed: 0,
    });
    expect(releaseWorkspace).not.toHaveBeenCalled();
    expect(listPendingWorkspaceReleases()).toEqual([]);
  });

  it('keeps a ledger entry when the in-use check cannot be confirmed (unknown is not another task)', async () => {
    // Bug／规则依据（2026-11-27 终局复审 P1）：重试时 `workspaceInUseByOtherActiveSession` 返回
    // `{inUse:true, checked:'unknown'}`（兄弟会话的归属读不到），旧实现只看 `use.inUse` 就
    // dropPending —— 待释放义务与常驻提示条一起被静默丢弃，锁却还挂在自己名下。
    // 可观察结果：重试失败计数 +1、条目仍在、没有发出 releaseWorkspace；证据恢复后才出账。
    const releaseWorkspace = vi.fn(async () => {
      throw Object.assign(new Error('[PSB_TUNNEL_UNREACHABLE] tunnel closed'), {
        failure: {
          code: 'TUNNEL_UNREACHABLE',
          messageKey: 'remoteWorkspace.error.clientOffline',
          message: null,
        },
      });
    });
    let siblings: Array<{ sessionId: string; psbSessionId: string }> = [];
    let siblingLookupFails = false;
    const readSessionStatus = vi.fn(async (id: string) => {
      if (id === 'psb-sibling' && siblingLookupFails) {
        throw Object.assign(new Error('[PSB_TUNNEL_UNREACHABLE] tunnel closed'), {
          failure: {
            code: 'TUNNEL_UNREACHABLE',
            messageKey: 'remoteWorkspace.error.clientOffline',
            message: null,
          },
        });
      }
      return status({ sessionId: id });
    });
    const { releaseTransports } = ports({
      releaseWorkspace,
      readSessionStatus,
      // 本机没有兄弟会话的「会话→工作区」映射，只能读 PSB 会话行确认归属。
      workspaceIdForPsbSession: () => null,
      listActivePsbSessions: async () => siblings,
    });
    await releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    });
    expect(listPendingWorkspaceReleases()).toHaveLength(1);
    releaseWorkspace.mockClear();
    releaseTransports.mockClear();

    // 重试时出现一条归属未知的活动任务，读它的 PSB 会话行又失败：证据不足（unknown）。
    siblings = [{ sessionId: 'local-2', psbSessionId: 'psb-sibling' }];
    siblingLookupFails = true;
    await expect(retryPendingWorkspaceReleases()).resolves.toEqual({
      attempted: 1,
      released: 0,
      failed: 1,
    });
    expect(releaseWorkspace).not.toHaveBeenCalled();
    // 不能当成「别人在用」出账：义务与提示条都要留着，下一次还能重试。
    expect(listPendingWorkspaceReleases()).toHaveLength(1);

    // 证据恢复（读到兄弟会话就在同一工作区）：这时才是确证的「别人在用」→ 出账且不释放。
    siblingLookupFails = false;
    await expect(retryPendingWorkspaceReleases()).resolves.toEqual({
      attempted: 1,
      released: 1,
      failed: 0,
    });
    expect(releaseWorkspace).not.toHaveBeenCalled();
    expect(listPendingWorkspaceReleases()).toEqual([]);
  });

  it('does not release the workspace when the archived session has been restored and is active again', async () => {
    // Bug／规则依据（2026-11-27 终局复审 P1）：归档时释放失败入账 → 用户恢复该任务（会话重新
    // active，重新占着同一把锁）→ 点提示条重试。旧实现按 workspaceId 直连 releaseWorkspace，
    // 直接解掉一条正在使用的工作区的锁；渲染层的恢复任务不负责清账本，只能在重试入口复核。
    // 可观察结果：重试后条目出账，但没有 releaseWorkspace，也没有按「任务结束」收掉恢复任务
    // 正在用的隧道。
    const releaseWorkspace = vi.fn(async () => {
      throw Object.assign(new Error('[PSB_TUNNEL_UNREACHABLE] tunnel closed'), {
        failure: {
          code: 'TUNNEL_UNREACHABLE',
          messageKey: 'remoteWorkspace.error.clientOffline',
          message: null,
        },
      });
    });
    let active: Array<{ sessionId: string; psbSessionId: string }> = [];
    const { releaseTransports, deps } = ports({
      releaseWorkspace,
      listActivePsbSessions: async () => active,
    });
    await releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    });
    expect(listPendingWorkspaceReleases()).toHaveLength(1);
    releaseWorkspace.mockClear();
    releaseTransports.mockClear();

    active = [{ sessionId: 'local-1', psbSessionId: 'psb-session' }];
    await expect(retryPendingWorkspaceReleases()).resolves.toEqual({
      attempted: 1,
      released: 1,
      failed: 0,
    });
    // 关键：不能解掉正在使用的工作区锁，也不能用「任务结束」路径收掉它的隧道。
    expect(releaseWorkspace).not.toHaveBeenCalled();
    expect(releaseTransports).not.toHaveBeenCalled();
    expect(listPendingWorkspaceReleases()).toEqual([]);
    expect(deps.log.info).toHaveBeenCalledWith(
      'psb pending workspace release resolved: the session is active again',
      expect.objectContaining({ sessionId: 'local-1' }),
    );
  });

  /* ---------------- 重试按 workspaceId 直接释放（二轮审查 s2 P1） ---------------- */

  it('retries by workspaceId without reading the PSB session row again', async () => {
    let releaseAttempts = 0;
    const releaseWorkspace = vi.fn(async () => {
      releaseAttempts += 1;
      if (releaseAttempts === 1) {
        throw Object.assign(new Error('[PSB_TUNNEL_UNREACHABLE] tunnel closed'), {
          failure: { code: 'TUNNEL_UNREACHABLE', messageKey: 'remoteWorkspace.error.clientOffline', message: null },
        });
      }
    });
    const readSessionStatus = vi.fn(async (id: string) => status({ sessionId: id }));
    const { invalidateSessionStatus } = ports({ releaseWorkspace, readSessionStatus });

    await releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    });
    expect(listPendingWorkspaceReleases()[0]?.workspaceId).toBe('ws-1');
    expect(readSessionStatus).toHaveBeenCalledTimes(1);

    await expect(retryPendingWorkspaceReleases()).resolves.toEqual({
      attempted: 1,
      released: 1,
      failed: 0,
    });
    // 关键：重试没有再打一次 sessionStatus，直接按账本里的 workspaceId 释放。
    expect(readSessionStatus).toHaveBeenCalledTimes(1);
    expect(releaseWorkspace).toHaveBeenCalledTimes(2);
    expect(invalidateSessionStatus).toHaveBeenCalledWith('psb-session');
    expect(listPendingWorkspaceReleases()).toEqual([]);
  });

  it('still releases by workspace when the PSB session is gone (404)', async () => {
    const releaseWorkspace = vi.fn(async () => undefined);
    const readSessionStatus = vi.fn<(id: string) => Promise<PsbSessionStatusResult>>(
      async () => {
        throw Object.assign(new Error('[NOT_FOUND] session is gone'), {
          failure: { code: 'NOT_FOUND', messageKey: 'remoteWorkspace.error.notFound', message: null },
        });
      },
    );
    ports({ releaseWorkspace, readSessionStatus });

    // 第一次：读会话行就 404 → 账本没有 workspaceId。
    await releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    });
    const entry = listPendingWorkspaceReleases()[0]!;
    expect(entry.workspaceId).toBeNull();

    // 让账本拿到 workspaceId（这次读到了工作区，但释放本身失败）。
    readSessionStatus.mockImplementation(async (id: string) => status({ sessionId: id }));
    releaseWorkspace.mockImplementationOnce(async () => {
      throw Object.assign(new Error('[PSB_UNREACHABLE] timeout'), {
        failure: { code: 'PSB_UNREACHABLE', messageKey: 'remoteWorkspace.error.unreachable', message: null },
      });
    });
    await expect(retryPendingWorkspaceReleases()).resolves.toMatchObject({ failed: 1 });
    const withWorkspace = listPendingWorkspaceReleases().find((item) => item.key === entry.key);
    expect(withWorkspace?.workspaceId).toBe('ws-1');

    // PSB 会话此时 404（已终态）—— 重试仍按 workspaceId 释放成功，不再读会话行。
    readSessionStatus.mockImplementation(async () => {
      throw Object.assign(new Error('[NOT_FOUND] session is gone'), {
        failure: { code: 'NOT_FOUND', messageKey: 'remoteWorkspace.error.notFound', message: null },
      });
    });
    const statusCallsBefore = readSessionStatus.mock.calls.length;
    await expect(retryPendingWorkspaceReleases()).resolves.toEqual({
      attempted: 1,
      released: 1,
      failed: 0,
    });
    expect(readSessionStatus.mock.calls.length).toBe(statusCallsBefore);
    expect(releaseWorkspace).toHaveBeenCalledWith('ws-1');
    expect(listPendingWorkspaceReleases()).toEqual([]);
  });

  it('records the locally mapped workspaceId even when the PSB session row is already 404', async () => {
    const readSessionStatus = vi.fn<(id: string) => Promise<PsbSessionStatusResult>>(
      async () => {
        throw Object.assign(new Error('[NOT_FOUND] session is gone'), {
          failure: { code: 'NOT_FOUND', messageKey: 'remoteWorkspace.error.notFound', message: null },
        });
      },
    );
    const releaseWorkspace = vi.fn(async () => undefined);
    ports({
      readSessionStatus,
      releaseWorkspace,
      // 本机持久化的「会话→工作区」映射（PSB 会话行读不到也能定位这把锁）。
      workspaceIdForPsbSession: () => 'ws-mapped',
    });

    await releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    });
    expect(listPendingWorkspaceReleases()[0]).toMatchObject({
      psbSessionId: 'psb-session',
      workspaceId: 'ws-mapped',
      failureCode: 'NOT_FOUND',
    });

    // 重试：直接按工作区释放，不再读 PSB 会话行。
    await expect(retryPendingWorkspaceReleases()).resolves.toEqual({
      attempted: 1,
      released: 1,
      failed: 0,
    });
    expect(readSessionStatus).toHaveBeenCalledTimes(1);
    expect(releaseWorkspace).toHaveBeenCalledWith('ws-mapped');
    expect(listPendingWorkspaceReleases()).toEqual([]);
  });

  it('evicts a workspace retry with the explicit NOT_FOUND attribution instead of retrying forever', async () => {
    const releaseWorkspace = vi.fn(async () => {
      throw Object.assign(new Error('[NOT_FOUND] workspace is gone'), {
        failure: { code: 'NOT_FOUND', messageKey: 'remoteWorkspace.error.notFound', message: null },
      });
    });
    const { deps } = ports({ releaseWorkspace });
    await releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    });
    releaseWorkspace.mockClear();
    releaseWorkspace.mockImplementation(async () => {
      throw Object.assign(new Error('[NOT_FOUND] workspace is gone'), {
        failure: { code: 'NOT_FOUND', messageKey: 'remoteWorkspace.error.notFound', message: null },
      });
    });

    await expect(retryPendingWorkspaceReleases()).resolves.toEqual({
      attempted: 1,
      released: 1,
      failed: 0,
    });
    expect(listPendingWorkspaceReleases()).toEqual([]);
    expect(deps.log.warn).toHaveBeenCalledWith(
      'psb pending workspace release dropped: attribution=workspace-unavailable',
      expect.objectContaining({ workspaceId: 'ws-1', attribution: 'workspace-missing' }),
    );
  });

  it('evicts a session-only entry when the PSB session is gone (no workspaceId to release)', async () => {
    const readSessionStatus = vi.fn(async () => {
      throw Object.assign(new Error('[NOT_FOUND] session is gone'), {
        failure: { code: 'NOT_FOUND', messageKey: 'remoteWorkspace.error.notFound', message: null },
      });
    });
    const { deps } = ports({ readSessionStatus });
    await releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    });
    expect(listPendingWorkspaceReleases()).toHaveLength(1);

    await expect(retryPendingWorkspaceReleases()).resolves.toEqual({
      attempted: 1,
      released: 1,
      failed: 0,
    });
    expect(listPendingWorkspaceReleases()).toEqual([]);
    expect(deps.log.warn).toHaveBeenCalledWith(
      'psb pending workspace release evicted: attribution=session-missing',
      expect.objectContaining({ psbSessionId: 'psb-session', failureCode: 'NOT_FOUND' }),
    );
  });

  it('drops a pending release at an account boundary instead of releasing with the new identity', async () => {
    let scope = 'owner-a:1';
    const releaseWorkspace = vi.fn(async () => {
      throw Object.assign(new Error('[PSB_UNREACHABLE] timeout'), {
        failure: { code: 'PSB_UNREACHABLE', messageKey: 'remoteWorkspace.error.unreachable', message: null },
      });
    });
    ports({
      releaseWorkspace,
      currentDataOwnerScope: () => scope,
    });
    await releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    });
    expect(listPendingWorkspaceReleases()).toHaveLength(1);

    scope = 'owner-b:2';
    releaseWorkspace.mockClear();
    await expect(retryPendingWorkspaceReleases()).resolves.toEqual({
      attempted: 1,
      released: 1,
      failed: 0,
    });
    expect(releaseWorkspace).not.toHaveBeenCalled();
    expect(listPendingWorkspaceReleases()).toEqual([]);
  });

  it('clears the ledger on teardown (dispose) instead of leaking it across accounts', async () => {
    const { releaseWorkspace } = ports({
      releaseWorkspace: vi.fn(async () => {
        throw Object.assign(new Error('[PSB_UNREACHABLE] timeout'), {
          failure: { code: 'PSB_UNREACHABLE', messageKey: 'remoteWorkspace.error.unreachable', message: null },
        });
      }),
    });
    expect(releaseWorkspace).toBeTypeOf('function');
    await releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    });
    expect(listPendingWorkspaceReleases()).toHaveLength(1);
    clearPendingWorkspaceReleases();
    expect(listPendingWorkspaceReleases()).toEqual([]);
  });

  it('counts a not-held retry as successful and still clears the ledger entry', async () => {
    const { deps } = ports({
      readSessionStatus: vi.fn(async () => {
        throw Object.assign(new Error('[PSB_TUNNEL_UNREACHABLE] tunnel closed'), {
          failure: { code: 'TUNNEL_UNREACHABLE', messageKey: 'remoteWorkspace.error.clientOffline', message: null },
        });
      }),
    });
    await expect(releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    })).resolves.toMatchObject({ ok: false });
    expect(listPendingWorkspaceReleases()).toHaveLength(1);
    // PSB 恢复后会话行已不存在 / 已不再由我占用。
    (deps.readSessionStatus as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string) => status({ sessionId: id, occupied: false, byMe: false }),
    );
    await expect(retryPendingWorkspaceReleases()).resolves.toMatchObject({ released: 1 });
    expect(listPendingWorkspaceReleases()).toEqual([]);
    clearPendingWorkspaceReleases();
  });

  it('releases every active psb session in parallel on app quit', async () => {
    const { releaseWorkspace } = ports();
    const outcome = await releaseActivePsbWorkspacesForQuit({
      listActiveSessions: async () => [
        { sessionId: 'local-1', remoteHostId: 'psb:s1' },
        { sessionId: 'local-2', remoteHostId: 'psb:s2' },
        { sessionId: 'local-3', remoteHostId: 'ssh-host-1' },
        { sessionId: 'local-4', remoteHostId: null },
      ],
    });
    expect(outcome).toEqual({ attempted: 2, released: 2, failed: 0 });
    expect(releaseWorkspace).toHaveBeenCalledTimes(2);
  });

  it('is a no-op before the desktop wiring is installed (Node Host / early boot)', async () => {
    await expect(releasePsbWorkspaceForSession({
      sessionId: 'local-1',
      remoteHostId: 'psb:psb-session',
      reason: 'session-archived',
    })).resolves.toEqual({ ok: true, released: false, reason: 'not-wired' });
  });
});
