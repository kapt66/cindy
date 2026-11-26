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

/** 把 PSB 路径（以 `/` 开头）拼成绝对 HTTPS 地址。 */
export function psbHttpUrl(pathname: string): string {
  const { origin } = resolvePsbEndpoint();
  return `${origin}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

/**
 * 把 PSB 路径拼成 WebSocket 地址。
 *
 * `wss:` 恒用（正式与联调都是 HTTPS 部署）。**不做 http 降级**：把一条带 Bearer 的隧道
 * 降级到明文会让 token 与会话内容出现在链路上，而失败原因会变成"连不上"，比直接报错更难查。
 */
export function psbWebSocketUrl(pathname: string): string {
  const { host } = resolvePsbEndpoint();
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `wss://${host}${path}`;
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
