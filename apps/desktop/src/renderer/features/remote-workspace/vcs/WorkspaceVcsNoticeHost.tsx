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
 * ## 挂载（App 根唯一安装）
 *
 * 放在 App 的受信窗口子树里、`ConfirmDialogProvider` 内（需要 `useConfirmDialog` 做不可逆
 * 动作的二次确认）；只挂主窗：
 *
 * ```tsx
 * {!isSecondaryWindow() && !isSidebarWindow() && <WorkspaceVcsNoticeHost />}
 * ```
 *
 * store 的推送订阅本身是**引用计数**的（`ensureWorkspaceVcsNoticeBridge`），所以主窗卸载再
 * 挂载、或者管理页 / 选择器各自安装，都不会出现「首调用者卸载后推送断掉」。
 *
 * ## 位置（避开窗口按钮 / 拖拽条 / toast）
 *
 * 固定悬浮在**右下角**：右上角是 Windows / macOS 的窗口按钮与标题行拖拽区，顶部中间 /
 * 右上（`top-16 right-6`）是仓库 ToastContainer 的落点。右下角同时避开这两处，且
 * `pointer-events-none` 容器 + 内层 `pointer-events-auto`，不遮断输入。非阻塞：advisory 是
 * **建议**（操作已成功），旧版 409 兼容形态也以提示条呈现、不弹模态。
 *
 * ## 只显示最近一条
 *
 * 同一时刻多工作区都有提示时，显示**最近被更新**的那一条（store 的 revision 顺序；更新已有
 * 工作区也会移到末尾）。横幅第一行带工作区显示名（store 由各入口上报），用户能分清是哪台
 * 机器 / 哪个工作区。其余通知不会丢：各入口的内联 View 与版本控制分类仍读得到，处理完当前
 * 这条后会看到下一条。
 */

import type { ReactNode } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  clearWorkspaceVcsNoticeState,
  useWorkspaceVcsNotices,
  type WorkspaceVcsNoticeState,
} from './vcsNoticeStore';
import { WorkspaceVcsNoticeView } from './WorkspaceVcsNoticeView';

/** 最近（revision 最大）的一条通知；数组按修改时间升序，取末位。 */
function latestNoticeState(
  states: readonly WorkspaceVcsNoticeState[],
): WorkspaceVcsNoticeState | null {
  let latest: WorkspaceVcsNoticeState | null = null;
  for (const state of states) {
    if (!latest || state.revision >= latest.revision) latest = state;
  }
  return latest;
}

export function WorkspaceVcsNoticeHost() {
  const notices = useWorkspaceVcsNotices();
  const { confirm } = useConfirmDialog();
  const latest = latestNoticeState(notices);
  if (!latest) return null;

  return (
    <div
      data-testid="workspace-vcs-notice-host"
      data-placement="bottom-right"
      className="pointer-events-none fixed bottom-4 right-4 z-40 w-[min(440px,calc(100vw-2rem))]"
    >
      <div className="pointer-events-auto">
        <WorkspaceVcsNoticeView
          workspaceId={latest.workspaceId}
          workspaceLabel={latest.workspaceLabel}
          notice={latest.notice}
          variant="banner"
          requestConfirm={async (input) =>
            confirm({
              title: input.title,
              description: input.description,
              confirmText: input.confirmText,
              confirmVariant: 'destructive',
              // 逐条检出清单用富内容区渲染成 <ul>：确认框 description 是 <p>，塞不进块级列表，
              // 也不该把 12 种语言的项目行拼成一个长句（r4 P2：确认文案按 kind 生成 + 列范围）。
              content:
                input.lines && input.lines.length > 0 ? (
                  <ul className="mt-1 space-y-1 text-13 text-[var(--text-secondary)]">
                    {input.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : undefined,
              // 屏幕阅读器把清单读成确认正文的一部分。
              describeContent: true,
            })
          }
          onDismiss={() => {
            clearWorkspaceVcsNoticeState(latest.workspaceId);
          }}
        />
      </div>
    </div>
  );
}
