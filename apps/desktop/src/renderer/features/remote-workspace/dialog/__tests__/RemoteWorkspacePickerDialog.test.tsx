// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：真实渲染 `RemoteWorkspacePickerDialog`（侧栏 / 草稿页共用入口），
 *   通过 `window.electronAPI.psbRemote` 注入 PSB 桥，断言用户能看到的结果：
 *   **不出现任何引擎选择控件**、确认时只占用工作区且**不创建 PSB 会话**、占用失败不回调、
 *   不可用行禁用并把可行动原因放进 tooltip（行内不再有「徽标 + 长句 + 锁」三遍）、
 *   新建工作区成功后出现在列表里并被选中、连续点击只占用一次、失败文案带占用人名。
 * - 2026-11-26 独立审查修复的两条新行为：
 *   ① **忙时也有出口**：占用在途时 Cancel 可点，关掉后迟到的成功会被 `releaseWorkspace`
 *      还回去（占用无 TTL，不能留一把没有主人的锁）；占用本身有超时；
 *   ② **VCS 通知抑制通用错误**：旧版 409 的版本控制通知与通用失败条不再同显；
 *   ③ **键盘 / ARIA**：radiogroup 方向键更换选中项、roving tabindex 只留一个 Tab 停点；
 *      占用在途时按钮保持可聚焦（`aria-disabled` + loading，而不是 `disabled` 把焦点甩回 body）。
 * - Bug／规则依据：产品口径 2026-11-25（新建远程工作区只选/建工作区）+ docs/product-rules/
 *   psb-remote-workspace-sessions.md §2.2（占用失败不留在草稿里）、§2.5（占用无 TTL）、
 *   §2.7（VCS 提示与失败提示不双显、释放失败不能静默）。
 * - 现有覆盖缺口：草稿页下拉与弹窗共用同一条选择链路；共享行为（占用/取消/键盘/失败文案）
 *   在本文件与 `PsbWorkspacePicker.test.tsx` 各钉一次自己容器的入口。
 * - 最小失败输入：占用取消后仍回调父级（用户被带进一个没有占用的草稿）；忙时禁用 Cancel
 *   （卡死无出口）；VCS 失败时同时弹通用错误条（同一事实两句话）。
 * - tier：unit（jsdom + 内存 fake bridge，无网络/进程）。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsbOccupyWorkspaceResult } from '../../../../../shared/psb-remote-workspace';
import {
  createdWorkspaceResult,
  deferred,
  installPsbBridge,
  makeLegacyVcsNotice,
  makeOccupiedByOtherWorkspace,
  makePsbWorkspace,
  occupiedByMeResult,
  uninstallPsbBridge,
} from '../../__tests__/psbTestFixtures';
import { resetWorkspaceVcsNoticeStoreForTest } from '../../vcs/vcsNoticeStore';
import { PSB_OCCUPY_TIMEOUT_MS } from '../usePsbWorkspaceSelection';
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

function renderDialog(
  overrides: {
    onCreated?: ReturnType<typeof vi.fn>;
    onOpenChange?: ReturnType<typeof vi.fn>;
    initialTab?: 'existing' | 'create';
  } = {},
) {
  const onCreated = overrides.onCreated ?? vi.fn();
  const onOpenChange = overrides.onOpenChange ?? vi.fn();
  const utils = render(
    <RemoteWorkspacePickerDialog
      open
      initialTab={overrides.initialTab}
      onOpenChange={onOpenChange}
      onCreated={onCreated}
    />,
  );
  return { onCreated, onOpenChange, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkspaceVcsNoticeStoreForTest();
});
afterEach(() => {
  vi.useRealTimers();
  uninstallPsbBridge();
});

describe('RemoteWorkspacePickerDialog', () => {
  it('不出现任何引擎选择控件，占用成功后只回工作区级载荷且不创建 PSB 会话', async () => {
    const workspace = makePsbWorkspace({});
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(async () => occupiedByMeResult(workspace)),
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
    // 0.1.180：占用成功可能带 advisory（检出脏）→ 兜底读一次（推送已覆盖时幂等）。
    await waitFor(() =>
      expect(bridge.workspaceVcsNotice).toHaveBeenCalledWith({ workspaceId: 'workspace-1' }),
    );
    // 产品口径：弹窗不建 PSB 会话（引擎/模型在草稿页选）。
    expect(bridge.createSession).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // 弹窗里没有任何引擎选择控件（模型/引擎面板在草稿页）。
    expect(screen.queryByRole('radiogroup', { name: 'newChat.agentSelect.label' })).toBeNull();
    expect(screen.queryByRole('radio', { name: /Claude|Codex|Pi/ })).toBeNull();
  });

  it('占用被他人抢走时不回调、不关闭，并在弹窗里显示占用人（文案只有一份来源）', async () => {
    const userWorkspace = makePsbWorkspace({});
    let listCall = 0;
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => {
        listCall += 1;
        // 第一次返回「可占用」；占用失败后的刷新返回别人的占用信息（占用人名来源）。
        return { workspaces: [listCall === 1 ? userWorkspace : makeOccupiedByOtherWorkspace()] };
      }),
      // main 的约定：占用人名放在 IPC message 里。
      occupyWorkspace: vi.fn(async () => {
        throw Object.assign(new Error('张三'), { code: 'PSB_WORKSPACE_OCCUPIED_BY_OTHER' });
      }),
    });

    const { onCreated, onOpenChange } = renderDialog();
    fireEvent.click(await screen.findByTestId('psb-workspace-row-workspace-1'));
    fireEvent.click(screen.getByTestId('psb-start-session'));

    await waitFor(() => expect(bridge.occupyWorkspace).toHaveBeenCalledTimes(1));
    expect(bridge.createSession).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // 错误可行动：文案带占用人名（i18n key#name），而不是一句「操作失败」。
    expect(
      (await screen.findAllByText('remoteWorkspace.error.occupiedByOther#张三')).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('remoteWorkspace.error.unknown')).toBeNull();
  });

  it('不可用行禁用：占用原因只进 tooltip，行内不再重复「徽标 + 长句 + 锁」', async () => {
    installPsbBridge({
      listWorkspaces: vi.fn(async () => ({
        workspaces: [
          makeOccupiedByOtherWorkspace(),
          makePsbWorkspace({
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
    // 可用性原因进 tooltip（可见短标签是徽标），长句不在行文本里重复。
    expect(otherRow.getAttribute('title')).toBe('remoteWorkspace.error.occupiedByOther#张三');
    expect(otherRow.textContent).toContain('remoteWorkspace.badge.occupied');
    expect(otherRow.textContent).not.toContain('remoteWorkspace.error.occupiedByOther');
    // 他人占用时**不再**额外挂锁图标（徽标已经表达占用，锁与徽标互斥）。
    expect(otherRow.querySelector('[data-lock-state="other"]')).toBeNull();

    const offlineRow = screen.getByTestId('psb-workspace-row-workspace-offline');
    expect((offlineRow as HTMLButtonElement).disabled).toBe(true);
    // 离线原因与占用原因是不同分支（badge.offline vs occupiedByOther）。
    expect(offlineRow.textContent).toContain('remoteWorkspace.badge.offline');
  });

  it('新建工作区成功后列表出现该工作区并被选中（继续可用于占用）', async () => {
    const existing = makePsbWorkspace({ id: 'workspace-existing', title: '旧工作区' });
    const created = makePsbWorkspace({
      id: 'workspace-created',
      title: '新工作区',
      state: 'provisioning',
    });
    let createdOnce = false;
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({
        workspaces: createdOnce ? [existing, created] : [existing],
      })),
      createWorkspace: vi.fn(async () => {
        createdOnce = true;
        return createdWorkspaceResult(created);
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

  it('labels workspace rows with the workspace name, keeping directory/machine as secondary text', async () => {
    installPsbBridge({
      listWorkspaces: vi.fn(async () => ({
        workspaces: [
          makePsbWorkspace({
            id: '9c747178aabbccdd',
            title: 'saga2_project',
            clientName: '打包机',
            directoryName: 'saga2_project',
          }),
          // 名称与目录不同：次要行继续显示目录。
          makePsbWorkspace({
            id: 'aa11bb22cc33',
            title: '我的项目',
            clientName: '打包机',
            directoryName: 'saga2_design',
          }),
        ],
      })),
    });
    renderDialog();
    const row = await screen.findByTestId('psb-workspace-row-9c747178aabbccdd');
    // 主标题 = 工作区名称（`title` 属性仍是完整 id，悬停可取）；名称与目录同名时不重复渲染。
    expect(row.querySelector('[title="9c747178aabbccdd"]')?.textContent).toBe('saga2_project');
    expect(row.textContent).toContain('打包机');
    expect(row.textContent).not.toContain('remoteWorkspace.dialog.directorySecondary');
    expect(row.textContent?.match(/saga2_project/g) ?? []).toHaveLength(1);
    const renamed = screen.getByTestId('psb-workspace-row-aa11bb22cc33');
    expect(renamed.querySelector('[title="aa11bb22cc33"]')?.textContent).toBe('我的项目');
    // 前缀是 i18n key（12 locale 各自翻译），目录名作为占位符值传入，不再写死中文。
    expect(renamed.textContent).toContain('remoteWorkspace.dialog.directorySecondary#saga2_design');
    expect(renamed.textContent).not.toContain('目录：');
  });

  it('opens directly on the create tab when the draft-page channel entry asks for it', async () => {
    installPsbBridge();
    renderDialog({ initialTab: 'create' });
    // 渠道内「新建远程工作区」必须直接落在新建表单，而不是让用户再点一次页签。
    expect(await screen.findByTestId('psb-workspace-create-form')).toBeTruthy();
    expect(screen.queryByTestId('psb-workspace-list')).toBeNull();
  });

  it('hydrates the legacy 409 notice and shows it inline instead of the generic error', async () => {
    const workspace = makePsbWorkspace({});
    installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(async () => {
        throw Object.assign(new Error('工作区有未提交修改'), {
          code: 'PSB_WORKSPACE_VCS_DIRTY',
        });
      }),
      workspaceVcsNotice: vi.fn(async () => ({
        workspaceId: 'workspace-1',
        notice: makeLegacyVcsNotice(),
      })),
    });
    const { onCreated } = renderDialog();
    fireEvent.click(await screen.findByTestId('psb-workspace-row-workspace-1'));
    fireEvent.click(screen.getByTestId('psb-start-session'));
    await waitFor(() => expect(screen.getByTestId('workspace-vcs-notice')).toBeTruthy());
    const inline = screen.getByTestId('workspace-vcs-notice');
    expect(inline.dataset['variant']).toBe('inline');
    expect(inline.dataset['advisory']).toBe('false');
    expect(inline.textContent).toContain('工作区有未提交修改：1 个检出');
    expect(inline.textContent).toContain('重试检查');
    // 同一事实不双显：VCS 通知在场时通用失败条被抑制。
    expect(screen.queryByText('remoteWorkspace.vcs.dirty')).toBeNull();
    // 占用失败不回调父级（不带着未占用的工作区进草稿）。
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('连续点击只发起一次占用与一次回调', async () => {
    const workspace = makePsbWorkspace({});
    const pending = deferred<PsbOccupyWorkspaceResult>();
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(() => pending.promise),
    });
    const { onCreated } = renderDialog();
    fireEvent.click(await screen.findByTestId('psb-workspace-row-workspace-1'));
    const start = screen.getByTestId('psb-start-session');
    fireEvent.click(start);
    fireEvent.click(start);
    expect(bridge.occupyWorkspace).toHaveBeenCalledTimes(1);
    pending.resolve(occupiedByMeResult(workspace));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(bridge.createSession).not.toHaveBeenCalled();
  });

  it('忙时按钮保持焦点，Cancel 可退出，迟到的占用成功会被释放（不留无名锁）', async () => {
    const workspace = makePsbWorkspace({});
    const pending = deferred<PsbOccupyWorkspaceResult>();
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(() => pending.promise),
    });
    const { onCreated, onOpenChange } = renderDialog();
    fireEvent.click(await screen.findByTestId('psb-workspace-row-workspace-1'));
    const start = screen.getByTestId('psb-start-session');
    start.focus();
    fireEvent.click(start);
    // 在途时焦点仍在主按钮上（aria-disabled + loading，而不是 disabled 把焦点甩回 body）。
    await waitFor(() => expect(start.getAttribute('aria-busy')).toBe('true'));
    expect(document.activeElement).toBe(start);
    expect((start as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'remoteWorkspace.dialog.cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // 取消之后占用才成功：必须还回去，并且不回调父级。
    pending.resolve(occupiedByMeResult(workspace));
    await waitFor(() =>
      expect(bridge.releaseWorkspace).toHaveBeenCalledWith({ workspaceId: 'workspace-1' }),
    );
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('占用超时给出可行动失败；超时后才成功的占用同样会被释放', async () => {
    const workspace = makePsbWorkspace({});
    const pending = deferred<PsbOccupyWorkspaceResult>();
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(() => pending.promise),
    });
    renderDialog();
    fireEvent.click(await screen.findByTestId('psb-workspace-row-workspace-1'));
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('psb-start-session'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PSB_OCCUPY_TIMEOUT_MS + 1);
    });
    expect(screen.getByText('remoteWorkspace.error.unreachable')).toBeTruthy();
    pending.resolve(occupiedByMeResult(workspace));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(bridge.releaseWorkspace).toHaveBeenCalledWith({ workspaceId: 'workspace-1' });
  });

  it('radiogroup 方向键更换选中项，roving tabindex 只留一个 Tab 停点', async () => {
    installPsbBridge({
      listWorkspaces: vi.fn(async () => ({
        workspaces: [
          makePsbWorkspace({ id: 'workspace-a', title: 'A' }),
          makePsbWorkspace({ id: 'workspace-b', title: 'B' }),
        ],
      })),
    });
    renderDialog();
    const rowA = await screen.findByTestId('psb-workspace-row-workspace-a');
    const rowB = screen.getByTestId('psb-workspace-row-workspace-b');
    expect(rowA.getAttribute('tabindex')).toBe('0');
    expect(rowB.getAttribute('tabindex')).toBe('-1');
    rowA.focus();
    fireEvent.keyDown(rowA, { key: 'ArrowDown' });
    // radio group 惯例：方向键移动 = 更换选中；焦点跟着走，Tab 停点只有一个。
    await waitFor(() => expect(rowB.getAttribute('aria-checked')).toBe('true'));
    expect(rowA.getAttribute('aria-checked')).toBe('false');
    expect(rowB.getAttribute('tabindex')).toBe('0');
    expect(rowA.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(rowB);
  });
});
