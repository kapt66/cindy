/**
 * createSessionRemoteHostIdReader 的缓存语义:
 * 查询成功(含行不存在)缓存;DB 异常返回 null 但不缓存——瞬时 DB 失败
 * 不得永久关闭该 session 的 remote ensure 兜底。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  selectCalls: { count: 0 },
  failNext: { value: false },
  row: null as { remoteHostId: string | null } | null,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../client/current', () => ({
  getCurrentDbClientUserId: () => 'test-user',
  getDbClient: () => {
    if (h.failNext.value) {
      h.failNext.value = false;
      throw new Error('db worker takeover in flight');
    }
    return {
      drizzle: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => {
                h.selectCalls.count += 1;
                return Promise.resolve(h.row ? [h.row] : []);
              },
            }),
          }),
        }),
      },
    };
  },
}));
vi.mock('../../dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: vi.fn() }));
vi.mock('../../../git-context/prRefsStore', () => ({
  recomputePrRefsForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../imageCacheStore.desktop', () => ({ removeSession: vi.fn(async () => undefined) }));
vi.mock('../recentWorkdirs', () => ({ upsertRecentWorkdir: vi.fn(async () => undefined) }));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));
vi.mock('../../agentIslandSessionPatch', () => ({ notifyAgentIslandSessionPatch: vi.fn() }));
vi.mock('../../../messagePersistBroadcaster.desktop', () => ({ noteSessionClearBoundary: vi.fn() }));
vi.mock('../../../sessionIds', () => ({ resolveBusinessSessionId: (id: string) => id }));

import { createSessionRemoteHostIdReader } from '../sessions';

describe('createSessionRemoteHostIdReader', () => {
  beforeEach(() => {
    h.selectCalls.count = 0;
    h.failNext.value = false;
    h.row = null;
  });

  it('caches successful lookups', async () => {
    h.row = { remoteHostId: 'host-1' };
    const read = createSessionRemoteHostIdReader();
    await expect(read('s1')).resolves.toBe('host-1');
    await expect(read('s1')).resolves.toBe('host-1');
    expect(h.selectCalls.count).toBe(1);
  });

  it('normalizes blank remoteHostId to null and caches it', async () => {
    h.row = { remoteHostId: '   ' };
    const read = createSessionRemoteHostIdReader();
    await expect(read('s1')).resolves.toBeNull();
    await expect(read('s1')).resolves.toBeNull();
    expect(h.selectCalls.count).toBe(1);
  });

  it('does NOT cache db errors — a transient failure does not permanently disable the fallback', async () => {
    const read = createSessionRemoteHostIdReader();
    h.failNext.value = true;
    await expect(read('s1')).resolves.toBeNull();

    // 瞬时失败后第二次调用必须重新查库,拿到真实 remoteHostId。
    h.row = { remoteHostId: 'host-1' };
    await expect(read('s1')).resolves.toBe('host-1');
    expect(h.selectCalls.count).toBe(1);

    // 成功后才进缓存。
    await expect(read('s1')).resolves.toBe('host-1');
    expect(h.selectCalls.count).toBe(1);
  });

  /**
   * 测试价值
   * - 生产入口与可观察结果：`createSessionRemoteHostIdReader` 在 `psb:` 会话被重绑后必须
   *   读到新的 PSB 身份；否则 lazy-resume 会把隧道开向一条已终态的 PSB 会话（消息发不出去）。
   * - Bug／规则依据：`docs/dev-rules/psb-remote-session-transport.md` §6「缓存失效」。
   *   重绑由 `main/remote-workspace/sessionRebind.ts` 改写 `remote_host_id`，缓存的原假设
   *   「remoteHostId 创建后不变」不再成立。
   * - 现有覆盖缺口：相邻用例只覆盖「成功缓存 / 空值缓存 / DB 错误不缓存」，没有覆盖
   *   「同一 sessionId 的行被改写后必须重读」。
   * - 最小失败输入：先读一次 `psb:old`（进缓存），把行改成 `psb:new` 后**不**调
   *   invalidate 再读 —— 旧实现返回 `psb:old`。
   * - tier：unit（进程内依赖注入，无真实 DB）。
   */
  it('re-reads after invalidate — a psb rebind changes remoteHostId for the same session', async () => {
    h.row = { remoteHostId: 'psb:old' };
    const read = createSessionRemoteHostIdReader();
    await expect(read('s1')).resolves.toBe('psb:old');
    expect(h.selectCalls.count).toBe(1);

    h.row = { remoteHostId: 'psb:new' };
    read.invalidate('s1');
    await expect(read('s1')).resolves.toBe('psb:new');
    expect(h.selectCalls.count).toBe(2);
  });
});
