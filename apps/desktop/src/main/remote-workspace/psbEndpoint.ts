/**
 * PSB 站点根解析 —— Cindy「远程工作区」的所有 PSB 调用都从这里取地址。
 *
 * ## 为什么复用 Meka 提交那条覆盖开关
 *
 * 正式部署是 `https://mekabot.meka.pawdy.fun`，联调部署是 `https://mekabot-test.meka.pawdy.fun`。
 * Meka 提交插件早就需要"同一份产物打两个部署"，宿主为此做了 **启动期环境变量覆盖**
 * （`CINDY_MEKA_PSB_HOST`，见 `mekaPsbHostOverride.ts`）：白名单只认测试主机，未设置时逐字节不变。
 *
 * 远程工作区**复用同一份解析**而不是新开一个开关，理由是用户可见的事实只有一个：
 * "这台 Cindy 连的是哪个 PSB"。两个开关会让插件打到正式、远程工作区打到测试，而界面上没有任何东西
 * 能解释这种分裂；也会让运维多做一次配置核对，漏配时表现为"插件能用、远程工作区 401"。
 *
 * ## 不变式
 *
 * 1. 本模块只回答**地址**，不回答凭证、不发起请求；
 * 2. 解析结果在进程生命周期内**只解析一次**（环境变量是启动期配置，改了要重启——与既有口径一致）；
 * 3. 未设置 / 被白名单拒绝时，`origin` 恒为正式部署 —— 不存在第三种落到"未知地址"的分支。
 */

import {
  MEKA_PSB_HOST,
  MEKA_PSB_TEST_HOST,
  readMekaPsbHostOverride,
} from '../cindy-brain/mekaPsbHostOverride.js';
import { PSB_CINDY_API_PREFIX } from '../../shared/psb-remote-workspace.js';

/** 正式 PSB 部署（生产）。 */
export const PSB_FORMAL_HOST = MEKA_PSB_HOST;

/** 唯一的联调部署（白名单）。 */
export const PSB_TEST_HOST = MEKA_PSB_TEST_HOST;

export interface PsbEndpoint {
  /** 纯主机名（不带协议），用于展示与日志。 */
  readonly host: string;
  /** `https://<host>`，不带尾斜杠。 */
  readonly origin: string;
  /** 是否被 `CINDY_MEKA_PSB_HOST` 覆盖到联调部署。 */
  readonly testHost: boolean;
}

let cachedEndpoint: PsbEndpoint | null = null;

/** 解析当前生效的 PSB 站点。首次调用后缓存（启动期配置）。 */
export function resolvePsbEndpoint(): PsbEndpoint {
  if (cachedEndpoint) return cachedEndpoint;
  const { host } = readMekaPsbHostOverride();
  const effectiveHost = host ?? PSB_FORMAL_HOST;
  cachedEndpoint = {
    host: effectiveHost,
    origin: `https://${effectiveHost}`,
    testHost: host === PSB_TEST_HOST,
  };
  return cachedEndpoint;
}

/** 单测用：清掉缓存，让下一次解析重新读环境变量。 */
export function resetPsbEndpointCacheForTest(): void {
  cachedEndpoint = null;
}

/**
 * 一个 PSB 路径被拒绝（不是网络失败，也不是 PSB 业务失败）：调用方按协议违约归因。
 *
 * 单独的类型让「路径越界」与「请求失败」在日志/单测里可区分：前者永远不应发生在
 * 内部拼接的路径上（发生了说明有代码在拿外部输入拼 URL）。
 */
export class PsbUrlRejectedError extends Error {
  constructor(
    readonly reason:
      | 'empty'
      | 'too-long'
      | 'unsafe-characters'
      | 'not-absolute-path'
      | 'origin-mismatch'
      | 'path-normalized'
      | 'encoded-separator'
      | 'duplicate-slash'
      | 'not-cindy-namespace',
    readonly path: string,
  ) {
    super(`PSB path rejected (${reason}): ${path.slice(0, 120)}`);
    this.name = 'PsbUrlRejectedError';
  }
}

/** PSB 路径的长度上限（Cindy 入口全是短路径；超长只可能是注入/畸形载荷）。 */
const PSB_PATH_MAX_LENGTH = 2_048;

/** Cindy 命名空间前缀（含尾斜杠）：只允许 `/api/cindy/remote/…`。 */
const PSB_CINDY_PATH_PREFIX = `${PSB_CINDY_API_PREFIX}/`;

/**
 * 把 PSB 路径解析成**确定的**绝对 HTTPS 地址；越界一律抛 {@link PsbUrlRejectedError}。
 *
 * ## 为什么不能只查字面 `..`
 *
 * URL 归一化会把 `%2e%2e`（以及 `%2E%2E`）当作 `..` 段处理：旧实现只拒绝字面 `..`，于是
 * `'/api/cindy/remote/workspaces/x/%2e%2e/%2e%2e/%2e%2e/evil'` 能通过白名单，而 `fetch`
 * 把它归一化到 Cindy 命名空间**之外**——一条带 Bearer 的请求就被打到别的路由上。服务端下发的
 * `actions[].path` 是外部输入，必须按「归一化后的结果」判定，而不是按原始字符串。
 *
 * ## 三条硬判据（缺一不可）
 *
 * 1. `new URL(path, origin)` 的 **origin 与当前 PSB 站点相同**（挡绝对 URL / `//host`）；
 * 2. **归一化后的 pathname 与原始 pathname 逐字节相同**（挡 `..` / `%2e%2e` / 反斜杠 /
 *    任何 URL 解析器会改写的形态）；
 * 3. pathname 以 `/api/cindy/remote/` 开头（挡跨命名空间）。
 *
 * 另外拒绝：空串、超长、空白/控制字符、反斜杠、`#` 片段、非绝对路径（必须以 `/` 开头）、
 * **编码的路径分隔符 / 点段**（`%2e` / `%2f` / `%5c`）与**连续 `//`**。
 * 方法 / body 的语义校验不在这里（那是各调用点自己的白名单）。
 *
 * ## 为什么还要单独拒绝「编码分隔符」与 `//`（2026-11-27 复审 P2）
 *
 * 判据 2 只挡得住**URL 解析器自己会改写**的形态。实测：
 *
 * - `%2e%2e%2f`：在 URL 解析里是**一个普通段**（不是 `..` 段，所以 pathname 不变、判据 2 放行），
 *   但服务端 / 反向代理解码后就是 `../` —— 一条带 Bearer 的请求被送到 Cindy 命名空间之外；
 * - `//`：URL 解析保留空段（pathname 同样不变），部分网关会折叠空段，路径语义随之漂移。
 *
 * PSB 下发的 `actions[].path` 都是固定路由 + id，**没有任何编码分隔符的正当用途**，所以直接在
 * 原始 path 上拒绝，而不是赌下游怎么解码。
 */
export function resolvePsbUrl(pathname: string): string {
  return resolvePsbPathUrl(pathname).toString();
}

/** 内部：解析成 `URL`（HTTP 与 WS 共用一个校验器，避免两条拼法各漏一道）。 */
function resolvePsbPathUrl(pathname: string): URL {
  const { origin } = resolvePsbEndpoint();
  if (typeof pathname !== 'string' || pathname.length === 0) {
    throw new PsbUrlRejectedError('empty', String(pathname));
  }
  if (pathname.length > PSB_PATH_MAX_LENGTH) {
    throw new PsbUrlRejectedError('too-long', pathname);
  }
  // 空白 / 控制字符 / 反斜杠 / 片段：合法 PSB 路径里都不该出现（注入与拼接错误的常见形态）。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s\\#]/.test(pathname)) {
    throw new PsbUrlRejectedError('unsafe-characters', pathname);
  }
  if (!pathname.startsWith('/')) {
    throw new PsbUrlRejectedError('not-absolute-path', pathname);
  }
  const queryAt = pathname.indexOf('?');
  const rawPath = queryAt >= 0 ? pathname.slice(0, queryAt) : pathname;
  const rawQuery = queryAt >= 0 ? pathname.slice(queryAt) : '';
  let resolved: URL;
  try {
    resolved = new URL(`${rawPath}${rawQuery}`, origin);
  } catch {
    throw new PsbUrlRejectedError('unsafe-characters', pathname);
  }
  if (resolved.origin !== origin) {
    throw new PsbUrlRejectedError('origin-mismatch', pathname);
  }
  // 归一化必须是无操作：这同时覆盖 `..` / `%2e%2e`（纯点段）等所有 URL 会改写的形态。
  if (resolved.pathname !== rawPath) {
    throw new PsbUrlRejectedError('path-normalized', pathname);
  }
  // 归一化**看不出来**的歧义形态（见文件头「为什么还要单独拒绝」）：编码的点段 / 分隔符在 URL
  // 解析里是普通字符，但落地端解码后语义会变；连续 `//` 依赖下游是否折叠空段。只检查 path，
  // query 里的百分号编码是正常用法（例如过滤参数）。
  if (/%(?:2e|2f|5c)/i.test(rawPath)) {
    throw new PsbUrlRejectedError('encoded-separator', pathname);
  }
  if (/\/\//.test(rawPath)) {
    throw new PsbUrlRejectedError('duplicate-slash', pathname);
  }
  if (!resolved.pathname.startsWith(PSB_CINDY_PATH_PREFIX)) {
    throw new PsbUrlRejectedError('not-cindy-namespace', pathname);
  }
  return resolved;
}

/**
 * 把一个 PSB 路径（以 `/` 开头）拼成绝对 HTTPS 地址。
 *
 * 只保留为内部便捷入口；**所有发请求的路径都必须经过 {@link resolvePsbUrl} 的同一套判据**
 * （本函数就是它），不允许别处再用字符串拼接。
 */
export function psbHttpUrl(pathname: string): string {
  return resolvePsbUrl(pathname);
}

/**
 * 会话 id 里不允许出现的字符（协议违约：PSB 的会话 id 是 UUID / 短标识）。
 *
 * 这些字符会被 `encodeURIComponent` 编进路径（`/` → `%2F`、`\` → `%5C`、`%` → `%25`、空格 →
 * `%20`），而我们刚刚（2026-11-27 复审 P2）**拒绝**了路径里的编码分隔符 —— 与其让 URL 构造在
 * 更下游抛一个看不出原因的 `PsbUrlRejectedError`，不如在拼 URL 之前明确拒绝这个 id。
 * 真实 PSB 会话 id 不含这些字符；包含它们只可能是上游注入 / 拼接错误。
 */
const PSB_IDENTIFIER_UNSAFE = /[/\\%?#\s\u0000-\u001f\u007f]/;

/** PSB 标识符（会话 id 等）的长度上限：UUID / 短 id 远小于它，超长只可能是畸形输入。 */
const PSB_IDENTIFIER_MAX_LENGTH = 256;

/**
 * 校验一个会被拼进 PSB 路径的标识符（会话 id）；不合法抛 {@link PsbUrlRejectedError}。
 *
 * 放在这里而不是各 URL 构造函数里：HTTP 路径、串流 WS、agent-tunnel WS 三处共用一个判据，
 * 避免「某一处忘了校验 → 编码分隔符绕过命名空间判断」。
 */
export function assertPsbIdentifier(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PSB_IDENTIFIER_MAX_LENGTH ||
    PSB_IDENTIFIER_UNSAFE.test(value)
  ) {
    throw new PsbUrlRejectedError('unsafe-characters', typeof value === 'string' ? value : String(value));
  }
}

/**
 * 把 PSB 路径拼成 WebSocket 地址。
 *
 * `wss:` 恒用（正式与联调都是 HTTPS 部署）。**不做 http 降级**：把一条带 Bearer 的隧道
 * 降级到明文会让 token 与会话内容出现在链路上，而失败原因会变成"连不上"，比直接报错更难查。
 */
export function psbWebSocketUrl(pathname: string): string {
  // 与 HTTP 出网共用同一份路径校验（origin / 归一化 / 命名空间），只把 scheme 换成 `wss:`。
  // **不做 http 降级**：把一条带 Bearer 的隧道降级到明文会让 token 与会话内容出现在链路上，
  // 而失败原因会变成"连不上"，比直接报错更难查。
  const resolved = resolvePsbPathUrl(pathname);
  const { host } = resolvePsbEndpoint();
  return `wss://${host}${resolved.pathname}${resolved.search}`;
}

/**
 * 把一个 PSB 下发的 `webUrl` 收敛到当前生效的站点。
 *
 * PSB 会直接下发绝对地址（它不知道 Cindy 连的是哪个部署）；如果对联调部署下发的地址是正式域名，
 * 用户点开就会跳到生产。这里只替换 **协议 + 主机**，路径与查询原样保留——路径本身就是 PSB 的事实
 * （`/remote/workspaces/<id>`），不要在这里重写。
 */
export function normalizePsbWebUrl(webUrl: string | null | undefined): string | null {
  if (!webUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(webUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const { origin } = resolvePsbEndpoint();
  const base = new URL(origin);
  parsed.protocol = base.protocol;
  parsed.host = base.host;
  return parsed.toString();
}
