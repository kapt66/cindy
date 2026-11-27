/**
 * 「新建远程工作区任务」弹窗。
 *
 * 产品口径（2026-11-25 用户明确要求）：**新建时不选引擎**，只选择/新建工作区；Harness 与
 * 模型在会话草稿页按既有链路选择。所以这里只做三件事：
 *
 *   1. 列出当前身份可用工作区（不可用行显示短状态徽标并禁用，长原因进 tooltip）；
 *   2. 选中一个工作区 = 在 PSB 上把它占用为当前身份（与网页同一把协作锁）；**无人占用时先弹
 *      确认框**（2026-11-27 用户复测：占用会让别人用不了，必须先问一次），确认并占用成功才算
 *      选中；已是 mine 的行直接选中、不弹确认；占用失败给出可行动的原因并停在这里；
 *   3. 主按钮「新建任务」把**已占用**的工作区交接给父级（侧栏 → 导航草稿页；草稿页内 →
 *      换目标），**不再第二次占用**。
 *
 * **不建 PSB 会话**：会话在草稿页首条消息发送时懒创建（引擎取草稿当时的 Harness），
 * 失败不建本地会话、重试复用同一条。这样弹窗与引擎/模型解耦，草稿页完全走原有链路。
 *
 * 2026-11-26 独立审查后的结构：
 *   - 「列出 → 占用 → 刷新补人名 → hydrate VCS → 内联错误」全部在
 *     `usePsbWorkspaceSelection()` 里，草稿页下拉与本弹窗共用；
 *   - 行 UI / 徽标 / 键盘与 ARIA 在 `PsbWorkspaceRow` + `usePsbWorkspaceListKeyboard`；
 *   - 本文件只剩壳：页签、新建工作区表单、页头状态、布局与按钮。
 *
 * ## 归还（2026-11-27）
 *
 * 弹窗里确认占用成功、但用户还没点「新建任务」就换选另一个工作区 / 关闭弹窗 / 卸载时，
 * 这个工作区由 hook 归还（占用无 TTL，不能留下一把没人接着用的锁）；交接成功后（`onCreated`
 * 已回调）释放责任转到草稿 / 任务生命周期，弹窗不再归还。
 *
 * ## 忙时怎么退出
 *
 * 占用可能很慢（网络卡住）。旧实现忙时禁止关闭，用户只能等；现在可以随时取消/关闭：
 * `usePsbWorkspaceSelection().cancel()` 会作废这次尝试，而**它之后若成功落地会被立刻释放**
 * 并记账（占用无 TTL，不能留一把没有主人、界面上也看不见的锁）。占用本身还有 20s 超时。
 *
 * ## 版本控制检查通知（CINDY-RW-10）
 *
 * 占用被旧版 409 `WORKSPACE_VCS_*` 拒绝、或 0.1.180 成功响应附带 advisory（检出脏）时，main
 * 会把通知缓存后广播。弹窗在占用失败后兜底读一次，并以内联形态（`WorkspaceVcsNoticeView
 * variant="inline"`）展示「查看详情 / 一键清理 / 继续」或旧版「重试 / 还原」；成功的 advisory
 * 在弹窗关闭后由全局宿主 / 管理页继续展示。**有内联通知时不再叠加通用错误条**（同一事实）。
 * 渲染层不解析 method/path/body，动作只按 kind 走 `runWorkspaceVcsAction`。
 *
 * 设计口径：DESIGN.md §4（Dialog & Modal / SegmentedControl / Buttons）、§5（圆角与点击目标）、
 * §10（语义 token、双模式）；文案全部走 `remoteWorkspace.dialog.*` / `remoteWorkspace.error.*`。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Check, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import {
  psbWorkspaceHealth,
  type PsbProjectTemplate,
  type PsbRemoteClient,
  type PsbRemoteStatus,
  type PsbRemoteWorkspace,
} from '../../../../shared/psb-remote-workspace';
import { tryGetPsbRemoteBridge } from '../bridge';
import { psbFailureText } from '../psbFailureText';
import { WorkspaceVcsNoticeView } from '../vcs/WorkspaceVcsNoticeView';
import { psbFailureDiagnosticText, readPsbFailure, type PsbFailureInfo } from './psbFailure';
import { PsbWorkspaceRow } from './PsbWorkspaceRow';
import type { RemoteWorkspacePickerCreated } from './psbSessionIdentity';
import { psbWorkspaceRowDisplayName } from './psbWorkspaceDisplay';
import { usePsbWorkspaceListKeyboard } from './usePsbWorkspaceListKeyboard';
import { usePsbWorkspaceSelection } from './usePsbWorkspaceSelection';

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

const SECTION_LABEL_CLASS = 'mb-1.5 block text-12 font-medium text-[var(--text-secondary)]';
/** 客户端 / 模板行与工作区行同一材质（2026-11-26 审查：两个入口的「行」曾各有一套底色/圆角）。 */
const PICK_ROW_CLASS = cn(
  'flex w-full items-center gap-2.5 rounded-lg border border-[var(--border-default)] px-3 py-1.5 text-left transition-colors outline-none',
  'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
  'disabled:cursor-not-allowed disabled:opacity-60',
  'enabled:hover:bg-[var(--surface-hover)]',
);
const PICK_ROW_SELECTED_CLASS = 'border-[var(--accent-emphasis)] bg-[var(--surface-hover)]';

export function RemoteWorkspacePickerDialog({
  open,
  onOpenChange,
  onCreated,
  initialTab = 'existing',
}: RemoteWorkspacePickerDialogProps) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [tab, setTab] = useState<DialogTab>(initialTab);
  const [status, setStatus] = useState<PsbRemoteStatus | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [clients, setClients] = useState<readonly PsbRemoteClient[]>([]);
  const [templates, setTemplates] = useState<readonly PsbProjectTemplate[]>([]);
  const [createDataLoading, setCreateDataLoading] = useState(false);
  const [createDataLoaded, setCreateDataLoaded] = useState(false);
  const [createDataError, setCreateDataError] = useState<PsbFailureInfo | null>(null);
  const [clientId, setClientId] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [title, setTitle] = useState('');
  /** 新建工作区在途（与占用在途分开：两者都让整弹窗进入忙态）。 */
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  /** 新建出来就已经 ready、待创建态落下后自动走「确认占用」的工作区。 */
  const [createdSelectTarget, setCreatedSelectTarget] = useState<PsbRemoteWorkspace | null>(null);

  const aliveRef = useRef(true);
  const createDataRequestRef = useRef(false);
  const creatingWorkspaceRef = useRef(false);

  const selection = usePsbWorkspaceSelection({
    open,
    disabled: creatingWorkspace,
  });
  const busy = selection.busy || creatingWorkspace;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
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
        setCreateDataError((previous) => previous ?? readPsbFailure(error));
      }
    }
  }, []);

  // 打开时拉一次；关闭后不再发请求。每次打开按入口页签重置（上次的新建表单与错误
  // 不跨打开保留）；在途占用由 hook 的 open/unmount 清理保证不留无名占用。
  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setSelectedWorkspaceId(null);
    setCreateDataError(null);
    setCreateDataLoaded(false);
    setClients([]);
    setTemplates([]);
    setClientId('');
    setTemplateKey('');
    setTitle('');
    setCreatedSelectTarget(null);
    void loadStatus();
  }, [initialTab, loadStatus, open]);

  // 新建工作区表单的客户端 / 模板只在第一次切到该页签时拉一次（不重复打 PSB）。
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

  const selectedIndex = useMemo(
    () => selection.workspaces.findIndex((workspace) => workspace.id === selectedWorkspaceId),
    [selectedWorkspaceId, selection.workspaces],
  );
  const selectedWorkspace =
    selectedIndex >= 0 ? selection.workspaces[selectedIndex] ?? null : null;
  // 主按钮只交接**已占用**的选择：行点击在确认 / 占用成功后才设 `selectedWorkspaceId`，
  // 新建出来但还没占用的行（provisioning）即使被选中也不能交接。
  const canSelect =
    !!selectedWorkspace &&
    selection.heldWorkspaceId === selectedWorkspace.id &&
    psbWorkspaceHealth(selectedWorkspace).canStartSession;

  // 弹窗是 `listbox`：激活（Enter/Space/点击）才走确认+占用；方向键只移动焦点。
  // 不能沿用「焦点跟随选中」的 radio 惯例——那会在键盘浏览时反复弹确认框/占用工作区。
  const keyboard = usePsbWorkspaceListKeyboard({
    role: 'listbox',
    ariaLabel: t('remoteWorkspace.dialog.tabExisting'),
    itemCount: selection.workspaces.length,
    isEnabled: (index) => {
      const workspace = selection.workspaces[index];
      return !!workspace && psbWorkspaceHealth(workspace).canStartSession;
    },
    selectedIndex,
    onMoveFocus: () => undefined,
  });

  /**
   * 激活一个工作区行：mine → 直接选中；无人占用 → 先弹确认，确认并占用成功才选中；
   * 不可选 / 占用失败 → 保持未选中（失败事实由 hook 的 `actionError` / VCS 通知展示）。
   */
  const beginWorkspaceSelection = useCallback(
    async (workspace: PsbRemoteWorkspace) => {
      // 待确认 / 忙时不再叠第二个确认框（双击行、回车连发都走这里）。
      if (busy || selection.pendingOccupy) return;
      const outcome = selection.requestSelect(workspace);
      if (outcome.kind === 'blocked') return;
      if (outcome.releasedWorkspaceId) setSelectedWorkspaceId(null);
      if (outcome.kind === 'selected') {
        setSelectedWorkspaceId(outcome.created.workspaceId);
        return;
      }
      const name =
        selection.labels.get(workspace.id)?.name ?? psbWorkspaceRowDisplayName(workspace);
      const confirmed = await confirm({
        title: t('remoteWorkspace.dialog.confirmOccupy.title', { name }),
        description: t('remoteWorkspace.dialog.confirmOccupy.body'),
        confirmText: t('remoteWorkspace.dialog.confirmOccupy.confirm'),
        cancelText: t('remoteWorkspace.dialog.confirmOccupy.cancel'),
      });
      if (!confirmed) {
        // 取消 = 不占用、不选中；此前已释放的选择由 outcome.releasedWorkspaceId 清掉选中态。
        selection.cancelOccupy();
        return;
      }
      const created = await selection.confirmOccupy();
      if (!created) return;
      setSelectedWorkspaceId(created.workspaceId);
    },
    [busy, confirm, selection, t],
  );

  const close = useCallback(
    (next: boolean) => {
      // 关闭/取消 = 放弃这次选择：在途占用作废（它若之后成功会被立刻释放并记账），
      // 已占用但还没交接的工作区也在 `cancel()` 里归还。
      if (!next) selection.cancel();
      onOpenChange(next);
    },
    [onOpenChange, selection],
  );

  /**
   * 主按钮 = **交接**已占用的工作区（占用已在行上确认时完成，这里不再 occupy 第二次）。
   * 占用失败**不**回调、不导航（产品验收：占用失败不留在草稿里）。
   */
  const handleSelectWorkspace = useCallback(() => {
    if (busy) return;
    const created = selection.handoffSelection();
    if (!created) return;
    onCreated(created);
    close(false);
  }, [busy, close, onCreated, selection]);

  const canCreateWorkspace = !!clientId && !!templateKey;

  const handleCreateWorkspace = useCallback(async () => {
    const bridge = tryGetPsbRemoteBridge();
    if (!bridge || !clientId || !templateKey) return;
    if (creatingWorkspaceRef.current || selection.busy) return;
    creatingWorkspaceRef.current = true;
    setCreatingWorkspace(true);
    setCreateDataError(null);
    try {
      const created = await bridge.createWorkspace({
        clientId,
        templateKey,
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      const next = await selection.refresh();
      if (!aliveRef.current) return;
      const list = next ?? [];
      if (!list.some((workspace) => workspace.id === created.workspace.id)) {
        // 列表请求失败/尚未反映刚建出的行：本地补上，保证用户看得到自己刚建的工作区。
        selection.adoptWorkspace?.(created.workspace);
      }
      // 新建成功 → 回到列表页并选中它。**新建不等于占用**：provisioning 时行上是「准备中」
      // （等 ready 才能占用）；已经 ready 的等本轮创建态清掉后，走与点击行相同的「确认占用」。
      setSelectedWorkspaceId(created.workspace.id);
      setTab('existing');
      if (psbWorkspaceHealth(created.workspace).canStartSession) {
        setCreatedSelectTarget(created.workspace);
      }
    } catch (error) {
      if (aliveRef.current) setCreateDataError(readPsbFailure(error));
    } finally {
      creatingWorkspaceRef.current = false;
      if (aliveRef.current) setCreatingWorkspace(false);
    }
  }, [clientId, selection, templateKey, title]);

  // 新建出来就已经 ready 的工作区：等 `creatingWorkspace` 落下后再弹确认（创建在途时禁用选择，
  // 同步调用会被 `disabled` 挡掉）。
  useEffect(() => {
    if (!open || creatingWorkspace || !createdSelectTarget) return;
    const workspace = createdSelectTarget;
    setCreatedSelectTarget(null);
    void beginWorkspaceSelection(workspace);
  }, [beginWorkspaceSelection, createdSelectTarget, creatingWorkspace, open]);

  const statusReason = status && !status.ready ? status.reasonKey : null;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        close(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
        <Dialog.Content
          className="modal-panel fixed left-1/2 top-1/2 z-[10001] flex max-h-[min(620px,85vh)] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col p-4 focus:outline-none"
          onPointerDownOutside={(event) => event.preventDefault()}
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
                selection.dismissError();
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
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className={cn(SECTION_LABEL_CLASS, 'mb-0')}>
                    {t('remoteWorkspace.dialog.tabExisting')}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    compact
                    disabled={selection.listLoading || busy}
                    onClick={() => void selection.refresh()}
                  >
                    <RefreshCw
                      size={12}
                      className={selection.listLoading ? 'animate-spin' : undefined}
                    />
                    {t('remoteWorkspace.dialog.refresh')}
                  </Button>
                </div>
                {selection.listError ? (
                  <ErrorNotice
                    message={psbFailureText(t, selection.listError)}
                    description={psbFailureDiagnosticText(selection.listError) ?? undefined}
                    actions={
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        compact
                        disabled={selection.listLoading || busy}
                        onClick={() => void selection.refresh()}
                      >
                        {t('remoteWorkspace.dialog.refresh')}
                      </Button>
                    }
                  />
                ) : null}
                {selection.listLoading && selection.workspaces.length === 0 ? (
                  <div className="flex items-center gap-2 px-1 py-6 text-13 text-[var(--text-secondary)]">
                    <Spinner size={14} />
                    {t('remoteWorkspace.dialog.workspaceListLoading')}
                  </div>
                ) : null}
                {!selection.listLoading &&
                !selection.listError &&
                selection.workspaces.length === 0 ? (
                  <p className="px-1 py-6 text-13 text-[var(--text-secondary)]">
                    {t('remoteWorkspace.dialog.workspaceListEmpty')}
                  </p>
                ) : null}
                <div
                  className="flex flex-col gap-1.5"
                  data-testid="psb-workspace-list"
                  {...keyboard.containerProps}
                >
                  {selection.workspaces.map((workspace, index) => {
                    const health = psbWorkspaceHealth(workspace);
                    const selected = workspace.id === selectedWorkspaceId;
                    return (
                      <PsbWorkspaceRow
                        key={workspace.id}
                        workspace={workspace}
                        health={health}
                        labels={
                          selection.labels.get(workspace.id) ?? {
                            name: workspace.title || workspace.id,
                            secondary: null,
                          }
                        }
                        selected={selected}
                        occupying={selection.occupyingId === workspace.id}
                        busy={busy}
                        testId={`psb-workspace-row-${workspace.id}`}
                        keyboardProps={keyboard.getItemProps(index)}
                        onActivate={() => {
                          keyboard.noteActivated(index);
                          void beginWorkspaceSelection(workspace);
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3" data-testid="psb-workspace-create-form">
                {createDataError ? (
                  <ErrorNotice
                    message={psbFailureText(t, createDataError)}
                    description={psbFailureDiagnosticText(createDataError) ?? undefined}
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
                    <div
                      className="flex max-h-[168px] flex-col gap-1 overflow-y-auto"
                      role="radiogroup"
                      aria-label={t('remoteWorkspace.dialog.client')}
                    >
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
                              selection.dismissError();
                            }}
                            className={cn(
                              PICK_ROW_CLASS,
                              'items-center',
                              selected && PICK_ROW_SELECTED_CLASS,
                            )}
                          >
                            <span className="flex size-4 shrink-0 items-center justify-center">
                              {selected ? (
                                <Check size={14} className="text-[var(--accent-emphasis)]" />
                              ) : null}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-13 text-[var(--text-primary)]">
                              {client.name || client.id}
                            </span>
                            {unavailable ? (
                              <span className="shrink-0 text-11 text-[var(--text-tertiary)]">
                                {t('remoteWorkspace.error.clientOffline')}
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
                    <div
                      className="flex max-h-[168px] flex-col gap-1 overflow-y-auto"
                      role="radiogroup"
                      aria-label={t('remoteWorkspace.dialog.template')}
                    >
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
                              selection.dismissError();
                            }}
                            className={cn(
                              PICK_ROW_CLASS,
                              'items-center',
                              selected && PICK_ROW_SELECTED_CLASS,
                            )}
                          >
                            <span className="flex size-4 shrink-0 items-center justify-center">
                              {selected ? (
                                <Check size={14} className="text-[var(--accent-emphasis)]" />
                              ) : null}
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

          {selection.vcsNotice ? (
            <div className="mt-3 shrink-0" data-testid="psb-workspace-vcs-notice-slot">
              <WorkspaceVcsNoticeView
                workspaceId={selection.vcsNotice.workspaceId}
                notice={selection.vcsNotice.notice}
                variant="inline"
              />
            </div>
          ) : null}

          {selection.visibleActionError ? (
            <div className="mt-3 shrink-0">
              <ErrorNotice
                message={psbFailureText(t, selection.visibleActionError)}
                description={
                  psbFailureDiagnosticText(selection.visibleActionError) ?? undefined
                }
              />
            </div>
          ) : null}

          {/* DESIGN.md §4 Dialog & Modal：Cancel 在最左、主操作在最右（视觉与 DOM 同序）。
              忙时两个按钮都保持可聚焦（loading + allowWhileLoading + aria-disabled），
              否则开始占用的那一刻焦点会被 disabled 甩回 body。 */}
          <div className="mt-4 flex shrink-0 justify-end gap-2.5">
            <Button
              type="button"
              size="lg"
              variant="secondary"
              onClick={() => close(false)}
            >
              {t('remoteWorkspace.dialog.cancel')}
            </Button>
            {tab === 'existing' ? (
              <Button
                type="button"
                size="lg"
                variant="primary"
                data-testid="psb-start-session"
                loading={selection.busy}
                allowWhileLoading
                aria-disabled={busy || !canSelect}
                disabled={!busy && !canSelect}
                onClick={() => void handleSelectWorkspace()}
              >
                {selection.busy
                  ? t('remoteWorkspace.dialog.working')
                  : t('remoteWorkspace.dialog.select')}
              </Button>
            ) : (
              <Button
                type="button"
                size="lg"
                variant="primary"
                data-testid="psb-create-workspace"
                loading={creatingWorkspace}
                allowWhileLoading
                aria-disabled={busy || !canCreateWorkspace}
                disabled={!creatingWorkspace && !canCreateWorkspace}
                onClick={() => void handleCreateWorkspace()}
              >
                {creatingWorkspace
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
