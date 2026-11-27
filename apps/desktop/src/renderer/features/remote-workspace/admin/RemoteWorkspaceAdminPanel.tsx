/**
 * 「远程工作区」页签的页面主体（PSB 网页「远程工作区」的简化版 / 快捷访问）。
 *
 * ## 它显示什么由「工作区」决定，不由当前任务决定
 *
 * 页面数据全部来自主进程的**工作区级**上下文（`useWorkspaceAdminContext`）：当前打开任务的
 * psb 会话（任何状态）→ 最近使用的远程工作区 → 空。页面不读当前任务的 PSB 会话状态，
 * 也不调 `sessionStatus` —— **Agent 任务结束 / 删除 / 切换都不影响本页操作**。
 *
 * ## 结构
 *
 *   1. 顶部页头（**单行 ≤40px**）：左侧信息：**工作区实例名最显眼**（目录名 `directoryName`，
 *      缺失回退 `title`；13px + font-medium）→ 模板名 · 机器名（`templateTitle · clientName`，
 *      次要色）→ 占用；**目录名就是主标题，页头不再单独显示目录段**。三块靠左紧凑、
 *      `min-w-0 + truncate`、`flex-nowrap`，长名称截断、绝不换行、不推高布局；右侧是通用操作按钮
 *      （占用 / 解除占用、在网页打开，`shrink-0` 靠右，不与信息行抢位）。
 *   2. 分类导航（分段控件）：`远程连接 / 版本控制 / 设置`，**左对齐紧凑排列**（inline 轨道、
 *      固定内边距、不拉伸铺满、不参与 space-between）。
 *   3. 内容区：
 *      - 远程连接 = 横条控制区（启动 / 停止同一个按钮切换、详情浮层、串流信息、全屏 + 状态文案）+ 占满剩余高度的
 *        串流画面；详情是 Popover 浮层，不改变任何布局高度；
 *      - 版本控制 / 设置 = 统一风格的「后续提供」占位空态（不放假按钮）；
 *        版本控制在 main 有版本控制检查通知时显示内联提示条 `WorkspaceVcsNoticeView
 *        variant="inline"`（查看详情 / 一键清理 / 继续），没有通知时回落到同一个占位空态；
 *      - 没有可用工作区 / 读不到 / 旧 preload 没有管理桥时，内容区显示对应空态，但页头与
 *        分类导航**始终保留**（页面结构不变）。
 *
 * **分类切换保活（2026-11-26 独立审查 r4 P1）**：切到版本控制 / 设置**不卸载**远程连接面板
 * （只 `hidden` 起来），已建立的串流继续；只有页签不可见 / 关闭 / 换工作区才自动释放观看名额。
 * 旧实现按分类卸载连接区并静默停播：用户看一眼「版本控制」回来就得重新点启动。
 *
 * **stale（2026-11-26 真机事故）**：页头在 stale / 工作区不可见时仍显示名称、模板 · 机器
 * （固定信息来自本机快照 / 历史会话行），并在页头下加一条降级说明；「还没有远程工作区」空态
 * 只在 main 明确返回 `context: null`（本机完全没有线索）时出现。stale 时版本控制通知**只读**：
 * 动作按钮全部禁用并给可行动原因（这时 PSB 工作区事实不可用，点下去只有 404）。
 *
 * ## 页签形态
 *
 * 全局单例页签（`features/right-sidebar/globalTabs.ts`）：不跟任务分桶、切任务留在原位；
 * 打开 / 聚焦走 `openRemoteWorkspaceAdminTab()`；关闭时页面卸载，观看名额由连接区分支释放。
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  GitBranch,
  MonitorCog,
  RefreshCw,
  Settings2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import type { TabKindBodyProps } from '@/features/right-sidebar/types';
import { cn } from '@/lib/utils';
import {
  PSB_ADMIN_STALE_COPY_KEYS,
  psbAdminContextActionBlockedKey,
  psbAdminContextCanOperate,
  psbAdminContextIsStale,
  psbAdminContextStaleCopyKind,
  type PsbWorkspaceAdminContext,
} from '../../../../shared/psb-workspace-admin';
import {
  psbWorkspaceInstanceName,
  psbWorkspaceTemplateMachineText,
} from '../dialog/psbWorkspaceDisplay';
import { formatWorkspaceOccupancy } from '../occupancyLabel';
import {
  rememberWorkspaceVcsNoticeWorkspaceLabel,
  useWorkspaceVcsNotice,
} from '../vcs/vcsNoticeStore';
import { WorkspaceVcsNoticeView } from '../vcs/WorkspaceVcsNoticeView';

import { RemoteWorkspaceAdminActions } from './RemoteWorkspaceAdminActions';
import { RemoteWorkspaceAdminConnection } from './RemoteWorkspaceAdminConnection';
import { useWorkspaceAdminContext } from './useWorkspaceAdminContext';

/** 页签自身不存任何东西：看哪个工作区由主进程解析，不落盘。 */
export type RemoteWorkspaceAdminTabState = Record<string, never>;

/** 三个分类；`kind` 名保留旧值不变，只改展示。 */
export type RemoteWorkspaceAdminCategory = 'connection' | 'versionControl' | 'settings';

const CATEGORY_VALUES: readonly RemoteWorkspaceAdminCategory[] = [
  'connection',
  'versionControl',
  'settings',
];

const CATEGORY_LABEL_KEYS: Record<RemoteWorkspaceAdminCategory, string> = {
  connection: 'remoteWorkspace.admin.categories.connection',
  versionControl: 'remoteWorkspace.admin.categories.versionControl',
  settings: 'remoteWorkspace.admin.categories.settings',
};

const EMPTY_VALUE = '—';

/** 统一风格的空态：图标 + 标题 + 一句说明，居中；不摆假按钮。 */
function AdminEmptyState({
  icon: Icon,
  title,
  hint,
  testId,
  tone = 'neutral',
  action,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly hint?: string;
  readonly testId?: string;
  readonly tone?: 'neutral' | 'failed';
  readonly action?: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex h-full min-h-0 flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <Icon
        size={22}
        className={tone === 'failed' ? 'text-[var(--error-fg)]' : 'text-[var(--text-tertiary)]'}
        aria-hidden
      />
      <p className="text-13 font-medium text-[var(--text-primary)]">{title}</p>
      {hint ? (
        <p className="max-w-[360px] text-12 leading-5 text-[var(--text-secondary)]">{hint}</p>
      ) : null}
      {action}
    </div>
  );
}

/**
 * 顶部页头：**单行**（≤40px），左侧信息**靠左紧凑**排布，右侧通用操作靠右且 `shrink-0`。
 *
 * 用户 2026-11-27 人工复测口径：**实例名 = 工作区目录名**（PSB `directoryName`，如
 * `saga2_project-3`；模板名 `saga2_project` 只是模板，同一模板可以有多个工作区）。所以左侧信息
 * 顺序是：**目录名**（`text-13` + `font-medium`，最显眼）→ **模板名 · 机器名**（`templateTitle` +
 * `clientName` 去重拼接，`text-11` 次要色）→ 占用；目录名缺失（老数据 / PSB 还没回填）才回退
 * `title`。目录名已是主标题，**不再单独显示目录段**。信息组不用 `flex-1` / `justify-between` 撑开：
 * 固定 16px 间距依次紧挨；每段 `min-w-0 + truncate`，长名称截断、窄窗口只挤压信息，不换行、
 * 不推高布局、不压右侧按钮。
 *
 * **stale（读不到工作区 / 工作区已不可见）口径（2026-11-26 真机事故）**：名称 / 模板 · 机器是
 * 固定信息，**仍照常显示**（它们来自本机快照）；占用是状态信息，未知时显示「无法获取」，
 * 不把快照里过期的占用人当成事实。历史会话没有快照时，名称退化成目录名（本机唯一还能确认
 * 「哪个工作区」的字段），模板 · 机器拿不到就显示占位「—」——有可展示的字段就展示，绝不整段留白。
 */
function WorkspaceHeader({
  context,
  actions,
}: {
  readonly context: PsbWorkspaceAdminContext | null;
  readonly actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const stale = context ? psbAdminContextIsStale(context) : false;
  // 主标题 = 实例名（目录名优先，缺失回退标题）：与选择器 / 胶囊同一口径（`psbWorkspaceInstanceName`）。
  const instanceName = context
    ? psbWorkspaceInstanceName({
        directoryName: context.directoryName,
        workspaceTitle: context.title,
      })
    : '';
  const name = instanceName || EMPTY_VALUE;
  // 次要行 = 模板名 · 机器名（去重；模板为空时只剩机器）。目录名已是主标题，不再重复。
  const meta = context
    ? (psbWorkspaceTemplateMachineText({
        templateTitle: context.templateTitle,
        clientName: context.clientName,
        primaryName: instanceName,
      }) ?? EMPTY_VALUE)
    : EMPTY_VALUE;
  // 占用展示与侧栏锁共用同一格式函数：有名字显示名字，自己占用追加「（你）」。
  // stale 时占用是「无法获取」——不能拿本机快照里过期的占用人去误导用户。
  const occupancy = context
    ? stale
      ? t('remoteWorkspace.admin.staleOccupancy')
      : formatWorkspaceOccupancy(context.occupancy, t)
    : EMPTY_VALUE;

  return (
    <div
      data-testid="remote-workspace-admin-workspace-line"
      data-stale={context ? String(stale) : undefined}
      className="flex h-10 shrink-0 flex-nowrap items-center gap-2 overflow-hidden whitespace-nowrap border-b border-[var(--border-default)] px-2.5"
    >
      <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden">
        <MonitorCog size={13} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
        {/* 信息段：同一行靠左、16px 间距紧挨，不用 flex-1 各自撑开。 */}
        <div
          data-testid="remote-workspace-admin-workspace-info"
          className="flex min-w-0 flex-nowrap items-center gap-4 overflow-hidden whitespace-nowrap"
        >
          <span
            data-testid="remote-workspace-admin-workspace-name"
            className="min-w-0 truncate text-13 font-medium text-[var(--text-primary)]"
          >
            {name}
          </span>
          <span
            data-testid="remote-workspace-admin-workspace-meta"
            className="min-w-0 truncate text-11 text-[var(--text-secondary)]"
          >
            {meta}
          </span>
          <span
            data-testid="remote-workspace-admin-workspace-occupancy"
            className="min-w-0 shrink-[2] truncate text-11 text-[var(--text-secondary)]"
          >
            {t('remoteWorkspace.admin.occupancyValue', { value: occupancy })}
          </span>
        </div>
      </div>
      {actions}
    </div>
  );
}

/**
 * 降级说明条：固定信息来自本机快照 / 历史会话行时，页头照旧显示名称、模板 · 机器，这一条
 * 负责说清「为什么现在读不到实时状态」以及用户下一步能做什么。
 *
 * 2026-11-26 真机事故的口径：读不到 / 工作区被删时**不能**退回「还没有远程工作区」空态；
 * 固定信息 + 降级原因要一起出现。PSB 原文只当诊断行（用户能看懂的中文由 i18n 提供）。
 */
function WorkspaceStaleNotice({
  context,
  onRefresh,
}: {
  readonly context: PsbWorkspaceAdminContext;
  readonly onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const kind = psbAdminContextStaleCopyKind(context);
  if (!kind) return null;
  const copy = PSB_ADMIN_STALE_COPY_KEYS[kind];
  const diagnostic = context.lastErrorZh?.trim() || null;
  return (
    <div
      data-testid="remote-workspace-admin-stale-notice"
      data-stale-availability={kind}
      role="status"
      className="flex shrink-0 items-start gap-1.5 border-b border-[var(--border-default)] bg-[var(--surface-elevated)] px-2.5 py-1.5"
    >
      <TriangleAlert
        size={13}
        className="mt-0.5 shrink-0 text-[var(--warning-fg)]"
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-11 leading-4">
        <p className="font-medium text-[var(--text-primary)]">{t(copy.title)}</p>
        <p className="text-[var(--text-secondary)]">{t(copy.hint)}</p>
        {diagnostic ? (
          <p
            data-testid="remote-workspace-admin-stale-detail"
            className="break-words text-[var(--text-tertiary)]"
          >
            {diagnostic}
          </p>
        ) : null}
      </div>
      <Button size="xs" compact variant="secondary" tone="quiet" onClick={onRefresh}>
        <RefreshCw size={13} aria-hidden />
        {t('remoteWorkspace.dialog.refresh')}
      </Button>
    </div>
  );
}

export function RemoteWorkspaceAdminPanel({
  ctx,
  active,
  shellVisible,
}: TabKindBodyProps<RemoteWorkspaceAdminTabState>) {
  const { t } = useTranslation();
  // 只作为「优先跟随哪个任务」的提示交给主进程；页面不做任何按任务的门禁。
  const localSessionId = ctx.sessionId.trim();
  const visible = active !== false && shellVisible !== false;
  const { context, status, refresh } = useWorkspaceAdminContext({
    localSessionId,
    enabled: visible,
  });
  const [category, setCategory] = useState<RemoteWorkspaceAdminCategory>('connection');
  /**
   * 当前工作区的版本控制检查通知（CINDY-RW-10，2026-11-26）。
   *
   * 数据来自 main 的广播（占用 / 释放时缓存后广播）与本 hook 首次挂载 / 换工作区时的兜底读；
   * 页面**不解析也不拼** method/path/body——「查看详情 / 一键清理 / 继续」由 View 按 kind 调
   * `runWorkspaceVcsAction`。有 notice 时版本控制分类显示内联提示条，没有则保留原占位空态。
   * 按 `context.workspaceId` 过滤：换工作区后旧工作区的提示不会串到新工作区的页面上。
   */
  const vcsNotice = useWorkspaceVcsNotice(context?.workspaceId ?? null);
  /**
   * 工作区**实例名**（目录名优先，缺失回退标题）：页头 / 全局横幅共用同一口径，横幅也要能写清
   * 「哪个工作区」（不为此多发请求）。目录名缺失只可能是老数据 / 本机还没快照过。
   */
  const workspaceName = useMemo(
    () =>
      context
        ? psbWorkspaceInstanceName({
            directoryName: context.directoryName,
            workspaceTitle: context.title,
          })
        : '',
    [context],
  );
  useEffect(() => {
    if (!context) return;
    rememberWorkspaceVcsNoticeWorkspaceLabel(context.workspaceId, workspaceName);
  }, [context, workspaceName]);

  const options = useMemo(
    () =>
      CATEGORY_VALUES.map((value) => ({
        value,
        label: t(CATEGORY_LABEL_KEYS[value]),
        id: `remote-workspace-admin-category-${value}`,
        'aria-controls': `remote-workspace-admin-category-panel-${value}`,
      })),
    [t],
  );

  /** 状态类空态（读不到 / 没有工作区 / 加载中）：不渲染连接面板，分类导航仍保留。 */
  const renderContextState = (): ReactNode => {
    if (status === 'unavailable') {
      return (
        <AdminEmptyState
          testId="remote-workspace-admin-unavailable"
          icon={TriangleAlert}
          title={t('remoteWorkspace.admin.emptyUnavailableTitle')}
          hint={t('remoteWorkspace.admin.emptyUnavailableHint')}
        />
      );
    }
    if (status === 'loading') {
      return (
        <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 text-[var(--text-secondary)]">
          <Spinner size={16} />
          <p className="text-12 leading-5">{t('remoteWorkspace.admin.loading')}</p>
        </div>
      );
    }
    if (status === 'failed') {
      return (
        <AdminEmptyState
          testId="remote-workspace-admin-load-failed"
          icon={TriangleAlert}
          tone="failed"
          title={t('remoteWorkspace.admin.emptyLoadFailedTitle')}
          hint={t('remoteWorkspace.admin.emptyLoadFailedHint')}
          action={
            <Button
              size="xs"
              compact
              variant="secondary"
              tone="quiet"
              onClick={() => void refresh()}
            >
              <RefreshCw size={13} aria-hidden />
              {t('remoteWorkspace.dialog.refresh')}
            </Button>
          }
        />
      );
    }
    if (!context) {
      // 没有可用工作区：保留页面结构，只把内容区换成「先打开一个远程工作区任务」。
      return (
        <AdminEmptyState
          testId="remote-workspace-admin-no-workspace"
          icon={MonitorCog}
          title={t('remoteWorkspace.admin.emptyNoWorkspaceTitle')}
          hint={t('remoteWorkspace.admin.emptyNoWorkspaceHint')}
        />
      );
    }
    return null;
  };

  const contextState = renderContextState();
  /** stale / 占位身份：工作区写操作不可用（版本控制通知只读）。 */
  const vcsReadOnly = context ? !psbAdminContextCanOperate(context) : false;
  const vcsReadOnlyHint = context
    ? t(psbAdminContextActionBlockedKey(context) ?? 'remoteWorkspace.admin.staleUnavailableAction')
    : null;

  const versionControlContent = (): ReactNode => {
    // 版本控制分类的挂载点（CINDY-RW-10）：main 广播过 advisory / 旧版 409 时，展示内联
    // 提示与处置动作；没有通知时保留统一占位空态（不放假按钮）。
    if (!vcsNotice) {
      return (
        <AdminEmptyState
          testId="remote-workspace-admin-version-control"
          icon={GitBranch}
          title={t('remoteWorkspace.admin.categories.versionControl')}
          hint={t('remoteWorkspace.admin.placeholderComingSoon')}
        />
      );
    }
    return (
      <div
        data-testid="remote-workspace-admin-version-control"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2.5"
      >
        <WorkspaceVcsNoticeView
          workspaceId={vcsNotice.workspaceId}
          workspaceLabel={workspaceName || vcsNotice.workspaceLabel}
          notice={vcsNotice.notice}
          variant="inline"
          readOnly={vcsReadOnly}
          readOnlyHint={vcsReadOnlyHint}
          onResolved={async (result) => {
            // 清理已接受（202 异步）后先刷新事实，View 会在刷新完成后再弹成功 toast。
            if (result.kind === 'clean-workspace' && result.accepted) await refresh();
          }}
        />
      </div>
    );
  };

  const settingsContent = (): ReactNode => (
    <AdminEmptyState
      testId="remote-workspace-admin-settings"
      icon={Settings2}
      title={t('remoteWorkspace.admin.categories.settings')}
      hint={t('remoteWorkspace.admin.placeholderComingSoon')}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader
        context={status === 'ready' ? context : null}
        actions={
          status === 'ready' && context ? (
            <RemoteWorkspaceAdminActions context={context} onChanged={refresh} />
          ) : undefined
        }
      />
      {/* stale 降级说明：固定信息仍在上方页头显示，这里只解释「为什么状态读不到」+ 重试。 */}
      {status === 'ready' && context && psbAdminContextIsStale(context) ? (
        <WorkspaceStaleNotice context={context} onRefresh={() => void refresh()} />
      ) : null}
      {/* 分类导航：左对齐紧凑排列 —— inline 轨道按内容宽度排布，靠左，不拉伸铺满，
          也不参与 space-between（用户 2026-11-26 口径）。 */}
      <div
        data-testid="remote-workspace-admin-categories"
        className="flex shrink-0 items-center justify-start border-b border-[var(--border-default)] px-2.5 py-1.5"
      >
        <SegmentedControl
          value={category}
          options={options}
          onValueChange={setCategory}
          role="tablist"
          aria-label={t('remoteWorkspace.admin.title')}
          className="w-max max-w-full"
        />
      </div>
      <div
        id={`remote-workspace-admin-category-panel-${category}`}
        role="tabpanel"
        aria-labelledby={`remote-workspace-admin-category-${category}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {contextState ??
          (category === 'versionControl' ? (
            versionControlContent()
          ) : category === 'settings' ? (
            settingsContent()
          ) : null)}
        {/* 远程连接面板**保活**：切到别的分类只隐藏，不卸载（串流不因此中断 / 释放名额）；
            只有页签不可见 / 关闭 / 换工作区时连接区才卸载并释放观看名额。 */}
        {context && !contextState ? (
          <div
            data-testid="remote-workspace-admin-connection-panel"
            aria-hidden={category === 'connection' ? undefined : true}
            className={cn('min-h-0 flex-1 flex-col', category === 'connection' ? 'flex' : 'hidden')}
          >
            <RemoteWorkspaceAdminConnection
              // key = 工作区 id：切到另一个工作区即重挂，串流状态重置、旧观看名额随卸载释放。
              key={context.workspaceId}
              context={context}
              active={active}
              shellVisible={shellVisible}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
