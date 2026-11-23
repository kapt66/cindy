import {
  defineSettings,
  type SettingsSearchModule,
} from './settingsSearchTypes';

/**
 * Static search metadata owned by this settings module; no component mounting or IPC.
 *
 * The Meka assistant tab declares its own catalog entries so it stays inside the upstream
 * per-tab completeness guard (`TAB_IDS` × `TAB_LABEL_KEY`) while its three cards
 * (P4 root, MCPRouter, MekaDesign) remain individually searchable.
 *
 * `keywordKeys` carry the confirmation-dialog copy and sub-card headings that belong to the
 * same setting, so those strings stay searchable even though they are not the row title.
 */
export const mekaAssistantSettings = defineSettings({
  tab: {
    id: 'mekaAssistant',
    tab: 'meka-assistant',
    targetId: 'settings-panel-meka-assistant',
    titleKey: 'settings.tabs.mekaAssistant',
    sectionKey: 'settings.tabs.mekaAssistant',
  },
  p4: {
    id: 'settings.meka.p4.title',
    fallbackTargetId: 'settings-panel-meka-assistant',
    tab: 'meka-assistant',
    targetId: 'settings-search-target-meka-assistant-p4',
    titleKey: 'settings.meka.p4.title',
    sectionKey: 'settings.tabs.mekaAssistant',
    descriptionKey: 'settings.meka.p4.description',
    keywordKeys: ['settings.meka.p4.matchedTitle'],
    aliases: ['p4', 'saga2', '功能路径', '项目根'],
  },
  router: {
    id: 'settings.meka.router.title',
    fallbackTargetId: 'settings-panel-meka-assistant',
    tab: 'meka-assistant',
    targetId: 'settings-search-target-meka-assistant-router',
    titleKey: 'settings.meka.router.title',
    sectionKey: 'settings.tabs.mekaAssistant',
    descriptionKey: 'settings.meka.router.description',
    keywordKeys: [
      'settings.meka.router.disconnectConfirm.title',
      'settings.meka.router.disconnectConfirm.description',
      'settings.meka.router.clientsTitle',
      'settings.meka.router.templatesTitle',
    ],
    aliases: ['mcpr', 'mcp router', 'MCPRouter', '工具客户端'],
  },
  design: {
    id: 'settings.meka.design.title',
    fallbackTargetId: 'settings-panel-meka-assistant',
    tab: 'meka-assistant',
    targetId: 'settings-search-target-meka-assistant-design',
    titleKey: 'settings.meka.design.title',
    sectionKey: 'settings.tabs.mekaAssistant',
    descriptionKey: 'settings.meka.design.description',
    keywordKeys: [
      'settings.meka.design.conflict.title',
      'settings.meka.design.conflict.description',
      'settings.meka.design.disconnectConfirm.title',
      'settings.meka.design.disconnectConfirm.description',
      'settings.meka.design.dialogTitle',
    ],
    aliases: ['mekadesign', 'MekaDesign', '设计'],
  },
});

export default {
  id: 'meka-assistant',
  // Appended after the upstream 0–17 sequence: Meka's tab sits between providers and billing
  // in the sidebar, but order only sequences declarations and must not renumber upstream modules.
  order: 18,
  entries: Object.values(mekaAssistantSettings),
} satisfies SettingsSearchModule;
