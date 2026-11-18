/**
 * dev 目录同步热更新的运行实例代次回归（2026-11-18 用户实测）。
 *
 * Bug／规则依据：`MekaDevPluginManager` 的自动同步在派生包内容变化后调用
 * `updateDevelopmentPackage`（`cindy-brain/index.ts`）。该实现当时用**逻辑 runtimeId**
 * （`meka-dev-*`）去停 runtime／Node broker／Agent slot，但开发副本固定落 root，三处
 * 生命周期账本键都是**物理实例键** `_root__meka-dev-*` ⇒ 停止全部落空。更新提交后旧
 * 沙箱继续报 running，活跃会话的 `/kv` 请求仍打在旧 receipt 分区上，`cindy-ghost://`
 * 目标守卫判定「已过期」后持续 403，只有重启 Cindy 才恢复。
 *
 * 覆盖缺口：`mekaDevPlugins.test.ts` 只覆盖 manager 侧注入的 `updatePackage` 依赖，
 * 没有覆盖 index.ts 里真正执行生命周期的那段函数体。本用例用仓库既有的
 * `ghostProductionCallbacksFixture` 抽取并执行**生产源码里的**
 * `updateDevelopmentPackage`，锁住「内容更新换 receipt 后，必须按物理实例键停掉旧
 * 代次，并让下一笔调用重绑到新实例」这条契约；再用真实 `handleGhostKvRequest` +
 * 真实目标令牌函数验证 `/kv` 的放行判据没有放宽（旧代次／换账号／换实例／卸载仍 403）。
 *
 * tier: unit（真实 GhostRuntime + 真实 /kv 端点与身份令牌函数，不启动 Electron）。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ghostInstallApprovalToken,
  type GhostManifest,
  type InstalledGhost,
} from '../../../shared/ghost';
import { installedGhostMutationTargetToken } from '../../../shared/pluginIdentity';
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
          load: () => new Promise<void>((resolve, reject) => {
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

describe('dev 目录同步更新的运行实例代次', () => {
  it('内容更新换 receipt 后按物理实例键停旧代次，下一笔调用重绑到新实例', async () => {
    const oldGhost = devGhost('11111111-1111-4111-8111-111111111111');
    const updatedGhost = devGhost('22222222-2222-4222-8222-222222222222');
    const harness = createRuntimeHarness();
    const oldStartup = harness.runtime.spawn(oldGhost);
    harness.loads[0].resolve();
    await oldStartup;
    expect(harness.runtime.stateOf(INSTANCE_KEY)).toBe('running');

    const nodeStop = vi.fn();
    const clearGhost = vi.fn();
    const spawnIfResident = vi.fn();
    const manager = {
      list: vi.fn(() => [oldGhost]),
      update: vi.fn(async () => ({ ghost: updatedGhost })),
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
      getGhostNodeRuntimeBroker: () => ({ stop: nodeStop }),
      getGhostAgentSlot: () => ({ clearGhost }),
      throwIpcError: (code: string, message: string): never => {
        throw new Error(`${code}: ${message}`);
      },
    }).updateDevelopmentPackage;

    await expect(
      update('/tmp/dev.cindy', RUNTIME_ID, { mode: 'automatic' }, { acquire: () => () => undefined }),
    ).resolves.toBe(updatedGhost);

    // 修复前：三处都收到逻辑 runtimeId，账本键 `_root__*` 找不到条目 ⇒ 旧沙箱继续 running。
    expect(harness.runtime.stateOf(INSTANCE_KEY)).toBe('off');
    expect(harness.destroyed).toHaveLength(1);
    expect(nodeStop).toHaveBeenCalledExactlyOnceWith(INSTANCE_KEY);
    expect(clearGhost).toHaveBeenCalledExactlyOnceWith(INSTANCE_KEY);
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
});

describe('/kv 的 receipt 目标守卫', () => {
  const oldGhost = devGhost('11111111-1111-4111-8111-111111111111');
  const updatedGhost = devGhost('22222222-2222-4222-8222-222222222222');
  const oldTarget = installedGhostMutationTargetToken(oldGhost, OWNER_SCOPE);
  const currentTarget = installedGhostMutationTargetToken(updatedGhost, OWNER_SCOPE);

  /**
   * 与生产判据同形（`index.ts` 的 `setGhostKvStore.isTargetCurrent`）：
   * 注册时捕获的目标必须非空且等于当前在装记录的目标令牌。
   */
  function kvRequest(
    current: string | null,
    captured: string | null,
    method: 'GET' | 'PUT' = 'GET',
    body?: Record<string, unknown>,
    store = new Map<string, Record<string, unknown>>(),
  ) {
    return {
      store,
      run: () => handleGhostKvRequest({
        method,
        readBodyText: async () => (body === undefined ? '' : JSON.stringify(body)),
        store: {
          read: (key) => store.get(key) ?? {},
          write: (key, value) => {
            store.set(key, value);
          },
        },
        ghostId: INSTANCE_KEY,
        isCurrent: () => captured !== null && current === captured,
      }),
    };
  }

  it('更新后旧代次的读写一律 403，重绑到当前 receipt 的代次读写成功', async () => {
    expect(currentTarget).not.toBe(oldTarget);
    expect((await kvRequest(currentTarget, oldTarget).run()).status).toBe(403);
    const rejectedWrite = kvRequest(currentTarget, oldTarget, 'PUT', { started: true });
    expect((await rejectedWrite.run()).status).toBe(403);
    expect(rejectedWrite.store.size).toBe(0);

    const store = new Map<string, Record<string, unknown>>();
    expect((await kvRequest(currentTarget, currentTarget, 'GET', undefined, store).run()).status).toBe(200);
    expect((await kvRequest(currentTarget, currentTarget, 'PUT', { started: true }, store).run()).status).toBe(204);
    expect((await kvRequest(currentTarget, currentTarget, 'GET', undefined, store).run()).body)
      .toBe(JSON.stringify({ started: true }));
  });

  it('换账号、换成另一个实例、卸载后仍必须 403（不放宽成任何旧实例都放行）', async () => {
    const otherOwnerTarget = installedGhostMutationTargetToken(
      updatedGhost,
      'cloud:opaque-owner-b:2',
    );
    expect(otherOwnerTarget).not.toBe(currentTarget);
    expect((await kvRequest(otherOwnerTarget, currentTarget).run()).status).toBe(403);

    const otherInstanceTarget = installedGhostMutationTargetToken({
      ...updatedGhost,
      manifest: { ...updatedGhost.manifest, id: 'meka-dev-meka-submit-00000000' },
      instanceKey: '_root__meka-dev-meka-submit-00000000',
      dir: '/brain/_ns/_root/meka-dev-meka-submit-00000000',
    }, OWNER_SCOPE);
    expect(otherInstanceTarget).not.toBe(currentTarget);
    expect((await kvRequest(otherInstanceTarget, currentTarget).run()).status).toBe(403);

    // 卸载后当前在装记录为空 → captureTarget 为 null → 守卫恒拒。
    expect((await kvRequest(null, currentTarget).run()).status).toBe(403);
  });
});
