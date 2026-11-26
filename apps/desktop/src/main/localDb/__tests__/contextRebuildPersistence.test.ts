/**
 * `contextRebuildPersistence` 的远端重绑持久化入口。
 *
 * 规则依据：审查 r7 P1 —— 重绑必须同时落「新远端身份 / 清旧原生绑定 / 旧任务上下文交接」。
 * 这层负责把交接文本包成隐藏 `context_rebuild` 标记并交给**同一个**事务；本用例锁的是
 * 「reason / consumed / handoff 的形状」与「请求字段原样进事务」，事务体本身由
 * `worker/opHandlers/__tests__/sessionRemoteRebindTx.test.ts` 覆盖。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildContextRebuildMarker,
  commitRemoteSessionRebindWithPorts,
} from '../contextRebuildPersistence.js';

describe('commitRemoteSessionRebindWithPorts', () => {
  it('stores the handoff as a hidden context_rebuild marker with reason remote-session-rebind', async () => {
    const tx = vi.fn(async (_name: string, _args: unknown) => ({ status: 'persisted' as const }));
    const result = await commitRemoteSessionRebindWithPorts(
      { now: () => 7, createId: () => 'id-1', tx },
      {
        sessionId: 's1',
        previousRemoteHostId: 'psb:old',
        remoteHostId: 'psb:new',
        workspaceId: 'ws-1',
        clearNativeSession: true,
        handoff: 'earlier history',
        sourceAgentKind: 'cc',
      },
    );

    expect(result).toEqual({ status: 'persisted' });
    expect(tx).toHaveBeenCalledTimes(1);
    const [name, args] = tx.mock.calls[0]!;
    expect(name).toBe('session.remoteRebind');
    expect(args).toMatchObject({
      sessionId: 's1',
      expectedRemoteHostId: 'psb:old',
      remoteHostId: 'psb:new',
      workspaceId: 'ws-1',
      clearNativeSession: true,
      updatedAt: 7,
    });
    const marker = (args as { marker: { content: string; createdAt: number } }).marker;
    expect(marker.createdAt).toBe(7);
    expect(JSON.parse(marker.content)).toMatchObject({
      handoff: 'earlier history',
      consumed: false,
      reason: 'remote-session-rebind',
      sourceUserClientId: null,
      sourceAgentKind: 'cc',
    });
  });

  it('omits the marker when the caller keeps the native session', async () => {
    const tx = vi.fn(async (_name: string, _args: unknown) => ({ status: 'conflict' as const }));
    await commitRemoteSessionRebindWithPorts(
      { now: () => 1, createId: () => 'id', tx },
      {
        sessionId: 's1',
        previousRemoteHostId: null,
        remoteHostId: 'psb:new',
        workspaceId: 'ws-1',
        clearNativeSession: false,
        handoff: null,
      },
    );
    const [, args] = tx.mock.calls[0]!;
    expect(args).not.toHaveProperty('marker');
    expect((args as { expectedRemoteHostId: string | null }).expectedRemoteHostId).toBeNull();
  });

  it('keeps the shared hidden-marker shape (single place that builds it)', () => {
    const marker = buildContextRebuildMarker(
      { now: () => 5, createId: () => 'id-2' },
      'handoff text',
      { reason: 'native-session-recovery', sourceUserClientId: 'client-9', expectedSdkSessionId: 'native-1' },
    );
    expect(JSON.parse(marker.content)).toEqual({
      handoff: 'handoff text',
      consumed: false,
      reason: 'native-session-recovery',
      sourceUserClientId: 'client-9',
      sourceSdkSessionId: 'native-1',
    });
  });
});
