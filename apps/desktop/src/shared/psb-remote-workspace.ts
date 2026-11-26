/**
 * PSB（Project Steward Bot）**远程工作区**会话 —— 跨进程契约（main / preload / renderer 共用）。
 *
 * ## 这个文件是什么
 *
 * Cindy 新增的一种远程会话目标：会话跑在 PSB 远程客户端机器上的**工作区目录**里，
 * Cindy 经 PSB 转发（HTTP + 两条 WebSocket）管理占用、会话与画面。本文件只放**形状与纯函数**：
 *
 *   - 远端会话身份（`psb:<PSB sessionId>`）——与 `mcpr:<instanceId>`、SSH host 并列的第三种 transport；
 *   - Cindy 调 PSB 的 HTTP / WS 路径常量（PSB 侧契约见 PSB 仓根目录 `协作需求.md` §4）；
 *   - PSB 响应的 DTO（工作区 / 客户端 / 项目模板 / 会话）；
 *   - IPC 通道名与请求/响应 DTO（renderer ↔ main）；
 *   - 展示口径的纯函数（状态词、可用性、锁、虚拟工作目录）。
 *
 * ## 跨仓映射契约（CINDY-RW-09，2026-11-26）
 *
 * `stream.cursor` 的形状（XFixes `name`）→ 观看端 CSS 关键字的映射**逐条一致**于 PSB
 * `@psb/shared` 的 `packages/shared/src/stream-cursor.ts`：36 个 CSS 关键字、64 条 X11 别名、
 * 归一化与回退顺序相同（PSB 源检出 0.1.127，2026-11-26 工作区快照）。PSB 的 `host` 位图是
 * **可选**外观策略，Cindy 固定 `system`（宿主风格、只变形态）；未知 / 缺名 → `default`，
 * 绝不 `none`。本仓**不 import PSB 包**，版本、来源与后续替换点见 §5b 的文件头。
 *
 * 不放实现（HTTP、隧道、Electron），也不放文案（文案走 i18n 的 `remoteWorkspace` 命名空间）。
 *
 * ## 三条硬约束（改动前先读）
 *
 * 1. **transport 身份必须在 `psb:` 前缀里**：不允许把 PSB 会话 id 直接当 SSH host 或 MCPR 实例 id 使用。
 *    分类器在 `main/maker-host/remote-session-routing.ts` 与 `renderer/lib/remoteCodexModelHost.ts`，
 *    新前缀要同时进两处（它们有一致性矩阵测试）。
 * 2. **PSB 会话 id 由 PSB 生成、Cindy 原样保存**：Cindy 不解析、不拼接、不推导它的格式；
 *    本地会话行用 `remoteHostId = buildPsbRemoteHostId(session.id)` 记住它。
 * 3. **`workingDir` 是虚拟引用**：它只是"这个会话属于哪个远端工作区"的显示/选择依据，
 *    绝不参与本机路径解析（不能拼 `path.join`、不能 `fs` 读、不能作为 worktree 根）。
 */

import { extractIpcError } from './ipcError';
import type { WorkspaceVcsNotice } from './psb-workspace-vcs';

/* ============================== 1. 传输身份 ============================== */

/**
 * 远端会话身份前缀。完整值形如 `psb:<PSB sessionId>`。
 *
 * 与 `MCPR_REMOTE_HOST_PREFIX`（`mcpr:`）同层级：两者都是"逻辑隧道身份"，不是 SSH host，
 * 也都不允许进入 SSH pool / SSH-only 探针（见 `docs/dev-rules/mcpr-remote-session-routing.md` 的规则）。
 */
export const PSB_REMOTE_HOST_PREFIX = 'psb:';

export function buildPsbRemoteHostId(sessionId: string): string {
  return `${PSB_REMOTE_HOST_PREFIX}${sessionId}`;
}

/** 解析 `psb:` 身份；畸形值（空 id）返回 `null` —— 与 `parseMcprRemoteHostId` 同口径。 */
export function parsePsbRemoteHostId(value: string | null | undefined): string | null {
  if (!value?.startsWith(PSB_REMOTE_HOST_PREFIX)) return null;
  const id = value.slice(PSB_REMOTE_HOST_PREFIX.length);
  return id ? id : null;
}

/**
 * 虚拟工作目录：会话行的 `workingDir` 值。
 *
 * **不是本机路径**（见文件头第 3 条约束）。带上工作区 id 与目录名是为了让日志、会话头与
 * 「工作区在哪」的展示有同一份来源；它不会出现在本机文件操作里。
 */
export function buildPsbVirtualWorkingDir(input: {
  workspaceId: string;
  directoryName?: string | null;
}): string {
  const name = input.directoryName?.trim();
  return `/psb-remote/${name && name.length > 0 ? name : input.workspaceId}`;
}

/* ============================== 2. Agent 类型与隧道 ============================== */

/**
 * 远端工作区会话可用的引擎。
 *
 * 与 `RemoteAgentKind`（`main/maker-host/remote-session-routing.ts`）同一集合：
 * 本地会话能选的三种 Harness 在远程工作区上都要能选（用户明确要求"完全跟本地会话一样"）。
 */
export const PSB_AGENT_KINDS = ['claude-code', 'codex', 'pi'] as const;

export type PsbAgentKind = (typeof PSB_AGENT_KINDS)[number];

export function isPsbAgentKind(value: unknown): value is PsbAgentKind {
  return typeof value === 'string' && (PSB_AGENT_KINDS as readonly string[]).includes(value);
}

/**
 * Agent 隧道 mode。**与 MCPRouter `agent-tunnel` 的 mode 逐字相同**，帧契约见
 * `docs/dev-rules/mcpr-remote-session-routing.md` 与 PSB 仓 `协作需求.md` §4.4：
 *
 *   - `cc-mgr`：Claude Code 的 cc-mgr 控制桥；
 *   - `codex-appserver`：Codex app-server 的 NDJSON 桥；
 *   - `pi`：pi-manager 两阶段（RPC → 同连接 JSONL）；
 *   - `exec`：单连接单次执行（file ops / 探针）。
 */
export const PSB_TUNNEL_MODES = ['cc-mgr', 'codex-appserver', 'pi', 'exec'] as const;

export type PsbTunnelMode = (typeof PSB_TUNNEL_MODES)[number];

/** Agent 类型 → 数据面隧道 mode。`exec` 不属于任何引擎，单独按需打开。 */
export function psbTunnelModeForAgent(kind: PsbAgentKind): PsbTunnelMode {
  switch (kind) {
    case 'claude-code':
      return 'cc-mgr';
    case 'codex':
      return 'codex-appserver';
    case 'pi':
      return 'pi';
  }
}

/** 只有消费 cc-mgr 产物的两种 mode 才声明 `bundleVersion`（与 MCPR 同口径）。 */
export function psbTunnelNeedsBundleVersion(mode: PsbTunnelMode): boolean {
  return mode === 'cc-mgr' || mode === 'codex-appserver';
}

/**
 * PSB agent-tunnel 的**可归因失败码**（main 抛 `PsbTunnelError` 时 `code` 的取值集合）。
 *
 * 隧道错误最终会经 maker-host 的 lazy create / send 失败进入用户可见的回合错误，所以码名
 * 必须与 HTTP 侧（`PSB_ERROR_CODES` / `PSB_CINDY_FAILURE_CODES`）同一套词：
 * 「认证 / 会话不可见 / 会话非就绪 / 会话终态 / 客户端离线 / 限流 / 不可达」是**不同处置**，
 * 不能都变成一句「连接失败」。与 HTTP 同名的码（`PSB_AUTH_REQUIRED` / `PSB_CLIENT_OFFLINE`
 * 等）刻意复用同一个字符串，方便把两条传输的失败归到同一张表。
 */
export const PSB_TUNNEL_FAILURE_CODES = [
  /** `psb:<sessionId>` 身份畸形。 */
  'PSB_SESSION_INVALID',
  /** 取不到 Cindy Connection JWT（未登录 / 非企业组织；见 `psbAuth.ts` 的 kind）。 */
  'PSB_AUTH_REQUIRED',
  /** PSB 拒绝 Upgrade 或 4003 关闭：token 被服务端判为无效。 */
  'PSB_TUNNEL_AUTH',
  'PSB_SESSION_NOT_FOUND',
  'PSB_SESSION_NOT_READY',
  'PSB_SESSION_STOPPED',
  'PSB_CLIENT_OFFLINE',
  'PSB_RATE_LIMITED',
  'PSB_TUNNEL_UNREACHABLE',
] as const;

export type PsbTunnelFailureCode = (typeof PSB_TUNNEL_FAILURE_CODES)[number];

/* ============================== 3. PSB API 路径 ============================== */

/**
 * Cindy 专用的 PSB 命名空间。
 *
 * 用独立前缀（而不是复用浏览器用的 `/api/remote/**`）有三个理由：鉴权是 Cindy Bearer 而不是浏览器
 * session；PSB 侧守卫可以按**精确形状**放行（不允许宽前缀）；浏览器接口的演进不受 Cindy 客户端版本影响。
 */
export const PSB_CINDY_API_PREFIX = '/api/cindy/remote';

export const PSB_CINDY_ROUTES = {
  workspaces: `${PSB_CINDY_API_PREFIX}/workspaces`,
  workspace: (workspaceId: string): string =>
    `${PSB_CINDY_API_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}`,
  occupy: (workspaceId: string): string =>
    `${PSB_CINDY_API_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/occupy`,
  sessions: (workspaceId: string): string =>
    `${PSB_CINDY_API_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
  /**
   * 工作区级串流订阅（PSB 0.1.172）。
   *
   * 语义是**服务接口调用**、不是建会话：解析该工作区当前 `running` 的桌面访问会话并返回它的
   * id；不创建 Agent 会话、不写库。观看端（WS `…/sessions/:sessionId/stream`）与
   * `…/stream/status` 在过渡期同时接受 agent 会话 id 与桌面访问会话 id（PSB 口径）。
   */
  streamSubscribe: (workspaceId: string): string =>
    `${PSB_CINDY_API_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/stream/subscribe`,
  /**
   * 工作区**桌面访问状态**读口（PSB 0.1.180，`GET …/workspaces/:id/access`）。
   *
   * 只在「Cindy 自己拉起了桌面访问」之后用来轮询到 running（见 `ensureWorkspaceStart`；
   * main `psbClient.ensureWorkspaceAccess`）。Cindy 侧**不**用它做常规状态展示：页面上的
   * 桌面会话状态仍来自 `stream/status.desktopSession`（那是已配对的观看端会话视角）。
   *
   * 响应形状 PSB 尚未给最终示例（跟进项已登记在
 * `docs/collaboration/psb-remote-workspace-contract.md`），所以解析按 `state` /
   * `desktopSession` / `access.state` 三种同义字段宽松读取，**不猜更多路径**。
   */
  workspaceAccess: (workspaceId: string): string =>
    `${PSB_CINDY_API_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/access`,
  clients: `${PSB_CINDY_API_PREFIX}/clients`,
  projectTemplates: `${PSB_CINDY_API_PREFIX}/project-templates`,
  session: (sessionId: string): string =>
    `${PSB_CINDY_API_PREFIX}/sessions/${encodeURIComponent(sessionId)}`,
  streamStatus: (sessionId: string): string =>
    `${PSB_CINDY_API_PREFIX}/sessions/${encodeURIComponent(sessionId)}/stream/status`,
} as const;

/** 隧道与串流的 WebSocket 路径（相对 PSB 站点根；由 main 侧拼成 `wss://` URL）。 */
export const PSB_CINDY_WS = {
  agentTunnel: (sessionId: string): string =>
    `${PSB_CINDY_API_PREFIX}/sessions/${encodeURIComponent(sessionId)}/agent-tunnel`,
  stream: (sessionId: string): string =>
    `${PSB_CINDY_API_PREFIX}/sessions/${encodeURIComponent(sessionId)}/stream`,
} as const;

/* ====================== 3b. PSB 通用网页接口（待 Cindy 白名单放行） ====================== */

/**
 * PSB **浏览器网页**命名空间（`/api/remote/**`）。
 *
 * Cindy 复用它的**唯一**一个接口是工作区桌面访问的幂等拉起：
 * `POST /api/remote/workspaces/:id/access/start`（200/202/409，幂等 ensure）。语义在 PSB 的
 * 网页路由里已经存在，Cindy 不再自造一条等价逻辑。
 *
 * ## 当前状态：Cindy Bearer **尚未**被放行（2026-11-26，PSB 0.1.180）
 *
 * PSB 的 Cindy 命名空间白名单是**精确形状**（只放行 `/api/cindy/remote/**`），所以这条路由
 * 现在对 Cindy 恒返回 **403**。PSB 台账（`docs/collaboration/psb-remote-workspace-contract.md`）
 * 记的是「Cindy 入口下一轮加」：
 * 要么放行 Cindy 的 `access/start`，要么在 `/api/cindy/remote/**` 下提供命名空间入口。
 *
 * 因此调用方必须把这条路径当成**可选增强**：403 / 404（旧 PSB）/ 405 都收敛成
 * 「Cindy 入口尚未开放」的**非致命**标记，继续走原有错误路径（subscribe 的 409 会给出
 * 可行动文案）。**不要**再猜别的路径来「拉起访问」——猜错的路径只会得到更多 404。
 */
export const PSB_WEB_API_PREFIX = '/api/remote';

export const PSB_WEB_ROUTES = {
  /** 幂等 ensure 工作区桌面访问（200/202 成功，409 见契约）。 */
  workspaceAccessStart: (workspaceId: string): string =>
    `${PSB_WEB_API_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/access/start`,
} as const;

/* ============================== 4. PSB 响应 DTO ============================== */

/**
 * 工作区状态词：**PSB 已有的词**（`REMOTE_WORKSPACE_STATES`），不为 Cindy 另造一套。
 * 语义见 PSB `docs/remote-workspace.md` §7.7 与 `packages/shared/src/remote-clients.ts`。
 */
export const PSB_WORKSPACE_STATES = [
  'planned',
  'provisioning',
  'ready',
  'failed',
  'deleting',
] as const;

export type PsbWorkspaceState = (typeof PSB_WORKSPACE_STATES)[number];

export function isPsbWorkspaceState(value: unknown): value is PsbWorkspaceState {
  return typeof value === 'string' && (PSB_WORKSPACE_STATES as readonly string[]).includes(value);
}

/**
 * 「不能开新会话」的原因（PSB 计算后下发，Cindy 只负责显示与禁用）。
 *
 * 为什么由 PSB 算：同一份判据（占用 + 状态 + 在线 + 能力）在网页上已经存在，Cindy 再算一遍必然漂移。
 */
export const PSB_WORKSPACE_UNUSABLE_REASONS = [
  'occupied-by-other',
  'workspace-not-ready',
  'client-offline',
  'agent-unsupported',
] as const;

export type PsbWorkspaceUnusableReason = (typeof PSB_WORKSPACE_UNUSABLE_REASONS)[number];

export function isPsbWorkspaceUnusableReason(
  value: unknown,
): value is PsbWorkspaceUnusableReason {
  return (
    typeof value === 'string' &&
    (PSB_WORKSPACE_UNUSABLE_REASONS as readonly string[]).includes(value)
  );
}

/** 工作区占用状态（**已按当前 Cindy 身份算好视角**，见 PSB 契约 `RemoteWorkspaceOccupancyView`）。 */
export interface PsbWorkspaceOccupancy {
  readonly occupied: boolean;
  /** 占用人就是当前身份。 */
  readonly byMe: boolean;
  /** 占用人 id（PSB 用十进制文本，沿用既有契约）；未占用时 `null`。 */
  readonly personId: string | null;
  /** 占用人显示名（占用那一刻的快照）；未占用时 `''`。 */
  readonly personName: string;
  /** 占用时刻（毫秒时间戳）；未占用时 `null`。 */
  readonly occupiedAt: number | null;
}

/** 列表 / 详情 / 创建 / 占用共用的工作区行（PSB 仓 `协作需求.md` §4.1）。 */
export interface PsbRemoteWorkspace {
  readonly id: string;
  /** 工作区**名称**（PSB 工作区标题，创建时可填、之后可在 PSB 侧改）：Cindy 的实例标签主标题用它。 */
  readonly title: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly clientOnline: boolean;
  readonly clientPlatform: string | null;
  /**
   * PSB 工作区状态词；**`null` = PSB 下发了 Cindy 还不认识的新词**。
   *
   * 不能把未知值伪装成某个已知状态（旧实现在这里回落 `'failed'`：界面会显示「失败」并把
   * 一个只是新状态的工作区当成坏的）。未知一律按「未就绪/未知」处理（不可写），
   * 与 `desktopSession` / `reasonCode` 的 `null` 口径一致。
   */
  readonly state: PsbWorkspaceState | null;
  readonly templateKey: string | null;
  readonly templateTitle: string | null;
  /** 服务端分配的目录名（仅显示）。 */
  readonly directoryName: string | null;
  /** 客户端机器上的工作区绝对路径（仅显示；**不得**当本机路径使用）。 */
  readonly clientPath: string | null;
  readonly occupancy: PsbWorkspaceOccupancy;
  /** 是否允许开启新会话（判据在 PSB，见 `PSB_WORKSPACE_UNUSABLE_REASONS`）。 */
  readonly usable: boolean;
  readonly unusableReason: PsbWorkspaceUnusableReason | null;
  readonly sessionCount: number;
  /** PSB 网页工作区详情绝对地址（Cindy 图标按钮跳转用）。 */
  readonly webUrl: string | null;
  readonly sessionsWebUrl: string | null;
}

/** 客户端上某个 Agent 运行时的可用性（新建工作区 / 选 Harness 时用）。 */
export interface PsbRemoteClientAgent {
  readonly kind: PsbAgentKind;
  readonly available: boolean;
  readonly version: string | null;
}

/** 远程客户端行（PSB 仓 `协作需求.md` §4.3.1）。 */
export interface PsbRemoteClient {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
  readonly platform: string | null;
  readonly capabilities: {
    readonly workspace: boolean;
    readonly agent: boolean;
    readonly streaming: boolean;
    readonly exec: boolean;
    readonly windows: boolean;
  };
  readonly agents: readonly PsbRemoteClientAgent[];
}

/** 项目模板行（PSB 仓 `协作需求.md` §4.3.2）——与网页「新建工作区」弹窗同一份数据。 */
export interface PsbProjectTemplate {
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly checkoutCount: number;
}

/** 会话状态词（Cindy 只认这一套，见 PSB 仓 `协作需求.md` PSB-RW-05）。 */
export const PSB_SESSION_STATUSES = ['starting', 'running', 'idle', 'stopped', 'failed'] as const;

export type PsbSessionStatus = (typeof PSB_SESSION_STATUSES)[number];

export function isPsbSessionStatus(value: unknown): value is PsbSessionStatus {
  return typeof value === 'string' && (PSB_SESSION_STATUSES as readonly string[]).includes(value);
}

/**
 * 会话是否已终态。终态**不会逆转**（PSB 契约），所以这个会话本身永远不能再开隧道。
 *
 * 注意：终态**不等于**「这个任务结束了」。Cindy 的处理是在用户下一次发送时透明地
 * 在同一工作区新建一条 PSB 会话并重绑到当前本地任务（见 `psbSessionNeedsRebind`
 * 与 `main/remote-workspace/sessionRebind.ts`），本地任务继续。
 */
export function psbSessionIsTerminal(status: PsbSessionStatus): boolean {
  return status === 'stopped' || status === 'failed';
}

/**
 * 这条 PSB 会话的**下一条消息**是否需要「发送前重建」：终态 ⇒ 要重建。
 *
 * 纯函数，main（发送路径决策）与渲染层（提示「下一条消息会自动重建」）共用同一判据。
 * `null` / `undefined`（还没读到状态）返回 `false` —— 「不知道」不能当成「要重建」，
 * 否则界面会对一条正常的会话预告重建。main 侧另有一个终态之外的触发条件：
 * 读会话 404（PSB 侧会话记录已不存在），那个由主进程按失败码判断，不进本函数。
 */
export function psbSessionNeedsRebind(status: PsbSessionStatus | null | undefined): boolean {
  return typeof status === 'string' && psbSessionIsTerminal(status);
}

/** 会话创建来源（网页创建的会话也出现在同一份列表里，见 PSB-RW-05）。 */
export const PSB_SESSION_SOURCES = ['cindy', 'web'] as const;

export type PsbSessionSource = (typeof PSB_SESSION_SOURCES)[number];

/** 会话行（PSB 仓 `协作需求.md` §4.2）。 */
export interface PsbRemoteSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly clientId: string;
  readonly title: string | null;
  /**
   * 引擎类型（数据面隧道 mode 由它决定）；**`null` = PSB 下发了 Cindy 不认识的引擎**。
   *
   * 未知值**不能**回落某个已知引擎：那会让 Cindy 用错的隧道 mode 去连这条会话。`null` 时
   * 只能做只读展示（不可开隧道、不可据此建会话）；新增引擎要走
   * `PSB_AGENT_KINDS` / `RemoteAgentKind` 的同一批落地。
   */
  readonly agentKind: PsbAgentKind | null;
  /**
   * 会话状态；**`null` = PSB 下发了 Cindy 不认识的新状态词**。
   *
   * 未知值**不能**回落 `'failed'`：终态会触发「发送时透明重建 PSB 会话」（一次远端写），
   * 那等于用未知事实去改写用户任务。`null` 时按「未知」处理——不预热重建
   * （`psbSessionNeedsRebind(null) === false`），界面按需显示未知。
   */
  readonly status: PsbSessionStatus | null;
  /** 失败/不可用时的可读原因（PSB 下发中文；Cindy 作兜底显示）。 */
  readonly statusMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: {
    readonly personId: string | null;
    readonly personName: string;
    readonly source: PsbSessionSource;
  };
  readonly webUrl: string | null;
}

/**
 * 该工作区当前桌面会话状态（PSB `CINDY_REMOTE_DESKTOP_SESSION_STATES`，2026-11-26 加性字段）。
 *
 * 只有三态：PSB 把 `stopping` 归并进 `starting`（两者的正确动作都是「等它落定」），
 * `stopped` / `failed` / 没有会话统一为 `none`（下一步是去 PSB 网页启动桌面会话）。
 * 解析时**不解析中文**、也不从其它字段推导，只认 PSB 下发的这个值。
 */
export const PSB_DESKTOP_SESSION_STATES = ['none', 'starting', 'running'] as const;

export type PsbDesktopSessionState = (typeof PSB_DESKTOP_SESSION_STATES)[number];

export function isPsbDesktopSessionState(value: unknown): value is PsbDesktopSessionState {
  return (
    typeof value === 'string' &&
    (PSB_DESKTOP_SESSION_STATES as readonly string[]).includes(value)
  );
}

/**
 * 工作区**桌面访问**的生命周期状态（PSB 0.1.180 `POST …/stream/subscribe` 的 409
 * `details.state`，以及 `GET …/access` 的读数）。
 *
 * 与 `PSB_DESKTOP_SESSION_STATES` **不是同一套词**，不要互换：
 *   - `PSB_DESKTOP_SESSION_STATES` 是 `stream/status` 视角的三态（PSB 已把 `stopping` 并进
 *     `starting`、`stopped`/`failed` 并进 `none`），只用于「为什么现在没有画面」的展示；
 *   - 这套是**访问实例自己**的五态 + `running`，订阅 409 时 PSB 原样下发 `details.state`，
 *     Cindy 按它决定文案与是否值得自动重试（`starting` 等一会儿会好，`stopping` 也会落定，
 *     `none`/`stopped`/`failed` 必须由人去 PSB 网页启动访问）。
 *
 * 解析时**不解析中文**、不从其它字段推导。
 */
export const PSB_WORKSPACE_ACCESS_STATES = [
  'none',
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed',
] as const;

export type PsbWorkspaceAccessState = (typeof PSB_WORKSPACE_ACCESS_STATES)[number];

export function isPsbWorkspaceAccessState(value: unknown): value is PsbWorkspaceAccessState {
  return (
    typeof value === 'string' &&
    (PSB_WORKSPACE_ACCESS_STATES as readonly string[]).includes(value)
  );
}

/**
 * 订阅 409 里「**没有 running 桌面访问**」的机器码（PSB `details.code`）。
 *
 * 另外两个同类机器码（`NO_DESKTOP_SESSION`）属于 WS 4004 / `stream/status.reasonCode` 那套，
 * 不是这个 409；不要混用（见 `PSB_STREAM_REASON_CODES`）。
 */
export const PSB_NO_RUNNING_SESSION_CODE = 'NO_RUNNING_SESSION';

/**
 * 「此刻为什么没有画面」的机器码（PSB `CINDY_REMOTE_STREAM_REASON_CODES`）。
 *
 * 同一套词出现在两个读口：`stream/status.reasonCode` 与 WS 4004 的结构化 close reason
 * （`{"reasonCode":…,"desktopSession":…}|<一句中文>`）。Cindy 按码决定文案与是否重试，
 * **不解析中文**。
 *
 * - `NO_DESKTOP_SESSION`：该工作区没有可观看的桌面会话 → 去 PSB 网页启动桌面会话后重试；
 * - `CAPTURE_NOT_READY`：有桌面会话但采集/画面还没就绪 → 可恢复，保持/重建连接等画面；
 * - `CLIENT_NO_STREAMING`：客户端没声明串流能力 → 重试无意义，先升级客户端
 *   （WS 升级前就回 409，不会出现在 4004 的 close reason 里）。
 */
export const PSB_STREAM_REASON_CODES = [
  'NO_DESKTOP_SESSION',
  'CAPTURE_NOT_READY',
  'CLIENT_NO_STREAMING',
] as const;

export type PsbStreamReasonCode = (typeof PSB_STREAM_REASON_CODES)[number];

export function isPsbStreamReasonCode(value: unknown): value is PsbStreamReasonCode {
  return (
    typeof value === 'string' &&
    (PSB_STREAM_REASON_CODES as readonly string[]).includes(value)
  );
}

/** 串流状态（Cindy「启动 / 停止 / 详情」三个按钮的数据来源，PSB 仓 `协作需求.md` PSB-RW-07）。 */
/**
 * PSB 串流状态（`stream/status` 的 `data`，也是管理页「启动 / 停止 / 详情」的数据来源）。
 *
 * ## 字段名 = PSB wire 字段名（唯一一套，别再引入别名）
 *
 * PSB `CindyRemoteStreamStatus` 的线上拼写是 `capability` / `encoder` / `lastErrorZh`
 * （PSB 0.1.172+，pinned 快照 2026-11-26）。2026-11-26 之前的契约**草稿**写的是
 * `capable` / `codec` / `lastError`，解析层曾同时认两套；草稿拼写从未出现在任何已发布的
 * PSB 版本里，所以本批删除双读兼容：
 *
 * - 契约版本锚点：PSB 0.1.172（工作区级订阅）/ 0.1.180（VCS advisory + 访问状态）；
 * - 旧拼写下线点：**已下线**（2026-11-26，Cindy 侧解析只认 `capability` / `encoder` /
 *   `lastErrorZh`）。若将来 PSB 再改字段名，按新契约版本在同一处加一次「版本化读取」，
 *   不要保留无限期的双拼写兜底（两个来源会让「到底读到没有」永远说不清）。
 *
 * 管理页复用本类型（`PsbWorkspaceAdminStreamStatus` 只是它的别名），不再另抄 8 个字段。
 */
export interface PsbSessionStreamStatus {
  /** 客户端是否声明 `streaming` 能力（PSB wire `capability`）。 */
  readonly capability: boolean;
  /** 当前是否有采集在跑。 */
  readonly active: boolean;
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  /** PSB wire `encoder`（编码器名，如 `h264`）。 */
  readonly encoder: string | null;
  /** 最近一次采集错误（可读中文，PSB wire `lastErrorZh`），没有则 `null`。 */
  readonly lastErrorZh: string | null;
  /**
   * 该工作区当前桌面会话状态（PSB 加性字段，见 `PSB_DESKTOP_SESSION_STATES`）。
   *
   * `null` = PSB 没给（旧服务端 / 非串流入口）；`undefined` = 调用方构造了旧形状的状态对象。
   * 两种都当「未知」处理，**不得**当成 `none`：那会把「不知道」显示成「没有桌面会话」。
   * 字段可选是刻意的加性兼容——旧调用方（含测试夹具）不需要补字段就能编译。
   */
  readonly desktopSession?: PsbDesktopSessionState | null;
  /**
   * 为什么没有画面（PSB 加性字段，见 `PSB_STREAM_REASON_CODES`）。
   *
   * `null` / `undefined` = PSB 说没有阻塞性问题（在播，或运行中的桌面会话只是暂时没人看），
   * 或者旧服务端没给这个字段。`desktopSession` 能区分这两种情况，不要凭它推断。
   */
  readonly reasonCode?: PsbStreamReasonCode | null;
}

/**
 * 工作区级串流订阅的结果（PSB 0.1.172
 * `POST /api/cindy/remote/workspaces/:workspaceId/stream/subscribe`）。
 *
 * ## `sessionId` 是桌面访问会话，不是 Agent 会话
 *
 * PSB 的框架规则：**Agent 会话只装用户任务**；串流 / 工作区读取 / 访问起停走服务接口。
 * 该端点只解析工作区当前 `running` 的**桌面访问会话**（PSB `remote_sessions.id`）并把句柄
 * 返回给接入端，**不创建任何 Agent 会话**。既有观看端 WS（`…/sessions/:sessionId/stream`）
 * 与 `…/stream/status` 过渡期同时接受 agent 会话 id 与桌面访问会话 id，所以观看端直接用它。
 *
 * ## 生命周期
 *
 * 订阅生命周期 = 观看端 WS 连接（连上即订阅、断开即退订），**没有需要续期的票据**；桌面访问
 * 被重建后旧 id 不再指向 running 会话，按工作区语义重新调用本端点拿新 id 即可，不要把它当
 * 长期句柄保存（Cindy 只把它当「当前观看绑定」持久化，失效就重新订阅）。
 *
 * `streamPath` 是 PSB 建议的 WS 路径（含它生成的订阅参数）；Cindy 观看端自己拼同一条路径并
 * 带本端稳定的 `subscriberId`，这里只保留给诊断，不作为唯一依据。
 */
export interface PsbWorkspaceStreamSubscription {
  readonly sessionId: string;
  readonly streamPath: string | null;
  readonly subscriberId: string | null;
  /** PSB 当前不发放过期时间（订阅生命周期 = WS 连接）；字段保留只为契约兼容。 */
  readonly expiresAt: string | null;
}

/** PSB 错误外壳（与 PSB 既有 `{ error: { code, message, details? } }` 一致）。 */
export interface PsbApiErrorShape {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

/** Cindy 侧对 PSB 错误码的收敛结果（见 PSB 仓 `协作需求.md` PSB-RW-08）。 */
export const PSB_ERROR_CODES = {
  authRequired: 'AUTH_REQUIRED',
  authInvalid: 'AUTH_INVALID',
  authExpired: 'AUTH_EXPIRED',
  identityNotLinked: 'IDENTITY_NOT_LINKED',
  occupiedByOther: 'WORKSPACE_OCCUPIED_BY_OTHER',
  clientOffline: 'CLIENT_OFFLINE',
  notFound: 'NOT_FOUND',
  /** 403「不是归属人」：与 `NOT_FOUND` 同一个处置（不泄漏存在性），单表里按同一 IPC 码映射。 */
  forbidden: 'FORBIDDEN',
  /**
   * CINDY-RW-10 更正版：占用 / 解除占用那一刻的版本控制检查（PSB 已把 `p4 reconcile` 与 git
   * 状态算完）。**三种都是拒绝**，没有 force 分支：
   *
   * - `DIRTY`：检出脏（`error.details.vcs.dirty=true` + 可执行 actions）
   * - `UNAVAILABLE`：无法检查（客户端离线 / 超时）
   * - `UNSUPPORTED`：旧客户端不支持检查
   *
   * 后两种语义是「不能确认干净」，不是「干净」；`retry` 是唯一安全的下一步。
   */
  workspaceVcsDirty: 'WORKSPACE_VCS_DIRTY',
  workspaceVcsUnavailable: 'WORKSPACE_VCS_UNAVAILABLE',
  workspaceVcsUnsupported: 'WORKSPACE_VCS_UNSUPPORTED',
  /**
   * 「这个工作区此刻没有 running 的桌面访问会话」——订阅串流的 409（PSB 0.1.180）。
   *
   * 服务端原文是 `details.code='NO_RUNNING_SESSION'`；Cindy 把它收敛成**自己的**失败码
   * `PSB_STREAM_NO_RUNNING_SESSION`（见 `PSB_CINDY_FAILURE_CODES`），因为下一步动作由
   * `details.state` 决定，而 PSB 的原始码不带这个分支语义。
   */
  noRunningSession: 'NO_RUNNING_SESSION',
} as const;

/**
 * Cindy 自己产出的 PSB 失败码（不是 PSB 的 `error.code`）。
 *
 * 只有「PSB 的事实需要 Cindy 补一层可行动归因」时才出现在这里：原始码不足以表达下一步。
 * 目前唯一一条是订阅串流的 `NO_RUNNING_SESSION`（要按 `details.state` 分文案与自动重试）。
 */
export const PSB_CINDY_FAILURE_CODES = {
  /** 没有 running 桌面访问会话：`failure.streamAccessState` 携带 PSB 的 `details.state`。 */
  streamNoRunningSession: 'PSB_STREAM_NO_RUNNING_SESSION',
} as const;

/* ============ 4b. PSB 失败单表（全部 PSB_* 失败码：唯一手写处，其余全派生） ============ */

/**
 * 用户下一步动作的机器可读分类（渲染层据此选按钮 / 是否自动重试；main 不消费）。
 *
 * 只有「没有 running 桌面访问」三档会被渲染层直接消费
 * （`psbStreamAccessFailureCopyForIpcCode` → `offerOpenWeb` / `retryOnce`）；其余分类是给后续
 * 界面收敛用的语义标注，不在任何 switch 里穷尽。
 */
export type PsbFailureNextStep =
  /** 查看未提交修改详情（或一键清理后重试）——VCS dirty。 */
  | 'inspect-vcs'
  /** 无法确认干净：只能重试检查（没有 force 分支）——VCS unavailable / unsupported。 */
  | 'retry'
  /** 去 PSB 网页启动桌面访问，再回来重试。 */
  | 'open-web-access'
  /** 等访问开始 / 结束落定后重试（此时点「去网页启动」是无效动作）。 */
  | 'wait'
  /** 登录 / 换组织账号后重试（鉴权 / 身份类失败）。 */
  | 'sign-in'
  /** 升级那台电脑上的 PSB 客户端（能力不支持）。 */
  | 'upgrade-client'
  /** 重新读取工作区 / 会话（列表已变、工作区不可见）。 */
  | 'refresh'
  /** 先启动观看，再把输入发出去（本端还没有活动串流连接）。 */
  | 'start-stream'
  /** 去 PSB 网页处理（例如被他人占用时解除占用）。 */
  | 'open-web'
  /** 没有可行动入口（只能读原因 / 联系管理员）。 */
  | 'none';

/** 串流访问三档状态（`none` 是「没有 running 访问」的兜底档）。 */
export type PsbStreamAccessFailureState = 'none' | 'starting' | 'stopping';

/**
 * 一条 PSB 失败的完整描述（`{psbCode, noticeCode, messageKey, state, nextStep, …}`）。
 *
 * 历史上同一事实在六处手写：PSB 原始码 → 文案键（main `psbClient` 的 switch）、
 * `WORKSPACE_VCS_*` 通知码 → 文案键（`psb-workspace-vcs`）、PSB 码 → IPC 码
 * （`psbIpcCodeForFailure` 的 switch）、IPC 码 → 文案键（`PSB_IPC_FAILURE_MESSAGE_KEYS`）、
 * 可写判据的 `PSB_WORKSPACE_WRITABLE_FAILURES`，以及渲染层三档串流访问文案表。六份清单
 * 漏改任一处都**没有编译错误**，只在用户面前表现为英文原文 /「操作失败」。
 *
 * 现在只有本表：可写判据、IPC 码、文案键、通知码、PSB 原始码与串流访问分档全是它的投影
 * （`psbFailureDescriptorFor*` / `psbIpcCodeForFailure` / `PSB_IPC_FAILURE_MESSAGE_KEYS` /
 * `PSB_WORKSPACE_WRITABLE_FAILURES` / `PSB_NO_RUNNING_SESSION_IPC_CODES`）。新增一类失败
 * 只在这里加一行；`ipc-errors.ts` 的 `IpcErrorCode` 仍要单独登记该 IPC 码（那是全仓 IPC 码表），
 * 本表负责「PSB 原始码 / 通知码 / 文案键 / 状态 / 下一步」的对应关系。
 *
 * 表键是**跨 IPC 的 `PSB_*` 码**；不面向用户的本地诊断码（`PSB_PROTOCOL` / `PSB_UNKNOWN` /
 * `PSB_AUTH_LOOP`）刻意不入表（见 `PSB_LOCAL_DIAGNOSTIC_CODES`），它们只进日志与 `INTERNAL`。
 */
export interface PsbFailureDescriptor {
  /** PSB 原始 `error.code`（或 `details.code`）；本地产生的失败则是对端码的同名词。 */
  readonly psbCode: string;
  /**
   * 同一 IPC 码还接受哪些 PSB 原始码（PSB 历史上换过码 / 合并过语义）。
   *
   * 只用于「PSB 码 → IPC 码 / 文案键」的反查，不改变 `psbCode` 的默认地位。
   */
  readonly alsoPsbCodes?: readonly string[];
  /** VCS 通知码（`WORKSPACE_VCS_*`，也是 PSB advisory/409 的 `code`）；非 VCS 家族为 `null`。 */
  readonly noticeCode: string | null;
  /** 本地化文案键（渲染层唯一映射；main 写入 `PsbRemoteFailure.messageKey`）。 */
  readonly messageKey: string;
  /** 「没有 running 桌面访问」三档状态（串流访问家族）；其余为 `null`。 */
  readonly state: PsbStreamAccessFailureState | null;
  /** 用户下一步动作分类（渲染层选按钮 / 是否自动重试）。 */
  readonly nextStep: PsbFailureNextStep;
  /**
   * 同一 PSB 码的**鉴别键**：只有 `PsbRemoteFailure.messageKey` 命中时才选这条描述。
   *
   * 目前只有 `AUTH_REQUIRED` 需要它：个人 membership 签不出 audience（要换组织账号）与未登录
   * （要去登录）是同一个 PSB 码、不同的下一步。鉴别键是数据，代码里不再写 if。
   */
  readonly whenMessageKey?: string;
  /**
   * 该失败在「工作区此刻能不能写」判据里的原因（见 `psbWorkspaceWritable`）。
   *
   * 只有可写判据会产出的四条登记它；`PSB_WORKSPACE_WRITABLE_FAILURES` 由它派生。
   */
  readonly writableReason?: PsbWorkspaceWritabilityReason;
  /** 输入框禁用的文案键（可写失败专用；缺省 = `messageKey`，即同一个事实两个入口同句）。 */
  readonly inputMessageKey?: string;
  /** `message` 字段是否只装占用人名（main 据此插值 `{{name}}`，不放 PSB 原话）。 */
  readonly occupantName?: true;
}

export const PSB_FAILURE_DESCRIPTORS = {
  // ── CINDY-RW-10：版本控制检查（占用 / 解除占用那一刻；0.1.180 advisory 与旧版 409）──
  PSB_WORKSPACE_VCS_DIRTY: {
    psbCode: PSB_ERROR_CODES.workspaceVcsDirty,
    noticeCode: PSB_ERROR_CODES.workspaceVcsDirty,
    messageKey: 'remoteWorkspace.vcs.dirty',
    state: null,
    nextStep: 'inspect-vcs',
  },
  PSB_WORKSPACE_VCS_UNAVAILABLE: {
    psbCode: PSB_ERROR_CODES.workspaceVcsUnavailable,
    noticeCode: PSB_ERROR_CODES.workspaceVcsUnavailable,
    messageKey: 'remoteWorkspace.vcs.unavailable',
    state: null,
    nextStep: 'retry',
  },
  PSB_WORKSPACE_VCS_UNSUPPORTED: {
    psbCode: PSB_ERROR_CODES.workspaceVcsUnsupported,
    noticeCode: PSB_ERROR_CODES.workspaceVcsUnsupported,
    messageKey: 'remoteWorkspace.vcs.unsupported',
    state: null,
    nextStep: 'retry',
  },
  // ── 订阅串流：没有 running 桌面访问（PSB 409 details.code='NO_RUNNING_SESSION'）──
  // 按 details.state 分三档：下一步动作不同，合并成一条会让用户对着「正在启动」做
  // 「去网页启动」。三档共用同一个 PSB 原始码，靠 `state` 而不是 messageKey 鉴别；
  // 反查默认档取 `none`（安全默认：不进自动重试循环）。
  PSB_STREAM_NO_RUNNING_SESSION: {
    psbCode: PSB_ERROR_CODES.noRunningSession,
    noticeCode: null,
    messageKey: 'remoteWorkspace.admin.streamAccessNone',
    state: 'none',
    nextStep: 'open-web-access',
  },
  PSB_STREAM_ACCESS_STARTING: {
    psbCode: PSB_ERROR_CODES.noRunningSession,
    noticeCode: null,
    messageKey: 'remoteWorkspace.admin.streamAccessStarting',
    state: 'starting',
    nextStep: 'wait',
  },
  PSB_STREAM_ACCESS_STOPPING: {
    psbCode: PSB_ERROR_CODES.noRunningSession,
    noticeCode: null,
    messageKey: 'remoteWorkspace.admin.streamAccessStopping',
    state: 'stopping',
    nextStep: 'wait',
  },
  // ── 鉴权 / 身份（`psbAuthFailure` 的唯一映射目标）──
  PSB_AUTH_REQUIRED: {
    psbCode: PSB_ERROR_CODES.authRequired,
    noticeCode: null,
    messageKey: 'remoteWorkspace.error.auth',
    state: null,
    nextStep: 'sign-in',
  },
  PSB_ORG_REQUIRED: {
    psbCode: PSB_ERROR_CODES.authRequired,
    noticeCode: null,
    messageKey: 'remoteWorkspace.error.orgRequired',
    state: null,
    nextStep: 'sign-in',
    // 个人 membership（`resolvePsbConnectionIdentity`）与未登录共用 AUTH_REQUIRED：
    // 文案键是唯一稳定的鉴别依据（见 `psbAuthFailure`）。
    whenMessageKey: 'remoteWorkspace.status.needOrg',
  },
  PSB_AUTH_EXPIRED: {
    psbCode: PSB_ERROR_CODES.authExpired,
    alsoPsbCodes: [PSB_ERROR_CODES.authInvalid],
    noticeCode: null,
    messageKey: 'remoteWorkspace.error.authExpired',
    state: null,
    nextStep: 'sign-in',
  },
  PSB_IDENTITY_NOT_LINKED: {
    psbCode: PSB_ERROR_CODES.identityNotLinked,
    noticeCode: null,
    messageKey: 'remoteWorkspace.error.identityNotLinked',
    state: null,
    nextStep: 'none',
  },
  // ── 工作区可写判据（四条原因；失败文案键与输入禁用键同表）──
  PSB_WORKSPACE_OCCUPIED_BY_OTHER: {
    psbCode: PSB_ERROR_CODES.occupiedByOther,
    noticeCode: null,
    messageKey: 'remoteWorkspace.error.occupiedByOther',
    state: null,
    nextStep: 'open-web',
    writableReason: 'occupied-by-other',
    inputMessageKey: 'remoteWorkspace.error.workspaceOccupied',
    occupantName: true,
  },
  PSB_CLIENT_OFFLINE: {
    psbCode: PSB_ERROR_CODES.clientOffline,
    noticeCode: null,
    messageKey: 'remoteWorkspace.error.clientOffline',
    state: null,
    nextStep: 'retry',
    writableReason: 'client-offline',
  },
  PSB_WORKSPACE_NOT_READY: {
    // 由本地可写判据 / 发送前重建产生（main `workspaceLock` / `sessionRebind`）。
    psbCode: 'WORKSPACE_NOT_READY',
    noticeCode: null,
    messageKey: 'remoteWorkspace.input.workspaceNotReady',
    state: null,
    nextStep: 'wait',
    writableReason: 'workspace-not-ready',
  },
  PSB_AGENT_UNSUPPORTED: {
    // PSB `unusableReason='agent-unsupported'`（`psbWorkspaceWritable` 与发送前重建都遇到）。
    psbCode: 'UNSUPPORTED_CAPABILITY',
    noticeCode: null,
    messageKey: 'remoteWorkspace.badge.agentUnsupported',
    state: null,
    nextStep: 'upgrade-client',
    writableReason: 'agent-unsupported',
  },
  // ── 管理页 stale 上下文（main `adminService` 构造）与通用读口失败 ──
  PSB_WORKSPACE_MISSING: {
    psbCode: 'WORKSPACE_MISSING',
    noticeCode: null,
    messageKey: 'remoteWorkspace.admin.staleMissingAction',
    state: null,
    nextStep: 'refresh',
  },
  PSB_WORKSPACE_UNREACHABLE: {
    psbCode: 'WORKSPACE_UNREACHABLE',
    noticeCode: null,
    messageKey: 'remoteWorkspace.admin.staleUnavailableAction',
    state: null,
    nextStep: 'retry',
  },
  PSB_WORKSPACE_ID_UNKNOWN: {
    psbCode: 'WORKSPACE_ID_UNKNOWN',
    noticeCode: null,
    messageKey: 'remoteWorkspace.admin.staleUnknownWorkspaceAction',
    state: null,
    nextStep: 'refresh',
  },
  PSB_NOT_FOUND: {
    psbCode: PSB_ERROR_CODES.notFound,
    // 403「不是归属人」按找不到呈现（PSB-RW-08：不泄漏会话存在性）。
    alsoPsbCodes: [PSB_ERROR_CODES.forbidden],
    noticeCode: null,
    messageKey: 'remoteWorkspace.admin.staleMissingTitle',
    state: null,
    nextStep: 'refresh',
  },
  PSB_UNREACHABLE: {
    // 本地产生的网络类失败（连不上 / 超时 / 取 token 的签发通道失败）。
    psbCode: 'PSB_UNREACHABLE',
    noticeCode: null,
    messageKey: 'remoteWorkspace.error.unreachable',
    state: null,
    nextStep: 'retry',
  },
  // ── 串流能力 / 本端串流状态 ──
  PSB_STREAM_UNAVAILABLE: {
    // 本地产生的两种「这台电脑不能用串流」：能力缺失 / 会话未就绪（不可恢复或需升级客户端）。
    psbCode: 'PSB_STREAM_UNSUPPORTED',
    alsoPsbCodes: ['PSB_STREAM_NOT_READY'],
    noticeCode: null,
    messageKey: 'remoteWorkspace.session.streamUnsupported',
    state: null,
    nextStep: 'upgrade-client',
  },
  PSB_STREAM_NOT_ACTIVE: {
    // 本端没有活动的串流连接（还没启动 / 已停止 / 已断开）：先启动观看即可恢复。
    psbCode: 'PSB_STREAM_NOT_ACTIVE',
    noticeCode: null,
    messageKey: 'remoteWorkspace.session.streamIdle',
    state: null,
    nextStep: 'start-stream',
  },
} as const satisfies Record<string, PsbFailureDescriptor>;

/** 单表覆盖的 IPC 码（`PSB_*`）。 */
export type PsbDescribedIpcCode = keyof typeof PSB_FAILURE_DESCRIPTORS;

/* 运行期投影：Map 而不是对象查表（属性名来自远端字符串时，原型链会让 `constructor` 之类
 * 命中 `Object.prototype`，返回一个函数当作文案键）。 */
interface PsbFailureEntry {
  readonly ipcCode: PsbDescribedIpcCode;
  readonly descriptor: PsbFailureDescriptor;
}

const PSB_FAILURE_ENTRY_BY_IPC_CODE: ReadonlyMap<string, PsbFailureEntry> = new Map(
  Object.entries(PSB_FAILURE_DESCRIPTORS).map(([ipcCode, descriptor]) => [
    ipcCode,
    { ipcCode: ipcCode as PsbDescribedIpcCode, descriptor: descriptor as PsbFailureDescriptor },
  ]),
);

/**
 * PSB 原始码（含别名）→ 默认条目。
 *
 * 「默认」的取法：跳过 `whenMessageKey` 鉴别条目；串流访问家族只收 `state:'none'` 那一档
 * （`starting` / `stopping` 的正确文案由 `psbNoRunningSessionMessageKey` 按状态取，
 * 不能落成「去网页启动」）。同码多条时先出现者胜，所以表内顺序即默认优先级。
 */
const PSB_FAILURE_ENTRY_BY_PSB_CODE: ReadonlyMap<string, PsbFailureEntry> = (() => {
  const entries = new Map<string, PsbFailureEntry>();
  for (const [ipcCode, descriptor] of Object.entries(PSB_FAILURE_DESCRIPTORS) as Array<
    [PsbDescribedIpcCode, PsbFailureDescriptor]
  >) {
    if (descriptor.whenMessageKey !== undefined) continue;
    if (descriptor.state !== null && descriptor.state !== 'none') continue;
    const entry: PsbFailureEntry = { ipcCode, descriptor };
    for (const psbCode of [descriptor.psbCode, ...(descriptor.alsoPsbCodes ?? [])]) {
      if (!entries.has(psbCode)) entries.set(psbCode, entry);
    }
  }
  return entries;
})();

/** `PSB 码 + messageKey` 鉴别条目（`AUTH_REQUIRED` 的组织变体）。 */
const PSB_FAILURE_ENTRY_BY_PSB_CODE_AND_MESSAGE_KEY: ReadonlyMap<
  string,
  ReadonlyMap<string, PsbFailureEntry>
> = (() => {
  const byPsbCode = new Map<string, Map<string, PsbFailureEntry>>();
  for (const [ipcCode, descriptor] of Object.entries(PSB_FAILURE_DESCRIPTORS) as Array<
    [PsbDescribedIpcCode, PsbFailureDescriptor]
  >) {
    if (descriptor.whenMessageKey === undefined) continue;
    const entry: PsbFailureEntry = { ipcCode, descriptor };
    for (const psbCode of [descriptor.psbCode, ...(descriptor.alsoPsbCodes ?? [])]) {
      const byMessageKey = byPsbCode.get(psbCode) ?? new Map<string, PsbFailureEntry>();
      byMessageKey.set(descriptor.whenMessageKey, entry);
      byPsbCode.set(psbCode, byMessageKey);
    }
  }
  return byPsbCode;
})();

/** psbCode → 条目，只取带 VCS 通知码的那些项（`psb-workspace-vcs` 的通知码表从这里派生）。 */
const PSB_VCS_FAILURE_ENTRY_BY_PSB_CODE: ReadonlyMap<string, PsbFailureEntry> = new Map(
  Object.entries(PSB_FAILURE_DESCRIPTORS).flatMap(([ipcCode, descriptor]) =>
    descriptor.noticeCode === null
      ? []
      : [[descriptor.psbCode, {
          ipcCode: ipcCode as PsbDescribedIpcCode,
          descriptor: descriptor as PsbFailureDescriptor,
        }] as const],
  ),
);

const PSB_STREAM_ACCESS_IPC_CODE_BY_STATE: ReadonlyMap<
  PsbStreamAccessFailureState,
  PsbDescribedIpcCode
> = new Map(
  Object.entries(PSB_FAILURE_DESCRIPTORS).flatMap(([ipcCode, descriptor]) =>
    descriptor.state === null
      ? []
      : [[descriptor.state, ipcCode as PsbDescribedIpcCode] as const],
  ),
);

/**
 * 「没有 running 桌面访问」三档 → IPC 失败码（main 跨 IPC 的唯一携带方式）。
 *
 * 为什么不把 `state` 塞进 message：跨 IPC 只剩 `[CODE] message`，把状态编码进 message 会让
 * 诊断原文变成机器串；本仓既有口径是「语义由码名承载」（见 §8）。三档对应三种下一步：
 * 去 PSB 网页启动访问 / 等启动 / 等结束。
 */
export const PSB_NO_RUNNING_SESSION_IPC_CODES: Readonly<
  Record<PsbStreamAccessFailureState, PsbDescribedIpcCode>
> = {
  none: psbStreamAccessIpcCode('none'),
  starting: psbStreamAccessIpcCode('starting'),
  stopping: psbStreamAccessIpcCode('stopping'),
};

function psbStreamAccessIpcCode(state: PsbStreamAccessFailureState): PsbDescribedIpcCode {
  const ipcCode = PSB_STREAM_ACCESS_IPC_CODE_BY_STATE.get(state);
  // 单表漏一档是编码错误（不是远端输入）：fail fast，别让 IPC 层拿到 undefined。
  if (!ipcCode) throw new Error(`PSB stream access state has no descriptor: ${state}`);
  return ipcCode;
}

/** PSB 原始 VCS 码 → IPC 码（`psbIpcCodeForFailure` 的 VCS 分支，由单表派生）。 */
export function vcsIpcCodeForPsbCode(psbCode: string): PsbDescribedIpcCode | null {
  return PSB_VCS_FAILURE_ENTRY_BY_PSB_CODE.get(psbCode)?.ipcCode ?? null;
}

/** `PSB_*` 描述符（未知码返回 `null`，调用方回落通用失败文案）。 */
export function psbFailureDescriptorForIpcCode(code: string): PsbFailureDescriptor | null {
  return PSB_FAILURE_ENTRY_BY_IPC_CODE.get(code)?.descriptor ?? null;
}

/**
 * PSB 原始码 → 描述符（含别名；串流访问家族返回 `none` 默认档）。
 *
 * main `psbClient` 的「PSB 码 → 文案键」必须走 {@link psbFailureMessageKeyForPsbCode}，
 * 别再在客户端里手写 switch。
 */
export function psbFailureDescriptorForPsbCode(psbCode: string): PsbFailureDescriptor | null {
  return PSB_FAILURE_ENTRY_BY_PSB_CODE.get(psbCode)?.descriptor ?? null;
}

/** PSB 原始码 → 本地化文案键；不认识返回 `null`（调用方回落 `PSB_FAILURE_UNKNOWN_MESSAGE_KEY`）。 */
export function psbFailureMessageKeyForPsbCode(psbCode: string): string | null {
  return psbFailureDescriptorForPsbCode(psbCode)?.messageKey ?? null;
}

/**
 * 「没有 running 桌面访问」一档 → 文案键（main 写进 `PsbRemoteFailure.messageKey`，渲染层按
 * 同一张表拿到同一个键——不会出现「main 说 A、界面显示 B」）。
 */
export function psbNoRunningSessionMessageKey(
  state: PsbWorkspaceAccessState | null | undefined,
): string {
  // 单表保证三档都存在（`psbStreamAccessIpcCode` 缺档会 fail fast），所以直接取键。
  return PSB_FAILURE_DESCRIPTORS[psbNoRunningSessionIpcCode(state)].messageKey;
}

/* ============================== 5. PSB 响应解析（纯函数，主/渲染共用） ============================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * PSB 字符串字段的长度上限（**远端输入边界**）。
 *
 * PSB 的字符串会直通 IPC、日志、本机快照与界面；远端（或中间一层错误响应）给一个几 MB 的
 * `title` / `statusMessage` 没有任何上限时，代价由本机承担。口径与 `stream.cursor` 的
 * `name` 一致（那里已有 {@link PSB_STREAM_CURSOR_MAX_NAME_LENGTH}）：
 *
 * - **展示字段**超限 → 截断（只影响显示的信息量，不影响任何判据）；
 * - **标识字段**超限 → 整行按畸形丢弃（`null`）——截断会让两个不同对象撞成同一个身份，
 *   比丢掉一条畸形行危险得多。
 */
export const PSB_TEXT_LIMITS = {
  /** 标识 / 短码（id、key、personId、目录名、订阅者 id）：超限即畸形。 */
  identity: 128,
  /** 名称 / 标题（工作区 title、客户端名、模板标题、占用人名）。 */
  name: 256,
  /** 可读原因 / 状态消息（PSB 中文原话，需要容纳整句）。 */
  message: 2048,
  /** URL / 文件路径（仅展示，不当本机路径用）。 */
  url: 4096,
  /** 版本号 / 编码器名 / 时间戳文本。 */
  code: 64,
} as const;

/** 展示字段：超限截断（不丢行）。 */
export function readBoundedString(value: unknown, max: number): string | null {
  const text = readString(value);
  if (text === null) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/** 标识字段：空 / 超限都返回 `null`（调用方据此丢行），**绝不截断**。 */
function readIdentityString(value: unknown): string | null {
  const text = readString(value);
  if (text === null || text.length === 0 || text.length > PSB_TEXT_LIMITS.identity) return null;
  return text;
}

function readOccupancy(value: unknown): PsbWorkspaceOccupancy {
  if (!isRecord(value)) {
    return { occupied: false, byMe: false, personId: null, personName: '', occupiedAt: null };
  }
  const personId = readIdentityString(value['personId']);
  return {
    occupied: readBoolean(value['occupied']) || personId !== null,
    byMe: readBoolean(value['byMe']),
    personId,
    personName: readBoundedString(value['personName'], PSB_TEXT_LIMITS.name) ?? '',
    occupiedAt: readNumber(value['occupiedAt']),
  };
}

/**
 * 解析一条工作区行。
 *
 * 为什么手写而不用 zod：renderer 与 main 都要用，而 renderer 目前不引 zod；这里只需要**防崩**
 * （未知/缺字段收敛成安全默认），不做严格校验——严格校验在 PSB 侧。
 * 返回 `null` 表示这一行连 `id` 都没有（或 id 超长），调用方应丢弃它而不是显示一条空行。
 *
 * 枚举未知值（`state` / `unusableReason`）解析成 `null` = 未知，**不回落某个已知状态**：
 * 未知状态是不可写、不可当作「失败」展示的（见 `PsbRemoteWorkspace.state` 注释）。
 */
export function parsePsbRemoteWorkspace(value: unknown): PsbRemoteWorkspace | null {
  if (!isRecord(value)) return null;
  const id = readIdentityString(value['id']);
  if (!id) return null;
  const state = isPsbWorkspaceState(value['state']) ? value['state'] : null;
  const unusableReason = isPsbWorkspaceUnusableReason(value['unusableReason'])
    ? value['unusableReason']
    : null;
  return {
    id,
    title: readBoundedString(value['title'], PSB_TEXT_LIMITS.name) ?? '',
    clientId: readIdentityString(value['clientId']) ?? '',
    clientName: readBoundedString(value['clientName'], PSB_TEXT_LIMITS.name) ?? '',
    clientOnline: readBoolean(value['clientOnline']),
    clientPlatform: readBoundedString(value['clientPlatform'], PSB_TEXT_LIMITS.code),
    state,
    templateKey: readIdentityString(value['templateKey']),
    templateTitle: readBoundedString(value['templateTitle'], PSB_TEXT_LIMITS.name),
    directoryName: readIdentityString(value['directoryName']),
    clientPath: readBoundedString(value['clientPath'], PSB_TEXT_LIMITS.url),
    occupancy: readOccupancy(value['occupancy']),
    usable: readBoolean(value['usable']),
    unusableReason,
    sessionCount: readNumber(value['sessionCount']) ?? 0,
    webUrl: readBoundedString(value['webUrl'], PSB_TEXT_LIMITS.url),
    sessionsWebUrl: readBoundedString(value['sessionsWebUrl'], PSB_TEXT_LIMITS.url),
  };
}

export function parsePsbRemoteClient(value: unknown): PsbRemoteClient | null {
  if (!isRecord(value)) return null;
  const id = readIdentityString(value['id']);
  if (!id) return null;
  const capabilities = isRecord(value['capabilities']) ? value['capabilities'] : {};
  const agents = Array.isArray(value['agents'])
    ? value['agents'].flatMap((entry): PsbRemoteClientAgent[] => {
        if (!isRecord(entry) || !isPsbAgentKind(entry['kind'])) return [];
        return [
          {
            kind: entry['kind'],
            available: readBoolean(entry['available']),
            version: readBoundedString(entry['version'], PSB_TEXT_LIMITS.code),
          },
        ];
      })
    : [];
  return {
    id,
    name: readBoundedString(value['name'], PSB_TEXT_LIMITS.name) ?? '',
    online: readBoolean(value['online']),
    platform: readBoundedString(value['platform'], PSB_TEXT_LIMITS.code),
    capabilities: {
      workspace: readBoolean(capabilities['workspace']),
      agent: readBoolean(capabilities['agent']),
      streaming: readBoolean(capabilities['streaming']),
      exec: readBoolean(capabilities['exec']),
      windows: readBoolean(capabilities['windows']),
    },
    agents,
  };
}

export function parsePsbProjectTemplate(value: unknown): PsbProjectTemplate | null {
  if (!isRecord(value)) return null;
  const key = readIdentityString(value['key']);
  if (!key) return null;
  return {
    key,
    title: readBoundedString(value['title'], PSB_TEXT_LIMITS.name) ?? key,
    description: readBoundedString(value['description'], PSB_TEXT_LIMITS.message),
    checkoutCount: readNumber(value['checkoutCount']) ?? 0,
  };
}

/**
 * 解析一条会话行。
 *
 * **未知枚举不落可写默认**（任务级安全边界）：
 * - `agentKind` 决定数据面隧道 mode：未知 → `null`，不回落 `'claude-code'`（那会用错隧道去连）；
 * - `status` 是「是否终态」的唯一依据，终态会触发发送前透明重建（**远端写**）：
 *   未知 → `null`，不回落 `'failed'`（那会把一条正常会话当成要重建）。
 */
export function parsePsbRemoteSession(value: unknown): PsbRemoteSession | null {
  if (!isRecord(value)) return null;
  const id = readIdentityString(value['id']);
  const workspaceId = readIdentityString(value['workspaceId']);
  if (!id || !workspaceId) return null;
  const agentKind = isPsbAgentKind(value['agentKind']) ? value['agentKind'] : null;
  const status = isPsbSessionStatus(value['status']) ? value['status'] : null;
  const createdBy = isRecord(value['createdBy']) ? value['createdBy'] : {};
  const source = createdBy['source'] === 'web' ? 'web' : 'cindy';
  return {
    id,
    workspaceId,
    clientId: readIdentityString(value['clientId']) ?? '',
    title: readBoundedString(value['title'], PSB_TEXT_LIMITS.name),
    agentKind,
    status,
    statusMessage: readBoundedString(value['statusMessage'], PSB_TEXT_LIMITS.message),
    createdAt: readBoundedString(value['createdAt'], PSB_TEXT_LIMITS.code) ?? '',
    updatedAt: readBoundedString(value['updatedAt'], PSB_TEXT_LIMITS.code) ?? '',
    createdBy: {
      personId: readIdentityString(createdBy['personId']),
      personName: readBoundedString(createdBy['personName'], PSB_TEXT_LIMITS.name) ?? '',
      source,
    },
    webUrl: readBoundedString(value['webUrl'], PSB_TEXT_LIMITS.url),
  };
}

/**
 * 解析 PSB 串流状态（字段名就是 PSB wire 名：`capability` / `encoder` / `lastErrorZh`）。
 *
 * 早期契约草稿的 `capable` / `codec` / `lastError` **不再读取**：它们从未出现在任何已发布
 * PSB 版本（理由与下线记录见 `PsbSessionStreamStatus` 的类型注释）。未知/缺字段按 `null`
 * 或 `false` 收敛——`capability` 缺失时是 `false`（不可启动，安全侧）。
 */
export function parsePsbSessionStreamStatus(value: unknown): PsbSessionStreamStatus {
  if (!isRecord(value)) {
    return {
      capability: false,
      active: false,
      width: null,
      height: null,
      fps: null,
      encoder: null,
      lastErrorZh: null,
      desktopSession: null,
      reasonCode: null,
    };
  }
  // `desktopSession` / `reasonCode` 是 2026-11-26 的**加性字段**：旧服务端不带它们，
  // 解析成 `null`（= 未知）而不是猜一个值；PSB 只下发上面枚举里的词，其它值一律当未知。
  const desktopSession = value['desktopSession'];
  const reasonCode = value['reasonCode'];
  return {
    capability: readBoolean(value['capability']),
    active: readBoolean(value['active']),
    width: readNumber(value['width']),
    height: readNumber(value['height']),
    fps: readNumber(value['fps']),
    encoder: readBoundedString(value['encoder'], PSB_TEXT_LIMITS.code),
    lastErrorZh: readBoundedString(value['lastErrorZh'], PSB_TEXT_LIMITS.message),
    desktopSession: isPsbDesktopSessionState(desktopSession) ? desktopSession : null,
    reasonCode: isPsbStreamReasonCode(reasonCode) ? reasonCode : null,
  };
}

/**
 * 解析工作区级串流订阅的结果。
 *
 * `sessionId` 是唯一的必需字段：没有它这条响应就没有意义（协议违约 → `null`，调用方按
 * `PSB_PROTOCOL` 处理）。`streamPath` / `subscriberId` / `expiresAt` 都是可选诊断字段，缺失
 * 时归一成 `null`，不猜也不报错——PSB 当前不发放 `expiresAt`，`streamPath` 也由本端自己拼。
 */
export function parsePsbWorkspaceStreamSubscription(
  value: unknown,
): PsbWorkspaceStreamSubscription | null {
  if (!isRecord(value)) return null;
  const sessionId = readIdentityString(value['sessionId']);
  if (!sessionId) return null;
  return {
    sessionId,
    streamPath: readBoundedString(value['streamPath'], PSB_TEXT_LIMITS.url),
    subscriberId: readIdentityString(value['subscriberId']),
    expiresAt: readBoundedString(value['expiresAt'], PSB_TEXT_LIMITS.code),
  };
}

/* ===================== 5c. 失败外壳解析（main 的 HTTP / WS 共用一份） ===================== */

/**
 * PSB 失败外壳的字段（失败响应的三种真实形态之一）。
 *
 * PSB 在 Cindy 命名空间统一用 `{ error: { code, message, details? } }`；0.1.180 的
 * `access` 路由（网页命名空间）见过**平铺** `{ code, message, details? }`。两种都读，
 * **只读这两种**，不递归猜别的形状。HTTP 客户端（`psbClient`）与 WS 观看端升级失败
 * （`streamViewer`）必须用同一份解析：两边各写一遍的结果是「同一个失败，HTTP 侧能按码
 * 归因、WS 侧落成操作失败」。
 */
export interface PsbFailureFields {
  readonly code: string | null;
  readonly message: string;
  readonly details: unknown;
}

/** 从已解析的 JSON（任意值）里取失败字段；`error` 优先、平铺兜底。 */
export function readPsbFailureFields(envelope: unknown): PsbFailureFields {
  if (isRecord(envelope)) {
    const nested = envelope['error'];
    if (isRecord(nested)) {
      return {
        code: readBoundedString(nested['code'], PSB_TEXT_LIMITS.code),
        message:
          readBoundedString(nested['message'], PSB_TEXT_LIMITS.message) ?? '',
        details: nested['details'],
      };
    }
    return {
      code: readBoundedString(envelope['code'], PSB_TEXT_LIMITS.code),
      message: readBoundedString(envelope['message'], PSB_TEXT_LIMITS.message) ?? '',
      details: envelope['details'],
    };
  }
  return { code: null, message: '', details: undefined };
}

/**
 * 从原始响应文本（升级失败体的 string）解析失败字段；`null` = 不是 JSON 对象。
 *
 * 调用方拿 `null` 时按 HTTP 状态 / 关闭码归因，绝不从中文里反推机器码。
 */
export function readPsbFailureFieldsFromText(text: string): PsbFailureFields | null {
  if (text.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return readPsbFailureFields(parsed);
}

/* ============================== 5b. 串流宿主光标形状（stream.cursor，2026-11-26） ============================== */

/**
 * ## CINDY-RW-09：映射语义的权威来源、版本与替换点（先读）
 *
 * PSB 已把「`stream.cursor` 形状 → 观看端 CSS」收进 `@psb/shared` 的
 * `packages/shared/src/stream-cursor.ts`（2026-11-26）：`remoteStreamCursorKeywordOf` /
 * `remoteStreamCursorCssOf` / `remoteStreamCursorStyleOf`，形状的边界校验只有
 * `remote-clients.ts` 的 `normalizeRemoteStreamCursorShape` 一份。本文件的
 * {@link PSB_STREAM_CURSOR_CSS_KEYWORDS} / {@link PSB_STREAM_CURSOR_KEYWORD_BY_X11_NAME} /
 * {@link psbStreamCursorKeyword} 是它的**只读副本**，必须与上游逐条一致；本仓**不 import PSB
 * 包**（不引入跨仓依赖），表是带版本注明的契约副本：
 *
 * | 项 | PSB 共享核心（权威） | Cindy（本文件） |
 * | --- | --- | --- |
 * | CSS 关键字白名单 | 36 项 | 同 36 项，逐字相同 |
 * | X11 别名表 | 64 条 | 同 64 条，逐字相同 |
 * | 归一化 | 大小写、首尾空白、`-` / 空格当 `_` | 相同（顺序相同） |
 * | 已是合法关键字 | 直接沿用 | 相同 |
 * | 未知 / 缺 `name` | `default`（**绝不 `none`**） | 相同 |
 * | 非法形状 | `remoteStreamCursorCssOf` → `null` | `psbStreamCursorKeyword` → `null` |
 * | 外观策略 | `system` 默认、`host` 可选位图 | **固定 `system`**（用户 2026-11-26 口径：永远是宿主指针风格），不渲染位图 |
 *
 * **版本 / 来源快照**：PSB 源检出根 `package.json` = **0.1.127**（2026-11-26）；本副本对照的
 * `packages/shared/src/stream-cursor.ts` 在 PSB 工作区**尚未提交**（PSB `git status` 为 `??`，
 * HEAD `edd6d4b`，2026-11-26），因此只能记「工作区快照」而无法引用 commit；网页薄层
 * `packages/web/src/features/remote-clients/stream/cursor-shape.ts` 最近提交 `236926e`
 * （2026-11-26，只保留「写到哪个 DOM 元素」）。PSB shared `stream-cursor.test.ts` 的四类映射 /
 * 别名 / 容错 / 未知回退用例已移植到
 * `shared/__tests__/psbRemoteWorkspaceStreamCursor.test.ts`（同一形状断言同一 CSS 值）。
 *
 * **后续替换点**：PSB 已表示可发布共享包或给出版本化快照（CINDY-RW-09 第 4 点；
 * 跟进项记在 `docs/collaboration/psb-remote-workspace-contract.md` §2）。拿到版本化快照后，把这两
 * 张表与归一化逻辑改为「对照 pinned 快照的差异测试」；若将来允许跨仓依赖，改为 import PSB
 * 共享包、这里只保留 Cindy 特有的 DTO / IPC。**在那之前不要在本文件自行增删别名或改映射顺序**：
 * 改表 = 改协议，必须先改 PSB 共享核心并同批同步
 * `docs/dev-rules/psb-remote-session-transport.md` §12.9（含漂移检查方式）。
 */

/**
 * 宿主光标形状（PSB 中继把客户端上报的宿主光标作为**文本帧**转发给同会话所有观看者）。
 *
 * ## 口径：只同步**形状**，外观永远是宿主（本机）指针风格（2026-11-26 用户确认）
 *
 * 用户原话：「鼠标指针变化不是只同步远程的形态——**鼠标指针的风格仍然保留宿主的风格**。参照
 * PSB 网页实现：**永远使用宿主鼠标指针、永远保持宿主鼠标指针风格**，但串流的**鼠标状态**
 * （形状/形态）需要同步过来」。所以观看端只用 `name`（XFixes 光标名，如 `xterm` / `left_side`）
 * 映射成 **CSS 光标关键字**（`text` / `ew-resize` / `wait`…），外观交给**本机**指针主题渲染；
 * **不再**把 `imageBase64` 拼成 `url("data:image/png;base64,…")` 自定义光标 —— 那会把
 * Windows / macOS 的宿主指针换成 Linux 主题外观（PSB 网页 2026-11-25 真机反馈过同一个问题）。
 *
 * ## 位图 + 热点字段仍然保留，且照旧校验
 *
 * PSB 的上行帧没有变（位图 + 热点 + `name`）；Cindy 解析时照旧做**完整校验**（畸形 / 超限整条
 * 丢弃），只是渲染不使用位图。校验留在协议边界：它是投递形状的入口，未来若真的要做显式
 * 「与宿主完全一致」的降级模式仍以它为准；Cindy 当前**没有**这个模式。
 *
 * ## 契约（PSB 侧常量同名）
 *
 * - `serial` 是 uint32 序号（PSB 生成）。语义是**覆盖**（丢一条没有后果）；Cindy 只拿它去重
 *   **连续重复**的同一条形状，**不按序号丢弃** —— 真机日志证明同一连接里的序号并不严格单调，
 *   旧的「out-of-order 丢弃」会把新形状吃掉（见 main `streamViewer`）；
 * - `width` / `height` ∈ 1..{@link PSB_STREAM_CURSOR_MAX_SIZE}；
 * - `xhot < width`、`yhot < height`（热点允许为 0，即左上角）；
 * - `imageBase64` 是 PNG 的 base64，长度 ≤ {@link PSB_STREAM_CURSOR_MAX_BASE64_LENGTH}；
 * - `name` 可选（XFixes 光标名），**是观看端唯一使用的字段**；长度不设上限地信任它没有价值，
 *   解析时截断。
 */
export interface PsbStreamCursorShape {
  /** uint32 序号（PSB 生成）；只用于去重连续重复形状，**不保证严格单调**，消费方不得按它丢弃。 */
  readonly serial: number;
  readonly width: number;
  readonly height: number;
  /** 热点（相对位图左上角的像素坐标），必须小于尺寸。 */
  readonly xhot: number;
  readonly yhot: number;
  /** PNG 图片的 base64（不含 `data:` 前缀、不含 MIME）；观看端不用它渲染，但仍校验。 */
  readonly imageBase64: string;
  /** XFixes 光标名（如 `xterm` / `left_side`）；**观看端唯一使用的字段**（映射成 CSS 关键字）。 */
  readonly name?: string;
}

/** 光标位图边长上限（PSB `REMOTE_STREAM_CURSOR_MAX_SIZE`）。 */
export const PSB_STREAM_CURSOR_MAX_SIZE = 64;

/** 光标 PNG base64 字符串长度上限（PSB `REMOTE_STREAM_CURSOR_MAX_BASE64_LENGTH`，48 KiB）。 */
export const PSB_STREAM_CURSOR_MAX_BASE64_LENGTH = 48 * 1024;

/** 光标文本帧的 `type`（PSB 契约；与上行 `kind:'input'` 是两条不同的文本帧）。 */
export const PSB_STREAM_CURSOR_TEXT_FRAME_TYPE = 'stream.cursor';

/** `name` 的截断长度：只用于排障属性与关键字映射，不参与任何持久化，不给它无界增长的机会。 */
export const PSB_STREAM_CURSOR_MAX_NAME_LENGTH = 64;

/** base64 字符集（不含空白/引号/括号：即使将来要拼回 `url()`，也没有可以闭合字符串的字符）。 */
const PSB_CURSOR_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function isUint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function isCursorDimension(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= PSB_STREAM_CURSOR_MAX_SIZE
  );
}

/**
 * 校验并归一一条光标形状（`parsePsbStreamCursorTextFrame` 与 `psbStreamCursorKeyword` 共用）。
 *
 * 严格的理由：形状是远端输入，观看端不能假设 PSB 与中间层永远守约。即使当前只把 `name` 映射成
 * CSS 关键字、不再拼位图 `url()`，也不放宽尺寸 / 热点 / base64 字符集的上限：形状通过校验才
 * 算合法（渲染层据此区分「合法的 default 形状」与「畸形数据」，后者保持现状、不写坏值）。
 * 任一字段不合规都整条丢弃（形状语义是覆盖，丢一条无后果）。
 */
function readCursorShape(value: unknown): PsbStreamCursorShape | null {
  if (!isRecord(value)) return null;
  const serial = value['serial'];
  if (!isUint32(serial)) return null;
  const width = value['width'];
  const height = value['height'];
  if (!isCursorDimension(width) || !isCursorDimension(height)) return null;
  const xhot = value['xhot'];
  const yhot = value['yhot'];
  if (!isUint32(xhot) || !isUint32(yhot) || xhot >= width || yhot >= height) return null;
  const imageBase64 = value['imageBase64'];
  if (typeof imageBase64 !== 'string') return null;
  if (imageBase64.length === 0 || imageBase64.length > PSB_STREAM_CURSOR_MAX_BASE64_LENGTH) {
    return null;
  }
  // 字符集之外还需要「长度 % 4 ≠ 1」：`A` 这类残串逐字符合法但不是可解码的 base64。
  if (imageBase64.length % 4 === 1 || !PSB_CURSOR_BASE64_PATTERN.test(imageBase64)) return null;
  const rawName = value['name'];
  const name =
    typeof rawName === 'string' && rawName.length > 0
      ? rawName.slice(0, PSB_STREAM_CURSOR_MAX_NAME_LENGTH)
      : undefined;
  return { serial, width, height, xhot, yhot, imageBase64, ...(name ? { name } : {}) };
}

/**
 * 解析一条 PSB 文本帧为光标形状；不是 `stream.cursor` 或字段不合规返回 `null`。
 *
 * 调用方（main `streamViewer.handleTextMessage`）据此决定 push / 丢弃；**不抛错**，
 * 非法文本帧只记 debug，绝不进入二进制帧路径。
 */
export function parsePsbStreamCursorTextFrame(record: unknown): PsbStreamCursorShape | null {
  if (!isRecord(record)) return null;
  if (record['type'] !== PSB_STREAM_CURSOR_TEXT_FRAME_TYPE) return null;
  return readCursorShape(record);
}

/**
 * 合法 CSS 光标关键字白名单（`psbStreamCursorKeyword` 只会输出这里面的词）。
 *
 * 形状名来自远端，不能把任意字符串直接写进 `style.cursor`；只放行「浏览器认识的固定词汇」，
 * 未知一律 {@link DEFAULT_PSB_STREAM_CURSOR_KEYWORD}。多一项不会坏（浏览器忽略未知值），
 * 少一项会退化成箭头。
 *
 * **与 PSB `@psb/shared` 的 `stream-cursor.ts` 逐字相同**（`REMOTE_STREAM_CURSOR_CSS_KEYWORDS`，
 * 36 项；PSB 0.1.127 / 2026-11-26 工作区快照，见本节文件头「CINDY-RW-09」）。历史：先移植自
 * PSB 网页 `remote-clients/stream/cursor-shape.ts`（2026-11-26），PSB 当天把表上收到共享核心，
 * 网页只留 DOM 落点——所以权威来源是共享核心，不是网页。两个观看端必须从同一张表得到同一个
 * 光标，本文件照抄，不自行增删。
 */
export const PSB_STREAM_CURSOR_CSS_KEYWORDS: ReadonlySet<string> = new Set([
  'auto',
  'default',
  'none',
  'context-menu',
  'help',
  'pointer',
  'progress',
  'wait',
  'cell',
  'crosshair',
  'text',
  'vertical-text',
  'alias',
  'copy',
  'move',
  'no-drop',
  'not-allowed',
  'grab',
  'grabbing',
  'all-scroll',
  'col-resize',
  'row-resize',
  'n-resize',
  'e-resize',
  's-resize',
  'w-resize',
  'ne-resize',
  'nw-resize',
  'se-resize',
  'sw-resize',
  'ew-resize',
  'ns-resize',
  'nesw-resize',
  'nwse-resize',
  'zoom-in',
  'zoom-out',
]);

/**
 * X11/XFixes 光标名 → CSS 关键字（`name` 本身不是关键字时查这张表）。
 *
 * 宿主是 Linux/Xvfb，XFixes 给的是 X 主题里的名字（`xterm` / `right_side` /
 * `sb_h_double_arrow`…），CSS 关键字是另一套词汇。直接搬宿主位图会把观看端用户的指针换成
 * Linux 外观（用户明确反对），所以只做关键字映射、外观交给本机主题。
 *
 * **与 PSB `@psb/shared` 的 `stream-cursor.ts` 逐字相同**
 * （`REMOTE_STREAM_CURSOR_KEYWORD_BY_X11_NAME`，64 条；PSB 0.1.127 / 2026-11-26 工作区快照）。
 * 表的来源是 PSB 打包机（Fedora 默认主题 `psb-cursor -once` 实测）+ X11 常见别名（cursorfont.h /
 * 各主题惯用名），覆盖 I-beam / 手形 / resize / 忙等待四类用户可感知场景。**表外 → `default`**；
 * 归一化（大小写 / 首尾空白 / `-` / 空格当 `_`）与「名字本身已是关键字直接沿用」在
 * {@link psbStreamCursorKeyword}，顺序与共享核心相同。
 *
 * **改动必须与 PSB 同步**：这张表是两个观看端「同一个远端看起来是同一种鼠标」的唯一保证；
 * PSB 侧改表后按 `docs/dev-rules/psb-remote-session-transport.md` §12.9 的漂移检查逐条对照。
 */
export const PSB_STREAM_CURSOR_KEYWORD_BY_X11_NAME: Readonly<Record<string, string>> = {
  // 文本 / 箭头 / 手形
  xterm: 'text',
  text: 'text',
  vertical_text: 'vertical-text',
  default: 'default',
  left_ptr: 'default',
  arrow: 'default',
  top_left_arrow: 'default',
  hand1: 'pointer',
  hand2: 'pointer',
  pointer: 'pointer',
  pointing_hand: 'pointer',
  // 十字 / 单元格
  crosshair: 'crosshair',
  cross: 'crosshair',
  tcross: 'crosshair',
  cell: 'cell',
  // 水平 / 垂直缩放
  left_side: 'ew-resize',
  right_side: 'ew-resize',
  sb_h_double_arrow: 'ew-resize',
  size_hor: 'ew-resize',
  top_side: 'ns-resize',
  bottom_side: 'ns-resize',
  sb_v_double_arrow: 'ns-resize',
  size_ver: 'ns-resize',
  // 四个角（↘↙ diagonals）
  top_left_corner: 'nwse-resize',
  bottom_right_corner: 'nwse-resize',
  fd_double_arrow: 'nwse-resize',
  size_fdiag: 'nwse-resize',
  top_right_corner: 'nesw-resize',
  bottom_left_corner: 'nesw-resize',
  bd_double_arrow: 'nesw-resize',
  size_bdiag: 'nesw-resize',
  // 单方向箭头
  up_arrow: 'n-resize',
  down_arrow: 's-resize',
  left_arrow: 'w-resize',
  right_arrow: 'e-resize',
  // 移动 / 抓取 / 禁止 / 帮助 / 忙碌 / 缩放
  fleur: 'move',
  move: 'move',
  grabbing: 'grabbing',
  openhand: 'grab',
  grab: 'grab',
  not_allowed: 'not-allowed',
  forbidden: 'not-allowed',
  crossed_circle: 'not-allowed',
  no_drop: 'no-drop',
  help: 'help',
  question_arrow: 'help',
  whats_this: 'help',
  wait: 'wait',
  watch: 'wait',
  progress: 'progress',
  left_ptr_watch: 'progress',
  half_busy: 'progress',
  zoom_in: 'zoom-in',
  zoom_out: 'zoom-out',
  col_resize: 'col-resize',
  row_resize: 'row-resize',
  all_scroll: 'all-scroll',
  context_menu: 'context-menu',
  copy: 'copy',
  alias: 'alias',
  dnd_copy: 'copy',
  dnd_move: 'move',
  dnd_link: 'alias',
  dnd_no_drop: 'no-drop',
};

/** 未知 / 缺省形状的 CSS 关键字：箭头。不要改成 `none`（那会让指针在画面里消失）。 */
export const DEFAULT_PSB_STREAM_CURSOR_KEYWORD = 'default';

/**
 * 别名表的 Map 视图（查表用）。
 *
 * **不能**直接 `PSB_STREAM_CURSOR_KEYWORD_BY_X11_NAME[name]`：`name` 来自远端文本帧，
 * `constructor` / `__proto__` / `toString` 这类名字会命中 `Object.prototype`，把一个函数当作
 * CSS 关键字返回（`?? default` 兜不住 truthy 的函数）。Map 只认自有键。
 */
const PSB_CURSOR_KEYWORD_BY_X11_NAME_MAP: ReadonlyMap<string, string> = new Map(
  Object.entries(PSB_STREAM_CURSOR_KEYWORD_BY_X11_NAME),
);

/**
 * 形状 → 宿主光标名（XFixes 的 `name`，如 `xterm`）；缺省 / 空白时 `null`。
 *
 * 只归一字符串原值，不做映射 ——「这个形状叫什么」（排障属性用）与「它该显示成什么」（见
 * {@link psbStreamCursorKeyword}）是两件事。
 */
export function psbStreamCursorName(shape: PsbStreamCursorShape): string | null {
  const name = shape.name;
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 形状 → CSS 光标关键字（渲染层写进**画面区域**的 `style.cursor`）。
 *
 * 规则与 PSB `@psb/shared` 的 `stream-cursor.ts`（2026-11-26 共享核心）**逐条一致**；本函数
 * 的完整语义 = 共享核心 `remoteStreamCursorCssOf(shape)`（默认 `system` 策略）：
 * 1. `name` 归一：大小写、首尾空白、`-` / 空格当 `_`；
 * 2. 归一后本身已是合法 CSS 关键字 → 直接沿用（`zoom-in` / `col-resize` 之类不必进表）；
 * 3. 否则查 X11→CSS 别名表（{@link PSB_STREAM_CURSOR_KEYWORD_BY_X11_NAME}）；
 * 4. 未知 / 缺 `name` → {@link DEFAULT_PSB_STREAM_CURSOR_KEYWORD}（箭头，**绝不 `none`**）；
 * 5. **形状不合法 → `null`**（对应共享核心 `remoteStreamCursorCssOf` 对非法形状返回 `null`）：
 *    调用方不写样式、保持现状（远端畸形数据不能伪造出一个光标）。
 *
 * 外观由本机指针主题渲染（永远是宿主风格）：这里只变**形态**，不复刻远端位图。PSB 共享核心还有
 * 一个显式 `host` 位图策略（`url("data:image/png;base64,…") <xhot> <yhot>, auto`），Cindy 当前
 * **没有**实现也不使用（用户口径是永远保持宿主指针风格）；将来若要做，CSS 值必须照
 * `remoteStreamCursorCssOf(shape, 'host')` 拼，不自行发明格式。
 */
export function psbStreamCursorKeyword(shape: PsbStreamCursorShape): string | null {
  const valid = readCursorShape(shape);
  if (!valid) return null;
  const name = psbStreamCursorName(valid);
  if (name === null) return DEFAULT_PSB_STREAM_CURSOR_KEYWORD;
  const normalized = name.toLowerCase();
  if (PSB_STREAM_CURSOR_CSS_KEYWORDS.has(normalized)) return normalized;
  // X11 名用下划线、人写的别名常用连字符/空格：查表前统一成下划线。
  const aliased = normalized.replaceAll('-', '_').replaceAll(' ', '_');
  if (PSB_STREAM_CURSOR_CSS_KEYWORDS.has(aliased)) return aliased;
  return PSB_CURSOR_KEYWORD_BY_X11_NAME_MAP.get(aliased) ?? DEFAULT_PSB_STREAM_CURSOR_KEYWORD;
}

/**
 * 4004 `notReady` 关闭原因里的**结构化前缀**（PSB `cindyRemoteStreamCloseReasonWithDetails`）。
 *
 * 线上形态是 `{"reasonCode":"NO_DESKTOP_SESSION","desktopSession":"none"}|<一句中文>`：
 * `|` 前是 ASCII JSON（机器读、永不截断），`|` 后是给人看的中文（可能被 PSB 截断到 WS
 * close reason 的字节上限）。PSB 的中继自身也会用 4004（慢订阅者被断开），那条**没有**
 * 这个前缀——所以「有没有结构」就是两种 4004 的第一条分界线，不要靠中文猜。
 *
 * 不是结构前缀（不以 `{` 开头 / JSON 解析失败 / 对象里没有这两个键）→ `null`，调用方按
 * 旧行为只当人话处理。
 */
export interface PsbStreamCloseReasonDetails {
  /** 结构里的机器码；PSB 给了未知值时 `null`（仍算「有结构前缀」）。 */
  readonly reasonCode: PsbStreamReasonCode | null;
  /** 结构里的桌面会话状态；PSB 给了未知值时 `null`。 */
  readonly desktopSession: PsbDesktopSessionState | null;
  /** `|` 之后的中文原因；没有中文部分时 `null`。 */
  readonly messageZh: string | null;
}

/** `PsbStreamCloseReasonDetails` 的结构部分与中文部分之间的分隔符（与 PSB 同一常量）。 */
export const PSB_STREAM_CLOSE_REASON_DETAILS_SEPARATOR = '|';

export function parsePsbStreamCloseReason(
  reason: string,
): PsbStreamCloseReasonDetails | null {
  const trimmed = reason.trim();
  if (!trimmed.startsWith('{')) return null;
  const separator = trimmed.indexOf(PSB_STREAM_CLOSE_REASON_DETAILS_SEPARATOR);
  const jsonPart = separator < 0 ? trimmed : trimmed.slice(0, separator);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPart);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const hasReasonCode = 'reasonCode' in parsed;
  const hasDesktopSession = 'desktopSession' in parsed;
  if (!hasReasonCode && !hasDesktopSession) return null;
  const tail = separator < 0 ? '' : trimmed.slice(separator + 1).trim();
  return {
    reasonCode: isPsbStreamReasonCode(parsed['reasonCode']) ? parsed['reasonCode'] : null,
    desktopSession: isPsbDesktopSessionState(parsed['desktopSession'])
      ? parsed['desktopSession']
      : null,
    // 关闭原因是界面可见的诊断文本，与其它 PSB 可读原因同一上限（防畸形载荷撑爆日志/IPC）。
    messageZh: tail.length > 0 ? tail.slice(0, PSB_TEXT_LIMITS.message) : null,
  };
}

/* ============================== 6. 展示口径（纯函数） ============================== */

/**
 * 会话行徽标口径（用户明确要求：状态标签 + 锁）。
 *
 * - `tone: 'ok'`   机器在线、工作区就绪、未被他人占用 —— 可以开会话；
 * - `tone: 'warn'` 工作区被**别人**占用 —— 橙色「不可用」，输入框置灰；
 * - `tone: 'bad'`  机器离线或工作区失败 —— 红色「离线 / 失败」；
 * - `tone: 'idle'` 工作区还在检出等中间态 —— 灰色；
 * - `lock: 'mine'` 被**我**占用 —— 锁图标亮起（这是"独占工作区"的直接反馈）；
 * - `lock: 'other'` 被别人占用 —— 锁图标显示为被占用但不可用样式；
 * - `lock: 'none'` 未占用。
 */
export type PsbWorkspaceTone = 'ok' | 'warn' | 'bad' | 'idle';

export type PsbWorkspaceLockState = 'none' | 'mine' | 'other';

export interface PsbWorkspaceHealth {
  readonly tone: PsbWorkspaceTone;
  readonly lock: PsbWorkspaceLockState;
  /** 是否可以在这个工作区上开新会话（与 PSB 下发的 `usable` 合并后仍为 false 时禁用）。 */
  readonly canStartSession: boolean;
  /** 状态标签要用的 i18n key（`remoteWorkspace.badge.*`），渲染层只做翻译。 */
  readonly badgeKey: string;
}

export function psbWorkspaceLockState(
  occupancy: PsbWorkspaceOccupancy,
): PsbWorkspaceLockState {
  if (!occupancy.occupied) return 'none';
  return occupancy.byMe ? 'mine' : 'other';
}

/**
 * 工作区徽标口径（用户明确要求：状态标签 + 锁）。
 *
 * **单一可写判据**：`canStartSession` 与「为什么不能开」都来自 {@link psbWorkspaceWritable}
 * （PSB 的 `usable` / `unusableReason` 权威 + 本地字段兜底），本函数只负责把原因翻成
 * tone / badgeKey，不再自己拼 `state === 'ready' && ...`（那是本批收敛掉的三份重算之一）。
 *
 * - `tone: 'ok'`   可以开会话；
 * - `tone: 'warn'` 被**别人**占用；
 * - `tone: 'bad'`  机器离线 / 工作区失败；
 * - `tone: 'idle'` 未就绪 / 客户端缺运行时等中间态。
 */
export function psbWorkspaceHealth(workspace: PsbWorkspaceWritabilityInput): PsbWorkspaceHealth {
  const lock = psbWorkspaceLockState(workspace.occupancy);
  const writable = psbWorkspaceWritable(workspace, { requireAgentRuntime: true });
  switch (writable.reason) {
    case 'agent-unsupported':
      return {
        tone: 'idle',
        lock,
        canStartSession: false,
        badgeKey: 'remoteWorkspace.badge.agentUnsupported',
      };
    case 'occupied-by-other':
      return { tone: 'warn', lock, canStartSession: false, badgeKey: 'remoteWorkspace.badge.occupied' };
    case 'client-offline':
      return { tone: 'bad', lock, canStartSession: false, badgeKey: 'remoteWorkspace.badge.offline' };
    case 'workspace-not-ready':
      // PSB 权威只说「不可写」；具体是失败还是中间态仍看本地状态词（缺字段时按中间态）。
      return workspace.state === 'failed'
        ? { tone: 'bad', lock, canStartSession: false, badgeKey: 'remoteWorkspace.badge.failed' }
        : { tone: 'idle', lock, canStartSession: false, badgeKey: 'remoteWorkspace.badge.pending' };
    case null:
      return { tone: 'ok', lock, canStartSession: writable.ok, badgeKey: 'remoteWorkspace.badge.online' };
  }
}

/**
 * 工作区「现在能不能写」的**唯一判据**（main 的三条写入口与渲染层的可点判据共用）。
 *
 * ## 为什么必须只有一份
 *
 * 「能不能开新会话 / 启动串流 / 发消息」在 main 有三处会判断（占用闸门 `workspaceLock`、
 * 发送前重建 `sessionRebind`、渲染层禁用态 `psbWorkspaceHealth`）。历史上这三处各写一遍
 * `clientOnline` / `state === 'ready'` / `occupancy` 的组合，**都漏读了 PSB 权威字段
 * `usable`**（PSB 已经把「占用 + 状态 + 在线 + 客户端能力」算好，见
 * `PSB_WORKSPACE_UNUSABLE_REASONS`）：结果是 PSB 说「不能开新会话」时 Cindy 仍然放行，
 * 用户只能等 PSB 拒绝后看到一句不可行动的失败。判据收在这一处，调用方只消费结果。
 *
 * ## 为什么区分 `requireAgentRuntime`
 *
 * `unusableReason='agent-unsupported'` 只否定**新建 Agent 会话**；占位 / 启动串流是
 * 工作区级写操作，与那台机器装没装某个 Harness 无关。把两者混成一个「不可写」会让
 * 串流按钮被无关原因锁死。因此默认按「要开 Agent 会话」的严格口径，工作区级写入口
 * 显式传 `false`。
 *
 * 返回值里的 `ipcCode` / `messageKey` 来自 §4b 的失败单表（可写原因只是它的一列）：main 抛
 * `PsbClientError` 前用它，跨进程后渲染层按同一张表的 IPC 码投影又能查到同一个键——
 * 不会出现「main 说 A、界面显示 B」。
 */
export type PsbWorkspaceWritabilityReason =
  | 'occupied-by-other'
  | 'client-offline'
  | 'workspace-not-ready'
  | 'agent-unsupported';

export interface PsbWorkspaceWritability {
  readonly ok: boolean;
  /** `ok:true` 时恒为 `null`。 */
  readonly reason: PsbWorkspaceWritabilityReason | null;
  /** 跨 IPC 的失败码（`ok:true` 时 `null`）。 */
  readonly ipcCode: PsbIpcFailureCode | null;
  /** i18n 文案键（`ok:true` 时 `null`）。 */
  readonly messageKey: string | null;
  /** 被他人占用时的占用人名（其余情况 `''`）。 */
  readonly personName: string;
  /** 工作区状态（未就绪文案的参数来源；未知时 `null`）。 */
  readonly state: PsbWorkspaceState | null;
  /**
   * 同一原因的「会话输入禁用」文案键（`remoteWorkspace.error.*`；工作区未就绪用
   * `remoteWorkspace.input.workspaceNotReady`）。
   *
   * 输入框置灰的文案与按钮失败文案是**同一个事实的两个入口**（offline / occupied 的措辞不同），
   * 所以两套键登记在同一张表里，`psbSessionInputAllowed` 不再自己拼第二套判据。
   * `ok:true` 时为 `null`。
   */
  readonly inputMessageKey: string | null;
}

/** 工作区可写判据需要的字段（`PsbRemoteWorkspace` 的子集，快照/会话行自带的部分也能传）。 */
export type PsbWorkspaceWritabilityInput = Pick<
  PsbRemoteWorkspace,
  'state' | 'clientOnline' | 'occupancy' | 'usable' | 'unusableReason'
>;

/**
 * 可写判据的四条原因 → IPC 码 / 文案键（**单表投影**，见 §4b 的 `PSB_FAILURE_DESCRIPTORS`）。
 *
 * 同一原因有两个消费面（操作失败 + 输入框置灰），两套键都登记在单表里：新增 / 改名一处生效，
 * 不会出现「按钮说 A、输入框说 B」。
 */
const PSB_WORKSPACE_WRITABLE_FAILURES: Record<
  PsbWorkspaceWritabilityReason,
  { readonly ipcCode: PsbIpcFailureCode; readonly messageKey: string; readonly inputMessageKey: string }
> = (() => {
  const failures = Object.fromEntries(
    Object.entries(PSB_FAILURE_DESCRIPTORS).flatMap(([ipcCode, rawDescriptor]) => {
      const descriptor = rawDescriptor as PsbFailureDescriptor;
      return descriptor.writableReason === undefined
        ? []
        : [[descriptor.writableReason, {
            ipcCode: ipcCode as PsbIpcFailureCode,
            messageKey: descriptor.messageKey,
            inputMessageKey: descriptor.inputMessageKey ?? descriptor.messageKey,
          }] as const];
    }),
  ) as Record<
    PsbWorkspaceWritabilityReason,
    { readonly ipcCode: PsbIpcFailureCode; readonly messageKey: string; readonly inputMessageKey: string }
  >;
  // 单表漏一条可写原因是编码错误（不是远端输入）：fail fast，别让界面拿到 undefined。
  for (const reason of [
    'occupied-by-other',
    'client-offline',
    'workspace-not-ready',
    'agent-unsupported',
  ] as const) {
    if (!failures[reason]) throw new Error(`PSB writable failure has no descriptor: ${reason}`);
  }
  return failures;
})();

/** 组装一个「不可写」结果。 */
function psbUnwritable(
  reason: PsbWorkspaceWritabilityReason,
  input: PsbWorkspaceWritabilityInput,
): PsbWorkspaceWritability {
  const failure = PSB_WORKSPACE_WRITABLE_FAILURES[reason];
  return {
    ok: false,
    reason,
    ipcCode: failure.ipcCode,
    messageKey: failure.messageKey,
    personName: reason === 'occupied-by-other' ? input.occupancy.personName.trim() : '',
    state: input.state,
    inputMessageKey: failure.inputMessageKey,
  };
}

/**
 * 工作区此刻能不能写（见类型注释的「为什么必须只有一份」）。
 *
 * 判据顺序刻意固定：**先信 PSB 的 `usable` / `unusableReason`**（那是服务端算好的完整口径），
 * 再用本地字段兜底（旧服务端 / 快照里 `usable` 与状态不一致时仍给出可行动原因）。
 */
export function psbWorkspaceWritable(
  workspace: PsbWorkspaceWritabilityInput,
  options: { requireAgentRuntime?: boolean } = {},
): PsbWorkspaceWritability {
  const requireAgentRuntime = options.requireAgentRuntime ?? true;
  const reason = workspace.unusableReason;
  if (reason === 'agent-unsupported') {
    if (requireAgentRuntime) return psbUnwritable('agent-unsupported', workspace);
  } else if (reason === 'occupied-by-other') {
    return psbUnwritable('occupied-by-other', workspace);
  } else if (reason === 'client-offline') {
    return psbUnwritable('client-offline', workspace);
  } else if (reason === 'workspace-not-ready') {
    return psbUnwritable('workspace-not-ready', workspace);
  } else if (!workspace.usable && requireAgentRuntime) {
    // `usable:false` 但没有（认识的）原因：PSB 说不能开新会话，具体原因 Cindy 不猜。
    // 工作区级写入口（`requireAgentRuntime:false`）不看这个字段：它描述的是「开新会话」。
    return psbUnwritable('workspace-not-ready', workspace);
  }

  if (psbWorkspaceLockState(workspace.occupancy) === 'other') {
    return psbUnwritable('occupied-by-other', workspace);
  }
  if (!workspace.clientOnline) return psbUnwritable('client-offline', workspace);
  if (workspace.state !== 'ready') return psbUnwritable('workspace-not-ready', workspace);
  return {
    ok: true,
    reason: null,
    ipcCode: null,
    messageKey: null,
    personName: '',
    state: workspace.state,
    inputMessageKey: null,
  };
}

/**
 * 会话输入是否允许（`false` 时输入框置灰）。
 *
 * **判据是同一个** {@link psbWorkspaceWritable}（`requireAgentRuntime: false`）：发消息不是
 * 「开新 Agent 会话」，所以 `agent-unsupported` 不阻断既有会话的输入；但「被他人占用 /
 * 客户端离线 / 工作区未就绪」必须与开新会话同一口径（历史上这里自己拼了一套，与 PSB 权威
 * 字段 `usable` 漂移）。
 *
 * **终态不阻断输入**：PSB 的会话终态不可逆转，但 Cindy 在用户下一次发送时会透明地
 * 在同一工作区新建一条 PSB 会话、重绑本地任务并发起这一轮（见
 * `docs/dev-rules/psb-remote-session-transport.md` §6）。所以「这个任务已经结束」
 * 不是真实状态——本地任务还在，只是底层 PSB 会话换了。
 *
 * `session` 参数保留在形状里（调用方与渲染层都按会话对象传），但不再参与判据；
 * 「这条会话下次发送会不会重建」用 `psbSessionNeedsRebind(session.status)` 单独问。
 */
export function psbSessionInputAllowed(input: {
  readonly session: PsbRemoteSession;
  readonly workspace: PsbWorkspaceWritabilityInput;
}): { readonly allowed: boolean; readonly reason: string | null } {
  const writable = psbWorkspaceWritable(input.workspace, { requireAgentRuntime: false });
  return { allowed: writable.ok, reason: writable.inputMessageKey };
}

/* ============================== 7. IPC 通道与 DTO ============================== */

/**
 * renderer ↔ main 通道名。
 *
 * 命名沿用仓库既有 `feature:sub:action` 约定（对照 `meka-settings:router:*`）。
 * 新增/改名要同时改 preload 白名单与 main 侧 handler 注册，见 `docs/dev-rules/` IPC 约定。
 */
export const PSB_REMOTE_CHANNELS = {
  /** 当前身份是否可用（登录态 + 组织 + PSB 连通性探测）。 */
  STATUS: 'psb-remote:status',
  /** 可用工作区列表（含被他人占用行，供列表展示与禁用）。 */
  LIST_WORKSPACES: 'psb-remote:list-workspaces',
  /** 可见远程客户端列表（新建工作区第一步）。 */
  LIST_CLIENTS: 'psb-remote:list-clients',
  /** 项目模板列表（新建工作区第二步）。 */
  LIST_TEMPLATES: 'psb-remote:list-templates',
  /** 新建工作区（选择客户端 + 模板）。 */
  CREATE_WORKSPACE: 'psb-remote:create-workspace',
  /** 占用工作区（协作锁）。 */
  OCCUPY_WORKSPACE: 'psb-remote:occupy-workspace',
  /** 释放工作区（自己占用时）。 */
  RELEASE_WORKSPACE: 'psb-remote:release-workspace',
  /** 在某工作区上创建 PSB 会话（返回的 id 用于拼 `psb:` 身份）。 */
  CREATE_SESSION: 'psb-remote:create-session',
  /** 工作区级状态刷新（会话徽标、锁、在线）。 */
  REFRESH_WORKSPACES: 'psb-remote:refresh-workspaces',
  /** 单个会话的 PSB 状态（详情/空闲/失败原因）。 */
  SESSION_STATUS: 'psb-remote:session-status',
  /** 停止 PSB 会话（结束本地会话/退出登录/放弃草稿时）。 */
  STOP_SESSION: 'psb-remote:stop-session',
  /** 在系统浏览器里打开 PSB 网页工作区页面。 */
  OPEN_WEB_WORKSPACE: 'psb-remote:open-web-workspace',
  /**
   * 会话结束 → 归还它占用的 PSB 工作区（幂等、可重试）。
   *
   * 入参与 main 的 `releasePsbWorkspaceForSession` 逐字一致：本地会话 id + 会话行的远端身份
   * （`psb:<id>`）+ 终态原因。**事实判断在 main**：它读 PSB 会话行、只在「由我占用」且
   * 「同工作区没有别的活动任务」时释放；失败不阻断调用方，先记进 main 的有界待释放账本
   * （`PENDING_RELEASES_GET` / `PENDING_RELEASES_RETRY`），渲染层不自己判占用者、也不重复
   * 排一份重试。
   *
   * **触发权威也在 main**（2026-11-27 审查 s5/s8 P1）：终态 observer
   * （`setTerminalSessionStatusObserver`）在每次归档 / 删除落库后已经发起释放，渲染层**不再**
   * 为同一个动作重复报告（否则一次归档 = 两轮 PSB `sessionStatus` + `release`）。这条通道只
   * 保留给「旧 main / 旧 preload 没有终态释放」的兼容补投：渲染层探测到新 main（本方法存在）
   * 时零调用；只有旧 build 存下的未送达事件在升级后的首次启动由本地账本重投一次。
   */
  RELEASE_SESSION_WORKSPACE: 'psb-remote:release-session-workspace',
  /** 读 main 的待释放账本（释放失败、等下次重试的会话；常驻提示条与诊断的数据源）。 */
  PENDING_RELEASES_GET: 'psb-remote:pending-releases:get',
  /** 显式重试待释放账本（一次、不排后台轮询）；返回重试后的完整账本。 */
  PENDING_RELEASES_RETRY: 'psb-remote:pending-releases:retry',
  /** main → renderer：待释放账本变了（失败入账 / 重试成功出账 / 退出前重试）。 */
  PENDING_RELEASES_CHANGED: 'psb-remote:pending-releases-changed',
  /**
   * 会话级串流通道（`STREAM_STATUS` / `STREAM_START` / `STREAM_STOP` / `STREAM_INPUT` /
   * `STREAM_EVENT`）**已删除**（2026-11-26）：渲染层对它们的消费为零，唯一在用的观看端是
   * 「远程工作区」管理页的**工作区级**通道（`PSB_ADMIN_CHANNELS`，见
   * `shared/psb-workspace-admin.ts`）。保留两套只会让「是谁启动了串流 / 帧该推给谁」有两个答案。
   */
  /** main → renderer：某工作区占用/在线状态变更（其他窗口占用了工作区等）。 */
  WORKSPACE_CHANGED: 'psb-remote:workspace-changed',
  /**
   * main → renderer：某工作区在占用/解除占用时被版本控制检查拒绝（CINDY-RW-10）。
   *
   * 载荷是 `PsbWorkspaceVcsNoticeEvent`。IPC 错误只能带 code + message，`details.vcs` 里的
   * `projects` / `actions` 无法随 invoke 失败跨进程；main 在抛错**之前**把它写进有界缓存并广播，
   * 渲染层用 `WORKSPACE_VCS_NOTICE_GET` 兜底读一次（避免推送与 invoke 失败的到达顺序竞争）。
   */
  WORKSPACE_VCS_NOTICE: 'psb-remote:workspace-vcs-notice',
  /** 读某工作区当前的版本控制通知（`null` = 没有；用于推送未到时兜底）。 */
  WORKSPACE_VCS_NOTICE_GET: 'psb-remote:workspace-vcs-notice:get',
  /** 执行一个版本控制处置动作（渲染层只传 kind；method/path/body 由 main 从服务端 notice 取）。 */
  WORKSPACE_VCS_ACTION: 'psb-remote:workspace-vcs-action',
  /**
   * main → renderer：本地任务在**发送时**透明重建了 PSB 会话并完成重绑。
   *
   * 触发条件：本地会话的 `remoteHostId` 是 `psb:<id>`，该 PSB 会话已终态（或已读不到），
   * 且当前没有回合在跑。main 会在同一工作区新建一条 PSB 会话、先更新本地会话行的
   * `remoteHostId`，再发这条事件，然后继续这一轮发送（见
   * `docs/dev-rules/psb-remote-session-transport.md` §6）。
   *
   * 渲染层据此刷新该本地会话的远程派生数据（状态、远程管理页信息条、轻提示）。
   * 事件里的 `remoteHostId` 已经是**落库后的真值**，消费方不必等 `sessions:patched`。
   */
  SESSIONS_REBOUND: 'psb-remote:sessions-rebound',
} as const;

/** 状态查询结果：把"为什么不能用"收敛成可翻译的键，不在渲染层判 HTTP 码。 */
export interface PsbRemoteStatus {
  /** 已登录且是组织成员（否则 `false`，入口整体不可用）。 */
  readonly ready: boolean;
  /** 不可用原因的 i18n key（`ready:false` 时非空）。 */
  readonly reasonKey: string | null;
  /** 生效的 PSB 站点根（仅主机，渲染层用来显示"连的是哪个部署"）。 */
  readonly host: string;
  /** 是否是测试部署（`CINDY_MEKA_PSB_HOST` 覆盖生效）。 */
  readonly testHost: boolean;
}

/** 统一失败形状：IPC 错误既要有可翻译的键，也要保留 PSB 原始码便于日志与联调。 */
export interface PsbRemoteFailure {
  readonly code: string;
  /** i18n key（`remoteWorkspace.error.*` / `remoteWorkspace.vcs.*` / `remoteWorkspace.admin.streamAccess*`）。 */
  readonly messageKey: string;
  /** PSB 原始 message（兜底显示；不含凭据）。VCS 失败时是 `details.vcs.messageZh`。 */
  readonly message: string | null;
  /**
   * 版本控制检查通知（仅 `WORKSPACE_VCS_*` 失败带）。
   *
   * 只在 main 进程内部与推送载荷里流转：`ipcMain.handle` 抛错跨进程**只保留 message**，
   * 所以渲染层拿到的 notice 来自 `WORKSPACE_VCS_NOTICE` 推送 / `WORKSPACE_VCS_NOTICE_GET` 读取，
   * 不依赖这个字段跨 IPC（见 `shared/psb-workspace-vcs.ts` 文件头）。
   */
  readonly vcs?: WorkspaceVcsNotice;
  /**
   * 桌面访问状态（仅 `PSB_STREAM_NO_RUNNING_SESSION` 带，来自 PSB 409 的 `details.state`）。
   *
   * `null` = PSB 没给 / 给了未知值（按 none 家族处理）。**这个字段不跨 IPC**：跨进程只有
   * `[CODE] message`，所以 main 把它翻成三条不同的 IPC 码（`PSB_NO_RUNNING_SESSION_IPC_CODES`
   * 由 §4b 单表派生），渲染层按码选文案，不解析本字段。
   */
  readonly streamAccessState?: PsbWorkspaceAccessState | null;
}

/**
 * 一条 PSB 串流访问失败的**可行动文案**（单表投影，渲染层横幅专用）。
 *
 * 从 §4b 单表派生：`state` 决定「等还是去网页启动」，不再由渲染层自己写三档表。
 */
export interface PsbStreamAccessFailureCopy {
  readonly state: PsbStreamAccessFailureState;
  /** 已本地化的正文由调用方 `t(messageKey)` 得到。 */
  readonly messageKey: string;
  /** 是否值得给「在 PSB 网页启动访问」入口（`starting` / `stopping` 的正确动作是等）。 */
  readonly offerOpenWeb: boolean;
  /** 竞态：访问正在启动，等一会儿重试一次通常就好。 */
  readonly retryOnce: boolean;
}

/** IPC 码 → 串流访问失败文案；不是这三档码返回 `null`（调用方走通用失败文案）。 */
export function psbStreamAccessFailureCopyForIpcCode(
  code: string,
): PsbStreamAccessFailureCopy | null {
  const descriptor = psbFailureDescriptorForIpcCode(code);
  if (!descriptor || descriptor.state === null) return null;
  return {
    state: descriptor.state,
    messageKey: descriptor.messageKey,
    offerOpenWeb: descriptor.nextStep === 'open-web-access',
    retryOnce: descriptor.nextStep === 'wait',
  };
}

/**
 * 状态 → IPC 失败码（`PSB_NO_RUNNING_SESSION_IPC_CODES` 的投影，见 §4b 单表）。
 *
 * `running` / `null` / 未知值都落到「去网页启动访问」那一档（安全默认：不进自动重试循环）。
 */
export function psbNoRunningSessionIpcCode(
  state: PsbWorkspaceAccessState | null | undefined,
): PsbDescribedIpcCode {
  if (state === 'starting') return psbStreamAccessIpcCode('starting');
  if (state === 'stopping') return psbStreamAccessIpcCode('stopping');
  return psbStreamAccessIpcCode('none');
}

export interface PsbListWorkspacesResult {
  readonly workspaces: readonly PsbRemoteWorkspace[];
}

export interface PsbListClientsResult {
  readonly clients: readonly PsbRemoteClient[];
}

export interface PsbListTemplatesResult {
  readonly templates: readonly PsbProjectTemplate[];
}

export interface PsbCreateWorkspaceRequest {
  readonly clientId: string;
  readonly templateKey: string;
  readonly title?: string;
}

export interface PsbCreateWorkspaceResult {
  readonly workspace: PsbRemoteWorkspace;
}

export interface PsbWorkspaceRefRequest {
  readonly workspaceId: string;
  /**
   * 发起这次动作的本地任务 id（加性、可空）。
   *
   * 只用于 main 的多窗口推送分桶：`CONTEXT_CHANGED` 是广播，main 只有一份「最近一次上下文
   * 读取用的本地任务」，多窗口各自打开不同任务时渲染层要按它过滤。动作路径带上它，main
   * 就能把「这次占用/释放属于哪个窗口的任务」写进下一次上下文；不传时按工作区匹配兜底。
   */
  readonly localSessionId?: string | null;
}

export interface PsbOccupyWorkspaceResult {
  readonly workspace: PsbRemoteWorkspace;
}

/**
 * 会话用途（PSB 0.1.172 加性字段 `purpose`）。
 *
 * PSB 的框架规则：**Agent 会话只装用户任务**。`internal` 是接入端服务用途（过渡兜底用），
 * 默认不进会话列表、不增加工作区 `sessionCount`，但详情 / 停止 / 转录照旧可用。其它值
 * （含空串、大小写不对）PSB 会 400，所以 Cindy 侧只用这两个词、且不把 `agent` 显式传出去
 * （省略 = agent，保持与旧服务端逐字节一致的请求体）。
 */
export const PSB_SESSION_PURPOSES = ['agent', 'internal'] as const;

export type PsbSessionPurpose = (typeof PSB_SESSION_PURPOSES)[number];

export interface PsbCreateSessionRequest {
  readonly workspaceId: string;
  readonly agentKind: PsbAgentKind;
  /** 会话标题（Cindy 本地首条消息的短标题；PSB 侧仅展示用）。 */
  readonly title?: string;
  /**
   * 去重键：Cindy 侧生成（每次用户点击一次），PSB 用它在"双击/重试"时只建一条会话。
   */
  readonly clientRequestId: string;
  /**
   * 会话用途（PSB 0.1.172 加性字段，见 `PSB_SESSION_PURPOSES`）。
   *
   * **省略 = `agent`（用户任务）**，这是所有用户任务的创建路径；只有「过渡兜底」的内部
   * 串流会话才显式传 `internal`。不要把内部用途伪装成用户任务：标题要写明内部语义。
   */
  readonly purpose?: PsbSessionPurpose;
}

export interface PsbCreateSessionResult {
  /** PSB 原始会话行（Cindy 用 `id` 拼 `psb:<id>` 作为会话的 `remoteHostId`）。 */
  readonly session: PsbRemoteSession;
  /**
   * 会话所属工作区的快照（草稿页顶部要显示客户端与工作区实例 ID）。
   *
   * **语义是「创建前读到的、请求里那个 workspaceId 的行」**：main 的 `createSession` 先读
   * 工作区、再建会话（读失败时**不建**，所以不存在「建了却拿不到工作区」的孤儿会话）。
   * 派生字段（占用 / 会话数）可能与会话行同一时刻差几十毫秒，渲染层本来就轮询，可接受。
   */
  readonly workspace: PsbRemoteWorkspace;
}

export interface PsbSessionStatusResult {
  readonly session: PsbRemoteSession;
  readonly workspace: PsbRemoteWorkspace;
}

/**
 * 远端关闭串流的**归因明细**（main 产出，渲染层只消费；见 main `classifyStreamClose`）。
 *
 * 4004 在 PSB 有**两种含义**（「没有可观看画面」与「慢订阅者被断开」，见 PSB 仓
 * `docs/remote-workspace.md` §11.10「已知语义重叠」）：main 已按「有没有结构前缀 + 该连接
 * 是否收到过二进制帧」分好，渲染层不需要也不应该自己解析 `reason` 文本。
 */
export interface PsbStreamCloseDetail {
  /** 4004 结构前缀里的机器码（`PSB_STREAM_REASON_CODES`）；没有结构前缀／其它关闭码为 `null`。 */
  readonly reasonCode: PsbStreamReasonCode | null;
  /** 同上前缀里的桌面会话状态（`PSB_DESKTOP_SESSION_STATES`）；没有／未知为 `null`。 */
  readonly desktopSession: PsbDesktopSessionState | null;
  /**
   * PSB 给的中文原话（结构前缀之后的部分；没有前缀时是整段 reason，已 trim）。
   * 没有 reason（空 reason 的关闭码）时 `null`。可直接显示，不保证是完整句子（PSB 会截断）。
   */
  readonly messageZh: string | null;
}

/**
 * 串流事件：帧走 `payload`（二进制），状态走字段，错误走 `error`。
 *
 * `cursor` 是**加性**事件（2026-11-26 宿主光标形状同步）：来自 PSB 中继的 `stream.cursor`
 * 文本帧，与二进制帧是两条互不影响的通道；`cursor` 只描述**形状**（由渲染层映射成 CSS 关键字、
 * 且只在画面区域生效），不携带也不影响 `status` / `frame` 语义。旧消费方（只认
 * frame/status/closed/error）在加一个成员后仍然编译，但**穷尽 switch 会报错**——这是刻意的：
 * 遗漏处理会让 `cursor` 落进「其它事件 = 错误」的兜底分支（渲染层曾把未知事件当错误显示）。
 */
export type PsbStreamEvent =
  | { readonly type: 'frame'; readonly sessionId: string; readonly payload: ArrayBuffer }
  | { readonly type: 'status'; readonly sessionId: string; readonly status: PsbSessionStreamStatus }
  | {
      /**
       * 远端宿主光标形状（覆盖语义）。`serial` 只用于去重连续重复形状，**不保证严格单调**，
       * 消费方不得按它丢弃形状；形状不合法（`psbStreamCursorKeyword` 返回 `null`）时保持现状。
       */
      readonly type: 'cursor';
      readonly sessionId: string;
      readonly cursor: PsbStreamCursorShape;
    }
  | {
      readonly type: 'closed';
      readonly sessionId: string;
      /** 稳定 token（main `psbStreamClosedReason` 产出）；4004 的「未就绪」是 `not-ready`。 */
      readonly reason: string | null;
      /** 归因明细（可选：旧 main / 旧持久化事件里没有它，消费方要按可选处理）。 */
      readonly detail?: PsbStreamCloseDetail;
    }
  | { readonly type: 'error'; readonly sessionId: string; readonly failure: PsbRemoteFailure };

/** 主进程 → 渲染层的"某个远程工作区变了"通知（占用/在线/状态）。 */
export interface PsbWorkspaceChangedEvent {
  readonly workspaceId: string;
  readonly workspace: PsbRemoteWorkspace | null;
}

/**
 * 主进程 → 渲染层：「这个本地任务换了一条 PSB 会话」（发送时透明重建的结果）。
 *
 * 只描述**变化本身**，不带工作区快照（工作区没变，还是同一个）；渲染层要么按
 * `remoteHostId` 更新本地会话行的远程派生数据，要么重读 `sessionStatus`。
 * 三个字段都是已确定的真值：`remoteHostId` 落库成功之后才发出。
 */
export interface PsbSessionsReboundEvent {
  /** 本地任务 id（sessions.id），渲染层用它定位要刷新的会话。 */
  readonly localSessionId: string;
  /** 重绑前的 PSB 身份（`psb:<旧 PSB 会话 id>`），已终态/已不存在。 */
  readonly previousRemoteHostId: string;
  /** 重绑后的 PSB 身份（`psb:<新 PSB 会话 id>`），已写入本地会话行。 */
  readonly remoteHostId: string;
}

/* ================== 7b. 会话结束归还工作区占用（renderer ↔ main） ================== */

/**
 * 触发释放的终态来源（诊断 / 账本归因用；**不参与**释放判据）。
 *
 * 判据只有两条（main 侧、都由 main 掌握）：
 *   1. PSB 会话行显示工作区「由我占用」才发释放；
 *   2. **同一工作区还有别的活动任务时不释放**（工作区级协作锁，不是会话级）—— 归档一条
 *      任务不等于归还它和同事共用的工作区。这一条只有 main 能判断（会话表 + 会话→工作区
 *      映射），所以它是「main 单权威」的一部分（见 `RELEASE_SESSION_WORKSPACE`）。
 *
 * 原因只用于日志、账本展示与「为什么会有一条待释放记录」的归因。
 */
export const PSB_SESSION_RELEASE_REASONS = [
  'session-archived',
  'session-deleted',
  'session-stopped',
  'app-quit',
] as const;

export type PsbSessionReleaseReason = (typeof PSB_SESSION_RELEASE_REASONS)[number];

/**
 * 「这条本地任务结束了」→ 让 main 归还它占用的 PSB 工作区。
 *
 * `remoteHostId` 来自本地会话行的 `psb:<PSB session id>`；不是 `psb:`（本地 / SSH / MCPRouter）
 * 时 main 直接 no-op —— 那三类 transport 没有 PSB 协作锁。
 */
export interface PsbSessionWorkspaceReleaseRequest {
  readonly sessionId: string;
  readonly remoteHostId: string | null;
  readonly reason: PsbSessionReleaseReason;
}

/**
 * main 对一次释放报告的结果。
 *
 * `ok:false` **不代表事件丢了**：main 已把失败记进它自己的待释放账本（`reason:'retained'`），
 * 由账本统一重试；渲染层只需清掉本地「事件未送达」的记录，不再为同一件事排第二份重试。
 * `reason:'not-wired'` 是「main 端口还没装配」，渲染层应保留记录等下次启动补投。
 *
 * `reason:'workspace-in-use'` = **同一工作区还有别的活动任务**，这次释放被跳过、也没有入账
 * （工作区锁要留到最后一个任务结束）。它是正常的成功结果，不是失败。
 */
export interface PsbSessionWorkspaceReleaseResult {
  readonly ok: boolean;
  readonly released: boolean;
  readonly reason: 'not-psb' | 'not-wired' | 'not-held' | 'released' | 'retained' | 'workspace-in-use';
  readonly failureCode: string | null;
  readonly message: string | null;
}

/**
 * 待重试的一条释放（main 账本）。
 *
 * 跨 IPC 只带 id / 原因 / 有界错误诊断：`lastError` 是 PSB 失败原文（不含 token、
 * Authorization 或身份字段），`attempt` 是连续失败次数。
 */
export interface PsbPendingWorkspaceReleaseInfo {
  readonly key: string;
  readonly psbSessionId: string;
  readonly remoteHostId: string;
  /**
   * 失败那一次**已经读到**的工作区 id（PSB 会话行 → `workspace.id`）；`null` = 还没读到
   * （读会话行就失败了）。
   *
   * 重试优先按它直接 `releaseWorkspace`：不依赖 PSB 会话行还在（会话 404 时工作区锁仍可由
   * workspaceId 归还），也不再为一条账本各打一次 `sessionStatus`。只读字段，跨 IPC 不参与
   * 任何判定以外的用途。
   */
  readonly workspaceId: string | null;
  readonly reason: PsbSessionReleaseReason;
  readonly attempt: number;
  readonly lastError: string;
  readonly failureCode: string | null;
  readonly updatedAt: number;
}

/** 待释放账本快照（`PENDING_RELEASES_GET` 与 `PENDING_RELEASES_CHANGED` 同形）。 */
export interface PsbPendingWorkspaceReleasesResult {
  readonly releases: readonly PsbPendingWorkspaceReleaseInfo[];
}

/** 显式重试结果：账本快照 + 这一次尝试的计数（`attempted:0` = 本来就没有待释放项）。 */
export interface PsbPendingWorkspaceReleasesRetryResult extends PsbPendingWorkspaceReleasesResult {
  readonly attempted: number;
  readonly released: number;
  readonly failed: number;
}

/* ============================== 8. IPC 失败码与失败形状 ============================== */

/**
 * PSB 失败在 IPC 错误码里的命名空间前缀。
 *
 * ## 为什么用「命名空间化的错误码」而不是把失败对象序列化进 message
 *
 * `ipcMain.handle` 抛错跨进程只保留 `Error.message`（`code` 字段会丢，见
 * `docs/dev-rules/engineering-conventions.md` §2），失败语义只能靠 message 或**错误码名**承载。
 * 选择后者：错误码是 `IpcErrorCode` 的编译期协议（漏登记 typecheck 直接失败），渲染层按码查文案键
 * （`psbFailureMessageKeyForIpcCode`），message 保留 PSB 原文或占用人名做兜底/诊断。把 JSON 塞进
 * message 会让不解析它的调用方（日志、错误条）显示一段机器串。
 *
 * `PSB_` 前缀也让「PSB 侧失败」与参数校验 / 权限拒绝等本地失败区分开。
 */
export const PSB_IPC_FAILURE_CODE_PREFIX = 'PSB_';

/**
 * 不面向用户的**本地诊断码**（不来自 PSB、也没有可行动文案）。
 *
 * 只出现在 `PsbRemoteFailure.code` 与日志里；`psbIpcCodeForFailure` 对它们返回 `null`，
 * IPC 层落 `INTERNAL`。集中一处，避免 main 各文件各写一串（也避免它们被误登记进失败单表）。
 */
export const PSB_LOCAL_DIAGNOSTIC_CODES = {
  /** 协议违约（外壳缺失 / 路径越界 / 响应超限）。 */
  protocol: 'PSB_PROTOCOL',
  /** 无法归因的本地失败。 */
  unknown: 'PSB_UNKNOWN',
  /** 401 重签一次后仍被判失败（实现错误保护）。 */
  authLoop: 'PSB_AUTH_LOOP',
} as const;

/**
 * 未知 PSB 失败 / 本地诊断失败的回退文案键（渲染层最后一道兜底）。
 *
 * §4b 单表覆盖的码不会用到它；main 与渲染层都从这里取，不再各写一份字面量。
 */
export const PSB_FAILURE_UNKNOWN_MESSAGE_KEY = 'remoteWorkspace.error.unknown';

/**
 * PSB 失败码 → i18n 文案键（**§4b 失败单表的投影**，唯一手写处仍在单表）。
 *
 * 保留这个名字是因为仓内注释 / 文档一直用它指「渲染层按 IPC 码查文案表」这件事；
 * 实际映射只有 `PSB_FAILURE_DESCRIPTORS` 一处，不要在这里再补行。
 */
export const PSB_IPC_FAILURE_MESSAGE_KEYS: Readonly<Record<PsbDescribedIpcCode, string>> =
  Object.fromEntries(
    Object.entries(PSB_FAILURE_DESCRIPTORS).map(([ipcCode, descriptor]) => [
      ipcCode,
      descriptor.messageKey,
    ]),
  ) as Readonly<Record<PsbDescribedIpcCode, string>>;

/** 失败码全集：由 §4b 单表派生（`ipc-errors.ts` 仍单独登记这些码）。 */
export type PsbIpcFailureCode = PsbDescribedIpcCode;

/**
 * main 侧唯一出口：失败形状 → 命名空间化 IPC 错误码（IPC 层 `throwIpcError` 用）。
 *
 * 返回 `null` 表示这不是一条可行动的用户失败（协议错 / 未知码）：调用方落通用 `INTERNAL`，
 * 只把诊断原文放进 message。
 */
export function psbIpcCodeForFailure(failure: PsbRemoteFailure): PsbIpcFailureCode | null {
  // VCS 三码：PSB 原始码 → IPC 码由 §4b 单表派生（VCS 通知码表用同一份映射）。
  const vcsIpcCode = vcsIpcCodeForPsbCode(failure.code);
  if (vcsIpcCode) return vcsIpcCode;
  // 同一 PSB 码的鉴别条目（AUTH_REQUIRED → 组织账号 / 未登录）：鉴别键登记在单表里。
  const discriminated = PSB_FAILURE_ENTRY_BY_PSB_CODE_AND_MESSAGE_KEY
    .get(failure.code)
    ?.get(failure.messageKey);
  if (discriminated) return discriminated.ipcCode;
  // 本地已经产出 PSB_ 码（例如 `PSB_STREAM_NO_RUNNING_SESSION` 带 `streamAccessState`）。
  const byIpcCode = PSB_FAILURE_ENTRY_BY_IPC_CODE.get(failure.code);
  if (byIpcCode) return psbIpcCodeForEntry(byIpcCode, failure);
  // PSB 原始码（含历史别名）。
  const byPsbCode = PSB_FAILURE_ENTRY_BY_PSB_CODE.get(failure.code);
  if (!byPsbCode) return null;
  return psbIpcCodeForEntry(byPsbCode, failure);
}

/** 单表条目 → IPC 码；串流访问家族按 `streamAccessState` 分三档（单表 `state` 列）。 */
function psbIpcCodeForEntry(
  entry: PsbFailureEntry,
  failure: PsbRemoteFailure,
): PsbIpcFailureCode {
  return entry.descriptor.state === null
    ? entry.ipcCode
    : psbNoRunningSessionIpcCode(failure.streamAccessState);
}

/**
 * 失败码 → 文案键（§4b 失败单表的投影）；不是 PSB 失败码返回 `null`（调用方回落通用文案）。
 *
 * 只查 Map（单表投影），不做对象属性查找：`constructor` 之类的远端字符串命中原型链会把
 * 函数当文案键返回。
 */
export function psbFailureMessageKeyForIpcCode(code: string): string | null {
  return psbFailureDescriptorForIpcCode(code)?.messageKey ?? null;
}

/**
 * 失败码 → **错误横幅**文案键（占用人名可省略的兜底）。
 *
 * 同一个事实（工作区被他人占用）有两个消费面，两者的信息量不同：
 * - 操作 / 按钮失败：main 的 IPC `message` 只放占用人名，调用方可以插值
 *   `{{name}}` → `remoteWorkspace.error.occupiedByOther`（`psbFailureMessageKeyForIpcCode`）；
 * - 发送被拒的错误横幅：decode 路径只有 `code + message`，名字可能为空，不能强制插值；
 *   统一落到**无名字的同一句** `remoteWorkspace.error.workspaceOccupied`。
 *
 * 这个差异登记在共享契约里（唯一映射点），渲染层**不得**再为某个码手写 if；新增带名字
 * 差异的失败码时在这里补一行，而不是在 main / renderer 各写一份。
 */
const PSB_IPC_BANNER_MESSAGE_KEY_OVERRIDES: Readonly<Record<string, string>> = {
  PSB_WORKSPACE_OCCUPIED_BY_OTHER: 'remoteWorkspace.error.workspaceOccupied',
};

/** 错误横幅用：失败码 → 文案键（含无名字兜底）；不是 PSB 失败码返回 `null`。 */
export function psbBannerMessageKeyForIpcCode(code: string): string | null {
  if (Object.hasOwn(PSB_IPC_BANNER_MESSAGE_KEY_OVERRIDES, code)) {
    return PSB_IPC_BANNER_MESSAGE_KEY_OVERRIDES[code] ?? null;
  }
  return psbFailureMessageKeyForIpcCode(code);
}

/**
 * 从 invoke 失败里取回 `PsbRemoteFailure` 形状（渲染层可选读法；组件仍不必判 HTTP 码）。
 *
 * 返回 `null` 表示这不是 PSB 失败码（参数校验 / 权限拒绝等本地失败），按普通 IPC 错误处理。
 */
export function psbRemoteFailureFromIpcError(error: unknown): PsbRemoteFailure | null {
  const ipcError = extractIpcError(error);
  if (!ipcError) return null;
  const messageKey = psbFailureMessageKeyForIpcCode(ipcError.code);
  if (!messageKey) return null;
  const message = ipcError.message.trim();
  return {
    code: ipcError.code,
    messageKey,
    message: message.length > 0 ? message : null,
  };
}
