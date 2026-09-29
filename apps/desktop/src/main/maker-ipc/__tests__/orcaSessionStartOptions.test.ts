import { beforeEach, describe, expect, it, vi } from 'vitest';

import { knownNonOrcaSessionIds } from '../orcaMcpHydrationCache';
import {
  applyOrcaInstructions,
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
      // workflow 机制删除的必然后果：`reportDelivery` 由「是不是战斗服务器 Worker」的条件变成了
      // 恒 `'explicit-bridge'`（条件真分支已不可达，等价于原「假分支」）。这里**刻意留着**这个
      // 残留键作为反向证据：即使同名 vendorOptions 值回来，也不得再改变投递形态。
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
    // 反向：终端自动桥接分支已不存在（连同它的两条独有文案）。
    expect(opts.userPrompt).not.toContain('terminal auto-bridge delivery');
    expect(opts.userPrompt).not.toContain('Do NOT call send_to_lead');
    // 身份行仍由 vendorOptions 原样渲染（这一层的机制未动）。
    expect(opts.userPrompt).toContain(
      'worker_id=worker-1, session_id=worker-session, workflow_id=team-1, lead_session_id=lead-session',
    );
  });
});
