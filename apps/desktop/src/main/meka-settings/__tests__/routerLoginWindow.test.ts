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

import { MEKA_ROUTER_OPEN_LOGIN_CHANNEL, openMekaRouterLoginWindow } from '../routerLoginWindow.js';

function fakeWindow(input: { visible?: boolean; minimized?: boolean; destroyed?: boolean } = {}) {
  return {
    isDestroyed: vi.fn(() => input.destroyed ?? false),
    isVisible: vi.fn(() => input.visible ?? true),
    isMinimized: vi.fn(() => input.minimized ?? false),
    show: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
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
});
