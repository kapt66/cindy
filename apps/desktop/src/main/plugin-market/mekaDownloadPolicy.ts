import type { GhostManifest } from '../../shared/ghost.js';

/**
 * Meka is an independent distribution channel and may carry self-contained
 * Node plugins. Keep its exception here so the upstream Cindy market retains
 * the historical 8 MiB download ceiling.
 */
export const MEKA_NODE_PLUGIN_MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;

/**
 * Only a manifest already accepted by the shared validator may opt into the
 * larger Node-package ceiling. Ordinary Meka plugins keep the downloader's
 * default 8 MiB limit.
 */
export function resolveMekaPluginMaxDownloadBytes(
  manifest: GhostManifest,
): number | undefined {
  return manifest.node ? MEKA_NODE_PLUGIN_MAX_DOWNLOAD_BYTES : undefined;
}
