import { ipcMain } from 'electron';

import { isIpcError } from '../../shared/ipc-errors.js';
import { isValidGhostId } from '../../shared/ghost.js';
import {
  isPluginMarketInstallOperationId,
  MEKA_PLUGIN_MARKET_INSTALL_PROGRESS_CHANNEL,
  type PluginMarketInstallProgress,
} from '../../shared/pluginMarket.js';
import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { getGhostManager, setGhostUninstallLedgerPreparer } from '../cindy-brain/index.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireString, throwIpcError } from '../utils/ipcValidate.js';
import { MekaPluginMarketApi } from './api.js';
import { PluginChannelLedger } from './channelLedger.js';
import { PluginMarketLedger } from './ledger.js';
import { resolveMekaPluginMaxDownloadBytes } from './mekaDownloadPolicy.js';
import { PluginMarketService } from './service.js';

const log = createLogger('plugin-market-ipc');
let registered = false;
let serviceSingleton: PluginMarketService | null = null;
let mekaServiceSingleton: PluginMarketService | null = null;

function requireInstallOperationId(value: unknown): string {
  if (!isPluginMarketInstallOperationId(value)) {
    throwIpcError('INVALID_PARAMS', 'Invalid Plugin install operation ID');
  }
  return value;
}

function service(): PluginMarketService {
  serviceSingleton ??= new PluginMarketService();
  return serviceSingleton;
}

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
      // The two market services below apply the same stable-owner guard.
    }
    const completions = [
      service().prepareLocalUninstallTracking(ghostId),
      mekaService().prepareLocalUninstallTracking(ghostId),
    ].filter(
      (completion): completion is () => Promise<void> => completion !== null,
    );
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
    return invokePluginMarket(() => service().snapshot());
  });
  ipcMain.handle('plugin-market:detail', (event, pluginId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() =>
      service().detail(requireString(pluginId, 'pluginId')),
    );
  });
  ipcMain.handle(
    'plugin-market:install',
    (event, pluginId: unknown, options: unknown) => {
      assertTrustedAppRendererEvent(event);
      const obj =
        typeof options === 'object' && options !== null
          ? (options as {
              expectedReleaseId?: unknown;
              allowPermissionExpansion?: unknown;
            })
          : null;
      const expectedReleaseId = requireString(obj?.expectedReleaseId, 'expectedReleaseId');
      const allowPermissionExpansion = obj?.allowPermissionExpansion === true;
      return invokePluginMarket(() =>
        service().install(requireString(pluginId, 'pluginId'), {
          expectedReleaseId,
          allowPermissionExpansion,
        }),
      );
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

  ipcMain.handle('meka-plugin-market:snapshot', (event) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() => mekaService().snapshot());
  });
  ipcMain.handle('meka-plugin-market:installed-ghost-ids', (event) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(async () => {
      const capturedChannelLedger = captureChannelLedger();
      const marketGhostIds = await mekaService().installedGhostIds();
      return [
        ...new Set([
          ...marketGhostIds,
          ...capturedChannelLedger.readMekaGhostIds(),
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
              allowPermissionExpansion?: unknown;
              operationId?: unknown;
            })
          : null;
      const normalizedPluginId = requireString(pluginId, 'pluginId');
      const expectedReleaseId = requireString(obj?.expectedReleaseId, 'expectedReleaseId');
      const allowPermissionExpansion = obj?.allowPermissionExpansion === true;
      const operationId = requireInstallOperationId(obj?.operationId);
      const sender = event.sender;
      return invokePluginMarket(() =>
        mekaService().install(normalizedPluginId, {
          expectedReleaseId,
          allowPermissionExpansion,
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
}
