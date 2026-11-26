import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import {
  getDraft,
  patchDraft,
  type NewMakerDraft,
  type NewMakerDraftPsbTarget,
} from '@/state/newMakerDraft';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { tryGetPsbRemoteBridge, type PsbRemoteBridge } from '@/features/remote-workspace/bridge';
import {
  buildPsbDraftTarget,
  type PsbDraftRouteTarget,
} from '@/features/remote-workspace/draft/psbDraftTarget';
import {
  createPsbSessionGate,
  releasePsbDraftTarget,
  type PsbEnsureResult,
  type PsbSessionGate,
} from '@/features/remote-workspace/draft/psbDraftSession';
import type { RemoteWorkspacePickerCreated } from '@/features/remote-workspace/dialog/psbDialogModel';
import type { PsbAgentKind } from '../../../shared/psb-remote-workspace';

import {
  consumeNewMakerNavigationIntent,
  type NewMakerNavigationIntent,
} from './lib/newMakerRouteState';

/**
 * 远程工作区（PSB）**草稿目标生命周期**的唯一所有者。
 *
 * ## 为什么必须收成一个 hook
 *
 * 收敛前，PSB 草稿的阶段散在路由的 5 个 ref + 3 个 effect + 2 个 useCallback 里：
 * 「已占用目标」（放弃时要还）、「已被本地会话接手」（不再还）、「在途懒建」（要合并 +
 * 跨重试复用）、「一次性交接意图」（要去重 + 消费 history state）、「换目标」（要还上一个）。
 * 矩阵的每一格都由不同代码段各记一遍，漏一格的表现是**远端协作锁永久留在自己名下**
 * （PSB 的占用没有 TTL，只能去网页手动解）或第二条 PSB 会话。
 *
 * 这里把状态机收进一个有明确边界的 hook，依赖全部注入（草稿 store / bridge / 导航 / toast），
 * 所以可以用 renderHook + mock bridge 钉住四条主路径：成功、失败、已接手（committed）、
 * 放弃草稿。
 *
 * ## 所有权边界
 *
 * 它**不**拥有「目标落到草稿时要连带清什么」——那是路由的 `applyDraftTarget`（mention chip /
 * 附件 / worktree 三态 / 远程运行配置）。hook 只管 PSB 的资源生命周期：懒建会话、占用释放、
 * 一次性交接意图。目标字段本身的派生与互斥在 `state/newMakerDraft.ts` 的归约里。
 */
export interface UsePsbDraftTargetOptions {
  draft: NewMakerDraft;
  /** PSB 桥（默认 `tryGetPsbRemoteBridge`；测试注入 mock）。 */
  getBridge?: () => PsbRemoteBridge | null;
  /** 把目标落到草稿（注入路由的 `applyDraftTarget`）。 */
  applyTarget: (target: NewMakerDraftPsbTarget) => void;
  dataOwnerId: string | null;
  /** 当前 history entry（一次性交接意图的读取与消费）。 */
  location: {
    pathname: string;
    search: string;
    hash: string;
    state: unknown;
    key: string;
  };
  navigate: (to: string, options: { replace: boolean; state: unknown }) => void;
  /** 渲染时的「一次性导航意图」（由路由用唯一 reader 读出）。 */
  intent: NewMakerNavigationIntent | null;
  /** 发送 / 目录恢复在途：此刻不允许换目标（读取最新值，不冻结渲染闭包）。 */
  isBusy: () => boolean;
  toastWarning: (message: string) => void;
  t: (key: string) => string;
  logWarn: (message: string, error: unknown) => void;
}

export interface PsbDraftTargetController {
  /** 应用一次性交接意图（route 的 layout effect 调用）；应用后消费 history state。 */
  applyNavigationIntent: () => void;
  /**
   * 选中一个工作区（弹窗 / 渠道下拉共用）。发送或目录恢复在途时拒绝，并把**刚被占用、
   * 但没进草稿**的工作区还回去——占用没有 TTL，不进草稿就没人会再释放它。
   */
  /** 返回是否被接受（false = 在途拒绝，调用方不要改渠道选中态）。 */
  selectWorkspace: (created: RemoteWorkspacePickerCreated | PsbDraftRouteTarget) => boolean;
  /**
   * 首条消息发送前确保 PSB 会话存在。`null` = 草稿没有 PSB 目标（调用方本来就不该发）。
   * 失败/桥缺失/目标已变返回非 ok，调用方据此**不建本地会话**并停留草稿。
   */
  ensureSessionForSend: (
    agentKind: PsbAgentKind,
    title?: string | null,
  ) => Promise<PsbEnsureResult | null>;
  /** 首条消息成功、本地会话接手该工作区：之后的离开**不再**释放占用。 */
  commit: () => void;
  /** 已由本地会话接手（诊断 / 测试用）。 */
  isCommitted: () => boolean;
  /** 当前占用持有者（诊断 / 测试用）。 */
  occupiedTarget: () => NewMakerDraftPsbTarget | null;
}

export function usePsbDraftTarget(options: UsePsbDraftTargetOptions): PsbDraftTargetController {
  // 所有输入经 ref 读最新值：hook 的回调身份保持稳定，路由的 memo 行 handler 不会被打穿，
  // 同时避免把「本轮渲染的旧闭包」写进异步发送路径。
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const psbTarget = options.draft.psbTarget;
  const psbTargetRef = useRef<NewMakerDraftPsbTarget | null>(psbTarget);
  psbTargetRef.current = psbTarget;

  /** 当前占用由草稿持有（放弃时要还）。 */
  const occupiedTargetRef = useRef<NewMakerDraftPsbTarget | null>(psbTarget);
  occupiedTargetRef.current = psbTarget;
  /** 已被本地会话接手：占用归那条会话，草稿卸载/换目标时不再释放。 */
  const committedRef = useRef(false);
  const ownerStampRef = useRef(getDataOwnerGeneration());
  ownerStampRef.current = getDataOwnerGeneration();

  const gateRef = useRef<PsbSessionGate | null>(null);
  const bridgeOf = useCallback(
    () => optionsRef.current.getBridge?.() ?? tryGetPsbRemoteBridge(),
    [],
  );
  if (!gateRef.current) gateRef.current = createPsbSessionGate();
  const handledIntentRef = useRef<string | null>(null);

  const release = useCallback((target: NewMakerDraftPsbTarget | null) => {
    releasePsbDraftTarget(target, {
      getBridge: bridgeOf,
      logWarn: (message, error) => optionsRef.current.logWarn(message, error),
    });
  }, []);

  /** 目标落到草稿；新目标 = 上一笔占用不再由本目标持有。 */
  const apply = useCallback((next: NewMakerDraftPsbTarget) => {
    committedRef.current = false;
    gateRef.current?.reset();
    occupiedTargetRef.current = next;
    optionsRef.current.applyTarget(next);
  }, []);

  // 页内换目标（换工作区 / 退回本机 / 换项目）= 放弃上一处占用。
  // sessionId 回写（懒建成功）不算换目标，必须按 workspaceId 比较。
  const previousTargetRef = useRef<NewMakerDraftPsbTarget | null>(psbTarget);
  useEffect(() => {
    const previous = previousTargetRef.current;
    previousTargetRef.current = psbTarget;
    if (!previous) return;
    if (psbTarget && previous.workspaceId === psbTarget.workspaceId) return;
    gateRef.current?.reset();
    if (committedRef.current) return;
    release(previous);
  }, [psbTarget, release]);

  // 离开草稿页 = 放弃这次草稿。发送成功路径会先 `commit()`，因此这里不会误释放
  // 「已经被新会话接手」的工作区/会话。
  useEffect(
    () => () => {
      const abandoned = occupiedTargetRef.current;
      const committed = committedRef.current;
      gateRef.current?.reset();
      if (!abandoned || committed) return;
      release(abandoned);
      // 只清理**属于自己的、仍然是同一个目标**的草稿字段：
      //   · 账号/数据 owner 变了 → 不碰新 owner 的草稿（旧草稿已按 owner 分命名空间保存）；
      //   · 用户已经显式切到别的目标（含「对话」）→ store 里目标已被归约清掉，不再写；
      // 清理不再无条件 `patchDraft({ psbTarget: null, explicitNoProject: false })`：
      // 那样会把用户刚落下的显式「对话」意图改回「未决定」，下一次通用新建又会被默认目录预填。
      if (!isDataOwnerGenerationCurrent(ownerStampRef.current)) return;
      const current = getDraft();
      if (current.psbTarget?.workspaceId !== abandoned.workspaceId) return;
      patchDraft({ psbTarget: null });
    },
    [release],
  );

  const applyNavigationIntent = useCallback(() => {
    const { intent, dataOwnerId, location, navigate } = optionsRef.current;
    if (!intent || intent.kind !== 'psbTarget' || !dataOwnerId) return;
    // 去重键 = owner + 意图 id。同一个工作区可以被再次交接（用户又点了一次「新建任务」），
    // 意图 id 每次新建，所以第二次交接不会被静默吞掉。
    const token = `${dataOwnerId}:${intent.requestId}`;
    if (handledIntentRef.current !== token) {
      handledIntentRef.current = token;
      const next = buildPsbDraftTarget(intent);
      // 回到**同一个**工作区时沿用已懒建的 sessionId：否则会用一份 sessionId=null 的目标
      // 覆盖草稿，让上一条 PSB 会话变成孤儿（占用仍在这条 Cindy 会话上，重发才会再建第二条）。
      const current = getDraft().psbTarget;
      if (current && current.workspaceId === next.workspaceId) {
        next.sessionId = current.sessionId ?? null;
      }
      apply(next);
    }
    // 一次性导航指令：应用后从 history state 移除（唯一消费口），避免浏览器后退到旧记录
    // 时再次应用。其它 route state 原样保留。
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: consumeNewMakerNavigationIntent(location.state, intent),
    });
  }, [apply]);

  const selectWorkspace = useCallback(
    (created: RemoteWorkspacePickerCreated | PsbDraftRouteTarget) => {
      const deps = optionsRef.current;
      if (deps.isBusy()) {
        const current = psbTargetRef.current;
        if (current?.workspaceId !== created.workspaceId) {
          const bridge = bridgeOf();
          if (bridge) {
            void bridge.releaseWorkspace({ workspaceId: created.workspaceId }).catch((error) => {
              deps.logWarn(
                'psb: releasing the workspace occupied by a rejected selection failed',
                error,
              );
            });
          }
        }
        // 不能静默：用户刚点完选择却什么都没发生，至少要说明为什么。
        deps.toastWarning(deps.t('remoteWorkspace.draft.actionBusy'));
        return false;
      }
      const next = buildPsbDraftTarget(created);
      const current = psbTargetRef.current;
      if (current && current.workspaceId === next.workspaceId) {
        next.sessionId = current.sessionId ?? null;
      }
      apply(next);
      return true;
    },
    [apply],
  );

  const ensureSessionForSend = useCallback(
    async (agentKind: PsbAgentKind, title?: string | null): Promise<PsbEnsureResult | null> => {
      const target = getDraft().psbTarget;
      if (!target) return null;
      return gateRef.current!.ensure({
        target,
        agentKind,
        title: title ?? null,
        getBridge: bridgeOf,
        isCurrentTarget: () => {
          const current = getDraft().psbTarget;
          return !!current && current.workspaceId === target.workspaceId;
        },
        onSessionCreated: (sessionId) => {
          // 返回值 = 这次会话有没有**真正**被草稿接住：懒建完成时用户可能已经换了目标，
          // 未采纳时由 `psbDraftSession` 负责停掉这条孤儿会话并保留去重键。
          const current = getDraft().psbTarget;
          if (!current || current.workspaceId !== target.workspaceId) return false;
          patchDraft({ psbTarget: { ...current, sessionId } });
          return getDraft().psbTarget?.sessionId === sessionId;
        },
      });
    },
    [],
  );

  const commit = useCallback(() => {
    committedRef.current = true;
    gateRef.current?.reset();
  }, []);

  // 一次性交接意图用 layout effect 应用：必须在首帧前落到草稿，用户不会看到默认目录/对话
  // 闪一帧。route 会把本 hook 的这个 effect 放在其它目标 effect 之前（顺序由调用点保证）。
  //
  // 依赖必须包含**本轮渲染读到的** intent 与 history entry：草稿页内再次导航到同一路径
  // （侧栏「远程工作区」选定工作区 → `/cc-agent/new` 只换 history state，不 remount）时，
  // 只用回调用调用点渲染一次这个 effect 不会重跑 —— 新意图既不落到草稿也不被消费，弹窗那侧
  // 刚占用成功的工作区因此没有任何释放路径（占用没有 TTL）。onMount 之外的重跑去重由
  // `applyNavigationIntent` 自己的 owner+requestId 键保证：同一个意图不会被应用两次。
  const navigationIntent = options.intent;
  const locationKey = options.location.key;
  useLayoutEffect(() => {
    applyNavigationIntent();
  }, [applyNavigationIntent, navigationIntent, locationKey]);

  // Controller 身份稳定：路由把它放进 `handleSend` / `handleCreateGoal` 的 deps，字面量对象
  // 每次渲染都换身份会打穿那两个巨型 useCallback 的 memo（行 handler / ChatInput props 跟着重算）。
  return useMemo<PsbDraftTargetController>(
    () => ({
      applyNavigationIntent,
      selectWorkspace,
      ensureSessionForSend,
      commit,
      isCommitted: () => committedRef.current,
      occupiedTarget: () => occupiedTargetRef.current,
    }),
    [applyNavigationIntent, selectWorkspace, ensureSessionForSend, commit],
  );
}
