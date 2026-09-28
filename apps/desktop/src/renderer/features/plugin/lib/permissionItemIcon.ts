import {
  AppWindow,
  Bot,
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
  Radio,
  Smartphone,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import type { GhostPermissionItem } from '../../../../shared/ghost';

const PERMISSION_ICON: Record<GhostPermissionItem['kind'], LucideIcon> = {
  cindy: Sparkles,
  agent: Bot,
  node: Cpu,
  tool: Wrench,
  command: Terminal,
  panel: PanelRight,
  'main-view': AppWindow,
  code: FileCode2,
  subscribe: Radio,
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
  'ios-simulator': Smartphone,
  workspace: FolderPlus,
  // Meka 两条能力槽:文件揭示(reveal)与 MCPRouter route 白名单(mcpr)。
  // 上游把这个映射抽成本模块时还没有这两个 kind,但它们已在
  // shared/ghost.ts 的 GhostPermissionItem['kind'] 里,漏项会让本表类型不完整。
  // 映射与 MekaDevInstallReview.tsx 的 KIND_ICON 保持一致(reveal→FolderOpen,
  // mcpr→Network),两处不得分叉。
  mcpr: Network,
};

/**
 * Chooses a visual affordance without changing the host-owned permission title or meaning.
 * Shared by the plugin detail page and the install confirmation dialog.
 */
export function permissionItemIcon(item: GhostPermissionItem): LucideIcon {
  if (item.labelKey === 'panelLeft') return PanelLeft;
  if (
    item.labelKey === 'networkSecret' ||
    item.labelKey === 'networkSecretOauth' ||
    item.labelKey === 'networkSecretGhCli' ||
    item.labelKey === 'networkSecretIdentity'
  ) {
    return KeyRound;
  }
  return PERMISSION_ICON[item.kind];
}
