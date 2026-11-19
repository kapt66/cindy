// @vitest-environment jsdom

/**
 * 头像行火焰与 UpdateBanner 折叠火焰互斥:rail 的 UserInfoSection 不渲染火焰,
 * 展开态才在 banner 被藏起时用这颗涂黑入口。钉住 Greptile 说的「busy 时两颗火焰」。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from '@/components/sidebar/UpdateBanner';
import {
  deferUpdateBannerBecauseBusy,
  getUpdateBannerDismissState,
  resetUpdateBannerDismissStoreForTests,
} from '@/hooks/useUpdateBannerDismiss';
import type { RawReleaseNotes } from '../../shared/releaseNotesContent';

const harness = vi.hoisted(() => ({
  updateStatus: { status: 'ready', version: '1.2.3', errorCode: null as string | null },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Cindy user', avatar: null },
    mode: 'cloud',
    isCanary: false,
  }),
}));

vi.mock('@/hooks/useUpdateStatus', () => ({
  // Meka 保留可变 harness：下面按用例切换 status / errorCode（exhausted vs 其它错误）。
  // 版本也走 harness —— 只有一份可变状态，renderUpdate 改它才会真的喂给组件。
  useUpdateStatus: () => harness.updateStatus,
}));

vi.mock('@/hooks/useLocale', () => ({
  useLocale: () => ({ effectiveLocale: 'en' }),
}));

vi.mock('@/hooks/useBetaChannelSettings', () => ({
  useBetaChannelSettings: () => ({
    state: { enableBeta: false, isCustomized: false, loading: false },
  }),
}));

vi.mock('@/hooks/useLogout', () => ({
  useLogout: () => ({ handleLogout: vi.fn() }),
}));

vi.mock('@/components/sidebar/MobileDownloadDialog', () => ({
  MobileDownloadDialog: () => null,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));

import { UserInfoSection } from '@/components/sidebar/UserInfoSection';

beforeEach(() => {
  harness.updateStatus = { status: 'ready', version: '1.2.3', errorCode: null };
  // 全部走真实 dismiss store：busy 让路后的火焰按钮本身由 store 的
  // dismissed + reason:'busy' 决定，不能再用 hook 替身伪造状态（上游本文件
  // 已改为真实 store 初始化；替身还会漏掉新增导出）。
  resetUpdateBannerDismissStoreForTests();
  deferUpdateBannerBecauseBusy('ready', harness.updateStatus.version);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      appDisplayVersion: '1.0.0',
      appDisplayVersionDetail: '1.0.0-test',
      appVersion: '1.0.0',
      anyActivityBlockingRelaunch: vi.fn().mockResolvedValue(false),
      clientEndpoints: { websiteUrl: 'https://cindy.ai' },
    },
  });
});

afterEach(cleanup);

/**
 * 生产入口：真实火焰按钮 → dismiss store → UpdateBanner → release-notes 缓存 → IPC。
 * Bug：公告首次 404 后，关闭提示再点火焰不会重试，公告恢复后仍没有入口。
 * 现有覆盖只检查火焰是否显示，未覆盖重新展开及公告缓存；最小输入为 null → 有效公告。
 * tier: unit，公告读取只在 IPC 边界用内存替身；另覆盖成功缓存及未完成请求，避免重复联网。
 * 单文件实测：vitest run src/renderer/__tests__/userInfoSectionUpdateFlame.test.tsx，1.55 秒。
 */
describe('UserInfoSection reopens update notes', () => {
  beforeEach(() => resetUpdateBannerDismissStoreForTests());

  function notes(version: string): RawReleaseNotes {
    return {
      version,
      date: '2026-11-16',
      contributors: [],
      topics: [{ title: 'Update', text: 'New features', contributors: [] }],
    };
  }

  async function renderUpdate(version: string) {
    harness.updateStatus = { ...harness.updateStatus, version };
    render(<>
      <UpdateBanner isCollapsed={false} onOpenVersionNotice={vi.fn()} />
      <UserInfoSection isCollapsed={false} onOpenUpdateNotice={vi.fn()} />
    </>);
    await screen.findByRole('button', { name: 'update.banner.dismissAria' });
  }

  function closeAndReopen() {
    fireEvent.click(screen.getByRole('button', { name: 'update.banner.dismissAria' }));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.user.reopenUpdateBanner' }));
  }

  it.each(['missing', 'rejected'] as const)('retries %s notes once when the flame reopens the banner', async (failure) => {
    const version = failure === 'missing' ? '1.2.4' : '1.2.5';
    const fetchNotes = vi.fn().mockResolvedValue(notes(version));
    if (failure === 'missing') fetchNotes.mockResolvedValueOnce(null);
    else fetchNotes.mockRejectedValueOnce(new Error('IPC unavailable'));
    window.electronAPI.fetchReleaseNotes = fetchNotes;
    await renderUpdate(version);
    expect(screen.queryByText('update.banner.viewNotes')).toBeNull();
    expect(fetchNotes).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.dismissAria' }));
    expect(fetchNotes).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.user.reopenUpdateBanner' }));

    expect(await screen.findByText('update.banner.viewNotes')).toBeTruthy();
    expect(fetchNotes).toHaveBeenCalledTimes(2);
    expect(fetchNotes).toHaveBeenLastCalledWith(version);
  });

  it('reuses successful notes when the flame reopens the banner', async () => {
    const version = '1.2.6';
    const fetchNotes = vi.fn().mockResolvedValue(notes(version));
    window.electronAPI.fetchReleaseNotes = fetchNotes;
    await renderUpdate(version);
    await screen.findByText('update.banner.viewNotes');

    closeAndReopen();

    expect(await screen.findByText('update.banner.viewNotes')).toBeTruthy();
    expect(fetchNotes).toHaveBeenCalledTimes(1);
  });

  it('reuses an in-flight request across repeated flame reopens', async () => {
    const version = '1.2.7';
    let resolveNotes!: (value: RawReleaseNotes) => void;
    const pending = new Promise<RawReleaseNotes>((resolve) => { resolveNotes = resolve; });
    const fetchNotes = vi.fn().mockReturnValue(pending);
    window.electronAPI.fetchReleaseNotes = fetchNotes;
    await renderUpdate(version);

    closeAndReopen();
    closeAndReopen();
    await act(async () => { resolveNotes(notes(version)); });

    expect(await screen.findByText('update.banner.viewNotes')).toBeTruthy();
    expect(fetchNotes).toHaveBeenCalledTimes(1);
  });
});

describe('UserInfoSection update flame vs rail', () => {
  it('does not render the reopen flame in the rail layout while busy-deferred', () => {
    render(<UserInfoSection isCollapsed onOpenUpdateNotice={() => {}} />);

    expect(screen.queryByRole('button', { name: 'sidebar.user.reopenUpdateBanner' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'sidebar.user.viewReleaseNotes' })).toBeNull();
  });

  it('renders the reopen flame in the expanded layout while the banner is deferred', () => {
    render(<UserInfoSection isCollapsed={false} onOpenUpdateNotice={() => {}} />);

    expect(screen.getByRole('button', { name: 'sidebar.user.reopenUpdateBanner' })).toBeTruthy();
  });

  it('offers the reopen flame for a version whose auto-apply budget is spent', () => {
    // The exhausted dialog is one-shot and `isErrorOnly` renders nothing else, so
    // this flame is the only way back to the manual-install guidance after "later".
    harness.updateStatus = { status: 'error', version: '1.2.3', errorCode: 'update_apply_exhausted' };
    const onOpenUpdateNotice = vi.fn();
    render(<UserInfoSection isCollapsed={false} onOpenUpdateNotice={onOpenUpdateNotice} />);

    const flame = screen.getByRole('button', { name: 'sidebar.user.reopenUpdateBanner' });
    fireEvent.click(flame);
    // 真实 store：火焰是「唤回 banner」= restore，并钉住当前版本（busy 不再藏）。
    expect(getUpdateBannerDismissState()).toMatchObject({ dismissed: false, reason: null, pinnedByUser: true });
    // Not the release-notes entry: reaching update history instead of the
    // manual-install dialog would strand the user on a version they cannot apply.
    expect(onOpenUpdateNotice).not.toHaveBeenCalled();
  });

  it('does not turn other error states into a reopen flame', () => {
    harness.updateStatus = { status: 'error', version: '1.2.3', errorCode: 'updater_spawn_failed' };
    render(<UserInfoSection isCollapsed={false} onOpenUpdateNotice={() => {}} />);

    expect(screen.queryByRole('button', { name: 'sidebar.user.reopenUpdateBanner' })).toBeNull();
    expect(screen.getByRole('button', { name: 'sidebar.user.viewReleaseNotes' })).toBeTruthy();
  });

  it('has no flame at all in the rail layout, so the dialog can only be reclaimed by expanding', () => {
    // Registered boundary (docs/dev-rules/cindy-updater.md): in the collapsed rail
    // `UserInfoSection` renders the avatar only. A remount does NOT reopen the dialog
    // once the user dismissed it, so expanding the sidebar is the only way back.
    harness.updateStatus = { status: 'error', version: '1.2.3', errorCode: 'update_apply_exhausted' };
    render(<UserInfoSection isCollapsed onOpenUpdateNotice={() => {}} />);

    expect(screen.queryByRole('button', { name: 'sidebar.user.reopenUpdateBanner' })).toBeNull();
  });

  it('keeps the regular app version label for the personal build', () => {
    render(<UserInfoSection isCollapsed={false} />);

    // Meka divergence(WL-5.5/5.6):版本行前缀走**运行期 edition**,dev 构建显示
    // `Global · <版本>` —— 同目录 userInfoSectionMobileDownload.test.tsx 按同一取值断言。
    // 上游本用例断言裸 '1.0.0'(上游 global 构建不标前缀、也没有 edition 解构),在 Meka 下不成立。
    expect(screen.getByText('login.realmSelector.global · 1.0.0')).toBeTruthy();
    expect(screen.queryByText('cindyMake.versions.personal')).toBeNull();
  });
});
