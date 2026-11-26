/**
 * 「新建远程工作区会话」弹窗。
 *
 * 产品口径（2026-11-25 用户明确要求）：**新建时不选引擎**，只选择/新建工作区；Harness 与
 * 模型在会话草稿页按既有链路选择。所以这里只做三件事：
 *
 *   1. 列出当前身份可用工作区（不可用行显示原因并禁用）；
 *   2. 选中一个工作区 = 在 PSB 上把它占用为当前身份（与网页同一把协作锁），占用失败
 *      给出可行动的原因并停在这里；
 *   3. 占用成功后把**工作区级载荷**交给父级（侧栏 → 导航草稿页；草稿页内 → 换目标）。
 *
 * **不建 PSB 会话**：会话在草稿页首条消息发送时懒创建（引擎取草稿当时的 Harness），
 * 失败不建本地会话、重试复用同一条。这样弹窗与引擎/模型解耦，草稿页完全走原有链路。
 *
 * ## 版本控制检查通知（CINDY-RW-10）
 *
 * 占用被旧版 409 `WORKSPACE_VCS_*` 拒绝、或 0.1.180 成功响应附带 advisory（检出脏）时，main
 * 会把通知缓存后广播。弹窗在占用失败后兜底读一次（`hydrateWorkspaceVcsNotice`），并以内联
 * 形态（`WorkspaceVcsNoticeView variant="inline"`）展示「查看详情 / 一键清理 / 继续」或旧版
 * 「重试 / 还原」；成功的 advisory 在弹窗关闭后由全局宿主 / 管理页继续展示。渲染层不解析
 * method/path/body，动作只按 kind 走 `runWorkspaceVcsAction`。
 *
 * ## 为什么要自己守「请求在途」
 *
 * 占用与建工作区都不可幂等重放的代价很高：占用双击会变成「自己抢自己」的 409。Busy 用
 * `useState` 驱动禁用态，同时用 refs 做**同步**守卫（React 的禁用态要到下一次渲染才生效）。
 *
 * 设计口径：DESIGN.md §4（Dialog & Modal / SegmentedControl / Buttons）、§5（圆角与点击目标）、
 * §10（语义 token、双模式）；文案全部走 `remoteWorkspace.dialog.*` / `remoteWorkspace.error.*`。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Check, CircleAlert, Lock, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import {
  type PsbListWorkspacesResult,
  type PsbProjectTemplate,
  type PsbRemoteClient,
  type PsbRemoteStatus,
  type PsbRemoteWorkspace,
  type PsbWorkspaceHealth,
} from '../../../../shared/psb-remote-workspace';
import { tryGetPsbRemoteBridge } from '../bridge';
import { formatWorkspaceOccupancy } from '../occupancyLabel';
import { hydrateWorkspaceVcsNotice, useWorkspaceVcsNotices } from '../vcs/vcsNoticeStore';
import { WorkspaceVcsNoticeView } from '../vcs/WorkspaceVcsNoticeView';
import {
  psbWorkspaceCreatedPayload,
  psbWorkspaceRowDisplayName,
  psbWorkspaceRowHealth,
  psbWorkspaceSecondaryText,
  psbWorkspaceUnavailableReason,
  readPsbFailure,
  type PsbFailureInfo,
  type RemoteWorkspacePickerCreated,
} from './psbDialogModel';

export type { RemoteWorkspacePickerCreated };

export interface RemoteWorkspacePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 选中并成功占用工作区后的工作区级载荷（无 sessionId / agentKind）。 */
  onCreated: (result: RemoteWorkspacePickerCreated) => void;
  /**
   * 打开时落在哪个页签。草稿页位置渠道的「新建远程工作区」入口直接落在「新建工作区」；
   * 侧栏入口保持默认的「选择工作区」。
   */
  initialTab?: 'existing' | 'create';
}

type DialogTab = 'existing' | 'create';

type SubmitKind = 'idle' | 'workspace' | 'occupy';

const BADGE_TONE_CLASS: Record<PsbWorkspaceHealth['tone'], string> = {
  ok: 'text-[var(--remote-status-ready)]',
  warn: 'text-[var(--warning-fg)]',
  bad: 'text-[var(--error-fg)]',
  idle: 'text-[var(--text-tertiary)]',
};

const ROW_CLASS =
  'flex w-full items-center gap-2.5 rounded-lg border border-[var(--border-default)] px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-60 enabled:hover:bg-[var(--surface-hover)]';
const ROW_SELECTED_CLASS = 'border-[var(--accent-emphasis)] bg-[var(--surface-hover)]';
const SECTION_LABEL_CLASS = 'mb-1.5 block text-12 font-medium text-[var(--text-secondary)]';

function WorkspaceBadge({
  tone,
  label,
}: {
  tone: PsbWorkspaceHealth['tone'];
  label: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full bg-[var(--surface-chip)] px-1.5 py-px text-11 font-medium',
        BADGE_TONE_CLASS[tone],
      )}
    >
      {label}
    </span>
  );
}

export function RemoteWorkspacePickerDialog({
  open,
  onOpenChange,
  onCreated,
  initialTab = 'existing',
}: RemoteWorkspacePickerDialogProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<DialogTab>(initialTab);
  const [status, setStatus] = useState<PsbRemoteStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<readonly PsbRemoteWorkspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<PsbFailureInfo | null>(null);
  const [actionError, setActionError] = useState<PsbFailureInfo | null>(null);
  const [submit, setSubmit] = useState<SubmitKind>('idle');
  const [clients, setClients] = useState<readonly PsbRemoteClient[]>([]);
  const [templates, setTemplates] = useState<readonly PsbProjectTemplate[]>([]);
  const [createDataLoading, setCreateDataLoading] = useState(false);
  const [createDataLoaded, setCreateDataLoaded] = useState(false);
  const [createDataError, setCreateDataError] = useState<PsbFailureInfo | null>(null);
  const [clientId, setClientId] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [title, setTitle] = useState('');
  /**
   * 本次占用尝试的工作区 id：占用失败（旧版 409）后用它把 main 缓存的版本控制通知拉进
   * store，并在弹窗内以内联形态展示（「查看详情 / 一键清理 / 继续」/ 旧版重试）。
   * 只在一次尝试后设置，不给列表里的每个工作区各读一次通知。
   */
  const [vcsNoticeWorkspaceId, setVcsNoticeWorkspaceId] = useState<string | null>(null);
  const vcsNoticeStates = useWorkspaceVcsNotices();
  const vcsNotice = useMemo(
    () => vcsNoticeStates.find((entry) => entry.workspaceId === vcsNoticeWorkspaceId) ?? null,
    [vcsNoticeStates, vcsNoticeWorkspaceId],
  );

  const busy = submit !== 'idle';
  // 同步守卫：busy 的禁用态要等下一帧渲染，双击/回车连发必须靠 ref 立刻拒绝。
  const submitRef = useRef<SubmitKind>('idle');
  const createDataRequestRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refreshWorkspaces = useCallback(async (): Promise<readonly PsbRemoteWorkspace[] | null> => {
    const bridge = tryGetPsbRemoteBridge();
    if (!bridge) {
      setListError(readPsbFailure(null));
      return null;
    }
    setListLoading(true);
    setListError(null);
    try {
      const result: PsbListWorkspacesResult = await bridge.listWorkspaces();
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

  const loadStatus = useCallback(async () => {
    const bridge = tryGetPsbRemoteBridge();
    if (!bridge) return;
    try {
      const next = await bridge.status();
      if (aliveRef.current) setStatus(next);
    } catch (error) {
      if (aliveRef.current) {
        // 状态探测失败不能把弹窗变成空白：让「列表为什么可能读不到」有一个解释。
        setStatus(null);
        setActionError(readPsbFailure(error));
      }
    }
  }, []);

  // 打开时拉一次；关闭后不再发请求。每次打开按入口页签重置（上次的新建表单与错误
  // 不跨打开保留）。
  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setSelectedWorkspaceId(null);
    setActionError(null);
    setListError(null);
    setCreateDataError(null);
    setCreateDataLoaded(false);
    setClients([]);
    setTemplates([]);
    setClientId('');
    setTemplateKey('');
    setTitle('');
    setVcsNoticeWorkspaceId(null);
    void refreshWorkspaces();
    void loadStatus();
  }, [initialTab, loadStatus, open, refreshWorkspaces]);

  // 他人占用/释放、工作区状态变化实时落到行上（列表本身不轮询）。
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

  useEffect(() => {
    if (!open || tab !== 'create' || createDataLoaded || createDataRequestRef.current) return;
    const bridge = tryGetPsbRemoteBridge();
    if (!bridge) {
      setCreateDataError(readPsbFailure(null));
      return;
    }
    createDataRequestRef.current = true;
    setCreateDataLoading(true);
    setCreateDataError(null);
    void (async () => {
      try {
        const [clientResult, templateResult] = await Promise.all([
          bridge.listClients(),
          bridge.listProjectTemplates(),
        ]);
        if (!aliveRef.current) return;
        setClients(clientResult.clients);
        setTemplates(templateResult.templates);
        setCreateDataLoaded(true);
      } catch (error) {
        if (aliveRef.current) setCreateDataError(readPsbFailure(error));
      } finally {
        createDataRequestRef.current = false;
        if (aliveRef.current) setCreateDataLoading(false);
      }
    })();
  }, [createDataLoaded, open, tab]);

  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  const selectedHealth = selectedWorkspace ? psbWorkspaceRowHealth(selectedWorkspace) : null;
  const canSelect = !!selectedWorkspace && selectedHealth?.canStartSession === true;

  const lockSubmit = useCallback((kind: Exclude<SubmitKind, 'idle'>): boolean => {
    if (submitRef.current !== 'idle') return false;
    submitRef.current = kind;
    setSubmit(kind);
    return true;
  }, []);
  const releaseSubmit = useCallback(() => {
    submitRef.current = 'idle';
    setSubmit('idle');
  }, []);

  /**
   * 确认 = 占用工作区（协作锁），成功即把工作区交给父级。
   * 占用失败**不**回调、不导航（产品验收：占用失败不留在草稿里）。
   */
  const handleSelectWorkspace = useCallback(async () => {
    const bridge = tryGetPsbRemoteBridge();
    const workspace = workspaces.find((candidate) => candidate.id === selectedWorkspaceId);
    if (!bridge || !workspace) return;
    if (!psbWorkspaceRowHealth(workspace).canStartSession) return;
    if (!lockSubmit('occupy')) return;
    setActionError(null);
    setVcsNoticeWorkspaceId(null);
    try {
      // 占用成功后父级会关闭弹窗并导航/换目标；这里只回工作区级事实。
      await bridge.occupyWorkspace({ workspaceId: workspace.id });
      // 0.1.180：成功响应可能带 advisory（检出脏）→ main 已广播；兜底读一次，避免推送与
      // invoke 返回的先后竞争（弹窗随即关闭，提示由全局宿主 / 管理页继续展示）。
      void hydrateWorkspaceVcsNotice(workspace.id);
      onCreated(psbWorkspaceCreatedPayload(workspace));
      onOpenChange(false);
    } catch (error) {
      const failure = readPsbFailure(error);
      // 旧版 409 兼容：main 把 `details.vcs` 缓存并广播后重抛；这里兜底读一次并在弹窗内
      // 以 inline 形态展示通知与处置动作（「继续」关提示、旧版「重试 / 还原」可执行）。
      setVcsNoticeWorkspaceId(workspace.id);
      void hydrateWorkspaceVcsNotice(workspace.id);
      // 409 占用：刷新列表，让「谁抢走了」从工作区行（occupancy.personName）取，
      // 并把占用人补进错误文案；刷新本身也会重画禁用态。
      let enriched = failure;
      if (failure.messageKey === 'remoteWorkspace.error.occupiedByOther' && !failure.personName) {
        const next = await refreshWorkspaces();
        const refreshed = next?.find((candidate) => candidate.id === workspace.id);
        const personName = refreshed?.occupancy.personName.trim();
        if (personName) enriched = { ...failure, personName };
      } else if (failure.code && /OCCUPIED/i.test(failure.code)) {
        void refreshWorkspaces();
      }
      if (aliveRef.current) setActionError(enriched);
    } finally {
      if (aliveRef.current) releaseSubmit();
      else submitRef.current = 'idle';
    }
  }, [lockSubmit, onCreated, onOpenChange, refreshWorkspaces, releaseSubmit, selectedWorkspaceId, workspaces]);

  const canCreateWorkspace = !!clientId && !!templateKey;

  const handleCreateWorkspace = useCallback(async () => {
    const bridge = tryGetPsbRemoteBridge();
    if (!bridge || !clientId || !templateKey) return;
    if (!lockSubmit('workspace')) return;
    setActionError(null);
    try {
      const created = await bridge.createWorkspace({
        clientId,
        templateKey,
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      const next = await refreshWorkspaces();
      if (!aliveRef.current) return;
      const list = next ?? [];
      if (!list.some((workspace) => workspace.id === created.workspace.id)) {
        // 列表请求失败/尚未反映刚建出的行：本地补上，保证用户看得到自己刚建的工作区。
        setWorkspaces((previous) => [
          created.workspace,
          ...previous.filter((workspace) => workspace.id !== created.workspace.id),
        ]);
      }
      // 新建成功 → 回到列表页并选中它（provisioning 时行上显示「准备中」，要等 ready 才能占用）。
      setSelectedWorkspaceId(created.workspace.id);
      setTab('existing');
    } catch (error) {
      if (aliveRef.current) setActionError(readPsbFailure(error));
    } finally {
      if (aliveRef.current) releaseSubmit();
      else submitRef.current = 'idle';
    }
  }, [clientId, lockSubmit, refreshWorkspaces, releaseSubmit, templateKey, title]);

  const statusReason = status && !status.ready ? status.reasonKey : null;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // 请求在途时不允许通过 Esc / 外部状态关掉：占用可能已经成功，关掉会留下
        // 一个没有父级继续的占用（草稿还没进，释放逻辑也就无从触发）。
        if (busy && !next) return;
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
        <Dialog.Content
          className="modal-panel fixed left-1/2 top-1/2 z-[10001] flex max-h-[min(620px,85vh)] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col p-4 focus:outline-none"
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <Dialog.Title className="shrink-0 text-18 font-medium text-[var(--confirm-title)]">
            {t('remoteWorkspace.dialog.title')}
          </Dialog.Title>
          <Dialog.Description className="mt-1 shrink-0 text-13 leading-[1.5] text-[var(--confirm-desc)]">
            {t('remoteWorkspace.dialog.subtitle')}
          </Dialog.Description>
          {status?.ready && status.host ? (
            <p className="mt-1 shrink-0 text-11 text-[var(--text-tertiary)]">{status.host}</p>
          ) : null}

          <div className="mt-3 shrink-0">
            <SegmentedControl<DialogTab>
              aria-label={t('remoteWorkspace.dialog.title')}
              role="tablist"
              value={tab}
              disabled={busy}
              fullWidth
              options={[
                { value: 'existing', label: t('remoteWorkspace.dialog.tabExisting') },
                { value: 'create', label: t('remoteWorkspace.dialog.tabCreate') },
              ]}
              onValueChange={(next) => {
                if (busy) return;
                setTab(next);
                setActionError(null);
              }}
            />
          </div>

          {statusReason ? (
            <div className="mt-3 shrink-0">
              <ErrorNotice message={t(statusReason)} />
            </div>
          ) : null}

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-0.5">
            {tab === 'existing' ? (
              <div
                className="flex flex-col gap-1.5"
                data-testid="psb-workspace-list"
                role="radiogroup"
                aria-label={t('remoteWorkspace.dialog.tabExisting')}
              >
                <div className="flex items-center justify-between">
                  <span className={cn(SECTION_LABEL_CLASS, 'mb-0')}>
                    {t('remoteWorkspace.dialog.tabExisting')}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    compact
                    disabled={listLoading || busy}
                    onClick={() => void refreshWorkspaces()}
                  >
                    <RefreshCw size={12} className={listLoading ? 'animate-spin' : undefined} />
                    {t('remoteWorkspace.dialog.refresh')}
                  </Button>
                </div>
                {listError ? (
                  <ErrorNotice
                    message={t(listError.messageKey)}
                    description={listError.message ?? undefined}
                    actions={
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        compact
                        disabled={listLoading || busy}
                        onClick={() => void refreshWorkspaces()}
                      >
                        {t('remoteWorkspace.dialog.refresh')}
                      </Button>
                    }
                  />
                ) : null}
                {listLoading && workspaces.length === 0 ? (
                  <div className="flex items-center gap-2 px-1 py-6 text-13 text-[var(--text-secondary)]">
                    <Spinner size={14} />
                    {t('remoteWorkspace.dialog.workspaceListLoading')}
                  </div>
                ) : null}
                {!listLoading && !listError && workspaces.length === 0 ? (
                  <p className="px-1 py-6 text-13 text-[var(--text-secondary)]">
                    {t('remoteWorkspace.dialog.workspaceListEmpty')}
                  </p>
                ) : null}
                {workspaces.map((workspace) => {
                  const health = psbWorkspaceRowHealth(workspace);
                  const selected = workspace.id === selectedWorkspaceId;
                  const reason = psbWorkspaceUnavailableReason(workspace, health, t);
                  const secondary = psbWorkspaceSecondaryText(workspace, t);
                  // 占用文案与页头 / 侧栏共用同一格式函数：有名字显示名字，自己占用追加「（你）」。
                  const lockLabel =
                    health.lock === 'none'
                      ? null
                      : formatWorkspaceOccupancy(workspace.occupancy, t);
                  return (
                    <button
                      key={workspace.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-testid={`psb-workspace-row-${workspace.id}`}
                      data-selected={selected ? 'true' : undefined}
                      data-available={health.canStartSession ? 'true' : 'false'}
                      disabled={!health.canStartSession || busy}
                      onClick={() => {
                        setSelectedWorkspaceId(workspace.id);
                        setActionError(null);
                      }}
                      className={cn(ROW_CLASS, selected && ROW_SELECTED_CLASS)}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        {selected ? <Check size={14} className="text-[var(--accent-emphasis)]" /> : null}
                      </span>
                      {/* 主标题占满可用宽度（完整显示，必要时由 flex-1 + truncate 收尾）；
                          状态徽标与锁固定在最右槽，不挤占标题。 */}
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span
                          className="w-full truncate text-13 font-medium text-[var(--text-primary)]"
                          title={workspace.id}
                        >
                          {psbWorkspaceRowDisplayName(workspace)}
                        </span>
                        {secondary ? (
                          <span
                            className="w-full truncate text-12 text-[var(--text-secondary)]"
                            title={secondary}
                          >
                            {secondary}
                          </span>
                        ) : null}
                        {reason ? (
                          <span
                            className="flex w-full items-center gap-1 text-11 leading-[1.4] text-[var(--text-tertiary)]"
                            title={reason}
                          >
                            <CircleAlert size={11} className="shrink-0" />
                            <span className="truncate">{reason}</span>
                          </span>
                        ) : null}
                      </span>
                      <span className="ml-auto flex shrink-0 items-center gap-1.5">
                        <WorkspaceBadge tone={health.tone} label={t(health.badgeKey)} />
                        {lockLabel ? (
                          <span
                            title={lockLabel}
                            aria-label={lockLabel}
                            className={cn(
                              'inline-flex shrink-0',
                              health.lock === 'mine'
                                ? 'text-[var(--accent-emphasis)]'
                                : 'text-[var(--text-tertiary)]',
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
            ) : (
              <div className="flex flex-col gap-3" data-testid="psb-workspace-create-form">
                {createDataError ? (
                  <ErrorNotice
                    message={t(createDataError.messageKey)}
                    description={createDataError.message ?? undefined}
                  />
                ) : null}
                <div>
                  <span className={SECTION_LABEL_CLASS}>{t('remoteWorkspace.dialog.client')}</span>
                  {createDataLoading && clients.length === 0 ? (
                    <div className="flex items-center gap-2 px-1 py-3 text-13 text-[var(--text-secondary)]">
                      <Spinner size={14} />
                      {t('remoteWorkspace.dialog.workspaceListLoading')}
                    </div>
                  ) : clients.length === 0 ? (
                    <p className="px-1 py-2 text-12 text-[var(--text-secondary)]">
                      {t('remoteWorkspace.dialog.clientPlaceholder')}
                    </p>
                  ) : (
                    <div className="flex max-h-[168px] flex-col gap-1 overflow-y-auto" role="radiogroup" aria-label={t('remoteWorkspace.dialog.client')}>
                      {clients.map((client) => {
                        const selected = client.id === clientId;
                        const unavailable = !client.online;
                        return (
                          <button
                            key={client.id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            data-testid={`psb-client-row-${client.id}`}
                            disabled={unavailable || busy}
                            onClick={() => {
                              setClientId(client.id);
                              setActionError(null);
                            }}
                            className={cn(ROW_CLASS, 'items-center py-1.5', selected && ROW_SELECTED_CLASS)}
                          >
                            <span className="flex size-4 shrink-0 items-center justify-center">
                              {selected ? <Check size={14} className="text-[var(--accent-emphasis)]" /> : null}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-13 text-[var(--text-primary)]">
                              {client.name || client.id}
                            </span>
                            {unavailable ? (
                              <span className="shrink-0 text-11 text-[var(--text-tertiary)]">
                                {t('remoteWorkspace.dialog.clientOffline')}
                              </span>
                            ) : client.agents.some((agent) => agent.available) ? null : (
                              <span className="shrink-0 text-11 text-[var(--warning-fg)]">
                                {t('remoteWorkspace.badge.agentUnsupported')}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div>
                  <span className={SECTION_LABEL_CLASS}>{t('remoteWorkspace.dialog.template')}</span>
                  {createDataLoading && templates.length === 0 ? (
                    <div className="flex items-center gap-2 px-1 py-3 text-13 text-[var(--text-secondary)]">
                      <Spinner size={14} />
                      {t('remoteWorkspace.dialog.workspaceListLoading')}
                    </div>
                  ) : templates.length === 0 ? (
                    <p className="px-1 py-2 text-12 text-[var(--text-secondary)]">
                      {t('remoteWorkspace.dialog.templatePlaceholder')}
                    </p>
                  ) : (
                    <div className="flex max-h-[168px] flex-col gap-1 overflow-y-auto" role="radiogroup" aria-label={t('remoteWorkspace.dialog.template')}>
                      {templates.map((template) => {
                        const selected = template.key === templateKey;
                        return (
                          <button
                            key={template.key}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            data-testid={`psb-template-row-${template.key}`}
                            disabled={busy}
                            onClick={() => {
                              setTemplateKey(template.key);
                              setActionError(null);
                            }}
                            className={cn(ROW_CLASS, 'items-center py-1.5', selected && ROW_SELECTED_CLASS)}
                          >
                            <span className="flex size-4 shrink-0 items-center justify-center">
                              {selected ? <Check size={14} className="text-[var(--accent-emphasis)]" /> : null}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-13 text-[var(--text-primary)]">
                                {template.title}
                              </span>
                              {template.description ? (
                                <span className="block truncate text-11 text-[var(--text-tertiary)]">
                                  {template.description}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <label className="block">
                  <span className={SECTION_LABEL_CLASS}>{t('remoteWorkspace.dialog.titleLabel')}</span>
                  <Input
                    value={title}
                    onChange={setTitle}
                    disabled={busy}
                    placeholder={t('remoteWorkspace.dialog.titlePlaceholder')}
                  />
                </label>
              </div>
            )}
          </div>

          {vcsNotice ? (
            <div className="mt-3 shrink-0" data-testid="psb-workspace-vcs-notice-slot">
              <WorkspaceVcsNoticeView
                workspaceId={vcsNotice.workspaceId}
                notice={vcsNotice.notice}
                operation={vcsNotice.operation}
                variant="inline"
              />
            </div>
          ) : null}

          {actionError ? (
            <div className="mt-3 shrink-0">
              <ErrorNotice
                message={
                  actionError.personName
                  && actionError.messageKey === 'remoteWorkspace.error.occupiedByOther'
                    ? t(actionError.messageKey, { name: actionError.personName })
                    : t(actionError.messageKey)
                }
                description={actionError.message ?? undefined}
              />
            </div>
          ) : null}

          {/* DESIGN.md §4 Dialog & Modal：Cancel 在最左、主操作在最右（视觉与 DOM 同序）。 */}
          <div className="mt-4 flex shrink-0 justify-end gap-2.5">
            <Button
              type="button"
              size="lg"
              variant="secondary"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t('remoteWorkspace.dialog.cancel')}
            </Button>
            {tab === 'existing' ? (
              <Button
                type="button"
                size="lg"
                variant="primary"
                data-testid="psb-start-session"
                loading={submit === 'occupy'}
                disabled={busy || !canSelect}
                onClick={() => void handleSelectWorkspace()}
              >
                {submit === 'occupy'
                  ? t('remoteWorkspace.dialog.working')
                  : t('remoteWorkspace.dialog.select')}
              </Button>
            ) : (
              <Button
                type="button"
                size="lg"
                variant="primary"
                data-testid="psb-create-workspace"
                loading={submit === 'workspace'}
                disabled={busy || !canCreateWorkspace}
                onClick={() => void handleCreateWorkspace()}
              >
                {submit === 'workspace'
                  ? t('remoteWorkspace.dialog.creatingWorkspace')
                  : t('remoteWorkspace.dialog.createWorkspace')}
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
