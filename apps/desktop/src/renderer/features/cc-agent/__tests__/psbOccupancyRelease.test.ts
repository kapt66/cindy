// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：`releasePsbOccupancyForEndedSession` / `flushPsbSessionReleases`
 *   （本地任务结束 → 归还 PSB 远程工作区占用的渲染层**兼容层**）。
 * - Bug／规则依据：2026-11-26 审查 r6 P1（占用无 TTL、任务结束没有释放路径）；
 *   2026-11-27 二轮审查 s5/s8 P1（main 终态 observer 与渲染层重复触发 = 一次归档两轮 PSB 请求）。
 * - 现有覆盖缺口：没有用例证明「新 main 下渲染层零上报 / 零本地记账」，也没有用例覆盖
 *   旧实现只存 psbSessionId 的记录会永久 pending-port。
 * - 最小失败输入：新 main 下仍调用 `releaseWorkspaceForSession`（双触发）；或只有 psbSessionId
 *   的旧记录被永远留在账本里。
 * - tier：unit（jsdom + 受控 bridge，无网络/进程）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing,
  flushPsbSessionReleases,
  listPendingWorkspaceReleasesFromMain,
  listPsbSessionReleases,
  psbOccupancyReleaseRecordOfSession,
  psbMainOwnsSessionEndRelease,
  refreshPendingWorkspaceReleases,
  releasePsbOccupancyForEndedSession,
  retryPendingWorkspaceReleasesInMain,
  subscribePendingWorkspaceReleases,
  watchPendingWorkspaceReleases,
} from '../psbOccupancyRelease';

function makeBridge(releaseWorkspaceForSession: ReturnType<typeof vi.fn>) {
  return { releaseWorkspaceForSession } as never;
}

/** 旧 preload / 旧 main：没有释放 IPC（也意味着没有终态 observer）。 */
function legacyBridge() {
  return {} as never;
}

beforeEach(() => {
  __testing.reset();
  __testing.setBridge(null);
});

describe('PSB session-end occupancy release', () => {
  it('derives the release obligation from a PSB session row only', () => {
    expect(psbOccupancyReleaseRecordOfSession(
      { id: 'local-1', remoteHostId: 'psb:psb-1' },
      'session-archived',
    )).toMatchObject({ localSessionId: 'local-1', psbSessionId: 'psb-1', reason: 'session-archived' });
    expect(psbOccupancyReleaseRecordOfSession({ id: 'local-1', remoteHostId: 'mcpr:x' }, 'session-deleted')).toBeNull();
    expect(psbOccupancyReleaseRecordOfSession({ id: 'local-1', remoteHostId: null }, 'session-deleted')).toBeNull();
    expect(psbOccupancyReleaseRecordOfSession(null, 'session-deleted')).toBeNull();
  });

  // 二轮审查 s5/s8 P1：一次归档/删除只能有一轮 PSB 请求。新 main 的终态 observer 已经发起
  // 释放，渲染层再报一次就是第二轮 `sessionStatus` + `release`，还会和 main 的账本双记账。
  // 最小失败输入：这里断言「没有调用 releaseWorkspaceForSession」。
  it('does not re-report a release when main owns session-end release (main authority)', async () => {
    const releaseWorkspaceForSession = vi.fn(async () => undefined);
    __testing.setBridge(() => makeBridge(releaseWorkspaceForSession));
    expect(psbMainOwnsSessionEndRelease()).toBe(true);

    const record = psbOccupancyReleaseRecordOfSession(
      { id: 'local-1', remoteHostId: 'psb:psb-1' },
      'session-deleted',
    );
    await expect(releasePsbOccupancyForEndedSession(record)).resolves.toBe('main-authority');
    expect(releaseWorkspaceForSession).not.toHaveBeenCalled();
    expect(listPsbSessionReleases()).toHaveLength(0);
  });

  it('clears a legacy record for the same task instead of delivering it a second time', async () => {
    const record = psbOccupancyReleaseRecordOfSession(
      { id: 'local-seed', remoteHostId: 'psb:psb-seed' },
      'session-archived',
    );
    // 旧 build：没有释放 IPC，事件只能先留在本地账本。
    __testing.setBridge(legacyBridge);
    expect(psbMainOwnsSessionEndRelease()).toBe(false);
    await expect(releasePsbOccupancyForEndedSession(record)).resolves.toBe('pending-port');
    expect(listPsbSessionReleases()).toHaveLength(1);

    // 升级后（新 main 单权威）：同一会话的历史记录不再补投。
    const releaseWorkspaceForSession = vi.fn(async () => undefined);
    __testing.setBridge(() => makeBridge(releaseWorkspaceForSession));
    await expect(releasePsbOccupancyForEndedSession(record)).resolves.toBe('main-authority');
    expect(releaseWorkspaceForSession).not.toHaveBeenCalled();
    expect(listPsbSessionReleases()).toHaveLength(0);
  });

  it('keeps an old-build obligation until the upgraded main can take it, then delivers it once', async () => {
    const record = psbOccupancyReleaseRecordOfSession(
      { id: 'local-2', remoteHostId: 'psb:psb-2' },
      'session-archived',
    );

    // 旧 preload / 主进程未就绪：桥或端口缺失，事件先留在本地账本。
    __testing.setBridge(legacyBridge);
    await expect(releasePsbOccupancyForEndedSession(record)).resolves.toBe('pending-port');
    expect(listPsbSessionReleases()).toHaveLength(1);

    // 升级后启动 / 页面可见：补投**一次**，成功后本地账本清空（main 自己记账）。
    const releaseWorkspaceForSession = vi.fn(async () => undefined);
    __testing.setBridge(() => makeBridge(releaseWorkspaceForSession));
    await expect(flushPsbSessionReleases()).resolves.toEqual({ attempted: 1, released: 1, retained: 0 });
    expect(releaseWorkspaceForSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'local-2',
      remoteHostId: 'psb:psb-2',
      reason: 'session-archived',
    }));
    expect(listPsbSessionReleases()).toHaveLength(0);
  });

  it('retains a transient delivery failure with backoff instead of silently dropping it', async () => {
    const record = psbOccupancyReleaseRecordOfSession(
      { id: 'local-3', remoteHostId: 'psb:psb-3' },
      'session-archived',
    );
    __testing.setBridge(legacyBridge);
    await releasePsbOccupancyForEndedSession(record);

    __testing.setBridge(() => makeBridge(vi.fn(async () => {
      throw new Error('[PSB_REMOTE_UNAVAILABLE] cannot reach PSB');
    })));
    await expect(flushPsbSessionReleases()).resolves.toEqual({ attempted: 1, released: 0, retained: 1 });
    const pending = listPsbSessionReleases();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ localSessionId: 'local-3', attempts: 1 });
    expect(pending[0]!.nextAttemptAt).toBeGreaterThan(Date.now());

    // 还没到退避时间：不偷偷重放（写操作不在高频时机自动重试）。
    await expect(flushPsbSessionReleases()).resolves.toEqual({ attempted: 0, released: 0, retained: 0 });
  });

  it('treats "already free / not found" as done so the ledger does not retry forever', async () => {
    const record = psbOccupancyReleaseRecordOfSession(
      { id: 'local-4', remoteHostId: 'psb:psb-4' },
      'session-stopped',
    );
    __testing.setBridge(legacyBridge);
    await releasePsbOccupancyForEndedSession(record);

    __testing.setBridge(() => makeBridge(vi.fn(async () => {
      throw new Error('[NOT_FOUND] workspace is gone');
    })));
    await expect(flushPsbSessionReleases()).resolves.toEqual({ attempted: 1, released: 1, retained: 0 });
    expect(listPsbSessionReleases()).toHaveLength(0);
  });

  // 二轮审查 s2 P1：旧实现存下的记录可能只有 psbSessionId（没有本地会话 id）。main 的入参与
  // 幂等键都需要本地会话 id，这种记录永远投不出去 —— 必须淘汰并留痕，不能永久 pending-port。
  it('drops a legacy record that has no local session id instead of pending forever', async () => {
    window.localStorage.setItem(__testing.storageKey, JSON.stringify({
      records: [{
        psbSessionId: 'psb-orphan',
        reason: 'session-archived',
        enqueuedAt: 1,
        attempts: 0,
        nextAttemptAt: 0,
        dataOwnerId: null,
      }],
    }));
    const releaseWorkspaceForSession = vi.fn(async () => undefined);
    __testing.setBridge(() => makeBridge(releaseWorkspaceForSession));

    await expect(flushPsbSessionReleases()).resolves.toEqual({ attempted: 1, released: 1, retained: 0 });
    expect(releaseWorkspaceForSession).not.toHaveBeenCalled();
    expect(listPsbSessionReleases()).toHaveLength(0);
  });

  it('treats a main-retained failure as delivered: main owns the retry, the renderer ledger does not', async () => {
    // main 读 PSB 失败时会在 IPC 结果里回 ok:false + reason:'retained'（失败已记进 main 账本）。
    // 渲染层若把它当投递失败留在自己的账本里，会让同一件事被两边各重试一遍。
    const record = psbOccupancyReleaseRecordOfSession(
      { id: 'local-5', remoteHostId: 'psb:psb-5' },
      'session-archived',
    );
    __testing.setBridge(legacyBridge);
    await releasePsbOccupancyForEndedSession(record);

    __testing.setBridge(() => ({
      releaseWorkspaceForSession: vi.fn(async () => ({
        ok: false,
        released: false,
        reason: 'retained',
        failureCode: 'PSB_UNREACHABLE',
        message: 'PSB unreachable',
      })),
    }) as never);
    await expect(flushPsbSessionReleases()).resolves.toEqual({ attempted: 1, released: 1, retained: 0 });
    expect(listPsbSessionReleases()).toHaveLength(0);
  });

  it('keeps the event pending when main has not wired its release port yet', async () => {
    const record = psbOccupancyReleaseRecordOfSession(
      { id: 'local-6', remoteHostId: 'psb:psb-6' },
      'session-archived',
    );
    __testing.setBridge(legacyBridge);
    await releasePsbOccupancyForEndedSession(record);

    __testing.setBridge(() => ({
      releaseWorkspaceForSession: vi.fn(async () => ({
        ok: true,
        released: false,
        reason: 'not-wired',
        failureCode: null,
        message: null,
      })),
    }) as never);
    await expect(flushPsbSessionReleases()).resolves.toEqual({ attempted: 1, released: 0, retained: 1 });
    expect(listPsbSessionReleases()).toHaveLength(1);
    expect(listPsbSessionReleases()[0]).toMatchObject({ localSessionId: 'local-6', attempts: 1 });
  });
});

describe('main pending-release ledger view', () => {
  const pending = {
    key: 'local-7\u0000session-archived',
    psbSessionId: 'psb-7',
    remoteHostId: 'psb:psb-7',
    workspaceId: 'ws-7',
    reason: 'session-archived' as const,
    attempt: 2,
    lastError: 'PSB unreachable',
    failureCode: 'PSB_UNREACHABLE',
    updatedAt: 1,
  };

  it('refreshes the snapshot from main and notifies subscribers', async () => {
    const pendingWorkspaceReleases = vi.fn(async () => ({ releases: [pending] }));
    __testing.setBridge(() => ({ pendingWorkspaceReleases }) as never);
    const listener = vi.fn();
    const unsubscribe = subscribePendingWorkspaceReleases(listener);

    await refreshPendingWorkspaceReleases();
    expect(listPendingWorkspaceReleasesFromMain()).toEqual([pending]);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(pendingWorkspaceReleases).toHaveBeenCalledTimes(1);
  });

  it('retries through main and replaces the snapshot with the post-retry ledger', async () => {
    const retryPendingWorkspaceReleases = vi.fn(async () => ({
      attempted: 1,
      released: 1,
      failed: 0,
      releases: [],
    }));
    __testing.setBridge(() => ({ retryPendingWorkspaceReleases }) as never);

    await expect(retryPendingWorkspaceReleasesInMain()).resolves.toMatchObject({
      attempted: 1,
      released: 1,
    });
    expect(listPendingWorkspaceReleasesFromMain()).toEqual([]);
  });

  it('subscribes to main pushes; an old preload without the methods degrades to an empty view', async () => {
    const handler: { current: ((event: { releases: readonly unknown[] }) => void) | null } = {
      current: null,
    };
    const onPendingWorkspaceReleasesChanged = vi.fn(
      (next: (event: { releases: readonly unknown[] }) => void) => {
        handler.current = next;
        return () => {
          handler.current = null;
        };
      },
    );
    __testing.setBridge(() => ({
      onPendingWorkspaceReleasesChanged,
      pendingWorkspaceReleases: vi.fn(async () => ({ releases: [] })),
    }) as never);

    const stop = watchPendingWorkspaceReleases();
    await Promise.resolve();
    handler.current?.({ releases: [pending] });
    expect(listPendingWorkspaceReleasesFromMain()).toEqual([pending]);
    stop();
    expect(handler.current).toBeNull();

    // 旧 preload：没有这两个方法 → 不抛错、快照保持（不因读不到就清空）。
    __testing.reset();
    __testing.setBridge(() => ({}) as never);
    await expect(refreshPendingWorkspaceReleases()).resolves.toEqual([]);
    expect(watchPendingWorkspaceReleases()).toBeTypeOf('function');
  });
});

