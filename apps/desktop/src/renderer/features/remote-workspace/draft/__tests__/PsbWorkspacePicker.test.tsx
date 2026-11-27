// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：真实渲染 `PsbWorkspacePicker`（草稿页位置渠道「远程工作区」的项目
 *   胶囊内容），通过 `window.electronAPI.psbRemote` 注入 PSB 桥，并挂**真实的**
 *   `ConfirmDialogProvider`（占用确认复用现有确认弹窗能力），断言：无人占用行点击**先弹确认**、
 *   取消不占用不回调、确认后占用一次并回传工作区级载荷；**mine 行直接交接、不弹确认、
 *   不调用 occupy**；不可用行（他人占用 / 离线）禁用、原因进 tooltip、占用表达不重复三遍；
 *   占用失败**不选中**且错误带占用人名；「新建远程工作区」入口回调上层；上层传 `disabled`
 *   （发送 / 目录恢复在途）时行与新建入口都点不动；主标题是**工作区名称**（缺名才回退机器-短 id）。
 * - 与弹窗共用同一份实现后的边界：
 *   ① **listbox 键盘**：方向键只移动焦点（既不触发占用也不弹确认），Enter/Space 才激活；
 *   ② **忙不丢焦点**：占用在途的行改用 `aria-disabled`（不是原生 disabled），焦点留在行上；
 *   ③ **卸载即放弃**：下拉在占用在途时被卸载，迟到的成功会被 `releaseWorkspace` 还回去
 *      （占用无 TTL，不能留下没有 UI 主人的锁）；交接成功（onSelect 已回调）则不释放。
 * - Bug／规则依据：产品口径 2026-11-27（工作区列表按占用状态区分选择流程：无人占用先确认占用、
 *   别人占用不可选、mine 直接可选）；产品 §2.3（远程工作区 = 位置渠道；选中即占用，失败不留在
 *   草稿里）+ §2.5（占用无 TTL、放弃选择必须归还）；VCS 场景见 §2.7。
 * - 现有覆盖缺口：草稿页路由太大不能挂载，工作区下拉是草稿页唯一的换工作区入口。
 * - 最小失败输入：无人占用行不确认就占用；mine 行还弹确认/再 occupy 一次；取消后仍回调
 *   （用户带着未占用工作区进草稿）；占用失败仍回调（注定发不出消息的草稿）；卸载后不释放；
 *   方向键顺手触发占用。
 * - tier：unit（jsdom + 内存 fake bridge，无网络/进程）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import type { PsbOccupyWorkspaceResult } from '../../../../../shared/psb-remote-workspace';
import {
  deferred,
  installPsbBridge,
  makeLegacyVcsNotice,
  makeOccupiedByMeWorkspace,
  makeOccupiedByOtherWorkspace,
  makePsbWorkspace,
  occupiedByMeResult,
  uninstallPsbBridge,
} from '../../__tests__/psbTestFixtures';
import { resetWorkspaceVcsNoticeStoreForTest } from '../../vcs/vcsNoticeStore';
import { psbWorkspaceDisplayName, shortPsbWorkspaceId } from '../../dialog/psbWorkspaceDisplay';
import { PsbWorkspacePicker } from '../PsbWorkspacePicker';

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

const CONFIRM_TITLE_KEY = 'remoteWorkspace.dialog.confirmOccupy.title';
const CONFIRM_CONFIRM_KEY = 'remoteWorkspace.dialog.confirmOccupy.confirm';
const CONFIRM_CANCEL_KEY = 'remoteWorkspace.dialog.confirmOccupy.cancel';

function renderPicker(overrides: Partial<Parameters<typeof PsbWorkspacePicker>[0]> = {}) {
  const onSelect = vi.fn();
  const onCreate = vi.fn();
  const utils = render(
    <ConfirmDialogProvider>
      <PsbWorkspacePicker
        open
        selectedWorkspaceId={null}
        onSelect={onSelect}
        onCreate={onCreate}
        {...overrides}
      />
    </ConfirmDialogProvider>,
  );
  return { onSelect, onCreate, ...utils };
}

async function acceptOccupyPrompt() {
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: CONFIRM_CONFIRM_KEY }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkspaceVcsNoticeStoreForTest();
});
afterEach(() => {
  cleanup();
  uninstallPsbBridge();
});

describe('PsbWorkspacePicker', () => {
  it('无人占用：点击先弹占用确认，确认后占用一次并回传工作区级载荷', async () => {
    const workspace = makePsbWorkspace({});
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(async () => occupiedByMeResult(workspace)),
    });
    const { onSelect } = renderPicker({ selectedWorkspaceId: 'workspace-1' });
    const row = await screen.findByTestId('psb-picker-workspace-row-workspace-1');
    // 当前选中的工作区行显示选中态（渠道切换后用户能确认当前工作区）。
    expect(row.getAttribute('aria-selected')).toBe('true');

    fireEvent.click(row);
    const prompt = await screen.findByRole('alertdialog');
    expect(within(prompt).getByText(`${CONFIRM_TITLE_KEY}#SAGA2 设计`)).toBeTruthy();
    expect(bridge.occupyWorkspace).not.toHaveBeenCalled();

    fireEvent.click(within(prompt).getByRole('button', { name: CONFIRM_CONFIRM_KEY }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(bridge.occupyWorkspace).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-1' });
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

  it('取消占用确认：不发 occupy、不回调、不选中', async () => {
    const workspace = makePsbWorkspace({});
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(async () => occupiedByMeResult(workspace)),
    });
    const { onSelect } = renderPicker();
    fireEvent.click(await screen.findByTestId('psb-picker-workspace-row-workspace-1'));
    const prompt = await screen.findByRole('alertdialog');
    fireEvent.click(within(prompt).getByRole('button', { name: CONFIRM_CANCEL_KEY }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(bridge.occupyWorkspace).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('mine 行直接交接：不弹占用确认、不调用 occupy', async () => {
    const mine = makeOccupiedByMeWorkspace({});
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [mine] })),
    });
    const { onSelect } = renderPicker();
    fireEvent.click(await screen.findByTestId('psb-picker-workspace-row-workspace-1'));
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(bridge.occupyWorkspace).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      clientId: 'client-1',
      clientName: '设计机-01',
      workspaceTitle: 'SAGA2 设计',
      directoryName: 'saga2_design',
    });
  });

  it('keeps unavailable workspaces visible but disabled, with the reason in the row tooltip', async () => {
    const bridge = installPsbBridge({
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

    const { onSelect } = renderPicker();
    const other = await screen.findByTestId('psb-picker-workspace-row-workspace-other');
    expect((other as HTMLButtonElement).disabled).toBe(true);
    expect(other.getAttribute('data-available')).toBe('false');
    // 占用原因在 tooltip（短标签是徽标），行里不再同时出现长句与锁图标。
    expect(other.getAttribute('title')).toBe('remoteWorkspace.error.occupiedByOther#张三');
    expect(other.textContent).toContain('remoteWorkspace.badge.occupied');
    expect(other.querySelector('[data-lock-state="other"]')).toBeNull();

    const offline = screen.getByTestId('psb-picker-workspace-row-workspace-offline');
    expect((offline as HTMLButtonElement).disabled).toBe(true);
    expect(offline.textContent).toContain('remoteWorkspace.badge.offline');

    fireEvent.click(other);
    fireEvent.click(offline);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(bridge.occupyWorkspace).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not select anything when occupying is rejected (shows readable error with occupier)', async () => {
    const workspace = makePsbWorkspace({});
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(async () => {
        throw Object.assign(new Error('张三'), { code: 'PSB_WORKSPACE_OCCUPIED_BY_OTHER' });
      }),
    });

    const { onSelect } = renderPicker();
    fireEvent.click(await screen.findByTestId('psb-picker-workspace-row-workspace-1'));
    await acceptOccupyPrompt();

    await waitFor(() => expect(bridge.occupyWorkspace).toHaveBeenCalledTimes(1));
    expect(onSelect).not.toHaveBeenCalled();
    // 错误可行动：带占用人名（IPC message 约定 = 人名），而不是一句通用失败。
    expect(
      (await screen.findAllByText('remoteWorkspace.error.occupiedByOther#张三')).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('remoteWorkspace.error.unknown')).toBeNull();
  });

  it('hydrates the legacy 409 notice inline instead of the generic error when occupying is rejected', async () => {
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

    const { onSelect } = renderPicker();
    fireEvent.click(await screen.findByTestId('psb-picker-workspace-row-workspace-1'));
    await acceptOccupyPrompt();

    const inline = await screen.findByTestId('workspace-vcs-notice');
    expect(inline.dataset['variant']).toBe('inline');
    expect(inline.dataset['advisory']).toBe('false');
    expect(inline.textContent).toContain('工作区有未提交修改：1 个检出');
    expect(inline.textContent).toContain('重试检查');
    // 同一事实不双显：VCS 通知在场时通用失败条被抑制。
    expect(screen.queryByText('remoteWorkspace.vcs.dirty')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opens the existing create-workspace form through the create entry', async () => {
    installPsbBridge({ listWorkspaces: vi.fn(async () => ({ workspaces: [] })) });

    const { onCreate } = renderPicker();
    fireEvent.click(await screen.findByTestId('psb-picker-create-workspace'));

    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('disables every row and the create entry while the draft has an in-flight operation', async () => {
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [makePsbWorkspace({})] })),
    });
    // 发送 / 目录恢复 / worktree 创建在途时上层传 `disabled`：此时选择和新建都必须点不动
    // （占用动作不能与在途发送并发，否则换目标会把刚占用的工作区留在草稿外）。
    const { onSelect } = renderPicker({ disabled: true });
    const row = await screen.findByTestId('psb-picker-workspace-row-workspace-1');
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('psb-picker-create-workspace') as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(row);
    expect(bridge.occupyWorkspace).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows list loading and empty states (no silent blank dropdown)', async () => {
    installPsbBridge({ listWorkspaces: vi.fn(async () => ({ workspaces: [] })) });
    renderPicker();
    expect(await screen.findByText('remoteWorkspace.dialog.workspaceListEmpty')).toBeTruthy();
  });

  it('labels rows with the workspace name, keeping directory/machine as the single secondary line', async () => {
    installPsbBridge({
      listWorkspaces: vi.fn(async () => ({
        workspaces: [
          makePsbWorkspace({
            id: '9c747178aabbccdd',
            title: 'saga2_project',
            clientName: '打包机',
            directoryName: 'saga2_project',
          }),
          // 同一名称、另一台机器：主标题相同，靠次要行的机器名区分。
          makePsbWorkspace({
            id: 'dd44ee55ff66',
            title: 'saga2_project',
            clientName: '设计机-01',
            directoryName: 'saga2_project',
          }),
          // 名称被改过：次要行继续显示目录（前缀走 i18n key，不写死中文）。
          makePsbWorkspace({
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
    expect(row.querySelector('[title="9c747178aabbccdd"]')?.textContent).toBe('saga2_project');
    // 名称与目录同名：次要行退回机器名，名称只出现一次。
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

  it('listbox 方向键只移动焦点：不占用、不弹确认、不回调', async () => {
    const workspaceA = makePsbWorkspace({ id: 'workspace-a', title: 'A' });
    const workspaceB = makePsbWorkspace({ id: 'workspace-b', title: 'B' });
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspaceA, workspaceB] })),
    });
    const { onSelect } = renderPicker();
    const rowA = await screen.findByTestId('psb-picker-workspace-row-workspace-a');
    const rowB = screen.getByTestId('psb-picker-workspace-row-workspace-b');
    expect(rowA.getAttribute('tabindex')).toBe('0');
    expect(rowB.getAttribute('tabindex')).toBe('-1');
    rowA.focus();
    fireEvent.keyDown(rowA, { key: 'ArrowDown' });
    // listbox：方向键只移动焦点；占用必须由 Enter/Space（原生按钮激活）显式触发。
    await waitFor(() => expect(document.activeElement).toBe(rowB));
    expect(bridge.occupyWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(rowB.getAttribute('tabindex')).toBe('0');
  });

  it('占用在途时行保持可聚焦（aria-disabled），卸载后迟到的成功会被释放', async () => {
    const workspace = makePsbWorkspace({});
    const pending = deferred<PsbOccupyWorkspaceResult>();
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(() => pending.promise),
    });
    const { onSelect, unmount } = renderPicker();
    const row = await screen.findByTestId('psb-picker-workspace-row-workspace-1');
    row.focus();
    fireEvent.click(row);
    await acceptOccupyPrompt();
    await waitFor(() => expect(row.getAttribute('aria-disabled')).toBe('true'));
    // 忙不丢焦点：行没有被原生 disabled 掉（否则焦点会掉回 body）。
    expect((row as HTMLButtonElement).disabled).toBe(false);
    expect(row.getAttribute('aria-busy')).toBe('true');
    expect(row.getAttribute('title')).toBe('remoteWorkspace.dialog.confirmOccupy.occupying');
    unmount();
    pending.resolve(occupiedByMeResult(workspace));
    await waitFor(() =>
      expect(bridge.releaseWorkspace).toHaveBeenCalledWith({ workspaceId: 'workspace-1' }),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('psbWorkspaceDisplayName', () => {
  it('prefers the workspace name, falling back to client-短id only when the name is missing', () => {
    expect(
      psbWorkspaceDisplayName({
        clientName: '打包机',
        workspaceId: '9c747178aabbccdd',
        workspaceTitle: '  saga2_project  ',
      }),
    ).toBe('saga2_project');
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
    expect(
      psbWorkspaceDisplayName({
        clientName: '  ',
        workspaceId: '9c747178aabbccdd',
        workspaceTitle: '',
      }),
    ).toBe('9c747178…');
    expect(psbWorkspaceDisplayName({ clientName: '', workspaceId: '', workspaceTitle: '' })).toBe(
      '',
    );
  });
});
