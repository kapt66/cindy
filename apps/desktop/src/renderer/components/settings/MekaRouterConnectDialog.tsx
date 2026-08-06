import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Eye, EyeOff, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { MekaRouterSettingsView } from '../../../shared/meka-router';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';

type AuthMode = 'login' | 'register';

const BUTTON_CLASS = cn(
  'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-14 font-medium',
  'border border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)]',
  'text-[var(--settings-btn-secondary-text)] transition-colors',
  'hover:bg-[var(--settings-btn-secondary-hover)] disabled:cursor-not-allowed disabled:opacity-50',
);

const INPUT_CLASS = cn(
  'h-9 w-full rounded-md border px-3 text-14 outline-none',
  'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
  'text-[var(--settings-input-text)] focus:border-[var(--settings-input-border-focus)]',
);

export function MekaRouterConnectDialog({
  open,
  settings,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  settings: MekaRouterSettingsView | null;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [routerUrl, setRouterUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [mode, setMode] = useState<AuthMode>('login');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRouterUrl(settings?.routerUrl ?? settings?.defaultRouterUrl ?? '');
    setUsername(settings?.routerUsername ?? '');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setMode('login');
  }, [open, settings]);

  const submit = async () => {
    if (
      submitting ||
      !routerUrl.trim() ||
      !username.trim() ||
      !password ||
      (mode === 'register' && (!confirmPassword || password !== confirmPassword))
    ) {
      if (mode === 'register' && confirmPassword && password !== confirmPassword) {
        toast.error(t('settings.meka.router.passwordMismatch'));
      }
      return;
    }
    setSubmitting(true);
    try {
      await window.electronAPI.mekaSettings.router[mode === 'register' ? 'register' : 'connect']({
        routerUrl,
        username,
        password,
      });
      await onConnected();
      setPassword('');
      setConfirmPassword('');
      onOpenChange(false);
      toast.success(
        t(
          mode === 'register'
            ? 'settings.meka.router.registered'
            : 'settings.meka.router.connected',
        ),
      );
    } catch (error) {
      toast.error(extractIpcError(error)?.message ?? String(error));
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = () => {
    setMode((current) => (current === 'login' ? 'register' : 'login'));
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
  };

  const canSubmit =
    !submitting &&
    !!routerUrl.trim() &&
    !!username.trim() &&
    !!password &&
    (mode === 'login' || (!!confirmPassword && password === confirmPassword));

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!submitting) onOpenChange(nextOpen);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10010] bg-black/45 backdrop-blur-[1px]"
          style={WINDOW_NO_DRAG_STYLE}
        />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10011] flex w-[min(440px,calc(100vw-32px))]',
            '-translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border p-5 shadow-xl',
            'border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
          )}
          style={WINDOW_NO_DRAG_STYLE}
          onKeyDown={(event) => {
            // App.tsx disables Tab globally; keep native/Radix focus traversal inside this form.
            if (event.key === 'Tab') event.stopPropagation();
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title className="text-16 font-medium text-[var(--settings-section-title)]">
              {t(
                mode === 'register'
                  ? 'settings.meka.router.registerDialogTitle'
                  : 'settings.meka.router.dialogTitle',
              )}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={submitting}
                className="rounded-md p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:cursor-wait disabled:opacity-50"
                aria-label={t('settings.ghosts.detail.closeDialog')}
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="text-13 leading-5 text-[var(--text-secondary)]">
            {t(
              mode === 'register'
                ? 'settings.meka.router.registerDescription'
                : 'settings.meka.router.loginDescription',
            )}
          </Dialog.Description>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-13 text-[var(--text-secondary)]">
                {t('settings.meka.router.url')}
              </span>
              <input
                className={INPUT_CLASS}
                type="url"
                value={routerUrl}
                onChange={(event) => setRouterUrl(event.target.value)}
                placeholder={settings?.defaultRouterUrl ?? 'https://router.example'}
                autoComplete="url"
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-13 text-[var(--text-secondary)]">
                {t('settings.meka.router.username')}
              </span>
              <input
                className={INPUT_CLASS}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-13 text-[var(--text-secondary)]">
                {t('settings.meka.router.password')}
              </span>
              <div className="relative">
                <input
                  className={cn(INPUT_CLASS, 'pr-10')}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={
                    showPassword
                      ? t('settings.meka.router.hidePassword')
                      : t('settings.meka.router.showPassword')
                  }
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>
            {mode === 'register' && (
              <label className="flex flex-col gap-1">
                <span className="text-13 text-[var(--text-secondary)]">
                  {t('settings.meka.router.confirmPassword')}
                </span>
                <input
                  className={INPUT_CLASS}
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
            )}
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                className="h-9 px-1 text-14 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={submitting}
                onClick={switchMode}
              >
                {t(
                  mode === 'login'
                    ? 'settings.meka.router.register'
                    : 'settings.meka.router.backToLogin',
                )}
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={BUTTON_CLASS}
                  disabled={submitting}
                  onClick={() => onOpenChange(false)}
                >
                  {t('logic.confirm.cancel')}
                </button>
                <button type="submit" className={BUTTON_CLASS} disabled={!canSubmit}>
                  {t(
                    mode === 'register'
                      ? 'settings.meka.router.registerSubmit'
                      : 'settings.meka.router.connect',
                  )}
                </button>
              </div>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
