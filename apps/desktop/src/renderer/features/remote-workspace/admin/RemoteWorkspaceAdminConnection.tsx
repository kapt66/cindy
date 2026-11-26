/**
 * 「远程工作区 › 远程连接」分类的页面主体：横条控制区 + 全屏串流画面。
 *
 * 数据全部来自**工作区级**桥（`psbWorkspaceAdminBridge.ts`，契约正本
 * `shared/psb-workspace-admin.ts`）：
 *   - 工作区信息（客户端 / 工作区 / 目录 / 占用 / 桌面会话）来自 `adminContext` 的宿主；
 *   - 启动 / 停止 / 状态按 `workspaceId` 操作；主进程走 PSB 的**工作区级服务接口**
 *     `stream/subscribe` 拿**桌面访问会话** id 订阅串流（**不建 Agent 会话**；旧 PSB 才过渡
 *     回退到内部会话），用户任务是否结束、是否还存在都不影响这里的按钮。
 *
 * ## 结构（2026-11-26 独立审查 r4 收口）
 *
 * 组件只负责**渲染与接线**，状态机 / HUD / 全屏分别由三个 hook 持有：
 *
 *   - `useAdminStreamSession`：显式联合状态（idle / starting / connecting / waiting-frame /
 *     streaming / stopping / error）、事件订阅、启动 / 停止、自动重试、可见性释放、跨窗口
 *     收敛与卸载令牌；
 *   - `useStreamHud`：「串流信息」HUD 的开关与最近 1s 采样；
 *   - `useFullscreen`：全屏状态与切换（浏览器是唯一事实）。
 *
 * 画面里的本地 UI（详情浮层 / HUD / 全屏退出按钮）与输入 / 光标两个既有 hook 不变。
 *
 * ## 布局
 *
 * 1. 横条控制区：启动 / 停止是同一个按钮切换，另有详情 / 串流信息 / 全屏 + 状态文案；高度恒定。
 * 2. 错误条（PSB 原文诊断行）/ 中性说明（观看端被 PSB 关闭时它给的 close reason 原话）。
 * 3. 画面：`flex-1 min-h-0` 的 canvas 容器，等比铺满、容器自己 `overflow-hidden`，
 *    不产生第二层滚动条；未启动 / 等待 / 失败时在画面上叠可聚焦的空态说明。
 *
 * **详情是浮层，不占布局**：点「详情」在按钮下方弹 Popover（分辨率 / 编码 / 帧率 / 最近
 * 错误 / `reasonCode` / `desktopSession`），Esc、点外部或再点按钮关闭；打开与关闭都不改变
 * 控制条高度、不让画面位移。
 *
 * **串流信息**：控制条里的「串流信息」开关打开后，画面右上角浮出性能 HUD（半透明深色
 * chrome，可关闭）：分辨率、编码/解码器、最近 1s FPS、最近 1s 码率、解码耗时 avg/p95、丢帧、
 * 解码队列、连接状态。数据来自本端收到的帧数/字节数 + `psbStreamPlayer` 的解码统计；没有 /
 * 读不到的字段显示「—」，不编造。HUD 是浮层，不改变布局。
 *
 * **全屏是极简模式**：进入全屏后页面 chrome 全部由原生全屏隐藏，画面里只保留右下角一个全屏
 * 切换图标按钮（带 Tip / Esc 提示），Esc 或按钮退出；控制条只存在于非全屏。已开启的「串流
 * 信息」HUD 在全屏下仍显示在右上角。全屏与工作区可用性绑定，不依赖会话状态。
 *
 * **进入页面不自动启动**（2026-11-26 用户口径）：不再因为远端 `desktopSession:running` /
 * `status.active` 自动 `adminStreamStart`，一律由用户点「启动」明确开始；页面进入时保持
 * 「串流未启动」空占位（HUD 字段为「—」）。**只有页签不可见 / 关闭 / 切工作区时才自动释放**
 * 观看名额（先补释放键鼠；PSB 每工作区观看名额有限，见产品正本 §2.4、工程契约 §5）；切到
 * 版本控制 / 设置分类**不释放**（面板保活，回来仍是同一场串流）。
 *
 * **「工作区访问没在运行」给可行动横幅，不是「操作失败」**：PSB 0.1.180 的订阅 409 带
 * `details.code='NO_RUNNING_SESSION'` + `details.state`；main 按状态翻成三条 IPC 码
 * （`PSB_NO_RUNNING_SESSION_IPC_CODES`），本组件据此显示：
 *   - `none` / `stopped` / `failed`：横幅说明「请先在 PSB 网页该工作区的『远程控制』启动访问」，
 *     并给「在网页启动访问」按钮（复用 `openWebWorkspace`，main 解析 `webUrl` 后系统浏览器打开）；
 *   - `starting`：说明访问正在启动（Unity / 虚拟桌面还没就绪），并**自动重试一次**（约 2s，
 *     不循环）；`stopping`：说明正在结束，等它落定。
 * PSB 的中文原话单独作为诊断行显示，正文是本地化文案——两者都不再落到通用「操作失败」。
 *
 * **「已连接」与「有画面」是两个状态**：`connecting` 只表示本端订阅已建立（「启动」成功、
 * 按钮切「停止」），`streaming` **只由本端收到的 `frame` 事件**进入。PSB 的 `active` 表示
 * 「那台机器此刻有没有采集」，既不是「本端有画面」，也不能反过来把已经在播的画面切回未启动；
 * 它只留在 `status` 里供提示 / 详情使用。启动成功到首帧之间面板显示「已连接，等待画面…」。
 *
 * **停止 / 关闭 / 错误立即清空画面（含停止失败）**：`adminStreamStop` reject 时同样无条件
 * 复位「未订阅 / 未流式」并 `clearPicture()`，只留一条中性可行动提示（停止失败不留冻结帧、
 * 不留「串流中 / 停止」按钮）；`closed` / 错误断开 / 切工作区 / 卸载路径一致。成功路径清掉
 * 上一轮的失败条，避免旧原因挂在新状态上。
 *
 * **可交互观看**：画面在订阅建立后接受键鼠 / 滚轮输入，指针进入画面即由远端接管（位置同步
 * 到远端机器）；全屏时键鼠全部转发到远端并拦住宿主默认行为（只留 F5 / F11 / F12、
 * Ctrl+Shift+I/J/C 给宿主自救）。输入经**工作区级** `adminStreamInput` 发到同一条串流 WS；
 * 该通道缺失（旧 preload）时降级成「只读观看」并如实标注；上行失败经节流提示后回到未启动。
 *
 * **宿主光标形状同步**：PSB 把客户端上报的宿主光标作为 `stream.cursor` 文本帧转发，main
 * 校验后推 `PsbStreamEvent{type:'cursor'}`；本组件交给 `usePsbStreamCursor` 把形状（`name`）
 * 映射成 **CSS 关键字**写到 **canvas（画面区域）**，外观永远是宿主本机指针风格。只有鼠标停在
 * 画面区域时才同步；离开画面立即恢复宿主默认，HUD / 全屏退出按钮 / 控制条这些本地 UI 不受
 * 影响。停止 / closed / 错误 / 切工作区 / 卸载恢复宿主默认光标。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Cast, CircleAlert, Eye, Globe, Info, Minimize2, MousePointerClick, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import {
  psbAdminContextActionBlockedKey,
  psbAdminContextIsStale,
  type PsbWorkspaceAdminContext,
  type PsbWorkspaceAdminStreamStatus,
} from '../../../../shared/psb-workspace-admin';
import {
  createPsbStreamPlayer,
  type PsbStreamPlayer,
  type PsbStreamPlayerStats,
} from '../stream/psbStreamPlayer';
import {
  adminStreamPhaseConnected,
  adminStreamStartDisabled,
  adminStreamStopDisabled,
  useAdminStreamSession,
  type StreamFailureBanner,
} from './useAdminStreamSession';
import { useFullscreen } from './useFullscreen';
import { useStreamHud } from './useStreamHud';
import {
  normalizeWorkspaceAdminStreamStatus,
  tryGetPsbWorkspaceAdminBridge,
} from './psbWorkspaceAdminBridge';
import { usePsbStreamCursor } from './usePsbStreamCursor';
import { usePsbStreamInteraction } from './usePsbStreamInteraction';

/** 详情里没有值时的占位（不编造数据）。 */
const EMPTY_VALUE = '—';

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
  if (reasonCode === 'CLIENT_NO_STREAMING' || status?.capability === false) {
    return 'remoteWorkspace.session.streamUnsupported';
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
  /**
   * stale（固定信息来自本机快照 / 工作区已不可见）：串流是工作区写操作，启动前先给可行动
   * 原因，而不是把一次注定失败的 PSB 请求变成一条不可读的错误。画面区照旧渲染 —— 页头与
   * 降级原因由 panel 负责，这里只负责「点启动时说清楚为什么不行」。
   */
  const stale = psbAdminContextIsStale(context);
  const blockedActionKey = stale ? psbAdminContextActionBlockedKey(context) : null;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<PsbStreamPlayer | null>(null);
  const mountedRef = useRef(true);
  const [playerUnavailable, setPlayerUnavailable] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  /**
   * `t` 的最新引用：订阅 / 定时器里的文案按当下语言取，但**不因语言切换重订阅 / 重开播**
   * （旧实现把 `t` 放进事件订阅依赖，切语言就重挂监听）。
   */
  const translateRef = useRef(t);
  translateRef.current = t;
  const translate = useCallback(() => translateRef.current, []);

  const hudRef = useRef<ReturnType<typeof useStreamHud> | null>(null);

  /**
   * 串流会话状态机。首帧到达时：送进播放器 + 计入 HUD 的 1s 窗口（HUD hook 在下面创建，
   * 通过 ref 取，避免 hook 间循环依赖）。
   */
  const session = useAdminStreamSession({
    bridge,
    workspaceId,
    blockedActionKey,
    contextViewerSessionId: context.viewerSessionId,
    visible: active !== false && shellVisible !== false,
    onFrame: (payload) => {
      playerRef.current?.push(payload);
      hudRef.current?.recordFrame(payload.byteLength);
    },
    onClearPicture: () => {
      playerRef.current?.clear();
      hudRef.current?.reset();
    },
    translate,
  });
  const { phase, status, failure, closedNote, viewerSessionIdRef } = session;
  const hud = useStreamHud({ playerRef, phase });
  hudRef.current = hud;
  const fullscreen = useFullscreen(stageRef);

  // 播放器：canvas 挂载后创建；WebCodecs 缺席时 playerUnavailable → 空态里说明不支持。
  //
  // 依赖刻意留空、`t` 走 `translateRef`：否则观看中切换界面语言会让 effect 重跑并 dispose 当前
  // 播放器，新实例再也拿不到上一次的 config（画面空白，必须手动停 / 再启动才恢复）。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const player = createPsbStreamPlayer(canvas, {
      onFailure: (playerFailure) => {
        if (!mountedRef.current) return;
        const translateNow = translateRef.current;
        session.reportFailure(
          translateNow('remoteWorkspace.session.streamFailed', {
            message:
              playerFailure === 'unsupported'
                ? translateNow('remoteWorkspace.session.streamUnsupported')
                : translateNow('remoteWorkspace.error.unknown'),
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
  }, [session.reportFailure]);

  // 键鼠交互（可交互观看）：输入归一 / 全屏捕获 / 释放策略都在 hook 里，这里只消费状态。
  // 上行失败 → 会话 hook 节流提示并回 idle（旧实现静默吞掉，「鼠标不动了」无任何反馈）。
  const interaction = usePsbStreamInteraction({
    workspaceId,
    stageRef,
    canvasRef,
    streaming: phase === 'streaming',
    remoteSize: { width: status?.width ?? null, height: status?.height ?? null },
    fullscreen: fullscreen.isFullscreen,
    onSendError: session.reportInputError,
  });

  // 宿主光标形状：订阅建立后跟随远端**形状**，但只把 CSS 关键字写到 canvas（画面区域）、由
  // 本机主题渲染外观；指针离开画面立即恢复宿主默认。停止 / closed / 错误 / 切工作区 / 卸载回默认。
  usePsbStreamCursor({
    bridge,
    canvasRef,
    stageRef,
    viewerSessionIdRef,
    active: adminStreamPhaseConnected(phase),
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * 全屏切换：进入成功后把焦点放回画面并尽力申请 Keyboard Lock（不支持则降级，不影响事件级
   * 捕获）；`fullscreenchange` 里 `usePsbStreamInteraction` 还会幂等重试一次。
   */
  const toggleFullscreen = useCallback(async () => {
    const entered = await fullscreen.toggle();
    if (!entered) return;
    try {
      stageRef.current?.focus({ preventScroll: true });
    } catch {
      // 元素已移除：焦点留在原处不影响事件级捕获（document 监听）。
    }
    interaction.requestKeyboardLock();
  }, [fullscreen, interaction]);

  const playing = adminStreamPhaseConnected(phase);
  const unavailable = !bridge || playerUnavailable;
  const startDisabled = adminStreamStartDisabled({
    bridgeReady: Boolean(bridge),
    playerAvailable: !playerUnavailable,
    capable: status?.capability ?? true,
    phase,
  });
  const stopDisabled = adminStreamStopDisabled({ bridgeReady: Boolean(bridge), phase });

  /* ------------------------------ 展示字段 ------------------------------ */

  const reasonHintKey = streamReasonHintKey(context, status);
  const psbHint = status?.lastErrorZh?.trim() || context.lastErrorZh?.trim() || null;
  const overlayText = unavailable
    ? t('remoteWorkspace.session.streamUnsupported')
    : phase === 'starting'
      ? t('remoteWorkspace.session.streamConnecting')
      : phase === 'connecting' || phase === 'waiting-frame'
        ? t('remoteWorkspace.session.streamWaiting')
        : t('remoteWorkspace.session.streamIdle');
  const overlayHint = unavailable || playing || phase === 'starting' || failure
    ? null
    : reasonHintKey
      ? t(reasonHintKey)
      : psbHint || t('remoteWorkspace.admin.streamStartHint');
  const statusText = phase === 'streaming'
    ? t('remoteWorkspace.session.streamLive')
    : phase === 'starting'
      ? t('remoteWorkspace.session.streamConnecting')
      : phase === 'connecting' || phase === 'waiting-frame'
        ? t('remoteWorkspace.session.streamWaiting')
        : t('remoteWorkspace.session.streamIdle');
  const resolution =
    status?.width != null && status.height != null
      ? `${status.width} × ${status.height}`
      : EMPTY_VALUE;
  const encoder = status?.encoder?.trim() || EMPTY_VALUE;
  const fps = status?.fps != null ? `${status.fps} fps` : EMPTY_VALUE;
  const lastError = status?.lastErrorZh?.trim() || context.lastErrorZh?.trim() || EMPTY_VALUE;
  const reasonCode = status?.reasonCode ?? context.reasonCode ?? EMPTY_VALUE;
  const desktopSession = desktopSessionLabel(t, status?.desktopSession ?? context.desktopSession);
  const fullscreenLabel = fullscreen.isFullscreen
    ? t('remoteWorkspace.admin.exitFullscreen')
    : t('remoteWorkspace.admin.enterFullscreen');
  const inputState = interaction.capture
    ? 'captured'
    : interaction.interactive
      ? 'interactive'
      : 'readonly';
  const inputLabel =
    inputState === 'captured'
      ? t('remoteWorkspace.admin.inputCaptured')
      : inputState === 'interactive'
        ? t('remoteWorkspace.admin.inputInteractive')
        : t('remoteWorkspace.admin.inputReadOnly');
  // 全屏接管时键鼠自救组合随平台不同：Windows/Linux 是 Ctrl+Shift，macOS 是 Cmd+Alt。
  const capturedHintKey =
    window.electronAPI?.platform === 'darwin'
      ? 'remoteWorkspace.admin.inputCapturedHintMac'
      : 'remoteWorkspace.admin.inputCapturedHintWindows';
  const inputHint =
    inputState === 'captured'
      ? t(capturedHintKey)
      : inputState === 'interactive'
        ? t('remoteWorkspace.admin.inputInteractiveHint')
        : t('remoteWorkspace.admin.inputReadOnlyHint');
  const inputHintId = `remote-workspace-admin-stream-input-hint-${workspaceId}`;

  /* ------------------------------ 串流信息 HUD ------------------------------ */

  const hudPlayerStats: PsbStreamPlayerStats | null = hud.snapshot?.playerStats ?? null;
  const hudCodec =
    [status?.encoder?.trim(), hudPlayerStats?.codec?.trim()].filter(Boolean).join(' / ') ||
    EMPTY_VALUE;
  const hudFps = hud.snapshot?.fps != null ? `${Math.round(hud.snapshot.fps)} fps` : EMPTY_VALUE;
  const hudBitrate =
    hud.snapshot?.mbps != null ? `${hud.snapshot.mbps.toFixed(2)} Mbps` : EMPTY_VALUE;
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

  /* -------------------------------- 控制条 -------------------------------- */

  const controls = (
    <div
      data-testid="remote-workspace-admin-stream-controls"
      role="group"
      aria-label={t('remoteWorkspace.admin.categories.connection')}
      className="flex shrink-0 items-center gap-1 border-b border-[var(--border-default)] px-2 py-1.5"
    >
      {/* 启动 / 停止合并成一个按钮（同一位置切换）：未在播显示「启动」，在播显示「停止」。 */}
      {playing || phase === 'stopping' ? (
        <Button
          type="button"
          size="xs"
          compact
          variant="secondary"
          tone="quiet"
          disabled={stopDisabled}
          loading={phase === 'stopping'}
          aria-busy={phase === 'stopping'}
          onClick={() => session.stop()}
        >
          {t('remoteWorkspace.session.stop')}
        </Button>
      ) : (
        <Button
          type="button"
          size="xs"
          compact
          variant="secondary"
          tone="quiet"
          disabled={startDisabled}
          loading={phase === 'starting'}
          aria-busy={phase === 'starting'}
          onClick={() => session.start()}
        >
          {t('remoteWorkspace.session.start')}
        </Button>
      )}
      {/* 详情是浮层：Popover 内容 portal 到 body（全屏时挂到画面容器里），不参与布局。 */}
      <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
        <PopoverTrigger asChild>
          <Button type="button" size="xs" compact variant="secondary" tone="quiet">
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
        type="button"
        size="xs"
        compact
        variant="secondary"
        tone="quiet"
        data-testid="remote-workspace-admin-stream-info-toggle"
        aria-pressed={hud.open}
        aria-controls={hud.open ? 'remote-workspace-admin-stream-info' : undefined}
        onClick={hud.toggle}
      >
        {t('remoteWorkspace.admin.streamInfo')}
      </Button>
      <div className="ml-auto flex min-w-0 items-center gap-1">
        {/* 可交互 / 只读：让用户知道「现在鼠标键盘属于远端」而不是本地。
            键盘焦点也能到它（span 挂 tabIndex + Tip 在 focus 时打开），小屏 / 读屏用户
            不会因为它是纯文本就拿不到这条说明。 */}
        <Tip text={inputHint} side="bottom">
          <span
            tabIndex={0}
            role="note"
            aria-describedby={inputHintId}
            data-testid="remote-workspace-admin-stream-input-state"
            data-input-state={inputState}
            className={cn(
              'flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm text-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              interaction.interactive ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]',
            )}
          >
            {interaction.interactive ? (
              <MousePointerClick size={11} aria-hidden />
            ) : (
              <Eye size={11} aria-hidden />
            )}
            {inputLabel}
          </span>
        </Tip>
        <span id={inputHintId} className="sr-only">
          {inputHint}
        </span>
        <span
          data-testid="remote-workspace-admin-stream-status"
          role="status"
          aria-live="polite"
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
            aria-pressed={fullscreen.isFullscreen}
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
      {failure ? <StreamFailureNotice failure={failure} onOpenWeb={session.openWebForAccess} /> : null}
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
        data-fullscreen={fullscreen.isFullscreen ? 'true' : undefined}
        data-interactive={interaction.interactive ? 'true' : undefined}
        data-stream-keyboard-lock={interaction.keyboardLock}
        // 画面可操作时可聚焦：被动态的键盘转发只认「画面自身持有焦点」；键盘焦点进来时画一圈
        // 焦点环（旧实现 `outline-none` 后没有任何可见焦点，键盘用户找不到画面）。
        tabIndex={interaction.interactive ? 0 : undefined}
        aria-label={interaction.interactive ? inputLabel : undefined}
        className={cn(
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[hsl(var(--surface-hsl))] outline-none',
          'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
          // 全屏时浏览器把本容器铺满屏幕。
          fullscreen.isFullscreen && 'h-full w-full',
        )}
      >
        <canvas
          ref={canvasRef}
          aria-hidden
          data-testid="remote-workspace-admin-stream-canvas"
          data-has-picture={phase === 'streaming' ? 'true' : 'false'}
          className={cn('max-h-full max-w-full object-contain', phase !== 'streaming' && 'hidden')}
        />
        {/* 串流信息 HUD：右上角浮层（半透明深色 chrome，复用 lightbox-toolbar 语义 token），
            不参与布局；全屏下同样显示。 */}
        {hud.open ? (
          <div
            id="remote-workspace-admin-stream-info"
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
                  onClick={hud.close}
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
        {phase !== 'streaming' ? (
          // 空态说明可聚焦：键盘 / 读屏用户能停在画面上读到「为什么没有画面」与下一步。
          <div
            data-testid="remote-workspace-admin-stream-overlay"
            tabIndex={0}
            role="status"
            className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 rounded-sm px-4 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
          >
            <Cast size={22} className="text-[var(--text-tertiary)]" aria-hidden />
            <p className="text-12 leading-5 text-[var(--text-secondary)]">{overlayText}</p>
            {overlayHint ? (
              <p className="max-w-[360px] text-11 leading-4 text-[var(--text-tertiary)]">
                {overlayHint}
              </p>
            ) : null}
          </div>
        ) : null}
        {/* 全屏极简：页面 chrome / 控制条都由原生全屏隐藏，只留右下角一个退出按钮
            （PSB 网页同款；Esc 也能退出）。 */}
        {fullscreen.isFullscreen ? (
          <Tip text={t('remoteWorkspace.admin.exitFullscreenEsc')} side="left">
            <Button
              type="button"
              size="md"
              variant="secondary"
              tone="quiet"
              aria-label={fullscreenLabel}
              className="absolute bottom-3 right-3 z-20 w-8 cursor-default px-0"
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

/**
 * 串流失败横幅（本轮失败）：正文是可行动文案，PSB 原文单独做诊断行；「没有 running 桌面
 * 访问」的 `none` 档给「在网页启动访问」按钮（复用既有 `openWebWorkspace`）。
 */
function StreamFailureNotice({
  failure,
  onOpenWeb,
}: {
  readonly failure: StreamFailureBanner;
  readonly onOpenWeb: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      data-testid="remote-workspace-admin-stream-failure"
      data-access-state={failure.accessState ?? undefined}
      className="flex shrink-0 items-start gap-1.5 border-b border-[var(--border-default)] bg-[var(--error-bg)] px-2 py-1.5 text-11 leading-4 text-[var(--error-fg)]"
    >
      <CircleAlert size={13} className="mt-px shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="min-w-0 break-words">{failure.text}</span>
        {failure.detail ? (
          <span
            data-testid="remote-workspace-admin-stream-failure-detail"
            className="min-w-0 break-words opacity-80"
          >
            {failure.detail}
          </span>
        ) : null}
        {failure.offerOpenWeb ? (
          <div className="flex">
            <Button
              type="button"
              size="xs"
              compact
              variant="secondary"
              tone="quiet"
              data-testid="remote-workspace-admin-stream-open-web"
              onClick={onOpenWeb}
            >
              <Globe size={12} aria-hidden />
              {t('remoteWorkspace.admin.streamAccessOpenWeb')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
