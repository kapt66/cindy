/**
 * PSB 会话串流：帧信封解析与 H.264 载荷转换（**纯函数**，无 IPC / 无 DOM）。
 *
 * ## 信封
 *
 * 观看端协议沿用 PSB 浏览器观看端的二进制帧头：
 *
 *     type(1) + flags(1) + seq(2, BE) + payload
 *
 * - `type`：`1` = video（H.264 码流），`2` = config（解码器配置）；
 * - `flags`：bit0 = 关键帧（`1` 时 payload 是 IDR，`delta` 帧不能先于它喂解码器）；
 * - `seq`：16 位大端序号，仅用于诊断/定位，本轮**不**据此丢帧（见报告里的假设）；
 * - `payload`：其余字节，`config` 是解码器描述，`video` 是一帧 H.264。
 *
 * 事实来源：PSB 仓根目录 `协作需求.md`、`docs/dev-rules/psb-remote-session-transport.md` §5。
 *
 * ## 为什么还要做载荷转换
 *
 * WebCodecs 的 `VideoDecoder` 只有两种输入形态：带 `description`（avcC）时吃 AVCC
 * （4 字节长度前缀的 NAL），不带 `description` 时吃 Annex-B（`00 00 01` 起始码）。
 * PSB 侧的采集端可能是任意一种，而跨仓契约没有逐字节固定它，所以这里同时接受：
 *
 * - `config` 载荷本身就是 avcC 记录（首字节为 1）→ 原样当 `description`；
 * - `config` 载荷是 Annex-B 的 SPS/PPS → 现场拼一条 avcC 记录；
 * - `video` 载荷是 Annex-B → 转成 AVCC（与上面拼出的 `description` 配套）。
 *
 * 这三条都是可单测的纯函数；真机串流未验证（见交付报告「未验证项」）。
 */

import { avcCodec } from '@/features/remote-desktop/liveScreenStream';

/** 两条载荷分支：H.264 画面（video）与解码器配置（config）。 */
export type PsbStreamFrameKind = 'video' | 'config';

/** 帧头字节数：type(1) + flags(1) + seq(2)。 */
export const PSB_STREAM_FRAME_HEADER_BYTES = 4;

/** 信封里的 `type` 取值（与 PSB 观看端逐字一致）。 */
export const PSB_STREAM_FRAME_TYPE = { video: 1, config: 2 } as const;

/** `flags` 的 bit0：该 video 帧是关键帧。 */
export const PSB_STREAM_FRAME_FLAG_KEYFRAME = 0x01;

export interface PsbStreamFrame {
  readonly kind: PsbStreamFrameKind;
  readonly keyframe: boolean;
  readonly sequence: number;
  readonly payload: Uint8Array;
}

function asBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(input);
}

/**
 * 解析一条串流帧。畸形 / 未知 type / 空载荷一律返回 `null`（调用方丢弃一帧，
 * 不把脏字节喂进解码器 —— 那会让 VideoDecoder 进 `error` 状态并停下整段画面）。
 */
export function parsePsbStreamFrame(
  input: ArrayBuffer | ArrayBufferView,
): PsbStreamFrame | null {
  const bytes = asBytes(input);
  if (bytes.byteLength <= PSB_STREAM_FRAME_HEADER_BYTES) return null;
  const rawType = bytes[0];
  const kind: PsbStreamFrameKind | null =
    rawType === PSB_STREAM_FRAME_TYPE.video
      ? 'video'
      : rawType === PSB_STREAM_FRAME_TYPE.config
        ? 'config'
        : null;
  if (kind === null) return null;
  const flags = bytes[1] ?? 0;
  const sequence = ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  return {
    kind,
    keyframe: (flags & PSB_STREAM_FRAME_FLAG_KEYFRAME) !== 0,
    sequence,
    payload: bytes.subarray(PSB_STREAM_FRAME_HEADER_BYTES),
  };
}

/** 找到 `from` 起的第一个 Annex-B 起始码（3 或 4 字节）。 */
function findStartCode(
  bytes: Uint8Array,
  from: number,
): { start: number; codeLength: 3 | 4 } | null {
  for (let index = from; index + 2 < bytes.length; index += 1) {
    if (bytes[index] !== 0 || bytes[index + 1] !== 0 || bytes[index + 2] !== 1) continue;
    // `00 00 00 01` 的 4 字节起始码：把前导 0 一起吃掉，避免留下一个裸 0 前缀。
    const isFourByte = index > from && bytes[index - 1] === 0;
    return { start: isFourByte ? index - 1 : index, codeLength: isFourByte ? 4 : 3 };
  }
  return null;
}

/**
 * 拆出全部 NAL 单元；不含起始码（Annex-B 形态）时返回 `null`。
 *
 * 只认**从第 0 字节开始**的起始码：AVCC 载荷以 4 字节长度前缀开头，长度值碰巧落在
 * `0x000001xx`（256~511 字节的 NAL 很常见）时中间也会出现 `00 00 01`，从中间扫描会把
 * 正常 AVCC 帧误判成 Annex-B 并破坏字节流。
 */
export function annexBNalUnits(payload: Uint8Array): Uint8Array[] | null {
  const first = findStartCode(payload, 0);
  if (!first || first.start !== 0) return null;
  const units: Uint8Array[] = [];
  let cursor: { start: number; codeLength: 3 | 4 } | null = first;
  while (cursor) {
    const nalStart = cursor.start + cursor.codeLength;
    const next = findStartCode(payload, nalStart);
    const nalEnd = next ? next.start : payload.length;
    if (nalEnd > nalStart) units.push(payload.subarray(nalStart, nalEnd));
    cursor = next;
  }
  return units.length > 0 ? units : null;
}

function asAvccNAL(nal: Uint8Array): Uint8Array {
  // AVCC：4 字节大端长度前缀 + NAL 本体（`description` 的 lengthSizeMinusOne = 3）。
  const out = new Uint8Array(4 + nal.length);
  out[0] = (nal.length >>> 24) & 0xff;
  out[1] = (nal.length >>> 16) & 0xff;
  out[2] = (nal.length >>> 8) & 0xff;
  out[3] = nal.length & 0xff;
  out.set(nal, 4);
  return out;
}

/**
 * 把一帧 video 载荷规范成 `VideoDecoder` 需要的 AVCC。
 *
 * `format` 由调用方从 config 帧的来源推出（`avcC` → `'avcc'`、Annex-B → `'annex-b'`）；
 * `'auto'` 是"还没见过 config"时的兜底：只有载荷**以起始码开头**才当 Annex-B 转换，
 * 否则原样返回（AVCC 帧零拷贝）。
 */
export function psbVideoChunkData(
  payload: Uint8Array,
  format: 'avcc' | 'annex-b' | 'auto' = 'auto',
): Uint8Array {
  if (format === 'avcc') return payload;
  const units = annexBNalUnits(payload);
  if (!units) return payload;
  const chunks = units.map(asAvccNAL);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface PsbAvcConfig {
  readonly description: Uint8Array;
  readonly codec: string;
  /** 配置来源形态，只用于诊断/日志，UI 不显示。 */
  readonly source: 'avcc' | 'annex-b';
}

function spsProfileLevel(sps: Uint8Array): string | null {
  if (sps.length < 4) return null;
  const hex = (value: number) => value.toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1] ?? 0)}${hex(sps[2] ?? 0)}${hex(sps[3] ?? 0)}`;
}

/**
 * 从 `config` 帧载荷得到 `VideoDecoder.configure` 需要的 `description` + codec 串。
 *
 * - avcC 记录（首字节 1，长度 ≥ 7）→ 直接复用既有播放器的 `avcCodec()` 读 profile/level；
 * - Annex-B（SPS + PPS）→ 现场拼 avcC 记录；
 * - 其它 → `null`（调用方丢弃，不解码）。
 */
export function psbAvcConfigFromPayload(payload: Uint8Array): PsbAvcConfig | null {
  if (payload.length === 0) return null;
  if (payload[0] === 1) {
    const codec = avcCodec(payload);
    if (!codec) return null;
    return { description: payload.slice(), codec, source: 'avcc' };
  }
  const units = annexBNalUnits(payload);
  if (!units) return null;
  const sps = units.find((unit) => (unit[0]! & 0x1f) === 7);
  const pps = units.find((unit) => (unit[0]! & 0x1f) === 8);
  if (!sps || !pps) return null;
  const codec = spsProfileLevel(sps);
  if (!codec) return null;
  const description = new Uint8Array(11 + sps.length + pps.length);
  description[0] = 1; // configurationVersion
  description[1] = sps[1] ?? 0; // AVCProfileIndication
  description[2] = sps[2] ?? 0; // profile_compatibility
  description[3] = sps[3] ?? 0; // AVCLevelIndication
  description[4] = 0xff; // 6 bits reserved + lengthSizeMinusOne = 3（4 字节长度前缀）
  description[5] = 0xe1; // 3 bits reserved + numOfSequenceParameterSets = 1
  description[6] = (sps.length >>> 8) & 0xff;
  description[7] = sps.length & 0xff;
  description.set(sps, 8);
  const ppsOffset = 8 + sps.length;
  description[ppsOffset] = 1; // numOfPictureParameterSets
  description[ppsOffset + 1] = (pps.length >>> 8) & 0xff;
  description[ppsOffset + 2] = pps.length & 0xff;
  description.set(pps, ppsOffset + 3);
  return { description, codec, source: 'annex-b' };
}
