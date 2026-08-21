import { BrowserWindow } from 'electron';

import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';

export const MEKA_ROUTER_OPEN_LOGIN_CHANNEL = 'meka-settings:router:open-login';

/** Bring the trusted Cindy window forward and open the existing MCPRouter login dialog. */
export function openMekaRouterLoginWindow(): boolean {
  const focused = BrowserWindow.getFocusedWindow();
  const win = isTrustedAppRendererWindow(focused)
    ? focused
    : BrowserWindow.getAllWindows().find((candidate) => isTrustedAppRendererWindow(candidate));
  if (!win || win.isDestroyed()) return false;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.send(MEKA_ROUTER_OPEN_LOGIN_CHANNEL);
  return true;
}
