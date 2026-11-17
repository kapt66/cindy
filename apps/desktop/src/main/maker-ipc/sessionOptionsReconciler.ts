import { eq } from 'drizzle-orm';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';
import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { reconcileCreateOptsFromPersistedSession } from './sessionCreateReconciliation.js';
import type { MakerSessionCreateOpts as CreateOpts } from './sessionRequest.js';
import type { createLogger } from '../logger.js';

export type SessionExecutionRow = Partial<Pick<typeof sessions.$inferSelect,
  'agentKind' | 'model' | 'sdkSessionId' | 'providerId' | 'effort' | 'fastMode' |
  'permissionMode' | 'planModeEnabled' | 'agentDeviceId' | 'remoteHostId' |
  'workingDir' | 'workspaceKind' | 'mekaProjectId' | 'mekaRoleId'>> & Pick<typeof sessions.$inferSelect, 'model'>;

/** Extra options for one reconciliation call (see `reconcileCreateOptsFromPersistedSession`). */
export interface SessionOptionsReconcileOptions {
  /** A session known to exist (error-recovery lazy create) must have its row, not a fresh create. */
  requirePersistedSession?: boolean;
  /** Treat an unreadable authoritative row as fatal instead of continuing with caller opts. */
  failClosedOnReadError?: boolean;
}

async function readSession(sessionId: string): Promise<SessionExecutionRow | undefined> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      agentKind: sessions.agentKind,
      model: sessions.model,
      sdkSessionId: sessions.sdkSessionId,
      providerId: sessions.providerId,
      effort: sessions.effort,
      fastMode: sessions.fastMode,
      permissionMode: sessions.permissionMode,
      planModeEnabled: sessions.planModeEnabled,
      agentDeviceId: sessions.agentDeviceId,
      remoteHostId: sessions.remoteHostId,
      // Meka 归属身份（WL-3/WL-11.3）：懒启动必须按落库值恢复三键，否则会话行会被
      // 当成普通任务重投影（侧栏落孤儿桶，运行期被判半绑定）。
      workingDir: sessions.workingDir,
      workspaceKind: sessions.workspaceKind,
      mekaProjectId: sessions.mekaProjectId,
      mekaRoleId: sessions.mekaRoleId,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row;
}

/** Refresh stale queue/native-resume snapshots from the task's persisted settings.
 * Desktop uses the original DB query; Host injects its owner-scoped admission read.
 *
 * Meka keeps two semantics on top of the upstream extraction (both registered):
 * - the Meka project/role identity guard (§6.33 / WL-3) applied through `applyRow`;
 * - the fail-closed reconciliation contract of `sessionCreateReconciliation.ts`
 *   (an explicitly-recovering Session must have its row; an unreadable row must not
 *   silently continue with stale `createOpts`). */
export function createSessionOptionsReconciler(deps: {
  log: Pick<ReturnType<typeof createLogger>, 'warn'>;
  readSession?: (sessionId: string) => Promise<SessionExecutionRow | null | undefined>;
  /** Meka binding reconciliation reads the task's persisted granted directories. */
  readExtraDirs?: (sessionId: string) => Promise<string[]>;
}) {
  const { log } = deps;
  const loadSession = deps.readSession ?? readSession;
  return async function reconcileCreateOptsAgainstDb(
    sessionId: string,
    co: CreateOpts,
    options: SessionOptionsReconcileOptions = {},
  ): Promise<void> {
    await reconcileCreateOptsFromPersistedSession<SessionExecutionRow>({
      sessionId,
      requirePersistedSession: options.requirePersistedSession,
      // Upstream extraction fails closed on every read error; keep that default.
      failClosedOnReadError: options.failClosedOnReadError ?? true,
      readRow: () => loadSession(sessionId),
      applyRow: async (row) => {
        // Agent 换电脑也在发送事务内落地：快照里的旧位置不能把 Agent 拉回原来那台。
        // 缺省(undefined)交给 bootstrapSession 按任务记录读取，与恢复路径同一口径。
        if (!co.remoteHostId && !row.remoteHostId) {
          co.agentDeviceId = row.agentDeviceId ?? undefined;
        }
        const dbMakerKind = dbToMakerAgentKind(row.agentKind);
        if (co.agentKind !== dbMakerKind) {
          log.warn('lazy-create: createOpts agentKind drifted from DB (agent switch); reconciling', {
            sessionId,
            staleAgentKind: co.agentKind,
            dbAgentKind: dbMakerKind,
          });
          co.agentKind = dbMakerKind;
        }
        // 意图制切换 / 凭证形态切换下,renderer 与排队项的 createOpts 快照构建于 send
        // 事务内 apply 之前。agentKind 可能已一致,但 model/resume/providerId/effort/fast
        // 仍是旧值；
        // 尤其 resumeSessionId 可能是**旧引擎**的原生会话 id——resume 会以错误引擎
        // 解释它)。lazy-create 时刻 DB 行是唯一真源,执行字段无条件对齐。
        co.model = row.model ?? undefined;
        co.resumeSessionId = row.sdkSessionId ?? undefined;
        if (!row.sdkSessionId && co.vendorOptions) {
          // context.rebuild clears the DB sdk_session_id. Queued createOpts may
          // still carry vendor-specific resume/fork anchors from before the close;
          // strip every native continuation hint so CC/Codex bootstrap fresh too.
          const freshVendorOptions = { ...co.vendorOptions };
          for (const key of ['resumeSessionAt', 'forkSession', 'threadId', 'tailTurnsToDrop']) {
            delete freshVendorOptions[key];
          }
          co.vendorOptions =
            Object.keys(freshVendorOptions).length > 0 ? freshVendorOptions : undefined;
        }
        co.providerId = row.providerId;
        co.effort = (row.effort ?? undefined) as CreateOpts['effort'];
        // DB 是权威档位，`FastMode` 是 `boolean | 'ultrafast'`：布尔强制转换会把
        // Ultrafast 静默压成 true（丢档位），必须原样透传。
        co.fastMode = (row.fastMode ?? false);
        // 权限档同样是会话级设置:forceQueue 入队快照不能锁死排队期间的切档,冷启动必须
        // 再读一次当前落库值,否则降档后仍免确认、升档后仍重复询问。
        co.permissionMode = permissionModeOrAsk(row.permissionMode);
        // 新建会话的计划模式按落库状态起档：排队项的 createOpts.planMode 是那一条消息的
        // 计划意图（伙伴委派等 Host 输入恒为 false），本轮意图仍由发送事务按原快照传给
        // send，这里只校正冷启动的会话状态，不改本轮是否以计划执行。
        co.planMode = row.planModeEnabled === true;
        // Meka 归属身份：三键必须同一次写入并以落库值为准（WL-3.8/WL-11.3），
        // 半绑定的行在运行期会被 `resolveBootstrapInjection` 直接拒绝。
        if (row.workspaceKind === 'meka') {
          if (!row.workingDir || !row.mekaProjectId || !row.mekaRoleId) {
            throw new Error(`Meka session ${sessionId} is missing its persisted project binding`);
          }
          co.workingDir = row.workingDir;
          co.workspaceKind = 'meka';
          co.mekaProjectId = row.mekaProjectId;
          co.mekaRoleId = row.mekaRoleId;
          if (deps.readExtraDirs) co.extraDirs = await deps.readExtraDirs(sessionId);
        }
      },
      onRequiredFailure: (error) => {
        log.warn('lazy-create: DB reconciliation failed; refusing stale native bootstrap', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  };
}
