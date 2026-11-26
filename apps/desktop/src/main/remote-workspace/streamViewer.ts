/**
 * PSB 会话串流**观看端**（main 进程）—— Cindy 是 PSB 串流中继的第二个观看端实现。
 *
 * ## 链路
 *
 * ```
 * PSB 远端客户端采集 H.264
 *   → PSB 中继
 *   → main（本文件：wss 观看端，Bearer 鉴权）
 *   → IPC 推送 `PSB_REMOTE_CHANNELS.STREAM_EVENT`（PsbStreamEvent）
 *   → renderer 用 WebCodecs 解码到 canvas
 * ```
 *
 * 帧是**二进制透传**：main 不解析 H.264、也不重编码，只把 WS 二进制消息原样转成
 * `{ type:'frame', payload: ArrayBuffer }`。这样渲染层能直接复用既有观看端的解包头
 * （`remote-desktop/liveScreenStream.ts` 那套）与关键帧请求策略。
 *
 * ## 三条不变式
 *
 * 1. **名额不能泄漏**：PSB 的观看名额与浏览器页面**共用**（默认 4，部署级
 *    `PSB_STREAM_MAX_SUBSCRIBERS`）。停流、切换会话、窗口销毁、退出登录都必须真的断开连接；
 *    重复 `start` 先停旧连接（本文件幂等），否则用户自己两个窗口就会把名额占满。
 * 2. **写操作不自动重连**：串流是用户显式「启动 / 停止」的动作，握手失败就报可行动的原因
 *    （鉴权 / 会话不可见 / 未就绪 / 不可达），不在这里做指数退避——否则用户会看到一个
 *    自己关不掉的连接风暴。
 * 3. **只推事实，不写文案**：`closed` 事件的 `reason` 是稳定 token（见 `psbStreamClosedReason`），
 *    `detail` 带 PSB 的机器码与中文原话（`PsbStreamCloseDetail`）；`error` 事件是
 *    `PsbRemoteFailure`（`messageKey` 由渲染层翻译）。main 不产生任何中文句子。
 *
 * ## 4004 有两种含义（2026-11-26 联调事故）
 *
 * PSB 的「没有可观看画面」（`notReady`）与串流中继的「慢订阅者被断开」都用关闭码 `4004`。
 * 之前这里把 4004 一律归因 `slow-subscriber`，导致「该工作区没有 running 桌面会话」被误报成
 * 网络/消费太慢。现在按 PSB 建议的两条判据区分（`classifyStreamClose`）：
 *
 * | 4004 情形 | 归因 token |
 * | --- | --- |
 * | close reason 以 `{"reasonCode":…,"desktopSession":…}\|` 开头（PSB notReady） | `not-ready` |
 * | 该连接**从没收到过二进制帧**、也没有结构前缀 | `not-ready`（不报慢订阅者） |
 * | **收到过帧之后**、且没有结构前缀（中继慢订阅者） | `slow-subscriber`（原语义不变） |
 *
 * 结构前缀优先于帧数：PSB 只会为 notReady 加前缀，收到过帧也不改变它的含义。
 *
 * ## 上行只有一种消息：`{kind:'input'}`
 *
 * PSB 的观看端订阅**由 WS 升级建立、断开即退订**（浏览器观看端就是这么做的）。Cindy 早期
 * 按「加性协议」猜测发过 `{kind:'open'}` / `{kind:'close'}`，PSB 侧把它们计入**非法消息**
 * （`联动需求.md` PSB-RW-06 问答：不要发这两个 kind）。现在本端**不再发送任何控制帧**，
 * 上行文本只有 `{kind:'input', event}`（`sendInput`），帧与状态的本地状态机保留在这里。
 *
 * ## 名额与稳定 `subscriberId`（PSB 0.1.170 契约）
 *
 * PSB 的规则（2026-11-26 PSB 0.1.170 回复）：`subscriberId` 由**客户端生成 UUIDv4**，一个
 * 「观看端（观看会话）」一个 id；**重连必须复用同一 id** —— 同 id 重连是**替换**旧订阅、不占
 * 新名额；换 id 才占新名额。观看名额与浏览器页面**共用**，默认 4（部署级
 * `PSB_STREAM_MAX_SUBSCRIBERS`）。
 *
 * Cindy 的「观看端」就是本文件的一个 viewer 实例（进程启动 / 账号边界时重建）：id 在
 * **实例创建时**生成一次（`createSubscriberId`，生产 = `randomUUID`），同一实例的所有重连都用
 * 它；账号边界重建实例 = 新观看端 = 新 id。id 放在 WS 升级 URL 的 query
 * （`subscriberId=<uuid>`），main 没有 localStorage，query 是浏览器等价物的自然对应。
 *
 * ## 协议（PSB 仓 `协作需求.md` §4.5 / §6.5）
 *
 *   - 上行（PSB → 本端）：二进制帧，帧头沿用既有观看端（`type(1) + flags(1) + seq(2, BE)` + H.264）；
 *     另有**两条文本帧**：`{kind:'status', status:{…}}`（采集状态）与
 *     `{type:'stream.cursor', …}`（宿主光标形状，见下）。
 *   - 下行（本端 → PSB）：只允许 JSON `{kind:'input', event}`；不发送 open / close 等控制帧。
 *
 * ## 文本帧：status 与 cursor（2026-11-26）
 *
 * WS 文本帧**只走 `handleTextMessage`**，二进制帧路径（`receivedBinaryFrames` / `{type:'frame'}`）
 * 不受文本帧影响 —— 这是本文件的第四条不变式：文本帧绝不进入二进制帧路径。
 *
 * PSB 中继把客户端上报的宿主光标形状作为 `{type:'stream.cursor'}` 转发给同会话所有观看者
 * （新订阅者会补发最近一条）。语义是**覆盖**：丢一条没有后果，所以：
 *
 *   - 字段完整校验（尺寸 1..64、热点 < 尺寸、base64 ≤ 48 KiB 且只含 base64 字符）由共享纯函数
 *     `parsePsbStreamCursorTextFrame` 完成，非法/超限只记 debug；
 *   - 每会话维护 `lastCursorSerial`，但**只用来去重连续重复的同一条形状，不按序号丢弃**：
 *     真机日志出现过同一连接里序号不严格单调（PSB 的 serial 不能当严格单调用），旧的
 *     「out-of-order 丢弃」会把更新的形状吃掉（用户看到指针卡在旧形态）；
 *   - `start` / `stop` / `dispose` 清空该会话的序号状态：新订阅是一条新的序号生命线；
 *   - 合法的推 `{ type:'cursor', sessionId, cursor }`，与 status 共用 `deps.emit` 通道。
 *     渲染层只取 `name` 映射成宿主风格的 CSS 关键字（形状同步、外观永远本机），不在 main 拼 CSS。
 *
 * ## 交互输入的服务端事实（已知风险，不要在客户端假装有闸门）
 *
 * 服务端**没有**只读 / 仲裁闸门：任何持有该会话可见权限的 Cindy 身份都能通过同一条中继把
 * 输入注入远端桌面。Cindy 侧的唯一约束是「渲染层只在用户显式开启的画面捕获态采集并转发」，
 * 它不是安全边界（见 `docs/dev-rules/psb-remote-session-transport.md` §12.5）。
 */

import { randomUUID } from 'node:crypto';

import WebSocket, { type RawData } from 'ws';

import type {
  PsbRemoteFailure,
  PsbSessionStreamStatus,
  PsbStreamCloseDetail,
  PsbStreamEvent,
} from '../../shared/psb-remote-workspace.js';
import {
  PSB_STREAM_CURSOR_TEXT_FRAME_TYPE,
  parsePsbSessionStreamStatus,
  parsePsbStreamCloseReason,
  parsePsbStreamCursorTextFrame,
} from '../../shared/psb-remote-workspace.js';
import { PsbClientError, psbMessageKeyForErrorCode, psbStreamPath } from './psbClient.js';
import { psbWebSocketUrl } from './psbEndpoint.js';

/** 观看端握手体的读取上限：PSB 的错误外壳（`{error:{code,message}}`）远小于它。 */
const UPGRADE_BODY_LIMIT_BYTES = 8 * 1024;

/** 握手失败时读错误体的预算；读不到（服务器不结束响应）就按 HTTP 状态归因。 */
const UPGRADE_BODY_TIMEOUT_MS = 1_500;

/**
 * 单条二进制帧的上限（16 MiB）。
 *
 * WS 客户端默认允许 `ws` 的 100 MiB payload；PSB 中继的 H.264 关键帧远小于 16 MiB，超过这个
 * 量级只可能是畸形/恶意帧。无上限时它会一路进 IPC 再进 `VideoDecoder`，把 main 与渲染层的
 * 内存一起放大。超限帧**丢弃并告警一次**，不关闭连接（一条坏帧不该让用户丢掉观看名额）。
 */
export const PSB_STREAM_MAX_BINARY_FRAME_BYTES = 16 * 1024 * 1024;

interface StreamLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** `ws` 的最小结构面（单测注入假实现用，不依赖真实 socket）。 */
type PsbStreamSocket = {
  readyState: number;
  binaryType?: string;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?: () => void;
  on(event: 'open', callback: () => void): unknown;
  on(event: 'message', callback: (data: RawData, isBinary: boolean) => void): unknown;
  on(event: 'close', callback: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', callback: (error: Error) => void): unknown;
  on(
    event: 'unexpected-response',
    callback: (_request: unknown, response: PsbStreamUpgradeResponse) => void,
  ): unknown;
};

/** `ws` 非 101 响应体（Node `http.IncomingMessage` 的最小面）。 */
interface PsbStreamUpgradeResponse {
  statusCode?: number;
  on(event: 'data', callback: (chunk: unknown) => void): unknown;
  on(event: 'end', callback: () => void): unknown;
  on(event: 'error', callback: (error: Error) => void): unknown;
  resume(): void;
}

type PsbStreamSocketConstructor = new (
  url: string,
  options: { headers: Record<string, string>; agent?: unknown },
) => PsbStreamSocket;

export interface PsbStreamViewerDeps {
  /** 取当前身份的 PSB Connection JWT（生产 = `getPsbConnectionToken`）。 */
  getToken(): Promise<{ ok: true; token: string } | { ok: false; reasonKey: string }>;
  /** 串流能力与状态的事实来源（生产 = `PsbApi.getStreamStatus`，HTTP 只读）。 */
  fetchStatus(sessionId: string): Promise<PsbSessionStreamStatus>;
  /** `ws` 的出站 agent（生产 = `createOutboundHttpAgent`，吃系统代理）；直连返回 `undefined`。 */
  createHttpAgent(url: string): Promise<unknown>;
  /** 把事件交给 IPC 推送层（生产 = `broadcastPsbStreamEvent`）。 */
  emit(event: PsbStreamEvent): void;
  logger: StreamLogger;
  /** 单测注入点；生产用 `ws` 默认导出。 */
  WebSocketCtor?: PsbStreamSocketConstructor;
  /**
   * 生成本观看端的 `subscriberId`（一个 viewer 实例只调一次；默认 `randomUUID`）。
   *
   * 单测注入确定性 id；生产必须 UUIDv4（PSB 契约要求，见 `createPsbStreamSubscriberId`）。
   */
  createSubscriberId?: () => string;
}

export interface PsbStreamViewer {
  /**
   * 开始观看某会话。幂等：同一会话已有连接时先停旧连接再重连。
   * 失败抛 `PsbClientError`（`failure.messageKey` 可翻译），不推 `error` 事件（invoke 自己会报错）。
   */
  start(sessionId: string): Promise<PsbSessionStreamStatus>;
  /** 停止观看（断开 WS；退订靠断开本身，不发控制帧）；没有连接时幂等无副作用。 */
  stop(sessionId: string): Promise<void>;
  /** 键鼠输入：唯一的上行业务消息 `{kind:'input', event}`。没有活动连接时抛可行动失败。 */
  sendInput(sessionId: string, event: Record<string, unknown>): Promise<void>;
  /** 进程退出/服务 dispose：断开全部观看端，不发事件。 */
  dispose(): void;
}

/**
 * 生成一个观看端的稳定 `subscriberId`（UUIDv4）。
 *
 * PSB 0.1.170 契约：id 由客户端生成，一个「观看端」一个，**重连必须复用同一 id**（同 id 重连
 * 替换旧订阅、不占新名额；不同 id 才占名额）。调用点只有一个：viewer 实例创建时（见
 * `createPsbStreamViewer`），因此「进程内某个 viewer 的所有重连」天然共用同一个值。
 */
export function createPsbStreamSubscriberId(): string {
  return randomUUID();
}

/**
 * 观看端 WS 地址（含 `subscriberId`）。
 *
 * 单独放在这里是为了让「上行 URL 里到底带了什么」可被单测钉住：`subscriberId` 一旦丢失或每次
 * 重连换新，故障表现是「观看名额被自己占满 / 别人偶尔连不上」，现场极难归因。
 */
export function buildPsbStreamUrl(sessionId: string, subscriberId: string): string {
  const url = new URL(psbWebSocketUrl(psbStreamPath(sessionId)));
  const params = new URLSearchParams();
  params.set('subscriberId', subscriberId);
  url.search = params.toString();
  url.hash = '';
  return url.toString();
}

/**
 * 关闭码 → 稳定原因 token（渲染层据此决定文案；main 不写死句子）。
 *
 * 4004 是**两种含义共用同一个数字**（见文件头）。裸码本身分不出来，所以默认按更常见、
 * 更可恢复的「未就绪」归因；只有调用方明确说明「连接已收到过帧、且 reason 没有 PSB 的
 * 结构化前缀」时才归因慢订阅者。生产路径走 `classifyStreamClose`，它把这两个事实都带上。
 */
export interface PsbStreamCloseContext {
  /** 该连接累计收到的二进制帧数（0 = 从没收到过画面/配置帧）。 */
  readonly receivedBinaryFrames?: number;
  /** close reason 是否带 PSB 的结构化前缀（`{"reasonCode":…,"desktopSession":…}|`）。 */
  readonly hasStructuredReason?: boolean;
}

export function psbStreamClosedReason(code: number, context: PsbStreamCloseContext = {}): string {
  switch (code) {
    case 1000:
      return 'closed';
    case 4001:
      return 'session-ended';
    case 4002:
      return 'client-offline';
    case 4003:
      return 'replaced';
    case 4004: {
      // 结构前缀 = PSB 的 notReady（「没有可观看画面」）；它只会在连接还没收到帧时出现，
      // 但结构本身是更强的信号，收到过帧也按 PSB 说的办。
      if (context.hasStructuredReason === true) return 'not-ready';
      return (context.receivedBinaryFrames ?? 0) > 0 ? 'slow-subscriber' : 'not-ready';
    }
    case 4005:
      return 'no-stream';
    case 4006:
      return 'socket-unwritable';
    // 4008 = 心跳超时（PSB 中继判定观看端已失联后关闭）。归因成独立 token 而不是 `ws-4008`：
    // 它与「慢订阅者」不同，用户可行动的是重新「启动」观看（会话本身通常还在）。
    // 文案仍优先用 PSB 的 close reason（`detail.messageZh`）；没有 reason 时 token 至少让
    // 诊断/日志可归因，而不是一个裸数字。
    case 4008:
      return 'heartbeat-timeout';
    case 4010:
      return 'channel-lost';
    case 4409:
      return 'quota';
    // PSB 0.1.170 的 `errors=frame` 升级会先发 `stream.reject` 原因帧再按这些码关闭；我们
    // **暂不启用**该参数（不带它行为与旧版逐字节一致），这里先加性识别，避免启用时变成未知码。
    // 4404 = 会话不存在（下一步同「会话已结束」：重新启动/重建）；4413 / 4412 = 控制仲裁
    // （当前 `unmanaged` 不会出现；PSB 落地 `role` + 单控制者后才可能触发）。
    case 4404:
      return 'session-not-found';
    case 4413:
      return 'control-conflict';
    case 4412:
      return 'control-lost';
    default:
      return `ws-${code}`;
  }
}

/**
 * 关闭事件的完整归因：稳定 token + PSB 的结构化机器码/中文原话。
 *
 * 只是把三个输入（关闭码、close reason、本连接收到过的帧数）收敛成一个结果：token 由
 * `psbStreamClosedReason` 决定，`detail` 里的机器字段来自 close reason 的 JSON 前缀
 * （没有前缀时是 `null`，不要从中文字里反推）。
 */
export interface PsbStreamCloseClassification {
  readonly reason: string;
  readonly detail: PsbStreamCloseDetail;
}

export function classifyStreamClose(input: {
  readonly code: number;
  readonly reason: string;
  /** 该连接累计收到的二进制帧数（用于区分「从未有画面」与「慢订阅者」）。 */
  readonly receivedBinaryFrames: number;
}): PsbStreamCloseClassification {
  const structured = parsePsbStreamCloseReason(input.reason);
  const rawReason = input.reason.trim();
  return {
    reason: psbStreamClosedReason(input.code, {
      receivedBinaryFrames: input.receivedBinaryFrames,
      hasStructuredReason: structured !== null,
    }),
    detail: {
      reasonCode: structured?.reasonCode ?? null,
      desktopSession: structured?.desktopSession ?? null,
      // 有结构前缀时只用 `|` 之后的人话；没有时才回退整段 reason。不能把 JSON 前缀当中文展示。
      messageZh: structured !== null ? structured.messageZh : rawReason || null,
    },
  };
}

/**
 * 握手阶段的 HTTP 状态 → 可归因失败。
 *
 * 归因错了用户就会去做无效动作（重新登录解决不了「会话终态」）。PSB 的错误外壳若可读，
 * 优先用它的 `code`（见 `resolveUpgradeFailure`），本函数只是兜底。
 */
export function classifyStreamHandshakeStatus(status: number | undefined): PsbRemoteFailure {
  switch (status) {
    case 401:
      return { code: 'AUTH_REQUIRED', messageKey: 'remoteWorkspace.error.auth', message: null };
    case 403:
      // PSB 对串流的 403 同时覆盖「身份未关联通讯录」与「非归属人」两种事实；对外不泄漏
      // 会话存在性，因此按「找不到 / 没权限」呈现（与 PSB-RW-08 的 404 口径一致）。
      return { code: 'FORBIDDEN', messageKey: 'remoteWorkspace.error.notFound', message: null };
    case 404:
      return { code: 'NOT_FOUND', messageKey: 'remoteWorkspace.error.notFound', message: null };
    case 409:
      // 会话非运行态 / 客户端离线 / 名额已满都落 409，没有 body 时无法进一步区分。
      return {
        code: 'PSB_STREAM_NOT_READY',
        messageKey: 'remoteWorkspace.error.unknown',
        message: null,
      };
    case 429:
      return {
        code: 'PSB_STREAM_RATE_LIMITED',
        messageKey: 'remoteWorkspace.error.unknown',
        message: null,
      };
    default:
      return {
        code: 'PSB_STREAM_UNREACHABLE',
        messageKey: 'remoteWorkspace.error.unreachable',
        message: null,
      };
  }
}

/** 握手关闭（没走到 open）→ 可归因失败；关闭码语义与 PSB §6.5 一致。 */
export function classifyStreamHandshakeClose(code: number, reason: string): PsbRemoteFailure {
  // 4004 的 close reason 可能是 `{"reasonCode":…,"desktopSession":…}|<一句中文>`：给用户看的
  // 只能是 `|` 之后那句人话，不能把结构前缀原样塞进错误条。
  const structured = parsePsbStreamCloseReason(reason);
  const detail = structured === null ? (reason.length > 0 ? reason : null) : structured.messageZh;
  if (code === 4003) {
    return { code: 'AUTH_REQUIRED', messageKey: 'remoteWorkspace.error.auth', message: detail };
  }
  if (code === 4004) {
    return {
      code: 'PSB_STREAM_NOT_READY',
      messageKey: 'remoteWorkspace.error.unknown',
      message: detail,
    };
  }
  if (code === 4409) {
    return {
      code: 'PSB_STREAM_NOT_READY',
      messageKey: 'remoteWorkspace.error.unknown',
      message: detail,
    };
  }
  // PSB 0.1.170 `errors=frame` 的新码（当前未启用该参数，加性识别）：会话不存在按「找不到」
  // 呈现（与 HTTP 404 同口径）；控制仲裁类（4413/4412）落到「未就绪」的通用文案。
  if (code === 4404) {
    return {
      code: 'NOT_FOUND',
      messageKey: 'remoteWorkspace.error.notFound',
      message: detail,
    };
  }
  if (code === 4413 || code === 4412) {
    return {
      code: 'PSB_STREAM_NOT_READY',
      messageKey: 'remoteWorkspace.error.unknown',
      message: detail,
    };
  }
  return {
    code: 'PSB_STREAM_UNREACHABLE',
    messageKey: 'remoteWorkspace.error.unreachable',
    message: detail ?? `stream closed before open (${code})`,
  };
}

export function createPsbStreamViewer(deps: PsbStreamViewerDeps): PsbStreamViewer {
  const Ctor = deps.WebSocketCtor ?? (WebSocket as unknown as PsbStreamSocketConstructor);
  /**
   * 本观看端的 `subscriberId`（PSB 0.1.170：客户端生成 UUIDv4，一个观看端一个，重连复用）。
   *
   * 生成点必须在这里（实例创建时）而不是每次 `start`：换 id 会被 PSB 当成**新订阅者**占新名额；
   * 同 id 重连才是替换旧订阅。实例生命周期 = 「一个观看端」，账号边界重建实例 = 换观看端。
   */
  const subscriberId = (deps.createSubscriberId ?? createPsbStreamSubscriberId)();
  const active = new Map<string, PsbStreamSocket>();
  const statusById = new Map<string, PsbSessionStreamStatus>();
  /**
   * 每会话最近一次收到的光标形状 serial（uint32）。
   *
   * **只用于去重连续重复的同一条形状**，不作为「新旧」判据：真机日志里同一连接的光标序号
   * 不严格单调（PSB serial 语义不能当严格单调用），按序号丢弃会吃掉真正的形状更新。
   * 生命周期与订阅绑定 —— `start` / `stop` / `dispose` 清空（新订阅 = 新的序号生命线）。
   */
  const lastCursorSerial = new Map<string, number>();
  const starting = new Map<string, Promise<PsbSessionStreamStatus>>();
  /**
   * 每会话的启动代次：`stop`/`dispose` 会推进它，握手回来发现代次变了就自己放弃连接。
   * 没有它时「start 还在握手、用户已点停止」会留下一条没人认领的连接，占掉 PSB 观看名额。
   */
  const generations = new Map<string, number>();
  /**
   * 本端主动断开的 socket：它们的 close 事件不再推 `closed`。
   * 重启（先停旧连）与用户停止都会走到这里；把「我关的」当成「远端断了」会让面板闪一下错误状态。
   */
  const intentionallyClosed = new WeakSet<PsbStreamSocket>();
  let disposed = false;

  function bumpGeneration(sessionId: string): number {
    const next = (generations.get(sessionId) ?? 0) + 1;
    generations.set(sessionId, next);
    return next;
  }

  function forget(sessionId: string): void {
    active.delete(sessionId);
    statusById.delete(sessionId);
  }

  /**
   * 关掉某会话的连接。
   *
   * **不发 `{kind:'close'}`**：PSB 的退订语义就是断开 WS（向 Cindy 的明确口径见 `联动需求.md`
   * PSB-RW-06；浏览器观看端也是这么做的）。用 `terminate()` 而不是优雅关闭，是为了让名额
   * **立刻**释放——「停止」之后马上再次启动时不该还占着旧连接。
   */
  function closeSocket(socket: PsbStreamSocket): void {
    intentionallyClosed.add(socket);
    try {
      if (socket.terminate) socket.terminate();
      else socket.close(1000, 'client stop');
    } catch {
      /* best-effort：即将断开的 socket 不需要把错误丢给用户 */
    }
  }

  function emitStatus(sessionId: string, patch: Partial<PsbSessionStreamStatus>): void {
    const next: PsbSessionStreamStatus = {
      ...(statusById.get(sessionId) ?? parsePsbSessionStreamStatus(null)),
      ...patch,
    };
    statusById.set(sessionId, next);
    deps.emit({ type: 'status', sessionId, status: next });
  }

  async function startInternal(sessionId: string): Promise<PsbSessionStreamStatus> {
    const myGeneration = bumpGeneration(sessionId);
    // 新订阅不应继承上一条连接的光标去重状态（PSB 重连/采集重建后序号可能重新开始）。
    lastCursorSerial.delete(sessionId);
    const previous = active.get(sessionId);
    if (previous) {
      // 幂等：重复启动先停旧连接，避免同一会话在自己这里占掉两个观看名额。
      closeSocket(previous);
      forget(sessionId);
    }

    const status = await deps.fetchStatus(sessionId);
    if (!status.capable) {
      throw psbStreamFailure({
        code: 'PSB_STREAM_UNSUPPORTED',
        messageKey: 'remoteWorkspace.session.streamUnsupported',
        message: status.lastError,
      });
    }

    const auth = await deps.getToken();
    if (!auth.ok) {
      throw psbStreamFailure({ code: 'AUTH_REQUIRED', messageKey: auth.reasonKey, message: null });
    }

    const url = buildPsbStreamUrl(sessionId, subscriberId);
    const agent = await deps.createHttpAgent(url);
    const socket = new Ctor(url, {
      headers: { authorization: `Bearer ${auth.token}` },
      ...(agent === undefined ? {} : { agent }),
    });
    socket.binaryType = 'nodebuffer';

    let handshakeSettled = false;
    let closedHandled = false;
    let streamErrorEmitted = false;
    /**
     * 本连接收到过的二进制帧数：4004 的两种含义靠它分界（PSB 中继的「慢订阅者」只会在
     * 已经收过帧之后出现；一帧都没有就说明从来没出过画面）。文本帧不计入。
     */
    let receivedBinaryFrames = 0;
    /** 超限帧只告警一次：一条坏流不该把 warn 变成刷屏。 */
    let oversizedFrameReported = false;

    try {
      await new Promise<void>((resolve, reject) => {
        /** 握手失败：停掉 socket 并让 `start` 以可翻译的失败拒绝（不推 error 事件，invoke 自己会报）。 */
        const failHandshake = (failure: PsbRemoteFailure): void => {
          if (handshakeSettled) return;
          handshakeSettled = true;
          intentionallyClosed.add(socket);
          try {
            socket.terminate?.();
          } catch {
            /* best-effort */
          }
          reject(psbStreamFailure(failure));
        };
        socket.on('open', () => {
          if (handshakeSettled) return;
          handshakeSettled = true;
          resolve();
        });
        socket.on('error', (error) => {
          deps.logger.warn('psb stream socket error', { sessionId, detail: error.message });
          if (handshakeSettled && !intentionallyClosed.has(socket)) {
            // 握手之后才出的错：invoke 早已返回，只能推 error 事件让面板显示可行动原因；
            // 同一连接只推一次（`ws` 之后还会发 close，届时再推 closed）。
            if (!streamErrorEmitted) {
              streamErrorEmitted = true;
              deps.emit({
                type: 'error',
                sessionId,
                failure: {
                  code: 'PSB_STREAM_UNREACHABLE',
                  messageKey: 'remoteWorkspace.error.unreachable',
                  message: error.message,
                },
              });
            }
            return;
          }
          failHandshake({
            code: 'PSB_STREAM_UNREACHABLE',
            messageKey: 'remoteWorkspace.error.unreachable',
            message: error.message,
          });
        });
        socket.on('unexpected-response', (_request, response) => {
          void resolveUpgradeFailure(response).then(failHandshake, (error: unknown) => {
            failHandshake({
              code: 'PSB_STREAM_UNREACHABLE',
              messageKey: 'remoteWorkspace.error.unreachable',
              message: error instanceof Error ? error.message : String(error),
            });
          });
        });
        socket.on('close', (code, reason) => {
          if (!handshakeSettled) {
            failHandshake(classifyStreamHandshakeClose(code, reason.toString('utf8')));
            return;
          }
          if (closedHandled) return;
          closedHandled = true;
          if (active.get(sessionId) === socket) forget(sessionId);
          // 本端主动断开（重启替换 / 用户停止 / dispose）不推事件：那不是"会话流断了"。
          if (intentionallyClosed.has(socket)) return;
          const classification = classifyStreamClose({
            code,
            reason: reason.toString('utf8'),
            receivedBinaryFrames,
          });
          deps.emit({
            type: 'closed',
            sessionId,
            reason: classification.reason,
            detail: classification.detail,
          });
        });
        socket.on('message', (data, isBinary) => {
          if (isBinary === false) {
            handleTextMessage(sessionId, socket, data);
            return;
          }
          const buffer = toBuffer(data);
          if (buffer.byteLength === 0) return;
          // 收到过帧是 4004 归因的证据：超限帧也来自这条流，仍计入（不然「坏帧流」会被
          // 归因成「从没出过画面」）。
          receivedBinaryFrames += 1;
          if (buffer.byteLength > PSB_STREAM_MAX_BINARY_FRAME_BYTES) {
            if (!oversizedFrameReported) {
              oversizedFrameReported = true;
              deps.logger.warn('psb stream dropped an oversized binary frame', {
                sessionId,
                bytes: buffer.byteLength,
                limit: PSB_STREAM_MAX_BINARY_FRAME_BYTES,
              });
            }
            return;
          }
          deps.emit({ type: 'frame', sessionId, payload: toArrayBuffer(buffer) });
        });
      });
    } catch (error) {
      closeSocket(socket);
      throw error;
    }

    if (disposed || generations.get(sessionId) !== myGeneration) {
      // 握手期间被 stop/dispose 取代（或服务已销毁）：关掉自己，别留下没人认领的连接。
      closeSocket(socket);
      return statusById.get(sessionId) ?? { ...status, active: false };
    }

    // 升级完成即已订阅（PSB 侧语义：连上 = 订阅，断开 = 退订）。**不发 `{kind:'open'}`**：
    // PSB 会把这两个控制 kind 计入非法消息（见文件头「上行只有一种消息」）。
    active.set(sessionId, socket);
    // `active` 属于 PSB 的语义（「此刻有没有可看的画面」，见工程契约 §7）：本端**订阅成功**
    // 不等于有画面，不能把它改写成 true，否则面板会在没有任何一帧时显示「串流中」。
    // 「已订阅」由渲染层自己记（streamStart 成功即已订阅），首帧到达时再把画面切到 live。
    emitStatus(sessionId, status);
    return statusById.get(sessionId) ?? status;
  }

  /**
   * WS 文本消息：只认 `{kind:'status', status:{…}}`（PSB 推送采集状态）与
   * `{type:'stream.cursor', …}`（宿主光标形状，2026-11-26）。
   * 其它文本一律忽略并记 debug —— 渲染层要的是帧与状态，未知消息不该让面板崩。
   *
   * **文本路径与二进制路径完全隔离**：这里绝不 emit `{type:'frame'}`，也不递增
   * `receivedBinaryFrames`（后者参与 4004 归因，把文本帧算进去会让「从没出过画面」被误判成
   * 「慢订阅者」）。
   */
  function handleTextMessage(sessionId: string, socket: PsbStreamSocket, data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toBuffer(data).toString('utf8'));
    } catch {
      deps.logger.debug('psb stream ignored a non-JSON text message', { sessionId });
      return;
    }
    if (active.get(sessionId) !== socket) return;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;
    if (record['type'] === PSB_STREAM_CURSOR_TEXT_FRAME_TYPE) {
      handleCursorTextFrame(sessionId, record);
      return;
    }
    if (record['kind'] !== 'status') {
      deps.logger.debug('psb stream ignored an unknown text message', { sessionId });
      return;
    }
    emitStatus(sessionId, parsePsbSessionStreamStatus(record['status']));
  }

  /**
   * `{type:'stream.cursor'}`：校验形状、去重连续重复后推给渲染层。
   *
   * 非法/超限只记 debug（形状语义是覆盖，丢一条无后果）；同一 serial 的**连续**重复下发不重复推
   * IPC（避免 PSB 异常重发时让渲染层反复改样式）。**不按 serial 丢弃形状**：WS 保序，而真机日志
   * 已证明 PSB 的序号并不严格单调，旧的「out-of-order 丢弃」会让新形状被吃掉（用户看到指针卡住）。
   */
  function handleCursorTextFrame(sessionId: string, record: Record<string, unknown>): void {
    const cursor = parsePsbStreamCursorTextFrame(record);
    if (!cursor) {
      deps.logger.debug('psb stream ignored an invalid cursor text message', { sessionId });
      return;
    }
    if (lastCursorSerial.get(sessionId) === cursor.serial) return;
    lastCursorSerial.set(sessionId, cursor.serial);
    deps.emit({ type: 'cursor', sessionId, cursor });
  }

  async function start(sessionId: string): Promise<PsbSessionStreamStatus> {
    const inFlight = starting.get(sessionId);
    if (inFlight) {
      // 同一会话的并发 start：等前一次落定再按「先停旧连接」重开，避免两条连接并存。
      try {
        await inFlight;
      } catch {
        /* 前一次失败不影响这一次 */
      }
    }
    const task = startInternal(sessionId);
    starting.set(sessionId, task);
    try {
      return await task;
    } finally {
      if (starting.get(sessionId) === task) starting.delete(sessionId);
    }
  }

  return {
    start,
    async stop(sessionId) {
      bumpGeneration(sessionId);
      lastCursorSerial.delete(sessionId);
      const socket = active.get(sessionId);
      forget(sessionId);
      if (!socket) return;
      closeSocket(socket);
    },
    async sendInput(sessionId, event) {
      const socket = active.get(sessionId);
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw psbStreamFailure({
          code: 'PSB_STREAM_NOT_ACTIVE',
          messageKey: 'remoteWorkspace.session.streamIdle',
          message: null,
        });
      }
      socket.send(JSON.stringify({ kind: 'input', event }));
    },
    dispose() {
      disposed = true;
      for (const [sessionId, socket] of active) {
        bumpGeneration(sessionId);
        closeSocket(socket);
        forget(sessionId);
      }
      active.clear();
      statusById.clear();
      lastCursorSerial.clear();
    },
  };
}

/** 抛与 HTTP 客户端同型的失败：IPC 层用同一个 `toPsbRemoteFailure` 映射，不另造错误分类。 */
function psbStreamFailure(failure: PsbRemoteFailure): PsbClientError {
  return new PsbClientError(failure, null);
}

async function resolveUpgradeFailure(
  response: PsbStreamUpgradeResponse,
): Promise<PsbRemoteFailure> {
  const fallback = classifyStreamHandshakeStatus(response.statusCode);
  const text = await readUpgradeBody(response);
  if (!text) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return fallback;
  const record = error as Record<string, unknown>;
  const code = typeof record['code'] === 'string' ? record['code'] : null;
  const message = typeof record['message'] === 'string' ? record['message'] : null;
  return {
    code: code ?? fallback.code,
    messageKey: code ? psbMessageKeyForErrorCode(code) : fallback.messageKey,
    message: message ?? fallback.message,
  };
}

/** 读握手失败体：上限 + 超时双保险，读不到就用状态码归因（不悬住 start）。 */
function readUpgradeBody(response: PsbStreamUpgradeResponse): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    let settled = false;
    const timer = setTimeout(finish, UPGRADE_BODY_TIMEOUT_MS);
    timer.unref?.();
    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(text);
    }
    response.on('data', (chunk) => {
      if (settled) return;
      const buffer = toBuffer(chunk as RawData);
      const remaining = UPGRADE_BODY_LIMIT_BYTES - text.length;
      if (buffer.byteLength >= remaining) {
        text += buffer.subarray(0, remaining).toString('utf8');
        finish();
        return;
      }
      text += buffer.toString('utf8');
    });
    response.on('end', finish);
    response.on('error', finish);
    response.resume();
  });
}

function toArrayBuffer(data: RawData): ArrayBuffer {
  const buffer = toBuffer(data);
  // 拷贝而不是复用 Buffer 的底层池：跨 IPC 传递的 ArrayBuffer 不能被后续帧覆写。
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data.map(toBuffer));
  return Buffer.from(data as ArrayBuffer);
}
