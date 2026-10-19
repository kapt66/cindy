// @vitest-environment jsdom
//
// Meka divergence (WL-26): Cindy Meka does not enable client log upload, so the upstream
// manual-upload cases (`uploadLogsNow` / `LOG_UPLOAD_*` / privacy consent) have no production
// surface to assert and were removed together with `useManualLogUpload`. What remains here is the
// retained surface: the startup entry's visibility rules and the local-log action.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from '../../../i18n/locales/zh-CN/common.json';

const mocks = vi.hoisted(() => ({
  auth: { canEnterApp: false, isInitializing: false },
  db: { localDbGateStatus: 'pending' },
  env: { status: 'passed' },
  handoff: { brandStageMounted: false },
  error: vi.fn(),
  success: vi.fn(),
  openLogsDir: vi.fn(),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/contexts/AppShellCoverContext', () => ({ useAppShellCover: () => mocks.db }));
vi.mock('@/contexts/EnvCheckContext', () => ({ useEnvCheck: () => mocks.env }));
vi.mock('@/contexts/LoginHandoffContext', () => ({ useLoginHandoff: () => mocks.handoff }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error, success: mocks.success } }));

import { StartupLogSupport } from '../StartupLogSupport';

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: 'zh-CN',
    resources: { 'zh-CN': { translation: zhCN } },
    interpolation: { escapeValue: false },
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.canEnterApp = false;
  mocks.auth.isInitializing = false;
  mocks.db.localDbGateStatus = 'pending';
  mocks.env.status = 'passed';
  mocks.handoff.brandStageMounted = false;
  mocks.openLogsDir.mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { openLogsDir: mocks.openLogsDir },
  });
});
afterEach(cleanup);

function openSupport() {
  render(<StartupLogSupport />);
  fireEvent.click(screen.getByRole('button', { name: zhCN.logSupport.title }));
}

describe('startup log support', () => {
  it('opens local logs while signed out', async () => {
    openSupport();
    fireEvent.click(screen.getByRole('button', { name: zhCN.settings.about.openLogsDir }));
    await waitFor(() => expect(mocks.openLogsDir).toHaveBeenCalledOnce());
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('reports a failure to open the local log directory', async () => {
    mocks.openLogsDir.mockResolvedValue({ success: false });
    openSupport();
    fireEvent.click(screen.getByRole('button', { name: zhCN.settings.about.openLogsDir }));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(zhCN.settings.about.openLogsDirError),
    );
  });

  // Meka divergence (WL-26) guard: the dialog exposes only the local-log action. The upload rows
  // (and their `settings.about.logUpload.*` i18n keys) were removed together with the feature.
  it('offers only the local log action in the dialog', () => {
    openSupport();
    const dialog = screen.getByRole('alertdialog');
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([zhCN.settings.about.openLogsDir, zhCN.logSupport.close]);
    expect((window.electronAPI as unknown as Record<string, unknown>).uploadLogsNow).toBeUndefined();
  });

  it('hides the startup entry but preserves a user-opened dialog when startup completes', () => {
    const view = render(<StartupLogSupport />);
    fireEvent.click(screen.getByRole('button', { name: zhCN.logSupport.title }));
    mocks.auth.canEnterApp = true;
    mocks.db.localDbGateStatus = 'ready';
    view.rerender(<StartupLogSupport />);
    expect(screen.queryByRole('button', { name: zhCN.logSupport.title })).toBeNull();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: zhCN.logSupport.close }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it.each(['pending', 'fatal'])('stays reachable when database state is %s', (state) => {
    mocks.auth.canEnterApp = true;
    mocks.db.localDbGateStatus = state;
    openSupport();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: zhCN.settings.about.openLogsDir }),
    ).toBeTruthy();
  });

  it('stays reachable through startup failure and disappears when the app is ready', () => {
    mocks.auth.canEnterApp = true;
    mocks.db.localDbGateStatus = 'ready';
    mocks.env.status = 'failed';
    const view = render(<StartupLogSupport />);
    expect(screen.getByRole('button', { name: zhCN.logSupport.title })).toBeTruthy();
    mocks.env.status = 'passed';
    view.rerender(<StartupLogSupport />);
    expect(screen.queryByRole('button', { name: zhCN.logSupport.title })).toBeNull();
  });

  it('keeps the entry reachable while the brand stage owns the screen', () => {
    mocks.auth.canEnterApp = true;
    mocks.db.localDbGateStatus = 'ready';
    mocks.handoff.brandStageMounted = true;
    const view = render(<StartupLogSupport />);
    expect(screen.getByRole('button', { name: zhCN.logSupport.title })).toBeTruthy();
    act(() => {
      mocks.handoff.brandStageMounted = false;
    });
    view.rerender(<StartupLogSupport />);
    expect(screen.queryByRole('button', { name: zhCN.logSupport.title })).toBeNull();
  });
});
