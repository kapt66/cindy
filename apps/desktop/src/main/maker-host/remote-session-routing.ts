/**
 * 远端会话的 transport 分类与**能力描述符** —— 整个 main 进程唯一的一套远端口径。
 *
 * ## 为什么这里既分类又给能力
 *
 * 同一个 `remoteHostId` 在 Cindy 里有三种完全不同的承载：SSH 主机、MCPRouter 账号隧道、
 * PSB 远程工作区会话。它们的工作目录归谁、file ops 走哪条通道、Codex 用什么凭证、错误码
 * 该把运维指向哪个系统，全都不一样；此前这些差异散落在 cc 宿主、pi 隧道、codex
 * agent 三层各自实现（同一事实写三遍，改一处就漂移）。所以：
 *
 *   - `classifyRemoteSessionTransport` 只回答「是哪一种 transport」；
 *   - `resolveRemoteTransportCapabilities` 回答「它有什么能力」（唯一能力表）；
 *   - 上层只消费能力，不认识前缀，也不再各自 `startsWith`。
 *
 * ## 三种 transport 的硬边界
 *
 *   - `psb:<PSB sessionId>`：PSB 远程工作区的会话隧道身份（与 MCPRouter 同一份
 *     agent-tunnel 帧契约，只换地址与鉴权）。**cwd 归宿主**，客户端手里的
 *     `/psb-remote/<目录>` 只是本机虚拟路径（`shared/psb-remote-workspace.ts` 硬约束 3）。
 *   - `mcpr:<instanceId>`：MCPRouter 账号隧道的逻辑实例身份。`workingDir` 是实例上的真实路径。
 *   - 其它非空值：SSH Remote 的 host id（既有的独立闭环：pool / 探针 / 反向转发）。
 *   - 空值：本地。
 *
 * 两个隧道身份都不在 SSH pool 里，也都不能喂给任何 SSH-only 探针（见
 * `docs/dev-rules/psb-remote-session-transport.md` §1 与
 * `docs/dev-rules/mcpr-remote-session-routing.md` §2/§3）。分类顺序无关（两个前缀互斥），
 * 但**任何一个都不能落到 ssh 默认分支**：畸形 `psb:` / `mcpr:` 必须留在各自的隧道错误路径上，
 * 否则会报成 SSH_HOST_NOT_FOUND，把「这不是 SSH 主机」误报成「SSH 主机没连」。
 */

import { MCPR_REMOTE_HOST_PREFIX } from '../../shared/meka-router.js';
import {
  PSB_REMOTE_HOST_PREFIX,
  psbTunnelModeForAgent,
  type PsbTunnelMode,
} from '../../shared/psb-remote-workspace.js';

export type RemoteSessionTransport = 'local' | 'ssh' | 'mcpr' | 'psb';

/** 远端会话可能承载的引擎(与 maker-core 的 AgentKind 同集,单独声明一是为了本模块纯函数化)。 */
export type RemoteAgentKind = 'claude-code' | 'codex' | 'pi';

export const REMOTE_AGENT_KINDS: readonly RemoteAgentKind[] = ['claude-code', 'codex', 'pi'];

/**
 * 远端 agent-tunnel 的 mode。
 *
 * **只有一份**：数据面 mode 由共享契约（`shared/psb-remote-workspace.ts` 的
 * `PSB_TUNNEL_MODES` / `PsbTunnelMode`）定义，MCPRouter 侧逐字相同（同一份帧契约）。
 * 本别名只为让 maker-host 的签名读起来是「远端隧道 mode」，不再是第二个字面量联合。
 */
export type RemoteTunnelMode = PsbTunnelMode;

/** 远端 file ops 的承载通道。 */
export type RemoteFileOpsMode =
  /** 本地文件系统（没有远端）。 */
  | 'local'
  /** SSH 连接池上的 exec（`getRemoteAgentFileOps` 的既有通道）。 */
  | 'ssh'
  /** agent-tunnel `mode=exec`（隧道 transport 的实例内执行，与 SSH exec 同形）。 */
  | 'tunnel-exec';

/**
 * 远端 Codex 的凭证形态。
 *
 * `gateway-key`：只把 Cindy AI Gateway key 交给远端 bridge（Desktop OAuth 绝不复制到
 * 另一台机器）。SSH 不用这个字段：它那份隔离的 CODEX_HOME 里自己持有该机器的登录态
 * （`undefined` = 沿用既有 SSH 行为）。
 */
export type RemoteCodexCredentialMode = 'gateway-key';

/** 错误码 / 日志的**归因标签**：跟着 transport 走，不跟着"谁先实现了这条代码路径"走。 */
export type RemoteTransportTag = 'LOCAL' | 'SSH' | 'MCPR' | 'PSB';

export interface RemoteTransportCapabilities {
  readonly transport: RemoteSessionTransport;
  /** 错误码前缀 / 日志归因标签（`[PSB_*]` 不会把运维指向 MCPRouter）。 */
  readonly tag: RemoteTransportTag;
  /**
   * 工作目录的权威是否在**远端宿主**（目前只有 `psb:`）。
   *
   * `true` 时客户端手里的 `workingDir` 是虚拟路径，不得作为远端 cwd / roots /
   * sandboxPolicy / Skill 发现根下发；cwd 由宿主按自己的会话工作区决定。
   */
  readonly ownsCwd: boolean;
  /**
   * agent → 隧道 mode；`null` = 这个 transport 根本不走 agent-tunnel
   * （本地 / SSH 各有自己的通道）。
   */
  readonly tunnelModeByAgent: Readonly<Record<RemoteAgentKind, RemoteTunnelMode>> | null;
  readonly fileOpsMode: RemoteFileOpsMode;
  /** 隧道 transport 上 Codex bridge 的凭证来源；`undefined` = 沿用该 transport 既有语义。 */
  readonly codexCredentialMode: RemoteCodexCredentialMode | undefined;
}

/**
 * 隧道 transport 的 agent → mode 表。
 *
 * 直接复用共享契约的 `psbTunnelModeForAgent`：MCPRouter 的 `agent-tunnel` 与 PSB 是
 * **同一份 mode 语义**（`cc-mgr` / `codex-appserver` / `pi` / `exec`），所以这张表对
 * 两种隧道 transport 是同一张。新增 mode 时只改共享契约；本模块不维护第二份映射。
 */
const TUNNEL_MODES_BY_AGENT: Readonly<Record<RemoteAgentKind, RemoteTunnelMode>> =
  Object.freeze({
    'claude-code': psbTunnelModeForAgent('claude-code'),
    codex: psbTunnelModeForAgent('codex'),
    pi: psbTunnelModeForAgent('pi'),
  });

const LOCAL_CAPABILITIES: RemoteTransportCapabilities = Object.freeze({
  transport: 'local',
  tag: 'LOCAL',
  ownsCwd: false,
  tunnelModeByAgent: null,
  fileOpsMode: 'local',
  codexCredentialMode: undefined,
});

const SSH_CAPABILITIES: RemoteTransportCapabilities = Object.freeze({
  transport: 'ssh',
  tag: 'SSH',
  ownsCwd: false,
  tunnelModeByAgent: null,
  fileOpsMode: 'ssh',
  // SSH 的 CODEX_HOME 是该机器自己的登录态，bootstrap 不需要复制网关 key。
  codexCredentialMode: undefined,
});

const MCPR_CAPABILITIES: RemoteTransportCapabilities = Object.freeze({
  transport: 'mcpr',
  tag: 'MCPR',
  ownsCwd: false,
  tunnelModeByAgent: TUNNEL_MODES_BY_AGENT,
  fileOpsMode: 'tunnel-exec',
  codexCredentialMode: 'gateway-key',
});

const PSB_CAPABILITIES: RemoteTransportCapabilities = Object.freeze({
  transport: 'psb',
  tag: 'PSB',
  // PSB 按服务端会话记录里的工作区 spawn 引擎；Cindy 的 workingDir 是虚拟路径。
  ownsCwd: true,
  tunnelModeByAgent: TUNNEL_MODES_BY_AGENT,
  fileOpsMode: 'tunnel-exec',
  codexCredentialMode: 'gateway-key',
});

const CAPABILITIES_BY_TRANSPORT: Readonly<
  Record<RemoteSessionTransport, RemoteTransportCapabilities>
> = Object.freeze({
  local: LOCAL_CAPABILITIES,
  ssh: SSH_CAPABILITIES,
  mcpr: MCPR_CAPABILITIES,
  psb: PSB_CAPABILITIES,
});

/** 远端身份 → transport。Keep session transport selection ahead of any SSH-only preflight. */
export function classifyRemoteSessionTransport(
  remoteHostId: string | null | undefined,
): RemoteSessionTransport {
  if (!remoteHostId) return 'local';
  if (remoteHostId.startsWith(PSB_REMOTE_HOST_PREFIX)) return 'psb';
  if (remoteHostId.startsWith(MCPR_REMOTE_HOST_PREFIX)) return 'mcpr';
  return 'ssh';
}

/**
 * 远端身份 → 能力描述符（**唯一能力表**，本进程内不另写第二份）。
 *
 * 上层（cc 宿主 / pi 隧道 / codex agent 外挂 / file ops / 凭证）都从这里取能力，
 * 不再各自按前缀判断，也不要在调用点重复拼 `startsWith`。
 */
export function resolveRemoteTransportCapabilities(
  remoteHostId: string | null | undefined,
): RemoteTransportCapabilities {
  return CAPABILITIES_BY_TRANSPORT[classifyRemoteSessionTransport(remoteHostId)];
}

/**
 * 这个远端身份是否把 cwd 的所有权交给**远端宿主**（目前只有 `psb:`）。
 *
 * 判定必须走这里（→ 能力表的 `ownsCwd`），不要在调用点手写 `startsWith`：
 * desktop 在 maker-core 的 `lifecycleHooks.prepareStartOptions` 里对**所有**
 * `createSession` 入口统一打 `remoteHostOwnsCwd`（界面 / lazy-create / resume /
 * Goal 恢复 / IM / hook-control 都经过这个钩子），`maker-ipc/register.ts` 不再单独打标
 * （那会漏掉绕过它的恢复路径）。
 */
export function remoteSessionHostOwnsCwd(
  remoteHostId: string | null | undefined,
): boolean {
  return resolveRemoteTransportCapabilities(remoteHostId).ownsCwd;
}

/**
 * 这个远端身份是否走 **agent-tunnel 字节流**(`psb:` / `mcpr:`)，而不是 SSH pool。
 *
 * 远端钩子(transport / file-ops / 技能源读取 / 探针)的公共门禁都用它，而不是各自手写
 * 前缀判断 —— 新增第三种隧道 transport 时只改能力表一处。
 * 具体的隧道实现再按 `classifyRemoteSessionTransport` 的返回值分派
 * (`maker-host/remote-tunnel-dispatch.ts`)。
 *
 * 空值(local)与 SSH 全部返回 `false`:它们各有自己的既有路径。
 */
export function isTunnelRemoteSessionTransport(
  remoteHostId: string | null | undefined,
): boolean {
  return resolveRemoteTransportCapabilities(remoteHostId).tunnelModeByAgent !== null;
}

/**
 * Resolve the credential source owned by a remote Codex transport.
 *
 * Both tunnel transports (`mcpr:` and `psb:`) hand the remote Codex bridge only the
 * Cindy AI Gateway key; Desktop OAuth is deliberately never copied to another machine.
 * SSH keeps its established fallback behavior because its isolated CODEX_HOME owns
 * that host's auth.
 */
export function resolveRemoteCodexCredentialMode(
  remoteHostId: string,
): RemoteCodexCredentialMode | undefined {
  return resolveRemoteTransportCapabilities(remoteHostId).codexCredentialMode;
}

/**
 * 归因码跟着 transport 走：`[MCPR_PI_*]` 出现在 PSB 会话上会把运维指向错误的系统。
 *
 * 用法：`remoteTransportErrorCode(remoteHostId, 'PI_BINARY_MISSING')` →
 * `[PSB_PI_BINARY_MISSING]` / `[MCPR_PI_BINARY_MISSING]`（SSH / 本地没有隧道码，
 * 落到中性 `REMOTE_` 前缀）。
 */
export function remoteTransportErrorCode(
  remoteHostId: string | null | undefined,
  code: string,
): string {
  const { tag } = resolveRemoteTransportCapabilities(remoteHostId);
  const prefix = tag === 'PSB' || tag === 'MCPR' ? tag : 'REMOTE';
  return `[${prefix}_${code}]`;
}

/**
 * 隧道 transport 现在承载 `claude-code` / `codex` / `pi` 三个引擎,因此这里**没有**引擎级静态门禁。
 *
 * 2026-10-09 起 MCPRouter 新增 `mode=pi` 隧道(`openMcprTunnel(..., { mode: 'pi' })`):
 * runtime 把隧道接到 `pi-manager bridge --socket <受管 socket>` 的 stdio,客户端这一侧的 Pi
 * 协议与 SSH 路径逐字节同源,差别只是字节从哪来(见 `docs/dev-rules/pi-harness.md`
 * 「MCPRouter 远端(MCPR)」)。PSB 远程工作区复用同一份 mode 与客户端实现
 * (`maker-host/remote-tunnel-dispatch.ts`),所以这条结论对 `psb:` 同样成立。
 *
 * 历史:2026-09-29 这里曾有一个 `assertMcprHostSupportsAgent('pi', …)` 静态门禁(类型化
 * `MCPR_AGENT_UNSUPPORTED`)。它解决的问题是**归因**——没有它时 `mcpr:<id>` 会被送进
 * `getRemoteSshPool()`,被报成 `remote SSH host "mcpr:<id>" not found in pool`。现在的做法
 * 改为在每个远端钩子内部按 transport 分派(数据面走隧道、控制面走 runtime 能力),
 * 事实不成立时给出的是**能力级**失败,而不是把「这个组合没有实现」当成引擎与 transport
 * 的永久不兼容再拦一次。SSH 路径的既有语义(claude/codex/pi 全部可用)一字未改。
 */
