// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：`WorkspaceVcsNoticeHost` 是版本控制检查通知的**全局接线点**（挂在
 *   App 的 `ConfirmDialogProvider` 内、只挂主窗）。它负责把 main 的 `onWorkspaceVcsNotice`
 *   广播变成一条非阻塞横幅；横幅必须写清「哪个工作区」（多个工作区同时有提示时不能只说一句
 *   「工作区有未提交修改」），并且只显示**最近被更新**的那一条。
 * - Bug／规则依据（独立审查 r4 P1）：
 *   ① 「最近一条」按最近更新时间（更新已有工作区也要排到最前），不是 Map 插入序；
 *   ② 横幅带工作区名；
 *   ③ 不可逆清理的二次确认走宿主确认框，并列出入确认范围的检出与修改数；
 *   ④ 关闭语义：advisory 直接关；非 advisory 先清 main 缓存再关（否则换窗口 / hydrate 复现）。
 * - 现有覆盖缺口：宿主此前没有「多工作区取最近一条」「工作区名」「非 advisory 关闭」的用例。
 * - 最小失败输入：先推 ws-1 再推 ws-2 后更新 ws-1（横幅应回到 ws-1）；非 advisory 关闭不调
 *   main（下次 hydrate 复现已关闭的提示）。
 * - tier：unit（jsdom + 内存 fake bridge，无真实 PSB / Electron）。
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import type { WorkspaceVcsNotice } from '../../../../../shared/psb-workspace-vcs';
import { WorkspaceVcsNoticeHost } from '../WorkspaceVcsNoticeHost';
import {
  rememberWorkspaceVcsNoticeWorkspaceLabel,
  resetWorkspaceVcsNoticeStoreForTest,
} from '../vcsNoticeStore';

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

const NON_ADVISORY: WorkspaceVcsNotice = {
  ...ADVISORY,
  advisory: false,
  messageZh: '工作区有未提交修改',
  actions: [
    {
      kind: 'clean-workspace',
      method: 'POST',
      path: '/api/cindy/remote/workspaces/ws-1/vcs/revert',
      body: { projectIds: [1], confirm: 'revert' },
    },
  ],
};

/** main → renderer 的推送处理器（Host 的 effect 里通过 `onWorkspaceVcsNotice` 注册）。 */
const noticeHandlers = new Set<(event: unknown) => void>();

function pushNotice(
  notice: WorkspaceVcsNotice | null,
  workspaceId = 'ws-1',
): void {
  for (const handler of [...noticeHandlers]) {
    handler({ workspaceId, operation: 'occupy', notice });
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
    // 悬浮容器不遮断输入：advisory 是建议，不是模态。
    expect(host.getAttribute('data-placement')).toBe('bottom-right');

    // 不可逆动作：宿主已有确认框能力，点一下**直接**弹宿主确认（不再叠加 View 的内联两步确认，
    // 否则用户要点两次）；此时没有发出任何后端动作。
    fireEvent.click(screen.getByText('一键清理'));
    expect(screen.queryByTestId('workspace-vcs-confirm')).toBeNull();
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('remoteWorkspace.vcs.confirm.title')).toBeTruthy();
    // 确认框必须列出确认范围（检出路径 + 未提交修改数），而不是只说「1 个检出」。
    expect(dialog.textContent).toContain(
      'remoteWorkspace.vcs.projectLine#.,p4,3',
    );
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

  it('多工作区并存时只显示最近更新的一条，并带工作区名', async () => {
    installBridge();
    renderHost();
    await act(async () => {
      rememberWorkspaceVcsNoticeWorkspaceLabel('ws-1', '打包机 · saga2');
      rememberWorkspaceVcsNoticeWorkspaceLabel('ws-2', '渲染机 · saga2');
      pushNotice(ADVISORY, 'ws-1');
      pushNotice({ ...ADVISORY, messageZh: '第二个工作区的提示' }, 'ws-2');
    });
    // 先写 ws-1 再写 ws-2：最近一条是 ws-2。
    expect(screen.getByTestId('workspace-vcs-notice').textContent).toContain(
      '第二个工作区的提示',
    );
    expect(screen.getByTestId('workspace-vcs-workspace-label').textContent).toBe(
      '渲染机 · saga2',
    );

    // 更新已有工作区 ws-1：它必须重新成为「最近一条」（旧实现按插入序会仍然显示 ws-2）。
    await act(async () => {
      pushNotice({ ...ADVISORY, messageZh: '第一个工作区更新了' }, 'ws-1');
    });
    expect(screen.getByTestId('workspace-vcs-notice').textContent).toContain(
      '第一个工作区更新了',
    );
    expect(screen.getByTestId('workspace-vcs-workspace-label').textContent).toBe(
      '打包机 · saga2',
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

  it('advisory 关闭只清本地；非 advisory 关闭先清 main 缓存再关', async () => {
    const bridge = installBridge();
    renderHost();
    await act(async () => {
      pushNotice(ADVISORY);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'remoteWorkspace.vcs.dismiss' }));
    });
    // advisory 是「操作已成功后的建议」：关掉就够，不必打 main。
    expect(bridge.runWorkspaceVcsAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId('workspace-vcs-notice-host')).toBeNull();

    // 非 advisory（旧版 409）关闭：先让 main 清缓存，否则换窗口 / hydrate 会把已关闭的提示复现。
    await act(async () => {
      pushNotice(NON_ADVISORY);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'remoteWorkspace.vcs.dismiss' }));
    });
    expect(bridge.runWorkspaceVcsAction).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      kind: 'continue',
    });
    expect(screen.queryByTestId('workspace-vcs-notice-host')).toBeNull();
  });
});
