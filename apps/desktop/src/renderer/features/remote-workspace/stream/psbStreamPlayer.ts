/**
 * PSB 会话串流：**push 式** H.264 → canvas 播放器（WebCodecs）。
 *
 * 为什么不复用 `features/remote-desktop/liveScreenStream.ts`：那个播放器是**拉模式**
 * （`read(keyframe)` 返回一批消息），宿主是 WebRTC 发送端，还会 `captureStream` 把画面
 * 再交出去。PSB 观看端只需要"帧到了就画到 canvas 上"，多一层拉循环没有收益，而且
 * liveScreenStream 已被远程桌面链路验证过，按任务要求**不修改**它 —— 这里只复用它的两条
 * 成熟做法：`avcCodec()` 的 avcC → codec 串推导，以及「解码器报错就重建、只吃关键帧起的
 * 数据」的重置策略（见 `psbStreamFrame.ts` / `liveScreenStream.ts:94-142`）。
 *
 * 帧来自 `PsbStreamEvent{type:'frame'}`（main 侧观看端转发），本模块只做三件事：
 * 解析信封 → 维护 `VideoDecoder` → 把解出的 `VideoFrame` 画到 canvas。
 *
 * 本模块**只负责解码画帧**：不采集键鼠、不发会话级 `streamInput`。可交互观看的输入由
 * `admin/usePsbStreamInteraction.ts` 采集、经**工作区级** `adminStreamInput` 发到同一条
 * 观看端 WS（产品正本 `docs/product-rules/psb-remote-workspace-sessions.md` §2.4，
 * 工程契约 §12.2）；播放器与输入通道互不依赖。
 */

import {
  parsePsbStreamFrame,
  psbAvcConfigFromPayload,
  psbVideoChunkData,
} from './psbStreamFrame';

/** 解码队列积压超过该值就丢掉后续 delta 帧，等下一个关键帧重来（与既有播放器同口径）。 */
const MAX_DECODE_QUEUE = 8;
/** 逐帧递增的时间戳步长；只用于让解码器有单调时间轴，不参与播放节奏。 */
const FRAME_DURATION_US = 16_667;

export type PsbStreamPlayerFailure = 'decode' | 'unsupported';

/**
 * 播放器运行期统计（供「串流信息」HUD 显示；只报事实，不做推断）。
 *
 * 没有的字段是 `null`（例如还没收到 config 时没有 `codec`），消费方显示「—」而不是编造。
 */
export interface PsbStreamPlayerStats {
  /** 已 configure 的解码器 codec 串（PSB 下发的 avcC/Annex-B 推导）；不知道为 `null`。 */
  readonly codec: string | null;
  /** 解码器当前排队帧数（`VideoDecoder.decodeQueueSize`）；没有解码器时为 `0`。 */
  readonly queueDepth: number;
  /** 解码跟不上时丢弃的 delta 帧数（等下一个关键帧重来，与既有播放器策略一致）。 */
  readonly droppedFrames: number;
  /** 提交解码到解出画面的最近若干帧平均耗时（ms）；样本不足为 `null`。 */
  readonly decodeLatencyAvgMs: number | null;
  /** 同上，p95（最近样本窗口）；样本不足为 `null`。 */
  readonly decodeLatencyP95Ms: number | null;
}

export interface PsbStreamPlayerHandlers {
  /**
   * 不可恢复的解码错误。调用方据此显示 `remoteWorkspace.session.streamFailed`；
   * 播放器自己会尝试用最后一份 `description` 重建解码器，不会永久停摆。
   */
  readonly onFailure?: (failure: PsbStreamPlayerFailure) => void;
}

export interface PsbStreamPlayer {
  /** 投递一帧（`PsbStreamEvent{type:'frame'}.payload`）。畸形帧被静默丢弃。 */
  readonly push: (payload: ArrayBuffer | ArrayBufferView) => void;
  /** 读取运行期统计（HUD 轮询用；不改变解码状态）。 */
  readonly getStats: () => PsbStreamPlayerStats;
  /**
   * 清空画面与解码状态（停止 / 关闭 / 错误断开 / 卸载时调用）。
   *
   * 只清画面与统计，不销毁实例：再次 `push` 时新的 config 会重新 configure，可以继续观看。
   * 不在这里 `dispose`，是因为「停止观看」与「组件卸载」是两个语义，卸载仍由 `dispose` 收尾。
   */
  readonly clear: () => void;
  /** 释放解码器与 canvas；之后 `push` 无效果。 */
  readonly dispose: () => void;
}

/** 解码耗时样本窗口：1s 一帧的 HUD 只需要最近约两秒的分布。 */
const LATENCY_SAMPLE_LIMIT = 120;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * 创建播放器。WebCodecs 缺席或 canvas 没有 2D 上下文时返回 `null`
 * （调用方据此显示「这台客户端没有开启串流能力」）。
 */
export function createPsbStreamPlayer(
  canvas: HTMLCanvasElement,
  handlers: PsbStreamPlayerHandlers = {},
): PsbStreamPlayer | null {
  if (typeof VideoDecoder === 'undefined') return null;
  const context = canvas.getContext('2d');
  if (!context) return null;

  let disposed = false;
  let decoder: VideoDecoder | null = null;
  /** config 只到达一次时也要留住：重建解码器后要能重新 configure。 */
  let description: Uint8Array | null = null;
  let codec: string | null = null;
  /**
   * video 载荷的 NAL 形态，由 config 的来源推出：
   * `config` 是 avcC 记录 → 画面基本可以确定是 AVCC；`config` 是 Annex-B SPS/PPS →
   * 画面也是 Annex-B。没见过 config 时用 `auto`（只按起始码判断）。
   */
  let nalFormat: 'avcc' | 'annex-b' | 'auto' = 'auto';
  let awaitingKey = true;
  let timestamp = 0;
  /** 「串流信息」HUD 统计：只做事实计数，不参与解码决策（已解出帧数 / 解码错误次数没有 UI 消费，不保留）。 */
  let droppedFrames = 0;
  /** 已提交 `decode()` 的帧时间（FIFO），用于在输出回调里算「提交 → 解出画面」耗时。 */
  let submittedAt: number[] = [];
  let latencySamples: number[] = [];

  const clearCanvas = () => {
    try {
      canvas.width = 1;
      canvas.height = 1;
    } catch {
      /* canvas 已脱离文档 */
    }
  };

  const resetStats = () => {
    droppedFrames = 0;
    submittedAt = [];
    latencySamples = [];
  };

  const recordDecodeLatency = (frame: VideoFrame): void => {
    const startedAt = submittedAt.shift();
    if (startedAt === undefined) return;
    const elapsed = nowMs() - startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0) return;
    latencySamples.push(elapsed);
    if (latencySamples.length > LATENCY_SAMPLE_LIMIT) latencySamples.shift();
  };

  const latencyStats = (): { average: number | null; p95: number | null } => {
    if (latencySamples.length === 0) return { average: null, p95: null };
    let sum = 0;
    for (const sample of latencySamples) sum += sample;
    const sorted = [...latencySamples].sort((left, right) => left - right);
    const p95Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
    return { average: sum / latencySamples.length, p95: sorted[p95Index] };
  };

  const paint = (frame: VideoFrame) => {
    if (disposed) return;
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    if (width <= 0 || height <= 0) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.drawImage(frame, 0, 0, width, height);
  };

  const configure = (nextDescription: Uint8Array, nextCodec: string) => {
    description = nextDescription;
    codec = nextCodec;
    try {
      decoder?.close();
    } catch {
      /* 已经关闭 */
    }
    const current = new VideoDecoder({
      output: (frame) => {
        try {
          if (decoder === current) {
            recordDecodeLatency(frame);
            paint(frame);
          }
        } finally {
          frame.close();
        }
      },
      error: () => {
        if (decoder !== current) return;
        decoder = null;
        awaitingKey = true;
        submittedAt = [];
        handlers.onFailure?.('decode');
        // 用最后一份 description 重建：PSB 只在开通观看时下发一次 config，
        // 不重建的话画面会一直停在最后一帧。
        rebuild();
      },
    });
    current.configure({
      codec: nextCodec,
      description: nextDescription.slice().buffer,
      optimizeForLatency: true,
      hardwareAcceleration: 'prefer-hardware',
    });
    decoder = current;
    awaitingKey = true;
    submittedAt = [];
  };

  const rebuild = () => {
    if (disposed || !description || !codec) return;
    try {
      configure(description, codec);
    } catch {
      /* 等下一份 config 帧 */
    }
  };

  const dropDecoder = () => {
    try {
      decoder?.close();
    } catch {
      /* 已经关闭 */
    }
    decoder = null;
    awaitingKey = true;
    submittedAt = [];
  };

  const pushVideo = (payload: Uint8Array, keyframe: boolean) => {
    const target = decoder;
    if (!target || target.state !== 'configured') return;
    if (keyframe) {
      awaitingKey = false;
    } else if (awaitingKey) {
      droppedFrames += 1;
      return;
    } else if (target.decodeQueueSize > MAX_DECODE_QUEUE) {
      // 解码跟不上时继续排队只会增加延迟：丢掉 delta，等下一个关键帧。
      awaitingKey = true;
      droppedFrames += 1;
      return;
    }
    try {
      target.decode(
        new EncodedVideoChunk({
          type: keyframe ? 'key' : 'delta',
          timestamp,
          data: psbVideoChunkData(payload, nalFormat),
        }),
      );
      submittedAt.push(nowMs());
      timestamp += FRAME_DURATION_US;
    } catch {
      dropDecoder();
      handlers.onFailure?.('decode');
      rebuild();
    }
  };

  return {
    push: (payload) => {
      if (disposed) return;
      const frame = parsePsbStreamFrame(payload);
      if (!frame) return;
      if (frame.kind === 'config') {
        const config = psbAvcConfigFromPayload(frame.payload);
        if (!config) return;
        nalFormat = config.source === 'annex-b' ? 'annex-b' : 'avcc';
        try {
          configure(config.description, config.codec);
        } catch {
          handlers.onFailure?.('unsupported');
        }
        return;
      }
      pushVideo(frame.payload, frame.keyframe);
    },
    getStats: () => {
      const latency = latencyStats();
      return {
        codec,
        queueDepth: decoder?.decodeQueueSize ?? 0,
        droppedFrames,
        decodeLatencyAvgMs: latency.average,
        decodeLatencyP95Ms: latency.p95,
      };
    },
    // 停止 / 关闭 / 错误断开：立刻清掉画面与解码状态，避免留下上一帧的冻结画面。
    clear: () => {
      if (disposed) return;
      dropDecoder();
      clearCanvas();
      resetStats();
      description = null;
      codec = null;
      nalFormat = 'auto';
      awaitingKey = true;
      timestamp = 0;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      dropDecoder();
      resetStats();
      clearCanvas();
    },
  };
}
