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
  auth: { canEnterApp: false, isInitializing: false, isAuthenticated: false, mode: 'signed-out' },
  db: { localDbGateStatus: 'pending', coverHeld: false },
  env: { status: 'passed' },
  handoff: {
    brandStageMounted: false,
    phase: 'done',
    branch: null as string | null,
    panelRevealed: true,
    startSignals: {
      brandAssetsReady: true,
      splashExited: true,
      splashExitCompleted: true,
      loginPanelMounted: false,
    },
  },
  reportStartupGateStall: vi.fn(),
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
import { parseStartupGateStallSnapshot } from '../../../../shared/startupGateStall';

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
  mocks.auth.isAuthenticated = false;
  mocks.auth.mode = 'signed-out';
  mocks.db.localDbGateStatus = 'pending';
  mocks.db.coverHeld = false;
  mocks.env.status = 'passed';
  mocks.handoff.brandStageMounted = false;
  mocks.handoff.phase = 'done';
  mocks.handoff.branch = null;
  mocks.handoff.panelRevealed = true;
  mocks.handoff.startSignals.loginPanelMounted = false;
  mocks.openLogsDir.mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      openLogsDir: mocks.openLogsDir,
      // WL-26：Meka 不提供任何上报入口，这里也不 stub 上传 API；
      // 启动门卡住诊断只经 main 写本地日志，仍需要这条桥。
      reportStartupGateStall: mocks.reportStartupGateStall,
    },
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

// 用户卡在开屏、主进程日志却显示已登录且数据库就绪时,原先无从判断是哪个门没放行;
// renderer 日志又不进上传。超时后经 main 记一份启动门快照。
describe('startup gate stall report', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function signedInWithBrandStageStuck() {
    mocks.auth.canEnterApp = true;
    mocks.auth.isAuthenticated = true;
    mocks.auth.mode = 'cloud';
    mocks.db.localDbGateStatus = 'ready';
    mocks.handoff.brandStageMounted = true;
    mocks.handoff.phase = 'boot';
    mocks.handoff.panelRevealed = false;
  }

  it('reports the gate snapshot once when the startup cover stays past the threshold', () => {
    signedInWithBrandStageStuck();
    render(<StartupLogSupport />);

    act(() => vi.advanceTimersByTime(19_000));
    expect(mocks.reportStartupGateStall).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(60_000));
    expect(mocks.reportStartupGateStall).toHaveBeenCalledOnce();
    expect(mocks.reportStartupGateStall.mock.calls[0][0]).toMatchObject({
      authenticated: true,
      canEnterApp: true,
      envStatus: 'passed',
      localDbGate: 'ready',
      handoffPhase: 'boot',
      handoffBranch: 'none',
      brandStageMounted: true,
      loginPanelMounted: false,
    });
  });

  it.each([
    [
      'the login panel is waiting for the user',
      () => {
        mocks.handoff.brandStageMounted = true;
        mocks.handoff.startSignals.loginPanelMounted = true;
      },
    ],
    ['startup finishes before the threshold', null],
  ])('does not report when %s', (_label, arrange) => {
    if (arrange) {
      arrange();
      render(<StartupLogSupport />);
    } else {
      signedInWithBrandStageStuck();
      const view = render(<StartupLogSupport />);
      act(() => vi.advanceTimersByTime(5_000));
      mocks.handoff.brandStageMounted = false;
      mocks.handoff.phase = 'done';
      view.rerender(<StartupLogSupport />);
    }

    act(() => vi.advanceTimersByTime(60_000));
    expect(mocks.reportStartupGateStall).not.toHaveBeenCalled();
  });

  // 未登录冷启动:登录页先挂在开屏底下,面板还没显示;开屏卡住时用户看到的仍是开屏。
  it('reports a stuck splash even while the login page is mounted underneath', () => {
    mocks.handoff.brandStageMounted = true;
    mocks.handoff.phase = 'boot';
    mocks.handoff.panelRevealed = false;
    mocks.handoff.startSignals.loginPanelMounted = true;
    render(<StartupLogSupport />);

    act(() => vi.advanceTimersByTime(20_000));
    expect(mocks.reportStartupGateStall).toHaveBeenCalledOnce();
    expect(mocks.reportStartupGateStall.mock.calls[0][0]).toMatchObject({
      handoffPhase: 'boot',
      loginPanelMounted: true,
    });
  });

  // 在登录页停留超过阈值后再登录:数据库准备的那一小段不能立刻被算成卡住。
  it('times the threshold from when waiting begins, not from page load', () => {
    mocks.handoff.brandStageMounted = true;
    mocks.handoff.startSignals.loginPanelMounted = true;
    const view = render(<StartupLogSupport />);
    act(() => vi.advanceTimersByTime(30_000));

    mocks.auth.canEnterApp = true;
    mocks.db.coverHeld = true;
    mocks.handoff.startSignals.loginPanelMounted = false;
    view.rerender(<StartupLogSupport />);
    act(() => vi.advanceTimersByTime(19_000));
    expect(mocks.reportStartupGateStall).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1_000));
    expect(mocks.reportStartupGateStall).toHaveBeenCalledOnce();
    expect(mocks.reportStartupGateStall.mock.calls[0][0]).toMatchObject({
      elapsedMs: 50_000,
      waitingMs: 20_000,
      localDbGate: 'pending',
    });
  });

  // 登录页停留(或休眠)跨过一天后再卡住:时长超出 main 的白名单上限会让整份快照被拒,
  // 而每次加载只报一次,诊断就此丢失。
  it('keeps a report from a day-long session within what main accepts', () => {
    mocks.handoff.brandStageMounted = true;
    mocks.handoff.startSignals.loginPanelMounted = true;
    const view = render(<StartupLogSupport />);
    act(() => vi.advanceTimersByTime(25 * 60 * 60 * 1000));

    mocks.auth.canEnterApp = true;
    mocks.db.coverHeld = true;
    mocks.handoff.startSignals.loginPanelMounted = false;
    view.rerender(<StartupLogSupport />);
    act(() => vi.advanceTimersByTime(20_000));

    expect(mocks.reportStartupGateStall).toHaveBeenCalledOnce();
    const payload = mocks.reportStartupGateStall.mock.calls[0][0];
    expect(parseStartupGateStallSnapshot(payload)).toMatchObject({
      elapsedMs: 24 * 60 * 60 * 1000,
      waitingMs: 20_000,
    });
  });
});
