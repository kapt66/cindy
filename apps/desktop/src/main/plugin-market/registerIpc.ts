import os from 'node:os';

import { app, ipcMain } from 'electron';

import { isIpcError } from '../../shared/ipc-errors.js';
import { ServerApiError } from '../serverApiClient.desktop.js';
import { isPluginMarketPassthroughErrorCode } from './api.js';
import {
  isGhostInstallApprovalToken,
  isValidGhostId,
  type GhostManifest,
} from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import {
  isPluginMarketInstallOperationId,
  isPluginMarketCustomIconKey,
  MEKA_PLUGIN_MARKET_INSTALL_PROGRESS_CHANNEL,
  type PluginMarketInstallProgress,
  type PluginMarketSnapshot,
} from '../../shared/pluginMarket.js';
import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import {
  createWindowGhostInstallConsentPrompt,
  getGhostManager,
  sendToTrustedAppWindows,
  setGhostUninstallLedgerPreparer,
} from '../cindy-brain/index.js';
import { markGhostRecommendationInstalled } from '../cindy-brain/ghostRecommendationStore.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { parseMarketSource } from './sources/parse.js';
import { MekaPluginMarketApi } from './api.js';
import { PluginChannelLedger } from './channelLedger.js';
import { pluginClientVersionReader } from './clientIdentity.js';
import { getMekaLedger } from './mekaLedger.js';
import { readMekaDefaultPlugins, resolveMekaDefaultPluginsPath } from './mekaDefaultPlugins.js';
import { LocalIconRequestGate } from './localIconRequestGate.js';
import { resolveMekaPluginMaxDownloadBytes } from './mekaDownloadPolicy.js';
import {
  getPluginMarketService as service,
  PluginMarketService,
  type PluginMarketSnapshotOptions,
} from './service.js';

import { preparePluginShare } from './sharing.js';
import { installLocalPluginShare, readLocalPluginShare, prepareLocalPluginShare, releaseLocalPluginShare, releaseLocalPluginSharesForCaller } from './localSharing.js';

const log = createLogger('plugin-market-ipc');
let registered = false;
const REMOVAL_NOTICE_AVAILABLE_CHANNEL = 'plugin-market:removal-notice-available';
const UPDATE_CONSENT_HOLDS_CHANGED_CHANNEL = 'plugin-market:update-consent-holds-changed';
const localIconRequestGate = new LocalIconRequestGate();
const localShareWindows = new Set<number>();
// Meka 独立渠道的服务实例（`channel:'meka'` + 8/128 MiB 下载档），与上游 cindy 实例并存。
let mekaServiceSingleton: PluginMarketService | null = null;

/**
 * Meka keeps its own market identity: a separate server API surface, a separate
 * installation ledger and its own download ceiling, and it never adopts legacy
 * installations or applies the upstream default-install set. Cindy 的目录页 /
 * 后台对账 / Agent 调用继续共用上游 `getPluginMarketService()`。
 *
 * 默认插件改为**随包清单**（2026-11-20 用户裁决）：安装包带
 * `resources/meka/default-plugins.json`（列 ghostId），Meka 市场按清单补齐/更新；
 * 不接服务端 `defaultInstall`，也不需要新增服务端接口。清单里的插件仍从市场下载并走
 * 完整校验；用户显式卸载写下的 opt-out 优先，不会被清单装回。
 */
let mekaBundledDefaultGhostIdsCache: string[] | null = null;

/** 读一次随包清单；dev 默认关闭（避免与 dev 插件重复），打包构建始终启用。 */
function mekaBundledDefaultGhostIds(): string[] {
  if (mekaBundledDefaultGhostIdsCache) return mekaBundledDefaultGhostIdsCache;
  const enableBundledDefaults = app.isPackaged || process.env.CINDY_MEKA_BUNDLED_DEFAULTS === '1';
  let ghostIds: string[] = [];
  if (enableBundledDefaults) {
    const manifest = readMekaDefaultPlugins(resolveMekaDefaultPluginsPath({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    }));
    if (manifest.ok) {
      ghostIds = manifest.ghostIds;
      log.info('meka bundled default plugins loaded', { count: ghostIds.length });
    } else if (manifest.reason === 'invalid' || manifest.reason === 'unreadable' ||
      (manifest.reason === 'missing' && app.isPackaged)) {
      // fail-closed：清单损坏/读不到时一个都不装，但不要让启动失败。打包版缺清单
      // 也要留下可诊断的 warn（旧安装/裁剪包不再静默）。
      log.warn('meka bundled default plugins ignored', {
        reason: manifest.reason,
        detail: manifest.detail,
      });
    }
  }
  mekaBundledDefaultGhostIdsCache = ghostIds;
  return ghostIds;
}

function mekaService(): PluginMarketService {
  mekaServiceSingleton ??= new PluginMarketService(
    // Meka 渠道必须上报真实客户端版本：恒发 `0.0.0` 会被协议的 versionless 语义无条件放行，
    // 服务端版本兼容门失效。身份（edition → 空间／版本／来源）只有
    // `plugin-market/clientIdentity.ts` 一个解析入口，构造点不再自己写 `app.getVersion()`。
    new MekaPluginMarketApi(pluginClientVersionReader('meka')),
    // Meka 渠道的独立账本（与 Cindy 的 `ledger.v1.json` 不合并）。实例来自
    // `mekaLedger.ts`，Connection 签发资格判定读的是同一个账本实例。
    getMekaLedger(),
    {
      adoptLegacyInstallations: false,
      // 不继承上游服务端 defaultInstall；只应用随包清单。
      applyDefaultInstalls: false,
      applyAutomaticUpgrades: false,
      defaultInstallSource: 'bundled',
      bundledDefaultGhostIds: mekaBundledDefaultGhostIds(),
      resolveMaxDownloadBytes: resolveMekaPluginMaxDownloadBytes,
    },
  );
  return mekaServiceSingleton;
}

function requireInstallOperationId(value: unknown): string {
  if (!isPluginMarketInstallOperationId(value)) {
    throwIpcError('INVALID_PARAMS', 'Invalid Plugin install operation ID');
  }
  return value;
}

function captureChannelLedger(expectedOwnerId?: string): PluginChannelLedger {
  const session = getActiveAppSession();
  if (
    isAppSessionBoundaryPending() ||
    !session.dataOwnerId ||
    (expectedOwnerId !== undefined && session.dataOwnerId !== expectedOwnerId)
  ) {
    throwIpcError('PRECONDITION_FAILED', 'Plugin channel requires a stable app session');
  }
  return new PluginChannelLedger(
    ownerScopedUserDataPath('plugin-market', 'channels.v1.json'),
  );
}
function signalRemovalNoticeAvailable(): void {
  if (!service().hasPendingRemovalNotice()) return;
  sendToTrustedAppWindows(REMOVAL_NOTICE_AVAILABLE_CHANNEL, undefined);
}

function signalUpdateConsentHoldsChanged(): void {
  sendToTrustedAppWindows(UPDATE_CONSENT_HOLDS_CHANGED_CHANNEL, undefined);
}

async function snapshotAndSignalRemovalNotice(options?: PluginMarketSnapshotOptions) {
  try {
    return await service().snapshot(options);
  } finally {
    // 清理已成功但后续默认安装等步骤失败时，pending 仍必须通知 Renderer；
    // snapshot 的原始异常继续向上抛，不把通知信号伪装成整轮成功。
    signalRemovalNoticeAvailable();
  }
}

/**
 * Reuse the market snapshot reconciliation outside the Plugins page so
 * default-install plugins are provisioned and stable-source updates are applied
 * as soon as an app owner is ready. Resume and periodic maintenance retry it.
 */
export type DefaultMarketPluginSyncOutcome = 'completed' | 'deferred' | 'failed';

export function defaultMarketPluginSyncOutcome(
  snapshot: PluginMarketSnapshot,
  reconciliationOutcome: 'completed' | 'failed' = 'completed',
): DefaultMarketPluginSyncOutcome {
  // The organization catalog was not reconciled. Only an upgrade can fix a
  // client-version rejection; every other reason may clear on retry.
  const organizationRetryable =
    Boolean(snapshot.organizationAccessError)
    && snapshot.organizationAccessError !== 'PLUGIN_NAMESPACE_CLIENT_REQUIRED';
  if (
    (snapshot.unavailableReason === null || snapshot.unavailableReason === 'not-configured')
    && reconciliationOutcome === 'completed'
    && !organizationRetryable
  ) {
    return 'completed';
  }
  if (
    snapshot.unavailableReason === 'session-switching'
    || snapshot.unavailableReason === 'authentication-required'
  ) {
    return 'deferred';
  }
  return 'failed';
}

export async function syncDefaultMarketPlugins(
  trigger: PluginMarketSnapshotOptions['trigger'] = 'background',
): Promise<DefaultMarketPluginSyncOutcome> {
  try {
    let reconciliationOutcome: 'completed' | 'failed' | null = null;
    const snapshot = await snapshotAndSignalRemovalNotice({
      trigger,
      onDefaultReconciliationOutcome: (outcome) => {
        reconciliationOutcome = outcome;
      },
    });
    const outcome = defaultMarketPluginSyncOutcome(
      snapshot,
      reconciliationOutcome ?? 'completed',
    );
    // Meka 随包默认清单：与上游默认安装同一批启动/登录/前台/周期对账触发。
    // 独立失败不影响上游对账结果；清单为空时完全跳过 Meka 快照。
    if (mekaBundledDefaultGhostIds().length > 0) {
      try {
        await mekaService().snapshot();
      } catch (error) {
        log.warn('meka bundled default plugin sync failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (outcome === 'failed') {
      log.warn('default plugin startup sync incomplete', {
        unavailableReason: snapshot.unavailableReason,
        organizationAccessError: snapshot.organizationAccessError ?? null,
      });
    }
    return outcome;
  } catch (error) {
    log.warn('Plugin market background sync failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

/** Signal foreground removals without requesting another snapshot or disk scan. */
export async function refreshForegroundMarketPlugins(): Promise<'completed' | 'failed'> {
  try {
    const outcome = await service().refreshCatalogForForeground();
    // 启动/回前台也要应用 Meka 随包默认清单；清单为空时完全跳过快照。
    if (mekaBundledDefaultGhostIds().length > 0) {
      try {
        await mekaService().snapshot();
      } catch (error) {
        log.warn('meka bundled default plugin sync failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcome;
  } finally {
    // A removal can succeed before a later maintenance step fails.
    signalRemovalNoticeAvailable();
  }
}

/**
 * Preserve stable IPC errors and hide internal/network messages from the
 * renderer. Detailed failures stay in main logs; the renderer localizes by
 * code and uses a generic fallback for INTERNAL.
 */
async function invokePluginMarket<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isIpcError(error)) throw error;
    if (error instanceof ServerApiError && isPluginMarketPassthroughErrorCode(error.code)) {
      throwIpcError(error.code, 'Plugin market operation failed');
    }
    log.warn('plugin market IPC failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throwIpcError('INTERNAL', 'Plugin market operation failed');
  }
}

/** 注册 renderer 可用的只读市场与显式安装/卸载写路径。 */
export function registerPluginMarketIpc(): void {
  if (registered) return;
  registered = true;
  setGhostUninstallLedgerPreparer((target) => {
    // 上游把 target 放宽为 `string | InstalledGhost`（实例身份）；账本仍按**逻辑插件 id**记账。
    const ghostId = typeof target === 'string' ? target : target.manifest.id;
    let capturedChannelLedger: PluginChannelLedger | null = null;
    try {
      capturedChannelLedger = captureChannelLedger();
    } catch {
      // Each market service applies the same stable-owner guard.
    }
    const completions = [
      service().prepareLocalUninstallTracking(ghostId),
      mekaService().prepareLocalUninstallTracking(ghostId),
    ].filter((completion): completion is () => Promise<void> => completion !== null);
    const hasExplicitMekaChannel =
      capturedChannelLedger?.readMekaGhostIds().includes(ghostId) ?? false;
    if (completions.length === 0 && !hasExplicitMekaChannel) return null;
    return async () => {
      await Promise.all(completions.map((complete) => complete()));
      capturedChannelLedger?.setMeka(ghostId, false);
    };
  });
  ipcMain.handle('plugin-market:snapshot', (event) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() =>
      snapshotAndSignalRemovalNotice({
        discoveryOnly: true,
        onConsentHoldsChanged: signalUpdateConsentHoldsChanged,
      }),
    );
  });
  ipcMain.handle('plugin-market:query', (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const query = requireObject(input, 'query');
    return invokePluginMarket(() => service().query(query));
  });
  ipcMain.handle('plugin-market:recommendations', (event) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() => service().recommendations());
  });
  ipcMain.handle('plugin-market:lookup', (event, ghostIds: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (!Array.isArray(ghostIds)) throwIpcError('INVALID_PARAMS', 'Invalid Plugin identities');
    return invokePluginMarket(() => service().lookup(ghostIds));
  });
  ipcMain.handle('plugin-market:consume-removal-notice', (event) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(async () => service().consumeRemovalNotice());
  });
  ipcMain.handle('plugin-market:detail', (event, pluginId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() =>
      service().detail(requireString(pluginId, 'pluginId'), { includeReadme: true }),
    );
  });
  ipcMain.handle('plugin-market:prepare-share', (event, pluginId: unknown, options: unknown) => {
    assertTrustedAppRendererEvent(event);
    return preparePluginShare(pluginId, options);
  });
  ipcMain.handle('plugin-market:local-share-detail', (event, snapshotId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() => readLocalPluginShare(requireString(snapshotId, 'snapshotId')));
  });
  ipcMain.handle('plugin-market:install-local-share', (event, snapshotId: unknown, expected: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(async () => ({
      ghost: await installLocalPluginShare(requireString(snapshotId, 'snapshotId'), expected, createWindowGhostInstallConsentPrompt(event.sender)),
    }));
  });
  ipcMain.handle('plugin-market:prepare-local-share', (event, instanceId: unknown, operationId: unknown, options: unknown, expected: unknown, uploadConfirmed: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof uploadConfirmed !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid upload confirmation');
    const caller = event.sender.id;
    if (!localShareWindows.has(caller)) {
      localShareWindows.add(caller);
      event.sender.once('destroyed', () => {
        localShareWindows.delete(caller);
        void releaseLocalPluginSharesForCaller(caller);
      });
    }
    return prepareLocalPluginShare(caller, requireString(instanceId, 'instanceId'), requireString(operationId, 'operationId'),
      requireObject(options) as unknown as import('../../shared/share.js').ShareOptions,
      requireObject(expected) as unknown as import('../../shared/share.js').LocalPluginShareBinding, uploadConfirmed);
  });
  ipcMain.handle('plugin-market:release-local-share', (event, operationId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = requireString(operationId, 'operationId');
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) throwIpcError('INVALID_PARAMS', 'Invalid local share operation');
    return releaseLocalPluginShare(event.sender.id, id);
  });
  ipcMain.handle('plugin-market:local-icons', (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (!Array.isArray(raw) || raw.length > 8) {
      throwIpcError('INVALID_PARAMS', 'local icon requests must contain at most 8 entries');
    }
    const requests = raw.map((entry) => {
      const payload = requireObject(entry);
      const pluginId = requireString(payload.pluginId, 'pluginId');
      const expectedIconKey = requireString(payload.expectedIconKey, 'expectedIconKey');
      if (pluginId.length > 1024 || !isPluginMarketCustomIconKey(expectedIconKey)) {
        throwIpcError('INVALID_PARAMS', 'Invalid local Plugin icon request');
      }
      return { pluginId, expectedIconKey };
    });
    return invokePluginMarket(() => {
      const request = localIconRequestGate.tryRun(() => service().localIcons(requests));
      if (!request) {
        throwIpcError('PRECONDITION_FAILED', 'Too many local Plugin icon requests');
      }
      return request;
    });
  });
  ipcMain.handle(
    'plugin-market:install',
    (event, pluginId: unknown, options: unknown) => {
      assertTrustedAppRendererEvent(event);
      const obj =
        typeof options === 'object' && options !== null
          ? (options as {
              expectedReleaseId?: unknown;
              expectedInstalledApproval?: unknown;
              expectedManifest?: unknown;
              allowSourceReplacement?: unknown;
            })
          : null;
      const expectedReleaseId = requireString(obj?.expectedReleaseId, 'expectedReleaseId');
      const expectedInstalledApproval = obj?.expectedInstalledApproval;
      const expectedManifest =
        obj?.expectedManifest === undefined
          ? undefined
          : (requireObject(obj.expectedManifest) as unknown as GhostManifest);
      if (
        expectedInstalledApproval !== undefined &&
        !isGhostInstallApprovalToken(expectedInstalledApproval)
      ) {
        throwIpcError(
          'INVALID_PARAMS',
          'expectedInstalledApproval must come from ghosts:list',
        );
      }
      const allowSourceReplacement = obj?.allowSourceReplacement;
      if (typeof allowSourceReplacement !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'allowSourceReplacement must be a boolean');
      }
      const owner = getActiveAppSession();
      const previouslyInstalled = new Set(
        getGhostManager()
          .list()
          .map((g) => installedGhostStoragePart(g)),
      );
      return invokePluginMarket(async () => {
        const result = await service().install(
          requireString(pluginId, 'pluginId'),
          {
            expectedReleaseId,
            ...(expectedInstalledApproval !== undefined ? { expectedInstalledApproval } : {}),
            ...(expectedManifest !== undefined ? { expectedManifest } : {}),
            allowSourceReplacement,
          },
          // 首装与扩权更新的确认框投给发起安装的这个窗口。
          {
            consent: {
              prompt: createWindowGhostInstallConsentPrompt(event.sender),
              initiator: 'user',
            },
          },
        );
        if (
          getActiveAppSession().generation === owner.generation &&
          !previouslyInstalled.has(installedGhostStoragePart(result.ghost))
        ) {
          try {
            markGhostRecommendationInstalled(installedGhostStoragePart(result.ghost));
          } catch {
            log.warn('ghost recommendation install history unavailable');
          }
        }
        return result;
      });
    },
  );
  ipcMain.handle('plugin-market:uninstall', (event, pluginId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() =>
      service().uninstall(requireString(pluginId, 'pluginId')),
    );
  });
  ipcMain.handle(
    'plugin-market:set-local-channel',
    (event, ghostId: unknown, channel: unknown, expectedOwnerId: unknown) => {
      assertTrustedAppRendererEvent(event);
      return invokePluginMarket(async () => {
        const normalizedChannel = requireString(channel, 'channel');
        if (normalizedChannel !== 'cindy' && normalizedChannel !== 'meka') {
          throwIpcError('INVALID_PARAMS', 'Invalid Plugin channel');
        }
        const normalizedGhostId = requireString(ghostId, 'ghostId');
        if (!isValidGhostId(normalizedGhostId)) {
          throwIpcError('INVALID_PARAMS', 'Invalid Plugin id');
        }
        if (!getGhostManager().list().some((ghost) => ghost.manifest.id === normalizedGhostId)) {
          throwIpcError('NOT_FOUND', 'Installed Plugin not found');
        }
        captureChannelLedger(requireString(expectedOwnerId, 'expectedOwnerId')).setMeka(
          normalizedGhostId,
          normalizedChannel === 'meka',
        );
        return { ok: true } as const;
      });
    },
  );

  /* ------------------------- Meka 独立市场渠道 ------------------------- */

  ipcMain.handle('meka-plugin-market:snapshot', (event) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() => mekaService().snapshot());
  });
  ipcMain.handle('meka-plugin-market:installed-ghost-ids', (event) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(async () => {
      const channelLedger = captureChannelLedger();
      return [
        ...new Set([
          ...(await mekaService().installedGhostIds()),
          ...channelLedger.readMekaGhostIds(),
        ]),
      ];
    });
  });
  ipcMain.handle('meka-plugin-market:detail', (event, pluginId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() =>
      mekaService().detail(requireString(pluginId, 'pluginId')),
    );
  });
  ipcMain.handle(
    'meka-plugin-market:install',
    (event, pluginId: unknown, options: unknown) => {
      assertTrustedAppRendererEvent(event);
      const obj =
        typeof options === 'object' && options !== null
          ? (options as {
              expectedReleaseId?: unknown;
              expectedInstalledApproval?: unknown;
              expectedManifest?: unknown;
              allowSourceReplacement?: unknown;
              operationId?: unknown;
            })
          : null;
      const normalizedPluginId = requireString(pluginId, 'pluginId');
      const expectedReleaseId = requireString(obj?.expectedReleaseId, 'expectedReleaseId');
      const expectedInstalledApproval = obj?.expectedInstalledApproval;
      if (
        expectedInstalledApproval !== undefined &&
        !isGhostInstallApprovalToken(expectedInstalledApproval)
      ) {
        throwIpcError('INVALID_PARAMS', 'expectedInstalledApproval must come from ghosts:list');
      }
      const expectedManifest =
        obj?.expectedManifest === undefined
          ? undefined
          : (requireObject(obj.expectedManifest) as unknown as GhostManifest);
      const operationId = requireInstallOperationId(obj?.operationId);
      const sender = event.sender;
      return invokePluginMarket(() =>
        mekaService().install(
          normalizedPluginId,
          {
            expectedReleaseId,
            ...(expectedInstalledApproval !== undefined ? { expectedInstalledApproval } : {}),
            ...(expectedManifest !== undefined ? { expectedManifest } : {}),
            ...(typeof obj?.allowSourceReplacement === 'boolean'
              ? { allowSourceReplacement: obj.allowSourceReplacement }
              : {}),
            onProgress: (progress) => {
              if (sender.isDestroyed()) return;
              const payload: PluginMarketInstallProgress = {
                operationId,
                pluginId: normalizedPluginId,
                ...progress,
              };
              sender.send(MEKA_PLUGIN_MARKET_INSTALL_PROGRESS_CHANNEL, payload);
            },
          },
          // 上游把「安装／扩权更新前向用户确认权限」收敛为装入出口的必填上下文；
          // Meka 渠道与 Cindy 渠道同口径：确认框投给发起本次安装的那个窗口，
          // initiator 是用户本人。确认在任何安装锁与 owner 租约之外求得，只在新版本
          // 权限变多时才真正弹（判据在 `ghostInstallConsent.ts`）。
          {
            consent: {
              prompt: createWindowGhostInstallConsentPrompt(sender),
              initiator: 'user',
            },
          },
        ),
      );
    },
  );
  ipcMain.handle('meka-plugin-market:uninstall', (event, pluginId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() =>
      mekaService().uninstall(requireString(pluginId, 'pluginId')),
    );
  });

  /* ------------------------- 自定义市场源管理 ------------------------- */

  ipcMain.handle('plugin-market:list-sources', (event) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() => service().listSources());
  });
  ipcMain.handle('plugin-market:add-source', (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    const obj = requireObject(payload);
    const source = requireString(obj.source, 'source');
    if (source.length > 512) throwIpcError('INVALID_PARAMS', 'source is too long');
    const ref =
      obj.ref === undefined || obj.ref === null
        ? undefined
        : requireString(obj.ref, 'ref');
    if (ref !== undefined && ref.length > 128) {
      throwIpcError('INVALID_PARAMS', 'ref is too long');
    }
    let sparsePaths: string[] | undefined;
    if (obj.sparsePaths !== undefined && obj.sparsePaths !== null) {
      if (!Array.isArray(obj.sparsePaths) || obj.sparsePaths.length > 32) {
        throwIpcError('INVALID_PARAMS', 'sparsePaths must be an array of at most 32 entries');
      }
      sparsePaths = obj.sparsePaths.map((entry) => {
        const value = requireString(entry, 'sparsePaths entry');
        if (value.length > 256) throwIpcError('INVALID_PARAMS', 'sparsePaths entry is too long');
        return value;
      });
    }
    // 本地目录不接受 Renderer 直传的绝对路径:XSS 控制下的 Renderer 自报路径
    // 不构成用户授权(frame 校验只证明来源窗口,不证明用户选择了这个目录)。
    // 本地来源一律走 pick-local-source(Main 原生目录选择器,选择即授权)。
    const parsed = parseMarketSource(
      { source, ...(ref !== undefined ? { ref } : {}), ...(sparsePaths !== undefined ? { sparsePaths } : {}) },
      os.homedir(),
    );
    if (parsed.ok && parsed.source.type === 'local') {
      throwIpcError('INVALID_PARAMS', 'Local folders must be added via the directory picker');
    }
    return invokePluginMarket(() =>
      service().addSource({
        source,
        ...(ref !== undefined ? { ref } : {}),
        ...(sparsePaths !== undefined ? { sparsePaths } : {}),
      }),
    );
  });
  ipcMain.handle('plugin-market:pick-local-source', (event, defaultPath: unknown) => {
    assertTrustedAppRendererEvent(event);
    const hint =
      defaultPath === undefined || defaultPath === null
        ? undefined
        : requireString(defaultPath, 'defaultPath');
    if (hint !== undefined && hint.length > 512) {
      throwIpcError('INVALID_PARAMS', 'defaultPath is too long');
    }
    // 授权来自用户在 Main 原生选择器里的选择;hint 只影响初始定位。
    return invokePluginMarket(() => service().addLocalSourceFromPicker(hint));
  });
  ipcMain.handle('plugin-market:remove-source', (event, name: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() =>
      service().removeSource(requireString(name, 'name')),
    );
  });
  ipcMain.handle('plugin-market:refresh-source', (event, name: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() =>
      service().refreshSource(requireString(name, 'name')),
    );
  });
  ipcMain.handle('plugin-market:git-preflight', (event) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() => service().gitPreflight());
  });
}
