/**
 * 会话页标题行里的「远程工作区」文字按钮。
 *
 * 位置（用户 2026-11-26 口径）：**会话标题行内、标题后的「…」菜单之后** ——
 * 即 `[图标][标题][…][远程工作区]` 同一行（见 `features/cc-agent/SessionContentHeader.tsx`），
 * 不再挂在窗口右上角的 `ContentHeader.trailing` 里。按钮 `shrink-0`，标题过长时由标题自己
 * 截断，不挤压按钮、也不改变标题行高度。
 *
 * - **只在 `psb:` 会话出现**：本地会话、`mcpr:`、SSH host 没有远程工作区（判据
 *   `../stream/psbStreamSession.ts`）；判断不出是哪条会话时渲染 `null`，不猜。
 * - 形态：文字按钮（28px 高、共享 `Button` 的 `sm` + `quiet` 面），带图标便于在标题行里认出，
 *   点按区域 ≥28px。可见文字就是无障碍名字，按 DESIGN §14.6 不重复挂 `Tip`。
 * - 点击 = 打开（或聚焦）右侧栏插件页签那一排里的「远程工作区」全局页签，不自动开始串流。
 *
 * 标题行是窗口拖拽区，按钮必须自挖 `no-drag`，否则点击会被 Electron 当成拖窗吞掉。
 */

import { MonitorCog } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { openRemoteWorkspaceAdminTab } from './remoteWorkspaceAdminTab';
import { shouldShowRemoteWorkspaceAdminEntry } from '../stream/psbStreamSession';

export function RemoteWorkspaceAdminButton({
  sessionId,
  remoteHostId,
  className,
}: {
  /** 当前打开的会话 id（没有打开会话时为 null / undefined）。 */
  sessionId: string | null | undefined;
  /** 该会话的远端身份；只有 `psb:` 才渲染。 */
  remoteHostId: string | null | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!shouldShowRemoteWorkspaceAdminEntry({ sessionId, remoteHostId })) return null;

  return (
    <Button
      type="button"
      data-testid="remote-workspace-admin-button"
      size="sm"
      compact
      variant="secondary"
      tone="quiet"
      className={cn('shrink-0 gap-1.5', className)}
      style={WINDOW_NO_DRAG_STYLE}
      onClick={() => openRemoteWorkspaceAdminTab({ sessionId })}
    >
      <MonitorCog size={13} aria-hidden />
      {t('remoteWorkspace.admin.title')}
    </Button>
  );
}
