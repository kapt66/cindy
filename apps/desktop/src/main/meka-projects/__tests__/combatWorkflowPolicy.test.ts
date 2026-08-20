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

vi.mock('../../maker-host/mcpr-codex-capability.js', () => ({
  probeRemoteCodexCapability: vi.fn(async () => ({ ok: true })),
}));

import { runCombatEnvironmentGate } from '../combatEnvironmentGate.js';
import {
  evaluateCombatToolExecution,
  evaluateCombatPlanReview,
  isCombatWorkflowPolicyActive,
  markCombatPlanApproved,
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
  resetCombatServerCapabilityStateForTests();
  services.p4.get.mockResolvedValue({ p4RootPath: 'C:\\Workspace\\saga2\\saga2_project' });
  services.router.listProjectTools.mockResolvedValue([]);
  services.router.listProjectBindings.mockResolvedValue(['server-1']);
  services.router.listInstances.mockResolvedValue([
    {
      id: 'server-1',
      projectName: 'saga2-server',
      projectDescription: 'SAGA2 server',
      available: true,
    },
  ]);
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
                initial_task: '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capabilities residual server gap: inspect server',
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

  it('allows report validation only after accepted dispatch and trusted auto-bridge delivery', async () => {
    const options = vendor();
    const task = '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capabilities residual server gap: inspect runtime support';
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
    await expect(
      evaluateCombatToolExecution(validation),
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
      "/bin/bash -lc 'rg --files'",
      "/bin/bash -c 'git show -s --format=%H HEAD'",
      "/usr/bin/sh -c 'cat AGENTS.md'",
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
    ).resolves.toEqual({ behavior: 'allow' });
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
    ).resolves.toEqual({ behavior: 'allow' });
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

  it('stops the Lead after a server capability report requires programmer handoff', async () => {
    const options = vendor({
      mekaCombatServerCapabilityStatus: 'unsupported',
      mekaCombatPhase: 'server-programmer-handoff',
    });
    await expect(evaluateCombatToolExecution(context(options))).resolves.toMatchObject({
      behavior: 'deny',
      reason: expect.stringContaining('程序介入'),
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
            initial_task: '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capabilities residual server gap: inspect AGENTS.md',
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
    ).resolves.toEqual({ behavior: 'allow' });

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
              initial_task: '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capabilities residual server gap: inspect AGENTS.md',
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
            initial_task: '[SAGA2_SERVER_EXPLORATION_READ_ONLY] [SAGA2_MODULE_FIRST] skill-entry-model atomic capabilities residual server gap: inspect AGENTS.md',
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
      reason: expect.stringContaining('skill-entry-model'),
    });
    expect(options).not.toHaveProperty('mekaCombatServerCapabilityStatus');
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
