/**
 * 远端 transport → `agent-tunnel` 字节流的**唯一分派点**。
 *
 * 三种 Harness 的客户端实现只依赖「一条字节流 + mode 选择」,隧道属于哪种 transport 对它们
 * 不可见。因此每个远端钩子只做两件事:
 *
 *   1. `isTunnelRemoteSessionTransport(remoteHostId)` —— 是不是隧道 transport(`psb:` / `mcpr:`)
 *      而不是 SSH pool;
 *   2. 需要字节流时调本模块,而不是自己认前缀。
 *
 * 这样新增一种隧道 transport(例如将来的其它账号隧道)只需要在能力表
 * (`remote-session-routing.ts`)与这里的 case 加一条:钩子、三种 Harness 的客户端实现、
 * `remoteTransportRegistry` 都不变。分派判据与 SSH-only 分类器是**同一个纯函数**
 * (`remote-session-routing.ts`),不存在第二套 `startsWith` 判断
 * (见 `docs/dev-rules/psb-remote-session-transport.md` §7.2)。
 */

import type { ExecStreamHandle } from '@cindy/maker-remote-ssh';

import type { PsbTunnelMode } from '../../shared/psb-remote-workspace.js';
import { openMcprTunnel } from './mcpr-tunnel.js';
import { openPsbAgentTunnel } from './psb-agent-tunnel.js';
import {
  classifyRemoteSessionTransport,
  resolveRemoteTransportCapabilities,
  type RemoteAgentKind,
} from './remote-session-routing.js';

/**
 * 隧道的用途，与 MCPRouter `agent-tunnel` 的 `mode` 逐字相同（PSB 是同一份帧契约）：
 * `cc-mgr`（Claude cc-mgr 控制通道）/ `codex-appserver`（Codex app-server NDJSON）/
 * `pi`（pi-manager 两阶段 RPC → 同连接 JSONL）/ `exec`（单连接单次执行，file ops 与探针）。
 *
 * **复用共享契约里的类型，不在本模块再写一份字面量联合**：新增 mode / 改 mode 语义时，共享
 * 契约（`shared/psb-remote-workspace.ts` 的 `PSB_TUNNEL_MODES` 与 `PsbTunnelMode`）是唯一来源，
 * 这里跟着变，避免两处漂移出一个「本模块认为合法、服务端拒绝」的 mode。
 */
export type RemoteTunnelMode = PsbTunnelMode;

/** `pi-mcpr-remote.ts` 的 `openTunnel` 注入点与本模块同形（测试也用它注入假隧道）。 */
export type RemoteTunnelOpener = (
  remoteHostId: string,
  mode: RemoteTunnelMode,
) => Promise<ExecStreamHandle>;

/**
 * 这个 transport 上某引擎的数据面 mode（`null` = 这个 transport 不走隧道）。
 *
 * 唯一映射表在能力描述符里（→ 共享契约的 `psbTunnelModeForAgent`）；调用点不要自己
 * 按引擎拼 mode 字面量，否则「表里改了、钩子里没改」不会报错。
 */
export function remoteTunnelModeForAgent(
  remoteHostId: string | null | undefined,
  agentKind: RemoteAgentKind,
): RemoteTunnelMode | null {
  return resolveRemoteTransportCapabilities(remoteHostId).tunnelModeByAgent?.[agentKind] ?? null;
}

/**
 * 打开一条远端隧道字节流。非隧道 transport（本地 / SSH）是**编程错误**，不回落 SSH：
 * 回落会把「这里不该有隧道」变成一个更难诊断的 SSH 错误，并且顺手把 SSH-only 前置
 * 引入一条本不该有的路径。
 */
export async function openRemoteTunnel(
  remoteHostId: string,
  mode: RemoteTunnelMode,
): Promise<ExecStreamHandle> {
  switch (classifyRemoteSessionTransport(remoteHostId)) {
    case 'mcpr':
      return openMcprTunnel(remoteHostId, { mode });
    case 'psb':
      return openPsbAgentTunnel(remoteHostId, mode);
    default:
      throw new Error(
        `[REMOTE_TUNNEL_INVALID] ${JSON.stringify(remoteHostId)} is not a tunnel transport (mode=${mode})`,
      );
  }
}
