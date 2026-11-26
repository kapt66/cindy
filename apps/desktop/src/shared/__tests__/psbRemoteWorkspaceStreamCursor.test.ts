/**
 * PSB 串流**宿主光标形状**契约的单测（`shared/psb-remote-workspace.ts`）。
 *
 * 测试价值
 * - 生产入口与可观察结果：`parsePsbStreamCursorTextFrame`（main 观看端解析 PSB 文本帧的唯一入口）、
 *   `psbStreamCursorKeyword`（渲染层把形状映射成 CSS 的唯一入口）、`psbStreamCursorName`
 *   （排障属性）三者决定「远端换光标时宿主指针形态是否跟着变」以及「畸形/超限数据会不会
 *   被当成合法形状」。
 * - Bug／规则依据（2026-11-26 用户口径）：**只同步远端光标形状，外观永远是宿主（本机）指针
 *   风格**，参照 PSB 网页实现（`remote-clients/stream/cursor-shape.ts` → `@psb/shared` 的
 *   `stream-cursor.ts`）。旧实现把远端 PNG 拼成 `url("data:image/png;base64,…")` 自定义光标，
 *   会把 Windows/macOS 的宿主指针换成 Linux 主题外观（PSB 网页 2026-11-25 真机反馈过同一个
 *   问题）。所以这里钉住：形状名 → CSS 关键字，且**不生成任何位图 data URL**。
 * - 现有覆盖缺口：此前测试锁的是位图 CSS 生成；改口径后必须换成映射表（xterm→text、
 *   left_side→ew-resize、left_ptr→default、未知/缺 name→default、合法关键字直接沿用、
 *   大小写/空白/横线归一）与非法形状回退 `null`，并断言输出里没有 `url("data:image/png`。
 * - 最小失败输入：`width: 65`、`xhot >= width`、`imageBase64` 含引号/`)`/换行、长度 > 48 KiB、
 *   非整数 serial、`type` 不是 `stream.cursor`；未知 X11 名 `made_up_cursor` → `default`；
 *   大小写/空白/连字符形态 ` XTerm ` / `left-side`。
 * - tier：unit（纯函数，无 Electron / 网络）。
 * - 实测耗时：单独运行约 3s（含 pnpm/vitest 启动；用例本身约 10ms）。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PSB_STREAM_CURSOR_KEYWORD,
  PSB_STREAM_CURSOR_CSS_KEYWORDS,
  PSB_STREAM_CURSOR_KEYWORD_BY_X11_NAME,
  PSB_STREAM_CURSOR_MAX_BASE64_LENGTH,
  PSB_STREAM_CURSOR_MAX_NAME_LENGTH,
  PSB_STREAM_CURSOR_MAX_SIZE,
  parsePsbStreamCursorTextFrame,
  psbStreamCursorKeyword,
  psbStreamCursorName,
  type PsbStreamCursorShape,
} from '../psb-remote-workspace';

/** 1×1 PNG 的 base64（真实前缀，长度 12 % 4 === 0）。 */
const PNG_BASE64 = 'iVBORw0KGgo';

function cursorFrame(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'stream.cursor',
    sessionId: 'psb-session-1',
    serial: 12,
    width: 32,
    height: 32,
    xhot: 5,
    yhot: 2,
    imageBase64: PNG_BASE64,
    name: 'text',
    ...patch,
  };
}

/** 一条合法形状（默认 `name: 'text'`），按需改名测试映射。 */
function shape(patch: Partial<PsbStreamCursorShape> = {}): PsbStreamCursorShape {
  return {
    serial: 3,
    width: 32,
    height: 32,
    xhot: 5,
    yhot: 2,
    imageBase64: PNG_BASE64,
    name: 'text',
    ...patch,
  };
}

describe('parsePsbStreamCursorTextFrame', () => {
  it('解析合法帧（含可选 name）并给出 typed 形状', () => {
    expect(parsePsbStreamCursorTextFrame(cursorFrame())).toEqual({
      serial: 12,
      width: 32,
      height: 32,
      xhot: 5,
      yhot: 2,
      imageBase64: PNG_BASE64,
      name: 'text',
    });
    // `name` 可选：缺失时不补字段（诊断字段）。
    expect(parsePsbStreamCursorTextFrame(cursorFrame({ name: undefined }))).toEqual({
      serial: 12,
      width: 32,
      height: 32,
      xhot: 5,
      yhot: 2,
      imageBase64: PNG_BASE64,
    });
    // 尺寸上限与实际热点边界（0 与 width-1）都合法。
    expect(
      parsePsbStreamCursorTextFrame(cursorFrame({ width: 64, height: 64, xhot: 63, yhot: 0 })),
    ).toMatchObject({ width: 64, height: 64, xhot: 63, yhot: 0 });
  });

  it('不是 stream.cursor / 不是对象 / 字段类型不对 → null（调用方按未知文本帧忽略）', () => {
    expect(parsePsbStreamCursorTextFrame(null)).toBeNull();
    expect(parsePsbStreamCursorTextFrame('stream.cursor')).toBeNull();
    expect(parsePsbStreamCursorTextFrame([])).toBeNull();
    // 旧的 `{kind:'status'}` 不是 cursor 帧：解析器不认它（main 在另一条分支处理）。
    expect(parsePsbStreamCursorTextFrame({ kind: 'status', status: {} })).toBeNull();
    expect(parsePsbStreamCursorTextFrame(cursorFrame({ type: 'stream.cursorx' }))).toBeNull();
  });

  it.each([
    { name: 'serial 负数', patch: { serial: -1 } },
    { name: 'serial 超过 uint32', patch: { serial: 0x100000000 } },
    { name: 'serial 非整数', patch: { serial: 1.5 } },
    { name: 'serial 是字符串', patch: { serial: '12' } },
    { name: 'width 为 0', patch: { width: 0 } },
    { name: 'width 超上限', patch: { width: PSB_STREAM_CURSOR_MAX_SIZE + 1 } },
    { name: 'height 超上限', patch: { height: PSB_STREAM_CURSOR_MAX_SIZE + 1 } },
    { name: 'height 非整数', patch: { height: 1.5 } },
    { name: 'xhot 等于 width', patch: { width: 32, xhot: 32 } },
    { name: 'yhot 等于 height', patch: { height: 32, yhot: 32 } },
    { name: 'xhot 负数', patch: { xhot: -1 } },
    { name: 'imageBase64 为空串', patch: { imageBase64: '' } },
    { name: 'imageBase64 不是字符串', patch: { imageBase64: 123 } },
    { name: 'imageBase64 含引号（潜在样式注入面）', patch: { imageBase64: 'iVBORw0KGg"' } },
    { name: 'imageBase64 含右括号（潜在样式注入面）', patch: { imageBase64: 'iVBORw0KGg)' } },
    { name: 'imageBase64 含换行', patch: { imageBase64: 'iVBORw0KGg\n' } },
    { name: 'imageBase64 含 URL-safe 字符（非契约字符集）', patch: { imageBase64: 'iVBORw0KG-' } },
    { name: 'imageBase64 长度 %4 === 1（不可解码残串）', patch: { imageBase64: 'iVBORw0KGgoXY' } },
  ])('非法字段被拒绝：$name', ({ patch }) => {
    expect(parsePsbStreamCursorTextFrame(cursorFrame(patch))).toBeNull();
  });

  it('base64 上限按字符数计：恰好 48 KiB 合法，超出即拒绝', () => {
    const atLimit = 'A'.repeat(PSB_STREAM_CURSOR_MAX_BASE64_LENGTH);
    expect(parsePsbStreamCursorTextFrame(cursorFrame({ imageBase64: atLimit }))).not.toBeNull();
    const overLimit = 'A'.repeat(PSB_STREAM_CURSOR_MAX_BASE64_LENGTH + 4);
    expect(parsePsbStreamCursorTextFrame(cursorFrame({ imageBase64: overLimit }))).toBeNull();
  });

  it('name 截断到诊断长度（不信任远端长度）', () => {
    const parsed = parsePsbStreamCursorTextFrame(
      cursorFrame({ name: 'x'.repeat(PSB_STREAM_CURSOR_MAX_NAME_LENGTH + 20) }),
    );
    expect(parsed?.name).toHaveLength(PSB_STREAM_CURSOR_MAX_NAME_LENGTH);
  });
});

describe('psbStreamCursorName', () => {
  it('只归一字符串原值：去首尾空白；缺失 / 空白 / 非字符串为 null', () => {
    expect(psbStreamCursorName(shape({ name: ' xterm ' }))).toBe('xterm');
    expect(psbStreamCursorName(shape({ name: undefined }))).toBeNull();
    expect(psbStreamCursorName(shape({ name: '   ' }))).toBeNull();
    // 运行时畸形（伪造对象）：不是字符串时同样当缺省。
    expect(psbStreamCursorName(shape({ name: 123 as unknown as string }))).toBeNull();
  });
});

describe('psbStreamCursorKeyword', () => {
  it('X11 名映射成 CSS 关键字（文本 / resize / 箭头）', () => {
    // 三类用户可感知场景：I-beam、窗口边缘 resize、普通箭头。
    expect(psbStreamCursorKeyword(shape({ name: 'xterm' }))).toBe('text');
    expect(psbStreamCursorKeyword(shape({ name: 'left_side' }))).toBe('ew-resize');
    expect(psbStreamCursorKeyword(shape({ name: 'sb_v_double_arrow' }))).toBe('ns-resize');
    expect(psbStreamCursorKeyword(shape({ name: 'left_ptr' }))).toBe('default');
  });

  it('名字本身已是合法 CSS 关键字时直接沿用（不必进表）', () => {
    expect(psbStreamCursorKeyword(shape({ name: 'text' }))).toBe('text');
    expect(psbStreamCursorKeyword(shape({ name: 'zoom-in' }))).toBe('zoom-in');
    expect(psbStreamCursorKeyword(shape({ name: 'col-resize' }))).toBe('col-resize');
    expect(psbStreamCursorKeyword(shape({ name: 'wait' }))).toBe('wait');
  });

  it('大小写 / 首尾空白 / 连字符归一（`-` 当 `_` 查表）', () => {
    expect(psbStreamCursorKeyword(shape({ name: 'XTerm' }))).toBe('text');
    expect(psbStreamCursorKeyword(shape({ name: '  left_side  ' }))).toBe('ew-resize');
    expect(psbStreamCursorKeyword(shape({ name: 'left-side' }))).toBe('ew-resize');
    expect(psbStreamCursorKeyword(shape({ name: 'vertical text' }))).toBe('vertical-text');
  });

  it('未知 name / 缺 name → default（箭头），绝不回退 none', () => {
    expect(psbStreamCursorKeyword(shape({ name: 'made_up_cursor' }))).toBe('default');
    expect(psbStreamCursorKeyword(shape({ name: undefined }))).toBe(DEFAULT_PSB_STREAM_CURSOR_KEYWORD);
    expect(DEFAULT_PSB_STREAM_CURSOR_KEYWORD).toBe('default');
    // 白名单里的每个词都必须是合法 CSS 关键字形状（不含 `url(` / 空格列表等复合值）。
    for (const keyword of PSB_STREAM_CURSOR_CSS_KEYWORDS) {
      expect(keyword).not.toContain('url(');
      expect(keyword).not.toContain('data:');
    }
  });

  it('映射表与 PSB 网页同款：表内每一条都得到对应关键字，且都不产生位图 data URL', () => {
    // 表是契约（来源见共享文件注释「移植自 PSB 网页 cursor-shape.ts（2026-11-26）」），
    // 逐条断言可以钉住「不会被本地悄悄改坏」，同时证明这里只产出关键字。
    for (const [x11Name, keyword] of Object.entries(PSB_STREAM_CURSOR_KEYWORD_BY_X11_NAME)) {
      const mapped = psbStreamCursorKeyword(shape({ name: x11Name }));
      expect(mapped).toBe(keyword);
      expect(mapped).not.toContain('url("data:image/png');
      expect(mapped).not.toContain('data:image');
    }
  });

  it('形状不合法 → null（调用方保持现状，不写坏值、也不伪造光标）', () => {
    expect(psbStreamCursorKeyword(shape({ width: 65 }))).toBeNull();
    expect(psbStreamCursorKeyword(shape({ xhot: 32 }))).toBeNull();
    expect(psbStreamCursorKeyword(shape({ serial: -1 }))).toBeNull();
    expect(psbStreamCursorKeyword(shape({ imageBase64: 'a"b)c' }))).toBeNull();
    expect(psbStreamCursorKeyword(null as unknown as PsbStreamCursorShape)).toBeNull();
  });

  it('输出永远是纯 CSS 关键字：不含 url() / data URL（宿主风格，不用远端位图）', () => {
    const allNames = [
      ...Object.keys(PSB_STREAM_CURSOR_KEYWORD_BY_X11_NAME),
      'text',
      'zoom-in',
      'made_up_cursor',
      '',
    ];
    for (const name of allNames) {
      const keyword = psbStreamCursorKeyword(shape({ name }));
      // 合法形状永远返回白名单里的一个纯关键字（不返回 null / 复合值）。
      if (keyword === null) throw new Error(`合法形状不应返回 null：${name}`);
      expect(PSB_STREAM_CURSOR_CSS_KEYWORDS.has(keyword)).toBe(true);
      expect(keyword).not.toContain('url(');
      expect(keyword).not.toContain('data:image/png');
      // 关键字里不出现空白 / fallback 列表（`text 4 4, auto` 那种位图写法）。
      expect(keyword.includes(' ')).toBe(false);
    }
  });
});
