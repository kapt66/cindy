import type { SettingsSearchModule } from './settingsSearchTypes';

/**
 * Static search metadata owned by this settings module; no component mounting or IPC.
 *
 * The Meka assistant tab declares its own catalog entries so it stays inside the upstream
 * per-tab completeness guard (`TAB_IDS` × `TAB_LABEL_KEY`) while its four cards
 * (plugin panel presentation, P4 root, MCPRouter, MekaDesign) remain individually searchable.
 */
export default {
  id: 'meka-assistant',
  // Appended after the upstream 0–17 sequence: Meka's tab sits between providers and billing
  // in the sidebar, but order only sequences declarations and must not renumber upstream modules.
  order: 18,
  entries: [
    { id: 'mekaAssistant', tab: 'meka-assistant', targetId: 'settings-panel-meka-assistant', titleKey: 'settings.tabs.mekaAssistant', sectionKey: 'settings.tabs.mekaAssistant' },
    { id: 'settings.meka.pluginPanel.title', fallbackTargetId: 'settings-panel-meka-assistant', tab: 'meka-assistant', targetId: 'settings-search-target-meka-assistant-plugin-panel', titleKey: 'settings.meka.pluginPanel.title', sectionKey: 'settings.tabs.mekaAssistant', descriptionKey: 'settings.meka.pluginPanel.description', aliases: ['plugin panel', '插件面板', '插件打开方式'] },
    { id: 'settings.meka.p4.title', fallbackTargetId: 'settings-panel-meka-assistant', tab: 'meka-assistant', targetId: 'settings-search-target-meka-assistant-p4', titleKey: 'settings.meka.p4.title', sectionKey: 'settings.tabs.mekaAssistant', descriptionKey: 'settings.meka.p4.description', aliases: ['p4', 'saga2', '功能路径', '项目根'] },
    { id: 'settings.meka.router.title', fallbackTargetId: 'settings-panel-meka-assistant', tab: 'meka-assistant', targetId: 'settings-search-target-meka-assistant-router', titleKey: 'settings.meka.router.title', sectionKey: 'settings.tabs.mekaAssistant', descriptionKey: 'settings.meka.router.description', aliases: ['mcpr', 'mcp router', 'MCPRouter', '工具客户端'] },
    { id: 'settings.meka.design.title', fallbackTargetId: 'settings-panel-meka-assistant', tab: 'meka-assistant', targetId: 'settings-search-target-meka-assistant-design', titleKey: 'settings.meka.design.title', sectionKey: 'settings.tabs.mekaAssistant', descriptionKey: 'settings.meka.design.description', aliases: ['mekadesign', 'MekaDesign', '设计'] },
  ],
} satisfies SettingsSearchModule;
