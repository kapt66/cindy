/**
 * Local packaging and MCPRouter publishing for one registered development Plugin.
 *
 * The renderer never receives package bytes or Router credentials. Both actions
 * are explicit IPC mutations against the registered source directory.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Box, CloudUpload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { MekaRouterConnectDialog } from '@/components/settings/MekaRouterConnectDialog';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';

import type {
  MekaDevPluginItem,
  MekaDevPluginUploadInfo,
  MekaPluginVisibility,
} from '../../../shared/mekaDevPlugin';
import type { MekaRouterSettingsView } from '../../../shared/meka-router';

type ActiveAction = 'package' | 'upload' | 'access' | null;

export function MekaDevPluginPackageDialog({
  item,
  pluginName,
  pluginVersion,
  open,
  onOpenChange,
  onUploaded,
}: {
  item: MekaDevPluginItem | null;
  pluginName: string;
  pluginVersion: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const packageButtonRef = useRef<HTMLButtonElement>(null);
  const [routerSettings, setRouterSettings] = useState<MekaRouterSettingsView | null>(null);
  const [routerConfigured, setRouterConfigured] = useState(false);
  const [routerLoginRequired, setRouterLoginRequired] = useState(false);
  const [checkingRouter, setCheckingRouter] = useState(false);
  const [routerLoginOpen, setRouterLoginOpen] = useState(false);
  const [uploadInfo, setUploadInfo] = useState<MekaDevPluginUploadInfo | null>(null);
  const [checkingUploadInfo, setCheckingUploadInfo] = useState(false);
  const [uploadInfoFailed, setUploadInfoFailed] = useState(false);
  const [visibility, setVisibility] = useState<MekaPluginVisibility>('private');
  const [sharedUsernamesText, setSharedUsernamesText] = useState('');
  const [activeAction, setActiveAction] = useState<ActiveAction>(null);
  const runtimeId = item?.runtimeId ?? null;

  const applyUploadInfo = useCallback((info: MekaDevPluginUploadInfo) => {
    setUploadInfo(info);
    setVisibility(info.existing?.visibility ?? 'private');
    setSharedUsernamesText(info.existing?.sharedUsernames.join(', ') ?? '');
    setUploadInfoFailed(false);
  }, []);

  const refreshUploadInfo = useCallback(async () => {
    if (!runtimeId) return;
    setCheckingUploadInfo(true);
    setUploadInfoFailed(false);
    try {
      applyUploadInfo(await window.electronAPI.mekaDevPlugins.uploadInfo(runtimeId));
    } catch (error) {
      setUploadInfo(null);
      if (extractIpcError(error)?.code === 'PERMISSION_DENIED') {
        setRouterConfigured(false);
        setRouterLoginRequired(true);
        setUploadInfoFailed(false);
      } else {
        setUploadInfoFailed(true);
      }
    } finally {
      setCheckingUploadInfo(false);
    }
  }, [applyUploadInfo, runtimeId]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setRouterSettings(null);
    setRouterConfigured(false);
    setRouterLoginRequired(false);
    setRouterLoginOpen(false);
    setUploadInfo(null);
    setUploadInfoFailed(false);
    setVisibility('private');
    setSharedUsernamesText('');
    setCheckingRouter(true);
    void (async () => {
      try {
        const settings = await window.electronAPI.mekaSettings.router.get();
        if (active) {
          setRouterSettings(settings);
          setRouterConfigured(settings.configured);
        }
        if (settings.configured && active) await refreshUploadInfo();
      } catch {
        if (active) {
          setRouterSettings(null);
          setRouterConfigured(false);
        }
      } finally {
        if (active) setCheckingRouter(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [open, refreshUploadInfo]);

  const sharedUsernames = useMemo(
    () => [
      ...new Set(
        sharedUsernamesText
          .split(/[,\n]/)
          .map((username) => username.trim())
          .filter(Boolean),
      ),
    ],
    [sharedUsernamesText],
  );
  const sameVersion =
    uploadInfo?.existing != null &&
    uploadInfo.existing.currentVersion === uploadInfo.version;
  const isUpdate = uploadInfo?.existing != null && !sameVersion;
  const accessInvalid = visibility === 'shared' && sharedUsernames.length === 0;

  const close = () => {
    if (activeAction) return;
    onOpenChange(false);
  };

  const handlePackage = async () => {
    if (!item || activeAction) return;
    setActiveAction('package');
    try {
      const result = await window.electronAPI.mekaDevPlugins.package(item.runtimeId);
      if (!result.canceled) {
        toast.success(
          t('settings.ghosts.meka.dev.packageSaved', {
            name: pluginName,
            path: result.filePath,
          }),
        );
      }
    } catch {
      toast.error(t('settings.ghosts.meka.dev.packageFailed'));
    } finally {
      setActiveAction(null);
    }
  };

  const handleUpload = async () => {
    if (!item || !routerConfigured || !uploadInfo || accessInvalid || activeAction) return;
    if (isUpdate) {
      const approved = await confirm({
        title: t('settings.ghosts.meka.dev.updateConfirmTitle'),
        description: t('settings.ghosts.meka.dev.updateConfirmDescription', {
          currentVersion: uploadInfo.existing?.currentVersion,
          nextVersion: uploadInfo.version,
        }),
        confirmText: t('settings.ghosts.meka.dev.updateConfirmAction'),
        cancelText: t('settings.ghosts.meka.dev.cancel'),
      });
      if (!approved) return;
    }
    setActiveAction(sameVersion ? 'access' : 'upload');
    try {
      const result = await window.electronAPI.mekaDevPlugins.upload({
        id: item.runtimeId,
        visibility,
        sharedUsernames: visibility === 'shared' ? sharedUsernames : [],
        expectedCurrentReleaseId: uploadInfo.existing?.currentReleaseId ?? null,
      });
      toast.success(
        result.releasePublished
          ? t('settings.ghosts.meka.dev.uploaded', {
              name: pluginName,
              version: result.version,
            })
          : t('settings.ghosts.meka.dev.accessSynced'),
      );
      await onUploaded();
      onOpenChange(false);
    } catch {
      toast.error(t('settings.ghosts.meka.dev.uploadFailed'));
    } finally {
      setActiveAction(null);
    }
  };

  const handleConfigureRouter = () => {
    if (activeAction) return;
    setRouterLoginOpen(true);
  };

  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) close();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay
            className={cn(
              'fixed inset-0 z-[10000] bg-[var(--overlay-modal)]',
              'data-[state=open]:animate-confirm-overlay-in data-[state=closed]:animate-confirm-overlay-out',
            )}
            style={WINDOW_NO_DRAG_STYLE}
          />
          <Dialog.Content
            data-testid="meka-dev-plugin-package-dialog"
            className={cn(
              'fixed left-1/2 top-1/2 z-[10000] w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2',
              'rounded-xl border border-[var(--border-default)] bg-[var(--confirm-bg)] p-5 shadow-[var(--confirm-shadow)] focus:outline-none',
              'data-[state=open]:animate-confirm-content-in data-[state=closed]:animate-confirm-content-out',
            )}
            style={WINDOW_NO_DRAG_STYLE}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              packageButtonRef.current?.focus();
            }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Dialog.Title className="truncate text-16 font-medium text-[var(--confirm-title)]">
                  {t('settings.ghosts.meka.dev.packageTitle', { name: pluginName })}
                </Dialog.Title>
                <Dialog.Description className="mt-2 text-13 leading-5 text-[var(--confirm-description)]">
                  {t(
                    checkingRouter
                      ? 'settings.ghosts.meka.dev.packageChecking'
                      : routerConfigured
                        ? 'settings.ghosts.meka.dev.packageConfigured'
                        : routerLoginRequired
                          ? 'settings.ghosts.meka.dev.packageLoginRequired'
                          : 'settings.ghosts.meka.dev.packageLocalOnly',
                  )}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={activeAction !== null}
                  aria-label={t('settings.ghosts.detail.closeDialog')}
                  className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-wait disabled:opacity-40"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>

            <div className="mt-5 rounded-lg border border-[var(--border-default)] bg-[var(--surface)] px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-13 font-medium text-[var(--text-primary)]">
                    {pluginName}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-11 text-[var(--text-tertiary)]">
                    {item?.pluginId ?? ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-11 text-[var(--text-tertiary)]">
                    {t('settings.ghosts.meka.dev.versionLabel')}
                  </p>
                  <p className="font-mono text-12 font-medium text-[var(--text-primary)]">
                    v{pluginVersion}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-12 font-medium text-[var(--text-secondary)]">
                  {t('settings.ghosts.meka.dev.permissionLabel')}
                </span>
                <select
                  value={visibility}
                  disabled={!routerConfigured || checkingUploadInfo || activeAction !== null}
                  onChange={(event) => setVisibility(event.target.value as MekaPluginVisibility)}
                  className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="private">
                    {t('settings.ghosts.meka.dev.permissions.private')}
                  </option>
                  <option value="shared">{t('settings.ghosts.meka.dev.permissions.shared')}</option>
                  <option value="public">{t('settings.ghosts.meka.dev.permissions.public')}</option>
                </select>
              </label>
              {visibility === 'shared' ? (
                <label className="mt-3 flex flex-col gap-1.5">
                  <span className="text-12 font-medium text-[var(--text-secondary)]">
                    {t('settings.ghosts.meka.dev.sharedUsersLabel')}
                  </span>
                  <textarea
                    value={sharedUsernamesText}
                    disabled={!routerConfigured || checkingUploadInfo || activeAction !== null}
                    onChange={(event) => setSharedUsernamesText(event.target.value)}
                    placeholder={t('settings.ghosts.meka.dev.sharedUsersPlaceholder')}
                    rows={2}
                    className="resize-none rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-13 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  {accessInvalid ? (
                    <span className="text-11 text-[var(--error-fg)]">
                      {t('settings.ghosts.meka.dev.sharedUsersRequired')}
                    </span>
                  ) : null}
                </label>
              ) : null}
              {routerConfigured && checkingUploadInfo ? (
                <p className="mt-2 text-11 text-[var(--text-tertiary)]">
                  {t('settings.ghosts.meka.dev.checkingPublishInfo')}
                </p>
              ) : uploadInfoFailed ? (
                <p className="mt-2 text-11 text-[var(--error-fg)]">
                  {t('settings.ghosts.meka.dev.publishInfoFailed')}
                </p>
              ) : uploadInfo?.existing ? (
                <p className="mt-2 text-11 text-[var(--text-tertiary)]">
                  {t(
                    sameVersion
                      ? 'settings.ghosts.meka.dev.versionAlreadyExists'
                      : 'settings.ghosts.meka.dev.versionUpdate',
                    {
                      currentVersion: uploadInfo.existing.currentVersion,
                      nextVersion: uploadInfo.version,
                    },
                  )}
                </p>
              ) : null}
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={activeAction !== null}
                className="inline-flex h-9 items-center justify-center rounded-full px-4 text-13 font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-wait disabled:opacity-40"
              >
                {t('settings.ghosts.meka.dev.cancel')}
              </button>
              <button
                ref={packageButtonRef}
                type="button"
                onClick={() => void handlePackage()}
                disabled={!item || activeAction !== null}
                className={cn(
                  'inline-flex h-9 items-center justify-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 text-13 font-medium text-[var(--text-primary)]',
                  'transition-[background-color,border-color,transform,opacity] hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-wait disabled:opacity-40 disabled:active:scale-100',
                )}
              >
                {activeAction === 'package' ? (
                  <Spinner size={14} />
                ) : (
                  <Box size={15} aria-hidden="true" />
                )}
                {t(
                  activeAction === 'package'
                    ? 'settings.ghosts.meka.dev.packaging'
                    : 'settings.ghosts.meka.dev.packageLocal',
                )}
              </button>
              <button
                type="button"
                onClick={() => void handleUpload()}
                disabled={
                  !item ||
                  checkingRouter ||
                  checkingUploadInfo ||
                  !routerConfigured ||
                  !uploadInfo ||
                  uploadInfoFailed ||
                  accessInvalid ||
                  activeAction !== null
                }
                className={cn(
                  'inline-flex h-9 items-center justify-center gap-2 rounded-full bg-[var(--accent-cta-bg)] px-4 text-13 font-medium text-[var(--accent-pure-cta-fg)]',
                  'transition-[background-color,transform,opacity] hover:bg-[var(--accent-hover)] active:scale-[0.98]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100',
                )}
              >
                {activeAction === 'upload' || activeAction === 'access' ? (
                  <Spinner size={14} />
                ) : (
                  <CloudUpload size={15} aria-hidden="true" />
                )}
                {t(
                  activeAction === 'access'
                    ? 'settings.ghosts.meka.dev.syncingAccess'
                    : activeAction === 'upload'
                      ? 'settings.ghosts.meka.dev.uploading'
                      : sameVersion
                        ? 'settings.ghosts.meka.dev.syncAccess'
                        : 'settings.ghosts.meka.dev.upload',
                )}
              </button>
            </div>
            {!checkingRouter && !routerConfigured ? (
              <div className="mt-4 border-t border-[var(--border-default)] pt-4 text-center">
                <button
                  type="button"
                  onClick={handleConfigureRouter}
                  disabled={activeAction !== null}
                  className="text-13 font-medium text-[var(--accent-text)] transition-colors hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-wait disabled:opacity-40"
                >
                  {t('settings.ghosts.meka.dev.configureRouter')}
                </button>
              </div>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <MekaRouterConnectDialog
        open={routerLoginOpen}
        settings={routerSettings}
        onOpenChange={setRouterLoginOpen}
        onConnected={async () => {
          // connect() only resolves after the credentials and client key are
          // persisted, so the current flow can enable upload immediately.
          setRouterConfigured(true);
          setRouterLoginRequired(false);
          try {
            setRouterSettings(await window.electronAPI.mekaSettings.router.get());
          } catch {
            // A follow-up settings refresh must not discard a successful login.
          }
          // Load publishing state independently so a transient settings-view
          // refresh failure does not force the user out of this packaging flow.
          await refreshUploadInfo();
        }}
      />
    </>
  );
}
