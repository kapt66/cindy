/**
 * 管理页串流的**多窗口 owner 账本 / 启动在途取消 / 主动关闭定向投递**（2026-11-27 复审 P1）。
 *
 * 测试价值
 * - 生产入口与可观察结果：`registerPsbRemoteIpc()` 注册的 `admin-stream-start` /
 *   `admin-stream-stop` handler（`ipc.ts`）+ `push.ts` 的 `broadcastPsbAdminStreamEvent`。
 *   用户可观察结果是四件事：① 两个窗口看同一工作区时，先走的窗口只减计数、最后一个窗口
 *   才真的停流；② 窗口在「启动还在路上」时卸载 / 停止，不会留下没人认领的观看连接与 owner；
 *   ③ 本端主动关闭的 `closed` 只发给正在看这条连接的窗口，不会把另一个只是打开着同一工作区
 *   页面的窗口判成「串流被关闭」；④ 窗口在**启动在途被销毁**时，落定后不登记 owner，并按
 *   「没有观看者」把刚起来的流收掉（否则 owner 永不归零，之后最后离开者也不停流）。
 * - Bug／规则依据：2026-11-27 复审 s1/s4 P1 + 终局复审 P1 —— 旧实现 owner 引用计数在三种
 *   时序下泄漏：
 *   (a) 启动成功后 `closed(superseded)` 广播导致另一窗口回 idle、不再发 stop；
 *   (b) `starting` 相位卸载时 stop 早于 `STREAM_START` 落定（当时 `untrack` 是 no-op，停止丢失）；
 *   (c) 窗口在 `STREAM_START` 在途被销毁：`destroyed` 回收监听是登记时才挂的，已销毁的 sender
 *   不会再回调，落定处登记 owner 即永久残留。
 *   泄漏的终点是「最后一个窗口停止时流不停 + PSB 观看名额被自己占满」（名额与浏览器端共用）。
 *   `ipc.ts` 需要 Electron 才能直接跑，本文件用最小 `electron` 替身驱动**真实 handler 与推送**，
 *   替换的是宿主 API，不是被测逻辑。工程口径见
 *   `docs/dev-rules/psb-remote-session-transport.md` §11.3/§11.4、§15.3。
 * - 现有覆盖缺口：owner 计数此前只有 `streamOwners.ts` 的纯结构单测与一条源码 guard；「谁该收到
 *   closed」「启动在途时的 stop 会不会丢」「启动在途窗口被销毁」没有任何运行期证据。
 * - 最小失败输入：① A、B 两个窗口 start → A stop 时若直接停流，B 的画面会黑；
 *   ② start 在途时 stop → 若 stop 丢失，启动落定后 owner 永久残留；③ `client-stopped` 事件若
 *   广播，未观看的第三个窗口也会收到一条它不该看到的「关闭」；④ start 在途时 sender 被销毁 →
 *   若照样登记 owner，之后最后一个观看者离开时 `streamStop` 不会被调用。
 * - tier：unit（`electron` 用替身；无真实窗口 / PSB / 网络）。
 * - 实测耗时：单独运行约 1.8s（其中 6 条用例 <10ms；其余为 vitest 启动与模块加载）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** handler 表 / 窗口表：`vi.hoisted` 让 `vi.mock` 工厂能引用（mock 会被提升到 import 之前）。 */
const host = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
  windows: [] as Array<Record<string, unknown>>,
  contents: new Map<number, Record<string, unknown>>(),
  admin: {
    streamStart: vi.fn(),
    streamStop: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      host.handlers.set(channel, handler);
    },
  },
  shell: { openExternal: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => host.windows,
    fromWebContents: (contents: Record<string, unknown>) => contents['window'] ?? null,
  },
  webContents: {
    fromId: (id: number) => host.contents.get(id) ?? null,
  },
}));

// 来源校验 / 受信窗口判据：被测逻辑是账本与投递，不是安全边界（后者有自己的单测）。
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: () => {},
  isTrustedAppRendererWindow: (win: Record<string, unknown>) => win['trusted'] !== false,
}));

// 管理页服务用假实现：本文件只验证 ipc 的 owner 账本与「启动在途取消」判据。
vi.mock('../adminRuntime.js', () => ({
  getPsbWorkspaceAdminService: () => host.admin,
  disposePsbWorkspaceAdminService: () => {},
  PSB_ADMIN_RECENT_WORKSPACE_FILE: 'psb-remote-workspace-admin.json',
}));

// 会话释放账本与捕获态：与本文件无关，装配时被 import 到而已。
vi.mock('../../maker-host/psb-workspace-session-release.js', () => ({
  listPendingWorkspaceReleases: () => [],
  onPendingWorkspaceReleasesChanged: () => () => {},
  releasePsbWorkspaceForSession: vi.fn(),
  retryPendingWorkspaceReleases: vi.fn(),
}));
vi.mock('../streamCaptureRuntime.js', () => ({ updatePsbStreamCapture: () => {} }));
// PSB 远程服务图很重（登录态 / 网络 / maker-host），本文件不需要任何一条它的通道。
vi.mock('../index.js', () => ({ getPsbRemoteService: () => ({}) }));

import { PSB_ADMIN_CHANNELS } from '../../../shared/psb-workspace-admin';
import type { PsbWorkspaceAdminStreamStatus } from '../../../shared/psb-workspace-admin';
import type { PsbStreamEvent } from '../../../shared/psb-remote-workspace';
import { registerPsbRemoteIpc } from '../ipc';
import { broadcastPsbAdminStreamEvent } from '../push';

const STREAM_STATUS: PsbWorkspaceAdminStreamStatus = {
  capability: true,
  active: false,
  width: 1920,
  height: 1080,
  fps: 30,
  encoder: 'h264',
  lastErrorZh: null,
  desktopSession: 'running',
  reasonCode: null,
};

/** 已被销毁的 sender id（`invokeEvent` 的 `isDestroyed()` 读它）。 */
const destroyedSenders = new Set<number>();

/** 一个受信窗口：webContents.id 就是 owner id（生产 = `event.sender.id`）。 */
function addWindow(id: number): {
  readonly sent: Array<{ channel: string; payload: unknown }>;
} {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const contents: Record<string, unknown> = {
    id,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
    },
  };
  const win: Record<string, unknown> = { trusted: true, webContents: contents };
  contents['window'] = win;
  host.contents.set(id, contents);
  host.windows.push(win);
  return { sent };
}

/** `ipcMain.handle` 收到的最小 invoke 事件面（只用到 sender.id / sender.once / sender.isDestroyed）。 */
function invokeEvent(id: number): Record<string, unknown> {
  return { sender: { id, once: () => {}, isDestroyed: () => destroyedSenders.has(id) } };
}

/**
 * 模拟「窗口在 `STREAM_START` 还在路上时被销毁」：生产里 `event.sender` 是 webContents，
 * 销毁后 `isDestroyed()` 为 true，且**登记 owner 时才挂**的 `destroyed` 监听不会再来。
 */
function markSenderDestroyed(id: number): void {
  destroyedSenders.add(id);
}

function handler(channel: string): (event: unknown, payload: unknown) => Promise<unknown> {
  const entry = host.handlers.get(channel);
  if (!entry) throw new Error(`IPC handler not registered: ${channel}`);
  return entry;
}

async function startStream(ownerId: number, workspaceId: string): Promise<unknown> {
  return handler(PSB_ADMIN_CHANNELS.STREAM_START)(invokeEvent(ownerId), { workspaceId });
}

async function stopStream(ownerId: number, workspaceId: string): Promise<unknown> {
  return handler(PSB_ADMIN_CHANNELS.STREAM_STOP)(invokeEvent(ownerId), { workspaceId });
}

beforeEach(() => {
  host.handlers.clear();
  host.windows.length = 0;
  host.contents.clear();
  destroyedSenders.clear();
  host.admin.streamStart.mockReset();
  host.admin.streamStop.mockReset();
  host.admin.streamStop.mockResolvedValue(undefined);
  // 生产语义：每次 start 返回**同一条**观看端绑定（工作区级订阅复用桌面访问会话）。
  host.admin.streamStart.mockImplementation(async (workspaceId: string) => ({
    status: STREAM_STATUS,
    workspaceId,
    viewerSessionId: `viewer-${workspaceId}`,
  }));
  registerPsbRemoteIpc();
});

describe('管理页串流多窗口 owner 账本（真实 IPC handler）', () => {
  it('A、B 两个窗口看同一工作区：A 停止只减计数，最后离开的 B 才真的停流', async () => {
    const workspaceId = 'ws-multi-1';
    const viewerSessionId = `viewer-${workspaceId}`;
    const a = addWindow(1);
    const b = addWindow(2);
    const onlooker = addWindow(3);
    await startStream(1, workspaceId);
    await startStream(2, workspaceId);

    // 帧定向投递证明两个窗口都登记成了 owner（与 start 的先后无关）。
    broadcastPsbAdminStreamEvent({
      type: 'frame',
      sessionId: viewerSessionId,
      payload: new ArrayBuffer(4),
    });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(onlooker.sent).toHaveLength(0);

    // A 离开：只减计数，不能停流（B 还在看）。
    await stopStream(1, workspaceId);
    expect(host.admin.streamStop).not.toHaveBeenCalled();
    a.sent.length = 0;
    b.sent.length = 0;
    broadcastPsbAdminStreamEvent({
      type: 'frame',
      sessionId: viewerSessionId,
      payload: new ArrayBuffer(4),
    });
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(1);

    // 最后一个观看者离开：真的停流。
    await stopStream(2, workspaceId);
    expect(host.admin.streamStop).toHaveBeenCalledTimes(1);
    expect(host.admin.streamStop).toHaveBeenCalledWith(workspaceId, { localSessionId: null });
  });

  it('启动还在路上时收到停止（starting 相位卸载）：不登记 owner，启动落定后把流收掉', async () => {
    const workspaceId = 'ws-multi-2';
    const viewerSessionId = `viewer-${workspaceId}`;
    const window = addWindow(1);
    const onlooker = addWindow(2);
    let resolveStart: ((value: unknown) => void) | null = null;
    host.admin.streamStart.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );

    const starting = startStream(1, workspaceId);
    // 渲染层在 starting 相位卸载：stop 先到（此刻 `STREAM_START` 还挂在 PSB 上）。
    await stopStream(1, workspaceId);

    // 启动落定：这一次启动不能把 owner 登记上（窗口已经不在观看态）。
    resolveStart!({ status: STREAM_STATUS, workspaceId, viewerSessionId });
    await starting;

    // 没有观看者 → 刚起来的流必须被收掉（否则是一条没人认领的观看连接）。
    expect(host.admin.streamStop).toHaveBeenCalled();
    // 未登记 owner 的行为证据：本端主动关闭**定向**只发给该连接的 owner，这里一个都没有，
    // 所以谁都不该收到（若启动落定后误登记了 owner，窗口 1 会收到这条事件）。
    broadcastPsbAdminStreamEvent({
      type: 'closed',
      sessionId: viewerSessionId,
      reason: 'client-stopped',
      detail: { reasonCode: null, desktopSession: null, messageZh: null },
    });
    expect(window.sent).toHaveLength(0);
    expect(onlooker.sent).toHaveLength(0);

    // 取消标记只对这一次启动有效：同一个窗口下一次启动正常登记 owner（帧只发给它）。
    host.admin.streamStart.mockImplementation(async () => ({
      status: STREAM_STATUS,
      workspaceId,
      viewerSessionId,
    }));
    await startStream(1, workspaceId);
    broadcastPsbAdminStreamEvent({
      type: 'frame',
      sessionId: viewerSessionId,
      payload: new ArrayBuffer(4),
    });
    expect(window.sent).toHaveLength(1);
    expect(onlooker.sent).toHaveLength(0);
    // 收尾：把这条工作区账本清空，用例之间不互相污染。
    await stopStream(1, workspaceId);
  });

  it('窗口在启动在途被销毁：落定后不登记 owner，并按「没有观看者」停流', async () => {
    // 2026-11-27 终局复审 P1：`destroyed` 回收监听是登记 owner 时才挂的；窗口在 PSB 启动
    // 在途被关掉时，落定后给已销毁的 webContents 登记 owner，owner 永不归零 —— 之后别的窗口
    // 「最后离开」不会停流，PSB 观看名额（与网页观看端共用）泄漏到进程退出。
    const workspaceId = 'ws-destroyed-in-flight';
    const viewerSessionId = `viewer-${workspaceId}`;
    const window = addWindow(1);
    let resolveStart: ((value: unknown) => void) | null = null;
    host.admin.streamStart.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );

    const starting = startStream(1, workspaceId);
    markSenderDestroyed(1);
    resolveStart!({ status: STREAM_STATUS, workspaceId, viewerSessionId });
    await starting;

    // 没有观看者 → 刚起来的流必须被收掉（旧实现：owner 登记成功，之后谁都不会再停它）。
    expect(host.admin.streamStop).toHaveBeenCalledTimes(1);
    expect(host.admin.streamStop).toHaveBeenCalledWith(workspaceId, { localSessionId: null });
    // 未登记 owner 的行为证据：本端主动关闭的定向投递一个窗口都不该收到。
    broadcastPsbAdminStreamEvent({
      type: 'closed',
      sessionId: viewerSessionId,
      reason: 'client-stopped',
      detail: { reasonCode: null, desktopSession: null, messageZh: null },
    });
    expect(window.sent).toHaveLength(0);

    // 账本没有残留 owner：另一个窗口开始观看、最后离开时仍然能真正停流（若旧 owner 泄漏，
    // 这里会因为「还有观看者」而不再停流）。
    addWindow(2);
    await startStream(2, workspaceId);
    await stopStream(2, workspaceId);
    expect(host.admin.streamStop).toHaveBeenCalledTimes(2);
  });
});

describe('管理页串流主动关闭的定向投递（push.ts）', () => {
  function closedEvent(
    reason: string,
    sessionId: string,
  ): Extract<PsbStreamEvent, { type: 'closed' }> {
    return {
      type: 'closed',
      sessionId,
      reason,
      detail: { reasonCode: null, desktopSession: null, messageZh: null },
    };
  }

  it('本端主动关闭只发给该连接的 owner；没有 owner 时发给任何人都不对', async () => {
    const workspaceId = 'ws-multi-3';
    const viewerSessionId = `viewer-${workspaceId}`;
    const a = addWindow(1);
    const b = addWindow(2);
    // 第三个窗口只是打开着同一工作区页面（没有启动观看）：它不该收到别人的关闭事件。
    const onlooker = addWindow(3);
    await startStream(1, workspaceId);
    await startStream(2, workspaceId);

    broadcastPsbAdminStreamEvent(closedEvent('client-stopped', viewerSessionId));
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(onlooker.sent).toHaveLength(0);
    expect(a.sent[0]?.channel).toBe(PSB_ADMIN_CHANNELS.STREAM_EVENT);

    // 最后一个观看者也走了：这条 closed 没有任何窗口需要（不是广播给「打开着页面的人」）。
    await stopStream(1, workspaceId);
    await stopStream(2, workspaceId);
    a.sent.length = 0;
    b.sent.length = 0;
    broadcastPsbAdminStreamEvent(closedEvent('client-stopped', viewerSessionId));
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(0);
    expect(onlooker.sent).toHaveLength(0);
  });

  it('远端关闭（未就绪 / 会话结束）仍然广播：每个展示该工作区的窗口都要收敛状态', () => {
    const a = addWindow(1);
    const onlooker = addWindow(2);

    broadcastPsbAdminStreamEvent(closedEvent('not-ready', 'viewer-someone-else'));

    expect(a.sent).toHaveLength(1);
    expect(onlooker.sent).toHaveLength(1);
  });

  it('帧仍然只发给该连接的 owner（定向投递的既有语义不变）', async () => {
    const workspaceId = 'ws-multi-4';
    const viewerSessionId = `viewer-${workspaceId}`;
    const owner = addWindow(1);
    const onlooker = addWindow(2);
    await startStream(1, workspaceId);

    broadcastPsbAdminStreamEvent({
      type: 'frame',
      sessionId: viewerSessionId,
      payload: new ArrayBuffer(4),
    });

    expect(owner.sent).toHaveLength(1);
    expect(onlooker.sent).toHaveLength(0);

    // 收尾：把这条工作区账本清空，用例之间不互相污染。
    await stopStream(1, workspaceId);
  });
});
