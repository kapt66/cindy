/**
 * modelVisibilityPrefs.test.ts
 * ---------------------------------------------------------------------------
 * 回归 state/modelVisibilityPrefs.ts 的核心约定:
 *   1. 新配置首次目录初始化；已初始化或既有配置不因目录默认改变
 *   1b. Meka 谱系一次性补种(2026-09-18 同步「用户裁决 A」后的最终口径):没有任何有效初始化
 *       清单的既有配置(含被新机制写成空清单的)**补种一次基线留痕** —— 写一次性标记、把
 *       「升级那一刻的目录基线」冻结进 `initialization.defaults`,并把整表重新镜像给 main。
 *       补种**不是可见性冻结**:可见性恒为「显式 override ?? 当前目录 defaultEnabled」
 *       (上游本轮语义,逐字等于 Meka 上一轮同步前的原生口径),所以存量 Meka 用户升级后
 *       看到的集合由目录原生满足,上一轮那起「选择器整张清空」的 P0 不会复现。
 *       依据:用户裁决 A(接纳上游语义);边界见
 *       docs/dev-rules/meka-whitelist-verification.md WL-10 与
 *       docs/dev-rules/configuration-and-overrides.md §2「Meka 谱系条款」。
 *   2. set override 覆盖目录默认(把默认开的关掉 / 把默认关的打开)
 *   3. set/get 往返 + owner-scoped localStorage 持久化(模拟 app 重启)
 *   4. 按 (agent, providerId, modelId) 分槽:同名模型在 cc / codex 互不覆盖
 *   5. setManyVisibility 批量(全部关 / 全部开)写显式 override
 *   6. 跨 agent 的一次用户操作原子落盘，失败不留下部分状态
 *   7. 同值写入短路(不抛)
 *   8. 旧全局 key 只由 Main 仲裁出的首个 owner 认领,新账号默认隔离
 *   9. schema 损坏 / 脏数据 → 不猜测开启未知模型
 *  10. main 镜像同步异步失败时不产生未处理 rejection
 *
 * 项目 vitest env=node,无 window。沿用 providerModelMemory.test.ts 的最小 localStorage stub。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildUserProvider, isModelVisible, unifiedModelEntries, type ProviderView,
} from '@cindy/model-providers';

import {
  __resetModelVisibilityMirrorForTest,
  getModelVisibilityOverride,
  setModelVisibilityMirror,
} from '../../main/maker-host/model-visibility-mirror';

class MemLocalStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

// Model Chromium's Web Locks explicitly. The Node test runner may also expose
// navigator.locks; that native implementation is not the renderer environment.
class Locks {
  chains = new Map<string, Promise<unknown>>();
  request<T>(key: string, run: () => T | Promise<T>): Promise<T> {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(run);
    this.chains.set(key, next.catch(() => undefined));
    return next;
  }
  hold(key = 'xdt:modelVisibilityPrefs:v1.initialization.owner.owner-a'): () => void {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    void this.request(key, () => held);
    return release;
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await Promise.all([...this.chains.values()]);
      await Promise.resolve();
    }
  }
}

let memStorage: MemLocalStorage;
// 显式声明参数,便于按真实推给 main 的 (snapshot, policy) 做端到端断言。
const syncModelVisibility = vi.fn(async (
  _ownerId: string | null,
  _generation: number,
  _snapshot: Record<string, boolean>,
  _policy?: unknown,
) => undefined);
const logToMain = vi.fn();
let ownerClaim: {
  dataOwnerId: string | null;
  ownerGeneration: number;
  canWriteOwnerScoped: boolean;
  claimed: boolean;
  claimedByOtherOwner?: boolean;
  canInitialize: boolean;
  profileOrigin?: 'new' | 'existing' | 'pending' | 'adopted-local';
};

function setOwnerClaim(
  dataOwnerId: string | null,
  ownerGeneration: number,
  claimed = true,
  canInitialize = true,
  claimedByOtherOwner = false,
  canWriteOwnerScoped = true,
): void {
  ownerClaim = {
    dataOwnerId,
    ownerGeneration,
    canWriteOwnerScoped,
    claimed,
    claimedByOtherOwner,
    canInitialize,
    profileOrigin: 'new',
  };
}

beforeEach(() => {
  memStorage = new MemLocalStorage();
  vi.stubGlobal('navigator', { locks: new Locks() });
  syncModelVisibility.mockClear();
  logToMain.mockClear();
  setOwnerClaim('owner-a', 1);
  vi.stubGlobal('window', {
    localStorage: memStorage,
    electronAPI: {
      logToMain,
      maker: {
        syncModelVisibility,
        claimLegacyModelVisibilityOwner: () => ownerClaim,
      },
    },
  });
  vi.stubGlobal('localStorage', memStorage);
  vi.resetModules();
});

describe('shared origin readiness', () => {
  it('does not publish transient pending while a reloaded renderer waits for its owner lock', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.migration-complete.owner.owner-a', '1');
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.owner.owner-a', JSON.stringify({ 'pi:xd:kept': false }));
    const locks = new Locks();
    vi.stubGlobal('navigator', { locks });
    const release = locks.hold();
    const prefs = await loadModule();
    const initialization = prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    await Promise.resolve();
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'kept' })).toBe(false);
    expect(syncModelVisibility).not.toHaveBeenCalled();
    release();
    await initialization;
    expect(syncModelVisibility).toHaveBeenCalled();
    expect(syncModelVisibility).not.toHaveBeenCalledWith('owner-a', 1,
      expect.anything(), expect.objectContaining({ pending: true }));
  });

  it('does not repeat owner claims for preference operations while legacy storage stays absent', async () => {
    setOwnerClaim('owner-a', 1, true, false);
    ownerClaim.profileOrigin = 'existing';
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.local-adoption.owner.owner-a', '1');
    const claim = vi.spyOn(window.electronAPI.maker, 'claimLegacyModelVisibilityOwner');
    const prefs = await loadModuleForOwner();
    await prefs.migrateModelVisibilityDefaults('owner-a', 1, []);
    claim.mockClear();
    expect(await prefs.setModelVisibility('pi', 'xd', 'kept', false)).toBe(true);
    expect(claim).not.toHaveBeenCalled();
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.migration-complete.owner.owner-a')).toBeNull();
  });
});

describe('local profile visibility adoption', () => {
  const initKey = (owner: string) => `xdt:modelVisibilityPrefs:v1.initialization.owner.${owner}`;
  const mapKey = (owner: string) => `xdt:modelVisibilityPrefs:v1.owner.${owner}`;
  const source = {
    eligibleForDefaults: true,
    defaults: { 'pi:xd:default': true, 'pi:xd:off': true },
    scopes: [JSON.stringify(['xd', 'pi'])],
    followCatalogKeys: ['pi:xd:restored'],
  };
  const catalog = {
    id: 'xd', agents: ['pi'], routing: {}, models: { pi: [
      { id: 'default', defaultEnabled: false }, { id: 'off', defaultEnabled: true },
      { id: 'added', defaultEnabled: true },
    ] },
  } as ProviderView;
  function seed() {
    memStorage.setItem(initKey('local-v1'), JSON.stringify(source));
    memStorage.setItem(mapKey('local-v1'), JSON.stringify({ 'pi:xd:off': false, 'pi:xd:on': true }));
    setOwnerClaim('owner-a', 1, false, false, true);
    ownerClaim.profileOrigin = 'adopted-local';
  }

  it('retains local defaults, explicit switches and restore-default routes across cloud login and restart', async () => {
    seed();
    let prefs = await import('../state/modelVisibilityPrefs');
    await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    expect(await prefs.migrateModelVisibilityDefaults('owner-a', 1, [catalog])).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'default', defaultEnabled: false })).toBe(false);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'off', defaultEnabled: true })).toBe(false);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'on', defaultEnabled: false })).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'added', defaultEnabled: true })).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'restored', defaultEnabled: true })).toBe(true);
    expect(await prefs.migrateModelVisibilityDefaults('owner-a', 1, [{ ...catalog,
      agents: ['codex'], models: { codex: [{ id: 'late', defaultEnabled: true }] },
    } as ProviderView])).toBe(true);
    expect(prefs.isModelEnabled('codex', 'xd', { id: 'late', defaultEnabled: false })).toBe(false);
    expect(JSON.parse(memStorage.getItem(initKey('local-v1'))!)).toEqual(source);
    await prefs.setModelVisibility('pi', 'xd', 'default', false);
    vi.resetModules();
    prefs = await import('../state/modelVisibilityPrefs');
    await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'default', defaultEnabled: true })).toBe(false);
    setOwnerClaim('owner-b', 2, false, false, true);
    ownerClaim.profileOrigin = 'existing';
    await prefs.setModelVisibilityOwner('owner-b', 2, 'cloud');
    expect(await prefs.migrateModelVisibilityDefaults('owner-b', 2, [catalog])).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'on', defaultEnabled: true })).toBe(true);
  });

  it('keeps target overrides and initialized scopes authoritative', async () => {
    seed();
    memStorage.setItem(mapKey('owner-a'), JSON.stringify({ 'pi:xd:on': false }));
    memStorage.setItem(initKey('owner-a'), JSON.stringify({
      eligibleForDefaults: false, defaults: { 'pi:xd:default': false },
      scopes: source.scopes, followCatalogKeys: [],
    }));
    const prefs = await import('../state/modelVisibilityPrefs');
    await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'on', defaultEnabled: true })).toBe(false);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'default', defaultEnabled: true })).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'restored', defaultEnabled: true })).toBe(true);
  });

  it.each([false, true])('preserves target restore-default choices through adoption and restart (interrupted: %s)', async (interrupted) => {
    seed();
    const sourceOverrides = { 'pi:xd:off': false, 'pi:xd:on': true, 'pi:xd:keep': true, 'pi:xd:manual': true };
    memStorage.setItem(mapKey('local-v1'), JSON.stringify(sourceOverrides));
    memStorage.setItem(initKey('owner-a'), JSON.stringify({
      eligibleForDefaults: false, defaults: {}, scopes: [],
      followCatalogKeys: ['pi:xd:off', 'pi:xd:on', 'pi:xd:manual'],
    }));
    // A subsequent explicit target switch still outranks its earlier Restore defaults.
    memStorage.setItem(mapKey('owner-a'), JSON.stringify({ 'pi:xd:manual': false }));
    let prefs = await import('../state/modelVisibilityPrefs');
    if (interrupted) {
      const write = memStorage.setItem.bind(memStorage);
      const failure = vi.spyOn(memStorage, 'setItem').mockImplementation((key, value) => {
        if (key === initKey('owner-a')) throw new Error('disk full');
        write(key, value);
      });
      await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
      expect(await prefs.migrateModelVisibilityDefaults('owner-a', 1, [catalog])).toBe(false);
      failure.mockRestore();
      vi.resetModules();
      prefs = await import('../state/modelVisibilityPrefs');
    }
    await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    expect(await prefs.migrateModelVisibilityDefaults('owner-a', 1, [catalog])).toBe(true);
    const checkChoices = () => {
      for (const id of ['off', 'on']) {
        expect(prefs.isModelEnabled('pi', 'xd', { id, defaultEnabled: true })).toBe(true);
        expect(prefs.isModelEnabled('pi', 'xd', { id, defaultEnabled: false })).toBe(false);
      }
      expect(prefs.isModelEnabled('pi', 'xd', { id: 'manual', defaultEnabled: true })).toBe(false);
      expect(prefs.isModelEnabled('pi', 'xd', { id: 'keep', defaultEnabled: false })).toBe(true);
      expect(JSON.parse(memStorage.getItem(mapKey('owner-a'))!)).toEqual({ 'pi:xd:keep': true, 'pi:xd:manual': false });
      expect(JSON.parse(memStorage.getItem(mapKey('local-v1'))!)).toEqual(sourceOverrides);
    };
    checkChoices();
    vi.resetModules();
    prefs = await import('../state/modelVisibilityPrefs');
    await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    checkChoices();
  });

  it('retries a partial handoff after restart before publishing the catalog', async () => {
    seed();
    let prefs = await import('../state/modelVisibilityPrefs');
    const original = memStorage.setItem.bind(memStorage);
    const write = vi.spyOn(memStorage, 'setItem').mockImplementation((key, value) => {
      if (key === initKey('owner-a')) throw new Error('disk full');
      original(key, value);
    });
    await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    expect(await prefs.migrateModelVisibilityDefaults('owner-a', 1, [catalog])).toBe(false);
    expect(syncModelVisibility).toHaveBeenLastCalledWith('owner-a', 1, expect.any(Object), expect.objectContaining({ pending: true }));
    write.mockRestore();
    vi.resetModules();
    prefs = await import('../state/modelVisibilityPrefs');
    await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    expect(await prefs.migrateModelVisibilityDefaults('owner-a', 1, [catalog])).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'default', defaultEnabled: false })).toBe(false);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'off', defaultEnabled: true })).toBe(false);
  });

  it('does not infer adoption from a first-owner reservation or an existing cloud database', async () => {
    seed();
    ownerClaim.profileOrigin = 'existing';
    const prefs = await import('../state/modelVisibilityPrefs');
    await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    await prefs.migrateModelVisibilityDefaults('owner-a', 1, [catalog]);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'on', defaultEnabled: true })).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'default', defaultEnabled: true })).toBe(true);
  });

  it('waits for adoption provenance even when the target already has initialization artifacts', async () => {
    seed();
    memStorage.setItem(initKey('owner-a'), JSON.stringify({
      eligibleForDefaults: false, defaults: {}, scopes: [], followCatalogKeys: [],
    }));
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.migration-complete.owner.owner-a', '1');
    ownerClaim.profileOrigin = 'pending';
    const prefs = await import('../state/modelVisibilityPrefs');
    await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    expect(await prefs.migrateModelVisibilityDefaults('owner-a', 1, [catalog])).toBe(false);
    ownerClaim.profileOrigin = 'adopted-local';
    expect(await prefs.migrateModelVisibilityDefaults('owner-a', 1, [catalog])).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'default', defaultEnabled: false })).toBe(false);
  });

  it('does not adopt a corrupt local map as empty catalog defaults', async () => {
    seed();
    memStorage.setItem(mapKey('local-v1'), '{ not valid json');
    const prefs = await import('../state/modelVisibilityPrefs');
    await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'off', defaultEnabled: true })).toBe(false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.local-adoption.owner.owner-a')).toBeNull();
    expect(memStorage.getItem(mapKey('owner-a'))).toBeNull();
    memStorage.setItem(mapKey('local-v1'), JSON.stringify({ 'pi:xd:off': false }));
    expect(await prefs.migrateModelVisibilityDefaults('owner-a', 1, [catalog])).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'off', defaultEnabled: true })).toBe(false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.local-adoption.owner.owner-a')).toBe('1');
  });

  it('keeps source corruption latched when the cloud target map is already valid', async () => {
    seed();
    memStorage.setItem(mapKey('local-v1'), '{ not valid json');
    memStorage.setItem(mapKey('owner-a'), JSON.stringify({ 'pi:xd:on': false }));
    const prefs = await import('../state/modelVisibilityPrefs');
    await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'on', defaultEnabled: true })).toBe(false);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'off', defaultEnabled: true })).toBe(false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.local-adoption.owner.owner-a')).toBeNull();
    memStorage.setItem(mapKey('local-v1'), JSON.stringify({ 'pi:xd:off': false }));
    expect(await prefs.migrateModelVisibilityDefaults('owner-a', 1, [catalog])).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'off', defaultEnabled: true })).toBe(false);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'on', defaultEnabled: true })).toBe(false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.local-adoption.owner.owner-a')).toBe('1');
  });

  it('repairs a corrupt cloud target then retries adopted-local handoff', async () => {
    seed();
    memStorage.setItem(mapKey('owner-a'), '{ not valid json');
    const prefs = await import('../state/modelVisibilityPrefs');
    await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'off', defaultEnabled: true })).toBe(false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.local-adoption.owner.owner-a')).toBeNull();
    expect(await prefs.setModelVisibility('pi', 'xd', 'manual', false)).toBe(true);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.local-adoption.owner.owner-a')).toBe('1');
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'off', defaultEnabled: true })).toBe(false);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'on', defaultEnabled: false })).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'manual' })).toBe(false);
  });
});

describe('model visibility across renderer windows', () => {
  const initKey = 'xdt:modelVisibilityPrefs:v1.initialization.owner.owner-a';
  const mapKey = 'xdt:modelVisibilityPrefs:v1.owner.owner-a';
  const model = (id: string, defaultEnabled = true) => ({
    id, name: id, defaultEnabled, contextWindow: 200000, efforts: [], defaultEffort: null,
  });
  const catalog = (agent: 'pi' | 'codex' | 'claude-code', defaultEnabled = true): ProviderView => ({
    id: 'xd', name: 'Cindy AI', source: 'builtin', connected: true, agents: [agent],
    auth: { method: 'apiKey' }, routing: {}, models: { [agent]: [model(agent, defaultEnabled)] },
  } as ProviderView);

  // Shared queue models Chromium's cross-renderer Web Locks. Separate module instances
  // share storage and the lock manager, but each retains its own owner/cache state.
  let locks: Locks;
  let handlers: Array<(event: StorageEvent) => void>;

  beforeEach(() => {
    locks = new Locks();
    handlers = [];
    vi.stubGlobal('navigator', { locks });
    Object.assign(window, {
      addEventListener: (type: string, handler: (event: StorageEvent) => void) => {
        if (type === 'storage') handlers.push(handler);
      },
      removeEventListener: vi.fn(),
    });
    const setItem = memStorage.setItem.bind(memStorage);
    vi.spyOn(memStorage, 'setItem').mockImplementation((key, value) => {
      setItem(key, value);
      queueMicrotask(() => handlers.forEach((handler) => handler({ key } as StorageEvent)));
    });
  });
  afterEach(async () => {
    await locks.settle();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function windows() {
    const a = await loadModuleForOwner();
    vi.resetModules();
    const b = await loadModuleForOwner();
    await locks.settle();
    return { a, b };
  }

  it('waits for an in-flight local switch before adopting into a cloud window', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.initialization.owner.local-v1', JSON.stringify({
      eligibleForDefaults: true, defaults: { 'pi:xd:pi': true },
      scopes: [JSON.stringify(['xd', 'pi'])], followCatalogKeys: [],
    }));
    setOwnerClaim('owner-a', 1, false, false, true);
    ownerClaim.profileOrigin = 'adopted-local';
    const release = locks.hold('xdt:modelVisibilityPrefs:v1.initialization.owner.local-v1');
    const prefs = await import('../state/modelVisibilityPrefs');
    const adopting = prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    await Promise.resolve();
    expect(memStorage.getItem(mapKey)).toBeNull();
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.owner.local-v1', JSON.stringify({ 'pi:xd:pi': false }));
    release();
    await adopting;
    await locks.settle();
    expect(await prefs.migrateModelVisibilityDefaults('owner-a', 1, [catalog('pi')])).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', model('pi'))).toBe(false);
  });

  it('retries adopted-local handoff when another window repairs the local source', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.initialization.owner.local-v1', JSON.stringify({
      eligibleForDefaults: true, defaults: { 'pi:xd:pi': true },
      scopes: [JSON.stringify(['xd', 'pi'])], followCatalogKeys: [],
    }));
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.owner.local-v1', '{ not valid json');
    setOwnerClaim('owner-a', 1, false, false, true);
    ownerClaim.profileOrigin = 'adopted-local';
    const prefs = await import('../state/modelVisibilityPrefs');
    await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'other', defaultEnabled: true })).toBe(false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.local-adoption.owner.owner-a')).toBeNull();
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.owner.local-v1', JSON.stringify({ 'pi:xd:pi': false }));
    await locks.settle();
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.local-adoption.owner.owner-a')).toBe('1');
    expect(prefs.isModelEnabled('pi', 'xd', model('pi'))).toBe(false);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'other', defaultEnabled: true })).toBe(true);
  });

  it('retries legacy migration when another window repairs the global key', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1', '{ not valid json');
    setOwnerClaim('owner-a', 1, true, true);
    ownerClaim.profileOrigin = 'existing';
    const prefs = await import('../state/modelVisibilityPrefs');
    await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
    expect(prefs.isModelEnabled('codex', 'openai', { id: 'other', defaultEnabled: true })).toBe(false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.migration-complete.owner.owner-a')).toBeNull();
    memStorage.setItem('xdt:modelVisibilityPrefs:v1', JSON.stringify({ 'codex:openai:gpt-5.6': false }));
    await locks.settle();
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.migration-complete.owner.owner-a')).toBe('1');
    expect(prefs.isModelEnabled('codex', 'openai', { id: 'gpt-5.6', defaultEnabled: true })).toBe(false);
    expect(prefs.isModelEnabled('codex', 'openai', { id: 'other', defaultEnabled: true })).toBe(true);
  });

  it('serializes first catalogs without optimistic overwrites and keeps the first baseline frozen', async () => {
    const { a, b } = await windows();
    const release = locks.hold();
    const first = a.migrateModelVisibilityDefaults('owner-a', 1, [catalog('pi')]);
    const second = b.migrateModelVisibilityDefaults('owner-a', 1, [catalog('codex')]);
    expect(JSON.parse(memStorage.getItem(initKey)!).scopes).toEqual([]);
    release();
    await Promise.all([first, second]);
    await locks.settle();
    for (const prefs of [a, b]) {
      expect(prefs.isModelEnabled('pi', 'xd', model('pi', false))).toBe(false);
      expect(prefs.isModelEnabled('codex', 'xd', model('codex', false))).toBe(false);
    }
    const changed = catalog('pi', false);
    changed.models.pi!.push(model('later'));
    await b.migrateModelVisibilityDefaults('owner-a', 1, [changed]);
    vi.resetModules();
    const restarted = await loadModuleForOwner();
    expect(restarted.isModelEnabled('pi', 'xd', model('pi', false))).toBe(false);
    expect(restarted.isModelEnabled('pi', 'xd', model('later'))).toBe(true);
    expect(restarted.isModelEnabled('codex', 'xd', model('codex', false))).toBe(false);
  });

  it('rebases concurrent restores, explicit switches, and another initialized scope', async () => {
    const { a, b } = await windows();
    await a.migrateModelVisibilityDefaults('owner-a', 1, [catalog('pi'), catalog('codex')]);
    await a.setModelVisibility('pi', 'xd', 'pi', false);
    await b.setModelVisibility('codex', 'xd', 'codex', false);
    const release = locks.hold();
    const writes = [
      a.resetModelVisibilities('xd', [{ agent: 'pi', modelId: 'pi' }]),
      b.resetModelVisibilities('xd', [{ agent: 'codex', modelId: 'codex' }]),
      a.setModelVisibility('pi', 'xd', 'manual', true),
      b.migrateModelVisibilityDefaults('owner-a', 1, [catalog('claude-code')]),
    ];
    expect(a.isModelEnabled('pi', 'xd', model('pi'))).toBe(false);
    release();
    expect((await Promise.all(writes)).slice(0, 3)).toEqual([true, true, true]);
    await locks.settle();
    expect(JSON.parse(memStorage.getItem(mapKey)!)).toEqual({ 'pi:xd:manual': true });
    for (const prefs of [a, b]) {
      for (const agent of ['pi', 'codex'] as const) {
        expect(prefs.isModelEnabled(agent, 'xd', model(agent))).toBe(true);
        expect(prefs.isModelEnabled(agent, 'xd', model(agent, false))).toBe(false);
        expect(prefs.isModelVisibilityCustomized(agent, 'xd', agent)).toBe(false);
      }
      expect(prefs.isModelEnabled('claude-code', 'xd', model('claude-code', false))).toBe(false);
      expect(prefs.isModelEnabled('pi', 'xd', model('manual', false))).toBe(true);
    }
    expect(syncModelVisibility).toHaveBeenLastCalledWith('owner-a', 1,
      expect.objectContaining({ 'pi:xd:manual': true }),
      expect.objectContaining({ followCatalogKeys: expect.arrayContaining(['pi:xd:pi', 'codex:xd:codex']) }));
  });

  it('cancels queued writes after an owner switch without blocking the new owner', async () => {
    const { a } = await windows();
    const before = memStorage.getItem(mapKey);
    const release = locks.hold();
    const pending = a.setModelVisibility('pi', 'xd', 'old-owner', true);
    setOwnerClaim('owner-b', 2, false, false, true);
    await a.setModelVisibilityOwner('owner-b', 2, 'cloud');
    expect(await a.setModelVisibility('pi', 'xd', 'new-owner', true)).toBe(true);
    release();
    expect(await pending).toBe(false);
    expect(memStorage.getItem(mapKey)).toBe(before);
    expect(a.isModelEnabled('pi', 'xd', model('new-owner', false))).toBe(true);
    expect(a.isModelVisibilityCustomized('pi', 'xd', 'old-owner')).toBe(false);
  });

  it('does not initialize a catalog superseded while waiting for the lock', async () => {
    const { a } = await windows();
    const release = locks.hold();
    let current = true;
    const stale = a.migrateModelVisibilityDefaults('owner-a', 1, [catalog('pi')], () => current);
    current = false;
    release();
    expect(await stale).toBe(false);
    expect(JSON.parse(memStorage.getItem(initKey)!).scopes).toEqual([]);
    await a.migrateModelVisibilityDefaults('owner-a', 1, [catalog('pi', false)]);
    expect(a.isModelEnabled('pi', 'xd', model('pi'))).toBe(true);
  });

  it('returns lock failures without writing outside the lock and permits retry', async () => {
    const { a } = await windows();
    const before = memStorage.getItem(mapKey);
    const request = vi.spyOn(locks, 'request').mockRejectedValueOnce(new Error('lock unavailable'));
    expect(await a.setModelVisibility('pi', 'xd', 'pi', true)).toBe(false);
    expect(memStorage.getItem(mapKey)).toBe(before);
    request.mockRestore();
    expect(await a.setModelVisibility('pi', 'xd', 'pi', true)).toBe(true);
  });

  it('adopts another window completing deferred migration without republishing pending state', async () => {
    setOwnerClaim('owner-a', 1, true, false);
    const { a, b } = await windows();
    setOwnerClaim('owner-a', 1);
    await a.migrateModelVisibilityDefaults('owner-a', 1, [catalog('pi')]);
    await locks.settle();
    expect(b.isModelEnabled('pi', 'xd', model('pi', false))).toBe(false);
    expect(syncModelVisibility).toHaveBeenLastCalledWith('owner-a', 1, {},
      expect.not.objectContaining({ pending: true }));
  });
});

async function loadModule() {
  return await import('@/state/modelVisibilityPrefs');
}

async function loadModuleForOwner(
  ownerId: string | null = 'owner-a',
  ownerGeneration = 1,
  mode: 'signed-out' | 'local' | 'cloud' = 'cloud',
) {
  const module = await loadModule();
  await module.setModelVisibilityOwner(ownerId, ownerGeneration, mode);
  return module;
}

describe('modelVisibilityPrefs store', () => {
  it('无 override:跟随目录默认值(缺省=开 / false=关 / true=开)', async () => {
    const { isModelEnabled } = await loadModuleForOwner();
    // defaultEnabled 缺省 → 开
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(true);
    // defaultEnabled: true → 开
    expect(isModelEnabled('claude-code', 'xd', { id: 'a', defaultEnabled: true })).toBe(true);
    // defaultEnabled: false → 默认关(目录把它标成默认隐藏)
    expect(isModelEnabled('claude-code', 'xd', { id: 'b', defaultEnabled: false })).toBe(false);
  });

  it('set override 覆盖目录默认:默认开的关掉、默认关的打开', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModuleForOwner();
    // 默认开 → 用户关
    await setModelVisibility('claude-code', 'xd', 'claude-opus-4-8', false);
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(false);
    // 默认关(defaultEnabled:false)→ 用户开
    await setModelVisibility('claude-code', 'xd', 'b', true);
    expect(isModelEnabled('claude-code', 'xd', { id: 'b', defaultEnabled: false })).toBe(true);
  });

  it('set/get 往返 + 跨重启持久化', async () => {
    const m1 = await loadModuleForOwner();
    await m1.setModelVisibility('codex', 'xd', 'gpt-5.5', false);
    expect(m1.isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(false);

    vi.resetModules();
    const m2 = await loadModuleForOwner();
    expect(m2.isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(false);
  });

  it('按 (agent, providerId, modelId) 分槽:同名 gpt-5.5 在 cc / codex 互不覆盖', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModuleForOwner();
    await setModelVisibility('codex', 'xd', 'gpt-5.5', true);
    await setModelVisibility('claude-code', 'xd', 'gpt-5.5', false); // cc 下关掉
    // codex 已开启的配置不受影响
    expect(isModelEnabled('claude-code', 'xd', { id: 'gpt-5.5' })).toBe(false);
    expect(isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(true);
  });

  it('同一来源不同 provider 互不影响(xd vs openai)', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModuleForOwner();
    await setModelVisibility('codex', 'openai', 'gpt-5.5', true);
    await setModelVisibility('codex', 'xd', 'gpt-5.5', false);
    expect(isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(false);
    expect(isModelEnabled('codex', 'openai', { id: 'gpt-5.5' })).toBe(true);
  });

  it('setManyVisibility:全部关 → 全部开,写显式 override(含目录默认关的也被打开)', async () => {
    const { isModelEnabled, setManyVisibility } = await loadModuleForOwner();
    const ids = ['claude-opus-4-8', 'claude-sonnet-4-6', 'b'];
    await setManyVisibility('claude-code', 'xd', ids, false);
    for (const id of ids) {
      expect(isModelEnabled('claude-code', 'xd', { id })).toBe(false);
    }
    await setManyVisibility('claude-code', 'xd', ids, true);
    // 即便 'b' 目录默认是关,「全部开启」也把它显式打开
    expect(isModelEnabled('claude-code', 'xd', { id: 'b', defaultEnabled: false })).toBe(true);
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(true);
  });

  it('setModelVisibilities:跨 agent 一次落盘并同时更新全部目标', async () => {
    const module = await loadModuleForOwner();
    const setItem = vi.spyOn(memStorage, 'setItem');

    expect(
      await module.setModelVisibilities(
        'xd',
        [
          { agent: 'claude-code', modelId: 'claude-sonnet-4-6' },
          { agent: 'codex', modelId: 'gpt-5.6' },
        ],
        false,
      ),
    ).toBe(true);

    expect(
      setItem.mock.calls.filter(([key]) => key === 'xdt:modelVisibilityPrefs:v1.owner.owner-a'),
    ).toHaveLength(1);
    expect(module.isModelEnabled('claude-code', 'xd', { id: 'claude-sonnet-4-6' })).toBe(false);
    expect(module.isModelEnabled('codex', 'xd', { id: 'gpt-5.6' })).toBe(false);
    setItem.mockRestore();
  });

  it('setModelVisibilities:落盘失败不部分提交，按同一方向重试可整体成功', async () => {
    const module = await loadModuleForOwner();
    const storageKey = 'xdt:modelVisibilityPrefs:v1.owner.owner-a';
    const rawBeforeFailure = memStorage.getItem(storageKey);
    const mirrorCallsBeforeFailure = syncModelVisibility.mock.calls.length;
    const setItem = vi.spyOn(memStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('injected storage failure');
    });
    const targets = [
      { agent: 'claude-code' as const, modelId: 'claude-sonnet-4-6' },
      { agent: 'codex' as const, modelId: 'gpt-5.6' },
    ];

    expect(await module.setModelVisibilities('xd', targets, false)).toBe(false);
    expect(memStorage.getItem(storageKey)).toBe(rawBeforeFailure);
    expect(module.isModelEnabled('claude-code', 'xd', { id: 'claude-sonnet-4-6' })).toBe(true);
    expect(module.isModelEnabled('codex', 'xd', { id: 'gpt-5.6' })).toBe(true);
    expect(syncModelVisibility).toHaveBeenCalledTimes(mirrorCallsBeforeFailure);

    expect(await module.setModelVisibilities('xd', targets, false)).toBe(true);
    expect(module.isModelEnabled('claude-code', 'xd', { id: 'claude-sonnet-4-6' })).toBe(false);
    expect(module.isModelEnabled('codex', 'xd', { id: 'gpt-5.6' })).toBe(false);
    setItem.mockRestore();
  });

  it('同值写入短路:不抛,值保持', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModuleForOwner();
    expect(await setModelVisibility('codex', 'openai', 'gpt-5.4', false)).toBe(true);
    expect(await setModelVisibility('codex', 'openai', 'gpt-5.4', false)).toBe(true);
    expect(isModelEnabled('codex', 'openai', { id: 'gpt-5.4' })).toBe(false);
  });

  it('空 providerId / modelId 入参被忽略', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModuleForOwner();
    await setModelVisibility('claude-code', '', 'x', false);
    await setModelVisibility('claude-code', 'xd', '', false);
    // 都没写进去 → 仍跟随默认(开)
    expect(isModelEnabled('claude-code', 'xd', { id: 'x' })).toBe(true);
  });

  it('首个已认领 owner 导入旧全局 override，切换到新账号后默认隔离', async () => {
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1',
      JSON.stringify({ 'codex:openai:gpt-5.6': false }),
    );
    const module = await loadModuleForOwner('owner-a', 1);

    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.owner.owner-a')).toBe(
      JSON.stringify({ 'codex:openai:gpt-5.6': false }),
    );

    setOwnerClaim('owner-b', 2, false, false, true);
    await module.setModelVisibilityOwner('owner-b', 2, 'cloud');

    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(true);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.owner.owner-b')).toBeNull();
    expect(syncModelVisibility).toHaveBeenLastCalledWith('owner-b', 2, {}, expect.objectContaining({ followCatalogKeys: [] }));

    setOwnerClaim('owner-a', 3, true, true);
    await module.setModelVisibilityOwner('owner-a', 3, 'cloud');
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(false);
  });

  it('非独占推迟导入时不把尚未迁入的关闭开关当成目录默认开', async () => {
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1',
      JSON.stringify({ 'codex:openai:gpt-5.6': false }),
    );
    setOwnerClaim('owner-a', 1, true, false);
    ownerClaim.profileOrigin = 'existing';
    const module = await loadModuleForOwner();
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6', defaultEnabled: true })).toBe(false);
  });

  it('已归属但非独占时保存新 override，恢复独占后合并旧值且新值优先', async () => {
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1',
      JSON.stringify({
        'codex:openai:gpt-5.6': false,
        'codex:openai:gpt-5.5': true,
      }),
    );
    setOwnerClaim('owner-a', 1, true, false);
    const module = await loadModuleForOwner();

    await module.setModelVisibility('codex', 'openai', 'gpt-5.5', false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.owner.owner-a')).toBe(
      JSON.stringify({ 'codex:openai:gpt-5.5': false }),
    );

    setOwnerClaim('owner-a', 1, true, true);
    await module.setModelVisibility('codex', 'openai', 'gpt-5.5', false);

    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(false);
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.5' })).toBe(false);
    expect(memStorage.getItem(
      'xdt:modelVisibilityPrefs:v1.migration-complete.owner.owner-a',
    )).toBe('1');
  });

  it('旧 key 尚未认领时仍允许稳定 owner 写自己的隔离 key', async () => {
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1',
      JSON.stringify({ 'codex:openai:gpt-5.6': false }),
    );
    setOwnerClaim('owner-a', 1, false, false);
    const module = await loadModuleForOwner();

    expect(await module.setModelVisibility('codex', 'openai', 'gpt-5.5', false)).toBe(true);

    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.owner.owner-a')).toBe(
      JSON.stringify({ 'codex:openai:gpt-5.5': false }),
    );
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1')).toBe(
      JSON.stringify({ 'codex:openai:gpt-5.6': false }),
    );
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.5' })).toBe(false);

    setOwnerClaim('owner-a', 1, true, true);
    expect(await module.setModelVisibility('codex', 'openai', 'gpt-5.5', false)).toBe(true);
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(false);
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.5' })).toBe(false);
  });

  it('当前 owner 会话尚未稳定时继续阻止写入', async () => {
    setOwnerClaim('owner-a', 1, false, false, false, false);
    const module = await loadModuleForOwner();

    expect(await module.setModelVisibility('codex', 'openai', 'gpt-5.5', false)).toBe(false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.owner.owner-a')).toBeNull();
    expect(logToMain).toHaveBeenCalledWith(
      'warn',
      'ModelVisibilityPrefs',
      expect.stringContaining('owner-write-not-ready'),
    );
  });

  it('owner-scoped 存储失败时返回失败并保持旧状态', async () => {
    const module = await loadModuleForOwner();
    const mirrorCallsBeforeFailure = syncModelVisibility.mock.calls.length;
    const setItem = vi.spyOn(memStorage, 'setItem').mockImplementation(() => {
      throw new Error('injected storage failure');
    });

    expect(await module.setModelVisibility('codex', 'openai', 'gpt-5.5', false)).toBe(false);
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.5' })).toBe(true);
    expect(syncModelVisibility).toHaveBeenCalledTimes(mirrorCallsBeforeFailure);
    expect(logToMain).toHaveBeenCalledWith(
      'warn',
      'ModelVisibilityPrefs',
      expect.stringContaining('storage-write-failed'),
    );
    setItem.mockRestore();
  });

  it('已有 owner-scoped override 优先，迁移不会覆盖', async () => {
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1',
      JSON.stringify({ 'codex:openai:gpt-5.6': false }),
    );
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1.owner.owner-a',
      JSON.stringify({ 'codex:openai:gpt-5.6': true }),
    );

    const module = await loadModuleForOwner();

    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(true);
  });

  it('未登录时不写 override，并将空镜像推给 Main 清除前账号状态', async () => {
    const module = await loadModuleForOwner();
    await module.setModelVisibility('codex', 'openai', 'gpt-5.6', false);

    await module.setModelVisibilityOwner(null, 2, 'signed-out');
    await module.setModelVisibility('codex', 'openai', 'gpt-5.6', false);

    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(true);
    expect(syncModelVisibility).toHaveBeenLastCalledWith(null, 2, {});
  });

  it('retries a failed mirror sync and cancels old snapshots after a newer switch', async () => {
    vi.useFakeTimers();
    try {
      syncModelVisibility.mockRejectedValueOnce(new Error('handler not registered'));
      const prefs = await loadModuleForOwner();
      await vi.advanceTimersByTimeAsync(250);
      expect(syncModelVisibility).toHaveBeenCalledTimes(2);
      syncModelVisibility.mockRejectedValueOnce(new Error('temporary failure'));
      await prefs.setModelVisibility('pi', 'xd', 'a', true);
      await Promise.resolve();
      await prefs.setModelVisibility('pi', 'xd', 'a', false);
      const count = syncModelVisibility.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(syncModelVisibility).toHaveBeenCalledTimes(count);
      expect(syncModelVisibility).toHaveBeenLastCalledWith('owner-a', 1,
        { 'pi:xd:a': false }, expect.anything());
    } finally { vi.useRealTimers(); }
  });

  it('本地 profile 认领历史全局 key 并迁移到自己的 namespace', async () => {
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1',
      JSON.stringify({ 'codex:openai:gpt-5.6': false }),
    );
    setOwnerClaim('local-v1', 1);
    const module = await loadModuleForOwner('local-v1', 1, 'local');

    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(false);
    await module.setModelVisibility('codex', 'openai', 'gpt-5.5', false);
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.5' })).toBe(false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1')).not.toBeNull();
  });

  it('旧配置损坏时不把未知模型自动开启', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1', '{ not valid json');
    const { isModelEnabled } = await loadModuleForOwner();
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(false);
  });

  it('旧配置损坏时不因 scoped 增量而提交迁移完成', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1', '{ not valid json');
    setOwnerClaim('owner-a', 1, true, false);
    ownerClaim.profileOrigin = 'existing';
    const module = await loadModuleForOwner();
    expect(await module.setModelVisibility('codex', 'openai', 'gpt-5.5', false)).toBe(true);
    setOwnerClaim('owner-a', 1, true, true);
    ownerClaim.profileOrigin = 'existing';
    expect(await module.setModelVisibility('codex', 'openai', 'gpt-5.5', false)).toBe(true);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.migration-complete.owner.owner-a')).toBeNull();
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6', defaultEnabled: true })).toBe(false);
    memStorage.setItem('xdt:modelVisibilityPrefs:v1', JSON.stringify({ 'codex:openai:gpt-5.6': false }));
    expect(await module.setModelVisibility('codex', 'openai', 'gpt-5.5', false)).toBe(true);
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6', defaultEnabled: true })).toBe(false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.migration-complete.owner.owner-a')).toBe('1');
  });

  it('配置损坏时仍尊重 Restore defaults 的跟随目录路线', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.owner.owner-a', '{ not valid json');
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.migration-complete.owner.owner-a', '1');
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.initialization.owner.owner-a', JSON.stringify({
      eligibleForDefaults: false,
      defaults: {},
      scopes: [JSON.stringify(['xd', 'claude-code'])],
      followCatalogKeys: ['claude-code:xd:claude-opus-4-8'],
    }));
    const { isModelEnabled } = await loadModuleForOwner();
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8', defaultEnabled: true })).toBe(true);
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-sonnet-4-6', defaultEnabled: true })).toBe(false);
  });

  it('写入显式开关时清除对应的 Restore defaults 标记', async () => {
    const module = await loadModuleForOwner();
    expect(await module.resetModelVisibilities('xd', [{ agent: 'claude-code', modelId: 'claude-opus-4-8' }])).toBe(true);
    expect(await module.setModelVisibility('claude-code', 'xd', 'claude-opus-4-8', false)).toBe(true);
    const init = JSON.parse(memStorage.getItem('xdt:modelVisibilityPrefs:v1.initialization.owner.owner-a')!);
    expect(init.followCatalogKeys).not.toContain('claude-code:xd:claude-opus-4-8');
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.owner.owner-a', '{ not valid json');
    vi.resetModules();
    const restarted = await loadModuleForOwner();
    expect(restarted.isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8', defaultEnabled: true })).toBe(false);
  });

  it('override 写入失败时保留 Restore defaults 标记', async () => {
    const module = await loadModuleForOwner();
    expect(await module.resetModelVisibilities('xd', [{ agent: 'claude-code', modelId: 'claude-opus-4-8' }])).toBe(true);
    const write = memStorage.setItem.bind(memStorage);
    vi.spyOn(memStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'xdt:modelVisibilityPrefs:v1.owner.owner-a') throw new Error('disk full');
      write(key, value);
    });
    expect(await module.setModelVisibility('claude-code', 'xd', 'claude-opus-4-8', false)).toBe(false);
    const init = JSON.parse(memStorage.getItem('xdt:modelVisibilityPrefs:v1.initialization.owner.owner-a')!);
    expect(init.followCatalogKeys).toContain('claude-code:xd:claude-opus-4-8');
  });

  it('owner-scoped 配置损坏时不把目录默认当成开启', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.owner.owner-a', '{ not valid json');
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.migration-complete.owner.owner-a', '1');
    const { isModelEnabled } = await loadModuleForOwner();
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8', defaultEnabled: true })).toBe(false);
  });

  it('写入修好损坏配置后恢复跟随目录默认', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.owner.owner-a', '{ not valid json');
    memStorage.setItem('xdt:modelVisibilityPrefs:v1.migration-complete.owner.owner-a', '1');
    const module = await loadModuleForOwner();
    expect(module.isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8', defaultEnabled: true })).toBe(false);
    expect(await module.setModelVisibility('codex', 'openai', 'gpt-5.5', false)).toBe(true);
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.5' })).toBe(false);
    expect(module.isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8', defaultEnabled: true })).toBe(true);
  });

  it('脏数据条目(value 非 boolean)被过滤', async () => {
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1',
      JSON.stringify({
        'claude-code:xd:claude-opus-4-8': false, // 合法
        'claude-code:xd:claude-sonnet-4-6': 'nope', // 非 boolean → 丢弃
        'codex:xd:gpt-5.5': 1, // 非 boolean → 丢弃
      }),
    );
    const { isModelEnabled } = await loadModuleForOwner();
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(false); // 合法 override 生效
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-sonnet-4-6' })).toBe(true);
    expect(isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(true);
  });
});


it('restoring model visibility deletes overrides and follows future online defaults', async () => {
  const prefs = await loadModuleForOwner();
  const target = { agent: 'claude-code' as const, modelId: 'chatgpt/gpt-6' };
  await prefs.setModelVisibility(target.agent, 'openai', target.modelId, true);
  expect(prefs.isModelVisibilityCustomized(target.agent, 'openai', target.modelId)).toBe(true);
  expect(await prefs.resetModelVisibilities('openai', [target])).toBe(true);
  expect(prefs.isModelVisibilityCustomized(target.agent, 'openai', target.modelId)).toBe(false);
  expect(prefs.isModelEnabled(target.agent, 'openai', { id: target.modelId, defaultEnabled: false })).toBe(false);
  expect(prefs.isModelEnabled(target.agent, 'openai', { id: target.modelId, defaultEnabled: true })).toBe(true);
});


describe('compact model defaults upgrade', () => {
  const scopedKey = 'xdt:modelVisibilityPrefs:v1.owner.owner-a';
  const markerKey = 'xdt:modelVisibilityPrefs:v1.initialization.owner.owner-a';
  const provider = {
    id: 'xd', name: 'Cindy AI', connected: true, source: 'builtin',
    agents: ['claude-code', 'codex', 'pi'], auth: { method: 'token' },
    routing: {
      'claude-code': { modelPrefixes: ['chatgpt/'], wireProtocol: 'anthropic-messages' },
      codex: { wireProtocol: 'openai-responses' },
      pi: { wireProtocol: 'openai-responses' },
    },
    models: Object.fromEntries(['claude-code', 'codex', 'pi'].map((agent) => [agent,
      ['fable-5', 'fable-5-1', 'gemini'].map((id) => ({
        id: agent === 'claude-code' ? `chatgpt/${id}` : id,
        name: id, contextWindow: 200000, efforts: [], defaultEffort: null,
        defaultEnabled: agent === 'pi' && id !== 'fable-5',
        nativeApi: 'google-generative-ai',
      })),
    ])),
  } as unknown as ProviderView;

  async function upgrade(ownerId = 'owner-a', generation = 1, snapshot = provider) {
    const memory = await import('@/state/providerModelMemory');
    const engines = await import('@/state/modelEnginePrefs');
    const favorites = await import('@/state/modelFavorites');
    memory.setProviderModelMemoryOwner(ownerId);
    engines.setModelEnginePrefsOwner(ownerId);
    favorites.setModelFavoritesOwner(ownerId);
    const prefs = await loadModuleForOwner(ownerId, generation);
    await prefs.migrateModelVisibilityDefaults(ownerId, generation, [snapshot]);
    return prefs;
  }

  it('keeps new-user defaults and does not manufacture compatibility selections', async () => {
    const prefs = await upgrade();
    expect(prefs.isModelEnabled('claude-code', 'xd', provider.models['claude-code']![2]!)).toBe(false);
    expect(prefs.isModelEnabled('pi', 'xd', provider.models.pi![2]!)).toBe(true);
    expect(JSON.parse(memStorage.getItem(scopedKey)!)).toEqual({});
  });

  it('follows catalog defaults for image and video display switches', async () => {
    ownerClaim.profileOrigin = 'existing';
    const snapshot = {
      ...provider,
      imageModels: [
        { id: 'openai/gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst' },
        { id: 'openai/gpt-image-2', name: 'GPT Image 2' },
        { id: 'openai/old-image', name: 'Old Image', defaultEnabled: false },
      ],
      videoModels: [{ id: 'xai/grok-imagine-video', name: 'Grok Imagine Video' }],
    } as unknown as ProviderView;
    const prefs = await upgrade('owner-a', 1, snapshot);
    expect(prefs.isModelEnabled('claude-code', 'xd', { id: 'openai/gpt-image-2.5-sunburst' })).toBe(true);
    expect(prefs.isModelEnabled('claude-code', 'xd', { id: 'openai/gpt-image-2' })).toBe(true);
    expect(prefs.isModelEnabled('claude-code', 'xd', { id: 'openai/old-image', defaultEnabled: false })).toBe(false);
    expect(prefs.isModelEnabled('claude-code', 'xd', { id: 'xai/grok-imagine-video' })).toBe(true);

    vi.resetModules();
    const later = {
      ...snapshot,
      imageModels: [
        ...(snapshot.imageModels ?? []),
        { id: 'openai/gpt-image-3', name: 'Image 3' },
      ],
    } as unknown as ProviderView;
    const next = await upgrade('owner-a', 1, later);
    expect(next.isModelEnabled('claude-code', 'xd', { id: 'openai/gpt-image-2' })).toBe(true);
    expect(next.isModelEnabled('claude-code', 'xd', { id: 'openai/gpt-image-3' })).toBe(true);
  });

  it('preserves old on/off switches without treating history or favorites as switches', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1', JSON.stringify({
      'claude-code:xd:chatgpt/fable-5': true,
      'claude-code:xd:chatgpt/fable-5-1': false,
    }));
    memStorage.setItem('xdt:providerModelMemory:v2:owner-a', JSON.stringify({
      'codex:xd': { lastModel: 'fable-5', effortByModel: {} },
    }));
    memStorage.setItem('xdt:modelEnginePrefs:v1:owner-a', JSON.stringify({ 'xd:gemini': { agent: 'cc' } }));
    const favorites = await import('@/state/modelFavorites');
    favorites.setModelFavoritesOwner('owner-a');
    favorites.addModelFavorite({ providerId: 'xd', modelId: 'fable-5', agent: 'pi' });
    const prefs = await upgrade();
    expect(prefs.isModelEnabled('claude-code', 'xd', { id: 'chatgpt/fable-5', defaultEnabled: false })).toBe(true);
    expect(prefs.isModelEnabled('claude-code', 'xd', { id: 'chatgpt/fable-5-1', defaultEnabled: true })).toBe(false);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(true);
  });

  // 上游本轮把本条从「无清单 ⇒ 一律关闭」改写成「无开关 ⇒ 跟随目录 defaultEnabled」,
  // 断言随之翻转(gemini 由 false 改 true)。Meka 侧原用例名 `does not initialize an existing
  // owner even when its override map is empty` 保留其事实:harness 默认 profileOrigin 'new'
  // 且 override 表非 null(不是补种命中面),所以既不补种也不写初始化清单 —— 与上游口径一致。
  it('follows catalog defaults when an existing owner has no switches', async () => {
    // Main 还没把这份配置定性(harness 默认 profileOrigin 'new' 且 override 表非 null):
    // 不补种、不初始化,与上游口径一致。
    memStorage.setItem(scopedKey, '{}');
    const prefs = await upgrade();
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'fable-5', defaultEnabled: false })).toBe(false);
  });

  it('seeds an upgrade baseline snapshot for a pre-merge Meka profile without freezing visibility', async () => {
    // `existing` = Main 定性「数据库早于可见性初始化机制就存在」= Meka 老配置。
    // 用户裁决 A(接纳上游语义)后补种的定位是**基线留痕**,不是可见性冻结:标记与
    // `initialization.defaults` 落盘记录「升级那一刻看到的目录基线」,可见性本身恒为
    // 「显式 override ?? 当前目录 defaultEnabled」。依据 WL-10 + 配置文档 §2「Meka 谱系条款」。
    ownerClaim.profileOrigin = 'existing';
    const prefs = await upgrade();
    // 补种副作用 1:P0 修复的实质 —— 一次性标记落盘。
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.meka-upgrade-seed.v1.owner.owner-a')).toBe('1');
    // 补种副作用 2:基线快照逐条写进 initialization.defaults,值 = 升级那一刻的目录默认值
    // (即合并前的实际可见集合)。
    const baseline = Object.fromEntries(provider.agents.flatMap((agent) =>
      provider.models[agent]!.map((model) => [
        `${agent}:${provider.id}:${model.id}`, model.defaultEnabled !== false,
      ])));
    const seeded = JSON.parse(memStorage.getItem(markerKey)!);
    expect(seeded).toMatchObject({ eligibleForDefaults: true });
    expect(seeded.scopes).toEqual(provider.agents.map((agent) => JSON.stringify([provider.id, agent])));
    expect(seeded.defaults).toEqual(baseline);
    // 补种副作用 3:整表重新镜像给 main(不是只落盘)。
    expect(syncModelVisibility).toHaveBeenCalledWith('owner-a', 1, expect.anything(), expect.anything());
    // 可见性:与目录逐条一致(存量 Meka 用户因此仍看得到合并前的集合)。
    for (const agent of provider.agents) {
      for (const model of provider.models[agent]!) {
        expect(prefs.isModelEnabled(agent, 'xd', model)).toBe(model.defaultEnabled !== false);
      }
    }
    // 目录后来新增的模型跟随目录 defaultEnabled ⇒ 可见(不再被补种冻结;接纳上游的确定性后果)。
    await prefs.migrateModelVisibilityDefaults('owner-a', 1, [{
      ...provider,
      models: { ...provider.models, pi: [...provider.models.pi!, {
        ...provider.models.pi![0]!, id: 'brand-new', defaultEnabled: true,
      }] },
    }]);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'brand-new', defaultEnabled: true })).toBe(true);
    // 而冻结快照本身不再变化:brand-new 不写进 defaults(补种只记录升级那一刻的基线)。
    expect(JSON.parse(memStorage.getItem(markerKey)!).defaults).toEqual(baseline);
    // 显式开关照旧最高优先并跨重启保留。
    await prefs.setModelVisibility('pi', 'xd', 'gemini', true);
    vi.resetModules();
    const restarted = await upgrade();
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'gemini' })).toBe(true);
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'fable-5', defaultEnabled: false })).toBe(false);
    // 目录默认关的路线在补种后仍关闭:补种没有把目录默认关的模型打开。
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'fable-5-1', defaultEnabled: false })).toBe(false);
  });

  it('resends the effective enabled table on a no-op catalog refresh after Main loses its mirror', async () => {
    ownerClaim.profileOrigin = 'existing';
    const prefs = await upgrade();
    await prefs.setModelVisibility('pi', 'xd', 'gemini', true);
    await prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider]);
    const before = memStorage.getItem(scopedKey);
    syncModelVisibility.mockClear();
    await prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider]);
    expect(memStorage.getItem(scopedKey)).toBe(before);
    expect(syncModelVisibility).toHaveBeenCalledWith('owner-a', 1,
      expect.objectContaining({ 'pi:xd:gemini': true }),
      expect.not.objectContaining({ pending: true }));
  });

  it('mirrors the seeded owner snapshot to main so IM /model is not left empty', async () => {
    // 本轮同步用户裁决 A(接纳上游语义)后,IM `/model` 不为空**不再靠把补种出的 defaults
    // 塞进镜像载荷**:`effectiveMap(map) => ({ ...map })` 只推 override 表,main 侧对未知
    // 路线返回 `undefined` 从而跟随目录,靠的是 renderer 不请求 `fallback: false`。所以本条
    // 既断言「补种确实重新镜像了」,也把 renderer 真正推出去的 (snapshot, policy) 喂进
    // **真实 main 侧镜像模块**,端到端证明 IM 侧判定与应用内 `isModelEnabled` 逐条一致。
    ownerClaim.profileOrigin = 'existing';
    const prefs = await upgrade();
    expect(syncModelVisibility).toHaveBeenCalled();
    const [, , snapshot, policy] = syncModelVisibility.mock.calls[
      syncModelVisibility.mock.calls.length - 1]!;
    // 镜像载荷是 override 表(补种不写 override),冻结的 defaults 不注入。
    expect(snapshot).toEqual({});
    expect(policy).toMatchObject({ followCatalogKeys: [] });
    // 关键:不请求 fallback:false —— 请求了就会让 main 把未知路线判成关闭 ⇒ 选择器/`/model`
    // 整张清空(上一轮 P0 的形态)。
    expect(policy).not.toHaveProperty('fallback');
    __resetModelVisibilityMirrorForTest();
    setModelVisibilityMirror(snapshot, policy);
    // 目录默认开的路线在 main 侧拿到 `undefined` ⇒ 由共享 `isModelVisible` 回落目录。
    expect(getModelVisibilityOverride('pi', 'xd', 'gemini')).toBeUndefined();
    for (const agent of provider.agents) {
      for (const model of provider.models[agent]!) {
        expect(isModelVisible(getModelVisibilityOverride(agent, 'xd', model.id), model.defaultEnabled))
          .toBe(prefs.isModelEnabled(agent, 'xd', model));
      }
    }
    // 目录后来新增的默认开模型同样不为空。
    expect(isModelVisible(getModelVisibilityOverride('pi', 'xd', 'brand-new'), true)).toBe(true);
    __resetModelVisibilityMirrorForTest();
  });

  it('keeps unknown profile provenance fail-closed (no seed, no fabricated eligibility)', async () => {
    // profileOrigin 缺失 = 旧 Main / preload 不提供定性。失败关闭的实质是:不写补种标记、
    // 不伪造资格位、不伪造基线快照 —— 本仓 Main 与 renderer 同版本发布,该分支实际不可达,
    // 但仍必须与上游同口径(用户在裁决 A 中要求的正是这一点)。
    ownerClaim = { ...ownerClaim, profileOrigin: undefined };
    const prefs = await upgrade();
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.meka-upgrade-seed.v1.owner.owner-a')).toBeNull();
    expect(JSON.parse(memStorage.getItem(markerKey)!)).toMatchObject({
      eligibleForDefaults: false, defaults: {},
    });
    // 可见性本身仍按上游语义跟随目录(defaultEnabled 缺省=开 / false=关),不是本仓新开的门。
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'fable-5', defaultEnabled: false })).toBe(false);
  });

  it('repairs a profile the merged build already recorded with an empty initialization', async () => {
    // 合并后的版本已经跑过一遍时写下的空清单(eligibleForDefaults:false + 空 defaults +
    // 已记录 scopes)。空清单与「没有清单」在读取侧等价,都会被解析成关闭,必须一起补种。
    ownerClaim.profileOrigin = 'existing';
    memStorage.setItem(markerKey, JSON.stringify({
      eligibleForDefaults: false,
      defaults: {},
      scopes: [JSON.stringify(['xd', 'pi'])],
      followCatalogKeys: [],
    }));
    memStorage.setItem(scopedKey, JSON.stringify({ 'pi:xd:fable-5': true }));
    const prefs = await upgrade();
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(true);
    // 显式 override 仍然最高优先:用户自己打开的冷门版本不会被补种覆盖掉。
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'fable-5', defaultEnabled: false })).toBe(true);
  });

  it('keeps restore-default routes following the catalog while seeding the rest', async () => {
    ownerClaim.profileOrigin = 'existing';
    memStorage.setItem(markerKey, JSON.stringify({
      eligibleForDefaults: false,
      defaults: {},
      scopes: [JSON.stringify(['xd', 'pi'])],
      followCatalogKeys: ['pi:xd:gemini'],
    }));
    const prefs = await upgrade();
    // 具名「恢复推荐」路线继续动态跟随目录默认值(补种不参与判定)。
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: false })).toBe(false);
    // 其余路线按补种快照:目录默认开的可见,目录默认关的仍关。
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'fable-5-1', defaultEnabled: true })).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'fable-5', defaultEnabled: false })).toBe(false);
  });

  it('waits for Main profile creation before writing migration artifacts or consuming defaults', async () => {
    ownerClaim.profileOrigin = 'pending';
    const prefs = await upgrade();
    expect(memStorage.getItem(scopedKey)).toBeNull();
    expect(memStorage.getItem(markerKey)).toBeNull();
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini' })).toBe(false);
    expect(syncModelVisibility).toHaveBeenLastCalledWith('owner-a', 1, {}, expect.objectContaining({ pending: true }));
    ownerClaim.profileOrigin = 'new';
    await prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider]);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini' })).toBe(true);
    expect(JSON.parse(memStorage.getItem(markerKey)!)).toMatchObject({ eligibleForDefaults: true });
  });

  it.each([false, true])('retains first-run eligibility across a restart before any nonempty catalog (empty snapshot: %s)', async (emptySnapshot) => {
    const prefs = await loadModuleForOwner();
    if (emptySnapshot) await prefs.migrateModelVisibilityDefaults('owner-a', 1, []);
    expect(syncModelVisibility).toHaveBeenLastCalledWith('owner-a', 1, {},
      expect.objectContaining({ followCatalogKeys: [] }));

    vi.resetModules();
    const restarted = await upgrade();
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(true);
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'fable-5', defaultEnabled: false })).toBe(false);
    expect(syncModelVisibility).toHaveBeenLastCalledWith('owner-a', 1, expect.anything(),
      expect.not.objectContaining({ pending: true }));
  });

  it.each(['pending', 'catalog'] as const)('recovers a failed %s initialization write after restart', async (stage) => {
    const prefs = stage === 'catalog' ? await loadModuleForOwner() : null;
    const original = memStorage.setItem.bind(memStorage);
    const spy = vi.spyOn(memStorage, 'setItem').mockImplementation((key, value) => {
      if (key === markerKey) throw new Error('storage full');
      original(key, value);
    });
    try {
      if (prefs) {
        await prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider]);
        // A user action during the failed baseline write still wins on recovery.
        expect(await prefs.setModelVisibility('pi', 'xd', 'gemini', false)).toBe(true);
      } else {
        await upgrade();
        expect(memStorage.getItem(scopedKey)).toBeNull();
        expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.migration-complete.owner.owner-a')).toBeNull();
      }
    } finally { spy.mockRestore(); }

    vi.resetModules();
    const restarted = await upgrade();
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'fable-5-1', defaultEnabled: true })).toBe(true);
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(stage === 'pending');
  });

  it.each([false, true])('keeps delayed provider/agent initialization independent of manual switches (restart: %s)', async (restart) => {
    const partial = { ...provider, models: { pi: provider.models.pi, 'claude-code': [], codex: [] } };
    let prefs = await upgrade('owner-a', 1, partial);
    await prefs.setModelVisibility('pi', 'xd', 'gemini', false);
    await prefs.setModelVisibility('codex', 'xd', 'late-off', false);
    if (restart) {
      vi.resetModules();
      prefs = await upgrade('owner-a', 1, partial);
    }
    const lateModels = ['late-on', 'late-off', 'late-default-off'].map((id) => ({
      ...provider.models.pi![0]!, id, defaultEnabled: id !== 'late-default-off',
    }));
    const catalogs = ['xd', 'other-provider'].map((id) => ({
      ...provider, id,
      models: { pi: [...provider.models.pi!, { ...lateModels[0]!, id: 'pi-added' }],
        'claude-code': lateModels, codex: lateModels },
    }));
    await prefs.migrateModelVisibilityDefaults('owner-a', 1, catalogs);
    for (const providerId of ['xd', 'other-provider']) {
      for (const agent of ['claude-code', 'codex'] as const) {
        expect(prefs.isModelEnabled(agent, providerId, lateModels[0]!)).toBe(true);
        expect(prefs.isModelEnabled(agent, providerId, lateModels[1]!)).toBe(providerId !== 'xd' || agent !== 'codex');
        expect(prefs.isModelEnabled(agent, providerId, lateModels[2]!)).toBe(false);
      }
    }
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(false);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'pi-added', defaultEnabled: true })).toBe(true);
    expect(prefs.isModelEnabled('pi', 'other-provider', { id: 'pi-added', defaultEnabled: true })).toBe(true);
  });

  it('does not grant fresh defaults to old initialization records without eligibility', async () => {
    memStorage.setItem(markerKey, JSON.stringify({
      defaults: { 'pi:xd:gemini': true }, scopes: [JSON.stringify(['xd', 'pi'])], followCatalogKeys: [],
    }));
    const prefs = await upgrade();
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: false })).toBe(false);
    expect(prefs.isModelEnabled('codex', 'xd', { id: 'fable-5', defaultEnabled: true })).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'brand-new', defaultEnabled: true })).toBe(true);
  });

  it('revokes pending eligibility when deferred ownership reveals a legacy profile after restart', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1', JSON.stringify({ 'pi:xd:gemini': false }));
    setOwnerClaim('owner-a', 1, false, false);
    const prefs = await upgrade();
    await prefs.setModelVisibility('pi', 'xd', 'fable-5', true);
    vi.resetModules();
    setOwnerClaim('owner-a', 1);
    const restarted = await upgrade();
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(false);
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'fable-5', defaultEnabled: false })).toBe(true);
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'fable-5-1', defaultEnabled: true })).toBe(true);
  });

  it('freezes a new profile initial defaults and keeps later additions off across restart', async () => {
    const prefs = await upgrade();
    const changed = {
      ...provider,
      models: { ...provider.models, pi: [
        ...provider.models.pi!.map((model) => ({ ...model, defaultEnabled: !model.defaultEnabled })),
        { ...provider.models.pi![0]!, id: 'brand-new', defaultEnabled: true },
      ] },
    };
    await prefs.migrateModelVisibilityDefaults('owner-a', 1, [changed]);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: false })).toBe(false);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'fable-5', defaultEnabled: true })).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'brand-new', defaultEnabled: true })).toBe(true);
    expect(prefs.isModelVisibilityCustomized('pi', 'xd', 'gemini')).toBe(false);
    vi.resetModules();
    const restarted = await upgrade('owner-a', 1, changed);
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'brand-new', defaultEnabled: true })).toBe(true);
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: false })).toBe(false);
  });

  it('preserves manually disabled defaults and allows manually enabling a new model', async () => {
    const prefs = await upgrade();
    await prefs.setModelVisibility('pi', 'xd', 'gemini', false);
    await prefs.setModelVisibility('codex', 'xd', 'brand-new', true);
    await prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider]);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(false);
    expect(prefs.isModelEnabled('codex', 'xd', { id: 'brand-new', defaultEnabled: false })).toBe(true);
  });

  it('Restore defaults applies only to explicitly named routes, including future online defaults', async () => {
    const prefs = await upgrade();
    await prefs.setModelVisibility('pi', 'xd', 'gemini', false);
    expect(await prefs.resetModelVisibilities('xd', [{ agent: 'pi', modelId: 'gemini' }])).toBe(true);
    vi.resetModules();
    const restarted = await upgrade();
    expect(restarted.isModelVisibilityCustomized('pi', 'xd', 'gemini')).toBe(false);
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(true);
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: false })).toBe(false);
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'brand-new', defaultEnabled: true })).toBe(true);
  });

  it.each(['claude-code', 'codex'] as const)('late %s routes preserve explicit switches but never auto-enable missing switches', async (agent) => {
    const wireId = agent === 'claude-code' ? 'chatgpt/fable-5' : 'fable-5';
    memStorage.setItem(scopedKey, JSON.stringify({ [`${agent}:xd:${wireId}`]: true }));
    const partial = { ...provider, models: { pi: provider.models.pi, 'claude-code': [], codex: [] } };
    await upgrade('owner-a', 1, partial);
    vi.resetModules();
    const prefs = await upgrade();
    expect(prefs.isModelEnabled(agent, 'xd', { id: wireId, defaultEnabled: false })).toBe(true);
    expect(prefs.isModelEnabled(agent, 'xd', { id: 'new-late-model', defaultEnabled: true })).toBe(true);
  });

  it('maps only declared same-engine switches without replacing versions or restoring a reset alias', async () => {
    memStorage.setItem(scopedKey, JSON.stringify({ 'claude-code:xd:fable-5': true }));
    const prefs = await upgrade();
    expect(prefs.isModelEnabled('claude-code', 'xd', { id: 'chatgpt/fable-5', defaultEnabled: false })).toBe(true);
    expect(prefs.isModelEnabled('claude-code', 'xd', { id: 'chatgpt/fable-5-1', defaultEnabled: true })).toBe(true);
    expect(await prefs.resetModelVisibilities('xd', [{ agent: 'claude-code', modelId: 'chatgpt/fable-5' }])).toBe(true);
    await prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider]);
    expect(prefs.isModelVisibilityCustomized('claude-code', 'xd', 'chatgpt/fable-5')).toBe(false);
  });

  it('waits for legacy ownership before initialization and preserves off switches on retry', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1', JSON.stringify({ 'claude-code:xd:chatgpt/gemini': false }));
    setOwnerClaim('owner-a', 1, true, false);
    const prefs = await upgrade();
    expect(memStorage.getItem(markerKey)).toBeNull();
    setOwnerClaim('owner-a', 1);
    await prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider]);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(true);
    expect(memStorage.getItem(markerKey)).not.toBeNull();
  });

  it('isolates owner baselines and rejects stale owner generations', async () => {
    const first = await upgrade();
    await first.setModelVisibility('pi', 'xd', 'gemini', false);
    setOwnerClaim('owner-b', 2, false, false, true);
    const prefs = await upgrade('owner-b', 2);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(true);
    const before = memStorage.getItem('xdt:modelVisibilityPrefs:v1.initialization.owner.owner-b');
    await prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider]);
    await prefs.migrateModelVisibilityDefaults('owner-b', 1, [provider]);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.initialization.owner.owner-b')).toBe(before);
  });

  it.each([false, true])('retains fresh initialization through pending writes, unless legacy data exists (%s)', async (hasLegacy) => {
    if (hasLegacy) memStorage.setItem('xdt:modelVisibilityPrefs:v1', JSON.stringify({ 'pi:xd:fable-5': false }));
    setOwnerClaim('owner-a', 1, true, false);
    const prefs = await upgrade();
    await prefs.setModelVisibility('pi', 'xd', 'fable-5-1', false);
    if (hasLegacy) expect(memStorage.getItem(markerKey)).toBeNull();
    else expect(JSON.parse(memStorage.getItem(markerKey)!)).toMatchObject({
      eligibleForDefaults: true,
      scopes: provider.agents.map((agent) => JSON.stringify([provider.id, agent])),
    });
    setOwnerClaim('owner-a', 1);
    await prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider]);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'fable-5-1', defaultEnabled: true })).toBe(false);
  });

  it('retries a baseline write failure without overwriting a newer explicit off switch', async () => {
    const prefs = await loadModuleForOwner();
    const original = memStorage.setItem.bind(memStorage);
    const spy = vi.spyOn(memStorage, 'setItem').mockImplementation((key, value) => {
      if (key === markerKey) throw new Error('storage full');
      original(key, value);
    });
    expect(await prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider])).toBe(false);
    expect(JSON.parse(memStorage.getItem(markerKey)!)).toMatchObject({ eligibleForDefaults: true, scopes: [] });
    spy.mockRestore();
    await prefs.setModelVisibility('pi', 'xd', 'gemini', false);
    expect(await prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider])).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(false);
  });
});


it('restores imported native defaults while preserving manual overrides until reset', async () => {
  const prefs = await import('../state/modelVisibilityPrefs');
  prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
  const agents = ['claude-code', 'codex', 'pi'] as const;
  const p = buildUserProvider({ id: 'imported-native', name: 'Test', runtimes: Object.fromEntries(
    agents.map(agent => [agent, { baseUrl: 'https://example.com/v1', models: [{
      id: 'claude-test', name: 'Claude', api: 'anthropic-messages',
    }] }]),
  ) }, { modelRegistry: { schemaVersion: 5, updatedAt: '2026-09-13T00:00:00Z', models: [{
    id: 'claude-test', name: 'Claude', nativeApi: 'anthropic-messages',
    routes: [{ providerId: 'imported-native', modelId: 'claude-test', agents: ['claude-code', 'codex'] }],
  }] } });
  const enabled = () => agents.map(agent => prefs.isModelEnabled(agent, p.id, p.models[agent]![0]!));
  expect(enabled()).toEqual([true, false, true]);
  await prefs.setModelVisibility('pi', p.id, 'claude-test', false);
  await prefs.setModelVisibility('codex', p.id, 'claude-test', true);
  expect(enabled()).toEqual([true, true, false]);
  await prefs.resetModelVisibilities(p.id, agents.map(agent => ({ agent, modelId: 'claude-test' })));
  expect(enabled()).toEqual([true, false, true]);
});
