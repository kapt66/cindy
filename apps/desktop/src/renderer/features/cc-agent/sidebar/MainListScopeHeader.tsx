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
import { HEADER_HOVER_ACTION_CLASS, SidebarFoldAllButton } from './SidebarHeaderActions';
import type { ProjectNode as ProjectNodeData } from '../lib/projectGrouping';
import type { UseSidebarFilterReturn } from '../hooks/useSidebarFilter';

// 段头右侧动作区的 hover 显隐与折叠按钮走共用件 `./SidebarHeaderActions`(WL-3.3:
// 本段头与「Meka 助理」段头必须逐像素一致)。上游 origin/main 在 2026-11 把该规则又内联
// 回各 section 各写一份;Meka 侧继续保留单一实现(两份内容当时逐字相同),不回退成两套。
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
        <div className="flex items-center gap-0.5 -mt-px">
          {fold ? (
            // 折叠按钮与右侧设置入口同样只在 hover / focus / 菜单展开时出现
            // （上游 W28 用共享 hover 规则包住它；Meka 侧改用共用件 `SidebarFoldAllButton`，
            // 但**必须**保留同一层 hover 容器，否则该动作会常驻——`MainListScopeHeader.test` 钉住）。
            <div className={HEADER_HOVER_ACTION_CLASS}>
              <SidebarFoldAllButton
                label={fold.label}
                Icon={fold.Icon}
                onClick={fold.onClick}
                disabled={fold.disabled}
              />
            </div>
          ) : null}
          {/* 在看已归档任务时设置按钮常驻(带点),否则跟随段头 hover 出现。 */}
          <div className={filter.status === 'archived' ? undefined : HEADER_HOVER_ACTION_CLASS}>
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
    </div>
  );
}
