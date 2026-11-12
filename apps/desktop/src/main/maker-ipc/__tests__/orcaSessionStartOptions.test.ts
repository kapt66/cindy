import { beforeEach, describe, expect, it, vi } from 'vitest';

import { knownNonOrcaSessionIds } from '../orcaMcpHydrationCache';
import {
  applyOrcaInstructions,
  orcaWorkerReportDeliveryForSession,
  preparePersistedOrcaSessionStart,
} from '../orcaSessionStartOptions';
import type { MakerSessionCreateOpts } from '../sessionRequest';

function baseOpts(id: string): MakerSessionCreateOpts {
  return {
    id,
    agentKind: 'codex',
    workingDir: '/repo',
    model: 'gpt-5',
  };
}

describe('persisted Orca session start options', () => {
  beforeEach(() => {
    knownNonOrcaSessionIds.clear();
  });

  // The execution device has no local team/role row. Its persisted origin must enable
  // the bridge across fresh/resumed starts without turning it into a nested local Worker.
  it.each(['codex', 'claude-code', 'pi'] as const)('enables the remote bridge for %s without a local role', async agentKind => {
    const lead = { leadDeviceId: 'pc', leadDeviceName: 'PC', leadSessionId: 'lead-1', leadTitle: 'Lead', workerLabel: 'tester' };
    const opts = { ...baseOpts('remote-session'), agentKind };
    await preparePersistedOrcaSessionStart('remote-session', opts, {
      getSessionRole: async () => null, getWorkerLink: vi.fn(),
      getRemoteLead: async () => lead, warn: vi.fn(),
    });
    expect(opts.vendorOptions).toMatchObject({ orcaRemoteWorker: true, orcaRemoteLead: lead });
    expect(opts.orcaRole).toBeUndefined();
    expect(opts.userPrompt).toBeUndefined();
    expect(knownNonOrcaSessionIds.has('remote-session')).toBe(false);
  });

  it('reconstructs persisted Lead vendor options and instructions', async () => {
    const opts = baseOpts('lead-session');
    const getWorkerLink = vi.fn();

    await expect(
      preparePersistedOrcaSessionStart('lead-session', opts, {
        getSessionRole: vi.fn().mockResolvedValue('lead'),
        getWorkerLink,
        warn: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(opts.orcaRole).toBe('lead');
    expect(opts.vendorOptions).toMatchObject({
      orcaRole: 'lead',
      orcaLeadSessionId: 'lead-session',
    });
    expect(opts.userPrompt).toEqual(expect.any(String));
    expect(opts.userPrompt).not.toHaveLength(0);
    expect(getWorkerLink).not.toHaveBeenCalled();
  });

  it('reconstructs persisted Worker link, vendor options, and instructions', async () => {
    const opts = baseOpts('worker-session');

    await expect(
      preparePersistedOrcaSessionStart('worker-session', opts, {
        getSessionRole: vi.fn().mockResolvedValue('worker'),
        getWorkerLink: vi.fn().mockResolvedValue({
          workerId: 'worker-1',
          teamId: 'team-1',
          leadSessionId: 'lead-session',
        }),
        warn: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(opts.orcaRole).toBe('worker');
    expect(opts.vendorOptions).toMatchObject({
      orcaRole: 'worker',
      orcaWorkflowId: 'team-1',
      orcaLeadSessionId: 'lead-session',
      orcaWorkerId: 'worker-1',
      orcaWorkerSessionId: 'worker-session',
    });
    expect(opts.userPrompt).toEqual(expect.any(String));
    expect(opts.userPrompt).not.toHaveLength(0);
  });

  it('does not cache an explicit Orca role as non-Orca before its row is persisted', async () => {
    const opts = {
      ...baseOpts('worker-session'),
      orcaRole: 'worker' as const,
    };
    knownNonOrcaSessionIds.add('worker-session');
    const getSessionRole = vi.fn().mockResolvedValue(null);

    await expect(
      preparePersistedOrcaSessionStart('worker-session', opts, {
        getSessionRole,
        getWorkerLink: vi.fn(),
        warn: vi.fn(),
      }),
    ).resolves.toBe(false);

    expect(getSessionRole).toHaveBeenCalledWith('worker-session');
    expect(knownNonOrcaSessionIds.has('worker-session')).toBe(false);
  });

  it('does not duplicate instructions when project context follows the Orca prompt', async () => {
    const opts = baseOpts('lead-session');
    const deps = {
      getSessionRole: vi.fn().mockResolvedValue('lead' as const),
      getWorkerLink: vi.fn(),
      warn: vi.fn(),
    };

    await preparePersistedOrcaSessionStart('lead-session', opts, deps);
    opts.userPrompt = `${opts.userPrompt}\n\n<project-context-toc>project context</project-context-toc>`;
    const promptWithProjectContext = opts.userPrompt;
    await preparePersistedOrcaSessionStart('lead-session', opts, deps);

    expect(opts.userPrompt).toBe(promptWithProjectContext);
    expect(deps.getSessionRole).toHaveBeenCalledTimes(1);
  });

  it('injects the explicit-bridge worker instructions for every Orca worker', () => {
    const opts = {
      ...baseOpts('worker-session'),
      // `reportDelivery` 现在只由**传输能力**决定（MCPRouter 远端 Pi 例外，见下一条用例）。
      // 这里刻意留着已失效的 workflow 残留键作为反向证据：同名 vendorOptions 值回来，
      // 也不得再改变投递形态。
      vendorOptions: {
        orcaRole: 'worker' as const,
        orcaWorkflowId: 'team-1',
        orcaLeadSessionId: 'lead-session',
        orcaWorkerId: 'worker-1',
        orcaWorkerSessionId: 'worker-session',
        mekaWorkflow: 'saga2-combat-server-worker-v1',
      },
    };

    expect(applyOrcaInstructions(opts)).toBe(true);
    // 显式桥接形态：Worker 必须自己调 send_to_lead 回报。
    expect(opts.userPrompt).toContain('ALWAYS call send_to_lead');
    // 反向：旧的 workflow 触发式自动桥接分支仍然不存在（连同它的两条独有文案）。
    expect(opts.userPrompt).not.toContain('terminal auto-bridge delivery');
    expect(opts.userPrompt).not.toContain('Do NOT call send_to_lead');
    // 身份行仍由 vendorOptions 原样渲染（这一层的机制未动）。
    expect(opts.userPrompt).toContain(
      'worker_id=worker-1, session_id=worker-session, workflow_id=team-1, lead_session_id=lead-session',
    );
  });

  it('switches an MCPRouter remote Pi worker to auto-bridge instructions', () => {
    const workerVendorOptions = {
      orcaRole: 'worker' as const,
      orcaWorkflowId: 'team-1',
      orcaLeadSessionId: 'lead-session',
      orcaWorkerId: 'worker-1',
      orcaWorkerSessionId: 'worker-session',
    };

    const remotePi = {
      ...baseOpts('worker-session'),
      agentKind: 'pi' as const,
      remoteHostId: 'mcpr:092af411-7a76-4b40-a4fe-6b4fa9c8f8cc',
      vendorOptions: workerVendorOptions,
    };
    expect(orcaWorkerReportDeliveryForSession(remotePi)).toBe('auto-bridge');
    expect(applyOrcaInstructions(remotePi)).toBe(true);
    // 远端 Pi 没有 in-process MCP bridge：提示词不得再承诺 send_to_lead。
    expect(remotePi.userPrompt).toContain('NO Orca bridge tools');
    expect(remotePi.userPrompt).not.toContain('ALWAYS call send_to_lead');
    expect(remotePi.userPrompt).toContain('the host relays your final answer text');

    // 同一台远端机器上的 Claude/Codex worker 走 cc-mgr 隧道，仍有桥接工具。
    expect(orcaWorkerReportDeliveryForSession({ agentKind: 'claude-code', remoteHostId: 'mcpr:x' }))
      .toBe('explicit-bridge');
    // 远端 Pi 以外的 Pi（本机 / SSH）保留显式桥接。
    expect(orcaWorkerReportDeliveryForSession({ agentKind: 'pi', remoteHostId: 'ssh-host-1' }))
      .toBe('explicit-bridge');
    expect(orcaWorkerReportDeliveryForSession({ agentKind: 'pi' })).toBe('explicit-bridge');
  });
});
