import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The IPC registration module imports Electron and the full Ghost host graph,
 * so guard its error-boundary contract using the established main-process
 * source-test pattern.
 */
describe('Plugin Market IPC error boundary', () => {
  const registerSource = readFileSync(
    resolve(process.cwd(), 'src/main/plugin-market/registerIpc.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const serviceSource = readFileSync(
    resolve(process.cwd(), 'src/main/plugin-market/service.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const bootstrapSource = readFileSync(
    resolve(process.cwd(), 'src/main/bootstrap-electron.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('preserves structured errors and normalizes unexpected failures', () => {
    const start = registerSource.indexOf('async function invokePluginMarket');
    const end = registerSource.indexOf('\n}\n\n/** 注册 renderer', start);
    const body = registerSource.slice(start, end);

    expect(body).toContain('if (isIpcError(error)) throw error;');
    expect(body).toContain("throwIpcError('INTERNAL', 'Plugin market operation failed');");
    // The merged client intentionally keeps ordinary-market, Meka-market, and
    // custom-source handlers. Each registration must stay behind the same
    // structured error boundary; the union currently has nineteen call sites.
    expect(registerSource.match(/return invokePluginMarket\(/g)?.length).toBe(19);
  });

  it('refuses renderer-supplied local paths and only grants them via the picker', () => {
    // 本地目录授权边界:Renderer 直传绝对路径不构成授权,必须由 Main 原生
    // 目录选择器签发(用户的选择即授权)。此断言防止有人退回"直传即添加"。
    expect(registerSource).toContain("parsed.source.type === 'local'");
    expect(registerSource).toContain('Local folders must be added via the directory picker');
    expect(registerSource).toContain("ipcMain.handle('plugin-market:pick-local-source'");
    expect(serviceSource).toContain('addLocalSourceFromPicker');
    expect(serviceSource).toContain("properties: ['openDirectory']");
  });

  it('does not throw user-visible plain errors from the market service', () => {
    expect(serviceSource).not.toContain('throw new Error(');
    expect(serviceSource).toContain("throwIpcError('PRECONDITION_FAILED'");
    expect(serviceSource).toContain("throwIpcError('PERMISSION_DENIED'");
  });

  it('routes Meka real-package review through the shared requester bridge', () => {
    const start = registerSource.indexOf("'meka-plugin-market:install'");
    const end = registerSource.indexOf("ipcMain.handle('meka-plugin-market:uninstall'", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = registerSource.slice(start, end);

    expect(body).toContain('trackPackageReviewRequester(event.sender);');
    expect(body).toContain('packagePermissionReviewBridge.request(');
    expect(body).toContain('sender.send(PACKAGE_PERMISSION_REVIEW_CHANNEL, request);');
  });

  it('runs default plugin reconciliation through the stable-owner post-commit retry path', () => {
    const syncStart = registerSource.indexOf(
      'export async function syncDefaultMarketPlugins(): Promise<DefaultMarketPluginSyncOutcome>',
    );
    const syncEnd = registerSource.indexOf('\n}\n\n/**\n * Preserve stable IPC errors', syncStart);
    const syncBody = registerSource.slice(syncStart, syncEnd);
    expect(syncBody).toContain('await snapshotAndSignalRemovalNotice({');
    expect(syncBody).toContain('onDefaultReconciliationOutcome: (outcome) => {');
    expect(syncBody).toContain("log.warn('default plugin startup sync incomplete'");
    expect(syncBody).toContain("log.warn('default plugin startup sync failed'");

    const ownerSyncStart = bootstrapSource.indexOf(
      'authManager.setStableOwnerPostCommitTask(async ({ reason, scopeKey, dataOwnerId }) => {',
    );
    const ownerSyncEnd = bootstrapSource.indexOf('\n});\n\n// ── Custom protocol', ownerSyncStart);
    const ownerSyncBody = bootstrapSource.slice(ownerSyncStart, ownerSyncEnd);
    expect(ownerSyncStart).toBeGreaterThan(-1);
    expect(ownerSyncBody).toContain('if (dataOwnerId === null)');
    expect(ownerSyncBody).toContain('const marketOutcome = await syncDefaultMarketPlugins();');
    expect(ownerSyncBody).toContain("if (marketOutcome === 'failed') needsRetry = true;");
    expect(ownerSyncBody).toContain("if (marketOutcome === 'deferred') deferred = true;");
    expect(ownerSyncBody).toContain(
      "return needsRetry ? 'failed' : deferred ? 'deferred' : 'completed';",
    );
  });
});
