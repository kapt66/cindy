// @vitest-environment jsdom

/**
 * `WorkspaceVcsNoticeView` 单测（CINDY-RW-10）。
 *
 * 测试价值
 * - 生产入口与可观察结果：这是版本控制提示的唯一展示/处置组件，会被挂进页头、横幅与弹层。
 *   用户可观察结果：advisory 是否以非错误形态出现、按钮文案来自哪（PSB descriptionZh / 本地
 *   key）、点「一键清理」是否先二次确认、确认后是否只传 kind + confirm（路径由 main 决定）、
 *   202 后是否出现「清理已开始」与刷新入口。
 * - Bug／规则依据：2026-11-26 20:4x 再更正：advisory 非阻塞；`clean-workspace` 不可逆需二次
 *   确认；`continue` 只关提示不发请求；旧 `force-release` 已删除，即使混进数据也不得渲染。
 * - 现有覆盖缺口：新组件无用例；「确认取消 → 不发请求」与「force-release 不渲染」是两条
 *   最容易回归的安全/产品边界。
 * - 最小失败输入：notice.actions 里塞 `force-release`（手动构造，绕过解析层）、
 *   clean 未确认就点、requestConfirm 返回 false。
 * - tier：unit（jsdom + 内存 fake bridge）。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceVcsNotice } from '../../../../../shared/psb-workspace-vcs';
import { WorkspaceVcsNoticeView } from '../WorkspaceVcsNoticeView';
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

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
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

const LEGACY_REJECTION: WorkspaceVcsNotice = {
  code: 'WORKSPACE_VCS_DIRTY',
  advisory: false,
  messageZh: '工作区有未提交修改：1 个检出',
  dirty: true,
  projects: [{ projectId: 1, pathInWorkspace: '.', kind: 'p4', changes: 3 }],
  actions: [{ kind: 'retry', method: 'POST', path: '/api/cindy/remote/workspaces/ws-1/vcs/check' }],
};

function installBridge(
  overrides: Record<string, unknown> = {},
): Record<string, ReturnType<typeof vi.fn>> {
  const bridge = {
    runWorkspaceVcsAction: vi.fn(async () => ({
      workspaceId: 'ws-1',
      kind: 'clean-workspace',
      accepted: true,
      operationId: 'op-7',
      data: null,
    })),
    refreshWorkspaces: vi.fn(async () => ({ workspaces: [] })),
    workspaceVcsNotice: vi.fn(async () => ({ workspaceId: 'ws-1', notice: null })),
    onWorkspaceVcsNotice: vi.fn(() => () => undefined),
    ...overrides,
  };
  (window as unknown as { electronAPI: { psbRemote: unknown } }).electronAPI = { psbRemote: bridge };
  return bridge as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

beforeEach(() => {
  resetWorkspaceVcsNoticeStoreForTest();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('advisory 展示（0.1.180）', () => {
  it('用 PSB messageZh 作为标题，渲染 clean / continue，不把 advisory 显示成错误', () => {
    installBridge();
    render(
      <WorkspaceVcsNoticeView workspaceId="ws-1" notice={ADVISORY} operation="occupy" />,
    );

    const root = screen.getByTestId('workspace-vcs-notice');
    expect(root.dataset['advisory']).toBe('true');
    expect(root.textContent).toContain('检测到未提交修改（1 个检出）');
    expect(root.textContent).toContain('一键清理');
    expect(root.textContent).toContain('忽略提示，继续使用工作区');
    // projects 摘要来自插件项目数（i18n 插值）。
    expect(root.textContent).toContain('remoteWorkspace.vcs.projectsSummary#1,3');
  });

  it('旧 force-release 即使混进 actions 也不渲染按钮（无 force 分支）', () => {
    installBridge();
    const notice = {
      ...ADVISORY,
      actions: [
        {
          kind: 'force-release',
          method: 'DELETE',
          path: '/api/cindy/remote/workspaces/ws-1/occupy?force=1',
          descriptionZh: '忽略修改，仍然解除占用',
        } as never,
      ],
    };
    render(<WorkspaceVcsNoticeView workspaceId="ws-1" notice={notice} />);

    expect(screen.queryByText('忽略修改，仍然解除占用')).toBeNull();
  });

  it('「继续」只关提示：调 main 的 continue（清缓存、不发 HTTP），不自己拼动作', async () => {
    const bridge = installBridge({
      runWorkspaceVcsAction: vi.fn(async () => ({
        workspaceId: 'ws-1',
        kind: 'continue',
        accepted: false,
        operationId: null,
        data: null,
      })),
    });
    const onResolved = vi.fn();
    render(
      <WorkspaceVcsNoticeView
        workspaceId="ws-1"
        notice={ADVISORY}
        onResolved={onResolved}
      />,
    );

    fireEvent.click(screen.getByText('忽略提示，继续使用工作区'));

    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith({ kind: 'continue', accepted: false, operationId: null }),
    );
    // 让 main 清掉有界缓存：否则换窗口 / hydrate 会把已忽略的提示复现（main 该分支不发 HTTP）。
    expect(bridge.runWorkspaceVcsAction).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      kind: 'continue',
    });
  });
});

describe('一键清理：不可逆动作必须二次确认', () => {
  it('先进入确认区（列检出与不可撤销说明），取消后不发请求', async () => {
    const bridge = installBridge();
    render(<WorkspaceVcsNoticeView workspaceId="ws-1" notice={ADVISORY} />);

    fireEvent.click(screen.getByText('一键清理'));

    const confirm = screen.getByTestId('workspace-vcs-confirm');
    expect(confirm.textContent).toContain('remoteWorkspace.vcs.confirm.title');
    expect(confirm.textContent).toContain('remoteWorkspace.vcs.irreversibleNote');
    expect(confirm.textContent).toContain('remoteWorkspace.vcs.confirm.description#1,.');

    fireEvent.click(screen.getByText('remoteWorkspace.vcs.confirm.cancel'));
    expect(screen.queryByTestId('workspace-vcs-confirm')).toBeNull();
    expect(bridge.runWorkspaceVcsAction).not.toHaveBeenCalled();
  });

  it('确认后只传 kind + confirm:true；202 operationId → 显示「清理已开始」+ 刷新', async () => {
    const bridge = installBridge();
    const onResolved = vi.fn();
    render(
      <WorkspaceVcsNoticeView workspaceId="ws-1" notice={ADVISORY} onResolved={onResolved} />,
    );

    fireEvent.click(screen.getByText('一键清理'));
    fireEvent.click(screen.getByText('remoteWorkspace.vcs.confirm.action'));

    await waitFor(() =>
      expect(bridge.runWorkspaceVcsAction).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        kind: 'clean-workspace',
        confirm: true,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('workspace-vcs-cleaning')).toBeTruthy());
    expect(onResolved).toHaveBeenCalledWith({
      kind: 'clean-workspace',
      accepted: true,
      operationId: 'op-7',
    });

    fireEvent.click(screen.getByText('remoteWorkspace.vcs.refresh'));
    await waitFor(() =>
      expect(bridge.refreshWorkspaces).toHaveBeenCalledWith({ workspaceIds: ['ws-1'] }),
    );
  });

  it('宿主提供 requestConfirm 时只走宿主确认一次（不叠加内联确认区）；取消则不执行', async () => {
    const bridge = installBridge();
    const requestConfirm = vi.fn(
      async (_input: { title: string; description: string; confirmText: string }) => false,
    );
    render(
      <WorkspaceVcsNoticeView
        workspaceId="ws-1"
        notice={ADVISORY}
        requestConfirm={requestConfirm}
      />,
    );

    // 点「一键清理」应直接弹宿主确认：内联确认区不再出现（否则用户要点两次）。
    fireEvent.click(screen.getByText('一键清理'));
    expect(screen.queryByTestId('workspace-vcs-confirm')).toBeNull();

    await waitFor(() => expect(requestConfirm).toHaveBeenCalledTimes(1));
    expect(requestConfirm.mock.calls[0]?.[0]).toMatchObject({
      title: 'remoteWorkspace.vcs.confirm.title',
      confirmText: 'remoteWorkspace.vcs.confirm.action',
    });
    expect(bridge.runWorkspaceVcsAction).not.toHaveBeenCalled();
  });

  it('宿主确认返回 true → 直接执行（confirm:true），无需第二次点击', async () => {
    const bridge = installBridge();
    const requestConfirm = vi.fn(
      async (_input: { title: string; description: string; confirmText: string }) => true,
    );
    render(
      <WorkspaceVcsNoticeView
        workspaceId="ws-1"
        notice={ADVISORY}
        requestConfirm={requestConfirm}
      />,
    );

    fireEvent.click(screen.getByText('一键清理'));

    await waitFor(() =>
      expect(bridge.runWorkspaceVcsAction).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        kind: 'clean-workspace',
        confirm: true,
      }),
    );
    expect(screen.queryByTestId('workspace-vcs-confirm')).toBeNull();
  });

  it('确认后请求失败 → 用可行动文案 toast，不静默', async () => {
    const bridge = installBridge({
      runWorkspaceVcsAction: vi.fn(async () => {
        const error = new Error('[PSB_WORKSPACE_VCS_UNAVAILABLE] 无法确认');
        throw error;
      }),
    });
    render(<WorkspaceVcsNoticeView workspaceId="ws-1" notice={ADVISORY} />);

    fireEvent.click(screen.getByText('一键清理'));
    fireEvent.click(screen.getByText('remoteWorkspace.vcs.confirm.action'));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(toastMock.error.mock.calls[0][0]).toContain('remoteWorkspace.vcs.unavailable');
    expect(bridge.runWorkspaceVcsAction).toHaveBeenCalledTimes(1);
  });
});

describe('旧版 409 兼容形态', () => {
  it('错误形态（advisory:false）渲染重试按钮，点后只传 kind 执行', async () => {
    const bridge = installBridge({
      runWorkspaceVcsAction: vi.fn(async () => ({
        workspaceId: 'ws-1',
        kind: 'retry',
        accepted: false,
        operationId: null,
        data: null,
      })),
    });
    const onResolved = vi.fn();
    render(
      <WorkspaceVcsNoticeView
        workspaceId="ws-1"
        notice={LEGACY_REJECTION}
        onResolved={onResolved}
      />,
    );

    expect(screen.getByTestId('workspace-vcs-notice').dataset['advisory']).toBe('false');
    expect(screen.getByTestId('workspace-vcs-notice').textContent).toContain(
      'remoteWorkspace.vcs.rejectedHint',
    );

    fireEvent.click(screen.getByText('remoteWorkspace.vcs.action.retry'));

    await waitFor(() =>
      expect(bridge.runWorkspaceVcsAction).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        kind: 'retry',
      }),
    );
    expect(onResolved).toHaveBeenCalledWith({ kind: 'retry', accepted: false, operationId: null });
  });

  it('旧 revert-then-release 同样走二次确认（不可逆），确认后带 confirm:true', async () => {
    const bridge = installBridge({
      runWorkspaceVcsAction: vi.fn(async () => ({
        workspaceId: 'ws-1',
        kind: 'revert-then-release',
        accepted: false,
        operationId: null,
        data: null,
      })),
    });
    render(
      <WorkspaceVcsNoticeView
        workspaceId="ws-1"
        notice={{
          ...LEGACY_REJECTION,
          actions: [
            {
              kind: 'revert-then-release',
              method: 'DELETE',
              path: '/api/cindy/remote/workspaces/ws-1/occupy',
              body: { revert: true },
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByText('remoteWorkspace.vcs.action.revert-then-release'));
    fireEvent.click(screen.getByText('remoteWorkspace.vcs.confirm.action'));

    await waitFor(() =>
      expect(bridge.runWorkspaceVcsAction).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        kind: 'revert-then-release',
        confirm: true,
      }),
    );
  });
});

describe('详情', () => {
  it('点「查看详情」按 inspect-vcs action 拉取并展示服务端字段', async () => {
    const bridge = installBridge({
      runWorkspaceVcsAction: vi.fn(async () => ({
        workspaceId: 'ws-1',
        kind: 'inspect-vcs',
        accepted: false,
        operationId: null,
        data: { branch: 'main', changes: 3 },
      })),
    });
    render(<WorkspaceVcsNoticeView workspaceId="ws-1" notice={ADVISORY} />);

    fireEvent.click(screen.getByText('查看未提交修改详情'));

    await waitFor(() =>
      expect(bridge.runWorkspaceVcsAction).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        kind: 'inspect-vcs',
      }),
    );
    await waitFor(() => expect(screen.getByTestId('workspace-vcs-details')).toBeTruthy());
    expect(screen.getByTestId('workspace-vcs-details').textContent).toContain('branch: main');
    expect(screen.getByTestId('workspace-vcs-details').textContent).toContain('changes: 3');
  });
});
