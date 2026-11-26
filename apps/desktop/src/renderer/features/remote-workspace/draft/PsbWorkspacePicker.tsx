/**
 * 草稿页「位置渠道 = 远程工作区」时，项目胶囊里列出的工作区下拉内容。
 *
 * 产品口径（2026-11-25 用户实机反馈后确定）：远程工作区是**位置渠道**，和「本机 / MCPR远程 /
 * 设备…」并列；选中该渠道后，右侧项目胶囊变成工作区下拉。所以这里不新造顶部信息头，
 * 只把「列出 PSB 工作区 + 新建远程工作区」接进既有的项目胶囊（`FolderPickerPopover`）。
 *
 * 与弹窗 `RemoteWorkspacePickerDialog` 的分工：
 *   · 弹窗负责「完整选择/新建工作区（两页签）」；侧栏「新建任务」入口用它；
 *   · 本下拉负责「已经决定用远程工作区渠道后，换/选一个工作区」，行数据与文案口径和弹窗
 *     完全一致（同一份 `psbDialogModel` 映射、同一个 `psbWorkspaceHealth` 判定）；
 *   · 选中即占用（与弹窗一致）：占用失败给出可读原因且**不选中**（不能带着一个注定发不出
 *     消息的工作区进草稿）。
 *
 * 新建入口不在这里重复实现表单：直接回调上层打开弹窗的「新建工作区」页签（同一份客户端 /
 * 模板表单），成功后弹窗回调把新工作区落进同一个 `psbTarget`。
 *
 * ## 版本控制检查通知（CINDY-RW-10）
 *
 * 选中即占用，因此占用被旧版 409 `WORKSPACE_VCS_*` 拒绝（或 0.1.180 成功响应带 advisory）时
 * main 会缓存并广播通知。下拉在失败后兜底读一次，并在行列表下方以内联形态
 * （`WorkspaceVcsNoticeView variant="inline"`）展示「查看详情 / 一键清理 / 继续」或旧版
 * 「重试 / 还原」；成功占用后的 advisory 由全局宿主 / 管理页展示。渲染层不解析 method/path/body。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, Lock, Plus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ui/error-notice';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import type { PsbRemoteWorkspace } from '../../../../shared/psb-remote-workspace';
import { tryGetPsbRemoteBridge } from '../bridge';
import { formatWorkspaceOccupancy } from '../occupancyLabel';
import { hydrateWorkspaceVcsNotice, useWorkspaceVcsNotices } from '../vcs/vcsNoticeStore';
import { WorkspaceVcsNoticeView } from '../vcs/WorkspaceVcsNoticeView';
import {
  psbFailureText,
  psbWorkspaceCreatedPayload,
  psbWorkspaceRowDisplayName,
  psbWorkspaceRowHealth,
  psbWorkspaceSecondaryText,
  psbWorkspaceUnavailableReason,
  readPsbFailure,
  type PsbFailureInfo,
  type RemoteWorkspacePickerCreated,
} from '../dialog/psbDialogModel';

export interface PsbWorkspacePickerProps {
  /** 下拉是否打开（打开时拉一次列表，不轮询）。 */
  open: boolean;
  /** 当前草稿已选中的工作区 id；null = 渠道已选但还没选工作区。 */
  selectedWorkspaceId: string | null;
  /** 占用成功后的工作区级载荷（调用方只写草稿目标，PSB 会话在首条消息才建）。 */
  onSelect: (created: RemoteWorkspacePickerCreated) => void;
  /** 「新建远程工作区」入口：上层打开已实现的弹窗新建页签。 */
  onCreate: () => void;
  /** 发送在途 / worktree 创建中等在途锁。 */
  disabled?: boolean;
}

const ROW_CLASS =
  'flex w-full items-center gap-3 rounded-[8px] px-3 py-[10px] text-left transition-colors outline-none hover:bg-[var(--folder-item-hover)] focus-visible:ring-2 focus-visible:ring-[var(--create-agent-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent';

function RowBadge({ tone, label }: { tone: 'ok' | 'warn' | 'bad' | 'idle'; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full bg-[var(--surface-chip)] px-1.5 py-px text-11 font-medium',
        tone === 'ok' && 'text-[var(--remote-status-ready)]',
        tone === 'warn' && 'text-[var(--warning-fg)]',
        tone === 'bad' && 'text-[var(--error-fg)]',
        tone === 'idle' && 'text-[var(--text-tertiary)]',
      )}
    >
      {label}
    </span>
  );
}

export function PsbWorkspacePicker({
  open,
  selectedWorkspaceId,
  onSelect,
  onCreate,
  disabled = false,
}: PsbWorkspacePickerProps) {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<readonly PsbRemoteWorkspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<PsbFailureInfo | null>(null);
  const [actionError, setActionError] = useState<PsbFailureInfo | null>(null);
  const [occupyingId, setOccupyingId] = useState<string | null>(null);
  /**
   * 本次占用尝试的工作区 id：占用失败后用它把 main 缓存的版本控制通知拉进 store 并在下拉内
   * 内联展示；不在打开下拉时给每个工作区各读一次通知。
   */
  const [vcsNoticeWorkspaceId, setVcsNoticeWorkspaceId] = useState<string | null>(null);
  const vcsNoticeStates = useWorkspaceVcsNotices();
  const vcsNotice = useMemo(
    () => vcsNoticeStates.find((entry) => entry.workspaceId === vcsNoticeWorkspaceId) ?? null,
    [vcsNoticeStates, vcsNoticeWorkspaceId],
  );
  const aliveRef = useRef(true);
  /** 同步占用守卫：禁用态要等下一帧渲染，双击/连点必须靠 ref 立刻拒绝。 */
  const occupyRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<readonly PsbRemoteWorkspace[] | null> => {
    const bridge = tryGetPsbRemoteBridge();
    if (!bridge) {
      setLoadError(readPsbFailure(null));
      return null;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const result = await bridge.listWorkspaces();
      if (!aliveRef.current) return result.workspaces;
      setWorkspaces(result.workspaces);
      return result.workspaces;
    } catch (error) {
      if (aliveRef.current) setLoadError(readPsbFailure(error));
      return null;
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setActionError(null);
    setVcsNoticeWorkspaceId(null);
    void refresh();
  }, [open, refresh]);

  // 他人占用/释放实时落到行上（与弹窗同一事件面；列表本身不轮询）。
  useEffect(() => {
    if (!open) return;
    const bridge = tryGetPsbRemoteBridge();
    if (!bridge) return;
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
  }, [open]);

  const handleSelect = useCallback(
    async (workspace: PsbRemoteWorkspace) => {
      const bridge = tryGetPsbRemoteBridge();
      if (!bridge || disabled || occupyingId || occupyRef.current) return;
      if (!psbWorkspaceRowHealth(workspace).canStartSession) return;
      occupyRef.current = true;
      setOccupyingId(workspace.id);
      setActionError(null);
      setVcsNoticeWorkspaceId(null);
      try {
        // 选中即占用（PSB 协作锁，与弹窗同一条动作链）；成功后调用方只写草稿目标。
        await bridge.occupyWorkspace({ workspaceId: workspace.id });
        if (!aliveRef.current) return;
        // 0.1.180 advisory 兜底读：推送与 invoke 返回的先后顺序不可依赖（幂等）。
        void hydrateWorkspaceVcsNotice(workspace.id);
        onSelect(psbWorkspaceCreatedPayload(workspace));
      } catch (error) {
        const failure = readPsbFailure(error);
        // 旧版 409 兼容：main 已缓存 + 广播通知；兜底读一次并在下拉内以内联形态展示。
        setVcsNoticeWorkspaceId(workspace.id);
        void hydrateWorkspaceVcsNotice(workspace.id);
        // 409 占用：刷新列表让「谁抢走了」从工作区行的 occupancy.personName 取，
        // 并把占用人补进错误文案（与弹窗同一套可行动提示）。
        let enriched = failure;
        if (failure.messageKey === 'remoteWorkspace.error.occupiedByOther' && !failure.personName) {
          const next = await refresh();
          const refreshed = next?.find((candidate) => candidate.id === workspace.id);
          const personName = refreshed?.occupancy.personName.trim();
          if (personName) enriched = { ...failure, personName };
        } else if (failure.code && /OCCUPIED/i.test(failure.code)) {
          void refresh();
        }
        if (aliveRef.current) setActionError(enriched);
      } finally {
        occupyRef.current = false;
        if (aliveRef.current) setOccupyingId(null);
      }
    },
    [disabled, occupyingId, onSelect, refresh],
  );

  return (
    <div data-testid="psb-workspace-picker" className="flex flex-col">
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <span className="text-xs font-normal text-[var(--folder-label)]">
          {t('remoteWorkspace.dialog.tabExisting')}
        </span>
        <button
          type="button"
          aria-label={t('remoteWorkspace.dialog.refresh')}
          title={t('remoteWorkspace.dialog.refresh')}
          disabled={loading || !!occupyingId || disabled}
          onClick={() => void refresh()}
          className="inline-flex size-5 items-center justify-center rounded-full text-[var(--folder-item-path)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {loadError ? (
        <ErrorNotice
          className="mx-1 mb-1"
          message={t(loadError.messageKey)}
          description={loadError.message ?? undefined}
          actions={
            <button
              type="button"
              disabled={loading}
              onClick={() => void refresh()}
              className="text-xs font-medium text-[var(--error-fg)] underline-offset-2 hover:underline disabled:opacity-40"
            >
              {t('remoteWorkspace.dialog.refresh')}
            </button>
          }
        />
      ) : null}

      <div
        data-folder-picker-scroll="true"
        className="pending-queue-scroll max-h-[216px] overflow-y-auto overscroll-contain"
        role="listbox"
        aria-label={t('remoteWorkspace.dialog.tabExisting')}
      >
        {loading && workspaces.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-[10px] text-sm text-[var(--folder-item-path)]">
            <Spinner size={14} />
            {t('remoteWorkspace.dialog.workspaceListLoading')}
          </div>
        ) : null}
        {!loading && !loadError && workspaces.length === 0 ? (
          <div className="px-3 py-[10px] text-sm text-[var(--folder-item-path)]">
            {t('remoteWorkspace.dialog.workspaceListEmpty')}
          </div>
        ) : null}
        {workspaces.map((workspace) => {
          const health = psbWorkspaceRowHealth(workspace);
          const selected = workspace.id === selectedWorkspaceId;
          const reason = psbWorkspaceUnavailableReason(workspace, health, t);
          const secondary = psbWorkspaceSecondaryText(workspace, t);
          const busy = occupyingId === workspace.id;
          // 占用文案与页头 / 侧栏共用同一格式函数：有名字显示名字，自己占用追加「（你）」。
          const lockLabel =
            health.lock === 'none' ? null : formatWorkspaceOccupancy(workspace.occupancy, t);
          return (
            <button
              key={workspace.id}
              type="button"
              role="option"
              aria-selected={selected}
              data-testid={`psb-picker-workspace-row-${workspace.id}`}
              data-available={health.canStartSession ? 'true' : 'false'}
              disabled={!health.canStartSession || disabled || !!occupyingId}
              onClick={() => void handleSelect(workspace)}
              className={cn(ROW_CLASS, selected && 'bg-[var(--folder-item-hover)]')}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {selected ? (
                  <Check size={14} className="text-[var(--accent-emphasis)]" />
                ) : busy ? (
                  <Spinner size={14} />
                ) : null}
              </span>
              {/* 与弹窗同一布局：主标题占满宽度、状态徽标/锁固定最右槽、次要行只一行。 */}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  className="w-full truncate text-sm font-medium text-[var(--folder-item-name)]"
                  title={workspace.id}
                >
                  {psbWorkspaceRowDisplayName(workspace)}
                </span>
                {secondary ? (
                  <span
                    className="w-full truncate text-xs text-[var(--folder-item-path)]"
                    title={secondary}
                  >
                    {secondary}
                  </span>
                ) : null}
                {reason ? (
                  <span
                    className="flex w-full items-center gap-1 text-11 leading-[1.4] text-[var(--folder-item-path)]"
                    title={reason}
                  >
                    <CircleAlert size={11} className="shrink-0" />
                    <span className="truncate">{reason}</span>
                  </span>
                ) : null}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                <RowBadge tone={health.tone} label={t(health.badgeKey)} />
                {lockLabel ? (
                  <span
                    title={lockLabel}
                    aria-label={lockLabel}
                    className={cn(
                      'inline-flex shrink-0',
                      health.lock === 'mine'
                        ? 'text-[var(--accent-emphasis)]'
                        : 'text-[var(--folder-item-path)]',
                    )}
                  >
                    <Lock size={12} />
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      {vcsNotice ? (
        <div className="mx-1 mt-1" data-testid="psb-picker-vcs-notice-slot">
          <WorkspaceVcsNoticeView
            workspaceId={vcsNotice.workspaceId}
            notice={vcsNotice.notice}
            operation={vcsNotice.operation}
            variant="inline"
          />
        </div>
      ) : null}

      {actionError ? (
        <ErrorNotice
          className="mx-1 mt-1"
          message={psbFailureText(actionError, t)}
          description={actionError.message ?? undefined}
        />
      ) : null}

      <div className="mx-2 my-1 h-px bg-[var(--folder-picker-border)]" />
      <button
        type="button"
        data-testid="psb-picker-create-workspace"
        disabled={disabled || !!occupyingId}
        onClick={onCreate}
        className={cn(ROW_CLASS, 'items-center')}
      >
        <Plus size={16} className="shrink-0 text-[var(--folder-item-icon)]" />
        <span className="relative top-px text-sm font-medium text-[var(--folder-item-name)]">
          {t('remoteWorkspace.dialog.createWorkspace')}
        </span>
      </button>
    </div>
  );
}
