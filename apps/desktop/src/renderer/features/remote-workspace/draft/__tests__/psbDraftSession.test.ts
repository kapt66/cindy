/**
 * psbDraftSession 单测 —— 「首条消息懒建 PSB 会话」的去重/孤儿与「放弃草稿归还远端资源」的顺序/记账。
 *
 * 测试价值
 * - 生产入口与可观察结果：`createPsbSessionGate()` / `releasePsbDraftTarget()` 是草稿页与
 *   离开草稿路径的唯一实现（`NewMakerDraftRoute` 调它们）。可观察结果是「调了几次
 *   `bridge.createSession`、用的哪个 clientRequestId」与「stop/release 的调用顺序、失败是否入账」
 *   ——都是 PSB 侧或用户能看到的真实副作用。
 * - Bug／规则依据：`docs/dev-rules/psb-remote-session-transport.md` §2（同一草稿只能建一条
 *   PSB 会话；重试复用 `clientRequestId`）与 §3（放弃草稿先停会话再释放协作锁，否则锁在我
 *   名下且没有 TTL）；产品 §2.5（释放失败不能静默）。
 * - 2026-11-26 独立审查修复的缺口：
 *   (a) gate 判过之后、回调拒绝采纳时，旧实现已清去重键且静默 return → 远端留下没人引用的
 *       PSB 会话，重试还会再建第二条；现在未采纳会 stopSession 且**保留**去重键；
 *   (b) `reset()` 之后旧请求的 `finally` 会清掉新请求的在途句柄 → 并发 ensure 再建一条；
 *   (c) stop 超时/失败后仍 release 的失败只 `log.warn`，用户不知道锁还留着；现在记账。
 * - 最小失败输入：`onSessionCreated` 返回 false（目标在回调这一帧被换掉）；`createSession`
 *   未落地时 `reset()` 并发起第二次 `ensure`；release 被 PSB 拒绝。
 * - tier：unit（假 bridge，无网络/Electron/真实定时器）。
 * - 实测耗时：单独运行 < 1s。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NewMakerDraftPsbTarget } from '@/state/newMakerDraft';

import type { PsbRemoteBridge } from '../../bridge';
import { resetPsbPendingReleasesForTest } from '../psbPendingReleaseLedger';
import {
  createPsbSessionGate,
  releasePsbDraftTarget,
  type PsbDraftSession,
} from '../psbDraftSession';
import { deferred } from '../../__tests__/psbTestFixtures';

const TARGET: NewMakerDraftPsbTarget = {
  workspaceId: 'ws-1',
  clientId: 'client-1',
  clientName: '打包机',
  workspaceTitle: 'saga2_project',
  directoryName: 'saga2_project',
};

function createBridge(overrides: Partial<PsbRemoteBridge>): PsbRemoteBridge {
  return {
    createSession: async () => {
      throw new Error('unused');
    },
    stopSession: async () => undefined,
    releaseWorkspace: async () => {
      throw new Error('unused');
    },
    ...overrides,
  } as unknown as PsbRemoteBridge;
}

function ensureInput(overrides: {
  bridge: PsbRemoteBridge;
  onSessionCreated?: (sessionId: string) => boolean;
  isCurrentTarget?: () => boolean;
}) {
  return {
    target: TARGET,
    agentKind: 'pi' as const,
    title: null,
    getBridge: () => overrides.bridge,
    isCurrentTarget: overrides.isCurrentTarget ?? (() => true),
    onSessionCreated: overrides.onSessionCreated ?? (() => true),
  };
}

afterEach(() => {
  vi.useRealTimers();
  resetPsbPendingReleasesForTest();
});

describe('createPsbSessionGate', () => {
  it('并发 ensure 共享同一次 createSession（双击不会建出两条 PSB 会话）', async () => {
    const pending = deferred<{ session: PsbDraftSession }>();
    const createSession = vi.fn(() => pending.promise);
    const bridge = createBridge({ createSession: createSession as never });
    const gate = createPsbSessionGate();
    const input = ensureInput({ bridge });
    const first = gate.ensure(input);
    const second = gate.ensure(input);
    pending.resolve({ session: { id: 'psb-1' } as never });
    const [a, b] = await Promise.all([first, second]);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('reset() 之后旧请求的 finally 不会清掉新请求的在途句柄', async () => {
    const firstPending = deferred<{ session: PsbDraftSession }>();
    const secondPending = deferred<{ session: PsbDraftSession }>();
    let call = 0;
    const createSession = vi.fn(() => {
      call += 1;
      return call === 1 ? firstPending.promise : secondPending.promise;
    });
    const bridge = createBridge({ createSession: createSession as never });
    const gate = createPsbSessionGate();
    const input = ensureInput({ bridge });

    const stale = gate.ensure(input);
    gate.reset();
    const fresh = gate.ensure(input);
    const concurrent = gate.ensure(input);
    firstPending.reject(new Error('stale request failed'));
    await expect(stale).resolves.toMatchObject({ ok: false });

    expect(createSession).toHaveBeenCalledTimes(2); // 旧 1 次 + 新 1 次（并发共享）
    secondPending.resolve({ session: { id: 'psb-2' } as never });
    const [f, c] = await Promise.all([fresh, concurrent]);
    expect(f.ok).toBe(true);
    expect(c.ok).toBe(true);
  });

  it('回调拒绝采纳时停掉孤儿会话，并保留去重键让重试拿回同一条（不再建第二条）', async () => {
    const createSession = vi.fn(async () => ({ session: { id: 'psb-1' } }));
    const stopSession = vi.fn(async () => undefined);
    const bridge = createBridge({
      createSession: createSession as never,
      stopSession: stopSession as never,
    });
    const gate = createPsbSessionGate();
    const rejected = await gate.ensure(
      ensureInput({ bridge, onSessionCreated: () => false }),
    );
    expect(rejected).toEqual({ ok: false, reason: 'stale' });
    await vi.waitFor(() => expect(stopSession).toHaveBeenCalledWith({ sessionId: 'psb-1' }));

    // 后一次发送（目标仍没变、用户重试）：去重键还在，PSB 会拿回同一条会话。
    const adopted = await gate.ensure(ensureInput({ bridge }));
    expect(adopted.ok).toBe(true);
    expect(createSession).toHaveBeenCalledTimes(2);
    const firstRequest = (createSession.mock.calls[0] as unknown[])[0] as {
      clientRequestId: string;
    };
    const secondRequest = (createSession.mock.calls[1] as unknown[])[0] as {
      clientRequestId: string;
    };
    expect(secondRequest.clientRequestId).toBe(firstRequest.clientRequestId);
  });

  it('目标在等待期间被换掉：停掉刚建出的会话，去重键保留给重试', async () => {
    const createSession = vi.fn(async () => ({ session: { id: 'psb-9' } }));
    const stopSession = vi.fn(async () => undefined);
    const bridge = createBridge({
      createSession: createSession as never,
      stopSession: stopSession as never,
    });
    const gate = createPsbSessionGate();
    const result = await gate.ensure(
      ensureInput({ bridge, isCurrentTarget: () => false }),
    );
    expect(result).toEqual({ ok: false, reason: 'stale' });
    await vi.waitFor(() => expect(stopSession).toHaveBeenCalledWith({ sessionId: 'psb-9' }));
  });

  it('已建出会话的目标直接复用，不再请求 PSB', async () => {
    const createSession = vi.fn();
    const bridge = createBridge({ createSession: createSession as never });
    const gate = createPsbSessionGate();
    const input = ensureInput({ bridge });
    const result = await gate.ensure({
      ...input,
      target: { ...TARGET, sessionId: 'psb-existing' },
    });
    expect(result).toMatchObject({ ok: true, session: { sessionId: 'psb-existing' } });
    expect(createSession).not.toHaveBeenCalled();
  });

  // 2026-11-27 用户复测：懒建会话同样受「占用必须由用户确认」约束。main 的 createSession
  // 占用闸门在空闲时不替用户占用，返回 `PSB_WORKSPACE_NOT_OCCUPIED`；渲染层确认并显式占用
  // 成功后才重试同一次建会话（同一 clientRequestId），取消则不建、不占用。
  it('占用待确认：用户确认后重试同一次建会话（同一去重键）；取消则不建、不静默占用', async () => {
    const { registerPsbOccupyWorkspaceConfirmationResolver } = await import(
      '../../occupyRequired'
    );
    const occupyRequired = () =>
      new Error(
        "Error invoking remote method 'maker:remote-workspace:create-session': Error: [PSB_WORKSPACE_NOT_OCCUPIED] 空闲",
      );

    // ① 取消：一次 createSession，失败按原样返回（不建本地会话、不占用）。
    const unregisterDeclined = registerPsbOccupyWorkspaceConfirmationResolver(
      async () => ({ status: 'declined' }),
    );
    const declinedCreate = vi.fn(async () => {
      throw occupyRequired();
    });
    const declined = await createPsbSessionGate().ensure(
      ensureInput({ bridge: createBridge({ createSession: declinedCreate as never }) }),
    );
    expect(declined).toMatchObject({ ok: false, reason: 'failed' });
    expect(declinedCreate).toHaveBeenCalledOnce();
    unregisterDeclined();

    // ② 确认并占用成功：用同一个 clientRequestId 重试一次，成功建出会话。
    const requested: { workspaceId: string; workspaceName: string }[] = [];
    const unregisterAccepted = registerPsbOccupyWorkspaceConfirmationResolver(async (input) => {
      requested.push(input);
      return { status: 'occupied' };
    });
    const acceptedCreate = vi
      .fn()
      .mockRejectedValueOnce(occupyRequired())
      .mockResolvedValueOnce({ session: { id: 'psb-1' } });
    const accepted = await createPsbSessionGate().ensure(
      ensureInput({ bridge: createBridge({ createSession: acceptedCreate as never }) }),
    );
    expect(accepted).toMatchObject({ ok: true, session: { sessionId: 'psb-1' } });
    expect(acceptedCreate).toHaveBeenCalledTimes(2);
    const firstRequest = (acceptedCreate.mock.calls[0] as unknown[])[0] as {
      clientRequestId: string;
    };
    const secondRequest = (acceptedCreate.mock.calls[1] as unknown[])[0] as {
      clientRequestId: string;
    };
    expect(secondRequest.clientRequestId).toBe(firstRequest.clientRequestId);
    // 确认框拿到的是草稿目标的工作区事实（名字来自弹窗交接载荷）。
    expect(requested).toEqual([{ workspaceId: 'ws-1', workspaceName: 'saga2_project' }]);
    unregisterAccepted();
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
    releasePsbDraftTarget({ workspaceId: 'ws-1', sessionId: 'psb-1' }, { getBridge: () => bridge });
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

  it('stop 超时后仍会 release（远端可能已在收尸，不能把离开也拖住）', async () => {
    vi.useFakeTimers();
    const releaseWorkspace = vi.fn(async () => ({ workspace: {} as never }));
    const bridge = createBridge({
      stopSession: (() => new Promise<void>(() => undefined)) as never,
      releaseWorkspace: releaseWorkspace as never,
    });
    releasePsbDraftTarget({ workspaceId: 'ws-3', sessionId: 'psb-3' }, { getBridge: () => bridge });
    await vi.advanceTimersByTimeAsync(3000);
    expect(releaseWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-3' });
  });

  it('release 失败不再只写日志：记进待释放账本，可被显式重试', async () => {
    const releaseWorkspace = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('远端忙'), { code: 'PSB_UNREACHABLE' }),
      )
      .mockResolvedValueOnce({ workspace: {} as never });
    const bridge = createBridge({
      stopSession: async () => undefined,
      releaseWorkspace: releaseWorkspace as never,
    });
    const { listPsbPendingReleases, retryPsbPendingReleases } = await import(
      '../psbPendingReleaseLedger'
    );
    releasePsbDraftTarget({ workspaceId: 'ws-4', sessionId: null }, { getBridge: () => bridge });
    await vi.waitFor(() => expect(listPsbPendingReleases()).toHaveLength(1));
    const [entry] = listPsbPendingReleases();
    expect(entry).toMatchObject({ workspaceId: 'ws-4', attempts: 1 });
    expect(entry?.failure.code).toBe('PSB_UNREACHABLE');

    // 用户显式重试（不自动重放写操作）：成功后账本清空。
    await retryPsbPendingReleases(() => bridge);
    expect(releaseWorkspace).toHaveBeenCalledTimes(2);
    expect(listPsbPendingReleases()).toHaveLength(0);
  });
});
