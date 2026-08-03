import type { TFunction } from 'i18next';

import type { MekaSkillMarketItem } from '../../../../shared/mekaSkillMarket';
import { formatMarketRelativeTime, type MarketSkill } from '../hooks/useMarketList';

/** Maps MCPRouter catalog records onto the unchanged Cindy Skill Hub card model. */
export function mapMekaSkillToMarketSkill(item: MekaSkillMarketItem, t: TFunction): MarketSkill {
  return {
    name: item.slug,
    displayName: item.name,
    description: item.description,
    authorName: t('mekaSkills.sourceMeka'),
    authorId: `meka:${item.id}`,
    authorAvatarUrl: null,
    avatarInitial: 'M',
    isMine: item.access === 'owner',
    latestVersion: item.currentRelease.version,
    visibility: item.scope === 'public' ? 'PUBLIC' : 'DEPARTMENT_SCOPED',
    publishedVisibility: item.scope === 'public' ? 'public' : 'shared',
    visibleDeptIds: [],
    categories: [],
    publishedAt: item.currentRelease.publishedAt,
    relativeTime: formatMarketRelativeTime(item.currentRelease.publishedAt, t),
    downloads: 0,
    installedLocally: item.installed,
    installedVersion: item.installed ? item.currentRelease.version : null,
    installedAbsolutePath: item.installedPath ?? null,
    hasAnyInstall: item.installed,
    latestPublishedFromDeviceId: null,
    cardState: item.updateAvailable
      ? 'installed-outdated'
      : item.installed
        ? 'installed-latest'
        : 'not-installed',
  };
}
