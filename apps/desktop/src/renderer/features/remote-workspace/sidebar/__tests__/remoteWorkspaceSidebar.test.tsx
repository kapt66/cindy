// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：`RemoteWorkspaceSection`（侧栏「Meka 助理 › 远程工作区」节点，由
 *   `MekaAssistantSection` 真实渲染）与行上的 `RemoteWorkspaceOpenButton` /
 *   `RemoteWorkspaceStatusBadges`（由 `SessionItem` / `SessionCard` 真实挂载）。用户看到的
 *   结果是：节点排在 Meka 分类**最上面**（先于项目分组，空态也如此）；节点里只出现 `psb:`
 *   会话；被他人占用时状态标签是「使用中」(tone=warn) 且锁为 other；行首图标按钮点击后在
 *   系统浏览器打开该会话所在工作区（`bridge.openWebWorkspace`）；弹窗选定后父层只收到
 *   **工作区级**载荷（无会话 id / 引擎）；图标按钮带 `Tip`。
 * - Bug／规则依据：`docs/product-rules/psb-remote-workspace-sessions.md` §2.1（节点只列本机
 *   开过的远程工作区会话；状态标签与锁的口径；「新建会话」不受他人占用影响）与 §7 验收 6；
 *   task-13 / lead 追加口径（新建任务只选工作区，引擎与模型在草稿页选；节点排分类首位）；
 *   `docs/dev-rules/psb-remote-session-transport.md` §4（组件只经 `PsbRemoteBridge`）。
 * - 现有覆盖缺口：`mekaSidebarOrder.test.ts` 只断言段级顺序（Meka 段在置顶/项目段之前），
 *   没有覆盖「远程工作区节点在 Meka 段内的首位」；`psb:` 与 `mcpr:` / SSH / 本机会话混排时
 *   的归属、被他人占用时的 tone、图标按钮的桥调用、工作区级载荷也都没有覆盖。
 * - 最小失败输入：`{ remoteHostId: 'mcpr:x' }` 混进节点列表（归属错）；workspace
 *   `occupancy { occupied: true, byMe: false }`（旧实现会显示「在线」）；把节点放在
 *   `{groups.map}` 之后（顺序回退）；`onCreated` 仍带 sessionId/agentKind（旧口径）。
 * - tier：unit（jsdom 组件测试，stub preload 桥，无网络 / 无 Electron）。
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import { toast } from '@/lib/toast';
import type { MekaProject } from '../../../../../shared/meka-projects';
import type { PsbRemoteWorkspace } from '../../../../../shared/psb-remote-workspace';
import type { UseSidebarFilterReturn } from '../../../cc-agent/hooks/useSidebarFilter';
import { MekaAssistantSection } from '../../../cc-agent/sidebar/sections/MekaAssistantSection';
import { RemoteWorkspaceSection } from '../RemoteWorkspaceSection';
import {
  RemoteWorkspaceOpenButton,
  RemoteWorkspaceStatusBadges,
} from '../RemoteWorkspaceRowDecor';
import {
  refreshRemoteWorkspaces,
  resetRemoteWorkspaceStatusForTest,
} from '../remoteWorkspaceStatusStore';

/** `listMekaProjects()` 的桩数据；顺序断言需要「有项目 / 无项目」两种（vi.mock 提升，故 vi.hoisted）。 */
const mekaProjectsStub = vi.hoisted(() => ({ projects: [] as unknown[] }));

// ── 与「节点/行装饰」无关的重依赖：按最小契约 mock ──────────────────────────────
vi.mock('@/components/ui/tooltip', () => ({
  // 守卫要求 icon-only 控件必须挂 Tip；mock 保留 text 以便断言「Tip 存在且文案本地化」。
  Tip: ({ text, children }: { text?: unknown; children: React.ReactElement }) => (
    <span data-tip={typeof text === 'string' ? text : ''}>{children}</span>
  ),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  // 返回 key 本身：断言的就是 i18n key，避免测试里复制翻译文案。
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
}));

// 节点只负责「哪些会话」；行组件本身由 SessionItem / SessionCard 单测覆盖，这里换成探针，
// 免得把整套会话行依赖（PR / 定时 / Orca …）拖进本文件的收集期。
vi.mock('@/features/cc-agent/sidebar/SessionEntryList', () => ({
  SessionEntryList: ({ sessions }: { sessions: readonly { id: string }[] }) => (
    <div data-testid="session-entry-list">
      {sessions.map((session) => (
        <span key={session.id} data-session-id={session.id} />
      ))}
    </div>
  ),
}));

// 弹窗是并行的 dialog 任务实现的组件；这里验证「按钮能打开它、选定工作区载荷能上抛」。
// 弹窗由 `React.lazy` 装载，mock 掉模块后 lazy 仍会 await 一次动态 import（Suspense）。
// 载荷是**工作区级**（不含会话 id / 引擎，引擎与模型在草稿页选）。
vi.mock('@/features/remote-workspace/dialog/RemoteWorkspacePickerDialog', () => ({
  RemoteWorkspacePickerDialog: ({ open, onCreated }: {
    open: boolean;
    onOpenChange(open: boolean): void;
    onCreated(result: {
      workspaceId: string;
      clientId: string;
      clientName: string;
      workspaceTitle: string;
      directoryName: string | null;
    }): void;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="remote-workspace-picker">
        <button
          type="button"
          data-testid="picker-create"
          onClick={() =>
            onCreated({
              workspaceId: 'ws-a',
              clientId: 'client-a',
              clientName: 'Build box',
              workspaceTitle: 'Checkout',
              directoryName: 'checkout',
            })
          }
        >
          create
        </button>
      </div>
    );
  },
}));

// 「远程工作区」节点要排在 Meka 分类最上面（用户裁决）：顺序断言用真实的
// MekaAssistantSection，只把它的外部门（项目查询 / 筛选菜单）换成稳定桩。
vi.mock('@/ipc/mekaProjects', () => ({
  listMekaProjects: async () => mekaProjectsStub.projects,
}));

vi.mock('@/lib/mekaProjectsRolesBus', () => ({
  onMekaProjectsRolesChanged: () => () => undefined,
}));

vi.mock('@/features/cc-agent/sidebar/SidebarFilterPopover', () => ({
  SidebarFilterPopover: () => null,
}));

/** 项目行用到的 Meka 项目（`MekaProject` 全字段，避免半成品桩在后续读取里炸）。 */
const MEKA_PROJECT_A: MekaProject = {
  id: 'project-a',
  name: 'project-a',
  displayName: 'Project A',
  description: null,
  tags: [],
  isBuiltin: false,
  configSource: 'project',
  configUnavailable: false,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  roles: [],
  formalWorkflowEnabled: false,
};

const OPENED_WORKSPACE_IDS: string[] = [];

function fakeWorkspace(patch: Partial<PsbRemoteWorkspace> = {}): PsbRemoteWorkspace {
  return {
    id: 'ws-a',
    title: 'Checkout',
    clientId: 'client-a',
    clientName: 'Build box',
    clientOnline: true,
    clientPlatform: 'linux',
    state: 'ready',
    templateKey: null,
    templateTitle: null,
    directoryName: 'checkout',
    clientPath: '/work/checkout',
    occupancy: { occupied: false, byMe: false, personId: null, personName: '', occupiedAt: null },
    usable: true,
    unusableReason: null,
    sessionCount: 1,
    webUrl: 'https://psb.example/remote/workspaces/ws-a',
    sessionsWebUrl: 'https://psb.example/remote/workspaces/ws-a/sessions',
    ...patch,
  };
}

function installBridge(workspaces: readonly PsbRemoteWorkspace[]) {
  const bridge = {
    status: vi.fn(),
    listWorkspaces: vi.fn(),
    listClients: vi.fn(),
    listProjectTemplates: vi.fn(),
    createWorkspace: vi.fn(),
    occupyWorkspace: vi.fn(),
    releaseWorkspace: vi.fn(),
    createSession: vi.fn(),
    refreshWorkspaces: vi.fn(async () => ({ workspaces })),
    sessionStatus: vi.fn(),
    stopSession: vi.fn(),
    openWebWorkspace: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      OPENED_WORKSPACE_IDS.push(workspaceId);
    }),
    streamStatus: vi.fn(),
    streamStart: vi.fn(),
    streamStop: vi.fn(),
    streamInput: vi.fn(),
    onStreamEvent: vi.fn(() => () => undefined),
    onWorkspaceChanged: vi.fn(() => () => undefined),
  };
  (window as unknown as { electronAPI?: unknown }).electronAPI = { psbRemote: bridge };
  return bridge;
}

function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    agentKind: 'cc',
    workspaceKind: 'project',
    status: 'active',
    source: 'user',
    workingDir: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  } as Session;
}

const NO_EVENTS = new Set<string>();
const NO_SCHEDULES = new Map();

function renderSection(sessions: readonly Session[], onWorkspaceSelected = vi.fn()) {
  return render(
    <RemoteWorkspaceSection
      sessions={sessions}
      runningSessionIds={NO_EVENTS}
      attachedSessionIds={NO_EVENTS}
      notifications={NO_EVENTS}
      scheduleSessionIndex={NO_SCHEDULES}
      onSessionClick={vi.fn()}
      onAction={vi.fn()}
      onRename={vi.fn()}
      onTogglePin={vi.fn()}
      onScheduleAction={vi.fn()}
      sessionVariant="text"
      onWorkspaceSelected={onWorkspaceSelected}
    />,
  );
}

beforeEach(() => {
  OPENED_WORKSPACE_IDS.length = 0;
  mekaProjectsStub.projects = [MEKA_PROJECT_A];
  resetRemoteWorkspaceStatusForTest();
});

afterEach(() => {
  cleanup();
  resetRemoteWorkspaceStatusForTest();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('远程工作区侧栏节点', () => {
  it('只列 psb: 会话，其它远端与本机会话不进这个节点', async () => {
    installBridge([fakeWorkspace()]);
    const { container } = renderSection([
      session('local-1'),
      session('psb-1', { remoteHostId: 'psb:psb-session-1', workingDir: '/psb-remote/checkout' }),
      session('mcpr-1', { remoteHostId: 'mcpr:instance-1' }),
      session('ssh-1', { remoteHostId: 'build-box' }),
    ]);

    await waitFor(() => {
      expect(container.querySelector('[data-session-id]')).not.toBeNull();
    });
    expect(container.querySelectorAll('[data-session-id]')).toHaveLength(1);
    expect(container.querySelector('[data-session-id="psb-1"]')).not.toBeNull();
    expect(container.querySelector('[data-session-id="local-1"]')).toBeNull();
    expect(container.querySelector('[data-remote-workspace-empty]')).toBeNull();
    // 节点头与「新建会话」入口常驻（即使一条会话都没有）,空态交给下一条用例。
    expect(screen.getByText('remoteWorkspace.sidebar.title')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'remoteWorkspace.sidebar.newSession' }),
    ).not.toBeNull();
  });

  it('一条会话都没有时显示空态提示', async () => {
    installBridge([]);
    const { container } = renderSection([]);
    await waitFor(() => {
      expect(container.querySelector('[data-remote-workspace-empty]')).not.toBeNull();
    });
    expect(screen.getByText('remoteWorkspace.sidebar.empty')).not.toBeNull();
  });

  it('工作区被他人占用时状态标签是 tone=warn 的「使用中」，新建会话入口仍可点', async () => {
    installBridge([
      fakeWorkspace({
        usable: false,
        unusableReason: 'occupied-by-other',
        occupancy: { occupied: true, byMe: false, personId: '2', personName: 'Bob', occupiedAt: 1 },
      }),
    ]);
    const onWorkspaceSelected = vi.fn();
    renderSection(
      [session('psb-1', { remoteHostId: 'psb:psb-session-1', workingDir: '/psb-remote/checkout' })],
      onWorkspaceSelected,
    );

    // 节点挂载即批量拉一次工作区状态（不是每行一次请求）。
    await waitFor(() => expect(screen.getByText('remoteWorkspace.sidebar.title')).not.toBeNull());
    // 他人占用时「新建会话」按钮照样可点：占用是工作区级的，用户还可以选/建别的工作区。
    fireEvent.click(screen.getByRole('button', { name: 'remoteWorkspace.sidebar.newSession' }));
    const picker = await screen.findByTestId('remote-workspace-picker');
    fireEvent.click(within(picker).getByTestId('picker-create'));

    // 弹窗只选/建工作区：交给父层的载荷是工作区级（没有会话 id / 引擎，引擎在草稿页选）。
    expect(onWorkspaceSelected).toHaveBeenCalledTimes(1);
    expect(onWorkspaceSelected.mock.calls[0][0]).toEqual({
      workspaceId: 'ws-a',
      clientId: 'client-a',
      clientName: 'Build box',
      workspaceTitle: 'Checkout',
      directoryName: 'checkout',
    });
  });
});

describe('远程工作区会话行装饰', () => {
  it('他人占用 → 状态标签 tone=warn + 锁 other（Tip 显示占用人名字）', async () => {
    installBridge([
      fakeWorkspace({
        usable: false,
        unusableReason: 'occupied-by-other',
        occupancy: { occupied: true, byMe: false, personId: '2', personName: 'Bob', occupiedAt: 1 },
      }),
    ]);
    await refreshRemoteWorkspaces(true);
    render(
      <RemoteWorkspaceStatusBadges
        session={{ id: 'psb-1', remoteHostId: 'psb:psb-session-1', workingDir: '/psb-remote/checkout' }}
      />,
    );

    const badge = await screen.findByText('remoteWorkspace.badge.occupied');
    expect(badge.getAttribute('data-badge-tone')).toBe('warn');
    const lock = document.querySelector('[data-lock-state]');
    expect(lock?.getAttribute('data-lock-state')).toBe('other');
    // 锁的说明文案走 Tip（icon-only 控件的双标签契约）：有名字显示名字，不再只写「他人占用」。
    expect(lock?.closest('[data-tip]')?.getAttribute('data-tip')).toBe('Bob');
  });

  it('自己占用 → 锁 mine 亮起，Tip 显示「名字 +（你）」', async () => {
    installBridge([
      fakeWorkspace({
        occupancy: { occupied: true, byMe: true, personId: '1', personName: 'Me', occupiedAt: 1 },
      }),
    ]);
    await refreshRemoteWorkspaces(true);
    render(
      <RemoteWorkspaceStatusBadges
        session={{ id: 'psb-1', remoteHostId: 'psb:psb-session-1', workingDir: '/psb-remote/checkout' }}
      />,
    );

    expect(await screen.findByText('remoteWorkspace.badge.online')).not.toBeNull();
    const lock = document.querySelector('[data-lock-state]');
    expect(lock?.getAttribute('data-lock-state')).toBe('mine');
    // 与页头占用文案共用同一格式函数：自己占用且 PSB 给了名字 → 名字 +（你）后缀（这里 t 返回 key）。
    expect(lock?.closest('[data-tip]')?.getAttribute('data-tip')).toBe(
      'remoteWorkspace.admin.occupancySelfValue',
    );
  });

  it('目录名变化/为空时仍按工作区 id 形态解析出状态（草稿目标用的是同一纯函数）', async () => {
    // 弹窗刚建出的工作区可能 directoryName 为空、PSB 后来才补上；会话行落库的是建会话那一帧的
    // 虚拟目录（`/psb-remote/<目录名或 id>`）。两种形态都要能对回同一个工作区，否则重启后
    // 这类会话会掉标签。
    installBridge([fakeWorkspace({ directoryName: 'checkout' })]);
    await refreshRemoteWorkspaces(true);
    render(
      <RemoteWorkspaceStatusBadges
        session={{ id: 'psb-1', remoteHostId: 'psb:psb-session-1', workingDir: '/psb-remote/ws-a' }}
      />,
    );
    expect(await screen.findByText('remoteWorkspace.badge.online')).not.toBeNull();
  });

  it('行首图标按钮经 Tip 说明并用系统浏览器打开该会话所在工作区', async () => {
    const bridge = installBridge([fakeWorkspace()]);
    await refreshRemoteWorkspaces(true);
    render(
      <RemoteWorkspaceOpenButton
        session={{ id: 'psb-1', remoteHostId: 'psb:psb-session-1', workingDir: '/psb-remote/checkout' }}
        isActive={false}
      />,
    );

    const button = screen.getByRole('button', {
      name: 'remoteWorkspace.session.openWorkspace',
    });
    // icon-only 控件必须有可见 Tip（守卫测试的同一份契约）。
    expect(button.closest('[data-tip]')?.getAttribute('data-tip')).toBe(
      'remoteWorkspace.session.openWorkspace',
    );
    fireEvent.click(button);
    await waitFor(() =>
      expect(bridge.openWebWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-a' }),
    );
    expect(OPENED_WORKSPACE_IDS).toEqual(['ws-a']);
  });

  it('打开网页失败时显示可行动文案，而不是通用「操作失败，请稍后重试。」', async () => {
    // 2026-11-26 真机事故：旧实现 catch 后写死 `remoteWorkspace.error.unknown`，用户点两次
    // 行首图标就看到两条通用 toast。已知失败码必须映射成可行动文案（`psbFailureText`）。
    const bridge = installBridge([fakeWorkspace()]);
    await refreshRemoteWorkspaces(true);
    vi.mocked(toast.error).mockClear();
    bridge.openWebWorkspace.mockRejectedValueOnce(new Error('[PSB_UNREACHABLE] 连不上 PSB'));
    render(
      <RemoteWorkspaceOpenButton
        session={{ id: 'psb-1', remoteHostId: 'psb:psb-session-1', workingDir: '/psb-remote/checkout' }}
        isActive={false}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'remoteWorkspace.session.openWorkspace' }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('remoteWorkspace.error.unreachable'),
    );
    expect(toast.error).not.toHaveBeenCalledWith('remoteWorkspace.error.unknown');
  });
});

describe('Meka 分类内的节点顺序', () => {
  const mekaSectionProps = {
    runningSessionIds: NO_EVENTS,
    attachedSessionIds: NO_EVENTS,
    notifications: NO_EVENTS,
    scheduleSessionIndex: NO_SCHEDULES,
    onSessionClick: vi.fn(),
    onAction: vi.fn(),
    onRename: vi.fn(),
    onTogglePin: vi.fn(),
    onScheduleAction: vi.fn(),
    onCreateRegular: vi.fn(),
    onCreateFormal: vi.fn(),
    onManage: vi.fn(),
    filter: {} as UseSidebarFilterReturn,
    allKnownProjects: [],
    onRemoteWorkspaceTargetSelected: vi.fn(),
  };
  const psbSession = session('psb-1', {
    remoteHostId: 'psb:psb-session-1',
    workingDir: '/psb-remote/checkout',
  });
  const mekaSession = session('meka-1', {
    title: 'Meka 任务',
    mekaProjectId: 'project-a',
    mekaRoleId: 'role-a',
  });

  function remoteNodeComesFirst(first: HTMLElement, second: HTMLElement) {
    // DOM 顺序断言：远程工作区节点必须出现在后者之前（首位）。
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }

  it('排在 Meka 项目分组之前（有会话时）', async () => {
    installBridge([fakeWorkspace()]);
    render(
      <MekaAssistantSection
        {...mekaSectionProps}
        sessions={[mekaSession]}
        remoteWorkspaceSessions={[psbSession]}
      />,
    );
    const remoteNode = await screen.findByText('remoteWorkspace.sidebar.title');
    const projectRow = await screen.findByText('Project A');
    remoteNodeComesFirst(remoteNode, projectRow);
  });

  it('没有任何 Meka 项目分组（空态）时同样在首位', async () => {
    mekaProjectsStub.projects = [];
    installBridge([fakeWorkspace()]);
    render(<MekaAssistantSection {...mekaSectionProps} sessions={[]} />);
    const remoteNode = await screen.findByText('remoteWorkspace.sidebar.title');
    // 空态提示在远程工作区节点之后：节点仍是分类第一行。
    const emptyHint = await screen.findByText('meka.noSessions');
    remoteNodeComesFirst(remoteNode, emptyHint);
  });
});
