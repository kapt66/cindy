// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：`PsbPendingReleaseNotice` 是「PSB 待释放占用」的**唯一常驻提示入口**
 *   （App 主窗挂一次）。它把 main 账本（会话结束释放失败）与渲染层工作区级账本（picker
 *   放弃草稿 / 在途取消失败）合并成一条非阻塞提示，给「重试 / 关闭」。
 * - Bug／规则依据（本轮 s8 P1 + s6 P1）：两本账本此前都只 `log.warn`、渲染层 0 调用方，
 *   用户不知道远端协作锁可能还在自己名下（PSB 占用无 TTL，产品 §2.5 / §2.7 / §8 要求
 *   非阻塞提示 + 显式重试入口）。i18n 的两条 PSB 键（`releasePending` / `releaseRetained`）
 *   在同批获得调用方。
 * - 本轮终局复审 P1（2026-11-27）：①main 账本 DTO 已带 `workspaceId`，旧实现仍按来源前缀
 *   造 id、不跨源去重 → 同一工作区两本账并存时计数虚高 / 原因行重复 / 重试双打；②main 账本
 *   `failureCode` 是 PSB 原始码（`AUTH_INVALID` / `CLIENT_OFFLINE` / `HTTP_5xx` /
 *   `PSB_PROTOCOL`），原样交给 `psbFailureText`（只认 IPC 码）会让已知失败落成 PSB 原文 /
 *   通用文案。用例用**真实 main 账本形状**（原始 PSB 码、带/不带 workspaceId）覆盖生产路径。
 * - 现有覆盖缺口：此前没有「跨源同 workspaceId 只显示一条（main 优先）」「重试只打一次」
 *   「main 原始 PSB 码 → 本地化文案」「未知码回退 PSB 原文」「main 内同工作区留最近失败」。
 * - 最小失败输入：同一 workspaceId 在两本账各一条时计数为 2、点重试对同一工作区发两次
 *   `releaseWorkspace`；`failureCode:'AUTH_INVALID'` 时显示 PSB 原文而不是「登录已过期」。
 * - tier：unit（jsdom + 内存 fake bridge，无真实 PSB / Electron；不自动重试写操作用行为断言，
 *   不引入真实等待）。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing,
  listPendingWorkspaceReleasesFromMain,
} from '@/features/cc-agent/psbOccupancyRelease';
import {
  listPsbPendingReleases,
  recordPsbPendingRelease,
  resetPsbPendingReleasesForTest,
} from '../../draft/psbPendingReleaseLedger';
import { PsbPendingReleaseNotice } from '../PsbPendingReleaseNotice';
import { resetPendingReleaseNoticeStoreForTest } from '../pendingReleaseNoticeStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 断言落在「用哪个 key / 原文」上，不复制任何语言的文案。`defaultValue` 用于
    // `psbFailureText` 的 ipcError 兜底查询（空串 = 没找到，继续走 PSB 原文）。
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

/** 一条 main 账本记录（与共享契约 `PsbPendingWorkspaceReleaseInfo` 同形）。 */
function mainRelease(overrides: Partial<{
  readonly key: string;
  readonly psbSessionId: string;
  readonly remoteHostId: string;
  readonly workspaceId: string | null;
  readonly reason: 'session-archived' | 'session-deleted' | 'session-stopped' | 'app-quit';
  readonly attempt: number;
  readonly lastError: string;
  readonly failureCode: string | null;
  readonly updatedAt: number;
}> = {}) {
  return {
    key: 's-1\u0000session-archived',
    psbSessionId: 'psb-1',
    remoteHostId: 'psb:psb-1',
    workspaceId: 'ws-main-1',
    reason: 'session-archived' as const,
    attempt: 2,
    lastError: 'PSB client offline',
    // 生产形状：main 账本记的是 PSB **原始码**（不是跨 IPC 的 `PSB_*` IPC 码）。
    failureCode: 'CLIENT_OFFLINE',
    updatedAt: 2,
    ...overrides,
  };
}

/** 工作区级账本的失败事实（`readPsbFailure` 认得的结构化形状）。 */
function workspaceFailure(message = 'boom') {
  return {
    code: 'PSB_UNREACHABLE',
    messageKey: 'remoteWorkspace.error.unreachable',
    message,
  };
}

type PendingPushEvent = { releases: readonly unknown[] };

function installBridge() {
  const pushHandlers = new Set<(event: PendingPushEvent) => void>();
  const bridge = {
    pendingWorkspaceReleases: vi.fn(async () => ({ releases: [] as readonly unknown[] })),
    retryPendingWorkspaceReleases: vi.fn(async () => ({
      attempted: 0,
      released: 0,
      failed: 0,
      releases: [] as readonly unknown[],
    })),
    onPendingWorkspaceReleasesChanged: vi.fn((handler: (event: PendingPushEvent) => void) => {
      pushHandlers.add(handler);
      return () => {
        pushHandlers.delete(handler);
      };
    }),
    releaseWorkspace: vi.fn(async () => ({ workspace: {} })),
  };
  (window as unknown as { electronAPI?: { psbRemote?: unknown } }).electronAPI = { psbRemote: bridge };
  return {
    bridge,
    push: (releases: readonly unknown[]): void => {
      for (const handler of [...pushHandlers]) handler({ releases });
    },
  };
}

/** 等挂载 effect 里的「读一次 main 账本」落地，避免它把随后 push 的快照覆盖成空。 */
async function flushPendingReads(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** 原因行（不含最后的「+N」折叠行）。 */
function reasonRows(): HTMLLIElement[] {
  return [...screen.getByTestId('psb-pending-release-reasons').querySelectorAll('li')]
    .filter((row) => row.getAttribute('data-testid') !== 'psb-pending-release-more') as HTMLLIElement[];
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  __testing.reset();
  __testing.setBridge(null);
  resetPsbPendingReleasesForTest();
  resetPendingReleaseNoticeStoreForTest();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  window.history.replaceState({}, '', '/');
});

describe('PsbPendingReleaseNotice', () => {
  it('合并两本账本：显示条数 / 右下位置 / 可读原因，且同一工作区只出现一条（main 优先）', async () => {
    const { bridge, push } = installBridge();
    render(<PsbPendingReleaseNotice />);
    await flushPendingReads();
    expect(screen.queryByTestId('psb-pending-release-notice-host')).toBeNull();

    // 工作区级账本：同一 workspaceId 记两次 → 只保留一条（attempts 累加，但 UI 只显示一次）。
    await act(async () => {
      recordPsbPendingRelease('ws-9', workspaceFailure('boom'));
      recordPsbPendingRelease('ws-9', workspaceFailure('boom again'));
      recordPsbPendingRelease('ws-10', workspaceFailure('also busy'));
    });
    expect(listPsbPendingReleases()).toHaveLength(2);

    await act(async () => {
      push([
        mainRelease(),
        mainRelease({
          key: 's-2\u0000app-quit',
          psbSessionId: 'psb-2',
          remoteHostId: 'psb:psb-2',
          workspaceId: 'ws-main-2',
          reason: 'app-quit',
          attempt: 1,
          lastError: '远端暂时读不到会话',
          failureCode: null,
          updatedAt: 1,
        }),
      ]);
    });

    const host = screen.getByTestId('psb-pending-release-notice-host');
    // 非阻塞悬浮在右下角，不占布局、不遮断输入。
    expect(host.getAttribute('data-placement')).toBe('bottom-right');
    expect(host.className).toContain('pointer-events-none');
    expect(host.className).toContain('fixed');

    // 4 = 2 条 main + 2 条工作区级（同一 workspaceId 的重复记录被去重，所以不是 5）。
    expect(screen.getByTestId('psb-pending-release-count').textContent).toBe('4');
    expect(screen.getByTestId('psb-pending-release-message').textContent).toBe(
      'remoteWorkspace.draft.releasePending',
    );
    expect(screen.getByTestId('psb-pending-release-notice').getAttribute('data-retained')).toBe('false');

    const rows = [...screen.getByTestId('psb-pending-release-reasons').querySelectorAll('li')];
    // 原因行最多 3 条 + `+N` 表达折叠数量；计数徽标仍是完整条数。
    expect(rows).toHaveLength(4);
    expect(rows[0]?.getAttribute('data-source')).toBe('main');
    expect(rows[0]?.getAttribute('data-identity')).toBe('psb-1');
    expect(rows[0]?.getAttribute('data-workspace-id')).toBe('ws-main-1');
    // 已知 PSB 原始码（main 账本的生产形状）归一后出本地化文案；PSB 原文作为诊断行仍可见。
    expect(rows[0]?.textContent).toContain('remoteWorkspace.error.clientOffline');
    expect(rows[0]?.textContent).toContain('PSB client offline');
    // 没有码时落通用正文，但原文（可读原因）照实显示，不只留一行日志。
    expect(rows[1]?.textContent).toContain('remoteWorkspace.error.unknown');
    expect(rows[1]?.textContent).toContain('远端暂时读不到会话');
    // 工作区级账本最近一条在前：ws-10 是后记的（ws-9 的重复记录已被去重）。
    expect(rows[2]?.getAttribute('data-source')).toBe('workspace');
    expect(rows[2]?.getAttribute('data-identity')).toBe('ws-10');
    expect(rows[2]?.textContent).toContain('remoteWorkspace.error.unreachable');
    expect(rows[2]?.textContent).toContain('also busy');
    expect(rows[3]?.getAttribute('data-testid')).toBe('psb-pending-release-more');
    expect(rows[3]?.textContent).toBe('+1');

    // 只读展示：挂载 / 推送不偷偷重试写操作（工程契约 §3.2）。
    expect(bridge.retryPendingWorkspaceReleases).not.toHaveBeenCalled();
    expect(bridge.releaseWorkspace).not.toHaveBeenCalled();
  });

  it('跨源同 workspaceId 合并去重：main 条目优先，重试只打一次（不双打同一把锁）', async () => {
    const shared = mainRelease({ workspaceId: 'ws-shared' });
    const { bridge, push } = installBridge();
    // main 这次重试成功（工作区锁已归还）：main 账本清空。
    bridge.retryPendingWorkspaceReleases.mockResolvedValue({
      attempted: 1,
      released: 1,
      failed: 0,
      releases: [],
    });
    render(<PsbPendingReleaseNotice />);
    await flushPendingReads();
    await act(async () => {
      // 同一工作区两本账各一条（picker 放弃草稿失败 + 会话结束释放失败），另有一条独立工作区。
      recordPsbPendingRelease('ws-shared', workspaceFailure('picker release failed'));
      recordPsbPendingRelease('ws-other', workspaceFailure('boom'));
    });
    await act(async () => {
      push([shared]);
    });

    // 同一把锁只展示一条：main 条目优先（identity 是 PSB 会话 id，不是 workspaceId 重复行）。
    expect(screen.getByTestId('psb-pending-release-count').textContent).toBe('2');
    const rows = reasonRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('data-source')).toBe('main');
    expect(rows[0]?.getAttribute('data-workspace-id')).toBe('ws-shared');
    expect(rows[1]?.getAttribute('data-identity')).toBe('ws-other');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'commonUi.retry' }));
    });
    await waitFor(() =>
      expect(screen.queryByTestId('psb-pending-release-notice-host')).toBeNull(),
    );
    // 同一工作区只由 main 那次重试代表：`releaseWorkspace` 只打 ws-other，不再重复释放 ws-shared；
    // 工作区级条目里的 ws-shared 陈旧副本已出账（否则 main 成功后提示条还会残留一条）。
    expect(bridge.releaseWorkspace).toHaveBeenCalledTimes(1);
    expect(bridge.releaseWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-other' });
    expect(bridge.releaseWorkspace).not.toHaveBeenCalledWith({ workspaceId: 'ws-shared' });
    expect(listPsbPendingReleases()).toHaveLength(0);
    expect(listPendingWorkspaceReleasesFromMain()).toHaveLength(0);
  });

  it('main 账本的原始 PSB 码归一成本地化文案；归一不了的码回退 PSB 原文', async () => {
    const { push } = installBridge();
    render(<PsbPendingReleaseNotice />);
    await flushPendingReads();
    await act(async () => {
      push([
        // 鉴权类：PSB 原始码 `AUTH_INVALID`（不是 IPC 码 `PSB_AUTH_EXPIRED`）。
        mainRelease({
          key: 's-auth\u0000session-archived',
          psbSessionId: 'psb-auth',
          workspaceId: 'ws-auth',
          lastError: '[AUTH_INVALID] token expired',
          failureCode: 'AUTH_INVALID',
          updatedAt: 3,
        }),
        // 未知码（服务端 5xx 兜底码）：归一不了 → 可读 PSB 原文兜底，不落通用文案。
        mainRelease({
          key: 's-http\u0000session-archived',
          psbSessionId: 'psb-http',
          workspaceId: 'ws-http',
          lastError: 'Bad gateway from PSB',
          failureCode: 'HTTP_502',
          updatedAt: 2,
        }),
        // 本地诊断码：同样没有本地化文案，原文照实显示。
        mainRelease({
          key: 's-proto\u0000session-archived',
          psbSessionId: 'psb-proto',
          workspaceId: 'ws-proto',
          lastError: 'malformed PSB response',
          failureCode: 'PSB_PROTOCOL',
          updatedAt: 1,
        }),
      ]);
    });

    const rows = reasonRows();
    expect(rows).toHaveLength(3);
    // 已知原始码 → 共享单表文案键；PSB 原文只作诊断行（[CODE] 机器前缀已剥掉）。
    expect(rows[0]?.textContent).toContain('remoteWorkspace.error.authExpired');
    expect(rows[0]?.textContent).toContain('token expired');
    // 归一不了的码 → 可读 PSB 原文当正文（比通用文案可行动），不再重复一条诊断行。
    expect(rows[1]?.textContent).toContain('Bad gateway from PSB');
    expect(rows[1]?.textContent).not.toContain('remoteWorkspace.error.unknown');
    expect(rows[2]?.textContent).toContain('malformed PSB response');
    expect(rows[2]?.textContent).not.toContain('remoteWorkspace.error.unknown');
  });

  it('main 内同一 workspaceId 只留最近一次失败（锁只有一把，原因行显示当前错误）', async () => {
    const { push } = installBridge();
    render(<PsbPendingReleaseNotice />);
    await flushPendingReads();
    await act(async () => {
      push([
        // 两个本地任务落在同一工作区、各自释放失败：同一条锁，不代表两条待释放义务。
        mainRelease({
          key: 's-old\u0000session-archived',
          psbSessionId: 'psb-old',
          workspaceId: 'ws-shared',
          attempt: 1,
          lastError: 'stale failure',
          failureCode: 'AUTH_INVALID',
          updatedAt: 1,
        }),
        mainRelease({
          key: 's-new\u0000session-archived',
          psbSessionId: 'psb-new',
          workspaceId: 'ws-shared',
          attempt: 2,
          lastError: 'PSB client offline',
          failureCode: 'CLIENT_OFFLINE',
          updatedAt: 5,
        }),
      ]);
    });

    expect(screen.getByTestId('psb-pending-release-count').textContent).toBe('1');
    const rows = reasonRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('data-identity')).toBe('psb-new');
    expect(rows[0]?.textContent).toContain('remoteWorkspace.error.clientOffline');
    expect(rows[0]?.textContent).not.toContain('remoteWorkspace.error.authExpired');
  });

  it('点「重试」：单一入口同时重试两本账 → 清空后提示条自动消失', async () => {
    const { bridge, push } = installBridge();
    bridge.retryPendingWorkspaceReleases.mockResolvedValue({
      attempted: 1,
      released: 1,
      failed: 0,
      releases: [],
    });
    render(<PsbPendingReleaseNotice />);
    await flushPendingReads();
    await act(async () => {
      recordPsbPendingRelease('ws-1', workspaceFailure());
    });
    await act(async () => {
      push([mainRelease({ workspaceId: 'ws-main-1' })]);
    });

    // 只有一个重试按钮（main / 工作区级共用同一入口，不摆两套按钮）。
    expect(screen.getAllByRole('button', { name: 'commonUi.retry' })).toHaveLength(1);
    expect(screen.getAllByRole('button')).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'commonUi.retry' }));
    });
    await waitFor(() =>
      expect(screen.queryByTestId('psb-pending-release-notice-host')).toBeNull(),
    );
    expect(bridge.retryPendingWorkspaceReleases).toHaveBeenCalledTimes(1);
    expect(bridge.releaseWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-1' });
    expect(listPsbPendingReleases()).toHaveLength(0);
    expect(listPendingWorkspaceReleasesFromMain()).toHaveLength(0);
  });

  it('重试失败：提示条保留、正文换成 releaseRetained、原因仍可读', async () => {
    const pendingMain = mainRelease({ workspaceId: 'ws-main-1' });
    const { bridge, push } = installBridge();
    bridge.retryPendingWorkspaceReleases.mockResolvedValue({
      attempted: 1,
      released: 0,
      failed: 1,
      releases: [pendingMain],
    });
    bridge.releaseWorkspace.mockRejectedValue(new Error('[PSB_UNREACHABLE] still busy'));
    render(<PsbPendingReleaseNotice />);
    await flushPendingReads();
    await act(async () => {
      recordPsbPendingRelease('ws-1', workspaceFailure());
    });
    await act(async () => {
      push([pendingMain]);
    });
    expect(screen.getByTestId('psb-pending-release-message').textContent).toBe(
      'remoteWorkspace.draft.releasePending',
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'commonUi.retry' }));
    });
    await waitFor(() =>
      expect(screen.getByTestId('psb-pending-release-message').textContent).toBe(
        'remoteWorkspace.draft.releaseRetained',
      ),
    );
    // 两条都还在（main 的账本 + 工作区级重试失败重新入账）：失败保留并显示原因。
    expect(screen.getByTestId('psb-pending-release-count').textContent).toBe('2');
    expect(screen.getByTestId('psb-pending-release-notice').getAttribute('data-retained')).toBe('true');
    expect(screen.getByTestId('psb-pending-release-reasons').textContent).toContain(
      'remoteWorkspace.error.clientOffline',
    );
  });

  it('关闭只影响本次会话的显示：账本仍在；重挂不回来；新的失败重新出现', async () => {
    const pendingMain = mainRelease({ workspaceId: 'ws-main-1' });
    const { bridge } = installBridge();
    // main 账本的读口返回同一条记录：组件重挂时读一次快照，不应让已显示的条目变少。
    bridge.pendingWorkspaceReleases.mockResolvedValue({ releases: [pendingMain] });
    const first = render(<PsbPendingReleaseNotice />);
    await flushPendingReads();
    await act(async () => {
      recordPsbPendingRelease('ws-1', workspaceFailure());
    });
    expect(screen.getByTestId('psb-pending-release-count').textContent).toBe('2');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));
    });
    expect(screen.queryByTestId('psb-pending-release-notice-host')).toBeNull();
    // 关闭 ≠ 放弃重试：两本账本都还在。
    expect(listPsbPendingReleases()).toHaveLength(1);
    expect(listPendingWorkspaceReleasesFromMain()).toHaveLength(1);

    // 条件卸载重挂（路由切换等）不能把用户关掉的提示又弹回来。
    first.unmount();
    render(<PsbPendingReleaseNotice />);
    await flushPendingReads();
    expect(screen.queryByTestId('psb-pending-release-notice-host')).toBeNull();

    // 新的一笔失败到来：这是新信息，必须重新显示。
    await act(async () => {
      recordPsbPendingRelease('ws-2', workspaceFailure());
    });
    expect(screen.getByTestId('psb-pending-release-count').textContent).toBe('3');
  });

  it('副窗 / 侧栏窗不渲染，回到主窗才显示', async () => {
    recordPsbPendingRelease('ws-1', workspaceFailure());
    window.history.replaceState({}, '', '/?secondaryWindow=1');
    const secondary = render(<PsbPendingReleaseNotice />);
    expect(screen.queryByTestId('psb-pending-release-notice-host')).toBeNull();
    secondary.unmount();

    window.history.replaceState({}, '', '/?sidebarWindow=1');
    const sidebar = render(<PsbPendingReleaseNotice />);
    expect(screen.queryByTestId('psb-pending-release-notice-host')).toBeNull();
    sidebar.unmount();

    window.history.replaceState({}, '', '/');
    render(<PsbPendingReleaseNotice />);
    expect(screen.getByTestId('psb-pending-release-count').textContent).toBe('1');
  });

  it('旧 preload / 无 bridge 时降级：不崩、不假成功、工作区级账本仍可提示与重试', async () => {
    recordPsbPendingRelease('ws-old', workspaceFailure());

    // 1) 完全没有 psbRemote 桥：订阅 / 读取都是 no-op，提示条仍显示工作区级账本。
    render(<PsbPendingReleaseNotice />);
    expect(screen.getByTestId('psb-pending-release-count').textContent).toBe('1');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'commonUi.retry' }));
    });
    // 没有桥就重试不了：条目原样保留，不当成已释放。
    expect(listPsbPendingReleases()).toHaveLength(1);
    expect(screen.getByTestId('psb-pending-release-message').textContent).toBe(
      'remoteWorkspace.draft.releaseRetained',
    );
    cleanup();

    // 2) 旧 preload：对象在、新方法缺 —— 不抛错，已有账本照常提示。
    (window as unknown as { electronAPI?: { psbRemote?: unknown } }).electronAPI = { psbRemote: {} };
    recordPsbPendingRelease('ws-older', workspaceFailure());
    render(<PsbPendingReleaseNotice />);
    expect(screen.getByTestId('psb-pending-release-count').textContent).toBe('2');
  });
});
