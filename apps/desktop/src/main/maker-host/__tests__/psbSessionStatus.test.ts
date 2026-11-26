/**
 * PSB 会话状态快照 store（`maker-host/psb-session-status.ts`）。
 *
 * 规则依据：审查 r7 P1 —— 发送前判定此前每次打 `sessionStatus`（GET + 全量列表），
 * 控制面抖动就把健康会话判成发送失败。修正后的口径三条：**TTL 复用**、**事件失效**、
 * **读不到 fail-open**（真终态由建隧道时的 `PSB_*` 报出）。
 *
 * 覆盖缺口：原实现没有这一层，所以没有既有用例可合并；这里放在新文件（单文件 <5s）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createPsbSessionStatusStore,
  PSB_SESSION_STATUS_TTL_MS,
  psbSessionStatusNeedsRebind,
  type PsbSessionStatusStoreDeps,
} from '../psb-session-status.js';
import type {
  PsbSessionStatus,
  PsbSessionStatusResult,
} from '../../../shared/psb-remote-workspace.js';

function sessionStatus(
  id: string,
  status: PsbSessionStatus = 'running',
): PsbSessionStatusResult {
  return {
    session: {
      id,
      workspaceId: `ws-${id}`,
      title: null,
      agentKind: 'claude-code',
      status,
      createdAt: 1,
      startedAt: 1,
      endedAt: null,
      exitCode: null,
    },
    workspace: {
      id: `ws-${id}`,
      name: 'ws',
      state: 'ready',
      clientOnline: true,
      occupancy: { occupied: true, byMe: true, personName: 'me', since: 1 },
      vcs: null,
      unusableReason: null,
    },
  } as unknown as PsbSessionStatusResult;
}

/** PSB 失败错误形状（`PsbClientError` 的稳定字段，见 shared 契约）。 */
function psbError(code: string, status?: number): Error {
  return Object.assign(new Error(`[${code}] boom`), {
    failure: { code, messageKey: 'remoteWorkspace.error.clientOffline', message: null },
    ...(status === undefined ? {} : { status }),
  });
}

describe('PSB session status snapshot store', () => {
  it('reads once inside the TTL and refreshes once it expires (no per-send GET)', async () => {
    let now = 1_000;
    const read = vi.fn(async (id: string) => sessionStatus(id));
    const store = createPsbSessionStatusStore({
      read,
      now: () => now,
      ttlMs: PSB_SESSION_STATUS_TTL_MS,
    });

    const first = await store.read('s1');
    expect(first.ok && first.snapshot.status.session.id).toBe('s1');
    const second = await store.read('s1');
    expect(second.ok).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);

    now += PSB_SESSION_STATUS_TTL_MS + 1;
    await store.read('s1');
    expect(read).toHaveBeenCalledTimes(2);

    // 强制刷新（重绑决策必须看最新事实）。
    await store.read('s1', { maxAgeMs: 0 });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight read between concurrent sends', async () => {
    const read = vi.fn(async (id: string) => {
      await Promise.resolve();
      return sessionStatus(id);
    });
    const store = createPsbSessionStatusStore({ read });
    const [a, b] = await Promise.all([store.read('s1'), store.read('s1')]);
    expect(a.ok && b.ok).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('fails open: a read failure is not a verdict, and the stale snapshot is handed back', async () => {
    let now = 1_000;
    let fail = false;
    const read = vi.fn(async (id: string) => {
      if (fail) throw psbError('NETWORK');
      return sessionStatus(id);
    });
    const store = createPsbSessionStatusStore({ read, now: () => now, ttlMs: 10 });
    await store.read('s1');
    fail = true;
    now += 11;
    const lookup = await store.read('s1');
    if (lookup.ok) throw new Error('expected a failed lookup');
    expect(lookup.kind).toBe('unavailable');
    if (lookup.kind !== 'unavailable') throw new Error('unreachable');
    // 旧快照随失败一起交回：调用方能按「上次看到的事实」继续，而不是完全失明。
    expect(lookup.stale?.status.session.status).toBe('running');
    expect(lookup.failure?.code).toBe('NETWORK');
  });

  it('treats PSB 404/403 as "missing" and drops the stale snapshot', async () => {
    let missing = false;
    const read = vi.fn(async (id: string) => {
      if (missing) throw psbError('NOT_FOUND', 404);
      return sessionStatus(id);
    });
    const store = createPsbSessionStatusStore({ read });
    await store.read('s1');
    expect(store.peek('s1')).not.toBeNull();
    missing = true;
    const lookup = await store.read('s1', { maxAgeMs: 0 });
    expect(lookup.ok).toBe(false);
    if (lookup.ok) throw new Error('unreachable');
    expect(lookup.kind).toBe('missing');
    expect(store.peek('s1')).toBeNull();
  });

  it('invalidates on events (rebind / stop) and accepts a recorded session row', () => {
    const store = createPsbSessionStatusStore({ read: async (id) => sessionStatus(id) });
    store.record(sessionStatus('s1', 'stopped'));
    expect(store.peek('s1')?.status.session.status).toBe('stopped');
    store.invalidate('s1');
    expect(store.peek('s1')).toBeNull();
    store.record(sessionStatus('s2'));
    store.clear();
    expect(store.peek('s2')).toBeNull();
  });

  it('bounds the cache by entry count', async () => {
    const read = vi.fn(async (id: string) => sessionStatus(id));
    const store = createPsbSessionStatusStore({ read, maxEntries: 2 });
    await store.read('a');
    await store.read('b');
    await store.read('c');
    expect(store.peek('a')).toBeNull();
    expect(store.peek('c')).not.toBeNull();
  });

  it('decides rebind only for terminal sessions', () => {
    expect(psbSessionStatusNeedsRebind('stopped')).toBe(true);
    expect(psbSessionStatusNeedsRebind('failed')).toBe(true);
    expect(psbSessionStatusNeedsRebind('running')).toBe(false);
    expect(psbSessionStatusNeedsRebind('idle')).toBe(false);
    expect(psbSessionStatusNeedsRebind(null)).toBe(false);
  });

  it('does not cache a failed read (next send retries the control plane)', async () => {
    let fail = true;
    const read = vi.fn(async (id: string) => {
      if (fail) throw psbError('NETWORK');
      return sessionStatus(id);
    });
    const store = createPsbSessionStatusStore({ read });
    expect((await store.read('s1')).ok).toBe(false);
    fail = false;
    const lookup = await store.read('s1');
    expect(lookup.ok).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('classifies a non-PSB error shape as unavailable (never as missing)', async () => {
    const deps: PsbSessionStatusStoreDeps = {
      read: async () => {
        throw new Error('socket hang up');
      },
    };
    const store = createPsbSessionStatusStore(deps);
    const lookup = await store.read('s1');
    if (lookup.ok) throw new Error('unreachable');
    expect(lookup.kind).toBe('unavailable');
    if (lookup.kind !== 'unavailable') throw new Error('unreachable');
    expect(lookup.failure).toBeNull();
  });
});
