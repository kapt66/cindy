/**
 * SidebarHeaderActions — 段头右侧动作区的共用件。
 * ---------------------------------------------------------------------------
 * 「全部任务」段头(MainListScopeHeader)与「Meka 助理」段头(MekaAssistantSection)
 * 共用同一份 hover 显隐规则、同一个折叠按钮:两处必须逐像素一致,否则同一排动作
 * 在两个段头里会显出两套视觉(2026-09-15 用户裁决:Meka 段头右侧与「全部任务」对齐,
 * 含「收起所有分组」与「侧边栏显示设置」)。
 *
 * hover 显隐必须同时留三条口子,缺一条就有用户点不到:
 *   - 鼠标悬停段头行(`group/sidebar-header`);
 *   - 键盘 focus-visible(指针点击产生的 focus 不算——鼠标移开后不该被钉住);
 *   - 段头内任一菜单展开时(trigger 带 `data-state=open`):鼠标移进展开的菜单、
 *     段头不再 hover,其余按钮不该消失。
 * 所以使用方段头容器必须带 `group/sidebar-header`,这些规则才会生效。
 */

import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';

export const HEADER_HOVER_ACTION_CLASS = cn(
  'pointer-events-none opacity-0 transition-opacity duration-150',
  'group-hover/sidebar-header:pointer-events-auto group-hover/sidebar-header:opacity-100',
  // Pointer click focus must not pin these hover-only actions after the mouse leaves.
  // Keyboard focus-visible still reveals them for tab navigation.
  'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
  // 段头内任一菜单(范围下拉 / 侧边栏显示设置)展开时(其 trigger 带 data-state=open),
  // 整排 action 保持可见——鼠标移进展开的菜单、段头不再 hover 时,其它按钮不该消失。
  'group-has-[[data-state=open]]/sidebar-header:pointer-events-auto group-has-[[data-state=open]]/sidebar-header:opacity-100',
);

export const HEADER_ACTIONS_CLASS = cn('flex items-center gap-0.5 -mt-px', HEADER_HOVER_ACTION_CLASS);

/**
 * 段头「收起所有分组 / 展开所有分组」按钮(侧边栏重设计 §6)。
 * 作用域由调用方决定:「全部任务」段头收的是主列表分组层(项目行 / 设备段 /
 * 自动任务组 / 对话组),「Meka 助理」段头收的是 Meka 自己的项目分组。
 */
export function SidebarFoldAllButton({
  label,
  Icon,
  onClick,
  disabled = false,
}: {
  /** 也用作 aria-label:文案如实描述**下一步动作**(收起 / 展开)。 */
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tip text={label} side="bottom">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-md',
          'text-[var(--sidebar-list-muted)]',
          'transition-colors hover:text-[var(--sidebar-nav-text)]',
          'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
        )}
      >
        <Icon size={14} strokeWidth={2} />
      </button>
    </Tip>
  );
}
