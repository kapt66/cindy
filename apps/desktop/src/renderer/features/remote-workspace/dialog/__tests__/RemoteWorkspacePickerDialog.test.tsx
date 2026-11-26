// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：真实渲染 `RemoteWorkspacePickerDialog`（侧栏/草稿页共用入口），
 *   通过 `window.electronAPI.psbRemote` 注入 PSB 桥，断言用户能看到的结果：**不出现任何
 *   引擎选择控件**、确认时只占用工作区且**不创建 PSB 会话**、占用失败不回调、不可用行禁用
 *   并给出占用人、新建工作区成功后出现在列表里并被选中、连续点击只占用一次。
 * - Bug／规则依据：产品口径 2026-11-25（新建远程工作区只选/建工作区，Harness 与模型在草稿页
 *   按既有链路选）+ docs/product-rules/psb-remote-workspace-sessions.md §2.2（占用失败不留在
 *   草稿里；不可用行仍显示并给出原因）。
 * - 现有覆盖缺口：弹窗是新增组件；`draft/psbDraftSession.test.ts` 覆盖懒建会话，但不覆盖
 *   「弹窗本身不建会话 / 不暴露引擎」这条产品边界。
 * - 最小失败输入：若弹窗仍调用 `createSession` 或在占用失败后回调父级，用户会进入一个引擎/
 *   会话身份都不一致的草稿；若把引擎选择放回弹窗，就违反本轮产品口径。
 * - tier：unit（jsdom + 内存 fake bridge，无网络/进程）。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PsbOccupyWorkspaceResult,
  PsbRemoteClient,
  PsbRemoteWorkspace,
  PsbSessionStatusResult,
  PsbCreateWorkspaceResult,
  PsbListClientsResult,
  PsbListTemplatesResult,
  PsbListWorkspacesResult,
  PsbProjectTemplate,
} from '../../../../../shared/psb-remote-workspace';
import { RemoteWorkspacePickerDialog } from '../RemoteWorkspacePickerDialog';

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
  status: ReturnType<typeof vi.fn>;
  listWorkspaces: ReturnType<typeof vi.fn>;
  listClients: ReturnType<typeof vi.fn>;
  listProjectTemplates: ReturnType<typeof vi.fn>;
  createWorkspace: ReturnType<typeof vi.fn>;
  occupyWorkspace: ReturnType<typeof vi.fn>;
  releaseWorkspace: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  refreshWorkspaces: ReturnType<typeof vi.fn>;
  sessionStatus: ReturnType<typeof vi.fn>;
  stopSession: ReturnType<typeof vi.fn>;
  openWebWorkspace: ReturnType<typeof vi.fn>;
  streamStatus: ReturnType<typeof vi.fn>;
  streamStart: ReturnType<typeof vi.fn>;
  streamStop: ReturnType<typeof vi.fn>;
  streamInput: ReturnType<typeof vi.fn>;
  onStreamEvent: ReturnType<typeof vi.fn>;
  onWorkspaceChanged: ReturnType<typeof vi.fn>;
}

function makeWorkspace(overrides: Partial<PsbRemoteWorkspace>): PsbRemoteWorkspace {
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

function makeClient(): PsbRemoteClient {
  return {
    id: 'client-1',
    name: '设计机-01',
    online: true,
    platform: 'windows',
    capabilities: { workspace: true, agent: true, streaming: true, exec: true, windows: true },
    agents: [{ kind: 'claude-code', available: true, version: '0.0.12' }],
  };
}

function makeTemplate(): PsbProjectTemplate {
  return { key: 'saga2_design', title: 'SAGA2 设计', description: null, checkoutCount: 2 };
}

function installBridge(overrides: Partial<FakeBridge> = {}): FakeBridge {
  const bridge: FakeBridge = {
    status: vi.fn(async () => ({ ready: true, reasonKey: null, host: 'mekabot-test', testHost: true })),
    listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({ workspaces: [] })),
    listClients: vi.fn(async (): Promise<PsbListClientsResult> => ({ clients: [makeClient()] })),
    listProjectTemplates: vi.fn(async (): Promise<PsbListTemplatesResult> => ({ templates: [makeTemplate()] })),
    createWorkspace: vi.fn(),
    occupyWorkspace: vi.fn(),
    releaseWorkspace: vi.fn(async (): Promise<PsbOccupyWorkspaceResult> => ({ workspace: makeWorkspace({}) })),
    // 弹窗**不应**调用：PSB 会话在草稿页首条消息发送时才懒建。留 spy 用于断言零调用。
    createSession: vi.fn(),
    refreshWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({ workspaces: [] })),
    sessionStatus: vi.fn(async () => ({}) as PsbSessionStatusResult),
    stopSession: vi.fn(async () => undefined),
    openWebWorkspace: vi.fn(async () => undefined),
    streamStatus: vi.fn(),
    streamStart: vi.fn(),
    streamStop: vi.fn(),
    streamInput: vi.fn(),
    onStreamEvent: vi.fn(() => () => undefined),
    onWorkspaceChanged: vi.fn(() => () => undefined),
    ...overrides,
  };
  (window as unknown as { electronAPI?: { psbRemote?: FakeBridge } }).electronAPI = {
    psbRemote: bridge,
  };
  return bridge;
}

function renderDialog(overrides: { onCreated?: ReturnType<typeof vi.fn>; onOpenChange?: ReturnType<typeof vi.fn> } = {}) {
  const onCreated = overrides.onCreated ?? vi.fn();
  const onOpenChange = overrides.onOpenChange ?? vi.fn();
  const utils = render(
    <RemoteWorkspacePickerDialog open onOpenChange={onOpenChange} onCreated={onCreated} />,
  );
  return { onCreated, onOpenChange, ...utils };
}

function readyOccupy(workspace: PsbRemoteWorkspace): PsbOccupyWorkspaceResult {
  return { workspace: { ...workspace, occupancy: { occupied: true, byMe: true, personId: 'me', personName: '我', occupiedAt: 1 } } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('RemoteWorkspacePickerDialog', () => {
  it('不出现任何引擎选择控件，占用成功后只回工作区级载荷且不创建 PSB 会话', async () => {
    const workspace = makeWorkspace({});
    const bridge = installBridge({
      listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(async () => readyOccupy(workspace)),
    });

    const { onCreated, onOpenChange } = renderDialog();
    fireEvent.click(await screen.findByTestId('psb-workspace-row-workspace-1'));
    fireEvent.click(screen.getByTestId('psb-start-session'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      clientId: 'client-1',
      clientName: '设计机-01',
      workspaceTitle: 'SAGA2 设计',
      directoryName: 'saga2_design',
    });
    expect(bridge.occupyWorkspace).toHaveBeenCalledTimes(1);
    // 产品口径：弹窗不建 PSB 会话（引擎/模型在草稿页选）。
    expect(bridge.createSession).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // 弹窗里没有任何引擎选择控件（模型/引擎面板在草稿页）。
    expect(screen.queryByRole('radiogroup', { name: 'newChat.agentSelect.label' })).toBeNull();
    expect(screen.queryByRole('radio', { name: /Claude|Codex|Pi/ })).toBeNull();
  });

  it('占用被他人抢走时不回调、不关闭，并在弹窗里显示占用人', async () => {
    const userWorkspace = makeWorkspace({});
    const occupiedByOther = makeWorkspace({
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
    let listCall = 0;
    const bridge = installBridge({
      listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => {
        listCall += 1;
        // 第一次返回「可占用」；占用失败后的刷新返回别人的占用信息（占用人名来源）。
        return { workspaces: [listCall === 1 ? userWorkspace : occupiedByOther] };
      }),
      occupyWorkspace: vi.fn(async () => {
        throw Object.assign(new Error('[WORKSPACE_OCCUPIED_BY_OTHER] 已被占用'), {
          code: 'WORKSPACE_OCCUPIED_BY_OTHER',
          message: '已被「张栋」占用',
        });
      }),
    });

    const { onCreated, onOpenChange } = renderDialog();
    fireEvent.click(await screen.findByTestId('psb-workspace-row-workspace-1'));
    fireEvent.click(screen.getByTestId('psb-start-session'));

    await waitFor(() => expect(bridge.occupyWorkspace).toHaveBeenCalledTimes(1));
    expect(bridge.createSession).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // 错误必须可行动：文案带占用人名（i18n key#name），而不是一句「操作失败」。
    // 行上的不可用原因与错误通知都会出现这条文案。
    expect(
      (await screen.findAllByText('remoteWorkspace.error.occupiedByOther#张栋')).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('remoteWorkspace.error.unknown')).toBeNull();
  });

  it('被他人占用 / 离线的工作区仍显示但禁止选中，并给出原因', async () => {
    installBridge({
      listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({
        workspaces: [
          makeWorkspace({
            id: 'workspace-other',
            occupancy: {
              occupied: true,
              byMe: false,
              personId: 'other',
              personName: '张栋',
              occupiedAt: 2,
            },
            usable: false,
            unusableReason: 'occupied-by-other',
          }),
          makeWorkspace({
            id: 'workspace-offline',
            clientOnline: false,
            usable: false,
            unusableReason: 'client-offline',
          }),
        ],
      })),
    });

    renderDialog();
    const otherRow = await screen.findByTestId('psb-workspace-row-workspace-other');
    expect((otherRow as HTMLButtonElement).disabled).toBe(true);
    expect(otherRow.getAttribute('data-available')).toBe('false');
    expect(await screen.findByText('remoteWorkspace.error.occupiedByOther#张栋')).toBeTruthy();

    const offlineRow = screen.getByTestId('psb-workspace-row-workspace-offline');
    expect((offlineRow as HTMLButtonElement).disabled).toBe(true);
    // 离线原因与占用原因是不同分支（badge.offline vs occupiedByOther）。
    expect(offlineRow.textContent).toContain('remoteWorkspace.badge.offline');
  });

  it('新建工作区成功后列表出现该工作区并被选中（继续可用于占用）', async () => {
    const existing = makeWorkspace({ id: 'workspace-existing', title: '旧工作区' });
    const created = makeWorkspace({ id: 'workspace-created', title: '新工作区', state: 'provisioning' });
    let createdOnce = false;
    const bridge = installBridge({
      listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({
        workspaces: createdOnce ? [existing, created] : [existing],
      })),
      createWorkspace: vi.fn(async (): Promise<PsbCreateWorkspaceResult> => {
        createdOnce = true;
        return { workspace: created };
      }),
    });

    renderDialog();
    fireEvent.click(await screen.findByRole('tab', { name: 'remoteWorkspace.dialog.tabCreate' }));
    fireEvent.click(await screen.findByTestId('psb-client-row-client-1'));
    fireEvent.click(await screen.findByTestId('psb-template-row-saga2_design'));
    fireEvent.click(screen.getByTestId('psb-create-workspace'));

    await waitFor(() =>
      expect(bridge.createWorkspace).toHaveBeenCalledWith({
        clientId: 'client-1',
        templateKey: 'saga2_design',
      }),
    );
    const createdRow = await screen.findByTestId('psb-workspace-row-workspace-created');
    expect(createdRow.getAttribute('data-selected')).toBe('true');
    // 刚建出的工作区还在 provisioning：行显示「准备中」，此时不能占用。
    expect(createdRow.textContent).toContain('remoteWorkspace.badge.pending');
    expect((screen.getByTestId('psb-start-session') as HTMLButtonElement).disabled).toBe(true);
  });

  it('labels workspace rows as client-短id, keeping the template name as secondary text', async () => {
    installBridge({
      listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({
        workspaces: [
          makeWorkspace({
            id: '9c747178aabbccdd',
            title: 'saga2_project',
            clientName: '打包机',
            directoryName: 'saga2_project',
          }),
        ],
      })),
    });
    renderDialog();
    const row = await screen.findByTestId('psb-workspace-row-9c747178aabbccdd');
    // 主标题 = 客户端名-短 id；模板名/标题不再与目录名重复渲染（次要行只一行「目录」）。
    expect(row.textContent).toContain('打包机-9c747178…');
    // 前缀是 i18n key（12 locale 各自翻译），目录名作为占位符值传入，不再写死中文。
    expect(row.textContent).toContain(
      'remoteWorkspace.dialog.directorySecondary#saga2_project',
    );
    expect(row.textContent).not.toContain('目录：');
    expect(row.textContent?.match(/saga2_project/g) ?? []).toHaveLength(1);
    expect(row.querySelector('[title="9c747178aabbccdd"]')).toBeTruthy();
  });

  it('opens directly on the create tab when the draft-page channel entry asks for it', async () => {
    installBridge();
    render(
      <RemoteWorkspacePickerDialog
        open
        initialTab="create"
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    // 渠道内「新建远程工作区」必须直接落在新建表单，而不是让用户再点一次页签。
    expect(await screen.findByTestId('psb-workspace-create-form')).toBeTruthy();
    expect(screen.queryByTestId('psb-workspace-list')).toBeNull();
  });

  it('连续点击只发起一次占用与一次回调', async () => {
    const workspace = makeWorkspace({});
    let releaseOccupy: () => void = () => undefined;
    const occupyGate = new Promise<void>((resolve) => {
      releaseOccupy = resolve;
    });
    const bridge = installBridge({
      listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(async () => {
        await occupyGate;
        return readyOccupy(workspace);
      }),
    });

    const { onCreated } = renderDialog();
    fireEvent.click(await screen.findByTestId('psb-workspace-row-workspace-1'));
    const start = screen.getByTestId('psb-start-session');
    fireEvent.click(start);
    fireEvent.click(start);

    expect(bridge.occupyWorkspace).toHaveBeenCalledTimes(1);
    releaseOccupy();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(bridge.createSession).not.toHaveBeenCalled();
  });
});
