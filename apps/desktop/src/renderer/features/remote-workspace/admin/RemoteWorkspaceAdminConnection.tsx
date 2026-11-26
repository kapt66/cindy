/**
 * 「远程工作区 › 远程连接」分类的页面主体：横条控制区 + 全屏串流画面。
 *
 * 数据全部来自**工作区级**桥（`psbWorkspaceAdminBridge.ts`，契约正本
 * `shared/psb-workspace-admin.ts`）：
 *   - 工作区信息（客户端 / 工作区 / 目录 / 占用 / 桌面会话）来自 `adminContext` 的宿主；
 *   - 启动 / 停止 / 状态按 `workspaceId` 操作；主进程用一个**内部观看端 PSB 会话**订阅
 *     串流，用户任务是否结束、是否还存在都不影响这里的按钮。
 *
 * 布局（自上而下）：
 *   1. 横条控制区：启动 / 停止是同一个按钮切换，另有详情 / 串流信息 / 全屏 + 状态文案；高度恒定。
 *   2. 错误条（PSB 失败原话）/ 中性说明（观看端被 PSB 关闭时它给的 close reason 原话）。
 *   3. 画面：`flex-1 min-h-0` 的 canvas 容器，等比铺满、容器自己 `overflow-hidden`，
 *      不产生第二层滚动条；未启动 / 等待 / 失败时在画面上叠空态说明。
 *
 * **详情是浮层，不占布局**：点「详情」在按钮下方弹 Popover（分辨率 / 编码 / 帧率 / 最近
 * 错误 / `reasonCode` / `desktopSession`），Esc、点外部或再点按钮关闭；打开与关闭都不改变
 * 控制条高度、不让画面位移。
 *
 * **串流信息（2026-11-26 用户口径）**：控制条里的「串流信息」开关打开后，画面右上角浮出性能
 * HUD（半透明深色 chrome，可关闭）：分辨率、编码/解码器、最近 1s FPS、最近 1s 码率、解码
 * 耗时 avg/p95、丢帧、解码队列、连接状态。数据来自本端收到的帧数/字节数 + `psbStreamPlayer`
 * 的解码统计；没有 / 读不到的字段显示「—」，不编造。HUD 是浮层，不改变布局。
 *
 * **全屏是极简模式（2026-11-26 用户口径，对齐 PSB 网页）**：进入全屏后页面 chrome 全部由
 * 原生全屏隐藏，画面里**只保留右下角一个全屏切换图标按钮**（带 Tip / Esc 提示），Esc 或按钮
 * 退出；控制条只存在于非全屏。已开启的「串流信息」HUD 在全屏下仍显示在右上角。
 * 全屏与工作区可用性绑定，不依赖会话状态。
 *
 * **进入页面不自动启动**（2026-11-26 用户改口）：不再因为远端 `desktopSession:running` /
 * `status.active` 自动 `adminStreamStart`，一律由用户点「启动」明确开始；页面进入时保持
 * 「串流未启动」空占位（HUD 字段为「—」）。切走页签 / 收起页签 / 切到别的工作区 / 切到别的
 * 分类时仍然**自动释放**观看名额（先补释放键鼠；PSB 每工作区观看名额有限，见产品正本 §2.4、
 * 工程契约 §5），回来需要用户再点「启动」。
 *
 * **「已连接」与「有画面」是两个状态（2026-11-26 口径，独立审查修复）**：`subscribed` 只表示
 * 本端订阅已建立（「启动」成功、按钮切「停止」），`streaming` **只由本端收到的 `frame` 事件
 * 置 true**。PSB 的 `active` 表示「那台机器此刻有没有采集」，既不是「本端有画面」，也不能
 * 反过来把已经在播的画面切回未启动；它只留在 `status` 里供提示 / 详情使用。启动成功到首帧
 * 之间面板显示「已连接，等待画面…」。
 *
 * **停止 / 关闭 / 错误立即清空画面（含停止失败）**：`adminStreamStop` reject 时同样无条件
 * 复位「未订阅 / 未流式」并 `clearPicture()`，只留一条中性可行动提示（停止失败不留冻结帧、
 * 不留「串流中 / 停止」按钮）；`closed` / 错误断开 / 切工作区 / 卸载路径一致。成功路径清掉
 * 上一轮的失败条，避免旧原因挂在新状态上。
 *
 * **可交互观看**（2026-11-26 用户口径）：画面在订阅建立后接受键鼠 / 滚轮输入，指针进入画面即
 * 由远端接管（位置同步到远端机器）；全屏时键鼠全部转发到远端并拦住宿主默认行为（只留 F5 /
 * F11 / F12、Ctrl+Shift+I/J/C 给宿主自救）。输入经**工作区级** `adminStreamInput` 发到同一条
 * 串流 WS；该通道缺失（旧 preload）时降级成「只读观看」并如实标注。
 *
 * **宿主光标形状同步**（2026-11-26，对齐 PSB 网页串流；同日改口径）：PSB 把客户端上报的宿主
 * 光标作为 `stream.cursor` 文本帧转发，main 校验后推 `PsbStreamEvent{type:'cursor'}`；本组件交给
 * `usePsbStreamCursor` 把形状（`name`）映射成 **CSS 关键字**写到 **canvas（画面区域）**，外观
 * 永远是宿主本机指针风格（不再用远端 PNG 位图，免得把 Windows/macOS 指针换成 Linux 主题外观）。
 * **只有鼠标停在画面区域时才同步**：离开画面立即恢复宿主默认，HUD / 全屏退出按钮 / 控制条这些
 * 本地 UI 不受影响。停止 / closed / 错误 / 切工作区 / 卸载恢复宿主默认光标。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Cast, CircleAlert, Eye, Info, Minimize2, MousePointerClick, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { extractIpcError } from '../../../../shared/ipcError';
import {
  psbAdminStreamStatusFromPsb,
  type PsbWorkspaceAdminContext,
  type PsbWorkspaceAdminStreamStatus,
} from '../../../../shared/psb-workspace-admin';
import type { PsbStreamEvent } from '../../../../shared/psb-remote-workspace';
import { createPsbStreamPlayer, type PsbStreamPlayer, type PsbStreamPlayerStats } from '../stream/psbStreamPlayer';
import { canManuallyStartPsbStream, shouldReleasePsbStreamOnLeave } from './psbStreamLifecycle';
import {
  normalizeWorkspaceAdminStreamStart,
  normalizeWorkspaceAdminStreamStatus,
  tryGetPsbWorkspaceAdminBridge,
} from './psbWorkspaceAdminBridge';
import { usePsbStreamCursor } from './usePsbStreamCursor';
import { usePsbStreamInteraction } from './usePsbStreamInteraction';

/** 详情里没有值时的占位（不编造数据）。 */
const EMPTY_VALUE = '—';

/** 「串流信息」HUD 的最近 1s 采样快照。 */
interface StreamInfoSnapshot {
  readonly fps: number | null;
  readonly mbps: number | null;
  readonly playerStats: PsbStreamPlayerStats | null;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function streamFailureMessage(t: ReturnType<typeof useTranslation>['t'], error: unknown): string {
  // IPC 失败的 `Error.message` 会被 Electron 包成长串；能用 extractIpcError 取出 code+message
  // 时只展示 PSB 原文（含「没有可观看的画面」这类可行动句子）。
  const ipc = extractIpcError(error);
  if (ipc) {
    const trimmed = ipc.message.trim();
    if (trimmed) return trimmed;
  }
  const message = error instanceof Error ? error.message.trim() : '';
  return message || t('remoteWorkspace.error.unknown');
}

function eventFailureMessage(
  t: ReturnType<typeof useTranslation>['t'],
  failure: Extract<PsbStreamEvent, { type: 'error' }>['failure'],
): string {
  const message = failure.message?.trim();
  if (message) return message;
  const key = failure.messageKey?.trim();
  return key ? t(key) : t('remoteWorkspace.error.unknown');
}

/**
 * 「为什么现在没有画面」的引导文案。
 *
 * 机器判断按 PSB 的 `reasonCode` / `desktopSession`（结构化字段），不解析中文；中文原话
 * （`lastErrorZh`）只在没有结构化归因时兜底显示。`null` 一律当「未知」，不显示
 * 「没有桌面会话」这种会把网络抖动说成事实的句子。
 */
function streamReasonHintKey(
  context: PsbWorkspaceAdminContext,
  status: PsbWorkspaceAdminStreamStatus | null,
): string | null {
  const reasonCode = status?.reasonCode ?? context.reasonCode;
  const desktopSession = status?.desktopSession ?? context.desktopSession;
  if (reasonCode === 'CLIENT_NO_STREAMING' || status?.capable === false) {
    return 'remoteWorkspace.admin.streamReasonNoStreaming';
  }
  if (reasonCode === 'NO_DESKTOP_SESSION' || desktopSession === 'none') {
    return 'remoteWorkspace.admin.streamReasonNoDesktop';
  }
  if (reasonCode === 'CAPTURE_NOT_READY' || desktopSession === 'starting') {
    return 'remoteWorkspace.admin.streamReasonCaptureNotReady';
  }
  return null;
}

/** 桌面会话三态 → 本地化短词；`null` = 未知（显示占位，不猜 `none`）。 */
function desktopSessionLabel(
  t: ReturnType<typeof useTranslation>['t'],
  state: PsbWorkspaceAdminContext['desktopSession'],
): string {
  if (state === 'none') return t('remoteWorkspace.admin.desktopSessionNone');
  if (state === 'starting') return t('remoteWorkspace.admin.desktopSessionStarting');
  if (state === 'running') return t('remoteWorkspace.admin.desktopSessionRunning');
  return EMPTY_VALUE;
}

export function RemoteWorkspaceAdminConnection({
  context,
  active,
  shellVisible,
}: {
  readonly context: PsbWorkspaceAdminContext;
  readonly active?: boolean;
  readonly shellVisible?: boolean;
}) {
  const { t } = useTranslation();
  const bridge = tryGetPsbWorkspaceAdminBridge();
  const workspaceId = context.workspaceId;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<PsbStreamPlayer | null>(null);
  const mountedRef = useRef(true);
  const streamingRef = useRef(false);
  const subscribedRef = useRef(false);
  const stoppingRef = useRef(false);
  /**
   * 本工作区内部观看端会话 id（用于过滤串流事件）。先取上下文里已知的值；`STREAM_START`
   * 返回的更新值优先。未知时不过滤（宁可能收到旧事件也不能丢首帧）。
   */
  const viewerSessionIdRef = useRef<string | null>(context.viewerSessionId);
  const [playerUnavailable, setPlayerUnavailable] = useState(false);
  const [status, setStatus] = useState<PsbWorkspaceAdminStreamStatus | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 观看端被 PSB 关闭时它给的原话（`detail.messageZh`，中性提示，不是错误条）。 */
  const [closedNote, setClosedNote] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** 「串流信息」HUD：非全屏控制条开关，全屏下保持原状态可见（右上角）。 */
  const [showStreamInfo, setShowStreamInfo] = useState(false);
  const [streamInfo, setStreamInfo] = useState<StreamInfoSnapshot | null>(null);
  /** 最近 1s 的帧数 / 字节数窗口（HUD 的 FPS 与码率唯一数据源）。 */
  const frameWindowRef = useRef({ frames: 0, bytes: 0, startedAt: nowMs() });

  streamingRef.current = streaming;
  subscribedRef.current = subscribed;

  /**
   * `t` 的最新引用：卸载 effect 里的自动停止不能因为「切换语言导致 `t` 变身份」重跑 ——
   * 那会把清理当作卸载、在用户只是改了界面语言时停掉串流。文案仍按当下语言取。
   */
  const translateRef = useRef(t);
  translateRef.current = t;

  // 键鼠交互（可交互观看）：输入归一 / 全屏捕获 / 释放策略都在 hook 里，这里只消费状态。
  const {
    interactive,
    capture: captureMode,
    keyboardLock,
    requestKeyboardLock,
  } = usePsbStreamInteraction({
    workspaceId,
    stageRef,
    canvasRef,
    streaming,
    remoteSize: { width: status?.width ?? null, height: status?.height ?? null },
    fullscreen: isFullscreen,
  });

  // 宿主光标形状（2026-11-26）：订阅建立后跟随远端**形状**（I-beam / pointer / resize / loading），
  // 但只把 CSS 关键字写到 canvas（画面区域）、由本机主题渲染外观；指针离开画面立即恢复宿主默认。
  // 停止 / closed / 错误 / 切工作区 / 卸载回宿主默认。HUD 与全屏退出按钮在 canvas 之外，不继承。
  usePsbStreamCursor({
    bridge,
    canvasRef,
    stageRef,
    viewerSessionIdRef,
    active: subscribed || streaming,
  });

  // 上下文推送会带出内部观看端会话 id（main 懒创建 / 复用后的真值），同步给事件过滤器。
  useEffect(() => {
    if (context.viewerSessionId) viewerSessionIdRef.current = context.viewerSessionId;
  }, [context.viewerSessionId]);

  // 播放器：canvas 挂载后创建；WebCodecs 缺席时 playerUnavailable → 空态里说明不支持。
  //
  // 依赖刻意留空、`t` 走 `translateRef`：否则观看中切换界面语言会让 effect 重跑并 dispose 当前
  // 播放器，新实例再也拿不到上一次的 config（画面空白，必须手动停 / 再启动才恢复）。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const player = createPsbStreamPlayer(canvas, {
      onFailure: (failure) => {
        if (!mountedRef.current) return;
        const translate = translateRef.current;
        setError(
          translate('remoteWorkspace.session.streamFailed', {
            message:
              failure === 'unsupported'
                ? translate('remoteWorkspace.session.streamUnsupported')
                : translate('remoteWorkspace.error.unknown'),
          }),
        );
      },
    });
    if (!player) {
      setPlayerUnavailable(true);
      return undefined;
    }
    setPlayerUnavailable(false);
    playerRef.current = player;
    return () => {
      playerRef.current = null;
      player.dispose();
    };
  }, []);

  /**
   * 停止 / 关闭 / 错误断开时**立刻清空画面**：点「停止」后画面区不能留着上一帧的冻结画面。
   * 播放器 `clear()` 同时清 canvas 尺寸与解码状态，下一次 config 会重新 configure。
   */
  const clearPicture = useCallback(() => {
    playerRef.current?.clear();
    frameWindowRef.current = { frames: 0, bytes: 0, startedAt: nowMs() };
    setStreamInfo(null);
  }, []);

  // 「串流信息」每次打开都重置采样窗口：关闭期间累积的帧不算进「最近 1s」。
  useEffect(() => {
    if (!showStreamInfo) return;
    frameWindowRef.current = { frames: 0, bytes: 0, startedAt: nowMs() };
    setStreamInfo(null);
  }, [showStreamInfo]);

  // HUD 每秒刷新一次：最近 1s 的帧数 / 字节数算 FPS 与码率，其余来自播放器统计。
  // 没有 / 读不到的字段保持 `null`，由渲染层显示「—」，不编造。
  useEffect(() => {
    if (!showStreamInfo) return undefined;
    const tick = () => {
      const now = nowMs();
      const bucket = frameWindowRef.current;
      const elapsed = Math.max(1, now - bucket.startedAt);
      const live = streamingRef.current;
      setStreamInfo({
        fps: live ? (bucket.frames * 1000) / elapsed : null,
        mbps: live ? (bucket.bytes * 8) / 1000 / elapsed : null,
        playerStats: playerRef.current?.getStats() ?? null,
      });
      frameWindowRef.current = { frames: 0, bytes: 0, startedAt: now };
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [showStreamInfo]);

  // 全屏状态：浏览器是唯一事实（Esc 退出不经过我们），只同步回来。
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onChange = () => setIsFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', onChange);
    onChange();
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (typeof document === 'undefined') return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen?.();
        return;
      }
      const stage = stageRef.current;
      if (stage && typeof stage.requestFullscreen === 'function') {
        await stage.requestFullscreen();
        // 全屏兑现后仍在用户手势链里：把焦点放回画面并尽力申请 Keyboard Lock（不支持则降级，
        // 不影响事件级捕获）。`fullscreenchange` 里还会幂等重试一次。
        stage.focus({ preventScroll: true });
        requestKeyboardLock();
      }
    } catch {
      // 用户拒绝 / 环境不支持全屏：保持原布局，不报错、不影响串流。
    }
  }, [requestKeyboardLock]);

  // 串流事件由主进程按管理工作区转发（事件仍是 `PsbStreamEvent` 形状，`sessionId` 是内部
  // 观看端会话）。已知观看端会话 id 时只吃本会话的事件，避免旧会话收尾事件画到新画面里。
  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onAdminStreamEvent((event) => {
      if (!mountedRef.current) return;
      const viewerSessionId = viewerSessionIdRef.current;
      if (viewerSessionId && event.sessionId && event.sessionId !== viewerSessionId) return;
      // 宿主光标形状由 `usePsbStreamCursor` 独立消费（同一条广播允许多个监听者）：
      // 它不是画面生命周期事件，落进下面的 error 兜底会被误报成串流失败。
      if (event.type === 'cursor') return;
      if (event.type === 'frame') {
        // 首帧到达即视为在串流：不依赖 PSB 是否回推 status（观看端协议里帧是主信号）。
        if (!streamingRef.current) setStreaming(true);
        const bucket = frameWindowRef.current;
        bucket.frames += 1;
        bucket.bytes += event.payload.byteLength;
        playerRef.current?.push(event.payload);
        return;
      }
      if (event.type === 'status') {
        const next = psbAdminStreamStatusFromPsb(event.status);
        setStatus(next);
        // `streaming` **只由本端收到 `frame` 决定**：PSB 的 `active` 是「那台机器此刻有没有采集」，
        // 不是「本端有没有画面」。拿它当判据会出现两种错：订阅成功但零帧时显示「串流中」，
        // 以及 active:false 而帧仍在到时切回未启动。`active` 只留在 `status` 里供提示 / 详情使用。
        if (next.lastErrorZh) {
          setError(t('remoteWorkspace.session.streamFailed', { message: next.lastErrorZh }));
        }
        return;
      }
      if (event.type === 'closed') {
        setStreaming(false);
        setSubscribed(false);
        // 已经建立的观看被 PSB 关掉（未就绪 / 慢订阅者）：不自动重连（本页也不再自动启动），
        // 用户点「启动」再试。关掉订阅后画面必须立刻清空，不能留上一帧；上一次的失败条
        // 已经由这次关闭的说明取代，清掉避免新旧原因同时挂着。
        setError(null);
        clearPicture();
        const messageZh = event.detail?.messageZh?.trim();
        if (messageZh) setClosedNote(messageZh);
        return;
      }
      setStreaming(false);
      clearPicture();
      setError(
        t('remoteWorkspace.session.streamFailed', {
          message: eventFailureMessage(t, event.failure),
        }),
      );
    });
  }, [bridge, clearPicture, t]);

  // 打开分类时读一次串流状态（能力位 / 桌面会话 / 最近错误），决定按钮可用性与说明。
  // `status: null` = 此刻读不到：保留「未知」，不把启动按钮锁死。
  useEffect(() => {
    if (!bridge) return undefined;
    let live = true;
    void bridge
      .adminStreamStatus({ workspaceId })
      .then((result) => {
        if (!live || !mountedRef.current) return;
        const normalized = normalizeWorkspaceAdminStreamStatus(result);
        if (!normalized) return;
        setStatus(normalized);
        if (normalized.lastErrorZh) {
          setError(t('remoteWorkspace.session.streamFailed', { message: normalized.lastErrorZh }));
        }
      })
      .catch(() => {
        // 连通性错误留给「启动」这个显式动作去报，打开分类时静默。
      });
    return () => {
      live = false;
    };
  }, [bridge, workspaceId, t]);

  /**
   * 自动释放观看名额（页签不可见 / 卸载 / 切工作区）。
   *
   * **停止失败也必须把本端状态清掉**：用户已经看不到画面（页签切走 / 关闭），残留
   * 「串流中 / 停止」按钮与上一帧冻结画面比一次停止失败更糟，也违反「停止 / closed /
   * 错误立即清空画面」。失败只给一条中性可行动提示（下次启动会重新订阅，main 侧断连
   * 也会兜底释放名额）。
   */
  const stopViewer = useCallback(async () => {
    if (!bridge || stoppingRef.current) return;
    if (!subscribedRef.current && !streamingRef.current) return;
    stoppingRef.current = true;
    try {
      await bridge.adminStreamStop({ workspaceId });
      if (mountedRef.current) setError(null);
    } catch {
      if (mountedRef.current) setError(translateRef.current('remoteWorkspace.session.stopFailed'));
    } finally {
      stoppingRef.current = false;
      clearPicture();
      if (mountedRef.current) {
        setSubscribed(false);
        setStreaming(false);
      }
    }
  }, [bridge, clearPicture, workspaceId]);

  // 页签可见性用**既有 tab pane 机制**（`active` + `shellVisible`）：页签被切走 / 右侧栏折叠时
  // body 是 `display:none`；不用 `document.visibilityState`（它只反映窗口，后台页签仍是 visible，
  // 拿它当判据会在用户看不到画面时仍占着 PSB 的观看名额）。
  const visible = active !== false && shellVisible !== false;

  // 卸载（关闭页签 / 切到另一个工作区 / 切到别的分类）：释放观看名额。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void stopViewer();
    };
  }, [stopViewer]);

  /**
   * 用户显式「启动」：进入页面 / 页签重新可见都**不自动开播**（2026-11-26 用户口径）。
   * 启动前先读一次工作区串流状态，PSB 明确不支持时给可行动提示、不再发 start。
   */
  const handleStart = useCallback(async () => {
    if (!bridge || starting) return;
    setStarting(true);
    setError(null);
    setClosedNote(null);
    try {
      const next = normalizeWorkspaceAdminStreamStatus(
        await bridge.adminStreamStatus({ workspaceId }),
      );
      if (next) setStatus(next);
      if (next && !next.capable) {
        // 状态可能刚被推送刷新成 capable:false（按钮的禁用态来自上一次渲染）：用户点了
        // 「启动」却什么都不发生是最糟的反馈，这里给一条能照做的原因。
        setError(t('remoteWorkspace.admin.streamReasonNoStreaming'));
        return;
      }
      const started = normalizeWorkspaceAdminStreamStart(
        await bridge.adminStreamStart({ workspaceId }),
      );
      if (!started) {
        setSubscribed(false);
        setStreaming(false);
        return;
      }
      setStatus(started.status);
      if (started.viewerSessionId) viewerSessionIdRef.current = started.viewerSessionId;
      // 订阅成功 ≠ 有画面：这里只置「已订阅」，面板显示「已连接，等待画面…」。
      // 「串流中」只能由首帧（`frame` 事件）置位，PSB 的 `active` 不参与该判定。
      setSubscribed(true);
      setError(null);
    } catch (failure) {
      setSubscribed(false);
      setStreaming(false);
      setError(
        t('remoteWorkspace.session.streamFailed', {
          message: streamFailureMessage(t, failure),
        }),
      );
    } finally {
      if (mountedRef.current) setStarting(false);
    }
  }, [bridge, starting, t, workspaceId]);

  const handleStop = useCallback(async () => {
    if (!bridge || stopping) return;
    setStopping(true);
    try {
      await bridge.adminStreamStop({ workspaceId });
      // 成功：清掉上一次启动 / 关闭留下的错误条，不把旧原因挂在新状态上。
      setError(null);
      setClosedNote(null);
    } catch {
      // 失败也要给一条中性、可行动的话；画面与按钮状态照下面 finally 复位，不残留旧帧。
      setError(t('remoteWorkspace.session.stopFailed'));
    } finally {
      // **无条件**复位：停止请求失败时 PSB 可能仍在采集中，但用户已经明确不要看了，
      // 本端必须立刻清空画面并回到「串流未启动」（停止 / closed / 错误立即清屏的口径）。
      clearPicture();
      if (mountedRef.current) {
        setSubscribed(false);
        setStreaming(false);
        setStopping(false);
      }
    }
  }, [bridge, clearPicture, stopping, t, workspaceId]);

  const capable = status?.capable ?? null;
  const unavailable = !bridge || playerUnavailable || capable === false;
  /**
   * 启动 / 停止是**同一个按钮位置**（用户 2026-11-26 口径）：订阅建立（含等待画面）即算
   * 「正在播」，按钮切到「停止」——否则用户无法关掉一个在等的连接。
   */
  const playing = subscribed || streaming;

  /* ------------------------ 生命周期：只自动停止，不自动启动 ------------------------ */

  /** 启动可点条件（纯函数）。不看远端是否 running：没有桌面会话时也允许点，由 PSB 失败码给提示。 */
  const startDisabled = !canManuallyStartPsbStream({
    bridgeReady: Boolean(bridge),
    playerAvailable: !playerUnavailable,
    capable: capable !== false,
    starting,
  });
  const stopDisabled = !playing || stopping || !bridge;

  // 页签不可见（切走 / 折叠）且已连接：自动释放观看名额。回来**不会**自动开播，需要用户再点「启动」。
  const releaseOnLeave = shouldReleasePsbStreamOnLeave({
    visible,
    connected: playing,
    stopping,
  });
  useEffect(() => {
    if (releaseOnLeave) void stopViewer();
  }, [releaseOnLeave, stopViewer]);

  /* ------------------------------ 交互状态标签 ------------------------------ */

  const inputState = captureMode ? 'captured' : interactive ? 'interactive' : 'readonly';
  const inputLabel =
    inputState === 'captured'
      ? t('remoteWorkspace.admin.inputCaptured')
      : inputState === 'interactive'
        ? t('remoteWorkspace.admin.inputInteractive')
        : t('remoteWorkspace.admin.inputReadOnly');
  const inputHint =
    inputState === 'captured'
      ? t('remoteWorkspace.admin.inputCapturedHint')
      : inputState === 'interactive'
        ? t('remoteWorkspace.admin.inputInteractiveHint')
        : t('remoteWorkspace.admin.inputReadOnlyHint');

  const reasonHintKey = streamReasonHintKey(context, status);
  const psbHint = status?.lastErrorZh?.trim() || context.lastErrorZh?.trim() || null;
  const overlayText = unavailable
    ? t('remoteWorkspace.session.streamUnsupported')
    : starting
      ? t('remoteWorkspace.session.streamConnecting')
      : subscribed && !streaming
        ? t('remoteWorkspace.session.streamWaiting')
        : t('remoteWorkspace.admin.streamNotStarted');
  const overlayHint = unavailable
    ? null
    : subscribed || starting
      ? null
      : reasonHintKey
        ? t(reasonHintKey)
        : psbHint || t('remoteWorkspace.admin.streamStartHint');
  const statusText = streaming
    ? t('remoteWorkspace.session.streamLive')
    : starting
      ? t('remoteWorkspace.session.streamConnecting')
      : subscribed
        ? t('remoteWorkspace.session.streamWaiting')
        : t('remoteWorkspace.admin.streamNotStarted');
  const resolution =
    status?.width != null && status.height != null
      ? `${status.width} × ${status.height}`
      : EMPTY_VALUE;
  const encoder = status?.encoder?.trim() || EMPTY_VALUE;
  const fps = status?.fps != null ? `${status.fps} fps` : EMPTY_VALUE;
  const lastError = status?.lastErrorZh?.trim() || context.lastErrorZh?.trim() || EMPTY_VALUE;
  const reasonCode = status?.reasonCode ?? context.reasonCode ?? EMPTY_VALUE;
  const desktopSession = desktopSessionLabel(t, status?.desktopSession ?? context.desktopSession);
  const fullscreenLabel = isFullscreen
    ? t('remoteWorkspace.admin.exitFullscreen')
    : t('remoteWorkspace.admin.enterFullscreen');

  /* ------------------------------ 串流信息 HUD ------------------------------ */

  const hudPlayerStats = streamInfo?.playerStats ?? null;
  const hudCodec =
    [status?.encoder?.trim(), hudPlayerStats?.codec?.trim()].filter(Boolean).join(' / ') ||
    EMPTY_VALUE;
  const hudFps = streamInfo?.fps != null ? `${Math.round(streamInfo.fps)} fps` : EMPTY_VALUE;
  const hudBitrate = streamInfo?.mbps != null ? `${streamInfo.mbps.toFixed(2)} Mbps` : EMPTY_VALUE;
  const hudDecode =
    hudPlayerStats?.decodeLatencyAvgMs != null
      ? `${hudPlayerStats.decodeLatencyAvgMs.toFixed(1)} ms${
          hudPlayerStats.decodeLatencyP95Ms != null
            ? ` (p95 ${hudPlayerStats.decodeLatencyP95Ms.toFixed(1)} ms)`
            : ''
        }`
      : EMPTY_VALUE;
  const hudDropped = hudPlayerStats ? String(hudPlayerStats.droppedFrames) : EMPTY_VALUE;
  const hudQueue = hudPlayerStats ? String(hudPlayerStats.queueDepth) : EMPTY_VALUE;

  const controls = (
    <div
      data-testid="remote-workspace-admin-stream-controls"
      className="flex shrink-0 items-center gap-1 border-b border-[var(--border-default)] px-2 py-1.5"
    >
      {/* 启动 / 停止合并成一个按钮（同一位置切换）：未在播显示「启动」，在播显示「停止」。 */}
      {playing ? (
        <Button
          size="xs"
          compact
          variant="secondary"
          tone="quiet"
          disabled={stopDisabled}
          loading={stopping}
          onClick={() => void handleStop()}
        >
          {t('remoteWorkspace.session.stop')}
        </Button>
      ) : (
        <Button
          size="xs"
          compact
          variant="secondary"
          tone="quiet"
          disabled={startDisabled}
          loading={starting}
          onClick={() => void handleStart()}
        >
          {t('remoteWorkspace.session.start')}
        </Button>
      )}
      {/* 详情是浮层：Popover 内容 portal 到 body（全屏时挂到画面容器里），不参与布局。 */}
      <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
        <PopoverTrigger asChild>
          <Button size="xs" compact variant="secondary" tone="quiet">
            {t('remoteWorkspace.session.details')}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="bottom" className="w-80">
          <dl
            data-testid="remote-workspace-admin-stream-details"
            className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-11 leading-4"
          >
            <dt className="text-[var(--text-secondary)]">
              {t('remoteWorkspace.session.detailResolution')}
            </dt>
            <dd className="min-w-0 break-all text-[var(--text-primary)]">{resolution}</dd>
            <dt className="text-[var(--text-secondary)]">
              {t('remoteWorkspace.session.detailCodec')}
            </dt>
            <dd className="min-w-0 break-all text-[var(--text-primary)]">{encoder}</dd>
            <dt className="text-[var(--text-secondary)]">
              {t('remoteWorkspace.session.detailFps')}
            </dt>
            <dd className="min-w-0 break-all text-[var(--text-primary)]">{fps}</dd>
            <dt className="text-[var(--text-secondary)]">
              {t('remoteWorkspace.admin.detailLastError')}
            </dt>
            <dd className="min-w-0 break-all text-[var(--text-primary)]">{lastError}</dd>
            <dt className="text-[var(--text-secondary)]">
              {t('remoteWorkspace.admin.detailReasonCode')}
            </dt>
            <dd className="min-w-0 break-all text-[var(--text-primary)]">{reasonCode}</dd>
            <dt className="text-[var(--text-secondary)]">
              {t('remoteWorkspace.admin.detailDesktopSession')}
            </dt>
            <dd className="min-w-0 break-all text-[var(--text-primary)]">{desktopSession}</dd>
          </dl>
        </PopoverContent>
      </Popover>
      {/* 串流信息：右上角性能 HUD 的开关（HUD 是浮层，开合不改变控制条 / 画面布局）。 */}
      <Button
        size="xs"
        compact
        variant="secondary"
        tone="quiet"
        data-testid="remote-workspace-admin-stream-info-toggle"
        aria-pressed={showStreamInfo}
        onClick={() => setShowStreamInfo((open) => !open)}
      >
        {t('remoteWorkspace.admin.streamInfo')}
      </Button>
      <div className="ml-auto flex min-w-0 items-center gap-1">
        {/* 可交互 / 只读：让用户知道「现在鼠标键盘属于远端」而不是本地。
            全屏捕获时单独一句，免得用户不知道宿主快捷键已被远端接管。 */}
        <Tip text={inputHint} side="bottom">
          <span
            data-testid="remote-workspace-admin-stream-input-state"
            data-input-state={inputState}
            className={cn(
              'flex shrink-0 items-center gap-1 whitespace-nowrap text-11',
              interactive ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]',
            )}
          >
            {interactive ? (
              <MousePointerClick size={11} aria-hidden />
            ) : (
              <Eye size={11} aria-hidden />
            )}
            {inputLabel}
          </span>
        </Tip>
        <span
          data-testid="remote-workspace-admin-stream-status"
          className="min-w-0 truncate text-11 text-[var(--text-secondary)]"
        >
          {statusText}
        </span>
        <Tip text={fullscreenLabel} side="bottom">
          <Button
            type="button"
            size="xs"
            compact
            variant="secondary"
            tone="quiet"
            aria-label={fullscreenLabel}
            aria-pressed={isFullscreen}
            onClick={() => void toggleFullscreen()}
          >
            {/* 用户口径：控制条上要能直接读到「全屏 / 退出全屏」，不做纯图标按钮；
                尺寸与同排的启动 / 停止 / 详情一致（xs = 24px）。 */}
            {fullscreenLabel}
          </Button>
        </Tip>
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {controls}
      {error ? (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-1.5 border-b border-[var(--border-default)] bg-[var(--error-bg)] px-2 py-1.5 text-11 leading-4 text-[var(--error-fg)]"
        >
          <CircleAlert size={13} className="mt-px shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : null}
      {closedNote ? (
        <div
          role="status"
          data-testid="remote-workspace-admin-stream-closed-note"
          className="flex shrink-0 items-start gap-1.5 border-b border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 py-1.5 text-11 leading-4 text-[var(--text-secondary)]"
        >
          <Info size={13} className="mt-px shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{closedNote}</span>
        </div>
      ) : null}
      <div
        ref={stageRef}
        data-testid="remote-workspace-admin-stream-stage"
        data-fullscreen={isFullscreen ? 'true' : undefined}
        data-interactive={interactive ? 'true' : undefined}
        data-stream-keyboard-lock={keyboardLock}
        // 画面可操作时可聚焦：被动态的键盘转发只认「画面自身持有焦点」。
        tabIndex={interactive ? 0 : undefined}
        aria-label={interactive ? inputLabel : undefined}
        className={cn(
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[hsl(var(--surface-hsl))] outline-none',
          // 全屏时浏览器把本容器铺满屏幕。
          isFullscreen && 'h-full w-full',
        )}
      >
        <canvas
          ref={canvasRef}
          aria-hidden
          data-testid="remote-workspace-admin-stream-canvas"
          className={cn('max-h-full max-w-full object-contain', !streaming && 'hidden')}
        />
        {/* 串流信息 HUD：右上角浮层（半透明深色 chrome，复用 lightbox-toolbar 语义 token），
            不参与布局；全屏下同样显示。 */}
        {showStreamInfo ? (
          <div
            data-testid="remote-workspace-admin-stream-info"
            role="group"
            aria-label={t('remoteWorkspace.admin.streamInfo')}
            className="pointer-events-auto absolute right-2 top-2 z-20 w-[252px] cursor-default rounded-xl border border-[var(--lightbox-toolbar-border)] bg-[var(--lightbox-toolbar-bg)] p-2.5 text-11 leading-4 text-[var(--lightbox-toolbar-fg)] shadow-[shadow:var(--shadow-menu)] backdrop-blur-sm"
          >
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="font-medium text-[var(--lightbox-toolbar-fg-hover)]">
                {t('remoteWorkspace.admin.streamInfo')}
              </span>
              <Tip text={t('remoteWorkspace.admin.streamInfoClose')} side="left">
                <button
                  type="button"
                  aria-label={t('remoteWorkspace.admin.streamInfoClose')}
                  onClick={() => setShowStreamInfo(false)}
                  className="inline-flex size-6 cursor-pointer items-center justify-center rounded-full text-[var(--lightbox-toolbar-fg)] transition-colors hover:bg-[var(--lightbox-toolbar-hover-bg)] hover:text-[var(--lightbox-toolbar-fg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <X size={12} aria-hidden />
                </button>
              </Tip>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
              <dt>{t('remoteWorkspace.session.detailResolution')}</dt>
              <dd className="text-right text-[var(--lightbox-toolbar-fg-hover)]">{resolution}</dd>
              <dt>{t('remoteWorkspace.admin.streamInfoCodec')}</dt>
              <dd
                data-testid="remote-workspace-admin-stream-info-codec"
                className="truncate text-right text-[var(--lightbox-toolbar-fg-hover)]"
              >
                {hudCodec}
              </dd>
              <dt>{t('remoteWorkspace.session.detailFps')}</dt>
              <dd
                data-testid="remote-workspace-admin-stream-info-fps"
                className="text-right text-[var(--lightbox-toolbar-fg-hover)]"
              >
                {hudFps}
              </dd>
              <dt>{t('remoteWorkspace.admin.streamInfoBitrate')}</dt>
              <dd
                data-testid="remote-workspace-admin-stream-info-bitrate"
                className="text-right text-[var(--lightbox-toolbar-fg-hover)]"
              >
                {hudBitrate}
              </dd>
              <dt>{t('remoteWorkspace.admin.streamInfoDecodeTime')}</dt>
              <dd
                data-testid="remote-workspace-admin-stream-info-decode"
                className="text-right text-[var(--lightbox-toolbar-fg-hover)]"
              >
                {hudDecode}
              </dd>
              <dt>{t('remoteWorkspace.admin.streamInfoDropped')}</dt>
              <dd
                data-testid="remote-workspace-admin-stream-info-dropped"
                className="text-right text-[var(--lightbox-toolbar-fg-hover)]"
              >
                {hudDropped}
              </dd>
              <dt>{t('remoteWorkspace.admin.streamInfoQueue')}</dt>
              <dd
                data-testid="remote-workspace-admin-stream-info-queue"
                className="text-right text-[var(--lightbox-toolbar-fg-hover)]"
              >
                {hudQueue}
              </dd>
              <dt>{t('remoteWorkspace.admin.streamInfoConnection')}</dt>
              <dd className="text-right text-[var(--lightbox-toolbar-fg-hover)]">{statusText}</dd>
            </dl>
          </div>
        ) : null}
        {streaming ? null : (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-4 text-center">
            <Cast size={22} className="text-[var(--text-tertiary)]" aria-hidden />
            <p className="text-12 leading-5 text-[var(--text-secondary)]">{overlayText}</p>
            {overlayHint ? (
              <p className="max-w-[360px] text-11 leading-4 text-[var(--text-tertiary)]">
                {overlayHint}
              </p>
            ) : null}
          </div>
        )}
        {/* 全屏极简：页面 chrome / 控制条都由原生全屏隐藏，只留右下角一个退出按钮
            （PSB 网页同款；Esc 也能退出）。 */}
        {isFullscreen ? (
          <Tip text={t('remoteWorkspace.admin.exitFullscreenEsc')} side="left">
            <Button
              type="button"
              size="md"
              variant="secondary"
              tone="quiet"
              className="absolute bottom-3 right-3 z-20 w-8 cursor-default px-0"
              aria-label={fullscreenLabel}
              onClick={() => void toggleFullscreen()}
            >
              <Minimize2 size={15} aria-hidden />
            </Button>
          </Tip>
        ) : null}
      </div>
    </div>
  );
}
