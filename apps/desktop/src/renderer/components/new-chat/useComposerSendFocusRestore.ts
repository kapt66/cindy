import { useCallback, useEffect, useRef } from 'react';

import { isInteractiveFocusedElement } from './composerBlankPointerFocus';
import {
  isConfirmDialogOpen,
  subscribeConfirmDialogSettled,
} from '@/lib/confirmDialogKeyboardGuard';

export interface ComposerFocusEditor {
  readonly isDestroyed: boolean;
  readonly isEditable: boolean;
  readonly isFocused: boolean;
  readonly view: { readonly dom: HTMLElement };
  readonly commands: {
    focus: (
      position: null,
      options?: { scrollIntoView?: boolean },
    ) => unknown;
  };
}

interface PendingComposerFocusRestore {
  readonly editor: ComposerFocusEditor;
  readonly focusAnchor: Element | null;
}

export function hasFocusMovedToInteractiveElement(
  focusAnchor: Element | null,
  editorDom: HTMLElement,
): boolean {
  const activeElement = editorDom.ownerDocument.activeElement;
  if (
    !activeElement ||
    activeElement === editorDom.ownerDocument.body ||
    activeElement === editorDom.ownerDocument.documentElement
  ) {
    return false;
  }
  if (activeElement === focusAnchor) return false;
  if (editorDom.contains(activeElement)) return false;
  return isInteractiveFocusedElement(activeElement);
}

export function hasNonCollapsedSelectionOutsideComposer(editorDom: HTMLElement): boolean {
  const selection = editorDom.ownerDocument.getSelection?.() ?? null;
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) return false;
  return !editorDom.contains(anchorNode) || !editorDom.contains(focusNode);
}

export function useComposerSendFocusRestore(
  editor: ComposerFocusEditor | null,
  composerTypingLocked: boolean,
): () => void {
  const pendingRestoreRef = useRef<PendingComposerFocusRestore | null>(null);

  useEffect(() => {
    // Retained sidebar panels can reconnect effects after their editor view
    // has been unmounted. Tiptap's view.dom getter throws in that state.
    if (!editor || editor.isDestroyed) return;
    const editorDom = editor.view.dom;
    const ownerDocument = editorDom.ownerDocument;
    const cancelRestoreForOutsidePointer = (event: PointerEvent) => {
      const pendingRestore = pendingRestoreRef.current;
      if (!pendingRestore || pendingRestore.editor !== editor) return;
      const target = event.target;
      if (target instanceof Node && editorDom.contains(target)) return;
      pendingRestoreRef.current = null;
    };

    ownerDocument.addEventListener('pointerdown', cancelRestoreForOutsidePointer, true);
    return () => {
      ownerDocument.removeEventListener('pointerdown', cancelRestoreForOutsidePointer, true);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor || composerTypingLocked) return;

    const pendingRestore = pendingRestoreRef.current;
    if (!pendingRestore) return;
    if (pendingRestore.editor !== editor) {
      pendingRestoreRef.current = null;
      return;
    }

    let cancelled = false;
    let frame = 0;
    let unsubscribeSettled: (() => void) | undefined;

    const attemptRestore = () => {
      if (cancelled || pendingRestoreRef.current !== pendingRestore) return;
      if (editor.isDestroyed) {
        pendingRestoreRef.current = null;
        return;
      }
      // A second lock can begin before this frame runs. Keep the pending intent
      // so the next unlocked effect can try again instead of dropping it.
      if (!editor.isEditable) return;
      if (editor.isFocused) {
        pendingRestoreRef.current = null;
        return;
      }
      // 发送前占用预检（PSB）会在发送途中异步弹确认框。焦点在确认框里时不能按
      // 「焦点已经去了别的控件」处理：等确认框队列彻底关闭后再归还焦点，否则取消确认后
      // composer 拿不回焦点（用户以为在输入框里回车/输入，实际没有落点）。
      if (isConfirmDialogOpen()) {
        unsubscribeSettled?.();
        unsubscribeSettled = subscribeConfirmDialogSettled(scheduleRestore);
        return;
      }
      unsubscribeSettled?.();
      unsubscribeSettled = undefined;
      if (
        hasFocusMovedToInteractiveElement(pendingRestore.focusAnchor, editor.view.dom) ||
        hasNonCollapsedSelectionOutsideComposer(editor.view.dom)
      ) {
        pendingRestoreRef.current = null;
        return;
      }

      pendingRestoreRef.current = null;
      // 只归还焦点，不强制滚动：发送后的恢复/确认框关闭时，输入框本来就在视口里；
      // 强制滚动会在关闭模态的同一拍里把视口顶走。
      editor.commands.focus(null, { scrollIntoView: false });
    };

    const scheduleRestore = () => {
      if (cancelled) return;
      frame = window.requestAnimationFrame(attemptRestore);
    };

    scheduleRestore();

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      unsubscribeSettled?.();
    };
  }, [composerTypingLocked, editor]);

  return useCallback(() => {
    // dispatchSend 会在本地路径与远端路径各捕获一次焦点（第二处在 effort settle 后触发）。
    // 旧实现 restoreFocusAfterDispatchRef 用 || 合并防止互相覆盖；此捕获函数是直接赋值，
    // 本地路径第一处捕获后 setEditable(false) 已打掉焦点，第二处捕获时 editor.isFocused 为 false，
    // 会把第一处记住的 intent 覆盖成 null，解锁后不再恢复光标。
    // 因此同一 editor 已有待恢复 intent 时，后续捕获直接跳过。
    if (pendingRestoreRef.current && pendingRestoreRef.current.editor === editor) {
      return;
    }
    pendingRestoreRef.current =
      editor && !editor.isDestroyed && editor.isFocused
        ? { editor, focusAnchor: editor.view.dom.ownerDocument.activeElement }
        : null;
  }, [editor]);
}
