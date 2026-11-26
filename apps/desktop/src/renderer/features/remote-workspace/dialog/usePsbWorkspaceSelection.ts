/**
 * 工作区选择器的**共享选择引擎**（弹窗与草稿页下拉只留壳）。
 *
 * 2026-11-26 独立审查：两个入口各自实现了「列出 → 占用 → 失败刷新补占用人名 →
 * hydrate VCS 通知 → 内联错误」这一整条链，逐行同构、bug 要修两遍。现在链路只在这里：
 *
 *   1. 打开时拉一次列表（不轮询），并订阅 `onWorkspaceChanged` 把别人的占用/释放实时落到行上；
 *   2. 选中即占用（PSB 协作锁）；占用失败时刷新列表，把「谁抢走了」从工作区行
 *      `occupancy.personName` 补进失败事实（IPC 只带人名，拿不到时人名就是空）；
 *   3. 占用成功 / 失败后都兜底 `hydrateWorkspaceVcsNotice`（推送与 invoke 返回的先后不可依赖），
 *      并顺手记住工作区显示名（全局 VCS 横幅要写「工作区名 · 提示」）；
 *   4. **有 VCS 通知时由调用方抑制通用错误**（同一事实不双显，见返回的 `visibleActionError`）；
 *   5. **忙时也有出口**：占用有超时（`PSB_OCCUPY_TIMEOUT_MS`），调用方可以 `cancel()`（关闭
 *      弹窗 / 卸载下拉）；取消或超时之后才落地的占用**会被还回去**并记账，不留无名占用。
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
   */
  readonly occupy: (workspace: PsbRemoteWorkspace) => Promise<RemoteWorkspacePickerCreated | null>;
  /**
   * 放弃本次在途占用（关闭弹窗 / 下拉卸载 / 换目标）。
   *
   * 已成功但还没被调用方接手的占用会被释放并记账（占用无 TTL，不能留无名锁）。
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

  // unmount：在途尝试作废（它若之后成功，会由 occupy 的迟到结算把锁还回去）。
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abandonAttempt();
    };
  }, [abandonAttempt]);

  useEffect(() => {
    if (!open) {
      // 下拉被父层关掉也算放弃这次选择（与 unmount 同一条清理路径）。
      abandonAttempt();
      return undefined;
    }
    setActionError(null);
    setVcsNoticeWorkspaceId(null);
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
  }, [open, refresh]);

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

  const labels = useMemo(() => psbWorkspaceRowLabels(workspaces, t), [t, workspaces]);

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
    cancel: abandonAttempt,
    dismissError,
    adoptWorkspace,
  };
}
