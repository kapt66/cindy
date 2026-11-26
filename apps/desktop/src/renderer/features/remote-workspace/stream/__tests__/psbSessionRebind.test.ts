// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：`usePsbRemoteSessionStatus`（会话页输入判据、「远程工作区」页信息条的
 *   数据源）与 `usePsbSessionRebind`（`psbRemote.sessionsRebound` 推送的渲染层状态源，
 *   `stream/psbSessionRebind.ts`）。可观察结果：PSB 会话终态时 `inputAllowed === true`
 *   （输入框不锁死、不出现「任务已结束」橙条），重绑事件后有效 `remoteHostId` 换成新会话并
 *   出现一条可关闭的轻提示。
 * - Bug / 规则依据：用户可见回归「远程工作区任务终态后输入被永久锁死，并显示『这个任务已经
 *   结束』」；产品正本 `docs/product-rules/psb-remote-workspace-sessions.md` §2.4 与共享契约
 *   `psbSessionInputAllowed` / `psbSessionNeedsRebind` 的注释（终态 = 发送时重建，不是判死）。
 * - 现有覆盖缺口：`remoteWorkspaceStreamGates.test.ts` 只测共享纯函数，没有覆盖 hook 这一层
 *   「终态快照 → 消费者看到的 inputAllowed / needsRebind」；重绑推送（新事件）没有任何用例。
 * - 最小失败输入：把终态重新当阻断原因（inputAllowed 变 false）、重绑事件不更新 remoteHostId
 *   （界面与串流面板继续指向已经结束的旧会话）、关掉提示后又弹回来。
 * - tier：unit（jsdom + RTL renderHook；无真实 PSB / Electron）。
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type {
  PsbRemoteSession,
  PsbRemoteWorkspace,
  PsbSessionsReboundEvent,
} from '../../../../../shared/psb-remote-workspace';
import { usePsbRemoteSessionStatus } from '../usePsbRemoteSessionStatus';
import { usePsbSessionRebind } from '../psbSessionRebind';

function session(patch: Partial<PsbRemoteSession> = {}): PsbRemoteSession {
  return {
    id: 'psb-a',
    workspaceId: 'ws-a',
    clientId: 'client-a',
    title: null,
    agentKind: 'claude-code',
    status: 'running',
    statusMessage: null,
    createdAt: '',
    updatedAt: '',
    createdBy: { personId: null, personName: '', source: 'cindy' },
    webUrl: null,
    ...patch,
  };
}

function workspace(patch: Partial<PsbRemoteWorkspace> = {}): PsbRemoteWorkspace {
  return {
    id: 'ws-a',
    title: 'Workspace A',
    clientId: 'client-a',
    clientName: 'Machine A',
    clientOnline: true,
    clientPlatform: 'linux',
    state: 'ready',
    templateKey: null,
    templateTitle: null,
    directoryName: 'proj-a',
    clientPath: null,
    occupancy: { occupied: false, byMe: false, personId: null, personName: '', occupiedAt: null },
    usable: true,
    unusableReason: null,
    sessionCount: 1,
    webUrl: null,
    sessionsWebUrl: null,
    ...patch,
  };
}

function installBridge(overrides: Record<string, unknown> = {}): void {
  Object.assign(window, {
    electronAPI: {
      psbRemote: {
        sessionStatus: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
          session: session({ id: sessionId }),
          workspace: workspace(),
        })),
        onSessionsRebound: vi.fn(() => () => {}),
        ...overrides,
      },
    },
  });
}

/** 取 preload 桥上的重绑推送订阅回调（模拟 main → renderer 的推送）。 */
function captureReboundHandler(): (event: PsbSessionsReboundEvent) => void {
  let handler: ((event: PsbSessionsReboundEvent) => void) | null = null;
  installBridge({
    onSessionsRebound: vi.fn((next: (event: PsbSessionsReboundEvent) => void) => {
      handler = next;
      return () => {
        handler = null;
      };
    }),
  });
  return (event) => {
    if (!handler) throw new Error('rebound handler was not subscribed');
    handler(event);
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

it('keeps composer usable for a terminal PSB session and says the next send rebuilds it', async () => {
  // 终态不再锁输入：这是用户看到的「任务已结束、输入框永远灰着」那条回归的判据层。
  installBridge({
    sessionStatus: vi.fn(async () => ({
      session: session({ status: 'stopped' }),
      workspace: workspace(),
    })),
  });
  const { result } = renderHook(() => usePsbRemoteSessionStatus('psb-a'));
  await act(async () => {});

  expect(result.current.snapshot?.session.status).toBe('stopped');
  expect(result.current.inputAllowed).toBe(true);
  expect(result.current.inputBlockedReasonKey).toBeNull();
  // 界面据此说明「已结束；发送下一条消息会自动新建远程会话」，而不是把它当任务判死。
  expect(result.current.needsRebind).toBe(true);
});

it('still blocks input when the workspace is occupied by someone else', async () => {
  installBridge({
    sessionStatus: vi.fn(async () => ({
      session: session(),
      workspace: workspace({
        occupancy: { occupied: true, byMe: false, personId: '42', personName: 'Someone', occupiedAt: 1 },
      }),
    })),
  });
  const { result } = renderHook(() => usePsbRemoteSessionStatus('psb-a'));
  await act(async () => {});

  expect(result.current.inputAllowed).toBe(false);
  expect(result.current.inputBlockedReasonKey).toBe('remoteWorkspace.input.occupiedByOther');
});

it('switches the effective remote identity to the new session and shows a dismissible light notice', () => {
  const pushRebound = captureReboundHandler();
  const { result } = renderHook(() => usePsbSessionRebind('local-rebind-1', 'psb:psb-old'));
  expect(result.current.remoteHostId).toBe('psb:psb-old');
  expect(result.current.noticeVisible).toBe(false);

  act(() => {
    pushRebound({
      localSessionId: 'local-rebind-1',
      previousRemoteHostId: 'psb:psb-old',
      remoteHostId: 'psb:psb-new',
    });
  });
  // 输入判据、「远程工作区」页与串流面板都吃这一个值：必须立刻指向新会话。
  expect(result.current.remoteHostId).toBe('psb:psb-new');
  expect(result.current.noticeVisible).toBe(true);

  act(() => {
    result.current.dismissNotice();
  });
  expect(result.current.noticeVisible).toBe(false);
  // 关掉的只是提示：远端身份仍然是新会话。
  expect(result.current.remoteHostId).toBe('psb:psb-new');
});

it('ignores a rebound push for another local task', () => {
  const pushRebound = captureReboundHandler();
  const { result } = renderHook(() => usePsbSessionRebind('local-rebind-2', 'psb:psb-old'));
  act(() => {
    pushRebound({
      localSessionId: 'local-other',
      previousRemoteHostId: 'psb:psb-other-old',
      remoteHostId: 'psb:psb-other-new',
    });
  });
  expect(result.current.remoteHostId).toBe('psb:psb-old');
  expect(result.current.noticeVisible).toBe(false);
});
