/**
 * Plugin panel presentation preference.
 *
 * This is a renderer-owned view override: docked panels remain the product
 * default, while an explicit Meka Assistant setting can switch panel-bearing
 * Plugins to the shared modal host. Only the non-default `true` override is
 * persisted, so users without a customization continue to follow the current
 * product default.
 */

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'xdt:ghostPanelPresentation:v1';

let modalOverride: boolean | null = null;
const listeners = new Set<() => void>();
let storageWired = false;

function readStoredValue(value: string | null): boolean {
  try {
    return JSON.parse(value ?? 'false') === true;
  } catch {
    return false;
  }
}

function ensureStorageWired(): void {
  if (storageWired) return;
  storageWired = true;
  window.addEventListener('storage', onStorage);
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) return;
  const next = readStoredValue(event.newValue);
  if (modalOverride === next) return;
  modalOverride = next;
  listeners.forEach((listener) => listener());
}

function load(): boolean {
  if (modalOverride !== null) return modalOverride;
  ensureStorageWired();
  modalOverride = readStoredValue(window.localStorage.getItem(STORAGE_KEY));
  return modalOverride;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether panel-bearing Plugins should use the modal presentation. */
export function isGhostPanelModalPresentationEnabled(): boolean {
  return load();
}

/**
 * Persist an explicit modal override. Turning it off removes the override and
 * resumes following the docked-panel product default.
 */
export function setGhostPanelModalPresentationEnabled(enabled: boolean): void {
  if (load() === enabled) return;
  modalOverride = enabled;
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(true));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage failure does not block the current in-memory interaction.
  }
  listeners.forEach((listener) => listener());
}

/** Reactive preference used by Settings, layout filtering, and Plugin surfaces. */
export function useGhostPanelModalPresentation(): boolean {
  return useSyncExternalStore(
    subscribe,
    isGhostPanelModalPresentationEnabled,
    isGhostPanelModalPresentationEnabled,
  );
}

/** Test-only reset. */
export function __resetGhostPanelPresentationPreferenceForTest(): void {
  modalOverride = null;
  listeners.clear();
  if (storageWired) window.removeEventListener('storage', onStorage);
  storageWired = false;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export const __GHOST_PANEL_PRESENTATION_STORAGE_KEY = STORAGE_KEY;
