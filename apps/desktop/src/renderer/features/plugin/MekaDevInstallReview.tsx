/**
 * Meka 开发模式装载确认框的内容区(docs/product-rules/meka-skills.md)。
 *
 * 上游 D3 之后,市场/文件安装不再在客户端做权限二次确认,
 * `cindy-brain/GhostPermissionList.tsx` 整文件随之上移删除。开发模式装载是
 * Meka 独有入口(上游没有 `mekaDevPlugins`):它监控并长期信任一个源码目录,
 * 目录随时可被改写,所以装载前仍要把这个目录将获得的能力逐项摆出来。
 *
 * 因此这里保留那份能力展示的最小实现(来源/信任摘要 + 逐项权限清单),但以
 * Meka 自己的组件名与文件承载,不复用已删除的上游确认框组件。数据仍取自
 * `shared/ghost.ts` 的 `ghostPermissionItems`(纯展示投影,不是安全判据)。
 */
import {
  AppWindow,
  BadgeCheck,
  Bell,
  BellDot,
  BookOpen,
  Bot,
  ChevronDown,
  Cpu,
  FileCode2,
  FilePen,
  FolderOpen,
  FolderPlus,
  Globe,
  GraduationCap,
  KeyRound,
  LayoutTemplate,
  Library,
  MapPin,
  Megaphone,
  MessageCircleQuestion,
  Network,
  PanelLeft,
  PanelRight,
  ShieldAlert,
  Smartphone,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import type { GhostPermissionItem, GhostTrustInfo } from '../../../shared/ghost';

const KIND_ICON: Record<GhostPermissionItem['kind'], LucideIcon> = {
  cindy: Sparkles,
  agent: Bot,
  node: Cpu,
  tool: Wrench,
  command: Terminal,
  panel: PanelRight,
  'main-view': PanelLeft,
  code: FileCode2,
  subscribe: Bell,
  card: LayoutTemplate,
  network: Globe,
  notify: Megaphone,
  confirm: MessageCircleQuestion,
  fs: FilePen,
  library: Library,
  'session-context': MapPin,
  pick: FolderOpen,
  preview: AppWindow,
  skill: GraduationCap,
  reveal: FolderOpen,
  workspace: FolderPlus,
  'ios-simulator': Smartphone,
  mcpr: Network,
};

function itemIcon(item: GhostPermissionItem): LucideIcon {
  if (item.labelKey === 'panelLeft') return PanelLeft;
  // 未读角标与一次性提示同属 notify kind,但一个是常驻注意力入口、一个是弹完就走,
  // 同时出现时同图标读起来像重复项,给角标换一枚带点的铃铛以示区分。
  if (item.labelKey === 'badge') return BellDot;
  // 凭证类条目换钥匙图标,与域名条目区分:一个是"去哪",一个是"带什么"。
  if (
    item.labelKey === 'networkSecret' ||
    item.labelKey === 'networkSecretOauth' ||
    item.labelKey === 'networkSecretGhCli' ||
    item.labelKey === 'networkSecretOrganizationIdentity' ||
    item.labelKey === 'nodeSecret'
  )
    return KeyRound;
  return KIND_ICON[item.kind];
}

function DevPermRow({ item }: { item: GhostPermissionItem }) {
  const { t } = useTranslation();
  const Icon = itemIcon(item);
  // 主机固定说明(detailKey)与作者自由文本(detail)可以并存,都在时两行都渲染。
  const hostDetail = item.detailKey
    ? t(`settings.ghosts.perm.${item.detailKey}`, item.detailArgs)
    : undefined;
  const authorDetail = item.detail;
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="mt-[2px] shrink-0 text-[var(--text-tertiary)]">
        <Icon size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="break-words text-13 leading-[1.5] text-[var(--confirm-desc)]">
          {t(`settings.ghosts.perm.${item.labelKey}`, item.labelArgs)}
        </div>
        {hostDetail && (
          <div className="break-words text-12 leading-[1.5] text-[var(--text-tertiary)]">
            {hostDetail}
          </div>
        )}
        {authorDetail && (
          <div className="whitespace-pre-line break-words text-12 leading-[1.5] text-[var(--text-tertiary)]">
            {authorDetail}
          </div>
        )}
      </div>
    </div>
  );
}

/** 逐项权限清单。工具说明常是整段接口文档,默认折叠只报数量。 */
function DevPermissionList({ items }: { items: GhostPermissionItem[] }) {
  const { t } = useTranslation();
  const [toolsExpanded, setToolsExpanded] = useState(false);
  if (items.length === 0) return null;
  const toolItems = items.filter((item) => item.kind === 'tool');
  const otherItems = items.filter((item) => item.kind !== 'tool');

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3 text-12 font-medium text-[var(--text-tertiary)]">
        <span>{t('settings.ghosts.perm.grantsTitle')}</span>
        <span>{t('settings.ghosts.perm.itemCount', { count: items.length })}</span>
      </div>
      {otherItems.map((item) => (
        <DevPermRow key={item.key} item={item} />
      ))}
      {toolItems.length > 0 && (
        <div className="my-1 rounded-xl border border-[var(--border-default)]">
          <button
            type="button"
            aria-expanded={toolsExpanded}
            onClick={() => setToolsExpanded((value) => !value)}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-13 text-[var(--confirm-desc)]"
          >
            <Wrench size={14} className="shrink-0 text-[var(--text-tertiary)]" />
            <span className="flex-1">{t('settings.ghosts.perm.toolsGroup')}</span>
            <span className="rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 text-[var(--text-secondary)]">
              {t('settings.ghosts.perm.itemCount', { count: toolItems.length })}
            </span>
            <ChevronDown
              size={14}
              className={cn(
                'shrink-0 text-[var(--text-tertiary)] transition-transform',
                toolsExpanded && 'rotate-180',
              )}
            />
          </button>
          {toolsExpanded && (
            <div className="border-t border-[var(--border-default)] px-3 py-2">
              {toolItems.map((item) => (
                <DevPermRow key={item.key} item={item} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 主机验出的包来源/签名摘要;不读取作者可伪造的 ghost.json 文案。 */
function DevTrustSummary({ trust }: { trust: GhostTrustInfo }) {
  const { t } = useTranslation();
  const trusted = trust.level !== 'unverified';
  const Icon = trusted ? BadgeCheck : ShieldAlert;
  const labelKey =
    trust.level === 'cindy-official'
      ? 'official'
      : trust.level === 'reviewed'
        ? 'reviewed'
        : trust.level === 'verified-publisher'
          ? 'verifiedPublisher'
          : trust.publisherSigned
            ? 'signedUnverified'
            : 'unsigned';
  return (
    <div className="mt-3 flex items-start gap-2 rounded-xl border border-[var(--border-default)] p-3">
      <Icon size={16} className="mt-0.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
      <div className="min-w-0">
        <p className="break-words text-13 font-medium leading-5 text-[var(--confirm-desc)]">
          {t(`settings.ghosts.trust.${labelKey}`, {
            publisher: trust.publisherName ?? t('settings.ghosts.trust.unknownPublisher'),
          })}
        </p>
        <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">
          {t(
            trust.unknownReviewer
              ? 'settings.ghosts.trust.unknownReviewerDetail'
              : `settings.ghosts.trust.${labelKey}Detail`,
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * 开发模式装载确认的内容区:简介可折叠,来源目录单列,随后是信任摘要与逐项权限。
 * 限高与滚动交给共享 ConfirmDialog,这里不自带滚动容器。
 */
export function MekaDevInstallReview({
  description,
  meta,
  trust,
  items,
  manualCount = 0,
}: {
  description?: string;
  meta: string;
  trust: GhostTrustInfo;
  items: GhostPermissionItem[];
  manualCount?: number;
}) {
  const { t } = useTranslation();
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const canCollapseDescription = Boolean(
    description && (description.length > 160 || description.includes('\n')),
  );

  return (
    <div>
      {description && (
        <div>
          <p
            className={cn(
              'whitespace-pre-line break-words text-13 leading-[1.55] text-[var(--confirm-desc)]',
              canCollapseDescription && !descriptionExpanded && 'line-clamp-3',
            )}
          >
            {description}
          </p>
          {canCollapseDescription && (
            <button
              type="button"
              aria-expanded={descriptionExpanded}
              onClick={() => setDescriptionExpanded((value) => !value)}
              className="mt-1 rounded-full text-12 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              {t(
                descriptionExpanded
                  ? 'settings.ghosts.installConfirm.collapseDescription'
                  : 'settings.ghosts.installConfirm.expandDescription',
              )}
            </button>
          )}
        </div>
      )}
      <p className={cn('text-12 leading-[1.5] text-[var(--text-tertiary)]', description && 'mt-2')}>
        {meta}
      </p>
      <DevTrustSummary trust={trust} />
      {manualCount > 0 && (
        <div className="mt-3 flex items-center gap-2 text-12 leading-[1.5] text-[var(--text-tertiary)]">
          <BookOpen size={14} className="shrink-0" aria-hidden="true" />
          <span>{t('settings.ghosts.installConfirm.manualCount', { count: manualCount })}</span>
        </div>
      )}
      <div className="mt-3 border-t border-[var(--border-default)] pt-3">
        <DevPermissionList items={items} />
      </div>
    </div>
  );
}
