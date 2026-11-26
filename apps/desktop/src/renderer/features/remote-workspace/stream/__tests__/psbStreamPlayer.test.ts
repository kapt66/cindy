/**
 * 测试价值
 * - 生产入口与可观察结果：`createPsbStreamPlayer()`（PSB 串流观看端的解码器封装）在
 *   fake `VideoDecoder` / canvas 下产生的结果：畸形帧丢弃、未收到关键帧前的 delta 丢弃
 *   （`droppedFrames` 统计）、解码失败后用最后一份 config 重建解码器、HUD 统计
 *   （codec / queueDepth / 延迟均值与 p95）。
 * - Bug／规则依据：`psbStreamPlayer.ts` 文件头（解码器报错就重建、只吃关键帧起的数据；
 *   HUD 只报事实）+ `docs/dev-rules/psb-remote-session-transport.md` §5/§12.8。
 *   2026-11-26 独立审查：`submittedAt` 只 push 不设上限，解码器在重建窗口里连续吃输入却不
 *   产出时数组会随串流时长无限增长 → 现在有 `PSB_STREAM_MAX_PENDING_SUBMISSIONS` 上限。
 * - 现有覆盖缺口：`psbStreamFrame.test.ts` 只测纯解码函数；播放器的重建/丢帧/统计算法此前
 *   完全没有行为测试（只能靠真机目验）。
 * - 最小失败输入：config 后直接喂 delta（无关键帧）；解码器 `error` 回调；大量无产出的提交。
 * - tier：unit（node 环境 + fake WebCodecs / canvas，无网络/进程）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPsbStreamPlayer,
  PSB_STREAM_MAX_PENDING_SUBMISSIONS,
} from '../psbStreamPlayer';
import {
  PSB_STREAM_FRAME_FLAG_KEYFRAME,
  PSB_STREAM_FRAME_TYPE,
} from '../psbStreamFrame';

/** 一段合法的 avcC 记录（首字节 1，profile/compat/level 各一字节）。 */
const AVC_CONFIG = new Uint8Array([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00]);
/** AVCC 形态的一帧 H.264（format=avcc 时零拷贝透传，不校验内容）。 */
const AVCC_FRAME = new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x65, 0x88]);

function streamFrame(type: number, flags: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = type;
  out[1] = flags;
  out[2] = 0;
  out[3] = 1;
  out.set(payload, 4);
  return out;
}

function videoPayload(): Uint8Array {
  return streamFrame(PSB_STREAM_FRAME_TYPE.video, 0, AVCC_FRAME);
}

function configPayload(): Uint8Array {
  return streamFrame(PSB_STREAM_FRAME_TYPE.config, 0, AVC_CONFIG);
}

function keyframePayload(): Uint8Array {
  return streamFrame(
    PSB_STREAM_FRAME_TYPE.video,
    PSB_STREAM_FRAME_FLAG_KEYFRAME,
    AVCC_FRAME,
  );
}

interface FakeFrame {
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly close: ReturnType<typeof vi.fn>;
}

function fakeFrame(width = 640, height = 360): FakeFrame {
  return {
    displayWidth: width,
    displayHeight: height,
    codedWidth: width,
    codedHeight: height,
    close: vi.fn(),
  };
}

interface FakeChunk {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly data: Uint8Array;
}

class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];

  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  decodeQueueSize = 0;
  readonly configureCalls: VideoDecoderConfig[] = [];
  readonly decoded: FakeChunk[] = [];
  private readonly init: VideoDecoderInit;

  constructor(init: VideoDecoderInit) {
    this.init = init;
    FakeVideoDecoder.instances.push(this);
  }

  configure(config: VideoDecoderConfig): void {
    this.configureCalls.push({ codec: config.codec, description: config.description });
    this.state = 'configured';
  }

  decode(chunk: FakeChunk): void {
    this.decoded.push(chunk);
  }

  close(): void {
    this.state = 'closed';
  }

  /** 模拟解出一帧（触发 `output` 回调）。 */
  emit(frame: FakeFrame): void {
    this.init.output(frame as unknown as VideoFrame);
  }

  /** 模拟解码器进入 error 状态。 */
  fail(): void {
    this.init.error(new DOMException('decode failed', 'EncodingError'));
  }
}

class FakeEncodedVideoChunk {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly data: Uint8Array;

  constructor(init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.data = init.data;
  }
}

function fakeCanvas(): {
  canvas: HTMLCanvasElement;
  context: { drawImage: ReturnType<typeof vi.fn> };
} {
  const context = { drawImage: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
  return { canvas, context };
}

function installFakeCodecs(): void {
  FakeVideoDecoder.instances = [];
  vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
  vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createPsbStreamPlayer', () => {
  it('WebCodecs 缺席或 canvas 没有 2D 上下文时返回 null（调用方显示「不支持串流」）', () => {
    vi.stubGlobal('VideoDecoder', undefined);
    const { canvas } = fakeCanvas();
    expect(createPsbStreamPlayer(canvas)).toBeNull();

    installFakeCodecs();
    const noContext = {
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    expect(createPsbStreamPlayer(noContext)).toBeNull();
  });

  it('没有关键帧前的 delta 一律丢弃并计数；关键帧起才喂解码器', () => {
    installFakeCodecs();
    const { canvas } = fakeCanvas();
    let now = 0;
    const player = createPsbStreamPlayer(canvas, {}, { now: () => now });
    expect(player).not.toBeNull();

    player!.push(configPayload());
    player!.push(videoPayload());
    player!.push(videoPayload());
    const decoder = FakeVideoDecoder.instances[0]!;
    expect(decoder.decoded).toHaveLength(0);
    expect(player!.getStats().droppedFrames).toBe(2);

    player!.push(keyframePayload());
    expect(decoder.decoded).toHaveLength(1);
    expect(decoder.decoded[0]!.type).toBe('key');
    expect(player!.getStats().droppedFrames).toBe(2);
  });

  it('解码失败后用最后一份 config 重建解码器，并报告可恢复失败', () => {
    installFakeCodecs();
    const { canvas } = fakeCanvas();
    const onFailure = vi.fn();
    const player = createPsbStreamPlayer(canvas, { onFailure });

    player!.push(configPayload());
    expect(FakeVideoDecoder.instances).toHaveLength(1);
    FakeVideoDecoder.instances[0]!.fail();

    expect(onFailure).toHaveBeenCalledWith('decode');
    // 重建 = 第二块解码器被 configure（PSB 只在开通观看时下发一次 config，不重建画面会冻住）。
    expect(FakeVideoDecoder.instances).toHaveLength(2);
    expect(FakeVideoDecoder.instances[1]!.configureCalls[0]?.codec).toBe('avc1.64001f');
    expect(player!.getStats().codec).toBe('avc1.64001f');
  });

  it('统计只报事实：codec / 队列深度 / 解码延迟（含 p95）', () => {
    installFakeCodecs();
    const { canvas, context } = fakeCanvas();
    let now = 0;
    const player = createPsbStreamPlayer(canvas, {}, { now: () => now })!;

    expect(player.getStats()).toMatchObject({
      codec: null,
      queueDepth: 0,
      droppedFrames: 0,
      decodeLatencyAvgMs: null,
      decodeLatencyP95Ms: null,
    });

    player.push(configPayload());
    now = 10;
    player.push(keyframePayload());
    const decoder = FakeVideoDecoder.instances[0]!;
    decoder.decodeQueueSize = 3;
    now = 22;
    decoder.emit(fakeFrame(800, 450));

    // 画面按解出帧的尺寸铺到 canvas 上。
    expect((canvas as unknown as { width: number }).width).toBe(800);
    expect(context.drawImage).toHaveBeenCalledTimes(1);
    const stats = player.getStats();
    expect(stats.codec).toBe('avc1.64001f');
    expect(stats.queueDepth).toBe(3);
    // 10ms 提交 → 22ms 解出 = 12ms 延迟。
    expect(stats.decodeLatencyAvgMs).toBe(12);
    expect(stats.decodeLatencyP95Ms).toBe(12);
  });

  it('待配对提交样本有上限：长时间只吃输入不产出也不会无限增长', () => {
    installFakeCodecs();
    const { canvas } = fakeCanvas();
    let now = 0;
    const player = createPsbStreamPlayer(canvas, {}, { now: () => now })!;

    player.push(configPayload());
    player.push(keyframePayload()); // t=0
    const total = PSB_STREAM_MAX_PENDING_SUBMISSIONS + 20;
    for (let index = 1; index < total; index += 1) {
      now = index;
      player.push(videoPayload());
    }
    const decoder = FakeVideoDecoder.instances[0]!;
    expect(decoder.decoded).toHaveLength(total);

    // 只保留最近 N 次提交：最早保留的提交时间是 total-N；此刻解出 → 延迟 = 100ms。
    const oldestRetained = total - PSB_STREAM_MAX_PENDING_SUBMISSIONS;
    now = oldestRetained + 100;
    decoder.emit(fakeFrame());
    expect(player.getStats().decodeLatencyAvgMs).toBe(100);
  });

  it('clear 清空画面与统计，dispose 之后 push 无效', () => {
    installFakeCodecs();
    const { canvas, context } = fakeCanvas();
    const player = createPsbStreamPlayer(canvas, {})!;
    player.push(configPayload());
    player.push(keyframePayload());
    FakeVideoDecoder.instances[0]!.emit(fakeFrame(320, 180));
    expect(context.drawImage).toHaveBeenCalledTimes(1);

    player.clear();
    expect((canvas as unknown as { width: number }).width).toBe(1);
    expect(player.getStats()).toMatchObject({ codec: null, droppedFrames: 0 });

    player.dispose();
    const decoder = FakeVideoDecoder.instances[0]!;
    const decodedBefore = decoder.decoded.length;
    player.push(keyframePayload());
    expect(decoder.decoded).toHaveLength(decodedBefore);
  });
});
