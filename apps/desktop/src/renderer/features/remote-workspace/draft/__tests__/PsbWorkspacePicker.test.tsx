// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：真实渲染 `PsbWorkspacePicker`（草稿页位置渠道「远程工作区」的项目
 *   胶囊内容），通过 `window.electronAPI.psbRemote` 注入 PSB 桥，断言：可用行选中时**先占用**
 *   再回传工作区级载荷；不可用行（他人占用/离线）禁用并显示原因；占用失败**不选中**且错误带
 *   占用人名；「新建远程工作区」入口回调上层；上层传 `disabled`（发送 / 目录恢复在途）时行与
 *   新建入口都点不动；主标题是**工作区名称**（缺名才回退机器-短 id），次要行是 i18n key +
 *   目录值（不写死中文），名称与目录同名时去重。
 * - 版本控制检查通知（CINDY-RW-10）：占用成功后的 advisory 兜底读一次；占用被旧版 409 拒绝时，
 *   下拉把 main 缓存的通知以内联形态（`variant="inline"`）展示并与错误一起可行动，占用仍不选中。
 * - Bug／规则依据：产品口径 2026-11-25（远程工作区 = 位置渠道；选中工作区即占用，失败不留在
 *   草稿里）+ 2026-11-26（实例标签只显示工作区名称）+ docs/product-rules/psb-remote-workspace-sessions.md §2.2/§2.5。
 * - 现有覆盖缺口：弹窗测试覆盖「弹窗本身」；草稿页路由太大不能挂载，工作区下拉是草稿页唯一
 *   的换工作区入口，必须单独钉住「占用失败不选中」这条产品边界。
 * - 最小失败输入：若省略 `occupyWorkspace` 直接回传，用户会带着一个未占用的工作区进草稿（发送
 *   时才 409）；若占用失败仍回调，会留下一个注定发不出消息的草稿。
 * - tier：unit（jsdom + 内存 fake bridge，无网络/进程）。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PsbListWorkspacesResult,
  PsbOccupyWorkspaceResult,
  PsbRemoteWorkspace,
} from '../../../../../shared/psb-remote-workspace';
import type { WorkspaceVcsNotice } from '../../../../../shared/psb-workspace-vcs';

import { PsbWorkspacePicker } from '../PsbWorkspacePicker';
import { psbWorkspaceDisplayName, shortPsbWorkspaceId } from '../../dialog/psbDialogModel';
import { resetWorkspaceVcsNoticeStoreForTest } from '../../vcs/vcsNoticeStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 只回伪造 key + 占位符值：断言落在「用哪个 key、传了什么值」上，不复制任何语言的文案。
    t: (key: string, options?: Record<string, string>) => {
      if (options?.name) return `${key}#${options.name}`;
      if (options?.directory) return `${key}#${options.directory}`;
      return key;
    },
  }),
}));

interface FakeBridge {
  listWorkspaces: ReturnType<typeof vi.fn>;
  occupyWorkspace: ReturnType<typeof vi.fn>;
  onWorkspaceChanged: ReturnType<typeof vi.fn>;
  /** 版本控制检查通知（CINDY-RW-10）：推送 / 兜底读 / 动作。 */
  workspaceVcsNotice: ReturnType<typeof vi.fn>;
  onWorkspaceVcsNotice: ReturnType<typeof vi.fn>;
  runWorkspaceVcsAction: ReturnType<typeof vi.fn>;
}

function makeWorkspace(overrides: Partial<PsbRemoteWorkspace> = {}): PsbRemoteWorkspace {
  return {
    id: 'workspace-1',
    title: 'SAGA2 设计',
    clientId: 'client-1',
    clientName: '设计机-01',
    clientOnline: true,
    clientPlatform: 'windows',
    state: 'ready',
    templateKey: 'saga2_design',
    templateTitle: 'SAGA2 设计',
    directoryName: 'saga2_design',
    clientPath: 'C:/work/saga2_design',
    occupancy: {
      occupied: false,
      byMe: false,
      personId: null,
      personName: '',
      occupiedAt: null,
    },
    usable: true,
    unusableReason: null,
    sessionCount: 0,
    webUrl: null,
    sessionsWebUrl: null,
    ...overrides,
  };
}

function occupiedByOther(): PsbRemoteWorkspace {
  return makeWorkspace({
    id: 'workspace-other',
    title: '别人的工作区',
    occupancy: {
      occupied: true,
      byMe: false,
      personId: 'other',
      personName: '张栋',
      occupiedAt: 2,
    },
    usable: false,
    unusableReason: 'occupied-by-other',
  });
}

/** 旧版 PSB（<0.1.180）409 携带的版本控制检查通知：`advisory:false` = 操作被拒。 */
const LEGACY_VCS_NOTICE: WorkspaceVcsNotice = {
  code: 'WORKSPACE_VCS_DIRTY',
  advisory: false,
  messageZh: '工作区有未提交修改：1 个检出',
  dirty: true,
  projects: [{ projectId: 1, pathInWorkspace: '.', kind: 'p4', changes: 3 }],
  actions: [
    {
      kind: 'inspect-vcs',
      method: 'GET',
      path: '/api/cindy/remote/workspaces/workspace-1/vcs',
      descriptionZh: '查看详情',
    },
    {
      kind: 'retry',
      method: 'POST',
      path: '/api/cindy/remote/workspaces/workspace-1/vcs/check',
      descriptionZh: '重试检查',
    },
  ],
};

function installBridge(overrides: Partial<FakeBridge> = {}): FakeBridge {
  const bridge: FakeBridge = {
    listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({
      workspaces: [],
    })),
    occupyWorkspace: vi.fn(),
    onWorkspaceChanged: vi.fn(() => () => undefined),
    workspaceVcsNotice: vi.fn(async () => ({ workspaceId: 'workspace-1', notice: null })),
    onWorkspaceVcsNotice: vi.fn(() => () => undefined),
    runWorkspaceVcsAction: vi.fn(),
    ...overrides,
  };
  (window as unknown as { electronAPI?: { psbRemote?: FakeBridge } }).electronAPI = {
    psbRemote: bridge,
  };
  return bridge;
}

function renderPicker(overrides: Partial<Parameters<typeof PsbWorkspacePicker>[0]> = {}) {
  const onSelect = vi.fn();
  const onCreate = vi.fn();
  const utils = render(
    <PsbWorkspacePicker
      open
      selectedWorkspaceId={null}
      onSelect={onSelect}
      onCreate={onCreate}
      {...overrides}
    />,
  );
  return { onSelect, onCreate, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkspaceVcsNoticeStoreForTest();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('PsbWorkspacePicker', () => {
  it('lists workspaces, then occupies the picked one before handing back workspace-level payload', async () => {
    const workspace = makeWorkspace({});
    const bridge = installBridge({
      listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({
        workspaces: [workspace],
      })),
      occupyWorkspace: vi.fn(
        async (): Promise<PsbOccupyWorkspaceResult> => ({ workspace }),
      ),
    });

    const { onSelect } = renderPicker({ selectedWorkspaceId: 'workspace-1' });
    const row = await screen.findByTestId('psb-picker-workspace-row-workspace-1');
    // 当前选中的工作区行显示选中态（渠道切换后用户能确认当前工作区）。
    expect(row.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(row);

    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(bridge.occupyWorkspace).toHaveBeenCalledWith({ workspaceId: 'workspace-1' });
    // 0.1.180：占用成功可能带 advisory（检出脏）→ 兜底读一次（推送已覆盖时幂等）。
    await waitFor(() =>
      expect(bridge.workspaceVcsNotice).toHaveBeenCalledWith({ workspaceId: 'workspace-1' }),
    );
    // 只回工作区级事实；sessionId / agentKind 属于首条消息懒建阶段，不在选择时决定。
    expect(onSelect).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      clientId: 'client-1',
      clientName: '设计机-01',
      workspaceTitle: 'SAGA2 设计',
      directoryName: 'saga2_design',
    });
  });

  it('keeps unavailable workspaces visible but disabled, with the reason and occupier name', async () => {
    installBridge({
      listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({
        workspaces: [
          occupiedByOther(),
          makeWorkspace({ id: 'workspace-offline', clientOnline: false, usable: false, unusableReason: 'client-offline' }),
        ],
      })),
    });

    renderPicker();
    const other = await screen.findByTestId('psb-picker-workspace-row-workspace-other');
    expect((other as HTMLButtonElement).disabled).toBe(true);
    expect(other.getAttribute('data-available')).toBe('false');
    expect(screen.getByText('remoteWorkspace.error.occupiedByOther#张栋')).toBeTruthy();

    const offline = screen.getByTestId('psb-picker-workspace-row-workspace-offline');
    expect((offline as HTMLButtonElement).disabled).toBe(true);
    expect(offline.textContent).toContain('remoteWorkspace.badge.offline');
  });

  it('does not select anything when occupying is rejected (shows readable error with occupier)', async () => {
    const workspace = makeWorkspace({});
    let listCall = 0;
    const bridge = installBridge({
      listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => {
        listCall += 1;
        // 首次读到「可用」；占用失败后的刷新返回别人的占用信息（占用人名来源）。
        return { workspaces: [listCall === 1 ? workspace : occupiedByOther()] };
      }),
      occupyWorkspace: vi.fn(async () => {
        throw Object.assign(new Error('[WORKSPACE_OCCUPIED_BY_OTHER] 已被占用'), {
          code: 'WORKSPACE_OCCUPIED_BY_OTHER',
          message: '已被「张栋」占用',
        });
      }),
    });

    const { onSelect } = renderPicker();
    fireEvent.click(await screen.findByTestId('psb-picker-workspace-row-workspace-1'));

    await waitFor(() => expect(bridge.occupyWorkspace).toHaveBeenCalledTimes(1));
    expect(onSelect).not.toHaveBeenCalled();
    // 错误可行动：带占用人名（刷新后从 occupancy.personName 补全），而不是一句通用失败。
    expect(
      (await screen.findAllByText('remoteWorkspace.error.occupiedByOther#张栋')).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('remoteWorkspace.error.unknown')).toBeNull();
  });

  /**
   * 版本控制检查通知（CINDY-RW-10）：旧版 409 拒绝占用时，main 已缓存 + 广播通知。下拉在失败后
   * 兜底读一次并以内联形态展示可行动作（查看详情 / 重试检查），用户不会只看到一句通用失败、
   * 也不知道清理入口在哪；占用仍不选中（不带着注定发不出消息的工作区进草稿）。
   */
  it('hydrates the legacy 409 notice and shows it inline when occupying is rejected', async () => {
    const workspace = makeWorkspace({});
    const bridge = installBridge({
      listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({
        workspaces: [workspace],
      })),
      occupyWorkspace: vi.fn(async () => {
        throw Object.assign(new Error('[WORKSPACE_VCS_DIRTY] 工作区有未提交修改'), {
          code: 'WORKSPACE_VCS_DIRTY',
          message: '工作区有未提交修改',
        });
      }),
      workspaceVcsNotice: vi.fn(async () => ({
        workspaceId: 'workspace-1',
        notice: LEGACY_VCS_NOTICE,
      })),
    });

    const { onSelect } = renderPicker();
    fireEvent.click(await screen.findByTestId('psb-picker-workspace-row-workspace-1'));

    await waitFor(() => expect(bridge.occupyWorkspace).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(bridge.workspaceVcsNotice).toHaveBeenCalledWith({ workspaceId: 'workspace-1' }),
    );
    const inline = await screen.findByTestId('workspace-vcs-notice');
    expect(inline.dataset['variant']).toBe('inline');
    expect(inline.dataset['advisory']).toBe('false');
    expect(inline.textContent).toContain(LEGACY_VCS_NOTICE.messageZh);
    expect(inline.textContent).toContain('重试检查');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opens the existing create-workspace form through the create entry', async () => {
    installBridge({ listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({ workspaces: [] })) });
    const { onCreate } = renderPicker();
    fireEvent.click(await screen.findByTestId('psb-picker-create-workspace'));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('disables every row and the create entry while the draft has an in-flight operation', async () => {
    installBridge({
      listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({
        workspaces: [makeWorkspace({})],
      })),
    });
    // 发送 / 目录恢复 / worktree 创建在途时上层传 `disabled`：此时选择和新建都必须点不动
    // （占用动作不能与在途发送并发，否则换目标会把刚占用的工作区留在草稿外）。
    renderPicker({ disabled: true });
    const row = await screen.findByTestId('psb-picker-workspace-row-workspace-1');
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('psb-picker-create-workspace') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('shows list loading and empty states (no silent blank dropdown)', async () => {
    installBridge({ listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({ workspaces: [] })) });
    renderPicker();
    expect(await screen.findByText('remoteWorkspace.dialog.workspaceListEmpty')).toBeTruthy();
  });

  /**
   * 显示名口径（2026-11-26 用户实机反馈，取代 2026-11-25 的「机器-短 id」）：选择器主标题直接
   * 显示**工作区名称**；机器-短 id 只在名称缺失时兜底。项目胶囊与下拉行共用同一份
   * `psbWorkspaceDisplayName`。次要行仍是单行去重：目录与名称同名时退回机器名（同名工作区
   * 跨机器靠它区分），目录与名称不同时显示目录。
   */
  it('labels rows with the workspace name, keeping directory/machine as the single secondary line', async () => {
    installBridge({
      listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({
        workspaces: [
          makeWorkspace({
            id: '9c747178aabbccdd',
            title: 'saga2_project',
            clientName: '打包机',
            directoryName: 'saga2_project',
          }),
          // 同一名称、另一台机器：主标题相同，靠次要行的机器名区分。
          makeWorkspace({
            id: 'dd44ee55ff66',
            title: 'saga2_project',
            clientName: '设计机-01',
            directoryName: 'saga2_project',
          }),
          // 名称被改过：次要行继续显示目录（前缀走 i18n key，不写死中文）。
          makeWorkspace({
            id: 'aa11bb22cc33',
            title: '我的项目',
            clientName: '打包机',
            directoryName: 'saga2_design',
          }),
        ],
      })),
    });

    renderPicker();
    const row = await screen.findByTestId('psb-picker-workspace-row-9c747178aabbccdd');
    // 主标题 = 工作区名称（`title` 属性仍是完整工作区 id，悬停可取）。
    expect(row.querySelector('[title="9c747178aabbccdd"]')?.textContent).toBe('saga2_project');
    // 名称与目录同名：次要行退回机器名，名称只出现一次（不再「目录：saga2_project」重复）。
    expect(row.textContent).toContain('打包机');
    expect(row.textContent).not.toContain('remoteWorkspace.dialog.directorySecondary');
    expect(row.textContent?.match(/saga2_project/g) ?? []).toHaveLength(1);

    const sameName = screen.getByTestId('psb-picker-workspace-row-dd44ee55ff66');
    expect(sameName.querySelector('[title="dd44ee55ff66"]')?.textContent).toBe('saga2_project');
    expect(sameName.textContent).toContain('设计机-01');

    const renamed = screen.getByTestId('psb-picker-workspace-row-aa11bb22cc33');
    expect(renamed.querySelector('[title="aa11bb22cc33"]')?.textContent).toBe('我的项目');
    expect(renamed.textContent).toContain('remoteWorkspace.dialog.directorySecondary#saga2_design');
    expect(renamed.textContent).not.toContain('目录：');
  });
});

describe('psbWorkspaceDisplayName', () => {
  it('prefers the workspace name, falling back to client-短id only when the name is missing', () => {
    // 名称是主标签（用户 2026-11-26：「具体的实例显示为工作区名称即可」）。
    expect(
      psbWorkspaceDisplayName({
        clientName: '打包机',
        workspaceId: '9c747178aabbccdd',
        workspaceTitle: '  saga2_project  ',
      }),
    ).toBe('saga2_project');
    // 名称缺失（空串 / 只有空格 / 没有该字段）：退回「机器-短 id」，不再拿模板名顶替。
    expect(
      psbWorkspaceDisplayName({
        clientName: '打包机',
        workspaceId: '9c747178aabbccdd',
        workspaceTitle: '   ',
      }),
    ).toBe('打包机-9c747178…');
    expect(psbWorkspaceDisplayName({ clientName: '打包机', workspaceId: '9c747178aabbccdd' })).toBe(
      '打包机-9c747178…',
    );
    expect(shortPsbWorkspaceId('9c747178')).toBe('9c747178');
    // 没有机器名时退回短 id；全空（只可能来自手改脏数据）返回空串但不抛。
    expect(
      psbWorkspaceDisplayName({
        clientName: '  ',
        workspaceId: '9c747178aabbccdd',
        workspaceTitle: '',
      }),
    ).toBe('9c747178…');
    expect(psbWorkspaceDisplayName({ clientName: '', workspaceId: '', workspaceTitle: '' })).toBe('');
  });
});
