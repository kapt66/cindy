// @vitest-environment jsdom

/**
 * 版本控制通知 store 单测（CINDY-RW-10）。
 *
 * 测试价值
 * - 生产入口与可观察结果：`ingestWorkspaceVcsNoticeEvent` / `ensureWorkspaceVcsNoticeBridge` /
 *   `hydrateWorkspaceVcsNotice` 是渲染层拿到 notice 的三条真实入口（推送 / 订阅安装 / 兜底读）。
 *   用户可观察结果：占用后是否出现提示、清理成功后提示是否消失。
 * - Bug／规则依据：IPC 错误只能带 code+message，`details.vcs` 的 actions 必须靠推送或兜底读；
 *   推送与 invoke 失败到达顺序不可依赖，所以两条路径都要接得住。
 * - 现有覆盖缺口：模块级 store 此前不存在；「重复安装只挂一条订阅」「hydrate 幂等清除」没有
 *   任何运行期断言。
 * - 最小失败输入：两个组件同时挂载（订阅应只有一条）；main 广播 `notice:null`（store 应删除）。
 * - tier：unit（jsdom + 内存 fake bridge）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PsbRemoteBridge } from '../../bridge';
import {
  clearWorkspaceVcsNoticeState,
  ensureWorkspaceVcsNoticeBridge,
  hydrateWorkspaceVcsNotice,
  ingestWorkspaceVcsNoticeEvent,
  readWorkspaceVcsNoticeState,
  readWorkspaceVcsNoticeStates,
  resetWorkspaceVcsNoticeStoreForTest,
  subscribeWorkspaceVcsNotices,
} from '../vcsNoticeStore';

function makeNotice(overrides: Record<string, unknown> = {}) {
  return {
    code: 'WORKSPACE_VCS_DIRTY' as const,
    advisory: true,
    messageZh: '检测到未提交修改（1 个检出）',
    dirty: true,
    projects: [{ projectId: 1, pathInWorkspace: '.', kind: 'p4', changes: 3 }],
    actions: [
      {
        kind: 'clean-workspace' as const,
        method: 'POST' as const,
        path: '/api/cindy/remote/workspaces/ws-1/vcs/revert',
        body: { projectIds: [1], confirm: 'revert' },
      },
      { kind: 'continue' as const },
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

afterEach(() => {
  resetWorkspaceVcsNoticeStoreForTest();
});

describe('版本控制通知 store', () => {
  it('推送写入 / notice:null 删除，并通知订阅者', () => {
    const listener = vi.fn();
    subscribeWorkspaceVcsNotices(listener);

    ingestWorkspaceVcsNoticeEvent({
      workspaceId: 'ws-1',
      operation: 'occupy',
      notice: makeNotice(),
    });

    expect(readWorkspaceVcsNoticeState('ws-1')).toMatchObject({
      operation: 'occupy',
      notice: { advisory: true, dirty: true },
    });
    expect(readWorkspaceVcsNoticeStates()).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);

    ingestWorkspaceVcsNoticeEvent({ workspaceId: 'ws-1', operation: 'occupy', notice: null });
    expect(readWorkspaceVcsNoticeState('ws-1')).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('非法 / 空载荷被忽略（不把半条数据渲染成按钮）', () => {
    ingestWorkspaceVcsNoticeEvent(null);
    ingestWorkspaceVcsNoticeEvent({ workspaceId: '', operation: 'occupy', notice: makeNotice() });
    expect(readWorkspaceVcsNoticeStates()).toHaveLength(0);
  });

  it('多个组件重复安装订阅时只挂一条；dispose 后可重新安装', () => {
    const bridge = fakeBridge();
    const unsubscribeHandlers: Array<() => void> = [];
    (bridge.onWorkspaceVcsNotice as ReturnType<typeof vi.fn>).mockImplementation(
      (handler: (event: never) => void) => {
        const dispose = () => undefined;
        unsubscribeHandlers.push(dispose);
        return dispose;
      },
    );

    ensureWorkspaceVcsNoticeBridge(bridge);
    ensureWorkspaceVcsNoticeBridge(bridge);
    expect(bridge.onWorkspaceVcsNotice).toHaveBeenCalledTimes(1);

    resetWorkspaceVcsNoticeStoreForTest();
    ensureWorkspaceVcsNoticeBridge(bridge);
    expect(bridge.onWorkspaceVcsNotice).toHaveBeenCalledTimes(2);
  });

  it('hydrate 兜底读 main 缓存并把结果写进 store；main 没有通知时清掉本地', async () => {
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

  it('hydrate 的桥读取失败不抛错（推送仍会到），本地状态保持不变', async () => {
    ingestWorkspaceVcsNoticeEvent({
      workspaceId: 'ws-1',
      operation: 'release',
      notice: makeNotice(),
    });
    const bridge = fakeBridge({
      workspaceVcsNotice: vi.fn(async () => {
        throw new Error('IPC failed');
      }),
    });

    await expect(hydrateWorkspaceVcsNotice('ws-1', bridge)).resolves.toBeNull();
    expect(readWorkspaceVcsNoticeState('ws-1')?.operation).toBe('release');
  });

  it('clearWorkspaceVcsNoticeState 幂等', () => {
    ingestWorkspaceVcsNoticeEvent({
      workspaceId: 'ws-1',
      operation: 'ensure',
      notice: makeNotice(),
    });
    clearWorkspaceVcsNoticeState('ws-1');
    clearWorkspaceVcsNoticeState('ws-1');
    expect(readWorkspaceVcsNoticeState('ws-1')).toBeNull();
  });
});
