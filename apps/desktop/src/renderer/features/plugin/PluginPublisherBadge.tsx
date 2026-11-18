import { BadgeCheck, Building2, Folder, Lock, Monitor, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PluginMarketItem } from '../../../shared/pluginMarket';
import type { PluginPresentationOrigin } from './lib/pluginMarketPresentation';

type PluginPublisherProps = {
  kind?: PluginMarketItem['publisherKind'];
  origin?: PluginPresentationOrigin;
};

function publisherIdentity({ kind, origin }: PluginPublisherProps) {
  return origin === 'organization' ? 'team'
    : origin === 'custom' ? 'custom'
      // Meka 渠道的个人发布：MCPRouter 的 private/shared 都被投影成 personal，中性标识。
      : origin === 'personal-meka' ? 'personal-meka'
        : origin === 'local' ? 'local'
          : kind === 'official' ? 'official'
            : origin === 'public' && kind === 'personal' ? 'community' : null;
}

/** Display provenance only; package trust and runtime privileges remain separate. */
export function PluginPublisherBadge(props: PluginPublisherProps) {
  const { t } = useTranslation();
  const identity = publisherIdentity(props);
  if (!identity) return null;
  const Icon = {
    official: BadgeCheck,
    community: Users,
    team: Building2,
    custom: Folder,
    local: Monitor,
    'personal-meka': Lock,
  }[identity];
  const label = identity === 'official' || identity === 'community'
    ? t(`settings.ghosts.market.publisherKind.${identity}`)
    : t(`settings.ghosts.page.origin.${identity === 'team' ? 'organization' : identity}`);
  // Meka 渠道的个人发布没有专属 design token：与 local 共用中性 chip 底色，双模式自动适配。
  const neutral = identity === 'local' || identity === 'personal-meka';
  return (
    <span
      title={t(`settings.ghosts.market.publisherDescription.${identity}`)}
      // design: intrinsic-geometry — owner-approved provenance mark, DESIGN §10: 20px high with 5px corners.
      className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 text-11 font-medium leading-none"
      style={{ color: neutral ? 'var(--text-secondary)' : `var(--plugin-identity-${identity}-text)`,
        backgroundColor: neutral ? 'var(--surface-chip)' : `var(--plugin-identity-${identity}-bg)` }}
    >
      <Icon size={12} strokeWidth={2} aria-hidden="true" />
      {label}
    </span>
  );
}

export function PluginPublisherDescription(props: PluginPublisherProps) {
  const { t } = useTranslation();
  const identity = publisherIdentity(props);
  return identity ? <p className="mt-3 text-12 leading-5 text-[var(--text-tertiary)]">
    {t(`settings.ghosts.market.publisherDescription.${identity}`)}
  </p> : null;
}
