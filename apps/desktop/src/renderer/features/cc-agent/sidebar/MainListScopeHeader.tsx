/**
 * MainListScopeHeader — 主列表范围标题行。
 * ---------------------------------------------------------------------------
 * 范围标题必须恒在(2026-08-13 定稿 + 第 4 轮 review P1):空账户、只剩置顶、
 * 远程目录 / 任务全屏 loading/error、所选设备连接中,都不能把「全部任务 ▾」
 * 和两项设置入口摘掉。ProjectsSection 有内容时画完整段头(含折叠按钮);
 * 无内容或父级占位分支只画这一行。
 */
import { useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

import { MachineSwitcherMenu } from './MachineSwitcherMenu';
import { SidebarFilterPopover } from './SidebarFilterPopover';
import { HEADER_ACTIONS_CLASS, SidebarFoldAllButton } from './SidebarHeaderActions';
import type { ProjectNode as ProjectNodeData } from '../lib/projectGrouping';
import type { UseSidebarFilterReturn } from '../hooks/useSidebarFilter';

export function MainListScopeHeader({
  filter,
  allKnownProjects,
  dialogueCount = 0,
  hasRemoteDevices,
  fold = null,
}: {
  filter: UseSidebarFilterReturn;
  allKnownProjects: ProjectNodeData[];
  dialogueCount?: number;
  hasRemoteDevices: boolean;
  fold?: {
    label: string;
    Icon: LucideIcon;
    onClick: () => void;
    disabled: boolean;
  } | null;
}): ReactNode {
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState(false);
  return (
    <div className="group/sidebar-header flex h-6 items-center justify-between pr-0 pl-6">
      <div className="flex min-w-0 items-center gap-1">
        <MachineSwitcherMenu onOpenDisplaySettings={() => setDisplaySettingsOpen(true)} />
      </div>
      <div className="flex items-center gap-0.5 -mt-px">
        <div className={HEADER_ACTIONS_CLASS}>
          {fold ? (
            <SidebarFoldAllButton
              label={fold.label}
              Icon={fold.Icon}
              onClick={fold.onClick}
              disabled={fold.disabled}
            />
          ) : null}
          <SidebarFilterPopover
            filter={filter}
            allKnownProjects={allKnownProjects}
            dialogueCount={dialogueCount}
            hasRemoteDevices={hasRemoteDevices}
            open={displaySettingsOpen}
            onOpenChange={setDisplaySettingsOpen}
          />
        </div>
      </div>
    </div>
  );
}
