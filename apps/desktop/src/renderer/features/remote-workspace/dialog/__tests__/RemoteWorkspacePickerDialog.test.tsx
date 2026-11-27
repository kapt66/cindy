// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：真实渲染 `RemoteWorkspacePickerDialog`（侧栏 / 草稿页共用入口），
 *   通过 `window.electronAPI.psbRemote` 注入 PSB 桥，并挂**真实的** `ConfirmDialogProvider`
 *   （占用确认复用现有确认弹窗能力，不是测试替身），断言用户能看到的结果：
 *   **无人占用行点击先弹占用确认**、取消不占用不选中、确认后只 `occupy` 一次并交接
 *   **已占用载荷**（主按钮不再第二次占用）、**mine 行直接选中且不弹确认**、他人占用 / 离线行
 *   原生 disabled 点击无效、不出现任何引擎选择控件、占用失败不回调、VCS 通知抑制通用错误。
 * - 2026-11-27 用户复测新增的归还语义：
 *   ① **选中后切换 / 关闭弹窗 → 已占用但未交接的工作区归还一次**（占用无 TTL，不能留无名锁；
 *      报表幂等：重复清理只发一次 release）；
 *   ② **交接成功后不释放**（释放责任转到草稿 / 任务生命周期）；
 *   ③ 占用失败（409 / 超时）保持未选中 + 可行动错误（复用现状）；VCS 通知与通用错误互斥。
 * - Bug／规则依据：产品口径 2026-11-27（工作区列表按占用状态区分选择流程；无人占用先确认占用、
 *   别人占用不可选、mine 直接可选）+ 产品 §2.2（占用失败不留在草稿里）、§2.5（占用无 TTL、
 *   放弃选择必须归还）、§2.7（VCS 提示与失败提示不双显）。
 * - 现有覆盖缺口：弹窗是侧栏与草稿页（「新建」入口）共用的工作区选择入口；共享选择引擎的
 *   状态机在这里按弹窗容器入口逐条钉住，草稿页下拉在 `PsbWorkspacePicker.test.tsx` 各钉一次。
 * - 最小失败输入：无人占用行不确认就占用（用户没同意独占别人的工作区）；取消后仍占用 /
 *   仍选中；主按钮第二次 occupy（重复锁请求）；选出后换行 / 关窗不归还（锁永久留在用户名下）；
 *   交接后仍归还（把草稿正在用的工作区解锁）；mine 行还弹确认（多余且会二次占用）。
 * - tier：unit（jsdom + 内存 fake bridge，无网络/进程）。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import type { PsbOccupyWorkspaceResult } from '../../../../../shared/psb-remote-workspace';
import {
  createdWorkspaceResult,
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

const CONFIRM_TITLE_KEY = 'remoteWorkspace.dialog.confirmOccupy.title';
const CONFIRM_BODY_KEY = 'remoteWorkspace.dialog.confirmOccupy.body';
const CONFIRM_CONFIRM_KEY = 'remoteWorkspace.dialog.confirmOccupy.confirm';
const CONFIRM_CANCEL_KEY = 'remoteWorkspace.dialog.confirmOccupy.cancel';

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
    <ConfirmDialogProvider>
      <RemoteWorkspacePickerDialog
        open
        initialTab={overrides.initialTab}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />
    </ConfirmDialogProvider>,
  );
  return { onCreated, onOpenChange, ...utils };
}

/** 点「占用」确认按钮（真实 ConfirmDialogProvider 渲染出来的主按钮）。 */
async function acceptOccupyPrompt() {
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: CONFIRM_CONFIRM_KEY }));
}

function expectNoOccupyPrompt() {
  expect(screen.queryByRole('alertdialog')).toBeNull();
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
  it('无人占用的行点击先弹占用确认；取消则不占用、不选中', async () => {
    const workspace = makePsbWorkspace({});
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(async () => occupiedByMeResult(workspace)),
    });
    renderDialog();
    fireEvent.click(await screen.findByTestId('psb-workspace-row-workspace-1'));
    // 连点行不会叠第二个确认框。
    fireEvent.click(screen.getByTestId('psb-workspace-row-workspace-1'));
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);

    // 确认框复用全局 ConfirmDialog，文案走 remoteWorkspace.dialog.confirmOccupy.*。
    const prompt = await screen.findByRole('alertdialog');
    // 确认框标题带**实例名**（目录名，与行主标题同一口径），不是模板名。
    expect(within(prompt).getByText(`${CONFIRM_TITLE_KEY}#saga2_design`)).toBeTruthy();
    expect(within(prompt).getByText(CONFIRM_BODY_KEY)).toBeTruthy();
    expect(bridge.occupyWorkspace).not.toHaveBeenCalled();

    fireEvent.click(within(prompt).getByRole('button', { name: CONFIRM_CANCEL_KEY }));
    await waitFor(() => expectNoOccupyPrompt());
    expect(bridge.occupyWorkspace).not.toHaveBeenCalled();
    expect(screen.getByTestId('psb-workspace-row-workspace-1').getAttribute('data-selected')).toBeNull();
    // 没有已占用的选择 → 不能交接。
    expect((screen.getByTestId('psb-start-session') as HTMLButtonElement).disabled).toBe(true);
  });

  it('确认后只占用一次，主按钮直接交接已占用载荷（不再第二次占用）', async () => {
    const workspace = makePsbWorkspace({});
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(async () => occupiedByMeResult(workspace)),
    });
    const { onCreated, onOpenChange } = renderDialog();
    fireEvent.click(await screen.findByTestId('psb-workspace-row-workspace-1'));
    await acceptOccupyPrompt();

    await waitFor(() =>
      expect(screen.getByTestId('psb-workspace-row-workspace-1').getAttribute('data-selected')).toBe(
        'true',
      ),
    );
    expect(bridge.occupyWorkspace).toHaveBeenCalledTimes(1);
    expect(bridge.occupyWorkspace).toHaveBeenCalledWith({ workspaceId: 'workspace-1' });

    fireEvent.click(screen.getByTestId('psb-start-session'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      clientId: 'client-1',
      clientName: '设计机-01',
      workspaceTitle: 'SAGA2 设计',
      directoryName: 'saga2_design',
    });
    // 交接成功：不再第二次占用，也不归还（释放责任转给草稿 / 任务）。
    expect(bridge.occupyWorkspace).toHaveBeenCalledTimes(1);
    expect(bridge.releaseWorkspace).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('mine 行直接选中：不弹占用确认、不调用 occupy，可直接交接', async () => {
    const mine = makeOccupiedByMeWorkspace({});
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [mine] })),
    });
    const { onCreated } = renderDialog();
    const row = await screen.findByTestId('psb-workspace-row-workspace-1');
    fireEvent.click(row);

    expectNoOccupyPrompt();
    await waitFor(() => expect(row.getAttribute('data-selected')).toBe('true'));
    expect(bridge.occupyWorkspace).not.toHaveBeenCalled();
    // mine 行保留亮锁（徽标没说「是我持有」）。
    expect(row.querySelector('[title]')).toBeTruthy();

    fireEvent.click(screen.getByTestId('psb-start-session'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      clientId: 'client-1',
      clientName: '设计机-01',
      workspaceTitle: 'SAGA2 设计',
      directoryName: 'saga2_design',
    });
  });

  it('取消新行的确认时保持原有 mine 选择（原选择没有被归还）', async () => {
    const mine = makeOccupiedByMeWorkspace({ id: 'workspace-mine', title: '我的工作区' });
    const free = makePsbWorkspace({ id: 'workspace-free', title: '空闲工作区' });
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [mine, free] })),
    });
    const { onCreated } = renderDialog();
    const mineRow = await screen.findByTestId('psb-workspace-row-workspace-mine');
    fireEvent.click(mineRow);
    await waitFor(() => expect(mineRow.getAttribute('data-selected')).toBe('true'));

    // 换点空闲行 → 弹确认；取消后原 mine 选择仍在，且没有被 release。
    fireEvent.click(screen.getByTestId('psb-workspace-row-workspace-free'));
    const prompt = await screen.findByRole('alertdialog');
    fireEvent.click(within(prompt).getByRole('button', { name: CONFIRM_CANCEL_KEY }));
    await waitFor(() => expectNoOccupyPrompt());
    expect(mineRow.getAttribute('data-selected')).toBe('true');
    expect(bridge.occupyWorkspace).not.toHaveBeenCalled();
    expect(bridge.releaseWorkspace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('psb-start-session'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0]?.[0]).toMatchObject({ workspaceId: 'workspace-mine' });
  });

  it('他人占用 / 离线行原生 disabled：点击无效、不弹确认、不发占用', async () => {
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

    renderDialog();
    const otherRow = await screen.findByTestId('psb-workspace-row-workspace-other');
    const offlineRow = screen.getByTestId('psb-workspace-row-workspace-offline');
    expect((otherRow as HTMLButtonElement).disabled).toBe(true);
    expect((offlineRow as HTMLButtonElement).disabled).toBe(true);
    expect(otherRow.getAttribute('data-lock-state')).toBe('other');
    // 原因只进 tooltip（短标签是徽标），行内不再重复「徽标 + 长句 + 锁」。
    expect(otherRow.getAttribute('title')).toBe('remoteWorkspace.error.occupiedByOther#张三');
    expect(otherRow.textContent).toContain('remoteWorkspace.badge.occupied');
    expect(otherRow.textContent).not.toContain('remoteWorkspace.error.occupiedByOther');
    expect(otherRow.querySelector('[data-lock-state="other"]')).toBeNull();
    expect(offlineRow.textContent).toContain('remoteWorkspace.badge.offline');
    // 不可用行不进入键盘序列（Tab 跳过），也不是 roving tabindex 的停点。
    expect(otherRow.getAttribute('tabindex')).toBe('-1');
    expect(offlineRow.getAttribute('tabindex')).toBe('-1');

    fireEvent.click(otherRow);
    fireEvent.click(offlineRow);
    expectNoOccupyPrompt();
    expect(bridge.occupyWorkspace).not.toHaveBeenCalled();
  });

  it('确认占用成功后切换选择：已占用但未交接的工作区被归还一次', async () => {
    const first = makePsbWorkspace({ id: 'workspace-a', title: 'A' });
    const second = makePsbWorkspace({ id: 'workspace-b', title: 'B' });
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [first, second] })),
      occupyWorkspace: vi.fn(async () => occupiedByMeResult(first)),
    });
    renderDialog();
    fireEvent.click(await screen.findByTestId('psb-workspace-row-workspace-a'));
    await acceptOccupyPrompt();
    await waitFor(() =>
      expect(screen.getByTestId('psb-workspace-row-workspace-a').getAttribute('data-selected')).toBe(
        'true',
      ),
    );

    // 换到 B（无人占用）：A 已经不要了，先归还再弹 B 的确认框。
    fireEvent.click(screen.getByTestId('psb-workspace-row-workspace-b'));
    await screen.findByRole('alertdialog');
    await waitFor(() =>
      expect(bridge.releaseWorkspace).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-a' }),
    );
    expect(screen.getByTestId('psb-workspace-row-workspace-a').getAttribute('data-selected')).toBeNull();
    // 取消 B 的确认：只清 pending，不再发占用、不再发第二次 release（切换时已归还）。
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: CONFIRM_CANCEL_KEY }),
    );
    await waitFor(() => expectNoOccupyPrompt());
    expect(bridge.occupyWorkspace).toHaveBeenCalledTimes(1);
    expect(bridge.releaseWorkspace).toHaveBeenCalledTimes(1);
  });

  it('关闭弹窗归还未交接的占用，且只归还一次', async () => {
    const workspace = makePsbWorkspace({});
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(async () => occupiedByMeResult(workspace)),
    });
    const { onCreated, onOpenChange } = renderDialog();
    fireEvent.click(await screen.findByTestId('psb-workspace-row-workspace-1'));
    await acceptOccupyPrompt();
    await waitFor(() =>
      expect(screen.getByTestId('psb-workspace-row-workspace-1').getAttribute('data-selected')).toBe(
        'true',
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'remoteWorkspace.dialog.cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() =>
      expect(bridge.releaseWorkspace).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-1' }),
    );
    expect(bridge.releaseWorkspace).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('交接成功后关闭不再归还未交接占用（释放责任已转给草稿 / 任务）', async () => {
    const workspace = makePsbWorkspace({});
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(async () => occupiedByMeResult(workspace)),
    });
    const { onCreated } = renderDialog();
    fireEvent.click(await screen.findByTestId('psb-workspace-row-workspace-1'));
    await acceptOccupyPrompt();
    await waitFor(() =>
      expect(screen.getByTestId('psb-workspace-row-workspace-1').getAttribute('data-selected')).toBe(
        'true',
      ),
    );
    fireEvent.click(screen.getByTestId('psb-start-session'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    // 弹窗关闭路径（交接成功后自己也走一次 cancel）不得归还。
    fireEvent.click(screen.getByRole('button', { name: 'remoteWorkspace.dialog.cancel' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.releaseWorkspace).not.toHaveBeenCalled();
  });

  it('新建工作区成功后列表出现该工作区并被选中（provisioning 不弹占用确认）', async () => {
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
    // 刚建出的工作区还在 provisioning：行显示「准备中」，此时不能占用 / 交接。
    expect(createdRow.textContent).toContain('remoteWorkspace.badge.pending');
    expectNoOccupyPrompt();
    expect((screen.getByTestId('psb-start-session') as HTMLButtonElement).disabled).toBe(true);
  });

  it('labels workspace rows with the directory name, keeping template · machine as secondary text', async () => {
    installPsbBridge({
      listWorkspaces: vi.fn(async () => ({
        workspaces: [
          // 用户实机形状：`title` 与模板名同词（`saga2_project`），目录名才是这个实例自己的名字。
          makePsbWorkspace({
            id: '9c747178aabbccdd',
            title: 'saga2_project',
            templateTitle: 'saga2_project',
            directoryName: 'saga2_project-3',
            clientName: '打包机',
          }),
          // 旧数据没有目录名：主标题回退标题，模板名仍在次要行。
          makePsbWorkspace({
            id: 'aa11bb22cc33',
            title: '我的项目',
            templateTitle: 'SAGA2 设计',
            directoryName: null,
            clientName: '打包机',
          }),
        ],
      })),
    });
    renderDialog();
    const row = await screen.findByTestId('psb-workspace-row-9c747178aabbccdd');
    // 主标题 = 工作区目录名（`title` 属性仍是完整 id，悬停可取）；模板名只进次要行。
    expect(row.querySelector('[title="9c747178aabbccdd"]')?.textContent).toBe('saga2_project-3');
    expect(row.querySelector('[title="saga2_project · 打包机"]')?.textContent).toBe(
      'saga2_project · 打包机',
    );
    // 目录名已是主标题：不再渲染「目录：<同一个目录名>」（旧 i18n 前缀在本口径下退休）。
    expect(row.textContent).not.toContain('remoteWorkspace.dialog.directorySecondary');
    expect(row.textContent).not.toContain('目录：');
    const legacy = screen.getByTestId('psb-workspace-row-aa11bb22cc33');
    expect(legacy.querySelector('[title="aa11bb22cc33"]')?.textContent).toBe('我的项目');
    expect(legacy.querySelector('[title="SAGA2 设计 · 打包机"]')?.textContent).toBe(
      'SAGA2 设计 · 打包机',
    );
  });

  it('opens directly on the create tab when the draft-page channel entry asks for it', async () => {
    installPsbBridge();
    renderDialog({ initialTab: 'create' });
    // 渠道内「新建远程工作区」必须直接落在新建表单，而不是让用户再点一次页签。
    expect(await screen.findByTestId('psb-workspace-create-form')).toBeTruthy();
    expect(screen.queryByTestId('psb-workspace-list')).toBeNull();
  });

  it('占用被他人抢走时不回调、不关闭、保持未选中，并显示占用人姓名', async () => {
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
    await acceptOccupyPrompt();

    await waitFor(() => expect(bridge.occupyWorkspace).toHaveBeenCalledTimes(1));
    expect(bridge.createSession).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByTestId('psb-workspace-row-workspace-1').getAttribute('data-selected')).toBeNull();
    // 错误可行动：文案带占用人名（i18n key#name），而不是一句「操作失败」。
    expect(
      (await screen.findAllByText('remoteWorkspace.error.occupiedByOther#张三')).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('remoteWorkspace.error.unknown')).toBeNull();
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
    await acceptOccupyPrompt();
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
    expect(screen.getByTestId('psb-workspace-row-workspace-1').getAttribute('data-selected')).toBeNull();
  });

  it('连续点击确认只发起一次占用，交接只回调一次', async () => {
    const workspace = makePsbWorkspace({});
    const pending = deferred<PsbOccupyWorkspaceResult>();
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(() => pending.promise),
    });
    const { onCreated } = renderDialog();
    fireEvent.click(await screen.findByTestId('psb-workspace-row-workspace-1'));
    const prompt = await screen.findByRole('alertdialog');
    const accept = within(prompt).getByRole('button', { name: CONFIRM_CONFIRM_KEY });
    fireEvent.click(accept);
    fireEvent.click(accept);
    // 占用在途：行显示 spinner 且带「占用中」tooltip，主按钮进入忙态。
    const row = screen.getByTestId('psb-workspace-row-workspace-1');
    await waitFor(() => expect(row.getAttribute('aria-busy')).toBe('true'));
    expect(row.getAttribute('title')).toBe('remoteWorkspace.dialog.confirmOccupy.occupying');
    expect(bridge.occupyWorkspace).toHaveBeenCalledTimes(1);
    pending.resolve(occupiedByMeResult(workspace));
    await waitFor(() => expect(row.getAttribute('data-selected')).toBe('true'));
    fireEvent.click(screen.getByTestId('psb-start-session'));
    fireEvent.click(screen.getByTestId('psb-start-session'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(bridge.createSession).not.toHaveBeenCalled();
  });

  it('忙时 Cancel 可退出，迟到的占用成功会被释放（不留无名锁）', async () => {
    const workspace = makePsbWorkspace({});
    const pending = deferred<PsbOccupyWorkspaceResult>();
    const bridge = installPsbBridge({
      listWorkspaces: vi.fn(async () => ({ workspaces: [workspace] })),
      occupyWorkspace: vi.fn(() => pending.promise),
    });
    const { onCreated, onOpenChange } = renderDialog();
    fireEvent.click(await screen.findByTestId('psb-workspace-row-workspace-1'));
    await acceptOccupyPrompt();
    await waitFor(() => expect(bridge.occupyWorkspace).toHaveBeenCalledTimes(1));
    // 在途时焦点仍在主按钮上（aria-disabled + loading，而不是 disabled 把焦点甩回 body）。
    const start = screen.getByTestId('psb-start-session');
    await waitFor(() => expect(start.getAttribute('aria-busy')).toBe('true'));
    expect((start as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'remoteWorkspace.dialog.cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // 取消之后占用才成功：必须还回去，并且不回调父级。
    pending.resolve(occupiedByMeResult(workspace));
    await waitFor(() =>
      expect(bridge.releaseWorkspace).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-1' }),
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
    const prompt = await screen.findByRole('alertdialog');
    vi.useFakeTimers();
    fireEvent.click(within(prompt).getByRole('button', { name: CONFIRM_CONFIRM_KEY }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(bridge.occupyWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PSB_OCCUPY_TIMEOUT_MS + 1);
    });
    expect(screen.getByText('remoteWorkspace.error.unreachable')).toBeTruthy();
    expect(screen.getByTestId('psb-workspace-row-workspace-1').getAttribute('data-selected')).toBeNull();
    pending.resolve(occupiedByMeResult(workspace));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(bridge.releaseWorkspace).toHaveBeenCalledWith({ workspaceId: 'workspace-1' });
  });

  it('listbox 方向键只移动焦点：不占用、不弹确认、不改变选中', async () => {
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
    // listbox 惯例：方向键只移动焦点；激活（Enter/Space）才确认 + 占用。
    await waitFor(() => expect(rowB.getAttribute('tabindex')).toBe('0'));
    expect(document.activeElement).toBe(rowB);
    expect(rowA.getAttribute('aria-selected')).toBe('false');
    expect(rowB.getAttribute('aria-selected')).toBe('false');
    expectNoOccupyPrompt();
    expect(rowB.getAttribute('data-selected')).toBeNull();
  });
});
