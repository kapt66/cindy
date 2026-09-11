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
    // MCPRouter 的 access='owner' 就是本账号对该技能资源的写权限(改访问范围/发新版本/
    // 停止分发)。Meka 渠道不引入上游团队/部门/组织角色,不存在「看得见但只是 viewer」
    // 的第三方技能,因此 owner 与可管理同真同假——与 MekaSkillMarketListView /
    // MekaSkillHomeView 里「access !== 'owner' 则不打开管理弹窗」的门禁同一口径。
    canManage: item.access === 'owner',
    latestVersion: item.currentRelease.version,
    visibility: item.scope === 'public' ? 'PUBLIC' : 'DEPARTMENT_SCOPED',
    publishedVisibility: item.scope === 'public' ? 'public' : 'shared',
    visibleDeptIds: [],
    categories: [],
    // MCPRouter 技能目录(schemaVersion 1)没有标签维度,也没有公开仓库地址字段:
    // main/meka-skills/api.ts 只映射 id/slug/name/description/scope/access/currentRelease,
    // 所以这里给空标签与 null,表示「该渠道未提供」而不是未知占位。
    tags: [],
    githubUrl: null,
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
