/**
 * confirmDialogWindow.test — 「可承载模态确认框的窗口」URL 判据的纯函数单测。
 *
 * Bug 依据(2026-11-19 用户实测):插件 confirm 槽只投一个窗口,旧装配取
 * `focused ?? getAllWindows()[0]`。focused 可能是右侧栏独立窗 / 资源用量窗 /
 * utility 浮窗——它们只挂轻量 renderer + 专用 preload,**没有 GhostConfirmDialogHost**,
 * 结果确认框「小窗/白屏/点不到」或干脆看不见,插件只能等到 90s 超时。
 * 最小失败输入:任意 sidebarWindow=1 的 URL 被判为可投 → 模态框投进画不出来的窗口。
 *
 * 这里锁住生产入口 `isModalConfirmHostUrl`(bootstrap client-mode 与本地 confirm
 * 槽共用)的窗口口径:只认完整主壳(主窗口 / `?secondaryWindow=1`),辅助窗口全排除。
 */

import { describe, expect, it } from 'vitest';

import { isModalConfirmHostUrl } from '../confirmDialogWindow';
import { isMainShellWindowUrl } from '../cindy-brain/scheduleSlot';

const MAIN_SHELL_URLS = [
  // 主窗口:dev server origin,无 query。
  'http://localhost:5173/index.html',
  // 主窗口:packaged file URL,无 query;hash 是应用内路由。
  'file:///app/renderer/index.html',
  'file:///app/renderer/index.html#/cc-agent/0b1c2d3e',
  // 主窗口带无害 query;secondaryWindow=0 按主窗口对待(与 isMainShellWindowUrl 同口径)。
  'file:///app/renderer/index.html?foo=1#/cc-agent',
  'file:///app/renderer/index.html?secondaryWindow=0#/cc-agent',
];

const FULL_SESSION_URLS = [
  'file:///app/renderer/index.html?secondaryWindow=1&bootSession=s1#/cc-agent/boot',
  'http://localhost:5173/index.html?secondaryWindow=1&bootSession=s1&bootDevice=d1#/cc-agent/boot',
];

const AUXILIARY_URLS = [
  ['右侧栏独立窗', 'file:///app/renderer/index.html?sidebarWindow=1#/sidebar-window'],
  ['右侧栏单页签弹出窗', 'file:///app/renderer/index.html?sidebarWindow=1&sidebarTabWindow=1#/sidebar-window'],
  ['资源用量窗', 'file:///app/renderer/index.html?resourceUsageWindow=1#/resource-usage-window'],
  ['远程桌面查看器', 'http://localhost:5173/?remoteDesktopViewer=1#/remote-desktop'],
  ['录制预览浮层', 'file:///app/renderer/index.html?recordingPreview=1'],
  ['截图选区浮层', 'file:///app/renderer/index.html?regionScreenshot=1'],
  ['截图编辑器', 'file:///app/renderer/index.html?regionScreenshotEditor=1'],
  ['截图贴图', 'file:///app/renderer/index.html?regionScreenshotPin=1'],
  ['utility 语音浮窗', 'file:///app/renderer/index.html?view=voice-input-overlay'],
  ['插件沙箱逻辑页', 'cindy-ghost://art/__boot__'],
  ['刚建还没 load 的窗口', 'about:blank'],
  ['空串', ''],
] as const;

describe('isModalConfirmHostUrl · 只认挂确认宿主的完整主壳', () => {
  it.each(MAIN_SHELL_URLS)('主窗口可承载:%s', (url) => {
    expect(isModalConfirmHostUrl(url)).toBe(true);
    // 主窗口同时是自动化草稿等单窗口能力的合法目标(两套判据不矛盾)。
    expect(isMainShellWindowUrl(url)).toBe(true);
  });

  it.each(FULL_SESSION_URLS)('完整会话副窗可承载(confirm 宿主在 App.tsx 里):%s', (url) => {
    expect(isModalConfirmHostUrl(url)).toBe(true);
    // 会话副窗不是"主壳"的草稿目标(能接住 ≠ 该接住),两套判据刻意不同。
    expect(isMainShellWindowUrl(url)).toBe(false);
  });

  it.each(AUXILIARY_URLS)('%s 不可承载(fail closed,不投辅助窗口)', (_label, url) => {
    expect(isModalConfirmHostUrl(url)).toBe(false);
  });

  it('非 app 页面协议一律不可承载(不猜自定义 scheme 是否也能画确认框)', () => {
    expect(isModalConfirmHostUrl('devtools://devtools/bundled/inspector.html')).toBe(false);
    expect(isModalConfirmHostUrl('not a url')).toBe(false);
  });
});
