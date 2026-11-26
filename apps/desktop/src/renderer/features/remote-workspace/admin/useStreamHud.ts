/**
 * 「串流信息」HUD 的状态与采样（2026-11-26 独立审查 r4：从 1087 行组件里抽出）。
 *
 * 只负责三件事，全部是**本端事实**、不编造：
 *   1. 开关状态（默认关闭，关闭期间不采样）；
 *   2. 「最近 1s」的帧数 / 字节数窗口（FPS 与码率的唯一数据源），由组件在收到帧时调用
 *      `recordFrame(byteLength)` 累加；
 *   3. 每秒一次的采样快照：FPS / 码率来自本端窗口，编码 / 解码 / 丢帧 / 队列来自播放器
 *      统计（`getStats`）；没有 / 读不到的值保持 `null`，由渲染层显示「—」。
 *
 * 采样只在 HUD 打开时跑；画面进入非播放态（idle / stopping / error）时停止采样并清掉快照，
 * 避免把上一轮的数字挂在新状态上。
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type {
  PsbStreamPlayer,
  PsbStreamPlayerStats,
} from '../stream/psbStreamPlayer';
import { adminStreamPhaseConnected, type AdminStreamPhase } from './useAdminStreamSession';

/** HUD 的最近 1s 采样快照。 */
export interface StreamInfoSnapshot {
  readonly fps: number | null;
  readonly mbps: number | null;
  readonly playerStats: PsbStreamPlayerStats | null;
}

const EMPTY_WINDOW = { frames: 0, bytes: 0, startedAt: 0 };

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export interface StreamHud {
  readonly open: boolean;
  readonly snapshot: StreamInfoSnapshot | null;
  toggle: () => void;
  close: () => void;
  /** 收到一帧：计入当前 1s 窗口（HUD 关闭时也计数，打开时窗口会重置）。 */
  recordFrame: (byteLength: number) => void;
  /** 画面被清空 / 停止时复位采样（新连接从零开始）。 */
  reset: () => void;
}

export function useStreamHud(input: {
  readonly playerRef: RefObject<PsbStreamPlayer | null>;
  readonly phase: AdminStreamPhase;
}): StreamHud {
  const { playerRef, phase } = input;
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<StreamInfoSnapshot | null>(null);
  /** 最近 1s 的帧数 / 字节数窗口。 */
  const windowRef = useRef({ ...EMPTY_WINDOW });
  const streamingRef = useRef(phase === 'streaming');
  streamingRef.current = phase === 'streaming';

  const reset = useCallback(() => {
    windowRef.current = { ...EMPTY_WINDOW, startedAt: nowMs() };
    setSnapshot(null);
  }, []);

  const recordFrame = useCallback((byteLength: number) => {
    const bucket = windowRef.current;
    bucket.frames += 1;
    bucket.bytes += byteLength;
  }, []);

  // 每次打开都重置采样窗口：关闭期间累积的帧不算进「最近 1s」。
  useEffect(() => {
    if (!open) {
      setSnapshot(null);
      return undefined;
    }
    windowRef.current = { frames: 0, bytes: 0, startedAt: nowMs() };
    setSnapshot(null);
    const tick = () => {
      const now = nowMs();
      const bucket = windowRef.current;
      const elapsed = Math.max(1, now - bucket.startedAt);
      const live = streamingRef.current;
      setSnapshot({
        fps: live ? (bucket.frames * 1000) / elapsed : null,
        mbps: live ? (bucket.bytes * 8) / 1000 / elapsed : null,
        playerStats: playerRef.current?.getStats() ?? null,
      });
      windowRef.current = { frames: 0, bytes: 0, startedAt: now };
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [open, playerRef]);

  // 画面进入非连接状态（停止 / 关闭 / 错误）：HUD 的「最近 1s」不再有意义，清掉旧数字。
  const connected = adminStreamPhaseConnected(phase);
  useEffect(() => {
    if (!connected) {
      windowRef.current = { ...EMPTY_WINDOW, startedAt: nowMs() };
      setSnapshot(null);
    }
  }, [connected]);

  const toggle = useCallback(() => setOpen((value) => !value), []);
  const close = useCallback(() => setOpen(false), []);

  return { open, snapshot, toggle, close, recordFrame, reset };
}
