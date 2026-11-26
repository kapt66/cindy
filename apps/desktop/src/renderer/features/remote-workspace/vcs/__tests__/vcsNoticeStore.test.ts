// @vitest-environment jsdom

/**
 * 版本控制通知 store 单测（CINDY-RW-10）。
 *
 * 测试价值
 * - 生产入口与可观察结果：`ingestWorkspaceVcsNoticeEvent` / `ensureWorkspaceVcsNoticeBridge` /
 *   `hydrateWorkspaceVcsNotice` 是渲染层拿到 notice 的三条真实入口（推送 / 订阅安装 / 兜底读）。
 *   用户可观察结果：占用后是否出现提示、横幅显示的是否是**最近一条**、清理成功后提示是否消失。
 * - Bug／规则依据（独立审查 r4 P1）：
 *   ① 多条通知并存时「最近一条」必须按最近更新时间，不是 Map 的旧插入序；
 *   ② 兜底读与推送并发时，迟到的 `notice:null` 不能抹掉刚到的处置入口；
 *   ③ 推送订阅是共享的：首个组件卸载不能让其余组件断掉推送（引用计数）。
 * - 现有覆盖缺口：上述三条并发 / 生命周期语义此前没有任何运行期断言。
 * - 最小失败输入：先写 ws-1、再写 ws-2、再更新 ws-1（横幅应显示 ws-1）；hydrate 请求在途时
 *   推送新通知（响应里的 null 不得清掉它）；两个组件安装后卸载第一个（推送仍到）。
 * - tier：unit（jsdom + 内存 fake bridge）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PsbRemoteBridge } from '../../bridge';
import type { WorkspaceVcsNotice } from '../../../../../shared/psb-workspace-vcs';
import {
  clearWorkspaceVcsNoticeState,
  ensureWorkspaceVcsNoticeBridge,
  hydrateWorkspaceVcsNotice,
  ingestWorkspaceVcsNoticeEvent,
  readLatestWorkspaceVcsNoticeState,
  readWorkspaceVcsNoticeState,
  readWorkspaceVcsNoticeStates,
  rememberWorkspaceVcsNoticeWorkspaceLabel,
  resetWorkspaceVcsNoticeStoreForTest,
  subscribeWorkspaceVcsNotices,
} from '../vcsNoticeStore';

function makeNotice(overrides: Partial<WorkspaceVcsNotice> = {}): WorkspaceVcsNotice {
  return {
    code: 'WORKSPACE_VCS_DIRTY',
    advisory: true,
    messageZh: '检测到未提交修改（1 个检出）',
    dirty: true,
    projects: [{ projectId: 1, pathInWorkspace: '.', kind: 'p4', changes: 3 }],
    actions: [
      {
        kind: 'clean-workspace',
        method: 'POST',
        path: '/api/cindy/remote/workspaces/ws-1/vcs/revert',
        body: { projectIds: [1], confirm: 'revert' },
      },
      { kind: 'continue' },
    ],
    ...overrides,
  };
}

function fakeBridge(overrides: Partial<PsbRemoteBridge> = {}): PsbRemoteBridge {
  return {
    onWorkspaceVcsNotice: vi.fn(() => () => undefined),
    workspaceVcsNotice: vi.fn(async () => ({ workspaceId: 'ws-1', notice: makeNotice() })),
    ...overrides,
  } as unknown as PsbRemoteBridge;
}

function push(workspaceId: string, notice: WorkspaceVcsNotice | null): void {
  ingestWorkspaceVcsNoticeEvent({ workspaceId, operation: 'occupy', notice });
}

afterEach(() => {
  resetWorkspaceVcsNoticeStoreForTest();
});

describe('版本控制通知 store', () => {
  it('推送写入 / notice:null 删除，并通知订阅者', () => {
    const listener = vi.fn();
    subscribeWorkspaceVcsNotices(listener);

    push('ws-1', makeNotice());

    expect(readWorkspaceVcsNoticeState('ws-1')).toMatchObject({
      operation: 'occupy',
      notice: { advisory: true, dirty: true },
    });
    expect(readWorkspaceVcsNoticeStates()).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);

    push('ws-1', null);
    expect(readWorkspaceVcsNoticeState('ws-1')).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('非法 / 空载荷被忽略（不把半条数据渲染成按钮）', () => {
    ingestWorkspaceVcsNoticeEvent(null);
    ingestWorkspaceVcsNoticeEvent({ workspaceId: '', operation: 'occupy', notice: makeNotice() });
    expect(readWorkspaceVcsNoticeStates()).toHaveLength(0);
  });

  it('「最近一条」按最近更新时间，而不是首次插入顺序', () => {
    push('ws-1', makeNotice());
    push('ws-2', makeNotice({ messageZh: '第二个工作区' }));
    // 先写 ws-1 再写 ws-2：最新是 ws-2。
    expect(readLatestWorkspaceVcsNoticeState()?.workspaceId).toBe('ws-2');
    // 更新已有工作区 ws-1：它必须重新排到「最近一条」（旧实现 Map 原地更新不改插入序，
    // 多工作区并存时横幅会一直显示错的那条）。
    push('ws-1', makeNotice({ messageZh: '第一个工作区更新了' }));
    expect(readLatestWorkspaceVcsNoticeState()?.workspaceId).toBe('ws-1');
    expect(readLatestWorkspaceVcsNoticeState()?.revision).toBeGreaterThan(
      readWorkspaceVcsNoticeStates()[0]!.revision,
    );
  });

  it('工作区显示名进入快照，且只在有通知时触发订阅者', () => {
    const listener = vi.fn();
    subscribeWorkspaceVcsNotices(listener);
    // 没有通知：只记名字不应让订阅者重渲染（横幅不存在）。
    rememberWorkspaceVcsNoticeWorkspaceLabel('ws-1', '打包机 · saga2');
    expect(listener).not.toHaveBeenCalled();
    expect(readWorkspaceVcsNoticeState('ws-1')).toBeNull();

    push('ws-1', makeNotice());
    expect(readLatestWorkspaceVcsNoticeState()?.workspaceLabel).toBe('打包机 · saga2');
    rememberWorkspaceVcsNoticeWorkspaceLabel('ws-1', '打包机 · saga2-prod');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(readLatestWorkspaceVcsNoticeState()?.workspaceLabel).toBe('打包机 · saga2-prod');
  });

  it('多个组件重复安装订阅时只挂一条；最后一个卸载才真正退订', () => {
    const calls: Array<{ handler: (event: unknown) => void; unsubscribe: () => void }> = [];
    const bridge = fakeBridge({
      onWorkspaceVcsNotice: vi.fn((handler: (event: unknown) => void) => {
        const entry = { handler, unsubscribe: vi.fn() };
        calls.push(entry);
        return entry.unsubscribe;
      }) as unknown as PsbRemoteBridge['onWorkspaceVcsNotice'],
    });

    const releaseFirst = ensureWorkspaceVcsNoticeBridge(bridge);
    const releaseSecond = ensureWorkspaceVcsNoticeBridge(bridge);
    expect(bridge.onWorkspaceVcsNotice).toHaveBeenCalledTimes(1);

    // 第一个组件卸载：底层订阅必须保留给仍在挂载的组件（旧实现这里已经变成 no-op）。
    releaseFirst();
    expect(calls[0]!.unsubscribe).not.toHaveBeenCalled();
    calls[0]!.handler({ workspaceId: 'ws-1', operation: 'occupy', notice: makeNotice() });
    expect(readWorkspaceVcsNoticeState('ws-1')).not.toBeNull();

    // 最后一个卸载：真正退订；再安装会重新挂一条。
    releaseSecond();
    expect(calls[0]!.unsubscribe).toHaveBeenCalledTimes(1);
    ensureWorkspaceVcsNoticeBridge(bridge);
    expect(bridge.onWorkspaceVcsNotice).toHaveBeenCalledTimes(2);
  });

  it('hydrate 兜底读 main 缓存并把结果写进 store；本地无更新时才清', async () => {
    const bridge = fakeBridge();
    const notice = await hydrateWorkspaceVcsNotice('ws-1', bridge);

    expect(notice).toMatchObject({ advisory: true });
    expect(bridge.workspaceVcsNotice).toHaveBeenCalledWith({ workspaceId: 'ws-1' });
    expect(readWorkspaceVcsNoticeState('ws-1')?.notice).toMatchObject({ dirty: true });

    (bridge.workspaceVcsNotice as ReturnType<typeof vi.fn>).mockResolvedValue({
      workspaceId: 'ws-1',
      notice: null,
    });
    const cleared = await hydrateWorkspaceVcsNotice('ws-1', bridge);
    expect(cleared).toBeNull();
    expect(readWorkspaceVcsNoticeState('ws-1')).toBeNull();
  });

  it('hydrate 从发请求到响应之间到了推送：迟到的 notice:null 不抹掉刚到的处置入口', async () => {
    let resolveRead: (value: { workspaceId: string; notice: null }) => void = () => {};
    const bridge = fakeBridge({
      workspaceVcsNotice: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
      ) as unknown as PsbRemoteBridge['workspaceVcsNotice'],
    });

    const pending = hydrateWorkspaceVcsNotice('ws-1', bridge);
    // 请求在途时 main 推送了新的 advisory（占用成功）：用户已经能看到处置按钮。
    push('ws-1', makeNotice({ messageZh: '刚推送的' }));
    // 兜底读随后返回 null（它拿到的是推送之前的缓存快照）：不能把按钮抹掉。
    resolveRead({ workspaceId: 'ws-1', notice: null });
    await expect(pending).resolves.toMatchObject({ messageZh: '刚推送的' });
    expect(readWorkspaceVcsNoticeState('ws-1')?.notice.messageZh).toBe('刚推送的');
  });

  it('hydrate 的响应比推送旧：不覆盖更新后的通知', async () => {
    let resolveRead: (value: { workspaceId: string; notice: WorkspaceVcsNotice }) => void =
      () => {};
    const bridge = fakeBridge({
      workspaceVcsNotice: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
      ) as unknown as PsbRemoteBridge['workspaceVcsNotice'],
    });

    const pending = hydrateWorkspaceVcsNotice('ws-1', bridge);
    push('ws-1', makeNotice({ messageZh: '新的' }));
    resolveRead({ workspaceId: 'ws-1', notice: makeNotice({ messageZh: '旧的' }) });
    await pending;
    expect(readWorkspaceVcsNoticeState('ws-1')?.notice.messageZh).toBe('新的');
  });

  it('hydrate 的桥读取失败不抛错（推送仍会到），本地状态保持不变', async () => {
    push('ws-1', makeNotice());
    const bridge = fakeBridge({
      workspaceVcsNotice: vi.fn(async () => {
        throw new Error('IPC failed');
      }) as unknown as PsbRemoteBridge['workspaceVcsNotice'],
    });

    await expect(hydrateWorkspaceVcsNotice('ws-1', bridge)).resolves.toBeNull();
    expect(readWorkspaceVcsNoticeState('ws-1')?.operation).toBe('occupy');
  });

  it('clearWorkspaceVcsNoticeState 幂等，且不会被在途的 hydrate 写回', async () => {
    let resolveRead: (value: { workspaceId: string; notice: WorkspaceVcsNotice }) => void =
      () => {};
    const bridge = fakeBridge({
      workspaceVcsNotice: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
      ) as unknown as PsbRemoteBridge['workspaceVcsNotice'],
    });
    push('ws-1', makeNotice());
    const pending = hydrateWorkspaceVcsNotice('ws-1', bridge);
    clearWorkspaceVcsNoticeState('ws-1');
    resolveRead({ workspaceId: 'ws-1', notice: makeNotice() });
    await pending;
    // 本地已清除（用户点了继续）：迟到的兜底读不再把它写回来。
    expect(readWorkspaceVcsNoticeState('ws-1')).toBeNull();
  });
});
