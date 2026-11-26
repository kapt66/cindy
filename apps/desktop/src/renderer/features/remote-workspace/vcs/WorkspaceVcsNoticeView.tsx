/**
 * 版本控制检查通知的展示 + 处置组件（CINDY-RW-10）。
 *
 * ## 两代形态同一个组件
 *
 * - **0.1.180 advisory**（`notice.advisory === true`）：占用 / 释放已成功，这是**非阻塞建议**。
 *   可放进页头 / 横幅 / 弹层，不遮断操作；给「查看详情 / 一键清理 / 继续」。
 * - **旧版 409 兼容**（`advisory === false`）：操作被拒，同样是这份 notice；给「查看详情 /
 *   旧版还原 / 重试检查」（旧 action kind，收到才渲染）。
 *
 * ## 安全与交互底线
 *
 * - 渲染层**不碰 method/path/body**：只按 `kind` 调 `runWorkspaceVcsAction`，URL 与 body 由
 *   main 从服务端 notice 取并校验（见 `main/remote-workspace/vcsNotice.ts`）。
 * - `clean-workspace` / 旧 `revert-*` 是**不可逆**动作：必须先二次确认（列 projects / changes、
 *   说明会删除新增 / 还原修改 / Git 切回默认分支）。`requestConfirm` 由宿主注入（通常接
 *   `useConfirmDialog`）；缺省用组件内置的两步确认，保证任何宿主下都不会「一下点掉」。
 * - 清理是 **202 异步**：成功后显示「清理已开始」+ 刷新按钮；**不猜轮询端点**（服务端没给
 *   轮询接口时猜路径就是新增一个未约定请求）。
 * - `force-release` 不在共享白名单里，这里永远不会渲染它的按钮。
 */

import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, GitBranch, Info, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { extractIpcError } from '../../../../shared/ipcError';
import {
  isWorkspaceVcsActionKind,
  workspaceVcsActionIsIrreversible,
  workspaceVcsActionMessageKey,
  workspaceVcsNoticeMessageKey,
  type WorkspaceVcsAction,
  type WorkspaceVcsActionKind,
  type WorkspaceVcsNotice,
  type WorkspaceVcsOperation,
} from '../../../../shared/psb-workspace-vcs';
import { psbFailureMessageKeyForIpcCode } from '../../../../shared/psb-remote-workspace';
import { tryGetPsbRemoteBridge } from '../bridge';
import { clearWorkspaceVcsNoticeState } from './vcsNoticeStore';

/** 宿主注入的二次确认（通常接 `useConfirmDialog`）；返回 `true` 才真正执行。 */
export type WorkspaceVcsConfirmRequest = (input: {
  title: string;
  description: string;
  confirmText: string;
}) => Promise<boolean>;

/** 动作完成后的回调（清理已接受 / 继续 / 旧版还原或重试成功）。 */
export interface WorkspaceVcsResolvedResult {
  readonly kind: WorkspaceVcsActionKind;
  readonly accepted: boolean;
  readonly operationId: string | null;
}

export interface WorkspaceVcsNoticeViewProps {
  readonly workspaceId: string;
  readonly notice: WorkspaceVcsNotice;
  /** 产生 notice 的入口（只影响文案，例如自动占用时标题更明确）。 */
  readonly operation?: WorkspaceVcsOperation;
  /**
   * `banner`（默认）：页头 / 全局横幅，非阻塞、带边框的浅色条；
   * `inline`：对话框或表单内的紧凑形态（advisory 也仍然用信息色，不用错误红）。
   */
  readonly variant?: 'banner' | 'inline';
  /** 工作区显示名（可选；放横幅时用来指明是哪个工作区）。 */
  readonly workspaceLabel?: string | null;
  /** 不可逆动作的二次确认入口；缺省用内置两步确认。 */
  readonly requestConfirm?: WorkspaceVcsConfirmRequest;
  /** 动作完成后通知宿主（宿主可刷新 admin 上下文 / 草稿工作区行）。 */
  readonly onResolved?: (result: WorkspaceVcsResolvedResult) => void;
  /** 自定义错误呈现；缺省 toast。 */
  readonly onError?: (error: unknown) => void;
  /** 关闭回调；不传则不渲染关闭按钮（例如 409 兼容形态下必须处置）。 */
  readonly onDismiss?: () => void;
  readonly className?: string;
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
    .sort((left, right) => ACTION_ORDER.indexOf(left.kind) - ACTION_ORDER.indexOf(right.kind));
}

/** 把 IPC 失败翻成用户可读的一句话（PSB 码走共享映射，其它显示原文）。 */
export function workspaceVcsFailureText(
  error: unknown,
  t: (key: string) => string,
): string {
  const ipc = extractIpcError(error);
  if (ipc) {
    const key = psbFailureMessageKeyForIpcCode(ipc.code);
    const detail = ipc.message.trim();
    if (key) return detail ? `${t(key)}（${detail}）` : t(key);
    if (detail) return detail;
  }
  const message = error instanceof Error ? error.message.trim() : '';
  return message || t('remoteWorkspace.error.unknown');
}

/** 项目清单（确认区的不可逆范围说明；详情区也复用它）。 */
function ProjectLines({
  notice,
  className,
}: {
  readonly notice: WorkspaceVcsNotice;
  readonly className?: string;
}): ReactNode {
  const { t } = useTranslation();
  if (notice.projects.length === 0) return null;
  return (
    <ul className={className}>
      {notice.projects.map((project) => (
        <li key={`${String(project.projectId)}:${project.pathInWorkspace}`} className="leading-[1.6]">
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
 * 详情区：默认只显示 notice 自带的 projects 摘要；点「查看详情」会**按服务端给的
 * `inspect-vcs` action** 拉一次完整明细（不自己拼 GET 路径）。
 */
function VcsDetails({
  notice,
  detail,
  loading,
  onRequestDetail,
}: {
  readonly notice: WorkspaceVcsNotice;
  readonly detail: unknown;
  readonly loading: boolean;
  readonly onRequestDetail: () => void;
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
    <div
      data-testid="workspace-vcs-details"
      className="mt-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-hover)] px-2.5 py-2 text-12 text-[var(--text-secondary)]"
    >
      <div className="font-medium text-[var(--text-primary)]">
        {t('remoteWorkspace.vcs.detailsTitle')}
      </div>
      <ProjectLines notice={notice} className="mt-1 list-none space-y-0.5" />
      {hasInspect ? (
        <div className="mt-1.5 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            compact
            tone="quiet"
            loading={loading}
            onClick={onRequestDetail}
          >
            {loading ? t('remoteWorkspace.vcs.detailsLoading') : t('remoteWorkspace.vcs.detailsToggle')}
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
    </div>
  );
}

export function WorkspaceVcsNoticeView({
  workspaceId,
  notice,
  operation,
  variant = 'banner',
  workspaceLabel = null,
  requestConfirm,
  onResolved,
  onError,
  onDismiss,
  className,
}: WorkspaceVcsNoticeViewProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<WorkspaceVcsActionKind | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detail, setDetail] = useState<unknown>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [acceptedOperationId, setAcceptedOperationId] = useState<string | null>(null);
  /** 缺省二次确认：点不可逆动作先进入这一步，再点确认才执行。 */
  const [pendingConfirm, setPendingConfirm] = useState<WorkspaceVcsAction | null>(null);

  const title = notice.messageZh.trim() || t(workspaceVcsNoticeMessageKey(notice.code));
  const advisory = notice.advisory;
  const projectsSummary =
    notice.projects.length > 0
      ? t('remoteWorkspace.vcs.projectsSummary', {
          count: String(notice.projects.length),
          changes: String(notice.projects.reduce((sum, project) => sum + project.changes, 0)),
        })
      : null;

  const reportError = useCallback(
    (error: unknown) => {
      if (onError) {
        onError(error);
        return;
      }
      toast.error(workspaceVcsFailureText(error, t));
    },
    [onError, t],
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
        onResolved?.({ kind, accepted: false, operationId: null });
        return;
      }
      const bridge = tryGetPsbRemoteBridge();
      if (!bridge || typeof bridge.runWorkspaceVcsAction !== 'function') {
        reportError(new Error('[PSB_REMOTE_BRIDGE_MISSING]'));
        return;
      }
      setBusy(kind);
      try {
        const result = await bridge.runWorkspaceVcsAction({
          workspaceId,
          kind,
          ...(workspaceVcsActionIsIrreversible(kind) ? { confirm: true } : {}),
        });
        setAcceptedOperationId(result.operationId ?? null);
        if (kind === 'inspect-vcs') {
          setDetail(result.data ?? null);
          setDetailsOpen(true);
        } else if (kind === 'clean-workspace') {
          // 202 异步：展示「清理已开始」，并给刷新入口（不猜轮询端点）。
          toast.success(t('remoteWorkspace.vcs.cleanStarted'));
        } else {
          // 旧版 409 兼容：还原 / 重试成功后检查已通过。
          toast.success(t('remoteWorkspace.vcs.actionDone'));
        }
        onResolved?.({
          kind,
          accepted: result.accepted === true,
          operationId: result.operationId ?? null,
        });
      } catch (error) {
        reportError(error);
      } finally {
        setBusy(null);
        setPendingConfirm(null);
      }
    },
    [onResolved, reportError, t, workspaceId],
  );

  /**
   * 不可逆动作的确认与执行（唯一路径）。
   *
   * 宿主提供 `requestConfirm`（生产：`useConfirmDialog`）时**只走宿主确认**，不再叠加内联确认区
   * ——否则用户要点两次（2026-11-26 接线反馈）。只有组件被单独嵌入、没有宿主确认能力时才用
   * 内联两步确认。
   */
  const executeIrreversible = useCallback(
    async (action: WorkspaceVcsAction) => {
      if (requestConfirm) {
        const confirmed = await requestConfirm({
          title: t('remoteWorkspace.vcs.confirm.title'),
          description: `${t('remoteWorkspace.vcs.confirm.description', {
            projects: String(notice.projects.length),
            path: notice.projects.map((project) => project.pathInWorkspace).join('、'),
          })}\n${t('remoteWorkspace.vcs.irreversibleNote')}`,
          confirmText: t('remoteWorkspace.vcs.confirm.action'),
        });
        if (!confirmed) return;
      }
      await runAction(action.kind);
    },
    [notice.projects, requestConfirm, runAction, t],
  );

  const onActionClick = useCallback(
    (action: WorkspaceVcsAction) => {
      if (!isWorkspaceVcsActionKind(action.kind)) return;
      if (workspaceVcsActionIsIrreversible(action.kind)) {
        // 有宿主确认能力 → 直接弹宿主确认（一次）；否则进入内联确认区（第二次点击才执行）。
        if (requestConfirm) void executeIrreversible(action);
        else setPendingConfirm(action);
        return;
      }
      void runAction(action.kind);
    },
    [executeIrreversible, requestConfirm, runAction],
  );

  /** 内联确认区（无宿主 `requestConfirm` 时）的「确认」按钮：已经过本组件的一次确认。 */
  const confirmPending = useCallback(async () => {
    const action = pendingConfirm;
    if (!action) return;
    await runAction(action.kind);
  }, [pendingConfirm, runAction]);

  const refresh = useCallback(async () => {
    const bridge = tryGetPsbRemoteBridge();
    if (!bridge || typeof bridge.refreshWorkspaces !== 'function') return;
    try {
      await bridge.refreshWorkspaces({ workspaceIds: [workspaceId] });
      toast.success(t('remoteWorkspace.vcs.refreshed'));
    } catch (error) {
      reportError(error);
    }
  }, [reportError, t, workspaceId]);

  const icon = advisory ? (
    <GitBranch size={15} aria-hidden />
  ) : (
    <AlertTriangle size={15} aria-hidden />
  );
  const toneClass = advisory
    ? 'border-[var(--border-default)] bg-[var(--surface-elevated)]'
    : 'border-[var(--error-border,var(--border-default))] bg-[var(--surface-elevated)]';
  const actions = orderedActions(notice);

  return (
    <div
      data-testid="workspace-vcs-notice"
      data-advisory={advisory ? 'true' : 'false'}
      data-variant={variant}
      className={[
        'flex items-start gap-2 rounded-xl border px-3 py-2',
        toneClass,
        variant === 'inline' ? 'text-12' : '',
        className ?? '',
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
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="break-words text-13 font-medium leading-[1.54] text-[var(--text-primary)]">
          {workspaceLabel ? `${workspaceLabel} · ` : ''}
          {title}
        </div>
        <div className="mt-0.5 text-12 leading-[1.6] text-[var(--text-secondary)]">
          {advisory
            ? t(
                notice.code === 'WORKSPACE_VCS_DIRTY'
                  ? 'remoteWorkspace.vcs.advisoryHint'
                  : notice.code === 'WORKSPACE_VCS_UNSUPPORTED'
                    ? 'remoteWorkspace.vcs.unsupportedHint'
                    : 'remoteWorkspace.vcs.unavailableHint',
              )
            : t('remoteWorkspace.vcs.rejectedHint')}
          {projectsSummary ? ` · ${projectsSummary}` : ''}
          {operation === 'ensure' ? ` · ${t('remoteWorkspace.vcs.autoOccupyHint')}` : ''}
        </div>
        <ProjectLines notice={notice} className="mt-1 list-none text-12 text-[var(--text-secondary)]" />

        {pendingConfirm ? (
          <div
            data-testid="workspace-vcs-confirm"
            className="mt-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-hover)] px-2.5 py-2"
          >
            <div className="flex items-center gap-1.5 text-12 font-medium text-[var(--text-primary)]">
              <Info size={13} aria-hidden />
              {t('remoteWorkspace.vcs.confirm.title')}
            </div>
            <div className="mt-0.5 text-12 leading-[1.6] text-[var(--text-secondary)]">
              {t('remoteWorkspace.vcs.confirm.description', {
                projects: String(notice.projects.length),
                path: notice.projects.map((project) => project.pathInWorkspace).join('、'),
              })}
            </div>
            <div className="mt-1 text-12 leading-[1.6] text-[var(--text-secondary)]">
              {t('remoteWorkspace.vcs.irreversibleNote')}
            </div>
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
                {t('remoteWorkspace.vcs.confirm.action')}
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
          </div>
        ) : null}

        {acceptedOperationId ? (
          <div
            data-testid="workspace-vcs-cleaning"
            className="mt-2 flex flex-wrap items-center gap-2 text-12 text-[var(--text-secondary)]"
          >
            <span>{t('remoteWorkspace.vcs.cleanStarted')}</span>
            <Button type="button" size="sm" compact tone="quiet" onClick={() => void refresh()}>
              <RefreshCw size={12} aria-hidden />
              {t('remoteWorkspace.vcs.refresh')}
            </Button>
          </div>
        ) : null}

        {detailsOpen ? (
          <VcsDetails
            notice={notice}
            detail={detail}
            loading={detailLoading}
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
                disabled={busy !== null && busy !== action.kind}
                onClick={() => onActionClick(action)}
              >
                {label}
              </Button>
            );
          })}
          <Button
            type="button"
            size="sm"
            compact
            tone="quiet"
            onClick={() => {
              const next = !detailsOpen;
              setDetailsOpen(next);
              if (next && detail === null && actions.some((action) => action.kind === 'inspect-vcs')) {
                // 详情按服务端给的 inspect-vcs action 拉取；不自己拼 GET 路径。
                void runAction('inspect-vcs');
              }
            }}
          >
            {t(detailsOpen ? 'remoteWorkspace.vcs.detailsHide' : 'remoteWorkspace.vcs.detailsShow')}
          </Button>
          {onDismiss ? (
            <Button type="button" size="sm" compact tone="quiet" onClick={onDismiss}>
              {t('remoteWorkspace.vcs.dismiss')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
