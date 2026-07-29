/**
 * Side-effect-free watcher-host singleton.
 *
 * Keeping lifecycle registration out of this module lets main-process modules
 * import the singleton under partial Electron test mocks. bootstrap-electron
 * owns disposal from the real app before-quit lifecycle.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { utilityProcess } from 'electron';

import { createLogger } from '../logger.js';
import { WatcherHostClient } from './WatcherHostClient.js';
import { WATCHER_HOST_ENV_PARCEL_MODULE } from './protocol.js';

const log = createLogger('watcher-host');
const _require = createRequire(__filename);

function resolveParcelModulePath(): string | undefined {
  try {
    return _require.resolve('@parcel/watcher');
  } catch (err) {
    log.warn('resolve @parcel/watcher from main failed, host will bare-require', err);
    return undefined;
  }
}

function forkWatcherHost(): ReturnType<typeof utilityProcess.fork> {
  const entry = path.join(__dirname, 'watcherHostProcess.js');
  const parcelModulePath = resolveParcelModulePath();
  const child = utilityProcess.fork(entry, [], {
    serviceName: 'xdt-watcher-host',
    env: {
      ...process.env,
      ...(parcelModulePath ? { [WATCHER_HOST_ENV_PARCEL_MODULE]: parcelModulePath } : {}),
    },
  });
  log.info(`watcher host forked: ${entry}`);
  return child;
}

/** main 进程全局唯一的 watcher host client。 */
export const watcherHostClient = new WatcherHostClient({
  fork: forkWatcherHost,
  log,
});
