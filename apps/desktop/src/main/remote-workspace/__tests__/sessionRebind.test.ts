/**
 * `main/remote-workspace/sessionRebind.ts` —— PSB 会话「发送前透明重建」的决策矩阵。
 *
 * 测试价值
 * - 生产入口与可观察结果：`createPsbSessionRebindCoordinator().prepareForSend()`。
 *   用户看到的是：远程任务里上一条 PSB 会话终态后，**下一条消息照常发出并拿到回复**
 *   （用户不需要重试，输入框也不再永久锁死）。
 * - Bug／规则依据：`docs/dev-rules/psb-remote-session-transport.md` §6 与
 *   `docs/product-rules/psb-remote-workspace-sessions.md` §2.4。修复前：PSB 会话终态
 *   ⇒ `psbSessionInputAllowed` 永久禁止输入并显示「这个任务已经结束」。
 * - 现有覆盖缺口：`apps/desktop/src/renderer/features/remote-workspace/stream/__tests__/
 *   remoteWorkspaceStreamGates.test.ts` 只覆盖「终态 ⇒ 禁止输入」的旧纯函数口径，没有任何
 *   用例覆盖「终态 ⇒ 发送时重建一次并重绑」的主进程行为、并发去重与失败语义。
 * - 最小失败输入：`sessions.remote_host_id = 'psb:old'` + PSB 返回 `stopped`，然后发送
 *   一条消息。旧实现直接拒绝；新实现必须建一条新 PSB 会话并把本地行改成 `psb:new`。
 * - tier：unit（决策逻辑全注入、无 Electron / DB / 网络）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildPsbRemoteHostId,
  psbSessionInputAllowed,
  psbSessionNeedsRebind,
  type PsbCreateSessionRequest,
  type PsbRemoteFailure,
  type PsbRemoteSession,
  type PsbRemoteWorkspace,
  type PsbSessionsReboundEvent,
  type PsbSessionStatusResult,
} from '../../../shared/psb-remote-workspace';
import {
  createPsbSessionRebindCoordinator,
  type PsbRebindCreateOutcome,
  type PsbRebindRemoteLookup,
  type PsbSessionRebindDeps,
  type PsbSessionRebindRow,
} from '../sessionRebind';

/* ------------------------------ fixtures ------------------------------ */

const WORKSPACE_ID = 'ws-1';

function makeWorkspace(overrides: Partial<PsbRemoteWorkspace> = {}): PsbRemoteWorkspace {
  return {
    id: WORKSPACE_ID,
    title: '远程工作区',
    clientId: 'client-1',
    clientName: '远端机器',
    clientOnline: true,
    clientPlatform: 'win32',
    state: 'ready',
    templateKey: null,
    templateTitle: null,
    directoryName: 'demo',
    clientPath: 'C:\\remote\\demo',
    occupancy: {
      occupied: false,
      byMe: false,
      personId: null,
      personName: '',
      occupiedAt: null,
    },
    usable: true,
    unusableReason: null,
    sessionCount: 1,
    webUrl: null,
    sessionsWebUrl: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<PsbRemoteSession> = {}): PsbRemoteSession {
  return {
    id: 'old',
    workspaceId: WORKSPACE_ID,
    clientId: 'client-1',
    title: null,
    agentKind: 'claude-code',
    status: 'running',
    statusMessage: null,
    createdAt: '2026-11-26T00:00:00.000Z',
    updatedAt: '2026-11-26T00:00:00.000Z',
    createdBy: { personId: null, personName: '我', source: 'cindy' },
    webUrl: null,
    ...overrides,
  };
}

function makeRow(overrides: Partial<PsbSessionRebindRow> = {}): PsbSessionRebindRow {
  return {
    remoteHostId: buildPsbRemoteHostId('old'),
    agentKind: 'cc',
    title: '修一下登录',
    sdkSessionId: 'sdk-old',
    workspaceId: null,
    ...overrides,
  };
}

const closedByOther: PsbRemoteFailure = {
  code: 'WORKSPACE_OCCUPIED_BY_OTHER',
  messageKey: 'remoteWorkspace.error.occupiedByOther',
  message: '小王',
};

const clientOffline: PsbRemoteFailure = {
  code: 'CLIENT_OFFLINE',
  messageKey: 'remoteWorkspace.error.clientOffline',
  message: 'offline',
};

interface Harness {
  readonly deps: PsbSessionRebindDeps;
  readonly createCalls: PsbCreateSessionRequest[];
  readonly persistCalls: Array<Parameters<PsbSessionRebindDeps['persistRebind']>[0]>;
  readonly stopCalls: string[];
  readonly emitted: PsbSessionsReboundEvent[];
  readonly remoteReads: string[];
  readonly listCalls: { count: number };
  row: PsbSessionRebindRow | null;
  lookup: PsbRebindRemoteLookup;
  workspaces: PsbRemoteWorkspace[];
  running: boolean;
  listFailure: PsbRemoteFailure | null;
  createOutcome: PsbRebindCreateOutcome | null;
  createDeferred: Promise<void> | null;
  persistFailure: Error | null;
  persistResult: 'persisted' | 'conflict';
  persistSideEffect: (() => void) | null;
}

function makeHarness(overrides: Partial<Harness> = {}): Harness {
  const h: Harness = {
    deps: undefined as unknown as PsbSessionRebindDeps,
    createCalls: [],
    persistCalls: [],
    stopCalls: [],
    emitted: [],
    remoteReads: [],
    listCalls: { count: 0 },
    row: makeRow(),
    lookup: { kind: 'found', result: { session: makeSession(), workspace: makeWorkspace() } },
    workspaces: [makeWorkspace()],
    running: false,
    listFailure: null,
    createOutcome: null,
    createDeferred: null,
    persistFailure: null,
    persistResult: 'persisted',
    persistSideEffect: null,
    ...overrides,
  };
  const deps: PsbSessionRebindDeps = {
    log: { info: vi.fn(), warn: vi.fn() },
    readSessionRow: async () => h.row,
    isTurnRunning: () => h.running,
    readRemoteSession: async (psbSessionId) => {
      h.remoteReads.push(psbSessionId);
      return h.lookup;
    },
    listWorkspaces: async () => {
      h.listCalls.count += 1;
      return h.listFailure
        ? { kind: 'failed', failure: h.listFailure }
        : { kind: 'listed', workspaces: h.workspaces };
    },
    createRemoteSession: async (input) => {
      h.createCalls.push(input);
      if (h.createDeferred) await h.createDeferred;
      if (h.createOutcome) return h.createOutcome;
      return {
        kind: 'created',
        result: {
          session: makeSession({ id: `new-${h.createCalls.length}`, workspaceId: input.workspaceId }),
          workspace: makeWorkspace(),
        },
      };
    },
    persistRebind: async (input) => {
      h.persistCalls.push(input);
      h.persistSideEffect?.();
      if (h.persistFailure) throw h.persistFailure;
      return h.persistResult;
    },
    stopRemoteSession: async (psbSessionId) => {
      h.stopCalls.push(psbSessionId);
    },
    emitRebound: (event) => {
      h.emitted.push(event);
    },
    createRequestId: () => `req-${h.createCalls.length + 1}`,
  };
  (h as { deps: PsbSessionRebindDeps }).deps = deps;
  return h;
}

/* ------------------------------ cases ------------------------------ */

describe('psb 会话发送前重建（决策矩阵）', () => {
  it('终态 ⇒ 在同一工作区新建一条会话并把本地任务重绑过去', async () => {
    const h = makeHarness({
      lookup: {
        kind: 'found',
        result: { session: makeSession({ status: 'stopped' }), workspace: makeWorkspace() },
      },
    });
    const coordinator = createPsbSessionRebindCoordinator(h.deps);

    const outcome = await coordinator.prepareForSend('local-1');

    // 用户可观察结果：这一轮可以继续（调用方拿到新身份后继续发送）。
    expect(outcome).toEqual({
      previousRemoteHostId: 'psb:old',
      remoteHostId: 'psb:new-1',
    });
    // 新 PSB 会话沿用同一工作区 + 同一引擎 + 同一标题。
    expect(h.createCalls).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        agentKind: 'claude-code',
        title: '修一下登录',
        clientRequestId: 'req-1',
      },
    ]);
    // 本地行先落新身份（并清掉旧的原生会话 id，否则新会话会 resume 不存在的会话）。
    expect(h.persistCalls).toEqual([
      {
        sessionId: 'local-1',
        previousRemoteHostId: 'psb:old',
        remoteHostId: 'psb:new-1',
        workspaceId: WORKSPACE_ID,
        clearNativeSession: true,
      },
    ]);
    // 渲染层要知道「这个任务换了一条会话」。
    expect(h.emitted).toEqual([
      { localSessionId: 'local-1', previousRemoteHostId: 'psb:old', remoteHostId: 'psb:new-1' },
    ]);
    // 没有回收动作：新建的会话已经接管。
    expect(h.stopCalls).toEqual([]);
  });

  it('失败态同样重建（failed 与 stopped 是同一类终态）', async () => {
    const h = makeHarness({
      lookup: {
        kind: 'found',
        result: { session: makeSession({ status: 'failed' }), workspace: makeWorkspace() },
      },
    });
    await expect(createPsbSessionRebindCoordinator(h.deps).prepareForSend('local-1')).resolves.toEqual({
      previousRemoteHostId: 'psb:old',
      remoteHostId: 'psb:new-1',
    });
  });

  it('会话还活着 ⇒ 不重建、不打扰 PSB 以外的东西', async () => {
    const h = makeHarness(); // status = 'running'
    await expect(
      createPsbSessionRebindCoordinator(h.deps).prepareForSend('local-1'),
    ).resolves.toBeNull();
    expect(h.createCalls).toEqual([]);
    expect(h.persistCalls).toEqual([]);
    expect(h.emitted).toEqual([]);
  });

  it('不是 psb 会话（本地 / SSH / MCPRouter）⇒ 完全不碰 PSB', async () => {
    for (const remoteHostId of [null, 'ssh-host-1', 'mcpr:instance-1']) {
      const h = makeHarness({ row: makeRow({ remoteHostId }) });
      await expect(
        createPsbSessionRebindCoordinator(h.deps).prepareForSend('local-1'),
      ).resolves.toBeNull();
      expect(h.remoteReads, `remoteHostId=${String(remoteHostId)}`).toEqual([]);
    }
  });

  it('有回合在跑 ⇒ 绝不重建（也不读 PSB，不关运行时）', async () => {
    const h = makeHarness({
      running: true,
      lookup: {
        kind: 'found',
        result: { session: makeSession({ status: 'stopped' }), workspace: makeWorkspace() },
      },
    });
    await expect(
      createPsbSessionRebindCoordinator(h.deps).prepareForSend('local-1'),
    ).resolves.toBeNull();
    expect(h.remoteReads).toEqual([]);
    expect(h.createCalls).toEqual([]);
  });

  it('并发两次发送只建一条新 PSB 会话，两边拿到同一个新身份', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({
      createDeferred: gate,
      lookup: {
        kind: 'found',
        result: { session: makeSession({ status: 'stopped' }), workspace: makeWorkspace() },
      },
    });
    const coordinator = createPsbSessionRebindCoordinator(h.deps);

    const first = coordinator.prepareForSend('local-1');
    const second = coordinator.prepareForSend('local-1');
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(h.createCalls).toHaveLength(1);
    expect(h.persistCalls).toHaveLength(1);
    expect(a).toEqual({ previousRemoteHostId: 'psb:old', remoteHostId: 'psb:new-1' });
    expect(b).toEqual(a);
  });

  it.each([
    ['被他人占用', makeWorkspace({
      occupancy: {
        occupied: true,
        byMe: false,
        personId: '2',
        personName: '小王',
        occupiedAt: 1,
      },
    }), 'PSB_WORKSPACE_OCCUPIED_BY_OTHER'],
    ['客户端离线', makeWorkspace({ clientOnline: false }), 'PSB_CLIENT_OFFLINE'],
    ['工作区未就绪', makeWorkspace({ state: 'provisioning' }), 'PSB_WORKSPACE_NOT_READY'],
  ])('%s ⇒ 不重建、抛可行动失败码', async (_label, workspace, expectedCode) => {
    const h = makeHarness({
      lookup: {
        kind: 'found',
        result: { session: makeSession({ status: 'stopped' }), workspace },
      },
    });
    const coordinator = createPsbSessionRebindCoordinator(h.deps);

    await expect(coordinator.prepareForSend('local-1')).rejects.toMatchObject({
      code: expectedCode,
    });
    // 关键：不建、不改、不广播 —— 下次发送还能再试。
    expect(h.createCalls).toEqual([]);
    expect(h.persistCalls).toEqual([]);
    expect(h.emitted).toEqual([]);
  });

  it('旧 PSB 会话已不存在（404）⇒ 仍重建，工作区 id 来自本地记录', async () => {
    const h = makeHarness({
      lookup: { kind: 'missing' },
      row: makeRow({ workspaceId: WORKSPACE_ID }),
    });
    await expect(
      createPsbSessionRebindCoordinator(h.deps).prepareForSend('local-1'),
    ).resolves.toEqual({ previousRemoteHostId: 'psb:old', remoteHostId: 'psb:new-1' });
    expect(h.listCalls.count).toBe(1);
    expect(h.persistCalls[0]?.workspaceId).toBe(WORKSPACE_ID);
  });

  it('旧会话已不存在且没有工作区线索 ⇒ 报 PSB_NOT_FOUND，不猜工作区', async () => {
    const h = makeHarness({ lookup: { kind: 'missing' } });
    await expect(
      createPsbSessionRebindCoordinator(h.deps).prepareForSend('local-1'),
    ).rejects.toMatchObject({ code: 'PSB_NOT_FOUND' });
    expect(h.createCalls).toEqual([]);
  });

  it('新建失败 ⇒ 不重绑；下一次发送可以重试成功', async () => {
    const h = makeHarness({
      createOutcome: { kind: 'failed', failure: clientOffline },
      lookup: {
        kind: 'found',
        result: { session: makeSession({ status: 'stopped' }), workspace: makeWorkspace() },
      },
    });
    const coordinator = createPsbSessionRebindCoordinator(h.deps);

    await expect(coordinator.prepareForSend('local-1')).rejects.toMatchObject({
      code: 'PSB_CLIENT_OFFLINE',
    });
    expect(h.persistCalls).toEqual([]);
    expect(h.emitted).toEqual([]);

    // 用户再发一条：失败没有留在 in-flight 里，这次成功重绑。
    h.createOutcome = null;
    await expect(coordinator.prepareForSend('local-1')).resolves.toEqual({
      previousRemoteHostId: 'psb:old',
      remoteHostId: 'psb:new-2',
    });
    expect(h.createCalls).toHaveLength(2);
    expect(h.persistCalls).toHaveLength(1);
  });

  it('落库失败 ⇒ 回收刚建的 PSB 会话、不广播、下一条消息可再试', async () => {
    const h = makeHarness({
      lookup: {
        kind: 'found',
        result: { session: makeSession({ status: 'stopped' }), workspace: makeWorkspace() },
      },
      persistFailure: new Error('db is locked'),
    });
    const coordinator = createPsbSessionRebindCoordinator(h.deps);

    await expect(coordinator.prepareForSend('local-1')).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    expect(h.stopCalls).toEqual(['new-1']);
    expect(h.emitted).toEqual([]);

    // 恢复后重试：仍然按同一条旧身份发起，能成功。
    h.persistFailure = null;
    await expect(coordinator.prepareForSend('local-1')).resolves.toEqual({
      previousRemoteHostId: 'psb:old',
      remoteHostId: 'psb:new-2',
    });
  });

  it('落库期发现别人已改过这一行 ⇒ 按库里的现值继续（回滚自己那条）', async () => {
    const h = makeHarness({
      lookup: {
        kind: 'found',
        result: { session: makeSession({ status: 'stopped' }), workspace: makeWorkspace() },
      },
      persistResult: 'conflict',
      persistSideEffect: () => {
        // 另一实例在这中间完成了一次重绑。
        h.row = makeRow({ remoteHostId: 'psb:winner' });
      },
    });

    await expect(
      createPsbSessionRebindCoordinator(h.deps).prepareForSend('local-1'),
    ).resolves.toEqual({ previousRemoteHostId: 'psb:old', remoteHostId: 'psb:winner' });
    expect(h.stopCalls).toEqual(['new-1']);
  });
});

describe('共享判据（main / renderer 同一份）', () => {
  it('psbSessionNeedsRebind 只在已知终态时为 true', () => {
    expect(psbSessionNeedsRebind('stopped')).toBe(true);
    expect(psbSessionNeedsRebind('failed')).toBe(true);
    for (const live of ['starting', 'running', 'idle'] as const) {
      expect(psbSessionNeedsRebind(live)).toBe(false);
    }
    // 「还没读到状态」不能预告重建。
    expect(psbSessionNeedsRebind(null)).toBe(false);
    expect(psbSessionNeedsRebind(undefined)).toBe(false);
  });

  it('终态不再阻断输入；真正阻断只剩占用 / 离线 / 未就绪', () => {
    const onlineWorkspace = { state: 'ready' as const, clientOnline: true, occupancy: makeWorkspace().occupancy };
    expect(
      psbSessionInputAllowed({
        session: makeSession({ status: 'stopped' }),
        workspace: onlineWorkspace,
      }),
    ).toEqual({ allowed: true, reason: null });

    expect(
      psbSessionInputAllowed({
        session: makeSession({ status: 'running' }),
        workspace: {
          ...onlineWorkspace,
          occupancy: { occupied: true, byMe: false, personId: '2', personName: '小王', occupiedAt: 1 },
        },
      }),
    ).toEqual({ allowed: false, reason: 'remoteWorkspace.input.occupiedByOther' });
    expect(
      psbSessionInputAllowed({
        session: makeSession({ status: 'stopped' }),
        workspace: { ...onlineWorkspace, clientOnline: false },
      }),
    ).toEqual({ allowed: false, reason: 'remoteWorkspace.input.clientOffline' });
    expect(
      psbSessionInputAllowed({
        session: makeSession({ status: 'stopped' }),
        workspace: { ...onlineWorkspace, state: 'provisioning' },
      }),
    ).toEqual({ allowed: false, reason: 'remoteWorkspace.input.workspaceNotReady' });
  });
});
