import type {
  ContextRebuildArgs,
  SessionRemoteRebindArgs,
  SessionRemoteRebindResult,
} from './client/tx/types.js';

/**
 * 老任务换「干净原生会话」时，本地消息历史与原生上下文的唯一桥。
 *
 * 交接触发原因（写入隐藏标记的 `reason`）必须与 `agentHandoff.ts` 的
 * `BuildHandoffOptions.reason` 同名：注入侧只按标记内容读 handoff，人读文案与
 * 诊断归属都靠这个字段区分「为什么重建」。
 */
export type ContextRebuildReason =
  | 'context-overflow'
  | 'model-window-switch'
  | 'pi-prompt-timeout'
  | 'native-session-recovery'
  | 'idle-gap'
  /**
   * `psb:` 远端会话透明重建：旧 PSB 会话已终态/不存在，本地任务换了一条全新的远端
   * 引擎会话，原生 vendor session 不再存在，只能把本地历史交接给新引擎。
   */
  | 'remote-session-rebind';

export interface ContextRebuildPersistencePorts {
  now(): number;
  createId(): string;
  tx(name: 'context.rebuild', args: ContextRebuildArgs): Promise<unknown>;
}

/** 隐藏交接标记的持久形状（`agentHandoffPendingQueries` 按 content 读它）。 */
export interface ContextRebuildMarker {
  id: string;
  clientId: string;
  content: string;
  createdAt: number;
}

/**
 * 构造隐藏的 `context_rebuild` 标记行 —— 消息删除 / 上下文超限 / 原生会话恢复 /
 * 远端重绑四条路共用同一份 JSON 形状（`{ handoff, consumed, reason, … }`）。
 *
 * 只在这一处拼 content：注入侧（`findPendingAgentHandoff`）与消费位
 * （`markLatestAgentHandoffConsumed`）都按这个形状读，多一处手写 JSON 就多一次漂移面。
 */
export function buildContextRebuildMarker(
  ports: Pick<ContextRebuildPersistencePorts, 'now' | 'createId'>,
  handoff: string,
  meta: {
    reason: ContextRebuildReason;
    sourceUserClientId: string | null;
    sourceAgentKind?: 'cc' | 'codex' | 'pi';
    sourceModel?: string | null;
    sourceProviderId?: string | null;
    expectedSdkSessionId?: string;
    replacementRoute?: ContextRebuildArgs['replacementRoute'];
  },
): ContextRebuildMarker {
  return {
    id: ports.createId(),
    clientId: `context-rebuild:${ports.createId()}`,
    createdAt: ports.now(),
    content: JSON.stringify({
      handoff,
      consumed: false,
      reason: meta.reason,
      sourceUserClientId: meta.sourceUserClientId,
      ...(meta.replacementRoute || meta.expectedSdkSessionId
        ? { sourceSdkSessionId: meta.replacementRoute?.expectedSdkSessionId ?? meta.expectedSdkSessionId }
        : {}),
      ...(meta.sourceAgentKind ? { sourceAgentKind: meta.sourceAgentKind } : {}),
      ...(meta.sourceModel !== undefined ? { sourceModel: meta.sourceModel } : {}),
      ...(meta.sourceProviderId !== undefined ? { sourceProviderId: meta.sourceProviderId } : {}),
    }),
  };
}

export async function commitContextRebuildWithPorts(
  ports: ContextRebuildPersistencePorts,
  sessionId: string,
  handoff: string,
  meta: {
    reason: ContextRebuildReason;
    sourceUserClientId: string | null;
    sourceAgentKind?: 'cc' | 'codex' | 'pi';
    sourceModel?: string | null;
    sourceProviderId?: string | null;
    expectedClearedAt?: number | null;
    expectedSdkSessionId?: string;
    replacementRoute?: ContextRebuildArgs['replacementRoute'];
  },
): Promise<{ updatedAt: number }> {
  const now = ports.now();
  const marker = buildContextRebuildMarker(ports, handoff, meta);
  await ports.tx('context.rebuild', {
    sessionId,
    markerId: marker.id,
    markerClientId: marker.clientId,
    markerContent: marker.content,
    markerCreatedAt: marker.createdAt,
    updatedAt: now,
    expectedClearedAt: meta.expectedClearedAt ?? null,
    ...(meta.replacementRoute ? { replacementRoute: meta.replacementRoute } : {}),
    ...(meta.expectedSdkSessionId !== undefined ? { expectedSdkSessionId: meta.expectedSdkSessionId } : {}),
  });
  return { updatedAt: now };
}

/**
 * 远端会话透明重建（`psb:`）的持久化入口：新远端身份 + 清旧原生绑定 + 旧任务上下文
 * 交接**一次事务提交**（`session.remoteRebind`，见 `client/tx/types.ts` 的注释）。
 *
 * 为什么不能用两次写拼起来：身份与交接分开提交时，中间崩溃/失败会留下「重连成功但
 * 模型失忆」的半提交状态，而界面完全看不出来（审查 r7 P1）。冲突时不写任何东西。
 */
export interface SessionRemoteRebindPersistencePorts {
  now(): number;
  createId(): string;
  tx(name: 'session.remoteRebind', args: SessionRemoteRebindArgs): Promise<SessionRemoteRebindResult>;
}

export async function commitRemoteSessionRebindWithPorts(
  ports: SessionRemoteRebindPersistencePorts,
  input: {
    readonly sessionId: string;
    /** 读库时看到的远端身份；CAS 用（`null` = 本地会话）。 */
    readonly previousRemoteHostId: string | null;
    /** 重建出来的新远端身份。 */
    readonly remoteHostId: string;
    /** 新远端会话所属工作区（PSB 权威来源）。 */
    readonly workspaceId: string;
    /** `true` = 同时清空 `sdk_session_id`（新远端会话不认旧 vendor session）。 */
    readonly clearNativeSession: boolean;
    /**
     * 旧任务的上下文交接文本（调用方按消息历史确定性拼出，见
     * `maker-ipc/agentHandoff.ts`）。`null` = 不写交接（调用方明确要求保留原生会话）。
     */
    readonly handoff: string | null;
    readonly sourceAgentKind?: 'cc' | 'codex' | 'pi';
  },
): Promise<SessionRemoteRebindResult> {
  const marker = input.handoff === null
    ? null
    : buildContextRebuildMarker(ports, input.handoff, {
        reason: 'remote-session-rebind',
        sourceUserClientId: null,
        ...(input.sourceAgentKind ? { sourceAgentKind: input.sourceAgentKind } : {}),
      });
  return ports.tx('session.remoteRebind', {
    sessionId: input.sessionId,
    expectedRemoteHostId: input.previousRemoteHostId,
    remoteHostId: input.remoteHostId,
    workspaceId: input.workspaceId,
    clearNativeSession: input.clearNativeSession,
    ...(marker ? { marker } : {}),
    updatedAt: ports.now(),
  });
}
