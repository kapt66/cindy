import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const services = vi.hoisted(() => ({
  p4: { get: vi.fn() },
  router: {
    listInstances: vi.fn(),
    listProjectBindings: vi.fn(),
    listProjectTools: vi.fn(),
  },
}));

vi.mock('../../meka-settings/ipc.js', () => ({
  getMekaP4SettingsService: () => services.p4,
  getMekaRouterService: () => services.router,
}));

vi.mock('../combatEnvironmentGate.js', () => ({
  runCombatEnvironmentGate: vi.fn(),
  combatEnvironmentAvailability: (gate: Record<string, unknown>) => ({
    p4: gate.p4,
    unityCli: gate.unityCli,
    mcpr: gate.mcpr,
  }),
}));

vi.mock('../../maker-host/mcpr-codex-capability.js', () => ({
  probeRemoteCodexCapability: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../maker-host/mcpr-claude-capability.js', () => ({
  probeRemoteClaudeCapability: vi.fn(async () => ({ ok: true })),
}));

import { runCombatEnvironmentGate } from '../combatEnvironmentGate.js';
import {
  evaluateCombatShellCommandExecution,
  evaluateCombatToolExecution,
  evaluateCombatPlanReview,
  invalidateCombatTargetBinding,
  isCombatWorkflowPolicyActive,
  markCombatTargetExportAttempted,
  markCombatTargetExportCompleted,
  markCombatPlanApproved,
  refreshCombatTargetBinding,
  resetCombatTargetExportStateForTests,
} from '../combatWorkflowPolicy.js';
import {
  recordCombatServerCapabilityAutoBridge,
  resetCombatServerCapabilityStateForTests,
  settleCombatServerCapabilityDispatch,
} from '../combatServerCapabilityState.js';

function vendor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'meka',
    mekaProjectId: 'saga2',
    mekaRoleId: 'combat-development',
    mekaWorkflow: 'saga2-combat-development-v1',
    mekaCombatEnvironmentReady: true,
    mekaCombatEnvironmentChecks: {
      p4: { status: 'ready', summary: 'P4 ready' },
      unityCli: { status: 'ready', summary: 'Unity CLI ready' },
      mcpr: { status: 'ready', summary: 'MCPRouter ready' },
    },
    mekaCombatPlanApproved: false,
    mekaCombatPhase: 'exploration',
    mekaCombatServerCapabilityStatus: 'supported',
    mekaCombatTargetSkillId: '123',
    mekaCombatTargetSkillIdState: 'confirmed',
    mekaCombatTargetExportCompleted: true,
    mekaCombatServerRemoteHostId: 'mcpr:server-1',
    mekaCombatServerWorkerAgent: 'codex',
    ...overrides,
  };
}

function context(vendorOptions: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    agentKind: 'codex' as const,
    sessionId: 'session-1',
    workingDir: 'C:\\Workspace\\saga2\\saga2_project',
    vendorOptions,
    toolName: 'Read',
    input: {},
    action: { kind: 'read' as const },
    ...overrides,
  };
}

beforeEach(() => {
  resetCombatTargetExportStateForTests();
  vi.resetAllMocks();
  resetCombatServerCapabilityStateForTests();
  services.p4.get.mockResolvedValue({ p4RootPath: 'C:\\Workspace\\saga2\\saga2_project' });
  services.router.listProjectTools.mockResolvedValue([]);
  services.router.listProjectBindings.mockResolvedValue(['server-1']);
  services.router.listInstances.mockResolvedValue([
    {
      id: 'server-1',
      projectName: 'saga2-server',
      projectDescription: 'SAGA2 server',
      agentType: 'codex',
      available: true,
    },
  ]);
});

describe('combat workflow host policy', () => {
  it('applies the target-first combat contract to Codex Shell before execution', () => {
    const missing = vendor({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: undefined,
    });
    expect(
      evaluateCombatShellCommandExecution(
        context(missing, {
          toolName: 'exec',
          action: { kind: 'exec', command: 'rg -n damage Assets' },
        }),
      ),
    ).toMatchObject({ behavior: 'deny', reason: expect.stringContaining('缺少用户明确提供') });

    const ready = vendor({ mekaCombatTargetSkillId: '1020' });
    for (const command of [
      "Get-Content -Raw 'C:\\Workspace\\saga2\\saga2_project\\AGENTS.md'",
      "rg --files -g 'AGENTS.md' 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity'",
      "rg -n -g '*.cs' 'BattleRoleSkill' 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\Assets'",
      "rg -n 'ModuleV2SemanticKind' 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\Assets\\Editor\\SkillEditor\\Module'",
    ]) {
      expect(
        evaluateCombatShellCommandExecution(
          context(ready, { toolName: 'exec', action: { kind: 'exec', command } }),
        ),
      ).toMatchObject({ behavior: 'deny' });
    }
    expect(
      evaluateCombatShellCommandExecution(
        context(ready, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command:
              "Get-Content -Raw 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\AGENTS.md'",
          },
        }),
      ),
    ).toEqual({ behavior: 'allow' });
    expect(
      evaluateCombatShellCommandExecution(
        context(ready, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command:
              '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-Content -LiteralPath \'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\AGENTS.md\'"',
          },
        }),
      ),
    ).toEqual({ behavior: 'allow' });
    expect(
      evaluateCombatShellCommandExecution(
        context(ready, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command:
              "Get-Content -LiteralPath 'C:\\\\Workspace\\\\saga2\\\\saga2_project\\\\saga2_unity\\\\AGENTS.md'",
          },
        }),
      ),
    ).toEqual({ behavior: 'allow' });
    expect(
      evaluateCombatShellCommandExecution(
        context(ready, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command:
              "Get-Content -LiteralPath 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\Assets\\Editor\\SkillEditor\\Common\\Editor\\Exporter\\Execute\\Impl\\Type\\SkillModuleProtocolCodec.cs'",
          },
        }),
      ),
    ).toEqual({ behavior: 'allow' });
    expect(
      evaluateCombatShellCommandExecution(
        context(ready, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command:
              '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-Content -LiteralPath \'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\Assets\\Editor\\SkillEditor\\Common\\Editor\\Exporter\\Execute\\Impl\\Type\\SkillModuleProtocolCodec.cs\' -Raw"',
          },
        }),
      ),
    ).toEqual({ behavior: 'allow' });
    expect(
      evaluateCombatShellCommandExecution(
        context(ready, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command:
              '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-Content -LiteralPath \'C:\\\\Workspace\\\\saga2\\\\saga2_project\\\\saga2_unity\\\\Assets\\\\Editor\\\\SkillEditor\\\\Common\\\\Editor\\\\Exporter\\\\Execute\\\\Impl\\\\Type\\\\SkillModuleProtocolCodec.cs\'"',
          },
        }),
      ),
    ).toEqual({ behavior: 'allow' });
    for (const wrongPathCommand of [
      "Get-Content -LiteralPath 'C:\\Workspace\\saga2\\saga2_unity\\AGENTS.md'",
      "Get-Content -LiteralPath 'C:\\Workspace\\saga2\\saga2_unity\\Assets\\Editor\\SkillEditor\\Common\\Editor\\Exporter\\Execute\\Impl\\Type\\SkillModuleProtocolCodec.cs'",
    ]) {
      expect(
        evaluateCombatShellCommandExecution(
          context(ready, {
            toolName: 'exec',
            action: { kind: 'exec', command: wrongPathCommand },
          }),
        ),
      ).toMatchObject({
        behavior: 'deny',
        reason: expect.stringContaining('C:\\Workspace\\saga2\\saga2_project\\saga2_unity'),
      });
    }
  });

  it('does not mistake a Codex Code Mode tool container for its nested Shell command', () => {
    const container =
      'const r = await tools.shell_command({command:"Get-Content -Raw \'C:\\\\snapshot\\\\SKILL.md\'",' +
      'workdir:"C:\\\\Workspace\\\\saga2"}); text(r)';
    expect(
      evaluateCombatShellCommandExecution(
        context(vendor({ mekaCombatTargetExportCompleted: undefined }), {
          toolName: 'exec',
          action: { kind: 'exec', command: container },
        }),
      ),
    ).toEqual({ behavior: 'allow' });
    expect(
      evaluateCombatShellCommandExecution(
        context(
          vendor({
            mekaCombatTargetSkillId: undefined,
            mekaCombatTargetSkillIdState: undefined,
            mekaCombatTargetExportCompleted: undefined,
          }),
          {
            toolName: 'exec',
            action: { kind: 'exec', command: container },
          },
        ),
      ),
    ).toMatchObject({ behavior: 'deny', reason: expect.stringContaining('缺少用户明确提供') });
  });

  it('blocks project access until the user provides one positive skill ID', async () => {
    const missing = vendor({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: undefined,
    });
    await expect(
      evaluateCombatToolExecution(
        context(missing, {
          action: { kind: 'read', path: 'Assets/Editor/SkillEditor/Module.cs' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('缺少用户明确提供的正整数技能 ID'),
    });

    const ambiguous = vendor({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'ambiguous',
    });
    await expect(evaluateCombatToolExecution(context(ambiguous))).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('多个技能 ID'),
    });
  });

  it('blocks evidence and legacy module calls that do not match the confirmed skill ID', async () => {
    const options = vendor({ mekaCombatTargetSkillId: '1019' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          action: {
            kind: 'exec',
            command:
              "Get-Content -Raw '.\\Assets\\Editor\\SkillEditor\\Skill\\Exportd Data\\Server\\skill_entry_model_1010_static.json'",
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('显式引用了 1010'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__meka-unity__unity_execute',
          input: {
            action: 'command',
            arguments: ['legacy_module_export_json', '--skill_id', '1010'],
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__meka-unity__unity_execute',
          input: { action: 'command', arguments: ['legacy_module_export_json'] },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('必须显式传入本轮技能 ID 1019'),
    });
  });

  it('enforces target-first legacy export and rejects redundant discovery or V2 evidence', async () => {
    const options = vendor({
      mekaCombatTargetSkillId: '1020',
      mekaCombatTargetExportCompleted: undefined,
      mekaCombatServerCapabilityStatus: 'unchecked',
    });
    const evaluateMcp = (toolName: string, input: Record<string, unknown> = {}) =>
      evaluateCombatToolExecution(
        context(options, {
          sessionId: 'target-first-evidence',
          toolName,
          input,
          action: { kind: 'mcp' as const },
        }),
      );

    await expect(evaluateMcp('mcp:cindy_orca:get_workspace_info')).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('get_workspace_info'),
    });
    await expect(
      evaluateMcp('mcp:cindy:ghost_info', { ghost_id: 'meka-unity' }),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('ghost_info'),
    });
    await expect(evaluateMcp('mcp:mcp_router:list_tools')).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('list_tools'),
    });
    await expect(
      evaluateMcp('mcp__cindy__ghost_call', {
        ghost_id: 'meka-unity',
        tool: 'list_tools',
        args: {},
      }),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('没有战斗流程可用的动态 list_tools'),
    });
    await expect(evaluateMcp('mcp:mcp_router:check_combat_environment')).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止立即重复'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          sessionId: 'target-first-evidence',
          action: {
            kind: 'read',
            path: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\AGENTS.md',
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('第一条项目内容证据'),
    });
    await expect(
      evaluateMcp('mcp__cindy__ghost_call', {
        ghost_id: 'meka-unity',
        tool: 'unity_inspect',
        args: {
          action: 'status',
          projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
        },
      }),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateMcp('mcp__cindy__ghost_call', {
        ghost_id: 'meka-unity',
        tool: 'unity_execute',
        args: {
          action: 'command',
          arguments: [
            'legacy_module_export_json',
            '1020',
            path.join(os.tmpdir(), 'saga2-skill-1020-target.json'),
          ],
        },
      }),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('不得省略 projectPath'),
    });
    expect(options.mekaCombatTargetExportCompleted).toBeUndefined();
    await expect(
      evaluateMcp('mcp__cindy__ghost_call', {
        ghost_id: 'meka-unity',
        tool: 'unity_execute',
        args: {
          action: 'command',
          projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
          arguments: [
            'legacy_module_export_json',
            '1020',
            path.join(os.tmpdir(), 'saga2-skill-1020-target.json'),
          ],
        },
      }),
    ).resolves.toEqual({ behavior: 'allow' });
    expect(options.mekaCombatTargetExportCompleted).toBeUndefined();
    markCombatTargetExportCompleted(
      context(options, {
        sessionId: 'target-first-evidence',
        toolName: 'mcp__cindy__ghost_call',
        input: {
          ghost_id: 'meka-unity',
          tool: 'unity_execute',
          args: {
            action: 'command',
            projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
            arguments: [
              'legacy_module_export_json',
              '1020',
              path.join(os.tmpdir(), 'saga2-skill-1020-target.json'),
            ],
          },
        },
        action: { kind: 'mcp' },
      }),
    );
    expect(options.mekaCombatTargetExportCompleted).toBe(true);

    const separateShellOptions = vendor({
      mekaCombatTargetSkillId: '1020',
      mekaCombatTargetExportCompleted: undefined,
    });
    expect(
      evaluateCombatShellCommandExecution(
        context(separateShellOptions, {
          sessionId: 'target-first-evidence',
          action: {
            kind: 'exec',
            command: "Get-Content 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\AGENTS.md'",
            cwd: 'C:\\Workspace\\saga2\\saga2_project',
          },
        }),
      ),
    ).toEqual({ behavior: 'allow' });
    expect(
      evaluateCombatShellCommandExecution(
        context(
          vendor({
            mekaCombatTargetSkillId: '1022',
            mekaCombatTargetExportCompleted: undefined,
          }),
          {
            sessionId: 'target-first-evidence',
            action: {
              kind: 'exec',
              command: "Get-Content 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\AGENTS.md'",
              cwd: 'C:\\Workspace\\saga2\\saga2_project',
            },
          },
        ),
      ),
    ).toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('第一条项目内容证据'),
    });

    await expect(
      evaluateCombatToolExecution(
        context(options, {
          sessionId: 'target-first-evidence',
          action: {
            kind: 'exec',
            command: 'rg --files -g AGENTS.md .',
            cwd: 'C:\\Workspace\\saga2\\saga2_project',
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止枚举或读取工作区根 AGENTS.md'),
    });
    for (const blockedPath of [
      'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\Assets\\Editor\\SkillEditor\\ModuleV2\\COMPONENT_CATALOG.md',
      'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\Assets\\Editor\\SkillEditor\\Skill\\Exportd Data\\Server\\skill_entry_model_editor.json',
    ]) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            sessionId: 'target-first-evidence',
            action: { kind: 'read', path: blockedPath },
          }),
        ),
      ).resolves.toMatchObject({
        behavior: 'deny',
        reason: expect.stringContaining('完全不使用 ModuleV2'),
      });
    }
  });

  it('keeps a failed target export as evidence and permits only the known follow-up reads', async () => {
    const options = vendor({
      mekaCombatTargetSkillId: '1021',
      mekaCombatTargetExportAttempted: undefined,
      mekaCombatTargetExportCompleted: undefined,
      mekaCombatServerCapabilityStatus: 'supported',
    });
    const base = context(options, {
      sessionId: 'failed-target-export',
      toolName: 'mcp__cindy__ghost_call',
      input: {
        ghost_id: 'meka-unity',
        tool: 'unity_execute',
        args: {
          action: 'command',
          projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
          arguments: ['legacy_module_export_json', '1021', path.join(os.tmpdir(), '1021.json')],
        },
      },
      action: { kind: 'mcp' as const },
    });
    markCombatTargetExportAttempted(base);
    expect(options.mekaCombatTargetExportAttempted).toBe(true);
    expect(
      evaluateCombatShellCommandExecution(
        context(options, {
          sessionId: 'failed-target-export',
          action: {
            kind: 'exec',
            command:
              "Get-Content -LiteralPath 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\AGENTS.md'",
            cwd: 'C:\\Workspace\\saga2\\saga2_project',
          },
        }),
      ),
    ).toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          sessionId: 'failed-target-export',
          action: {
            kind: 'exec',
            command:
              "rg -n -g '*.cs' 'BattleRoleSkill' 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\Assets'",
          },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('invalidates in-memory export evidence when a session switches back to an older skill', () => {
    const sessionId = 'target-generation-switch';
    refreshCombatTargetBinding(sessionId, '1019');
    const first = vendor({ mekaCombatTargetSkillId: '1019' });
    markCombatTargetExportCompleted(
      context(first, {
        sessionId,
        toolName: 'mcp__meka-unity__unity_execute',
        input: {
          action: 'command',
          projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
          arguments: ['legacy_module_export_json', '1019', path.join(os.tmpdir(), '1019.json')],
        },
      }),
    );
    invalidateCombatTargetBinding(sessionId);
    refreshCombatTargetBinding(sessionId, '1019');
    const current = vendor({
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetExportCompleted: undefined,
    });
    expect(
      evaluateCombatShellCommandExecution(
        context(current, {
          sessionId,
          action: {
            kind: 'exec',
            command: "Get-Content 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\AGENTS.md'",
          },
        }),
      ),
    ).toMatchObject({ behavior: 'deny' });
  });

  it('applies target ID and JSON path checks to the public cindy ghost_call shape', async () => {
    const options = vendor({
      mekaCombatTargetSkillId: '1019',
      mekaCombatExecutionMode: 'autonomous-user-request',
    });
    const ghostCall = (arguments_: string[]) =>
      context(options, {
        toolName: 'mcp__cindy__ghost_call',
        input: {
          ghost_id: 'meka-unity',
          tool: 'unity_execute',
          args: {
            action: 'command',
            projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
            arguments: arguments_,
          },
        },
        action: { kind: 'mcp' as const },
      });

    await expect(
      evaluateCombatToolExecution(
        ghostCall(['legacy_module_export_json', '1010', path.join(os.tmpdir(), '1010.json')]),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('显式引用了 1010'),
    });
    await expect(
      evaluateCombatToolExecution(
        ghostCall([
          'legacy_module_export_json',
          '1010',
          path.join(os.tmpdir(), 'reference-1010.json'),
        ]),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('显式引用了 1010'),
    });
    await expect(
      evaluateCombatToolExecution(
        ghostCall([
          'legacy_module_export_json',
          '1011',
          path.join(os.tmpdir(), 'reference-1011.json'),
        ]),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('显式引用了 1011'),
    });
    await expect(
      evaluateCombatToolExecution(
        ghostCall([
          'legacy_module_import_json',
          '1010',
          path.join(os.tmpdir(), 'reference-1010.json'),
        ]),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
    await expect(
      evaluateCombatToolExecution(ghostCall(['legacy_module_export_json', '1019'])),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('必须使用绝对 .json 路径'),
    });
    await expect(
      evaluateCombatToolExecution(
        ghostCall([
          'legacy_module_import_json',
          '1019',
          'C:\\Workspace\\saga2\\saga2_project\\saga2_json\\1019.import.json',
          'true',
        ]),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('JSON 路径超出授权范围'),
    });
  });

  it('rejects a secondary reference ID in a server evidence task', async () => {
    const options = vendor({
      mekaCombatTargetSkillId: '1019',
      mekaCombatReferenceSkillId: '1010',
    });
    const task = [
      '[SAGA2_SERVER_EXPLORATION_READ_ONLY]',
      '[SAGA2_MODULE_FIRST]',
      '[SAGA2_REFERENCE_SKILL_ID: 1010]',
      '目标技能 ID: 1019',
      'saga2-entry-model 原子能力矩阵，剩余服务器缺口',
    ].join('\n');
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__create_worker',
          input: {
            role: 'server-capability-reviewer',
            agent: 'codex',
            label: 'target-with-reference',
            remote_host_id: 'mcpr:server-1',
            initial_task: task,
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('显式引用了 1010'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__create_worker',
          input: {
            role: 'server-capability-reviewer',
            agent: 'codex',
            label: 'target-as-reference',
            remote_host_id: 'mcpr:server-1',
            initial_task: task.replace('1010', '1019'),
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('移除参考技能 marker'),
    });
  });

  it('limits legacy module JSON files to OS temp or saga2_unity', async () => {
    const options = vendor({
      mekaCombatTargetSkillId: '1019',
      mekaCombatPlanApproved: true,
      mekaCombatPhase: 'execution',
    });
    for (const blockedPath of [
      'C:\\Workspace\\saga2\\saga2_project\\saga2_json\\1019.import.json',
      'C:\\Workspace\\saga2\\saga2_design\\planning\\1019.export.json',
      '1019.import.json',
    ]) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            toolName: 'mcp__meka-unity__unity_execute',
            input: {
              action: 'command',
              projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
              arguments: ['legacy_module_import_json', '1019', blockedPath, 'true'],
            },
            action: { kind: 'mcp' },
          }),
        ),
      ).resolves.toMatchObject({
        behavior: 'deny',
        reason: expect.stringMatching(/绝对 \.json 路径|超出授权范围/),
      });
    }

    vi.mocked(runCombatEnvironmentGate).mockResolvedValue({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    for (const allowedPath of [
      path.join(os.tmpdir(), '1019.import.json'),
      'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\Temp\\1019.export.json',
    ]) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            toolName: 'mcp__meka-unity__unity_execute',
            input: {
              action: 'command',
              projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
              arguments: ['legacy_module_import_json', '1019', allowedPath, 'true'],
            },
            action: { kind: 'mcp' },
          }),
        ),
      ).resolves.toEqual({ behavior: 'allow' });
    }
  });

  it('allows module evidence export but blocks implementation until the server report is validated', async () => {
    const options = vendor({
      mekaCombatTargetSkillId: '1019',
      mekaCombatExecutionMode: 'autonomous-user-request',
      mekaCombatServerCapabilityStatus: 'unchecked',
    });
    const unityCall = (command: string) =>
      context(options, {
        sessionId: 'unchecked-server-gate',
        toolName: 'mcp__cindy__ghost_call',
        input: {
          ghost_id: 'meka-unity',
          tool: 'unity_execute',
          args: {
            action: 'command',
            projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
            arguments: [command, '1019', path.join(os.tmpdir(), 'skill-1019.json')],
          },
        },
        action: { kind: 'mcp' as const },
      });

    await expect(
      evaluateCombatToolExecution(unityCall('legacy_module_export_json')),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(unityCall('legacy_module_import_json')),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('服务器 supported 回执'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          sessionId: 'unchecked-server-gate',
          toolName: 'mcp__cindy__ghost_call',
          input: {
            ghost_id: 'meka-p4',
            tool: 'p4_checkout',
            args: { files: ['C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\1019.asset'] },
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止 P4 写入'),
    });

    const plan = `[SAGA2_COMBAT_SOLUTION]\ntargetSkillId: 1019\nchangeMode: incremental\nsurfaces: module\nmoduleEvidence: saga2-entry-model 101901 -> 101902\ncapabilityMatrix: 原子能力逐项已映射\nevidence: 当前技能导出和客户端消费者\nvalidation: 老版导出逐字段回读\nremainingUnknowns: none\n[/SAGA2_COMBAT_SOLUTION]`;
    expect(evaluateCombatPlanReview({ vendorOptions: options, plan })).toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('当前远端 HEAD'),
    });
  });

  it('bounds local lead evidence reads and releases the limit for execution validation', async () => {
    const options = vendor({ mekaCombatPhase: 'exploration' });
    for (let index = 0; index < 8; index += 1) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            sessionId: 'lead-evidence-budget',
            action: { kind: 'read', path: `skill-${index}.json` },
          }),
        ),
      ).resolves.toEqual({ behavior: 'allow' });
    }
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          sessionId: 'lead-evidence-budget',
          action: { kind: 'read', path: 'skill-repeat.json' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('最多 8 次只读证据调用'),
    });

    const executionOptions = vendor({ mekaCombatPhase: 'execution' });
    await expect(
      evaluateCombatToolExecution(
        context(executionOptions, {
          sessionId: 'lead-evidence-budget',
          action: { kind: 'read', path: 'skill-final-export.json' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
  });

  it('fails closed for the SAGA2 combat role when the workflow field is missing', () => {
    expect(isCombatWorkflowPolicyActive({ vendorOptions: vendor() })).toBe(true);
    expect(
      isCombatWorkflowPolicyActive({
        vendorOptions: vendor({ mekaWorkflow: undefined }),
      }),
    ).toBe(true);
    expect(
      isCombatWorkflowPolicyActive({
        vendorOptions: vendor({ mekaRoleId: 'general-development', mekaWorkflow: undefined }),
      }),
    ).toBe(false);
    expect(
      isCombatWorkflowPolicyActive({
        vendorOptions: vendor({
          mekaWorkflow: undefined,
          mekaRoleDisplayName: '通用开发',
        }),
      }),
    ).toBe(true);
  });

  it('allows independent reads but rejects redundant discovery when workflow metadata is recovered', async () => {
    const options = vendor({
      mekaWorkflow: undefined,
      mekaCombatEnvironmentReady: true,
    });
    delete options.mekaCombatEnvironmentChecks;
    await expect(evaluateCombatToolExecution(context(options))).resolves.toEqual({
      behavior: 'allow',
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Read',
          action: { kind: 'read', path: 'C:\\snapshot\\remote-operations\\SKILL.md' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__mcp_router__check_combat_environment',
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止立即重复'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp:mcp_router',
          input: { serverName: 'mcp_router', toolName: 'list_tools', toolParams: {} },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny', reason: expect.stringContaining('list_tools') });
  });

  it('only blocks a tool whose own dependency is unavailable', async () => {
    const options = vendor({
      mekaCombatEnvironmentReady: false,
      mekaCombatEnvironmentChecks: {
        p4: { status: 'ready', summary: 'P4 ready' },
        unityCli: {
          status: 'blocked',
          summary: 'Unity CLI 未连接目标工程',
          nextAction: '调用 unity_inspect status 检查目标工程',
        },
        mcpr: { status: 'ready', summary: 'MCPRouter ready' },
      },
    });
    await expect(evaluateCombatToolExecution(context(options))).resolves.toEqual({
      behavior: 'allow',
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Bash',
          input: { command: 'p4 -ztag info' },
          action: { kind: 'exec', command: 'p4 -ztag info' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__meka-unity__unity_inspect',
          input: {
            action: 'status',
            projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('只阻止本次调用'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__meka-unity__unity_inspect',
          input: {
            action: 'status',
            projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      reason: expect.stringContaining('调用 unity_inspect status 检查目标工程'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__mcp_router__check_combat_environment',
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp:mcp_router',
          input: { serverName: 'mcp_router', toolName: 'list_tools', toolParams: {} },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny', reason: expect.stringContaining('list_tools') });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp:mcp_router',
          input: {
            serverName: 'mcp_router',
            toolName: 'call_tool',
            toolParams: { name: 'mcp_list_instances', args: {} },
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp:mcp_router',
          input: {
            serverName: 'mcp_router',
            toolName: 'call_tool',
            toolParams: { name: 'mcp_create_key', args: { type: 'client' } },
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          remoteHostId: 'mcpr:server-1',
          action: {
            kind: 'exec',
            command: "/bin/sh -c 'git grep -n -E damage -- internal/battle | head'",
          },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
    await expect(
      evaluateCombatToolExecution(
        context(vendor({ mekaCombatPlanApproved: true }), {
          toolName: 'mcp__cindy_orca__create_workers',
          input: {
            workers: [
              {
                role: 'server-capability-reviewer',
                agent: 'codex',
                label: 'server-batch',
                remote_host_id: 'mcpr:server-1',
                initial_task:
                  '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capabilities residual server gap: inspect server',
              },
            ],
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止用 create_workers'),
    });
  });

  it('includes the dependency reason and recovery action without blocking other paths', async () => {
    const options = vendor({
      mekaCombatEnvironmentReady: false,
      mekaCombatEnvironmentChecks: {
        p4: {
          status: 'blocked',
          summary: 'P4 客户端映射不可用',
          nextAction: '修复 P4CLIENT 和工作区映射',
        },
        unityCli: { status: 'ready', summary: 'unityCli ready' },
        mcpr: {
          status: 'blocked',
          summary: '远端 Runtime 版本不匹配',
          nextAction: '升级并重启远端 Runtime',
        },
      },
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__meka-unity__unity_inspect',
          input: {
            action: 'status',
            projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Write',
          action: { kind: 'file-write', path: 'x.ts' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('修复 P4CLIENT 和工作区映射'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__mcp_router__diagnose_mcp_router_connection',
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__mcp_router__call_tool',
          input: { name: 'read_server_status', args: {} },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('升级并重启远端 Runtime'),
    });
    options.mekaCombatPlanApproved = true;
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Bash',
          action: { kind: 'exec', command: 'pnpm test' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
  });

  it('allows read-only exploration but blocks mutation before plan approval', async () => {
    const options = vendor();
    await expect(evaluateCombatToolExecution(context(options))).resolves.toEqual({
      behavior: 'allow',
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Write',
          input: { file_path: 'x.ts' },
          action: { kind: 'file-write', path: 'x.ts' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('blocks bulk or full-file combat design scans while preserving narrow reads', async () => {
    const options = vendor();
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Bash',
          action: {
            kind: 'exec',
            command:
              "Get-Content -LiteralPath 'saga2_design/planning/04-职能组-functional-groups/战斗策划组-combat-planning/skills/saga2-project-battle-designer/SKILL.md'",
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止批量或全文读取 saga2_design'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Bash',
          action: {
            kind: 'exec',
            command:
              "rg -n '目标类型|伤害' saga2_design/planning/04-职能组-functional-groups/战斗策划组-combat-planning/专业规则-rules/ModuleDesignKnowledge.md",
          },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Read',
          action: {
            kind: 'read',
            path: 'C:\\Workspace\\saga2\\saga2_design\\planning\\01-治理规范-governance\\ai-onboarding-rules.md',
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止读取 saga2_design 治理长文档'),
    });
  });

  it('blocks unrelated external skill reads and recursive project skill enumeration', async () => {
    const options = vendor();
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Read',
          action: {
            kind: 'read',
            path: 'C:\\Users\\XINDONG\\.codex\\plugins\\openai-primary-runtime\\spreadsheets\\SKILL.md',
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止读取其它 Agent Skill'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Bash',
          action: {
            kind: 'exec',
            command: 'Get-ChildItem saga2_unity/.agents/skills -Recurse -File',
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止递归枚举项目 Skill'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Read',
          action: {
            kind: 'read',
            path: 'C:\\Workspace\\saga2\\saga2_unity\\.agents\\skills\\editor-skill-editor-module\\SKILL.md',
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止读取其它 Agent Skill'),
    });

    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Bash',
          action: {
            kind: 'exec',
            command:
              "Get-Content -Raw -LiteralPath 'saga2_unity/.agents/skills/editor-skill-editor-module/SKILL.md'",
            cwd: 'C:\\Workspace\\saga2\\saga2_project',
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止递归枚举项目 Skill'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Bash',
          action: {
            kind: 'exec',
            command: "rg --files saga2_unity -g '*.cs' | Select-Object -First 300",
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止枚举整个客户端'),
    });
  });

  it('allows an explicitly user-authorized combat implementation without a second plan review', async () => {
    const options = vendor({ mekaCombatExecutionMode: 'autonomous-user-request' });
    vi.mocked(runCombatEnvironmentGate).mockResolvedValueOnce({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Write',
          action: {
            kind: 'file-write',
            path: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\Temp\\123.import.json',
          },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    expect(options).toMatchObject({
      mekaCombatExecutionMode: 'autonomous-user-request',
      mekaCombatEnvironmentReady: true,
      mekaCombatPhase: 'execution',
    });
  });

  it('blocks writes under saga2_design/planning while allowing the approved implementation scope', async () => {
    const options = vendor({ mekaCombatPlanApproved: true, mekaCombatPhase: 'execution' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          action: {
            kind: 'file-write',
            path: 'C:\\Workspace\\saga2\\saga2_design\\planning\\draft.md',
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('暂不允许修改 saga2_design/planning'),
    });
    vi.mocked(runCombatEnvironmentGate).mockResolvedValueOnce({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          action: {
            kind: 'file-write',
            path: 'C:\\Workspace\\saga2\\saga2_unity\\Assets\\Editor\\SkillEditor\\Skill\\Saved Data\\123.asset',
          },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
  });

  it('keeps Meka P4 ghost calls classified as the P4 dependency', async () => {
    const options = vendor({ mekaCombatPlanApproved: true, mekaCombatPhase: 'execution' });
    vi.mocked(runCombatEnvironmentGate).mockResolvedValueOnce({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy__ghost_call',
          input: {
            ghost_id: 'meka-p4',
            tool: 'p4_edit',
            args: { path: 'skill_entry_model_editor.json' },
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
  });

  it('treats bound remote-project reference routes as read-only evidence without a Worker', async () => {
    const options = vendor();
    services.router.listProjectTools.mockResolvedValue([]);
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__mcp_router__call_tool',
          input: { name: 'git.show', args: { sha: 'a'.repeat(40) } },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });

    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__mcp_router__call_tool',
          input: { name: 'git.commit', args: { message: 'should remain blocked' } },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('allows a plain Select-String inspection but rejects PowerShell side effects', async () => {
    const options = vendor();
    const wrappedReadOnlyCommand =
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Select-String -Path \'saga2_unity\\Assets\\Scripts\\Hot\\Game\\Room\\Role\\RoomRoleSkill.cs\' -Pattern \'预警|伤害\' -Context 20,20"';
    const directReadOnlyCommand =
      "Select-String -LiteralPath 'saga2_unity\\Assets\\Scripts\\Hot\\Game\\Room\\Role\\RoomRoleSkill.cs' -Pattern '预警|伤害' -Context 20,20";
    const directFileRead =
      "Get-Content -LiteralPath 'saga2_unity\\Assets\\Scripts\\Hot\\Game\\Room\\Role\\RoomRoleSkill.cs' -Raw";
    for (const command of [wrappedReadOnlyCommand, directReadOnlyCommand, directFileRead]) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            toolName: 'exec',
            action: {
              kind: 'exec',
              command,
              cwd: 'C:\\Workspace\\saga2\\saga2_project',
            },
          }),
        ),
      ).resolves.toEqual({ behavior: 'allow' });
    }

    for (const command of [
      wrappedReadOnlyCommand.replace('"', '; Set-Content hacked.txt x"'),
      directReadOnlyCommand.replace('-Context 20,20', '-Context 20,20 > result.txt'),
      directReadOnlyCommand.replace("'预警|伤害'", '$env:API_KEY'),
      directReadOnlyCommand.replace('RoomRoleSkill.cs', '*.cs'),
      directReadOnlyCommand.replace('saga2_unity', '..\\saga2_design'),
      directReadOnlyCommand.replace(
        'Assets\\Scripts\\Hot\\Game\\Room\\Role\\RoomRoleSkill.cs',
        '.agents\\skills\\editor-skill-editor-module\\SKILL.md',
      ),
      `${directFileRead}; Set-Content hacked.txt x`,
      directFileRead.replace('RoomRoleSkill.cs', '*.cs'),
    ]) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            toolName: 'exec',
            action: { kind: 'exec', command, cwd: 'C:\\Workspace\\saga2\\saga2_project' },
          }),
        ),
      ).resolves.toMatchObject({ behavior: 'deny' });
    }
  });

  it('allows only the generated read-only probe for a snapshotted Skill', async () => {
    const options = vendor();
    const revision = 'a'.repeat(64);
    const skillPath =
      `C:\\Users\\XINDONG\\AppData\\Roaming\\CindyMeka\\meka-skill-snapshots\\revisions\\${revision}` +
      '\\claude-plugin\\skills\\combat-skill-configuration\\SKILL.md';
    const readSkillCommand =
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command ` +
      `'$s=Get-Content -LiteralPath '"'${skillPath}'; "'$s.Length; $s'`;

    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command: readSkillCommand,
            cwd: 'C:\\Workspace\\saga2\\saga2_project',
          },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });

    for (const command of [
      readSkillCommand.replace('$s.Length; $s', '$s.Length; Set-Content hacked.txt x; $s'),
      readSkillCommand.replace('SKILL.md', 'reference.md'),
      readSkillCommand.replace(revision, '..'),
    ]) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            toolName: 'exec',
            action: {
              kind: 'exec',
              command,
              cwd: 'C:\\Workspace\\saga2\\saga2_project',
            },
          }),
        ),
      ).resolves.toMatchObject({ behavior: 'deny' });
    }
  });

  it('allows only a complete direct read of the combat controller Skill snapshot', async () => {
    const options = vendor({ mekaCombatTargetExportCompleted: undefined });
    const revision = 'd'.repeat(64);
    const skillPath =
      `C:\\Users\\XINDONG\\AppData\\Roaming\\CindyMeka\\meka-skill-snapshots\\revisions\\${revision}` +
      '\\claude-plugin\\skills\\combat-skill-configuration\\SKILL.md';
    const readSkillCommands = [`Get-Content '${skillPath}'`, `Get-Content -Raw '${skillPath}'`];
    const wrappedReadSkillCommands = readSkillCommands.map(
      (command) => `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command ` + `"${command}"`,
    );

    for (const command of [...readSkillCommands, ...wrappedReadSkillCommands]) {
      expect(
        evaluateCombatShellCommandExecution(
          context(options, {
            toolName: 'exec',
            action: { kind: 'exec', command },
          }),
        ),
      ).toEqual({ behavior: 'allow' });
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            toolName: 'exec',
            action: {
              kind: 'exec',
              command,
              cwd: 'C:\\Workspace\\saga2\\saga2_project',
            },
          }),
        ),
      ).resolves.toEqual({ behavior: 'allow' });
    }

    const rawReadSkillCommand = readSkillCommands[1]!;
    const wrappedRawReadSkillCommand = wrappedReadSkillCommands[1]!;
    for (const command of [
      rawReadSkillCommand.replace('combat-skill-configuration', 'saga2-overview'),
      rawReadSkillCommand.replace('SKILL.md', '*.md'),
      rawReadSkillCommand.replace(revision, '..'),
      rawReadSkillCommand.replace('-Raw', '-First 10'),
      `${rawReadSkillCommand} | Select-Object -First 10`,
      `${rawReadSkillCommand}; Get-ChildItem`,
      `${wrappedRawReadSkillCommand}; Get-ChildItem`,
      `Get-Content -Raw 'C:\\Workspace\\saga2\\saga2_project\\AGENTS.md'`,
      `Get-Content -Raw 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity\\Assets\\Editor\\SkillEditor\\skill_entry_model_editor.json'`,
    ]) {
      expect(
        evaluateCombatShellCommandExecution(
          context(options, {
            toolName: 'exec',
            action: { kind: 'exec', command },
          }),
        ),
      ).toMatchObject({ behavior: 'deny' });
    }
  });

  it('rejects generated batch line-count probes that enumerate multiple Skill entrypoints', async () => {
    const options = vendor();
    const revision = 'b'.repeat(64);
    const root =
      `C:\\Users\\XINDONG\\AppData\\Roaming\\CindyMeka\\meka-skill-snapshots\\revisions\\${revision}` +
      '\\claude-plugin\\skills';
    const lineCountCommand =
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command ` +
      `'$paths = @('"'${root}\\saga2-overview\\SKILL.md','${root}\\editor-skill-editor-module\\SKILL.md'); ` +
      `foreach ("'$p in $paths) { if (Test-Path $p) { $m=Get-Content $p | Measure-Object -Line; ` +
      `Write-Output "$p\`t$($m.Lines)" } }'`;

    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command: lineCountCommand,
            cwd: 'C:\\Workspace\\saga2\\saga2_project',
          },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });

    for (const command of [
      lineCountCommand.replace('Write-Output', 'Set-Content result.txt'),
      lineCountCommand.replace('SKILL.md', 'reference.md'),
      lineCountCommand.replace('Measure-Object -Line', 'Measure-Object -Line; Remove-Item x'),
    ]) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            toolName: 'exec',
            action: {
              kind: 'exec',
              command,
              cwd: 'C:\\Workspace\\saga2\\saga2_project',
            },
          }),
        ),
      ).resolves.toMatchObject({ behavior: 'deny' });
    }
  });

  it('allows a read-only count expression only for the combat Skill snapshot', async () => {
    const options = vendor();
    const revision = 'c'.repeat(64);
    const skillPath =
      `C:\\Users\\XINDONG\\AppData\\Roaming\\CindyMeka\\meka-skill-snapshots\\revisions\\${revision}` +
      '\\claude-plugin\\skills\\combat-skill-configuration\\SKILL.md';
    const countCommand =
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command ` +
      `"(Get-Content -LiteralPath '${skillPath}').Count"`;

    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command: countCommand,
            cwd: 'C:\\Workspace\\saga2\\saga2_project',
          },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });

    for (const command of [
      countCommand.replace(').Count', '); Set-Content hacked.txt x'),
      countCommand.replace('SKILL.md', 'reference.md'),
      countCommand.replace(revision, '..'),
    ]) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            toolName: 'exec',
            action: {
              kind: 'exec',
              command,
              cwd: 'C:\\Workspace\\saga2\\saga2_project',
            },
          }),
        ),
      ).resolves.toMatchObject({ behavior: 'deny' });
    }
  });

  it('allows Unity CLI inspection and blocks Unity CLI mutations before approval', async () => {
    const options = vendor();
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__meka-unity__unity_inspect',
          input: {
            action: 'status',
            projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__meka-unity__unity_execute',
          input: { action: 'command', arguments: ['set_node'] },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('uses direct Unity status and lets the Meka Unity plugin own startup recovery', async () => {
    const options = vendor();
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy__ghost_list',
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny', reason: expect.stringContaining('ghost_list') });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__meka-unity__unity_inspect',
          input: {
            action: 'status',
            projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__meka-unity__unity_execute',
          input: {
            action: 'open',
            projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
  });

  it('allows an explicit Unity open after the plugin has asked the user to approve startup', async () => {
    const options = vendor({ mekaCombatPlanApproved: true, mekaCombatPhase: 'execution' });
    vi.mocked(runCombatEnvironmentGate).mockResolvedValueOnce({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__meka-unity__unity_execute',
          input: {
            action: 'open',
            projectPath: 'C:\\Workspace\\saga2\\saga2_project\\saga2_unity',
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
  });

  it('allows MCPRouter control-plane discovery through the call_tool wrapper', async () => {
    const options = vendor();
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__mcp_router__call_tool',
          input: { name: 'mcp_instance_tools', args: { instanceId: 'server-1' } },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
  });

  it('allows report validation only after accepted dispatch and trusted auto-bridge delivery', async () => {
    const options = vendor();
    const task =
      '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capabilities residual server gap: inspect runtime support';
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__create_worker',
          input: {
            role: 'server-capability-reviewer',
            agent: 'codex',
            label: 'server-readonly',
            remote_host_id: 'mcpr:server-1',
            initial_task: task,
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    expect(options).toMatchObject({ mekaCombatServerCapabilityStatus: 'dispatching' });

    const validation = context(options, {
      toolName: 'mcp:mcp_router',
      input: {
        serverName: 'mcp_router',
        toolName: 'validate_server_capability_report',
        toolParams: { serverCapabilityReport: { supportStatus: 'unsupported' } },
      },
      action: { kind: 'mcp' },
    });
    await expect(evaluateCombatToolExecution(validation)).resolves.toMatchObject({
      behavior: 'deny',
    });

    settleCombatServerCapabilityDispatch({
      leadSessionId: 'session-1',
      kind: 'create_worker',
      task,
      accepted: true,
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
    });
    await expect(evaluateCombatToolExecution(validation)).resolves.toMatchObject({
      behavior: 'deny',
    });
    recordCombatServerCapabilityAutoBridge({
      leadSessionId: 'session-1',
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
      message:
        '[Auto-bridged: worker 完成但未调 send_to_lead]\n\n' +
        JSON.stringify({ supportStatus: 'unsupported' }),
      accepted: true,
    });
    await expect(evaluateCombatToolExecution(validation)).resolves.toEqual({ behavior: 'allow' });
  });

  it('requires a fresh environment gate for every mutation after approval', async () => {
    const options = vendor();
    markCombatPlanApproved({ vendorOptions: options });
    vi.mocked(runCombatEnvironmentGate).mockResolvedValueOnce({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Write',
          action: { kind: 'file-write', path: 'x.ts' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    expect(options).toMatchObject({
      mekaCombatPlanApproved: true,
      mekaCombatEnvironmentReady: true,
      mekaCombatPhase: 'execution',
    });
  });

  it('does not block a P4 write when only unityCli is unavailable', async () => {
    const options = vendor({ mekaCombatPlanApproved: true });
    vi.mocked(runCombatEnvironmentGate).mockResolvedValueOnce({
      checkedAt: new Date(0).toISOString(),
      ready: false,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'blocked', summary: 'down' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Write',
          action: { kind: 'file-write', path: 'x.ts' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    expect(options).toMatchObject({
      mekaCombatEnvironmentReady: false,
      mekaCombatPhase: 'environment-recovery',
    });
  });

  it('requires the structured solution envelope before native approval', () => {
    const options = vendor();
    expect(
      evaluateCombatPlanReview({ vendorOptions: options, plan: 'module: 10104' }),
    ).toMatchObject({
      behavior: 'deny',
    });
    const plan = `[SAGA2_COMBAT_SOLUTION]\ntargetSkillId: 123\nchangeMode: incremental\nsurfaces: module/client\nmoduleEvidence: skill-entry-model 10104 -> 10000\ncapabilityMatrix: passive, periodic, random point, delay, damage, effect\nevidence: table + code\nvalidation: tests\nremainingUnknowns: none\n[/SAGA2_COMBAT_SOLUTION]`;
    expect(evaluateCombatPlanReview({ vendorOptions: options, plan })).toEqual({
      behavior: 'allow',
    });
    expect(
      evaluateCombatPlanReview({
        vendorOptions: options,
        plan: plan.replace('targetSkillId: 123', 'targetSkillId: 待确认'),
      }),
    ).toMatchObject({ behavior: 'deny' });
    expect(
      evaluateCombatPlanReview({
        vendorOptions: options,
        plan: plan.replace('evidence: table + code', 'evidence: 服务端待确认'),
      }),
    ).toMatchObject({ behavior: 'deny' });
    expect(
      evaluateCombatPlanReview({
        vendorOptions: options,
        plan: plan.replace('changeMode: incremental', 'changeMode: modify'),
      }),
    ).toMatchObject({ behavior: 'deny' });
    expect(
      evaluateCombatPlanReview({
        vendorOptions: options,
        plan: plan.replace('surfaces: module/client', 'surfaces: module/server'),
      }),
    ).toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('仅用于只读能力核查'),
    });
  });

  it('keeps remote server workers permanently read-only after the local Lead approves', async () => {
    const options = vendor({
      mekaWorkflow: 'saga2-combat-server-worker-v1',
      orcaLeadSessionId: 'lead-remote-1',
    });
    delete options.mekaCombatEnvironmentReady;
    delete options.mekaCombatPlanApproved;
    delete options.mekaCombatPhase;
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          remoteHostId: 'mcpr:server-1',
          action: { kind: 'file-write', path: 'server.ts' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });

    const lead = vendor();
    markCombatPlanApproved({ vendorOptions: lead, sessionId: 'lead-remote-1' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          remoteHostId: 'mcpr:server-1',
          action: { kind: 'file-write', path: 'server.ts' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('永久只读'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          remoteHostId: 'mcpr:server-1',
          action: { kind: 'exec', command: 'git status --short' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    for (const command of [
      "/bin/bash -c 'git show -s --format=%H HEAD'",
      '/bin/sh -c \'git grep -l -E "entryTypeDamageHit|dataFunRoleAtk" HEAD -- internal/battle\'',
      '/bin/sh -c \'git grep -n -C 24 -E "entryTypeDamageHit|dataFunRoleAtk" HEAD -- internal/battle/battle/battle_entry_model.go\'',
      "/usr/bin/sh -c 'git show HEAD:AGENTS.md'",
    ]) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            remoteHostId: 'mcpr:server-1',
            action: { kind: 'exec', command },
          }),
        ),
      ).resolves.toEqual({ behavior: 'allow' });
    }
    for (const command of [
      "/bin/sh -c 'git grep -n -E damage -- internal/battle'",
      '/bin/sh -c \'git grep -n -C 41 -E "entryTypeDamageHit" HEAD -- internal/battle\'',
    ]) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            remoteHostId: 'mcpr:server-1',
            action: { kind: 'exec', command },
          }),
        ),
      ).resolves.toMatchObject({ behavior: 'deny' });
    }
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          remoteHostId: 'mcpr:server-1',
          action: { kind: 'exec', command: "/bin/bash -lc 'rg -n damage internal/battle'" },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny', reason: expect.stringContaining('永久只读') });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          remoteHostId: 'mcpr:server-1',
          action: { kind: 'exec', command: 'printf changed > server.ts' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          remoteHostId: 'mcpr:server-1',
          action: { kind: 'exec', command: "/bin/bash -lc 'printf changed > server.ts'" },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          remoteHostId: 'mcpr:server-1',
          toolName: 'mcp__server__get_status',
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          remoteHostId: 'mcpr:server-1',
          toolName: 'mcp__orca_worker_bridge__send_to_lead',
          input: { worker_id: 'worker-1', message: '{"supportStatus":"unsupported"}' },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('auto-bridge'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          remoteHostId: 'mcpr:server-1',
          toolName: 'mcp:orca_worker_bridge',
          input: {
            serverName: 'orca_worker_bridge',
            toolName: 'send_to_lead',
            toolParams: {
              worker_id: 'worker-1',
              message: '{"supportStatus":"unsupported"}',
            },
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('auto-bridge'),
    });
    for (const blockedMcp of [
      {
        toolName: 'mcp__orca_worker_bridge__read_lead',
        input: { worker_id: 'worker-1' },
      },
      {
        toolName: 'mcp__orca_worker_bridge__send_to_lead',
        input: { worker_id: 'worker-1' },
      },
      {
        toolName: 'mcp:orca_worker_bridge',
        input: {
          serverName: 'orca_worker_bridge',
          toolParams: {
            worker_id: 'worker-1',
            message: '{"supportStatus":"unsupported"}',
          },
        },
      },
      {
        toolName: 'mcp__cindy_orca__send_to_worker',
        input: { worker_id: 'worker-2', message: 'continue' },
      },
    ]) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            remoteHostId: 'mcpr:server-1',
            ...blockedMcp,
            action: { kind: 'mcp' },
          }),
        ),
      ).resolves.toMatchObject({ behavior: 'deny' });
    }
    expect(options).not.toHaveProperty('mekaCombatEnvironmentReady');
    expect(options).not.toHaveProperty('mekaCombatPhase');
    expect(runCombatEnvironmentGate).not.toHaveBeenCalled();
  });

  it('allows combat server evidence only through bounded Git commands', async () => {
    const options = vendor({
      mekaWorkflow: 'saga2-combat-server-worker-v1',
      orcaLeadSessionId: 'lead-git-only-1',
    });

    await expect(
      evaluateCombatToolExecution(
        context(options, {
          remoteHostId: 'mcpr:server-1',
          toolName: 'Read',
          action: { kind: 'read', path: '/tmp/tool-results/search.txt' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止 Read/文件读取工具'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          remoteHostId: 'mcpr:server-1',
          action: { kind: 'exec', command: 'git show HEAD:AGENTS.md' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
  });

  it('forces a remote server worker to summarize after its evidence budget', async () => {
    const options = vendor({
      mekaWorkflow: 'saga2-combat-server-worker-v1',
      orcaLeadSessionId: 'lead-budget-1',
    });
    for (let index = 0; index < 6; index += 1) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            remoteHostId: 'mcpr:server-1',
            action: { kind: 'exec', command: 'git status --short' },
          }),
        ),
      ).resolves.toEqual({ behavior: 'allow' });
    }
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          remoteHostId: 'mcpr:server-1',
          action: { kind: 'exec', command: 'git status --short' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('最多 6 次只读证据调用'),
    });
  });

  it('keeps read-only work available after a server capability report requires programmer handoff', async () => {
    const options = vendor({
      mekaCombatServerCapabilityStatus: 'unsupported',
      mekaCombatPhase: 'server-programmer-handoff',
    });
    await expect(evaluateCombatToolExecution(context(options))).resolves.toEqual({
      behavior: 'allow',
    });
    const plan = `[SAGA2_COMBAT_SOLUTION]\ntargetSkillId: 123\nchangeMode: incremental\nsurfaces: module\nmoduleEvidence: skill-entry-model 10104 -> 10000\ncapabilityMatrix: periodic random point damage chain\nevidence: table + code\nvalidation: tests\nremainingUnknowns: none\n[/SAGA2_COMBAT_SOLUTION]`;
    expect(evaluateCombatPlanReview({ vendorOptions: options, plan })).toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('程序交接报告'),
    });
    const pending = vendor({ mekaCombatServerCapabilityStatus: 'pending' });
    expect(evaluateCombatPlanReview({ vendorOptions: pending, plan })).toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('Host 完整结算'),
    });
  });

  it('allows only marked read-only server exploration workers before approval', async () => {
    const options = vendor();
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__create_worker',
          input: {
            role: 'server-capability-reviewer',
            agent: 'codex',
            label: 'server-readonly-direct',
            remote_host_id: 'mcpr:server-1',
            initial_task:
              '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capabilities residual server gap: inspect AGENTS.md',
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    expect(options).toMatchObject({
      mekaCombatServerCapabilityStatus: 'dispatching',
      mekaCombatPhase: 'server-capability-dispatch',
    });
    for (const pendingAction of [
      {
        toolName: 'Read',
        action: { kind: 'read' as const, path: 'Assets/Skill.cs' },
      },
      {
        toolName: 'exec',
        action: { kind: 'exec' as const, command: 'rg -n Skill Assets' },
      },
      {
        toolName: 'mcp__cindy_orca__list_workers',
        action: { kind: 'mcp' as const },
      },
      {
        toolName: 'mcp__cindy_orca__read_worker',
        input: { worker_id: 'worker-1' },
        action: { kind: 'mcp' as const },
      },
    ]) {
      await expect(
        evaluateCombatToolExecution(context(options, pendingAction)),
      ).resolves.toMatchObject({
        behavior: 'deny',
        reason: expect.stringContaining('正在派发或运行'),
      });
    }

    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__mcp_router__check_combat_environment',
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny', reason: expect.stringContaining('禁止立即重复') });

    settleCombatServerCapabilityDispatch({
      leadSessionId: 'session-1',
      kind: 'create_worker',
      task: '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capabilities residual server gap: inspect AGENTS.md',
      accepted: false,
    });
    expect(options).toMatchObject({
      mekaCombatServerCapabilityStatus: 'retry-required',
      mekaCombatPhase: 'server-capability-retry',
    });

    const wrappedOptions = vendor();
    await expect(
      evaluateCombatToolExecution(
        context(wrappedOptions, {
          toolName: 'mcp:cindy_orca',
          input: {
            serverName: 'cindy_orca',
            message: 'Allow this MCP tool call?',
            toolParams: {
              role: 'developer',
              agent: 'codex',
              label: 'server-readonly',
              remote_host_id: 'mcpr:server-1',
              initial_task:
                '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capabilities residual server gap: inspect AGENTS.md',
            },
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    expect(wrappedOptions).toMatchObject({
      mekaCombatServerCapabilityStatus: 'dispatching',
      mekaCombatPhase: 'server-capability-dispatch',
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__create_worker',
          input: {
            role: 'server-capability-reviewer',
            agent: 'codex',
            label: 'server-unmarked',
            remote_host_id: 'mcpr:server-1',
            initial_task: 'inspect server',
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__create_worker',
          input: {
            role: 'server-capability-reviewer',
            agent: 'claude-code',
            label: 'server-wrong-agent',
            remote_host_id: 'mcpr:server-1',
            initial_task:
              '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capabilities residual server gap: inspect AGENTS.md',
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('rejects a server worker that lacks module-first atomic evidence', async () => {
    const options = vendor();
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__create_worker',
          input: {
            role: 'server-capability-reviewer',
            agent: 'codex',
            label: 'server-readonly-unscoped',
            remote_host_id: 'mcpr:server-1',
            initial_task: '[SAGA2_SERVER_EXPLORATION_READ_ONLY] inspect the whole skill support',
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('目标技能的老版导出回执'),
    });
    expect(options.mekaCombatServerCapabilityStatus).toBe('supported');
  });

  it('accepts a new-skill module-first report built from the target legacy export', async () => {
    const options = vendor({
      mekaCombatTargetExportCompleted: undefined,
      mekaCombatTargetExportAttempted: true,
    });
    const task = [
      '[SAGA2_SERVER_EXPLORATION_READ_ONLY]',
      '[SAGA2_MODULE_FIRST]',
      'targetSkillId: 123',
      'legacy_module_export_json 对 skill_id=123 的目标技能返回资产不存在。',
      '模块协议字段已读取；原子能力矩阵：目标、伤害、时序均为待核查。',
      '剩余服务器语义：核查目标继承、伤害数据函数和重复调度。',
    ].join('\n');
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__create_worker',
          input: {
            role: 'server-capability-reviewer',
            agent: 'codex',
            label: 'server-new-skill',
            remote_host_id: 'mcpr:server-1',
            initial_task: task,
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
  });

  it('requires the exact bound capability-ready MCPR target and only reuses Host-known workers', async () => {
    const options = vendor();
    const task =
      '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capability matrix residual server gap';
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__create_worker',
          input: {
            role: 'server-capability-reviewer',
            agent: 'codex',
            label: 'wrong-server',
            remote_host_id: 'mcpr:other-server',
            initial_task: task,
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('已绑定'),
    });

    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__send_to_worker',
          input: { target_session_id: 'untrusted-worker', message: task },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });

    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__create_worker',
          input: {
            role: 'server-capability-reviewer',
            agent: 'codex',
            label: 'trusted-server',
            remote_host_id: 'mcpr:server-1',
            initial_task: task,
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    settleCombatServerCapabilityDispatch({
      leadSessionId: 'session-1',
      kind: 'create_worker',
      task,
      accepted: false,
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__send_to_worker',
          input: { target_session_id: 'worker-session-1', message: task },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
  });

  it('requires the Worker agent to match the Host-injected Claude instance type', async () => {
    services.router.listProjectBindings.mockResolvedValue(['server-claude']);
    services.router.listInstances.mockResolvedValue([
      {
        id: 'server-claude',
        projectName: 'SAGA2服务器',
        projectDescription: 'SAGA2 server',
        agentType: 'claude',
        available: true,
      },
    ]);
    const options = vendor({
      mekaCombatServerRemoteHostId: 'mcpr:server-claude',
      mekaCombatServerWorkerAgent: 'claude-code',
    });
    const task =
      '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capability matrix residual server gap';

    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__create_worker',
          input: {
            role: 'server-capability-reviewer',
            agent: 'codex',
            label: 'wrong-agent',
            remote_host_id: 'mcpr:server-claude',
            initial_task: task,
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });

    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__create_worker',
          input: {
            role: 'server-capability-reviewer',
            agent: 'claude-code',
            label: 'matching-agent',
            remote_host_id: 'mcpr:server-claude',
            initial_task: task,
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
  });

  it('keeps Router and Orca server-side mutations blocked after plan approval', async () => {
    const options = vendor();
    markCombatPlanApproved({ vendorOptions: options });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__mcp_router__call_tool',
          input: { name: 'mcp_create_key', args: { type: 'client' } },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('只允许环境恢复和只读查询'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__create_worker',
          input: {
            role: 'local-helper',
            agent: 'codex',
            label: 'local-helper',
            initial_task: 'inspect local files',
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止创建本地 Worker'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp:cindy_orca',
          input: {
            serverName: 'cindy_orca',
            toolParams: { workers: [{ role: 'helper', initial_task: 'inspect' }] },
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止用 create_workers'),
    });
    expect(runCombatEnvironmentGate).not.toHaveBeenCalled();
  });

  it('recognizes the exact read-only P4 status call from Codex code-mode approval metadata', async () => {
    await expect(
      evaluateCombatToolExecution(
        context(vendor(), {
          toolName: 'mcp:cindy',
          input: {
            serverName: 'cindy',
            message: 'Allow this MCP tool call?',
            toolParams: {
              ghost_id: 'meka-p4',
              tool: 'p4_status',
              args: { scan: false },
            },
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(vendor(), {
          toolName: 'mcp:cindy',
          input: {
            toolParams: {
              ghost_id: 'meka-p4',
              tool: 'p4_submit',
              args: {},
            },
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
  });
});
