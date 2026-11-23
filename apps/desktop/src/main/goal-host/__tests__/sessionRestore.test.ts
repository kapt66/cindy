import { describe, expect, it, vi } from 'vitest';

import type { Session, SessionMeta } from '@cindy/maker-core';

import type {
  AppliedMekaRuntimeConfig,
  PersistedMekaSessionBinding,
} from '../../meka-injection/index';
import type { MakerSessionCreateOpts } from '../../maker-ipc/sessionRequest';
import { restoreSessionForGoal, type RestoreGoalSessionDeps } from '../sessionRestore';

const META: SessionMeta = {
  id: 'session-1',
  agentKind: 'codex',
  workDir: '/repo',
  title: 'Session',
  model: 'gpt-5',
  createdAt: 1,
  updatedAt: 1,
  sdkSessionId: 'thread-1',
};

/** 持久化行：Meka 项目 saga2 + 该项目默认角色（成对绑定）。 */
const MEKA_BINDING: PersistedMekaSessionBinding = {
  workspaceKind: 'project',
  mekaProjectId: 'saga2',
  mekaRoleId: 'saga2-default-role',
  mekaRole: null,
};

/** 普通（非 Meka）持久化行。 */
const ORDINARY_BINDING: PersistedMekaSessionBinding = {
  workspaceKind: 'dialogue',
  mekaProjectId: null,
  mekaRoleId: null,
  mekaRole: null,
};

const EMPTY_MEKA_RESULT: AppliedMekaRuntimeConfig = {
  didApply: false,
  mcpProviderIds: [],
  inlineMcpCount: 0,
  skillsCount: 0,
  platformSkillsCount: 0,
  skillSnapshot: null,
};

function fakeSession(): Session {
  return {
    id: 'session-1',
    agentKind: 'codex',
    send: vi.fn(),
    onEvent: vi.fn(),
    isTurnRunning: vi.fn().mockReturnValue(false),
    abort: vi.fn(),
  } as unknown as Session;
}

function baseDeps(overrides: Partial<RestoreGoalSessionDeps> = {}): RestoreGoalSessionDeps {
  return {
    maker: {
      getSession: vi.fn(),
      getSessionMeta: vi.fn().mockResolvedValue(META),
      createSession: vi.fn().mockResolvedValue(fakeSession()),
    },
    warn: vi.fn(),
    getSessionRow: vi.fn().mockResolvedValue({ providerId: 'provider-1' }),
    hydrateProvider: vi.fn(),
    prepareOrcaStart: vi.fn().mockResolvedValue(true),
    markOrcaHydrated: vi.fn(),
    wireSession: vi.fn(),
    // 默认普通会话：不升级绑定、不注入。测试不 mock 模块，靠这两条 seam 隔离真实 DB / 注入。
    ensureMekaBinding: vi.fn().mockResolvedValue(ORDINARY_BINDING),
    applyMekaRuntime: vi.fn().mockResolvedValue(EMPTY_MEKA_RESULT),
    ...overrides,
  };
}

describe('Goal dormant session restore', () => {
  it('prepares persisted Orca context before entering Maker singleflight', async () => {
    const order: string[] = [];
    const deps = baseDeps({
      prepareOrcaStart: vi.fn().mockImplementation(async (_sessionId, opts) => {
        order.push('prepare');
        opts.vendorOptions = { orcaRole: 'lead', orcaLeadSessionId: 'session-1' };
        opts.userPrompt = 'orca lead instructions';
        return true;
      }),
    });
    vi.mocked(deps.maker.createSession).mockImplementation(async (opts) => {
      order.push('create');
      expect(opts.vendorOptions).toMatchObject({ orcaRole: 'lead' });
      expect(opts.userPrompt).toBe('orca lead instructions');
      return fakeSession();
    });
    vi.mocked(deps.markOrcaHydrated!).mockImplementation(() => {
      order.push('mark');
    });

    await expect(restoreSessionForGoal('session-1', deps)).resolves.toMatchObject({
      id: 'session-1',
    });

    expect(order).toEqual(['prepare', 'create', 'mark']);
    expect(deps.hydrateProvider).toHaveBeenCalledWith('session-1', 'provider-1');
    expect(deps.wireSession).toHaveBeenCalledOnce();
  });

  it('rebuilds an error Session instead of returning the poisoned live object', async () => {
    const poisoned = {
      ...fakeSession(),
      getStatus: vi.fn().mockReturnValue('error'),
    } as unknown as Session;
    const replacement = fakeSession();
    const deps = baseDeps({
      maker: {
        getSession: vi.fn().mockReturnValue(poisoned),
        getSessionMeta: vi.fn().mockResolvedValue(META),
        createSession: vi.fn().mockResolvedValue(replacement),
      },
    });

    await expect(restoreSessionForGoal('session-1', deps)).resolves.toBe(replacement);

    expect(deps.maker.createSession).toHaveBeenCalledOnce();
    expect(deps.wireSession).toHaveBeenCalledWith(replacement);
  });

  it('preserves a persisted null provider route when restoring a Pi session', async () => {
    const deps = baseDeps({
      maker: {
        getSession: vi.fn(),
        getSessionMeta: vi.fn().mockResolvedValue({ ...META, agentKind: 'pi' }),
        createSession: vi.fn().mockResolvedValue(fakeSession()),
      },
      getSessionRow: vi.fn().mockResolvedValue({ providerId: null }),
    });

    await restoreSessionForGoal('session-1', deps);

    expect(deps.maker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentKind: 'pi', providerId: null }),
    );
    expect(deps.hydrateProvider).toHaveBeenCalledWith('session-1', null);
  });

  it('marks Orca hydration only after successful session creation', async () => {
    const markOrcaHydrated = vi.fn();
    const warn = vi.fn();
    const deps = baseDeps({
      maker: {
        getSession: vi.fn(),
        getSessionMeta: vi.fn().mockResolvedValue(META),
        createSession: vi.fn().mockRejectedValue(new Error('start failed')),
      },
      markOrcaHydrated,
      warn,
    });

    await expect(restoreSessionForGoal('session-1', deps)).resolves.toBeUndefined();

    expect(markOrcaHydrated).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[goal-host] ensureSession createSession failed',
      expect.objectContaining({ sessionId: 'session-1' }),
    );
  });

  // Goal 恢复是**不经过**桌面 `bootstrapSessionOnce` 的启动收口：持久行已绑定 Meka 时，
  // 必须在 createSession 前用唯一注入入口应用运行时，且 create opts 带持久化身份。
  it('injects the persisted Meka runtime before creating the dormant session', async () => {
    const ensureMekaBinding = vi.fn().mockResolvedValue(MEKA_BINDING);
    const applyMekaRuntime = vi.fn(
      async (opts: MakerSessionCreateOpts): Promise<AppliedMekaRuntimeConfig> => {
        // 生产实现按持久绑定回填 opts（sessionBindingPatch）；这里断言同一可观察结果。
        opts.workspaceKind = 'project';
        opts.mekaProjectId = MEKA_BINDING.mekaProjectId;
        opts.mekaRoleId = MEKA_BINDING.mekaRoleId;
        return { ...EMPTY_MEKA_RESULT, didApply: true };
      },
    );
    const deps = baseDeps({ ensureMekaBinding, applyMekaRuntime });

    await expect(restoreSessionForGoal('session-1', deps)).resolves.toMatchObject({
      id: 'session-1',
    });

    expect(ensureMekaBinding).toHaveBeenCalledWith('session-1');
    expect(applyMekaRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1' }),
      { readPersistedSession: ensureMekaBinding },
    );
    expect(applyMekaRuntime.mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(deps.maker.createSession).mock.invocationCallOrder[0]!,
    );
    expect(deps.maker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-1',
        workspaceKind: 'project',
        mekaProjectId: 'saga2',
        mekaRoleId: 'saga2-default-role',
      }),
    );
  });

  // 旧行兼容：`workspaceKind === 'meka'` 的行仍要注入（注入层按旧 kind 派生默认角色）。
  it('injects sessions persisted under the legacy meka workspace kind', async () => {
    const ensureMekaBinding = vi.fn().mockResolvedValue({
      ...MEKA_BINDING,
      workspaceKind: 'meka',
      mekaRoleId: null,
    } satisfies PersistedMekaSessionBinding);
    const deps = baseDeps({ ensureMekaBinding });

    await restoreSessionForGoal('session-1', deps);

    expect(deps.applyMekaRuntime).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.applyMekaRuntime!).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(deps.maker.createSession).mock.invocationCallOrder[0]!,
    );
  });

  // 普通会话是回归边界：不升级绑定、不注入，恢复流程照旧。
  it('leaves ordinary sessions untouched', async () => {
    const deps = baseDeps();

    await restoreSessionForGoal('session-1', deps);

    expect(deps.ensureMekaBinding).toHaveBeenCalledWith('session-1');
    expect(deps.applyMekaRuntime).not.toHaveBeenCalled();
    expect(deps.maker.createSession).toHaveBeenCalledOnce();
  });

  // 失败必须 fail-closed：注入失败时绝不能把 Meka 会话按普通身份拉起来。
  it('fails closed without starting the session when Meka injection fails', async () => {
    const warn = vi.fn();
    const deps = baseDeps({
      ensureMekaBinding: vi.fn().mockResolvedValue(MEKA_BINDING),
      applyMekaRuntime: vi.fn().mockRejectedValue(new Error('meka config failed')),
      warn,
    });

    await expect(restoreSessionForGoal('session-1', deps)).resolves.toBeUndefined();

    expect(deps.maker.createSession).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[goal-host] ensureSession createSession failed',
      expect.objectContaining({ sessionId: 'session-1' }),
    );
  });
});
