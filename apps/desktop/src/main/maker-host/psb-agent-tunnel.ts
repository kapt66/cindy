/**
 * `psb:<sessionId>` 会话到 PSB `agent-tunnel` 的生产接线 —— 三种 Harness 共用的**唯一**取 token 处。
 *
 * ## 为什么需要这一层
 *
 * 数据面(URL / 帧契约 / 关闭码归因)在 `main/remote-workspace/psbTunnel.ts`,它刻意不自己解析
 * 身份:PSB 的令牌是宿主的 **Cindy Connection JWT**(`Authorization: Bearer …`),签发链是
 * 「登录身份 → `<orgSlug>:meka-submit` audience → 云端 `/api/auth/connections/token`」,
 * 见 `main/remote-workspace/psbAuth.ts`。maker-host 的远端钩子只关心"给我一条字节流",
 * 不该各自知道 audience 与登录态,所以取 token 的依赖只在这里注入一次。
 *
 * ## 与 `mcpr:` 的差别：鉴权互换，上层接缝不变
 *
 * MCPRouter 用 cookie session(隧道 opener 内部自己取),PSB 用 Bearer。**帧契约、mode 语义、
 * bundleVersion 声明完全一致**,因此上层三个 Harness 客户端的**字节协议实现**都直接复用
 * (`cc-manager-client` / `codex-remote-transport` / `pi-mcpr-remote`),这里只换
 * `openStream` / `openTunnel` 注入点(见 `maker-host/remote-tunnel-dispatch.ts`)。
 *
 * **`psb:` 的 cwd / 工作目录归属是宿主**（PSB 按服务端会话记录的工作区 spawn 引擎），这条与
 * `mcpr:` / SSH 不同，不由隧道层处理，而是各 Harness 在宿主注入点按 `remoteHostOwnsCwd` 消费：
 * cc 的 `query/start` 传 `'.'`、pi 的 `pi/ensure` 不写 `cd`、codex 不下发 `cwd` /
 * `runtimeWorkspaceRoots` / 本机目录（见 `docs/dev-rules/psb-remote-session-transport.md` §2）。
 * 所以「只换注入点」指的是字节通道，不代表这三个客户端在 cwd 语义上零改动。
 *
 * ## 已知缺口(交付说明里登记)
 *
 * 隧道与 HTTP 走**同一份**系统代理语义:HTTP 用 `outboundFetch`、隧道用
 * `createOutboundHttpAgent(url)` 经 `agentForUrl` 注入(`PsbTunnelDeps` 已支持按 URL 异步取
 * agent)。`ws` 本身不读系统代理,所以这里必须显式给,否则会出现"列表能拉到、隧道连不上"。
 *
 * 仍存在的缺口:`ws` 直连时不经 undici,重定向链路的代理语义依赖上层 resolver;需要认证的
 * 系统代理仍不支持(与 main 其它出网一致,收到 407 会明确失败)。
 */

import type { ExecStreamHandle } from '@cindy/maker-remote-ssh';

import type { PsbTunnelMode } from '../../shared/psb-remote-workspace.js';
import { getAuthState } from '../authManager.js';
import { getConnectionTokenProvider } from '../cindy-brain/index.js';
import { createOutboundHttpAgent } from './outbound-fetch.desktop.js';
import {
  getPsbConnectionToken,
  invalidatePsbConnectionToken,
} from '../remote-workspace/psbAuth.js';
import { openPsbTunnel } from '../remote-workspace/psbTunnel.js';

/**
 * 取一次 PSB Connection JWT。
 *
 * 失败时只把**原因键**交给隧道层(它自己抛 `[PSB_AUTH_REQUIRED]`),不把登录态细节带进
 * maker-host 的错误串 —— 与 `psbClient` 的凭据纪律一致:token 只留在 main 内存。
 */
async function getPsbTunnelToken(): Promise<
  { ok: true; token: string } | { ok: false; reasonKey: string }
> {
  const resolved = await getPsbConnectionToken({
    getAuthState,
    tokens: getConnectionTokenProvider(),
  });
  return resolved.ok
    ? { ok: true, token: resolved.token }
    : { ok: false, reasonKey: resolved.reasonKey };
}

/**
 * 打开一条 `psb:` 会话的 agent-tunnel(`mode` 语义与 MCPRouter 逐字相同)。
 *
 * 鉴权被拒时失效内存里的 Connection JWT 缓存,让**下一次**调用重新签发一次(与 `psbClient`
 * 的「401 只重签一次」同一纪律)。不在这里自动重试:隧道是长连接,静默重连会把
 * 「工作区被占用 / 会话已终态」这类必须让用户看到的状态藏起来。
 */
export async function openPsbAgentTunnel(
  remoteHostId: string,
  mode: PsbTunnelMode,
): Promise<ExecStreamHandle> {
  try {
    return await openPsbTunnel(remoteHostId, {
      mode,
      getToken: getPsbTunnelToken,
      agentForUrl: (url) => createOutboundHttpAgent(url),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[PSB_TUNNEL_AUTH]')) {
      invalidatePsbConnectionToken({
        getAuthState,
        tokens: getConnectionTokenProvider(),
      });
    }
    throw error;
  }
}
