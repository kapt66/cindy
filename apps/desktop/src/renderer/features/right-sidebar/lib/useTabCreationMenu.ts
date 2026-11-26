import { useContext, useRef, useState, useSyncExternalStore } from 'react';
import { Puzzle } from 'lucide-react';
import { MAIN_VIEW_ICONS } from '@/cindy-brain/mainViewIcons';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { installedGhostStoragePart } from '../../../../shared/pluginIdentity';
import { useBotProfiles } from '@/features/bots/botStore';
import { findBotProfileForSession } from '@/features/bots/botSessionOwners';
import { DetachedBotMenuOwnerContext } from '../botMenuOwnerContext';
import { useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { isRemoteSessionWriteBlocked } from '@/features/cc-agent/lib/remoteSessionWriteGuard';
import { sessionsStore } from '@/lib/sessionsStore';
import { listTabKindMenuMetas, useTabKindRegistryVersion } from '../registry';
import type { TabKindId, TabKindMenuMeta } from '../types';
import { canOpenSideChat, openSideChatTab, type SideChatTabPlacement } from './openSideChatTab';
import {
  addGlobalPluginTab,
  globalTabTitleForGhost,
  isGlobalTabCapableGhost,
  findRemoteWorkspaceAdminTab,
  isRemoteWorkspaceAdminKind,
  setActiveGlobalTabId,
  useGlobalTabs,
  type PluginViewTabState,
} from '../globalTabs';
import { openRemoteWorkspaceAdminTab } from '@/features/remote-workspace/admin/remoteWorkspaceAdminTab';
import type { TabGroupId } from '../tabGroups';

const BOT_SECONDARY_KINDS = new Set<TabKindId>([
  'review',
  'subagents',
  'background-tasks',
  'terminal',
]);

export interface TabCreationSelectionOptions {
  groupId?: TabGroupId;
  onGlobalTabSelected?: (tabId: string, existed: boolean) => void;
}

export interface TabCreationMenu {
  items: Array<
    TabKindMenuMeta & {
      disabled: boolean;
      busy: boolean;
      group?: 'plugins';
      alreadyOpen?: boolean;
    }
  >;
  select: (kind: TabKindId, options?: TabCreationSelectionOptions) => void;
}

/** Both entry surfaces share the registry, eligibility, pending state and open actions. */
export function useTabCreationMenu({
  sessionId,
  subagentsAvailable,
  onSelect,
  sideChatPlacement,
}: {
  sessionId: string | null | undefined;
  subagentsAvailable: boolean;
  onSelect: (kind: TabKindId) => void;
  sideChatPlacement?: SideChatTabPlacement;
}): TabCreationMenu {
  useTabKindRegistryVersion();
  const installedGhosts = useInstalledGhosts();
  const globalTabs = useGlobalTabs();
  const pluginEntries = installedGhosts
    .filter(isGlobalTabCapableGhost)
    .map((ghost) => {
      const instanceId = installedGhostStoragePart(ghost);
      return {
        kind: `ghost:${instanceId}` as TabKindId,
        instanceId,
        ghost,
        title: globalTabTitleForGhost(ghost),
        icon: MAIN_VIEW_ICONS[ghost.manifest.mainView?.icon ?? 'puzzle'] ?? Puzzle,
        open: globalTabs.some(
          (tab) => (tab.state as PluginViewTabState | null)?.instanceId === instanceId,
        ),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title) || a.instanceId.localeCompare(b.instanceId));
  const bots = useBotProfiles();
  const bot = sessionId ? findBotProfileForSession(bots, sessionId) : undefined;
  const detachedOwner = useContext(DetachedBotMenuOwnerContext);
  const linkedOwner = detachedOwner?.sessionId === sessionId ? detachedOwner : null;
  const isBotSession = Boolean(bot || linkedOwner);
  const localSession = useSyncExternalStore(sessionsStore.subscribe, () =>
    sessionId ? sessionsStore.findById(sessionId) : null,
  );
  const remoteSessions = useRemoteProjectSessions();
  const session = remoteSessions.find((row) => row.id === sessionId) ?? localSession;
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const items = listTabKindMenuMetas()
    .filter((item) => {
      if (item.kind.startsWith('ghost:')) return false;
      if (item.kind === 'subagents' && !subagentsAvailable) return false;
      if (item.kind === 'side-chat' && (isBotSession || !canOpenSideChat(session))) return false;
      // Bot 会话只收「伙伴的次要页签」白名单；「远程工作区」不是次要页签（不在集合里），
      // 因此自然通过这一条 —— 不要再补一个 kind 特判。
      return !isBotSession || !BOT_SECONDARY_KINDS.has(item.kind);
    })
    .map((item) => {
      const busy = item.kind === 'side-chat' && !!sessionId && openingSessionId === sessionId;
      // 「远程工作区」是全局页签(不跟任务、不按会话分桶):没有打开任务 / 打开的不是远程工作区
      // 任务时也允许打开,页面自己显示提示态;已有同一页时菜单显示「已打开」。
      const adminKind = isRemoteWorkspaceAdminKind(item.kind);
      return {
        ...item,
        busy,
        ...(adminKind ? { alreadyOpen: findRemoteWorkspaceAdminTab() !== null } : {}),
        disabled: adminKind
          ? !item.enabled || busy
          : !sessionId ||
            !item.enabled ||
            busy ||
            (item.kind === 'side-chat' && isRemoteSessionWriteBlocked(session)),
      };
    });

  const select = (kind: TabKindId, options?: TabCreationSelectionOptions) => {
    const plugin = pluginEntries.find((entry) => entry.kind === kind);
    if (plugin) {
      const tab = addGlobalPluginTab(plugin.instanceId, {
        ...(options?.groupId && options.groupId !== 'right' ? { groupId: options.groupId } : {}),
        ghost: plugin.ghost,
      });
      if (tab) {
        options?.onGlobalTabSelected?.(tab.id, plugin.open);
        setActiveGlobalTabId(tab.id);
      }
      return;
    }
    // 「远程工作区」是**全局页签**：打开/聚焦只有 `openRemoteWorkspaceAdminTab` 一个入口
    // （标题栏按钮、管理页、这里的「+」菜单都走它）。这里只把「+」菜单独有的语义交给它：
    // **落点 = 点 + 的那排标签栏所在的组**（在插件窗口那排点 +，就落在同一排）。组只由单入口
    // 写一次，且它给出的 dock 展开判定也按这个最终组执行；调用方不得事后再 `setTabGroup`
    // 覆盖 —— 那会让展开判定用旧组（左排点 + 却弹出右侧 dock）。
    if (isRemoteWorkspaceAdminKind(kind)) {
      const existed = findRemoteWorkspaceAdminTab() !== null;
      openRemoteWorkspaceAdminTab({
        sessionId: sessionId ?? null,
        userInitiated: true,
        ...(options?.groupId ? { targetGroup: options.groupId } : {}),
      });
      const adminTab = findRemoteWorkspaceAdminTab();
      // 激活位已由单入口设置；这里只把「此前是否已打开」交给宿主（弹出窗口据此聚焦）。
      if (adminTab) options?.onGlobalTabSelected?.(adminTab.id, existed);
      return;
    }
    if (!sessionId || !items.some((item) => item.kind === kind && !item.disabled)) return;
    if (kind === 'side-chat') {
      if (pending.current === sessionId) return;
      pending.current = sessionId;
      setOpeningSessionId(sessionId);
      const opening = openSideChatTab(sessionId, {
        placement: sideChatPlacement,
      });
      void opening.finally(() => {
        if (pending.current === sessionId) pending.current = null;
        setOpeningSessionId((current) => (current === sessionId ? null : current));
      });
      return;
    }
    onSelect(kind);
  };

  // Keep unavailable future entries last on both surfaces.
  return {
    items: [
      ...items.filter((item) => item.enabled),
      ...pluginEntries.map((entry) => ({
        kind: entry.kind,
        labelKey: 'rightSidebar.tabs.menu.pluginsLabel',
        labelText: entry.title,
        descriptionKey: 'rightSidebar.tabs.menu.pluginsLabel',
        icon: entry.icon,
        order: 0,
        enabled: true,
        disabled: false,
        busy: false,
        group: 'plugins' as const,
        alreadyOpen: entry.open,
      })),
      ...items.filter((item) => !item.enabled),
    ],
    select,
  };
}
