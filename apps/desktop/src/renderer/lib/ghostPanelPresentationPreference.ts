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

import { isValidGhostId } from '../../shared/ghost';

const STORAGE_KEY = 'xdt:ghostPanelPresentation:v1';
const OVERRIDES_STORAGE_KEY = 'xdt:ghostPanelPresentationOverrides:v1';

let modalOverride: boolean | null = null;
let pluginOverrides: Record<string, GhostPanelPresentation> | null = null;
let revision = 0;
const listeners = new Set<() => void>();
let storageWired = false;

export type GhostPanelPresentation = 'docked' | 'modal';
export type GhostPanelPresentationOverride = 'inherit' | GhostPanelPresentation;

function readStoredValue(value: string | null): boolean {
  try {
    return JSON.parse(value ?? 'false') === true;
  } catch {
    return false;
  }
}

function readStoredOverrides(value: string | null): Record<string, GhostPanelPresentation> {
  try {
    const parsed: unknown = JSON.parse(value ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const overrides: Record<string, GhostPanelPresentation> = {};
    for (const [ghostId, presentation] of Object.entries(parsed)) {
      if (
        isValidGhostId(ghostId) &&
        (presentation === 'docked' || presentation === 'modal')
      ) {
        overrides[ghostId] = presentation;
      }
    }
    return overrides;
  } catch {
    return {};
  }
}

function notify(): void {
  revision += 1;
  listeners.forEach((listener) => listener());
}

function ensureStorageWired(): void {
  if (storageWired) return;
  storageWired = true;
  window.addEventListener('storage', onStorage);
}

function onStorage(event: StorageEvent): void {
  if (event.key === STORAGE_KEY) {
    const next = readStoredValue(event.newValue);
    if (modalOverride === next) return;
    modalOverride = next;
    notify();
    return;
  }
  if (event.key === OVERRIDES_STORAGE_KEY) {
    pluginOverrides = readStoredOverrides(event.newValue);
    notify();
  }
}

function loadGlobal(): boolean {
  if (modalOverride !== null) return modalOverride;
  ensureStorageWired();
  modalOverride = readStoredValue(window.localStorage.getItem(STORAGE_KEY));
  return modalOverride;
}

function loadPluginOverrides(): Record<string, GhostPanelPresentation> {
  if (pluginOverrides !== null) return pluginOverrides;
  ensureStorageWired();
  pluginOverrides = readStoredOverrides(
    window.localStorage.getItem(OVERRIDES_STORAGE_KEY),
  );
  return pluginOverrides;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether panel-bearing Plugins should use the modal presentation. */
export function isGhostPanelModalPresentationEnabled(ghostId?: string): boolean {
  if (ghostId !== undefined) {
    const override = loadPluginOverrides()[ghostId];
    if (override !== undefined) return override === 'modal';
  }
  return loadGlobal();
}

export function getGhostPanelPresentationOverride(
  ghostId: string,
): GhostPanelPresentationOverride {
  return loadPluginOverrides()[ghostId] ?? 'inherit';
}

/**
 * Persist an explicit modal override. Turning it off removes the override and
 * resumes following the docked-panel product default.
 */
export function setGhostPanelModalPresentationEnabled(enabled: boolean): void {
  if (loadGlobal() === enabled) return;
  modalOverride = enabled;
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(true));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage failure does not block the current in-memory interaction.
  }
  notify();
}

/**
 * Persist only an explicit per-Plugin override. `inherit` removes the entry so
 * later global-default changes continue to apply.
 */
export function setGhostPanelPresentationOverride(
  ghostId: string,
  presentation: GhostPanelPresentationOverride,
): void {
  if (!isValidGhostId(ghostId)) return;
  const current = getGhostPanelPresentationOverride(ghostId);
  if (current === presentation) return;
  const next = { ...loadPluginOverrides() };
  if (presentation === 'inherit') delete next[ghostId];
  else next[ghostId] = presentation;
  pluginOverrides = next;
  try {
    if (Object.keys(next).length === 0) {
      window.localStorage.removeItem(OVERRIDES_STORAGE_KEY);
    } else {
      window.localStorage.setItem(OVERRIDES_STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // Storage failure does not block the current in-memory interaction.
  }
  notify();
}

/** Reactive preference used by Settings, layout filtering, and Plugin surfaces. */
export function useGhostPanelModalPresentation(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isGhostPanelModalPresentationEnabled(),
    () => isGhostPanelModalPresentationEnabled(),
  );
}

export function useGhostPanelPresentationOverride(
  ghostId: string,
): GhostPanelPresentationOverride {
  return useSyncExternalStore(
    subscribe,
    () => getGhostPanelPresentationOverride(ghostId),
    () => getGhostPanelPresentationOverride(ghostId),
  );
}

/** Re-render consumers whose effective value depends on a dynamic ghost ID. */
export function useGhostPanelPresentationRevision(): number {
  return useSyncExternalStore(
    subscribe,
    () => revision,
    () => revision,
  );
}

/** Test-only reset. */
export function __resetGhostPanelPresentationPreferenceForTest(): void {
  modalOverride = null;
  pluginOverrides = null;
  revision = 0;
  listeners.clear();
  if (storageWired) window.removeEventListener('storage', onStorage);
  storageWired = false;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(OVERRIDES_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export const __GHOST_PANEL_PRESENTATION_STORAGE_KEY = STORAGE_KEY;
export const __GHOST_PANEL_PRESENTATION_OVERRIDES_STORAGE_KEY =
  OVERRIDES_STORAGE_KEY;
