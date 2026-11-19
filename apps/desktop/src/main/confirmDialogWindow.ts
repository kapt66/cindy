/**
 * confirmDialogWindow —— 「这个窗口能不能承载主机模态确认框」的单一判据。
 *
 * 背景(2026-11-19 用户实测):插件 confirm 槽的原生确认框由 main 铸 requestId 后投递。
 * 本地模式**广播**给所有可承载窗口(首个作答生效,其余窗口收卡),但单窗口时代与
 * client-mode 仍由同一判据选出一个窗口。旧装配写的是 `focused ?? getAllWindows()[0]`:
 * focused 完全可能是右侧栏独立窗、资源用量窗、远程桌面查看器或 utility 浮窗——它们与
 * MainLayout 平级,只挂轻量 renderer 与专用 preload,**根本没有 `ghosts:confirm-request`
 * 监听**(挂 confirm 宿主的只有完整主壳 `main-entry -> App.tsx`)。投过去的结果就是
 * 「弹了小窗/白屏/点不到」或者干脆看不见,插件只能等到 90s 超时拿到 `confirmed:false`。
 *
 * 判据分两层,缺一不可:
 *  1. URL 口径(纯函数,`isModalConfirmHostUrl`)只认**完整主壳**:主窗口(不带任何
 *     辅助窗口标识)或「在新窗口打开」的完整会话副窗(`?secondaryWindow=1`)。
 *     URL query 是 renderer 入口分流的既有事实(index.tsx):`sidebarWindow`/
 *     `resourceUsageWindow`/`remoteDesktopViewer`/`recordingPreview`/截图三件套
 *     各自进轻量入口;utility 窗沿用 `?view=<名字>` 约定。按 key 排除而不是按窗口
 *     大小或标题猜——尺寸不背这个契约。
 *  2. 受信窗口(`isTrustedAppRendererWindow`):Cindy 自有、已登记 app-content、
 *     当前仍加载 Cindy renderer 的窗口。两层都过才投。
 *
 * 与 cindy-brain/scheduleSlot.ts 的 `isMainShellWindowUrl` 是同一套窗口约定的两个
 * 用途:那边只认主窗口(自动化草稿不能落进会话副窗),这边额外允许**完整会话副窗**
 * ——它挂的是同一个 App.tsx,confirm 宿主就在里面,用户正看着它就投它。新增窗口
 * 类型沿用既有 query 约定(轻量入口一律带标识 / utility 窗带 `?view=`)即可自动落在
 * 排除侧;不要在这里按窗口枚举做特例。
 */

import type { BrowserWindow } from 'electron';

import { isTrustedAppRendererWindow } from './security/trustedAppRenderer.js';

/**
 * 轻量 renderer / utility 窗口的 URL 标识(任一出现即不是完整主壳)。
 *
 * 来源:renderer/index.tsx 的入口分流 + utility 窗的 `?view=<名字>` 约定。
 * 只列 key 不列取值:取值枚举会等着下一个新窗口再漏一次。
 */
const AUXILIARY_WINDOW_QUERY_KEYS = [
  'view',
  'sidebarWindow',
  'sidebarTabWindow',
  'resourceUsageWindow',
  'remoteDesktopViewer',
  'recordingPreview',
  'regionScreenshot',
  'regionScreenshotEditor',
  'regionScreenshotPin',
] as const;

/** 右侧栏独立窗的 hash 路由标签(兜底:即使将来 query 变了也不误投)。 */
const SIDEBAR_WINDOW_HASH = '/sidebar-window';

/**
 * 这个 URL 对应的窗口能否承载主机模态确认框。
 *
 * 纯函数(只收 URL 字符串,不碰 Electron),便于单测直测。空串 / 非法 URL /
 * `about:blank`(窗口刚建还没 load)一律 false:宁可回 UNAVAILABLE,也不把模态框
 * 投进一个还不知道加载了什么的窗口。
 */
export function isModalConfirmHostUrl(rawUrl: string): boolean {
  if (!rawUrl.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'file:' && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  if (AUXILIARY_WINDOW_QUERY_KEYS.some((key) => parsed.searchParams.has(key))) return false;
  if (parsed.hash.includes(SIDEBAR_WINDOW_HASH)) return false;
  // 主窗口不带 secondaryWindow;完整会话副窗必须显式 `=1`。`=0` 按主窗口对待
  //(与 scheduleSlot.isMainShellWindowUrl 同口径:它取 ==='1' 而非 has());其它取值
  // 现在没有确认宿主,失败关闭比猜它"应该也是完整壳"安全。
  const secondaryWindow = parsed.searchParams.get('secondaryWindow');
  return secondaryWindow === null || secondaryWindow === '0' || secondaryWindow === '1';
}

/**
 * 窗口级判据:受信 Cindy renderer + URL 是完整主壳。
 *
 * `isTrustedAppRendererWindow` 负责 app-content 登记与当前 URL 仍是 Cindy renderer;
 * 本函数补上「它加载的必须是会挂 confirm 宿主的那个入口」。读取 URL 失败(渲染进程
 * 已退出、frame 已释放)按不可承载处理,不抛。
 */
export function isModalConfirmHostWindow(win: BrowserWindow | null | undefined): boolean {
  if (!win || !isTrustedAppRendererWindow(win)) return false;
  try {
    return isModalConfirmHostUrl(win.webContents.getURL());
  } catch {
    return false;
  }
}
