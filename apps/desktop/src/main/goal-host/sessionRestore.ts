import type { Session, SessionMeta } from '@cindy/maker-core';

import {
  applyMekaRuntimeConfig,
  type AppliedMekaRuntimeConfig,
  type ApplyMekaRuntimeConfigDeps,
  type PersistedMekaSessionBinding,
} from '../meka-injection/index.js';
import { ensurePersistedMekaSessionBinding } from '../meka-injection/persistedBinding.js';
import { isMekaAssistantSession } from '../../shared/mekaAssistantSession.js';
import { getSessionRowSnapshot } from '../localDb/ipc/sessions.js';
import { markOrcaMcpHydratedIfNeeded } from '../maker-ipc/orcaMcpHydrationCache.js';
import { preparePersistedOrcaSessionStart } from '../maker-ipc/orcaSessionStartOptions.js';
import type { MakerSessionCreateOpts } from '../maker-ipc/sessionRequest.js';
import { wireSessionToIpc } from '../maker-ipc/register.js';
import { hydrateSessionProvider } from '../maker-host/session-provider-store.js';
import type { SessionLike } from './types.js';

interface GoalSessionRestoreMaker {
  getSession(sessionId: string): SessionLike | undefined;
  getSessionMeta(sessionId: string): Promise<SessionMeta | null>;
  createSession(opts: MakerSessionCreateOpts): Promise<Session>;
}

interface GoalSessionRow {
  providerId: string | null;
}

/** Injectable seams keep the dormant-session restore ordering deterministic in tests. */
export interface RestoreGoalSessionDeps {
  maker: GoalSessionRestoreMaker;
  warn(message: string, meta: Record<string, unknown>): void;
  getSessionRow?: (sessionId: string) => Promise<GoalSessionRow | null>;
  hydrateProvider?: (sessionId: string, providerId: string | null) => void;
  prepareOrcaStart?: (sessionId: string, opts: MakerSessionCreateOpts) => Promise<boolean>;
  markOrcaHydrated?: (sessionId: string, opts: MakerSessionCreateOpts) => void;
  wireSession?: (session: Session) => void;
  /**
   * 启动前的持久化 Meka 身份收口：读 sessions 行，未绑定但工作区是本机 Meka 项目目录时
   * 按路径补齐成对绑定。默认用生产实现；测试注入 fake，避免触真实 DB。
   */
  ensureMekaBinding?: (sessionId: string) => Promise<PersistedMekaSessionBinding | null>;
  /** Meka 运行时注入的唯一入口（`../meka-injection/index.js`）；默认生产实现。 */
  applyMekaRuntime?: (
    opts: MakerSessionCreateOpts,
    deps: ApplyMekaRuntimeConfigDeps,
  ) => Promise<AppliedMekaRuntimeConfig>;
}

/**
 * Resume a dormant Goal session with the same persisted Orca context as SEND.
 * Orca options must be reconstructed before Maker's singleflight boundary so a
 * concurrent rehydrate can only join a correctly configured startup.
 */
export async function restoreSessionForGoal(
  sessionId: string,
  deps: RestoreGoalSessionDeps,
): Promise<SessionLike | undefined> {
  const live = deps.maker.getSession(sessionId);
  // A failed close leaves the Session in Maker's live map with status=error.
  // Do not hand that poisoned object back to Goal: Maker.createSession owns the
  // retry-close-then-rebuild boundary for this exact state.
  if (live && live.getStatus?.() !== 'error') return live;

  const meta = await deps.maker.getSessionMeta(sessionId).catch(() => null);
  if (!meta) {
    deps.warn('[goal-host] cannot resume session (no meta)', { sessionId });
    return undefined;
  }

  try {
    const row = await (deps.getSessionRow ?? getSessionRowSnapshot)(sessionId);
    const opts: MakerSessionCreateOpts = {
      id: sessionId,
      agentKind: meta.agentKind,
      workingDir: meta.workDir,
      model: meta.model,
      effort: meta.effort,
      permissionMode: meta.permissionMode,
      fastMode: meta.fastMode,
      resumeSessionId: meta.sdkSessionId,
      remoteHostId: meta.remoteHostId,
      // A persisted null explicitly selects the Cindy default route for Pi;
      // only a missing row has no route value to pass through.
      providerId: row?.providerId,
    };

    await (deps.prepareOrcaStart ?? preparePersistedOrcaSessionStart)(sessionId, opts);
    (deps.hydrateProvider ?? hydrateSessionProvider)(sessionId, row?.providerId ?? null);

    // 启动前按持久化行注入 Meka 运行时（长期规则：任何启动路径都按行注入，不按调用口径）。
    // dormant Goal 恢复不经过桌面 `bootstrapSessionOnce`，所以在这里用**同一个唯一入口**
    // `applyMekaRuntimeConfig`，数据源与 IM / hook 冷启动一致走
    // `ensurePersistedMekaSessionBinding`（读行 + 本地 Meka 工作区补成对绑定）。放在
    // createSession 之前、Orca 参数之后：注入段 prepend 到既有 prompt，与桌面 bootstrap 的
    // 「先 Meka 段、后 Orca 指令」最终顺序一致。
    // 非 Meka 行零写入（注入层自己早返回）；绑定 / 注入失败按本次续轮失败收口，绝不吞掉
    // 错误把会话按普通身份拉起来。
    const ensureMekaBinding = deps.ensureMekaBinding ?? ensurePersistedMekaSessionBinding;
    const persistedBinding = await ensureMekaBinding(sessionId);
    if (isMekaAssistantSession(persistedBinding)) {
      await (deps.applyMekaRuntime ?? applyMekaRuntimeConfig)(opts, {
        readPersistedSession: ensureMekaBinding,
      });
    }

    const session = await deps.maker.createSession(opts);
    (deps.markOrcaHydrated ?? markOrcaMcpHydratedIfNeeded)(session.id, opts);
    (deps.wireSession ?? wireSessionToIpc)(session);
    return session;
  } catch (err) {
    deps.warn('[goal-host] ensureSession createSession failed', {
      sessionId,
      error: String(err),
    });
    return undefined;
  }
}
