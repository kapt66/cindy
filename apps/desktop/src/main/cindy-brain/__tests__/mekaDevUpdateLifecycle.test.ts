/**
 * dev 目录同步热更新的运行实例代次、生命周期与 /kv 目标守卫回归（2026-11-18 用户实测；
 * 2026-11-19 独立审查修复）。
 *
 * Bug／规则依据：
 * 1. `MekaDevPluginManager` 的自动同步在派生包内容变化后调用 `updateDevelopmentPackage`
 *    （`cindy-brain/index.ts`）。该实现曾用**逻辑 runtimeId**（`meka-dev-*`）去停
 *    runtime／Node broker／Agent slot，但开发副本固定落 root，生命周期账本键都是
 *    **物理实例键** `_root__meka-dev-*` ⇒ 停止全部落空。更新提交后旧沙箱继续报 running，
 *    活跃会话的 `/kv` 请求仍打在旧 receipt 分区上，`cindy-ghost://` 目标守卫判定「已过期」
 *    后持续 403，只有重启 Cindy 才恢复。同时该路径也没有像市场/本地包更新那样
 *    `await stopPluginAppInstance` / `stopAndWait`、清理 errand 槽并暂停浏览器扩展槽，
 *    所以「与市场更新同口径」不成立。
 * 2. 旧用例的 `/kv` 断言用的是**同形谓词**（测试里手写 `captured !== null && current ===
 *    captured`），并没有执行生产判据，属于 overclaim。现在改为抽取并执行生产
 *    `setGhostKvStore` 回调与 `createGhostProtocolTargetGuard`
 *    （`runtime/electronSandboxAdapter.ts`——真正产生 403 的那段），端到端跑
 *    `handleGhostKvRequest`。
 *
 * 覆盖缺口：`mekaDevPlugins.test.ts` 只覆盖 manager 侧注入的 `updatePackage` 依赖，
 * 没有覆盖 index.ts 里真正执行生命周期的那段函数体；`ghostProtocolTargetLookup.test.ts`
 * 覆盖的是「卸载 / 换账号 / 换实例」的端点目标语义，没有覆盖「同实例换 receipt revision」。
 *
 * tier: unit（真实 GhostRuntime + 生产 kv store/目标守卫 + 真实 /kv 端点，不启动 Electron）。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ghostInstallApprovalToken,
  type GhostManifest,
  type InstalledGhost,
} from '../../../shared/ghost';
import {
  installedGhostMutationTargetToken,
  installedGhostStoragePart,
} from '../../../shared/pluginIdentity';
import { findGhostForInstanceIdIn } from '../ghostAvailability';
import { ownerScopedGhostPartitionForInstalledGhost } from '../ghostWebviewPartition';
import { GhostRuntime } from '../runtime/GhostRuntime';
import { handleGhostKvRequest } from '../runtime/ghostKvEndpoint';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture';

const RUNTIME_ID = 'meka-dev-meka-submit-6953b2fd';
/** 开发副本固定落 root：通用插件页与生命周期账本都只认这个物理实例键。 */
const INSTANCE_KEY = `_root__${RUNTIME_ID}`;
const DIR = `/brain/_ns/_root/${RUNTIME_ID}`;
const OWNER_SCOPE = 'cloud:opaque-owner-a:1';
const OWNER = { mode: 'cloud' as const, dataOwnerId: 'owner-a', generation: 1 };
const PARTITION = 'cindy-ghost-partition';

const manifest = (): GhostManifest => ({
  schemaVersion: 2,
  id: RUNTIME_ID,
  name: 'Meka 提交',
  version: '0.12.9',
  kind: 'chip',
  entry: 'main.js',
  slots: ['tool'],
  tools: [{ name: 'submit_start', description: '开始提交' }],
});

function devGhost(revision: string, version = '0.12.9'): InstalledGhost {
  return {
    manifest: { ...manifest(), version },
    dir: DIR,
    instanceKey: INSTANCE_KEY,
    namespace: null,
    enabled: true,
    approval: { state: 'approved', revision },
  };
}

type UpdateFn = (
  cindyPath: string,
  expectedId: string,
  authorization: unknown,
  ownerLease: { acquire(): () => void },
) => Promise<InstalledGhost>;

const loadUpdateDevelopmentPackage = createGhostProductionCallbacks<{
  updateDevelopmentPackage: UpdateFn;
}>({ variables: ['updateDevelopmentPackage'] });

/** 真实一次性 GhostRuntime 适配器：记录创建/销毁，load 由用例显式放行。 */
function createRuntimeHarness() {
  const created: InstalledGhost[] = [];
  const destroyed: InstalledGhost[] = [];
  const loads: Array<{ resolve(): void; reject(error: Error): void }> = [];
  const runtime = new GhostRuntime({
    adapter: {
      create: (ghost) => {
        created.push(ghost);
        return {
          load: () =>
            new Promise<void>((resolve, reject) => {
              loads.push({ resolve, reject });
            }),
          destroy: () => {
            destroyed.push(ghost);
          },
          crashForTest: () => undefined,
          onGone: () => undefined,
        };
      },
    },
  });
  return { runtime, created, destroyed, loads };
}

/**
 * 生产更新的生命周期桩：按调用顺序记账，锁住「先暂停浏览器扩展槽 → 停沙箱并等退出 →
 * 清 Agent/errand 槽 → 提交 manager.update → 恢复浏览器扩展槽」。顺序与市场更新
 * （`applyMarketGhostUpdate`）一致，是「同口径」的可执行定义。
 */
function lifecycleHarness(order: string[]) {
  const releaseBrowserUpdate = vi.fn(() => {
    order.push('browser.release');
  });
  const prepareUpdate = vi.fn(async () => {
    order.push('browser.prepareUpdate');
    return releaseBrowserUpdate;
  });
  const stopPluginAppInstance = vi.fn(async () => {
    order.push('stopPluginAppInstance');
  });
  const stopAndWait = vi.fn(async () => {
    order.push('node.stopAndWait');
  });
  const clearAgent = vi.fn(() => {
    order.push('agent.clearGhost');
  });
  const clearErrand = vi.fn(() => {
    order.push('errand.clearGhost');
  });
  return {
    deps: {
      stopPluginAppInstance,
      getGhostNodeRuntimeBroker: () => ({ stopAndWait }),
      getGhostAgentSlot: () => ({ clearGhost: clearAgent }),
      getGhostErrandSlot: () => ({ clearGhost: clearErrand }),
      getGhostBrowserExtensionSlot: () => ({ prepareUpdate }),
    },
    prepareUpdate,
    releaseBrowserUpdate,
    stopPluginAppInstance,
    stopAndWait,
    clearAgent,
    clearErrand,
  };
}

const lifecycleOrder = [
  'browser.prepareUpdate',
  'stopPluginAppInstance',
  'node.stopAndWait',
  'agent.clearGhost',
  'errand.clearGhost',
  'manager.update',
  'browser.release',
] as const;

describe('dev 目录同步更新的运行实例代次', () => {
  it('内容更新换 receipt 后按物理实例键停旧代次、清理槽位，下一笔调用重绑到新实例', async () => {
    const oldGhost = devGhost('11111111-1111-4111-8111-111111111111');
    const updatedGhost = devGhost('22222222-2222-4222-8222-222222222222');
    const harness = createRuntimeHarness();
    const oldStartup = harness.runtime.spawn(oldGhost);
    harness.loads[0].resolve();
    await oldStartup;
    expect(harness.runtime.stateOf(INSTANCE_KEY)).toBe('running');

    const order: string[] = [];
    const lifecycle = lifecycleHarness(order);
    const spawnIfResident = vi.fn();
    const manager = {
      list: vi.fn(() => [oldGhost]),
      update: vi.fn(async () => {
        order.push('manager.update');
        return { ghost: updatedGhost };
      }),
    };
    const update = loadUpdateDevelopmentPackage({
      manager,
      runtime: harness.runtime,
      inspectDevelopmentPackage: vi.fn(async () => ({
        manifest: updatedGhost.manifest,
        packageSha256: 'b'.repeat(64),
      })),
      resolveDevelopmentPackageConsent: vi.fn(async () => ({ state: 'approved' })),
      assertGhostInstallConsent: vi.fn(),
      installAndDock: vi.fn(),
      spawnIfResident,
      ...lifecycle.deps,
      throwIpcError: (code: string, message: string): never => {
        throw new Error(`${code}: ${message}`);
      },
    }).updateDevelopmentPackage;

    await expect(
      update('/tmp/dev.cindy', RUNTIME_ID, { mode: 'automatic' }, { acquire: () => () => undefined }),
    ).resolves.toBe(updatedGhost);

    // 修复前：三处都收到逻辑 runtimeId，账本键 `_root__*` 找不到条目 ⇒ 旧沙箱继续
    // running；且没有 await 旧进程退出、没有清理 errand 槽、没有暂停浏览器扩展槽。
    expect(harness.runtime.stateOf(INSTANCE_KEY)).toBe('off');
    expect(harness.destroyed).toHaveLength(1);
    // 与市场更新同口径的顺序（不可交换）：暂停浏览器扩展槽 → 停沙箱（await）→
    // 等 Node broker 退出 → 清 Agent / errand 槽 → 提交更新 → 释放浏览器扩展槽。
    expect(order).toEqual([...lifecycleOrder]);
    expect(lifecycle.prepareUpdate).toHaveBeenCalledWith(INSTANCE_KEY);
    expect(lifecycle.stopPluginAppInstance).toHaveBeenCalledWith(INSTANCE_KEY);
    expect(lifecycle.stopAndWait).toHaveBeenCalledWith(INSTANCE_KEY);
    expect(lifecycle.clearAgent).toHaveBeenCalledWith(INSTANCE_KEY);
    expect(lifecycle.clearErrand).toHaveBeenCalledWith(INSTANCE_KEY);
    expect(lifecycle.releaseBrowserUpdate).toHaveBeenCalledTimes(1);
    expect(spawnIfResident).toHaveBeenCalledExactlyOnceWith(updatedGhost);
    // 输入就是「内容指纹变了」的同步:新 packageSha256 + 旧批准 token 绑定的原子更新。
    expect(manager.update).toHaveBeenCalledExactlyOnceWith('/tmp/dev.cindy', {
      expectedInstalledApproval: ghostInstallApprovalToken(oldGhost.approval),
      expectedPackageSha256: 'b'.repeat(64),
    });

    // 旧 receipt 分区随更新作废；新代次按更新后的记录拉起、注册新 receipt 分区。
    const oldPartition = ownerScopedGhostPartitionForInstalledGhost(oldGhost, OWNER);
    const newPartition = ownerScopedGhostPartitionForInstalledGhost(updatedGhost, OWNER);
    expect(newPartition).not.toBe(oldPartition);
    const rebind = harness.runtime.spawn(updatedGhost);
    expect(harness.created[1]).toBe(updatedGhost);
    harness.loads[1].resolve();
    await rebind;
    expect(harness.runtime.stateOf(INSTANCE_KEY)).toBe('running');
  });

  it('更新失败时旧版本恢复 resident，且浏览器扩展槽一定被恢复（不长期停在 updating）', async () => {
    const oldGhost = devGhost('11111111-1111-4111-8111-111111111111');
    const harness = createRuntimeHarness();
    const oldStartup = harness.runtime.spawn(oldGhost);
    harness.loads[0].resolve();
    await oldStartup;

    const order: string[] = [];
    const lifecycle = lifecycleHarness(order);
    const spawnIfResident = vi.fn();
    const update = loadUpdateDevelopmentPackage({
      manager: {
        list: vi.fn(() => [oldGhost]),
        update: vi.fn(async () => {
          order.push('manager.update');
          throw new Error('update failed');
        }),
      },
      runtime: harness.runtime,
      inspectDevelopmentPackage: vi.fn(async () => ({
        manifest: oldGhost.manifest,
        packageSha256: 'b'.repeat(64),
      })),
      resolveDevelopmentPackageConsent: vi.fn(async () => ({ state: 'approved' })),
      assertGhostInstallConsent: vi.fn(),
      installAndDock: vi.fn(),
      spawnIfResident,
      ...lifecycle.deps,
      throwIpcError: (code: string, message: string): never => {
        throw new Error(`${code}: ${message}`);
      },
    }).updateDevelopmentPackage;

    await expect(
      update('/tmp/dev.cindy', RUNTIME_ID, { mode: 'automatic' }, { acquire: () => () => undefined }),
    ).rejects.toThrow('update failed');
    expect(order).toEqual([...lifecycleOrder]);
    expect(lifecycle.releaseBrowserUpdate).toHaveBeenCalledTimes(1);
    expect(spawnIfResident).toHaveBeenCalledExactlyOnceWith(oldGhost);
  });
});

/**
 * /kv 端点级回归：**执行生产判据**。
 *
 * - store 来自 `index.ts` 里注册给 `cindy-ghost://` handler 的 `setGhostKvStore({...})`
 *   回调（`captureTarget` / `isTargetCurrent` 都是生产函数，令牌由
 *   `installedGhostMutationTargetToken` 生成）；
 * - isCurrent 来自 `electronSandboxAdapter.ts` 的 `createGhostProtocolTargetGuard`
 *   （每个协议请求前真正调用的那段守卫；分区未撤销、owner 活跃由用例固定放行）；
 * - 请求走真实 `handleGhostKvRequest`。
 *
 * 因此 403 不再由测试手写的同形谓词得出，而是与生产链路同源。
 */
type KvStore = {
  captureTarget(ghostId: string): string | null;
  isTargetCurrent(ghostId: string, expectedTarget: string | null): boolean;
  read(ghostId: string): Record<string, unknown>;
  write(ghostId: string, value: Record<string, unknown>): void;
};

function loadProductionKvHarness(current: () => InstalledGhost[], ownerScope: () => string) {
  const kv = new Map<string, Record<string, unknown>>();
  const { store } = createGhostProductionCallbacks<{ store: KvStore }>({
    functions: ['findGhostForInstanceId', 'ghostInstallMutationTargetFor'],
    variables: ['ghostInstalled'],
    callbacks: { store: ['setGhostKvStore'] },
  })({
    getGhostManager: () => ({
      list: current,
      findInstalledInstance: (key: string) =>
        current().find((ghost) => installedGhostStoragePart(ghost) === key) ?? null,
    }),
    isGhostAvailableForActiveSession: () => true,
    availableGhosts: current,
    findGhostForInstanceIdIn,
    isAppSessionBoundaryPending: () => false,
    activeOwnerScopeKey: ownerScope,
    installedGhostMutationTargetToken,
    ghostKv: {
      read: (ghostId: string) => kv.get(ghostId) ?? {},
      write: (ghostId: string, value: Record<string, unknown>) => {
        kv.set(ghostId, value);
      },
    },
    getGhostSetupChangeBus: () => ({ emit: () => undefined }),
  });

  const { createGhostProtocolTargetGuard } = createGhostProductionCallbacks<{
    createGhostProtocolTargetGuard: (
      ghostId: string,
      partition: string,
      owner: unknown,
    ) => () => boolean;
  }>({
    source: new URL('../runtime/electronSandboxAdapter.ts', import.meta.url),
    functions: ['createGhostProtocolTargetGuard'],
  })({
    ghostKvStore: store,
    revokedPartitions: new Set<string>(),
    isGhostProtocolOwnerActive: () => true,
  });

  return {
    store,
    captureGuard: (ghostId: string) =>
      createGhostProtocolTargetGuard(ghostId, PARTITION, OWNER),
  };
}

function kvRequest(
  store: KvStore,
  guard: () => boolean,
  method: 'GET' | 'PUT',
  body?: Record<string, unknown>,
) {
  return handleGhostKvRequest({
    method,
    readBodyText: async () => (body === undefined ? '' : JSON.stringify(body)),
    store,
    ghostId: INSTANCE_KEY,
    isCurrent: guard,
  });
}

describe('/kv 的 receipt 目标守卫（生产 store + 生产 guard + 真实端点）', () => {
  const oldGhost = devGhost('11111111-1111-4111-8111-111111111111');
  const updatedGhost = devGhost('22222222-2222-4222-8222-222222222222');

  it('更新后旧代次的读写一律 403，重绑到当前 receipt 的代次读写成功', async () => {
    let ghosts: InstalledGhost[] = [oldGhost];
    let ownerScope = OWNER_SCOPE;
    const { store, captureGuard } = loadProductionKvHarness(
      () => ghosts,
      () => ownerScope,
    );

    // 更新前注册的协议守卫捕获旧 receipt 目标（生产 handler 在分区注册时捕获一次）。
    const staleGuard = captureGuard(INSTANCE_KEY);
    expect(staleGuard()).toBe(true);
    expect((await kvRequest(store, staleGuard, 'GET')).status).toBe(200);

    // 内容同步更新提交：同实例、同目录，只有 receipt revision 变了。
    ghosts = [updatedGhost];
    expect(staleGuard()).toBe(false);
    expect((await kvRequest(store, staleGuard, 'GET')).status).toBe(403);
    expect((await kvRequest(store, staleGuard, 'PUT', { started: true })).status).toBe(403);
    // 403 的写没有落进存储。
    const reboundGuard = captureGuard(INSTANCE_KEY);
    expect(reboundGuard()).toBe(true);
    expect((await kvRequest(store, reboundGuard, 'GET')).status).toBe(200);
    expect((await kvRequest(store, reboundGuard, 'GET')).body).toBe('{}');

    // 派发器按新记录重绑后重新注册分区 → 新守卫捕获新目标，读写恢复。
    expect((await kvRequest(store, reboundGuard, 'PUT', { started: true })).status).toBe(204);
    expect((await kvRequest(store, reboundGuard, 'GET')).body).toBe(
      JSON.stringify({ started: true }),
    );
  });

  it('换账号、换成另一个实例、卸载后仍必须 403（不放宽成任何旧实例都放行）', async () => {
    let ghosts: InstalledGhost[] = [updatedGhost];
    let ownerScope = OWNER_SCOPE;
    const { store, captureGuard } = loadProductionKvHarness(
      () => ghosts,
      () => ownerScope,
    );
    const currentGuard = captureGuard(INSTANCE_KEY);
    expect(currentGuard()).toBe(true);

    // 换账号：owner scope 变了，捕获目标与当前目标不再相等。
    ownerScope = 'cloud:opaque-owner-b:2';
    expect(currentGuard()).toBe(false);
    expect((await kvRequest(store, currentGuard, 'GET')).status).toBe(403);
    ownerScope = OWNER_SCOPE;
    expect(currentGuard()).toBe(true);

    // 换成另一个实例：查询键仍是旧实例，但当前在装记录已换成另一实例 ⇒ 目标为 null。
    const oldGuard = captureGuard(INSTANCE_KEY);
    expect(oldGuard()).toBe(true);
    ghosts = [
      {
        ...updatedGhost,
        manifest: { ...updatedGhost.manifest, id: 'meka-dev-meka-submit-00000000' },
        instanceKey: '_root__meka-dev-meka-submit-00000000',
        dir: '/brain/_ns/_root/meka-dev-meka-submit-00000000',
      },
    ];
    expect(oldGuard()).toBe(false);
    expect((await kvRequest(store, oldGuard, 'GET')).status).toBe(403);

    // 卸载后当前在装记录为空 → captureTarget 为 null → 守卫恒拒。
    ghosts = [];
    expect(oldGuard()).toBe(false);
    expect((await kvRequest(store, oldGuard, 'GET')).status).toBe(403);
  });
});
