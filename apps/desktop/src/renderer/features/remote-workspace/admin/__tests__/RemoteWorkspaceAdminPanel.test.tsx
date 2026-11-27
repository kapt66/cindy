// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：`RemoteWorkspaceAdminPanel`（「远程工作区」全局页签的真实页面主体）。
 *   可观察的是「页面围绕**工作区**工作，不围绕当前任务」这件事：
 *     ① 页头是**单行 ≤40px**：**工作区实例名（目录名）最显眼**（13px + 中粗）→ 模板名 · 机器名
 *        → 占用，三块**靠左紧凑**、固定 16px 间距依次紧挨（不撑开），逐段截断、不换行；
 *        目录名就是主标题，**不再单独显示目录段**；右侧通用操作（占用 / 解除占用 / 在网页打开）
 *        靠右且不被窄窗口挤压；
 *     ② 分类导航左对齐紧凑排列（inline 轨道、不拉伸铺满、不参与 space-between）；
 *     ③ 三个分类（远程连接 / 版本控制 / 设置）可切换，后两个是统一占位空态、没有假按钮；
 *     ④ 远程连接横条控制区（启动 / 停止是同一个按钮切换、详情浮层、串流信息、全屏 + 状态文案）
 *        与占满剩余高度的画面；
 *        详情是 Popover 浮层，**开合不改变任何布局**（控制条高度/子节点、画面容器 class 都不变）；
 *     ⑤ 全屏是极简模式（对齐 PSB 网页）：全屏画面里不再渲染控制条，只剩右下角一个图标切换按钮，
 *        已开启的「串流信息」HUD 仍在右上角；Esc / 按钮都能退出；
 *     ⑥ 数据只来自 `adminContext`，**从不读当前任务的 PSB 会话状态**（mock 里放了一个
 *        会话级 `sessionStatus`，本页不得调用）；Agent 任务结束与否不影响启动 / 停止；
 *     ⑦ 跟随主进程推送的**工作区变化**（`onAdminContextChanged`）：换工作区即换信息条、
 *        旧工作区的观看名额被释放；
 *     ⑧ 没有可用工作区 / preload 缺管理桥 / 读取失败时，都有对应空态，且页头与分类导航仍保留；
 *     ⑨ **串流生命周期**（2026-11-26 改口）：进入页面**不自动开播**（远端 running / active 也
 *        不触发），点「启动」才订阅；离开页签仍自动 `adminStreamStop` 释放名额，回来需要用户
 *        再点「启动」；
 *     ⑩ **可交互观看**（2026-11-26）：订阅后指针 / 键盘 / 滚轮经工作区级 `adminStreamInput`
 *        转发，坐标是远端屏幕像素；全屏时普通键转发并拦宿主默认行为、F5 留给宿主；失焦补发
 *        release-all；输入通道缺失时降级为「只读观看」标签且不转发；
 *     ⑪ **串流信息 HUD / 停止清屏**（2026-11-26）：HUD 显示最近 1s FPS、码率、解码耗时、丢帧、
 *        队列等真实统计（缺字段「—」），全屏保留；停止 / closed 后画面立即清空；「在网页打开」
 *        遇到工作区已不存在时给专门的可行动文案。
 *     ⑫ **宿主光标形状同步**（2026-11-26，同日改口径）：订阅建立后 `stream.cursor` 的
 *        `name` 映射成**宿主风格 CSS 关键字**、且**只在鼠标停在画面区域（canvas）时**写到
 *        `canvas.style.cursor`；移出画面立即恢复宿主默认、重新进入用缓存形状；旧 serial 不丢弃
 *        （真机日志证明 PSB serial 不严格单调）、别的观看端的形状被忽略；停止 / closed / 错误 /
 *        卸载后恢复宿主默认光标；HUD 与全屏退出按钮显式 `cursor-default` / `cursor-pointer`，
 *        不继承远端形状；全屏时 canvas 仍在 stage 里，样式继续生效。不再生成 PNG data URL。
 *        （这一条由文档复审 2026-11-26 补充：旧实现写 stage + 位图自定义光标，口径已作废。）
 *     ⑬ **「串流中」只认首帧 / 停止失败也清屏 / 边沿保序**（2026-11-26 独立审查修复）：
 *        `streaming` 只由 `frame` 事件置 true（`status.active` 既不能提前点亮，也不能在帧仍在到
 *        时把它切回未启动，启动后到首帧之间显示「已连接，等待画面…」）；`adminStreamStop` reject
 *        时同样清空画面并复位成未启动（手动停止与页签隐藏的自动停止都覆盖），失败只留一条中性
 *        可行动提示；`capability:false` 时点「启动」给原因而不是静默；同一帧里「移动 → 按下」按
 *        这个顺序发出（移动经 rAF 合并、边沿经 `pump.sendEdge` 先冲刷）。
 *     ⑭ **版本控制检查通知的页面接线**（2026-11-26，CINDY-RW-10）：main 广播 advisory 后，版本
 *        控制分类从统一占位空态切换为 `variant="inline"` 的内联提示条（查看详情 / 一键清理 /
 *        继续）；「一键清理」先二次确认、确认后才按 kind + `confirm:true` 调
 *        `runWorkspaceVcsAction`（202 后出现「清理已开始」）；「继续」关提示并调
 *        `runWorkspaceVcsAction({kind:'continue'})` 清 main 缓存（否则换窗口 / hydrate 复现已忽略
 *        的提示，VCS 现行口径）；页头占用 / 解除占用成功后兜底 `hydrateWorkspaceVcsNotice`
 *        （推送已覆盖时幂等）。
 *     ⑮ **多窗口 owner 语义**（2026-11-27 复审 P1）：`closed(superseded)` 是**非终态**（同会话新
 *        连接继续送帧：保留相位 / 画面、不提示、不释放 owner）；事件驱动的结束（PSB 关闭 /
 *        错误断开）必须向 main 发一次「仅释放 owner」（否则 owner 计数泄漏、最后一个窗口停止时
 *        流不停）；`starting` 相位卸载也要发 stop（旧实现只在 connected 发，启动落定后成僵尸
 *        订阅）。
 * - Bug / 规则依据：用户 2026-11-26 两轮口径（入口与页面改为「远程工作区」；页头右侧通用操作、
 *   分类左对齐、详情改浮层、新增全屏；串流可交互 + 进入页面不自动开播）；产品正本
 *   `docs/product-rules/psb-remote-workspace-sessions.md` §2.4 / §2.7 / §6；工程契约
 *   `docs/dev-rules/psb-remote-session-transport.md` §13.5；契约正本
 *   `apps/desktop/src/shared/psb-workspace-admin.ts`、`shared/psb-remote-workspace.ts` 与
 *   `shared/psb-workspace-vcs.ts`。
 * - 现有覆盖缺口：旧页面测试锁的是「跟随当前任务 + 会话终态文案」，与工作区级语义相反；
 *   本文件覆盖工作区级跟随、页头操作、分类对齐、浮层不改布局、全屏、空态与解耦，以及本轮的
 *   串流生命周期（手动启动 / 离开释放）/ 输入转发 / 释放策略。
 * - 最小失败输入：页面重新调用 `sessionStatus`；信息行换行把布局推高；分类控件被拉伸铺满；
 *   详情插进布局把画面顶下去；切工作区不释放旧观看名额；缺桥时崩溃或整页空白；打开页面必须
 *   手动点启动；页签不可见仍占观看名额；黑边坐标发成 0,0；失焦不补 keyup。
 * - tier：unit（jsdom + RTL，无真实 PSB / Electron）。
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import type { TabKindHostContext } from '@/features/right-sidebar/types';
import type {
  PsbWorkspaceAdminContext,
  PsbWorkspaceAdminStreamStatus,
} from '../../../../../shared/psb-workspace-admin';
import type { WorkspaceVcsNotice } from '../../../../../shared/psb-workspace-vcs';
import {
  psbStreamCursorKeyword,
  type PsbStreamCursorShape,
} from '../../../../../shared/psb-remote-workspace';
import { toast } from '@/lib/toast';
import { resetWorkspaceVcsNoticeStoreForTest } from '../../vcs/vcsNoticeStore';
import { RemoteWorkspaceAdminPanel } from '../RemoteWorkspaceAdminPanel';

// jsdom 没有 WebCodecs / canvas 2D：换成假播放器，让「启动 → 已订阅」这条路可以走通。
// 统计 / 清屏也在这层可控：HUD 与「停止后清空画面」的断言不依赖真实解码器。
// `createCount` 用来钉住「播放器实例只在 canvas 挂载时创建一次」：观看中切 UI 语言不能
// dispose + 重建（新实例拿不到上一次的 config，画面会白掉）。
const playerMock = vi.hoisted(() => ({
  push: vi.fn(),
  dispose: vi.fn(),
  clear: vi.fn(),
  createCount: 0,
  stats: {
    codec: 'avc1.42E01E' as string | null,
    queueDepth: 0,
    droppedFrames: 0,
    decodeLatencyAvgMs: null as number | null,
    decodeLatencyP95Ms: null as number | null,
  },
}));

vi.mock('../../stream/psbStreamPlayer', () => ({
  createPsbStreamPlayer: () => {
    playerMock.createCount += 1;
    return {
      push: playerMock.push,
      dispose: playerMock.dispose,
      clear: playerMock.clear,
      getStats: () => ({ ...playerMock.stats }),
    };
  },
}));

// 详情浮层用受控的轻量替身：模拟 Popover 的开合语义，避免 Radix 在 jsdom 里依赖
// ResizeObserver / 浮层定位；生产代码仍使用仓库共享 Popover 组件。
vi.mock('@/components/ui/popover', async () => {
  const React = await import('react');
  const ReactDOM = await import('react-dom');
  const PopoverState = React.createContext<{
    open: boolean;
    onOpenChange?: (open: boolean) => void;
  }>({ open: false });
  return {
    Popover: ({
      children,
      open = false,
      onOpenChange,
    }: {
      children: React.ReactNode;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) => <PopoverState.Provider value={{ open, onOpenChange }}>{children}</PopoverState.Provider>,
    PopoverTrigger: ({ children }: { children: React.ReactNode }) => {
      const state = React.useContext(PopoverState);
      const child = children as React.ReactElement<{ onClick?: React.MouseEventHandler }>;
      return React.cloneElement(child, {
        onClick: (event) => {
          child.props.onClick?.(event);
          state.onOpenChange?.(!state.open);
        },
      });
    },
    // 真实 Popover 的内容 portal 到 body：替身保持同样的「不占宿主布局」语义，才能验证
    // 「打开详情不改变控制条 / 画面的布局」。
    PopoverContent: ({ children }: { children: React.ReactNode; portalContainer?: unknown }) => {
      const state = React.useContext(PopoverState);
      if (!state.open) return null;
      return ReactDOM.createPortal(
        <div data-testid="remote-workspace-admin-details-overlay">{children}</div>,
        document.body,
      );
    },
  };
});

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

/**
 * 「需要先占用」确认框的替身。
 *
 * 页面本身不用 `useConfirmDialog`（VCS 清理走内联确认），但串流的占用待确认路径经
 * `useOptionalConfirmDialog` 取全局确认框；裸渲染没有 Provider 时它会返回 null（降级成普通失败）。
 * 这里给一个可断言的替身，钉住「确认 → 占用 → 重试」与「取消 → 不占用不重试」两条路径。
 */
const confirmDialogMock = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('@/components/ui/confirm-dialog-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/confirm-dialog-provider')>()),
  useOptionalConfirmDialog: () => ({ confirm: confirmDialogMock.confirm }),
}));

const STREAM_ACTIVE: PsbWorkspaceAdminStreamStatus = {
  capability: true,
  active: true,
  width: 1920,
  height: 1080,
  fps: 30,
  encoder: 'avc1.42E01E',
  lastErrorZh: null,
  desktopSession: 'running',
  reasonCode: null,
};

/** 一条宿主光标形状（PSB `stream.cursor` 解包后的形状；尺寸 / 热点都取合法值）。 */
const CURSOR_SHAPE: PsbStreamCursorShape = {
  serial: 2,
  width: 32,
  height: 32,
  xhot: 5,
  yhot: 2,
  imageBase64: 'iVBORw0KGgo',
  name: 'text',
};

function context(patch: Partial<PsbWorkspaceAdminContext> = {}): PsbWorkspaceAdminContext {
  return {
    workspaceId: 'ws-a',
    clientName: 'Machine A',
    clientOnline: true,
    title: 'Workspace A',
    templateTitle: 'Saga2',
    directoryName: 'proj-a',
    state: 'ready',
    occupancy: { occupied: true, byMe: true, personName: 'Me' },
    desktopSession: null,
    reasonCode: null,
    lastErrorZh: null,
    source: 'session',
    viewerSessionId: 'viewer-a',
    stale: false,
    availability: 'live',
    staleReason: null,
    snapshotSavedAt: null,
    workspaceIdKnown: true,
    ...patch,
  };
}

/** stale（固定信息来自本机快照）上下文：页头照旧，状态类信息未知。 */
function staleContext(patch: Partial<PsbWorkspaceAdminContext> = {}): PsbWorkspaceAdminContext {
  return context({
    stale: true,
    availability: 'unavailable',
    staleReason: 'list-failed',
    snapshotSavedAt: '2026-11-26T00:00:00.000Z',
    viewerSessionId: null,
    desktopSession: null,
    reasonCode: null,
    lastErrorZh: '连不上 PSB',
    occupancy: { occupied: false, byMe: false, personName: '' },
    ...patch,
  });
}

/**
 * 旧会话级桥方法（`sessionStatus`）故意也放进 mock：本页不得调用它 —— 那是「页面还依赖
 * 当前任务」的直接证据。它存在但零调用，是解耦断言的对照物。
 */
const bridge = {
  adminContext: vi.fn(),
  onAdminContextChanged: vi.fn(),
  adminStreamStart: vi.fn(),
  adminStreamStop: vi.fn(),
  adminStreamStatus: vi.fn(),
  onAdminStreamEvent: vi.fn(),
  occupyWorkspace: vi.fn(),
  releaseWorkspace: vi.fn(),
  openWebWorkspace: vi.fn(),
  /** 工作区级输入通道（可交互观看）；缺方法的降级路径由专门用例覆盖。 */
  adminStreamInput: vi.fn(),
  /** 画面捕获态开关（全屏时让 main 抑制宿主快捷键）。 */
  setAdminStreamCaptureActive: vi.fn(),
  sessionStatus: vi.fn(),
  /** 版本控制检查通知（CINDY-RW-10）：main 广播 → store → 版本控制分类的内联提示条。 */
  workspaceVcsNotice: vi.fn(),
  onWorkspaceVcsNotice: vi.fn(),
  runWorkspaceVcsAction: vi.fn(),
};

let pushContext:
  | ((event: {
      context: PsbWorkspaceAdminContext | null;
      localSessionId?: string | null;
    }) => void)
  | null = null;
/**
 * 串流事件监听者集合。
 *
 * 生产 preload 的 `onAdminStreamEvent` 是 fan-out（`createIpcFanOut`），同一条广播可以有多个
 * 监听者：画面事件归连接区、宿主光标形状归 `usePsbStreamCursor`。测试替身必须保留这个语义，
 * 否则「多个 hook 各订阅一次」会互相顶掉。
 */
const streamEventHandlers = new Set<(event: unknown) => void>();

function pushStreamEvent(event: unknown): void {
  for (const handler of [...streamEventHandlers]) handler(event);
}

/** main → renderer 的版本控制通知处理器（页面 hook 通过 `onWorkspaceVcsNotice` 订阅）。 */
const vcsNoticeHandlers = new Set<(event: unknown) => void>();

/** 模拟 main 的广播（与占用 / 释放成功后 `emitWorkspaceVcsNotice` 同形）。 */
function pushVcsNotice(notice: WorkspaceVcsNotice | null, workspaceId = 'ws-a'): void {
  for (const handler of [...vcsNoticeHandlers]) {
    handler({ workspaceId, operation: 'occupy', notice });
  }
}

/**
 * 0.1.180 advisory 样例（成功占用 / 释放后附带的建议）：「查看详情 / 一键清理 / 继续」。
 * 文案来自 PSB（`messageZh` / `descriptionZh`），Cindy 只展示。
 */
const VCS_ADVISORY: WorkspaceVcsNotice = {
  code: 'WORKSPACE_VCS_DIRTY',
  advisory: true,
  messageZh: '检测到未提交修改（1 个检出）',
  dirty: true,
  projects: [{ projectId: 1, pathInWorkspace: '.', kind: 'p4', changes: 3 }],
  actions: [
    {
      kind: 'inspect-vcs',
      method: 'GET',
      path: '/api/cindy/remote/workspaces/ws-a/vcs',
      descriptionZh: '查看未提交修改详情',
    },
    {
      kind: 'clean-workspace',
      method: 'POST',
      path: '/api/cindy/remote/workspaces/ws-a/vcs/revert',
      body: { projectIds: [1], confirm: 'revert' },
      descriptionZh: '一键清理',
    },
    { kind: 'continue', descriptionZh: '忽略提示，继续使用工作区' },
  ],
};

/** Fullscreen API 替身（jsdom 没有）：记录调用并模拟浏览器切换全屏元素。 */
let fullscreenElement: Element | null = null;
const requestFullscreen = vi.fn(function (this: HTMLElement) {
  fullscreenElement = this;
  return Promise.resolve();
});
const exitFullscreen = vi.fn(function () {
  fullscreenElement = null;
  return Promise.resolve();
});

function ctx(sessionId: string, remoteHostId: string | null): TabKindHostContext {
  return {
    tabId: 'tab-admin',
    sessionId,
    workdir: '',
    remoteHostId,
    patchState: () => {},
    onVisibilityChange: () => {},
    setCloseInterceptor: () => () => {},
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  // 占用确认框替身每个用例复位（`clearAllMocks` 不清实现）：默认「用户点了确认」。
  confirmDialogMock.confirm.mockReset();
  confirmDialogMock.confirm.mockResolvedValue(true);
  pushContext = null;
  streamEventHandlers.clear();
  vcsNoticeHandlers.clear();
  resetWorkspaceVcsNoticeStoreForTest();
  fullscreenElement = null;
  playerMock.createCount = 0;
  playerMock.stats = {
    codec: 'avc1.42E01E',
    queueDepth: 0,
    droppedFrames: 0,
    decodeLatencyAvgMs: null,
    decodeLatencyP95Ms: null,
  };
  bridge.adminContext.mockResolvedValue({ context: context() });
  // 默认「远端没在采集 / 桌面会话不知道」：老用例走手动「启动」路径；自动恢复由专门用例显式给
  // `desktopSession: 'running'` / `active: true` 触发。
  bridge.adminStreamStatus.mockResolvedValue({
    status: { ...STREAM_ACTIVE, active: false, desktopSession: null },
  });
  bridge.adminStreamStart.mockResolvedValue({
    status: STREAM_ACTIVE,
    workspaceId: 'ws-a',
    viewerSessionId: 'viewer-a',
  });
  bridge.adminStreamStop.mockResolvedValue(undefined);
  bridge.adminStreamInput.mockResolvedValue(undefined);
  bridge.setAdminStreamCaptureActive.mockResolvedValue(undefined);
  bridge.occupyWorkspace.mockResolvedValue({ workspace: {} });
  bridge.releaseWorkspace.mockResolvedValue({ workspace: {} });
  bridge.openWebWorkspace.mockResolvedValue(undefined);
  // 默认没有版本控制通知：既有用例看的就是「没有通知时保留占位空态」。
  bridge.workspaceVcsNotice.mockResolvedValue({ workspaceId: 'ws-a', notice: null });
  bridge.onWorkspaceVcsNotice.mockImplementation((handler: (event: unknown) => void) => {
    vcsNoticeHandlers.add(handler);
    return () => {
      vcsNoticeHandlers.delete(handler);
    };
  });
  bridge.runWorkspaceVcsAction.mockResolvedValue({
    workspaceId: 'ws-a',
    kind: 'clean-workspace',
    accepted: true,
    operationId: 'op-1',
    data: null,
  });
  bridge.onAdminContextChanged.mockImplementation(
    (
      handler: (event: {
        context: PsbWorkspaceAdminContext | null;
        localSessionId?: string | null;
      }) => void,
    ) => {
      pushContext = handler;
      return () => {};
    },
  );
  bridge.onAdminStreamEvent.mockImplementation((handler: (event: unknown) => void) => {
    streamEventHandlers.add(handler);
    return () => {
      streamEventHandlers.delete(handler);
    };
  });
  Object.assign(window, {
    electronAPI: { psbRemote: bridge as unknown as Record<string, unknown> },
  });
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    configurable: true,
    value: requestFullscreen,
  });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: exitFullscreen,
  });
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  });
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
  delete (document as { exitFullscreen?: unknown }).exitFullscreen;
});

/** 渲染并等首次 `adminContext` 返回。 */
async function renderPanel(input?: {
  sessionId?: string;
  active?: boolean;
  shellVisible?: boolean;
}) {
  const view = render(
    <RemoteWorkspaceAdminPanel
      state={{}}
      ctx={ctx(input?.sessionId ?? 'local-a', 'psb:psb-a')}
      active={input?.active ?? true}
      shellVisible={input?.shellVisible ?? true}
    />,
  );
  await act(async () => {});
  return view;
}

/** 输入事件经串行发送器的 promise 链排队：等微任务落定后再断言 IPC 调用。 */
async function flushInput(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

/**
 * 给 canvas 补上「远端 1920×1080 画面显示在 960×540 区域」的几何（jsdom 不做真实布局）。
 */
function stubCanvasGeometry(
  canvas: HTMLCanvasElement,
  size: { width: number; height: number; displayWidth: number; displayHeight: number },
): void {
  canvas.width = size.width;
  canvas.height = size.height;
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: size.displayWidth,
      height: size.displayHeight,
      right: size.displayWidth,
      bottom: size.displayHeight,
      toJSON: () => ({}),
    }),
  });
}

it('renders the workspace header as one compact left-aligned line with right-aligned actions', async () => {
  await renderPanel();
  const line = screen.getByTestId('remote-workspace-admin-workspace-line');
  // 结构契约（可见布局本身交给 `pnpm ui:check`）：信息组在左、名称 / 模板 · 机器 / 占用三段
  // 按顺序紧挨，右侧操作同在这条页头行里。
  const info = screen.getByTestId('remote-workspace-admin-workspace-info');
  const name = screen.getByTestId('remote-workspace-admin-workspace-name');
  const meta = screen.getByTestId('remote-workspace-admin-workspace-meta');
  const occupancy = screen.getByTestId('remote-workspace-admin-workspace-occupancy');
  expect(info.children[0]).toBe(name);
  expect(info.children[1]).toBe(meta);
  expect(info.children[2]).toBe(occupancy);
  // 不再有独立目录段：目录名就是主标题，页头里只出现一次（`proj-a`）。
  expect(screen.queryByTestId('remote-workspace-admin-workspace-directory')).toBeNull();
  // 页头行同时包含信息组与右侧操作（同一行，不是内容区里的独立浮层）。
  const actions = screen.getByTestId('remote-workspace-admin-actions');
  expect(within(line).getByTestId('remote-workspace-admin-actions')).toBe(actions);
  // 内容 = 实例名（目录名）/ 模板名 · 机器名 / 占用（自己占用时显示 PSB 回的名字并追加「（你）」）。
  expect(name.textContent).toBe('proj-a');
  expect(meta.textContent).toBe('Saga2 · Machine A');
  expect(occupancy.textContent).toBe(
    i18n.t('remoteWorkspace.admin.occupancyValue', {
      value: i18n.t('remoteWorkspace.admin.occupancySelfValue', { name: 'Me' }),
    }),
  );
  expect(
    screen.getByRole('button', { name: i18n.t('remoteWorkspace.admin.actionRelease') }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: i18n.t('remoteWorkspace.admin.actionOpenWeb') }),
  ).toBeTruthy();
});

it('omits the template segment from the header when PSB has no template title', async () => {
  bridge.adminContext.mockResolvedValue({ context: context({ templateTitle: null }) });
  await renderPanel();
  // 模板为空时只显示机器，不会留下「· 打包机」或空占位。
  expect(screen.getByTestId('remote-workspace-admin-workspace-meta').textContent).toBe('Machine A');
  expect(screen.getByTestId('remote-workspace-admin-workspace-name').textContent).toBe('proj-a');
});

it('keeps the category navigation as one tablist inside a dedicated nav row', async () => {
  await renderPanel();
  const nav = screen.getByTestId('remote-workspace-admin-categories');
  const track = screen.getByRole('tablist');
  // 结构契约（左对齐 / 不拉伸的视觉本身交给 `pnpm ui:check`）：页面里只有一个分类 tablist，
  // 且它就在分类导航行里，不和页头操作混在一起。
  expect(within(nav).getByRole('tablist')).toBe(track);
  expect(within(nav).getAllByRole('tab')).toHaveLength(3);
});

it('switches the three categories and shows one shared placeholder style without fake buttons', async () => {
  await renderPanel();
  // 默认是远程连接：有启动按钮，没有占位文案。
  expect(
    screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }),
  ).toBeTruthy();
  expect(screen.queryByText(i18n.t('remoteWorkspace.admin.placeholderComingSoon'))).toBeNull();

  for (const [tab, testId] of [
    ['versionControl', 'remote-workspace-admin-version-control'],
    ['settings', 'remote-workspace-admin-settings'],
  ] as const) {
    await act(async () => {
      fireEvent.click(
        screen.getByRole('tab', { name: i18n.t(`remoteWorkspace.admin.categories.${tab}`) }),
      );
    });
    const placeholder = screen.getByTestId(testId);
    expect(
      within(placeholder).getByText(i18n.t(`remoteWorkspace.admin.categories.${tab}`)),
    ).toBeTruthy();
    expect(
      within(placeholder).getByText(i18n.t('remoteWorkspace.admin.placeholderComingSoon')),
    ).toBeTruthy();
    // 占位空态不摆假按钮：该分类内容里没有任何可点动作。
    expect(within(placeholder).queryAllByRole('button')).toHaveLength(0);
  }

  await act(async () => {
    fireEvent.click(
      screen.getByRole('tab', { name: i18n.t('remoteWorkspace.admin.categories.connection') }),
    );
  });
  expect(
    screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }),
  ).toBeTruthy();
});

it('occupy / release / open-web actions call the bridge and refresh the workspace context', async () => {
  await renderPanel();
  // 自己占着 → 显示「解除占用」。
  const release = screen.getByRole('button', {
    name: i18n.t('remoteWorkspace.admin.actionRelease'),
  });
  await act(async () => {
    fireEvent.click(release);
  });
  expect(bridge.releaseWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-a' });
  expect(toast.success).toHaveBeenCalledWith(i18n.t('remoteWorkspace.admin.actionReleaseDone'));
  const callsAfterRelease = bridge.adminContext.mock.calls.length;
  // 成功 → 刷新工作区上下文（占用者 / 状态以主进程事实为准）。
  expect(callsAfterRelease).toBeGreaterThan(1);
  // 占用 / 解除占用成功：兜底读一次版本控制通知（推送已覆盖时幂等，读不到不清掉已到的通知）。
  await waitFor(() =>
    expect(bridge.workspaceVcsNotice).toHaveBeenCalledWith({ workspaceId: 'ws-a' }),
  );

  // 推送一个「未占用」的工作区：按钮切换成「占用」，点击后调 occupyWorkspace。
  await act(async () => {
    pushContext?.({
      context: context({ occupancy: { occupied: false, byMe: false, personName: '' } }),
    });
  });
  const occupy = screen.getByRole('button', { name: i18n.t('remoteWorkspace.admin.actionOccupy') });
  await act(async () => {
    fireEvent.click(occupy);
  });
  expect(bridge.occupyWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-a' });
  expect(toast.success).toHaveBeenCalledWith(i18n.t('remoteWorkspace.admin.actionOccupyDone'));

  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', { name: i18n.t('remoteWorkspace.admin.actionOpenWeb') }),
    );
  });
  expect(bridge.openWebWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-a' });
});

it('shows the version-control advisory inline on its category and cleans only after inline confirmation', async () => {
  await renderPanel();
  // 没有通知：版本控制分类仍是统一占位空态（不放假按钮）。
  await act(async () => {
    fireEvent.click(
      screen.getByRole('tab', { name: i18n.t('remoteWorkspace.admin.categories.versionControl') }),
    );
  });
  expect(screen.getByTestId('remote-workspace-admin-version-control').textContent).toContain(
    i18n.t('remoteWorkspace.admin.placeholderComingSoon'),
  );

  // main 广播 advisory（与占用成功后的推送同一路径）：不刷新页面就出现内联提示条。
  await act(async () => {
    pushVcsNotice(VCS_ADVISORY);
  });
  const inline = screen.getByTestId('workspace-vcs-notice');
  expect(inline.dataset['variant']).toBe('inline');
  expect(inline.dataset['advisory']).toBe('true');
  expect(inline.textContent).toContain(VCS_ADVISORY.messageZh);
  expect(inline.textContent).toContain('一键清理');
  expect(screen.queryByText(i18n.t('remoteWorkspace.admin.placeholderComingSoon'))).toBeNull();

  // 不可逆清理：点按钮只进入二次确认，不立刻发动作。
  await act(async () => {
    fireEvent.click(screen.getByText('一键清理'));
  });
  expect(screen.getByTestId('workspace-vcs-confirm')).toBeTruthy();
  expect(bridge.runWorkspaceVcsAction).not.toHaveBeenCalled();

  await act(async () => {
    fireEvent.click(screen.getByText(i18n.t('remoteWorkspace.vcs.confirm.action')));
  });
  expect(bridge.runWorkspaceVcsAction).toHaveBeenCalledWith({
    workspaceId: 'ws-a',
    kind: 'clean-workspace',
    confirm: true,
  });
  // 202 异步：给「清理已开始」+ 刷新入口，不猜轮询端点。
  expect(screen.getByTestId('workspace-vcs-cleaning')).toBeTruthy();
});

it('dismisses the inline version-control advisory when the user keeps using the workspace', async () => {
  await renderPanel();
  await act(async () => {
    fireEvent.click(
      screen.getByRole('tab', { name: i18n.t('remoteWorkspace.admin.categories.versionControl') }),
    );
  });
  await act(async () => {
    pushVcsNotice(VCS_ADVISORY);
  });
  expect(screen.getByTestId('workspace-vcs-notice')).toBeTruthy();

  // 「继续」= 关闭提示 + 调 main 清缓存（VCS 现行口径：只清本地通知的话，换窗口 /
  // hydrate 会复现已忽略的提示，所以必须发 `kind:'continue'`）。
  await act(async () => {
    fireEvent.click(screen.getByText('忽略提示，继续使用工作区'));
  });
  expect(bridge.runWorkspaceVcsAction).toHaveBeenCalledWith({
    workspaceId: 'ws-a',
    kind: 'continue',
  });
  expect(screen.queryByTestId('workspace-vcs-notice')).toBeNull();
  // 关掉后回到占位空态，页面结构不变。
  expect(screen.getByTestId('remote-workspace-admin-version-control').textContent).toContain(
    i18n.t('remoteWorkspace.admin.placeholderComingSoon'),
  );
});

it('shows the person’s name when occupying is rejected because someone else took the workspace', async () => {
  bridge.adminContext.mockResolvedValue({
    context: context({ occupancy: { occupied: false, byMe: false, personName: '' } }),
  });
  bridge.occupyWorkspace.mockRejectedValue(new Error('[PSB_WORKSPACE_OCCUPIED_BY_OTHER] 张三'));
  await renderPanel();
  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', { name: i18n.t('remoteWorkspace.admin.actionOccupy') }),
    );
  });
  expect(toast.error).toHaveBeenCalledTimes(1);
  const errorMock = vi.mocked(toast.error);
  expect(String(errorMock.mock.calls[0]?.[0])).toContain('张三');
});

it('works from the workspace context alone: no task/session state is read, and the viewer works after the Agent ends', async () => {
  // 工作区上下文来自 main 的兜底解析（source=last-used 表示不是从某个任务解析的）：
  // 页面没有任何「任务是否结束」的输入，启动 / 停止照常可用。
  bridge.adminContext.mockResolvedValue({ context: context({ source: 'last-used' }) });
  await renderPanel();
  expect(bridge.adminContext).toHaveBeenCalledWith({ localSessionId: 'local-a' });
  // 旧会话级接口一次都不该被调用。
  expect(bridge.sessionStatus).not.toHaveBeenCalled();

  const start = screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') });
  expect((start as HTMLButtonElement).disabled).toBe(false);
  await act(async () => {
    fireEvent.click(start);
  });
  expect(bridge.adminStreamStart).toHaveBeenCalledWith({ workspaceId: 'ws-a' });
  // 启动后同一个按钮变成可用的「停止」。
  const stop = screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.stop') });
  expect((stop as HTMLButtonElement).disabled).toBe(false);
  expect(
    screen.queryByRole('button', { name: i18n.t('remoteWorkspace.session.start') }),
  ).toBeNull();
});

it('uses one start/stop button that switches label with the stream state', async () => {
  await renderPanel();
  // 未在播：控制条左侧只有一个「启动」按钮，不并排「停止」。
  expect(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') })).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: i18n.t('remoteWorkspace.session.stop') }),
  ).toBeNull();

  // 启动中：同一个按钮禁用（避免重复点击），标签仍是「启动」。
  let resolveStart: (value: unknown) => void = () => {};
  bridge.adminStreamStart.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  // 先让前置的 `adminStreamStatus` 落定，才进入 pending 的 `adminStreamStart`。
  await act(async () => {});
  const pending = screen.getByRole('button', {
    name: i18n.t('remoteWorkspace.session.start'),
  });
  expect((pending as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    resolveStart({ status: STREAM_ACTIVE, workspaceId: 'ws-a', viewerSessionId: 'viewer-a' });
  });

  // 点击后同一位置变成「停止」；不再有「启动」。
  expect(bridge.adminStreamStart).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.stop') })).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: i18n.t('remoteWorkspace.session.start') }),
  ).toBeNull();

  // 再点「停止」：执行现有停止逻辑并清画面，按钮切回「启动」。
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.stop') }));
  });
  expect(bridge.adminStreamStop).toHaveBeenCalledWith({ workspaceId: 'ws-a' });
  expect(playerMock.clear).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') })).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: i18n.t('remoteWorkspace.session.stop') }),
  ).toBeNull();
});

it('starts, stops and streams in a full-height stage', async () => {
  await renderPanel();
  // 未启动：状态文案 + 画面区空态（两处都写「串流未启动」）。
  expect(
    screen.getAllByText(i18n.t('remoteWorkspace.session.streamIdle')).length,
  ).toBeGreaterThan(0);
  expect(screen.getByText(i18n.t('remoteWorkspace.admin.streamStartHint'))).toBeTruthy();
  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  // 画面在占满剩余高度的 stage 里（具体几何 / 不产生第二层滚动条由 `pnpm ui:check` 目检）。
  const stage = screen.getByTestId('remote-workspace-admin-stream-stage');
  expect(stage.contains(canvas)).toBe(true);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  expect(bridge.adminStreamStart).toHaveBeenCalledWith({ workspaceId: 'ws-a' });
  // 订阅成功 ≠ 有画面：先显示「已连接，等待画面…」，不显示「串流中」。
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamWaiting'),
  );
  expect(screen.queryByText(i18n.t('remoteWorkspace.session.streamIdle'))).toBeNull();

  // PSB 的 `active` 不是本端「有画面」的判据：status.active:true 也不切「串流中」。
  await act(async () => {
    pushStreamEvent({
      type: 'status',
      sessionId: 'viewer-a',
      status: {
        capability: true,
        active: true,
        width: 1920,
        height: 1080,
        fps: 30,
        codec: 'avc1.42E01E',
        lastError: null,
      },
    });
  });
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamWaiting'),
  );

  // 首帧到达才进入「串流中」。
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(1024) });
  });
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamLive'),
  );

  // 帧仍在到但 PSB 回推 active:false：不能把已经在播的画面切回未启动。
  await act(async () => {
    pushStreamEvent({
      type: 'status',
      sessionId: 'viewer-a',
      status: {
        capability: true,
        active: false,
        width: 1920,
        height: 1080,
        fps: 30,
        codec: 'avc1.42E01E',
        lastError: null,
      },
    });
  });
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamLive'),
  );

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.stop') }));
  });
  expect(bridge.adminStreamStop).toHaveBeenCalledWith({ workspaceId: 'ws-a' });
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamIdle'),
  );
});

it('opens the details as a floating overlay without changing the stream layout', async () => {
  bridge.adminStreamStatus.mockResolvedValue({
    status: {
      ...STREAM_ACTIVE,
      active: false,
      desktopSession: 'none',
      reasonCode: 'NO_DESKTOP_SESSION',
      lastErrorZh: '需要先启动桌面会话',
    },
  });
  await renderPanel();
  const stage = screen.getByTestId('remote-workspace-admin-stream-stage');
  const controls = screen.getByTestId('remote-workspace-admin-stream-controls');
  const before = {
    stageClass: stage.className,
    controlsClass: controls.className,
    controlsChildren: controls.childElementCount,
  };
  expect(screen.queryByTestId('remote-workspace-admin-details-overlay')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.details') }));
  // 浮层出现，但控制条与画面容器保持原样（高度/子节点/class 都不变）。
  expect(screen.getByTestId('remote-workspace-admin-details-overlay')).toBeTruthy();
  expect(stage.className).toBe(before.stageClass);
  expect(controls.className).toBe(before.controlsClass);
  expect(controls.childElementCount).toBe(before.controlsChildren);
  const details = screen.getByTestId('remote-workspace-admin-stream-details');
  expect(details.textContent).toContain('1920 × 1080');
  expect(details.textContent).toContain('avc1.42E01E');
  // 详情浮层按新口径显示 PSB 的机器字段与中文原话。
  expect(details.textContent).toContain('NO_DESKTOP_SESSION');
  expect(details.textContent).toContain('需要先启动桌面会话');
  expect(details.textContent).toContain(i18n.t('remoteWorkspace.admin.desktopSessionNone'));

  fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.details') }));
  expect(screen.queryByTestId('remote-workspace-admin-details-overlay')).toBeNull();
  expect(stage.className).toBe(before.stageClass);
  expect(controls.className).toBe(before.controlsClass);
  expect(controls.childElementCount).toBe(before.controlsChildren);
});

it('turns full screen into a minimal picture-only view with one corner toggle', async () => {
  await renderPanel();
  const stage = screen.getByTestId('remote-workspace-admin-stream-stage');
  const enter = screen.getByRole('button', {
    name: i18n.t('remoteWorkspace.admin.enterFullscreen'),
  });
  await act(async () => {
    fireEvent.click(enter);
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  expect(requestFullscreen).toHaveBeenCalledTimes(1);
  expect(stage.getAttribute('data-fullscreen')).toBe('true');
  // 极简全屏（对齐 PSB 网页）：画面里不再挂控制条 / 启动停止按钮，只剩右下角一个图标按钮。
  expect(within(stage).queryByTestId('remote-workspace-admin-stream-controls')).toBeNull();
  expect(
    within(stage).queryByRole('button', { name: i18n.t('remoteWorkspace.session.start') }),
  ).toBeNull();
  const exit = within(stage).getByRole('button', {
    name: i18n.t('remoteWorkspace.admin.exitFullscreen'),
  });
  expect(exit.textContent).toBe('');
  // 全屏画面里只有一个本地控件（右下角退出按钮），位置本身交给 ui:check。
  expect(within(stage).getAllByRole('button')).toEqual([exit]);

  await act(async () => {
    fireEvent.click(exit);
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  expect(exitFullscreen).toHaveBeenCalledTimes(1);
  expect(stage.getAttribute('data-fullscreen')).toBeNull();
  // 退出后非全屏控制条仍在：启动 / 停止 / 详情 / 串流信息 / 全屏。
  expect(screen.getByTestId('remote-workspace-admin-stream-controls')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: i18n.t('remoteWorkspace.admin.streamInfo') }),
  ).toBeTruthy();
});

/**
 * 观看中切换界面语言不能重建播放器（2026-11-26 独立审查 P2）：旧实现播放器 effect 依赖 `[t]`，
 * 语言一变就 dispose 当前实例；新实例没有上一次的 config，画面白掉、只能手动停 / 再启动。
 */
it('keeps the player instance when the UI language changes mid-stream', async () => {
  await renderPanel();
  expect(playerMock.createCount).toBe(1);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(64) });
  });
  await act(async () => {
    await i18n.changeLanguage('de');
  });
  // 不重建、不 dispose：同一个播放器实例继续收帧，画面仍在。
  expect(playerMock.createCount).toBe(1);
  expect(playerMock.dispose).not.toHaveBeenCalled();
  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  expect(canvas.getAttribute('data-has-picture')).toBe('true');
});

it('clears the frozen picture when stopping or when PSB closes the viewer', async () => {
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  // 收到帧 = 有画面：canvas 可见。
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(1024) });
  });
  expect(canvas.getAttribute('data-has-picture')).toBe('true');

  // 手动停止：立刻清空画面，不能留下冻结的上一帧。
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.stop') }));
  });
  expect(playerMock.clear).toHaveBeenCalled();
  expect(canvas.getAttribute('data-has-picture')).toBe('false');
  expect(screen.getAllByText(i18n.t('remoteWorkspace.session.streamIdle')).length).toBeGreaterThan(0);

  // PSB 主动关闭观看（closed 事件）：同样立刻清空。
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  playerMock.clear.mockClear();
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(1024) });
    pushStreamEvent({
      type: 'closed',
      sessionId: 'viewer-a',
      reason: 'not-ready',
      detail: { reasonCode: 'NO_DESKTOP_SESSION', desktopSession: 'none', messageZh: '没有可观看的画面' },
    });
  });
  expect(playerMock.clear).toHaveBeenCalled();
  expect(canvas.getAttribute('data-has-picture')).toBe('false');
});

it('syncs the remote cursor shape onto the picture only while the pointer is over it', async () => {
  await renderPanel();
  const stage = screen.getByTestId('remote-workspace-admin-stream-stage') as HTMLDivElement;
  const canvas = screen.getByTestId(
    'remote-workspace-admin-stream-canvas',
  ) as HTMLCanvasElement;
  // 共享映射把远端 `name` 变成宿主风格关键字（2026-11-26 口径：不用位图 data URL）。
  expect(psbStreamCursorKeyword(CURSOR_SHAPE)).toBe('text');
  expect(psbStreamCursorKeyword({ ...CURSOR_SHAPE, name: 'left_side' })).toBe('ew-resize');

  // 未启动：不订阅 cursor；指针也不在画面上，收到形状不该写任何样式。
  await act(async () => {
    pushStreamEvent({ type: 'cursor', sessionId: 'viewer-a', cursor: CURSOR_SHAPE });
  });
  expect(canvas.style.cursor).toBe('');
  expect(stage.style.cursor).toBe('');

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  // 有画面后再进入画面：此刻还没有形状缓存 → 保持宿主默认（不伪造光标）。
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(1024) });
  });
  await act(async () => {
    fireEvent.pointerEnter(canvas);
  });
  expect(canvas.style.cursor).toBe('');

  // 形状到达且指针在画面里：立刻写 CSS 关键字；只写 canvas，不写 stage（stage 含黑边 / HUD）。
  await act(async () => {
    pushStreamEvent({ type: 'cursor', sessionId: 'viewer-a', cursor: CURSOR_SHAPE });
  });
  expect(canvas.style.cursor).toBe('text');
  expect(canvas.getAttribute('data-stream-cursor-keyword')).toBe('text');
  expect(canvas.getAttribute('data-stream-cursor-name')).toBe('text');
  expect(stage.style.cursor).toBe('');
  // 永远宿主风格：画面样式里没有远端位图。
  expect(canvas.style.cursor).not.toContain('url(');
  expect(canvas.style.cursor).not.toContain('data:image/png');

  // 拖拽时指针被捕获到 stage（`usePsbStreamInteraction` 在 pointerdown 捕获）：canvas 会收到
  // 一次「伪造的」pointerleave，但不能因此把 resize / grabbing 形状清掉。命中判定按 canvas 矩形
  // 几何校正，捕获前后一致。
  stubCanvasGeometry(canvas, {
    width: 1920,
    height: 1080,
    displayWidth: 960,
    displayHeight: 540,
  });
  await act(async () => {
    fireEvent.pointerLeave(canvas);
    fireEvent.pointerMove(stage, { clientX: 100, clientY: 100, pointerId: 1 });
  });
  expect(canvas.style.cursor).toBe('text');

  // 指针移到画面外（黑边外 / 容器内但不在 canvas 上）：立即恢复宿主默认，缓存保留。
  await act(async () => {
    fireEvent.pointerMove(stage, { clientX: 2000, clientY: 2000, pointerId: 1 });
  });
  expect(canvas.style.cursor).toBe('');
  expect(canvas.getAttribute('data-stream-cursor-keyword')).toBeNull();

  // 指针不在画面时收到新形状：只缓存、不写样式（离开画面后不保持远端形状）。
  await act(async () => {
    pushStreamEvent({
      type: 'cursor',
      sessionId: 'viewer-a',
      cursor: { ...CURSOR_SHAPE, serial: 4, name: 'left_side' },
    });
  });
  expect(canvas.style.cursor).toBe('');

  // 重新进入画面：立刻用缓存形状恢复，不必等下一帧 cursor 事件。
  await act(async () => {
    fireEvent.pointerEnter(canvas);
  });
  expect(canvas.style.cursor).toBe('ew-resize');
  expect(canvas.getAttribute('data-stream-cursor-name')).toBe('left_side');

  // serial 回退不是「旧形状」：新形态照常生效（真机日志证明 PSB 的 serial 不严格单调）。
  await act(async () => {
    pushStreamEvent({
      type: 'cursor',
      sessionId: 'viewer-a',
      cursor: { ...CURSOR_SHAPE, serial: 3, name: 'wait' },
    });
  });
  expect(canvas.style.cursor).toBe('wait');

  // 别的观看端 / 旧会话收尾：按 viewerSessionId 过滤，多观看端不串味。
  await act(async () => {
    pushStreamEvent({
      type: 'cursor',
      sessionId: 'viewer-other',
      cursor: { ...CURSOR_SHAPE, serial: 9, name: 'progress' },
    });
  });
  expect(canvas.style.cursor).toBe('wait');

  // 离开整个画面容器（切到控制条 / 页签外）：同样立即恢复宿主默认。
  await act(async () => {
    fireEvent.pointerLeave(stage);
  });
  expect(canvas.style.cursor).toBe('');

  // 停止观看：立刻回宿主默认光标（远端形状不能留在宿主画面上），缓存也清掉。
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.stop') }));
  });
  expect(canvas.style.cursor).toBe('');
  // 停止后再收到形状也不再写（订阅已结束 / 缓存已清）。
  await act(async () => {
    pushStreamEvent({ type: 'cursor', sessionId: 'viewer-a', cursor: CURSOR_SHAPE });
  });
  expect(canvas.style.cursor).toBe('');
  // 重新「启动」不会恢复停止前的形状：缓存随订阅归零，等新形状到达。
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  await act(async () => {
    fireEvent.pointerEnter(canvas);
  });
  expect(canvas.style.cursor).toBe('');
});

it('restores the host cursor on closed / error / unmount and keeps local overlays off the remote shape', async () => {
  const view = await renderPanel();
  const stage = screen.getByTestId('remote-workspace-admin-stream-stage') as HTMLDivElement;
  const canvas = screen.getByTestId(
    'remote-workspace-admin-stream-canvas',
  ) as HTMLCanvasElement;
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(1024) });
  });
  await act(async () => {
    fireEvent.pointerEnter(canvas);
    pushStreamEvent({ type: 'cursor', sessionId: 'viewer-a', cursor: CURSOR_SHAPE });
  });
  expect(canvas.style.cursor).toBe('text');

  // 画面里的本地浮层（串流信息 HUD 及其关闭按钮）显式声明宿主光标：不继承远端形状。
  // 关键字只写在 canvas 上（HUD 是它的兄弟节点，stage 也不写），所以浮层拿不到远端光标。
  await act(async () => {
    fireEvent.click(screen.getByTestId('remote-workspace-admin-stream-info-toggle'));
  });
  const hud = screen.getByTestId('remote-workspace-admin-stream-info');
  const hudClose = within(hud).getByRole('button', {
    name: i18n.t('remoteWorkspace.admin.streamInfoClose'),
  });
  // 关闭按钮自身不写远端光标样式（cursor 外观由本地 chrome 决定，不由远端形状泄漏进来）。
  expect(hudClose.style.cursor).toBe('');
  expect(stage.style.cursor).toBe('');
  expect((hud as HTMLElement).style.cursor).toBe('');

  // 全屏时 canvas 仍在 stage 里：同一份关键字继续生效；退出按钮不继承远端形状。
  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', { name: i18n.t('remoteWorkspace.admin.enterFullscreen') }),
    );
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  expect(stage.getAttribute('data-fullscreen')).toBe('true');
  expect(canvas.style.cursor).toBe('text');
  const exit = within(stage).getByRole('button', {
    name: i18n.t('remoteWorkspace.admin.exitFullscreen'),
  });
  expect(exit.style.cursor).toBe('');

  // PSB 主动关闭观看：光标随订阅一起恢复宿主默认（不能把远端形状留在画面上）。
  await act(async () => {
    pushStreamEvent({
      type: 'closed',
      sessionId: 'viewer-a',
      reason: 'not-ready',
      detail: {
        reasonCode: 'NO_DESKTOP_SESSION',
        desktopSession: 'none',
        messageZh: '没有可观看的画面',
      },
    });
  });
  expect(canvas.style.cursor).toBe('');
  expect(canvas.getAttribute('data-stream-cursor-keyword')).toBeNull();

  // 错误断开（`error` 不一定会重置「已订阅」状态）：光标必须由事件本身清掉。
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  await act(async () => {
    fireEvent.pointerEnter(canvas);
    pushStreamEvent({ type: 'cursor', sessionId: 'viewer-a', cursor: CURSOR_SHAPE });
  });
  expect(canvas.style.cursor).toBe('text');
  await act(async () => {
    pushStreamEvent({
      type: 'error',
      sessionId: 'viewer-a',
      failure: {
        code: 'PSB_STREAM_UNREACHABLE',
        messageKey: 'remoteWorkspace.error.unreachable',
        message: 'read ECONNRESET',
      },
    });
  });
  expect(canvas.style.cursor).toBe('');

  // `error` 是**本轮失败**：状态机回到 error、画面与远端形状一起清掉；用户重新点「启动」才是
  // 新的订阅（旧实现 error 后仍把 subscribed 当 true，界面停在不可解释的「串流中」）。
  expect(
    screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }),
  ).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  await act(async () => {
    fireEvent.pointerEnter(canvas);
    pushStreamEvent({ type: 'cursor', sessionId: 'viewer-a', cursor: CURSOR_SHAPE });
  });

  // 卸载（关页签 / 切工作区由页面按 workspaceId 重挂）：清掉画面上的远端形状。
  expect(canvas.style.cursor).toBe('text');
  view.unmount();
  expect(canvas.style.cursor).toBe('');
});

it('shows a live stream-info HUD with real frame statistics and closes it', async () => {
  vi.useFakeTimers();
  bridge.adminContext.mockResolvedValue({ context: context({ desktopSession: 'running' }) });
  bridge.adminStreamStatus.mockResolvedValue({ status: STREAM_ACTIVE });
  playerMock.stats = {
    codec: 'avc1.42E01E',
    queueDepth: 2,
    droppedFrames: 3,
    decodeLatencyAvgMs: 9.9,
    decodeLatencyP95Ms: 12.3,
  };
  await renderPanel();
  const stage = screen.getByTestId('remote-workspace-admin-stream-stage');
  // 进入页面不自动开播：先由用户点「启动」（本批改口）。
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  // 打开 HUD 前没有任何浮层。
  expect(screen.queryByTestId('remote-workspace-admin-stream-info')).toBeNull();
  fireEvent.click(
    screen.getByTestId('remote-workspace-admin-stream-info-toggle'),
  );
  // 打开 HUD 后推入最近 1s 的帧，再走一个采样周期：FPS / 码率来自真实帧数与字节数。
  // 帧与采样分两个 act：`streaming` 由帧事件置位后要先落一次渲染，采样读到的才是「在播」。
  await act(async () => {
    for (let index = 0; index < 30; index += 1) {
      pushStreamEvent({
        type: 'frame',
        sessionId: 'viewer-a',
        payload: new ArrayBuffer(100_000),
      });
    }
  });
  await act(async () => {
    vi.advanceTimersByTime(1100);
  });
  const hud = screen.getByTestId('remote-workspace-admin-stream-info');
  // HUD 是画面上的浮层（在 stage 内，不进入文档流；具体定位 / 层级由 ui:check 目检）。
  expect(stage.contains(hud)).toBe(true);
  // 开关与浮层用 aria 关联：读屏能知道这个按钮控制哪块内容。
  expect(
    screen.getByTestId('remote-workspace-admin-stream-info-toggle').getAttribute('aria-controls'),
  ).toBe('remote-workspace-admin-stream-info');
  expect(hud.textContent).toContain('1920 × 1080');
  expect(screen.getByTestId('remote-workspace-admin-stream-info-codec').textContent).toContain(
    'avc1.42E01E',
  );
  expect(screen.getByTestId('remote-workspace-admin-stream-info-fps').textContent).not.toBe('—');
  expect(
    screen.getByTestId('remote-workspace-admin-stream-info-bitrate').textContent,
  ).toContain('Mbps');
  expect(screen.getByTestId('remote-workspace-admin-stream-info-decode').textContent).toContain(
    '9.9 ms',
  );
  expect(screen.getByTestId('remote-workspace-admin-stream-info-dropped').textContent).toBe('3');
  expect(screen.getByTestId('remote-workspace-admin-stream-info-queue').textContent).toBe('2');
  expect(hud.textContent).toContain(i18n.t('remoteWorkspace.admin.streamInfoConnection'));

  // 可关闭。
  fireEvent.click(
    screen.getByRole('button', { name: i18n.t('remoteWorkspace.admin.streamInfoClose') }),
  );
  expect(screen.queryByTestId('remote-workspace-admin-stream-info')).toBeNull();

  // 全屏下 HUD 仍在右上角（不因极简全屏被隐藏）。
  fireEvent.click(screen.getByTestId('remote-workspace-admin-stream-info-toggle'));
  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', { name: i18n.t('remoteWorkspace.admin.enterFullscreen') }),
    );
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  expect(within(stage).getByTestId('remote-workspace-admin-stream-info')).toBeTruthy();
});

it('shows an actionable message when opening the workspace on the web finds it gone', async () => {
  await renderPanel();
  bridge.openWebWorkspace.mockRejectedValue(new Error('[PSB_NOT_FOUND] workspace gone'));
  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', { name: i18n.t('remoteWorkspace.admin.actionOpenWeb') }),
    );
  });
  expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
    i18n.t('remoteWorkspace.admin.staleMissingTitle'),
  );
});

it('releases the viewer when the tab becomes invisible', async () => {
  const view = await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  view.rerender(
    <RemoteWorkspaceAdminPanel
      state={{}}
      ctx={ctx('local-a', 'psb:psb-a')}
      active={false}
      shellVisible
    />,
  );
  await act(async () => {});
  expect(bridge.adminStreamStop).toHaveBeenCalledWith({ workspaceId: 'ws-a' });
});

it('follows the pushed workspace change and releases the previous workspace viewer', async () => {
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  expect(bridge.adminStreamStart).toHaveBeenCalledWith({ workspaceId: 'ws-a' });

  await act(async () => {
    pushContext?.({
      context: context({
        workspaceId: 'ws-b',
        clientName: 'Machine B',
        title: 'Workspace B',
        directoryName: 'proj-b',
        occupancy: { occupied: false, byMe: false, personName: '' },
      }),
    });
  });
  // 旧工作区的观看名额随连接区卸载释放；播放器实例被 dispose（也清掉旧画面）。
  expect(bridge.adminStreamStop).toHaveBeenCalledWith({ workspaceId: 'ws-a' });
  expect(playerMock.dispose).toHaveBeenCalled();
  // 页头跟随新工作区：主标题是目录名（实例名），模板名 · 机器名在名称之后。
  expect(screen.getByTestId('remote-workspace-admin-workspace-name').textContent).toBe('proj-b');
  expect(screen.getByTestId('remote-workspace-admin-workspace-meta').textContent).toBe(
    'Saga2 · Machine B',
  );
  expect(screen.getByTestId('remote-workspace-admin-workspace-occupancy').textContent).toBe(
    i18n.t('remoteWorkspace.admin.occupancyValue', {
      value: i18n.t('remoteWorkspace.admin.occupancyFree'),
    }),
  );
  // 新工作区是全新的观看端：可以重新启动。
  expect(
    (
      screen.getByRole('button', {
        name: i18n.t('remoteWorkspace.session.start'),
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it('explains why there is no picture using PSB reason codes, not a dead end', async () => {
  bridge.adminContext.mockResolvedValue({
    context: context({ desktopSession: 'none', reasonCode: 'NO_DESKTOP_SESSION' }),
  });
  await renderPanel();
  expect(screen.getByText(i18n.t('remoteWorkspace.admin.streamReasonNoDesktop'))).toBeTruthy();
  // 空态里仍然可以点「启动」（PSB 状态未知时不预判失败）。
  expect(
    (
      screen.getByRole('button', {
        name: i18n.t('remoteWorkspace.session.start'),
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  // 远端没有 running 桌面会话也不自动发 start（本页一律手动启动）。
  expect(bridge.adminStreamStart).not.toHaveBeenCalled();
});

it('keeps the page structure with a no-workspace hint when main resolves no workspace', async () => {
  bridge.adminContext.mockResolvedValue({ context: null });
  await renderPanel();
  expect(screen.getByTestId('remote-workspace-admin-no-workspace').textContent).toContain(
    i18n.t('remoteWorkspace.admin.emptyNoWorkspaceTitle'),
  );
  // 结构保留：页头 + 三个分类都在，只是没有观看端与通用操作。
  expect(screen.getByTestId('remote-workspace-admin-workspace-line').textContent).toContain('—');
  expect(screen.getAllByRole('tab')).toHaveLength(3);
  expect(screen.queryByTestId('remote-workspace-admin-actions')).toBeNull();
  expect(
    screen.queryByRole('button', { name: i18n.t('remoteWorkspace.session.start') }),
  ).toBeNull();
});

it('degrades to an unavailable hint when the preload has no workspace-admin bridge', async () => {
  Object.assign(window, { electronAPI: { psbRemote: {} } });
  await renderPanel();
  expect(screen.getByTestId('remote-workspace-admin-unavailable').textContent).toContain(
    i18n.t('remoteWorkspace.admin.emptyUnavailableTitle'),
  );
  expect(screen.getAllByRole('tab')).toHaveLength(3);
});

it('offers a real retry when the context read fails and then recovers', async () => {
  bridge.adminContext
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ context: context() });
  await renderPanel();
  expect(screen.getByTestId('remote-workspace-admin-load-failed').textContent).toContain(
    i18n.t('remoteWorkspace.admin.emptyLoadFailedTitle'),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.dialog.refresh') }));
  });
  expect(screen.getByTestId('remote-workspace-admin-workspace-name').textContent).toBe('proj-a');
});

it('does not start on entry, starts only on demand, and still releases the viewer when hidden', async () => {
  bridge.adminContext.mockResolvedValue({ context: context({ desktopSession: 'running' }) });
  bridge.adminStreamStatus.mockResolvedValue({
    status: { ...STREAM_ACTIVE, active: false, desktopSession: 'running' },
  });
  const view = await renderPanel();
  // 改口后的口径：进入页面**不**自动开播（即便远端 desktopSession:running / active 也不触发）。
  expect(bridge.adminStreamStart).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') })).toBeTruthy();
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamIdle'),
  );

  // 用户点「启动」才订阅；首帧之前是「已连接，等待画面…」。
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  expect(bridge.adminStreamStart).toHaveBeenCalledTimes(1);
  expect(bridge.adminStreamStart).toHaveBeenCalledWith({ workspaceId: 'ws-a' });
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamWaiting'),
  );
  // 这一轮里 PSB 状态本身写完 `active:false` 也不影响（`streaming` 只认 frame）。
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(64) });
  });
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamLive'),
  );

  // 离开页签：仍然自动停止，释放 PSB 的观看名额。
  view.rerender(
    <RemoteWorkspaceAdminPanel
      state={{}}
      ctx={ctx('local-a', 'psb:psb-a')}
      active={false}
      shellVisible
    />,
  );
  await act(async () => {});
  expect(bridge.adminStreamStop).toHaveBeenCalledWith({ workspaceId: 'ws-a' });

  // 再回来：**未启动态**，需要用户再点「启动」（不会自动开播）。
  view.rerender(
    <RemoteWorkspaceAdminPanel state={{}} ctx={ctx('local-a', 'psb:psb-a')} active shellVisible />,
  );
  await act(async () => {});
  expect(bridge.adminStreamStart).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') })).toBeTruthy();
});

it('surfaces a manual start failure without auto-retrying', async () => {
  bridge.adminStreamStart.mockRejectedValue(new Error('[PSB_UNREACHABLE] 远端暂时不可达'));
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  expect(bridge.adminStreamStart).toHaveBeenCalledTimes(1);
  // 不再自动重试（没有自动启动，也就没有启动风暴）。
  await act(async () => {});
  await act(async () => {});
  expect(bridge.adminStreamStart).toHaveBeenCalledTimes(1);
  // 已知错误码显示可行动文案（网络问题 →「检查网络后重试」），不是通用「操作失败」。
  expect(screen.getByRole('alert').textContent).toContain(
    i18n.t('remoteWorkspace.error.unreachable'),
  );
});

/* ============ 占用待确认（2026-11-27 用户复测：占用一律由用户确认） ============ */

const OCCUPY_REQUIRED = () =>
  new Error('[PSB_WORKSPACE_NOT_OCCUPIED] 这个工作区还没有被占用');

it('启动串流遇到「需要先占用」→ 用户确认后占用一次并重试启动一次', async () => {
  confirmDialogMock.confirm.mockResolvedValue(true);
  bridge.adminStreamStart
    .mockRejectedValueOnce(OCCUPY_REQUIRED())
    .mockResolvedValueOnce({
      status: STREAM_ACTIVE,
      workspaceId: 'ws-a',
      viewerSessionId: 'viewer-a',
    });
  await renderPanel();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });

  // 确认 → 恰好显式占用一次 → 用同一个工作区重发这一次启动。
  expect(confirmDialogMock.confirm).toHaveBeenCalledOnce();
  expect(bridge.occupyWorkspace).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'ws-a' });
  expect(bridge.adminStreamStart).toHaveBeenCalledTimes(2);
  expect(bridge.adminStreamStart).toHaveBeenLastCalledWith({ workspaceId: 'ws-a' });
  // 重试成功 = 进入已连接等待画面，不是错误条。
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamWaiting'),
  );
});

it('启动串流遇到「需要先占用」→ 用户取消：不占用、不重试，给可行动原因', async () => {
  confirmDialogMock.confirm.mockResolvedValue(false);
  bridge.adminStreamStart.mockRejectedValueOnce(OCCUPY_REQUIRED());
  await renderPanel();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });

  expect(confirmDialogMock.confirm).toHaveBeenCalledOnce();
  expect(bridge.occupyWorkspace).not.toHaveBeenCalled();
  expect(bridge.adminStreamStart).toHaveBeenCalledTimes(1);
  // 取消 ≠ 通用失败：正文是「需要先占用」的可行动原因。
  expect(screen.getByRole('alert').textContent).toContain(
    i18n.t('remoteWorkspace.error.occupyRequired'),
  );
});

/* ============ 工作区访问没在运行：可行动横幅（2026-11-26 真机事故修复） ============ */

/**
 * 真机：访问未运行时点「启动串流」只显示「串流失败：操作失败，请稍后重试。」。
 * main 现在把 PSB 409 `details.code/state` 翻成三条 IPC 码；这里验证文案、诊断行与动作。
 */
it('shows an actionable banner when the workspace access is not running, plus a web-start entry', async () => {
  bridge.adminStreamStart.mockRejectedValue(
    new Error(
      '[PSB_STREAM_NO_RUNNING_SESSION] 该工作区还没有运行中的桌面访问会话，请先在 PSB 网页启动远程桌面。',
    ),
  );
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });

  const alert = screen.getByRole('alert');
  expect(alert.getAttribute('data-access-state')).toBe('none');
  // 正文是本地化的可行动文案，不是通用「操作失败，请稍后重试。」。
  expect(alert.textContent).toContain(i18n.t('remoteWorkspace.admin.streamAccessNone'));
  expect(alert.textContent).not.toContain(i18n.t('remoteWorkspace.error.unknown'));
  // PSB 中文原话保留为诊断行（可对照 / 报障）。
  expect(
    screen.getByTestId('remote-workspace-admin-stream-failure-detail').textContent,
  ).toContain('请先在 PSB 网页启动远程桌面');

  // 「在网页启动访问」复用既有「在网页打开」能力（main 解析 webUrl → 系统浏览器）。
  const openWeb = screen.getByTestId('remote-workspace-admin-stream-open-web');
  await act(async () => {
    fireEvent.click(openWeb);
  });
  expect(bridge.openWebWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-a' });
});

it('reports the real reason when the in-web start entry cannot be opened', async () => {
  bridge.adminStreamStart.mockRejectedValue(
    new Error('[PSB_STREAM_NO_RUNNING_SESSION] 请先在 PSB 网页启动远程桌面。'),
  );
  bridge.openWebWorkspace.mockRejectedValue(new Error('[PSB_NOT_FOUND] 工作区已不存在'));
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId('remote-workspace-admin-stream-open-web'));
  });
  // 打不开网页时显示真实原因，不假装什么都没发生，也不留旧的可行动文案。
  expect(screen.getByRole('alert').textContent).toContain(
    i18n.t('remoteWorkspace.admin.staleMissingTitle'),
  );
});

it('auto-retries once (~2s) while the workspace access is still starting, then stops', async () => {
  vi.useFakeTimers();
  try {
    const starting = new Error(
      '[PSB_STREAM_ACCESS_STARTING] 工作区访问正在启动（Unity 还没就绪），请稍等再试。',
    );
    bridge.adminStreamStart.mockRejectedValueOnce(starting).mockRejectedValueOnce(starting);
    await renderPanel();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }),
      );
    });

    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-access-state')).toBe('starting');
    expect(alert.textContent).toContain(i18n.t('remoteWorkspace.admin.streamAccessStarting'));
    // 这一档的正确动作是等一会儿，不提供「在网页启动访问」。
    expect(screen.queryByTestId('remote-workspace-admin-stream-open-web')).toBeNull();
    expect(bridge.adminStreamStart).toHaveBeenCalledTimes(1);

    // 约 2s 后自动重试一次（Unity / 虚拟桌面就绪的竞态）。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(bridge.adminStreamStart).toHaveBeenCalledTimes(2);

    // 只重试一次：再过几秒也不会出现第三次（不循环、不形成启动风暴）。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(bridge.adminStreamStart).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert').getAttribute('data-access-state')).toBe('starting');
  } finally {
    vi.useRealTimers();
  }
});

it('shows a wait banner while the workspace access is stopping (no auto retry, no web entry)', async () => {
  bridge.adminStreamStart.mockRejectedValue(
    new Error('[PSB_STREAM_ACCESS_STOPPING] 工作区访问正在结束，请稍等再试。'),
  );
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });

  const alert = screen.getByRole('alert');
  expect(alert.getAttribute('data-access-state')).toBe('stopping');
  expect(alert.textContent).toContain(i18n.t('remoteWorkspace.admin.streamAccessStopping'));
  expect(screen.queryByTestId('remote-workspace-admin-stream-open-web')).toBeNull();
  // 「正在结束」不是「正在启动」：不自动重试（重试只会再撞一次 409）。
  await act(async () => {});
  await act(async () => {});
  expect(bridge.adminStreamStart).toHaveBeenCalledTimes(1);
});

it('forwards pointer, keyboard and wheel input as remote screen pixels', async () => {
  bridge.adminContext.mockResolvedValue({ context: context({ desktopSession: 'running' }) });
  bridge.adminStreamStatus.mockResolvedValue({
    status: { ...STREAM_ACTIVE, active: false, desktopSession: 'running' },
  });
  await renderPanel();
  const stage = screen.getByTestId('remote-workspace-admin-stream-stage');
  // 进入页面不自动开播：先由用户点「启动」，之后画面才接收输入；输入在首帧之后才可用。
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(64) });
  });
  const chip = screen.getByTestId('remote-workspace-admin-stream-input-state');
  expect(chip.getAttribute('data-input-state')).toBe('interactive');
  expect(chip.textContent).toContain(i18n.t('remoteWorkspace.admin.inputInteractive'));

  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  stubCanvasGeometry(canvas, { width: 1920, height: 1080, displayWidth: 960, displayHeight: 540 });

  // 画面中心 → 远端 (960, 540)：远端像素 = 浏览器坐标 × 2。
  fireEvent.pointerDown(canvas, { clientX: 480, clientY: 270, button: 0, pointerId: 1 });
  await flushInput();
  expect(bridge.adminStreamInput).toHaveBeenCalledWith({
    workspaceId: 'ws-a',
    event: { kind: 'pointerdown', x: 960, y: 540, button: 0 },
  });

  // 同一帧内「移动到 (x,y) → 按下」必须按这个顺序发出：移动经 rAF 合并，边沿事件经
  // `pump.sendEdge` 先冲刷待发移动。直接 sender.send 会让 pointerdown 抢在还没发出的
  // pointermove 前面，远端就在旧位置按下（独立审查 P1）。
  bridge.adminStreamInput.mockClear();
  fireEvent.pointerMove(canvas, { clientX: 300, clientY: 200, pointerId: 1 });
  fireEvent.pointerDown(canvas, { clientX: 480, clientY: 270, button: 0, pointerId: 1 });
  await flushInput();
  expect(
    bridge.adminStreamInput.mock.calls.map(
      (call) => (call[0] as { event: { kind: string } }).event.kind,
    ),
  ).toEqual(['pointermove', 'pointerdown']);
  expect(bridge.adminStreamInput).toHaveBeenNthCalledWith(1, {
    workspaceId: 'ws-a',
    event: { kind: 'pointermove', x: 600, y: 400 },
  });

  // 点画面后焦点在画面上：被动态键盘事件才转发给远端。
  expect(document.activeElement).toBe(stage);
  await act(async () => {
    fireEvent.keyDown(stage, { key: 'a', code: 'KeyA' });
  });
  await flushInput();
  expect(bridge.adminStreamInput).toHaveBeenCalledWith({
    workspaceId: 'ws-a',
    event: { kind: 'keydown', key: 'a', code: 'KeyA' },
  });

  // 滚轮：位置同上，delta 是 CSS 像素。
  await act(async () => {
    fireEvent.wheel(canvas, {
      clientX: 480,
      clientY: 270,
      deltaX: 0,
      deltaY: 120,
      deltaMode: 0,
    });
  });
  await flushInput();
  expect(bridge.adminStreamInput).toHaveBeenCalledWith({
    workspaceId: 'ws-a',
    event: { kind: 'wheel', x: 960, y: 540, deltaX: 0, deltaY: 120 },
  });

  // 右键菜单被拦在本地：右键属于远端，宿主不弹菜单。
  const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  canvas.dispatchEvent(contextMenu);
  expect(contextMenu.defaultPrevented).toBe(true);
});

it('captures every key in full screen, leaves host rescue shortcuts, and releases on blur', async () => {
  bridge.adminContext.mockResolvedValue({ context: context({ desktopSession: 'running' }) });
  bridge.adminStreamStatus.mockResolvedValue({
    status: { ...STREAM_ACTIVE, active: false, desktopSession: 'running' },
  });
  await renderPanel();
  // 进入页面不自动开播：先由用户点「启动」，键鼠才有远端可发；首帧之后输入才可用。
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(64) });
  });
  const enter = screen.getByRole('button', {
    name: i18n.t('remoteWorkspace.admin.enterFullscreen'),
  });
  await act(async () => {
    fireEvent.click(enter);
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  // 键鼠进入捕获态（标签在控制条上，全屏时控制条本身隐藏，但输入语义不变）。
  expect(
    screen
      .getByTestId('remote-workspace-admin-stream-input-state')
      .getAttribute('data-input-state'),
  ).toBe('captured');
  // 同时通知 main：本窗口进入捕获态（宿主菜单快捷键让路 —— Electron accelerator 在 main 侧，
  // 渲染层 preventDefault 拦不住）。
  expect(bridge.setAdminStreamCaptureActive).toHaveBeenCalledWith({
    active: true,
    workspaceId: 'ws-a',
  });

  // 普通键：拦住宿主默认行为并转发给远端。
  let ctrlSPrevented = false;
  await act(async () => {
    const event = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);
    ctrlSPrevented = event.defaultPrevented;
  });
  expect(ctrlSPrevented).toBe(true);
  await flushInput();
  expect(bridge.adminStreamInput).toHaveBeenCalledWith({
    workspaceId: 'ws-a',
    event: { kind: 'keydown', key: 's', code: 'KeyS' },
  });

  // F5 留给宿主自救：不拦、不转发。
  const f5 = new KeyboardEvent('keydown', {
    key: 'F5',
    code: 'F5',
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(f5);
  expect(f5.defaultPrevented).toBe(false);
  // Escape 也留给宿主（全屏下它的语义是退出全屏，转发给远端反而让用户出不去）。
  const escape = new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(false);
  await flushInput();
  expect(bridge.adminStreamInput).toHaveBeenCalledTimes(1);

  // 窗口失焦：补发 keyup，远端不会停在「S 一直按着」。
  await act(async () => {
    window.dispatchEvent(new Event('blur'));
  });
  await flushInput();
  expect(bridge.adminStreamInput).toHaveBeenLastCalledWith({
    workspaceId: 'ws-a',
    event: { kind: 'keyup', key: 's', code: 'KeyS' },
  });

  await act(async () => {
    // 极简全屏下退出按钮在画面右下角（控制条随全屏隐藏）。
    const stage = screen.getByTestId('remote-workspace-admin-stream-stage');
    fireEvent.click(
      within(stage).getByRole('button', { name: i18n.t('remoteWorkspace.admin.exitFullscreen') }),
    );
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  // 退出全屏：通知 main 恢复宿主快捷键。
  expect(bridge.setAdminStreamCaptureActive).toHaveBeenLastCalledWith({
    active: false,
    workspaceId: 'ws-a',
  });
});

it('degrades to view-only when the workspace input channel is not available yet', async () => {
  // 旧 preload / 主进程通道尚未落地：没有 `adminStreamInput` → 只读观看，但仍可自动看画面。
  const readOnlyBridge: Record<string, unknown> = { ...bridge };
  delete readOnlyBridge.adminStreamInput;
  Object.assign(window, { electronAPI: { psbRemote: readOnlyBridge } });
  bridge.adminContext.mockResolvedValue({ context: context({ desktopSession: 'running' }) });
  bridge.adminStreamStatus.mockResolvedValue({
    status: { ...STREAM_ACTIVE, active: false, desktopSession: 'running' },
  });
  await renderPanel();
  // 进入页面不自动开播：先由用户点「启动」（只读降级只影响输入，不影响手动启动）。
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  const chip = screen.getByTestId('remote-workspace-admin-stream-input-state');
  expect(chip.getAttribute('data-input-state')).toBe('readonly');
  expect(chip.textContent).toContain(i18n.t('remoteWorkspace.admin.inputReadOnly'));
  expect(
    screen.getByTestId('remote-workspace-admin-stream-stage').getAttribute('tabindex'),
  ).toBeNull();
  // 只读不影响观看：手动启动照旧（且只触发了这一次）。
  expect(bridge.adminStreamStart).toHaveBeenCalledTimes(1);
});

/**
 * 停止失败也必须清屏并复位（独立审查 P1）：`adminStreamStop` reject 时旧实现只记错，
 * `subscribed/streaming` 仍是 true、画面留上一帧 —— 页签切走自动停止失败后再回来，
 * 面板还显示「串流中 / 停止」+ 冻结画面，违反「停止 / closed / 错误立即清空画面」。
 */
it('clears the picture and resets to not-started even when stopping is rejected', async () => {
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(1024) });
  });
  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  expect(canvas.getAttribute('data-has-picture')).toBe('true');

  bridge.adminStreamStop.mockRejectedValueOnce(new Error('[PSB_UNREACHABLE] offline'));
  playerMock.clear.mockClear();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.stop') }));
  });

  expect(bridge.adminStreamStop).toHaveBeenCalledWith({ workspaceId: 'ws-a' });
  // 画面清空、回到未启动态：不留冻结帧，也不留「串流中 / 停止」。
  expect(playerMock.clear).toHaveBeenCalled();
  expect(canvas.getAttribute('data-has-picture')).toBe('false');
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamIdle'),
  );
  expect(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') })).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: i18n.t('remoteWorkspace.session.stop') }),
  ).toBeNull();
  // 失败给的是中性、可行动的一句，而不是沉默或把原始英文/中文报错直接甩给用户。
  expect(screen.getByRole('alert').textContent).toBe(
    i18n.t('remoteWorkspace.session.stopFailed'),
  );
});

it('clears the picture when the automatic stop on hide is rejected', async () => {
  const view = await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(1024) });
  });
  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  bridge.adminStreamStop.mockRejectedValueOnce(new Error('[PSB_UNREACHABLE] offline'));
  view.rerender(
    <RemoteWorkspaceAdminPanel
      state={{}}
      ctx={ctx('local-a', 'psb:psb-a')}
      active={false}
      shellVisible
    />,
  );
  await act(async () => {});
  expect(bridge.adminStreamStop).toHaveBeenCalledWith({ workspaceId: 'ws-a' });
  expect(canvas.getAttribute('data-has-picture')).toBe('false');
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamIdle'),
  );
  expect(screen.getByRole('alert').textContent).toBe(
    i18n.t('remoteWorkspace.session.stopFailed'),
  );
});

/**
 * 点「启动」时 PSB 刚回推 `capability:false`（按钮禁用态来自上一次渲染）：旧实现静默 return，
 * 用户点了没反应；现在给一条能照做的原因。
 */
it('explains why starting did nothing when PSB says streaming is not capable', async () => {
  bridge.adminStreamStatus
    .mockResolvedValueOnce({ status: { ...STREAM_ACTIVE, active: false } })
    .mockResolvedValueOnce({ status: { ...STREAM_ACTIVE, active: false, capability: false } });
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  expect(bridge.adminStreamStart).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamUnsupported'),
  );
});

it('ignores context pushes resolved for another window’s task', async () => {
  await renderPanel();
  expect(screen.getByTestId('remote-workspace-admin-workspace-name').textContent).toBe('proj-a');
  // 广播是发给所有受信窗口的：`localSessionId` 不匹配 = 这条是别的窗口（主窗 / 独立页签窗口）
  // 的读取结果，丢弃，不能把本页换成另一个任务的工作区（否则写操作会落到别人的工作区上）。
  await act(async () => {
    pushContext?.({
      context: context({ workspaceId: 'ws-other', title: 'Other task workspace' }),
      localSessionId: 'local-other-window',
    });
  });
  expect(screen.getByTestId('remote-workspace-admin-workspace-name').textContent).toBe('proj-a');
  // 本窗口任务 id 的推送照常生效（换目录名 = 换实例）。
  await act(async () => {
    pushContext?.({
      context: context({ workspaceId: 'ws-b', title: 'Workspace B', directoryName: 'proj-b' }),
      localSessionId: 'local-a',
    });
  });
  expect(screen.getByTestId('remote-workspace-admin-workspace-name').textContent).toBe('proj-b');
});

it('keeps showing the fixed workspace details when the workspace is stale, instead of the empty state', async () => {
  // 2026-11-26 真机事故：PSB 读不到时旧页面变成「页头只有 — + 还没有远程工作区」。
  // 新口径：名称 / 模板 · 机器是固定信息，来自本机快照，必须照常显示；状态未知要有降级说明。
  bridge.adminContext.mockResolvedValue({ context: staleContext() });
  await renderPanel();

  // 固定信息全在：实例名（目录名）、模板名 · 机器名。
  expect(screen.getByTestId('remote-workspace-admin-workspace-name').textContent).toBe('proj-a');
  expect(screen.getByTestId('remote-workspace-admin-workspace-meta').textContent).toBe(
    'Saga2 · Machine A',
  );
  // 占用是状态信息：未知时显示「无法获取」，不沿用快照里过期的占用人。
  expect(screen.getByTestId('remote-workspace-admin-workspace-occupancy').textContent).toBe(
    i18n.t('remoteWorkspace.admin.occupancyValue', {
      value: i18n.t('remoteWorkspace.admin.staleOccupancy'),
    }),
  );
  // 降级说明 + PSB 原文诊断行；空态「还没有远程工作区」**不出现**。
  const notice = screen.getByTestId('remote-workspace-admin-stale-notice');
  expect(notice.getAttribute('data-stale-availability')).toBe('unavailable');
  expect(within(notice).getByText(i18n.t('remoteWorkspace.admin.staleUnavailableTitle'))).toBeTruthy();
  expect(within(notice).getByText(i18n.t('remoteWorkspace.admin.staleUnavailableHint'))).toBeTruthy();
  expect(screen.getByTestId('remote-workspace-admin-stale-detail').textContent).toBe('连不上 PSB');
  expect(screen.queryByTestId('remote-workspace-admin-no-workspace')).toBeNull();
  // stale 时连「读串流状态」都不发：main 没有可信绑定可读，白打一次只会多等一次超时。
  expect(bridge.adminStreamStatus).not.toHaveBeenCalled();
  // 页头操作仍在（占用语义未知，但点下去要给可行动原因，不是消失）。
  expect(screen.getByTestId('remote-workspace-admin-actions')).toBeTruthy();
  // 页头标记 stale（供样式 / 联调定位）。
  expect(
    screen.getByTestId('remote-workspace-admin-workspace-line').getAttribute('data-stale'),
  ).toBe('true');
});

it('distinguishes a deleted workspace from a temporary read failure', async () => {
  bridge.adminContext.mockResolvedValue({
    context: staleContext({
      availability: 'missing',
      staleReason: 'workspace-missing',
      lastErrorZh: null,
    }),
  });
  await renderPanel();
  const notice = screen.getByTestId('remote-workspace-admin-stale-notice');
  expect(notice.getAttribute('data-stale-availability')).toBe('missing');
  expect(within(notice).getByText(i18n.t('remoteWorkspace.admin.staleMissingTitle'))).toBeTruthy();
  // 名称 / 模板 / 机器照旧（主标题是目录名）。
  expect(screen.getByTestId('remote-workspace-admin-workspace-name').textContent).toBe('proj-a');
  expect(screen.getByTestId('remote-workspace-admin-workspace-meta').textContent).toBe(
    'Saga2 · Machine A',
  );
  // 没有 PSB 原文时不渲染空诊断行。
  expect(screen.queryByTestId('remote-workspace-admin-stale-detail')).toBeNull();
});

it('keeps the directory name as the instance name for historical sessions without template or machine', async () => {
  bridge.adminContext.mockResolvedValue({
    context: staleContext({
      // 历史会话种子：本机只有目录名这一条能确认「哪个工作区」的线索；任务标题不得冒充工作区名。
      title: '修一下检出脚本',
      templateTitle: null,
      clientName: '',
      directoryName: 'saga2_project-9',
      workspaceIdKnown: false,
    }),
  });
  await renderPanel();
  // 主标题 = 目录名（实例名），不是任务标题、也不是模板名。
  expect(screen.getByTestId('remote-workspace-admin-workspace-name').textContent).toBe(
    'saga2_project-9',
  );
  // 模板 / 机器都拿不到：次要不留空行也不重复目录名，显示占位「—」。
  expect(screen.getByTestId('remote-workspace-admin-workspace-meta').textContent).toBe('—');
  expect(screen.queryByTestId('remote-workspace-admin-no-workspace')).toBeNull();
});

it('gives an actionable reason instead of a generic failure when starting a stale workspace', async () => {
  bridge.adminContext.mockResolvedValue({ context: staleContext() });
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  // 不再发一次注定失败的 PSB 写请求；错误条是可行动的中文（工作区不可见 / 连不上）。
  expect(bridge.adminStreamStart).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toBe(
    i18n.t('remoteWorkspace.admin.staleUnavailableAction'),
  );
});

it('gives an actionable reason instead of a generic failure when occupying a stale workspace', async () => {
  bridge.adminContext.mockResolvedValue({ context: staleContext() });
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.admin.actionOccupy') }));
  });
  // 占用是工作区写操作：stale 时直接 toast 可行动原因，不调用 IPC、不弹通用「操作失败」。
  expect(bridge.occupyWorkspace).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith(i18n.t('remoteWorkspace.admin.staleUnavailableAction'));
});

/* ==================== 2026-11-26 独立审查 r4：状态机 / 保活 / 只读 ==================== */

it('does not turn the historical lastError into an error bar on entry (only this round fails)', async () => {
  bridge.adminStreamStatus.mockResolvedValue({
    status: {
      ...STREAM_ACTIVE,
      active: false,
      lastErrorZh: '上次会话的错误',
    },
  });
  await renderPanel();
  // 进页读到的历史错误只进详情 / 空态提示：这一轮用户还没做任何动作，红条会误导成「刚失败」。
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('上次会话的错误')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.details') }));
  expect(
    screen.getByTestId('remote-workspace-admin-stream-details').textContent,
  ).toContain('上次会话的错误');
});

it('returns to idle when the viewer is closed by another window (closed 补发)', async () => {
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(64) });
  });
  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  expect(canvas.getAttribute('data-has-picture')).toBe('true');
  playerMock.clear.mockClear();

  // 另一个窗口停止串流：main 广播同一条绑定的 closed（补发）。本窗口必须静默回未启动，
  // 不留「串流中 / 停止」按钮，也不把画面冻在上一帧。
  await act(async () => {
    pushStreamEvent({
      type: 'closed',
      sessionId: 'viewer-a',
      reason: 'stopped',
      detail: { reasonCode: null, desktopSession: null, messageZh: '已在别处停止' },
    });
  });
  expect(playerMock.clear).toHaveBeenCalled();
  expect(canvas.getAttribute('data-has-picture')).toBe('false');
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamIdle'),
  );
  expect(
    screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }),
  ).toBeTruthy();
  expect(screen.getByTestId('remote-workspace-admin-stream-closed-note').textContent).toContain(
    '已在别处停止',
  );
});

it('keeps the picture when the viewer connection is superseded (replaced, same session keeps streaming)', async () => {
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(64) });
  });
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamLive'),
  );
  playerMock.clear.mockClear();
  bridge.adminStreamStop.mockClear();

  // main 的观看端被**同会话**新连接替换：新 socket 继续往同一个 sessionId 送帧，所以这是
  // 非终态提示。旧实现把它当"关闭"：清屏回 idle、面板显示一次「已终止」，用户被判观看结束。
  await act(async () => {
    pushStreamEvent({
      type: 'closed',
      sessionId: 'viewer-a',
      reason: 'superseded',
      detail: { reasonCode: null, desktopSession: null, messageZh: null },
    });
  });

  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  expect(playerMock.clear).not.toHaveBeenCalled();
  expect(canvas.getAttribute('data-has-picture')).toBe('true');
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamLive'),
  );
  // 仍然是「停止」按钮（没有回到未启动），也没有被关闭的中性说明。
  expect(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.stop') })).toBeTruthy();
  expect(screen.queryByTestId('remote-workspace-admin-stream-closed-note')).toBeNull();
  // 这是同一条观看的延续，不是本端离开：不能顺手把 owner 释放掉。
  expect(bridge.adminStreamStop).not.toHaveBeenCalled();
});

it('releases the main-process owner when the stream ends without the user stopping', async () => {
  // 事件驱动的结束（PSB 关闭 / 错误断开）也必须发一次「仅释放 owner」：否则本端回到 idle 后
  // 停止路径提前 return，main 的 owner 计数永不归零，最后一个窗口停止时流不停（复审 P1）。
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(64) });
  });
  bridge.adminStreamStop.mockClear();

  await act(async () => {
    pushStreamEvent({
      type: 'closed',
      sessionId: 'viewer-a',
      reason: 'not-ready',
      detail: {
        reasonCode: 'NO_DESKTOP_SESSION',
        desktopSession: 'none',
        messageZh: '该工作区没有正在运行的桌面会话',
      },
    });
  });
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamIdle'),
  );
  expect(bridge.adminStreamStop).toHaveBeenCalledTimes(1);
  expect(bridge.adminStreamStop).toHaveBeenCalledWith({ workspaceId: 'ws-a' });

  // 错误断开同样释放（画面已经不可用，不能让本端继续占着观看名额）。
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  bridge.adminStreamStop.mockClear();
  await act(async () => {
    pushStreamEvent({
      type: 'error',
      sessionId: 'viewer-a',
      failure: { code: 'PSB_STREAM_UNREACHABLE', messageKey: null, message: 'read ECONNRESET' },
    });
  });
  expect(bridge.adminStreamStop).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('remote-workspace-admin-stream-failure')).toBeTruthy();
});

it('releases the viewer when the panel unmounts while starting (start still in flight)', async () => {
  // starting 相位卸载是「僵尸订阅」的来源：旧实现只在 connected 相位发 stop，启动落定后
  // main 才登记 owner，而渲染层已经卸载 → 没人再来释放。现在卸载时就发 stop，main 把它记成
  // 「启动在途的停止请求」，在启动落定时直接收尾。
  const view = await renderPanel();
  let resolveStart: (value: unknown) => void = () => {};
  bridge.adminStreamStart.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  // 前置 `adminStreamStatus` 已落定、`adminStreamStart` 仍在途 → 相位是 `starting`。
  expect(
    (screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(bridge.adminStreamStart).toHaveBeenCalledTimes(1);

  view.unmount();
  expect(bridge.adminStreamStop).toHaveBeenCalled();

  // 启动在卸载后才落定：不能再写状态，且释放请求仍然有效（幂等的第二次）。
  await act(async () => {
    resolveStart({ status: STREAM_ACTIVE, workspaceId: 'ws-a', viewerSessionId: 'viewer-a' });
  });
  expect(bridge.adminStreamStop).toHaveBeenCalled();
});

it('returns to idle when the workspace viewer binding disappears (watchdog / binding change)', async () => {
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(64) });
  });
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamLive'),
  );

  // main 推送的上下文里观看端绑定没了（另一个窗口停止 / 绑定被释放）：本端不再拥有画面。
  await act(async () => {
    pushContext?.({ context: context({ viewerSessionId: null }) });
  });
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamIdle'),
  );
  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  expect(canvas.getAttribute('data-has-picture')).toBe('false');
});

it('keeps the stream alive when switching categories (only a hidden tab releases it)', async () => {
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  await act(async () => {
    pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(64) });
  });
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamLive'),
  );

  // 切到版本控制：连接面板只隐藏、不卸载，也不释放观看名额（回来还是同一场串流）。
  await act(async () => {
    fireEvent.click(
      screen.getByRole('tab', { name: i18n.t('remoteWorkspace.admin.categories.versionControl') }),
    );
  });
  const panel = screen.getByTestId('remote-workspace-admin-connection-panel');
  expect(panel.getAttribute('aria-hidden')).toBe('true');
  expect(bridge.adminStreamStop).not.toHaveBeenCalled();

  await act(async () => {
    fireEvent.click(
      screen.getByRole('tab', { name: i18n.t('remoteWorkspace.admin.categories.connection') }),
    );
  });
  expect(panel.getAttribute('aria-hidden')).toBeNull();
  expect(bridge.adminStreamStart).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('remote-workspace-admin-stream-status').textContent).toBe(
    i18n.t('remoteWorkspace.session.streamLive'),
  );
});

it('releases the viewer exactly once after unmount and ignores late writes', async () => {
  const view = await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteWorkspace.session.start') }));
  });
  view.unmount();
  expect(bridge.adminStreamStop).toHaveBeenCalledTimes(1);
  // 卸载后迟到的帧 / 错误不能触发任何 state 写入或第二次释放（旧实现多处 setState 无守护）。
  pushStreamEvent({ type: 'frame', sessionId: 'viewer-a', payload: new ArrayBuffer(64) });
  pushStreamEvent({
    type: 'error',
    sessionId: 'viewer-a',
    failure: { code: 'PSB_STREAM_UNREACHABLE', messageKey: null, message: 'late' },
  });
  expect(bridge.adminStreamStop).toHaveBeenCalledTimes(1);
});

it('shows the VCS notice instead of a generic error when both would appear (one fact, one surface)', async () => {
  bridge.adminContext.mockResolvedValue({
    context: context({ occupancy: { occupied: false, byMe: false, personName: '' } }),
  });
  bridge.occupyWorkspace.mockRejectedValue(new Error('[PSB_WORKSPACE_VCS_DIRTY] 有未提交修改'));
  bridge.workspaceVcsNotice.mockResolvedValue({ workspaceId: 'ws-a', notice: VCS_ADVISORY });
  await renderPanel();
  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', { name: i18n.t('remoteWorkspace.admin.actionOccupy') }),
    );
  });
  // 旧版 409 的可执行处置动作已经在 VCS 通知里：不再叠一条通用错误 toast。
  expect(toast.error).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(
      screen.getByRole('tab', { name: i18n.t('remoteWorkspace.admin.categories.versionControl') }),
    );
  });
  expect(screen.getByTestId('workspace-vcs-notice').textContent).toContain(
    VCS_ADVISORY.messageZh,
  );
});

it('disables the version-control actions when the workspace context is stale', async () => {
  bridge.adminContext.mockResolvedValue({ context: staleContext() });
  await renderPanel();
  await act(async () => {
    pushVcsNotice(VCS_ADVISORY);
  });
  await act(async () => {
    fireEvent.click(
      screen.getByRole('tab', { name: i18n.t('remoteWorkspace.admin.categories.versionControl') }),
    );
  });
  expect(screen.getByTestId('workspace-vcs-read-only-hint').textContent).toBe(
    i18n.t('remoteWorkspace.admin.staleUnavailableAction'),
  );
  // 清理是不可逆写操作：stale 时按钮禁用（点下去只有 404）。
  expect((screen.getByText('一键清理') as HTMLButtonElement).disabled).toBe(true);
});

it('does not read the workspace context while the tab is hidden, and loads as soon as it is shown', async () => {
  const view = render(
    <RemoteWorkspaceAdminPanel
      state={{}}
      ctx={ctx('local-a', 'psb:psb-a')}
      active={false}
      shellVisible
    />,
  );
  await act(async () => {});
  // 页签不可见：不发 IPC（旧实现挂载时就先读一次、隐藏时仍每 30s 一次）。
  expect(bridge.adminContext).not.toHaveBeenCalled();

  view.rerender(
    <RemoteWorkspaceAdminPanel state={{}} ctx={ctx('local-a', 'psb:psb-a')} active shellVisible />,
  );
  await act(async () => {});
  // 重新可见：立即补读，不等下一档轮询。
  expect(bridge.adminContext).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('remote-workspace-admin-workspace-name').textContent).toBe('proj-a');
});

it('ships localized copy for the new page actions and details fields', () => {
  // 12 locale 的 key 完整性由 `pnpm check:i18n` 负责；这里锁住页面真正用到的 key 都能解析，
  // 不是把 i18n key 原样渲染到界面上。
  for (const key of [
    'remoteWorkspace.admin.actionOccupy',
    'remoteWorkspace.admin.actionRelease',
    'remoteWorkspace.admin.actionOpenWeb',
    'remoteWorkspace.admin.occupancyMine',
    'remoteWorkspace.admin.occupancyFree',
    'remoteWorkspace.admin.occupancySelfValue',
    'remoteWorkspace.admin.actionOccupyDone',
    'remoteWorkspace.admin.actionReleaseDone',
    'remoteWorkspace.admin.enterFullscreen',
    'remoteWorkspace.admin.exitFullscreen',
    'remoteWorkspace.admin.detailLastError',
    'remoteWorkspace.admin.detailReasonCode',
    'remoteWorkspace.admin.detailDesktopSession',
    'remoteWorkspace.admin.desktopSessionNone',
    'remoteWorkspace.admin.desktopSessionStarting',
    'remoteWorkspace.admin.desktopSessionRunning',
    'remoteWorkspace.admin.inputInteractive',
    'remoteWorkspace.admin.inputCaptured',
    'remoteWorkspace.admin.inputReadOnly',
    'remoteWorkspace.admin.inputInteractiveHint',
    'remoteWorkspace.admin.inputCapturedHintWindows',
    'remoteWorkspace.admin.inputCapturedHintMac',
    'remoteWorkspace.admin.inputReadOnlyHint',
    'remoteWorkspace.admin.streamInfo',
    'remoteWorkspace.admin.streamInfoClose',
    'remoteWorkspace.admin.streamInfoCodec',
    'remoteWorkspace.admin.streamInfoBitrate',
    'remoteWorkspace.admin.streamInfoDecodeTime',
    'remoteWorkspace.admin.streamInfoDropped',
    'remoteWorkspace.admin.streamInfoQueue',
    'remoteWorkspace.admin.streamInfoConnection',
    'remoteWorkspace.admin.exitFullscreenEsc',
    'remoteWorkspace.admin.staleMissingTitle',
    'remoteWorkspace.admin.staleMissingHint',
    'remoteWorkspace.admin.staleMissingAction',
    'remoteWorkspace.admin.staleUnavailableTitle',
    'remoteWorkspace.admin.staleUnavailableHint',
    'remoteWorkspace.admin.staleUnavailableAction',
    'remoteWorkspace.admin.staleUnknownWorkspaceAction',
    'remoteWorkspace.admin.staleOccupancy',
    'remoteWorkspace.session.streamUnsupported',
    'remoteWorkspace.session.stopFailed',
  ]) {
    expect(i18n.t(key)).not.toBe(key);
  }
});
