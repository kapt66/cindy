/**
 * 工作区选择器的**共享选择引擎**（弹窗与草稿页下拉只留壳）。
 *
 * 2026-11-26 独立审查：两个入口各自实现了「列出 → 占用 → 失败刷新补占用人名 →
 * hydrate VCS 通知 → 内联错误」这一整条链，逐行同构、bug 要修两遍。现在链路只在这里：
 *
 *   1. 打开时拉一次列表（不轮询），并订阅 `onWorkspaceChanged` 把别人的占用/释放实时落到行上；
 *   2. 选择即占用（PSB 协作锁；2026-11-27 起无人占用时先确认）：占用失败时刷新列表，把
 *      「谁抢走了」从工作区行 `occupancy.personName` 补进失败事实（IPC 只带人名，拿不到时
 *      人名就是空）；
 *   3. 占用成功 / 失败后都兜底 `hydrateWorkspaceVcsNotice`（推送与 invoke 返回的先后不可依赖），
 *      并顺手记住工作区显示名（全局 VCS 横幅要写「工作区名 · 提示」）；
 *   4. **有 VCS 通知时由调用方抑制通用错误**（同一事实不双显，见返回的 `visibleActionError`）；
 *   5. **忙时也有出口**：占用有超时（`PSB_OCCUPY_TIMEOUT_MS`），调用方可以 `cancel()`（关闭
 *      弹窗 / 卸载下拉）；取消或超时之后才落地的占用**会被还回去**并记账，不留无名占用。
 *
 * ## 选择状态机（2026-11-27 用户复测：按占用状态区分选择流程）
 *
 * 行点击不再等于「立刻占用」：
 *
 *   - `requestSelect(workspace)`：**已是 mine** → 立即返回可交接载荷（不发占用请求）；
 *     **不可选**（他人占用 / 离线 / 未就绪）→ no-op；**无人占用** → 只进入 `pendingOccupy`
 *     （确认弹窗数据），不占用；
 *   - `confirmOccupy()`：用户确认后才走 `occupy()`；成功返回载荷并记为「本次选择新占用」，
 *     失败保持现状（`actionError` / VCS 通知）；
 *   - `cancelOccupy()` / 切换行：清掉 pending，不占用；
 *   - `handoffSelection()`：把已占用的选择交给调用方（创建任务 / 草稿采用）。交接之后**不再归还**；
 *   - 交接之前切换选择、关闭弹窗或卸载：本 hook 会区分「本次选择期间新占用的」与「选之前就已是
 *     mine 的」——只有前者需要归还（复用 `releasePsbWorkspaceOccupancy` 与待释放账本，
 *     每次选择至多归还一次；后者不是我们占的锁，不能替别人/别的任务释放）。
 *
 * 纯 UI 状态（弹窗页签、新建工作区表单）留在容器里，不进本 hook。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  psbWorkspaceHealth,
  type PsbOccupyWorkspaceResult,
  type PsbRemoteWorkspace,
} from '../../../../shared/psb-remote-workspace';
import { tryGetPsbRemoteBridge } from '../bridge';
import { releasePsbWorkspaceOccupancy } from '../draft/psbPendingReleaseLedger';
import {
  hydrateWorkspaceVcsNotice,
  rememberWorkspaceVcsNoticeWorkspaceLabel,
  useWorkspaceVcsNotices,
  type WorkspaceVcsNoticeState,
} from '../vcs/vcsNoticeStore';
import {
  psbFailureWithPersonName,
  psbOccupyTimeoutFailure,
  readPsbFailure,
  type PsbFailureInfo,
} from './psbFailure';
import {
  psbWorkspaceCreatedPayload,
  type RemoteWorkspacePickerCreated,
} from './psbSessionIdentity';
import {
  psbWorkspaceRowDisplayName,
  psbWorkspaceRowLabels,
  type PsbWorkspaceRowLabels,
} from './psbWorkspaceDisplay';

/** 占用超时：PSB 正常几百毫秒内返回；等太久说明连接卡住，给用户可行动失败而不是无限转圈。 */
export const PSB_OCCUPY_TIMEOUT_MS = 20_000;

/** 等待用户确认占用的工作区（容器据此弹确认框；确认前不发占用请求）。 */
export interface PsbPendingOccupy {
  readonly workspace: PsbRemoteWorkspace;
}

/**
 * `requestSelect()` 的结果：
 *
 * - `selected`：这个工作区**已经**由我占用，可以直接交接（mine 行不弹确认、不发占用）；
 * - `confirm`：无人占用，容器要先弹确认框，用户确认后走 `confirmOccupy()`；
 * - `blocked`：不可选（他人占用 / 离线 / 未就绪）或容器忙，调用方什么都不做。
 *
 * `releasedWorkspaceId` = 本次切换已经归还的、此前**本次选择期间新占用**的工作区 id
 * （把选择从 A 换到 B 时立刻归还 A；没有归还时为 `null`）。容器据此清掉旧行的选中态。
 */
export type PsbWorkspaceSelectOutcome =
  | {
      readonly kind: 'selected';
      readonly created: RemoteWorkspacePickerCreated;
      readonly releasedWorkspaceId: string | null;
    }
  | {
      readonly kind: 'confirm';
      readonly workspace: PsbRemoteWorkspace;
      readonly releasedWorkspaceId: string | null;
    }
  | { readonly kind: 'blocked' };

export interface PsbWorkspaceSelectionOptions {
  /** 下拉/弹窗是否打开；关闭时不再发请求、不订阅推送。 */
  readonly open: boolean;
  /** 外部在途锁（草稿发送 / 目录恢复）：为 true 时不允许再发起占用。 */
  readonly disabled?: boolean;
}

export interface PsbWorkspaceSelection {
  readonly workspaces: readonly PsbRemoteWorkspace[];
  readonly labels: ReadonlyMap<string, PsbWorkspaceRowLabels>;
  readonly listLoading: boolean;
  readonly listError: PsbFailureInfo | null;
  /** 占用失败（VCS 通知存在时由 `visibleActionError` 抑制）。 */
  readonly actionError: PsbFailureInfo | null;
  /** 渲染用：VCS 通知存在时不再显示通用错误（同一事实不双显）。 */
  readonly visibleActionError: PsbFailureInfo | null;
  /** 本次占用尝试的 VCS 通知（可能为 `null`：不是 VCS 失败 / main 没有缓存）。 */
  readonly vcsNotice: WorkspaceVcsNoticeState | null;
  /** 正在占用的工作区 id（行上显示 spinner）。 */
  readonly occupyingId: string | null;
  /** 是否有占用在途（容器据此把按钮/行切到忙态）。 */
  readonly busy: boolean;
  /** 重新拉列表（返回最新列表，失败返回 null）。 */
  readonly refresh: () => Promise<readonly PsbRemoteWorkspace[] | null>;
  /**
   * 占用一个工作区；成功返回工作区级交接载荷，失败 / 取消 / 超时返回 `null`
   * （失败事实在 `actionError` / `vcsNotice`）。
   *
   * 容器不应直接调用它：行选择走 `requestSelect` → （确认）→ `confirmOccupy`，这样
   * 「无人占用先确认、已是 mine 不确认」的口径只在这个 hook 里。
   */
  readonly occupy: (workspace: PsbRemoteWorkspace) => Promise<RemoteWorkspacePickerCreated | null>;
  /** 等待用户确认占用的工作区（`null` = 没有待确认的选择）。 */
  readonly pendingOccupy: PsbPendingOccupy | null;
  /**
   * 选择工作区（行点击 / 键盘激活）：mine 直接返回载荷、无人占用只进入待确认、不可选 no-op。
   * 不在这里发占用请求。
   */
  readonly requestSelect: (workspace: PsbRemoteWorkspace) => PsbWorkspaceSelectOutcome;
  /**
   * 用户确认占用后调用：走 `occupy()`，成功返回可交接载荷并登记「本次选择新占用」。
   * 失败返回 `null`，失败事实仍在 `actionError` / `vcsNotice`（保持未选中）。
   */
  readonly confirmOccupy: () => Promise<RemoteWorkspacePickerCreated | null>;
  /** 用户放弃确认（或切换行）：清掉 `pendingOccupy`，不发占用。 */
  readonly cancelOccupy: () => void;
  /** 当前已占用、等待交接的工作区 id（`null` = 还没有可交接的选择）。 */
  readonly heldWorkspaceId: string | null;
  /**
   * 交接：把已占用的选择交给调用方（创建任务 / 草稿采用），返回交接载荷；没有可交接的选择时
   * `null`。**交接成功后本 hook 不再归还这把锁**（交给草稿 / 任务自己的生命周期）。
   */
  readonly handoffSelection: () => RemoteWorkspacePickerCreated | null;
  /**
   * 放弃本次在途占用（关闭弹窗 / 下拉卸载 / 换目标）。
   *
   * 已成功但还没被调用方接手的占用会被释放并记账（占用无 TTL，不能留无名锁）；待确认的选择
   * 一并清掉。
   */
  readonly cancel: () => void;
  /** 用户换了选中行：收起上一次的占用失败提示（旧提示不再对应当前选择）。 */
  readonly dismissError: () => void;
  /**
   * 新建工作区成功但列表请求失败/尚未反映时，把刚建出的工作区补进列表（保证用户看得到）。
   * 只影响本地列表，不发请求。
   */
  readonly adoptWorkspace: (workspace: PsbRemoteWorkspace) => void;
}

interface OccupyAttempt {
  cancelled: boolean;
  /** 已经放弃这次尝试：它若之后成功落地，必须把占用的工作区还回去。 */
  releaseOnLateSuccess: boolean;
  /** 已发过释放请求：迟到结算与取消竞态可能同时看到「成功了」，只能还一次。 */
  releaseRequested: boolean;
}

/**
 * 当前已占用、等待交接的选择。
 *
 * `newlyOccupied` 是归还语义的分界线：只有**本次选择期间**由本 hook 占用的工作区在放弃选择时
 * 需要归还；选之前就已是 mine 的锁不是我们占的（可能是同一用户另一条任务），不能替它释放。
 */
interface HeldSelection {
  readonly workspaceId: string;
  readonly created: RemoteWorkspacePickerCreated;
  readonly newlyOccupied: boolean;
}

/** 超时信号（不是 PSB 失败码；文案按「连不上 PSB」处理）。 */
const OCCUPY_TIMEOUT_SIGNAL = Symbol('psb-occupy-timeout');

function withOccupyTimeout(
  call: Promise<PsbOccupyWorkspaceResult>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<PsbOccupyWorkspaceResult> {
  return new Promise<PsbOccupyWorkspaceResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(OCCUPY_TIMEOUT_SIGNAL);
    }, timeoutMs);
    call.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function usePsbWorkspaceSelection(
  options: PsbWorkspaceSelectionOptions,
): PsbWorkspaceSelection {
  const { open, disabled = false } = options;
  const { t } = useTranslation();

  const [workspaces, setWorkspaces] = useState<readonly PsbRemoteWorkspace[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<PsbFailureInfo | null>(null);
  const [actionError, setActionError] = useState<PsbFailureInfo | null>(null);
  const [occupyingId, setOccupyingId] = useState<string | null>(null);
  /**
   * 本次占用尝试的工作区 id：占用失败后用它把 main 缓存的版本控制通知拉进 store 并在容器内
   * 以内联形态展示；不在打开时给每个工作区各读一次通知。
   */
  const [vcsNoticeWorkspaceId, setVcsNoticeWorkspaceId] = useState<string | null>(null);

  const vcsNoticeStates = useWorkspaceVcsNotices();
  const vcsNotice = useMemo(
    () => vcsNoticeStates.find((entry) => entry.workspaceId === vcsNoticeWorkspaceId) ?? null,
    [vcsNoticeStates, vcsNoticeWorkspaceId],
  );

  const aliveRef = useRef(true);
  const attemptRef = useRef<OccupyAttempt | null>(null);
  /** 已占用、等待交接的选择（渲染只读 `heldWorkspaceId` 状态，判定一律读这个 ref）。 */
  const heldRef = useRef<HeldSelection | null>(null);
  const [heldWorkspaceId, setHeldWorkspaceId] = useState<string | null>(null);
  /** 待确认的选择；ref 供确认 / 取消的同步路径读取（state 只负责让容器渲染）。 */
  const pendingRef = useRef<PsbPendingOccupy | null>(null);
  const [pendingOccupy, setPendingOccupy] = useState<PsbPendingOccupy | null>(null);

  const refresh = useCallback(async (): Promise<readonly PsbRemoteWorkspace[] | null> => {
    const bridge = tryGetPsbRemoteBridge();
    if (!bridge) {
      if (aliveRef.current) setListError(readPsbFailure(null));
      return null;
    }
    setListLoading(true);
    setListError(null);
    try {
      const result = await bridge.listWorkspaces();
      if (!aliveRef.current) return result.workspaces;
      setWorkspaces(result.workspaces);
      return result.workspaces;
    } catch (error) {
      if (aliveRef.current) setListError(readPsbFailure(error));
      return null;
    } finally {
      if (aliveRef.current) setListLoading(false);
    }
  }, []);

  const abandonAttempt = useCallback(() => {
    const attempt = attemptRef.current;
    if (!attempt) return;
    attempt.cancelled = true;
    attempt.releaseOnLateSuccess = true;
    attemptRef.current = null;
  }, []);

  /**
   * 归还「本 hook 为这次选择新占用、但还没交接」的工作区；返回被归还的 id。
   *
   * 选之前就已是 mine 的选择只清登记、**不释放**（锁不是这次占的）。先清登记再发请求，
   * 所以同一次选择无论触发几次清理（切换 + 关闭 + 卸载）都只会归还一次；释放失败仍走
   * `releasePsbWorkspaceOccupancy` 的待释放账本，不静默。
   */
  const releaseHeldSelection = useCallback((reason: string): string | null => {
    const held = heldRef.current;
    if (!held) return null;
    heldRef.current = null;
    setHeldWorkspaceId(null);
    if (!held.newlyOccupied) return null;
    void releasePsbWorkspaceOccupancy(tryGetPsbRemoteBridge(), held.workspaceId, reason);
    return held.workspaceId;
  }, []);

  const dismissError = useCallback(() => {
    setActionError(null);
    setVcsNoticeWorkspaceId(null);
  }, []);

  const adoptWorkspace = useCallback((workspace: PsbRemoteWorkspace) => {
    setWorkspaces((previous) => [
      workspace,
      ...previous.filter((candidate) => candidate.id !== workspace.id),
    ]);
  }, []);

  // unmount：在途尝试作废（它若之后成功，会由 occupy 的迟到结算把锁还回去）；
  // 已占用但还没交接的选择同样归还，否则弹窗一关就留下一把界面看不见的锁。
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abandonAttempt();
      pendingRef.current = null;
      releaseHeldSelection('selection unmounted before handoff');
    };
  }, [abandonAttempt, releaseHeldSelection]);

  useEffect(() => {
    if (!open) {
      // 下拉被父层关掉也算放弃这次选择（与 unmount 同一条清理路径）。
      abandonAttempt();
      pendingRef.current = null;
      setPendingOccupy(null);
      releaseHeldSelection('selection closed before handoff');
      return undefined;
    }
    setActionError(null);
    setVcsNoticeWorkspaceId(null);
    pendingRef.current = null;
    setPendingOccupy(null);
    void refresh();
    const bridge = tryGetPsbRemoteBridge();
    if (!bridge) return undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = bridge.onWorkspaceChanged((event) => {
        const changed = event.workspace;
        setWorkspaces((previous) => {
          const index = previous.findIndex((workspace) => workspace.id === event.workspaceId);
          if (index < 0) return previous;
          if (!changed) return previous.filter((workspace) => workspace.id !== event.workspaceId);
          const next = [...previous];
          next[index] = changed;
          return next;
        });
      });
    } catch {
      unsubscribe = undefined;
    }
    return () => unsubscribe?.();
  }, [open, refresh, releaseHeldSelection]);

  /** 409 占用失败：刷新列表把占用人名补进失败事实（行上 `occupancy` 才是人名来源）。 */
  const enrichOccupiedFailure = useCallback(
    async (failure: PsbFailureInfo, workspaceId: string): Promise<PsbFailureInfo> => {
      if (failure.messageKey !== 'remoteWorkspace.error.occupiedByOther') {
        // 旧版 PSB 可能给非标准码：只要像「被占用」就顺手刷新一次，让行状态跟上。
        if (failure.code && /OCCUPIED/i.test(failure.code)) void refresh();
        return failure;
      }
      if (failure.personName) return failure;
      const next = await refresh();
      const personName =
        next?.find((workspace) => workspace.id === workspaceId)?.occupancy.personName ?? null;
      return psbFailureWithPersonName(failure, personName);
    },
    [refresh],
  );

  const occupy = useCallback(
    async (workspace: PsbRemoteWorkspace): Promise<RemoteWorkspacePickerCreated | null> => {
      const bridge = tryGetPsbRemoteBridge();
      if (!bridge || disabled) return null;
      if (!psbWorkspaceHealth(workspace).canStartSession) return null;
      // 同步守卫：busy 的禁用态要等下一帧渲染，双击 / 回车连发必须在这里立刻拒绝。
      if (attemptRef.current) return null;

      const workspaceId = workspace.id;
      // VCS 横幅要写「哪个工作区 · 提示」：显示名与行主标题同源（含同名消歧）。
      rememberWorkspaceVcsNoticeWorkspaceLabel(workspaceId, psbWorkspaceRowDisplayName(workspace));

      const attempt: OccupyAttempt = {
        cancelled: false,
        releaseOnLateSuccess: false,
        releaseRequested: false,
      };
      attemptRef.current = attempt;
      setOccupyingId(workspaceId);
      setActionError(null);
      setVcsNoticeWorkspaceId(null);

      /** 把「没人要的占用」还回去；同一次尝试只还一次（迟到结算与取消竞态可能重叠）。 */
      const releaseAbandonedOccupation = (reason: string) => {
        if (attempt.releaseRequested) return;
        attempt.releaseRequested = true;
        void releasePsbWorkspaceOccupancy(bridge, workspaceId, reason);
      };

      // 占用请求的落地必须一直被盯住：超时 / 取消之后它仍可能成功（锁已经生效）。
      const call = bridge.occupyWorkspace({ workspaceId });
      call.then(
        () => {
          if (!attempt.releaseOnLateSuccess) return;
          releaseAbandonedOccupation('occupy settled after the selection was abandoned');
        },
        () => undefined,
      );

      try {
        await withOccupyTimeout(call, PSB_OCCUPY_TIMEOUT_MS, () => {
          attempt.releaseOnLateSuccess = true;
        });
        if (attempt.cancelled || !aliveRef.current) {
          // 成功与取消竞态：调用方已经不要这次结果了，立刻把锁还回去。
          attempt.releaseOnLateSuccess = true;
          releaseAbandonedOccupation('selection cancelled');
          return null;
        }
        // 0.1.180：成功响应可能带 advisory（检出脏）→ main 已广播；兜底读一次保证不丢。
        void hydrateWorkspaceVcsNotice(workspaceId);
        return psbWorkspaceCreatedPayload(workspace);
      } catch (error) {
        if (attempt.cancelled || !aliveRef.current) return null;
        const failure =
          error === OCCUPY_TIMEOUT_SIGNAL ? psbOccupyTimeoutFailure() : readPsbFailure(error);
        // 旧版 409 兼容：main 把通知缓存并广播后重抛；兜底读一次，容器内以内联形态展示。
        setVcsNoticeWorkspaceId(workspaceId);
        void hydrateWorkspaceVcsNotice(workspaceId);
        const enriched = await enrichOccupiedFailure(failure, workspaceId);
        if (!aliveRef.current || attempt.cancelled) return null;
        setActionError(enriched);
        return null;
      } finally {
        if (attemptRef.current === attempt) attemptRef.current = null;
        if (aliveRef.current) setOccupyingId(null);
      }
    },
    [disabled, enrichOccupiedFailure],
  );

  /**
   * 选择工作区：**不发占用请求**，只决定「直接可交接 / 需要确认 / 不可选」。
   *
   * 切换选择（点到另一个工作区）时：此前**本次选择期间新占用**但还没交接的工作区立刻归还
   * （占用无 TTL，用户已经不要它了）；选之前就已是 mine 的旧选择不归还——它可能在确认新行
   * 期间继续作为当前选择（取消确认后用户仍能交接它），所以先留着，确认成功时才被替换。
   * 返回值带 `releasedWorkspaceId`，容器据此清掉旧行的选中态。
   */
  const requestSelect = useCallback(
    (workspace: PsbRemoteWorkspace): PsbWorkspaceSelectOutcome => {
      if (disabled || attemptRef.current) return { kind: 'blocked' };
      const health = psbWorkspaceHealth(workspace);
      if (!health.canStartSession) return { kind: 'blocked' };
      // 同一个工作区再次点击（列表还没刷到 byMe）：沿用已占用的选择，不重复占用。
      const held = heldRef.current;
      if (held && held.workspaceId === workspace.id) {
        pendingRef.current = null;
        setPendingOccupy(null);
        dismissError();
        return { kind: 'selected', created: held.created, releasedWorkspaceId: null };
      }
      // 只有本次新占用的旧选择需要立刻归还；mine 旧选择留给「确认成功后再替换 / 取消则保留」。
      const releasedWorkspaceId =
        held && held.newlyOccupied
          ? releaseHeldSelection('selected another workspace before handoff')
          : null;
      pendingRef.current = null;
      setPendingOccupy(null);
      dismissError();
      if (health.lock === 'mine') {
        // 选之前就已是 mine：不再发占用请求，也不在放弃选择时释放（锁不是这次占的）。
        const created = psbWorkspaceCreatedPayload(workspace);
        heldRef.current = { workspaceId: workspace.id, created, newlyOccupied: false };
        setHeldWorkspaceId(workspace.id);
        return { kind: 'selected', created, releasedWorkspaceId };
      }
      const pending: PsbPendingOccupy = { workspace };
      pendingRef.current = pending;
      setPendingOccupy(pending);
      return { kind: 'confirm', workspace, releasedWorkspaceId };
    },
    [disabled, dismissError, releaseHeldSelection],
  );

  /** 用户确认占用：这时才真正走 `occupy()`；成功登记为「本次选择新占用」。 */
  const confirmOccupy = useCallback(async (): Promise<RemoteWorkspacePickerCreated | null> => {
    const pending = pendingRef.current;
    if (!pending) return null;
    pendingRef.current = null;
    setPendingOccupy(null);
    if (disabled) return null;
    const workspace = pending.workspace;
    const held = heldRef.current;
    if (held && held.workspaceId === workspace.id) return held.created;
    const created = await occupy(workspace);
    if (!created) return null;
    heldRef.current = { workspaceId: workspace.id, created, newlyOccupied: true };
    setHeldWorkspaceId(workspace.id);
    return created;
  }, [disabled, occupy]);

  const cancelOccupy = useCallback(() => {
    pendingRef.current = null;
    setPendingOccupy(null);
  }, []);

  /**
   * 交接：把已占用的选择交给调用方。之后本 hook 不再归还这把锁（草稿 / 任务自己负责释放）。
   */
  const handoffSelection = useCallback((): RemoteWorkspacePickerCreated | null => {
    const held = heldRef.current;
    heldRef.current = null;
    setHeldWorkspaceId(null);
    pendingRef.current = null;
    setPendingOccupy(null);
    return held?.created ?? null;
  }, []);

  const cancel = useCallback(() => {
    // 关闭 / 卸载 = 放弃这次选择：在途占用作废、待确认清掉、未交接的占用归还（只还一次）。
    abandonAttempt();
    cancelOccupy();
    releaseHeldSelection('selection cancelled before handoff');
  }, [abandonAttempt, cancelOccupy, releaseHeldSelection]);

  // 行标签是纯 PSB 事实拼接（实例名 = 目录名；次要行 = 模板名 · 机器名），不经过翻译。
  const labels = useMemo(() => psbWorkspaceRowLabels(workspaces), [workspaces]);

  return {
    workspaces,
    labels,
    listLoading,
    listError,
    actionError,
    visibleActionError: vcsNotice ? null : actionError,
    vcsNotice,
    occupyingId,
    busy: occupyingId !== null,
    refresh,
    occupy,
    pendingOccupy,
    requestSelect,
    confirmOccupy,
    cancelOccupy,
    heldWorkspaceId,
    handoffSelection,
    cancel,
    dismissError,
    adoptWorkspace,
  };
}
