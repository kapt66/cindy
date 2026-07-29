import { useSyncExternalStore } from 'react';

const revisions = new Map<string, number>();
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function ensureSubscribed(): void {
  if (unsubscribe || !window.electronAPI?.ghosts?.onContentReloaded) return;
  unsubscribe = window.electronAPI.ghosts.onContentReloaded(({ id }) => {
    revisions.set(id, (revisions.get(id) ?? 0) + 1);
    for (const listener of listeners) listener();
  });
}

function subscribe(listener: () => void): () => void {
  ensureSubscribed();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGhostContentRevision(id: string): number {
  return useSyncExternalStore(
    subscribe,
    () => revisions.get(id) ?? 0,
    () => 0,
  );
}
