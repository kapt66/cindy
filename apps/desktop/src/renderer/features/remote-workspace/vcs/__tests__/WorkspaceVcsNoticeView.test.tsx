// @vitest-environment jsdom

/**
 * `WorkspaceVcsNoticeView` 单测（CINDY-RW-10）。
 *
 * 测试价值
 * - 生产入口与可观察结果：这是版本控制提示的唯一展示/处置组件，会被挂进页头、横幅与弹层。
 *   用户可观察结果：advisory 是否以非错误形态出现、按钮文案来自哪（PSB descriptionZh / 本地
 *   key）、点「一键清理」是否先二次确认、确认后是否只传 kind + confirm（路径由 main 决定）、
 *   202 后是否出现「清理已开始」与刷新入口、stale 时动作是否禁用。
 * - Bug／规则依据（2026-11-26 20:4x 再更正 + 独立审查 r4）：
 *   ① advisory 非阻塞；`clean-workspace` 不可逆需二次确认且确认文案按 kind 生成、列出检出与
 *      修改数；② 只有 clean-workspace 会显示「清理已开始」（旧实现任何带 operationId 的动作都
 *      会挂这句）；③ 旧 `force-release` 已删除，即使混进数据也不得渲染；④ 详情不重复列检出
 *      范围（范围只在正文列一次）；⑤ 失败文案统一走根 `psbFailureText`。
 * - 最小失败输入：notice.actions 里塞 `force-release`（手动构造，绕过解析层）、clean 未确认
 *   就点、requestConfirm 返回 false、stale 时点清理。
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
      <WorkspaceVcsNoticeView
        workspaceId="ws-1"
        notice={ADVISORY}
        workspaceLabel="打包机 · saga2"
      />,
    );

    const root = screen.getByTestId('workspace-vcs-notice');
    expect(root.dataset['advisory']).toBe('true');
    expect(screen.getByTestId('workspace-vcs-notice-message').getAttribute('role')).toBe('status');
    expect(root.textContent).toContain('检测到未提交修改（1 个检出）');
    expect(root.textContent).toContain('一键清理');
    expect(root.textContent).toContain('忽略提示，继续使用工作区');
    // 横幅写清是哪个工作区。
    expect(screen.getByTestId('workspace-vcs-workspace-label').textContent).toBe(
      '打包机 · saga2',
    );
    // projects 摘要来自检出数与修改数（i18n 插值）。
    expect(screen.getByTestId('workspace-vcs-projects-summary').textContent).toContain(
      'remoteWorkspace.vcs.projectsSummary#1,3',
    );
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

  it('stale（readOnly）时禁用全部动作并给出可行动原因', () => {
    installBridge();
    render(
      <WorkspaceVcsNoticeView
        workspaceId="ws-1"
        notice={ADVISORY}
        readOnly
        readOnlyHint="暂时连不上这个远程工作区，请检查网络后重试。"
      />,
    );

    expect(screen.getByTestId('workspace-vcs-notice').dataset['readOnly']).toBe('true');
    expect(screen.getByTestId('workspace-vcs-read-only-hint').textContent).toBe(
      '暂时连不上这个远程工作区，请检查网络后重试。',
    );
    // 清理是不可逆写操作：stale 时不能摆一个点下去只有 404 的按钮。
    expect((screen.getByText('一键清理') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('忽略提示，继续使用工作区') as HTMLButtonElement).disabled).toBe(
      true,
    );
    // 详情也不在 stale 时去拉（同一条不可达的 PSB）。
    expect(screen.queryByText('remoteWorkspace.vcs.detailsShow')).toBeNull();
  });
});

describe('一键清理：不可逆动作必须二次确认', () => {
  it('先进入确认区，按 kind 生成文案并列出检出与修改数；取消后不发请求', async () => {
    const bridge = installBridge();
    render(<WorkspaceVcsNoticeView workspaceId="ws-1" notice={ADVISORY} />);

    fireEvent.click(screen.getByText('一键清理'));

    const confirm = screen.getByTestId('workspace-vcs-confirm');
    expect(confirm.getAttribute('role')).toBe('group');
    expect(confirm.textContent).toContain('remoteWorkspace.vcs.confirm.title');
    expect(confirm.textContent).toContain('remoteWorkspace.vcs.irreversibleNote');
    // 确认范围：具体检出路径 + 未提交修改数（不是只有一个总数）。
    expect(confirm.textContent).toContain('remoteWorkspace.vcs.projectLine#.,p4,3');

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
    // 成功 toast 在 onResolved（宿主刷新事实）之后。
    expect(toastMock.success).toHaveBeenCalledWith('remoteWorkspace.vcs.cleanStarted');

    fireEvent.click(screen.getByText('remoteWorkspace.dialog.refresh'));
    await waitFor(() =>
      expect(bridge.refreshWorkspaces).toHaveBeenCalledWith({ workspaceIds: ['ws-1'] }),
    );
  });

  it('「清理已开始」只属于 clean-workspace：普通动作带 operationId 也不显示', async () => {
    const bridge = installBridge({
      runWorkspaceVcsAction: vi.fn(async () => ({
        workspaceId: 'ws-1',
        kind: 'retry',
        accepted: false,
        operationId: 'op-should-not-show',
        data: null,
      })),
    });
    render(
      <WorkspaceVcsNoticeView
        workspaceId="ws-1"
        notice={{
          ...LEGACY_REJECTION,
          actions: [
            { kind: 'retry', method: 'POST', path: '/api/cindy/remote/workspaces/ws-1/vcs/check' },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByText('remoteWorkspace.vcs.action.retry'));
    await waitFor(() => expect(bridge.runWorkspaceVcsAction).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('workspace-vcs-cleaning')).toBeNull();
  });

  it('宿主提供 requestConfirm 时只走宿主确认一次（不叠加内联确认区）；取消则不执行', async () => {
    const bridge = installBridge();
    const requestConfirm = vi.fn(
      async (_input: {
        title: string;
        description: string;
        confirmText: string;
        lines?: readonly string[];
      }) => false,
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
      // 确认范围逐条给出（宿主可用富内容区渲染，不在字符串里拼中文标点）。
      lines: ['remoteWorkspace.vcs.projectLine#.,p4,3'],
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

  it('确认后请求失败 → 用根 psbFailureText 的可行动文案 toast，不静默', async () => {
    const bridge = installBridge({
      runWorkspaceVcsAction: vi.fn(async () => {
        throw new Error('[PSB_WORKSPACE_VCS_UNAVAILABLE] 无法确认');
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
  it('错误形态（advisory:false）用 alert 语义，渲染重试按钮，点后只传 kind 执行', async () => {
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

    const root = screen.getByTestId('workspace-vcs-notice');
    expect(root.dataset['advisory']).toBe('false');
    expect(screen.getByTestId('workspace-vcs-notice-message').getAttribute('role')).toBe('alert');
    expect(root.textContent).toContain('remoteWorkspace.vcs.rejectedHint');

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
    const confirm = screen.getByTestId('workspace-vcs-confirm');
    // 确认文案按 kind 生成：标题是「还原后解除占用（不可撤销）」，不是清理的「清理工作区并继续？」。
    expect(confirm.textContent).toContain('remoteWorkspace.vcs.action.revert-then-release');
    expect(confirm.textContent).not.toContain('remoteWorkspace.vcs.confirm.title');
    expect(confirm.textContent).toContain('remoteWorkspace.vcs.projectLine#.,p4,3');
    // 通用确认文案（复用共享确认框默认文案，不新造“清理并继续”这种错语义）。
    fireEvent.click(screen.getByText('commonUi.confirmDialog.confirm'));

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
  it('点「查看详情」按 inspect-vcs action 拉取并展示服务端字段；范围只在正文列一次', async () => {
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

    fireEvent.click(screen.getByText('remoteWorkspace.vcs.detailsShow'));

    await waitFor(() =>
      expect(bridge.runWorkspaceVcsAction).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        kind: 'inspect-vcs',
      }),
    );
    await waitFor(() => expect(screen.getByTestId('workspace-vcs-details')).toBeTruthy());
    const details = screen.getByTestId('workspace-vcs-details');
    expect(details.textContent).toContain('branch: main');
    expect(details.textContent).toContain('changes: 3');
    // 详情块不再重复列检出范围（正文已经列过一次；旧实现三处重复）。
    expect(details.textContent).not.toContain('remoteWorkspace.vcs.projectLine');
  });
});
