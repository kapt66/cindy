/**
 * psbDraftSession 单测 —— 「首条消息懒建 PSB 会话」的去重与「放弃草稿归还远端资源」的顺序。
 *
 * 测试价值
 * - 生产入口与可观察结果：`createPsbSessionGate()` / `releasePsbDraftTarget()` 是草稿页与
 *   离开草稿路径的唯一实现（`NewMakerDraftRoute` 调它们）。可观察结果是「调了几次
 *   `bridge.createSession`」与「stop/release 的调用顺序」——都是 PSB 侧能看到的真实副作用。
 * - Bug／规则依据：`docs/dev-rules/psb-remote-session-transport.md` §2（同一草稿只能建一条
 *   PSB 会话；重试复用 `clientRequestId`）与 §3（放弃草稿先停会话再释放协作锁，
 *   否则锁在我名下且没有 TTL）。
 * - 现有覆盖缺口：这两条不变量此前只由人工联调发现——(a) `reset()` 之后旧请求的 `finally`
 *   会把新请求的在途句柄清掉，导致紧随其后的并发 `ensure` 再建一条 PSB 会话（新
 *   `clientRequestId`，PSB 幂等键挡不住）；(b) stop 与 release 并发发出时，服务端可能因
 *   「仍有运行中会话」拒绝释放，锁留下。
 * - 最小失败输入：在 `createSession` 未落地时 `reset()` 并发起第二次 `ensure`；以及带
 *   sessionId 的目标直接 `releasePsbDraftTarget`。
 * - tier：unit（假 bridge，无网络/Electron/真实定时器）。
 * - 实测耗时：单独运行 < 1s。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createPsbSessionGate,
  releasePsbDraftTarget,
  type PsbDraftSession,
} from '../psbDraftSession';
import type { PsbRemoteBridge } from '../../bridge';
import type { NewMakerDraftPsbTarget } from '@/state/newMakerDraft';

const TARGET: NewMakerDraftPsbTarget = {
  workspaceId: 'ws-1',
  clientId: 'client-1',
  clientName: '打包机',
  workspaceTitle: 'saga2_project',
  directoryName: 'saga2_project',
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (e: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createBridge(overrides: Partial<PsbRemoteBridge>): PsbRemoteBridge {
  return {
    status: async () => ({ ready: true, reasonKey: null, host: 'h', testHost: false }),
    listWorkspaces: async () => ({ workspaces: [] }),
    listClients: async () => ({ clients: [] }),
    listProjectTemplates: async () => ({ templates: [] }),
    createWorkspace: async () => {
      throw new Error('unused');
    },
    occupyWorkspace: async () => {
      throw new Error('unused');
    },
    releaseWorkspace: async () => {
      throw new Error('unused');
    },
    createSession: async () => {
      throw new Error('unused');
    },
    sessionStatus: async () => {
      throw new Error('unused');
    },
    stopSession: async () => undefined,
    openWebWorkspace: async () => undefined,
    refreshWorkspaces: async () => ({ workspaces: [] }),
    streamStatus: async () => {
      throw new Error('unused');
    },
    streamStart: async () => {
      throw new Error('unused');
    },
    streamStop: async () => undefined,
    streamInput: async () => undefined,
    onStreamEvent: () => () => undefined,
    onWorkspaceChanged: () => () => undefined,
    ...overrides,
  } as PsbRemoteBridge;
}

describe('createPsbSessionGate', () => {
  it('并发 ensure 共享同一次 createSession（双击不会建出两条 PSB 会话）', async () => {
    const pending = deferred<{ session: PsbDraftSession }>();
    const createSession = vi.fn(() => pending.promise);
    const bridge = createBridge({ createSession: createSession as never });
    const gate = createPsbSessionGate();
    const input = {
      target: TARGET,
      agentKind: 'pi' as const,
      title: null,
      getBridge: () => bridge,
      isCurrentTarget: () => true,
      onSessionCreated: () => undefined,
    };
    const first = gate.ensure(input);
    const second = gate.ensure(input);
    pending.resolve({ session: { id: 'psb-1' } as never });
    const [a, b] = await Promise.all([first, second]);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('reset() 之后旧请求的 finally 不会清掉新请求的在途句柄', async () => {
    // 场景：createSession 未落地 → reset()（换目标/离开草稿）→ 立刻第二次 ensure。
    // 旧请求结束时若无条件 `inFlight = null`，会把新请求的句柄清掉，后面的并发 ensure
    // 于是再发一条 createSession（新 clientRequestId），远端多出一条孤儿会话。
    const firstPending = deferred<{ session: PsbDraftSession }>();
    const secondPending = deferred<{ session: PsbDraftSession }>();
    let call = 0;
    const createSession = vi.fn(() => {
      call += 1;
      return call === 1 ? firstPending.promise : secondPending.promise;
    });
    const bridge = createBridge({ createSession: createSession as never });
    const gate = createPsbSessionGate();
    const base = {
      target: TARGET,
      agentKind: 'pi' as const,
      title: null,
      getBridge: () => bridge,
      isCurrentTarget: () => true,
      onSessionCreated: () => undefined,
    };

    const stale = gate.ensure(base);
    gate.reset();
    const fresh = gate.ensure(base);
    const concurrent = gate.ensure(base); // 应与 fresh 共享，而不是再发一条
    // 旧请求失败收尾：不能影响新请求的在途状态。
    firstPending.reject(new Error('stale request failed'));
    await expect(stale).resolves.toMatchObject({ ok: false });

    expect(createSession).toHaveBeenCalledTimes(2); // 旧 1 次 + 新 1 次（并发共享）
    secondPending.resolve({ session: { id: 'psb-2' } as never });
    const [f, c] = await Promise.all([fresh, concurrent]);
    expect(f.ok).toBe(true);
    expect(c.ok).toBe(true);
  });
});

describe('releasePsbDraftTarget', () => {
  it('先 stop 会话、等它落地后才 release 工作区（锁不会因并发而留下）', async () => {
    const order: string[] = [];
    const stopPending = deferred<void>();
    const bridge = createBridge({
      stopSession: (async () => {
        order.push('stop:start');
        await stopPending.promise;
        order.push('stop:done');
      }) as never,
      releaseWorkspace: (async () => {
        order.push('release');
        return { workspace: {} as never };
      }) as never,
    });
    releasePsbDraftTarget(
      { workspaceId: 'ws-1', sessionId: 'psb-1' },
      { getBridge: () => bridge },
    );
    await Promise.resolve();
    // stop 还没落地时不能 release
    expect(order).toEqual(['stop:start']);
    stopPending.resolve();
    await vi.waitFor(() => expect(order).toEqual(['stop:start', 'stop:done', 'release']));
  });

  it('没有建过 PSB 会话时只释放占用', async () => {
    const order: string[] = [];
    const bridge = createBridge({
      releaseWorkspace: (async () => {
        order.push('release');
        return { workspace: {} as never };
      }) as never,
    });
    releasePsbDraftTarget({ workspaceId: 'ws-2', sessionId: null }, { getBridge: () => bridge });
    await vi.waitFor(() => expect(order).toEqual(['release']));
  });
});
