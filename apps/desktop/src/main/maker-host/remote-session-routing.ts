import { MCPR_REMOTE_HOST_PREFIX } from '../../shared/meka-router.js';
import { PSB_REMOTE_HOST_PREFIX } from '../../shared/psb-remote-workspace.js';

export type RemoteSessionTransport = 'local' | 'ssh' | 'mcpr' | 'psb';

/** 远端会话可能承载的引擎(与 maker-core 的 AgentKind 同集,单独声明一是为了本模块纯函数化)。 */
export type RemoteAgentKind = 'claude-code' | 'codex' | 'pi';

/**
 * 远端身份是**三种并列的 transport**,不是"有 remoteHostId 就是 SSH 主机":
 *
 *   - `psb:<PSB sessionId>`:PSB 远程工作区的会话隧道身份(与 MCPRouter 同一份 agent-tunnel
 *     帧契约,只换地址与鉴权);
 *   - `mcpr:<instanceId>`:MCPRouter 账号隧道的逻辑实例身份;
 *   - 其它非空值:SSH Remote 的 host id;
 *   - 空值:本地。
 *
 * Keep session transport selection ahead of any SSH-only preflight or recovery.
 * 两个隧道身份都不在 SSH pool 里,也都不能喂给任何 SSH-only 探针
 * (见 `docs/dev-rules/psb-remote-session-transport.md` §1 与
 * `docs/dev-rules/mcpr-remote-session-routing.md` §2/§3)。
 */
export function classifyRemoteSessionTransport(
  remoteHostId: string | null | undefined,
): RemoteSessionTransport {
  if (!remoteHostId) return 'local';
  // 顺序无关(两个前缀互斥),但**任何一个都不能落到 ssh 默认分支**:畸形 `psb:` / `mcpr:`
  // 必须留在各自的隧道错误路径上,否则会报成 SSH_HOST_NOT_FOUND,把「这不是 SSH 主机」
  // 误报成「SSH 主机没连」。
  if (remoteHostId.startsWith(PSB_REMOTE_HOST_PREFIX)) return 'psb';
  if (remoteHostId.startsWith(MCPR_REMOTE_HOST_PREFIX)) return 'mcpr';
  return 'ssh';
}

/**
 * 这个远端身份是否把 cwd 的所有权交给**远端宿主**（目前只有 `psb:`）。
 *
 * PSB 远程工作区按会话记录里的服务端工作区 spawn 引擎；Cindy 手里的 `/psb-remote/<目录>` 只是
 * 本机虚拟路径（`shared/psb-remote-workspace.ts` 硬约束 3），不能当远端 cwd / roots 下发。
 * 判定必须走这里（→ `classifyRemoteSessionTransport`），不要在调用点手写 `startsWith`：
 * desktop 在 maker-core 的 `lifecycleHooks.prepareStartOptions` 里对**所有** `createSession`
 * 入口统一打 `remoteHostOwnsCwd`（界面 / lazy-create / resume / Goal 恢复 / IM / hook-control
 * 都经过这个钩子），`maker-ipc/register.ts` 不再单独打标（那会漏掉绕过它的恢复路径）。
 */
export function remoteSessionHostOwnsCwd(
  remoteHostId: string | null | undefined,
): boolean {
  return classifyRemoteSessionTransport(remoteHostId) === 'psb';
}

/**
 * 这个远端身份是否走 **agent-tunnel 字节流**(`psb:` / `mcpr:`),而不是 SSH pool。
 *
 * 远端钩子(transport / file-ops / 技能源读取 / 探针)的公共门禁都用它,而不是各自手写
 * 前缀判断 —— 新增第三种隧道 transport 时只改这里一处。
 * 具体的隧道实现再按 `classifyRemoteSessionTransport` 的返回值分派
 * (`maker-host/remote-tunnel-dispatch.ts`)。
 *
 * 空值(local)与 SSH 全部返回 `false`:它们各有自己的既有路径。
 */
export function isTunnelRemoteSessionTransport(
  remoteHostId: string | null | undefined,
): boolean {
  const transport = classifyRemoteSessionTransport(remoteHostId);
  return transport === 'mcpr' || transport === 'psb';
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
): 'gateway-key' | undefined {
  return isTunnelRemoteSessionTransport(remoteHostId) ? 'gateway-key' : undefined;
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
