// @vitest-environment jsdom

/**
 * UpdateBanner 终态弹窗的**真 store** 唤回链路。
 *
 * 另外两个文件各自 mock 了一半：`updateBannerRelaunchEntry.test.tsx` 直接改 mock 的
 * `dismissed`，`userInfoSectionUpdateFlame.test.tsx` mock 掉 store 只验火焰渲染。
 * 这里不 mock `useUpdateBannerDismiss`，跑「点『稍后』→ dismiss → 火焰 restore → 弹窗重开」
 * 的完整链路：它是该状态下用户唯一的回头路，断了就等于手动安装引导再也出不来。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateStatus = vi.hoisted(() => ({
  current: {
    status: 'error',
    version: '1.2.3',
    errorCode: 'update_apply_exhausted' as string | null,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useLocale', () => ({
  useLocale: () => ({ locale: 'en', effectiveLocale: 'en', setLocale: vi.fn() }),
}));

vi.mock('@/hooks/useUpdateStatus', () => ({
  useUpdateStatus: () => updateStatus.current,
}));

vi.mock('@/hooks/useDeferUpdateBannerWhileBusy', () => ({
  useDeferUpdateBannerWhileBusy: () => false,
  UPDATE_BANNER_BUSY_POLL_MS: 2000,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));

import { UpdateBanner } from '@/components/sidebar/UpdateBanner';
import {
  getUpdateBannerDismissState,
  resetUpdateBannerDismissStoreForTests,
  restoreUpdateBanner,
} from '@/hooks/useUpdateBannerDismiss';

beforeEach(() => {
  resetUpdateBannerDismissStoreForTests();
  updateStatus.current = {
    status: 'error',
    version: '1.2.3',
    errorCode: 'update_apply_exhausted',
  };
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      relaunchToUpdate: vi.fn(),
      anyActivityBlockingRelaunch: vi.fn(async () => false),
      clientEndpoints: { websiteUrl: 'https://cindy.ai' },
    } as unknown as Window['electronAPI'],
  });
});

afterEach(cleanup);

describe('UpdateBanner exhausted dialog reclaim path', () => {
  it('reopens after the sidebar flame restores the dismissed entry', async () => {
    const { rerender } = render(<UpdateBanner isCollapsed={false} />);
    await screen.findByText('update.applyExhausted.title');

    fireEvent.click(screen.getByRole('button', { name: 'update.applyExhausted.later' }));
    await waitFor(() => {
      expect(screen.queryByText('update.applyExhausted.title')).toBeNull();
    });
    // The real store, not a mock: dismissing is what the flame later reverses.
    expect(getUpdateBannerDismissState().dismissed).toBe(true);
    expect(getUpdateBannerDismissState().reason).toBe('user');

    act(() => {
      restoreUpdateBanner();
    });
    rerender(<UpdateBanner isCollapsed={false} />);
    await screen.findByText('update.applyExhausted.title');
    expect(getUpdateBannerDismissState().dismissed).toBe(false);
  });
});
