/**
 * pipeDispatcher.ts — 管子(脑机接口)工具调用派发器。
 * ---------------------------------------------------------------------------
 * 管子派发契约:agent 经 ghost 总机(cindy-tools)拨号 →
 * 本派发器把活顺管子送进目标意识的电子脑,等交卷(callId 配对),
 * 把结果/结构化失败原样交回总机。
 *
 * 职责边界:
 *   - 资格审(装没装 / 醒没醒 / 有没有这个工具 / 熔断没)→ 结构化错误码;
 *   - 按需拉起沙箱(spawn 幂等);
 *   - callId 配对 + 超时掐断(过期卷子作废丢弃);
 *   - 长任务续命:主机代办在途 hold(cindySlot 接线)与插件 tool-progress
 *     心跳都能把超时窗口续到 GHOST_PIPE_CALL_MAX_TOTAL_MS 天花板内;
 *   - 交卷验身:pending 记录派给了谁,别的意识交不了这份卷(不信自报之外
 *     的第二道:连"替别人交卷"的通道都没有);
 *   - 崩溃/熄灯时把在途调用全部按 GHOST_CRASHED/GHOST_ASLEEP 收掉。
 *
 * 全部依赖注入(规则 14),单测用假 deps + 假时钟直测。
 */

import { randomUUID } from 'node:crypto';
import { getPluginToolUi, pluginToolVisible } from '@cindy/plugin-protocol';

import type {
  GhostPipeToolCall,
  GhostPipeToolProgress,
  GhostToolCallResult,
  GhostManifest,
  InstalledGhost,
} from '../../shared/ghost.js';
import { GHOST_PIPE_CALL_MAX_TOTAL_MS, isGhostPluginErrorCode } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import type { GhostRuntimeState } from './runtime/GhostRuntime.js';
import { isGhostOwnerScopeUsable, type GhostOwnerScope } from './ghostOwnerScope.js';
import { normalizeGhostModelImages } from './ghostModelImages.js';
import type { PluginUsageOutcome } from '../../shared/pluginUsage.js';

/** Internal observation only; no parameters or result bodies leave the dispatcher. */
export interface GhostCallUsageObserver {
  accepted(occurredAt: number): void;
  settled(outcome: PluginUsageOutcome): void;
}

export interface PipeDispatcherDeps {
  /** 按 id 取已装意识(未装 → null)。 */
  getGhost(id: string, namespace?: string | null): InstalledGhost | null;
  /** 当前运行时状态。 */
  runtimeStateOf(id: string): GhostRuntimeState;
  /** 拉起沙箱(幂等;fused/stopping 拒绝)。 */
  spawn(ghost: InstalledGhost): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * 受控重启(可选;crashed 预派发恢复 / 投递发现逻辑页离线时用):同一个实例,
   * 先停旧沙箱再按当前安装记录拉起并等就绪。生产接线
   * `GhostRuntime.stop + spawnForTool`;未注入时保持旧行为(直接按 GHOST_CRASHED 收卷)。
   * 每次调用最多触发一次,并有单飞与冷却,失败不重试。
   *
   * 覆盖范围:**Desktop 本地模式注入**;Host/client-mode 的派发器
   * (`apps/host/src/plugins/runtime.ts:361`)尚未接线,缺省不发重启,投递失败仍按
   * 原 GHOST_CRASHED 语义处理(该路径未验证)。
   */
  restart?(ghost: InstalledGhost): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * 运行中的沙箱是否按**这份安装记录**拉起(可选;生产接线到
   * `GhostRuntime.isCurrentInstall`)。返回 false 时派发前先 `spawn` 对齐代次,
   * 避免更新提交后新调用继续落进旧 receipt 分区的旧页面。
   */
  isCurrentInstall?(ghost: InstalledGhost): boolean;
  /** 把下行消息发到该意识的电子脑逻辑页;false = 逻辑页不在线。 */
  sendToGhost(ghostId: string, payload: GhostPipeToolCall): boolean | Promise<boolean>;
  ownerScope?: GhostOwnerScope;
  /**
   * 为一次工具调用建立用量观测(可选)。正常派发只问一次;受控重启(重启的 stop 会
   * 让旧 volume 的观测失效)后重投成功时会以**同一 callId** 再问一次,用来把观测
   * 换到恢复后的新 volume 上。实现必须按 callId 幂等:同一次调用只记一条账。
   */
  prepareUsage?(ghost: InstalledGhost, callId: string, toolName: string, sessionId?: string): GhostCallUsageObserver | null;
  /** 单次调用超时(默认 330s,见 DEFAULT_TIMEOUT_MS 注释)。 */
  timeoutMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface PendingBindingClaim {
  callerTool: string;
  requestKey: string;
  attempts: number;
  active: boolean;
  consumed: boolean;
}

export type GhostToolProgress = Pick<GhostPipeToolProgress, 'progress' | 'total' | 'message'> & { progress: number };

interface PendingCall {
  onProgress?: (progress: GhostToolProgress) => void;
  progressHighWater?: number;
  usage?: GhostCallUsageObserver | null;
  usageAccepted?: boolean;
  usageOutcome?: PluginUsageOutcome;
  sessionId?: string;
  ghostId: string;
  tool: string;
  ownerScopeSnapshot: unknown;
  /** 宿主能力按用途绑定，允许同请求一次受控重试，禁止换参或无限消费。 */
  claimedBindings: Map<string, PendingBindingClaim>;
  resolve: (result: GhostToolCallResult) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** 派发时刻(续命天花板从这里起算)。 */
  startedAt: number;
  /** 本次调用的基础超时档；默认沿用全局档，宿主 UI 查询可显式收短。 */
  baseTimeoutMs: number;
  /** 显式短超时是绝对窗口，不接受 hold / tool-progress 续命。 */
  timeoutExtensionsAllowed: boolean;
  /** 当前生效的超时时刻(hold / 心跳只延不缩,release 才收)。 */
  deadlineAt: number;
  /** 在途代办 hold 计数(同一卷可并发多单代办,全部收工才收窗)。 */
  holds: number;
  lifetime: AbortController;
  sourceSignal?: AbortSignal;
  cancellationBound?: boolean;
  detachAbort?: () => void;
}

/**
 * 单次工具调用超时。必须 ≥ network 槽重载荷的 fetch 上限
 * (GHOST_FETCH_MEDIA_TIMEOUT_MAX_MS = 300s,媒体取件/上传/目录上传共用)
 * + 余量——否则意识合法地等一单大上传时,管子先到点向 agent 报 TIMEOUT,
 * 而上传仍在后台继续并可能成功,用户被误导重试造成二次全量上传
 * (2026-07-13 xd-pages 部署迁移时定为 330s;原 180s)。
 * 分钟级以上的长任务不再靠调大本值硬扛:主机代办在途自动续命、插件可发
 * tool-progress 心跳续命,天花板见 GHOST_PIPE_CALL_MAX_TOTAL_MS。
 */
const DEFAULT_TIMEOUT_MS = 330_000;

/** 代办收工(release)后留给意识做后处理与交卷的余量窗口。 */
const HOLD_SETTLE_GRACE_MS = 60_000;

/**
 * 同一实例的受控重启冷却(投递失败触发的那条路)。每次调用最多重启一次,冷却再
 * 挡住"每失败一次就重启一次"的连续抖动;预派发发现 crashed 时不受冷却限制
 * ——那时状态机本身就是"沙箱已死"的证据。
 */
const SANDBOX_RESTART_COOLDOWN_MS = 10_000;

/**
 * TOOL_NOT_FOUND 自愈文案。只报"没有什么"会让 agent 拿同一错误形态反复重试,
 * 甚至误判"插件没有写能力"(2026-07-30 实测:二级分派型插件 cindy-github 的
 * 操作名被两个模型先后当作顶层 tool 直调,均在此卡死)。
 * 分派型插件(暴露了 call_tool)把 agent 想调的名字直接回填进正确调用形态;
 * 普通插件列出实际可用的顶层工具名。调用方须传完整 manifest，不能先过滤工具，
 * 否则无法区分未声明和仅页面可见；已知 audience 时只推荐该调用方可用的入口。
 * 消费方:本派发器 + ghost_call 主路径预检(mcp-integrations/ghost.ts)+
 * setup 恢复校验(maker-ipc/register.ts validateTarget)——所有 TOOL_NOT_FOUND
 * 返回点必须共用本函数,新增返回点不得自写文案。导出供单测直测(规则 14)。
 */
export function toolNotFoundMessage(
  ghostId: string,
  tool: string,
  manifest: Partial<Pick<GhostManifest, 'schemaVersion' | 'tools' | 'mcpApps' | 'network'>>,
  audience?: 'model' | 'app',
): string {
  const declaredTools = manifest.tools ?? [];
  const names = declaredTools
    .filter((t) => !audience || pluginToolVisible(manifest, t.name, audience))
    .map((t) => t.name);
  // [MEKA] meka-unity 不提供 list_tools 动态清单；直说怎么调，避免模型反复重试未知工具。
  if (ghostId === 'meka-unity') {
    return (
      `插件 ${ghostId} 没有工具 ${tool};可用工具: ${names.length > 0 ? names.join(', ') : '(未声明任何工具)'}` +
      '。该插件不提供 list_tools 动态清单接口；请直接使用已声明的 unity_inspect 或 unity_execute，不要重试未知工具。'
    );
  }
  if (audience === 'model' && declaredTools.some((t) => t.name === tool) &&
      !pluginToolVisible(manifest, tool, 'model') && pluginToolVisible(manifest, tool, 'app')) {
    const ui = getPluginToolUi(manifest);
    const openers = names.filter((name) => ui?.tools[name]?.resourceUri);
    const next = openers.length
      ? `请先通过 ghost_call 调用模型可见的开页面工具: ${openers.join(', ')}，再由页面调用 ${tool}。`
      : `当前没有模型可见的开页面工具；请先查看模型可见的工具: ${names.length ? names.join(', ') : '(无)'}。`;
    return `插件 ${ghostId} 已声明工具 ${tool}，但它只供插件页面调用，模型不能直接 ghost_call。${next}不要据此判定插件缺少该能力。`;
  }
  if (names.includes('call_tool')) {
    return (
      `插件 ${ghostId} 没有名为 ${tool} 的顶层工具——它采用二级分派:具体操作经 call_tool 下发,` +
      `正确形态 ghost_call({ghost_id:"${ghostId}",tool:"call_tool",args:{name:"${tool}",args:{...}}});` +
      `操作名与参数先调 list_tools 查询。不要据此判定插件缺少该能力。`
    );
  }
  return `插件 ${ghostId} 没有工具 ${tool};可用工具: ${names.length > 0 ? names.join(', ') : '(未声明任何工具)'}`;
}

export class GhostPipeDispatcher {
  private readonly pending = new Map<string, PendingCall>();
  private readonly sessionCalls = new Map<string, Set<AbortController>>();
  /** 同实例重启单飞:并发调用撞上同一份死沙箱时只重启一次。 */
  private readonly sandboxRestarts = new Map<
    string,
    Promise<{ ok: true } | { ok: false; reason: string }>
  >();
  /** 实例最近一次受控重启时刻(冷却用)。 */
  private readonly lastSandboxRestartAt = new Map<string, number>();
  /**
   * 正在被恢复流程保护的 callId:重启会触发 stop/crashed 状态变化,派发器自己的
   * onRuntimeState 不得把手里的这一单提前结算掉,否则重投永远没机会发生。
   */
  private readonly recoveringCalls = new Set<string>();

  constructor(private readonly deps: PipeDispatcherDeps) {}

  /** 在途调用数(诊断/测试用)。 */
  pendingCount(): number {
    return this.pending.size;
  }

  hasPendingCallsFor(ghostId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.ghostId === ghostId) return true;
    }
    return false;
  }

  /**
   * 派活主入口(ghost 总机的 callGhostTool 回调)。
   * 永不 reject——一切失败都折叠成结构化 GhostToolCallResult。
   */
  async callGhostTool(request: Parameters<GhostPipeDispatcher['dispatchCall']>[0]): Promise<GhostToolCallResult> {
    // Remember Stop even while a sandbox starts, without changing legacy RPC
    // completion. Only an explicit Node opt-in consumes this cancellation gate.
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    const sessionId = request.sessionId;
    if (sessionId) {
      const calls = this.sessionCalls.get(sessionId) ?? new Set<AbortController>();
      calls.add(controller);
      this.sessionCalls.set(sessionId, calls);
    }
    try {
      return await this.dispatchCall({ ...request, signal: controller.signal });
    } finally {
      request.signal?.removeEventListener('abort', abort);
      if (sessionId) {
        const calls = this.sessionCalls.get(sessionId);
        calls?.delete(controller);
        if (calls?.size === 0) this.sessionCalls.delete(sessionId);
      }
    }
  }

  private async dispatchCall(request: {
    ghostId: string;
    namespace?: string | null;
    tool: string;
    args: Record<string, unknown>;
    /**
     * 预铸配对号(卡槽③:调用方需先向 cardService.registerCall 登记同一
     * callId,故由它铸好传入;缺省自铸,老调用方零改动)。
     */
    callId?: string;
    /** 仅供可信宿主内部调用方收短等待时间；插件不能控制该值。 */
    timeoutMs?: number;
    /** Trusted caller's MCP cancellation; not a plugin-controlled field. */
    signal?: AbortSignal;
    /** Trusted Host session attribution, never accepted from plugin input. */
    sessionId?: string;
    /** Host debug actions are explicitly excluded. Never exposed in plugin payloads. */
    recordUsage?: false;
    onProgress?: (progress: GhostToolProgress) => void;
    /** Native reader's explicit opening intent. Never sourced from tool args. */
    mailReaderOpened?: true;
  }): Promise<GhostToolCallResult> {
    const { ghostId, namespace, tool, args } = request;

    // ── 资格审 ─────────────────────────────────────────────────────────
    const ghost = this.deps.getGhost(ghostId, namespace);
    if (!ghost) {
      return { ok: false, errorCode: 'GHOST_NOT_FOUND', message: `插件 ${ghostId} 未安装或已卸载` };
    }
    if (!ghost.enabled) {
      return {
        ok: false,
        errorCode: 'GHOST_ASLEEP',
        message: `插件 ${ghostId} 未启用(可在主界面侧边栏「插件」中启用)`,
      };
    }
    // The requested id may be a logical Meka plugin id backed by a development
    // runtime install. All lifecycle and pipe operations use the resolved
    // physical instance key, never the logical id.
    const declared = ghost.manifest.tools?.some((t) => t.name === tool);
    if (!declared) {
      return { ok: false, errorCode: 'TOOL_NOT_FOUND', message: toolNotFoundMessage(ghostId, tool, ghost.manifest) };
    }
    const storagePart = installedGhostStoragePart(ghost);
    if (this.deps.runtimeStateOf(storagePart) === 'fused') {
      return {
        ok: false,
        errorCode: 'GHOST_CRASHED',
        message: `插件 ${ghostId} 已熔断(反复崩溃),重载或重新启用后再试`,
      };
    }
    let ownerScopeSnapshot: unknown;
    try {
      ownerScopeSnapshot = this.deps.ownerScope?.capture();
    } catch {
      return this.ownerBoundaryResult();
    }

    const callId = request.callId && request.callId.length > 0 ? request.callId : randomUUID();
    // ── 按需拉起 + 代次对齐 + 崩溃恢复 ─────────────────────────────────
    const stateBefore = this.deps.runtimeStateOf(storagePart);
    const running = stateBefore === 'running';
    if (!running) {
      this.deps.log?.info('ghost tool waiting for sandbox readiness', {
        ghostId: storagePart, tool, callId, state: stateBefore,
      });
    }
    // 代次对齐:沙箱报 running 不代表它就是**当前安装记录**拉起的。更新提交后旧
    // 沙箱可能仍 running 且不匹配新的目录／receipt／版本／namespace;此时直接派发
    // 会让调用落进旧页面,而旧页面的 receipt 分区已被 `cindy-ghost://` 目标守卫
    // 判过期,`/kv`、`/secrets`、`/oauth`、`/connections` 会持续 403,只能重启应用
    // (2026-11-18 dev 同步热更新实测)。spawn 是幂等的代次对齐入口:同身份立即返回,
    // 不匹配就停旧沙箱、拉起新代次并等它就绪,让活跃会话自动 rebind(不再依赖每条
    // 更新路径都记得停实例)。
    //
    // crashed 态优先走受控重启(2026-11-19 用户实测):沙箱崩溃后状态机可能停在
    // "已收尸但逻辑页绑定还在"的形态,后续每单都投递失败并永久报"电子脑离线"。
    // 这里先停再按当前安装记录从零拉起,比只调 spawn 更彻底(单飞+受每次调用一次
    // 限制,失败仍回原 GHOST_CRASHED)。
    if (!running || this.deps.isCurrentInstall?.(ghost) === false) {
      const spawned = stateBefore === 'crashed' && this.deps.restart
        ? await this.restartSandbox(ghost, storagePart, { respectCooldown: false })
        : await this.deps.spawn(ghost);
      if (!spawned.ok) {
        return { ok: false, errorCode: 'GHOST_CRASHED', message: `插件启动失败:${spawned.reason}` };
      }
    }
    if (!this.ownerScopeUsable(storagePart, ownerScopeSnapshot)) {
      return this.ownerBoundaryResult();
    }
    if (this.deps.runtimeStateOf(storagePart) !== 'running') {
      return { ok: false, errorCode: 'GHOST_CRASHED', message: '插件就绪前已停止' };
    }

    // ── 派发 + 配对等待 ────────────────────────────────────────────────
    let toolArgs = args;
    if (ghost.manifest.mail === true && ghost.manifest.mailReader?.tool === tool) {
      toolArgs = { ...args };
      delete toolArgs.markRead;
      delete toolArgs.openDraft;
      if (request.mailReaderOpened === true) toolArgs.openDraft = true;
      if (request.mailReaderOpened === true && ghost.manifest.mailReader.markRead === true)
        toolArgs.markRead = true;
    }
    const payload: GhostPipeToolCall = { type: 'tool-call', callId, tool, args: toolArgs };

    return new Promise<GhostToolCallResult>((resolve) => {
      const startedAt = Date.now();
      const baseTimeoutMs = this.baseTimeoutMs(request.timeoutMs);
      const entry: PendingCall = {
        sessionId: request.sessionId,
        ghostId: storagePart,
        tool,
        ownerScopeSnapshot,
        claimedBindings: new Map(),
        resolve,
        timer: undefined,
        startedAt,
        baseTimeoutMs,
        timeoutExtensionsAllowed: request.timeoutMs === undefined,
        deadlineAt: startedAt + baseTimeoutMs,
        holds: 0,
        lifetime: new AbortController(),
        sourceSignal: request.signal,
        onProgress: request.onProgress,
      };
      if (request.recordUsage !== false) {
        this.observeUsage(() => { entry.usage = this.deps.prepareUsage?.(ghost, callId, tool, request.sessionId); });
      }
      this.pending.set(callId, entry);
      this.armTimer(callId, entry);

      if (!this.ownerScopeUsable(storagePart, ownerScopeSnapshot)) {
        this.settle(callId, this.ownerBoundaryResult());
        return;
      }
      /**
       * 交付已到达逻辑卷。`refreshUsage` = 这次是受控重启后的重投:重启的 stop 已让
       * 旧 volume 的用量观测失效(`PluginInvocations.invalidate`),恢复成功的新
       * volume 要用同一 callId 重新建观测,否则这次**成功了**的调用反而不进用量/
       * 计费统计,还每次留 warn。
       */
      const acceptDelivery = (refreshUsage = false) => {
        if (refreshUsage && !entry.usageAccepted) this.refreshUsageObserver(entry, ghost, callId, tool, request.sessionId);
        entry.usageAccepted = true;
        this.observeUsage(() => entry.usage?.accepted(Date.now()));
        // A synchronous transport/test may already have returned the result.
        if (entry.usageOutcome) this.observeUsage(() => entry.usage?.settled(entry.usageOutcome!));
      };
      const settleOffline = () => {
        // 逻辑页不在线(拉起后瞬时死亡等):立即收卷。这是恢复失败后的原语义,
        // 用户可见文案不变。
        this.settle(callId, { ok: false, errorCode: 'GHOST_CRASHED', message: '电子脑离线,派发失败' });
      };
      const delivered = async (accepted: boolean) => {
        if (!this.ownerScopeUsable(storagePart, ownerScopeSnapshot)) {
          this.settle(callId, this.ownerBoundaryResult());
          return;
        }
        if (accepted) {
          acceptDelivery();
          return;
        }
        // 投递失败 = 逻辑页离线。先做**一次**受控重启,恢复后把同一份卷子重投一次
        // (2026-11-19 用户实测:330s 超时后沙箱永久离线,后续每单都直接失败,只能
        // 重开会话)。重启失败/重投仍失败都回到原 GHOST_CRASHED 语义,不无限重试。
        const recovered = await this.recoverOfflineSandbox(ghost, storagePart, callId);
        if (!recovered || !this.pending.has(callId)) {
          if (this.pending.has(callId)) settleOffline();
          return;
        }
        if (!this.ownerScopeUsable(storagePart, ownerScopeSnapshot)) {
          this.settle(callId, this.ownerBoundaryResult());
          return;
        }
        this.recoveringCalls.add(callId);
        let retried = false;
        try {
          const delivery = this.deps.sendToGhost(storagePart, payload);
          retried = typeof delivery === 'boolean' ? delivery : await delivery;
        } catch {
          retried = false;
        } finally {
          this.recoveringCalls.delete(callId);
        }
        if (retried) {
          // 重投成功但本单可能已在恢复期间被结算(超时/账号边界):只给仍在途的
          // 卷记 accepted,避免事后冒出一次无主的使用观测。重启会 invalidate 旧
          // volume 的 usage 观测,所以这一单要按同一 callId 重建观测后再记。
          if (this.pending.has(callId)) acceptDelivery(true);
          return;
        }
        if (this.pending.has(callId)) settleOffline();
      };
      try {
        const delivery = this.deps.sendToGhost(storagePart, payload);
        // Desktop IPC is synchronous; the headless Chromium transport confirms
        // delivery asynchronously. Both use the same once-only result record.
        if (typeof delivery === 'boolean') void delivered(delivery);
        else void delivery.then((accepted) => delivered(accepted), () => delivered(false));
      } catch { void delivered(false); }
    });
  }

  /**
   * 受控重启后重建用量观测(同一 callId)。
   *
   * 重启 = stop + spawn,stop 的 onStateChanged 会调 `PluginInvocations.invalidate`,
   * 旧 volume 的 observer 的 accepted/settled 全部抛 `INVALID_INVOCATION`(被
   * `observeUsage` 吞成一条 warn)。恢复成功的新 volume 必须重新登记观测,否则这次
   * 成功的调用不计入用量/计费。生产 `prepareUsage` 按 callId 幂等:真被 invalidate
   * 过就新建一条,没被清掉则复用同一条,不会重复记账。
   *
   * 重挂失败(插件被禁用/账号边界变了)时保留旧对象:行为回到修复前(该调用记不到
   * 账 + warn),不凭空造一条半截观测。
   */
  private refreshUsageObserver(
    entry: PendingCall,
    ghost: InstalledGhost,
    callId: string,
    tool: string,
    sessionId?: string,
  ): void {
    if (!entry.usage) return;
    this.observeUsage(() => {
      entry.usage = this.deps.prepareUsage?.(ghost, callId, tool, sessionId) ?? null;
    });
  }

  /**
   * 沙箱离线恢复(投递失败触发的单次受控重启)。
   *
   * 返回 true 仅当重启成功且运行时确实回到 running。单飞:并发的离线投递共享同一次
   * 重启;冷却阻止按调用连续重启抖动。没注入 restart(单测/旧装配)时直接 false,
   * 保持原 GHOST_CRASHED 行为。
   */
  private async recoverOfflineSandbox(
    ghost: InstalledGhost,
    storagePart: string,
    callId: string,
  ): Promise<boolean> {
    if (!this.deps.restart) return false;
    this.deps.log?.warn('ghost sandbox offline; attempting one controlled restart', {
      ghostId: storagePart,
      callId,
    });
    this.recoveringCalls.add(callId);
    let restarted: { ok: true } | { ok: false; reason: string };
    try {
      restarted = await this.restartSandbox(ghost, storagePart, { respectCooldown: true });
    } finally {
      this.recoveringCalls.delete(callId);
    }
    if (!restarted.ok) {
      this.deps.log?.warn('ghost sandbox restart failed; keeping the original GHOST_CRASHED', {
        ghostId: storagePart,
        callId,
        reason: restarted.reason,
      });
      return false;
    }
    return this.deps.runtimeStateOf(storagePart) === 'running';
  }

  /**
   * 受控重启的执行点:同实例单飞 + 可选冷却。
   *
   * 重启本身会触发 runtime 的 stop/starting/running 状态变化;`recoveringCalls`
   * 让 onRuntimeState 不提前结算正在等重投的那一单(其它在途卷照常收卷)。
   */
  private async restartSandbox(
    ghost: InstalledGhost,
    storagePart: string,
    options: { respectCooldown: boolean },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const restart = this.deps.restart;
    if (!restart) return { ok: false, reason: '派发通道不支持重启' };
    const existing = this.sandboxRestarts.get(storagePart);
    if (existing) return existing;
    if (options.respectCooldown) {
      const last = this.lastSandboxRestartAt.get(storagePart);
      if (last !== undefined && Date.now() - last < SANDBOX_RESTART_COOLDOWN_MS) {
        return { ok: false, reason: '沙箱刚刚重启过,冷却中' };
      }
    }
    // 先登记单飞 Promise、再真正启动重启:重启入口会同步触发 runtime 的 stop
    // 状态变化,`onRuntimeState` 靠这张表识别"这是主机自己的恢复动作"。
    const shared = Promise.resolve()
      .then(async () => {
        this.lastSandboxRestartAt.set(storagePart, Date.now());
        this.deps.log?.info('ghost sandbox controlled restart', { ghostId: storagePart });
        try {
          return await restart(ghost);
        } catch (error) {
          return {
            ok: false as const,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      })
      .finally(() => {
        // 单飞槽在 finally 里清空:此后再进来的调用会开启新一次重启。
        this.sandboxRestarts.delete(storagePart);
      });
    this.sandboxRestarts.set(storagePart, shared);
    return shared;
  }

  /** Cancel opt-in work and deny late opt-in; legacy completion remains unchanged. */
  cancelSessionCalls(sessionId: string): void {
    for (const controller of this.sessionCalls.get(sessionId) ?? []) controller.abort();
  }

  private cancelBoundCall(callId: string): void {
    this.settle(callId, { ok: false, errorCode: 'CANCELLED', message: 'Plugin tool call cancelled' }, 'cancelled');
  }

  /** Explicit call-bound capabilities (Node cancelWithCall / pick). Legacy tools keep their lifetime. */
  getPendingCallSignal(ghostId: string, callId: string): AbortSignal | null {
    const entry = this.pending.get(callId);
    if (!entry || entry.ghostId !== ghostId || !this.ownerScopeUsable(ghostId, entry.ownerScopeSnapshot)) return null;
    if (!entry.cancellationBound) {
      entry.cancellationBound = true;
      const abort = () => this.cancelBoundCall(callId);
      entry.sourceSignal?.addEventListener('abort', abort, { once: true });
      entry.detachAbort = () => entry.sourceSignal?.removeEventListener('abort', abort);
    }
    if (entry.sourceSignal?.aborted) {
      this.cancelBoundCall(callId);
      return null;
    }
    return entry.lifetime.signal;
  }

  getPendingCallSessionId(ghostId: string, callId: string): string | null {
    const entry = this.pending.get(callId);
    if (!entry?.cancellationBound || entry.ghostId !== ghostId || entry.lifetime.signal.aborted ||
      entry.sourceSignal?.aborted || !this.ownerScopeUsable(ghostId, entry.ownerScopeSnapshot)) return null;
    return entry.sessionId ?? null;
  }


  /**
   * 认领真实在途 tool-call 的宿主能力绑定。
   *
   * callerTool 必须与派发器事实表逐字匹配；同一 binding 只允许同 requestKey
   * 在暂态失败后重试一次，禁止换查询借用同一 callId 或无限消费付费通道。
   */
  claimPendingCall(
    ghostId: string,
    callId: string,
    callerTool: string,
    binding: string,
    requestKey: string,
  ): boolean {
    const entry = this.pending.get(callId);
    if (!entry || entry.ghostId !== ghostId || entry.tool !== callerTool) return false;
    const existing = entry.claimedBindings.get(binding);
    if (!existing) {
      entry.claimedBindings.set(binding, {
        callerTool,
        requestKey,
        attempts: 1,
        active: true,
        consumed: false,
      });
      return true;
    }
    if (
      existing.callerTool !== callerTool ||
      existing.requestKey !== requestKey ||
      existing.active ||
      existing.consumed ||
      existing.attempts >= 2
    ) {
      return false;
    }
    existing.attempts += 1;
    existing.active = true;
    return true;
  }

  /** 收束一次能力尝试；仅首次暂态失败可重新认领同一请求。 */
  settlePendingCallClaim(
    ghostId: string,
    callId: string,
    callerTool: string,
    binding: string,
    requestKey: string,
    allowRetry: boolean,
  ): boolean {
    const entry = this.pending.get(callId);
    const claim = entry?.claimedBindings.get(binding);
    if (
      !entry ||
      entry.ghostId !== ghostId ||
      entry.tool !== callerTool ||
      !claim ||
      claim.callerTool !== callerTool ||
      claim.requestKey !== requestKey ||
      !claim.active
    ) {
      return false;
    }
    claim.active = false;
    if (!allowRetry || claim.attempts >= 2) claim.consumed = true;
    return true;
  }

  /** 基础超时档(注入值钳到天花板内,保证初始 deadline 不越过绝对上限)。 */
  private baseTimeoutMs(override?: number): number {
    const requested = Number.isFinite(override)
      ? Math.max(1, Math.floor(override as number))
      : (this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return Math.min(requested, GHOST_PIPE_CALL_MAX_TOTAL_MS);
  }

  /** 按 entry.deadlineAt 重挂超时闹钟(旧闹钟一并清掉)。 */
  private armTimer(callId: string, entry: PendingCall): void {
    (this.deps.clearTimeoutFn ?? clearTimeout)(entry.timer);
    const setT = this.deps.setTimeoutFn ?? setTimeout;
    entry.timer = setT(() => {
      if (this.pending.delete(callId)) {
        this.noteUsageOutcome(entry, 'timed-out');
        entry.detachAbort?.();
        entry.lifetime.abort();
        this.deps.log?.warn('ghost tool call timed out', {
          ghostId: entry.ghostId,
          tool: entry.tool,
          callId,
          totalMs: Date.now() - entry.startedAt,
        });
        entry.resolve({
          ok: false,
          errorCode: 'TIMEOUT',
          message: `工具 ${entry.tool} 执行超时(任务可能仍在后台继续,稍后重试或许能直接取回已完成的结果)`,
        });
      }
    }, Math.max(0, entry.deadlineAt - Date.now()));
  }

  /**
   * 把在途卷的超时时刻至少延到 targetAt:只延不缩,且不超过派发起算的
   * GHOST_PIPE_CALL_MAX_TOTAL_MS 天花板(到顶后不再续,卷到点照常作废)。
   */
  private extendDeadline(callId: string, entry: PendingCall, targetAt: number): void {
    const cap = entry.startedAt + GHOST_PIPE_CALL_MAX_TOTAL_MS;
    const next = Math.min(Math.max(targetAt, entry.deadlineAt), cap);
    // <=:双保险守住"只延不缩"——即使 deadline 因注入值异常已在 cap 之上,
    // 也绝不反向收短(baseTimeoutMs 的钳制让这理论上不会发生)。
    if (next <= entry.deadlineAt) return;
    entry.deadlineAt = next;
    this.armTimer(callId, entry);
  }

  /**
   * 代办 hold:主机自己正为该卷干活(cindy 槽署名代办)时替它续命。
   * ghostId = 主机反查的代办发起方身份——与交卷/心跳同纪律配对校验,
   * 沙箱填错/冒用别人在途的 callId 不能续命他人的卷、也不污染其计数。
   * budgetMs = 这单代办自身的预算(如视频 expected×3);窗口延到
   * now + budget + 交卷余量。查无此卷/不是它的卷,静默忽略。
   *
   * 已知边界:callId 归因是插件自报的(记账同契约),同一意识自己的两个
   * 并发调用互填 callId 主机无从分辨(沙箱内部并发,主机没有"正在处理哪
   * 份卷"的会话状态)。错配只伤它自己:错署名的调用不获续命照常超时,
   * 被错挂的调用最多被延长;release 收窗下限是基础窗口(见 releaseCall),
   * 不会把任何卷收到无续命机制时的行为之下。
   */
  holdCall(ghostId: string, callId: string, budgetMs: number): void {
    const entry = this.pending.get(callId);
    if (!entry || entry.ghostId !== ghostId) return;
    if (!entry.timeoutExtensionsAllowed) return;
    entry.holds += 1;
    this.extendDeadline(callId, entry, Date.now() + budgetMs + HOLD_SETTLE_GRACE_MS);
  }

  /**
   * 代办收工:hold 计数归零时把窗口收回(不短于插件本来的基础窗口,并留
   * 交卷余量)——不让 16 分钟的 hold 在任务 3 分钟完成后继续吊着失败面。
   * 验身同 holdCall(冒名 release 不能提前收短别人的窗口)。
   */
  releaseCall(ghostId: string, callId: string): void {
    const entry = this.pending.get(callId);
    if (!entry || entry.ghostId !== ghostId) return;
    entry.holds = Math.max(0, entry.holds - 1);
    if (entry.holds > 0) return;
    const target = Math.max(
      entry.startedAt + entry.baseTimeoutMs,
      Date.now() + HOLD_SETTLE_GRACE_MS,
    );
    if (target < entry.deadlineAt) {
      entry.deadlineAt = target;
      this.armTimer(callId, entry);
    }
  }

  /**
   * 心跳续命(ghost-pipe:send 的 tool-progress 分支)。验身同交卷:callId
   * 不是派给你的即拒(拒因只进日志,不给沙箱探测面)。每次心跳把窗口
   * 重新续满一个基础档;天花板由 extendDeadline 统一钳制。
   */
  handleToolProgress(senderGhostId: string, payload: unknown): { accepted: boolean; reason?: string } {
    const p = payload as { callId?: unknown; progress?: unknown; total?: unknown; message?: unknown };
    if (typeof p?.callId !== 'string') {
      return { accepted: false, reason: 'tool-progress 载荷形状不合法' };
    }
    const entry = this.pending.get(p.callId);
    if (!entry) {
      return { accepted: false, reason: '卷子不存在或已过期' };
    }
    if (entry.ghostId !== senderGhostId) {
      return { accepted: false, reason: '不是你的卷子' };
    }
    if (!this.ownerScopeUsable(senderGhostId, entry.ownerScopeSnapshot)) {
      this.settle(p.callId, this.ownerBoundaryResult());
      return { accepted: false, reason: '账号边界已变化' };
    }
    if (p.progress !== undefined) {
      if (typeof p.progress !== 'number' || !Number.isFinite(p.progress) || p.progress < 0 ||
          (p.total !== undefined && (typeof p.total !== 'number' || !Number.isFinite(p.total) || p.total < p.progress)) ||
          (p.message !== undefined && (typeof p.message !== 'string' || p.message.length > 4096))) {
        return { accepted: false, reason: 'tool-progress 进度值不合法' };
      }
      entry.progressHighWater = Math.max(entry.progressHighWater ?? 0, p.progress);
      // The observer is Host-owned. It cannot change the legacy call's outcome.
      try { entry.onProgress?.({ progress: p.progress, ...(typeof p.total === 'number' ? { total: p.total } : {}),
        ...(typeof p.message === 'string' ? { message: p.message } : {}) }); } catch { /* detached View */ }
    }
    if (entry.timeoutExtensionsAllowed) {
      this.extendDeadline(p.callId, entry, Date.now() + entry.baseTimeoutMs);
    }
    return { accepted: true };
  }

  /** Host transfers use cumulative work units across phases; byte counts stay in the phase message. */
  createHostProgress(ghostId: string, callId: string | undefined) {
    const entry = callId ? this.pending.get(callId) : undefined;
    let previousBytes = 0;
    return (bytes: number | undefined, total: number | undefined, message: string): void => {
      if (!entry || !callId || this.pending.get(callId) !== entry || entry.ghostId !== ghostId) return;
      const delta = bytes === undefined ? 1 : Math.max(0, bytes - previousBytes);
      if (bytes !== undefined) previousBytes = bytes;
      if (delta === 0) return;
      const progress = (entry.progressHighWater ?? 0) + delta;
      this.handleToolProgress(ghostId, { callId, progress,
        ...(total !== undefined && bytes !== undefined ? { total: progress + Math.max(0, total - bytes) } : {}),
        message: bytes === undefined ? message : `${message} (${bytes}${total === undefined ? '' : ` / ${total}`} bytes)`,
      });
    };
  }

  /**
   * 交卷(ghost-pipe:send 的 tool-result 分支)。
   * senderGhostId 来自主机按 webContents 反查的身份——callId 配对之外再验
   * "这份卷子当初是不是派给你的",别的意识拿到 callId 也交不了。
   */
  handleToolResult(
    senderGhostId: string,
    payload: unknown,
  ): { accepted: boolean; reason?: string } {
    const p = payload as {
      callId?: unknown;
      ok?: unknown;
      result?: unknown;
      images?: unknown;
      errorCode?: unknown;
      message?: unknown;
    };
    if (typeof p?.callId !== 'string' || typeof p?.ok !== 'boolean') {
      return { accepted: false, reason: 'tool-result 载荷形状不合法' };
    }
    const entry = this.pending.get(p.callId);
    if (!entry) {
      // 超时作废/重复交卷:丢弃即可,不给沙箱探测在途表的机会。
      return { accepted: false, reason: '卷子不存在或已过期' };
    }
    if (entry.ghostId !== senderGhostId) {
      this.deps.log?.warn('ghost tool result identity mismatch', {
        callId: p.callId,
        expected: entry.ghostId,
        actual: senderGhostId,
      });
      return { accepted: false, reason: '不是你的卷子' };
    }
    if (!this.ownerScopeUsable(senderGhostId, entry.ownerScopeSnapshot)) {
      this.settle(p.callId, this.ownerBoundaryResult());
      return { accepted: false, reason: '账号边界已变化' };
    }
    // Images for the model ride next to `result`; invalid ones are dropped here.
    const shown = p.ok ? normalizeGhostModelImages(p.images) : { images: [], dropped: 0 };
    if (shown.dropped) {
      this.deps.log?.warn('ghost tool result images dropped', { callId: p.callId, dropped: shown.dropped });
    }
    const result: GhostToolCallResult = p.ok
      ? { ok: true, result: p.result ?? null, ...(shown.images.length ? { images: shown.images } : {}) }
      : {
          ok: false,
          errorCode: isGhostPluginErrorCode(p.errorCode) ? p.errorCode : 'INTERNAL',
          message: typeof p.message === 'string' ? p.message : '插件执行失败',
        };
    this.settle(p.callId, result);
    return { accepted: true };
  }

  /**
   * 运行时状态钩子:意识崩溃/熔断/熄灯时,把它名下全部在途调用收掉
   * (brain/index.ts 在 onStateChanged 里接线)。
   *
   * 恢复流程自己会 stop/spawn 并制造这些状态变化:正在等重投的那一单必须留下
   * (`recoveringCalls`),否则重投永远没机会发生;同一实例的其它在途卷照常收卷。
   */
  onRuntimeState(ghostId: string, state: GhostRuntimeState): void {
    if (state === 'running' || state === 'starting') return;
    const isCrash = state === 'crashed' || state === 'fused';
    // 恢复流程里的 stop 不是"用户停用":同一实例的其它在途卷按崩溃收卷,别把
    // 「沙箱正在重启」谎报成 GHOST_ASLEEP(那会让 agent 以为插件被禁用)。
    const recoveringSandbox = this.sandboxRestarts.has(ghostId);
    for (const [callId, entry] of [...this.pending]) {
      if (entry.ghostId !== ghostId) continue;
      if (this.recoveringCalls.has(callId)) continue;
      this.settle(
        callId,
        isCrash || recoveringSandbox
          ? { ok: false, errorCode: 'GHOST_CRASHED', message: '插件执行中崩溃' }
          : { ok: false, errorCode: 'GHOST_ASLEEP', message: '插件执行中被停用' },
      );
    }
  }

  private settle(callId: string, result: GhostToolCallResult, outcome: PluginUsageOutcome = result.ok ? 'succeeded' : 'failed'): void {
    const entry = this.pending.get(callId);
    if (!entry) return;
    this.pending.delete(callId);
    this.noteUsageOutcome(entry, outcome);
    (this.deps.clearTimeoutFn ?? clearTimeout)(entry.timer);
    entry.detachAbort?.();
    entry.lifetime.abort();
    this.deps.log?.info('ghost tool call completed', {
      ghostId: entry.ghostId,
      tool: entry.tool,
      callId,
      ok: result.ok,
      ...(result.ok ? {} : { errorCode: result.errorCode }),
      totalMs: Date.now() - entry.startedAt,
    });
    entry.resolve(result);
  }

  private noteUsageOutcome(entry: PendingCall, outcome: PluginUsageOutcome): void {
    entry.usageOutcome = outcome;
    if (entry.usageAccepted) this.observeUsage(() => entry.usage?.settled(outcome));
  }

  private observeUsage(fn: () => void): void {
    try { fn(); } catch { this.deps.log?.warn('plugin usage observer unavailable'); }
  }

  private ownerScopeUsable(ghostId: string, captured: unknown): boolean {
    if (isGhostOwnerScopeUsable(this.deps.ownerScope, captured)) return true;
    this.deps.ownerScope?.onInvalidated?.(ghostId);
    return false;
  }

  private ownerBoundaryResult(): GhostToolCallResult {
    return {
      ok: false,
      errorCode: 'GHOST_ASLEEP',
      message:
        'Plugin owner boundary changed before dispatch; retry after the active session settles.',
    };
  }
}
