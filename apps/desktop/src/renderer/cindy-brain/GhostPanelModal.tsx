import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { WINDOW_NO_DRAG_STYLE, useManualWindowDrag } from '@/components/layout/windowDrag';
import { cn } from '@/lib/utils';

import type { InstalledGhost } from '../../shared/ghost';
import { GhostChipPanelBody, GhostPanelError } from './ghostPanelBody';
import { useGhostRuntimeState } from './runtimeStates';

/**
 * Modal presentation for a Plugin panel. The body is the same sandboxed
 * WebView host used by docked and right-sidebar panels; only its host chrome
 * changes.
 */
export function GhostPanelModal({
  ghost,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  ghost: InstalledGhost;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}): ReactNode {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const headerWindowDrag = useManualWindowDrag();
  const runtimeState = useGhostRuntimeState(ghost.manifest.id);
  const broken = runtimeState === 'crashed' || runtimeState === 'fused';
  const title = ghost.manifest.panel?.title ?? ghost.manifest.name;
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const webview = panelBodyRef.current?.querySelector<HTMLElement>('webview');
      if (webview) webview.focus();
      else closeRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          const active = document.activeElement;
          if (active instanceof HTMLElement) active.blur();
          window.setTimeout(() => returnFocusRef?.current?.focus(), 0);
        }
        onOpenChange(nextOpen);
      }}
    >
      {/* forceMount keeps the sandbox WebView attached while the modal is closed.
          The Plugin runtime and in-flight Node requests already live outside this
          surface; retaining the guest preserves its selection, scroll and draft UI. */}
      <Dialog.Portal forceMount>
        <Dialog.Overlay
          forceMount
          className={cn(
            'fixed inset-0 z-[10000] bg-[var(--overlay-modal)]',
            'data-[state=open]:animate-confirm-overlay-in',
            'data-[state=closed]:animate-confirm-overlay-out',
            'data-[state=closed]:pointer-events-none data-[state=closed]:invisible',
          )}
          style={WINDOW_NO_DRAG_STYLE}
        />
        <Dialog.Content
          forceMount
          data-testid="ghost-panel-modal"
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] flex h-[90vh] w-[90vw]',
            '-translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl',
            'border border-[var(--border-default)] bg-[var(--confirm-bg)]',
            'shadow-[var(--confirm-shadow)] focus:outline-none',
            'data-[state=open]:animate-confirm-content-in',
            'data-[state=closed]:animate-confirm-content-out',
            'data-[state=closed]:pointer-events-none data-[state=closed]:invisible',
          )}
          style={WINDOW_NO_DRAG_STYLE}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const webview = panelBodyRef.current?.querySelector<HTMLElement>('webview');
            if (webview) webview.focus();
            else closeRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (!returnFocusRef?.current) return;
            event.preventDefault();
            returnFocusRef.current.focus();
          }}
        >
          <header
            data-testid="ghost-panel-modal-header"
            className="flex h-12 shrink-0 cursor-default items-center justify-between gap-3 border-b border-[var(--border-default)] px-4"
            style={WINDOW_NO_DRAG_STYLE}
            {...headerWindowDrag}
          >
            <Dialog.Title className="truncate text-14 font-medium text-[var(--confirm-title)]">
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                ref={closeRef}
                type="button"
                aria-label={t('settings.ghosts.detail.closePanel')}
                onPointerDown={(event) => event.stopPropagation()}
                className="grid size-9 shrink-0 place-items-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                <X size={17} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </header>
          <div
            ref={panelBodyRef}
            className="flex min-h-0 flex-1 flex-col bg-[var(--panel-bg)]"
          >
            {broken ? (
              <GhostPanelError manifest={ghost.manifest} state={runtimeState} />
            ) : (
              <GhostChipPanelBody manifest={ghost.manifest} autoFocusWebview={open} />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
