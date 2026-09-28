import type { GhostManifest } from '../../shared/ghost.js';

/**
 * Meka is an independent distribution channel and may carry self-contained
 * Node plugins. Keep its exception here so the upstream Cindy market keeps its
 * own ceiling.
 *
 * Meka 普通插件的下载上限必须与「安装期」的 basic 包上限同值
 * （`MAX_BASIC_CINDY_FILE_BYTES`，见 `cindy-brain/GhostManager.ts`），并且**必须显式注入**：
 * 上游把 `PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES` 从 8 MiB 提到 128 MiB 之后，共享下载器的
 * 缺省值不再等于 basic 包上限，继续「返回 undefined 交给缺省」会让普通 Meka 插件的下载
 * 上限被静默放宽到 128 MiB（白下之后才在安装期被拒）。不变量正文见
 * `docs/dev-rules/plugin-security-and-authoring.md` §4.2。
 */
export const MEKA_PLUGIN_MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
export const MEKA_NODE_PLUGIN_MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;

/**
 * Only a manifest already accepted by the shared validator may opt into the
 * larger Node-package ceiling. Ordinary Meka plugins are pinned to the basic
 * package ceiling explicitly instead of falling through to the downloader
 * default.
 */
export function resolveMekaPluginMaxDownloadBytes(
  manifest: GhostManifest,
): number {
  return manifest.node
    ? MEKA_NODE_PLUGIN_MAX_DOWNLOAD_BYTES
    : MEKA_PLUGIN_MAX_DOWNLOAD_BYTES;
}
