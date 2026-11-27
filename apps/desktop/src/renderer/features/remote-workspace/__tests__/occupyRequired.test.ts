// @vitest-environment jsdom
/**
 * 「这个工作区还没被你占用」→ 用户确认后显式占用（`features/remote-workspace/occupyRequired.ts`）。
 *
 * 测试价值
 * - 生产入口与可观察结果：`confirmAndOccupyPsbWorkspace` / `requestPsbOccupyConfirmationFor*`
 *   是发送、启动串流、懒建会话三条隐式入口共用的唯一「确认 + 占用」实现。用户可观察结果：
 *   空闲工作区**不会**被默认占用；确认后才发一次显式占用；取消不占用；占用失败不重试。
 * - Bug／规则依据：2026-11-27 用户人工复测「所有工作区占用都必须由用户通过弹窗确认，禁止任何
 *   默认/自动占用」。main 的占用闸门返回 `PSB_WORKSPACE_NOT_OCCUPIED`（与 PSB 2026-11-27 守卫
 *   契约 `403 WORKSPACE_NOT_OCCUPIED` 同码同形）。
 * - 现有覆盖缺口：旧实现根本不存在这条确认路径（main 直接自动占用），所以没有任何渲染层用例
 *   钉「取消 = 0 次 occupy 请求」「确认 = 1 次 occupy」「没有宿主时不假装成功」。
 * - 最小失败输入：① `[PSB_WORKSPACE_NOT_OCCUPIED]` 的 Electron 包装错误；② 宿主未注册；
 *   ③ occupyWorkspace 被抢（reject）；④ adminContext 只有占位身份（workspaceIdKnown:false）。
 * - tier：unit（jsdom，无真实 PSB / Electron）。
 */

import { afterEach, expect, it, vi } from 'vitest';

import i18n from '@/i18n';

import {
  PSB_OCCUPY_CONFIRM_KEYS,
  PSB_OCCUPY_REQUIRED_IPC_CODE,
  confirmAndOccupyPsbWorkspace,
  confirmAndOccupyPsbWorkspaceDetailed,
  isPsbOccupyRequiredFailure,
  registerPsbOccupyConfirmationResolver,
  registerPsbOccupyWorkspaceConfirmationResolver,
  requestPsbOccupyConfirmationForSession,
  requestPsbOccupyConfirmationForWorkspace,
  resolvePsbWorkspaceForOccupyConfirmation,
} from '../occupyRequired';
import { psbFailureMessageKeyForIpcCode } from '../../../../shared/psb-remote-workspace';
import { psbFailureText } from '../psbFailureText';

const t = i18n.t.bind(i18n);

afterEach(() => {
  // 注册表是模块级单例：每个用例结束时注销，避免用例之间串味。
  registerPsbOccupyConfirmationResolver(async () => false)();
  registerPsbOccupyWorkspaceConfirmationResolver(async () => ({ status: 'declined' }))();
});

it('码名与共享单表一致：渲染层按码名识别，文案键由单表给出', () => {
  // 字面量与本文件的常量必须与单表键同名（改名时这里先红，避免渲染层静默失配）。
  expect(PSB_OCCUPY_REQUIRED_IPC_CODE).toBe('PSB_WORKSPACE_NOT_OCCUPIED');
  expect(psbFailureMessageKeyForIpcCode(PSB_OCCUPY_REQUIRED_IPC_CODE)).toBe(
    'remoteWorkspace.error.occupyRequired',
  );
  // 与 PSB 守卫契约同码同形：失败条正文是「需要先占用」，不是通用失败。
  expect(
    psbFailureText(t, new Error('[PSB_WORKSPACE_NOT_OCCUPIED] 这个工作区还没有被占用')),
  ).toBe(i18n.t('remoteWorkspace.error.occupyRequired'));
});

it('识别 Electron 包装 / 裸码 / 直接码三种形态，其它 PSB 失败不算', () => {
  expect(
    isPsbOccupyRequiredFailure(
      new Error(
        "Error invoking remote method 'maker:input:enqueue': Error: [PSB_WORKSPACE_NOT_OCCUPIED] 空闲",
      ),
    ),
  ).toBe(true);
  expect(isPsbOccupyRequiredFailure(new Error('[PSB_WORKSPACE_NOT_OCCUPIED]'))).toBe(true);
  expect(
    isPsbOccupyRequiredFailure(Object.assign(new Error('空闲'), { code: 'PSB_WORKSPACE_NOT_OCCUPIED' })),
  ).toBe(true);
  expect(isPsbOccupyRequiredFailure(new Error('[PSB_WORKSPACE_OCCUPIED_BY_OTHER] 张三'))).toBe(false);
  expect(isPsbOccupyRequiredFailure(new Error('boom'))).toBe(false);
  expect(isPsbOccupyRequiredFailure(null)).toBe(false);
});

it('确认框文案复用 confirmOccupy 五键：标题带工作区名，正文说明占用期间他人不可用', async () => {
  const confirm = vi.fn(async (_options: Record<string, unknown>) => false);
  const outcome = await confirmAndOccupyPsbWorkspace({
    t,
    confirm,
    bridge: { occupyWorkspace: vi.fn() },
    workspaceId: 'ws-a',
    workspaceName: 'saga2_project',
  });

  expect(outcome).toBe('declined');
  expect(confirm).toHaveBeenCalledOnce();
  expect(confirm.mock.calls[0][0]).toMatchObject({
    title: i18n.t(PSB_OCCUPY_CONFIRM_KEYS.title, { name: 'saga2_project' }),
    description: i18n.t(PSB_OCCUPY_CONFIRM_KEYS.body),
    confirmText: i18n.t(PSB_OCCUPY_CONFIRM_KEYS.confirm),
    cancelText: i18n.t(PSB_OCCUPY_CONFIRM_KEYS.cancel),
  });
});

it('取消 → 不占用（0 次 occupy）；确认 → 恰好占用一次；占用被抢 → failed', async () => {
  const occupyWorkspace = vi.fn(async () => ({ workspace: {} }));
  const declined = await confirmAndOccupyPsbWorkspace({
    t,
    confirm: async () => false,
    bridge: { occupyWorkspace },
    workspaceId: 'ws-a',
    workspaceName: 'saga2_project',
  });
  expect(declined).toBe('declined');
  expect(occupyWorkspace).not.toHaveBeenCalled();

  const occupied = await confirmAndOccupyPsbWorkspace({
    t,
    confirm: async () => true,
    bridge: { occupyWorkspace },
    workspaceId: 'ws-a',
    workspaceName: 'saga2_project',
  });
  expect(occupied).toBe('occupied');
  expect(occupyWorkspace).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'ws-a' });

  const failed = await confirmAndOccupyPsbWorkspace({
    t,
    confirm: async () => true,
    bridge: {
      occupyWorkspace: async () => {
        throw new Error('[PSB_WORKSPACE_OCCUPIED_BY_OTHER] 李四');
      },
    },
    workspaceId: 'ws-a',
    workspaceName: 'saga2_project',
  });
  expect(failed).toBe('failed');
});

it('没有桥 / 空 workspaceId → failed（不假装占用成功，调用方不会重试一次必然失败的写入）', async () => {
  const confirm = vi.fn(async () => true);
  expect(
    await confirmAndOccupyPsbWorkspace({ t, confirm, bridge: null, workspaceId: 'ws-a', workspaceName: '' }),
  ).toBe('failed');
  expect(confirm).not.toHaveBeenCalled();
  expect(
    await confirmAndOccupyPsbWorkspace({
      t,
      confirm,
      bridge: { occupyWorkspace: vi.fn() },
      workspaceId: ' ',
      workspaceName: '',
    }),
  ).toBe('failed');
});

it('注册式：没有宿主时不假装成功；注册后按 sessionId / 工作区询问用户', async () => {
  expect(await requestPsbOccupyConfirmationForSession('s1')).toBe(false);
  expect(
    await requestPsbOccupyConfirmationForWorkspace({ workspaceId: 'ws-a', workspaceName: '' }),
  ).toBeNull();

  const forSession = vi.fn(async () => true);
  const forWorkspace = vi.fn(async () => ({ status: 'declined' }) as const);
  const unregisterSession = registerPsbOccupyConfirmationResolver(forSession);
  const unregisterWorkspace = registerPsbOccupyWorkspaceConfirmationResolver(forWorkspace);

  expect(await requestPsbOccupyConfirmationForSession('s1')).toBe(true);
  expect(forSession).toHaveBeenCalledWith('s1');
  expect(
    await requestPsbOccupyConfirmationForWorkspace({ workspaceId: 'ws-a', workspaceName: 'x' }),
  ).toEqual({ status: 'declined' });
  expect(forWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-a', workspaceName: 'x' });

  unregisterSession();
  unregisterWorkspace();
  expect(await requestPsbOccupyConfirmationForSession('s1')).toBe(false);
  expect(
    await requestPsbOccupyConfirmationForWorkspace({ workspaceId: 'ws-a', workspaceName: '' }),
  ).toBeNull();
});

it('详细结果区分取消与占用失败（发送前预检据此静默 / 给可行动提示）', async () => {
  // 取消：既不占用，也不带「失败原因」。
  const declined = await confirmAndOccupyPsbWorkspaceDetailed({
    t,
    confirm: async () => false,
    bridge: { occupyWorkspace: vi.fn() },
    workspaceId: 'ws-a',
    workspaceName: 'saga2_project',
  });
  expect(declined).toEqual({ status: 'declined' });

  // 占用被抢：保留原始失败（调用方按既有 PSB 文案表展示占用人名）。
  const occupiedError = new Error('[PSB_WORKSPACE_OCCUPIED_BY_OTHER] 李四');
  const failed = await confirmAndOccupyPsbWorkspaceDetailed({
    t,
    confirm: async () => true,
    bridge: {
      occupyWorkspace: async () => {
        throw occupiedError;
      },
    },
    workspaceId: 'ws-a',
    workspaceName: 'saga2_project',
  });
  expect(failed).toEqual({ status: 'failed', error: occupiedError });

  // 没有桥同样是不带原因（拿不到失败对象）的失败，不假装成功。
  expect(
    await confirmAndOccupyPsbWorkspaceDetailed({
      t,
      confirm: async () => true,
      bridge: null,
      workspaceId: 'ws-a',
      workspaceName: '',
    }),
  ).toEqual({ status: 'failed', error: null });
});

it('发送路径解析工作区：只用 adminContext 的实时事实；占位身份 / 读取失败 → null', async () => {
  const bridge = (context: unknown) => ({
    adminContext: vi.fn(async () => ({ context })),
  });

  expect(
    await resolvePsbWorkspaceForOccupyConfirmation(
      bridge({ workspaceId: 'ws-a', title: 'saga2_project', workspaceIdKnown: true }),
      'local-1',
    ),
  ).toEqual({ workspaceId: 'ws-a', workspaceName: 'saga2_project' });

  // 占位身份（psb:<sessionId>）不能拿去占用：只会得到一条不可行动失败。
  expect(
    await resolvePsbWorkspaceForOccupyConfirmation(
      bridge({ workspaceId: 'psb:1', title: '', workspaceIdKnown: false }),
      'local-1',
    ),
  ).toBeNull();
  expect(await resolvePsbWorkspaceForOccupyConfirmation(bridge(null), 'local-1')).toBeNull();
  expect(await resolvePsbWorkspaceForOccupyConfirmation(bridge({}), null)).toBeNull();
});
