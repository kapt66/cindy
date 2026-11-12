import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { GhostPanelModal } from '@/cindy-brain/GhostPanelModal';
import { resolveGhostPanelPresentation } from '@/lib/ghostPanelPresentationPreference';
import { openPluginInSidebar } from '@/features/right-sidebar/pluginPlacement';

import { findInstalledGhostByInstanceId } from '../../../shared/pluginIdentity';
import type { InstalledGhost } from '../../../shared/ghost';

export interface GhostPanelLauncher {
  /**
   * 打开某个插件实例的面板。`trigger` 只在 Modal 分支用于焦点还原;
   * `?panel=` 深链与安装流程没有可信点击,可以省略。
   */
  openPanel: (id: string, trigger?: HTMLButtonElement | null) => Promise<void>;
  resetPanelModal: () => void;
  modalHost: ReactNode;
}

/**
 * One launch boundary for every Plugin-catalog entry point.
 *
 * 分支由 `resolveGhostPanelPresentation` 决定(插件级 override → Meka 全局开关 →
 * 停靠产品默认),三个市场/详情入口(详情「打开界面」/ 列表卡片主动作 / `?panel=` 深链 /
 * 安装流程)全部复用本函数,不再各自维护 Modal 或停靠分支:
 *
 * - `tab`(manifest 固定):交给插件页里的 `GhostPagePanelHost`,本函数不处理
 *   (Q-B①:不保留「没有会话宿主时用 Modal 兜底」——那会让同一实例出现两个 webview);
 * - `docked`:上游右侧栏全局页签(`openPluginInSidebar(ghost,'panel')`);
 * - `modal`:Meka Modal 宿主。
 *
 * The modal target is mounted closed before it opens on the next animation
 * frame. This prevents the trusted click that creates the Radix Dialog from
 * also being observed as an outside interaction that immediately dismisses it.
 */
export function useGhostPanelLauncher({
  ghosts,
  navigate,
  openPageHost,
}: {
  ghosts: InstalledGhost[];
  /** 保留在签名里:上游停靠路径不再跳任务页,调用方无需改;仅测试/未来入口使用。 */
  navigate?: NavigateFunction;
  /**
   * `panel.position:'tab'` 的宿主在插件页里(`GhostPagePanelHost`,`openPanelId` 状态),
   * 由调用方注入;launcher 仍是唯一分流点(tab 形态 manifest 固定,不提供 Modal 兜底)。
   */
  openPageHost?: (instanceId: string) => void;
}): GhostPanelLauncher {
  const [modalGhostId, setModalGhostId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const modalTriggerRef = useRef<HTMLElement | null>(null);
  const openFrameRef = useRef<number | null>(null);
  const openRequestRef = useRef(0);
  const openPageHostRef = useRef(openPageHost);
  openPageHostRef.current = openPageHost;
  void navigate;

  const cancelPendingOpen = useCallback(() => {
    openRequestRef.current += 1;
    if (openFrameRef.current !== null) {
      window.cancelAnimationFrame(openFrameRef.current);
      openFrameRef.current = null;
    }
  }, []);

  const resetPanelModal = useCallback(() => {
    cancelPendingOpen();
    setModalOpen(false);
    setModalGhostId(null);
  }, [cancelPendingOpen]);

  useEffect(() => cancelPendingOpen, [cancelPendingOpen]);

  const openPanel = useCallback(
    async (id: string, trigger?: HTMLButtonElement | null) => {
      // `id` 是**物理实例键**（`_root__<id>` / `_ns__<ns>__<id>`，与插件页 `selectedDetail.id`
      // 和 `?panel=` 深链同源），不是逻辑插件 id：namespace 隔离后新装 root 落在
      // `_ns/_root/<id>`，用 `manifest.id === id` 找不到任何实例，面板会静默不开。
      const ghost = findInstalledGhostByInstanceId(ghosts, id);
      if (!ghost?.manifest.panel || ghost.enabled === false) return;
      const panel = ghost.manifest.panel;
      // tab 形态由插件页内的 GhostPagePanelHost 承载,这里不抢宿主。
      if (panel.position === 'tab') {
        openPageHostRef.current?.(id);
        return;
      }

      if (resolveGhostPanelPresentation(ghost) === 'modal') {
        modalTriggerRef.current = trigger ?? null;
        cancelPendingOpen();
        const request = openRequestRef.current;
        setModalGhostId(id);
        setModalOpen(false);
        openFrameRef.current = window.requestAnimationFrame(() => {
          openFrameRef.current = null;
          if (openRequestRef.current === request) setModalOpen(true);
        });
        return;
      }

      // docked:上游右侧栏全局页签。先关掉可能开着的 Modal(呈现方式已切走),
      // 再打开/聚焦页签并选中它(选中与展开右侧组由 openPluginInSidebar 负责)。
      cancelPendingOpen();
      setModalOpen(false);
      setModalGhostId(null);
      await openPluginInSidebar(ghost, 'panel').catch(() => undefined);
    },
    [cancelPendingOpen, ghosts],
  );

  const modalGhost = useMemo(
    () =>
      modalGhostId
        ? (findInstalledGhostByInstanceId(ghosts, modalGhostId) ?? null)
        : null,
    [ghosts, modalGhostId],
  );

  const returnFocusRef: RefObject<HTMLElement | null> = modalTriggerRef;
  const modalHost = modalGhost ? (
    <GhostPanelModal
      ghost={modalGhost}
      open={modalOpen}
      onOpenChange={(open) => {
        if (!open) cancelPendingOpen();
        setModalOpen(open);
      }}
      returnFocusRef={returnFocusRef}
    />
  ) : null;

  return { openPanel, resetPanelModal, modalHost };
}
