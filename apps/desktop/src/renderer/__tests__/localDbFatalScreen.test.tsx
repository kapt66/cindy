// @vitest-environment jsdom

/**
 * LocalDbFatalScreen 的视图接线（不是纯函数映射）：本地库被更高版本升级后，
 * 「自动更新已放弃该版本」与「无补丁可装」必须给不同的主按钮动作 ——
 * 前者点「检查更新」只会拿到同一结论（主进程不再下载），结果又被 `.catch` 吞掉，
 * 于是按钮永远没反应、页面没有任何手动安装入口。这里钉住这层接线。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateStatus = vi.hoisted(() => ({
  current: { status: 'error', errorCode: undefined } as {
    status: string;
    errorCode?: string;
    progress?: number;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useUpdateStatus', () => ({
  useUpdateStatus: () => updateStatus.current,
}));

import { LocalDbFatalScreen } from '@/components/error/LocalDbFatalScreen';

const checkForUpdate = vi.fn().mockResolvedValue('apply_exhausted');

beforeEach(() => {
  updateStatus.current = { status: 'error', errorCode: undefined };
  checkForUpdate.mockClear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      checkForUpdate,
      clientEndpoints: { websiteUrl: 'https://cindy.ai' },
    } as unknown as Window['electronAPI'],
  });
});

afterEach(cleanup);

describe('LocalDbFatalScreen update recovery wiring', () => {
  it('offers a manual download once auto-apply gave up, instead of a dead "check for updates"', () => {
    updateStatus.current = { status: 'error', errorCode: 'update_apply_exhausted' };
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      render(<LocalDbFatalScreen />);

      expect(screen.getByText('localDbFatal.applyExhausted.title')).toBeTruthy();
      expect(screen.getByText('localDbFatal.applyExhausted.description')).toBeTruthy();
      fireEvent.click(
        screen.getByRole('button', { name: 'localDbFatal.applyExhausted.download' }),
      );

      expect(openSpy).toHaveBeenCalledWith('https://cindy.ai', '_blank');
      // The gate would answer `apply_exhausted` again and the screen would stay put.
      expect(checkForUpdate).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it('keeps the ordinary retry path for any other error state', () => {
    updateStatus.current = { status: 'error', errorCode: 'updater_spawn_failed' };
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      render(<LocalDbFatalScreen />);

      expect(screen.getByText('localDbFatal.noUpdate.title')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'localDbFatal.noUpdate.checkUpdate' }));

      expect(checkForUpdate).toHaveBeenCalledTimes(1);
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });
});
