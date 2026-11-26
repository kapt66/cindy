/**
 * PSB 串流**宿主光标形状**契约的单测（`shared/psb-remote-workspace.ts`）。
 *
 * 测试价值
 * - 生产入口与可观察结果：`parsePsbStreamCursorTextFrame`（main 观看端解析 PSB 文本帧的唯一入口）、
 *   `psbStreamCursorKeyword`（渲染层把形状映射成 CSS 的唯一入口）、`psbStreamCursorName`
 *   （排障属性）三者决定「远端换光标时宿主指针形态是否跟着变」以及「畸形/超限数据会不会
 *   被当成合法形状」。
 * - Bug／规则依据（CINDY-RW-09，2026-11-26）：**映射语义属 PSB 协议层**，权威来源是
 *   `@psb/shared` 的 `packages/shared/src/stream-cursor.ts`（`remoteStreamCursorKeywordOf` /
 *   `remoteStreamCursorCssOf` / `remoteStreamCursorStyleOf`）。Cindy 不得自己维护「换皮」映射：
 *   同一 `stream.cursor` 形状在 PSB 网页与 Cindy 必须得到同一个 CSS 关键字。PSB 0.1.127 /
 *   2026-11-26 工作区快照为 36 个 CSS 关键字、64 条 X11 别名，归一化顺序与未知回退相同。
 *   PSB shared `stream-cursor.test.ts` 的四类映射 / 别名 / 容错 / 未知回退 / 非法形状用例已
 *   移植到本文件（各处注释标明来源），确保两端对同一形状给出同一 CSS 值。
 * - 与 PSB 共享核心的**有意差异**（不移植的部分，均不影响 `system` 模式的形状 → CSS 结果）：
 *   1. `host` 位图策略（`url("data:image/png;base64,…") <xhot> <yhot>, auto`）是 PSB 的可选
 *      外观策略；Cindy 固定 `system`（用户 2026-11-26 口径：永远是宿主指针风格），不渲染位图，
 *      所以没有 `remoteStreamCursorCssOf(shape, 'host')` 对应用例；
 *   2. `remoteStreamCursorStyleOf`（`system` / `host` 策略解析）Cindy 不需要；
 *   3. 共享核心的帧信封要求 `type` + `sessionId`（`parseRemoteStreamCursorMessage`）；Cindy 的
 *      `parsePsbStreamCursorTextFrame` 由 main 观看端先按会话过滤，`sessionId` 不参与形状解析；
 *   4. 边界校验是 Cindy 自己的协议边界（见共享文件 §5b）：`xhot < width` 比共享核心的
 *      `xhot <= width` 更严、`name` 超长截断而非整条拒绝、不要求 PNG magic 前缀——这些只影响
 *      「帧收不收」，不影响被接受形状的映射值。
 * - 最小失败输入：`width: 65` / `height: 0`、`xhot >= width`、`yhot < 0`、`imageBase64` 含
 *   引号/`)`/换行、长度 > 48 KiB、非整数 serial、`type` 不是 `stream.cursor`；未知 X11 名
 *   `made_up_cursor` → `default`；大小写/空白/连字符形态 ` XTerm ` / `left-side` /
 *   `bottom-right-corner`。
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
    expect(psbStreamCursorName(shape({ name: 'xterm' }))).toBe('xterm');
    expect(psbStreamCursorName(shape({ name: '  ' }))).toBeNull();
    expect(psbStreamCursorName(shape({ name: undefined }))).toBeNull();
    // 运行时畸形（伪造对象）：不是字符串时同样当缺省。
    expect(psbStreamCursorName(shape({ name: 123 as unknown as string }))).toBeNull();
    // 不在这里做映射：叫什么是排障属性，该显示什么见 psbStreamCursorKeyword。
    expect(psbStreamCursorName(shape({ name: ' XTerm ' }))).toBe('XTerm');
  });
});

describe('psbStreamCursorKeyword（映射语义与 PSB `@psb/shared stream-cursor.ts` 逐条一致）', () => {
  it('同一形状两端同一 CSS：PSB shared 测试的四类验收场景（I-beam / pointer / resize / loading）', () => {
    // 期望值逐条取自 PSB `packages/shared/src/stream-cursor.test.ts`（PSB 0.1.127，
    // 2026-11-26 工作区快照）。同一 `stream.cursor` 形状在 PSB 网页与 Cindy 必须得到同一 CSS。
    const cases: ReadonlyArray<readonly [string, string]> = [
      // I-beam：文本框
      ['xterm', 'text'],
      ['text', 'text'],
      ['vertical_text', 'vertical-text'],
      // pointer：按钮 / 链接
      ['hand1', 'pointer'],
      ['hand2', 'pointer'],
      ['pointer', 'pointer'],
      ['pointing_hand', 'pointer'],
      // resize：左右边框 ew / 上下边框 ns / 四角 nesw·nwse
      ['right_side', 'ew-resize'],
      ['left_side', 'ew-resize'],
      ['sb_h_double_arrow', 'ew-resize'],
      ['top_side', 'ns-resize'],
      ['bottom_side', 'ns-resize'],
      ['bottom_right_corner', 'nwse-resize'],
      ['top_left_corner', 'nwse-resize'],
      ['top_right_corner', 'nesw-resize'],
      ['bottom_left_corner', 'nesw-resize'],
      // loading：忙等待
      ['wait', 'wait'],
      ['watch', 'wait'],
      ['progress', 'progress'],
      ['left_ptr_watch', 'progress'],
      ['half_busy', 'progress'],
    ];
    for (const [name, keyword] of cases) {
      expect(psbStreamCursorKeyword(shape({ name })), name).toBe(keyword);
    }
  });

  it('X11 常见别名与「名字本身就是 CSS 关键字」的项', () => {
    const table: ReadonlyArray<readonly [string, string]> = [
      ['default', 'default'],
      ['left_ptr', 'default'],
      ['arrow', 'default'],
      ['top_left_arrow', 'default'],
      ['crosshair', 'crosshair'],
      ['cross', 'crosshair'],
      ['tcross', 'crosshair'],
      ['cell', 'cell'],
      ['sb_v_double_arrow', 'ns-resize'],
      ['fd_double_arrow', 'nwse-resize'],
      ['bd_double_arrow', 'nesw-resize'],
      ['fleur', 'move'],
      ['move', 'move'],
      ['openhand', 'grab'],
      ['grab', 'grab'],
      ['grabbing', 'grabbing'],
      ['not_allowed', 'not-allowed'],
      ['forbidden', 'not-allowed'],
      ['crossed_circle', 'not-allowed'],
      ['no_drop', 'no-drop'],
      ['help', 'help'],
      ['question_arrow', 'help'],
      ['whats_this', 'help'],
      ['zoom_in', 'zoom-in'],
      ['zoom_out', 'zoom-out'],
      ['col_resize', 'col-resize'],
      ['row_resize', 'row-resize'],
      ['all_scroll', 'all-scroll'],
      ['context_menu', 'context-menu'],
      ['copy', 'copy'],
      ['alias', 'alias'],
      ['dnd_copy', 'copy'],
      ['dnd_move', 'move'],
      ['dnd_link', 'alias'],
      ['dnd_no_drop', 'no-drop'],
      // 名字本身已是 CSS 关键字：不需要在表里列一遍
      ['zoom-out', 'zoom-out'],
      ['col-resize', 'col-resize'],
      ['vertical-text', 'vertical-text'],
    ];
    for (const [name, keyword] of table) {
      expect(psbStreamCursorKeyword(shape({ name })), name).toBe(keyword);
    }
  });

  it('容错：大小写、首尾空白、连字符/空格当 `_`（与共享核心归一化顺序相同）', () => {
    expect(psbStreamCursorKeyword(shape({ name: ' XTerm ' }))).toBe('text');
    expect(psbStreamCursorKeyword(shape({ name: 'Left-Ptr' }))).toBe('default');
    expect(psbStreamCursorKeyword(shape({ name: 'bottom-right-corner' }))).toBe('nwse-resize');
    expect(psbStreamCursorKeyword(shape({ name: 'left-side' }))).toBe('ew-resize');
    expect(psbStreamCursorKeyword(shape({ name: 'vertical text' }))).toBe('vertical-text');
    expect(psbStreamCursorKeyword(shape({ name: '  left_side  ' }))).toBe('ew-resize');
  });

  it('未知 / 缺 name / 空白 name → default（箭头），绝不回退 none', () => {
    expect(psbStreamCursorKeyword(shape({ name: 'some_unknown_cursor' }))).toBe('default');
    expect(psbStreamCursorKeyword(shape({ name: 'sb_h_double_arrow_typo' }))).toBe('default');
    expect(psbStreamCursorKeyword(shape({ name: 'made_up_cursor' }))).toBe('default');
    expect(psbStreamCursorKeyword(shape({ name: '' }))).toBe('default');
    expect(psbStreamCursorKeyword(shape({ name: undefined }))).toBe(
      DEFAULT_PSB_STREAM_CURSOR_KEYWORD,
    );
    expect(DEFAULT_PSB_STREAM_CURSOR_KEYWORD).toBe('default');
    for (const name of ['', 'some_unknown_cursor', 'sb_h_double_arrow_typo']) {
      expect(psbStreamCursorKeyword(shape({ name }))).not.toBe('none');
    }
    // 白名单里的每个词都必须是纯 CSS 关键字形状（不含 `url(` / `data:` 等复合值）。
    for (const keyword of PSB_STREAM_CURSOR_CSS_KEYWORDS) {
      expect(keyword).not.toContain('url(');
      expect(keyword).not.toContain('data:');
    }
  });

  it('映射表是 PSB 共享核心的只读副本：64 条别名 / 36 个关键字，逐条得到对应关键字', () => {
    // PSB 快照（0.1.127，2026-11-26）为 64 条别名 / 36 个 CSS 关键字。本地若要增减别名，先改
    // PSB 共享核心并同批同步文档与测试——CINDY-RW-09：不要自己维护一份「换皮」映射。
    expect(Object.keys(PSB_STREAM_CURSOR_KEYWORD_BY_X11_NAME)).toHaveLength(64);
    expect(PSB_STREAM_CURSOR_CSS_KEYWORDS.size).toBe(36);
    for (const [x11Name, keyword] of Object.entries(PSB_STREAM_CURSOR_KEYWORD_BY_X11_NAME)) {
      const mapped = psbStreamCursorKeyword(shape({ name: x11Name }));
      expect(mapped, x11Name).toBe(keyword);
      // 共享核心的「映射表只输出合法 CSS 关键字」不变量（PSB shared 测试同款）。
      expect(PSB_STREAM_CURSOR_CSS_KEYWORDS.has(keyword), `${x11Name} → ${keyword}`).toBe(true);
      // 这里只产出关键字，绝不生成位图 data URL（宿主风格，不用远端位图）。
      expect(mapped).not.toContain('url("data:image/png');
      expect(mapped).not.toContain('data:image');
    }
  });

  it('形状不合法 → null（对应共享核心 remoteStreamCursorCssOf 的非法形状分支）', () => {
    // 与 PSB shared `stream-cursor.test.ts` 的非法形状矩阵同源：尺寸 / 热点 / serial / 图片越界。
    expect(psbStreamCursorKeyword(shape({ width: 65 }))).toBeNull();
    expect(psbStreamCursorKeyword(shape({ height: 0 }))).toBeNull();
    expect(psbStreamCursorKeyword(shape({ xhot: 33 }))).toBeNull();
    expect(psbStreamCursorKeyword(shape({ yhot: -1 }))).toBeNull();
    expect(psbStreamCursorKeyword(shape({ serial: -1 }))).toBeNull();
    expect(psbStreamCursorKeyword(shape({ imageBase64: 'not base64!' }))).toBeNull();
    expect(psbStreamCursorKeyword(shape({ imageBase64: '' }))).toBeNull();
    // Cindy 协议边界更严：热点等于尺寸也拒绝（共享核心允许 `xhot <= width`）。
    expect(psbStreamCursorKeyword(shape({ xhot: 32 }))).toBeNull();
    // 复合注入面同样不合法。
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
