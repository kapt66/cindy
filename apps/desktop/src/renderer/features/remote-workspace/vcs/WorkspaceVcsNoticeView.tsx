/**
 * 版本控制检查通知的展示 + 处置组件（CINDY-RW-10）。
 *
 * ## 两代形态同一个组件
 *
 * - **0.1.180 advisory**（`notice.advisory === true`）：占用 / 释放已成功，这是**非阻塞建议**。
 *   可放进页头 / 横幅 / 弹层，不遮断操作；给「读取完整详情 / 一键清理 / 继续」。
 * - **旧版 409 兼容**（`advisory === false`）：操作被拒，同样是这份 notice；给「读取完整详情 /
 *   旧版还原 / 重试检查」（旧 action kind，收到才渲染）。
 *
 * ## 安全与交互底线
 *
 * - 渲染层**不碰 method/path/body**：只按 `kind` 调 `runWorkspaceVcsAction`，URL 与 body 由
 *   main 从服务端 notice 取并校验（见 `main/remote-workspace/vcsNotice.ts`）。
 * - 不可逆动作（`clean-workspace` / 旧 `revert-*`）**必须**先二次确认：确认文案按 `kind`
 *   生成（清理 / 还原后占用 / 还原后解除占用各说各的后果），并列出具体检出与未提交修改数。
 *   `requestConfirm` 由宿主注入（生产：`useConfirmDialog`，用 `content` 渲染清单）；缺省用
 *   组件内置的两步确认，保证任何宿主下都不会「一下点掉」。
 * - `readOnly`（工作区 stale / 占位身份）：所有动作按钮禁用并给出原因 —— 这时 PSB 工作区
 *   事实不可用，任何动作都只会撞 404，不能把不可逆按钮摆在那里当陷阱。
 * - 清理是 **202 异步**：只有 `clean-workspace` 成功后显示「清理已开始」+ 刷新按钮；**不猜
 *   轮询端点**（服务端没给轮询接口时猜路径就是新增一个未约定请求）。
 * - `force-release` 不在共享白名单里，这里永远不会渲染它的按钮。
 * - 关闭：advisory 直接关（建议随时可忽略）；非 advisory 先调 main 的 `continue` 清掉缓存
 *   再关，否则换窗口 / 兜底 hydrate 会把已关闭的拒绝提示复现。
 * - 失败文案统一走根 `psbFailureText`（PSB 码 → i18n；本文件不再自建 code → 文案映射）。
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, GitBranch, Info, RefreshCw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import {
  isWorkspaceVcsActionKind,
  workspaceVcsActionIsIrreversible,
  workspaceVcsActionMessageKey,
  workspaceVcsNoticeMessageKey,
  type WorkspaceVcsAction,
  type WorkspaceVcsActionKind,
  type WorkspaceVcsNotice,
} from '../../../../shared/psb-workspace-vcs';
import { psbFailureText } from '../psbFailureText';
import { getPsbRemoteBridge, psbBridgeHasMethod, tryGetPsbRemoteBridge } from '../bridge';
import { clearWorkspaceVcsNoticeState } from './vcsNoticeStore';

/** 宿主注入的二次确认（通常接 `useConfirmDialog`）；返回 `true` 才真正执行。 */
export type WorkspaceVcsConfirmRequest = (input: {
  title: string;
  description: string;
  confirmText: string;
  /**
   * 逐条检出范围（`path · 未提交修改数`）。宿主可用确认框的富内容区渲染成列表；
   * 不用字符串拼中文标点（顿号 / 括号在源码里写死会让 12 种语言共用一套标点）。
   */
  lines?: readonly string[];
}) => Promise<boolean>;

/** 动作完成后的回调（清理已接受 / 继续 / 旧版还原或重试成功）。可返回 Promise 供宿主等待刷新。 */
export interface WorkspaceVcsResolvedResult {
  readonly kind: WorkspaceVcsActionKind;
  readonly accepted: boolean;
  readonly operationId: string | null;
}

export interface WorkspaceVcsNoticeViewProps {
  readonly workspaceId: string;
  readonly notice: WorkspaceVcsNotice;
  /**
   * `banner`（默认）：页头 / 全局横幅，非阻塞、带边框的浅色条；
   * `inline`：对话框或表单内的紧凑形态（advisory 也仍然用信息色，不用错误红）。
   */
  readonly variant?: 'banner' | 'inline';
  /** 工作区显示名（已知时放第一行，说清是哪个工作区）。 */
  readonly workspaceLabel?: string | null;
  /** 不可逆动作的二次确认入口；缺省用内置两步确认。 */
  readonly requestConfirm?: WorkspaceVcsConfirmRequest;
  /** 动作完成后的通知（宿主可刷新 admin 上下文 / 草稿工作区行）；可返回 Promise。 */
  readonly onResolved?: (result: WorkspaceVcsResolvedResult) => void | Promise<void>;
  /** 关闭回调；advisory 关本地即可，非 advisory 会先清 main 缓存。 */
  readonly onDismiss?: () => void;
  /** 工作区事实不可用（stale / 占位身份）：禁用所有动作，只保留关闭。 */
  readonly readOnly?: boolean;
  /** readOnly 时显示的可行动原因（已本地化的一句话）。 */
  readonly readOnlyHint?: string | null;
}

/** 处置动作的排序：先只读详情，再清理，再重试/继续（旧版动作排在后面）。 */
const ACTION_ORDER: readonly WorkspaceVcsActionKind[] = [
  'inspect-vcs',
  'clean-workspace',
  'revert-then-occupy',
  'revert-then-release',
  'revert-vcs',
  'retry',
  'continue',
];

function orderedActions(notice: WorkspaceVcsNotice): readonly WorkspaceVcsAction[] {
  return [...notice.actions]
    // 运行时白名单：共享解析层已丢弃未知 kind，这里再兜一次（force-release 等已删除动作
    // 即使因旧数据 / 手改载荷混进来也**不渲染按钮**）。
    .filter((action) => isWorkspaceVcsActionKind(action.kind))
    // 详情由专用开关（`detailsShow` / `detailsHide`）提供，不再把 inspect-vcs 摆成一个动作按钮。
    .filter((action) => action.kind !== 'inspect-vcs')
    .sort((left, right) => ACTION_ORDER.indexOf(left.kind) - ACTION_ORDER.indexOf(right.kind));
}

/** 逐条检出范围：`path · kind · N 处未提交修改`（i18n 模板；源码不拼标点）。 */
function projectScopeLines(
  notice: WorkspaceVcsNotice,
  t: ReturnType<typeof useTranslation>['t'],
): readonly string[] {
  return notice.projects.map((project) =>
    t('remoteWorkspace.vcs.projectLine', {
      path: project.pathInWorkspace,
      kind: project.kind || 'vcs',
      changes: String(project.changes),
    }),
  );
}

/** 不可逆动作的确认文案：标题 / 摘要 / 确认按钮都按 kind 生成（不再共用「清理并继续」）。 */
interface VcsConfirmCopy {
  readonly title: string;
  readonly description: string;
  readonly confirmText: string;
  readonly lines: readonly string[];
}

function buildConfirmCopy(
  notice: WorkspaceVcsNotice,
  kind: WorkspaceVcsActionKind,
  t: ReturnType<typeof useTranslation>['t'],
): VcsConfirmCopy {
  const lines = projectScopeLines(notice, t);
  // 确认框正文只有一句摘要（Radix Description 是 <p>，多行会被折成一行）：具体检出清单走
  // `lines`（宿主用富内容区渲染成列表）。不再套 `confirm.description` 模板 —— 它带
  // 「（{{path}}）」占位，路径已单独列出后只剩一对空括号（旧实现的重复来源）。
  const summary =
    notice.code === 'WORKSPACE_VCS_DIRTY' && notice.projects.length > 0
      ? t('remoteWorkspace.vcs.projectsSummary', {
          count: String(notice.projects.length),
          changes: String(notice.projects.reduce((sum, project) => sum + project.changes, 0)),
        })
      : '';
  // 旧版 409 的 revert-* 与 0.1.180 的 clean-workspace 是不同后果，标题 / 按钮各用各的：
  // clean 用「清理工作区并继续？」，revert-* 用各自的动作名（都带「不可撤销」）。
  const isClean = kind === 'clean-workspace';
  return {
    title: isClean ? t('remoteWorkspace.vcs.confirm.title') : t(workspaceVcsActionMessageKey(kind)),
    description: [summary, t('remoteWorkspace.vcs.irreversibleNote')]
      .filter((line) => line.length > 0)
      .join(' '),
    confirmText: isClean
      ? t('remoteWorkspace.vcs.confirm.action')
      // 旧版 revert-* 没有「清理并继续」这个语义：按钮用通用「确认」（宿主确认框同款默认文案），
      // 具体后果写在标题（动作名，含「不可撤销」）与不可逆说明里。
      : t('commonUi.confirmDialog.confirm'),
    lines,
  };
}

/** 项目清单（advisory / 旧版 400 共用的唯一「范围」区；详情块不再重复列一遍）。 */
function ProjectLines({ notice }: { readonly notice: WorkspaceVcsNotice }): ReactNode {
  const { t } = useTranslation();
  if (notice.projects.length === 0) return null;
  return (
    <ul className="mt-1 list-none space-y-0.5 text-12 leading-[1.6] text-[var(--text-secondary)]">
      {notice.projects.map((project) => (
        <li key={`${String(project.projectId)}:${project.pathInWorkspace}`}>
          {t('remoteWorkspace.vcs.projectLine', {
            path: project.pathInWorkspace,
            kind: project.kind || 'vcs',
            changes: String(project.changes),
          })}
        </li>
      ))}
    </ul>
  );
}

/**
 * 详情区：按服务端给的 `inspect-vcs` action 拉一次完整明细（不自己拼 GET 路径）。
 *
 * 只展示服务端返回的标量字段；未提交修改范围已经在正文的 `ProjectLines` 列过一次，这里不再
 * 重复（r4 P2：详情三份重复）。
 */
function VcsDetails({
  notice,
  detail,
  loading,
  onRequestDetail,
  disabled,
}: {
  readonly notice: WorkspaceVcsNotice;
  readonly detail: unknown;
  readonly loading: boolean;
  readonly onRequestDetail: () => void;
  readonly disabled: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const hasInspect = notice.actions.some((action) => action.kind === 'inspect-vcs');
  const primitives =
    detail && typeof detail === 'object' && !Array.isArray(detail)
      ? Object.entries(detail as Record<string, unknown>).flatMap(([key, value]) =>
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? [`${key}: ${String(value)}`]
            : [],
        )
      : [];
  return (
    <section
      data-testid="workspace-vcs-details"
      aria-label={t('remoteWorkspace.vcs.detailsTitle')}
      className="mt-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-hover)] px-2.5 py-2 text-12 text-[var(--text-secondary)]"
    >
      <div className="font-medium text-[var(--text-primary)]">
        {t('remoteWorkspace.vcs.detailsTitle')}
      </div>
      {hasInspect ? (
        <div className="mt-1.5 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            compact
            tone="quiet"
            loading={loading}
            disabled={disabled}
            onClick={onRequestDetail}
          >
            {loading ? t('remoteWorkspace.vcs.detailsLoading') : t('remoteWorkspace.vcs.detailsShow')}
          </Button>
        </div>
      ) : null}
      {detail !== null && primitives.length === 0 && !loading ? (
        <div className="mt-1">{t('remoteWorkspace.vcs.detailsEmpty')}</div>
      ) : null}
      {primitives.length > 0 ? (
        <ul className="mt-1 list-none space-y-0.5 font-mono">
          {primitives.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function WorkspaceVcsNoticeView({
  workspaceId,
  notice,
  variant = 'banner',
  workspaceLabel = null,
  requestConfirm,
  onResolved,
  onDismiss,
  readOnly = false,
  readOnlyHint = null,
}: WorkspaceVcsNoticeViewProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<WorkspaceVcsActionKind | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detail, setDetail] = useState<unknown>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  /** 只有 `clean-workspace` 被服务端接受（202）后才是「清理已开始」，其它动作不共用这句。 */
  const [cleaningStarted, setCleaningStarted] = useState(false);
  /** 缺省二次确认：点不可逆动作先进入这一步，再点确认才执行。 */
  const [pendingConfirm, setPendingConfirm] = useState<WorkspaceVcsAction | null>(null);

  const title = notice.messageZh.trim() || t(workspaceVcsNoticeMessageKey(notice.code));
  const advisory = notice.advisory;
  const actions = orderedActions(notice);

  const reportError = useCallback(
    (error: unknown) => {
      toast.error(psbFailureText(t, error));
    },
    [t],
  );

  const runAction = useCallback(
    async (kind: WorkspaceVcsActionKind) => {
      // `continue` = 「忽略提示，继续使用工作区」：**不发 HTTP**，但必须让 main 清掉该工作区的
      // notice 缓存（否则换窗口 / 兜底 hydrate 会把已忽略的提示复现）。main 的
      // `runWorkspaceVcsAction` 对 continue 是幂等的：无缓存直接返回，不产生网络请求。
      if (kind === 'continue') {
        const continueBridge = tryGetPsbRemoteBridge();
        try {
          if (continueBridge && typeof continueBridge.runWorkspaceVcsAction === 'function') {
            await continueBridge.runWorkspaceVcsAction({ workspaceId, kind });
          }
        } catch {
          // main 清缓存失败不阻塞用户关闭提示；本地先清，下一次 hydrate 以 main 为准。
        }
        clearWorkspaceVcsNoticeState(workspaceId);
        await onResolved?.({ kind, accepted: false, operationId: null });
        onDismiss?.();
        return;
      }
      // 空桥由 getPsbRemoteBridge 产出稳定的 [PSB_REMOTE_BRIDGE_MISSING] 错误（勿手写）；
      // 方法缺失（旧 preload）仍按「此版本不支持」处理，不静默。
      let bridge;
      try {
        bridge = getPsbRemoteBridge();
      } catch (bridgeError) {
        reportError(bridgeError);
        return;
      }
      if (!psbBridgeHasMethod(bridge, 'runWorkspaceVcsAction')) {
        reportError(new Error('runWorkspaceVcsAction is unavailable in this build'));
        return;
      }
      setBusy(kind);
      try {
        const result = await bridge.runWorkspaceVcsAction({
          workspaceId,
          kind,
          ...(workspaceVcsActionIsIrreversible(kind) ? { confirm: true } : {}),
        });
        if (kind === 'inspect-vcs') {
          setDetail(result.data ?? null);
          setDetailsOpen(true);
        } else if (kind === 'clean-workspace') {
          // 202 异步：只有清理被接受才展示「清理已开始」+ 刷新入口（不猜轮询端点）。
          if (result.accepted) setCleaningStarted(true);
        }
        // 先等宿主把事实刷新完（管理页重新读工作区上下文），再弹成功 toast：
        // 用户看到「清理已开始」时页面上的事实已经是刷新后的。
        await onResolved?.({
          kind,
          accepted: result.accepted === true,
          operationId: result.operationId ?? null,
        });
        if (kind === 'clean-workspace' && result.accepted) {
          toast.success(t('remoteWorkspace.vcs.cleanStarted'));
        }
      } catch (error) {
        reportError(error);
      } finally {
        setBusy(null);
        setPendingConfirm(null);
      }
    },
    [onDismiss, onResolved, reportError, t, workspaceId],
  );

  /**
   * 不可逆动作的确认与执行（唯一路径）。
   *
   * 宿主提供 `requestConfirm`（生产：`useConfirmDialog`）时**只走宿主确认**，不再叠加内联确认区
   * ——否则用户要点两次。只有组件被单独嵌入、没有宿主确认能力时才用内联两步确认。
   */
  const executeIrreversible = useCallback(
    async (action: WorkspaceVcsAction) => {
      const copy = buildConfirmCopy(notice, action.kind, t);
      if (requestConfirm) {
        const confirmed = await requestConfirm({
          title: copy.title,
          description: copy.description,
          confirmText: copy.confirmText,
          lines: copy.lines,
        });
        if (!confirmed) return;
      }
      await runAction(action.kind);
    },
    [notice, requestConfirm, runAction, t],
  );

  const onActionClick = useCallback(
    (action: WorkspaceVcsAction) => {
      if (readOnly || !isWorkspaceVcsActionKind(action.kind)) return;
      if (workspaceVcsActionIsIrreversible(action.kind)) {
        // 有宿主确认能力 → 直接弹宿主确认（一次）；否则进入内联确认区（第二次点击才执行）。
        if (requestConfirm) void executeIrreversible(action);
        else setPendingConfirm(action);
        return;
      }
      void runAction(action.kind);
    },
    [executeIrreversible, readOnly, requestConfirm, runAction],
  );

  /** 内联确认区（无宿主 `requestConfirm` 时）的「确认」按钮：已经过本组件的一次确认。 */
  const confirmPending = useCallback(async () => {
    const action = pendingConfirm;
    if (!action) return;
    await runAction(action.kind);
  }, [pendingConfirm, runAction]);

  const refresh = useCallback(async () => {
    const bridge = tryGetPsbRemoteBridge();
    if (!psbBridgeHasMethod(bridge, 'refreshWorkspaces')) return;
    try {
      await bridge.refreshWorkspaces({ workspaceIds: [workspaceId] });
      toast.success(t('remoteWorkspace.vcs.refreshed'));
    } catch (error) {
      reportError(error);
    }
  }, [reportError, t, workspaceId]);

  /** 关闭：advisory 直接清本地；非 advisory 先清 main 缓存，避免换窗口 / hydrate 复现。 */
  const dismiss = useCallback(async () => {
    if (!advisory) {
      const bridge = tryGetPsbRemoteBridge();
      try {
        if (bridge && psbBridgeHasMethod(bridge, 'runWorkspaceVcsAction')) {
          await bridge.runWorkspaceVcsAction({ workspaceId, kind: 'continue' });
        }
      } catch (error) {
        // main 清缓存失败：保留提示（否则下一次 hydrate 又回来，用户会以为没关掉）。
        reportError(error);
        return;
      }
    }
    clearWorkspaceVcsNoticeState(workspaceId);
    onDismiss?.();
  }, [advisory, onDismiss, reportError, workspaceId]);

  const hintKey =
    notice.code === 'WORKSPACE_VCS_DIRTY'
      ? 'remoteWorkspace.vcs.advisoryHint'
      : notice.code === 'WORKSPACE_VCS_UNSUPPORTED'
        ? 'remoteWorkspace.vcs.unsupportedHint'
        : 'remoteWorkspace.vcs.unavailableHint';
  const projectsSummary =
    notice.code === 'WORKSPACE_VCS_DIRTY' && notice.projects.length > 0
      ? t('remoteWorkspace.vcs.projectsSummary', {
          count: String(notice.projects.length),
          changes: String(notice.projects.reduce((sum, project) => sum + project.changes, 0)),
        })
      : null;
  const pendingCopy = pendingConfirm
    ? buildConfirmCopy(notice, pendingConfirm.kind, t)
    : null;

  return (
    <div
      data-testid="workspace-vcs-notice"
      data-advisory={advisory ? 'true' : 'false'}
      data-variant={variant}
      data-read-only={readOnly ? 'true' : undefined}
      className={[
        'flex items-start gap-2 rounded-xl border px-3 py-2',
        advisory
          ? 'border-[var(--border-default)] bg-[var(--surface-elevated)]'
          : 'border-[var(--error-border,var(--border-default))] bg-[var(--surface-elevated)]',
        variant === 'inline' ? 'text-12' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span
        className={[
          'mt-0.5 inline-flex shrink-0',
          advisory ? 'text-[var(--text-secondary)]' : 'text-[var(--error-fg)]',
        ].join(' ')}
        aria-hidden
      >
        {advisory ? <GitBranch size={15} /> : <AlertTriangle size={15} />}
      </span>
      <div className="min-w-0 flex-1">
        {/* 读屏播报区只包文字（不含动作按钮）：advisory 是「操作已生效」的建议 → status/polite；
            旧版 409 是拒绝 → alert/assertive。 */}
        <div
          data-testid="workspace-vcs-notice-message"
          role={advisory ? 'status' : 'alert'}
          aria-live={advisory ? 'polite' : 'assertive'}
        >
          <div className="break-words text-13 font-medium leading-[1.54] text-[var(--text-primary)]">
            {workspaceLabel ? (
              <>
                <span data-testid="workspace-vcs-workspace-label">{workspaceLabel}</span>
                <span aria-hidden> · </span>
              </>
            ) : null}
            {title}
          </div>
          {/* 一句提示一段：不再用「 · 」把事实拼成一句（r4 P2：同文 / 长句不可读）。 */}
          <p className="mt-0.5 text-12 leading-[1.6] text-[var(--text-secondary)]">
            {advisory ? t(hintKey) : t('remoteWorkspace.vcs.rejectedHint')}
          </p>
          {projectsSummary ? (
            <p
              data-testid="workspace-vcs-projects-summary"
              className="text-12 leading-[1.6] text-[var(--text-secondary)]"
            >
              {projectsSummary}
            </p>
          ) : null}
        </div>
        <ProjectLines notice={notice} />

        {readOnly ? (
          <p
            data-testid="workspace-vcs-read-only-hint"
            className="mt-1 text-12 leading-[1.6] text-[var(--text-tertiary)]"
          >
            {readOnlyHint ?? t('remoteWorkspace.admin.staleUnavailableAction')}
          </p>
        ) : null}

        {pendingConfirm && pendingCopy ? (
          <section
            data-testid="workspace-vcs-confirm"
            role="group"
            aria-label={pendingCopy.title}
            className="mt-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-hover)] px-2.5 py-2"
          >
            <div className="flex items-center gap-1.5 text-12 font-medium text-[var(--text-primary)]">
              <Info size={13} aria-hidden />
              {pendingCopy.title}
            </div>
            {pendingCopy.lines.length > 0 ? (
              <ul className="mt-1 list-none space-y-0.5 text-12 leading-[1.6] text-[var(--text-secondary)]">
                {pendingCopy.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
            <p className="mt-1 text-12 leading-[1.6] text-[var(--text-secondary)]">
              {t('remoteWorkspace.vcs.irreversibleNote')}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                compact
                variant="secondary"
                tone="danger"
                loading={busy === pendingConfirm.kind}
                onClick={() => void confirmPending()}
              >
                {pendingCopy.confirmText}
              </Button>
              <Button
                type="button"
                size="sm"
                compact
                tone="quiet"
                disabled={busy !== null}
                onClick={() => setPendingConfirm(null)}
              >
                {t('remoteWorkspace.vcs.confirm.cancel')}
              </Button>
            </div>
          </section>
        ) : null}

        {cleaningStarted ? (
          <div
            data-testid="workspace-vcs-cleaning"
            className="mt-2 flex flex-wrap items-center gap-2 text-12 text-[var(--text-secondary)]"
          >
            <span>{t('remoteWorkspace.vcs.cleanStarted')}</span>
            <Button type="button" size="sm" compact tone="quiet" onClick={() => void refresh()}>
              <RefreshCw size={12} aria-hidden />
              {t('remoteWorkspace.dialog.refresh')}
            </Button>
          </div>
        ) : null}

        {detailsOpen && !readOnly ? (
          <VcsDetails
            notice={notice}
            detail={detail}
            loading={detailLoading}
            disabled={readOnly || busy !== null}
            onRequestDetail={() => {
              setDetailLoading(true);
              void runAction('inspect-vcs').finally(() => setDetailLoading(false));
            }}
          />
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {actions.map((action) => {
            const label = action.descriptionZh?.trim() || t(workspaceVcsActionMessageKey(action.kind));
            const irreversible = workspaceVcsActionIsIrreversible(action.kind);
            return (
              <Button
                key={action.kind}
                type="button"
                size="sm"
                compact
                variant={irreversible ? 'secondary' : 'primary'}
                tone={irreversible ? 'danger' : 'default'}
                loading={busy === action.kind}
                disabled={readOnly || (busy !== null && busy !== action.kind)}
                onClick={() => onActionClick(action)}
              >
                {label}
              </Button>
            );
          })}
          {!readOnly ? (
            <Button
              type="button"
              size="sm"
              compact
              tone="quiet"
              aria-expanded={detailsOpen}
              onClick={() => {
                const next = !detailsOpen;
                setDetailsOpen(next);
                if (
                  next &&
                  detail === null &&
                  notice.actions.some((action) => action.kind === 'inspect-vcs')
                ) {
                  // 详情按服务端给的 inspect-vcs action 拉取；不自己拼 GET 路径。
                  void runAction('inspect-vcs');
                }
              }}
            >
              {t(detailsOpen ? 'remoteWorkspace.vcs.detailsHide' : 'remoteWorkspace.vcs.detailsShow')}
            </Button>
          ) : null}
          {onDismiss ? (
            <Button
              type="button"
              size="sm"
              compact
              tone="quiet"
              aria-label={t('remoteWorkspace.vcs.dismiss')}
              onClick={() => void dismiss()}
            >
              <X size={12} aria-hidden />
              {t('remoteWorkspace.vcs.dismiss')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
