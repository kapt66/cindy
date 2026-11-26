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
 *   1. 顶部页头（**单行 ≤40px**）：左侧信息：**工作区名称最显眼**（`title`，13px + font-medium）→
 *      模板 · 机器（`templateTitle · clientName`，次要色）→ 占用；**页头不显示目录**。三块靠左紧凑、
 *      `min-w-0 + truncate`、`flex-nowrap`，长名称截断、绝不换行、不推高布局；右侧是通用操作按钮
 *      （占用 / 解除占用、在网页打开，`shrink-0` 靠右，不与信息行抢位）。
 *   2. 分类导航（分段控件）：`远程连接 / 版本控制 / 设置`，**左对齐紧凑排列**（inline 轨道、
 *      固定内边距、不拉伸铺满、不参与 space-between）。
 *   3. 内容区：
 *      - 远程连接 = 横条控制区（启动 / 停止同一个按钮切换、详情浮层、串流信息、全屏 + 状态文案）+ 占满剩余高度的
 *        串流画面；详情是 Popover 浮层，不改变任何布局高度；
 *      - 版本控制 / 设置 = 统一风格的「后续提供」占位空态（不放假按钮）；
 *      - 没有可用工作区 / 读不到 / 旧 preload 没有管理桥时，内容区显示对应空态，但页头与
 *        分类导航**始终保留**（页面结构不变）。
 *
 * ## 页签形态
 *
 * 全局单例页签（`features/right-sidebar/globalTabs.ts`）：不跟任务分桶、切任务留在原位；
 * 打开 / 聚焦走 `openRemoteWorkspaceAdminTab()`；关闭时页面卸载，观看名额由连接区分支释放。
 */

import { useMemo, useState, type ReactNode } from 'react';
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
import type { PsbWorkspaceAdminContext } from '../../../../shared/psb-workspace-admin';
import { formatWorkspaceOccupancy } from '../occupancyLabel';

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
 * 用户 2026-11-26 口径（参考 PSB 网页工作区页）：**工作区名称最显眼**（`title`，`text-13` +
 * `font-medium`），其后依次是模板 · 机器（`templateTitle` + `clientName`，`text-11` 次要色），
 * 再是占用信息；**不再显示目录名**（目录仍留在上下文字段里给其它调用方，只是页头不展示）。
 * 信息组不用 `flex-1` / `justify-between` 撑开：固定 16px 间距依次紧挨；每段 `min-w-0 + truncate`，
 * 长名称截断、窄窗口只挤压信息，不换行、不推高布局、不压右侧按钮。
 */
function WorkspaceHeader({
  context,
  actions,
}: {
  readonly context: PsbWorkspaceAdminContext | null;
  readonly actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const name = context?.title.trim() || EMPTY_VALUE;
  // 模板与机器合成一个次要信息段（模板为空时只剩机器；两者都空时显示占位）。
  const meta = context
    ? [context.templateTitle?.trim(), context.clientName.trim()].filter(Boolean).join(' · ') ||
      EMPTY_VALUE
    : EMPTY_VALUE;
  // 占用展示与侧栏锁共用同一格式函数：有名字显示名字，自己占用追加「（你）」。
  const occupancy = context ? formatWorkspaceOccupancy(context.occupancy, t) : EMPTY_VALUE;

  return (
    <div
      data-testid="remote-workspace-admin-workspace-line"
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

  const renderContent = () => {
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
            <Button size="xs" compact variant="secondary" tone="quiet" onClick={refresh}>
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
    if (category === 'versionControl') {
      return (
        <AdminEmptyState
          testId="remote-workspace-admin-version-control"
          icon={GitBranch}
          title={t('remoteWorkspace.admin.categories.versionControl')}
          hint={t('remoteWorkspace.admin.placeholderComingSoon')}
        />
      );
    }
    if (category === 'settings') {
      return (
        <AdminEmptyState
          testId="remote-workspace-admin-settings"
          icon={Settings2}
          title={t('remoteWorkspace.admin.categories.settings')}
          hint={t('remoteWorkspace.admin.placeholderComingSoon')}
        />
      );
    }
    return (
      <RemoteWorkspaceAdminConnection
        // key = 工作区 id：切到另一个工作区即重挂，串流状态重置、旧观看名额随卸载释放。
        key={context.workspaceId}
        context={context}
        active={active}
        shellVisible={shellVisible}
      />
    );
  };

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
        {renderContent()}
      </div>
    </div>
  );
}
