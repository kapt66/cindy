/**
 * PSB 工作区占用闸门（`workspaceLock.ts`）。
 *
 * 测试价值
 * - 生产入口与可观察结果：`createPsbWorkspaceLock(ports).ensure()` 是「开新会话 / 启动串流 /
 *   发送消息」三条写入路径共用的唯一锁定判据。用户可观察结果是：未被自己锁定 → **不自动占用**，
 *   返回 `occupy-required`（由渲染层弹确认框，用户确认后才显式占用）；被别人占用 → 可行动失败
 *   （带人名）；离线 / 未就绪 / 不可见 → 对应原因；网络失败 → 报错。
 * - Bug／规则依据：PSB 服务端对工作区写操作做占用闸门（2026-11-26 口径），Cindy 必须在写入前
 *   自己锁定，否则只能在 PSB 拒绝后显示一句不可行动的失败。**2026-11-27 用户人工复测**：任何
 *   工作区占用都必须由用户通过弹窗确认，禁止默认 / 自动占用。规则见
 *   `docs/dev-rules/psb-remote-session-transport.md` §12 与
 *   `docs/product-rules/psb-remote-workspace-sessions.md`「写前锁定」。
 * - 现有覆盖缺口：原用例只钉「未占用 → 自动占用」。现在必须同时钉「缺省不占用、不发 POST
 *   /occupy、返回 occupy-required」「显式 allowAutoOccupy 才会占用」「发送路径权威读 free 时也
 *   是 occupy-required」，以及失败 → `PSB_WORKSPACE_NOT_OCCUPIED` 文案码。
 * - 最小失败输入：① 列表里工作区 `occupancy.occupied=false` 且不带选项（应 0 次占用请求）；
 *   ② 同样输入带 `allowAutoOccupy:true`（应占用一次）；③ `occupy` 抛 `WORKSPACE_OCCUPIED_BY_OTHER`；
 *   ④ `listWorkspaces` 抛网络错误；⑤ 同一工作区 1.5s 内连续两次 ensure（应只有一次请求）。
 * - tier：unit（进程内内存 fake，无网络 / 无 Electron）。
 * - 实测耗时：单独运行约 1.8s（用例本身毫秒级；其余为 vitest 启动与模块加载）。
 */

import { describe, expect, it } from 'vitest';

import {
  psbIpcCodeForFailure,
  type PsbRemoteWorkspace,
  type PsbSessionStatusResult,
} from '../../../shared/psb-remote-workspace';
import { PsbClientError } from '../psbClient';
import {
  PSB_WORKSPACE_LOCK_TTL_MS,
  createPsbWorkspaceLock,
  psbWorkspaceLockFailure,
  psbWorkspaceLockFailureError,
} from '../workspaceLock';

const WORKSPACE_ID = 'ws-saga2';

function workspaceRow(overrides: Partial<PsbRemoteWorkspace> = {}): PsbRemoteWorkspace {
  return {
    id: WORKSPACE_ID,
    title: 'saga2_project',
    clientId: 'client-pack',
    clientName: '打包机',
    clientOnline: true,
    clientPlatform: 'win32',
    state: 'ready',
    templateKey: 'saga2',
    templateTitle: 'Saga2',
    directoryName: 'saga2_project-2',
    clientPath: 'D:\\psb\\saga2_project-2',
    occupancy: { occupied: false, byMe: false, personId: null, personName: '', occupiedAt: null },
    usable: true,
    unusableReason: null,
    sessionCount: 0,
    webUrl: null,
    sessionsWebUrl: null,
    ...overrides,
  };
}

function occupiedByMe(): PsbRemoteWorkspace {
  return workspaceRow({
    occupancy: { occupied: true, byMe: true, personId: '7', personName: '我', occupiedAt: 1 },
  });
}

function occupiedByOther(name = '张三'): PsbRemoteWorkspace {
  return workspaceRow({
    occupancy: { occupied: true, byMe: false, personId: '9', personName: name, occupiedAt: 2 },
  });
}

interface HarnessOptions {
  workspaces?: () => Promise<PsbRemoteWorkspace[]>;
  occupy?: (workspaceId: string) => Promise<PsbRemoteWorkspace>;
  /** 发送前闸门读会话行（缺省 = 会话属于 `WORKSPACE_ID`，工作区按 `workspaces` 或默认空闲行）。 */
  session?: (psbSessionId: string) => Promise<PsbSessionStatusResult>;
  now?: () => number;
}

/** 一条 PSB 会话行 + 工作区快照（`ensureForSession` 的读口返回值）。 */
function sessionStatus(
  psbSessionId: string,
  workspace: PsbRemoteWorkspace,
): PsbSessionStatusResult {
  return {
    session: {
      id: psbSessionId,
      workspaceId: workspace.id,
      clientId: 'client-pack',
      title: '用户任务',
      agentKind: 'pi',
      status: 'running',
      statusMessage: null,
      createdAt: '2026-11-26T01:00:00.000Z',
      updatedAt: '2026-11-26T01:00:00.000Z',
      createdBy: { personId: '7', personName: '我', source: 'cindy' },
      webUrl: null,
    },
    workspace,
  };
}

function createHarness(options: HarnessOptions = {}) {
  const counts = { list: 0, occupy: 0, session: 0 };
  let clock = 0;
  const lock = createPsbWorkspaceLock(
    {
      listWorkspaces: async () => {
        counts.list += 1;
        return options.workspaces ? options.workspaces() : [workspaceRow()];
      },
      occupyWorkspace: async (workspaceId) => {
        counts.occupy += 1;
        return {
          workspace: options.occupy ? await options.occupy(workspaceId) : occupiedByMe(),
          // 0.1.180：占用响应可能带建议性 VCS 通知；锁只关心工作区行（advisory 由服务层广播）。
          vcs: null,
        };
      },
      readSession: async (psbSessionId) => {
        counts.session += 1;
        if (options.session) return options.session(psbSessionId);
        return sessionStatus(psbSessionId, workspaceRow());
      },
    },
    { now: options.now ?? (() => clock) },
  );
  return {
    lock,
    counts,
    advance(ms: number) {
      clock += ms;
    },
  };
}

function psbFailure(code: string, message: string | null = null): PsbClientError {
  return new PsbClientError({ code, messageKey: 'remoteWorkspace.error.unknown', message }, null);
}

describe('占用闸门：状态机', () => {
  it('未被占用（缺省）→ occupy-required，且**不发任何占用请求**（占用必须由用户确认）', async () => {
    const harness = createHarness();

    expect(await harness.lock.ensure(WORKSPACE_ID)).toEqual({ ok: false, reason: 'occupy-required' });
    // 用户还没确认：闸门不得替用户占用（2026-11-27 用户复测口径）。
    expect(harness.counts).toEqual({ list: 1, occupy: 0, session: 0 });
    // 失败不缓存：下一次仍按事实判定（不会因为上一次「待确认」就放行 / 也不再自动占用）。
    expect(await harness.lock.ensure(WORKSPACE_ID)).toEqual({ ok: false, reason: 'occupy-required' });
    expect(harness.counts).toEqual({ list: 2, occupy: 0, session: 0 });
  });

  it('显式 allowAutoOccupy（用户已确认的占用 / 选择流程）→ 占用一次后放行；乐观有效期内不再请求', async () => {
    const harness = createHarness();

    expect(await harness.lock.ensure(WORKSPACE_ID, { allowAutoOccupy: true })).toEqual({
      ok: true,
    });
    expect(harness.counts).toEqual({ list: 1, occupy: 1, session: 0 });

    // 连续发送不为每条消息多打一次 PSB：TTL 内走缓存。
    expect(await harness.lock.ensure(WORKSPACE_ID)).toEqual({ ok: true });
    expect(harness.counts).toEqual({ list: 1, occupy: 1, session: 0 });

    harness.advance(PSB_WORKSPACE_LOCK_TTL_MS + 1);
    expect(await harness.lock.ensure(WORKSPACE_ID, { allowAutoOccupy: true })).toEqual({
      ok: true,
    });
    expect(harness.counts.list).toBe(2);
  });

  it('已由自己占用 → 放行，且不再调用 occupy', async () => {
    const harness = createHarness({ workspaces: async () => [occupiedByMe()] });

    expect(await harness.lock.ensure(WORKSPACE_ID)).toEqual({ ok: true });
    expect(harness.counts).toEqual({ list: 1, occupy: 0, session: 0 });
  });

  it('被他人占用 → occupied-by-other + 占用人名，且不尝试占用', async () => {
    const harness = createHarness({ workspaces: async () => [occupiedByOther('李四')] });

    expect(await harness.lock.ensure(WORKSPACE_ID)).toEqual({
      ok: false,
      reason: 'occupied-by-other',
      personName: '李四',
    });
    expect(harness.counts.occupy).toBe(0);
  });

  it('客户端离线 / 工作区未就绪 / 工作区不可见 → 各自的 reason（不尝试占用）', async () => {
    const offline = createHarness({ workspaces: async () => [workspaceRow({ clientOnline: false })] });
    expect(await offline.lock.ensure(WORKSPACE_ID)).toEqual({ ok: false, reason: 'offline' });
    expect(offline.counts.occupy).toBe(0);

    const provisioning = createHarness({
      workspaces: async () => [workspaceRow({ state: 'provisioning' })],
    });
    expect(await provisioning.lock.ensure(WORKSPACE_ID)).toEqual({
      ok: false,
      reason: 'workspace-unavailable',
      missing: false,
      state: 'provisioning',
    });

    const gone = createHarness({ workspaces: async () => [] });
    expect(await gone.lock.ensure(WORKSPACE_ID)).toEqual({
      ok: false,
      reason: 'workspace-unavailable',
      missing: true,
      state: null,
    });
  });

  it('显式占用时被他人抢先 → 仍按 occupied-by-other 回报（人名来自 PSB 失败原文）', async () => {
    const harness = createHarness({
      occupy: async () => {
        throw psbFailure('WORKSPACE_OCCUPIED_BY_OTHER', '王五');
      },
    });

    expect(await harness.lock.ensure(WORKSPACE_ID, { allowAutoOccupy: true })).toEqual({
      ok: false,
      reason: 'occupied-by-other',
      personName: '王五',
    });
  });

  it('失败不缓存：占用被释放后，下一次显式 ensure 立刻重新占用', async () => {
    let workspaces = [occupiedByOther('张三')];
    const harness = createHarness({ workspaces: async () => workspaces });

    expect(await harness.lock.ensure(WORKSPACE_ID, { allowAutoOccupy: true })).toMatchObject({
      ok: false,
      reason: 'occupied-by-other',
    });
    // 对方释放（无人占用）：下一次必须重新判断，不能被上一次失败缓存挡掉。
    workspaces = [workspaceRow()];
    expect(await harness.lock.ensure(WORKSPACE_ID, { allowAutoOccupy: true })).toEqual({
      ok: true,
    });
    expect(harness.counts.occupy).toBe(1);
  });

  it('网络失败原样抛出，不静默当成「可以写」', async () => {
    const harness = createHarness({
      workspaces: async () => {
        throw psbFailure('PSB_UNREACHABLE', '连不上 PSB');
      },
    });

    await expect(harness.lock.ensure(WORKSPACE_ID)).rejects.toMatchObject({
      failure: { code: 'PSB_UNREACHABLE' },
    });
  });

  it('PSB 的权威 usable/unusableReason 被采信（不是只看在线 + state）', async () => {
    // 旧实现完全不读 `usable`：PSB 说「不能开新会话」时 Cindy 仍放行。四种原因各自成可行动结果。
    const occupied = createHarness({
      workspaces: async () => [
        workspaceRow({
          usable: false,
          unusableReason: 'occupied-by-other',
          occupancy: {
            occupied: true,
            byMe: false,
            personId: '9',
            personName: '李四',
            occupiedAt: 2,
          },
        }),
      ],
    });
    expect(await occupied.lock.ensure(WORKSPACE_ID)).toEqual({
      ok: false,
      reason: 'occupied-by-other',
      personName: '李四',
    });

    const offline = createHarness({
      workspaces: async () => [
        workspaceRow({ usable: false, unusableReason: 'client-offline' }),
      ],
    });
    expect(await offline.lock.ensure(WORKSPACE_ID)).toEqual({ ok: false, reason: 'offline' });

    const notReady = createHarness({
      workspaces: async () => [
        workspaceRow({ usable: false, unusableReason: 'workspace-not-ready' }),
      ],
    });
    expect(await notReady.lock.ensure(WORKSPACE_ID)).toMatchObject({
      ok: false,
      reason: 'workspace-unavailable',
      missing: false,
    });
  });

  it('agent-unsupported 只否定「开新会话」：工作区级写入口（占用闸门）不被无关原因锁死', async () => {
    const harness = createHarness({
      workspaces: async () => [
        workspaceRow({ usable: false, unusableReason: 'agent-unsupported' }),
      ],
    });
    // 占用闸门服务建会话 / 启串流 / 发送三条写入口；串流与那台机器有没有某 Harness 无关，
    // 所以这里按 requireAgentRuntime:false 放行（用户确认后显式占用的那条路径）。
    expect(await harness.lock.ensure(WORKSPACE_ID, { allowAutoOccupy: true })).toEqual({
      ok: true,
    });
    expect(harness.counts.occupy).toBe(1);
  });

  it('调用方给出新鲜快照 → 不读列表（发送路径少一次请求）', async () => {
    const harness = createHarness({ workspaces: async () => [occupiedByMe()] });

    expect(await harness.lock.ensure(WORKSPACE_ID, { snapshot: occupiedByMe() })).toEqual({
      ok: true,
    });
    expect(harness.counts).toEqual({ list: 0, occupy: 0, session: 0 });
  });

  it('释放后失效缓存：下一次 ensure 重新确认', async () => {
    const harness = createHarness();
    await harness.lock.ensure(WORKSPACE_ID, { allowAutoOccupy: true });
    expect(harness.counts.list).toBe(1);

    harness.lock.invalidate(WORKSPACE_ID);
    await harness.lock.ensure(WORKSPACE_ID, { allowAutoOccupy: true });
    expect(harness.counts.list).toBe(2);
  });
});

describe('占用闸门：发送前（按 PSB 会话）', () => {
  it('首次读一次会话行（自带工作区快照）→ 未占用时 occupy-required，不自动占用；TTL 内再发送零请求', async () => {
    const harness = createHarness();

    expect(await harness.lock.ensureForSession('psb-1')).toEqual({
      ok: false,
      reason: 'occupy-required',
    });
    // 会话行给了工作区快照，不需要再读工作区列表；**没有发任何占用请求**。
    expect(harness.counts).toEqual({ list: 0, occupy: 0, session: 1 });

    // 失败不缓存：第二次仍读会话行（不是 TTL 放行，也不是自动占用）。
    expect(await harness.lock.ensureForSession('psb-1')).toEqual({
      ok: false,
      reason: 'occupy-required',
    });
    expect(harness.counts).toEqual({ list: 0, occupy: 0, session: 2 });
  });

  it('会话行显示工作区已被他人占用 → occupied-by-other（人名来自快照），不尝试占用', async () => {
    const harness = createHarness({
      session: async (psbSessionId) => sessionStatus(psbSessionId, occupiedByOther('李四')),
    });

    expect(await harness.lock.ensureForSession('psb-1')).toEqual({
      ok: false,
      reason: 'occupied-by-other',
      personName: '李四',
    });
    expect(harness.counts.occupy).toBe(0);
  });

  it('会话行读不到（已被清理）→ 原样抛出，不静默放行', async () => {
    const harness = createHarness({
      session: async () => {
        throw psbFailure('NOT_FOUND', '会话不存在');
      },
    });

    await expect(harness.lock.ensureForSession('psb-1')).rejects.toMatchObject({
      failure: { code: 'NOT_FOUND' },
    });
  });
});

/**
 * 发送路径的**权威校验**（2026-11-27 用户复测口径）。
 *
 * 测试价值
 * - 生产入口与可观察结果：`createPsbWorkspaceLock(ports).ensureForSession(id, { requireAuthoritative: true })`
 *   是发送前闸门（`makerSendTransaction` → `register.preparePsbWorkspaceLock`）的唯一判定入口。
 *   用户可观察结果：会话创建后工作区被交接给别人时，**下一条消息**被拒（不发送、给可行动文案）；
 *   被交接回空闲时**也不自动占用**，返回 `PSB_WORKSPACE_NOT_OCCUPIED`（渲染层弹确认框，
 *   用户确认后才占用并重试）；PSB 读不到时也是失败而不是「无法确认就继续」。
 * - Bug／规则依据：旧实现先在 `register` 用 10s 会话快照「在线 + ready + byMe」零请求放行、读不到
 *   fail-open；`ensureForSession` 又有 1.5s 乐观缓存——两条路径都可能让「别人的工作区」继续收到本端
 *   写入。用户口径（2026-11-27 人工复测）：每条消息发送前都必须确认当前仍由我占用；**占用一律由
 *   用户确认**（2026-11-27 第二次复测追加）。
 * - 现有覆盖缺口：原用例只覆盖「TTL 内零请求」这条**非权威**语义，没有任何用例钉「发送路径不吃
 *   缓存」「权威读不是 mine 时清缓存」。
 * - 最小失败输入：① 缓存过 mine、权威读改回 other；② 权威读抛 `PSB_UNREACHABLE`；③ 权威读 free。
 * - tier：unit（进程内内存 fake，无网络 / 无 Electron）。
 */
describe('占用闸门：发送路径的权威校验（requireAuthoritative）', () => {
  it('权威路径每次都读 PSB 会话行，乐观缓存不再是放行依据', async () => {
    const harness = createHarness({
      session: async (psbSessionId) => sessionStatus(psbSessionId, occupiedByMe()),
    });

    expect(await harness.lock.ensureForSession('psb-1', { requireAuthoritative: true })).toEqual({
      ok: true,
    });
    // 第二条消息同样读一次（连续两条 = 两次读取），而不是命中 1.5s 缓存零请求。
    expect(await harness.lock.ensureForSession('psb-1', { requireAuthoritative: true })).toEqual({
      ok: true,
    });
    expect(harness.counts).toEqual({ list: 0, occupy: 0, session: 2 });

    // 对照：不带该选项的既有调用方仍走 TTL（1 次读取后零请求），差异是可观察的。
    expect(await harness.lock.ensureForSession('psb-1')).toEqual({ ok: true });
    expect(harness.counts.session).toBe(2);
  });

  it('缓存过「是我的」但权威读为他人占用 → 拒绝，并清掉乐观缓存（下一条不可拿旧态放行）', async () => {
    let workspace = occupiedByMe();
    const harness = createHarness({
      session: async (psbSessionId) => sessionStatus(psbSessionId, workspace),
    });

    // 普通路径（重绑 / 启动串流等）先把「是我的」记进 1.5s 乐观缓存。
    expect(await harness.lock.ensureForSession('psb-1')).toEqual({ ok: true });
    expect(await harness.lock.ensureForSession('psb-1')).toEqual({ ok: true });
    expect(harness.counts.session).toBe(1);

    // 工作区在 PSB 侧被交接给别人（用户重新点「新建任务」/ 网页解锁后被占用）。
    workspace = occupiedByOther('李四');
    expect(await harness.lock.ensureForSession('psb-1', { requireAuthoritative: true })).toEqual({
      ok: false,
      reason: 'occupied-by-other',
      personName: '李四',
    });
    // 权威读不是 mine → 缓存已清：非权威调用方也必须重新读，而不是零请求放行。
    expect(await harness.lock.ensureForSession('psb-1')).toEqual({
      ok: false,
      reason: 'occupied-by-other',
      personName: '李四',
    });
    expect(harness.counts.session).toBe(3);
  });

  it('权威读为无人占用（被交接回空闲）→ occupy-required 且不占用；用户显式确认后才占用并放行', async () => {
    let workspace = workspaceRow();
    const harness = createHarness({
      session: async (psbSessionId) => sessionStatus(psbSessionId, workspace),
      occupy: async () => {
        workspace = occupiedByMe();
        return workspace;
      },
    });

    // 发送闸门（隐式写路径）：空闲也不替用户占用。
    expect(await harness.lock.ensureForSession('psb-1', { requireAuthoritative: true })).toEqual({
      ok: false,
      reason: 'occupy-required',
    });
    expect(harness.counts).toEqual({ list: 0, occupy: 0, session: 1 });

    // 渲染层确认后走显式占用入口（这条路径允许 allowAutoOccupy）→ 之后发送闸门放行。
    expect(await harness.lock.ensureForSession('psb-1', { allowAutoOccupy: true })).toEqual({
      ok: true,
    });
    expect(harness.counts).toEqual({ list: 0, occupy: 1, session: 2 });

    expect(await harness.lock.ensureForSession('psb-1', { requireAuthoritative: true })).toEqual({
      ok: true,
    });
    // 仍然读一次权威事实，但已是我占用 → 不再 `occupy`。
    expect(harness.counts).toEqual({ list: 0, occupy: 1, session: 3 });
  });

  it('权威读失败（网络 / 鉴权）→ 抛出，不 fail-open、也不留成功缓存', async () => {
    const harness = createHarness({
      session: async () => {
        throw psbFailure('PSB_UNREACHABLE', '连不上 PSB');
      },
    });

    // 旧实现在这里 fail-open 继续发送；现在必须让这一轮拒绝（无法确认 ≠ 可以写）。
    await expect(
      harness.lock.ensureForSession('psb-1', { requireAuthoritative: true }),
    ).rejects.toMatchObject({ failure: { code: 'PSB_UNREACHABLE' } });
    await expect(
      harness.lock.ensureForSession('psb-1', { requireAuthoritative: true }),
    ).rejects.toMatchObject({ failure: { code: 'PSB_UNREACHABLE' } });
    // 失败不缓存：每次都要重新读（两条消息 = 两次读取）。
    expect(harness.counts).toEqual({ list: 0, occupy: 0, session: 2 });
  });
});

describe('占用闸门：失败 → PSB_* 文案码', () => {
  it('工作区空闲且不允许自动占用 → PSB_WORKSPACE_NOT_OCCUPIED（带「需要先占用」文案键）', () => {
    const failure = psbWorkspaceLockFailureError({ ok: false, reason: 'occupy-required' }).failure;

    expect(failure).toMatchObject({
      code: 'WORKSPACE_NOT_OCCUPIED',
      messageKey: 'remoteWorkspace.error.occupyRequired',
      message: null,
    });
    // 跨 IPC 的码是用户 / 渲染层可观察的那一个：它决定弹确认框而不是显示普通失败。
    expect(psbIpcCodeForFailure(failure)).toBe('PSB_WORKSPACE_NOT_OCCUPIED');
  });

  it('三种可行动失败各自映射到不同的 IPC 码（下一步不同，不能糊成一个）', () => {
    expect(
      psbIpcCodeForFailure(
        psbWorkspaceLockFailureError({
          ok: false,
          reason: 'occupied-by-other',
          personName: '张三',
        }).failure,
      ),
    ).toBe('PSB_WORKSPACE_OCCUPIED_BY_OTHER');
    expect(
      psbIpcCodeForFailure(psbWorkspaceLockFailureError({ ok: false, reason: 'offline' }).failure),
    ).toBe('PSB_CLIENT_OFFLINE');
    expect(
      psbIpcCodeForFailure(
        psbWorkspaceLockFailureError({
          ok: false,
          reason: 'workspace-unavailable',
          missing: false,
          state: 'provisioning',
        }).failure,
      ),
    ).toBe('PSB_WORKSPACE_NOT_READY');
    expect(
      psbIpcCodeForFailure(
        psbWorkspaceLockFailureError({
          ok: false,
          reason: 'workspace-unavailable',
          missing: true,
          state: null,
        }).failure,
      ),
    ).toBe('PSB_NOT_FOUND');
  });

  it('被他人占用的失败 message 只放占用人名（渲染层回填 {{name}}），成功结果不产生异常', () => {
    const failure = psbWorkspaceLockFailureError({
      ok: false,
      reason: 'occupied-by-other',
      personName: '张三',
    }).failure;

    expect(failure).toMatchObject({
      code: 'WORKSPACE_OCCUPIED_BY_OTHER',
      messageKey: 'remoteWorkspace.error.occupiedByOther',
      message: '张三',
    });
    expect(psbWorkspaceLockFailure({ ok: true })).toBeNull();
  });
});
