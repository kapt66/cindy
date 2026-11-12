import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const aboutSettings = defineSettings({
  about: {
    id: 'about',
    tab: 'about',
    targetId: 'settings-panel-about',
    titleKey: TAB_LABEL_KEY['about'],
    sectionKey: 'settings.sections.about',
  },
  appVersionLabel: {
    id: 'settings.about.appVersionLabel',
    isVisible: ({ region }) => region === 'cn',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-appVersionLabel',
    titleKey: 'settings.about.appVersionLabel',
    sectionKey: 'settings.tabs.about',
  },
  autoUpdateLabel: {
    id: 'settings.about.autoUpdateLabel',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-autoUpdateLabel',
    titleKey: 'settings.about.autoUpdateLabel',
    descriptionKey: 'settings.about.autoUpdateDescription',
    descriptionKeyForContext: ({ platform }) => platform === 'linux'
      ? 'settings.about.linuxUpdateDescription' : undefined,
    aliases: ['自动更新', '自动升级', 'auto update'],
    sectionKey: 'settings.tabs.about',
  },
  analyticsLabel: {
    id: 'settings.about.analyticsLabel',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-analyticsLabel',
    titleKey: 'settings.about.analyticsLabel',
    sectionKey: 'settings.tabs.about',
    descriptionKey: 'settings.about.analyticsDescription',
  },
  debugLogLabel: {
    id: 'settings.about.debugLogLabel',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-debugLogLabel',
    titleKey: 'settings.about.debugLogLabel',
    sectionKey: 'settings.tabs.about',
    descriptionKey: 'settings.about.debugLogDescription',
  },
  logsDirLabel: {
    id: 'settings.about.logsDirLabel',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-logsDirLabel',
    titleKey: 'settings.about.logsDirLabel',
    sectionKey: 'settings.tabs.about',
  },
  logUploadCrashAutoLabel: {
    id: 'settings.about.logUpload.crashAutoLabel',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-logUpload-crashAutoLabel',
    titleKey: 'settings.about.logUpload.crashAutoLabel',
    sectionKey: 'settings.tabs.about',
  },
  logUploadUploadLabel: {
    id: 'settings.about.logUpload.uploadLabel',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-logUpload-uploadLabel',
    titleKey: 'settings.about.logUpload.uploadLabel',
    sectionKey: 'settings.tabs.about',
  },
});

export default {
  id: 'about',
  order: 16,
  // 单一来源：搜索项与 `aboutSettings` 同一份定义（上游 W28 起不再手写一份平行数组）。
  // **Meka divergence（WL-26）**：Meka 不提供客户端日志上报面（无「崩溃自动上传」开关、
  // 无「上传日志」入口），这两条搜索项必须排除 —— 否则搜索会命中一个界面上不存在的
  // 行，`targetId` 永远解析不到。恢复上报面时同步删掉这个 filter。
  entries: Object.values(aboutSettings).filter(
    (entry) =>
      entry.id !== 'settings.about.logUpload.crashAutoLabel' &&
      entry.id !== 'settings.about.logUpload.uploadLabel',
  ),
} satisfies SettingsSearchModule;
