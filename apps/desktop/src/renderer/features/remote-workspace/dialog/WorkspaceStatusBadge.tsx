/**
 * 工作区状态徽标（弹窗行 / 草稿页分拉行共用一份材质与 tone 映射）。
 *
 * 口径来自共享纯函数 `psbWorkspaceHealth()` 的 `badgeKey` / `tone`：本组件只翻译与上色，
 * **不自己判断「在线 / 使用中」**。颜色一律走语义 token（Light/Dark 由主题解析）。
 *
 * 徽标是「占用 / 在线 / 离线 / 准备中 / 失败 / 不支持 Agent」的**短标签**；说明性长句
 * （「正被谁占用、下一步做什么」）只进 `title` tooltip，不在行里重复渲染。
 */

import { cn } from '@/lib/utils';

import type { PsbWorkspaceTone } from '../../../../shared/psb-remote-workspace';

/** tone → 文字色（四个 tone 各自一个已登记语义 token）。 */
const TONE_TEXT_CLASS: Record<PsbWorkspaceTone, string> = {
  ok: 'text-[var(--remote-status-ready)]',
  warn: 'text-[var(--warning-fg)]',
  bad: 'text-[var(--error-fg)]',
  idle: 'text-[var(--text-tertiary)]',
};

export interface WorkspaceStatusBadgeProps {
  readonly tone: PsbWorkspaceTone;
  /** 已本地化的短标签（`t(health.badgeKey)`）。 */
  readonly label: string;
  /** 可行动说明（占用时带人名）；没有额外信息时不传。 */
  readonly title?: string | null;
  /** 测试 / 联调可观察口径（`ok` / `warn` / `bad` / `idle`）。 */
  readonly dataBadgeTone?: boolean;
  readonly className?: string;
}

export function WorkspaceStatusBadge({
  tone,
  label,
  title,
  dataBadgeTone = true,
  className,
}: WorkspaceStatusBadgeProps) {
  return (
    <span
      title={title ?? undefined}
      data-badge-tone={dataBadgeTone ? tone : undefined}
      className={cn(
        // 行高用无单位比例而非固定 px：字号会随「外观 → UI 字号」缩放，固定行框会裁切。
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-1.5 text-10 font-medium leading-[1.4]',
        'border-[color-mix(in_srgb,currentColor_35%,transparent)]',
        TONE_TEXT_CLASS[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}
