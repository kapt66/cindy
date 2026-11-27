/**
 * makerChatStorePsbSendPreflight.test.ts
 * ---------------------------------------------------------------------------
 * PSB 远程工作区任务的**发送前占用预检**（2026-11-27 用户复测口径）在 store 侧的行为契约。
 *
 * 测试价值
 * - 生产入口与可观察结果：`makerChatStore.sendMessage` / `steerMessage` / `resumeQueue` /
 *   `retryLastError` 是 composer、草稿页首条消息、队列恢复、重试与自动重发唯一的发送入口；
 *   `psbRemote.sessionStatus` / `occupyWorkspace` / `maker.input.enqueue` 是用户真实能看到的
 *   远端请求与消息落库。可观察结果：先问还是先发、取消时是否真的没发、是否多弹一次确认。
 * - Bug／规则依据：用户截图里消息先进入对话变成「回复未完成 / [PSB_WORKSPACE_NOT_OCCUPIED]」，
 *   即旧链路「先发出去 → 失败 → 才弹确认」。用户要求发送前预检：未占用先确认，取消就**完全
 *   不发送**（不排队、不落库、不出失败气泡，草稿保留）；确认则先显式占用成功再发送。
 *   主进程闸门仍是最终权威：预检通过后被抢仍会失败，失败后确认只作竞态兜底，且不能与预检
 *   重复弹两次确认。
 * - 现有覆盖缺口：既有 `occupyRequired.test.ts` 只覆盖「失败之后」的确认实现；没有任何用例钉
 *   「发送前预检」的顺序（occupy 在 enqueue 之前）、取消零写入、读不到时放行给主进程。
 * - 最小失败输入：① 空闲工作区 + 用户取消；② 空闲 + 确认后被抢（预检已占用仍失败）；
 *   ③ 他人占用 / 离线；④ `sessionStatus` 拒绝；⑤ 队列恢复（resumeQueue）时工作区被交接。
 * - tier：unit（假 PSB 桥 + 假 ipc，无网络 / 无 Electron）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentInputProjection, AgentInputQueuedMessage } from '../../shared/agentInputQueue';
import type {
  PsbRemoteSession,
  PsbRemoteWorkspace,
  PsbSessionStatusResult,
} from '../../shared/psb-remote-workspace';
import {
  confirmAndOccupyPsbWorkspaceDetailed,
  registerPsbOccupyConfirmationResolver,
  registerPsbOccupyWorkspaceConfirmationResolver,
} from '@/features/remote-workspace/occupyRequired';
import {
  makeOccupiedByMeWorkspace,
  makeOccupiedByOtherWorkspace,
  makePsbWorkspace,
} from '@/features/remote-workspace/__tests__/psbTestFixtures';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => ({ items: [], hasMore: false, oldestId: null })),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));

vi.mock('@/lib/sessionService', () => ({
  touchUserSend: vi.fn(async () => {}),
  update: vi.fn(async () => ({})),
  get: vi.fn(async () => null),
}));

vi.mock('@/lib/sessionsBus', () => ({
  emitPatch: vi.fn(),
}));

vi.mock('@/lib/userPromptStore', () => ({
  getUserPrompt: () => 'test user prompt',
}));

vi.mock('@/lib/memorySettingsStore', () => ({
  getMakerMemoryEnabled: () => true,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/lib/imageRef', () => ({
  parseUserContent: vi.fn((c: string) => ({ text: c, images: [], files: [] })),
  stringifyUserContent: vi.fn((text: string, images = [], files = []) =>
    JSON.stringify({ text, images, files }),
  ),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  setRemoteOptimisticAttachmentUrls: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import { toast } from '@/lib/toast';
import i18n from '@/i18n';
import { PSB_SEND_PREFLIGHT_READ_TIMEOUT_MS } from '@/features/remote-workspace/psbSendPreflight';

const t = i18n.t.bind(i18n);

const MODEL = 'claude-opus-4-7';
const EFFORT = 'medium';
const PERM = 'default';
const WD = 'C:\\workspace';
const PSB_SESSION_ID = 'psb-session-1';

function projection(
  sessionId: string,
  patch: Partial<AgentInputProjection> = {},
): AgentInputProjection {
  return {
    sessionId,
    pendingQueue: [],
    steeringQueueClientIds: [],
    queuePaused: false,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    error: null,
    recovery: null,
    errorRetryText: null,
    credentialSwitchWait: null,
    ...patch,
  };
}

function queuedItem(clientId: string, text: string): AgentInputQueuedMessage {
  return {
    clientId,
    text,
    persistedContent: JSON.stringify({ text, images: [], files: [] }),
    model: MODEL,
    effort: EFFORT,
    permissionMode: PERM,
    workingDir: WD,
    chatMessage: {
      clientId,
      role: 'user',
      content: text,
      isStreaming: false,
      createdAt: '2026-11-27T00:00:00.000Z',
    },
    createOpts: {
      agentKind: 'claude-code',
      workingDir: WD,
      model: MODEL,
      effort: EFFORT,
      permissionMode: PERM,
      userPrompt: 'test user prompt',
      makerMemoryEnabled: true,
      displayReasoning: 'summarized',
    },
  };
}

function psbSession(): PsbRemoteSession {
  return {
    id: PSB_SESSION_ID,
    workspaceId: 'workspace-1',
    clientId: 'client-1',
    title: '远程任务',
    agentKind: 'claude-code',
    status: 'running',
    statusMessage: null,
    createdAt: '2026-11-27T00:00:00.000Z',
    updatedAt: '2026-11-27T00:00:00.000Z',
    createdBy: { personId: 'me', personName: '我', source: 'cindy' },
    webUrl: null,
  };
}

/** 预检读到的当前工作区事实（每个用例可覆盖）。 */
let currentWorkspace: PsbRemoteWorkspace;
/** `occupy` 与 `send` 的真实发生顺序（断言「占用成功后才发送」）。 */
let callOrder: string[];
let projectionHandler: ((projection: AgentInputProjection) => void) | null = null;

const enqueue = vi.fn(async (sessionId: string, item: AgentInputQueuedMessage) => {
  callOrder.push('send');
  return projection(sessionId, { pendingQueue: [item] });
});
const steer = vi.fn(async () => {
  callOrder.push('steer');
  return true;
});
const resume = vi.fn(async (sessionId: string) => {
  callOrder.push('resume');
  return projection(sessionId, { queuePaused: false });
});
const retryLastError = vi.fn(async (sessionId: string) => {
  callOrder.push('retry');
  return projection(sessionId);
});
const getProjection = vi.fn(async (sessionId: string) => projection(sessionId));
const sessionStatus = vi.fn(async (): Promise<PsbSessionStatusResult> => ({
  session: psbSession(),
  workspace: currentWorkspace,
}));
const occupyWorkspace = vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
  callOrder.push('occupy');
  // 与 PSB 一致：占用成功后工作区变成「由我占用」。
  currentWorkspace = makeOccupiedByMeWorkspace({ id: workspaceId });
  return { workspace: currentWorkspace };
});
const adminContext = vi.fn(async () => ({ context: null }));

function installElectronBridge(): void {
  projectionHandler = null;
  const w = globalThis as unknown as { window?: Record<string, unknown> };
  if (!w.window) w.window = {};
  w.window.electronAPI = {
    maker: {
      input: { enqueue, steer, resume, retryLastError, getProjection },
      onInputProjection: vi.fn((cb: (projection: AgentInputProjection) => void) => {
        projectionHandler = cb;
        return vi.fn();
      }),
      onEvent: vi.fn(() => vi.fn()),
      onStatusChanged: vi.fn(() => vi.fn()),
      onInteractionRequest: vi.fn(() => vi.fn()),
      onInteractionDismissed: vi.fn(() => vi.fn()),
      send: vi.fn(async () => {}),
      steer: vi.fn(async () => {}),
      generateTitle: vi.fn(async () => ({ title: 't' })),
      abortSession: vi.fn(async () => {}),
      closeSession: vi.fn(async () => {}),
      listActive: vi.fn(async () => []),
    },
    localDb: {
      messages: {
        onCreated: vi.fn(() => vi.fn()),
      },
    },
    deviceLink: { invoke: vi.fn().mockResolvedValue(undefined) },
    psbRemote: {
      sessionStatus,
      occupyWorkspace,
      adminContext,
      releaseWorkspace: vi.fn(async () => ({ workspace: currentWorkspace })),
    },
  };
}

/**
 * 注册「按工作区」确认宿主（生产里由 `PsbOccupyRequiredConfirmation` 挂载）。
 *
 * `approve` = 用户在确认框里点确认还是取消；同时注册**失败后**确认（sessionId 版）的替身，
 * 用来钉「预检已占用成功时不再弹第二次确认」与「预检只是放行时失败后兜底仍在」。
 */
function registerOccupyHost(approve: boolean): {
  confirm: ReturnType<typeof vi.fn>;
  sessionFallback: ReturnType<typeof vi.fn>;
} {
  const confirm = vi.fn(async () => approve);
  unregisters.push(
    registerPsbOccupyWorkspaceConfirmationResolver(async ({ workspaceId, workspaceName }) =>
      confirmAndOccupyPsbWorkspaceDetailed({
        t,
        confirm,
        bridge: { occupyWorkspace },
        workspaceId,
        workspaceName,
      }),
    ),
  );
  const sessionFallback = vi.fn(async () => false);
  unregisters.push(registerPsbOccupyConfirmationResolver(sessionFallback));
  return { confirm, sessionFallback };
}

let unregisters: Array<() => void> = [];

/** 把会话标成 `psb:` 远程工作区任务（store 由此启动预检）。 */
function seedPsbSession(sessionId: string): void {
  makerChatStore.setSessionRuntime(sessionId, { remoteHostId: `psb:${PSB_SESSION_ID}` });
}

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  unregisters = [];
  callOrder = [];
  currentWorkspace = makePsbWorkspace();
  makerChatStore.__teardownGlobalListeners();
  installElectronBridge();
});

afterEach(() => {
  for (const unregister of unregisters) unregister();
  makerChatStore.__teardownGlobalListeners();
  vi.restoreAllMocks();
});

function newSessionId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('发送前占用预检（sendMessage）', () => {
  it('空闲 + 取消：问一次确认，但不占用也不发送（无待发消息 / 失败气泡，首条状态保留）', async () => {
    const sid = newSessionId('preflight-cancel');
    seedPsbSession(sid);
    const { confirm } = registerOccupyHost(false);

    const accepted = await makerChatStore.sendMessage(sid, 'hello', MODEL, EFFORT, PERM, WD);

    expect(accepted).toBe(false);
    expect(sessionStatus).toHaveBeenCalledExactlyOnceWith({ sessionId: PSB_SESSION_ID });
    expect(confirm).toHaveBeenCalledOnce();
    expect(occupyWorkspace).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();

    const snapshot = makerChatStore.getSnapshot(sid);
    expect(snapshot.pendingQueue).toHaveLength(0);
    expect(snapshot.messages).toHaveLength(0);
    expect(snapshot.error).toBeNull();
    // 没有消费「首条消息」状态：调用方（ChatInput）按 false 保留草稿 / 附件后可原样重发。
    expect(snapshot.isFirstMessage).toBe(true);
  });

  it('空闲 + 确认：先显式占用一次，再发送一次（顺序在占用成功之后）', async () => {
    const sid = newSessionId('preflight-confirm');
    seedPsbSession(sid);
    const { confirm } = registerOccupyHost(true);

    const accepted = await makerChatStore.sendMessage(sid, 'hello', MODEL, EFFORT, PERM, WD);

    expect(accepted).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(occupyWorkspace).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-1' });
    expect(enqueue).toHaveBeenCalledOnce();
    // 关键顺序：占用成功之后才把消息交给主进程。
    expect(callOrder).toEqual(['occupy', 'send']);
  });

  it('已由我占用（byMe）：直接发送，不弹确认、不再占用', async () => {
    const sid = newSessionId('preflight-mine');
    seedPsbSession(sid);
    currentWorkspace = makeOccupiedByMeWorkspace();
    const { confirm } = registerOccupyHost(true);

    const accepted = await makerChatStore.sendMessage(sid, 'hello', MODEL, EFFORT, PERM, WD);

    expect(accepted).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(occupyWorkspace).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(['send']);
  });

  it('他人占用：发送前拦下并给可行动提示，不发送、不产生失败气泡', async () => {
    const sid = newSessionId('preflight-other');
    seedPsbSession(sid);
    currentWorkspace = makeOccupiedByOtherWorkspace();
    const { confirm } = registerOccupyHost(true);
    const warning = vi.spyOn(toast, 'warning');

    const accepted = await makerChatStore.sendMessage(sid, 'hello', MODEL, EFFORT, PERM, WD);

    expect(accepted).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(occupyWorkspace).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      i18n.t('remoteWorkspace.error.occupiedByOther', { name: '张三' }),
    );
    // 「提示」不是对话里的失败气泡：消息流 / 队列 / error 都不留痕。
    const snapshot = makerChatStore.getSnapshot(sid);
    expect(snapshot.messages).toHaveLength(0);
    expect(snapshot.pendingQueue).toHaveLength(0);
    expect(snapshot.error).toBeNull();
  });

  it('客户端离线：发送前拦下并给离线原因，不发送、不产生失败气泡', async () => {
    const sid = newSessionId('preflight-offline');
    seedPsbSession(sid);
    currentWorkspace = makePsbWorkspace({ clientOnline: false });
    const { confirm } = registerOccupyHost(true);
    const warning = vi.spyOn(toast, 'warning');

    const accepted = await makerChatStore.sendMessage(sid, 'hello', MODEL, EFFORT, PERM, WD);

    expect(accepted).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(occupyWorkspace).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      i18n.t('remoteWorkspace.error.clientOffline'),
    );
    expect(makerChatStore.getSnapshot(sid).error).toBeNull();
  });

  it('空闲 + 确认后占用失败（被抢）：可行动提示（占用人名）、不发送，也不产生失败气泡', async () => {
    const sid = newSessionId('preflight-occupy-fail');
    seedPsbSession(sid);
    registerOccupyHost(true);
    occupyWorkspace.mockRejectedValueOnce(
      new Error('[PSB_WORKSPACE_OCCUPIED_BY_OTHER] 李四'),
    );
    const warning = vi.spyOn(toast, 'warning');

    const accepted = await makerChatStore.sendMessage(sid, 'hello', MODEL, EFFORT, PERM, WD);

    expect(accepted).toBe(false);
    expect(occupyWorkspace).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      i18n.t('remoteWorkspace.error.occupiedByOther', { name: '李四' }),
    );
    const snapshot = makerChatStore.getSnapshot(sid);
    expect(snapshot.messages).toHaveLength(0);
    expect(snapshot.pendingQueue).toHaveLength(0);
    expect(snapshot.error).toBeNull();
  });

  it('sessionStatus 读取失败：预检不拦（fail-open），照常交给主进程权威闸门', async () => {
    const sid = newSessionId('preflight-read-fail');
    seedPsbSession(sid);
    sessionStatus.mockRejectedValueOnce(new Error('network down'));
    const { confirm } = registerOccupyHost(true);

    const accepted = await makerChatStore.sendMessage(sid, 'hello', MODEL, EFFORT, PERM, WD);

    expect(accepted).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(occupyWorkspace).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('sessionStatus 迟迟不返回（超过预检读预算）：不拦截、照常发送，避免点发送后长时间无反应', async () => {
    vi.useFakeTimers();
    try {
      const sid = newSessionId('preflight-read-slow');
      seedPsbSession(sid);
      sessionStatus.mockImplementationOnce(() => new Promise(() => {}));
      const { confirm } = registerOccupyHost(false);

      const acceptedPromise = makerChatStore.sendMessage(sid, 'hello', MODEL, EFFORT, PERM, WD);
      await vi.advanceTimersByTimeAsync(PSB_SEND_PREFLIGHT_READ_TIMEOUT_MS + 10);
      const accepted = await acceptedPromise;

      expect(accepted).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('非 psb 任务：零 PSB 请求、零预检（本机发送路径不引入 await）', async () => {
    const sid = newSessionId('preflight-local');

    const accepted = await makerChatStore.sendMessage(sid, 'hello', MODEL, EFFORT, PERM, WD);

    expect(accepted).toBe(true);
    expect(sessionStatus).not.toHaveBeenCalled();
    expect(occupyWorkspace).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
  });
});

describe('预检与「失败后确认」的关系（主进程仍是最终权威）', () => {
  it('预检刚占用成功、主进程闸门仍拒绝（被抢）：不再弹第二次确认，失败只落错误横幅', async () => {
    const sid = newSessionId('preflight-race');
    seedPsbSession(sid);
    const { confirm, sessionFallback } = registerOccupyHost(true);
    enqueue.mockRejectedValueOnce(
      new Error('[PSB_WORKSPACE_NOT_OCCUPIED] 这个工作区还没有被占用'),
    );

    const accepted = await makerChatStore.sendMessage(sid, 'hello', MODEL, EFFORT, PERM, WD);

    expect(accepted).toBe(false);
    expect(occupyWorkspace).toHaveBeenCalledOnce();
    // 同一次发送只弹一次确认（预检那次）；竞态失败走错误横幅，不再问一遍。
    expect(confirm).toHaveBeenCalledOnce();
    expect(sessionFallback).not.toHaveBeenCalled();
    expect(makerChatStore.getSnapshot(sid).error).not.toBeNull();
  });

  it('预检只是放行（byMe 未占用动作）时，失败后的确认兜底仍然保留', async () => {
    const sid = newSessionId('preflight-fallback');
    seedPsbSession(sid);
    currentWorkspace = makeOccupiedByMeWorkspace();
    const { confirm, sessionFallback } = registerOccupyHost(true);
    enqueue.mockRejectedValueOnce(
      new Error('[PSB_WORKSPACE_NOT_OCCUPIED] 这个工作区还没有被占用'),
    );

    const accepted = await makerChatStore.sendMessage(sid, 'hello', MODEL, EFFORT, PERM, WD);

    expect(accepted).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    // 失败后确认（按 sessionId 解析工作区）仍是竞态兜底。
    expect(sessionFallback).toHaveBeenCalledExactlyOnceWith(sid);
  });
});

describe('队列 / 重发路径同样预检', () => {
  it('resumeQueue（队列自动 drain 前）：拦下 / 取消时不调用 main 的 resume；放行时才恢复', async () => {
    const sid = newSessionId('preflight-resume');
    makerChatStore.initGlobalListeners();
    seedPsbSession(sid);
    projectionHandler!(
      projection(sid, { pendingQueue: [queuedItem('q1', 'queued message')], queuePaused: true }),
    );
    expect(projectionHandler).toBeTypeOf('function');

    // ① 空闲 + 取消：队列消息不恢复、不自动发出。
    const declined = registerOccupyHost(false);
    makerChatStore.resumeQueue(sid);
    await flushPromises();
    expect(declined.confirm).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    unregisters.forEach((unregister) => unregister());
    unregisters = [];

    // ② 已由我占用：放行，调用 main 恢复队列（随后由 main drain）。
    currentWorkspace = makeOccupiedByMeWorkspace();
    registerOccupyHost(true);
    makerChatStore.resumeQueue(sid);
    await flushPromises();
    expect(resume).toHaveBeenCalledOnce();
  });

  it('retryLastError（重发上一次失败消息）：拦下时不调用 main 的 retry', async () => {
    const sid = newSessionId('preflight-retry');
    seedPsbSession(sid);
    currentWorkspace = makeOccupiedByOtherWorkspace();
    const { confirm } = registerOccupyHost(true);

    await makerChatStore.retryLastError(sid);

    expect(confirm).not.toHaveBeenCalled();
    expect(retryLastError).not.toHaveBeenCalled();
  });
});
