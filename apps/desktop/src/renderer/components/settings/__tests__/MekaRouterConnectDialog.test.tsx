/**
 * MCPRouter login and registration dialog behavior.
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { MekaRouterConnectDialog } from '../MekaRouterConnectDialog';

describe('MekaRouterConnectDialog', () => {
  const connect = vi.fn(async () => undefined);
  const register = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { mekaSettings: { router: { connect, register } } },
    });
  });

  it('keeps Tab navigation inside the dialog instead of reaching the app-level blocker', () => {
    const globalTabBlocker = vi.fn((event: KeyboardEvent) => event.preventDefault());
    window.addEventListener('keydown', globalTabBlocker);
    render(
      <MekaRouterConnectDialog
        open
        settings={{
          configured: false,
          routerUrl: null,
          defaultRouterUrl: 'https://router.example/',
          routerUsername: null,
          mekaDesignConfigured: false,
          mekaDesignUrl: null,
          mekaDesignConflict: false,
          mekaDesignConflictId: null,
        }}
        onOpenChange={vi.fn()}
        onConnected={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByLabelText('settings.meka.router.url'), { key: 'Tab' });
    expect(globalTabBlocker).not.toHaveBeenCalled();
    window.removeEventListener('keydown', globalTabBlocker);
  });

  it('switches to registration and connects with the returned account session', async () => {
    const onOpenChange = vi.fn();
    const onConnected = vi.fn(async () => undefined);
    render(
      <MekaRouterConnectDialog
        open
        settings={{
          configured: false,
          routerUrl: null,
          defaultRouterUrl: 'https://router.example/',
          routerUsername: null,
          mekaDesignConfigured: false,
          mekaDesignUrl: null,
          mekaDesignConflict: false,
          mekaDesignConflictId: null,
        }}
        onOpenChange={onOpenChange}
        onConnected={onConnected}
      />,
    );

    expect(screen.getByText('settings.meka.router.loginDescription')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.meka.router.register' }));
    expect(screen.getByText('settings.meka.router.registerDescription')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('settings.meka.router.username'), {
      target: { value: 'new-user' },
    });
    fireEvent.change(screen.getByLabelText('settings.meka.router.password'), {
      target: { value: 'secret-password' },
    });
    fireEvent.change(screen.getByLabelText('settings.meka.router.confirmPassword'), {
      target: { value: 'secret-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.meka.router.registerSubmit' }));

    await waitFor(() =>
      expect(register).toHaveBeenCalledWith({
        routerUrl: 'https://router.example/',
        username: 'new-user',
        password: 'secret-password',
      }),
    );
    expect(connect).not.toHaveBeenCalled();
    expect(onConnected).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
