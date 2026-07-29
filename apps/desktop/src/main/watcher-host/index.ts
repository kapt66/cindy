/**
 * watcher-host 单例接线 — 真实 Electron 环境下的 WatcherHostClient。
 *
 * fork 细节:
 *   - 产物路径:与 main bundle 同目录的 watcherHostProcess.js(forge VitePlugin
 *     独立 entry,dev / packaged 布局一致,参考 db-worker 的解析方式)
 *   - @parcel/watcher 模块路径由 main 预解析后经 env 传入,避免子进程在
 *     packaged(asar.unpacked)布局下猜错解析根
 *   - bootstrap-electron 在 app before-quit 时 dispose(kill 子进程、抑制退出期的误重启)
 */

export type {
  WatcherHostSubscription,
  WatcherHostEventsHandler,
  WatcherHostErrorHandler,
} from './WatcherHostClient.js';
export type { WatchedFsEvent } from './protocol.js';
export { watcherHostClient } from './client.js';
