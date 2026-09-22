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
  combatRequestScopeAnswerApprovalPatch,
  combatRequestScopeApprovalPatch,
  combatSkillIdVendorPatchFromUserPrompt,
} from '../../meka-injection/mekaCombatPrompts.js';
import { prepareCombatFollowupRuntimeContext } from '../../meka-injection/mekaResolvePlan.js';
import {
  combatScopeStateRestorePatch,
  evaluateCombatShellCommandExecution,
  evaluateCombatToolExecution,
  forgetCombatVendorOptions,
  invalidateCombatTargetBinding,
  isCombatWorkflowPolicyActive,
  markCombatTargetExportAttempted,
  markCombatTargetExportCompleted,
  observeCombatLegacyModuleResult,
  readCombatVendorOptions,
  refreshCombatTargetBinding,
  rememberCombatVendorOptions,
  resetCombatTargetExportStateForTests,
  resetCombatVendorOptionsMirrorForTests,
} from '../combatWorkflowPolicy.js';
import {
  recordCombatServerCapabilityAutoBridge,
  resetCombatServerCapabilityStateForTests,
  settleCombatServerCapabilityDispatch,
} from '../combatServerCapabilityState.js';

// SAGA2 fixture paths. Every project path below is derived from these resolved
// roots with the same `path.resolve` / `path.join` chain the production policy
// uses, so the expectations hold on Windows and on POSIX hosts (a raw
// `C:\Workspace\...` literal would no longer resolve to the working directory
// there).
const SAGA2_PROJECT_ROOT = path.resolve('C:/Workspace/saga2/saga2_project');
const SAGA2_WORKSPACE_ROOT = path.dirname(SAGA2_PROJECT_ROOT);
const SAGA2_UNITY_ROOT = path.join(SAGA2_PROJECT_ROOT, 'saga2_unity');
const SAGA2_UNITY_ASSETS_ROOT = path.join(SAGA2_UNITY_ROOT, 'Assets');
const SAGA2_UNITY_MODULE_V2_ROOT = path.join(
  SAGA2_UNITY_ASSETS_ROOT,
  'Editor',
  'SkillEditor',
  'Module',
);
const SAGA2_JSON_ROOT = path.join(SAGA2_PROJECT_ROOT, 'saga2_json');
const SAGA2_DESIGN_ROOT = path.join(SAGA2_WORKSPACE_ROOT, 'saga2_design');
// The real SAGA2 checkout also keeps a Unity project next to `saga2_project`.
// It is deliberately NOT the Host-injected root, so it is only used for paths
// that must stay outside the authorized project.
const SAGA2_STRAY_UNITY_ROOT = path.join(SAGA2_WORKSPACE_ROOT, 'saga2_unity');
const SAGA2_WORKSPACE_AGENTS_PATH = path.join(SAGA2_PROJECT_ROOT, 'AGENTS.md');
const SAGA2_UNITY_AGENTS_PATH = path.join(SAGA2_UNITY_ROOT, 'AGENTS.md');
const SAGA2_LEGACY_MODULE_PROTOCOL_CODEC_PATH = path.join(
  SAGA2_UNITY_ASSETS_ROOT,
  'Editor',
  'SkillEditor',
  'Common',
  'Editor',
  'Exporter',
  'Execute',
  'Impl',
  'Type',
  'SkillModuleProtocolCodec.cs',
);
const SAGA2_STRAY_UNITY_AGENTS_PATH = path.join(SAGA2_STRAY_UNITY_ROOT, 'AGENTS.md');
/**
 * Host 注入的两条项目参考路径白名单（生产上由 `mekaResolvePlan` 从 workingDir 解析后写进
 * `vendorOptions.mekaCombatProjectRefPaths`；测试里按同一规则重建）。
 */
const COMBAT_PROJECT_REF_PATHS = [
  path.join(SAGA2_UNITY_ROOT, '.agents', 'skills', 'editor-skill-editor-module', 'SKILL.md'),
  path.join(
    SAGA2_PROJECT_ROOT,
    'saga2_design',
    'planning',
    '04-职能组-functional-groups',
    '战斗策划组-combat-planning',
    '专业规则-rules',
    'ModuleDesignKnowledge.md',
  ),
];
const SAGA2_MODULE_ASSET_PATH = path.join(
  SAGA2_UNITY_ROOT,
  'Assets',
  'Editor',
  'SkillEditor',
  'Module',
  'Saved Data',
  'Modules',
  '3001210.asset',
);
/** 表范围解析允许的只读 Unity 查询命令白名单（`mekaCombatReadOnlyUnityCommands`）。 */
const COMBAT_READ_ONLY_UNITY_COMMANDS = [
  'legacy_module_query_nodes',
  'legacy_module_audit_coverage',
];
const SAGA2_STRAY_LEGACY_MODULE_PROTOCOL_CODEC_PATH = path.join(
  SAGA2_STRAY_UNITY_ROOT,
  'Assets',
  'Editor',
  'SkillEditor',
  'Common',
  'Editor',
  'Exporter',
  'Execute',
  'Impl',
  'Type',
  'SkillModuleProtocolCodec.cs',
);

const SAGA2_UNITY_ROLE_SKILL_RELATIVE_PATH = path.relative(
  SAGA2_PROJECT_ROOT,
  path.join(
    SAGA2_UNITY_ROOT,
    'Assets',
    'Scripts',
    'Hot',
    'Game',
    'Room',
    'Role',
    'RoomRoleSkill.cs',
  ),
);

/**
 * Render a path the way model-generated PowerShell commands sometimes do, with
 * every separator doubled. On POSIX `path.sep` is '/', so the doubled form still
 * resolves to the same file and the `allow` case keeps its meaning.
 */
function doubledSeparators(value: string): string {
  return value.split(path.sep).join(path.sep + path.sep);
}

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
    workingDir: SAGA2_PROJECT_ROOT,
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
  services.p4.get.mockResolvedValue({ p4RootPath: SAGA2_PROJECT_ROOT });
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
      `Get-Content -Raw '${SAGA2_WORKSPACE_AGENTS_PATH}'`,
      `rg --files -g 'AGENTS.md' '${SAGA2_UNITY_ROOT}'`,
      `rg -n -g '*.cs' 'BattleRoleSkill' '${SAGA2_UNITY_ASSETS_ROOT}'`,
      `rg -n 'ModuleV2SemanticKind' '${SAGA2_UNITY_MODULE_V2_ROOT}'`,
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
            command: `Get-Content -Raw '${SAGA2_UNITY_AGENTS_PATH}'`,
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
              `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-Content -LiteralPath '${SAGA2_UNITY_AGENTS_PATH}'"`,
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
            command: `Get-Content -LiteralPath '${doubledSeparators(SAGA2_UNITY_AGENTS_PATH)}'`,
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
            command: `Get-Content -LiteralPath '${SAGA2_LEGACY_MODULE_PROTOCOL_CODEC_PATH}'`,
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
              `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-Content -LiteralPath '${SAGA2_LEGACY_MODULE_PROTOCOL_CODEC_PATH}' -Raw"`,
          },
        }),
      ),
    ).toEqual({ behavior: 'allow' });
    // 注入的参考文件读取命令现在带 `-Encoding UTF8`（原生 read 不可用时的回退形态）。
    expect(
      evaluateCombatShellCommandExecution(
        context(ready, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command: `Get-Content -LiteralPath '${SAGA2_LEGACY_MODULE_PROTOCOL_CODEC_PATH}' -Encoding UTF8`,
          },
        }),
      ),
    ).toEqual({ behavior: 'allow' });
    // 编码白名单刻意收窄到 UTF-8 家族：`-Encoding Oem`/`Default` 会把中文读成乱码，
    // 等于"读了但没读到"，不能被当成一次成功的参考读取。
    expect(
      evaluateCombatShellCommandExecution(
        context(ready, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command: `Get-Content -LiteralPath '${SAGA2_LEGACY_MODULE_PROTOCOL_CODEC_PATH}' -Encoding Oem`,
          },
        }),
      ),
    ).toMatchObject({ behavior: 'deny' });
    expect(
      evaluateCombatShellCommandExecution(
        context(ready, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command:
              `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-Content -LiteralPath '${doubledSeparators(SAGA2_LEGACY_MODULE_PROTOCOL_CODEC_PATH)}'"`,
          },
        }),
      ),
    ).toEqual({ behavior: 'allow' });
    for (const wrongPathCommand of [
      `Get-Content -LiteralPath '${SAGA2_STRAY_UNITY_AGENTS_PATH}'`,
      `Get-Content -LiteralPath '${SAGA2_STRAY_LEGACY_MODULE_PROTOCOL_CODEC_PATH}'`,
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
        reason: expect.stringContaining(SAGA2_UNITY_ROOT),
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
            path: SAGA2_UNITY_AGENTS_PATH,
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
          projectPath: SAGA2_UNITY_ROOT,
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
          projectPath: SAGA2_UNITY_ROOT,
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
            projectPath: SAGA2_UNITY_ROOT,
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
            command: `Get-Content '${SAGA2_UNITY_AGENTS_PATH}'`,
            cwd: SAGA2_PROJECT_ROOT,
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
              command: `Get-Content '${SAGA2_UNITY_AGENTS_PATH}'`,
              cwd: SAGA2_PROJECT_ROOT,
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
            cwd: SAGA2_PROJECT_ROOT,
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止枚举或读取工作区根 AGENTS.md'),
    });
    for (const blockedPath of [
      path.join(SAGA2_UNITY_ROOT, 'Assets', 'Editor', 'SkillEditor', 'ModuleV2', 'COMPONENT_CATALOG.md'),
      path.join(SAGA2_UNITY_ROOT, 'Assets', 'Editor', 'SkillEditor', 'Skill', 'Exportd Data', 'Server', 'skill_entry_model_editor.json'),
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
          projectPath: SAGA2_UNITY_ROOT,
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
              `Get-Content -LiteralPath '${SAGA2_UNITY_AGENTS_PATH}'`,
            cwd: SAGA2_PROJECT_ROOT,
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
              `rg -n -g '*.cs' 'BattleRoleSkill' '${SAGA2_UNITY_ASSETS_ROOT}'`,
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
          projectPath: SAGA2_UNITY_ROOT,
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
            command: `Get-Content '${SAGA2_UNITY_AGENTS_PATH}'`,
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
            projectPath: SAGA2_UNITY_ROOT,
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
          path.join(SAGA2_JSON_ROOT, '1019.import.json'),
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
      path.join(SAGA2_JSON_ROOT, '1019.import.json'),
      path.join(SAGA2_DESIGN_ROOT, 'planning', '1019.export.json'),
      '1019.import.json',
    ]) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            toolName: 'mcp__meka-unity__unity_execute',
            input: {
              action: 'command',
              projectPath: SAGA2_UNITY_ROOT,
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
      path.join(SAGA2_UNITY_ROOT, 'Temp', '1019.export.json'),
    ]) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            toolName: 'mcp__meka-unity__unity_execute',
            input: {
              action: 'command',
              projectPath: SAGA2_UNITY_ROOT,
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
            projectPath: SAGA2_UNITY_ROOT,
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
            args: { files: [path.join(SAGA2_UNITY_ROOT, '1019.asset')] },
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止 P4 写入'),
    });
  });

  it('never denies local lead evidence reads, in exploration or execution', async () => {
    const options = vendor({ mekaCombatPhase: 'exploration' });
    for (let index = 0; index < 12; index += 1) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            sessionId: 'lead-evidence-unbounded',
            action: { kind: 'read', path: `skill-${index}.json` },
          }),
        ),
      ).resolves.toEqual({ behavior: 'allow' });
    }

    const executionOptions = vendor({ mekaCombatPhase: 'execution' });
    await expect(
      evaluateCombatToolExecution(
        context(executionOptions, {
          sessionId: 'lead-evidence-unbounded',
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
            projectPath: SAGA2_UNITY_ROOT,
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
            projectPath: SAGA2_UNITY_ROOT,
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
            projectPath: SAGA2_UNITY_ROOT,
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

  it('allows read-only exploration and file writes without a plan-approval step', async () => {
    const options = vendor();
    await expect(evaluateCombatToolExecution(context(options))).resolves.toEqual({
      behavior: 'allow',
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
          toolName: 'Write',
          input: { file_path: 'x.ts' },
          action: { kind: 'file-write', path: 'x.ts' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
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
            path: path.join(SAGA2_DESIGN_ROOT, 'planning', '01-治理规范-governance', 'ai-onboarding-rules.md'),
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
            path: path.join(SAGA2_STRAY_UNITY_ROOT, '.agents', 'skills', 'editor-skill-editor-module', 'SKILL.md'),
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
            cwd: SAGA2_PROJECT_ROOT,
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

  it('allows exactly the injected project reference paths and keeps enumeration and other skills denied', async () => {
    // 首证据（目标导出）尚未完成：两条注入路径仍必须可读 —— 它们是 Host 交办的域事实正本。
    const beforeExport = vendor({
      mekaCombatTargetExportCompleted: false,
      mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
    });
    // 负例断言走「目标导出已完成」的常规状态，避免被首证据门禁的文案抢先命中。
    const options = vendor({ mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS });

    await expect(
      evaluateCombatToolExecution(
        context(beforeExport, { action: { kind: 'read', path: COMBAT_PROJECT_REF_PATHS[0] } }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(beforeExport, {
          toolName: 'Bash',
          action: {
            kind: 'exec',
            command: `Get-Content -LiteralPath '${COMBAT_PROJECT_REF_PATHS[0]}'`,
          },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(beforeExport, {
          toolName: 'Bash',
          action: {
            kind: 'exec',
            command: `Get-Content -LiteralPath '${COMBAT_PROJECT_REF_PATHS[1]}'`,
          },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    // 同一个 Saga2 Shell 入口（Codex 预执行守卫）也必须放行同样的两条路径。
    expect(
      evaluateCombatShellCommandExecution(
        context(beforeExport, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command: `Get-Content -LiteralPath '${COMBAT_PROJECT_REF_PATHS[1]}'`,
          },
        }),
      ),
    ).toEqual({ behavior: 'allow' });

    // 同目录的其它项目 Skill：仍然拒绝（白名单是精确路径，不是目录前缀）。
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          action: {
            kind: 'read',
            path: path.join(
              SAGA2_UNITY_ROOT,
              '.agents',
              'skills',
              'editor-skill-editor-timeline',
              'SKILL.md',
            ),
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止读取其它 Agent Skill'),
    });
    // 通配/批量形态：即便目标目录含白名单路径也不放行。
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Bash',
          action: {
            kind: 'exec',
            command: `Get-Content -LiteralPath '${COMBAT_PROJECT_REF_PATHS[0]}*'`,
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止递归枚举项目 Skill'),
    });
    // 枚举白名单所在目录：仍然拒绝。
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Bash',
          action: {
            kind: 'exec',
            command: `Get-ChildItem '${path.join(SAGA2_UNITY_ROOT, '.agents', 'skills')}' -Recurse -File`,
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止递归枚举项目 Skill'),
    });
    // 治理规范目录：白名单不得短路它。
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          action: {
            kind: 'read',
            path: path.join(
              SAGA2_DESIGN_ROOT,
              'planning',
              '01-治理规范-governance',
              'ai-onboarding-rules.md',
            ),
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止读取 saga2_design 治理长文档'),
    });
  });

  it('keeps writes closed and allows only bounded read-only scope resolution for an unapproved table scope', async () => {
    const options = vendor({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatTargetExportAttempted: undefined,
      mekaCombatTargetExportCompleted: undefined,
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
      mekaCombatScopeSourceTables: [],
      mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
    });

    // 不再回「缺少正整数技能 ID / 请只询问技能 ID」：范围解析阶段读声明的表即可。
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          action: { kind: 'read', path: path.join(SAGA2_JSON_ROOT, 'MonsterSkill.json') },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, { action: { kind: 'read', path: SAGA2_MODULE_ASSET_PATH } }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Bash',
          action: {
            kind: 'exec',
            command: `Get-Content -LiteralPath '${path.join(SAGA2_JSON_ROOT, 'MonsterSkill.json')}'`,
          },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });

    // 未确认范围之前：写入仍然关闭（首证据门禁 + 后续 supported 门禁都未放宽）。
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Write',
          action: { kind: 'file-write', path: path.join(SAGA2_UNITY_ROOT, 'Temp', 'notes.md') },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('第一条项目内容证据必须是老版模块编辑器'),
    });
    // 未确认范围之前：老版模块导入也不放行（范围外的显式 ID 直接被目标门禁拒绝）。
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy__ghost_call',
          input: {
            ghost_id: 'meka-unity',
            tool: 'unity_execute',
            args: {
              action: 'command',
              projectPath: SAGA2_UNITY_ROOT,
              arguments: [
                'legacy_module_import_json',
                '1019',
                path.join(os.tmpdir(), '1019.import.json'),
                'true',
              ],
            },
          },
          action: { kind: 'mcp' as const },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('范围外'),
    });
    // 枚举仍然拒绝（目标导出已完成时也不放宽）。
    await expect(
      evaluateCombatToolExecution(
        context(vendor({ ...options, mekaCombatTargetExportCompleted: true }), {
          toolName: 'Bash',
          action: { kind: 'exec', command: `Get-ChildItem '${SAGA2_JSON_ROOT}' -Recurse` },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止枚举整个客户端'),
    });
    // 表范围也不放宽「其它 Agent Skill」：范围知识来自配置表，不是别的 Skill。
    await expect(
      evaluateCombatToolExecution(
        context(vendor({ ...options, mekaCombatTargetExportCompleted: true }), {
          action: {
            kind: 'read',
            path: path.join(
              SAGA2_UNITY_ROOT,
              '.agents',
              'skills',
              'saga2-project-battle-designer',
              'SKILL.md',
            ),
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('禁止读取其它 Agent Skill'),
    });
  });

  it('routes an in-skill bulk numeric edit through the single-ID flow, not the table-scope flow (D5)', async () => {
    // 检测器层：单技能内的批量数值改动（「把伤害数值都改成0.5」）不产生任何范围补丁。
    const inSkillEditPatch = combatSkillIdVendorPatchFromUserPrompt('把伤害数值都改成0.5');
    expect(inSkillEditPatch).toBeNull();
    // 路由后果：零绑定会话读声明的源表**不会**走「范围解析只读放行」，而是回到单技能硬入口的
    // 缺 ID 追问。这正是 D5 的危害面：判错会让请求进入表范围流程，而表范围正文禁止向用户
    // 追问技能 ID，两边互相踢皮球。
    await expect(
      evaluateCombatToolExecution(
        context(
          vendor({
            mekaCombatTargetSkillId: undefined,
            mekaCombatTargetSkillIdState: undefined,
            ...(inSkillEditPatch ?? {}),
          }),
          { action: { kind: 'read', path: path.join(SAGA2_JSON_ROOT, 'MonsterSkill.json') } },
        ),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('缺少用户明确提供的正整数技能 ID'),
    });
    // 对照组：真正点名的表范围走同一条读的**相反**分支（范围解析只读放行）。两者必须由检测器
    // 分开，不能靠「都问用户确认范围」蒙混。
    await expect(
      evaluateCombatToolExecution(
        context(
          vendor({
            mekaCombatTargetSkillId: undefined,
            mekaCombatTargetSkillIdState: 'missing',
            mekaCombatRequestScope: 'table-scope',
            mekaCombatRequestScopeState: 'proposed',
            mekaCombatScopeApproved: false,
            mekaCombatScopeSourceTables: [],
            mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
          }),
          { action: { kind: 'read', path: path.join(SAGA2_JSON_ROOT, 'MonsterSkill.json') } },
        ),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    // 两个用户点名的 ID 走歧义分支：同样不得读取任何项目内容，只要求用户收敛到一个 ID。
    const twoIds = combatSkillIdVendorPatchFromUserPrompt('把 1019 和 1020 都改成取100%攻击力');
    expect(twoIds).toMatchObject({
      mekaCombatTargetSkillIdState: 'ambiguous',
      mekaCombatTargetSkillIds: ['1019', '1020'],
      mekaCombatRequestScope: 'single-skill',
    });
    await expect(
      evaluateCombatToolExecution(
        context(
          vendor({
            mekaCombatTargetSkillId: undefined,
            mekaCombatTargetSkillIdState: undefined,
            ...(twoIds ?? {}),
          }),
          { action: { kind: 'read', path: path.join(SAGA2_JSON_ROOT, 'MonsterSkill.json') } },
        ),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('多个技能 ID'),
    });
  });

  it('allows only the whitelisted read-only Unity query channel while a table scope is unconfirmed', async () => {
    const options = vendor({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatTargetExportAttempted: undefined,
      mekaCombatTargetExportCompleted: undefined,
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
      mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
      mekaCombatReadOnlyUnityCommands: COMBAT_READ_ONLY_UNITY_COMMANDS,
    });
    const unityInspect = (arguments_: unknown[], projectPath: string) =>
      context(options, {
        toolName: 'mcp__meka-unity__unity_inspect',
        input: { action: 'command', projectPath, arguments: arguments_ },
        action: { kind: 'mcp' as const },
      });

    // 白名单只读查询：范围发现通道放行（不要求 supported 回执）。示例统一用 Unity CLI 的
    // 规范形态 `--name value`：`exclude_data=true` 这类 `key=value` 不会被绑定，会被当成位置
    // 参数塞进 `skill_ids` 而失败（见 `moduleEditorSkillPath` 的命令契约）。
    await expect(
      evaluateCombatToolExecution(
        unityInspect(
          ['legacy_module_query_nodes', '--module_type', '10000', '--limit', '500'],
          SAGA2_UNITY_ROOT,
        ),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(unityInspect(['legacy_module_audit_coverage'], SAGA2_UNITY_ROOT)),
    ).resolves.toEqual({ behavior: 'allow' });
    // 下面四种「范围发现通道不成立」的形态必须被拒，而且理由要钉住（A8）：先用**已具备导出
    // 证据**的同一份状态，让首证据门禁不再拦截，于是拒绝只能来自「没被识别为白名单只读范围
    // 查询」之后的 fail-closed 服务器回执门禁（放行分支走的是 2012 行的专用 allow）。
    const withEvidence = vendor({ ...options, mekaCombatTargetExportCompleted: true });
    const probe = (toolName: string, arguments_: unknown[], projectPath: string) =>
      context(withEvidence, {
        toolName,
        input: { action: 'command', projectPath, arguments: arguments_ },
        action: { kind: 'mcp' as const },
      });
    // 换项目路径：必须与 Host 注入的 unityClientRoot 一致。
    await expect(
      evaluateCombatToolExecution(
        probe('mcp__meka-unity__unity_inspect', ['legacy_module_query_nodes'], SAGA2_STRAY_UNITY_ROOT),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('服务器 supported 回执'),
    });
    // 白名单以外的动作/命令：一律不放行（老版导入命令先被表范围的目标门禁拦下，
    // 理由必须是**范围外**，不是别的门禁顺手拒掉）。
    await expect(
      evaluateCombatToolExecution(
        probe(
          'mcp__meka-unity__unity_inspect',
          ['legacy_module_import_json', '1019'],
          SAGA2_UNITY_ROOT,
        ),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('范围外'),
    });
    await expect(
      evaluateCombatToolExecution(
        probe('mcp__meka-unity__unity_inspect', ['eval', 'return 1'], SAGA2_UNITY_ROOT),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('服务器 supported 回执'),
    });
    // 同一个只读命令走 unity_execute（写通道）也不算只读放行。
    await expect(
      evaluateCombatToolExecution(
        probe('mcp__meka-unity__unity_execute', ['legacy_module_query_nodes', '10000'], SAGA2_UNITY_ROOT),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('服务器 supported 回执'),
    });
    // 未见导出证据时拒绝更早：由首证据门禁拦下（与上面四种是**不同**的门禁）。
    await expect(
      evaluateCombatToolExecution(unityInspect(['eval', 'return 1'], SAGA2_UNITY_ROOT)),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('第一条项目内容证据必须是老版模块编辑器'),
    });
    // 未注入白名单（老会话）时同样不放行，理由同样落在首证据门禁。
    await expect(
      evaluateCombatToolExecution(
        context(
          vendor({
            ...options,
            mekaCombatReadOnlyUnityCommands: undefined,
          }),
          {
            toolName: 'mcp__meka-unity__unity_inspect',
            input: {
              action: 'command',
              projectPath: SAGA2_UNITY_ROOT,
              arguments: ['legacy_module_query_nodes'],
            },
            action: { kind: 'mcp' as const },
          },
        ),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('第一条项目内容证据必须是老版模块编辑器'),
    });
  });

  it('has no reachable server-Worker channel while the session is a table scope (A5)', async () => {
    // A5 的前提：范围段不得命令模型「改走只读服务器 Worker」—— 表范围没有注入服务器路由键
    // （`mekaCombatServerRemoteHostId` / `…WorkerAgent` 只在绑定唯一技能 ID 时写入），
    // 而 create_worker 授权要求 remoteHostId 与注入值**相等**。
    const options = vendor({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatTargetExportCompleted: true,
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
      mekaCombatServerRemoteHostId: undefined,
      mekaCombatServerWorkerAgent: undefined,
      mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
      mekaCombatReadOnlyUnityCommands: COMBAT_READ_ONLY_UNITY_COMMANDS,
    });
    const dispatch = (vendorOptions: Record<string, unknown>) =>
      context(vendorOptions, {
        toolName: 'mcp__cindy_orca__create_worker',
        input: {
          initial_task:
            '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capability matrix residual gap',
          remote_host_id: 'mcpr:server-1',
          role: 'server',
          agent: 'codex',
          label: 'server-check',
        },
        action: { kind: 'mcp' as const },
      });
    await expect(evaluateCombatToolExecution(dispatch(options))).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('服务器核查 Worker 必须位于'),
    });
    // 对照：同一份派发在单技能绑定下不再被这条拒绝（说明拒绝确实来自「没有路由键」）。
    await expect(
      evaluateCombatToolExecution(
        dispatch(
          vendor({
            ...options,
            mekaCombatServerRemoteHostId: 'mcpr:server-1',
            mekaCombatServerWorkerAgent: 'codex',
          }),
        ),
      ),
    ).resolves.not.toMatchObject({ reason: expect.stringContaining('服务器核查 Worker 必须位于') });
  });

  it('records the agent own read-only scope query ids so membership stays enforceable (A4)', async () => {
    vi.mocked(runCombatEnvironmentGate).mockResolvedValue({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    // 真实生产形态：Agent 先用白名单只读查询解析出「在用集合」，用户随后才确认这个范围。
    const options = vendor({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatTargetExportCompleted: true,
      // 范围解析期：还没有服务器 supported 回执，只有白名单只读查询通道可用。
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
      mekaCombatScopeSkillIds: [],
      mekaCombatScopeSourceTables: ['saga2_json/MonsterSkill.json'],
      mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
      mekaCombatReadOnlyUnityCommands: COMBAT_READ_ONLY_UNITY_COMMANDS,
    });
    const unityInspect = (arguments_: unknown[]) =>
      context(options, {
        toolName: 'mcp__meka-unity__unity_inspect',
        input: { action: 'command', projectPath: SAGA2_UNITY_ROOT, arguments: arguments_ },
        action: { kind: 'mcp' as const },
      });
    const unityExecute = (arguments_: unknown[]) =>
      context(options, {
        toolName: 'mcp__meka-unity__unity_execute',
        input: { action: 'command', projectPath: SAGA2_UNITY_ROOT, arguments: arguments_ },
        action: { kind: 'mcp' as const },
      });

    // 只读查询放行，并登记其中显式给出的 `skill_ids`（去重 + 数值升序）。
    await expect(
      evaluateCombatToolExecution(
        unityInspect(['legacy_module_query_nodes', 'skill_ids=1020,1019', 'exclude_data=true']),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    expect(options.mekaCombatScopeSkillIds).toEqual(['1019', '1020']);
    await expect(
      evaluateCombatToolExecution(unityInspect(['legacy_module_query_nodes', 'skill_ids=20'])),
    ).resolves.toEqual({ behavior: 'allow' });
    expect(options.mekaCombatScopeSkillIds).toEqual(['20', '1019', '1020']);

    // 登记只发生在白名单查询通道上：写通道、其它只读命令、非本会话的路径都不登记。
    await expect(
      evaluateCombatToolExecution(unityExecute(['legacy_module_query_nodes', 'skill_ids=9999'])),
    ).resolves.toMatchObject({ behavior: 'deny' });
    await expect(
      evaluateCombatToolExecution(unityInspect(['legacy_module_audit_coverage', 'skill_ids=9998'])),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(unityInspect(['legacy_module_query_nodes', 'skill_ids=9997'])),
    ).resolves.toEqual({ behavior: 'allow' });
    expect(options.mekaCombatScopeSkillIds).toEqual(['20', '1019', '1020', '9997']);

    // 用户确认（真实审批补丁）之后冻结清单：再查询不得扩容。
    Object.assign(
      options,
      combatRequestScopeApprovalPatch({ prompt: '确认', previousVendorOptions: options }),
    );
    expect(options).toMatchObject({
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatScopeApproved: true,
    });
    await expect(
      evaluateCombatToolExecution(unityInspect(['legacy_module_query_nodes', 'skill_ids=9996'])),
    ).resolves.toEqual({ behavior: 'allow' });
    expect(options.mekaCombatScopeSkillIds).not.toContain('9996');
  });

  it('falls back to the per-call single-ID rule when the scope list is capped (A4)', async () => {
    vi.mocked(runCombatEnvironmentGate).mockResolvedValue({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    const options = vendor({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatTargetExportCompleted: true,
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
      mekaCombatScopeSkillIds: [],
      mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
      mekaCombatReadOnlyUnityCommands: COMBAT_READ_ONLY_UNITY_COMMANDS,
    });
    const manyIds = Array.from({ length: 201 }, (_, index) => String(2000 + index)).join(',');
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__meka-unity__unity_inspect',
          input: {
            action: 'command',
            projectPath: SAGA2_UNITY_ROOT,
            arguments: ['legacy_module_query_nodes', `skill_ids=${manyIds}`],
          },
          action: { kind: 'mcp' as const },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });

    const recorded = options.mekaCombatScopeSkillIds as string[];
    expect(recorded).toHaveLength(200);
    // 截断必须如实记录：部分清单不能当成成员白名单（否则范围里的 ID 会被误判成范围外）。
    expect(options.mekaCombatScopeSkillIdsTruncated).toBe(true);
    Object.assign(
      options,
      combatRequestScopeApprovalPatch({ prompt: '确认', previousVendorOptions: options }),
    );
    const importCall = (skillId: string) =>
      context(options, {
        toolName: 'mcp__meka-unity__unity_execute',
        input: {
          action: 'command',
          projectPath: SAGA2_UNITY_ROOT,
          arguments: [
            'legacy_module_import_json',
            skillId,
            path.join(os.tmpdir(), `${skillId}.import.json`),
            'true',
          ],
        },
        action: { kind: 'mcp' as const },
      });
    // 截断后按「无清单」口径：每次调用只允许一个 ID，不再比对成员资格。
    await expect(evaluateCombatToolExecution(importCall('2099'))).resolves.toEqual({
      behavior: 'allow',
    });
  });

  it('accepts only user-approved scope IDs after a table-scope confirmation', async () => {
    vi.mocked(runCombatEnvironmentGate).mockResolvedValue({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    // A4：成员清单**必须经真实路径产生**（Agent 自己的只读范围查询 → 用户确认），
    // 不再手写 `mekaCombatScopeSkillIds` —— 手写的话这条用例证明的是「手写的状态能用」，
    // 而不是「生产状态能用」。生产调用方是 register.ts 的续聊口子，链路里的三跳在这里
    // 逐一经过：表范围提案状态 → 只读查询登记 → 审批补丁确认。
    const options = vendor({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatTargetExportCompleted: true,
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
      mekaCombatScopeSkillIds: [],
      mekaCombatScopeSourceTables: ['saga2_json/MonsterSkill.json'],
      mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
      mekaCombatReadOnlyUnityCommands: COMBAT_READ_ONLY_UNITY_COMMANDS,
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__meka-unity__unity_inspect',
          input: {
            action: 'command',
            projectPath: SAGA2_UNITY_ROOT,
            arguments: ['legacy_module_query_nodes', 'skill_ids=1020,1019'],
          },
          action: { kind: 'mcp' as const },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    expect(options.mekaCombatScopeSkillIds).toEqual(['1019', '1020']);
    Object.assign(
      options,
      combatRequestScopeApprovalPatch({ prompt: '确认，就按这个范围执行', previousVendorOptions: options }),
    );
    expect(options).toMatchObject({
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatScopeApproved: true,
    });
    const exportCall = (skillId: string) =>
      context(options, {
        toolName: 'mcp__cindy__ghost_call',
        input: {
          ghost_id: 'meka-unity',
          tool: 'unity_execute',
          args: {
            action: 'command',
            projectPath: SAGA2_UNITY_ROOT,
            arguments: [
              'legacy_module_export_json',
              skillId,
              path.join(os.tmpdir(), `${skillId}.export.json`),
            ],
          },
        },
        action: { kind: 'mcp' as const },
      });

    // 已确认范围内：不触发单值目标门禁。
    await expect(evaluateCombatToolExecution(exportCall('1020'))).resolves.toEqual({
      behavior: 'allow',
    });
    // 已确认范围内的一次导出可以记为「已导出」证据（逐目标、每次一个 ID）。
    markCombatTargetExportCompleted({
      ...context(options, {
        toolName: 'mcp__cindy__ghost_call',
        input: {
          ghost_id: 'meka-unity',
          tool: 'unity_execute',
          args: {
            action: 'command',
            projectPath: SAGA2_UNITY_ROOT,
            arguments: [
              'legacy_module_export_json',
              '1020',
              path.join(os.tmpdir(), '1020.export.json'),
            ],
          },
        },
        action: { kind: 'mcp' as const },
      }),
    });
    expect(options).toMatchObject({ mekaCombatTargetExportCompleted: true });
    // 范围外：仍然拒绝，并指出可用的已确认范围。
    await expect(evaluateCombatToolExecution(exportCall('1021'))).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('范围外'),
    });
    // 未确认范围（approved=false）时，任何显式 ID 都不产生导出证据。
    const unapproved = vendor({
      ...options,
      mekaCombatScopeApproved: false,
      mekaCombatTargetExportCompleted: undefined,
      mekaCombatRequestScopeState: 'proposed',
    });
    markCombatTargetExportCompleted(
      context(unapproved, {
        toolName: 'mcp__cindy__ghost_call',
        input: {
          ghost_id: 'meka-unity',
          tool: 'unity_execute',
          args: {
            action: 'command',
            projectPath: SAGA2_UNITY_ROOT,
            arguments: [
              'legacy_module_export_json',
              '1020',
              path.join(os.tmpdir(), '1020.export.json'),
            ],
          },
        },
        action: { kind: 'mcp' as const },
      }),
    );
    expect(unapproved.mekaCombatTargetExportCompleted).toBeUndefined();
  });

  it('rejects a mixed-ID legacy module import where an in-scope JSON filename masks an out-of-scope skill (D1)', async () => {
    vi.mocked(runCombatEnvironmentGate).mockResolvedValue({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    // 成员清单经真实路径产生（Agent 自己的白名单只读查询 → 用户确认范围），范围 = {1019, 1020}。
    const options = vendor({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatTargetExportCompleted: true,
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
      mekaCombatScopeSkillIds: [],
      mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
      mekaCombatReadOnlyUnityCommands: COMBAT_READ_ONLY_UNITY_COMMANDS,
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__meka-unity__unity_inspect',
          input: {
            action: 'command',
            projectPath: SAGA2_UNITY_ROOT,
            arguments: ['legacy_module_query_nodes', 'skill_ids=1020,1019'],
          },
          action: { kind: 'mcp' as const },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    expect(options.mekaCombatScopeSkillIds).toEqual(['1019', '1020']);
    Object.assign(
      options,
      combatRequestScopeApprovalPatch({
        prompt: '确认，就按这个范围执行',
        previousVendorOptions: options,
      }),
    );
    expect(options).toMatchObject({ mekaCombatScopeApproved: true });
    // 生产形态：ghost_call → meka-unity unity_execute legacy_module_import_json。
    // `explicitCombatSkillIds` 会从 `<tmp>/1019.import.json` 这类 **JSON 文件名**里也收到一个 ID，
    // 所以「positional skill_id」与「文件名里的 ID」是两条互相独立的信号。
    const ghostImport = (skillId: string, jsonFileName: string) =>
      context(options, {
        toolName: 'mcp__cindy__ghost_call',
        input: {
          ghost_id: 'meka-unity',
          tool: 'unity_execute',
          args: {
            action: 'command',
            projectPath: SAGA2_UNITY_ROOT,
            arguments: [
              'legacy_module_import_json',
              skillId,
              path.join(os.tmpdir(), jsonFileName),
              'true',
            ],
          },
        },
        action: { kind: 'mcp' as const },
      });

    // 对照 1：范围外 ID，且 JSON 文件名也是同一个范围外 ID ⇒ 拒绝。
    await expect(
      evaluateCombatToolExecution(ghostImport('1021', '1021.import.json')),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('范围外'),
    });
    // 对照 2：合法请求（positional 与 JSON 文件名一致，且都在已确认范围内）⇒ 仍然放行。
    // 修复不得把这条真实工作流也一起拒掉。
    await expect(
      evaluateCombatToolExecution(ghostImport('1019', '1019.import.json')),
    ).resolves.toEqual({ behavior: 'allow' });
    // 缺陷形态：范围内 ID **只**出现在 JSON 文件名里，真正的 positional `skill_id` 是范围外的 1021。
    // 修复前这里会被放行，于是 `clear_existing=true` 的全量替换会把范围外技能 1021 的整个模块图
    // 按这个 payload 重写。
    await expect(
      evaluateCombatToolExecution(ghostImport('1021', '1019.import.json')),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('范围外'),
    });
    await expect(
      evaluateCombatToolExecution(ghostImport('1021', '1019.import.json')),
    ).resolves.toMatchObject({ reason: expect.stringContaining('1021') });
    // 同一形状的对称逃逸：范围内 ID 作 positional、范围外 ID 藏在文件名里 ⇒ 同样拒绝。
    await expect(
      evaluateCombatToolExecution(ghostImport('1019', '1021.import.json')),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('1021'),
    });
    // 合法形态的反向对照：两个 ID 都在确认范围内（positional 1019 + 文件名 1020）也必须拒绝 ——
    // 一次老版模块调用只允许一个已确认范围内的 ID，不因为「都在范围内」就放宽（D1 的第二处收紧）。
    await expect(
      evaluateCombatToolExecution(ghostImport('1019', '1020.import.json')),
    ).resolves.toMatchObject({
      behavior: 'deny',
    });
    // 对照 3：同一个混合 ID 请求在单技能会话里本来就被拒（单技能分支一直用 `mismatched.length > 0`）。
    const singleSkill = vendor({
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatTargetExportCompleted: true,
      mekaCombatServerCapabilityStatus: 'supported',
    });
    await expect(
      evaluateCombatToolExecution(
        context(singleSkill, {
          toolName: 'mcp__cindy__ghost_call',
          input: {
            ghost_id: 'meka-unity',
            tool: 'unity_execute',
            args: {
              action: 'command',
              projectPath: SAGA2_UNITY_ROOT,
              arguments: [
                'legacy_module_import_json',
                '1021',
                path.join(os.tmpdir(), '1019.import.json'),
                'true',
              ],
            },
          },
          action: { kind: 'mcp' as const },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('1021'),
    });
    // A4 登记过的折中：已批准但成员清单不可信（截断）时**不做**成员资格比对，只要求每次恰好一个
    // 显式 ID —— 这个 `withoutList` 分支的行为不得被本次收紧改变（所以这个范围外 ID 仍然放行）。
    const withoutList = vendor({
      ...options,
      mekaCombatScopeSkillIds: [],
      mekaCombatScopeSkillIdsTruncated: true,
    });
    await expect(
      evaluateCombatToolExecution(
        context(withoutList, {
          toolName: 'mcp__cindy__ghost_call',
          input: {
            ghost_id: 'meka-unity',
            tool: 'unity_execute',
            args: {
              action: 'command',
              projectPath: SAGA2_UNITY_ROOT,
              arguments: [
                'legacy_module_import_json',
                '1021',
                path.join(os.tmpdir(), '1021.import.json'),
                'true',
              ],
            },
          },
          action: { kind: 'mcp' as const },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
  });

  it('denies unregistered legacy module write commands and keeps the whitelisted import (D3)', async () => {
    vi.mocked(runCombatEnvironmentGate).mockResolvedValue({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    const unityExecute = (options: Record<string, unknown>, arguments_: unknown[]) =>
      context(options, {
        toolName: 'mcp__meka-unity__unity_execute',
        input: { action: 'command', projectPath: SAGA2_UNITY_ROOT, arguments: arguments_ },
        action: { kind: 'mcp' as const },
      });
    const ghostExecute = (options: Record<string, unknown>, arguments_: unknown[]) =>
      context(options, {
        toolName: 'mcp__cindy__ghost_call',
        input: {
          ghost_id: 'meka-unity',
          tool: 'unity_execute',
          args: { action: 'command', projectPath: SAGA2_UNITY_ROOT, arguments: arguments_ },
        },
        action: { kind: 'mcp' as const },
      });
    // 形态 1：单技能已确认目标 + supported。其余写入门禁全部满足，因此拒绝只能来自命令面白名单。
    const singleSkill = vendor({
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatTargetExportCompleted: true,
      mekaCombatServerCapabilityStatus: 'supported',
    });
    for (const call of [
      unityExecute(singleSkill, ['legacy_module_migrate_layers']),
      unityExecute(singleSkill, ['legacy_module_migrate_layers', '--from', '0', '--to', '1']),
      ghostExecute(singleSkill, ['legacy_module_migrate_layers']),
      // 不是「只拉黑一个名字」：任何未登记的 `legacy_module_*` 写命令都不放行。
      unityExecute(singleSkill, ['legacy_module_rebuild_all']),
      // 不存在于任何地方的「创建空白资产」命令同样不放行。
      unityExecute(singleSkill, ['legacy_module_prepare_asset', '1019']),
      // 直连 meka-unity 运行时 MCP 的 `{ name, args }` 形态（`CallToolRequest` 原样透传）——
      // 既有 `mcpToolArguments` 在这种形态下解不出命令，这条门禁必须自己认，否则该通道放行。
      context(singleSkill, {
        toolName: 'mcp__meka-unity__unity_execute',
        input: {
          name: 'unity_execute',
          args: {
            action: 'command',
            projectPath: SAGA2_UNITY_ROOT,
            arguments: ['legacy_module_migrate_layers'],
          },
        },
        action: { kind: 'mcp' as const },
      }),
    ]) {
      await expect(evaluateCombatToolExecution(call)).resolves.toMatchObject({
        behavior: 'deny',
        reason: expect.stringContaining('登记过的模块写入命令只有 legacy_module_import_json'),
      });
    }
    // 形态 2：已批准表范围 + project-reference（reviewer 测到的另一个「allow」形态）。
    const approvedTableScope = vendor({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatTargetExportCompleted: true,
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatScopeApproved: true,
      mekaCombatScopeSkillIds: [],
      mekaCombatEvidenceBasis: 'project-reference',
      mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
    });
    await expect(
      evaluateCombatToolExecution(ghostExecute(approvedTableScope, ['legacy_module_migrate_layers'])),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('登记过的模块写入命令只有 legacy_module_import_json'),
    });
    // 白名单写入仍然放行：全量替换单个技能是本次交付唯一需要的写通道。
    await expect(
      evaluateCombatToolExecution(
        unityExecute(singleSkill, [
          'legacy_module_import_json',
          '1019',
          path.join(os.tmpdir(), '1019.import.json'),
          'true',
        ]),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    // 目标导出（只读回读）不被这条拦。
    await expect(
      evaluateCombatToolExecution(
        unityExecute(singleSkill, [
          'legacy_module_export_json',
          '1019',
          path.join(os.tmpdir(), '1019.export.json'),
        ]),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    // Host 注入的只读查询白名单命令不被这条拦：它的拒绝理由（这里）必须仍来自下游的服务器回执门禁，
    // 证明这条新门禁只收「未登记的模块命令」，没有顺手收紧范围解析通道。
    const withEvidence = vendor({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatTargetExportCompleted: true,
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
      mekaCombatScopeSkillIds: [],
      mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
      mekaCombatReadOnlyUnityCommands: COMBAT_READ_ONLY_UNITY_COMMANDS,
    });
    await expect(
      evaluateCombatToolExecution(
        context(withEvidence, {
          toolName: 'mcp__meka-unity__unity_execute',
          input: {
            action: 'command',
            projectPath: SAGA2_UNITY_ROOT,
            arguments: ['legacy_module_query_nodes', '10000'],
          },
          action: { kind: 'mcp' as const },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('服务器 supported 回执'),
    });
  });

  it('consumes the legacy module receipts and blocks the turn on a lossy full-replacement import (D2)', async () => {
    vi.mocked(runCombatEnvironmentGate).mockResolvedValue({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    const optionsBySession = new Map<string, Record<string, unknown>>();
    const options = (sessionId: string) => {
      const existing = optionsBySession.get(sessionId);
      if (existing) return existing;
      const created = vendor({
        mekaCombatTargetSkillId: '1019',
        mekaCombatTargetSkillIdState: 'confirmed',
        mekaCombatTargetExportCompleted: true,
        mekaCombatServerCapabilityStatus: 'supported',
        mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
      });
      optionsBySession.set(sessionId, created);
      return created;
    };
    const moduleCall = (sessionId: string, arguments_: unknown[]) =>
      context(options(sessionId), {
        sessionId,
        toolName: 'mcp__cindy__ghost_call',
        input: {
          ghost_id: 'meka-unity',
          tool: 'unity_execute',
          args: { action: 'command', projectPath: SAGA2_UNITY_ROOT, arguments: arguments_ },
        },
        action: { kind: 'mcp' as const },
      });
    // 「导入之后的下一步」用一个本来一定放行的只读调用代表：Host 注入的项目参考单文件读取。
    const nextStep = (sessionId: string) =>
      context(options(sessionId), {
        sessionId,
        toolName: 'Read',
        action: { kind: 'read' as const, path: COMBAT_PROJECT_REF_PATHS[0]! },
      });
    const exportCall = (sessionId: string) =>
      moduleCall(sessionId, [
        'legacy_module_export_json',
        '1019',
        path.join(os.tmpdir(), '1019.export.json'),
      ]);
    const importCall = (sessionId: string) =>
      moduleCall(sessionId, [
        'legacy_module_import_json',
        '1019',
        path.join(os.tmpdir(), '1019.import.json'),
        'true',
      ]);
    // 真实回执形态：导入 `success / skillId / importedNodeCount / clearExisting / sourcePath / message`，
    // 导出 `success / skillId / exportedNodeCount / targetPath / message`（见 SKILL.md 与迁移文档）。
    const exportReceipt = (exportedNodeCount: number) => ({
      ok: true,
      result: {
        success: true,
        skillId: '1019',
        exportedNodeCount,
        targetPath: path.join(os.tmpdir(), '1019.export.json'),
        message: 'ok',
      },
    });
    const importReceipt = (importedNodeCount: number) => ({
      ok: true,
      result: {
        data: {
          success: true,
          skillId: '1019',
          importedNodeCount,
          clearExisting: true,
          sourcePath: path.join(os.tmpdir(), '1019.import.json'),
          message: 'ok',
        },
      },
    });

    // ── 有损导入：写入前 696 节点，payload 只带回 669 ────────────────────────────────
    const lossy = 'combat-d2-lossy';
    await expect(evaluateCombatToolExecution(exportCall(lossy))).resolves.toEqual({
      behavior: 'allow',
    });
    observeCombatLegacyModuleResult(exportCall(lossy), exportReceipt(696));
    await expect(evaluateCombatToolExecution(importCall(lossy))).resolves.toEqual({
      behavior: 'allow',
    });
    observeCombatLegacyModuleResult(importCall(lossy), importReceipt(669));
    // 修复前：没有任何 Host 消费者读这两个数字，下一步照常放行（丢 27 个节点静默成功）。
    await expect(evaluateCombatToolExecution(nextStep(lossy))).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('写入前导出的节点数基线 696'),
    });
    await expect(evaluateCombatToolExecution(nextStep(lossy))).resolves.toMatchObject({
      reason: expect.stringContaining('importedNodeCount 669'),
    });
    await expect(evaluateCombatToolExecution(nextStep(lossy))).resolves.toMatchObject({
      reason: expect.stringContaining('legacy_module_export_json'),
    });
    await expect(evaluateCombatToolExecution(nextStep(lossy))).resolves.toMatchObject({
      reason: expect.stringContaining('1019'),
    });
    // Shell 通道也不能绕开这条义务：回读走 Unity MCP，Shell 上没有豁免形态。
    expect(
      evaluateCombatShellCommandExecution(
        context(options(lossy), {
          sessionId: lossy,
          toolName: 'exec',
          action: {
            kind: 'exec' as const,
            command: `Get-Content -LiteralPath '${SAGA2_UNITY_AGENTS_PATH}'`,
          },
        }),
      ),
    ).toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('写入前导出的节点数基线 696'),
    });
    // 义务未结清时连「换一个技能 / 换一条通道」都不行：只放行同一技能的回读与重新导入。
    await expect(
      evaluateCombatToolExecution(
        moduleCall(lossy, [
          'legacy_module_import_json',
          '1020',
          path.join(os.tmpdir(), '1020.import.json'),
          'true',
        ]),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
    // 结构化回读（数字与导入回执一致）⇒ 结清，下一步恢复放行。
    await expect(evaluateCombatToolExecution(exportCall(lossy))).resolves.toEqual({
      behavior: 'allow',
    });
    observeCombatLegacyModuleResult(exportCall(lossy), exportReceipt(669));
    await expect(evaluateCombatToolExecution(nextStep(lossy))).resolves.toEqual({
      behavior: 'allow',
    });

    // ── 无损导入：节点数与基线一致 ⇒ 不产生回读义务 ────────────────────────────────
    const lossless = 'combat-d2-lossless';
    observeCombatLegacyModuleResult(exportCall(lossless), exportReceipt(700));
    await expect(evaluateCombatToolExecution(importCall(lossless))).resolves.toEqual({
      behavior: 'allow',
    });
    observeCombatLegacyModuleResult(importCall(lossless), importReceipt(700));
    await expect(evaluateCombatToolExecution(nextStep(lossless))).resolves.toEqual({
      behavior: 'allow',
    });

    // ── 缺基线：Host 无法证明本次 payload 无损 ⇒ 如实说明并要求回读，不编造通过 ────────
    const noBaseline = 'combat-d2-no-baseline';
    await expect(evaluateCombatToolExecution(importCall(noBaseline))).resolves.toEqual({
      behavior: 'allow',
    });
    observeCombatLegacyModuleResult(importCall(noBaseline), importReceipt(669));
    await expect(evaluateCombatToolExecution(nextStep(noBaseline))).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('未建立'),
    });
    // 回读补齐基线并与导入回执一致 ⇒ 结清。
    observeCombatLegacyModuleResult(exportCall(noBaseline), exportReceipt(669));
    await expect(evaluateCombatToolExecution(nextStep(noBaseline))).resolves.toEqual({
      behavior: 'allow',
    });

    // ── 回读与导入回执不一致 ⇒ 说明落盘结果与导入回执不是同一份事实，继续拦截 ──────────
    const readBackMismatch = 'combat-d2-readback-mismatch';
    observeCombatLegacyModuleResult(exportCall(readBackMismatch), exportReceipt(696));
    observeCombatLegacyModuleResult(importCall(readBackMismatch), importReceipt(669));
    observeCombatLegacyModuleResult(exportCall(readBackMismatch), exportReceipt(700));
    await expect(evaluateCombatToolExecution(nextStep(readBackMismatch))).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('与导入回执不一致'),
    });
    await expect(evaluateCombatToolExecution(nextStep(readBackMismatch))).resolves.toMatchObject({
      reason: expect.stringContaining('700'),
    });

    // ── 回执里没有可解析的节点数 ⇒ 不伪造基线 ────────────────────────────────────────
    // 只调用「导出尝试 / 导出完成」记录器（它们拿不到真实回执）**不得**产生基线：
    // 否则有损导入就会拿一个编造出来的数字去比对。
    const attemptedOnly = 'combat-d2-attempted-only';
    markCombatTargetExportCompleted(exportCall(attemptedOnly));
    markCombatTargetExportAttempted(exportCall(attemptedOnly));
    observeCombatLegacyModuleResult(importCall(attemptedOnly), importReceipt(669));
    await expect(evaluateCombatToolExecution(nextStep(attemptedOnly))).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('未建立'),
    });
    // 回执里没有 exportedNodeCount 时同样不写基线（`legacyModuleExport` 内联 payload 也没有节点数组）。
    const unparseable = 'combat-d2-unparseable-receipt';
    observeCombatLegacyModuleResult(exportCall(unparseable), {
      ok: true,
      result: { success: true, skillId: '1019', message: 'ok' },
    });
    observeCombatLegacyModuleResult(importCall(unparseable), importReceipt(669));
    await expect(evaluateCombatToolExecution(nextStep(unparseable))).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('未建立'),
    });

    // ── 直连 meka-unity 运行时 MCP 的 `{ name, args }` 形态同样被消费 ────────────────────
    // `meka-runtime-mcp` 的 `CallToolRequestSchema` 原样透传 MCP `CallToolRequest`，参数在
    // `input.args` 一层里；既有 `mcpToolArguments` 在这种形态下解不出命令，因此对账入口必须自己
    // 认这个形态，否则这条通道上的导入仍然是「零消费者」。
    const runtime = 'combat-d2-runtime-mcp';
    const runtimeCall = (name: string, arguments_: unknown[]) =>
      context(options(runtime), {
        sessionId: runtime,
        toolName: `mcp__meka-unity__${name}`,
        input: { name, args: { action: 'command', projectPath: SAGA2_UNITY_ROOT, arguments: arguments_ } },
        action: { kind: 'mcp' as const },
      });
    observeCombatLegacyModuleResult(
      runtimeCall('unity_execute', [
        'legacy_module_export_json',
        '1019',
        path.join(os.tmpdir(), '1019.export.json'),
      ]),
      { content: [{ type: 'text', text: JSON.stringify({ success: true, skillId: '1019', exportedNodeCount: 696 }) }] },
    );
    observeCombatLegacyModuleResult(
      runtimeCall('unity_execute', [
        'legacy_module_import_json',
        '1019',
        path.join(os.tmpdir(), '1019.import.json'),
        'true',
      ]),
      { content: [{ type: 'text', text: JSON.stringify({ success: true, skillId: '1019', importedNodeCount: 669 }) }] },
    );
    await expect(evaluateCombatToolExecution(nextStep(runtime))).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('写入前导出的节点数基线 696'),
    });
    // 内联 `legacyModuleExport.payload` 也是合法基线来源（插件把导出 payload 内联在回执里）。
    const inline = 'combat-d2-inline-payload';
    observeCombatLegacyModuleResult(exportCall(inline), {
      ok: true,
      result: {
        success: true,
        skillId: '1019',
        legacyModuleExport: { payload: { nodes: [{ id: 1 }, { id: 2 }] } },
      },
    });
    observeCombatLegacyModuleResult(importCall(inline), importReceipt(1));
    await expect(evaluateCombatToolExecution(nextStep(inline))).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('写入前导出的节点数基线 2'),
    });
  });

  it('re-seeds the live session from the scope mirror so prompt and policy cannot disagree (D6/D7)', async () => {
    vi.mocked(runCombatEnvironmentGate).mockResolvedValue({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    resetCombatVendorOptionsMirrorForTests();
    const sessionId = 'combat-d6-resume';
    // 镜像 = Host 真正注入并落地的战斗键（bootstrap / resume 的计划层 + onAccepted 写入）。
    rememberCombatVendorOptions(sessionId, {
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatScopeApproved: true,
      mekaCombatScopeSkillIds: ['1019', '1020'],
      mekaCombatTargetExportCompleted: true,
    });
    // Session 被重建（lazy-create / 从渲染进程排队快照 rehydrate）：实时 vendorOptions 里没有范围
    // 状态键，只剩每轮都会重算的注入键。
    const live = vendor({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatRequestScope: undefined,
      mekaCombatRequestScopeState: undefined,
      mekaCombatScopeApproved: undefined,
      mekaCombatTargetExportCompleted: undefined,
      mekaCombatServerCapabilityStatus: 'supported',
      mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
      mekaCombatReadOnlyUnityCommands: COMBAT_READ_ONLY_UNITY_COMMANDS,
    });
    // 续聊口子只看镜像 ⇒ 提示词说「范围已批准，逐目标实施」。
    const followup = await prepareCombatFollowupRuntimeContext({
      prompt: '继续',
      projectId: 'saga2',
      workingDir: SAGA2_PROJECT_ROOT,
      sessionId,
      previousVendorOptions: readCombatVendorOptions(sessionId),
    });
    expect(followup?.promptSection).toContain('scopeApproved: true（用户已确认范围）');
    const scopeQuery = context(live, {
      sessionId,
      toolName: 'mcp__meka-unity__unity_inspect',
      input: {
        action: 'command',
        projectPath: SAGA2_UNITY_ROOT,
        arguments: ['legacy_module_query_nodes', 'skill_ids=1020,1019'],
      },
      action: { kind: 'mcp' as const },
    });
    // 同一个 turn 里，策略层读**实时**状态 ⇒ 没有范围键，退回单技能分支，把同一条只读范围查询
    // 也拒掉（D6 的分裂：提示词让模型逐目标实施，Host 却要求一个单值技能 ID，而 SKILL 禁止向
    // 表范围请求索要单个技能 ID）。
    await expect(evaluateCombatToolExecution(scopeQuery)).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('缺少用户明确提供的正整数技能 ID'),
    });
    // 还原补丁只覆盖「纯注入语义、不会被策略层就地扩展」的范围状态键。
    const restore = combatScopeStateRestorePatch(sessionId);
    expect(restore).toMatchObject({
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatScopeApproved: true,
    });
    // 成员清单是策略层就在实时对象上累加的（recordCombatScopeSkillIds），导出证据记录器同理：
    // 镜像里这两者可能更旧，绝不能写回，否则成员资格比对会退化成「无清单」口径 —— 削弱门禁。
    expect(restore).not.toHaveProperty('mekaCombatScopeSkillIds');
    expect(restore).not.toHaveProperty('mekaCombatTargetExportCompleted');
    expect(combatScopeStateRestorePatch('combat-d6-unknown')).toEqual({});
    // 调度前把补丁写回实时 Session（register.ts 的续聊口子）⇒ 两层一致：这条表范围只读查询放行。
    Object.assign(live, restore);
    await expect(evaluateCombatToolExecution(scopeQuery)).resolves.toEqual({ behavior: 'allow' });
    // D7：终态关闭丢弃镜像 ⇒ 两层一起回落到「未知」，不会再各说一套。
    forgetCombatVendorOptions(sessionId);
    expect(readCombatVendorOptions(sessionId)).toBeNull();
    expect(combatScopeStateRestorePatch(sessionId)).toEqual({});
  });

  it('lets an ask_user_question card answer unlock the table scope the user actually confirmed (D8)', async () => {
    vi.mocked(runCombatEnvironmentGate).mockResolvedValue({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    const sessionId = 'combat-card-approval-1';
    resetCombatVendorOptionsMirrorForTests();
    // 真实会话现场（6811f297）：表范围已由用户提出、等待确认；Host 手上还没有成员清单
    // （Agent 的只读范围查询要么没做，要么清单被截断）。
    rememberCombatVendorOptions(sessionId, {
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
    });
    const live = vendor({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatTargetExportCompleted: undefined,
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
      mekaCombatScopeSkillIds: [],
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatEvidenceBasis: 'project-reference',
      mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
      mekaCombatReadOnlyUnityCommands: COMBAT_READ_ONLY_UNITY_COMMANDS,
    });
    const exportCallFor = (options: Record<string, unknown>) =>
      context(options, {
        sessionId,
        toolName: 'mcp__cindy__ghost_call',
        input: {
          ghost_id: 'meka-unity',
          tool: 'unity_execute',
          args: {
            action: 'command',
            projectPath: SAGA2_UNITY_ROOT,
            arguments: [
              'legacy_module_export_json',
              '3001064',
              path.join(os.tmpdir(), '3001064.export.json'),
            ],
          },
        },
        action: { kind: 'mcp' as const },
      });
    const exportCall = () => exportCallFor(live);
    // 缺陷现场：用户已经答过卡片，但审批门禁只认聊天消息 ⇒ 范围里空无一人，导出被拒。
    await expect(evaluateCombatToolExecution(exportCall())).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('尚未确认任何技能'),
    });

    // register.ts 的卡片答案观察者形状：逐个答案求补丁，命中即停（答案 key 是问题文本）。
    const cardAnswerPatch = (answers: Record<string, string>) => {
      const previousVendorOptions = readCombatVendorOptions(sessionId);
      for (const answer of Object.values(answers)) {
        const patch = combatRequestScopeAnswerApprovalPatch({ answer, previousVendorOptions });
        if (patch) return patch;
      }
      return null;
    };

    // 用户真实答案（卡片选项原文）：确认只改伤害节点、技能表参数不动。
    const confirmed = cardAnswerPatch({
      '这次改动按哪个范围执行？': '确认：只改这 15 个伤害节点，技能表参数先不动',
    });
    expect(confirmed).toMatchObject({
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatScopeApproved: true,
      mekaCombatEvidenceBasis: 'project-reference',
    });
    if (!confirmed) throw new Error('card answer must produce a scope approval patch');
    // 与生产 wiring 同序：先记镜像，再把同一份补丁写进实时 vendorOptions。
    rememberCombatVendorOptions(sessionId, confirmed);
    Object.assign(live, confirmed);
    // 同一轮里后续的策略判定的确放行（此前是「尚未确认任何技能」）。
    await expect(evaluateCombatToolExecution(exportCall())).resolves.toEqual({ behavior: 'allow' });

    // 拒绝项：不产生补丁 ⇒ 范围仍然未确认，导出继续被拒。
    resetCombatVendorOptionsMirrorForTests();
    rememberCombatVendorOptions(sessionId, {
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
    });
    const refusedOptions = vendor({
      ...live,
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
    });
    expect(
      cardAnswerPatch({
        '这次改动按哪个范围执行？': '先不执行，我要调整范围或数值',
      }),
    ).toBeNull();
    // 系统性 dismissal（会话 abort / 关闭等自动空答）同样不产生补丁。
    expect(cardAnswerPatch({ '这次改动按哪个范围执行？': '' })).toBeNull();
    await expect(
      evaluateCombatToolExecution(exportCallFor(refusedOptions)),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('尚未确认任何技能'),
    });
    forgetCombatVendorOptions(sessionId);
  });

  it('requires the server supported report only when the evidence basis is not the injected project reference', async () => {
    vi.mocked(runCombatEnvironmentGate).mockResolvedValue({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    const approvedTableScope = vendor({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatTargetExportCompleted: true,
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatScopeApproved: true,
      // A4：清单缺失是**兜底形态**（用户直接批准、Agent 没走过带 `skill_ids` 的只读范围
      // 查询，或清单被截断）；此时按「每次一个 ID + 已确认范围」约束。正常路径下清单由
      // `recordCombatScopeSkillIds` 从 Agent 自己的只读查询登记（见上一个用例）。
      mekaCombatScopeSkillIds: [],
      mekaCombatEvidenceBasis: 'project-reference',
      mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
    });
    const importCall = (options: Record<string, unknown>, skillId = '1019') =>
      context(options, {
        toolName: 'mcp__meka-unity__unity_execute',
        input: {
          action: 'command',
          projectPath: SAGA2_UNITY_ROOT,
          arguments: [
            'legacy_module_import_json',
            skillId,
            path.join(os.tmpdir(), `${skillId}.import.json`),
            'true',
          ],
        },
        action: { kind: 'mcp' as const },
      });

    // 已批准范围 + 注入的项目参考覆盖 ⇒ 写入不要求 supported 回执（其余门禁照旧）。
    await expect(evaluateCombatToolExecution(importCall(approvedTableScope))).resolves.toEqual({
      behavior: 'allow',
    });
    // 未记录 project-reference 依据 ⇒ 回到服务器回执要求。
    await expect(
      evaluateCombatToolExecution(
        importCall(vendor({ ...approvedTableScope, mekaCombatEvidenceBasis: undefined })),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('supported 回执'),
    });
    // 没有注入项目参考（无覆盖）⇒ 回到服务器回执要求。
    await expect(
      evaluateCombatToolExecution(
        importCall(vendor({ ...approvedTableScope, mekaCombatProjectRefPaths: [] })),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('supported 回执'),
    });
    // 范围未获用户批准 ⇒ 不豁免（且显式 ID 直接被范围门禁拒绝）。
    await expect(
      evaluateCombatToolExecution(
        importCall(
          vendor({
            ...approvedTableScope,
            mekaCombatScopeApproved: false,
            mekaCombatRequestScopeState: 'proposed',
          }),
        ),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
    // 单技能在目标**未确认**时仍不放行写入（本用例沿用 approvedTableScope 的
    // `TargetSkillIdState: 'missing'`；目标由用户确认后由 `combatEvidenceBasisPatch` 写入
    // project-reference，见「applies the same project-reference evidence basis…」用例）。
    await expect(
      evaluateCombatToolExecution(
        importCall(
          vendor({
            ...approvedTableScope,
            mekaCombatRequestScope: 'single-skill',
            mekaCombatTargetSkillId: '1019',
          }),
        ),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('supported 回执'),
    });
    // 服务器报告给出 unsupported（参考与需求冲突的信号）⇒ 仍然拦住实施。
    await expect(
      evaluateCombatToolExecution(
        importCall(
          vendor({ ...approvedTableScope, mekaCombatServerCapabilityStatus: 'unsupported' }),
        ),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('尚不支持或证据不确定'),
    });
  });

  it('applies the same project-reference evidence basis to a confirmed single skill', async () => {
    vi.mocked(runCombatEnvironmentGate).mockResolvedValue({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    const singleSkill = vendor({
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatTargetExportCompleted: true,
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatEvidenceBasis: 'project-reference',
      mekaCombatProjectRefPaths: COMBAT_PROJECT_REF_PATHS,
    });
    const importCall = (options: Record<string, unknown>, skillId = '1019') =>
      context(options, {
        toolName: 'mcp__meka-unity__unity_execute',
        input: {
          action: 'command',
          projectPath: SAGA2_UNITY_ROOT,
          arguments: [
            'legacy_module_import_json',
            skillId,
            path.join(os.tmpdir(), `${skillId}.import.json`),
            'true',
          ],
        },
        action: { kind: 'mcp' as const },
      });

    // 目标由用户确认 + 参考已注入 ⇒ 与表范围同口径：不要求 supported 回执。
    await expect(evaluateCombatToolExecution(importCall(singleSkill))).resolves.toEqual({
      behavior: 'allow',
    });
    // 目标未经用户确认：仍要求 supported 回执。
    await expect(
      evaluateCombatToolExecution(
        importCall(vendor({ ...singleSkill, mekaCombatTargetSkillIdState: 'ambiguous' })),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('supported 回执'),
    });
    // 参考未注入（无覆盖）：仍要求 supported 回执。
    await expect(
      evaluateCombatToolExecution(
        importCall(vendor({ ...singleSkill, mekaCombatProjectRefPaths: [] })),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('supported 回执'),
    });
    // 没有 Host 写入的 project-reference 依据：仍要求 supported 回执。
    await expect(
      evaluateCombatToolExecution(
        importCall(vendor({ ...singleSkill, mekaCombatEvidenceBasis: undefined })),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('supported 回执'),
    });
    // unsupported / uncertain（参考与需求冲突的信号）：仍然拒绝写入。
    for (const status of ['unsupported', 'uncertain']) {
      await expect(
        evaluateCombatToolExecution(
          importCall(vendor({ ...singleSkill, mekaCombatServerCapabilityStatus: status })),
        ),
      ).resolves.toMatchObject({
        behavior: 'deny',
        reason: expect.stringContaining('尚不支持或证据不确定'),
      });
    }
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
            path: path.join(SAGA2_UNITY_ROOT, 'Temp', '123.import.json'),
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
            path: path.join(SAGA2_DESIGN_ROOT, 'planning', 'draft.md'),
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
            path: path.join(SAGA2_STRAY_UNITY_ROOT, 'Assets', 'Editor', 'SkillEditor', 'Skill', 'Saved Data', '123.asset'),
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
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Select-String -Path '${SAGA2_UNITY_ROLE_SKILL_RELATIVE_PATH}' -Pattern '预警|伤害' -Context 20,20"`;
    const directReadOnlyCommand =
      `Select-String -LiteralPath '${SAGA2_UNITY_ROLE_SKILL_RELATIVE_PATH}' -Pattern '预警|伤害' -Context 20,20`;
    const directFileRead =
      `Get-Content -LiteralPath '${SAGA2_UNITY_ROLE_SKILL_RELATIVE_PATH}' -Raw`;
    for (const command of [wrappedReadOnlyCommand, directReadOnlyCommand, directFileRead]) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            toolName: 'exec',
            action: {
              kind: 'exec',
              command,
              cwd: SAGA2_PROJECT_ROOT,
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
      directReadOnlyCommand.replace('saga2_unity', path.join('..', 'saga2_design')),
      directReadOnlyCommand.replace(
        path.join('Assets', 'Scripts', 'Hot', 'Game', 'Room', 'Role', 'RoomRoleSkill.cs'),
        path.join('.agents', 'skills', 'editor-skill-editor-module', 'SKILL.md'),
      ),
      `${directFileRead}; Set-Content hacked.txt x`,
      directFileRead.replace('RoomRoleSkill.cs', '*.cs'),
    ]) {
      expect(
        evaluateCombatShellCommandExecution(
          context(options, {
            toolName: 'exec',
            action: { kind: 'exec', command, cwd: SAGA2_PROJECT_ROOT },
          }),
        ),
      ).toMatchObject({ behavior: 'deny' });
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
            cwd: SAGA2_PROJECT_ROOT,
          },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });

    for (const command of [
      readSkillCommand.replace('$s.Length; $s', '$s.Length; Set-Content hacked.txt x; $s'),
      readSkillCommand.replace('SKILL.md', 'reference.md'),
      readSkillCommand.replace(revision, '..'),
    ]) {
      expect(
        evaluateCombatShellCommandExecution(
          context(options, {
            toolName: 'exec',
            action: {
              kind: 'exec',
              command,
              cwd: SAGA2_PROJECT_ROOT,
            },
          }),
        ),
      ).toMatchObject({ behavior: 'deny' });
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
              cwd: SAGA2_PROJECT_ROOT,
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
      `Get-Content -Raw '${SAGA2_WORKSPACE_AGENTS_PATH}'`,
      `Get-Content -Raw '${path.join(SAGA2_UNITY_ROOT, 'Assets', 'Editor', 'SkillEditor', 'skill_entry_model_editor.json')}'`,
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

    expect(
      evaluateCombatShellCommandExecution(
        context(options, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command: lineCountCommand,
            cwd: SAGA2_PROJECT_ROOT,
          },
        }),
      ),
    ).toMatchObject({ behavior: 'deny' });

    for (const command of [
      lineCountCommand.replace('Write-Output', 'Set-Content result.txt'),
      lineCountCommand.replace('SKILL.md', 'reference.md'),
      lineCountCommand.replace('Measure-Object -Line', 'Measure-Object -Line; Remove-Item x'),
    ]) {
      expect(
        evaluateCombatShellCommandExecution(
          context(options, {
            toolName: 'exec',
            action: {
              kind: 'exec',
              command,
              cwd: SAGA2_PROJECT_ROOT,
            },
          }),
        ),
      ).toMatchObject({ behavior: 'deny' });
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
            cwd: SAGA2_PROJECT_ROOT,
          },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });

    for (const command of [
      countCommand.replace(').Count', '); Set-Content hacked.txt x'),
      countCommand.replace('SKILL.md', 'reference.md'),
      countCommand.replace(revision, '..'),
    ]) {
      expect(
        evaluateCombatShellCommandExecution(
          context(options, {
            toolName: 'exec',
            action: {
              kind: 'exec',
              command,
              cwd: SAGA2_PROJECT_ROOT,
            },
          }),
        ),
      ).toMatchObject({ behavior: 'deny' });
    }
  });

  it('allows Unity CLI inspection and Unity CLI mutations once the environment gate is fresh', async () => {
    const options = vendor();
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__meka-unity__unity_inspect',
          input: {
            action: 'status',
            projectPath: SAGA2_UNITY_ROOT,
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
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
          input: { action: 'command', arguments: ['set_node'] },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
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
            projectPath: SAGA2_UNITY_ROOT,
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
            projectPath: SAGA2_UNITY_ROOT,
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
            projectPath: SAGA2_UNITY_ROOT,
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
    const options = vendor({ mekaCombatPlanApproved: true });
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

  it('never caps read-only evidence calls for a remote server worker', async () => {
    const options = vendor({
      mekaWorkflow: 'saga2-combat-server-worker-v1',
      orcaLeadSessionId: 'lead-unbounded-1',
    });
    for (let index = 0; index < 12; index += 1) {
      await expect(
        evaluateCombatToolExecution(
          context(options, {
            remoteHostId: 'mcpr:server-1',
            action: { kind: 'exec', command: 'git status --short' },
          }),
        ),
      ).resolves.toEqual({ behavior: 'allow' });
    }
  });

  it('keeps read-only work available after a server capability report requires programmer handoff', async () => {
    const options = vendor({
      mekaCombatServerCapabilityStatus: 'unsupported',
      mekaCombatPhase: 'server-programmer-handoff',
    });
    await expect(evaluateCombatToolExecution(context(options))).resolves.toEqual({
      behavior: 'allow',
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
    const options = vendor({ mekaCombatPlanApproved: true });
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

  it('recognizes only the exact read-only P4 status call from Codex code-mode approval metadata', async () => {
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
    expect(runCombatEnvironmentGate).not.toHaveBeenCalled();
    vi.mocked(runCombatEnvironmentGate).mockResolvedValueOnce({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityCli: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
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
    ).resolves.toEqual({ behavior: 'allow' });
    // A P4 mutation is not a read-only exemption: it must re-run the
    // environment gate, while the read-only p4_status call above must not.
    expect(runCombatEnvironmentGate).toHaveBeenCalledTimes(1);
  });
});
