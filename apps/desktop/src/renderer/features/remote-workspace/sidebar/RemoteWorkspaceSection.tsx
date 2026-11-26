/**
 * 侧栏「Meka 助理 › 远程工作区」分组节点。
 *
 * ## 它渲染什么（产品正本 `docs/product-rules/psb-remote-workspace-sessions.md` §2.1）
 *
 * 一行分组头（图标 + 「远程工作区」 + 右侧「新建会话」按钮）＋ 其下该身份在本机开过的
 * `psb:` 会话列表（复用主列表同一套会话行组件 / 显示形态）。会话行上的图标按钮、状态标签与
 * 锁由 `RemoteWorkspaceRowDecor` 提供，本文件不重复实现。
 *
 * ## 为什么单独成文件
 *
 * `MekaAssistantSection` 已经 550+ 行，它的分组层是「Meka 项目」；远程工作区是与项目行同级、
 * 但**不属于任何 Meka 项目**的固定节点（`psb:` 会话不进 Meka 项目分组，也不进普通项目/对话段）。
 * 拆出来还便于单测：它只依赖会话列表 + 弹窗回调，不依赖 Meka 项目查询。
 *
 * ## 数据来源
 *
 * 会话列表来自既有本地会话表（父层 `activityFilteredSessions` 已按筛选条件收窄），本组件只做
 * `isRemoteWorkspaceSession()` 兜底过滤与排序 —— 判定唯一依据是 `remoteHostId` 以 `psb:`
 * 开头，**不做二次猜测**（例如不看工作目录、不看标题）。工作区在线/占用状态由
 * `remoteWorkspaceStatusStore` 批量拉取（一次 IPC，非逐行请求）。
 *
 * ## 新建任务
 *
 * 按钮打开 `dialog/` 任务的 `RemoteWorkspacePickerDialog`（`React.lazy` 按需装载，弹窗依赖不进
 * 侧栏首屏 bundle）。弹窗**只选 / 新建工作区**（顺带占用协作锁），不创建 PSB 会话；选定后由
 * 父层导航到草稿页，引擎与模型在草稿页选 —— 本组件只把工作区级载荷
 * `{ workspaceId, clientId, clientName, workspaceTitle, directoryName }` 交给
 * `onWorkspaceSelected`，不写草稿字段（草稿归属 `NewMakerDraftRoute`，其读 route state 的
 * `psbTarget`）。会话行上的状态标签/锁因此只能靠「虚拟 `workingDir` 反查工作区」解析，
 * 不依赖任何会话 id。
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Monitor, SquarePen } from 'lucide-react';

import { Tip } from '@/components/ui/tooltip';
import { useStableTranslation as useTranslation } from '@/hooks/useStableTranslation';
import type { Session } from '@/lib/ccAgent.types';
import { cn } from '@/lib/utils';
import type {
  AutomationScheduleAction,
  AutomationScheduleSessionInfo,
  AutomationSessionGroup,
} from '../../cc-agent/lib/automationSidebarGrouping';
import { sessionActivityMs } from '../../cc-agent/lib/dateSessionGrouping';
import { getDialogueCollapseLimit } from '../../cc-agent/lib/sidebarCollapseConfig';
import { SectionCollapse } from '../../cc-agent/sidebar/SectionCollapse';
import { SessionEntryList } from '../../cc-agent/sidebar/SessionEntryList';
import type { SessionClickHandler } from '../../cc-agent/sidebar/SessionItem';
import type { RemoteWorkspacePickerCreated } from '../dialog/RemoteWorkspacePickerDialog';
import { isRemoteWorkspaceSession } from './isRemoteWorkspaceSession';
import { retainRemoteWorkspaceStatus } from './remoteWorkspaceStatusStore';
import { useRemoteWorkspaceListSnapshot } from './useRemoteWorkspaceSidebar';

/**
 * 新建会话弹窗按需加载：侧栏常驻，弹窗依赖（客户端 / 模板 / 建会话）不进首屏 bundle。
 * 仓库既有同类写法见 `components/settings/SettingsView.tsx` 的 `lazy(() => import(...))`；
 * 命名导出要在这里换成 `default`。
 */
const RemoteWorkspacePickerDialog = lazy(() =>
  import('../dialog/RemoteWorkspacePickerDialog').then((module) => ({
    default: module.RemoteWorkspacePickerDialog,
  })),
);

/**
 * 扁平列表行（`SessionCard` list）缺的横向间距。
 *
 * 普通会话行由行组件自己排节奏：text 行整行 `gap-2.5`、标题簇 `gap-1.5`；list 行的
 * 标题条是 `gap-0`（前缀图标自己带 6px 间隔）。远程工作区的三件装饰是挂在共享行组件里的
 * **独立兄弟节点**，行组件不会为它们补间距，所以 list 下会出现「外链图标紧贴「在线」胶囊、
 * 锁紧贴标题」的挤压（实机量到 3px / 0px）。
 *
 * 这里只在本节点内、且只对 list 变体补：
 *   - 图标按钮 → 状态标签：`mr-1`(4px) 盒间距；按钮内 14px 图标在 20px 点击区里居中，
 *     还有 3px 留白，视觉间距 ≈ 7px；
 *   - 状态标签 / 锁 → 标题：`mr-1.5`(6px)，与普通行的标题簇同档；
 *   - 工作区状态还没解析出来（装饰整体不渲染）时，前置的 `mr-1` 仍把标题与图标按钮分开。
 *
 * 用 data 钩子（既有测试与联调口径）而不是类名选择器，装饰组件本身不感知排版变体；
 * text 行不加这段，避免变成「两套节奏」。
 */
const ROW_DECOR_LIST_SPACING_CLASS = cn(
  '[&_[data-remote-workspace-open]]:mr-1',
  '[&_[data-remote-workspace-status]]:mr-1.5',
);

export interface RemoteWorkspaceSectionProps {
  /** 父层筛选后的会话；本组件再按 `psb:` 兜底过滤一次（防御性，不重复判定来源）。 */
  sessions: readonly Session[];
  activeSessionId?: string;
  runningSessionIds: ReadonlySet<string>;
  attachedSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  scheduleSessionIndex: ReadonlyMap<string, AutomationScheduleSessionInfo>;
  selectedSessionIds?: ReadonlySet<string>;
  onSessionClick: SessionClickHandler;
  onAction: (id: string, action: 'delete' | 'archive' | 'archive-now' | 'unarchive') => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, currentlyPinned: boolean) => void;
  onScheduleAction: (group: AutomationSessionGroup, action: AutomationScheduleAction) => void;
  /** 与主列表一致的显示形态（text / list）。 */
  sessionVariant: 'text' | 'list';
  /**
   * 弹窗选定工作区成功（工作区级载荷，不含会话 id / 引擎）。
   * 父层负责导航到草稿页：引擎、模型与首条消息（以及首条消息时的 PSB 会话创建）都在那边。
   */
  onWorkspaceSelected: (target: RemoteWorkspacePickerCreated) => void;
}

export function RemoteWorkspaceSection({
  sessions,
  activeSessionId,
  runningSessionIds,
  attachedSessionIds,
  notifications,
  scheduleSessionIndex,
  selectedSessionIds,
  onSessionClick,
  onAction,
  onRename,
  onTogglePin,
  onScheduleAction,
  sessionVariant,
  onWorkspaceSelected,
}: RemoteWorkspaceSectionProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const statusSnapshot = useRemoteWorkspaceListSnapshot();

  // 只有这个节点挂载期间才轮询 PSB 工作区状态（引用计数，见 store）。
  useEffect(() => retainRemoteWorkspaceStatus(), []);

  const workspaceSessions = useMemo(() => {
    const psbSessions = sessions.filter(isRemoteWorkspaceSession);
    return psbSessions.slice().sort((a, b) => {
      const pinRank = Number(b.pinnedAt != null) - Number(a.pinnedAt != null);
      return pinRank || sessionActivityMs(b) - sessionActivityMs(a) || a.id.localeCompare(b.id);
    });
  }, [sessions]);

  const handleSelected = useCallback(
    (target: RemoteWorkspacePickerCreated) => {
      // 弹窗只做了「选 / 建工作区（顺带占用）」；本组件把工作区级载荷交给父层导航到草稿页。
      // 会话与 `psb:<id>` 身份在草稿页首条消息时才创建，侧栏这里没有任何会话 id 可记。
      setPickerOpen(false);
      onWorkspaceSelected(target);
    },
    [onWorkspaceSelected],
  );

  const ToggleIcon = collapsed ? ChevronRight : ChevronDown;
  const newSessionLabel = t('remoteWorkspace.sidebar.newSession');

  return (
    <div className="relative flex w-full flex-col select-none">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          setCollapsed((value) => !value);
        }}
        className={cn(
          // 与 Meka 项目行同款几何：h-8 / rounded-full / pl-3 / hover 底。
          'group flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-full pl-3 pr-1',
          'text-sm font-normal text-[var(--sidebar-list-muted)] transition-colors',
          'hover:bg-sidebar-item-hover',
        )}
      >
        <Monitor
          size={15}
          strokeWidth={1.8}
          className="shrink-0 text-[var(--sidebar-list-muted)]"
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">{t('remoteWorkspace.sidebar.title')}</span>
          <ToggleIcon
            size={13}
            strokeWidth={2}
            aria-hidden="true"
            // DESIGN §14.4:时长走 motion token（`--motion-fast`），不写死毫秒数。
            className="shrink-0 text-[var(--cmd-palette-item-meta)] opacity-0 transition-opacity duration-[var(--motion-fast)] group-hover:opacity-100"
          />
        </div>
        {/* 「＋ 新建会话」常显（它是这个节点唯一的入口动作，不像项目行的次级动作藏在 hover）。 */}
        <Tip text={newSessionLabel}>
          <button
            type="button"
            aria-label={newSessionLabel}
            onClick={(event) => {
              // 父行点击 = 折叠，按钮必须拦下来。
              event.stopPropagation();
              setPickerOpen(true);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            className={cn(
              // 尺寸与同段既有行内图标钮一致(size-5 / icon 14);圆角按 DESIGN §5 的 control
              // tier 取 pill(rounded-full),6px 的 rounded-md 不在 §5 半径清单内。
              'flex size-5 shrink-0 items-center justify-center rounded-full',
              'text-sidebar-action-icon hover:text-foreground',
              'hover:bg-sidebar-item-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            )}
          >
            <SquarePen size={14} strokeWidth={2} />
          </button>
        </Tip>
      </div>

      <SectionCollapse collapsed={collapsed}>
        <div className="flex flex-col gap-0.5 pt-0.5 pb-1.5">
          {workspaceSessions.length === 0 ? (
            <div
              data-remote-workspace-empty=""
              className="flex flex-col gap-0.5 py-1 pl-[22px] pr-2 text-xs"
            >
              {statusSnapshot.loadFailed ? (
                <span className="text-[var(--sidebar-list-muted)]">
                  {t('remoteWorkspace.sidebar.loadFailed')}
                </span>
              ) : (
                <>
                  <span className="text-[var(--sidebar-list-muted)]">
                    {t('remoteWorkspace.sidebar.empty')}
                  </span>
                  <span className="text-[var(--cmd-palette-item-meta)]">
                    {t('remoteWorkspace.sidebar.emptyHint')}
                  </span>
                </>
              )}
            </div>
          ) : (
            <div className={cn('pl-3', sessionVariant === 'list' && ROW_DECOR_LIST_SPACING_CLASS)}>
              <SessionEntryList
                sessions={workspaceSessions}
                activeSessionId={activeSessionId}
                runningSessionIds={runningSessionIds}
                attachedSessionIds={attachedSessionIds}
                notifications={notifications}
                scheduleSessionIndex={scheduleSessionIndex}
                selectedSessionIds={selectedSessionIds}
                onSessionClick={onSessionClick}
                onAction={onAction}
                onRename={onRename}
                onTogglePin={onTogglePin}
                onScheduleAction={onScheduleAction}
                collapsible
                collapseLimit={getDialogueCollapseLimit()}
                sectionCollapsed={collapsed}
                indented
                sessionVariant={sessionVariant}
              />
            </div>
          )}
        </div>
      </SectionCollapse>

      {pickerOpen ? (
        <Suspense fallback={null}>
          <RemoteWorkspacePickerDialog
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onCreated={handleSelected}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
