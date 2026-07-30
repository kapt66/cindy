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
import { restoreGhostPanel } from '@/lib/ghostPanelBubbleState';
import { isGhostPanelModalPresentationEnabled } from '@/lib/ghostPanelPresentationPreference';

import {
  layoutWithGhostPanel,
  type InstalledGhost,
} from '../../../shared/ghost';

export interface GhostPanelLauncher {
  openPanel: (id: string, trigger: HTMLButtonElement) => Promise<void>;
  resetPanelModal: () => void;
  modalHost: ReactNode;
}

/**
 * One launch boundary for every Plugin-catalog entry point.
 *
 * The modal target is mounted closed before it opens on the next animation
 * frame. This prevents the trusted click that creates the Radix Dialog from
 * also being observed as an outside interaction that immediately dismisses it.
 */
export function useGhostPanelLauncher({
  ghosts,
  navigate,
}: {
  ghosts: InstalledGhost[];
  navigate: NavigateFunction;
}): GhostPanelLauncher {
  const [modalGhostId, setModalGhostId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const modalTriggerRef = useRef<HTMLElement | null>(null);
  const openFrameRef = useRef<number | null>(null);
  const openRequestRef = useRef(0);

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
    async (id: string, trigger: HTMLButtonElement) => {
      const ghost = ghosts.find((candidate) => candidate.manifest.id === id);
      if (!ghost?.manifest.panel || ghost.enabled === false) return;
      modalTriggerRef.current = trigger;

      if (
        isGhostPanelModalPresentationEnabled(ghost.manifest.id) ||
        ghost.manifest.panel.position === 'tab'
      ) {
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

      cancelPendingOpen();
      setModalOpen(false);
      const currentLayout = window.electronAPI.layout.getStateSync().layout;
      const withPanel = layoutWithGhostPanel(currentLayout, ghost.manifest);
      if (withPanel) {
        await window.electronAPI.layout.set(withPanel).catch(() => undefined);
      }
      restoreGhostPanel(id);
      await window.electronAPI.ghostPanelWindow
        .setDetached(id, false)
        .catch(() => undefined);
      navigate('/cc-agent/new');
    },
    [cancelPendingOpen, ghosts, navigate],
  );

  const modalGhost = useMemo(
    () =>
      modalGhostId
        ? (ghosts.find((ghost) => ghost.manifest.id === modalGhostId) ?? null)
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
