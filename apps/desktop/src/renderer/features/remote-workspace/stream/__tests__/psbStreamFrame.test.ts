/**
 * 测试价值
 * - 生产入口与可观察结果：`parsePsbStreamFrame` / `psbAvcConfigFromPayload` /
 *   `psbVideoChunkData`（`features/remote-workspace/stream/psbStreamFrame.ts`）。串流画面
 *   能不能出来只取决于这三步：帧头解析错 = 画面定格或黑屏；config 转换错 = WebCodecs
 *   直接 `configure` 失败。
 * - Bug / 规则依据：`docs/dev-rules/psb-remote-session-transport.md` §5（帧头
 *   `type(1)+flags(1)+seq(2,BE)+payload`、flags bit0=关键帧、config 与 WebCodecs
 *   `description` 的关系）。跨仓契约没有逐字节固定 config 形态，这里同时锁住 avcC 与
 *   Annex-B 两条分支。
 * - 现有覆盖缺口：仓库里只有远程桌面链路（`liveScreenStream`）的播放器实现，没有任何
 *   用例覆盖 PSB 信封；`remote-desktop/__tests__` 测的是拉模式播放器与 WebRTC，不经过
 *   这套解析。
 * - 最小失败输入：`[0x01, 0x02, 0x00, 0x01, ...]` 的 4 字节头错位、未知 type 被当成画面、
 *   Annex-B SPS/PPS 未转成 avcC（解码器 configure 抛错）、AVCC 帧被误判成 Annex-B 后
 *   长度前缀被改写。
 * - tier：unit（纯函数，node 环境，无 DOM / 无 WebCodecs）。
 */

import { describe, expect, it } from 'vitest';

import {
  PSB_STREAM_FRAME_HEADER_BYTES,
  annexBNalUnits,
  parsePsbStreamFrame,
  psbAvcConfigFromPayload,
  psbVideoChunkData,
} from '../psbStreamFrame';

/** 4 字节起始码的 SPS（profile 0x64 / compat 0x00 / level 0x1f）与 PPS。 */
const SPS = [0x67, 0x64, 0x00, 0x1f];
const PPS = [0x68, 0xee, 0x3c, 0x80];
/** 同一份配置的 avcC 记录形态。 */
const AVCC_RECORD = [
  1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, ...SPS, 0x01, 0x00, 0x02, 0x68, 0xee,
];
/** Annex-B 配置：4 字节起始码 + SPS + 4 字节起始码 + PPS。 */
const ANNEX_B_CONFIG = [0x00, 0x00, 0x00, 0x01, ...SPS, 0x00, 0x00, 0x00, 0x01, ...PPS];

describe('parsePsbStreamFrame', () => {
  it('reads type / keyframe flag / big-endian sequence / payload from the header', () => {
    const video = new Uint8Array([1, 0x01, 0x12, 0x34, 0xde, 0xad, 0xbe, 0xef]);
    expect(parsePsbStreamFrame(video)).toMatchObject({
      kind: 'video',
      keyframe: true,
      sequence: 0x1234,
    });
    expect(Array.from(parsePsbStreamFrame(video)?.payload ?? [])).toEqual([
      0xde, 0xad, 0xbe, 0xef,
    ]);

    const delta = new Uint8Array([1, 0x00, 0xff, 0xff, 0x42]);
    expect(parsePsbStreamFrame(delta)).toMatchObject({
      kind: 'video',
      keyframe: false,
      sequence: 0xffff,
    });

    const config = new Uint8Array([2, 0x00, 0x00, 0x07, 0x01, 0x64]);
    expect(parsePsbStreamFrame(config)).toMatchObject({
      kind: 'config',
      keyframe: false,
      sequence: 7,
    });
  });

  it.each([
    ['header only', new Uint8Array([1, 1, 0x00, 0x01])],
    ['empty buffer', new Uint8Array(0)],
    ['unknown type', new Uint8Array([9, 1, 0x00, 0x01, 0x00])],
    ['type 0', new Uint8Array([0, 1, 0x00, 0x01, 0x00])],
  ])('drops a malformed frame instead of feeding it to the decoder: %s', (_name, input) => {
    expect(parsePsbStreamFrame(input)).toBeNull();
  });

  it('accepts ArrayBuffer and views with an offset without shifting the payload', () => {
    const backing = new Uint8Array([0xaa, 0xbb, 1, 0x00, 0x00, 0x05, 0x10, 0x20]);
    const view = backing.subarray(2);
    const parsed = parsePsbStreamFrame(view);
    expect(parsed?.sequence).toBe(5);
    expect(Array.from(parsed?.payload ?? [])).toEqual([0x10, 0x20]);
    const standalone = Uint8Array.from([1, 0x00, 0x00, 0x05, 0x10, 0x20]);
    expect(Array.from(parsePsbStreamFrame(standalone.buffer)?.payload ?? [])).toEqual([
      0x10, 0x20,
    ]);
  });

  it('keeps the header size in one place', () => {
    expect(PSB_STREAM_FRAME_HEADER_BYTES).toBe(4);
  });
});

describe('psbAvcConfigFromPayload', () => {
  it('passes an avcC record through and derives the codec string', () => {
    const config = psbAvcConfigFromPayload(new Uint8Array(AVCC_RECORD));
    expect(config?.source).toBe('avcc');
    expect(config?.codec).toBe('avc1.64001f');
    expect(Array.from(config?.description ?? [])).toEqual(AVCC_RECORD);
  });

  it('builds an avcC record from Annex-B SPS/PPS', () => {
    const config = psbAvcConfigFromPayload(new Uint8Array(ANNEX_B_CONFIG));
    expect(config?.source).toBe('annex-b');
    expect(config?.codec).toBe('avc1.64001f');
    // configurationVersion + profile/compat/level + lengthSizeMinusOne + 1×SPS …
    expect(Array.from(config?.description.slice(0, 12) ?? [])).toEqual([
      1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, ...SPS,
    ]);
    // … + 1×PPS 收尾（PPS 段从 8 + SPS 开始，总长 = 11 + SPS + PPS）。
    expect(config?.description.length).toBe(11 + SPS.length + PPS.length);
    expect(Array.from(config?.description.slice(8 + SPS.length) ?? [])).toEqual([
      1, 0x00, 0x04, ...PPS,
    ]);
  });

  it.each([
    ['empty payload', new Uint8Array(0)],
    ['avcC marker without record body', new Uint8Array([1, 0x64, 0x00])],
    ['Annex-B SPS without PPS', new Uint8Array([0x00, 0x00, 0x00, 0x01, ...SPS])],
    ['opaque bytes', new Uint8Array([0xff, 0xfe, 0xfd])],
  ])('rejects unusable config payloads: %s', (_name, input) => {
    expect(psbAvcConfigFromPayload(input)).toBeNull();
  });
});

describe('psbVideoChunkData', () => {
  it('converts Annex-B NAL units into 4-byte length-prefixed AVCC', () => {
    const annexB = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0xaa, 0x00, 0x00, 0x01, 0x06, 0xbb]);
    expect(Array.from(psbVideoChunkData(annexB, 'annex-b'))).toEqual([
      0x00, 0x00, 0x00, 0x02, 0x65, 0xaa, 0x00, 0x00, 0x00, 0x02, 0x06, 0xbb,
    ]);
  });

  it('never rewrites a payload declared as AVCC, even when its length field contains 00 00 01', () => {
    // 300 字节 NAL：长度前缀 00 00 01 2c。auto 模式无法区分它与 Annex-B 起始码，
    // 所以播放器按 config 来源显式传 'avcc' —— 这条用例锁住"显式声明就零改写"。
    const avcc = new Uint8Array([0x00, 0x00, 0x01, 0x2c, 0x65, 0x00]);
    expect(psbVideoChunkData(avcc, 'avcc')).toBe(avcc);
  });

  it('only converts in auto mode when the payload starts with a start code', () => {
    const annexB = new Uint8Array([0x00, 0x00, 0x01, 0x65, 0xaa]);
    expect(Array.from(psbVideoChunkData(annexB))).toEqual([0x00, 0x00, 0x00, 0x02, 0x65, 0xaa]);
    const notAnnexB = new Uint8Array([0x65, 0xaa, 0x00, 0x00, 0x01, 0xbb]);
    expect(psbVideoChunkData(notAnnexB)).toBe(notAnnexB);
  });

  it('splits NAL units on 3-byte and 4-byte start codes', () => {
    const units = annexBNalUnits(
      new Uint8Array([0x00, 0x00, 0x01, 0x67, 0x01, 0x00, 0x00, 0x00, 0x01, 0x68, 0x02]),
    );
    expect(units?.map((unit) => Array.from(unit))).toEqual([
      [0x67, 0x01],
      [0x68, 0x02],
    ]);
    expect(annexBNalUnits(new Uint8Array([0x67, 0x00, 0x00, 0x01, 0x68]))).toBeNull();
  });
});
