/**
 * 远程工作区会话行上的三件装饰：最前面的图标按钮、状态标签、占用锁。
 *
 * 产品口径（`docs/product-rules/psb-remote-workspace-sessions.md` §2.1）：
 *   - 图标按钮：用系统浏览器打开该会话所在工作区的 PSB 网页。地址由 PSB 下发、主进程按当前
 *     生效站点根纠正域名，**渲染层不拼站点路径**（本文件只传 workspaceId）；
 *   - 状态标签：在线 / 离线 / 使用中 / 准备中 / 失败 / 不支持 Agent。口径来自共享纯函数
 *     `psbWorkspaceHealth()` 的 `badgeKey` 与 `tone`，本文件只做翻译与上色；
 *   - 锁：`mine` = 自己占用（亮起）、`other` = 他人占用（暗态），Tip 显示占用人名字
 *     （自己占用时追加「（你）」；PSB 在 `byMe:true` 时也会回自己的名字）。锁是「人 vs 人」的
 *     独占反馈，不是「会话 vs 会话」，所以自己占用的工作区仍可再开一条会话。
 *
 * 颜色一律用语义 token（`--remote-status-ready` / `--warning-fg` / `--error-fg` /
 * `--text-tertiary`），Light 与 Dark 由主题各自解析，不允许写死色值。
 *
 * ## 横向节奏（2026-11-26，用户反馈「状态、锁、标题横向间隔不平均、挤压」）
 *
 * 图标按钮 / 状态标签 / 锁 / 标题之间统一按普通会话行的节奏排：
 *   - 状态标签 ↔ 锁：6px（`gap-1.5`，与普通行标题簇内部间距同档），本文件负责；
 *   - 图标按钮 → 状态标签、锁 → 标题：扁平列表（`SessionCard` list）是 `gap-0` 的标题条，
 *     缺的间距由**外层节点** `RemoteWorkspaceSection` 按 `sessionVariant` 补（见该文件
 *     `ROW_DECOR_LIST_SPACING_CLASS`）—— text 行由行自身 `gap-2.5` / `gap-1.5` 承担，不能
 *     在这里写死外边距，否则等于给两种显示形态各造一套节奏；
 *   - 垂直方向靠 flex `items-center` 对齐，锁（11px）与标签胶囊（16px）同一中轴。
 *
 * 放在 `features/remote-workspace/sidebar/` 而不是 `features/cc-agent/sidebar/`：
 * 三件装饰只在 `psb:` 会话上出现，由 `SessionItem` / `SessionCard` 按
 * `isRemoteWorkspaceSession()` 条件挂载 —— 普通行零开销，也不会把远程工作区的知识塞进
 * 通用行组件。
 */

import { useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ExternalLink, Lock } from 'lucide-react';

import { Tip } from '@/components/ui/tooltip';
import { useStableTranslation as useTranslation } from '@/hooks/useStableTranslation';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  psbWorkspaceHealth,
  type PsbRemoteWorkspace,
  type PsbWorkspaceTone,
} from '../../../../shared/psb-remote-workspace';
import { tryGetPsbRemoteBridge } from '../bridge';
import { formatWorkspaceOccupancy } from '../occupancyLabel';
import { psbFailureText } from '../psbFailureText';
import { remoteWorkspacePsbSessionId } from './isRemoteWorkspaceSession';
import type { RemoteWorkspaceSidebarSessionLike } from './remoteWorkspaceStatusStore';
import { useRemoteWorkspaceForSession } from './useRemoteWorkspaceSidebar';

const log = createLogger('RemoteWorkspaceRow');

/** 状态标签的文字色。四个 tone 各自一个已登记语义 token，双模式由主题解析。 */
const TONE_TEXT_CLASS: Record<PsbWorkspaceTone, string> = {
  ok: 'text-[var(--remote-status-ready)]',
  warn: 'text-[var(--warning-fg)]',
  bad: 'text-[var(--error-fg)]',
  idle: 'text-[var(--text-tertiary)]',
};

type RemoteWorkspaceRowSession = RemoteWorkspaceSidebarSessionLike;

/**
 * 行首图标按钮：在系统浏览器打开该会话所在工作区的 PSB 网页工作区页。
 *
 * 工作区 id 解析顺序（详见 `remoteWorkspaceStatusStore.ts` 文件头）：缓存里的显式绑定 /
 * 虚拟工作目录反查 → 兜底一次 `sessionStatus()`（**仅在用户点击时**发生，不是渲染期请求，
 * 不用逐行打 PSB）。
 *
 * `workspace` 由 `RemoteWorkspaceRowDecor` 一次解析后传入；单独使用本组件时才内部解析
 * （兼容旧调用点，FIX-F 迁移后应只用合并组件）。
 */
export function RemoteWorkspaceOpenButton({
  session,
  isActive,
  workspace: resolvedWorkspace,
}: {
  session: RemoteWorkspaceRowSession;
  isActive: boolean;
  workspace?: PsbRemoteWorkspace | null;
}) {
  const { t } = useTranslation();
  const storeWorkspace = useRemoteWorkspaceForSession(resolvedWorkspace === undefined ? session : null);
  const workspace = resolvedWorkspace === undefined ? storeWorkspace : resolvedWorkspace;
  const [opening, setOpening] = useState(false);
  const label = t('remoteWorkspace.session.openWorkspace');

  const handleClick = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (opening) return;
      const bridge = tryGetPsbRemoteBridge();
      if (!bridge) {
        toast.error(t('remoteWorkspace.error.unknown'));
        return;
      }
      setOpening(true);
      try {
        let workspaceId = workspace?.id ?? null;
        if (!workspaceId) {
          // 兜底：虚拟工作目录反查不到工作区时，用一次 sessionStatus 解析（用户显式动作，
          // 非渲染期请求）。结果只用于本次打开网页，不写缓存 —— 状态标签/锁仍由
          // `resolveRemoteWorkspaceForSession` 的虚拟目录反查决定。
          const psbSessionId = remoteWorkspacePsbSessionId(session);
          if (!psbSessionId) return;
          const status = await bridge.sessionStatus({ sessionId: psbSessionId });
          workspaceId = status.workspace.id;
        }
        await bridge.openWebWorkspace({ workspaceId });
      } catch (error) {
        log.warn('open psb workspace in browser failed', error);
        // 2026-11-26 真机事故：这里旧实现写死 `remoteWorkspace.error.unknown`，用户点两下行首
        // 图标就只会看到两条「操作失败，请稍后重试。」。失败码（工作区已删 / PSB 不可达 / 未
        // 登录）必须映射成可行动文案（`psbFailureText` 是渲染层唯一出口）。
        toast.error(psbFailureText(t, error));
      } finally {
        setOpening(false);
      }
    },
    [opening, session, t, workspace?.id],
  );

  return (
    <Tip text={label}>
      <button
        type="button"
        aria-label={label}
        aria-busy={opening || undefined}
        data-remote-workspace-open={workspace?.id ?? ''}
        onClick={(event) => void handleClick(event)}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        className={cn(
          // 尺寸与同目录既有行内图标钮同为 size-5 / icon 14；圆角按 DESIGN §5 的
          // control tier 取 pill(rounded-full)，不沿用旧行的 rounded-md(6px 不在 §5 清单内)。
          // 本钮常显（它是远程工作区行的第一个身份动作），不走 hover 才出现。
          'flex size-5 shrink-0 items-center justify-center rounded-full',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          isActive
            ? 'text-sidebar-item-active-foreground hover:bg-[color-mix(in_srgb,var(--sidebar-item-active-foreground)_14%,transparent)]'
            : 'text-sidebar-action-icon hover:bg-sidebar-item-hover hover:text-foreground',
          opening && 'opacity-60',
        )}
      >
        <ExternalLink size={14} strokeWidth={2} />
      </button>
    </Tip>
  );
}

/**
 * 状态标签 + 锁。工作区状态未解析出来时不渲染任何东西 —— 宁可暂时没有标签，也不能把
 * 「在线 / 使用中」贴到错的工作区上。
 *
 * `workspace` 由 `RemoteWorkspaceRowDecor` 一次解析后传入（同一次渲染只解析一次）。
 */
export function RemoteWorkspaceStatusBadges({
  session,
  workspace: resolvedWorkspace,
}: {
  session: RemoteWorkspaceRowSession;
  workspace?: PsbRemoteWorkspace | null;
}) {
  const { t } = useTranslation();
  const storeWorkspace = useRemoteWorkspaceForSession(
    resolvedWorkspace === undefined ? session : null,
  );
  const workspace = resolvedWorkspace === undefined ? storeWorkspace : resolvedWorkspace;
  if (!workspace) return null;
  const health = psbWorkspaceHealth(workspace);
  // 锁的 Tip 与页头占用文案共用同一格式函数（2026-11-26）：有名字显示名字，自己占用追加「（你）」。
  const lockLabel = health.lock === 'none' ? null : formatWorkspaceOccupancy(workspace.occupancy, t);
  return (
    // 状态标签与锁是同一组「这条能不能用」信号：簇内 gap 取普通会话行标题簇的 6px
    // （`text-<n>` 行内 `gap-1.5`），不再用更紧的 4px —— 与标题之间的距离由各变体的
    // 行布局决定（list 行在 `RemoteWorkspaceSection` 补，text 行自带 `gap-1.5`）。
    <span className="flex shrink-0 items-center gap-1.5" data-remote-workspace-status="">
      <span
        // tone 是给测试与联调的可观察口径（`ok` / `warn` / `bad` / `idle`），颜色仍走 token。
        data-badge-tone={health.tone}
        className={cn(
          // 行高用无单位比例而非 `leading-[14px]`：字号走 `text-10` 会随「外观 → UI 字号」
          // 缩放，固定 px 行框不跟随会让徽标大字时被裁切（DESIGN §3 行高例外）。
          // 14 ÷ 10 = 1.4，默认字号下渲染与原 14px 逐像素一致。
          'rounded-full border px-1.5 text-10 font-medium leading-[1.4] whitespace-nowrap',
          'border-[color-mix(in_srgb,currentColor_35%,transparent)]',
          TONE_TEXT_CLASS[health.tone],
        )}
      >
        {t(health.badgeKey)}
      </span>
      {lockLabel ? (
        <Tip text={lockLabel}>
          <span
            role="img"
            aria-label={lockLabel}
            data-lock-state={health.lock}
            className={cn(
              'inline-flex items-center',
              health.lock === 'mine'
                ? 'text-[var(--remote-status-ready)]'
                : 'text-[var(--text-tertiary)]',
            )}
          >
            <Lock size={11} strokeWidth={2} aria-hidden />
          </span>
        </Tip>
      ) : null}
    </span>
  );
}

/**
 * 会话行上「外链按钮 + 状态标签/锁」的**合并入口**（2026-11-26 审查：一次解析传给两个装饰）。
 *
 * 两个装饰都需要「这条会话属于哪个工作区」：旧调用点分别挂 `RemoteWorkspaceOpenButton` 与
 * `RemoteWorkspaceStatusBadges`，同一行同一次渲染解析两遍。这里解析一次，把结果当 prop 传下去。
 *
 * 调用点（`SessionItem` / `SessionCard`，FIX-F 负责迁移）应只挂这一个组件。
 */
export function RemoteWorkspaceRowDecor({
  session,
  isActive,
}: {
  session: RemoteWorkspaceRowSession;
  isActive: boolean;
}) {
  const workspace = useRemoteWorkspaceForSession(session);
  return (
    <>
      <RemoteWorkspaceOpenButton session={session} isActive={isActive} workspace={workspace} />
      <RemoteWorkspaceStatusBadges session={session} workspace={workspace} />
    </>
  );
}
