// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：`WorkspaceVcsNoticeHost` 是版本控制检查通知的**全局接线点**（挂在
 *   App 的 `ConfirmDialogProvider` 内、只挂主窗）。它负责两件事：把 main 的
 *   `onWorkspaceVcsNotice` 广播变成一条非阻塞横幅；把不可逆清理的二次确认接到宿主自己的确认框
 *   （`useConfirmDialog`）。用户可观察结果：推送后马上出现横幅、点「一键清理」先弹宿主确认框、
 *   取消不发请求、确认后只按 kind + `confirm:true` 调 `runWorkspaceVcsAction`。
 * - Bug／规则依据：产品规则 `psb-remote-workspace-sessions.md` §2.7（advisory 非阻塞；清理不可逆
 *   必须二次确认；「继续」不发请求）；工程契约 §13.5.2（挂载点与测试）。
 * - 现有覆盖缺口：store（推送 / 兜底读）与 View（两代形态、确认取消）各有单测，但「宿主订阅
 *   推送 + 用宿主确认框」这条接线没有覆盖 —— 漏订阅就是推送不回显，确认框没接就是点一下就清理。
 * - 最小失败输入：宿主不订阅 `onWorkspaceVcsNotice`；`requestConfirm` 没接确认框而直接执行；
 *   取消后仍调用 `runWorkspaceVcsAction`。
 * - tier：unit（jsdom + 内存 fake bridge，无真实 PSB / Electron）。
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import type { WorkspaceVcsNotice } from '../../../../../shared/psb-workspace-vcs';
import { WorkspaceVcsNoticeHost } from '../WorkspaceVcsNoticeHost';
import { resetWorkspaceVcsNoticeStoreForTest } from '../vcsNoticeStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 伪造 key（带插值值）：断言落在「用哪个 key」上，不复制任何语言的文案。
    t: (key: string, options?: Record<string, string>) => {
      const values = options ? Object.values(options).join(',') : '';
      return values ? `${key}#${values}` : key;
    },
  }),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

const ADVISORY: WorkspaceVcsNotice = {
  code: 'WORKSPACE_VCS_DIRTY',
  advisory: true,
  messageZh: '检测到未提交修改（1 个检出）',
  dirty: true,
  projects: [{ projectId: 1, pathInWorkspace: '.', kind: 'p4', changes: 3 }],
  actions: [
    {
      kind: 'inspect-vcs',
      method: 'GET',
      path: '/api/cindy/remote/workspaces/ws-1/vcs',
      descriptionZh: '查看未提交修改详情',
    },
    {
      kind: 'clean-workspace',
      method: 'POST',
      path: '/api/cindy/remote/workspaces/ws-1/vcs/revert',
      body: { projectIds: [1], confirm: 'revert' },
      descriptionZh: '一键清理',
    },
    { kind: 'continue', descriptionZh: '忽略提示，继续使用工作区' },
  ],
};

/** main → renderer 的推送处理器（Host 的 effect 里通过 `onWorkspaceVcsNotice` 注册）。 */
const noticeHandlers = new Set<(event: unknown) => void>();

function pushNotice(notice: WorkspaceVcsNotice | null): void {
  for (const handler of [...noticeHandlers]) {
    handler({ workspaceId: 'ws-1', operation: 'occupy', notice });
  }
}

function installBridge() {
  const bridge = {
    workspaceVcsNotice: vi.fn(async () => ({ workspaceId: 'ws-1', notice: null })),
    onWorkspaceVcsNotice: vi.fn((handler: (event: unknown) => void) => {
      noticeHandlers.add(handler);
      return () => {
        noticeHandlers.delete(handler);
      };
    }),
    runWorkspaceVcsAction: vi.fn(async () => ({
      workspaceId: 'ws-1',
      kind: 'clean-workspace',
      accepted: true,
      operationId: 'op-1',
      data: null,
    })),
    refreshWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  };
  (window as unknown as { electronAPI?: { psbRemote?: unknown } }).electronAPI = {
    psbRemote: bridge,
  };
  return bridge;
}

function renderHost() {
  return render(
    <ConfirmDialogProvider>
      <WorkspaceVcsNoticeHost />
    </ConfirmDialogProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  noticeHandlers.clear();
  localStorage.clear();
  resetWorkspaceVcsNoticeStoreForTest();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('WorkspaceVcsNoticeHost', () => {
  it('订阅 main 的推送并显示非阻塞横幅，点「一键清理」先走宿主确认框', async () => {
    const bridge = installBridge();
    renderHost();
    // 没有通知：宿主不占位。
    expect(screen.queryByTestId('workspace-vcs-notice-host')).toBeNull();

    await act(async () => {
      pushNotice(ADVISORY);
    });
    const host = screen.getByTestId('workspace-vcs-notice-host');
    const banner = screen.getByTestId('workspace-vcs-notice');
    expect(host.contains(banner)).toBe(true);
    expect(banner.dataset['variant']).toBe('banner');
    expect(banner.dataset['advisory']).toBe('true');
    expect(banner.textContent).toContain('检测到未提交修改（1 个检出）');
    // 悬浮容器不遮断输入：外层 pointer-events-none、内层可点。
    expect(host.className).toContain('pointer-events-none');

    // 不可逆动作：宿主已有确认框能力，点一下**直接**弹宿主确认（不再叠加 View 的内联两步确认，
    // 否则用户要点两次）；此时没有发出任何后端动作。
    fireEvent.click(screen.getByText('一键清理'));
    expect(screen.queryByTestId('workspace-vcs-confirm')).toBeNull();
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('remoteWorkspace.vcs.confirm.title')).toBeTruthy();
    expect(bridge.runWorkspaceVcsAction).not.toHaveBeenCalled();

    // 取消：不执行。
    fireEvent.click(within(dialog).getByRole('button', { name: 'commonUi.confirmDialog.cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(bridge.runWorkspaceVcsAction).not.toHaveBeenCalled();
    // 横幅仍在（提示没被误清掉）。
    expect(screen.getByTestId('workspace-vcs-notice-host')).toBeTruthy();
  });

  it('在宿主确认框确认后只按 kind + confirm:true 执行清理', async () => {
    const bridge = installBridge();
    renderHost();
    await act(async () => {
      pushNotice(ADVISORY);
    });

    fireEvent.click(screen.getByText('一键清理'));
    const dialog = await screen.findByRole('alertdialog');
    expect(bridge.runWorkspaceVcsAction).not.toHaveBeenCalled();

    // Host 传给确认框的 confirmText 就是 View 的确认动作文案（同一把尺子）；点击宿主框的确认。
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'remoteWorkspace.vcs.confirm.action' }),
    );
    await waitFor(() =>
      expect(bridge.runWorkspaceVcsAction).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        kind: 'clean-workspace',
        confirm: true,
      }),
    );
  });

  it('收到 notice:null（成功占用 / 释放 / 清理后）撤下横幅', async () => {
    installBridge();
    renderHost();
    await act(async () => {
      pushNotice(ADVISORY);
    });
    expect(screen.getByTestId('workspace-vcs-notice-host')).toBeTruthy();

    await act(async () => {
      pushNotice(null);
    });
    expect(screen.queryByTestId('workspace-vcs-notice-host')).toBeNull();
  });
});
