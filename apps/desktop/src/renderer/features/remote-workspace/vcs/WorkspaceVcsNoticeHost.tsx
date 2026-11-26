/**
 * 版本控制检查通知的**全局宿主**（CINDY-RW-10）—— 挂一次，覆盖所有占用 / 释放入口。
 *
 * ## 为什么需要全局宿主
 *
 * 产生 notice 的入口有六条（工作区弹窗、草稿页工作区选择、管理页页头占用/释放、自动占用
 * 发送闸门、启动串流、放弃草稿释放），其中「发送前自动占用」经过会话发送事务，没有自己的
 * 稳定 UI 落点。全局宿主订阅 store：谁触发的都能看到同一条非阻塞提示，不必在每个入口各写
 * 一套横幅（那六份一定会漂）。
 *
 * ## 挂载
 *
 * 放在 App 的受信窗口子树里、`ConfirmDialogProvider` 内（需要 `useConfirmDialog` 做不可逆
 * 动作的二次确认）；推荐主窗挂载：
 *
 * ```tsx
 * {!isSecondaryWindow() && !isSidebarWindow() && <WorkspaceVcsNoticeHost />}
 * ```
 *
 * 多窗口同时挂也安全：store 在各自 renderer 进程内，推送由 main 广播。
 *
 * ## 非阻塞
 *
 * 固定悬浮在视口右上（`pointer-events-none` 容器 + 内层 `pointer-events-auto`），不遮断
 * 输入；advisory 是**建议**（操作已成功），旧版 409 兼容形态也以提示条呈现、不弹模态。
 */

import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { clearWorkspaceVcsNoticeState, useWorkspaceVcsNotices } from './vcsNoticeStore';
import { WorkspaceVcsNoticeView } from './WorkspaceVcsNoticeView';

export interface WorkspaceVcsNoticeHostProps {
  /** 悬浮位置；缺省右上。 */
  readonly position?: 'top-right' | 'top-center' | 'bottom-right';
  /**
   * 宿主需要刷新工作区数据时调用（清理已接受 / 旧版还原成功后）。
   * 缺省不做事：View 内已经调用 `refreshWorkspaces` 并给「刷新」按钮。
   */
  readonly onResolved?: () => void;
}

export function WorkspaceVcsNoticeHost({
  position = 'top-right',
  onResolved,
}: WorkspaceVcsNoticeHostProps) {
  const { t } = useTranslation();
  const notices = useWorkspaceVcsNotices();
  const { confirm } = useConfirmDialog();
  // 悬浮条只显示**最近一条**：同一时刻多工作区都有提示时，按状态变化顺序取最后一条；
  // 其余的通知不会丢（各入口的内联 View 仍读得到），用户处理完当前这条后会看到下一条。
  const latest = notices.length > 0 ? notices[notices.length - 1] : null;
  if (!latest) return null;

  const positionClass =
    position === 'top-center'
      ? 'top-2 left-1/2 -translate-x-1/2'
      : position === 'bottom-right'
        ? 'bottom-2 right-2'
        : 'top-2 right-2';

  return (
    <div
      data-testid="workspace-vcs-notice-host"
      className={`pointer-events-none fixed z-40 w-[min(440px,calc(100vw-1rem))] ${positionClass}`}
    >
      <div className="pointer-events-auto">
        <WorkspaceVcsNoticeView
          workspaceId={latest.workspaceId}
          notice={latest.notice}
          operation={latest.operation}
          variant="banner"
          requestConfirm={async (input) => confirm(input)}
          onResolved={() => {
            onResolved?.();
          }}
          onDismiss={() => {
            clearWorkspaceVcsNoticeState(latest.workspaceId);
          }}
        />
      </div>
    </div>
  );
}
