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
}));

import { runCombatEnvironmentGate } from '../combatEnvironmentGate.js';
import {
  evaluateCombatToolExecution,
  evaluateCombatPlanReview,
  isCombatWorkflowPolicyActive,
  markCombatPlanApproved,
  resetCombatPlanApprovals,
} from '../combatWorkflowPolicy.js';

function vendor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'meka',
    mekaProjectId: 'saga2',
    mekaRoleId: 'combat-development',
    mekaWorkflow: 'saga2-combat-development-v1',
    mekaCombatEnvironmentReady: true,
    mekaCombatPlanApproved: false,
    mekaCombatPhase: 'exploration',
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
  vi.resetAllMocks();
  resetCombatPlanApprovals();
  services.p4.get.mockResolvedValue({ p4RootPath: 'C:\\Workspace\\saga2\\saga2_project' });
  services.router.listProjectTools.mockResolvedValue([]);
});

describe('combat workflow host policy', () => {
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

  it('blocks business reads but still allows environment checks when workflow metadata is absent', async () => {
    const options = vendor({
      mekaWorkflow: undefined,
      mekaCombatEnvironmentReady: true,
    });
    await expect(evaluateCombatToolExecution(context(options))).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('不是用户拒绝'),
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command: 'Get-Content -Raw C:\\\\snapshot\\\\remote-operations\\\\SKILL.md',
          },
        }),
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('不得加载 Skill/AGENTS.md'),
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
    ).resolves.toEqual({ behavior: 'allow' });
  });

  it('allows only recovery diagnostics while the environment is blocked', async () => {
    const options = vendor({ mekaCombatEnvironmentReady: false });
    await expect(evaluateCombatToolExecution(context(options))).resolves.toMatchObject({
      behavior: 'deny',
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
    ).resolves.toEqual({ behavior: 'allow' });
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

  it('allows a plain Select-String inspection but rejects PowerShell side effects', async () => {
    const options = vendor();
    const readOnlyCommand =
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Select-String -Path \'saga2_json\\skill_entry_model_editor.json\' -Pattern \'预警|伤害\' -Context 20,20"';
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'exec',
          action: {
            kind: 'exec',
            command: readOnlyCommand,
            cwd: 'C:\\Workspace\\saga2\\saga2_project',
          },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });

    for (const command of [
      readOnlyCommand.replace('"', '; Set-Content hacked.txt x"'),
      readOnlyCommand.replace('-Context 20,20', '-Context 20,20 > result.txt'),
      readOnlyCommand.replace("'预警|伤害'", '$env:API_KEY'),
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
      '\\claude-plugin\\skills\\editor-skill-editor-module\\SKILL.md';
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

  it('allows only the generated line-count loop for snapshotted Skill entrypoints', async () => {
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
    ).resolves.toEqual({ behavior: 'allow' });

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

  it('allows a read-only snapshotted Skill count expression without opening a permission prompt', async () => {
    const options = vendor();
    const revision = 'c'.repeat(64);
    const skillPath =
      `C:\\Users\\XINDONG\\AppData\\Roaming\\CindyMeka\\meka-skill-snapshots\\revisions\\${revision}` +
      '\\claude-plugin\\skills\\editor-skill-editor-module\\SKILL.md';
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

  it('allows Unity custom queries and blocks Unity custom mutations before approval', async () => {
    const options = vendor();
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__unity-editor__execute_custom_tool',
          input: { parameters: { function: 'get_config_data' } },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__unity-editor__execute_custom_tool',
          input: { parameters: { function: 'set_node' } },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('allows only known startup diagnostics without asking for business permission', async () => {
    const options = vendor();
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy__ghost_list',
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__unity-editor__manage_editor',
          input: { action: 'telemetry_ping' },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__unity-editor__manage_editor',
          input: { action: 'open_project' },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
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

  it('requires a fresh environment gate for every mutation after approval', async () => {
    const options = vendor();
    markCombatPlanApproved({ vendorOptions: options });
    vi.mocked(runCombatEnvironmentGate).mockResolvedValueOnce({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityMcp: { status: 'ready', summary: 'ok' },
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

  it('falls back to environment recovery when the pre-mutation recheck fails', async () => {
    const options = vendor({ mekaCombatPlanApproved: true });
    vi.mocked(runCombatEnvironmentGate).mockResolvedValueOnce({
      checkedAt: new Date(0).toISOString(),
      ready: false,
      p4: { status: 'ready', summary: 'ok' },
      unityMcp: { status: 'blocked', summary: 'down' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'Write',
          action: { kind: 'file-write', path: 'x.ts' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
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
    const plan = `[SAGA2_COMBAT_SOLUTION]\ntargetSkillId: 123\nchangeMode: incremental\nsurfaces: module/server\nevidence: table + code\nvalidation: tests\nremainingUnknowns: none\n[/SAGA2_COMBAT_SOLUTION]`;
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
  });

  it('keeps remote server workers read-only until the local Lead approves', async () => {
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
    vi.mocked(runCombatEnvironmentGate).mockResolvedValueOnce({
      checkedAt: new Date(0).toISOString(),
      ready: true,
      p4: { status: 'ready', summary: 'ok' },
      unityMcp: { status: 'ready', summary: 'ok' },
      mcpr: { status: 'ready', summary: 'ok' },
    });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          remoteHostId: 'mcpr:server-1',
          action: { kind: 'file-write', path: 'server.ts' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    expect(options).not.toHaveProperty('mekaCombatEnvironmentReady');
    expect(options).not.toHaveProperty('mekaCombatPhase');
  });

  it('allows only marked read-only server exploration workers before approval', async () => {
    const options = vendor();
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__create_worker',
          input: {
            remote_host_id: 'mcpr:server-1',
            initial_task: '[SAGA2_SERVER_EXPLORATION_READ_ONLY] inspect AGENTS.md',
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp:cindy_orca',
          input: {
            serverName: 'cindy_orca',
            message: 'Allow this MCP tool call?',
            toolParams: {
              role: 'developer',
              agent: 'codex',
              label: 'server-readonly',
              remote_host_id: 'mcpr:server-1',
              initial_task: '[SAGA2_SERVER_EXPLORATION_READ_ONLY] inspect AGENTS.md',
            },
          },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      evaluateCombatToolExecution(
        context(options, {
          toolName: 'mcp__cindy_orca__create_worker',
          input: { remote_host_id: 'mcpr:server-1', initial_task: 'inspect server' },
          action: { kind: 'mcp' },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
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
