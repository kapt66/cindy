/**
 * 草稿页「位置渠道 = 远程工作区」时，项目胶囊里列出的工作区下拉内容。
 *
 * 产品口径（2026-11-25 用户实机反馈后确定）：远程工作区是**位置渠道**，和「本机 / MCPR远程 /
 * 设备…」并列；选中该渠道后，右侧项目胶囊变成工作区下拉。所以这里不新造顶部信息头，
 * 只把「列出 PSB 工作区 + 新建远程工作区」接进既有的项目胶囊（`FolderPickerPopover`）。
 *
 * 与弹窗 `RemoteWorkspacePickerDialog` 的分工：
 *   · 弹窗负责「完整选择/新建工作区（两页签）」；侧栏「新建任务」入口用它；
 *   · 本下拉负责「已经决定用远程工作区渠道后，换/选一个工作区」；
 *   · 行 UI、状态徽标、键盘/ARIA、占用链路与失败文案和弹窗**共用同一份实现**
 *     （`PsbWorkspaceRow` / `WorkspaceStatusBadge` / `usePsbWorkspaceListKeyboard` /
 *     `usePsbWorkspaceSelection`），两个容器只留壳；不再有第二套逐行同构的代码。
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
 * 有内联通知时不再叠加通用错误条（同一事实）。
 */

import { useTranslation } from 'react-i18next';
import { Plus, RefreshCw } from 'lucide-react';

import { ErrorNotice } from '@/components/ui/error-notice';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import {
  psbWorkspaceHealth,
  type PsbRemoteWorkspace,
} from '../../../../shared/psb-remote-workspace';
import { psbFailureText } from '../psbFailureText';
import { WorkspaceVcsNoticeView } from '../vcs/WorkspaceVcsNoticeView';
import { psbFailureDiagnosticText } from '../dialog/psbFailure';
import { PsbWorkspaceRow } from '../dialog/PsbWorkspaceRow';
import type { RemoteWorkspacePickerCreated } from '../dialog/psbSessionIdentity';
import { usePsbWorkspaceListKeyboard } from '../dialog/usePsbWorkspaceListKeyboard';
import { usePsbWorkspaceSelection } from '../dialog/usePsbWorkspaceSelection';

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

export function PsbWorkspacePicker({
  open,
  selectedWorkspaceId,
  onSelect,
  onCreate,
  disabled = false,
}: PsbWorkspacePickerProps) {
  const { t } = useTranslation();
  const selection = usePsbWorkspaceSelection({ open, disabled });

  const selectedIndex = selection.workspaces.findIndex(
    (workspace) => workspace.id === selectedWorkspaceId,
  );

  const keyboard = usePsbWorkspaceListKeyboard({
    role: 'listbox',
    ariaLabel: t('remoteWorkspace.dialog.tabExisting'),
    itemCount: selection.workspaces.length,
    isEnabled: (index) => {
      const workspace = selection.workspaces[index];
      return !!workspace && psbWorkspaceHealth(workspace).canStartSession;
    },
    selectedIndex,
    // 下拉里方向键只移动焦点：选中 = 占用，不能顺手把工作区占了。
    onMoveFocus: () => undefined,
  });

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
          disabled={selection.listLoading || selection.busy || disabled}
          onClick={() => void selection.refresh()}
          className="inline-flex size-5 items-center justify-center rounded-full text-[var(--folder-item-path)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
        >
          <RefreshCw size={12} className={selection.listLoading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {selection.listError ? (
        <ErrorNotice
          className="mx-1 mb-1"
          message={psbFailureText(t, selection.listError)}
          description={psbFailureDiagnosticText(selection.listError) ?? undefined}
          actions={
            <button
              type="button"
              disabled={selection.listLoading}
              onClick={() => void selection.refresh()}
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
        {...keyboard.containerProps}
        aria-busy={selection.busy || undefined}
      >
        {selection.listLoading && selection.workspaces.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-[10px] text-sm text-[var(--folder-item-path)]">
            <Spinner size={14} />
            {t('remoteWorkspace.dialog.workspaceListLoading')}
          </div>
        ) : null}
        {!selection.listLoading &&
        !selection.listError &&
        selection.workspaces.length === 0 ? (
          <div className="px-3 py-[10px] text-sm text-[var(--folder-item-path)]">
            {t('remoteWorkspace.dialog.workspaceListEmpty')}
          </div>
        ) : null}
        {selection.workspaces.map((workspace: PsbRemoteWorkspace, index: number) => (
          <PsbWorkspaceRow
            key={workspace.id}
            workspace={workspace}
            health={psbWorkspaceHealth(workspace)}
            labels={
              selection.labels.get(workspace.id) ?? {
                name: workspace.title || workspace.id,
                secondary: null,
              }
            }
            selected={workspace.id === selectedWorkspaceId}
            occupying={selection.occupyingId === workspace.id}
            busy={selection.busy}
            disabled={disabled}
            testId={`psb-picker-workspace-row-${workspace.id}`}
            keyboardProps={keyboard.getItemProps(index)}
            onActivate={() => {
              if (disabled) return;
              keyboard.noteActivated(index);
              void selection.occupy(workspace).then((created) => {
                if (!created) return;
                onSelect(created);
              });
            }}
          />
        ))}
      </div>

      {selection.vcsNotice ? (
        <div className="mx-1 mt-1" data-testid="psb-picker-vcs-notice-slot">
          <WorkspaceVcsNoticeView
            workspaceId={selection.vcsNotice.workspaceId}
            notice={selection.vcsNotice.notice}
            variant="inline"
          />
        </div>
      ) : null}

      {selection.visibleActionError ? (
        <ErrorNotice
          className="mx-1 mt-1"
          message={psbFailureText(t, selection.visibleActionError)}
          description={psbFailureDiagnosticText(selection.visibleActionError) ?? undefined}
        />
      ) : null}

      <div className="mx-2 my-1 h-px bg-[var(--folder-picker-border)]" />
      <button
        type="button"
        data-testid="psb-picker-create-workspace"
        disabled={disabled || selection.busy}
        onClick={onCreate}
        className={cn(
          'flex w-full items-center gap-3 rounded-[8px] px-3 py-[10px] text-left transition-colors outline-none',
          'hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent',
        )}
      >
        <Plus size={16} className="shrink-0 text-[var(--folder-item-icon)]" />
        {/* 1px 是图标与文字的**光学**基线对齐：Plus 图标视觉重心略高于文字中线，
            负/正 1px 让「新建工作区」与上方行标题落在同一条阅读线上。 */}
        <span className="relative top-px text-sm font-medium text-[var(--folder-item-name)]">
          {t('remoteWorkspace.dialog.createWorkspace')}
        </span>
      </button>
    </div>
  );
}
