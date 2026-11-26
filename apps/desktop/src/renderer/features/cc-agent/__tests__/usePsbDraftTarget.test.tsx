// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：真实挂载 `usePsbDraftTarget`（草稿页远程工作区目标的资源生命周期），
 *   注入 mock bridge，走「懒建会话成功 / 失败 / 已被本地会话接手 / 放弃草稿」四条主路径，
 *   断言草稿 store 与 bridge 调用顺序。
 * - Bug／规则依据：2026-11-26 独立审查 r6 P1——成功发出首条消息后占用无释放路径（归档 / 删除 /
 *   退出都不还，PSB 占用无 TTL 会永久锁住远端工作区）；以及懒建失败绝不能留下半截目标。
 *   2026-11-27 s5 复审 P1——一次性交接意图的 layout effect 只依赖稳定回调：草稿页内再次导航到
 *   `/cc-agent/new`（只换 history state、不 remount）时新意图既不落地也不被消费，弹窗那侧刚
 *   占用成功的工作区因此没有任何释放路径。本文件用「重渲染同一路径」复现该时序。
 * - 现有覆盖缺口：原 `newMakerDraftTargetCatalog.test.ts` 用 TS AST + `new Function` 执行路由源码
 *   文本来断言 PSB 守卫，hook 抽取后那些断言既脆弱又不再对应生产入口；这里改为行为测试。
 * - 最小失败输入：同路径导航只换 state；`ensure` 失败仍继续建本地会话；或 `commit()` 后仍释放
 *   占用（抢走别人正在用的锁）。
 * - tier：unit（jsdom + 受控 bridge，无网络/进程）。
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getDraft,
  patchDraft,
  resetDraftWorkspaceTargets,
  type NewMakerDraftPsbTarget,
} from '@/state/newMakerDraft';
import { __testing as ownerTesting } from '@/contexts/dataOwnerGeneration';
import { usePsbDraftTarget, type UsePsbDraftTargetOptions } from '../usePsbDraftTarget';
import type { NewMakerNavigationIntent } from '../lib/newMakerRouteState';

const target: NewMakerDraftPsbTarget = {
  workspaceId: 'ws-1',
  clientId: 'client-1',
  clientName: '设计机',
  workspaceTitle: 'SAGA2',
  directoryName: 'saga2_design',
  sessionId: null,
};

function makeBridge(
  overrides: Partial<{
    createSession: ReturnType<typeof vi.fn>;
    stopSession: ReturnType<typeof vi.fn>;
    releaseWorkspace: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    createSession:
      overrides.createSession ?? vi.fn(async () => ({ session: { id: 'psb-session-1' } })),
    stopSession: overrides.stopSession ?? vi.fn(async () => undefined),
    releaseWorkspace: overrides.releaseWorkspace ?? vi.fn(async () => ({ workspace: {} })),
    occupyWorkspace: vi.fn(),
  };
}

type Bridge = ReturnType<typeof makeBridge>;

/** 一次「远程工作区」交接意图（与 `makePsbTargetNewMakerRouteState` 同形）。 */
function handoverIntent(
  workspaceId: string,
  overrides: Partial<NewMakerDraftPsbTarget> = {},
): Extract<NewMakerNavigationIntent, { kind: 'psbTarget' }> {
  return {
    kind: 'psbTarget',
    requestId: `psb:${workspaceId}:1`,
    workspaceId,
    clientId: 'client-1',
    clientName: '设计机',
    workspaceTitle: workspaceId === 'ws-1' ? 'SAGA2' : 'SAGA2-2',
    directoryName: workspaceId === 'ws-1' ? 'saga2_design' : 'saga2_design_2',
    ...overrides,
  };
}

/** route state 里带着同一个意图（应用后它应该被消费掉）。 */
function routeStateFor(intent: Extract<NewMakerNavigationIntent, { kind: 'psbTarget' }>) {
  return { workspacePrompt: 'generic', newMakerIntent: intent };
}

interface HookProps {
  intent: NewMakerNavigationIntent | null;
  locationState: unknown;
  locationKey: string;
}

function renderPsb(options: {
  bridge: Bridge;
  intent?: NewMakerNavigationIntent | null;
  busy?: boolean;
  locationState?: unknown;
  locationKey?: string;
  onApply?: (next: NewMakerDraftPsbTarget) => void;
}) {
  const applyTarget = vi.fn(options.onApply);
  const navigate = vi.fn();
  const toastWarning = vi.fn();
  const logWarn = vi.fn();
  let props: HookProps = {
    intent: options.intent ?? null,
    locationState: options.locationState ?? {},
    locationKey: options.locationKey ?? 'loc-1',
  };
  const hook = renderHook(
    (current: HookProps) =>
      usePsbDraftTarget({
        draft: getDraft(),
        getBridge: () => options.bridge as never,
        applyTarget,
        dataOwnerId: 'owner-1',
        location: {
          pathname: '/cc-agent/new',
          search: '',
          hash: '',
          key: current.locationKey,
          state: current.locationState,
        },
        navigate,
        intent: current.intent,
        isBusy: () => options.busy === true,
        toastWarning,
        t: (key: string) => key,
        logWarn,
      }),
    { initialProps: props },
  );
  /** 模拟「同一路径、只有 history state / location 变化」的再次导航（组件不 remount）。 */
  const rerender = (patch: Partial<HookProps> = {}) => {
    props = { ...props, ...patch };
    hook.rerender(props);
  };
  return { hook, applyTarget, navigate, toastWarning, rerender };
}

beforeEach(() => {
  ownerTesting.reset();
  localStorage.clear();
  resetDraftWorkspaceTargets();
  patchDraft({ psbTarget: null });
});

describe('usePsbDraftTarget lazy session creation', () => {
  it('creates the PSB session once, writes the id back to the draft, and reuses it on retry', async () => {
    patchDraft({ psbTarget: target });
    const bridge = makeBridge();
    const { hook } = renderPsb({ bridge });

    let first: Awaited<ReturnType<typeof hook.result.current.ensureSessionForSend>> = null;
    await act(async () => {
      first = await hook.result.current.ensureSessionForSend('claude-code', '首条消息');
    });
    expect(first).toMatchObject({ ok: true, session: { sessionId: 'psb-session-1' } });
    expect(bridge.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        agentKind: 'claude-code',
        title: '首条消息',
      }),
    );
    // 回写进草稿：重试 / 重发复用同一条，不会建第二条 PSB 会话。
    expect(getDraft().psbTarget?.sessionId).toBe('psb-session-1');

    await act(async () => {
      const second = await hook.result.current.ensureSessionForSend('claude-code');
      expect(second).toMatchObject({ ok: true, session: { sessionId: 'psb-session-1' } });
    });
    expect(bridge.createSession).toHaveBeenCalledTimes(1);
  });

  it('reports a failure without creating a local session or mutating the target', async () => {
    patchDraft({ psbTarget: target });
    const bridge = makeBridge({
      createSession: vi.fn(async () => {
        throw new Error('PSB unavailable');
      }),
    });
    const { hook, applyTarget } = renderPsb({ bridge });

    let result: Awaited<ReturnType<typeof hook.result.current.ensureSessionForSend>> = null;
    await act(async () => {
      result = await hook.result.current.ensureSessionForSend('codex');
    });
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    // 调用方据此停留在草稿：目标不被改写、不落 applyTarget。
    expect(getDraft().psbTarget?.sessionId ?? null).toBeNull();
    expect(applyTarget).not.toHaveBeenCalled();
  });

  it('returns null when the draft has no PSB target (nothing to lazily create)', async () => {
    const { hook } = renderPsb({ bridge: makeBridge() });
    await act(async () => {
      expect(await hook.result.current.ensureSessionForSend('pi')).toBeNull();
    });
  });
});

describe('usePsbDraftTarget occupancy release', () => {
  it('releases the abandoned workspace on unmount when no local session took it over', async () => {
    patchDraft({ psbTarget: { ...target, sessionId: 'psb-session-1' } });
    const bridge = makeBridge();
    const { hook } = renderPsb({ bridge });
    act(() => {
      hook.unmount();
    });
    await waitFor(() => {
      expect(bridge.stopSession).toHaveBeenCalledWith({ sessionId: 'psb-session-1' });
      expect(bridge.releaseWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-1' });
    });
    // 目标已失效：不把「已释放的工作区」留给下一次进入草稿页。
    expect(getDraft().psbTarget).toBeNull();
  });

  it('keeps the workspace after commit: the local session owns the occupancy', async () => {
    patchDraft({ psbTarget: target });
    const bridge = makeBridge();
    const { hook } = renderPsb({ bridge });
    act(() => {
      hook.result.current.commit();
    });
    expect(hook.result.current.isCommitted()).toBe(true);
    act(() => {
      hook.unmount();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.releaseWorkspace).not.toHaveBeenCalled();
  });

  it('releases the previous workspace when the draft switches to another target', async () => {
    patchDraft({ psbTarget: target });
    const bridge = makeBridge();
    const { hook, applyTarget, rerender } = renderPsb({
      bridge,
      onApply: (next) => patchDraft({ psbTarget: next }),
    });
    act(() => {
      hook.result.current.selectWorkspace({
        workspaceId: 'ws-2',
        clientId: 'client-1',
        clientName: '设计机',
        workspaceTitle: 'SAGA2-2',
        directoryName: 'saga2_design_2',
      });
    });
    expect(applyTarget).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-2' }));
    rerender();
    await waitFor(() => {
      expect(bridge.releaseWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-1' });
    });
  });

  it('returns a freshly occupied workspace when an in-flight send rejects the switch', () => {
    patchDraft({ psbTarget: target });
    const bridge = makeBridge();
    const { hook, applyTarget, toastWarning } = renderPsb({ bridge, busy: true });
    let accepted = false;
    act(() => {
      accepted = hook.result.current.selectWorkspace({
        workspaceId: 'ws-new',
        clientId: 'client-1',
        clientName: '设计机',
        workspaceTitle: '新工作区',
        directoryName: 'new',
      });
    });
    expect(accepted).toBe(false);
    // 占用没有 TTL：这次选择进不了草稿就必须立刻还回去。
    expect(bridge.releaseWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-new' });
    expect(applyTarget).not.toHaveBeenCalled();
    expect(toastWarning).toHaveBeenCalledWith('remoteWorkspace.draft.actionBusy');
  });
});

describe('usePsbDraftTarget one-shot handover intent', () => {
  it('applies a workspace handover on mount, keeps the lazily created session id, and consumes the intent', () => {
    patchDraft({ psbTarget: { ...target, sessionId: 'psb-session-1' } });
    const bridge = makeBridge();
    const intent = handoverIntent('ws-1');
    const { applyTarget, navigate } = renderPsb({
      bridge,
      intent,
      locationState: routeStateFor(intent),
    });
    // 首帧前由 layout effect 自动应用：调用方不需要手动调 controller。
    // 回到同一个工作区：沿用已懒建的 sessionId，不把旧 PSB 会话变成孤儿。
    expect(applyTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        sessionId: 'psb-session-1',
      }),
    );
    // 一次性指令：应用后从 history state 移除，后退不会重放。
    expect(navigate).toHaveBeenCalledWith(
      '/cc-agent/new',
      expect.objectContaining({
        replace: true,
        state: expect.not.objectContaining({ newMakerIntent: expect.anything() }),
      }),
    );
  });

  it('applies and consumes a handover that arrives by same-path navigation, without remounting', () => {
    // 用户已经停在 `/cc-agent/new`（本次草稿占着 ws-1）；侧栏此时选定另一个远程工作区，
    // 路由只 replace/push 同一路径的 history state —— 组件不 remount，intent 只能来自重渲染。
    patchDraft({ psbTarget: { ...target, sessionId: 'psb-session-1' } });
    const bridge = makeBridge();
    const { applyTarget, navigate, rerender } = renderPsb({ bridge });
    expect(applyTarget).not.toHaveBeenCalled();

    const intent = handoverIntent('ws-2');
    act(() => {
      rerender({
        intent,
        locationState: routeStateFor(intent),
        locationKey: 'loc-2',
      });
    });

    // 新工作区在首帧前落到草稿；否则弹窗刚占用的 ws-2 永远不会有人释放。
    expect(applyTarget).toHaveBeenCalledTimes(1);
    expect(applyTarget).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-2' }));
    // 一次性语义不因同路径导航退化：应用后仍消费掉 history state。
    expect(navigate).toHaveBeenCalledWith(
      '/cc-agent/new',
      expect.objectContaining({
        replace: true,
        state: expect.not.objectContaining({ newMakerIntent: expect.anything() }),
      }),
    );
  });

  it('re-applies a repeated delivery at most once per owner + request id', () => {
    const bridge = makeBridge();
    const { applyTarget, rerender } = renderPsb({ bridge });
    const first = handoverIntent('ws-2');
    act(() => {
      rerender({ intent: first, locationState: routeStateFor(first), locationKey: 'loc-2' });
    });
    expect(applyTarget).toHaveBeenCalledTimes(1);
    // 同一意图再次到达（新的对象身份、同一 requestId）：去重键挡住第二次应用，
    // 已占用的工作区不会因此被重复写进草稿。
    const repeat = { ...handoverIntent('ws-2') };
    act(() => {
      rerender({ intent: repeat, locationState: routeStateFor(repeat), locationKey: 'loc-2' });
    });
    expect(applyTarget).toHaveBeenCalledTimes(1);
  });

  it('releases the previous occupancy when a same-path handover replaces the target', async () => {
    // 端到端形状：同路径交接把草稿从 ws-1 换到 ws-3，页面没有卸载，旧占用仍必须释放。
    patchDraft({ psbTarget: { ...target, sessionId: 'psb-session-1' } });
    const bridge = makeBridge();
    const { rerender } = renderPsb({
      bridge,
      onApply: (next) => patchDraft({ psbTarget: next }),
    });
    const intent = handoverIntent('ws-3', { workspaceTitle: 'SAGA3' });
    act(() => {
      rerender({ intent, locationState: routeStateFor(intent), locationKey: 'loc-3' });
    });
    expect(getDraft().psbTarget?.workspaceId).toBe('ws-3');
    // 目标变更后 hook 的「换目标 = 放弃上一处占用」effect 生效（弹窗占用没有 TTL）。
    act(() => {
      rerender();
    });
    await waitFor(() => {
      expect(bridge.releaseWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-1' });
    });
  });
});
