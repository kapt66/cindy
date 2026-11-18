/**
 * Local packaging and MCPRouter publishing for one registered development Plugin.
 *
 * The renderer never receives package bytes or Router credentials. Both actions
 * are explicit IPC mutations against the registered source directory.
 *
 * 读取线上信息失败时必须按**原因**给出不同下一步(重新连接 / 升级 MCPRouter /
 * 检查网络 / 重试),所以这里保存结构化的 `{ code, detail }`,而不是一个布尔。
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
import { compareMekaPluginVersion } from '../../../shared/mekaDevPlugin';
import type { MekaRouterSettingsView } from '../../../shared/meka-router';

type ActiveAction = 'package' | 'upload' | 'access' | null;

/**
 * 待发布版本相对 MCPRouter 上**已发布版本**的关系。
 *
 * - `new`:还没发布过,首次上传;
 * - `newer`:正常「更新」,保留二次确认;
 * - `same`:版本已存在,只同步权限,不碰不可覆盖的 Release;
 * - `older`:本地要发布的是更低版本。MCPRouter 的 Release 不可覆盖,上传必然 409,
 *   因此禁止上传并说明该怎么改。
 */
type MekaPublishVersionRelation = 'new' | 'same' | 'newer' | 'older';

/**
 * 读取 MCPRouter 发布信息的失败事实。
 *
 * `code` 来自 Main 的固定分类(`MEKA_ROUTER_*`),`detail` 是可公开的补充信息
 * (HTTP 状态码与端点),不含凭证、查询串或响应体。
 */
interface MekaUploadInfoFailure {
  code: string;
  detail?: string;
}

/** 凭证类失败:可以原位重新连接 MCPRouter 后重试。 */
function isMekaRouterCredentialFailure(code: string): boolean {
  return (
    code === 'MEKA_ROUTER_NOT_CONFIGURED' ||
    code === 'MEKA_ROUTER_SESSION_EXPIRED' ||
    // 旧版本 Main 把 401 映射成通用 PERMISSION_DENIED,保持同一引导。
    code === 'PERMISSION_DENIED'
  );
}

function uploadInfoFailureCopyKey(code: string): string {
  switch (code) {
    case 'MEKA_ROUTER_NOT_CONFIGURED':
      return 'settings.ghosts.meka.dev.publishInfoFailures.notConfigured';
    case 'MEKA_ROUTER_SESSION_EXPIRED':
    case 'PERMISSION_DENIED':
      return 'settings.ghosts.meka.dev.publishInfoFailures.sessionExpired';
    case 'MEKA_ROUTER_ENDPOINT_UNSUPPORTED':
      return 'settings.ghosts.meka.dev.publishInfoFailures.endpointUnsupported';
    case 'MEKA_ROUTER_UNREACHABLE':
      return 'settings.ghosts.meka.dev.publishInfoFailures.unreachable';
    case 'MEKA_ROUTER_RESPONSE_INVALID':
      return 'settings.ghosts.meka.dev.publishInfoFailures.responseInvalid';
    default:
      return 'settings.ghosts.meka.dev.publishInfoFailed';
  }
}

function describeUploadInfoFailure(error: unknown): MekaUploadInfoFailure {
  const ipcError = extractIpcError(error);
  const detail = ipcError?.message.trim();
  return {
    code: ipcError?.code ?? 'INTERNAL',
    ...(detail ? { detail } : {}),
  };
}

/**
 * 上传失败里可辨别的稳定码 → 用户语言的文案。
 *
 * 版本类失败必须换成可操作说明(当前线上是哪个版本、为什么发不出去),
 * 不能让 Main 的英文诊断句直接冒到 toast 上;其余失败(网络、未知原因)
 * 仍显示 Main 的说明,信息更多。
 */
function uploadFailureCopyKey(code: string): string | null {
  switch (code) {
    case 'MEKA_ROUTER_VERSION_NOT_NEWER':
      return 'settings.ghosts.meka.dev.publishVersionTooOld';
    case 'MEKA_ROUTER_VERSION_ALREADY_PUBLISHED':
      return 'settings.ghosts.meka.dev.publishVersionAlreadyPublished';
    default:
      return null;
  }
}

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
  /** 已装开发副本当前运行的版本;只用于版本对照的回退,不当作上传版本。 */
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
  const [uploadInfoFailure, setUploadInfoFailure] = useState<MekaUploadInfoFailure | null>(null);
  const [visibility, setVisibility] = useState<MekaPluginVisibility>('private');
  const [sharedUsernamesText, setSharedUsernamesText] = useState('');
  const [activeAction, setActiveAction] = useState<ActiveAction>(null);
  const runtimeId = item?.runtimeId ?? null;

  const applyUploadInfo = useCallback((info: MekaDevPluginUploadInfo) => {
    setUploadInfo(info);
    setVisibility(info.existing?.visibility ?? 'private');
    setSharedUsernamesText(info.existing?.sharedUsernames.join(', ') ?? '');
    setUploadInfoFailure(null);
  }, []);

  const refreshUploadInfo = useCallback(async () => {
    if (!runtimeId) return;
    setCheckingUploadInfo(true);
    setUploadInfoFailure(null);
    try {
      applyUploadInfo(await window.electronAPI.mekaDevPlugins.uploadInfo(runtimeId));
    } catch (error) {
      setUploadInfo(null);
      const failure = describeUploadInfoFailure(error);
      setUploadInfoFailure(failure);
      // 凭证类失败时上传不可能成功:按「未连接」呈现,原位给出重新连接入口,
      // 本地打包不受影响(它不读线上信息)。
      if (isMekaRouterCredentialFailure(failure.code)) {
        setRouterConfigured(false);
        setRouterLoginRequired(true);
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
    setUploadInfoFailure(null);
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
  /**
   * 三态判断。`older` 只有在**能证明更低**时才成立:不同字符串但数值段相同
   * (例如 `1.0.0-beta` 与 `1.0.0`)仍按「更新」处理,不改变旧行为。
   */
  const versionRelation = useMemo<MekaPublishVersionRelation>(() => {
    if (!uploadInfo?.existing) return 'new';
    if (uploadInfo.existing.currentVersion === uploadInfo.version) return 'same';
    return compareMekaPluginVersion(uploadInfo.version, uploadInfo.existing.currentVersion) < 0
      ? 'older'
      : 'newer';
  }, [uploadInfo]);
  const isUpdate = versionRelation === 'newer';
  const versionTooOld = versionRelation === 'older';
  const accessInvalid = visibility === 'shared' && sharedUsernames.length === 0;
  // 版本口径:展示**将要打包/上传的版本**(源码打包结果)。已装开发副本的版本只是
  // 「当前运行版本」,两者不同时必须并排标出,避免把运行版本误读成上传版本。
  const uploadVersion = uploadInfo?.version ?? item?.sourceVersion ?? null;
  const runningVersion = item?.installedVersion ?? (pluginVersion || null);
  const versionChanged =
    uploadVersion !== null && runningVersion !== null && uploadVersion !== runningVersion;
  const credentialFailure =
    uploadInfoFailure !== null && isMekaRouterCredentialFailure(uploadInfoFailure.code);

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
    if (
      !item ||
      !routerConfigured ||
      !uploadInfo ||
      accessInvalid ||
      versionTooOld ||
      activeAction
    ) {
      return;
    }
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
    } catch (error) {
      const ipcError = extractIpcError(error);
      const copyKey = ipcError ? uploadFailureCopyKey(ipcError.code) : null;
      toast.error(
        copyKey
          ? t(copyKey, {
              currentVersion: uploadInfo.existing?.currentVersion,
              nextVersion: uploadInfo.version,
            })
          : (ipcError?.message ?? t('settings.ghosts.meka.dev.uploadFailed')),
      );
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
            className="modal-scrim fixed inset-0 z-[10000]"
            style={WINDOW_NO_DRAG_STYLE}
          />
          <Dialog.Content
            data-testid="meka-dev-plugin-package-dialog"
            onPointerDownOutside={(event) => event.preventDefault()}
            className={cn(
              'modal-panel fixed left-1/2 top-1/2 z-[10000] w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2',
              'p-5 focus:outline-none',
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
                    {t('settings.ghosts.meka.dev.uploadVersionLabel')}
                  </p>
                  <p className="font-mono text-12 font-medium text-[var(--text-primary)]">
                    {uploadVersion ? `v${uploadVersion}` : '—'}
                  </p>
                  {versionChanged ? (
                    <p className="mt-0.5 max-w-[160px] text-11 leading-4 text-[var(--text-tertiary)]">
                      {t('settings.ghosts.meka.dev.versionChanged', {
                        runningVersion,
                        uploadVersion,
                      })}
                    </p>
                  ) : null}
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
                    className="resize-none rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-13 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
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
              ) : uploadInfoFailure ? (
                <div className="mt-2" data-testid="meka-dev-plugin-publish-info-failure">
                  <p className="text-11 text-[var(--error-fg)]">
                    {t(uploadInfoFailureCopyKey(uploadInfoFailure.code))}
                  </p>
                  {uploadInfoFailure.detail ? (
                    <p className="mt-0.5 break-words font-mono text-11 leading-4 text-[var(--text-tertiary)]">
                      {uploadInfoFailure.detail}
                    </p>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void refreshUploadInfo()}
                      disabled={checkingUploadInfo || activeAction !== null}
                      className="text-11 font-medium text-[var(--accent-text)] transition-colors hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-wait disabled:opacity-40"
                    >
                      {t('settings.ghosts.meka.dev.publishInfoRetry')}
                    </button>
                    {credentialFailure ? (
                      <button
                        type="button"
                        onClick={handleConfigureRouter}
                        disabled={activeAction !== null}
                        className="text-11 font-medium text-[var(--accent-text)] transition-colors hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-wait disabled:opacity-40"
                      >
                        {t('settings.ghosts.meka.dev.configureRouter')}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : uploadInfo?.existing ? (
                <p
                  className={
                    versionTooOld
                      ? 'mt-2 text-11 leading-4 text-[var(--error-fg)]'
                      : 'mt-2 text-11 text-[var(--text-tertiary)]'
                  }
                  data-testid={versionTooOld ? 'meka-dev-plugin-version-too-old' : undefined}
                >
                  {t(
                    versionTooOld
                      ? 'settings.ghosts.meka.dev.publishVersionTooOld'
                      : sameVersion
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
                  uploadInfoFailure !== null ||
                  accessInvalid ||
                  // 低于线上已发布版本时上传必然失败,直接禁用(本地打包不受影响)。
                  versionTooOld ||
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
            {/* 凭证类失败的重新连接入口已就地渲染在失败原因下方,这里不重复;
                从未配置过 MCPRouter 时才把配置入口放在弹窗底部。 */}
            {!checkingRouter && !routerConfigured && !credentialFailure ? (
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
