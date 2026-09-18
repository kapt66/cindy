import os from 'node:os';

import { ipcMain } from 'electron';

import { isIpcError } from '../../shared/ipc-errors.js';
import {
  isGhostInstallApprovalToken,
  isValidGhostId,
  type GhostManifest,
} from '../../shared/ghost.js';
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
import { PluginMarketLedger } from './ledger.js';
import { LocalIconRequestGate } from './localIconRequestGate.js';
import { resolveMekaPluginMaxDownloadBytes } from './mekaDownloadPolicy.js';
import {
  getPluginMarketService as service,
  PluginMarketService,
  type PluginMarketSnapshotOptions,
} from './service.js';

const log = createLogger('plugin-market-ipc');
let registered = false;
const REMOVAL_NOTICE_AVAILABLE_CHANNEL = 'plugin-market:removal-notice-available';
const localIconRequestGate = new LocalIconRequestGate();
let mekaServiceSingleton: PluginMarketService | null = null;

/**
 * Meka keeps its own market identity: a separate server API surface, a separate
 * installation ledger and its own download ceiling, and it never adopts legacy
 * installations or applies the upstream default-install set.
 * Cindy 的目录页 / 后台对账 / Agent 调用继续共用上游 `getPluginMarketService()`。
 */
function mekaService(): PluginMarketService {
  mekaServiceSingleton ??= new PluginMarketService(
    new MekaPluginMarketApi(),
    new PluginMarketLedger(() =>
      ownerScopedUserDataPath('plugin-market', 'meka-ledger.v1.json'),
    ),
    {
      adoptLegacyInstallations: false,
      applyDefaultInstalls: false,
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
 * as soon as an app owner is ready. The Plugins page remains a later retry path.
 */
export type DefaultMarketPluginSyncOutcome = 'completed' | 'deferred' | 'failed';

export function defaultMarketPluginSyncOutcome(
  snapshot: PluginMarketSnapshot,
  reconciliationOutcome: 'completed' | 'failed' = 'completed',
): DefaultMarketPluginSyncOutcome {
  if (
    (snapshot.unavailableReason === null || snapshot.unavailableReason === 'not-configured')
    && reconciliationOutcome === 'completed'
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

export async function syncDefaultMarketPlugins(): Promise<DefaultMarketPluginSyncOutcome> {
  try {
    let reconciliationOutcome: 'completed' | 'failed' | null = null;
    const snapshot = await snapshotAndSignalRemovalNotice({
      onDefaultReconciliationOutcome: (outcome) => {
        reconciliationOutcome = outcome;
      },
    });
    const outcome = defaultMarketPluginSyncOutcome(
      snapshot,
      reconciliationOutcome ?? 'completed',
    );
    if (outcome === 'failed') {
      log.warn('default plugin startup sync incomplete', {
        unavailableReason: snapshot.unavailableReason,
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
  setGhostUninstallLedgerPreparer((ghostId) => {
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
        deferReconciliation: true,
      }),
    );
  });
  ipcMain.handle('plugin-market:consume-removal-notice', (event) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(async () => service().consumeRemovalNotice());
  });
  ipcMain.handle('plugin-market:detail', (event, pluginId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() =>
      service().detail(requireString(pluginId, 'pluginId')),
    );
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
          .map((g) => g.manifest.id),
      );
      return invokePluginMarket(async () => {
        const result = await service().install(requireString(pluginId, 'pluginId'), {
          expectedReleaseId,
          ...(expectedInstalledApproval !== undefined ? { expectedInstalledApproval } : {}),
          ...(expectedManifest !== undefined ? { expectedManifest } : {}),
          allowSourceReplacement,
        });
        if (
          getActiveAppSession().generation === owner.generation &&
          !previouslyInstalled.has(result.ghost.manifest.id)
        ) {
          try {
            markGhostRecommendationInstalled(result.ghost.manifest.id);
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
        mekaService().install(normalizedPluginId, {
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
        }),
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
