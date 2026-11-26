/**
 * streamViewer 单测 —— PSB 串流观看端的协议与名额不变量。
 *
 * 测试价值
 * - 生产入口与可观察结果：`createPsbStreamViewer(deps)` 是 main 侧观看端的唯一实现
 *   （`streamViewer.ts`）。它决定渲染层收到什么（`PsbStreamEvent`）以及 PSB 端看到什么
 *   （WS 升级 URL 是否带稳定 `subscriberId`、上行是否只有 `{kind:'input'}`、连接是否真的断开）。
 * - Bug／规则依据：`docs/dev-rules/psb-remote-session-transport.md` §5（帧按原样转成
 *   `{type:'frame', payload:ArrayBuffer}`；同一会话重复 start 幂等先停旧连接；关闭必须真的断开，
 *   否则 PSB 每会话的观看名额泄漏、别人连不上）；2026-11-26 联调事故（PSB 协作需求
 *   「Cindy 串流取证结果」）：PSB 的 4004 同时表示「没有可观看画面」与「慢订阅者被断开」，
 *   此前一律归因 `slow-subscriber`，于是「该工作区没有 running 桌面会话」被误报成用户消费太慢。
 *   PSB 建议按「close reason 有无结构前缀」+「是否收到过二进制帧」区分（PSB 仓
 *   `docs/remote-workspace.md` §11.10）。同日 PSB 明确两件事：订阅靠 WS 升级、断开即退订，
 *   不要发 `{kind:'open'}` / `{kind:'close'}`（计为非法消息）；观看名额与浏览器页面共用、默认 4
 *   （部署级 `PSB_STREAM_MAX_SUBSCRIBERS`），Cindy 必须带稳定 `subscriberId` 重连（同 id 替换旧
 *   订阅、不占新名额；PSB 0.1.170 契约，PSB 协作需求 PSB-RW-06 问答）。
 * - 现有覆盖缺口：既有用例只覆盖 4001 的纯 token 映射，没有 4004 的两种含义、也没有
 *   close reason 结构前缀的解析结果；「帧数」这个维度此前根本不存在，靠类型或人工目检
 *   无法证明归因正确。本轮另补四条此前没有运行期证据的线：上行不得出现控制帧、每个观看端
 *   实例的 UUIDv4 `subscriberId`（重连/多会话复用、换观看端才换新）、`sendInput` 的帧形状与
 *   「无活动连接」失败、PSB 0.1.170 `errors=frame` 新关闭码（4404/4413/4412，当前未启用）的加性归因。
 * - 最小失败输入：4004 + `{"reasonCode":"NO_DESKTOP_SESSION","desktopSession":"none"}|…` 关闭
 *   （旧代码给 `slow-subscriber`）；4004 + 纯中文 reason 且一帧未收（旧代码给
 *   `slow-subscriber`）；收到一帧后 4004 + 纯中文 reason（必须仍是 `slow-subscriber`）；
 *   握手后发 `{kind:'open'}`（旧实现的真实行为，现在必须零控制帧）；URL 缺 `subscriberId`；
 *   每次 `start` 重新生成 `subscriberId`（重连会被 PSB 当成新订阅者占新名额）。
 * - 2026-11-26 新增宿主光标形状（`stream.cursor` 文本帧）：合法帧 → `{type:'cursor'}`、连续重复
 *   serial 去重、**serial 回退也照常 emit**（真机日志证明 PSB 的 serial 不严格单调，旧的
 *   out-of-order 丢弃会把新形状吃掉）、超限/非法帧只丢自己、`start`/`stop` 重置去重状态、
 *   **文本帧不进入二进制帧路径**（只收过文本帧的连接 4004 仍归因 `not-ready`，证明
 *   `receivedBinaryFrames` 没被污染）。
 * - tier：unit（假 `ws` 构造器 + 假 fetch/token，无真实网络与 Electron）。
 * - 实测耗时：单独运行 1.7s（其中 15 条用例 8ms；其余为 vitest 启动与模块加载）。
 */

import { describe, expect, it, vi } from 'vitest';

import { PsbClientError } from '../psbClient';
import {
  buildPsbStreamUrl,
  classifyStreamClose,
  createPsbStreamSubscriberId,
  createPsbStreamViewer,
  PSB_STREAM_MAX_BINARY_FRAME_BYTES,
} from '../streamViewer';
import type { PsbStreamViewerDeps } from '../streamViewer';
import {
  PSB_STREAM_CURSOR_MAX_BASE64_LENGTH,
  type PsbSessionStreamStatus,
  type PsbStreamCursorShape,
  type PsbStreamEvent,
} from '../../../shared/psb-remote-workspace';

/** 1×1 PNG 的 base64（合法形状里最常用的图片字符集）。 */
const CURSOR_PNG_BASE64 = 'iVBORw0KGgo';

/** 组装一条 PSB `stream.cursor` 文本帧（默认合法；测试按需覆盖字段造非法帧）。 */
function cursorTextFrame(patch: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'stream.cursor',
      sessionId: 'session-1',
      serial: 1,
      width: 32,
      height: 32,
      xhot: 4,
      yhot: 4,
      imageBase64: CURSOR_PNG_BASE64,
      name: 'text',
      ...patch,
    }),
  );
}

function cursorEvents(events: PsbStreamEvent[]): PsbStreamCursorShape[] {
  return events.flatMap((event) => (event.type === 'cursor' ? [event.cursor] : []));
}

const CAPABLE_STATUS: PsbSessionStreamStatus = {
  capability: true,
  active: false,
  width: 1920,
  height: 1080,
  fps: 30,
  encoder: 'h264',
  lastErrorZh: null,
  desktopSession: null,
  reasonCode: null,
};

type SocketHandler = (...args: unknown[]) => void;

class FakeSocket {
  static instances: FakeSocket[] = [];

  readyState = 0;
  binaryType?: string;
  readonly sent: string[] = [];
  closed = false;
  terminated = false;
  readonly url: string;
  readonly options: { headers: Record<string, string>; agent?: unknown };
  private readonly handlers = new Map<string, SocketHandler>();

  constructor(url: string, options: { headers: Record<string, string>; agent?: unknown }) {
    this.url = url;
    this.options = options;
    FakeSocket.instances.push(this);
  }

  on(event: string, handler: SocketHandler): this {
    this.handlers.set(event, handler);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.fire('close', 1000, Buffer.alloc(0));
  }

  terminate(): void {
    this.terminated = true;
    // 与 `ws` 的 terminate 一致：立刻以 1006 结束并触发 close，方便验证「自己关的不推事件」。
    this.readyState = 3;
    this.fire('close', 1006, Buffer.alloc(0));
  }

  private fire(event: string, ...args: unknown[]): void {
    const handler = this.handlers.get(event);
    if (handler) handler(...args);
  }

  /** 握手成功（`ws` 的 OPEN）。 */
  openSocket(): void {
    this.readyState = 1;
    this.fire('open');
  }

  /** 收到一条消息；`isBinary:false` 表示 WS 文本帧。 */
  receive(data: Buffer, isBinary = true): void {
    this.fire('message', data, isBinary);
  }

  /** 服务端关闭（`reason` 原样进 `close` 事件，用于 4004 两种含义的归因）。 */
  finish(code: number, reason = ''): void {
    this.readyState = 3;
    this.fire('close', code, Buffer.from(reason, 'utf8'));
  }

  /** `ws` 的 error 事件（连接建立后出错时不再抛给 invoke）。 */
  failSocket(message: string): void {
    this.fire('error', new Error(message));
  }
}

interface ViewerHarness {
  readonly viewer: ReturnType<typeof createPsbStreamViewer>;
  readonly events: PsbStreamEvent[];
  /** 本观看端实例的 `subscriberId`（注入值；生产是 UUIDv4）。 */
  readonly subscriberId: string;
}

const TEST_SUBSCRIBER_ID = 'subscriber-test-1';

function createHarness(input?: {
  status?: PsbSessionStreamStatus;
  /** 覆盖状态读取（预检失败 / 按次变化用）；优先于 `status`。 */
  fetchStatus?: (sessionId: string) => Promise<PsbSessionStreamStatus>;
  /** 覆盖 subscriberId 工厂（用于断言「每实例只生成一次」）；默认固定返回 TEST_SUBSCRIBER_ID。 */
  createSubscriberId?: () => string;
  subscriberId?: string;
}): ViewerHarness {
  FakeSocket.instances = [];
  const events: PsbStreamEvent[] = [];
  const subscriberId = input?.subscriberId ?? TEST_SUBSCRIBER_ID;
  const viewer = createPsbStreamViewer({
    getToken: async () => ({ ok: true as const, token: 'connection-token' }),
    fetchStatus: input?.fetchStatus ?? (async () => input?.status ?? CAPABLE_STATUS),
    createHttpAgent: async () => undefined,
    emit: (event) => events.push(event),
    logger: { debug: vi.fn(), warn: vi.fn() },
    WebSocketCtor: FakeSocket as unknown as NonNullable<PsbStreamViewerDeps['WebSocketCtor']>,
    createSubscriberId: input?.createSubscriberId ?? (() => subscriberId),
  });
  return { viewer, events, subscriberId };
}

/** 冲掉 viewer.start 内部的若干 await（假依赖都已 resolve，不需要真实等待）。 */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

describe('psbStreamViewer 串流观看端', () => {
  it('带 Bearer 与稳定 subscriberId 建连、不发控制帧，并把帧按原字节推给渲染层', async () => {
    const { viewer, events } = createHarness();
    const starting = viewer.start('session-1');
    await flushMicrotasks();
    const socket = FakeSocket.instances[0];
    expect(socket.options.headers).toEqual({ authorization: 'Bearer connection-token' });
    expect(socket.url).toContain('/api/cindy/remote/sessions/session-1/stream');
    // `subscriberId` 是**观看端实例**的稳定 id（生产 = UUIDv4，重连复用；PSB 0.1.170 契约）：
    // 同 id 重连替换旧订阅、不占新名额，换 id 才占名额。
    expect(new URL(socket.url).searchParams.get('subscriberId')).toBe(TEST_SUBSCRIBER_ID);

    socket.openSocket();
    const status = await starting;

    // 上行**只有** `{kind:'input'}`：`{kind:'open'}` / `{kind:'close'}` 会被 PSB 计成非法消息
    // （订阅靠 WS 升级、断开即退订，见 PSB 协作需求 PSB-RW-06）。升级后一条文本帧都不该发。
    expect(socket.sent).toEqual([]);
    // 订阅成功 ≠ 有画面：`active` 是 PSB 的语义（此刻有没有可看的画面），本端不能改写它。
    // PSB 说 false（没有 running 桌面会话）时就是 false，面板据此显示「已连接，等待画面」，
    // 首帧到达后才切到 live；把它改写成 true 会让面板在零帧时谎称「串流中」。
    expect(status).toMatchObject({ capability: true, active: false, width: 1920 });
    expect(events[0]).toMatchObject({ type: 'status', sessionId: 'session-1' });
    expect((events[0] as { status: PsbSessionStreamStatus }).status.active).toBe(false);

    const frameBytes = [0x00, 0x00, 0x00, 0x01, 0x67];
    socket.receive(Buffer.from(frameBytes), true);

    const frame = events.find((event) => event.type === 'frame');
    expect(frame).toBeDefined();
    expect([...new Uint8Array((frame as { payload: ArrayBuffer }).payload)]).toEqual(frameBytes);
  });

  it('超限二进制帧被丢弃（只告警一次），后续正常帧不受影响', async () => {
    // 无上限时一条畸形帧会原样进 IPC 与 VideoDecoder，把 main/渲染层内存一起放大。
    // 上限与拒收点都在 streamViewer（唯一帧入口），这里经真实 start/receive 路径验证。
    const { viewer, events } = createHarness();
    const starting = viewer.start('session-1');
    await flushMicrotasks();
    const socket = FakeSocket.instances[0]!;
    socket.openSocket();
    await starting;
    events.length = 0;

    socket.receive(Buffer.alloc(PSB_STREAM_MAX_BINARY_FRAME_BYTES + 1), true);
    expect(events.filter((event) => event.type === 'frame')).toHaveLength(0);

    // 后续合法帧照常投递（一条坏帧不关闭连接、也不影响该会话继续观看）。
    socket.receive(Buffer.from([0x01, 0x02, 0x03]), true);
    expect(events.filter((event) => event.type === 'frame')).toHaveLength(1);
  });

  it('4008 心跳超时归因为稳定 token（不是裸 ws-4008）', () => {
    const classification = classifyStreamClose({
      code: 4008,
      reason: '',
      receivedBinaryFrames: 0,
    });
    expect(classification.reason).toBe('heartbeat-timeout');
    // 没有 PSB 原因文本时明细为空，消费方按 token 处理（重新「启动」观看）。
    expect(classification.detail).toEqual({
      reasonCode: null,
      desktopSession: null,
      messageZh: null,
    });
  });

  it('服务端关闭码映射成稳定 token；mid-stream 错误推 error 事件且只推一次', async () => {
    const { viewer, events } = createHarness();
    const starting = viewer.start('session-1');
    await flushMicrotasks();
    FakeSocket.instances[0].openSocket();
    await starting;

    FakeSocket.instances[0].failSocket('read ECONNRESET');
    FakeSocket.instances[0].failSocket('read ECONNRESET');

    expect(events.filter((event) => event.type === 'error')).toEqual([
      {
        type: 'error',
        sessionId: 'session-1',
        failure: {
          code: 'PSB_STREAM_UNREACHABLE',
          messageKey: 'remoteWorkspace.error.unreachable',
          message: 'read ECONNRESET',
        },
      },
    ]);

    FakeSocket.instances[0].finish(4001);

    expect(events.at(-1)).toEqual({
      type: 'closed',
      sessionId: 'session-1',
      reason: 'session-ended',
      // 4001 没有结构前缀、也没有原因文本：明细字段全空，消费方按 token 选文案。
      detail: { reasonCode: null, desktopSession: null, messageZh: null },
    });
  });

  /**
   * 4004 在 PSB 有**两种含义**（PSB 仓 `docs/remote-workspace.md` §11.10「已知语义重叠」）：
   * 「没有可观看画面」（notReady，close reason 带结构前缀）与串流中继的「慢订阅者被断开」。
   * 归因规则见 `streamViewer.ts` 文件头；联调事故就是这里把前者报成了后者。
   */
  it.each([
    {
      name: '结构化 reason（没有桌面会话）→ not-ready，并带出机器码与中文人话',
      frameBytes: null,
      closeReason:
        '{"reasonCode":"NO_DESKTOP_SESSION","desktopSession":"none"}|该工作区没有正在运行的桌面会话，请先到 PSB 网页「远程控制」页签启动桌面会话。',
      expected: {
        reason: 'not-ready',
        detail: {
          reasonCode: 'NO_DESKTOP_SESSION',
          desktopSession: 'none',
          messageZh:
            '该工作区没有正在运行的桌面会话，请先到 PSB 网页「远程控制」页签启动桌面会话。',
        },
      },
    },
    {
      name: '无帧 + 无结构 reason 的 4004 → not-ready（不报慢订阅者）',
      frameBytes: null,
      closeReason: '该工作区没有正在运行的桌面会话',
      expected: {
        reason: 'not-ready',
        detail: {
          reasonCode: null,
          desktopSession: null,
          messageZh: '该工作区没有正在运行的桌面会话',
        },
      },
    },
    {
      name: '收到过帧之后的 4004 → slow-subscriber（原语义不变）',
      frameBytes: [0x00, 0x00, 0x00, 0x01, 0x67],
      closeReason: '订阅者缓冲积压超过上限，已断开。',
      expected: {
        reason: 'slow-subscriber',
        detail: {
          reasonCode: null,
          desktopSession: null,
          messageZh: '订阅者缓冲积压超过上限，已断开。',
        },
      },
    },
  ])('4004 关闭归因：$name', async ({ frameBytes, closeReason, expected }) => {
    const { viewer, events } = createHarness();
    const starting = viewer.start('session-1');
    await flushMicrotasks();
    const socket = FakeSocket.instances[0];
    socket.openSocket();
    await starting;
    if (frameBytes) socket.receive(Buffer.from(frameBytes), true);
    socket.finish(4004, closeReason);

    expect(events.at(-1)).toEqual({
      type: 'closed',
      sessionId: 'session-1',
      ...expected,
    });
  });

  /**
   * PSB 0.1.170 的 `errors=frame` 升级（我们**暂不启用**该参数）：不带它时行为与旧版逐字节
   * 一致，但这些关闭码已经可以出现（服务端升级后）。main 先做加性识别，避免启用时变成未知码。
   */
  it.each([
    { code: 4409, reason: 'quota' },
    { code: 4001, reason: 'session-ended' },
    { code: 4404, reason: 'session-not-found' },
    { code: 4413, reason: 'control-conflict' },
    { code: 4412, reason: 'control-lost' },
  ])(
    'PSB 0.1.170 新关闭码 $code → token $reason（加性，未启用 errors=frame）',
    ({ code, reason }) => {
      expect(classifyStreamClose({ code, reason: '', receivedBinaryFrames: 0 })).toEqual({
        reason,
        // 没有 close reason 文本：明细字段全空，消费方按 token 选下一步（不解析中文/不猜会话状态）。
        detail: { reasonCode: null, desktopSession: null, messageZh: null },
      });
    },
  );

  it('同一会话重复 start：预检通过后原子替换旧连接，补发 closed(superseded)，全程不发控制帧', async () => {
    const { viewer, events } = createHarness();
    const first = viewer.start('session-1');
    await flushMicrotasks();
    FakeSocket.instances[0].openSocket();
    await first;
    const eventsBeforeRestart = events.length;

    const restarting = viewer.start('session-1');
    await flushMicrotasks();
    const firstSocket = FakeSocket.instances[0];
    const secondSocket = FakeSocket.instances[1];

    // 新连接握手成功前，旧连接必须原样活着（预检/握手失败不该让画面消失）。
    expect(firstSocket.terminated).toBe(false);
    secondSocket.openSocket();
    await restarting;

    // 退订靠断开本身：替换时旧连接已被 terminate，不需要（也不允许）先发 `{kind:'close'}`。
    expect(firstSocket.sent).toEqual([]);
    expect(firstSocket.terminated).toBe(true);
    // 旧连接被替换要补发 closed(superseded)：渲染层据此拆掉旧画面状态（顺序在新状态之前）。
    const closed = events.slice(eventsBeforeRestart).filter((event) => event.type === 'closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ type: 'closed', sessionId: 'session-1', reason: 'superseded' });
    const closedAt = events.indexOf(closed[0]!);
    const statusAfterClosed = events.findIndex(
      (event, index) => index > closedAt && event.type === 'status',
    );
    expect(statusAfterClosed).toBeGreaterThan(closedAt);

    // 重连必须复用同一个 subscriberId（PSB 0.1.170：同 id 重连 = 替换旧订阅、不占新名额；
    // 换 id 才占新名额）。这里断言两个 socket 的 query 完全一致。
    expect(new URL(secondSocket.url).searchParams.get('subscriberId')).toBe(
      new URL(firstSocket.url).searchParams.get('subscriberId'),
    );
    expect(secondSocket.sent).toEqual([]);
  });

  it('重启预检失败时保留旧连接（不先拆后建，失败不挂空）', async () => {
    let failPreflight = false;
    const { viewer, events } = createHarness({
      fetchStatus: async () => {
        if (failPreflight) throw new PsbClientError(
          { code: 'PSB_UNREACHABLE', messageKey: 'remoteWorkspace.error.unreachable', message: 'boom' },
          null,
        );
        return CAPABLE_STATUS;
      },
    });
    const first = viewer.start('session-1');
    await flushMicrotasks();
    const firstSocket = FakeSocket.instances[0];
    firstSocket.openSocket();
    await first;

    failPreflight = true;
    const restarting = viewer.start('session-1').catch((cause: unknown) => cause);
    await flushMicrotasks();
    const error = await restarting;

    expect(error).toBeInstanceOf(PsbClientError);
    // 旧连接没有被拆：仍处于可用状态，且新 socket 根本没建。
    expect(firstSocket.terminated).toBe(false);
    expect(FakeSocket.instances).toHaveLength(1);
    // 旧连接还能继续送帧（用户画面没有中断）。
    firstSocket.receive(Buffer.from('still-live'), true);
    expect(events.filter((event) => event.type === 'frame')).toHaveLength(1);
  });

  it('subscriberId 在观看端实例创建时生成一次：重连/多会话复用，换个观看端才换新的', async () => {
    let generated = 0;
    const harness = createHarness({
      createSubscriberId: () => {
        generated += 1;
        return `subscriber-${generated}`;
      },
    });

    // 实例创建即生成（不是第一次 start 才生成）：一次。
    expect(generated).toBe(1);

    const first = harness.viewer.start('session-1');
    await flushMicrotasks();
    FakeSocket.instances[0].openSocket();
    await first;
    // 同一观看端的另一次订阅（不同 PSB 会话）复用同一个 id；重连同样复用。
    const other = harness.viewer.start('session-2');
    await flushMicrotasks();
    FakeSocket.instances[1].openSocket();
    await other;
    expect(generated).toBe(1);
    expect(new URL(FakeSocket.instances[0].url).searchParams.get('subscriberId')).toBe(
      'subscriber-1',
    );
    expect(new URL(FakeSocket.instances[1].url).searchParams.get('subscriberId')).toBe(
      'subscriber-1',
    );

    // 换观看端（账号边界重建实例）→ 新 id，PSB 才会把它算作另一个订阅者。
    const another = createHarness({
      createSubscriberId: () => 'subscriber-second-viewer',
    });
    const starting = another.viewer.start('session-1');
    await flushMicrotasks();
    FakeSocket.instances[0].openSocket();
    await starting;
    expect(new URL(FakeSocket.instances[0].url).searchParams.get('subscriberId')).toBe(
      'subscriber-second-viewer',
    );
  });

  it('生产 subscriberId 工厂产出 UUIDv4（至少三次互不相同）', () => {
    const ids = [
      createPsbStreamSubscriberId(),
      createPsbStreamSubscriberId(),
      createPsbStreamSubscriberId(),
    ];
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const id of ids) expect(id).toMatch(uuidV4);
    expect(new Set(ids).size).toBe(3);
    // URL 只带 query（main 没有 localStorage，query 是浏览器等价物的自然对应）。
    expect(buildPsbStreamUrl('psb-session-9', 'uuid-9')).toMatch(
      /^wss:\/\/[^/]+\/api\/cindy\/remote\/sessions\/psb-session-9\/stream\?subscriberId=uuid-9$/,
    );
  });

  it('stop 断开并发 closed(client-stopped)；客户端没有 streaming 能力时不开 socket', async () => {
    const { viewer, events } = createHarness();
    const starting = viewer.start('session-1');
    await flushMicrotasks();
    const socket = FakeSocket.instances[0];
    socket.openSocket();
    await starting;

    await viewer.stop('session-1');

    // 断开即退订：不再向 PSB 发送任何文本帧（旧实现会先发 `{kind:'close'}`）。
    expect(socket.sent).toEqual([]);
    expect(socket.terminated).toBe(true);
    // 主动停止也要让渲染层收敛状态：补发稳定 token 的 closed，而不是靠 invoke 返回值猜。
    expect(events.at(-1)).toMatchObject({
      type: 'closed',
      sessionId: 'session-1',
      reason: 'client-stopped',
    });

    const incapable = createHarness({
      status: { ...CAPABLE_STATUS, capability: false, lastErrorZh: '采集未启动' },
    });
    const error = await incapable.viewer.start('session-2').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PsbClientError);
    expect((error as PsbClientError).failure).toMatchObject({
      code: 'PSB_STREAM_UNSUPPORTED',
      messageKey: 'remoteWorkspace.session.streamUnsupported',
    });
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('sendInput 是唯一的上行业务消息；没有活动连接时抛 PSB_STREAM_NOT_ACTIVE', async () => {
    const { viewer } = createHarness();

    // 未 start：可行动失败（先启动观看），不是静默丢弃。
    const idle = await viewer
      .sendInput('session-1', { kind: 'pointermove', x: 1, y: 2 })
      .catch((cause: unknown) => cause);
    expect(idle).toBeInstanceOf(PsbClientError);
    expect((idle as PsbClientError).failure).toMatchObject({
      code: 'PSB_STREAM_NOT_ACTIVE',
      messageKey: 'remoteWorkspace.session.streamIdle',
    });

    const starting = viewer.start('session-1');
    await flushMicrotasks();
    const socket = FakeSocket.instances[0];
    socket.openSocket();
    await starting;

    await viewer.sendInput('session-1', { kind: 'pointermove', x: 12, y: 34 });
    expect(socket.sent).toEqual([
      JSON.stringify({ kind: 'input', event: { kind: 'pointermove', x: 12, y: 34 } }),
    ]);

    // stop 之后同一会话的输入立刻回到「未启动」：不会留在旧 socket 上等它自己断。
    await viewer.stop('session-1');
    await expect(
      viewer.sendInput('session-1', { kind: 'keydown', key: 'a', code: 'KeyA' }),
    ).rejects.toBeInstanceOf(PsbClientError);
  });
});

/**
 * 宿主光标形状（2026-11-26）：PSB 把客户端上报的光标作为 `stream.cursor` **文本帧**转发。
 *
 * 这条链路的可观察结果有三件事：渲染层是否收到 `{type:'cursor'}`、连续重复 serial 是否去重
 * （**serial 回退不丢弃**——真机日志证明 PSB 的序号不严格单调）、文本帧是否**没有**污染二进制
 * 帧路径（后者参与 4004 归因，混入会让「从未有画面」被误报成「慢订阅者」）。旧实现只认
 * `{kind:'status'}`，cursor 会被当未知文本帧丢弃。
 */
describe('psbStreamViewer 宿主光标形状（stream.cursor 文本帧）', () => {
  it('合法 cursor 文本帧 → 推 cursor 事件；文本帧不进入二进制帧路径（4004 仍归因 not-ready）', async () => {
    const { viewer, events } = createHarness();
    const starting = viewer.start('session-1');
    await flushMicrotasks();
    const socket = FakeSocket.instances[0];
    socket.openSocket();
    await starting;

    // 旧的 `{kind:'status'}` 文本帧行为不变（同一 handleTextMessage 的另一条分支）。
    socket.receive(
      Buffer.from(
        JSON.stringify({
          kind: 'status',
          status: { capability: true, active: true, width: 1280, height: 720, fps: 30 },
        }),
      ),
      false,
    );
    socket.receive(cursorTextFrame({ serial: 1, width: 16, height: 16, xhot: 0, yhot: 0 }), false);

    // 首个 status 事件来自 start（PSB 状态快照），这里取最新一条（文本帧推来的）。
    expect(events.filter((event) => event.type === 'status').at(-1)).toMatchObject({
      type: 'status',
      sessionId: 'session-1',
      status: { active: true, width: 1280 },
    });
    expect(cursorEvents(events)).toEqual([
      {
        serial: 1,
        width: 16,
        height: 16,
        xhot: 0,
        yhot: 0,
        imageBase64: CURSOR_PNG_BASE64,
        name: 'text',
      },
    ]);
    // 文本帧绝不能被当成画面帧：否则渲染层会把 base64 JSON 丢进解码器。
    expect(events.filter((event) => event.type === 'frame')).toHaveLength(0);

    // 关键不变量：文本帧不计入 `receivedBinaryFrames`。一帧二进制都没有时 4004 必须归因
    // not-ready（「从没出过画面」），而不是 slow-subscriber。
    socket.finish(4004, '没有可观看的画面');
    expect(events.at(-1)).toMatchObject({ type: 'closed', reason: 'not-ready' });
  });

  it('连续重复 serial 去重；serial 回退也照常 emit（PSB serial 不严格单调）', async () => {
    const { viewer, events } = createHarness();
    const starting = viewer.start('session-1');
    await flushMicrotasks();
    const socket = FakeSocket.instances[0];
    socket.openSocket();
    await starting;

    socket.receive(cursorTextFrame({ serial: 5 }), false);
    expect(cursorEvents(events).map((shape) => shape.serial)).toEqual([5]);

    // 同一条形状重复下发：不重复占 IPC（渲染层样式已经是对的）。
    socket.receive(cursorTextFrame({ serial: 5 }), false);
    expect(cursorEvents(events).map((shape) => shape.serial)).toEqual([5]);

    // **serial 回退不是「旧形状」**：真机日志里同一连接的光标序号会回退（PSB 的 serial
    // 不能当严格单调用）。旧的 out-of-order 丢弃会让远端的新形状被吃掉，指针卡在旧形态。
    socket.receive(cursorTextFrame({ serial: 4, name: 'xterm' }), false);
    socket.receive(cursorTextFrame({ serial: 3, name: 'left_side' }), false);
    expect(cursorEvents(events).map((shape) => shape.serial)).toEqual([5, 4, 3]);
    expect(cursorEvents(events).map((shape) => shape.name)).toEqual(['text', 'xterm', 'left_side']);

    // 再回到 5：与前一条（3）不同 → 照常投递。
    socket.receive(cursorTextFrame({ serial: 5 }), false);
    expect(cursorEvents(events).map((shape) => shape.serial)).toEqual([5, 4, 3, 5]);
  });

  it('非法 / 超限 cursor 帧只丢自己：不推事件、不污染序号（后续合法帧仍生效）', async () => {
    const { viewer, events } = createHarness();
    const starting = viewer.start('session-1');
    await flushMicrotasks();
    const socket = FakeSocket.instances[0];
    socket.openSocket();
    await starting;

    socket.receive(cursorTextFrame({ serial: 1, width: 65 }), false);
    socket.receive(cursorTextFrame({ serial: 2, imageBase64: 'iVBORw0KGg"' }), false);
    socket.receive(
      cursorTextFrame({
        serial: 3,
        imageBase64: 'A'.repeat(PSB_STREAM_CURSOR_MAX_BASE64_LENGTH + 4),
      }),
      false,
    );
    socket.receive(cursorTextFrame({ serial: 4, xhot: 32 }), false);
    expect(events.filter((event) => event.type === 'cursor')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'frame')).toHaveLength(0);

    socket.receive(cursorTextFrame({ serial: 1, width: 8, height: 8, xhot: 7, yhot: 7 }), false);
    expect(cursorEvents(events)).toEqual([
      {
        serial: 1,
        width: 8,
        height: 8,
        xhot: 7,
        yhot: 7,
        imageBase64: CURSOR_PNG_BASE64,
        name: 'text',
      },
    ]);
  });

  it('stop / 重新 start 清空序号状态：新订阅从低 serial 重新开始也生效', async () => {
    const { viewer, events } = createHarness();
    const first = viewer.start('session-1');
    await flushMicrotasks();
    const firstSocket = FakeSocket.instances[0];
    firstSocket.openSocket();
    await first;
    firstSocket.receive(cursorTextFrame({ serial: 9 }), false);
    expect(cursorEvents(events).map((shape) => shape.serial)).toEqual([9]);

    await viewer.stop('session-1');

    const restarting = viewer.start('session-1');
    await flushMicrotasks();
    const secondSocket = FakeSocket.instances[1];
    secondSocket.openSocket();
    await restarting;
    // PSB 重连 / 采集重建后序号可能从低值重新开始：若沿用旧序号，1 会被当旧值永久丢弃。
    secondSocket.receive(cursorTextFrame({ serial: 1 }), false);
    expect(cursorEvents(events).map((shape) => shape.serial)).toEqual([9, 1]);
  });
});
