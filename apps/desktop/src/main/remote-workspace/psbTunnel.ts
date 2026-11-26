/**
 * PSB agent-tunnel —— 与 MCPRouter `agent-tunnel` **同一份帧契约**，只换地址与鉴权。
 *
 * ## 为什么是「同一份」
 *
 * Cindy 已经在用 MCPRouter 的隧道跑三种 Harness（`pi-mcpr-remote.ts` / `cc-manager-client.ts` /
 * `codex-remote-transport.ts`）；那些实现只依赖两件事：**一条字节流** 与 **`mode` 的选择**。
 * 远程工作区把 PSB 插在 Cindy 与客户端机器之间，但**协议一行没变**——所以这里只做：
 *
 *   - URL：`wss://<psb>/api/cindy/remote/sessions/<sessionId>/agent-tunnel?mode=…&bundleVersion=…`
 *   - 鉴权：`Authorization: Bearer <Cindy Connection JWT>`（不是 MCPRouter 的 `cookie: session=`）
 *   - 失败分类：把 PSB 的 HTTP 状态/关闭码收敛成**可归因**的结构化错误（`PsbTunnelError`：
 *     `code ∈ PSB_TUNNEL_FAILURE_CODES` + `detail` + 可选的 `PsbRemoteFailure`），上层
 *     （maker-host 的 lazy create / send 失败）才能给出"哪一边不对"的提示，而不是一句
 *     `LAZY_CREATE_FAILED`。
 *
 * ## 四条不变式
 *
 * 1. **`bundleVersion` 只在 cc-mgr / codex-appserver 上携带**（与 MCPR 同口径）：pi / exec 不消费
 *    cc-mgr 产物，声明版本只会让服务端白做一次物化。取值一律来自 `CC_MGR_BUNDLE_VERSION`，
 *    绝不在这里写第二份字面量。
 * 2. **连接是「一条隧道一次订阅」**：调用方拿到的 `ExecStreamHandle` 与 MCPR 那条逐方法同义
 *    （`write` / `end` / `kill` / `onStdoutBytes` / `onClose` / `onError`），因此
 *    `pi-mcpr-remote.ts` 里那套阶段切换逻辑可以原样接在这条流上。
 * 3. **失败不静默**：握手失败、鉴权被拒、会话终态、工作区被他人占用分别是不同的码——
 *    renderer 要用它们决定"重试 / 去占用 / 换客户端"，而不是一律"连接失败"。
 *    `message` 仍保持 `[CODE] detail` 的形状（既有调用方靠前缀判断），同时 `code` 是结构化事实。
 * 4. **就绪前的业务字节不能丢**：服务端在 `agent-tunnel.ready` 之后可能立即发首帧（cc-mgr 的
 *    hello、pi 的 RPC 输出）。旧实现从 `open` 到 ready 之间只监听控制帧，binary 帧直接丢弃；
 *    现在先挂接收、有界排队，句柄交给调用方后**在首个订阅者出现时按序回放**（见 `wsFrames.ts`）。
 *
 * ## ready 帧的能力探测（为什么不再固定等 5s）
 *
 * `readyFrame=1` 是 PSB 0.1.160+ 的 opt-in：老服务端不认这个参数、也就永远不发 ready 帧。
 * 旧实现对老服务端每条长连接都固定等满 5s（exec 1.2s），远程任务启动会累计多等十几秒。
 * 现在按**进程级能力探测**：第一次等到 ready → `supported`；第一次超时 → 判 `unsupported`
 * 并跳过后续等待（老服务端的兜底行为本来就是「收到就发，服务端有 1MiB 缓冲」）。
 * 探测结果在同一个 PSB 站点进程生命周期内复用；单测用
 * {@link resetPsbTunnelReadyFrameProbeForTest} 复位。
 */

import WebSocket from 'ws';

import type { ExecStreamHandle } from '@cindy/maker-remote-ssh';

import { CC_MGR_BUNDLE_VERSION } from '@cindy/maker-cc-manager';

import {
  parsePsbRemoteHostId,
  psbTunnelNeedsBundleVersion,
  type PsbRemoteFailure,
  type PsbTunnelFailureCode,
  type PsbTunnelMode,
} from '../../shared/psb-remote-workspace.js';
import type { PsbAuthFailureKind } from './psbAuth.js';
import { psbAuthFailure } from './psbAuth.js';
import { psbAgentTunnelPath } from './psbClient.js';
import { assertPsbIdentifier, psbWebSocketUrl } from './psbEndpoint.js';
import {
  EXEC_STREAM_BUFFERED_BYTES,
  createExecByteStream,
  toBuffer,
  type PsbWebSocketLike,
} from './wsFrames.js';

/** Upgrade 被拒时读 body 的上限与兜底超时（只为拿到 PSB 的那句原因，不做重试）。 */
const PSB_TUNNEL_UPGRADE_BODY_LIMIT = 2048;
const PSB_TUNNEL_UPGRADE_BODY_TIMEOUT_MS = 2000;

/**
 * 就绪帧（PSB 0.1.159+）：Upgrade 成功后、业务字节之前的一条**文本帧**。
 *
 * PSB 的说明（协作需求 §14.1）：收到它再发首帧；`mode`/`sessionId`/`waitMs` 只作诊断。
 */
const PSB_TUNNEL_READY_TYPE = 'agent-tunnel.ready';
/** 长连接会话（cc-mgr / codex-appserver / pi）给足客户端出站隧道建立的时间。 */
const PSB_TUNNEL_READY_TIMEOUT_MS = 5000;
/** 一次性 exec（文件操作/探针）要快：等不到就按老行为直接发。 */
const PSB_TUNNEL_READY_TIMEOUT_EXEC_MS = 1200;

/** 就绪能力探测状态（进程级；见文件头「ready 帧的能力探测」）。 */
export type PsbReadyFrameCapability = 'unknown' | 'supported' | 'unsupported';

let readyFrameCapability: PsbReadyFrameCapability = 'unknown';

/** 单测：复位能力探测（生产只在进程启动时为 `unknown`）。 */
export function resetPsbTunnelReadyFrameProbeForTest(): void {
  readyFrameCapability = 'unknown';
}

/** 单测 / 诊断：读当前探测结果。 */
export function readPsbTunnelReadyFrameCapability(): PsbReadyFrameCapability {
  return readyFrameCapability;
}

/**
 * 隧道失败（结构化；`message` 仍是 `[CODE] detail`，兼容既有按前缀判断的调用方）。
 *
 * `failure` 是给上层做 IPC / 文案映射用的统一失败形状（`code` + `messageKey`）：
 * 隧道错误最终会进入用户可见的回合错误，码与文案键必须与 HTTP 侧同表。
 */
export class PsbTunnelError extends Error {
  constructor(
    readonly code: PsbTunnelFailureCode,
    readonly detail: string,
    readonly failure: PsbRemoteFailure | null = null,
  ) {
    super(detail.length > 0 ? `[${code}] ${detail}` : `[${code}]`);
    this.name = 'PsbTunnelError';
  }
}

/** 把 PSB 的拒绝原因附在分类错误后面（单行、截断；没有 body 就返回原错误）。 */
function withUpgradeDetail(error: PsbTunnelError, body: string): PsbTunnelError {
  const detail = body.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!detail) return error;
  return new PsbTunnelError(error.code, `${error.detail}: ${detail}`, error.failure);
}

/** 4004 的排队期原因（纯 JSON，PSB 0.1.159+）：`{reasonCode, cause, waitMs, bufferedBytes, limitBytes}`。 */
interface PsbTunnelNotReadyReason {
  reasonCode?: unknown;
  cause?: unknown;
  waitMs?: unknown;
  bufferedBytes?: unknown;
  limitBytes?: unknown;
}

function parseNotReadyReason(reason: Buffer): PsbTunnelNotReadyReason | null {
  if (reason.length === 0) return null;
  const text = reason.toString('utf8').trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as PsbTunnelNotReadyReason;
  } catch {
    return null;
  }
}

type WebSocketConstructor = new (
  url: string,
  options: {
    headers: Record<string, string>;
    agent?: unknown;
  },
) => PsbTunnelSocket;

/** `ws` 非 101 响应体（Node `http.IncomingMessage` 的最小面）。 */
interface PsbTunnelUpgradeResponse {
  statusCode?: number;
  resume(): void;
  on(event: 'data', callback: (chunk: Buffer | string) => void): unknown;
  on(event: 'end', callback: () => void): unknown;
  on(event: 'error', callback: () => void): unknown;
}

/**
 * 隧道 socket 面：`PsbWebSocketLike`（与字节工具共用）+ `unexpected-response`。
 *
 * 后者是 `ws` 在 Upgrade 被拒时才发的事件，类型不在共用结构里（字节工具用不到它）。
 */
type PsbTunnelSocket = PsbWebSocketLike & {
  on(
    event: 'unexpected-response',
    callback: (_request: unknown, response: PsbTunnelUpgradeResponse) => void,
  ): unknown;
};

/**
 * 取 token 的结果（隧道自己的最小依赖面）。
 *
 * **`kind` 必填**是推荐的形状；旧装配只给 `reasonKey` 时按 reasonKey 归因
 * （`needOrg` / `needLogin` / 其余 = 签发通道失败），因此不会把「网络抖动」误报成「请重新登录」。
 */
export type PsbTunnelTokenResult =
  | { readonly ok: true; readonly token: string }
  | {
      readonly ok: false;
      readonly reasonKey: string;
      readonly detail?: string | null;
      readonly kind?: PsbAuthFailureKind;
    };

export interface PsbTunnelDeps {
  /** 取当前身份的 PSB Connection JWT（生产 = `getPsbConnectionToken(deps)` 的结果）。 */
  getToken?: () => Promise<PsbTunnelTokenResult>;
  WebSocketCtor?: WebSocketConstructor;
  /**
   * 按目标 URL 取 `ws` 的出站 agent（生产 = `createOutboundHttpAgent`，吃系统代理）。
   *
   * 为什么是按 URL 的回调而不是一个现成 agent：系统代理/ PAC 允许按目标选出口，而解析是
   * **异步**的。把 URL 交给调用方、允许返回 Promise，是为了让这条隧道与 main 里其它出网
   * （HTTP 走 `outboundFetch`、其它 WS 走 `createOutboundHttpAgent`）**同一份代理语义**，
   * 而不是"HTTP 走代理、隧道直连"这种一半一半的状态。
   */
  agentForUrl?: (url: string) => unknown | Promise<unknown>;
  /** 旧形状（同步无参工厂）：仅为兼容既有注入点保留，新代码用 `agentForUrl`。 */
  agent?: () => unknown;
  /**
   * 等 `agent-tunnel.ready` 的上限（毫秒）。生产不传：非 exec 5s、exec 1.2s。
   * 单测用它把「超时按老行为继续」压到几毫秒。
   */
  readyTimeoutMs?: number;
  /**
   * main 侧日志面（可选；生产 = `createLogger('psb-tunnel')`，单测不注入）。
   *
   * 目前只用于一条告警：就绪前到达的 binary 帧超过 {@link EXEC_STREAM_BUFFERED_BYTES} 被丢弃。
   * 静默丢业务字节会让「隧道连上了但首帧丢失」在现场无法归因（服务端出站缓冲也有 1MiB 上限，
   * 超限说明对端在握手期就灌数据了）；只 warn 一次，避免坏流把日志刷满。
   */
  logger?: {
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

/**
 * 拼 agent-tunnel URL。导出给单测钉住。
 *
 * **`mode` 必须显式写**：MCPR 那条约定的缺省值是 `cc-mgr`（不写 = 服务端默认），但 PSB 的
 * Cindy 入口把 `mode` 当**必填**：`parseTunnelMode(undefined)` → 400「mode 必须是 … 之一
 * （收到 空）」。2026-11-26 联调因此让 cc-mgr 控制通道与 codex-appserver 的 bootstrap 全挂，
 * 只有 `pi`/`exec`（本来就写 mode）能通——不要照抄 MCPR「缺省不写」的习惯。
 *
 * **`readyFrame=1` 必须显式写（PSB 0.1.160+，opt-in 默认不发）**：PSB 的就绪文本帧
 * `agent-tunnel.ready` 只有客户端在 URL 上声明后才下发，服务端日志里显示 `readyFrame=false`
 * 就是不声明。不声明时每条长连接隧道都会固定等满 5s 的就绪兜底，exec 隧道等 1.2s——
 * 远程任务启动 / 文件操作会累计多等十几到几十秒（2026-11-26 审查）。服务端只认字面量 `1`；
 * 超时兜底（老服务端不发 ready）仍保留在 `openPsbTunnel`，两者互不替代。
 */
export function buildPsbTunnelUrl(sessionId: string, mode: PsbTunnelMode): string {
  // 会话 id 会被编进路径：含 `/` `\` `%` 空白等字符时 `encodeURIComponent` 会产出 `%2F` / `%5C`
  // 这类编码分隔符，而路径校验（2026-11-27 复审 P2）拒绝它们 —— 那是协议违约的 id，不是要放行的
  // 合法形态，所以在拼 URL 前明确拒绝（真实 PSB 会话 id 是 UUID / 短标识）。
  assertPsbIdentifier(sessionId);
  const url = new URL(psbWebSocketUrl(psbAgentTunnelPath(sessionId)));
  const params = new URLSearchParams();
  params.set('mode', mode);
  if (psbTunnelNeedsBundleVersion(mode)) params.set('bundleVersion', CC_MGR_BUNDLE_VERSION);
  // PSB 0.1.160+：就绪帧是 opt-in，不写这一条服务端就不发（日志 `readyFrame=false`）。
  params.set('readyFrame', '1');
  url.search = params.toString();
  url.hash = '';
  return url.toString();
}

/**
 * 取 token 失败 → 可归因的隧道错误（HTTP 与隧道共用 `psbAuthFailure` 的映射）。
 *
 * 未登录 / 非企业组织 → `PSB_AUTH_REQUIRED`（带身份原因键）；签发通道失败 → 网络类码。
 * **这里不失效 token 缓存**：取不到 token 不等于缓存里那条坏了（失效只发生在 PSB 明确拒绝后）。
 */
function tokenFailureError(auth: PsbTunnelTokenResult | null): PsbTunnelError {
  const kind: PsbAuthFailureKind =
    auth?.ok === false
      ? (auth.kind ??
        (auth.reasonKey === 'remoteWorkspace.status.needOrg'
          ? 'need-org'
          : auth.reasonKey === 'remoteWorkspace.status.needLogin'
            ? 'signed-out'
            : 'unreachable'))
      : 'signed-out';
  const failure = psbAuthFailure({
    ok: false,
    kind,
    reasonKey: auth?.ok === false ? auth.reasonKey : 'remoteWorkspace.status.needLogin',
    detail: auth?.ok === false ? (auth.detail ?? null) : null,
  });
  const code: PsbTunnelFailureCode =
    TUNNEL_CODE_FOR_AUTH_FAILURE[failure.code] ?? 'PSB_TUNNEL_UNREACHABLE';
  return new PsbTunnelError(
    code,
    code === 'PSB_AUTH_REQUIRED'
      ? AUTH_REQUIRED_TUNNEL_DETAIL
      : (failure.message ?? 'the Cindy connection token could not be issued'),
    failure,
  );
}

/**
 * HTTP 侧鉴权失败码 → 隧道的可归因失败码（单表）。
 *
 * 取 token 失败只有两种结局：身份问题（未登录 / 非企业组织 → `AUTH_REQUIRED`）与签发通道
 * 不可达（网络类）。之前 `tokenFailureError` 在码与文案两处各 `=== 'AUTH_REQUIRED'` 判一次；
 * 改成查表后新增一种身份失败只改这里，不会出现「码改了、文案没改」的漂移（2026-11-27 复审
 * P2 单表整理）。
 */
const TUNNEL_CODE_FOR_AUTH_FAILURE: Readonly<
  Partial<Record<PsbRemoteFailure['code'], PsbTunnelFailureCode>>
> = {
  AUTH_REQUIRED: 'PSB_AUTH_REQUIRED',
  PSB_UNREACHABLE: 'PSB_TUNNEL_UNREACHABLE',
};

/** 身份缺失（未登录 / 非企业组织）时的隧道失败原文（与 HTTP 侧 `psbAuthFailure` 同口径）。 */
const AUTH_REQUIRED_TUNNEL_DETAIL = 'a Cindy connection token is required for the PSB tunnel';

/** 文本帧是否是 `agent-tunnel.ready`（JSON 优先；保留 `includes` 兜底以兼容历史形状）。 */
function isReadyTextFrame(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        return (parsed as Record<string, unknown>)['type'] === PSB_TUNNEL_READY_TYPE;
      }
    } catch {
      /* 落到 includes 兜底 */
    }
  }
  return trimmed.includes(PSB_TUNNEL_READY_TYPE);
}

/**
 * 打开一条 PSB agent-tunnel，返回与 MCPR 同形的字节流句柄。
 *
 * `remoteHostId` 必须是 `psb:<PSB sessionId>`（由 `parsePsbRemoteHostId` 校验）；
 * 传进去的是会话身份，不是工作区身份——隧道永远是"某个会话"的通道。
 */
export async function openPsbTunnel(
  remoteHostId: string,
  deps: PsbTunnelDeps & { mode?: PsbTunnelMode } = {},
): Promise<ExecStreamHandle> {
  const sessionId = parsePsbRemoteHostId(remoteHostId);
  if (!sessionId) {
    throw new PsbTunnelError(
      'PSB_SESSION_INVALID',
      `invalid PSB remote host id (expected psb:<sessionId>): ${remoteHostId}`,
    );
  }
  const mode = deps.mode ?? 'cc-mgr';
  const auth = deps.getToken ? await deps.getToken() : null;
  if (!auth || !auth.ok) throw tokenFailureError(auth);
  const Ctor = deps.WebSocketCtor ?? (WebSocket as unknown as WebSocketConstructor);
  const url = buildPsbTunnelUrl(sessionId, mode);
  const agent = deps.agentForUrl ? await deps.agentForUrl(url) : deps.agent?.();
  const socket = new Ctor(url, {
    headers: { authorization: `Bearer ${auth.token}` },
    ...(agent === undefined ? {} : { agent }),
  }) as PsbTunnelSocket;
  socket.binaryType = 'nodebuffer';

  return new Promise<ExecStreamHandle>((resolve, reject) => {
    let settled = false;
    let opened = false;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * 就绪前到达的 binary 帧（业务字节）：有界排队，句柄交给调用方后回放。
     * 旧实现直接丢弃，表现为「隧道连上了但首帧丢了」。
     */
    const pendingFrames: Buffer[] = [];
    let pendingBytes = 0;
    let droppedPreReadyFrames = 0;
    let warnedPreReadyOverflow = false;
    /**
     * 就绪前缓冲溢出（> {@link EXEC_STREAM_BUFFERED_BYTES}）的告警。
     *
     * 只 warn 一次：丢的是业务字节，必须留下证据（否则表现为「连上了但首帧丢了」）；但一条
     * 灌数据的连接会持续丢帧，逐帧 warn 会把 main 日志刷满。
     */
    const reportPreReadyDrop = (frames: number): void => {
      droppedPreReadyFrames += frames;
      if (warnedPreReadyOverflow) return;
      warnedPreReadyOverflow = true;
      deps.logger?.warn('psb tunnel dropped pre-ready frames beyond the buffer budget', {
        sessionId,
        mode,
        frames: droppedPreReadyFrames,
        limitBytes: EXEC_STREAM_BUFFERED_BYTES,
      });
    };
    const clearReadyTimer = (): void => {
      if (readyTimer !== null) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearReadyTimer();
      try {
        socket.terminate?.();
      } catch {
        /* best-effort：握手阶段失败时 socket 可能还没建立 */
      }
      reject(error);
    };
    /** 就绪（真实 ready 帧或超时兼容）后才把句柄交给调用方，避免在客户端隧道配对前发首帧。 */
    const proceed = (): void => {
      if (settled || !opened) return;
      settled = true;
      clearReadyTimer();
      resolve(
        createExecByteStream(socket, {
          classifyError: classifyPsbError,
          classifyClose: classifyPsbClose,
          closedErrorCodes: [4003, 4004],
          // 文本帧是控制面（`agent-tunnel.ready`），绝不能混进 JSONL/exec 输出。
          binaryOnly: true,
          initialFrames: pendingFrames,
          bufferUntilSubscribed: true,
          onBufferedOverflow: (dropped) => {
            reportPreReadyDrop(dropped.frames);
          },
        }),
      );
      // `initialFrames` 已按引用交给句柄：这里只清账，不要再把同一批帧 emit 两次。
      pendingFrames.length = 0;
      pendingBytes = 0;
    };
    socket.on('open', () => {
      if (settled || opened) return;
      opened = true;
      if (readyFrameCapability === 'unsupported') {
        // 老服务端从不发 ready 帧：探测已经判过，别让每条连接都白等。
        proceed();
        return;
      }
      const timeoutMs =
        mode === 'exec' ? PSB_TUNNEL_READY_TIMEOUT_EXEC_MS : PSB_TUNNEL_READY_TIMEOUT_MS;
      readyTimer = setTimeout(() => {
        if (readyFrameCapability === 'unknown') {
          // 一次探测：等不到就记「这个服务端不支持 ready 帧」，后续连接不再等待。
          readyFrameCapability = 'unsupported';
        }
        proceed();
      }, Math.max(0, deps.readyTimeoutMs ?? timeoutMs));
      readyTimer.unref?.();
    });
    // 文本帧 = 控制面；binary 帧 = 业务字节，就绪前先排队（见上）。
    socket.on('message', (data, isBinary) => {
      if (isBinary !== false) {
        if (settled) return; // 句柄已接管（它自己的监听器负责转发）
        const chunk = toBuffer(data);
        if (chunk.byteLength === 0) return;
        pendingFrames.push(chunk);
        pendingBytes += chunk.byteLength;
        let droppedNow = 0;
        while (pendingBytes > EXEC_STREAM_BUFFERED_BYTES && pendingFrames.length > 0) {
          const dropped = pendingFrames.shift();
          if (!dropped) break;
          pendingBytes -= dropped.byteLength;
          droppedNow += 1;
        }
        if (droppedNow > 0) reportPreReadyDrop(droppedNow);
        return;
      }
      const text = toBuffer(data).toString('utf8');
      if (isReadyTextFrame(text)) {
        if (readyFrameCapability !== 'supported') readyFrameCapability = 'supported';
        clearReadyTimer();
        proceed();
      }
    });
    socket.on('error', (error) => fail(classifyPsbError(error)));
    socket.on('unexpected-response', (_request, response) => {
      // Upgrade 被拒时 PSB 会带一句可行动的中文原因（例如「mode 必须是 cc-mgr / codex-appserver /
      // pi / exec 之一（收到 …）」）。只拿状态码会让用户和联调都看不到真正原因（400 只剩
      // `handshake failed (400)`），所以这里读一小段 body 附在错误后面；读不到就按状态码分类。
      const status = response.statusCode;
      let body = '';
      let responseSettled = false;
      const finish = (): void => {
        if (responseSettled) return;
        responseSettled = true;
        response.resume();
        fail(withUpgradeDetail(classifyPsbHandshakeStatus(status), body));
      };
      const timer = setTimeout(finish, PSB_TUNNEL_UPGRADE_BODY_TIMEOUT_MS);
      timer.unref?.();
      response.on('data', (chunk: Buffer | string) => {
        if (body.length < PSB_TUNNEL_UPGRADE_BODY_LIMIT) body += chunk.toString();
      });
      response.on('end', () => {
        clearTimeout(timer);
        finish();
      });
      response.on('error', () => {
        clearTimeout(timer);
        finish();
      });
    });
    socket.on('close', (code, reason) => fail(classifyPsbClose(code, reason)));
  });
}

/**
 * 握手阶段的 HTTP 状态 → 可归因错误。
 *
 * 这些码与 PSB 契约（协作需求 §PSB-RW-08）一一对应：401/403 是身份问题、404 是会话不可见、
 * 409 是"会话/工作区此刻不能开隧道"（离线、非就绪、被他人占用、终态）。归因错了用户就会去做
 * 无效动作（重新登录一次解决不了"工作区被占用"）。
 */
export function classifyPsbHandshakeStatus(statusCode: number | undefined): PsbTunnelError {
  switch (statusCode) {
    case 401:
    case 403:
      return new PsbTunnelError(
        'PSB_TUNNEL_AUTH',
        `authentication rejected (${statusCode})`,
        {
          code: 'AUTH_INVALID',
          messageKey: 'remoteWorkspace.error.auth',
          message: null,
        },
      );
    case 404:
      return new PsbTunnelError(
        'PSB_SESSION_NOT_FOUND',
        'session is not visible to this account',
        { code: 'NOT_FOUND', messageKey: 'remoteWorkspace.admin.staleMissingTitle', message: null },
      );
    case 409:
      return new PsbTunnelError(
        'PSB_SESSION_NOT_READY',
        'session or workspace is not ready for a tunnel',
        {
          code: 'PSB_STREAM_NOT_READY',
          messageKey: 'remoteWorkspace.error.unknown',
          message: null,
        },
      );
    case 429:
      return new PsbTunnelError('PSB_RATE_LIMITED', 'too many tunnel attempts', null);
    default:
      return new PsbTunnelError(
        'PSB_TUNNEL_UNREACHABLE',
        `handshake failed (${statusCode ?? 0})`,
      );
  }
}

/** 关闭码 → 可归因错误。约定见 PSB 协作需求 §4.4.1（与 MCPR 口径一致）。 */
export function classifyPsbClose(code: number, reason: Buffer): PsbTunnelError {
  if (code === 4003) {
    const detail = reason.length > 0 ? `: ${reason.toString('utf8')}` : '';
    return new PsbTunnelError('PSB_TUNNEL_AUTH', `authentication rejected${detail}`, {
      code: 'AUTH_INVALID',
      messageKey: 'remoteWorkspace.error.auth',
      message: null,
    });
  }
  if (code === 4004) {
    const parsed = parseNotReadyReason(reason);
    if (parsed !== null) {
      const cause = typeof parsed.cause === 'string' ? parsed.cause : '';
      // 终态 / 离线不是"重试能好"的：给独立码，调用方（与用户文案）才能区分处置方式。
      if (cause === 'SESSION_STOPPED') {
        return new PsbTunnelError('PSB_SESSION_STOPPED', 'session runtime stopped', {
          code: 'PSB_SESSION_STOPPED',
          messageKey: 'remoteWorkspace.session.streamIdle',
          message: null,
        });
      }
      if (cause === 'CLIENT_OFFLINE') {
        return new PsbTunnelError('PSB_CLIENT_OFFLINE', 'remote client is offline', {
          code: 'CLIENT_OFFLINE',
          messageKey: 'remoteWorkspace.error.clientOffline',
          message: null,
        });
      }
      const pieces = [
        cause || (typeof parsed.reasonCode === 'string' ? parsed.reasonCode : ''),
        typeof parsed.waitMs === 'number' ? `waitMs=${parsed.waitMs}` : '',
        typeof parsed.bufferedBytes === 'number' ? `buffered=${parsed.bufferedBytes}` : '',
        typeof parsed.limitBytes === 'number' ? `limit=${parsed.limitBytes}` : '',
      ].filter((piece) => piece !== '');
      return new PsbTunnelError(
        'PSB_SESSION_NOT_READY',
        `tunnel not ready${pieces.length > 0 ? `: ${pieces.join(' ')}` : ''}`,
        {
          code: 'PSB_STREAM_NOT_READY',
          messageKey: 'remoteWorkspace.error.unknown',
          message: null,
        },
      );
    }
    const detail = reason.length > 0 ? `: ${reason.toString('utf8')}` : '';
    return new PsbTunnelError(
      'PSB_SESSION_NOT_READY',
      `session runtime is not ready${detail}`,
      {
        code: 'PSB_STREAM_NOT_READY',
        messageKey: 'remoteWorkspace.error.unknown',
        message: null,
      },
    );
  }
  const detail = reason.length > 0 ? `: ${reason.toString('utf8')}` : '';
  return new PsbTunnelError('PSB_TUNNEL_UNREACHABLE', `tunnel closed (${code})${detail}`);
}

/** 网络层错误 → 隧道可归因错误（已带 `[PSB_*]` 的 passthrough 成结构化码）。 */
function classifyPsbError(error: Error): PsbTunnelError {
  if (error instanceof PsbTunnelError) return error;
  const match = /^\[(PSB_[A-Z_]+)\]\s?(.*)$/.exec(error.message);
  if (match) {
    const code = match[1] as PsbTunnelFailureCode;
    return new PsbTunnelError(code, match[2] ?? '');
  }
  return new PsbTunnelError('PSB_TUNNEL_UNREACHABLE', error.message);
}
