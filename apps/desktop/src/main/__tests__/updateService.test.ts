import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_CDN_BASE_URL as CDN_EXTERNAL_BASE_URL } from '../../test/vitest/clientEndpointsFixture';
// Meka 不变量: 更新器产物名固定为 `cindy-meka-updater`(见 brandIdentity.ts)。
// 上游测试硬编码了上游渠道名, 这里必须按产品身份取名字, 不能用字面量。
import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';

const originalPlatform = process.platform;
const originalArch = process.arch;
let TEST_ROOT: string;
let TEST_USER_DATA: string;
let TEST_EXE: string;

const browserWindowGetAllWindows = vi.fn(() => []);
const ipcMainHandle = vi.fn();
const ipcMainOn = vi.fn();
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcListeners = new Map<string, (...args: unknown[]) => unknown>();
const powerMonitorGetSystemIdleState = vi.fn(() => 'idle');
const powerMonitorGetSystemIdleTime = vi.fn(() => 600);
const powerMonitorOn = vi.fn();
const powerMonitorRemoveListener = vi.fn();
const appGetVersion = vi.fn(() => '0.0.64');
const appRelaunch = vi.fn();
const appQuit = vi.fn();
const appGetAppPath = vi.fn(() => path.join(TEST_ROOT, 'Cindy.app', 'Contents', 'Resources', 'app.asar'));
const appIsInApplicationsFolder = vi.fn(() => true);
const appGetPath = vi.fn((name: string) => {
  if (name === 'userData') return TEST_USER_DATA;
  if (name === 'exe') return TEST_EXE;
  return TEST_ROOT;
});
const fetchManifest = vi.fn();
const getBaseUrl = vi.fn(() => CDN_EXTERNAL_BASE_URL);
const isDev = vi.fn(() => false);
const syncWindowsVersionAfterUpdate = vi.fn(async () => undefined);
const download = vi.fn();
const readAutoUpdateSettings = vi.fn(() => ({ autoRelaunchOnIdle: true }));
const spawnProcess = vi.fn(() => ({
  unref: vi.fn(),
  on: vi.fn(),
}));
const findLinuxUserInstallation = vi.fn(() => null);
const isDebianManagedInstallation = vi.fn(() => false);
const missingLinuxUserInstallTools = vi.fn(() => [] as string[]);
vi.mock('../linuxInstallation', () => ({
  findLinuxUserInstallation, isDebianManagedInstallation, missingLinuxUserInstallTools,
}));
const checkWindowsUpdaterPrerequisites = vi.fn<
  () => { satisfied: boolean; missingFiles: string[] }
>(() => ({
  satisfied: true,
  missingFiles: [],
}));
const stageBundledWindowsUpdaterRuntime = vi.fn<
  () => 'staged' | 'fallback-safe' | 'blocked'
>(() => 'staged');

const logInfo = vi.fn();
const logWarn = vi.fn();
const logError = vi.fn();
const logDebug = vi.fn();

vi.mock('electron', () => ({
  app: {
    getVersion: appGetVersion,
    getPath: appGetPath,
    relaunch: appRelaunch,
    quit: appQuit,
    getAppPath: appGetAppPath,
    isPackaged: true,
    isInApplicationsFolder: appIsInApplicationsFolder,
    moveToApplicationsFolder: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: browserWindowGetAllWindows,
  },
  ipcMain: {
    handle: ipcMainHandle,
    on: ipcMainOn,
  },
  powerMonitor: {
    getSystemIdleState: powerMonitorGetSystemIdleState,
    getSystemIdleTime: powerMonitorGetSystemIdleTime,
    on: powerMonitorOn,
    removeListener: powerMonitorRemoveListener,
  },
}));

vi.mock('../auto-update-settings-store', () => ({
  readAutoUpdateSettings,
  readAutoUpdateSettingsState: () => ({
    value: readAutoUpdateSettings(),
    isCustomized: true,
    defaults: { autoRelaunchOnIdle: false },
  }),
  resetAutoUpdateSettings: () => ({ autoRelaunchOnIdle: false }),
  writeAutoRelaunchOnIdle: vi.fn(),
}));

const tryEnableUncustomizedBetaAtomic = vi.fn(async () => true);
const writeEnableBeta = vi.fn(async () => undefined);
const readUpdateChannelSettings = vi.fn(() => ({
  enableBeta: false,
  orgDefaultEnableBeta: false,
}));

vi.mock('../manifestService', () => ({
  fetchManifest,
  getBaseUrl,
  isDev,
  clearCachedManifest: vi.fn(),
}));

vi.mock('../updateChannelStore', () => ({
  readUpdateChannelSettings,
  readUpdateChannelSettingsState: () => ({
    value: readUpdateChannelSettings(),
    isCustomized: false,
    customizedKeys: [],
    defaults: { enableBeta: false, orgDefaultEnableBeta: false },
  }),
  resetUpdateChannelSettings: () => ({ enableBeta: false, orgDefaultEnableBeta: false }),
  writeEnableBeta,
  tryEnableUncustomizedBetaAtomic,
  isEnableBetaUserCustomized: () => false,
  isBetaChannelEnabled: () => readUpdateChannelSettings().enableBeta === true,
}));

vi.mock('../downloader/index', () => ({
  download,
  DownloadError: class DownloadError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

// cindy-brain/index 的真身会拖进 authManager→node-machine-id 等平台相关
// 模块图;本套测试会伪造 process.platform,真加载会在非 Windows 上炸
// spawnSync cmd.exe。updateService 只用 destroyAll,按需给最小假身。
vi.mock('../cindy-brain/index', () => ({
  getGhostNodeRuntimeBroker: () => ({ destroyAll: vi.fn() }),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnProcess,
  };
});

vi.mock('../windowsUpdaterPrerequisites', () => ({
  WINDOWS_UPDATER_RUNTIME_MISSING_ERROR_CODE: 'windows_vc_runtime_missing',
  WINDOWS_UPDATER_RUNTIME_FILES: ['vcruntime140.dll', 'vcruntime140_1.dll'],
  checkWindowsUpdaterPrerequisites,
  stageBundledWindowsUpdaterRuntime,
}));

vi.mock('../windowsInstallationVersion', async (importOriginal) => ({
  ...await importOriginal<typeof import('../windowsInstallationVersion')>(),
  syncWindowsVersionAfterUpdate,
}));

vi.mock('../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));


vi.mock('../logger', () => ({
  createLogger: () => ({
    info: logInfo,
    warn: logWarn,
    error: logError,
    debug: logDebug,
  }),
  maskPath: (value: string) => value,
}));

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function setArch(value: string): void {
  Object.defineProperty(process, 'arch', { value, configurable: true });
}

async function freshUpdateService(platform: NodeJS.Platform, arch: string = originalArch) {
  vi.resetModules();
  setPlatform(platform);
  setArch(arch);
  return import('../updateService');
}

function resetUpdateServiceFixture() {
  if (TEST_ROOT) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-maker-update-service-test-'));
  TEST_USER_DATA = path.join(TEST_ROOT, 'user-data');
  TEST_EXE = path.join(TEST_ROOT, 'app', 'xdt-maker.exe');
  fs.mkdirSync(TEST_USER_DATA, { recursive: true });
  fs.mkdirSync(path.dirname(TEST_EXE), { recursive: true });
}

beforeAll(() => {
  resetUpdateServiceFixture();
});
afterAll(() => {
  if (!TEST_ROOT) return;
  fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
beforeEach(() => {
  // Own every startup/background timer so afterEach can cancel it before the
  // app.getPath mock starts pointing at the next test's isolated fixture.
  // stopUpdateService clears intervals but not the initial 10-second check.
  vi.useFakeTimers();
  syncWindowsVersionAfterUpdate.mockClear();
  browserWindowGetAllWindows.mockReset();
  browserWindowGetAllWindows.mockReturnValue([]);
  ipcHandlers.clear();
  ipcListeners.clear();
  ipcMainHandle.mockReset();
  ipcMainHandle.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcHandlers.set(channel, handler);
  });
  ipcMainOn.mockReset();
  ipcMainOn.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcListeners.set(channel, handler);
  });
  powerMonitorGetSystemIdleState.mockReset();
  powerMonitorGetSystemIdleState.mockReturnValue('idle');
  powerMonitorGetSystemIdleTime.mockReset();
  powerMonitorGetSystemIdleTime.mockReturnValue(600);
  powerMonitorOn.mockReset();
  powerMonitorRemoveListener.mockReset();
  appGetVersion.mockReset();
  appGetVersion.mockReturnValue('0.0.64');
  appRelaunch.mockReset();
  appQuit.mockReset();
  appIsInApplicationsFolder.mockReset();
  appIsInApplicationsFolder.mockReturnValue(true);
  appGetPath.mockReset();
  appGetPath.mockImplementation((name: string) => {
    if (name === 'userData') return TEST_USER_DATA;
    if (name === 'exe') return TEST_EXE;
    return TEST_ROOT;
  });
  fetchManifest.mockReset();
  getBaseUrl.mockReset();
  getBaseUrl.mockReturnValue(CDN_EXTERNAL_BASE_URL);
  isDev.mockReset();
  isDev.mockReturnValue(false);
  download.mockReset();
  tryEnableUncustomizedBetaAtomic.mockReset();
  tryEnableUncustomizedBetaAtomic.mockResolvedValue(true);
  writeEnableBeta.mockReset();
  writeEnableBeta.mockResolvedValue(undefined);
  readUpdateChannelSettings.mockReset();
  readUpdateChannelSettings.mockReturnValue({
    enableBeta: false,
    orgDefaultEnableBeta: false,
  });
  readAutoUpdateSettings.mockReset();
  readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: true });
  spawnProcess.mockClear();
  findLinuxUserInstallation.mockReset();
  findLinuxUserInstallation.mockReturnValue(null);
  isDebianManagedInstallation.mockReset();
  isDebianManagedInstallation.mockReturnValue(false);
  missingLinuxUserInstallTools.mockReset();
  missingLinuxUserInstallTools.mockReturnValue([]);
  checkWindowsUpdaterPrerequisites.mockReset();
  checkWindowsUpdaterPrerequisites.mockReturnValue({
    satisfied: true,
    missingFiles: [],
  });
  stageBundledWindowsUpdaterRuntime.mockReset();
  stageBundledWindowsUpdaterRuntime.mockReturnValue('staged');
  logInfo.mockReset();
  logWarn.mockReset();
  logError.mockReset();
  logDebug.mockReset();
  resetUpdateServiceFixture();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  setPlatform(originalPlatform);
  setArch(originalArch);
});

describe.sequential('updateService', () => {
describe('installation version repair scope', () => {
  // 这几条是**首次**为 updateService 模块图付 `vi.resetModules()` + 重新 import 的代价，
  // 而且导入发生在 beforeEach 已经 `vi.useFakeTimers()` 之后（fake timers 下的动态 import
  // 会走定时器驱动的调度，明显更慢）。空载实测首条 >5s，第八个 worker 的满载机器上会撞上
  // 全局 20s 默认上限，表现为一条 `FAIL … does not add metadata work to darwin startup` 的
  // 超时（不是断言失败）。这里给显式预算，避免用 22 分钟的整仓重试去兜一条首导入成本很高的
  // 用例。同文件后续用例因模块图已热，只需默认值。
  const MODULE_GRAPH_IMPORT_TIMEOUT_MS = 120_000;

  it.each(['darwin', 'linux'] as const)('does not add metadata work to %s startup', async (platform) => {
    const service = await freshUpdateService(platform);
    service.initUpdateService();
    expect(syncWindowsVersionAfterUpdate).not.toHaveBeenCalled();
    service.stopUpdateService();
  }, MODULE_GRAPH_IMPORT_TIMEOUT_MS);

  it('does not touch Windows development installations', async () => {
    const service = await freshUpdateService('win32');
    isDev.mockReturnValue(true);
    service.initUpdateService();
    expect(syncWindowsVersionAfterUpdate).not.toHaveBeenCalled();
    service.stopUpdateService();
  }, MODULE_GRAPH_IMPORT_TIMEOUT_MS);

  it('checks only the current Windows install and its existing update receipt', async () => {
    const service = await freshUpdateService('win32');
    service.initUpdateService();
    expect(syncWindowsVersionAfterUpdate).toHaveBeenCalledOnce();
    expect(syncWindowsVersionAfterUpdate).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'win32', packaged: true, version: appGetVersion(), exePath: TEST_EXE,
      patchInfoPath: path.join(TEST_USER_DATA, 'updates', 'patch-info.json'),
    }));
    service.stopUpdateService();
  });
});

describe('binary version checks after a user-requested update', () => {
  beforeEach(() => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });
  });

  it('writes the target-version marker only when the user actually applies the update', async () => {
    const service = await freshUpdateService('darwin');
    const { consumeStartupBinaryUpdateMarker } = await import('../agent-binaries/startup-update');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest())).resolves.toBe('ready');
      const markerPath = path.join(TEST_USER_DATA, 'agent-binary-update-once.json');
      expect(fs.existsSync(markerPath)).toBe(false);
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      await vi.waitFor(() => { expect(spawnProcess).toHaveBeenCalledOnce(); });
      expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toMatchObject({ version: '0.0.65' });
      expect(consumeStartupBinaryUpdateMarker(TEST_USER_DATA, '0.0.65')).toBe(true);
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(consumeStartupBinaryUpdateMarker(TEST_USER_DATA, '0.0.65')).toBe(false);
    } finally {
      service.stopUpdateService();
      exitSpy.mockRestore();
    }
  });

  it('does not write the marker for an automatic update relaunch', async () => {
    const service = await freshUpdateService('darwin');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    service.initUpdateService();
    try {
      await service.checkForUpdate(updateManifest());
      await expect(ipcHandlers.get('update-relaunch-auto')?.({}, 'dark')).resolves.toMatchObject({ accepted: true });
      await vi.waitFor(() => { expect(spawnProcess).toHaveBeenCalledOnce(); });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'agent-binary-update-once.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
      exitSpy.mockRestore();
    }
  });

  it('does not write the marker when Windows updater prerequisites block applying', async () => {
    const service = await freshUpdateService('win32');
    checkWindowsUpdaterPrerequisites.mockReturnValue({ satisfied: false, missingFiles: ['vcruntime140.dll'] });
    service.initUpdateService();
    try {
      await service.checkForUpdate(updateManifest());
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'agent-binary-update-once.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('clears the marker when the Windows updater reports an asynchronous spawn error', async () => {
    const service = await freshUpdateService('win32');
    const resourcesPath = path.join(TEST_ROOT, 'resources');
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(path.join(resourcesPath, `${BRAND_IDENTITY.updaterName}.exe`), 'updater');
    const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true });
    const tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(TEST_ROOT);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const childListeners = new Map<string, (...args: unknown[]) => void>();
    spawnProcess.mockImplementationOnce(() => ({
      unref: vi.fn(),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => { childListeners.set(event, listener); }),
    }));
    service.initUpdateService();
    try {
      await service.checkForUpdate(updateManifest());
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      await vi.waitFor(() => { expect(childListeners.has('error')).toBe(true); });
      const [, updaterArgs, updaterOptions] = spawnProcess.mock.calls.at(-1)! as unknown as [string, string[], { env: Record<string, string> }];
      expect(updaterArgs).not.toContain('--install-key');
      expect(updaterOptions.env.CINDY_VERSION_SYNC_KEY).toMatch(/^[0-9a-f-]{36}$/);
      const markerPath = path.join(TEST_USER_DATA, 'agent-binary-update-once.json');
      expect(fs.existsSync(markerPath)).toBe(true);
      childListeners.get('error')?.(Object.assign(new Error('spawn denied'), { code: 'EACCES' }));
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(service.getUpdateStatus()).toBe('error');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      service.stopUpdateService();
      tmpdirSpy.mockRestore();
      exitSpy.mockRestore();
      if (resourcesDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesDescriptor);
      else Reflect.deleteProperty(process, 'resourcesPath');
    }
  });

  it('removes the marker when spawning the updater fails', async () => {
    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      await service.checkForUpdate(updateManifest());
      spawnProcess.mockImplementationOnce(() => {
        expect(fs.existsSync(path.join(TEST_USER_DATA, 'agent-binary-update-once.json'))).toBe(true);
        throw new Error('updater spawn failed');
      });
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      await vi.waitFor(() => { expect(service.getUpdateStatus()).toBe('error'); });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'agent-binary-update-once.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });
});

function updateManifest(version = '0.0.65', hotfixFile?: string) {
  return {
    app: {
      version,
      hotfix: {
        file: hotfixFile ?? `app/darwin-arm64/xdt-maker-${version}.zip`,
        sha256: 'a'.repeat(64),
        size: 123,
      },
    },
    claudeCode: {
      version: '1.0.0',
      file: 'claude-code/1.0.0/darwin-arm64/claude.gz',
      sha256: 'def',
      size: 456,
    },
  };
}

async function runStartupUpdate(
  options: {
    idleState?: 'active' | 'idle' | 'locked' | 'unknown';
    enabled?: boolean;
    busy?: boolean;
    platform?: NodeJS.Platform;
  } = {},
) {
  vi.useFakeTimers();
  powerMonitorGetSystemIdleState.mockReturnValue(options.idleState ?? 'idle');
  readAutoUpdateSettings.mockReturnValue({
    autoRelaunchOnIdle: options.enabled ?? true,
  });
  fetchManifest.mockResolvedValue(
    options.platform === 'linux' ? linuxInstallerManifest() : updateManifest(),
  );
  download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
    fs.mkdirSync(path.join(TEST_USER_DATA, 'updates'), { recursive: true });
    fs.writeFileSync(targetPath, 'update');
    return { path: targetPath, size: 123 };
  });

  const service = await freshUpdateService(options.platform ?? 'darwin');
  if (options.busy) service.setUpdateAutoRelaunchBusyProbe(() => true);
  service.initUpdateService();
  const handler = ipcHandlers.get('update-check-startup');
  if (!handler) throw new Error('update-check-startup handler not registered');
  try {
    return await handler();
  } finally {
    service.stopUpdateService();
  }
}

function linuxInstallerManifest(version = '0.0.65') {
  return {
    app: {
      version,
      installer: {
        file: `app/linux-x64/cindy-${version}-amd64.deb`,
        sha256: 'abc',
        size: 123,
      },
    },
  };
}

describe('checkForUpdate Linux installer flow', () => {
  it('does not quit or increment attempts for an unmanaged Linux installation', async () => {
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'deb');
      return { path: targetPath, size: 123 };
    });
    const service = await freshUpdateService('linux', 'x64');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(linuxInstallerManifest())).resolves.toBe('ready');
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      await vi.waitFor(() => expect(ipcHandlers.get('update-get-status')?.()).toMatchObject({
        status: 'ready', errorCode: 'linux_installation_unsupported',
      }));
      const info = JSON.parse(fs.readFileSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'), 'utf8'));
      expect(info.applyAttempts).toBeUndefined();
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', info.fileName))).toBe(true);
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
      exitSpy.mockRestore();
    }
  });

  it('downloads the Linux installer .deb instead of a hotfix zip', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.join(TEST_USER_DATA, 'updates'), { recursive: true });
      fs.writeFileSync(targetPath, 'deb');
      return { path: targetPath, size: 123 };
    });
    const { checkForUpdate, getUpdateStatus } = await freshUpdateService('linux', 'x64');

    const result = await checkForUpdate(linuxInstallerManifest('9.9.9'));

    expect(result).toBe('ready');
    expect(getUpdateStatus()).toBe('ready');
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.[0]).toMatchObject({
      url: expect.stringContaining('cindy-9.9.9-amd64.deb'),
      sha256: 'abc',
    });
  });

  it('ignores a Linux hotfix zip and stays idle without an installer', async () => {
    const { checkForUpdate, getUpdateStatus } = await freshUpdateService('linux', 'x64');

    const result = await checkForUpdate({
      app: {
        version: '9.9.9',
        hotfix: {
          file: 'app/linux-x64/app.hotfix.zip',
          sha256: 'abc',
          size: 123,
        },
      },
    });

    expect(result).toBe('idle');
    expect(getUpdateStatus()).toBe('idle');
    expect(download).not.toHaveBeenCalled();
  });

  it('does not auto-apply a staged Linux .deb at startup', async () => {
    await expect(runStartupUpdate({ platform: 'linux' })).resolves.toMatchObject({
      hasUpdate: true,
      action: 'none',
      version: '0.0.65',
    });
  });

  it('allows the xd org beta default on Linux x64', async () => {
    tryEnableUncustomizedBetaAtomic.mockReset();
    tryEnableUncustomizedBetaAtomic.mockResolvedValue(true);
    const { enableUncustomizedBetaChannel } = await freshUpdateService('linux', 'x64');

    await expect(enableUncustomizedBetaChannel()).resolves.toBe(true);
    expect(tryEnableUncustomizedBetaAtomic).toHaveBeenCalledOnce();
  });

  it('refuses the xd org beta default on Linux arm64 without writing to disk', async () => {
    tryEnableUncustomizedBetaAtomic.mockReset();
    const { enableUncustomizedBetaChannel } = await freshUpdateService('linux', 'arm64');

    await expect(enableUncustomizedBetaChannel()).resolves.toBe(false);
    expect(tryEnableUncustomizedBetaAtomic).not.toHaveBeenCalled();
  });

  it('allows the beta channel setting to be written on Linux x64', async () => {
    const service = await freshUpdateService('linux', 'x64');
    service.initUpdateService();
    try {
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');

      await expect(
        setHandler?.({ sender: { id: 1 } }, { enableBeta: true }),
      ).resolves.toBeDefined();
      expect(writeEnableBeta).toHaveBeenCalledWith(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('rejects beta channel setting writes on Linux arm64', async () => {
    const service = await freshUpdateService('linux', 'arm64');
    service.initUpdateService();
    try {
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');

      await expect(
        setHandler?.({ sender: { id: 1 } }, { enableBeta: true }),
      ).rejects.toThrow('This build does not support the beta update channel');
      expect(writeEnableBeta).not.toHaveBeenCalled();
    } finally {
      service.stopUpdateService();
    }
  });

  it.each([
    { arch: 'x64', expected: true },
    { arch: 'arm64', expected: false },
  ])('reports a persisted beta setting correctly on Linux $arch', async ({ arch, expected }) => {
    readUpdateChannelSettings.mockReturnValue({
      enableBeta: true,
      orgDefaultEnableBeta: false,
    });
    const service = await freshUpdateService('linux', arch);
    service.initUpdateService();
    try {
      const getHandler = ipcHandlers.get('update-channel-settings-get');
      expect(getHandler).toBeTypeOf('function');

      expect(getHandler?.({ sender: { id: 1 } })).toMatchObject({ enableBeta: expected });
    } finally {
      service.stopUpdateService();
    }
  });
});

describe('checkForUpdate 版本无关(占位 0.0.0)打包豁免', () => {
  it('占位版本 0.0.0 时直接 idle,不拉 manifest 不下载(即便传入含热更的 manifest)', async () => {
    appGetVersion.mockReturnValue('0.0.0');
    const { checkForUpdate, getUpdateStatus } = await freshUpdateService('darwin');

    const result = await checkForUpdate(updateManifest('9.9.9'));

    expect(result).toBe('idle');
    expect(getUpdateStatus()).toBe('idle');
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('update-check-startup 同样豁免:即便本地残留已下好的 patch 也不触发 relaunch', async () => {
    // 版本无关包与正式版同 userData,updates/ 里可能残留正式版下好的 patch;
    // startup 快路径(manifest 拉不到 → 本地 patch 直接 relaunch)必须一并短路。
    appGetVersion.mockReturnValue('0.0.0');
    fetchManifest.mockResolvedValue(null);
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(path.join(updatesDir, 'stale.zip'), 'zip');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({ version: '9.9.9', fileName: 'stale.zip', sha256: 'abc' }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      if (!handler) throw new Error('update-check-startup handler not registered');
      const reply = (await handler()) as { hasUpdate: boolean; action: string };
      expect(reply.hasUpdate).toBe(false);
      expect(reply.action).toBe('none');
      expect(service.getUpdateStatus()).toBe('idle');
      expect(download).not.toHaveBeenCalled();
    } finally {
      service.stopUpdateService();
      fs.rmSync(updatesDir, { recursive: true, force: true });
    }
  });

  it('0.0.0-dev 形态同样豁免;真实版本不受影响', async () => {
    appGetVersion.mockReturnValue('0.0.0-dev');
    const service = await freshUpdateService('win32');
    expect(await service.checkForUpdate(updateManifest('9.9.9'))).toBe('idle');
    expect(download).not.toHaveBeenCalled();

    expect(service.isVersionlessAppVersion('0.0.0')).toBe(true);
    expect(service.isVersionlessAppVersion('0.0.0-dev')).toBe(true);
    expect(service.isVersionlessAppVersion('0.0.1')).toBe(false);
    expect(service.isVersionlessAppVersion('1.0.0')).toBe(false);
  });
});

describe('update version downgrade protection', () => {
  it('does not download when the manifest is older than the installed app', async () => {
    appGetVersion.mockReturnValue('1.2.3');
    const service = await freshUpdateService('darwin');

    await expect(service.checkForUpdate(updateManifest('1.2.2'))).resolves.toBe('idle');
    expect(download).not.toHaveBeenCalled();
    expect(service.getUpdateStatus()).toBe('idle');
  });

  it('fails closed when the manifest version is not strict SemVer', async () => {
    const service = await freshUpdateService('darwin');

    await expect(service.checkForUpdate(updateManifest('latest'))).resolves.toBe('manifest_failed');
    expect(download).not.toHaveBeenCalled();
  });

  it('offline startup discards an older staged patch instead of relaunching it', async () => {
    appGetVersion.mockReturnValue('1.2.3');
    fetchManifest.mockResolvedValue(null);
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(path.join(updatesDir, 'old.zip'), 'zip');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({ version: '1.2.2', fileName: 'old.zip', sha256: 'abc' }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      await expect(handler?.()).resolves.toMatchObject({
        hasUpdate: false,
        action: 'none',
      });
      expect(fs.existsSync(path.join(updatesDir, 'old.zip'))).toBe(false);
      expect(fs.existsSync(path.join(updatesDir, 'patch-info.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('channel rollback removes a staged newer patch before returning idle', async () => {
    appGetVersion.mockReturnValue('1.2.3');
    fetchManifest.mockResolvedValue(updateManifest('1.2.2'));
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(path.join(updatesDir, 'future.zip'), 'zip');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({ version: '1.2.4', fileName: 'future.zip', sha256: 'abc' }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      await expect(handler?.()).resolves.toMatchObject({
        hasUpdate: false,
        action: 'none',
      });
      expect(fs.existsSync(path.join(updatesDir, 'future.zip'))).toBe(false);
      expect(fs.existsSync(path.join(updatesDir, 'patch-info.json'))).toBe(false);
      expect(download).not.toHaveBeenCalled();
    } finally {
      service.stopUpdateService();
    }
  });
});

describe('app update forward-only policy', () => {
  it('does not download a manifest version lower than the running app', async () => {
    const service = await freshUpdateService('darwin');

    await expect(service.checkForUpdate(updateManifest('0.0.63'))).resolves.toBe('idle');

    expect(service.getUpdateStatus()).toBe('idle');
    expect(download).not.toHaveBeenCalled();
    expect(logWarn.mock.calls.map((call) => String(call[0]))).toContain(
      'Skipping app downgrade from %s to %s',
    );
  });

  it('fails closed when the manifest app version is not valid SemVer', async () => {
    const service = await freshUpdateService('darwin');

    await expect(service.checkForUpdate(updateManifest('not-semver'))).resolves.toBe(
      'manifest_failed',
    );

    expect(service.getUpdateStatus()).toBe('idle');
    expect(download).not.toHaveBeenCalled();
  });

  it.each(['0.0.63', 'not-semver'])(
    'does not apply an offline non-upgrade staged patch (%s)',
    async (patchVersion) => {
      vi.useFakeTimers();
      fetchManifest.mockResolvedValue(null);
      const updatesDir = path.join(TEST_USER_DATA, 'updates');
      const patchPath = path.join(updatesDir, 'staged.zip');
      const flagPath = path.join(TEST_USER_DATA, 'relogin-required.flag');
      fs.mkdirSync(updatesDir, { recursive: true });
      fs.writeFileSync(patchPath, 'update');
      fs.writeFileSync(
        path.join(updatesDir, 'patch-info.json'),
        JSON.stringify({
          version: patchVersion,
          fileName: 'staged.zip',
          sha256: 'abc',
          requireRelogin: true,
          enableBeta: false,
        }),
      );
      fs.writeFileSync(flagPath, JSON.stringify({ version: patchVersion }));

      const service = await freshUpdateService('darwin');
      service.initUpdateService();
      try {
        const handler = ipcHandlers.get('update-check-startup');
        await expect(handler?.()).resolves.toMatchObject({
          hasUpdate: false,
          action: 'none',
          error: 'manifest_failed',
        });
        expect(service.getUpdateStatus()).toBe('idle');
        expect(fs.existsSync(patchPath)).toBe(false);
        expect(fs.existsSync(path.join(updatesDir, 'patch-info.json'))).toBe(false);
        expect(fs.existsSync(flagPath)).toBe(false);
      } finally {
        service.stopUpdateService();
      }
    },
  );

  it('still restores a newer staged patch when startup is offline', async () => {
    vi.useFakeTimers();
    fetchManifest.mockResolvedValue(null);
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    const patchPath = path.join(updatesDir, 'staged.zip');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(patchPath, 'update');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({
        version: '0.0.65',
        fileName: 'staged.zip',
        sha256: 'abc',
        enableBeta: false,
      }),
    );

    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      await expect(handler?.()).resolves.toMatchObject({
        hasUpdate: true,
        action: 'relaunch',
        version: '0.0.65',
      });
      expect(service.getUpdateStatus()).toBe('ready');
      expect(fs.existsSync(patchPath)).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('keeps an offline Windows patch but refuses to apply its persisted digest', async () => {
    vi.useFakeTimers();
    fetchManifest.mockResolvedValue(null);
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    const patchPath = path.join(updatesDir, 'staged.zip');
    const patchInfoPath = path.join(updatesDir, 'patch-info.json');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(patchPath, 'update');
    fs.writeFileSync(
      patchInfoPath,
      JSON.stringify({
        version: '0.0.65',
        fileName: 'staged.zip',
        sha256: 'f'.repeat(64),
        enableBeta: false,
      }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      await expect(handler?.()).resolves.toMatchObject({
        hasUpdate: false,
        action: 'none',
        error: 'manifest_failed',
      });
      expect(service.getUpdateStatus()).toBe('idle');
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(fs.existsSync(patchPath)).toBe(true);
      expect(fs.existsSync(patchInfoPath)).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('hashes staged Windows zips as a stream instead of one main-thread buffer', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'updateService.ts'),
      'utf8',
    );
    const start = source.indexOf('function windowsZipFileMatchesDigest');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 900);
    expect(body).toContain('createReadStream');
    expect(body).not.toMatch(/readFileSync\s*\(/);
    expect(body).not.toMatch(/readFile\s*\(/);
  });

  it('stops auto-applying a version whose durable attempt budget is spent', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    // A previous run handed this version to the updater three times. Its staged
    // ZIP is gone (the Windows updater moves it away on a retryable failure) and
    // patch-info.json is rewritten by every re-download, so only the durable
    // state can remember that this version is done.
    fs.writeFileSync(
      path.join(updatesDir, 'apply-state.json'),
      JSON.stringify({ version: '0.0.65', attempts: 3, abandoned: true }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      // A distinct result, not 'idle': the renderer must not answer a manual
      // "check for updates" with "you're on the latest version".
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe(
        'apply_exhausted',
      );
      expect(download).not.toHaveBeenCalled();
      expect(ipcHandlers.get('update-get-status')?.()).toMatchObject({
        status: 'error',
        errorCode: 'update_apply_exhausted',
      });
    } finally {
      service.stopUpdateService();
    }
  });

  it('gives a newly advertised version a fresh attempt budget', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(
      path.join(updatesDir, 'apply-state.json'),
      JSON.stringify({ version: '0.0.65', attempts: 3, abandoned: true }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      // 0.0.66 is a different target, so the spent budget for 0.0.65 must not
      // block it — otherwise one bad release would freeze the client forever.
      await expect(service.checkForUpdate(updateManifest('0.0.66'))).resolves.toBe('ready');
      expect(download).toHaveBeenCalledTimes(1);
    } finally {
      service.stopUpdateService();
    }
  });

  it('keeps the durable attempt counter across the re-download after a failure', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    // Two of three attempts already spent. The download that follows a failed
    // apply deletes every other file in `updates/` — if the cleanup dropped this
    // record, the counter would restart and the client would retry forever,
    // which is exactly the loop this record exists to break.
    fs.writeFileSync(
      path.join(updatesDir, 'apply-state.json'),
      JSON.stringify({ version: '0.0.65', attempts: 2 }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      expect(download).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(fs.readFileSync(path.join(updatesDir, 'apply-state.json'), 'utf8')),
      ).toEqual({ version: '0.0.65', attempts: 2 });
    } finally {
      service.stopUpdateService();
    }
  });

  it('gives up on a staged patch that hit the durable cap instead of re-downloading it', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const manifest = updateManifest('0.0.65', 'app/windows-x64/staged.zip');
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(path.join(updatesDir, 'staged.zip'), 'update');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({ version: '0.0.65', fileName: 'staged.zip', sha256: 'f'.repeat(64) }),
    );
    // patch-info.json carries no counter (the re-download path never writes one),
    // so the cap can only be observed through the durable state.
    fs.writeFileSync(
      path.join(updatesDir, 'apply-state.json'),
      JSON.stringify({ version: '0.0.65', attempts: 3 }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(manifest)).resolves.toBe('apply_exhausted');
      expect(download).not.toHaveBeenCalled();
      // The staged copy is dropped rather than handed to the updater a fourth time.
      expect(fs.existsSync(path.join(updatesDir, 'staged.zip'))).toBe(false);
      expect(fs.existsSync(path.join(updatesDir, 'patch-info.json'))).toBe(false);
      expect(
        JSON.parse(fs.readFileSync(path.join(updatesDir, 'apply-state.json'), 'utf8')),
      ).toMatchObject({ version: '0.0.65', attempts: 3, abandoned: true });
      expect(ipcHandlers.get('update-get-status')?.()).toMatchObject({
        status: 'error',
        errorCode: 'update_apply_exhausted',
      });
    } finally {
      service.stopUpdateService();
    }
  });

  it('mirrors each handed-off attempt into the durable apply state', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });
    const resourcesPath = path.join(TEST_ROOT, 'resources');
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(path.join(resourcesPath, `${BRAND_IDENTITY.updaterName}.exe`), 'updater');
    const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesPath,
      configurable: true,
    });
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const updaterWorkDir = path.join(os.tmpdir(), `cindy-update-${now}`);

    const service = await freshUpdateService('win32');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      const statePath = path.join(TEST_USER_DATA, 'updates', 'apply-state.json');
      await vi.waitFor(() => {
        expect(fs.existsSync(statePath)).toBe(true);
      });
      expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({
        version: '0.0.65',
        attempts: 1,
      });
    } finally {
      exitSpy.mockRestore();
      service.stopUpdateService();
      nowSpy.mockRestore();
      fs.rmSync(updaterWorkDir, { recursive: true, force: true });
      if (resourcesPathDescriptor) {
        Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor);
      } else {
        Reflect.deleteProperty(process, 'resourcesPath');
      }
    }
  });

  it('keeps another version staged patch intact when this version is exhausted', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    // A staged patch for a DIFFERENT version must not be collateral damage.
    fs.writeFileSync(path.join(updatesDir, 'other.zip'), 'other');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({ version: '0.0.66', fileName: 'other.zip', sha256: 'a'.repeat(64) }),
    );
    fs.writeFileSync(
      path.join(updatesDir, 'apply-state.json'),
      JSON.stringify({ version: '0.0.65', attempts: 3, abandoned: true }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe(
        'apply_exhausted',
      );
      expect(download).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(updatesDir, 'other.zip'))).toBe(true);
      const info = JSON.parse(
        fs.readFileSync(path.join(updatesDir, 'patch-info.json'), 'utf8'),
      ) as { version: string };
      expect(info.version).toBe('0.0.66');
    } finally {
      service.stopUpdateService();
    }
  });

  it('gives up on a version whose only remaining counter lives in patch-info', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const manifest = updateManifest('0.0.65', 'app/windows-x64/staged.zip');
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(path.join(updatesDir, 'staged.zip'), 'update');
    // No durable record at all: the gate must still see patch-info's counter,
    // otherwise the give-up branch fires below it and the same pass re-downloads.
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({
        version: '0.0.65',
        fileName: 'staged.zip',
        sha256: 'f'.repeat(64),
        applyAttempts: 3,
      }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(manifest)).resolves.toBe('apply_exhausted');
      expect(download).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(updatesDir, 'staged.zip'))).toBe(false);
      expect(fs.existsSync(path.join(updatesDir, 'patch-info.json'))).toBe(false);
      expect(
        JSON.parse(fs.readFileSync(path.join(updatesDir, 'apply-state.json'), 'utf8')),
      ).toMatchObject({ version: '0.0.65', attempts: 3, abandoned: true });
    } finally {
      service.stopUpdateService();
    }
  });

  it('clears a spent record once that version is what is installed', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    // The dialog sends users to a manual install, which never writes patch-info —
    // so without a cold-start reconcile the record would outlive its purpose.
    fs.writeFileSync(
      path.join(updatesDir, 'apply-state.json'),
      JSON.stringify({ version: '0.0.64', attempts: 3, abandoned: true }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      expect(fs.existsSync(path.join(updatesDir, 'apply-state.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('holds the spent-budget terminal state across polls and an offline check', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const statuses: string[] = [];
    browserWindowGetAllWindows.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: { status?: string }) => {
            if (channel === 'update-status' && payload.status) statuses.push(payload.status);
          },
        },
      } as never,
    ]);
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(
      path.join(updatesDir, 'apply-state.json'),
      JSON.stringify({ version: '0.0.65', attempts: 3, abandoned: true }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      const manifest = updateManifest('0.0.65');
      await expect(service.checkForUpdate(manifest)).resolves.toBe('apply_exhausted');
      statuses.length = 0;

      // Second poll on the same version must stay on the terminal state: the
      // renderer renders 'checking' as "nothing to follow" and unmounts the
      // manual-install dialog, so the next 'error' remounted it with a stale open
      // state — replaying the entrance animation and stealing focus onto the
      // primary button on every 30-minute poll.
      await expect(service.checkForUpdate(manifest)).resolves.toBe('apply_exhausted');
      expect(statuses).not.toContain('checking');
      expect(ipcHandlers.get('update-get-status')?.()).toMatchObject({
        status: 'error',
        errorCode: 'update_apply_exhausted',
      });

      // An offline poll must not silently drop main to 'idle' either: the renderer
      // would keep showing the terminal state, and the next successful poll would
      // re-broadcast 'checking' — the same tear-down and remount.
      fetchManifest.mockResolvedValue(null);
      await expect(service.checkForUpdate()).resolves.toBe('manifest_failed');
      expect(ipcHandlers.get('update-get-status')?.()).toMatchObject({
        status: 'error',
        errorCode: 'update_apply_exhausted',
      });
    } finally {
      service.stopUpdateService();
    }
  });

  it('releases the terminal state once the manifest stops advertising that version', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const statuses: string[] = [];
    browserWindowGetAllWindows.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: { status?: string }) => {
            if (channel === 'update-status' && payload.status) statuses.push(payload.status);
          },
        },
      } as never,
    ]);
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(
      path.join(updatesDir, 'apply-state.json'),
      JSON.stringify({ version: '0.0.65', attempts: 3, abandoned: true }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe(
        'apply_exhausted',
      );

      // The release must happen BEFORE the "manifest no longer advertises this
      // version" exits: those return early, so releasing afterwards left
      // status/errorCode/applyExhaustedVersion pinned for the rest of the process
      // (restart only) while `checkForUpdate` answered 'idle' — the dialog said
      // "install manually" and the toast said "already on the latest version".
      statuses.length = 0;
      await expect(service.checkForUpdate(updateManifest('0.0.64'))).resolves.toBe('idle');
      expect(statuses).toEqual(['idle']);
      expect(ipcHandlers.get('update-get-status')?.()).toMatchObject({ status: 'idle' });
      expect(ipcHandlers.get('update-get-status')?.()).not.toMatchObject({
        errorCode: 'update_apply_exhausted',
      });

      // ...and the next poll is a normal poll again, `checking` included.
      statuses.length = 0;
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe(
        'apply_exhausted',
      );
      expect(statuses).toContain('checking');
    } finally {
      service.stopUpdateService();
    }
  });

  it('keeps a spent record for another version and clears SemVer-equal installed forms', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    const statePath = path.join(updatesDir, 'apply-state.json');

    // Not the installed version → the budget still has to refuse that version.
    // (A guard against over-clearing rather than a regression test: reconcile never
    // removed other versions' records in the first place.)
    fs.writeFileSync(
      statePath,
      JSON.stringify({ version: '0.0.66', attempts: 3, abandoned: true }),
    );
    const otherVersion = await freshUpdateService('win32');
    otherVersion.initUpdateService();
    try {
      expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({ version: '0.0.66' });
    } finally {
      otherVersion.stopUpdateService();
    }

    // Same installed version written in a SemVer-equal form: `+build` metadata and
    // a `v` prefix both parse to 0.0.64, so string equality would leave the record
    // behind forever after a manual install.
    fs.writeFileSync(
      statePath,
      JSON.stringify({ version: '0.0.64+local', attempts: 3, abandoned: true }),
    );
    const sameVersion = await freshUpdateService('win32');
    sameVersion.initUpdateService();
    try {
      expect(fs.existsSync(statePath)).toBe(false);
    } finally {
      sameVersion.stopUpdateService();
    }
  });

  it('does not declare a spent version dead while its apply is still in flight', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    // One attempt short of the cap, so the hand-off below is the third one and the
    // budget is spent exactly while the updater is running.
    fs.writeFileSync(
      path.join(updatesDir, 'apply-state.json'),
      JSON.stringify({ version: '0.0.65', attempts: 2 }),
    );

    const service = await freshUpdateService('darwin');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      const statePath = path.join(updatesDir, 'apply-state.json');
      await vi.waitFor(() => {
        expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({ attempts: 3 });
      });

      // The budget is charged at hand-off, so "3 of 3 spent" includes the apply
      // running right now. Declaring the version dead here would pin a record the
      // apply is about to invalidate and tell the user to install by hand above an
      // update that may still succeed.
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      expect(service.getUpdateStatus()).toBe('ready');
      expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({
        version: '0.0.65',
        attempts: 3,
      });
      expect(logInfo.mock.calls.map((call) => String(call[0]))).toContain(
        'Update to v%s has spent its budget but an apply is in flight — deferring the give-up',
      );
    } finally {
      exitSpy.mockRestore();
      service.stopUpdateService();
    }
  });

  it('keeps counting hand-offs when the durable state file cannot be written', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    // Make every `atomicWriteFileSync` for the apply state fail deterministically: the
    // main file *and* its rollback snapshot are non-empty directories, so both the
    // rename and the backup swap are rejected. That is the shape of a file an AV/EDR
    // keeps locked: unreadable and unwritable for the whole session.
    fs.mkdirSync(path.join(updatesDir, 'apply-state.json', 'occupied'), { recursive: true });
    fs.mkdirSync(path.join(updatesDir, 'apply-state.json.bak', 'occupied'), { recursive: true });

    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      for (let round = 1; round <= 3; round += 1) {
        await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
        spawnProcess.mockImplementationOnce(() => {
          throw new Error('updater spawn failed');
        });
        ipcListeners.get('update-relaunch')?.({}, 'dark');
        await vi.waitFor(() => {
          expect(service.getUpdateStatus()).toBe('error');
        });
      }

      // Three hand-offs is the cap. Without the in-memory mirror the counter would
      // restart from the (unreadable) durable file on every round — each round would
      // count 1, the cap would never be reached, and the client would re-download the
      // full package forever, which is the defect this mechanism exists to stop.
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe(
        'apply_exhausted',
      );
      expect(download).toHaveBeenCalledTimes(3);
    } finally {
      service.stopUpdateService();
    }
  });

  it('keeps counting hand-offs when the durable state is readable but cannot be replaced', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    // Readable, but every replacement is refused — the shape an AV/EDR read-lock or a
    // read-only attribute produces. The value on disk therefore never advances while
    // the process keeps handing the update off.
    fs.writeFileSync(
      path.join(updatesDir, 'apply-state.json'),
      JSON.stringify({ version: '0.0.65', attempts: 1 }),
    );
    const realRename = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).includes('apply-state') || String(to).includes('apply-state')) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return realRename(from, to);
    }) as typeof fs.renameSync);

    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      // Two hand-offs: the first takes the counter from the stale on-disk 1 to 2, the
      // second to 3 — so the *next* check is the one that must give up.
      for (let round = 1; round <= 2; round += 1) {
        await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
        spawnProcess.mockImplementationOnce(() => {
          throw new Error('updater spawn failed');
        });
        ipcListeners.get('update-relaunch')?.({}, 'dark');
        await vi.waitFor(() => {
          expect(service.getUpdateStatus()).toBe('error');
        });
      }

      // The in-memory value must win over the stale-but-readable file: taking the file
      // whenever it is readable computes "1 + 1" on every round, so the cap is never
      // reached and the client re-downloads the whole package on each retry.
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe(
        'apply_exhausted',
      );
      expect(download).toHaveBeenCalledTimes(2);
      // The premise of this case, asserted rather than assumed: the file stayed
      // readable and never advanced, so every round really did read a stale 1. If a
      // future refactor replaces the atomic writer's `fs.renameSync` (this spy would
      // silently stop failing the write) the test would otherwise degrade into a copy
      // of the sibling case and keep passing.
      expect(
        JSON.parse(fs.readFileSync(path.join(updatesDir, 'apply-state.json'), 'utf8')),
      ).toMatchObject({ version: '0.0.65', attempts: 1 });
      expect(renameSpy).toHaveBeenCalled();
    } finally {
      renameSpy.mockRestore();
      service.stopUpdateService();
    }
  });

  it('ignores a durable record for another version when accumulating the budget', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    // Readable record for a DIFFERENT version, plus refused replacements: taking that
    // record as the increment's base (or dropping the mirror because the file "exists")
    // would restart the count at 1 on every round and put the cap out of reach again.
    fs.writeFileSync(
      path.join(updatesDir, 'apply-state.json'),
      JSON.stringify({ version: '0.0.66', attempts: 2 }),
    );
    const realRename = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).includes('apply-state') || String(to).includes('apply-state')) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return realRename(from, to);
    }) as typeof fs.renameSync);

    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      for (let round = 1; round <= 3; round += 1) {
        await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
        spawnProcess.mockImplementationOnce(() => {
          throw new Error('updater spawn failed');
        });
        ipcListeners.get('update-relaunch')?.({}, 'dark');
        await vi.waitFor(() => {
          expect(service.getUpdateStatus()).toBe('error');
        });
      }

      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe(
        'apply_exhausted',
      );
      expect(download).toHaveBeenCalledTimes(3);
    } finally {
      renameSpy.mockRestore();
      service.stopUpdateService();
    }
  });

  it('answers apply_exhausted when a held version has no asset or the channel changed', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(
      path.join(updatesDir, 'apply-state.json'),
      JSON.stringify({ version: '0.0.65', attempts: 3, abandoned: true }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      const withAsset = updateManifest('0.0.65');
      await expect(service.checkForUpdate(withAsset)).resolves.toBe('apply_exhausted');

      // Same held version, but this round's manifest has no hotfix asset. Answering
      // 'idle' here would toast "already on the latest version" above a dialog that
      // says the opposite.
      const withoutAsset = { app: { version: '0.0.65' } } as ReturnType<typeof updateManifest>;
      await expect(service.checkForUpdate(withoutAsset)).resolves.toBe('apply_exhausted');
      expect(service.getUpdateStatus()).toBe('error');

      // Cross-instance channel switch: `clearStagedPatch()` is silent in the error
      // state, so the terminal state is still displayed and must still be the answer.
      // The manifest deliberately advertises a DIFFERENT version here: if this early
      // return were deleted the flow would fall through, release v0.0.65 and download
      // v0.0.66 — so the assertions below cannot pass for the wrong reason.
      readUpdateChannelSettings.mockReturnValue({ enableBeta: true, orgDefaultEnableBeta: false });
      await expect(service.checkForUpdate(updateManifest('0.0.66'))).resolves.toBe(
        'apply_exhausted',
      );
      expect(service.getUpdateStatus()).toBe('error');
      expect(download).not.toHaveBeenCalled();
    } finally {
      service.stopUpdateService();
    }
  });

  it('clears a matching relogin flag when the startup path gives up on a spent version', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(path.join(updatesDir, 'staged.zip'), 'update');
    // No counter in patch-info: the cap is only visible through the durable state.
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({ version: '0.0.65', fileName: 'staged.zip', sha256: 'f'.repeat(64) }),
    );
    fs.writeFileSync(
      path.join(updatesDir, 'apply-state.json'),
      JSON.stringify({ version: '0.0.65', attempts: 3 }),
    );
    // A cold start reaches the give-up branch inside `checkExistingPatch` (the
    // download gate runs later), so both give-up paths must agree on the marker:
    // this version will never be launched, and a stale flag would force a re-login
    // after the manual install the dialog just asked for.
    const flagPath = path.join(TEST_USER_DATA, 'relogin-required.flag');
    fs.writeFileSync(flagPath, JSON.stringify({ version: '0.0.65' }));
    fetchManifest.mockResolvedValue(updateManifest('0.0.65', 'app/windows-x64/staged.zip'));

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      await expect(ipcHandlers.get('update-check-startup')?.()).resolves.toMatchObject({
        hasUpdate: false,
      });
      expect(fs.existsSync(flagPath)).toBe(false);
      expect(fs.existsSync(path.join(updatesDir, 'staged.zip'))).toBe(false);
      expect(fs.existsSync(path.join(updatesDir, 'patch-info.json'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(updatesDir, 'apply-state.json'), 'utf8')))
        .toMatchObject({ version: '0.0.65', attempts: 3, abandoned: true });
    } finally {
      service.stopUpdateService();
    }
  });

  it('neither downloads nor relaunches from the startup path once exhausted', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const manifest = updateManifest('0.0.65', 'app/windows-x64/staged.zip');
    fetchManifest.mockResolvedValue(manifest);
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(
      path.join(updatesDir, 'apply-state.json'),
      JSON.stringify({ version: '0.0.65', attempts: 3, abandoned: true }),
    );

    const service = await freshUpdateService('win32');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    service.initUpdateService();
    try {
      const startupHandler = ipcHandlers.get('update-check-startup');
      await expect(startupHandler?.()).resolves.toMatchObject({
        hasUpdate: false,
        action: 'none',
      });
      expect(download).not.toHaveBeenCalled();
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(ipcHandlers.get('update-get-status')?.()).toMatchObject({
        status: 'error',
        errorCode: 'update_apply_exhausted',
      });
    } finally {
      exitSpy.mockRestore();
      service.stopUpdateService();
    }
  });

  it('lets a later online check re-anchor an offline-ready Windows patch', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const stagedBytes = Buffer.from('update');
    const digest = createHash('sha256').update(stagedBytes).digest('hex');
    const manifest = updateManifest('0.0.65', 'app/windows-x64/staged.zip');
    manifest.app.hotfix.sha256 = digest;
    fetchManifest
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(manifest);
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(path.join(updatesDir, 'staged.zip'), stagedBytes);
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({
        version: '0.0.65',
        fileName: 'staged.zip',
        sha256: 'f'.repeat(64),
        enableBeta: false,
      }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      const startupHandler = ipcHandlers.get('update-check-startup');
      await expect(startupHandler?.()).resolves.toMatchObject({
        hasUpdate: false,
        action: 'none',
        error: 'manifest_failed',
      });

      const checkNowHandler = ipcHandlers.get('update-check-now');
      await expect(checkNowHandler?.()).resolves.toEqual({ result: 'ready' });
      expect(fetchManifest).toHaveBeenCalledTimes(2);
      expect(download).not.toHaveBeenCalled();
    } finally {
      service.stopUpdateService();
    }
  });

  it('redownloads a ready Windows patch when the same version is republished under a new filename', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const firstDigest = 'a'.repeat(64);
    const secondDigest = 'b'.repeat(64);
    const firstManifest = updateManifest('0.0.65', 'app/windows-x64/staged.zip');
    firstManifest.app.hotfix.sha256 = firstDigest;
    const secondManifest = updateManifest('0.0.65', 'app/windows-x64/cindy-0.0.65.zip');
    secondManifest.app.hotfix.sha256 = secondDigest;
    download.mockImplementation(async ({ targetPath, sha256 }: { targetPath: string; sha256: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, sha256 === firstDigest ? 'old-bytes' : 'new-bytes');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(firstManifest)).resolves.toBe('ready');
      expect(download).toHaveBeenCalledTimes(1);

      await expect(service.checkForUpdate(secondManifest)).resolves.toBe('ready');
      expect(download).toHaveBeenCalledTimes(2);
      expect(download.mock.calls[1]?.[0]).toMatchObject({ sha256: secondDigest });
      expect(fs.readFileSync(path.join(TEST_USER_DATA, 'updates', 'cindy-0.0.65.zip'), 'utf8')).toBe(
        'new-bytes',
      );
    } finally {
      service.stopUpdateService();
    }
  });

  it('redownloads a ready Windows patch when the same file is republished with a new digest', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const firstDigest = 'a'.repeat(64);
    const secondDigest = 'b'.repeat(64);
    const firstManifest = updateManifest('0.0.65', 'app/windows-x64/staged.zip');
    firstManifest.app.hotfix.sha256 = firstDigest;
    const secondManifest = updateManifest('0.0.65', 'app/windows-x64/staged.zip');
    secondManifest.app.hotfix.sha256 = secondDigest;
    download.mockImplementation(async ({ targetPath, sha256 }: { targetPath: string; sha256: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, sha256 === firstDigest ? 'old-bytes' : 'new-bytes');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(firstManifest)).resolves.toBe('ready');
      expect(download).toHaveBeenCalledTimes(1);
      const patchPath = path.join(TEST_USER_DATA, 'updates', 'staged.zip');
      expect(fs.readFileSync(patchPath, 'utf8')).toBe('old-bytes');

      await expect(service.checkForUpdate(secondManifest)).resolves.toBe('ready');
      expect(download).toHaveBeenCalledTimes(2);
      expect(download.mock.calls[1]?.[0]).toMatchObject({ sha256: secondDigest });
      expect(fs.readFileSync(patchPath, 'utf8')).toBe('new-bytes');
    } finally {
      service.stopUpdateService();
    }
  });

  it('redownloads a cold-started Windows patch when the same version is republished under a new filename', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const digest = 'd'.repeat(64);
    const manifest = updateManifest('0.0.65', 'app/windows-x64/cindy-0.0.65.zip');
    manifest.app.hotfix.sha256 = digest;
    fetchManifest.mockResolvedValue(manifest);
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(path.join(updatesDir, 'staged.zip'), 'old-bytes');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({
        version: '0.0.65',
        fileName: 'staged.zip',
        sha256: 'f'.repeat(64),
        enableBeta: false,
      }),
    );
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'new-bytes');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      await expect(handler?.()).resolves.toMatchObject({
        hasUpdate: true,
        version: '0.0.65',
      });
      expect(download).toHaveBeenCalledTimes(1);
      expect(download.mock.calls[0]?.[0]).toMatchObject({ sha256: digest });
      expect(fs.readFileSync(path.join(updatesDir, 'cindy-0.0.65.zip'), 'utf8')).toBe('new-bytes');
    } finally {
      service.stopUpdateService();
    }
  });

  it('redownloads a cold-started Windows patch whose bytes do not match the current digest', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    const digest = 'c'.repeat(64);
    const manifest = updateManifest('0.0.65', 'app/windows-x64/staged.zip');
    manifest.app.hotfix.sha256 = digest;
    fetchManifest.mockResolvedValue(manifest);
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(path.join(updatesDir, 'staged.zip'), 'stale-bytes');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({
        version: '0.0.65',
        fileName: 'staged.zip',
        sha256: 'f'.repeat(64),
        enableBeta: false,
      }),
    );
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'fresh-bytes');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      await expect(handler?.()).resolves.toMatchObject({
        hasUpdate: true,
        version: '0.0.65',
      });
      expect(download).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(path.join(updatesDir, 'staged.zip'), 'utf8')).toBe('fresh-bytes');
    } finally {
      service.stopUpdateService();
    }
  });

  it('uses the current matching manifest digest for a staged Windows patch', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    checkWindowsUpdaterPrerequisites.mockReturnValue({
      satisfied: false,
      missingFiles: ['vcruntime140.dll'],
    });
    const stagedBytes = Buffer.from('update');
    const digest = createHash('sha256').update(stagedBytes).digest('hex');
    const manifest = updateManifest('0.0.65', 'app/windows-x64/staged.zip');
    manifest.app.hotfix.sha256 = digest;
    fetchManifest.mockResolvedValue(manifest);
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    const patchPath = path.join(updatesDir, 'staged.zip');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(patchPath, stagedBytes);
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({
        version: '0.0.65',
        fileName: 'staged.zip',
        sha256: 'f'.repeat(64),
        enableBeta: false,
      }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      await expect(handler?.()).resolves.toMatchObject({
        hasUpdate: true,
        action: 'none',
        version: '0.0.65',
      });
      expect(download).not.toHaveBeenCalled();

      ipcListeners.get('update-relaunch')?.({}, 'dark');

      expect(checkWindowsUpdaterPrerequisites).toHaveBeenCalledTimes(2);
      expect(logError).not.toHaveBeenCalledWith(
        'Windows update archive is missing its trusted manifest SHA-256',
      );
    } finally {
      service.stopUpdateService();
    }
  });

  it('does not apply a lower local patch that matches the online manifest', async () => {
    vi.useFakeTimers();
    fetchManifest.mockResolvedValue(updateManifest('0.0.63'));
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    const patchPath = path.join(updatesDir, 'staged.zip');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(patchPath, 'update');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({
        version: '0.0.63',
        fileName: 'staged.zip',
        sha256: 'abc',
        enableBeta: false,
      }),
    );

    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      await expect(handler?.()).resolves.toMatchObject({
        hasUpdate: false,
        action: 'none',
      });
      expect(download).not.toHaveBeenCalled();
      expect(fs.existsSync(patchPath)).toBe(false);
      expect(fs.existsSync(path.join(updatesDir, 'patch-info.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('discards a newer local patch that is no longer advertised by the online manifest', async () => {
    vi.useFakeTimers();
    fetchManifest.mockResolvedValue(updateManifest('0.0.64'));
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    const patchPath = path.join(updatesDir, 'staged.zip');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(patchPath, 'update');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({
        version: '0.0.65',
        fileName: 'staged.zip',
        sha256: 'abc',
        enableBeta: false,
      }),
    );

    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      await expect(handler?.()).resolves.toMatchObject({
        hasUpdate: false,
        action: 'none',
      });
      expect(service.getUpdateStatus()).toBe('idle');
      expect(fs.existsSync(patchPath)).toBe(false);
      expect(fs.existsSync(path.join(updatesDir, 'patch-info.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('drops a ready patch when a later manifest no longer advertises an upgrade', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });
    const service = await freshUpdateService('darwin');

    await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
    await expect(service.checkForUpdate(updateManifest('0.0.63'))).resolves.toBe('idle');

    expect(service.getUpdateStatus()).toBe('idle');
    expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);
  });

  it('rechecks the version immediately before launching the native updater', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      expect(service.getUpdateStatus()).toBe('ready');

      appGetVersion.mockReturnValue('0.0.65');
      ipcListeners.get('update-relaunch')?.({}, 'dark');

      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('idle');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);
      expect(logError.mock.calls.map((call) => String(call[0]))).toContain(
        'executeRelaunch() refused non-upgrade patch: current=%s patch=%s relation=%s',
      );
    } finally {
      service.stopUpdateService();
    }
  });

  it('does not discard a staged patch while the native updater is already applying it', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('darwin');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      expect(service.getUpdateStatus()).toBe('ready');

      ipcListeners.get('update-relaunch')?.({}, 'dark');
      await vi.waitFor(() => {
        expect(logInfo.mock.calls.map((call) => String(call[0]))).toContain(
          'executeRelaunch() called, theme=%s, readyFilePath=%s',
        );
      });

      await expect(service.checkForUpdate(updateManifest('0.0.63'))).resolves.toBe('idle');
      const stagedFile = path.basename(updateManifest('0.0.65').app.hotfix.file);
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', stagedFile))).toBe(true);
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
    } finally {
      exitSpy.mockRestore();
      service.stopUpdateService();
    }
  });

  it('defers manifest-driven discard while auto-relaunch eligibility is pending', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('darwin');
    let releaseProbe: ((busy: boolean) => void) | undefined;
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      const stagedFile = path.join(
        TEST_USER_DATA,
        'updates',
        path.basename(updateManifest('0.0.65').app.hotfix.file),
      );
      expect(fs.existsSync(stagedFile)).toBe(true);

      readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: true });
      const probeStarted = new Promise<void>((resolveStarted) => {
        service.setUpdateAutoRelaunchBusyProbe(
          () =>
            new Promise<boolean>((resolveProbe) => {
              resolveStarted();
              releaseProbe = resolveProbe;
            }),
        );
      });
      await probeStarted;

      await expect(service.checkForUpdate(updateManifest('0.0.63'))).resolves.toBe('idle');
      // The manifest says the staged version is no longer eligible, but the
      // pending busy probe still owns the apply decision. Keep the zip intact
      // until that decision settles; only the marker is removed immediately.
      expect(fs.existsSync(stagedFile)).toBe(true);
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);

      releaseProbe?.(true);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('idle');
      });
      expect(fs.existsSync(stagedFile)).toBe(false);
    } finally {
      releaseProbe?.(true);
      service.stopUpdateService();
    }
  });
});

describe('startup update relaunch safety', () => {
  // Startup/splash auto-applies a staged patch as soon as it is ready — the
  // historic behavior restored deliberately (owner-approved). A fresh launch has
  // no in-flight agent turn / schedule to protect, so the startup gate skips the
  // idle/busy/user-active checks that guard the *background* auto-relaunch and
  // keeps only the essentials (disabled / dev / not-ready / relaunching).
  it('auto-applies a staged startup update as soon as it is ready', async () => {
    await expect(runStartupUpdate()).resolves.toMatchObject({
      hasUpdate: true,
      action: 'relaunch',
      version: '0.0.65',
    });
  });

  it.each(['idle', 'active', 'unknown', 'locked'] as const)(
    'auto-applies at startup regardless of system idle state (%s)',
    async (idleState) => {
      await expect(runStartupUpdate({ idleState })).resolves.toMatchObject({
        hasUpdate: true,
        action: 'relaunch',
        version: '0.0.65',
      });
    },
  );

  it('auto-applies at startup even when agent tasks are busy', async () => {
    await expect(runStartupUpdate({ busy: true })).resolves.toMatchObject({
      action: 'relaunch',
    });
  });

  it('auto-applies startup updates even when idle auto-install is disabled', async () => {
    await expect(runStartupUpdate({ enabled: false })).resolves.toMatchObject({
      hasUpdate: true,
      action: 'relaunch',
      version: '0.0.65',
    });
  });

  it('never runs the startup update flow (nor the native updater) on a dev build', async () => {
    // The handler bails before any update work in dev (updater can't replace a
    // forge/dev instance); the startup gate's `dev` branch is defense-in-depth.
    isDev.mockReturnValue(true);
    await expect(runStartupUpdate()).resolves.toMatchObject({ hasUpdate: false, action: 'none' });
  });

  it('keeps startup and manual relaunch IPC paths separate', async () => {
    vi.useFakeTimers();
    fetchManifest.mockResolvedValue(updateManifest());
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.join(TEST_USER_DATA, 'updates'), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      const startupHandler = ipcHandlers.get('update-check-startup');
      const autoApplyHandler = ipcHandlers.get('update-relaunch-auto');
      expect(startupHandler).toBeTypeOf('function');
      expect(autoApplyHandler).toBeTypeOf('function');
      // Manual "立即重启" path stays a separate, unguarded listener.
      expect(ipcListeners.get('update-relaunch')).toBeTypeOf('function');

      await expect(startupHandler?.()).resolves.toMatchObject({ action: 'relaunch' });

      // Startup/Splash relaunch is independent from the background idle setting.
      readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
      expect(service.getUpdateStatus()).toBe('ready');
    } finally {
      service.stopUpdateService();
    }
  });

  /** Boots the startup flow (staging a patch) and hands back the live module. */
  async function bootWithStagedPatch(options: {
    enabled?: boolean;
    manifest?: ReturnType<typeof updateManifest>;
  } = {}) {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: options.enabled ?? true });
    fetchManifest.mockResolvedValue(options.manifest ?? updateManifest());
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.join(TEST_USER_DATA, 'updates'), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    const handler = ipcHandlers.get('update-check-startup');
    if (!handler) throw new Error('update-check-startup handler not registered');
    await handler();
    return service;
  }

  it('is false with nothing staged', async () => {
    const service = await freshUpdateService('darwin');
    try {
      expect(service.getUpdateStatus()).toBe('idle');
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  // Regression: a staged patch used to read as "about to relaunch" purely from
  // status==='ready'. With auto-relaunch off the patch sits there indefinitely,
  // so every cold boot re-observed 'ready' and callers (startImConnection) kept
  // deferring to a "next cold boot" that behaved identically — the FeishuBot
  // never came online and feishuBot:save failed with [IM_NOT_READY] forever.
  it('is false for a patch staged while auto-relaunch is off', async () => {
    const service = await bootWithStagedPatch({ enabled: false });
    try {
      expect(service.getUpdateStatus()).toBe('ready');
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('is true for a patch staged while auto-relaunch is on', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    try {
      expect(service.getUpdateStatus()).toBe('ready');
      expect(service.isUpdateRelaunchImminent()).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('re-reads the auto-relaunch switch on every call', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    try {
      expect(service.isUpdateRelaunchImminent()).toBe(true);
      readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
      expect(service.isUpdateRelaunchImminent()).toBe(false);
      readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: true });
      expect(service.isUpdateRelaunchImminent()).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('is false on a dev build even with a staged patch', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    try {
      expect(service.getUpdateStatus()).toBe('ready');
      isDev.mockReturnValue(true);
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('does not clear the staged patch while busyProbe is still pending', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    try {
      await probeStarted;
      expect(service.getUpdateStatus()).toBe('ready');
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      expect(service.getUpdateStatus()).toBe('ready');
    } finally {
      releaseProbe?.(true);
      service.stopUpdateService();
    }
  });

  it('clears a matching relogin flag when the staged patch is discarded', async () => {
    const service = await bootWithStagedPatch({ enabled: false });
    const flagPath = path.join(TEST_USER_DATA, 'relogin-required.flag');
    fs.writeFileSync(flagPath, JSON.stringify({ version: '0.0.65' }));
    try {
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      expect(fs.existsSync(flagPath)).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('clears the deferred staged patch after a busy eligibility check settles', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      expect(service.getUpdateStatus()).toBe('ready');
      releaseProbe?.(true);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('idle');
      });
    } finally {
      service.stopUpdateService();
    }
  });

  it('aborts auto-relaunch when the channel changes during eligibility', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      expect(service.getUpdateStatus()).toBe('ready');
      releaseProbe?.(false);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('idle');
      });
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('keeps a same-path newer patch after deferred channel-change clear', async () => {
    const sharedHotfix = 'app/darwin-arm64/xdt-maker-hotfix.zip';
    const service = await bootWithStagedPatch({
      enabled: true,
      manifest: updateManifest('0.0.65', sharedHotfix),
    });
    service.stopUpdateService();
    vi.useRealTimers();
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      expect(service.getUpdateStatus()).toBe('ready');
      // 后续 ready 不要再挂住另一条 probe,否则延迟清理永远不会 flush。
      service.setUpdateAutoRelaunchBusyProbe(() => true);

      readUpdateChannelSettings.mockReturnValue({
        enableBeta: true,
        orgDefaultEnableBeta: true,
      });
      fetchManifest.mockResolvedValue(updateManifest('0.0.66', sharedHotfix));
      await expect(service.checkForUpdate()).resolves.toBe('ready');
      expect(service.getUpdateStatus()).toBe('ready');

      const destPath = path.join(TEST_USER_DATA, 'updates', path.basename(sharedHotfix));
      const patchInfoPath = path.join(TEST_USER_DATA, 'updates', 'patch-info.json');
      expect(fs.existsSync(destPath)).toBe(true);
      expect(fs.existsSync(patchInfoPath)).toBe(true);
      expect(fs.readFileSync(patchInfoPath, 'utf-8')).toContain('0.0.66');

      releaseProbe?.(true);
      await vi.waitFor(() => {
        expect(
          logInfo.mock.calls.some((call) =>
            String(call[0]).includes('keeping newer staged patch after deferred channel-change clear'),
          ),
        ).toBe(true);
      });
      expect(service.getUpdateStatus()).toBe('ready');
      expect(fs.existsSync(destPath)).toBe(true);
    } finally {
      releaseProbe?.(true);
      service.stopUpdateService();
    }
  });

  it('drops patch-info immediately so a channel relaunch cannot revive the old zip', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      expect(service.getUpdateStatus()).toBe('ready');
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);

      const relaunch = ipcHandlers.get('update-channel-relaunch');
      expect(relaunch).toBeTypeOf('function');
      relaunch?.({ sender: { id: 1 } });
      expect(appRelaunch).toHaveBeenCalledWith({ args: process.argv.slice(1) });
      expect(appQuit).toHaveBeenCalled();
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);
    } finally {
      releaseProbe?.(true);
      service.stopUpdateService();
    }
  });

  it('does not bump the channel epoch again when flushing during a same-path download', async () => {
    const sharedHotfix = 'app/darwin-arm64/xdt-maker-hotfix.zip';
    const service = await bootWithStagedPatch({
      enabled: true,
      manifest: updateManifest('0.0.65', sharedHotfix),
    });
    service.stopUpdateService();
    vi.useRealTimers();
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    let finishDownload: (() => void) | undefined;
    let downloadEntered: (() => void) | undefined;
    const downloadStarted = new Promise<void>((resolve) => {
      downloadEntered = resolve;
    });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      downloadEntered?.();
      await new Promise<void>((resolve) => {
        finishDownload = resolve;
      });
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'newer-update');
      return { path: targetPath, size: 123 };
    });
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      service.setUpdateAutoRelaunchBusyProbe(() => true);
      readUpdateChannelSettings.mockReturnValue({
        enableBeta: true,
        orgDefaultEnableBeta: true,
      });
      fetchManifest.mockResolvedValue(updateManifest('0.0.66', sharedHotfix));
      const checkPromise = service.checkForUpdate();
      await downloadStarted;
      expect(service.getUpdateStatus()).toBe('superseding');
      releaseProbe?.(true);
      finishDownload?.();
      await expect(checkPromise).resolves.toBe('ready');
      expect(service.getUpdateStatus()).toBe('ready');
      expect(
        fs.readFileSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'), 'utf-8'),
      ).toContain('0.0.66');
    } finally {
      finishDownload?.();
      releaseProbe?.(true);
      service.stopUpdateService();
    }
  });

  it('invalidates an in-flight check when another instance changes the shared channel', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    try {
      expect(service.getUpdateStatus()).toBe('ready');
      readUpdateChannelSettings.mockReturnValue({
        enableBeta: true,
        orgDefaultEnableBeta: true,
      });
      await expect(service.checkForUpdate()).resolves.toBe('idle');
      expect(service.getUpdateStatus()).toBe('idle');
    } finally {
      service.stopUpdateService();
    }
  });

  it('does not restore a superseded patch after a channel change', async () => {
    const { DownloadError } = await import('../downloader/index');
    const service = await bootWithStagedPatch({ enabled: true });
    service.stopUpdateService();
    vi.useRealTimers();
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    let failDownload: ((error: Error) => void) | undefined;
    let downloadEntered: (() => void) | undefined;
    const downloadStarted = new Promise<void>((resolve) => {
      downloadEntered = resolve;
    });
    download.mockImplementation(() => {
      downloadEntered?.();
      return new Promise((_, reject) => {
        failDownload = reject;
      });
    });
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      service.setUpdateAutoRelaunchBusyProbe(() => true);
      readUpdateChannelSettings.mockReturnValue({
        enableBeta: true,
        orgDefaultEnableBeta: true,
      });
      fetchManifest.mockResolvedValue(updateManifest('0.0.66'));
      const checkPromise = service.checkForUpdate();
      await downloadStarted;
      expect(service.getUpdateStatus()).toBe('superseding');
      releaseProbe?.(true);
      failDownload?.(new DownloadError('NETWORK', 'boom'));
      await expect(checkPromise).resolves.toBe('idle');
      expect(service.getUpdateStatus()).toBe('idle');
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);
    } finally {
      releaseProbe?.(true);
      service.stopUpdateService();
    }
  });

  it('aborts a manual relaunch when a channel change is still deferred', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    try {
      await probeStarted;
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');
      await setHandler?.({ sender: { id: 1 } }, { enableBeta: true });
      expect(service.getUpdateStatus()).toBe('ready');
      const relaunch = ipcListeners.get('update-relaunch');
      expect(relaunch).toBeTypeOf('function');
      logInfo.mockClear();
      relaunch?.({}, 'dark');
      expect(logInfo.mock.calls.map((call) => String(call[0]))).toEqual(
        expect.arrayContaining([
          expect.stringContaining('executeRelaunch() aborted'),
        ]),
      );
      releaseProbe?.(false);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('idle');
      });
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('invalidates the staged patch before the settings write settles', async () => {
    const service = await bootWithStagedPatch({ enabled: false });
    let releaseWrite: (() => void) | undefined;
    writeEnableBeta.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          releaseWrite = () => resolve(undefined);
        }),
    );
    try {
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      const writePromise = setHandler?.({ sender: { id: 1 } }, { enableBeta: true });
      await vi.waitFor(() => {
        expect(releaseWrite).toBeTypeOf('function');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      releaseWrite?.();
      await writePromise;
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('keeps the staged patch when an org-default write is rejected', async () => {
    const service = await bootWithStagedPatch({ enabled: false });
    tryEnableUncustomizedBetaAtomic.mockResolvedValue(false);
    try {
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(false);
      expect(service.getUpdateStatus()).toBe('ready');
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('keeps a settings-page hold when a concurrent org-default write throws', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    let releaseWrite: (() => void) | undefined;
    writeEnableBeta.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          releaseWrite = () => resolve(undefined);
        }),
    );
    tryEnableUncustomizedBetaAtomic.mockRejectedValue(new Error('lock timeout'));
    try {
      await probeStarted;
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');
      const writePromise = setHandler?.({ sender: { id: 1 } }, { enableBeta: true });
      await vi.waitFor(() => {
        expect(releaseWrite).toBeTypeOf('function');
      });
      await expect(service.enableUncustomizedBetaChannel()).rejects.toThrow('lock timeout');
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      releaseProbe?.(false);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('ready');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      logInfo.mockClear();
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      expect(logInfo.mock.calls.map((call) => String(call[0]))).toEqual(
        expect.arrayContaining([
          expect.stringContaining('executeRelaunch() aborted'),
        ]),
      );
      expect(service.getUpdateStatus()).toBe('ready');
      releaseWrite?.();
      await writePromise;
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('idle');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('applies a newer same-path patch after a deferred channel change', async () => {
    const sharedHotfix = 'app/darwin-arm64/xdt-maker-hotfix.zip';
    const service = await bootWithStagedPatch({
      enabled: true,
      manifest: updateManifest('0.0.65', sharedHotfix),
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      service.setUpdateAutoRelaunchBusyProbe(() => true);
      readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
      readUpdateChannelSettings.mockReturnValue({
        enableBeta: true,
        orgDefaultEnableBeta: true,
      });
      fetchManifest.mockResolvedValue(updateManifest('0.0.66', sharedHotfix));
      await expect(service.checkForUpdate()).resolves.toBe('ready');
      expect(service.getUpdateStatus()).toBe('ready');
      logInfo.mockClear();
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      expect(logInfo.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain(
        'executeRelaunch() aborted',
      );
      expect(logInfo.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        'executeRelaunch() called',
      );
      expect(
        fs.readFileSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'), 'utf-8'),
      ).toContain('0.0.66');
    } finally {
      exitSpy.mockRestore();
      releaseProbe?.(true);
      service.stopUpdateService();
    }
  });

  it('does not treat a failed settings write as a committed channel change', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    let rejectWrite: ((error: Error) => void) | undefined;
    writeEnableBeta.mockImplementation(
      () =>
        new Promise<undefined>((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    try {
      await probeStarted;
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');
      const writePromise = setHandler?.({ sender: { id: 1 } }, { enableBeta: true });
      await vi.waitFor(() => {
        expect(rejectWrite).toBeTypeOf('function');
      });
      rejectWrite?.(new Error('lock timeout'));
      await expect(writePromise).rejects.toThrow();
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      releaseProbe?.(true);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('ready');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('does not treat a failed settings write as an external channel change', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    writeEnableBeta.mockRejectedValueOnce(new Error('lock timeout'));
    try {
      await probeStarted;
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');
      await expect(setHandler?.({ sender: { id: 1 } }, { enableBeta: true })).rejects.toThrow();
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      releaseProbe?.(true);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('ready');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('does not let a failed settings write overwrite a committed observed channel', async () => {
    const service = await bootWithStagedPatch({ enabled: false });
    let releaseFirstWrite: (() => void) | undefined;
    let rejectSecondWrite: ((error: Error) => void) | undefined;
    let writeCalls = 0;
    writeEnableBeta.mockImplementation(
      () =>
        new Promise<undefined>((resolve, reject) => {
          writeCalls += 1;
          if (writeCalls === 1) {
            releaseFirstWrite = () => resolve(undefined);
            return;
          }
          rejectSecondWrite = reject;
        }),
    );
    try {
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');
      const firstWrite = setHandler?.({ sender: { id: 1 } }, { enableBeta: true });
      const secondWrite = setHandler?.({ sender: { id: 1 } }, { enableBeta: true });
      await vi.waitFor(() => {
        expect(releaseFirstWrite).toBeTypeOf('function');
        expect(rejectSecondWrite).toBeTypeOf('function');
      });
      readUpdateChannelSettings.mockReturnValue({
        enableBeta: true,
        orgDefaultEnableBeta: true,
      });
      releaseFirstWrite?.();
      await firstWrite;
      rejectSecondWrite?.(new Error('lock timeout'));
      await expect(secondWrite).rejects.toThrow();
      await expect(service.checkForUpdate()).resolves.toBe('ready');
      expect(service.getUpdateStatus()).toBe('ready');
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('invalidates the staged patch when another instance already enabled beta', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    tryEnableUncustomizedBetaAtomic.mockImplementation(async () => {
      readUpdateChannelSettings.mockReturnValue({
        enableBeta: true,
        orgDefaultEnableBeta: true,
      });
      return false;
    });
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(false);
      expect(service.getUpdateStatus()).toBe('ready');
      releaseProbe?.(false);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('idle');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('releases a pending hold when the org-default write throws', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    tryEnableUncustomizedBetaAtomic.mockRejectedValue(new Error('lock timeout'));
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).rejects.toThrow('lock timeout');
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      releaseProbe?.(true);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('ready');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('does not apply a leftover patch after an offline channel change', async () => {
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(path.join(updatesDir, 'xdt-maker-0.0.65.zip'), 'update');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({
        version: '0.0.65',
        fileName: 'xdt-maker-0.0.65.zip',
        sha256: 'abc',
        enableBeta: false,
      }),
    );
    const flagPath = path.join(TEST_USER_DATA, 'relogin-required.flag');
    fs.writeFileSync(flagPath, JSON.stringify({ version: '0.0.65' }));
    readUpdateChannelSettings.mockReturnValue({
      enableBeta: true,
      orgDefaultEnableBeta: true,
    });
    fetchManifest.mockResolvedValue(null);
    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      expect(handler).toBeTypeOf('function');
      await expect(handler?.()).resolves.toMatchObject({
        hasUpdate: false,
        action: 'none',
        error: 'manifest_failed',
      });
      expect(service.getUpdateStatus()).toBe('idle');
      await vi.waitFor(() => {
        expect(fs.existsSync(path.join(updatesDir, 'patch-info.json'))).toBe(false);
        expect(fs.existsSync(path.join(updatesDir, 'xdt-maker-0.0.65.zip'))).toBe(false);
        expect(fs.existsSync(flagPath)).toBe(false);
      });
    } finally {
      service.stopUpdateService();
    }
  });
});

describe('Windows updater prerequisites', () => {
  it('passes the verified manifest digest to the Windows updater', async () => {
    const digest = 'a'.repeat(64);
    const manifest = updateManifest('0.0.65');
    manifest.app.hotfix.sha256 = digest;
    const resourcesPath = path.join(TEST_ROOT, 'resources');
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(path.join(resourcesPath, `${BRAND_IDENTITY.updaterName}.exe`), 'updater');
    const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true });
    const tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(TEST_ROOT);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    spawnProcess.mockImplementationOnce(() => ({
      unref: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => {
        if (event === 'spawn') listener();
      }),
    }));
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(manifest)).resolves.toBe('ready');
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      await vi.waitFor(() => { expect(spawnProcess).toHaveBeenCalledOnce(); });
      const spawnedArgs = (spawnProcess.mock.calls as unknown as Array<[string, string[]]>)[0]?.[1];
      expect(spawnedArgs).toEqual(expect.arrayContaining(['--zip-sha256', digest]));
    } finally {
      service.stopUpdateService();
      tmpdirSpy.mockRestore();
      exitSpy.mockRestore();
      if (resourcesPathDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor);
      else Reflect.deleteProperty(process, 'resourcesPath');
    }
  });

  it('refuses to spawn the Windows updater when the manifest digest is missing', async () => {
    const manifest = updateManifest('0.0.65');
    manifest.app.hotfix.sha256 = '';
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });
    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(manifest)).resolves.toBe('ready');
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      await vi.waitFor(() => { expect(service.getUpdateStatus()).toBe('error'); });
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      service.stopUpdateService();
    }
  });

  it('defers the first startup relaunch and exposes the prerequisite error', async () => {
    vi.useFakeTimers();
    checkWindowsUpdaterPrerequisites.mockReturnValue({
      satisfied: false,
      missingFiles: ['vcruntime140.dll', 'vcruntime140_1.dll'],
    });
    fetchManifest.mockResolvedValue(updateManifest('0.0.65'));
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      const startupHandler = ipcHandlers.get('update-check-startup');
      await expect(startupHandler?.()).resolves.toMatchObject({
        hasUpdate: true,
        action: 'none',
        version: '0.0.65',
      });
      expect(ipcHandlers.get('update-get-status')?.()).toMatchObject({
        status: 'ready',
        version: '0.0.65',
        errorCode: 'windows_vc_runtime_missing',
      });
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('keeps Cindy and the staged patch intact when the VC++ Runtime is missing', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    checkWindowsUpdaterPrerequisites.mockReturnValue({
      satisfied: false,
      missingFiles: ['vcruntime140_1.dll'],
    });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('win32');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      const patchInfoPath = path.join(TEST_USER_DATA, 'updates', 'patch-info.json');
      const patchInfoBefore = JSON.parse(fs.readFileSync(patchInfoPath, 'utf-8')) as {
        fileName: string;
      };
      const stagedPatchPath = path.join(TEST_USER_DATA, 'updates', patchInfoBefore.fileName);

      ipcListeners.get('update-relaunch')?.({}, 'dark');

      await vi.waitFor(() => {
        expect(ipcHandlers.get('update-get-status')?.()).toMatchObject({
          status: 'ready',
          version: '0.0.65',
          errorCode: 'windows_vc_runtime_missing',
        });
      });
      const patchInfoAfter = JSON.parse(fs.readFileSync(patchInfoPath, 'utf-8')) as {
        applyAttempts?: number;
      };
      expect(patchInfoAfter.applyAttempts).toBeUndefined();
      expect(fs.existsSync(stagedPatchPath)).toBe(true);
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      exitSpy.mockRestore();
      service.stopUpdateService();
    }
  });

  it.each([
    { stageResult: 'fallback-safe' as const, prerequisiteChecks: 2 },
    { stageResult: 'blocked' as const, prerequisiteChecks: 1 },
  ])('keeps the patch and retry count when Runtime staging is $stageResult', async ({
    stageResult,
    prerequisiteChecks,
  }) => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    checkWindowsUpdaterPrerequisites
      .mockReturnValueOnce({ satisfied: true, missingFiles: [] })
      .mockReturnValue({
        satisfied: false,
        missingFiles: ['vcruntime140.dll', 'vcruntime140_1.dll'],
      });
    stageBundledWindowsUpdaterRuntime.mockReturnValue(stageResult);
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const resourcesPath = path.join(TEST_ROOT, 'resources');
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(path.join(resourcesPath, `${BRAND_IDENTITY.updaterName}.exe`), 'updater');
    const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesPath,
      configurable: true,
    });
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const updaterWorkDir = path.join(os.tmpdir(), `cindy-update-${now}`);

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      const patchInfoPath = path.join(TEST_USER_DATA, 'updates', 'patch-info.json');
      const patchInfoBefore = JSON.parse(fs.readFileSync(patchInfoPath, 'utf-8')) as {
        fileName: string;
      };
      const stagedPatchPath = path.join(TEST_USER_DATA, 'updates', patchInfoBefore.fileName);

      ipcListeners.get('update-relaunch')?.({}, 'dark');

      await vi.waitFor(() => {
        expect(checkWindowsUpdaterPrerequisites).toHaveBeenCalledTimes(prerequisiteChecks);
        expect(ipcHandlers.get('update-get-status')?.()).toMatchObject({
          status: 'ready',
          version: '0.0.65',
          errorCode: 'windows_vc_runtime_missing',
        });
      });
      if (stageResult === 'fallback-safe') {
        expect(checkWindowsUpdaterPrerequisites).toHaveBeenNthCalledWith(2, undefined, '');
      }
      const patchInfoAfter = JSON.parse(fs.readFileSync(patchInfoPath, 'utf-8')) as {
        applyAttempts?: number;
      };
      expect(patchInfoAfter.applyAttempts).toBeUndefined();
      expect(fs.existsSync(stagedPatchPath)).toBe(true);
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
      nowSpy.mockRestore();
      fs.rmSync(updaterWorkDir, { recursive: true, force: true });
      if (resourcesPathDescriptor) {
        Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor);
      } else {
        Reflect.deleteProperty(process, 'resourcesPath');
      }
    }
  });

  it('does not repeatedly auto-relaunch a prerequisite-blocked patch', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: true });
    checkWindowsUpdaterPrerequisites.mockReturnValue({
      satisfied: false,
      missingFiles: ['vcruntime140.dll', 'vcruntime140_1.dll'],
    });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      await vi.waitFor(() => {
        expect(checkWindowsUpdaterPrerequisites).toHaveBeenCalledTimes(1);
      });

      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      expect(checkWindowsUpdaterPrerequisites).toHaveBeenCalledTimes(1);
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(service.getUpdateStatus()).toBe('ready');
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });
});

describe('splash 启动下载 0% 显式广播', () => {
  interface SentIpc {
    channel: string;
    payload: { progress?: number; received?: number; total?: number };
  }

  function makeProgressCollector() {
    const sends: SentIpc[] = [];
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: SentIpc['payload']) => {
          sends.push({ channel, payload });
        },
      },
    };
    browserWindowGetAllWindows.mockReturnValue([win as never]);
    const progressSends = () => sends.filter((s) => s.channel === 'app-update-progress');
    return { sends, progressSends };
  }

  function mockDownloadSuccess(onInvoke?: () => void) {
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      onInvoke?.();
      fs.mkdirSync(path.join(TEST_USER_DATA, 'updates'), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });
  }

  beforeEach(() => {
    // setStatus('ready') 会触发 evaluateAutoRelaunch;关掉无人值守开关,
    // 避免测试进程里真的走到 executeRelaunch(spawn + process.exit)。
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
  });

  it('启动(非 wasReady)路径:download() 之前恰好广播一次 progress:0', async () => {
    const { progressSends } = makeProgressCollector();
    // ProgressNormalizer 只在进度上升时 emit,首个 ≥1% 事件在大补丁/慢网下
    // 可能要等数秒;没有这条显式 0%,splash 会停留在 'checking'、grace 定时器
    // 也看不到 'updating' 而提前放行进 app —— 这里锁死"下载真正开始前恰好
    // 已广播一次 0%"的契约。
    let progressCountWhenDownloadStarted = -1;
    mockDownloadSuccess(() => {
      progressCountWhenDownloadStarted = progressSends().length;
    });

    const { checkForUpdate } = await freshUpdateService('darwin');
    expect(await checkForUpdate(updateManifest())).toBe('ready');

    expect(progressCountWhenDownloadStarted).toBe(1);
    const payloads = progressSends().map((s) => s.payload);
    expect(payloads[0]).toMatchObject({ progress: 0, received: 0, total: 123 });
    expect(payloads[payloads.length - 1]).toMatchObject({ progress: 100 });
  });

  it('superseding(wasReady)路径:下载前不向 splash 通道广播 0%', async () => {
    const { sends, progressSends } = makeProgressCollector();
    mockDownloadSuccess();

    const service = await freshUpdateService('darwin');
    expect(await service.checkForUpdate(updateManifest('0.0.65'))).toBe('ready');

    // 清空第一轮的广播,只观察 superseding 轮。
    sends.length = 0;
    let progressCountWhenDownloadStarted = -1;
    mockDownloadSuccess(() => {
      progressCountWhenDownloadStarted = progressSends().length;
    });

    // banner 已 ready(a=0.0.65),后台轮询发现更高的 b=0.0.66 → superseding。
    // 此时用户在主界面,启动 splash 早已结束;0% 广播只属于启动态。
    expect(await service.checkForUpdate(updateManifest('0.0.66'))).toBe('ready');
    expect(progressCountWhenDownloadStarted).toBe(0);
  });
});
});
