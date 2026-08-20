import { promises as fs } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { MekaRoleMcpEntry } from '../../../shared/meka-projects.js';
import type { MekaRuntimeConfig } from '../../meka-projects/runtimeConfig.js';
import { applyMekaRuntimeConfig } from '../mekaRuntimeInjection.js';
import type { MakerSessionCreateOpts } from '../sessionRequest.js';

const environmentServices = vi.hoisted(() => ({
  p4: { get: vi.fn(async () => ({ p4RootPath: null })) },
  router: {
    listInstances: vi.fn(async () => []),
    listProjectBindings: vi.fn(async () => []),
  },
}));

vi.mock('../../meka-settings/ipc.js', () => ({
  getMekaP4SettingsService: () => environmentServices.p4,
  getMekaRouterService: () => environmentServices.router,
}));

function baseOpts(overrides: Partial<MakerSessionCreateOpts> = {}): MakerSessionCreateOpts {
  return {
    id: 'session-1',
    agentKind: 'codex',
    model: 'gpt-test',
    workingDir: 'C:/Workspace/saga2/saga2_project',
    workspaceKind: 'meka',
    mekaProjectId: 'saga2',
    mekaRoleId: 'general-development',
    ...overrides,
  };
}

function runtime(overrides: Partial<MekaRuntimeConfig> = {}): MekaRuntimeConfig {
  return {
    projectId: 'saga2',
    roleId: 'general-development',
    roleDisplayName: '通用开发',
    workflowRecoveredFromRole: false,
    promptText: 'SAGA2 server code lives behind MCPRouter as saga2-server.',
    skills: [
      {
        id: 'remote-operation',
        name: 'Remote Operation',
        description: 'Use bound MCPRouter instances.',
        content: '# Remote Operation',
        sourceDirectory: 'C:/skills/remote-operation',
        sourceEntryPath: 'C:/skills/remote-operation/SKILL.md',
      },
    ],
    mcp: [
      { id: 'router', providerId: 'mcp-router', enabled: true },
      { id: 'project-agent', providerId: 'project-agent', enabled: true },
      { id: 'design', providerId: 'meka-design', enabled: true },
      { id: 'local-http', transport: 'http', url: 'https://example.invalid/mcp', enabled: true },
    ],
    policyProviderRefs: [],
    ...overrides,
  };
}

describe('applyMekaRuntimeConfig', () => {
  it('is wired into register bootstrap before maker.createSession', async () => {
    const source = await fs.readFile(new URL('../register.ts', import.meta.url), 'utf8');
    const bootstrap = source.indexOf('async function bootstrapSession');
    const applyRuntime = source.indexOf('await applyMekaRuntimeConfig(o,', bootstrap);
    const createSession = source.indexOf('await maker.createSession(o)', bootstrap);

    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(applyRuntime).toBeGreaterThan(bootstrap);
    expect(createSession).toBeGreaterThan(applyRuntime);
  });

  it('injects project-role prompt and MCP provider ids for Meka sessions', async () => {
    const opts = baseOpts({
      userPrompt: 'USER PROMPT',
      vendorOptions: { onStderrLine: 'keep-me', orcaRole: 'lead' },
    });
    const snapshot = {
      revision: 'a'.repeat(64),
      pluginPath: 'C:/CindyMeka/meka-skill-snapshots/revisions/a/claude-plugin',
      files: [
        {
          relativePath: 'skills/remote-operation/SKILL.md',
          contentBase64: 'IyBSZW1vdGUgT3BlcmF0aW9u',
          digest: '1'.repeat(64),
        },
      ],
    };
    const materialize = vi.fn(async () => snapshot);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime()),
      prepareRuntimeMcp: vi.fn((entries: readonly MekaRoleMcpEntry[]) => ({
        providerIds: entries
          .filter(
            (entry): entry is Extract<typeof entry, { providerId: string }> =>
              'providerId' in entry,
          )
          .map((entry) => entry.providerId),
        inlineConfigs: entries.filter(
          (entry): entry is Extract<typeof entry, { transport: unknown }> => 'transport' in entry,
        ),
      })),
      materializeSkillSnapshot: materialize,
    });

    expect(result).toMatchObject({
      didApply: true,
      mcpProviderIds: ['mcp-router', 'project-agent', 'meka-design'],
      inlineMcpCount: 1,
      skillsCount: 1,
      skillSnapshot: snapshot,
      workflow: null,
      workflowRecoveredFromRole: false,
      combatEnvironmentReady: null,
    });
    expect(opts.userPrompt).toContain('[MEKA_ROLE_CONTEXT]');
    expect(opts.userPrompt).toContain('roleId: general-development');
    expect(opts.userPrompt).toContain('displayName: 通用开发');
    expect(opts.userPrompt).toContain(
      'SAGA2 server code lives behind MCPRouter as saga2-server.\n\nUSER PROMPT',
    );
    expect(opts.userPrompt).not.toContain('# Remote Operation');
    expect(opts.nativeSkillPluginPath).toBe(snapshot.pluginPath);
    expect(opts.nativeSkillRevision).toBe(snapshot.revision);
    expect(opts.vendorOptions).toMatchObject({
      onStderrLine: 'keep-me',
      orcaRole: 'lead',
      source: 'meka',
      mekaProjectId: 'saga2',
      mekaRoleId: 'general-development',
      mekaMcpProviderIds: ['mcp-router', 'project-agent', 'meka-design'],
      mekaMcpInlineConfigs: [
        { id: 'local-http', transport: 'http', url: 'https://example.invalid/mcp' },
      ],
    });
    expect(materialize).toHaveBeenCalledWith(opts.id, runtime().skills);
  });

  it('uses an immutable native Skill snapshot without mutating the workspace', async () => {
    const opts = baseOpts({ workingDir: 'C:/Workspace/real-project' });
    const resolved = runtime();
    const snapshot = {
      revision: 'b'.repeat(64),
      pluginPath: 'C:/CindyMeka/meka-skill-snapshots/revisions/b/claude-plugin',
      files: [
        {
          relativePath: 'skills/remote-operation/SKILL.md',
          contentBase64: 'IyBSZW1vdGUgT3BlcmF0aW9u',
          digest: '2'.repeat(64),
        },
      ],
    };
    const materialize = vi.fn(async () => snapshot);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => resolved),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      materializeSkillSnapshot: materialize,
    });

    expect(result.skillSnapshot).toBe(snapshot);
    expect(materialize).toHaveBeenCalledWith(opts.id, resolved.skills);
    expect(opts.nativeSkillPluginPath).toBe(snapshot.pluginPath);
    expect(opts.nativeSkillRevision).toBe(snapshot.revision);
    expect(opts.userPrompt).toContain('[MEKA_ROLE_CONTEXT]');
    expect(opts.userPrompt).toContain('SAGA2 server code lives behind MCPRouter as saga2-server.');
  });

  it('enters environment-recovery mode before combat exploration when the gate is blocked', async () => {
    const opts = baseOpts({ mekaRoleId: 'combat-development' });

    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () =>
        runtime({
          roleId: 'combat-development',
          roleDisplayName: '战斗开发',
          workflow: 'saga2-combat-development-v1',
        }),
      ),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      materializeSkillSnapshot: vi.fn(async () => null),
    });

    expect(opts.userPrompt).toContain('[SAGA2_COMBAT_ENVIRONMENT_GATE]');
    expect(opts.userPrompt).toContain('roleId: combat-development');
    expect(opts.userPrompt).toContain('displayName: 战斗开发');
    expect(opts.userPrompt).toContain('ready: false');
    expect(opts.userPrompt).toContain('BLOCKED TURN CONTRACT');
    expect(opts.userPrompt).toContain('Do not load Skills or AGENTS.md');
    expect(opts.userPrompt).toContain('without any tool call');
    expect(opts.userPrompt).toContain('first user-visible assistant message');
    expect(opts.vendorOptions).toMatchObject({
      mekaCombatEnvironmentReady: false,
      codexNativeSubagentsDisabled: true,
    });
  });

  it('isolates remote server workers from local combat environment state', async () => {
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      remoteHostId: 'mcpr:server-1',
      orcaRole: 'worker',
      vendorOptions: { orcaRole: 'worker', orcaLeadSessionId: 'lead-1' },
    });

    const materialize = vi.fn(async () => null);
    const prepareRuntimeMcp = vi.fn(() => ({ providerIds: [], inlineConfigs: [] }));
    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () =>
        runtime({
          roleId: 'combat-development',
          roleDisplayName: '战斗开发',
          workflow: 'saga2-combat-development-v1',
        }),
      ),
      prepareRuntimeMcp,
      materializeSkillSnapshot: materialize,
    });

    expect(result).toMatchObject({
      didApply: true,
      mcpProviderIds: [],
      inlineMcpCount: 0,
      skillsCount: 0,
      skillSnapshot: null,
    });
    expect(prepareRuntimeMcp).toHaveBeenCalledWith([]);
    expect(materialize).toHaveBeenCalledWith(opts.id, []);
    expect(opts.nativeSkillPluginPath).toBeUndefined();
    expect(opts.nativeSkillRevision).toBeUndefined();
    expect(opts.vendorOptions).toMatchObject({
      mekaWorkflow: 'saga2-combat-server-worker-v1',
      source: 'meka',
      mekaProjectId: 'saga2',
      codexNativeSubagentsDisabled: true,
    });
    expect(opts.vendorOptions).not.toHaveProperty('mekaCombatEnvironmentReady');
    expect(opts.vendorOptions).not.toHaveProperty('mekaCombatPlanApproved');
    expect(opts.userPrompt).toContain('[SAGA2_COMBAT_REMOTE_SERVER_WORKER]');
    expect(opts.userPrompt).toContain('整个任务永久只读');
    expect(opts.userPrompt).toContain('serverCapabilityReport');
    expect(opts.userPrompt).toContain('唯一一次完整终态回复');
    expect(opts.userPrompt).toContain('MCPR Codex 不暴露 orca_worker_bridge');
    expect(opts.userPrompt).toContain('Orca 会把终态回复自动桥接给 Lead');
    expect(opts.userPrompt).toContain('[SAGA2_MODULE_FIRST]');
    expect(opts.userPrompt).toContain('只核查其中标记为剩余服务器缺口的窄语义');
    expect(opts.userPrompt).toContain('没有完整专用函数不等于模块组合不支持');
    expect(opts.userPrompt).not.toContain('battle-designer-server-development');
    expect(opts.userPrompt).not.toContain(
      'SAGA2 server code lives behind MCPRouter as saga2-server.',
    );
    expect(opts.userPrompt).not.toContain('[MEKA_ROLE_CONTEXT]');
  });

  it('freezes an empty selection without mounting an empty native Skill plugin', async () => {
    const opts = baseOpts();
    const snapshot = {
      revision: '0'.repeat(64),
      pluginPath: 'C:/CindyMeka/meka-skill-snapshots/revisions/0/claude-plugin',
      files: [{ relativePath: 'catalog.json', contentBase64: 'W10K', digest: '4'.repeat(64) }],
    };

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime({ skills: [], mcp: [] })),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      materializeSkillSnapshot: vi.fn(async () => snapshot),
    });

    expect(result.skillSnapshot).toBe(snapshot);
    expect(opts.nativeSkillPluginPath).toBeUndefined();
    expect(opts.nativeSkillRevision).toBeUndefined();
  });

  it.each([
    ['planner', 'general-development'],
    ['artist', 'general-development'],
    ['tester', 'general-development'],
    ['programmer', 'general-development'],
  ] as const)(
    'hydrates a persisted legacy %s binding as %s',
    async (legacyRole, expectedRoleId) => {
      const opts = baseOpts({
        id: 'legacy-session',
        workspaceKind: undefined,
        mekaProjectId: null,
        mekaRoleId: null,
        mekaRole: null,
      });
      const resolveRuntimeConfig = vi.fn(async (projectId: string, roleId: string) =>
        runtime({ projectId, roleId, skills: [], mcp: [] }),
      );

      const result = await applyMekaRuntimeConfig(opts, {
        readPersistedSession: vi.fn(async () => ({
          workspaceKind: 'meka' as const,
          mekaProjectId: 'saga2',
          mekaRoleId: null,
          mekaRole: legacyRole,
        })),
        resolveRuntimeConfig,
        prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
        materializeSkillSnapshot: vi.fn(async () => null),
      });

      expect(result.didApply).toBe(true);
      expect(resolveRuntimeConfig).toHaveBeenCalledWith('saga2', expectedRoleId);
      expect(opts).toMatchObject({
        workspaceKind: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: expectedRoleId,
        mekaRole: legacyRole,
      });
    },
  );

  it('does not duplicate prompt injection when the same create opts are bootstrapped twice', async () => {
    const opts = baseOpts({ userPrompt: 'USER PROMPT' });
    const resolveRuntimeConfig = vi.fn(async () => runtime({ skills: [], mcp: [] }));
    const prepareRuntimeMcp = vi.fn(() => ({ providerIds: [], inlineConfigs: [] }));
    const materializeSkillSnapshot = vi.fn(async () => null);

    const first = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      prepareRuntimeMcp,
      materializeSkillSnapshot,
    });
    const promptAfterFirstBootstrap = opts.userPrompt;
    const second = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      prepareRuntimeMcp,
      materializeSkillSnapshot,
    });

    expect(first.didApply).toBe(true);
    expect(second.didApply).toBe(false);
    expect(resolveRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(prepareRuntimeMcp).toHaveBeenCalledTimes(1);
    expect(materializeSkillSnapshot).toHaveBeenCalledTimes(2);
    expect(opts.userPrompt).toBe(promptAfterFirstBootstrap);
  });

  it('freezes remote skills without exposing the local snapshot path to the remote harness', async () => {
    const opts = baseOpts({ remoteHostId: 'mcpr:instance-1' });
    const snapshot = {
      revision: 'c'.repeat(64),
      pluginPath: 'C:/CindyMeka/meka-skill-snapshots/revisions/c/claude-plugin',
      files: [
        {
          relativePath: 'skills/remote-operation/SKILL.md',
          contentBase64: 'IyBSZW1vdGUgT3BlcmF0aW9u',
          digest: '3'.repeat(64),
        },
      ],
    };
    const materialize = vi.fn(async () => snapshot);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime()),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      materializeSkillSnapshot: materialize,
    });

    expect(result.skillSnapshot).toBe(snapshot);
    expect(materialize).toHaveBeenCalledWith(opts.id, runtime().skills);
    expect(opts.nativeSkillPluginPath).toBeUndefined();
    expect(opts.nativeSkillRevision).toBeUndefined();
    expect(opts.userPrompt).not.toContain('# Remote Operation');

    const retried = await applyMekaRuntimeConfig(opts, {
      materializeSkillSnapshot: materialize,
    });
    expect(retried.skillSnapshot).toBe(snapshot);
    expect(opts.userPrompt).toContain('[MEKA_ROLE_CONTEXT]');
    expect(opts.userPrompt).toContain('SAGA2 server code lives behind MCPRouter as saga2-server.');
    expect(materialize).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: 'project/role resolution',
      deps: {
        resolveRuntimeConfig: vi.fn(async () => {
          throw new Error('broken role');
        }),
      },
      message: '[INVALID_PARAMS] Meka project/role configuration failed: broken role',
    },
    {
      name: 'MCP preparation',
      deps: {
        resolveRuntimeConfig: vi.fn(async () => runtime()),
        prepareRuntimeMcp: vi.fn(() => {
          throw new Error('broken MCP');
        }),
      },
      message: '[INVALID_PARAMS] Meka project/role MCP configuration failed: broken MCP',
    },
  ])('preserves INVALID_PARAMS for $name failures', async ({ deps, message }) => {
    await expect(applyMekaRuntimeConfig(baseOpts(), deps)).rejects.toThrow(message);
  });

  it('leaves non-Meka sessions untouched', async () => {
    const opts = baseOpts({
      workspaceKind: 'project',
      mekaProjectId: null,
      mekaRoleId: null,
      userPrompt: 'USER PROMPT',
    });
    const resolveRuntimeConfig = vi.fn();

    const result = await applyMekaRuntimeConfig(opts, { resolveRuntimeConfig });

    expect(result.didApply).toBe(false);
    expect(resolveRuntimeConfig).not.toHaveBeenCalled();
    expect(opts.userPrompt).toBe('USER PROMPT');
    expect(opts.vendorOptions).toBeUndefined();
  });
});
