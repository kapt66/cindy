import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Regression guards for the market Node-authorization/session-switch race.
 * cindy-brain/index.ts depends on Electron process state and is not safe to
 * import in the Node test environment, so this follows the repository's
 * established source-contract test pattern for main-process auth boundaries.
 */
describe('market Ghost session boundary', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const marketServiceSource = readFileSync(
    resolve(process.cwd(), 'src/main/plugin-market/service.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('keeps automatic custom updates bound to the owner captured by synchronization', () => {
    const installStart = marketServiceSource.indexOf('  private async customInstall(');
    const installEnd = marketServiceSource.indexOf(
      '\n  private async installDetail(',
      installStart,
    );
    const installBody = marketServiceSource.slice(installStart, installEnd);
    const automaticStart = marketServiceSource.indexOf('  private async applyAutomaticUpgrades(');
    const automaticEnd = marketServiceSource.indexOf(
      '\n  private localInstallSnapshot(',
      automaticStart,
    );
    const automaticBody = marketServiceSource.slice(automaticStart, automaticEnd);

    expect(installBody).toContain('owner = captureMarketOwner(),');
    expect(installBody).toContain('const ledger = this.ledgerForOwner(owner);');
    expect(installBody).toContain('const manager = this.sourceManagerForOwner(owner);');
    expect(installBody).toContain('requireSameMarketOwner(owner);');
    expect(installBody).toContain(
      'beforePackagePlacement: () => {\n            requireSameMarketOwner(owner);',
    );
    expect(installBody).toContain(
      'afterCommit: async (_installed, _packagedManifest, evidence) => {',
    );
    const afterCommitStart = installBody.indexOf(
      'afterCommit: async (_installed, _packagedManifest, evidence) => {',
    );
    const afterCommitEnd = installBody.indexOf('\n          },\n        }).catch', afterCommitStart);
    const afterCommitBody = installBody.slice(afterCommitStart, afterCommitEnd);
    expect(afterCommitBody).toContain('this.withCapturedLedgerMutation(ledger, () => {');
    expect(afterCommitBody).not.toContain('requireSameMarketOwner(');
    expect(automaticBody).toContain("          { mode: 'automatic' },\n          owner,\n        );");
  });

  it('releases the custom-source cache lease before waiting for install consent', () => {
    const installStart = marketServiceSource.indexOf('  private async customInstall(');
    const installEnd = marketServiceSource.indexOf(
      '\n  private async installDetail(',
      installStart,
    );
    const installBody = marketServiceSource.slice(installStart, installEnd);
    const lease = installBody.indexOf('manager.withDiscoveredSource(');
    const pack = installBody.indexOf('packCustomMarketPlugin(');
    const consent = installBody.indexOf('obtainGhostInstallConsent(');
    expect(lease).toBeGreaterThan(-1);
    expect(pack).toBeGreaterThan(lease);
    expect(consent).toBeGreaterThan(pack);
    expect(installBody.slice(lease, consent)).toContain('packCustomMarketPlugin(');
    expect(installBody.slice(consent)).not.toContain('withDiscoveredSource(');
  });

  it('keeps package placement and market ledger commit in the same owner lease', () => {
    const installStart = source.indexOf(
      'async function installOrUpdateMarketGhostPackageLocked(',
    );
    const installEnd = source.indexOf('\n}\n\ntype GhostUninstallLedgerCompletion', installStart);
    const installBody = source.slice(installStart, installEnd);
    const firstAfterCommit = installBody.indexOf(
      'await expected.afterCommitInLock?.(installedGhost, commitEvidence);',
    );
    const updateAfterCommit = installBody.indexOf(
      'await expected.afterCommitInLock?.(result.ghost, commitEvidence);',
    );
    const release = installBody.indexOf('releaseMutation?.();');

    expect(firstAfterCommit).toBeGreaterThan(-1);
    expect(updateAfterCommit).toBeGreaterThan(firstAfterCommit);
    expect(release).toBeGreaterThan(updateAfterCommit);
    const serverCommitStart = marketServiceSource.indexOf(
      'afterCommitInLock: async (_committed, evidence) => {',
    );
    const serverCommitEnd = marketServiceSource.indexOf('\n        },\n      }).catch', serverCommitStart);
    const serverCommitBody = marketServiceSource.slice(serverCommitStart, serverCommitEnd);
    expect(serverCommitBody).toContain('this.withCapturedLedgerMutation(ledger, () => {');
    expect(serverCommitBody).not.toContain('requireSameMarketOwner(');
  });

  it('requires the pre-approval session generation when acquiring the mutation lease', () => {
    const captureStart = source.indexOf('function captureGhostMutationOwner(): ActiveAppSession {');
    const captureEnd = source.indexOf('\n}\n', captureStart);
    const captureBody = source.slice(captureStart, captureEnd);
    expect(captureBody).toContain('isAppSessionBoundaryPending()');
    expect(captureBody).toContain('return getActiveAppSession();');
    expect(captureBody).not.toContain('isGhostSkillProjectionBoundaryStableForOwner');

    const leaseStart = source.indexOf(
      'function beginGhostMutation(expectedOwner?: ActiveAppSession): () => void {',
    );
    const leaseEnd = source.indexOf('\n}\n', leaseStart);
    const leaseBody = source.slice(leaseStart, leaseEnd);
    expect(leaseBody).toContain('isAppSessionBoundaryPending()');
    expect(leaseBody).toContain('currentOwner.mode !== expectedOwner.mode');
    expect(leaseBody).toContain('currentOwner.dataOwnerId !== expectedOwner.dataOwnerId');
    expect(leaseBody).toContain('currentOwner.generation !== expectedOwner.generation');
    expect(leaseBody).not.toContain('isGhostSkillProjectionBoundaryStableForOwner');
  });

  it('captures before async inspection but leases only after Node authorization', () => {
    const installStart = source.indexOf('export async function installOrUpdateMarketGhostPackage(');
    const installEnd = source.indexOf('\n}\n\ntype GhostUninstallLedgerCompletion', installStart);
    const body = source.slice(installStart, installEnd);

    const captureIndex = body.indexOf('const mutationOwner = captureGhostMutationOwner();');
    const inspectIndex = body.indexOf('await manager.inspect(cindyFilePath)');
    const leaseIndex = body.indexOf('releaseMutation = beginGhostMutation(mutationOwner);');

    expect(captureIndex).toBeGreaterThan(-1);
    expect(captureIndex).toBeLessThan(inspectIndex);
    expect(leaseIndex).toBeGreaterThan(inspectIndex);
    expect(body).toContain('releaseMutation?.();');
  });

  it('fails owner-scoped plugin reads closed while an account boundary is pending', () => {
    const start = source.indexOf('function availableGhosts(): InstalledGhost[] {');
    const end = source.indexOf('\n}', start);
    const body = source.slice(start, end);
    expect(body).toContain('if (isAppSessionBoundaryPending()) return [];');
    const lookupStart = source.indexOf('function findAvailableGhost(id: string)');
    const lookupEnd = source.indexOf('\n}', lookupStart);
    const lookupBody = source.slice(lookupStart, lookupEnd);
    expect(lookupBody).toContain('const ghosts = availableGhosts();');
    expect(lookupBody).toContain('mekaDevPluginsSingleton?.runtimeIdFor(id)');
    expect(lookupBody).not.toContain('mekaDevRuntimeId(id)');
    expect(source.match(/getGhost: findAvailableGhost/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(source).toContain('return findAvailableGhost(id)?.manifest.name ?? null;');
  });

  it('allows explicit local replacement and detaches market routing before landing', () => {
    const updateStart = source.indexOf(
      "ipcMain.handle('ghosts:update'",
    );
    const updateEnd = source.indexOf(
      "ipcMain.handle('ghosts:pick-file'",
      updateStart,
    );
    const updateBody = source.slice(updateStart, updateEnd);
    const helperStart = source.indexOf('async function updateLocalGhostPackageLocked(');
    const helperEnd = source.indexOf(
      '\n}\n\n/**\n * Forge 的显式安装入口。',
      helperStart,
    );
    const helperBody = source.slice(helperStart, helperEnd);

    const ledgerReadIndex = helperBody.indexOf(
      'marketLedger.installationForGhost(inspected.manifest.id)',
    );
    const captureIndex = updateBody.indexOf('const mutationOwner = captureGhostMutationOwner();');
    const inspectIndex = updateBody.indexOf('await manager.inspect(lizFilePath)');
    const leaseIndex = updateBody.indexOf('const releaseMutation = beginGhostMutation(mutationOwner);');
    const helperCallIndex = updateBody.indexOf('updateLocalGhostPackageLocked(');
    const ledgerBindIndex = helperBody.indexOf('const marketLedger = getPluginMarketLedger().bind(');
    const detachDecisionIndex = helperBody.indexOf(
      'const detachMarketRecord = Boolean(marketRecord?.installed)',
    );
    const runtimeStopIndex = helperBody.indexOf('runtime.stop(inspected.manifest.id)');
    const stopAndWaitIndex = helperBody.indexOf(
      'await getGhostNodeRuntimeBroker().stopAndWait(inspected.manifest.id);',
    );
    const oauthLockIndex = helperBody.indexOf(
      'result = await withActiveOwnerGhostOauthMutationLock(inspected.manifest.id',
    );
    const managerUpdateIndex = helperBody.indexOf('manager.update(cindyFilePath,');
    const detachIndex = helperBody.indexOf(
      'marketLedger.markRemoved(inspected.manifest.id, null)',
    );

    expect(captureIndex).toBeGreaterThan(-1);
    expect(captureIndex).toBeLessThan(inspectIndex);
    expect(leaseIndex).toBeGreaterThan(inspectIndex);
    expect(helperCallIndex).toBeGreaterThan(leaseIndex);
    expect(ledgerBindIndex).toBeGreaterThan(-1);
    expect(runtimeStopIndex).toBeGreaterThan(ledgerBindIndex);
    expect(ledgerReadIndex).toBeGreaterThan(stopAndWaitIndex);
    expect(detachDecisionIndex).toBeGreaterThan(ledgerReadIndex);
    expect(stopAndWaitIndex).toBeGreaterThan(runtimeStopIndex);
    // 只有确认旧进程退出，才切断旧市场的自动更新路由；等待失败时保留原路由，
    // 也不会尝试恢复第二份 resident 进程。
    expect(detachIndex).toBeGreaterThan(stopAndWaitIndex);
    expect(helperBody.indexOf('if (isCurrent?.() === false)')).toBeGreaterThan(-1);
    expect(helperBody.indexOf('if (isCurrent?.() === false)')).toBeLessThan(stopAndWaitIndex);
    expect(oauthLockIndex).toBeGreaterThan(detachIndex);
    expect(managerUpdateIndex).toBeGreaterThan(oauthLockIndex);
    expect(helperBody).toContain('marketLedger.restoreInstallation(');
    expect(helperBody).not.toContain('marketLedger.isDefaultInstallSuppressed(');
    expect(helperBody).not.toContain('marketInstallSubject');
    expect(helperBody).toContain('用户显式卸载，不得产生 default-install opt-out');
    expect(helperBody).toContain('onPackagePlaced: () => {');
    expect(helperBody).toContain('packagePlaced = true;');
    expect(helperBody).toContain('if (!packagePlaced) {\n      restoreMarketRecord();');
    expect(updateBody).toContain('releaseMutation();');
    expect(helperBody).not.toContain('GHOST_SOURCE_CONFLICT');
  });

  it('forwards the first-install check into package placement and guards update entry', () => {
    const installStart = source.indexOf(
      'async function installOrUpdateMarketGhostPackageLocked(',
    );
    const installEnd = source.indexOf(
      '\n}\n\ntype GhostUninstallLedgerCompletion',
      installStart,
    );
    const body = source.slice(installStart, installEnd);
    const initialBranch = body.slice(
      body.indexOf('if (!installed) {'),
      body.indexOf('const runtime = getGhostRuntime();'),
    );

    expect(initialBranch).toContain('beforePackagePlacement: expected.beforeCommitInLock,');
    expect(body.match(/expected\.beforeCommitInLock\?\.\(\);/g)).toHaveLength(1);

    const waitIndex = body.indexOf(
      'await getGhostNodeRuntimeBroker().stopAndWait(expected.ghostId);',
    );
    const oauthLockIndex = body.indexOf(
      'await withActiveOwnerGhostOauthMutationLock(expected.ghostId',
    );
    const updateIndex = body.indexOf('manager.update(cindyFilePath,');

    expect(waitIndex).toBeGreaterThan(-1);
    expect(waitIndex).toBeLessThan(oauthLockIndex);
    expect(oauthLockIndex).toBeLessThan(updateIndex);
    const restoreIndex = body.indexOf('spawnIfResident(installed);');
    expect(restoreIndex).toBeGreaterThan(updateIndex);
  });

  it('releases the mutation lease for shutdown failures and restores only after confirmed shutdown', () => {
    const updateStart = source.indexOf("ipcMain.handle('ghosts:update'");
    const updateEnd = source.indexOf("ipcMain.handle('ghosts:pick-file'", updateStart);
    const updateBody = source.slice(updateStart, updateEnd);
    const helperStart = source.indexOf('async function updateLocalGhostPackageLocked(');
    const helperEnd = source.indexOf(
      '\n}\n\n/**\n * Forge 的显式安装入口。',
      helperStart,
    );
    const helperBody = source.slice(helperStart, helperEnd);

    const waitIndex = helperBody.indexOf(
      'await getGhostNodeRuntimeBroker().stopAndWait(inspected.manifest.id);',
    );
    const oauthLockIndex = helperBody.indexOf(
      'result = await withActiveOwnerGhostOauthMutationLock(inspected.manifest.id',
    );
    const updateIndex = helperBody.indexOf('manager.update(cindyFilePath');
    const restoreIndex = helperBody.indexOf(
      'if (previousGhost) spawnIfResident(previousGhost);',
    );

    // stopAndWait must be called before manager.update (safe directory
    // replacement on Windows). The owner lease is outside the per-id lock
    // per the documented invariant (owner lease → per-id lock).
    expect(waitIndex).toBeGreaterThan(-1);
    expect(waitIndex).toBeLessThan(oauthLockIndex);
    expect(oauthLockIndex).toBeLessThan(updateIndex);
    // spawnIfResident is in the market-provenance catch block, after
    // stopAndWait (rollback if provenance check fails).
    expect(restoreIndex).toBeGreaterThan(waitIndex);
    expect(updateBody).toContain('finally {\n      releaseMutation();');
    expect(helperBody).toContain("throwIpcError('INTERNAL', 'Unable to verify the installed Plugin source');");
    expect(helperBody).toContain("throwIpcError('INTERNAL', 'Unable to detach the installed Plugin source');");
  });

  it('Ghost 媒体在途守卫只依赖当前进程的 AppSession owner 边界', () => {
    const helperStart = source.indexOf('function isGhostBoundaryPending(): boolean {');
    expect(helperStart).toBeGreaterThan(-1);
    const helperEnd = source.indexOf('\n}\n', helperStart);
    const helperBody = source.slice(helperStart, helperEnd);
    expect(helperBody).toContain('isAppSessionBoundaryPending()');
    expect(helperBody).not.toContain('isGhostSkillProjectionBoundaryStableForOwner');
    // 两处 Ghost 专属消费点(xAI 通道与 GhostCindySlot)都必须走 helper。
    const injections =
      source.match(/isOwnerBoundaryPending: \(\) => isGhostBoundaryPending\(\)/g)?.length ?? 0;
    expect(injections).toBeGreaterThanOrEqual(2);
  });

  it('Ghost 媒体持久化写入守卫也绑定当前进程的 owner scope', () => {
    // 这两处是 GhostCindySlot 的 deps,内部 assertStillValid 会在 ingestMedia 的
    // await 边界反复断言。持久化写入守卫必须同时检查本进程边界与 scope generation。
    const resolveStart = source.indexOf('resolveOwnedMedia: async (ghostId, hash, ownerScopeKey)');
    const saveStart = source.indexOf(
      'saveGhostMedia: async ({ ghostId, buffer, mimeType, ownerScopeKey',
    );
    expect(resolveStart).toBeGreaterThan(-1);
    expect(saveStart).toBeGreaterThan(-1);
    const resolveBody = source.slice(resolveStart, resolveStart + 700);
    const saveBody = source.slice(saveStart, saveStart + 700);
    const combinedGuard = 'isGhostBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey';
    expect(resolveBody).toContain(combinedGuard);
    expect(saveBody).toContain(combinedGuard);
    // generation 不能退化成只看 pending 位。
    expect(source).not.toContain(
      'isAppSessionBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey',
    );
  });

  it('networkSlot 的 saveGhostMedia(as:media fetch 落仓)也绑定本地 owner scope', () => {
    // networkSlot 与 cindy 槽是两个独立实现,签名不带 ownerScopeKey(在函数体开头
    // 捕获)。它的落仓路径(ghost-gallery 作品归属 + recordGhostCallMedia)必须同样
    // 有本地 owner 守卫 + assertStillValid + 补偿 journal,否则账号切换期间的
    // as:'media' fetch 仍可能落仓到错误 owner 的画廊。
    const networkStart = source.indexOf(
      'saveGhostMedia: async ({ ghostId, buffer, mimeType, label, callId }) =>',
    );
    expect(networkStart).toBeGreaterThan(-1);
    const networkBody = source.slice(networkStart, networkStart + 1800);
    expect(networkBody).toContain('const ownerScopeKey = activeOwnerScopeKey();');
    expect(networkBody).toContain(
      'isGhostBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey',
    );
    expect(networkBody).toContain('assertStillValid: assertOwnerScopeCurrent');
    expect(networkBody).toContain(
      'refCompensationScope: captureMediaRefCompensationScope(ownerScopeKey)',
    );
  });

  it('depositMedia(ghost-deposit 寄存器落仓)也绑定本地 owner scope', () => {
    // 寄存器引用按 ghostId 落到 owner 作用域账本(originKind:'user' 但 refId 仍是意识),
    // 本进程账号切换时必须 fail closed,与 saveGhostMedia 同口径。
    const depositStart = source.indexOf(
      'depositMedia: async ({ ghostId, buffer, mimeType, label }) =>',
    );
    expect(depositStart).toBeGreaterThan(-1);
    const depositBody = source.slice(depositStart, depositStart + 1800);
    expect(depositBody).toContain('const ownerScopeKey = activeOwnerScopeKey();');
    expect(depositBody).toContain(
      'isGhostBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey',
    );
    expect(depositBody).toContain('assertStillValid: assertOwnerScopeCurrent');
    expect(depositBody).toContain(
      'refCompensationScope: captureMediaRefCompensationScope(ownerScopeKey)',
    );
  });

  it('keeps Meka development reads and approved installs inside one app session', () => {
    const start = source.indexOf("ipcMain.handle('meka-dev-plugins:list'");
    const end = source.indexOf('\n  // 启动即对账一次 skill 槽链接', start);
    const body = source.slice(start, end);

    expect(body).toContain('const expectedOwner = captureGhostMutationOwner();');
    expect(body).toContain('!isSameAppSession(expectedOwner, getActiveAppSession())');
    expect(body).toContain('expectedPackageSha256');
    expect(body).toContain('expectedSessionGeneration');
    // 开发目录装入的 owner 绑定(第四轮同步 P0 修复后的形状):确认可能等用户几分钟,
    // 不能持租约,所以「打包前捕获 owner → 确认 → 取租约」被拆成两道同步检查——
    // 入口的 assertGhostMutationOwnerStable,以及 deps 里 captureOwnerLease 的 acquire
    // (即 beginGhostMutation(捕获到的 owner))。
    expect(body).toContain('assertGhostMutationOwnerStable(expectedOwner);');
    expect(source).toContain('captureOwnerLease: () => {');
    expect(source).toContain('const owner = captureGhostMutationOwner();');
    expect(source).toContain('return { acquire: () => beginGhostMutation(owner) };');
    expect(source).toContain("import { watcherHostClient } from '../watcher-host/index.js';");
    expect(body).not.toContain("await import('../watcher-host/index.js')");
  });

  it('resolves Meka development install consent on the derived package inspection', () => {
    // P0 回归(index.ts 依赖 Electron 进程态,不能直接 import,沿用本文件的源码契约模式):
    // 确认必须落在**即将落位那份派生包**的 inspection 上,否则 `ghostInstallConsentKey`
    // 的 ghostId/包摘要与锁内复核对不上,用户确认后必然 PRECONDITION_FAILED。
    const resolveStart = source.indexOf('const resolveDevelopmentPackageConsent = (');
    const resolveEnd = source.indexOf('\n  const installDevelopmentPackage = async (', resolveStart);
    expect(resolveStart).toBeGreaterThan(-1);
    const resolveBody = source.slice(resolveStart, resolveEnd);
    expect(resolveBody).toContain('obtainGhostInstallConsent(');
    expect(resolveBody).toContain('inspected.manifest,');
    expect(resolveBody).toContain('inspected.packageSha256,');
    expect(resolveBody).not.toContain("mode: 'decision'");
    expect(resolveBody).not.toContain('mekaDevRuntimeId');

    const installStart = resolveEnd;
    const installEnd = source.indexOf('\n  const updateDevelopmentPackage = async (', installStart);
    const installBody = source.slice(installStart, installEnd);
    const consentAt = installBody.indexOf(
      'await resolveDevelopmentPackageConsent(authorization, inspected)',
    );
    const leaseAt = installBody.indexOf('ownerLease.acquire()');
    const dockAt = installBody.indexOf('installAndDock(');
    expect(consentAt).toBeGreaterThan(-1);
    // 顺序不变量:先求确认(不持租约)→ 再取租约 → 才落位。
    expect(leaseAt).toBeGreaterThan(consentAt);
    expect(dockAt).toBeGreaterThan(leaseAt);
    expect(installBody).toContain('consent: { decision, manifest: inspected.manifest }');
    expect(installBody).not.toContain('authorizeMekaDevPluginInstall');

    const updateEnd = source.indexOf('\n  const mekaDevPlugins = new MekaDevPluginManager(', installEnd);
    const updateBody = source.slice(installEnd, updateEnd);
    expect(updateBody.indexOf('ownerLease.acquire()')).toBeGreaterThan(
      updateBody.indexOf('await resolveDevelopmentPackageConsent(authorization, inspected)'),
    );
    expect(updateBody).toContain('assertGhostInstallConsent(');
    expect(updateBody).toContain('inspected.packageSha256,');

    // 策略本身:窗口级 prompt,initiator 是本人,来源与本页本地 .cindy 口径一致。
    const policyStart = source.indexOf('const mekaDevInstallAuthorization = (');
    const policyBody = source.slice(
      policyStart,
      source.indexOf('const verifyMekaDevPluginSource = async (', policyStart),
    );
    expect(policyBody).toContain("mode: 'prompt'");
    expect(policyBody).toContain('createWindowGhostInstallConsentPrompt(sender)');
    expect(policyBody).toContain("initiator: 'user'");
    expect(policyBody).toContain("origin: 'local-file'");

    // IPC 入口:锁外只验源码快照指纹与身份门,交出策略;不做任何预先求得的结论,
    // 也不在这里取 owner 租约(租约由 deps 在确认之后取)。
    const handlerStart = source.indexOf("ipcMain.handle('meka-dev-plugins:install'");
    const handlerEnd = source.indexOf("\n  ipcMain.handle('meka-dev-plugins:package'", handlerStart);
    const handlerBody = source.slice(handlerStart, handlerEnd);
    expect(handlerBody).toContain('const authorization = mekaDevInstallAuthorization(event.sender);');
    expect(handlerBody).toContain('await verifyMekaDevPluginSource(');
    expect(handlerBody).toContain('assertGhostMutationOwnerStable(expectedOwner);');
    expect(handlerBody).toContain('await mekaDevPlugins.install(');
    expect(handlerBody).not.toContain('beginGhostMutation(');
    expect(handlerBody).not.toContain('obtainGhostInstallConsent(');
  });
});
