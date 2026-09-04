import { promises as fs } from 'node:fs';
import os from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import type { MekaRoleMcpEntry } from '../../../shared/meka-projects.js';
import type { MekaRuntimeConfig } from '../../meka-projects/runtimeConfig.js';
import {
  applyMekaRuntimeConfig as applyMekaRuntimeConfigImpl,
  combatSkillIdVendorPatchFromUserPrompt,
  parseCombatSkillIdFromUserPrompt,
  prepareCombatFollowupRuntimeContext,
} from '../mekaRuntimeInjection.js';
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

vi.mock('../../maker-host/mcpr-codex-capability.js', () => ({
  probeRemoteCodexCapability: vi.fn(async () => undefined),
}));

vi.mock('../../maker-host/mcpr-claude-capability.js', () => ({
  probeRemoteClaudeCapability: vi.fn(async () => undefined),
}));

type ApplyDeps = NonNullable<Parameters<typeof applyMekaRuntimeConfigImpl>[1]>;

function applyMekaRuntimeConfig(opts: MakerSessionCreateOpts, deps: ApplyDeps = {}) {
  return applyMekaRuntimeConfigImpl(opts, {
    resolvePlatformSkills: async () => [],
    ...deps,
  });
}

function platformSkill() {
  return {
    id: 'platform-capabilities',
    name: 'platform-capabilities',
    description: 'Host-owned Meka platform capabilities.',
    content: '# Platform Capabilities',
    sourceDirectory: 'C:/skills/platform-capabilities',
    sourceEntryPath: 'C:/skills/platform-capabilities/SKILL.md',
  };
}

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
  it('extracts only an explicitly labelled positive combat skill ID', () => {
    expect(parseCombatSkillIdFromUserPrompt('技能 ID：1019，伤害 100，重复 3 次')).toEqual({
      state: 'valid',
      skillId: '1019',
    });
    expect(parseCombatSkillIdFromUserPrompt('请检查技能1019的伤害目标')).toEqual({
      state: 'valid',
      skillId: '1019',
    });
    expect(parseCombatSkillIdFromUserPrompt('检查下1009技能')).toEqual({
      state: 'valid',
      skillId: '1009',
    });
    expect(parseCombatSkillIdFromUserPrompt('请检查 1009 技能的伤害目标')).toEqual({
      state: 'valid',
      skillId: '1009',
    });
    expect(parseCombatSkillIdFromUserPrompt('技能编号就是 1019，继续完成刚才的修改')).toEqual({
      state: 'valid',
      skillId: '1019',
    });
    expect(parseCombatSkillIdFromUserPrompt('1021')).toEqual({
      state: 'valid',
      skillId: '1021',
    });
    expect(parseCombatSkillIdFromUserPrompt('伤害 100，重复 3 次')).toEqual({ state: 'missing' });
    expect(parseCombatSkillIdFromUserPrompt('技能ID是skill_001')).toEqual({ state: 'missing' });
    expect(parseCombatSkillIdFromUserPrompt('对比技能 1019 和技能 1010')).toEqual({
      state: 'ambiguous',
      skillIds: ['1019', '1010'],
    });
    expect(parseCombatSkillIdFromUserPrompt('技能 ID: 900719925474099312345678901')).toEqual({
      state: 'valid',
      skillId: '900719925474099312345678901',
    });
  });

  it('turns a follow-up skill ID into a live target patch without guessing ordinary numbers', () => {
    expect(combatSkillIdVendorPatchFromUserPrompt('伤害 100，1 秒后重复 3 次')).toBeNull();
    expect(
      combatSkillIdVendorPatchFromUserPrompt('技能 ID 就是 1019，继续完成刚才的修改。'),
    ).toEqual({
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatTargetSkillIds: undefined,
    });
    expect(combatSkillIdVendorPatchFromUserPrompt('对比技能 1019 和技能 1010')).toEqual({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'ambiguous',
      mekaCombatTargetSkillIds: ['1019', '1010'],
    });
  });

  it('clears prior target export state when a follow-up switches skills', async () => {
    const runtimeConfig: MekaRuntimeConfig = runtime({
      workflow: 'saga2-combat-development-v1',
      roleId: 'combat-development',
      skills: [],
    });
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      userPrompt: '技能 ID: 1019',
      vendorOptions: {
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatTargetSkillId: '1019',
        mekaCombatTargetExportAttempted: true,
        mekaCombatTargetExportCompleted: true,
      },
    });
    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtimeConfig),
      materializeSkillSnapshot: vi.fn(async () => null),
    });
    opts.userPrompt = '技能 ID: 1021';
    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtimeConfig),
      materializeSkillSnapshot: vi.fn(async () => null),
    });
    expect(opts.vendorOptions).toMatchObject({
      mekaCombatTargetSkillId: '1021',
      mekaCombatTargetExportAttempted: undefined,
      mekaCombatTargetExportCompleted: undefined,
    });
  });

  it('injects the confirmed follow-up target, project paths, and resolved server target', async () => {
    const resolveCombatServerTarget = vi.fn(async () => ({
      remoteHostId: 'mcpr:server-1',
      workerAgent: 'claude-code' as const,
    }));

    const result = await prepareCombatFollowupRuntimeContext({
      prompt: '1021',
      projectId: 'saga2',
      workingDir: 'C:/Workspace/saga2/saga2_project',
      resolveCombatServerTarget,
    });

    expect(resolveCombatServerTarget).toHaveBeenCalledWith('saga2');
    expect(result?.vendorOptionsPatch).toMatchObject({
      mekaCombatTargetSkillId: '1021',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatTargetExportAttempted: undefined,
      mekaCombatTargetExportCompleted: undefined,
      mekaCombatServerRemoteHostId: 'mcpr:server-1',
      mekaCombatServerWorkerAgent: 'claude-code',
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatPlanApproved: false,
    });
    expect(result?.promptSection).toContain('[SAGA2_COMBAT_TARGET]');
    expect(result?.promptSection).toContain('targetSkillId: 1021');
    expect(result?.promptSection).toContain('[SAGA2_PROJECT_PATHS]');
    expect(result?.promptSection).toContain(
      'unityClientRoot: C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
    );
    expect(result?.promptSection).toContain(
      "unityAgentsReadCommand: Get-Content -LiteralPath 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\AGENTS.md'",
    );
    expect(result?.promptSection).toContain('[SAGA2_COMBAT_SERVER_TARGET]');
    expect(result?.promptSection).toContain('serverRemoteHostId: mcpr:server-1');
    expect(result?.promptSection).toContain('serverWorkerAgent: claude-code');
  });

  it('clears stale export evidence in the live follow-up patch', async () => {
    const result = await prepareCombatFollowupRuntimeContext({
      prompt: '技能 ID: 1021，继续修改',
      projectId: 'saga2',
      workingDir: 'C:/Workspace/saga2/saga2_project',
      sessionId: 'live-followup-1',
      resolveCombatServerTarget: vi.fn(async () => null),
    });
    const liveOptions: Record<string, unknown> = {
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetExportAttempted: true,
      mekaCombatTargetExportCompleted: true,
      mekaCombatServerCapabilityStatus: 'supported',
      mekaCombatPlanApproved: true,
    };
    Object.assign(liveOptions, result?.vendorOptionsPatch);
    expect(liveOptions).toMatchObject({
      mekaCombatTargetSkillId: '1021',
      mekaCombatTargetExportAttempted: undefined,
      mekaCombatTargetExportCompleted: undefined,
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatPlanApproved: false,
    });
  });

  it('injects an unavailable server target when follow-up target resolution fails', async () => {
    const result = await prepareCombatFollowupRuntimeContext({
      prompt: '技能 ID 是 1021',
      projectId: 'saga2',
      workingDir: 'C:/Workspace/saga2/saga2_project',
      resolveCombatServerTarget: vi.fn(async () => {
        throw new Error('transport unavailable');
      }),
    });

    expect(result?.vendorOptionsPatch).toMatchObject({
      mekaCombatTargetSkillId: '1021',
      mekaCombatServerRemoteHostId: undefined,
      mekaCombatServerWorkerAgent: undefined,
    });
    expect(result?.promptSection).toContain('[SAGA2_COMBAT_SERVER_TARGET]');
    expect(result?.promptSection).toContain('status: unavailable');
  });

  it('clears target and server routing for an ambiguous follow-up without resolving a worker', async () => {
    const resolveCombatServerTarget = vi.fn();
    const result = await prepareCombatFollowupRuntimeContext({
      prompt: '对比技能 1019 和技能 1010',
      projectId: 'saga2',
      workingDir: 'C:/Workspace/saga2/saga2_project',
      resolveCombatServerTarget,
    });

    expect(resolveCombatServerTarget).not.toHaveBeenCalled();
    expect(result).toEqual({
      vendorOptionsPatch: {
        mekaCombatTargetSkillId: undefined,
        mekaCombatTargetSkillIdState: 'ambiguous',
        mekaCombatTargetSkillIds: ['1019', '1010'],
        mekaCombatServerRemoteHostId: undefined,
        mekaCombatServerWorkerAgent: undefined,
        mekaCombatServerCapabilityStatus: 'unchecked',
        mekaCombatPlanApproved: false,
        mekaCombatReferenceSkillId: undefined,
        mekaCombatTargetExportCompleted: undefined,
      },
      promptSection: null,
    });
  });

  it('commits live combat context only from the accepted-message hook', async () => {
    const source = await fs.readFile(new URL('../register.ts', import.meta.url), 'utf8');
    const prepare = source.indexOf('prepareSendUserMessage: async');
    const normalize = source.indexOf('await prepareUserMessageForAgent', prepare);
    const resolve = source.indexOf('await prepareCombatFollowupRuntimeContext', prepare);
    const accepted = source.indexOf('onAccepted: async', resolve);
    const refresh = source.indexOf('await liveSession.setVendorOptions', accepted);
    const undispatched = source.indexOf('onUndispatched: async', refresh);

    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(normalize).toBeGreaterThan(prepare);
    expect(resolve).toBeGreaterThan(normalize);
    expect(accepted).toBeGreaterThan(resolve);
    expect(refresh).toBeGreaterThan(accepted);
    expect(undispatched).toBeGreaterThan(refresh);
    expect(source.slice(resolve, accepted)).not.toContain('setVendorOptions');
  });

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

  it('does not inject active Router guidance into ordinary Meka tasks', async () => {
    const opts = baseOpts({ userPrompt: 'USER PROMPT' });
    const materialize = vi.fn(async () => null);
    const prepareRuntimeMcp = vi.fn((entries: readonly MekaRoleMcpEntry[]) => ({
      providerIds: entries
        .filter(
          (entry): entry is Extract<typeof entry, { providerId: string }> => 'providerId' in entry,
        )
        .map((entry) => entry.providerId),
      inlineConfigs: [],
    }));

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime({ skills: [], mcp: [] })),
      resolvePlatformSkills: vi.fn(async () => [platformSkill()]),
      prepareRuntimeMcp,
      materializeSkillSnapshot: materialize,
    });

    expect(result).toMatchObject({
      didApply: true,
      mcpProviderIds: ['mcp-router'],
      skillsCount: 1,
      platformSkillsCount: 1,
    });
    expect(prepareRuntimeMcp).toHaveBeenCalledWith([
      { id: 'mcp-router', providerId: 'mcp-router', enabled: true },
    ]);
    expect(materialize).toHaveBeenCalledWith(opts.id, [platformSkill()]);
    expect(opts.userPrompt).not.toContain('[MEKA_PLATFORM_CAPABILITIES]');
    expect(opts.userPrompt).not.toContain('mcp_router.list_remote_directory');
  });

  it('does not inject the combat startup gate prompt for a combat role', async () => {
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
    expect(environmentServices.p4.get).not.toHaveBeenCalled();
    expect(environmentServices.router.listInstances).not.toHaveBeenCalled();
    expect(opts.userPrompt).not.toContain('[SAGA2_COMBAT_ENVIRONMENT_GATE]');
    expect(opts.userPrompt).not.toContain('# SAGA2 战斗开发');
    expect(opts.vendorOptions).not.toHaveProperty('mekaCombatEnvironmentReady');
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

  it('does not run an aggregate combat environment gate at session startup', async () => {
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

    expect(environmentServices.p4.get).not.toHaveBeenCalled();
    expect(environmentServices.router.listInstances).not.toHaveBeenCalled();
    expect(opts.userPrompt).not.toContain('[SAGA2_COMBAT_ENVIRONMENT_GATE]');
    expect(opts.vendorOptions).toMatchObject({
      codexNativeSubagentsDisabled: true,
    });
    expect(opts.vendorOptions).not.toHaveProperty('mekaCombatEnvironmentReady');
  });

  it('injects the frozen combat controller Skill body into new and resumed combat tasks', async () => {
    const skillBody = '# Combat Controller\n\nSTATUS_THEN_TARGET_EXPORT';
    const snapshot = {
      revision: 'e'.repeat(64),
      pluginPath: 'C:/CindyMeka/meka-skill-snapshots/revisions/e/claude-plugin',
      files: [
        {
          relativePath: 'skills/combat-skill-configuration/SKILL.md',
          contentBase64: Buffer.from(skillBody).toString('base64'),
          digest: '5'.repeat(64),
        },
      ],
    };
    const materializeSkillSnapshot = vi.fn(async () => snapshot);
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      userPrompt: '技能 ID：1021，请生成。',
    });

    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () =>
        runtime({
          roleId: 'combat-development',
          roleDisplayName: '战斗开发',
          workflow: 'saga2-combat-development-v1',
        }),
      ),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      materializeSkillSnapshot,
    });

    expect(opts.userPrompt).toContain('[SAGA2_COMBAT_CONTROLLER_SKILL]');
    expect(opts.userPrompt).toContain('STATUS_THEN_TARGET_EXPORT');
    expect(opts.userPrompt).toContain('不要再读取、枚举或发现任何 SKILL.md');

    const resumed = baseOpts({
      userPrompt: '继续。',
      vendorOptions: {
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatTargetSkillId: '1021',
        mekaCombatTargetSkillIdState: 'confirmed',
      },
    });
    await applyMekaRuntimeConfig(resumed, { materializeSkillSnapshot });

    expect(resumed.userPrompt).toContain('[SAGA2_COMBAT_CONTROLLER_SKILL]');
    expect(resumed.userPrompt).toContain('STATUS_THEN_TARGET_EXPORT');
    expect((resumed.userPrompt ?? '').match(/\[SAGA2_COMBAT_CONTROLLER_SKILL\]/g)?.length).toBe(1);
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
    const resolvePlatformSkills = vi.fn(async () => [platformSkill()]);
    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () =>
        runtime({
          roleId: 'combat-development',
          roleDisplayName: '战斗开发',
          workflow: 'saga2-combat-development-v1',
        }),
      ),
      resolvePlatformSkills,
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
    expect(resolvePlatformSkills).not.toHaveBeenCalled();
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
    expect(opts.userPrompt).toContain('targetSkillId（与 Lead 绑定值一致的正整数）');
    expect(opts.userPrompt).toContain('唯一一次完整终态回复');
    expect(opts.userPrompt).toContain('不要搜索或重试 orca_worker_bridge');
    expect(opts.userPrompt).toContain('Orca 会把终态回复自动桥接给 Lead');
    expect(opts.userPrompt).toContain('git grep -l -E <精确符号表达式> HEAD -- internal/battle');
    expect(opts.userPrompt).toContain('git grep -n -C 24 -E <精确符号表达式> HEAD -- <path>');
    expect(opts.userPrompt).toContain('所有 `git grep` 都必须显式写 `HEAD`');
    expect(opts.userPrompt).toContain('不要用 `git show` 打开大型实现文件');
    expect(opts.userPrompt).toContain('[SAGA2_MODULE_FIRST]');
    expect(opts.userPrompt).toContain('只核查其中依赖当前服务器解释的窄语义');
    expect(opts.userPrompt).toContain('没有完整专用函数不等于模块组合不支持');
    expect(opts.userPrompt).not.toContain('battle-designer-server-development');
    expect(opts.userPrompt).not.toContain(
      'SAGA2 server code lives behind MCPRouter as saga2-server.',
    );
    expect(opts.userPrompt).not.toContain('[MEKA_ROLE_CONTEXT]');
    expect(opts.userPrompt).not.toContain('[MEKA_PLATFORM_CAPABILITIES]');
  });

  it('arms autonomous execution only for the local combat role', async () => {
    const resolveCombatServerTarget = vi.fn(async () => ({
      remoteHostId: 'mcpr:server-1',
      workerAgent: 'claude-code' as const,
    }));
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      userPrompt: '技能 ID：1019。检查当前伤害目标。',
    });
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
      resolveCombatServerTarget,
    });
    expect(opts.vendorOptions).toMatchObject({
      mekaCombatExecutionMode: 'autonomous-user-request',
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatServerRemoteHostId: 'mcpr:server-1',
      mekaCombatServerWorkerAgent: 'claude-code',
    });
    expect(resolveCombatServerTarget).toHaveBeenCalledWith('saga2');
    expect(opts.userPrompt).toContain('[SAGA2_COMBAT_EXECUTION_AUTHORIZATION]');
    expect(opts.userPrompt).toContain('[SAGA2_COMBAT_TARGET]');
    expect(opts.userPrompt).toContain('targetSkillId: 1019');
    expect(opts.userPrompt).toContain('[SAGA2_PROJECT_PATHS]');
    expect(opts.userPrompt).toContain('projectRoot: C:\\Workspace\\saga2\\saga2_project');
    expect(opts.userPrompt).toContain(
      'unityClientRoot: C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
    );
    expect(opts.userPrompt).toContain(`legacyModuleJsonTempRoot: ${os.tmpdir()}`);
    expect(opts.userPrompt).toContain(
      'unityAgentsPath: C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\AGENTS.md',
    );
    expect(opts.userPrompt).toContain(
      'legacyModuleProtocolCodecPath: C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\Assets\\Editor\\SkillEditor\\Common\\Editor\\Exporter\\Execute\\Impl\\Type\\SkillModuleProtocolCodec.cs',
    );
    expect(opts.userPrompt).toContain('[SAGA2_COMBAT_SERVER_TARGET]');
    expect(opts.userPrompt).toContain('serverRemoteHostId: mcpr:server-1');
    expect(opts.userPrompt).toContain('serverWorkerAgent: claude-code');
    expect(opts.userPrompt).toContain('create_worker 的 remote_host_id 和 agent 必须分别原样使用');
  });

  it('updates the confirmed combat skill ID from a resumed user message', async () => {
    const opts = baseOpts({
      userPrompt: '现在检查技能 ID 1020。',
      vendorOptions: {
        source: 'meka',
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatTargetSkillId: '1019',
      },
    });

    await applyMekaRuntimeConfig(opts, {
      materializeSkillSnapshot: vi.fn(async () => null),
    });

    expect(opts.vendorOptions).toMatchObject({
      mekaCombatTargetSkillId: '1020',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatServerCapabilityStatus: 'unchecked',
    });
    expect(opts.userPrompt).toContain('targetSkillId: 1020');
    expect(opts.userPrompt).toContain(
      'unityClientRoot: C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
    );
  });

  it('invalidates server evidence when a resumed combat task changes skill ID', async () => {
    const opts = baseOpts({
      userPrompt: '改为检查技能 ID 1020。',
      vendorOptions: {
        source: 'meka',
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatExecutionMode: 'autonomous-user-request',
        mekaCombatTargetSkillId: '1019',
        mekaCombatTargetSkillIdState: 'confirmed',
        mekaCombatServerCapabilityStatus: 'supported',
        mekaCombatPlanApproved: true,
        mekaCombatTargetExportCompleted: true,
      },
    });

    await applyMekaRuntimeConfig(opts, {
      materializeSkillSnapshot: vi.fn(async () => null),
    });

    expect(opts.vendorOptions).toMatchObject({
      mekaCombatTargetSkillId: '1020',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatPlanApproved: false,
    });
    expect(opts.vendorOptions?.mekaCombatTargetExportCompleted).toBeUndefined();
  });

  it('restores autonomous execution when resuming an already-resolved combat session', async () => {
    const opts = baseOpts({
      userPrompt: 'RESUMED USER PROMPT',
      vendorOptions: {
        source: 'meka',
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
      },
    });

    await applyMekaRuntimeConfig(opts, {
      materializeSkillSnapshot: vi.fn(async () => null),
    });
    await applyMekaRuntimeConfig(opts, {
      materializeSkillSnapshot: vi.fn(async () => null),
    });

    expect(opts.vendorOptions).toMatchObject({
      mekaRuntimeResolved: true,
      mekaWorkflow: 'saga2-combat-development-v1',
      mekaCombatExecutionMode: 'autonomous-user-request',
    });
    expect(
      (opts.userPrompt ?? '').match(/\[SAGA2_COMBAT_EXECUTION_AUTHORIZATION\]/g)?.length ?? 0,
    ).toBe(1);
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
    const resolvePlatformSkills = vi.fn(async () => [platformSkill()]);

    const first = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      prepareRuntimeMcp,
      materializeSkillSnapshot,
      resolvePlatformSkills,
    });
    const promptAfterFirstBootstrap = opts.userPrompt;
    const second = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      prepareRuntimeMcp,
      materializeSkillSnapshot,
      resolvePlatformSkills,
    });

    expect(first.didApply).toBe(true);
    expect(second.didApply).toBe(false);
    expect(resolveRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(prepareRuntimeMcp).toHaveBeenCalledTimes(1);
    expect(materializeSkillSnapshot).toHaveBeenCalledTimes(2);
    expect(opts.userPrompt).toBe(promptAfterFirstBootstrap);
    expect(opts.userPrompt).not.toContain('[MEKA_PLATFORM_CAPABILITIES]');
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
