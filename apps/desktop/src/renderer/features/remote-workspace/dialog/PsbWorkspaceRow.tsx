/**
 * 工作区选择行（弹窗「选择工作区」与草稿页项目胶囊下拉**共用一份实现**）。
 *
 * 2026-11-26 独立审查：两个入口原来各写一份逐行同构的行 UI（标题 / 次要行 / 原因长句 /
 * 徽标 / 锁 / 选中勾），导致材质、间距与可用性表达各自漂移。现在：
 *
 * - **一行只表达一次占用**：状态徽标给短标签（`使用中` / `在线`…），占用人名与下一步只进
 *   行 tooltip；`mine` 仍显示亮锁（「我持有这把锁」是徽标没说的信息），`other` **不再**重复
 *   挂锁 —— 徽标已经是占用态。
 * - **材质统一**：边框 + `--surface-hover` / `--accent-emphasis` 选中态，圆角按 DESIGN §5
 *   的 inner-control 档（8px，下拉行高亮同档）；不再用 folder 专属 token 造第二套材质。
 * - **忙不丢焦点**：不可用行用原生 `disabled`（Tab 跳过）；容器在途忙时改用 `aria-disabled`
 *   （仍可聚焦），开始占用的那一行不会因为属性变成 disabled 把焦点丢回 body。
 *
 * 行本身不解析工作区状态以外的数据：`health` 与消歧后的 `labels` 由容器一次算好传入。
 */

import { Check, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

import type { PsbRemoteWorkspace, PsbWorkspaceHealth } from '../../../../shared/psb-remote-workspace';
import { formatWorkspaceOccupancy } from '../occupancyLabel';
import {
  psbWorkspaceUnavailableReason,
  type PsbWorkspaceRowLabels,
} from './psbWorkspaceDisplay';
import { WorkspaceStatusBadge } from './WorkspaceStatusBadge';

const ROW_CLASS = cn(
  'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors outline-none',
  'border-[var(--border-default)]',
  'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
  'disabled:cursor-not-allowed disabled:opacity-60',
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-60',
  'enabled:hover:bg-[var(--surface-hover)]',
);
const ROW_SELECTED_CLASS = 'border-[var(--accent-emphasis)] bg-[var(--surface-hover)]';

/** 键盘 / ARIA props 由 `usePsbWorkspaceListKeyboard` 的 `getItemProps` 原样展开。 */
export interface PsbWorkspaceRowKeyboardProps {
  readonly role: 'radio' | 'option';
  readonly tabIndex: number;
  readonly 'aria-checked'?: boolean;
  readonly 'aria-selected'?: boolean;
  readonly ref: (element: HTMLButtonElement | null) => void;
  readonly onFocus: () => void;
}

export interface PsbWorkspaceRowProps {
  readonly workspace: PsbRemoteWorkspace;
  readonly health: PsbWorkspaceHealth;
  /** 同列表消歧后的主标题与次要行（`psbWorkspaceRowLabels`）。 */
  readonly labels: PsbWorkspaceRowLabels;
  readonly selected: boolean;
  /** 这一行正在执行占用（显示 spinner、禁止重复激活）。 */
  readonly occupying: boolean;
  /** 容器整体在途忙（弹窗占用中）：用 `aria-disabled` 而非 `disabled` 保焦点。 */
  readonly busy: boolean;
  /** 外部锁（草稿发送中 / 目录恢复中）：与不可用行一样是原生 disabled（不可交互、Tab 跳过）。 */
  readonly disabled?: boolean;
  readonly testId: string;
  readonly keyboardProps: PsbWorkspaceRowKeyboardProps;
  readonly onActivate: () => void;
}

export function PsbWorkspaceRow({
  workspace,
  health,
  labels,
  selected,
  occupying,
  busy,
  disabled = false,
  testId,
  keyboardProps,
  onActivate,
}: PsbWorkspaceRowProps) {
  const { t } = useTranslation();
  const unavailable = !health.canStartSession;
  const rowDisabled = unavailable || disabled;
  // 可行动说明只给占用态（人名 + 下一步）；离线 / 准备中 / 失败的徽标已经是完整短句，
  // 再挂一条同名 tooltip 等于把同一句话写两遍。
  const hoverHint =
    health.lock === 'other'
      ? psbWorkspaceUnavailableReason(workspace, health, t)
      : null;
  const lockLabel =
    health.lock === 'mine' ? formatWorkspaceOccupancy(workspace.occupancy, t) : null;

  return (
    <button
      {...keyboardProps}
      type="button"
      data-testid={testId}
      data-selected={selected ? 'true' : undefined}
      data-available={health.canStartSession ? 'true' : 'false'}
      data-lock-state={health.lock}
      data-occupying={occupying ? 'true' : undefined}
      title={hoverHint ?? undefined}
      disabled={rowDisabled}
      aria-disabled={rowDisabled || busy || occupying ? true : undefined}
      onClick={() => {
        if (rowDisabled || busy || occupying) return;
        onActivate();
      }}
      className={cn(ROW_CLASS, selected && ROW_SELECTED_CLASS)}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {occupying ? (
          <Spinner size={14} />
        ) : selected ? (
          <Check size={14} className="text-[var(--accent-emphasis)]" aria-hidden />
        ) : null}
      </span>
      {/* 主标题占满可用宽度（完整显示，必要时 truncate）；徽标与锁固定在最右槽。 */}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className="w-full truncate text-13 font-medium text-[var(--text-primary)]"
          title={workspace.id}
        >
          {labels.name}
        </span>
        {labels.secondary ? (
          <span className="w-full truncate text-12 text-[var(--text-secondary)]" title={labels.secondary}>
            {labels.secondary}
          </span>
        ) : null}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <WorkspaceStatusBadge tone={health.tone} label={t(health.badgeKey)} />
        {lockLabel ? (
          <span
            title={lockLabel}
            aria-label={lockLabel}
            className="inline-flex shrink-0 text-[var(--accent-emphasis)]"
          >
            <Lock size={12} aria-hidden />
          </span>
        ) : null}
      </span>
    </button>
  );
}
