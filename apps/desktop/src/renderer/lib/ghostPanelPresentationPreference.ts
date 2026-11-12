/**
 * Plugin panel presentation preference.
 *
 * This is a renderer-owned view override: docked panels remain the product
 * default, while an explicit Meka Assistant setting can switch panel-bearing
 * Plugins to the shared modal host. Only the non-default `true` override is
 * persisted, so users without a customization continue to follow the current
 * product default.
 */

import { useMemo, useSyncExternalStore } from 'react';

import { isValidGhostId, type InstalledGhost } from '../../shared/ghost';

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
  if (storageWired || typeof window === 'undefined') return;
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
  if (typeof window === 'undefined') return false;
  ensureStorageWired();
  modalOverride = readStoredValue(window.localStorage.getItem(STORAGE_KEY));
  return modalOverride;
}

function loadPluginOverrides(): Record<string, GhostPanelPresentation> {
  if (pluginOverrides !== null) return pluginOverrides;
  if (typeof window === 'undefined') return {};
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

/**
 * 面板页的**有效宿主**（Meka 侧唯一真值，所有入口共用）。
 *
 * - 没有 `panel` 声明，或 `position:'tab'` → 恒 `docked`：tab 形态由 manifest 固定成
 *   插件页内的独占宿主（`GhostPagePanelHost`），调用方不得据此开 Modal（否则同一实例
 *   两个 webview 各存整份插件数据）；
 * - 插件级 override（`docked`／`modal`）优先；
 * - 否则跟随 Meka 全局开关（缺省 false = docked，兼容「用户从未设置」）；
 * - 纯函数、无副作用，可在 render 期与模块级同步路径（启动/`ghosts:changed` 的
 *   reconcile）里调用；存储损坏一律回落到 `docked`。
 */
export function resolveGhostPanelPresentation(
  ghost: Pick<InstalledGhost, 'manifest'>,
): GhostPanelPresentation {
  const panel = ghost.manifest.panel;
  if (!panel || panel.position === 'tab') return 'docked';
  const override = loadPluginOverrides()[ghost.manifest.id];
  if (override !== undefined) return override;
  return loadGlobal() ? 'modal' : 'docked';
}

/** 携带呈现信息的 hook：偏好或插件实例变化时重渲染。 */
export function useGhostPanelPresentation(
  ghost: Pick<InstalledGhost, 'manifest'> | null,
): GhostPanelPresentation {
  // revision 只为订阅变更触发重算。
  const revision = useGhostPanelPresentationRevision();
  return useMemo(
    () => (ghost ? resolveGhostPanelPresentation(ghost) : 'docked'),
    [ghost, revision],
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
