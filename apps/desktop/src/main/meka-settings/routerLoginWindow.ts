import { randomUUID } from 'node:crypto';

import { BrowserWindow } from 'electron';

import { isMainShellWindowUrl } from '../cindy-brain/scheduleSlot.js';
import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';

export const MEKA_ROUTER_OPEN_LOGIN_CHANNEL = 'meka-settings:router:open-login';

export type MekaRouterLoginOutcome = 'connected' | 'cancelled' | 'timed-out' | 'unavailable';

export interface MekaRouterLoginResult {
  opened: boolean;
  outcome: MekaRouterLoginOutcome;
}

const LOGIN_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingLoginRequest {
  id: string;
  opened: boolean;
  promise: Promise<MekaRouterLoginResult>;
  resolve: (result: MekaRouterLoginResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

let pendingLoginRequest: PendingLoginRequest | null = null;

function finishPendingLogin(outcome: MekaRouterLoginOutcome): boolean {
  const pending = pendingLoginRequest;
  if (!pending) return false;
  pendingLoginRequest = null;
  clearTimeout(pending.timeout);
  pending.resolve({ opened: pending.opened, outcome });
  return true;
}

/** Bring the trusted Cindy window forward and open the existing MCPRouter login dialog. */
export function openMekaRouterLoginWindow(requestId?: string): boolean {
  const isLoginTarget = (candidate: BrowserWindow | null | undefined): candidate is BrowserWindow =>
    Boolean(
      isTrustedAppRendererWindow(candidate) &&
      candidate &&
      isMainShellWindowUrl(candidate.webContents.getURL()),
    );
  const focused = BrowserWindow.getFocusedWindow();
  const win = isLoginTarget(focused) ? focused : BrowserWindow.getAllWindows().find(isLoginTarget);
  if (!win || win.isDestroyed()) return false;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  if (requestId) {
    win.webContents.send(MEKA_ROUTER_OPEN_LOGIN_CHANNEL, { requestId });
  } else {
    win.webContents.send(MEKA_ROUTER_OPEN_LOGIN_CHANNEL);
  }
  return true;
}

/**
 * Open one shared login flow and wait for the renderer to connect or cancel.
 * Concurrent Router calls share the same request so credentials are requested once.
 */
export function requestMekaRouterLogin(
  timeoutMs: number = LOGIN_WAIT_TIMEOUT_MS,
): Promise<MekaRouterLoginResult> {
  if (pendingLoginRequest) return pendingLoginRequest.promise;

  const id = randomUUID();
  let resolve!: (result: MekaRouterLoginResult) => void;
  const promise = new Promise<MekaRouterLoginResult>((done) => {
    resolve = done;
  });
  const timeout = setTimeout(() => finishPendingLogin('timed-out'), timeoutMs);
  pendingLoginRequest = { id, opened: false, promise, resolve, timeout };

  if (!openMekaRouterLoginWindow(id)) {
    finishPendingLogin('unavailable');
  }
  return promise;
}

/** Record that the main renderer actually committed the login dialog. */
export function markMekaRouterLoginPresented(requestId: string): boolean {
  if (!pendingLoginRequest || pendingLoginRequest.id !== requestId) return false;
  pendingLoginRequest.opened = true;
  return true;
}

/** Complete a matching renderer-owned login request after cancellation. */
export function cancelMekaRouterLogin(requestId: string): boolean {
  if (!pendingLoginRequest || pendingLoginRequest.id !== requestId) return false;
  return finishPendingLogin('cancelled');
}

/** A successful Router connect/register completes the shared flow regardless of its UI origin. */
export function completeMekaRouterLogin(): boolean {
  return finishPendingLogin('connected');
}
