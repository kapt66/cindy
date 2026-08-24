import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  getFocusedWindow: vi.fn(),
  getAllWindows: vi.fn(),
}));
const trusted = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: electron.getFocusedWindow,
    getAllWindows: electron.getAllWindows,
  },
}));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  isTrustedAppRendererWindow: trusted,
}));

import {
  cancelMekaRouterLogin,
  completeMekaRouterLogin,
  markMekaRouterLoginPresented,
  MEKA_ROUTER_OPEN_LOGIN_CHANNEL,
  openMekaRouterLoginWindow,
  requestMekaRouterLogin,
} from '../routerLoginWindow.js';

function fakeWindow(
  input: {
    visible?: boolean;
    minimized?: boolean;
    destroyed?: boolean;
    url?: string;
  } = {},
) {
  return {
    isDestroyed: vi.fn(() => input.destroyed ?? false),
    isVisible: vi.fn(() => input.visible ?? true),
    isMinimized: vi.fn(() => input.minimized ?? false),
    show: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: {
      getURL: vi.fn(() => input.url ?? 'https://app.example/#/cc-agent/new'),
      send: vi.fn(),
    },
  };
}

describe('MCPRouter login window presenter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electron.getFocusedWindow.mockReturnValue(null);
    electron.getAllWindows.mockReturnValue([]);
    trusted.mockReturnValue(false);
  });

  it('focuses a trusted app window and opens the existing login dialog', () => {
    const win = fakeWindow({ visible: false, minimized: true });
    electron.getAllWindows.mockReturnValue([win]);
    trusted.mockImplementation((candidate) => candidate === win);

    expect(openMekaRouterLoginWindow()).toBe(true);
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith(MEKA_ROUTER_OPEN_LOGIN_CHANNEL);
  });

  it('does not send the login event when no trusted app window exists', () => {
    const untrusted = fakeWindow();
    electron.getAllWindows.mockReturnValue([untrusted]);

    expect(openMekaRouterLoginWindow()).toBe(false);
    expect(untrusted.webContents.send).not.toHaveBeenCalled();
  });

  it('ignores a focused detached sidebar and sends the login event to the main shell', () => {
    const sidebar = fakeWindow({ url: 'https://app.example/?sidebarWindow=1#/sidebar-window' });
    const main = fakeWindow();
    electron.getFocusedWindow.mockReturnValue(sidebar);
    electron.getAllWindows.mockReturnValue([sidebar, main]);
    trusted.mockReturnValue(true);

    expect(openMekaRouterLoginWindow()).toBe(true);
    expect(sidebar.webContents.send).not.toHaveBeenCalled();
    expect(main.webContents.send).toHaveBeenCalledWith(MEKA_ROUTER_OPEN_LOGIN_CHANNEL);
    expect(main.focus).toHaveBeenCalledOnce();
  });

  it('does not report success when only utility app windows exist', () => {
    const utility = fakeWindow({ url: 'https://app.example/?view=voice-input-overlay' });
    electron.getFocusedWindow.mockReturnValue(utility);
    electron.getAllWindows.mockReturnValue([utility]);
    trusted.mockReturnValue(true);

    expect(openMekaRouterLoginWindow()).toBe(false);
    expect(utility.webContents.send).not.toHaveBeenCalled();
  });

  it('ignores the resource usage window when selecting the login target', () => {
    const resourceUsage = fakeWindow({
      url: 'https://app.example/?resourceUsageWindow=1#/resource-usage-window',
    });
    const main = fakeWindow();
    electron.getFocusedWindow.mockReturnValue(resourceUsage);
    electron.getAllWindows.mockReturnValue([resourceUsage, main]);
    trusted.mockReturnValue(true);

    expect(openMekaRouterLoginWindow()).toBe(true);
    expect(resourceUsage.webContents.send).not.toHaveBeenCalled();
    expect(main.webContents.send).toHaveBeenCalledWith(MEKA_ROUTER_OPEN_LOGIN_CHANNEL);
  });

  it('waits for the presented login dialog and resumes after a successful connection', async () => {
    const main = fakeWindow();
    electron.getAllWindows.mockReturnValue([main]);
    trusted.mockReturnValue(true);

    const resultPromise = requestMekaRouterLogin();
    const request = main.webContents.send.mock.calls[0]?.[1] as { requestId: string };
    expect(request.requestId).toBeTruthy();
    expect(markMekaRouterLoginPresented(request.requestId)).toBe(true);
    expect(completeMekaRouterLogin()).toBe(true);

    await expect(resultPromise).resolves.toEqual({ opened: true, outcome: 'connected' });
  });

  it('deduplicates concurrent login requests and lets the renderer cancel the shared wait', async () => {
    const main = fakeWindow();
    electron.getAllWindows.mockReturnValue([main]);
    trusted.mockReturnValue(true);

    const first = requestMekaRouterLogin();
    const second = requestMekaRouterLogin();
    const request = main.webContents.send.mock.calls[0]?.[1] as { requestId: string };
    expect(first).toBe(second);
    expect(main.webContents.send).toHaveBeenCalledOnce();
    expect(cancelMekaRouterLogin(request.requestId)).toBe(true);

    await expect(first).resolves.toEqual({ opened: false, outcome: 'cancelled' });
  });

  it('returns unavailable when no main shell can present the login dialog', async () => {
    await expect(requestMekaRouterLogin()).resolves.toEqual({
      opened: false,
      outcome: 'unavailable',
    });
  });
});
