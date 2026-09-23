// @vitest-environment jsdom

/**
 * 头像行火焰与 UpdateBanner 折叠火焰互斥:rail 的 UserInfoSection 不渲染火焰,
 * 展开态才在 banner 被藏起时用这颗涂黑入口。钉住 Greptile 说的「busy 时两颗火焰」。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  updateStatus: { status: 'ready', version: '1.2.3', errorCode: null as string | null },
  restore: vi.fn(),
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
  useUpdateStatus: () => harness.updateStatus,
}));

vi.mock('@/hooks/useUpdateBannerDismiss', () => ({
  useUpdateBannerDismiss: () => ({ dismissed: true, restore: harness.restore, reason: 'busy' }),
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
  harness.restore.mockClear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      appDisplayVersion: '1.0.0',
      appDisplayVersionDetail: '1.0.0-test',
    },
  });
});

afterEach(cleanup);

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
    render(<UserInfoSection isCollapsed={false} onOpenUpdateNotice={() => {}} />);

    const flame = screen.getByRole('button', { name: 'sidebar.user.reopenUpdateBanner' });
    fireEvent.click(flame);
    expect(harness.restore).toHaveBeenCalled();

    // Not the release-notes entry: reaching update history instead of the
    // manual-install dialog would strand the user on a version they cannot apply.
    expect(screen.queryByRole('button', { name: 'sidebar.user.viewReleaseNotes' })).toBeNull();
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
});
