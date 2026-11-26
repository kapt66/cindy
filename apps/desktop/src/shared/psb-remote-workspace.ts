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
  readonly title: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly clientOnline: boolean;
  readonly clientPlatform: string | null;
  readonly state: PsbWorkspaceState;
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
  readonly agentKind: PsbAgentKind;
  readonly status: PsbSessionStatus;
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
export interface PsbSessionStreamStatus {
  /** 客户端是否声明 `streaming` 能力。 */
  readonly capable: boolean;
  /** 当前是否有采集在跑。 */
  readonly active: boolean;
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  readonly codec: string | null;
  /** 最近一次采集错误（可读中文），没有则 `null`。 */
  readonly lastError: string | null;
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
} as const;

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

function readOccupancy(value: unknown): PsbWorkspaceOccupancy {
  if (!isRecord(value)) {
    return { occupied: false, byMe: false, personId: null, personName: '', occupiedAt: null };
  }
  const personId = readString(value['personId']);
  return {
    occupied: readBoolean(value['occupied']) || personId !== null,
    byMe: readBoolean(value['byMe']),
    personId,
    personName: readString(value['personName']) ?? '',
    occupiedAt: readNumber(value['occupiedAt']),
  };
}

/**
 * 解析一条工作区行。
 *
 * 为什么手写而不用 zod：renderer 与 main 都要用，而 renderer 目前不引 zod；这里只需要**防崩**
 * （未知/缺字段收敛成安全默认），不做严格校验——严格校验在 PSB 侧。
 * 返回 `null` 表示这一行连 `id` 都没有，调用方应丢弃它而不是显示一条空行。
 */
export function parsePsbRemoteWorkspace(value: unknown): PsbRemoteWorkspace | null {
  if (!isRecord(value)) return null;
  const id = readString(value['id']);
  if (!id) return null;
  const state = isPsbWorkspaceState(value['state']) ? value['state'] : 'failed';
  const unusableReason = isPsbWorkspaceUnusableReason(value['unusableReason'])
    ? value['unusableReason']
    : null;
  return {
    id,
    title: readString(value['title']) ?? '',
    clientId: readString(value['clientId']) ?? '',
    clientName: readString(value['clientName']) ?? '',
    clientOnline: readBoolean(value['clientOnline']),
    clientPlatform: readString(value['clientPlatform']),
    state,
    templateKey: readString(value['templateKey']),
    templateTitle: readString(value['templateTitle']),
    directoryName: readString(value['directoryName']),
    clientPath: readString(value['clientPath']),
    occupancy: readOccupancy(value['occupancy']),
    usable: readBoolean(value['usable']),
    unusableReason,
    sessionCount: readNumber(value['sessionCount']) ?? 0,
    webUrl: readString(value['webUrl']),
    sessionsWebUrl: readString(value['sessionsWebUrl']),
  };
}

export function parsePsbRemoteClient(value: unknown): PsbRemoteClient | null {
  if (!isRecord(value)) return null;
  const id = readString(value['id']);
  if (!id) return null;
  const capabilities = isRecord(value['capabilities']) ? value['capabilities'] : {};
  const agents = Array.isArray(value['agents'])
    ? value['agents'].flatMap((entry): PsbRemoteClientAgent[] => {
        if (!isRecord(entry) || !isPsbAgentKind(entry['kind'])) return [];
        return [
          {
            kind: entry['kind'],
            available: readBoolean(entry['available']),
            version: readString(entry['version']),
          },
        ];
      })
    : [];
  return {
    id,
    name: readString(value['name']) ?? '',
    online: readBoolean(value['online']),
    platform: readString(value['platform']),
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
  const key = readString(value['key']);
  if (!key) return null;
  return {
    key,
    title: readString(value['title']) ?? key,
    description: readString(value['description']),
    checkoutCount: readNumber(value['checkoutCount']) ?? 0,
  };
}

export function parsePsbRemoteSession(value: unknown): PsbRemoteSession | null {
  if (!isRecord(value)) return null;
  const id = readString(value['id']);
  const workspaceId = readString(value['workspaceId']);
  if (!id || !workspaceId) return null;
  const agentKind = isPsbAgentKind(value['agentKind']) ? value['agentKind'] : 'claude-code';
  const status = isPsbSessionStatus(value['status']) ? value['status'] : 'failed';
  const createdBy = isRecord(value['createdBy']) ? value['createdBy'] : {};
  const source = createdBy['source'] === 'web' ? 'web' : 'cindy';
  return {
    id,
    workspaceId,
    clientId: readString(value['clientId']) ?? '',
    title: readString(value['title']),
    agentKind,
    status,
    statusMessage: readString(value['statusMessage']),
    createdAt: readString(value['createdAt']) ?? '',
    updatedAt: readString(value['updatedAt']) ?? '',
    createdBy: {
      personId: readString(createdBy['personId']),
      personName: readString(createdBy['personName']) ?? '',
      source,
    },
    webUrl: readString(value['webUrl']),
  };
}

export function parsePsbSessionStreamStatus(value: unknown): PsbSessionStreamStatus {
  if (!isRecord(value)) {
    return {
      capable: false,
      active: false,
      width: null,
      height: null,
      fps: null,
      codec: null,
      lastError: null,
      desktopSession: null,
      reasonCode: null,
    };
  }
  // PSB 的 `CindyRemoteStreamStatus` 用 `capability` / `encoder` / `lastErrorZh`
  // （见 PSB 仓 `packages/shared/src/cindy-remote.ts`）；早期契约草稿写的是
  // `capable` / `codec` / `lastError`。两种拼写都认，优先 PSB 现行字段。
  const capable = value['capability'] ?? value['capable'];
  const codec = value['encoder'] ?? value['codec'];
  const lastError = value['lastErrorZh'] ?? value['lastError'];
  // `desktopSession` / `reasonCode` 是 2026-11-26 的**加性字段**：旧服务端不带它们，
  // 解析成 `null`（= 未知）而不是猜一个值；PSB 只下发上面枚举里的词，其它值一律当未知。
  const desktopSession = value['desktopSession'];
  const reasonCode = value['reasonCode'];
  return {
    capable: readBoolean(capable),
    active: readBoolean(value['active']),
    width: readNumber(value['width']),
    height: readNumber(value['height']),
    fps: readNumber(value['fps']),
    codec: readString(codec),
    lastError: readString(lastError),
    desktopSession: isPsbDesktopSessionState(desktopSession) ? desktopSession : null,
    reasonCode: isPsbStreamReasonCode(reasonCode) ? reasonCode : null,
  };
}

/* ============================== 5b. 串流宿主光标形状（stream.cursor，2026-11-26） ============================== */

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
 * 移植自 PSB 网页 `remote-clients/stream/cursor-shape.ts`（2026-11-26）；PSB 2026-11-26 又把
 * 表上收到 `@psb/shared` 的 `stream-cursor.ts`（网页只保留「写到哪个 DOM 元素」）。两个观看端
 * 必须从同一张表得到同一个光标，所以这里照抄，不自行增删。
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
 * 移植自 PSB 网页 `remote-clients/stream/cursor-shape.ts`（2026-11-26）；表的来源是 PSB 打包机
 * （Fedora 默认主题 `psb-cursor -once` 实测）+ X11 常见别名（cursorfont.h / 各主题惯用名），
 * 覆盖 I-beam / 手形 / resize / 忙等待四类用户可感知场景。表外 → `default`。
 *
 * **改动必须与 PSB 同步**：这张表是两个观看端「同一个远端看起来是同一种鼠标」的唯一保证。
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
 * 规则（与 PSB 网页 `systemCursorKeywordOf` 逐条一致）：
 * 1. `name` 归一：大小写、首尾空白、`-` / 空格当 `_`；
 * 2. 归一后本身已是合法 CSS 关键字 → 直接沿用（`zoom-in` / `col-resize` 之类不必进表）；
 * 3. 否则查 X11→CSS 别名表（{@link PSB_STREAM_CURSOR_KEYWORD_BY_X11_NAME}）；
 * 4. 未知 / 缺 `name` → {@link DEFAULT_PSB_STREAM_CURSOR_KEYWORD}（箭头）；
 * 5. **形状不合法 → `null`**：调用方不写样式、保持现状（远端畸形数据不能伪造出一个光标）。
 *
 * 外观由本机指针主题渲染（永远是宿主风格）：这里只变**形态**，不复刻远端位图。
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
  return PSB_STREAM_CURSOR_KEYWORD_BY_X11_NAME[aliased] ?? DEFAULT_PSB_STREAM_CURSOR_KEYWORD;
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
    messageZh: tail.length > 0 ? tail : null,
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

export function psbWorkspaceHealth(workspace: {
  readonly state: PsbWorkspaceState;
  readonly clientOnline: boolean;
  readonly occupancy: PsbWorkspaceOccupancy;
  readonly usable: boolean;
  readonly unusableReason: PsbWorkspaceUnusableReason | null;
}): PsbWorkspaceHealth {
  const lock = psbWorkspaceLockState(workspace.occupancy);
  const canStartSession =
    workspace.usable &&
    workspace.clientOnline &&
    workspace.state === 'ready' &&
    lock !== 'other';

  if (!workspace.clientOnline) {
    return { tone: 'bad', lock, canStartSession: false, badgeKey: 'remoteWorkspace.badge.offline' };
  }
  if (workspace.state === 'failed') {
    return { tone: 'bad', lock, canStartSession: false, badgeKey: 'remoteWorkspace.badge.failed' };
  }
  if (workspace.state !== 'ready') {
    return { tone: 'idle', lock, canStartSession: false, badgeKey: 'remoteWorkspace.badge.pending' };
  }
  if (lock === 'other') {
    return { tone: 'warn', lock, canStartSession: false, badgeKey: 'remoteWorkspace.badge.occupied' };
  }
  if (workspace.unusableReason === 'agent-unsupported') {
    return {
      tone: 'idle',
      lock,
      canStartSession: false,
      badgeKey: 'remoteWorkspace.badge.agentUnsupported',
    };
  }
  return { tone: 'ok', lock, canStartSession, badgeKey: 'remoteWorkspace.badge.online' };
}

/**
 * 会话输入是否允许（`false` 时输入框置灰）。
 *
 * **终态不阻断输入**：PSB 的会话终态不可逆转，但 Cindy 在用户下一次发送时会透明地
 * 在同一工作区新建一条 PSB 会话、重绑本地任务并发起这一轮（见
 * `docs/dev-rules/psb-remote-session-transport.md` §6）。所以「这个任务已经结束」
 * 不是真实状态——本地任务还在，只是底层 PSB 会话换了。
 *
 * 真正阻断输入的只剩三种：**被他人占用**（用户明确要求置灰）、**客户端离线**、
 * **工作区未就绪**（这两种消息发不出去）。这三种在发送时也无法自动恢复，属于
 * 可行动的外部条件，保持阻断。
 *
 * `session` 参数保留在形状里（调用方与渲染层都按会话对象传），但不再参与判据；
 * 「这条会话下次发送会不会重建」用 `psbSessionNeedsRebind(session.status)` 单独问。
 */
export function psbSessionInputAllowed(input: {
  readonly session: PsbRemoteSession;
  readonly workspace: {
    readonly state: PsbWorkspaceState;
    readonly clientOnline: boolean;
    readonly occupancy: PsbWorkspaceOccupancy;
  };
}): { readonly allowed: boolean; readonly reason: string | null } {
  const { workspace } = input;
  if (psbWorkspaceLockState(workspace.occupancy) === 'other') {
    return { allowed: false, reason: 'remoteWorkspace.input.occupiedByOther' };
  }
  if (!workspace.clientOnline) {
    return { allowed: false, reason: 'remoteWorkspace.input.clientOffline' };
  }
  if (workspace.state !== 'ready') {
    return { allowed: false, reason: 'remoteWorkspace.input.workspaceNotReady' };
  }
  return { allowed: true, reason: null };
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
  /** 串流状态（启动/停止/详情按钮的数据来源）。 */
  STREAM_STATUS: 'psb-remote:stream-status',
  /** 开始串流（建立观看端 WS，后续帧经 `STREAM_EVENT` 推送）。 */
  STREAM_START: 'psb-remote:stream-start',
  /** 停止串流。 */
  STREAM_STOP: 'psb-remote:stream-stop',
  /** 键鼠输入（renderer → main → PSB 观看端 WS）。 */
  STREAM_INPUT: 'psb-remote:stream-input',
  /** main → renderer 的串流事件（帧 / 状态 / 光标 / 错误）。 */
  STREAM_EVENT: 'psb-remote:stream-event',
  /** main → renderer：某工作区占用/在线状态变更（其他窗口占用了工作区等）。 */
  WORKSPACE_CHANGED: 'psb-remote:workspace-changed',
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
  /** i18n key（`remoteWorkspace.error.*`）。 */
  readonly messageKey: string;
  /** PSB 原始 message（兜底显示；不含凭据）。 */
  readonly message: string | null;
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
}

export interface PsbOccupyWorkspaceResult {
  readonly workspace: PsbRemoteWorkspace;
}

export interface PsbCreateSessionRequest {
  readonly workspaceId: string;
  readonly agentKind: PsbAgentKind;
  /** 会话标题（Cindy 本地首条消息的短标题；PSB 侧仅展示用）。 */
  readonly title?: string;
  /**
   * 去重键：Cindy 侧生成（每次用户点击一次），PSB 用它在"双击/重试"时只建一条会话。
   */
  readonly clientRequestId: string;
}

export interface PsbCreateSessionResult {
  /** PSB 原始会话行（Cindy 用 `id` 拼 `psb:<id>` 作为会话的 `remoteHostId`）。 */
  readonly session: PsbRemoteSession;
  /** 本次会话所属工作区的快照（草稿页顶部要显示客户端与工作区实例 ID）。 */
  readonly workspace: PsbRemoteWorkspace;
}

export interface PsbSessionStatusResult {
  readonly session: PsbRemoteSession;
  readonly workspace: PsbRemoteWorkspace;
}

export interface PsbStreamStartResult {
  readonly status: PsbSessionStreamStatus;
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

/** PSB 失败码 → i18n 文案键（渲染层唯一映射；main 用 `psbIpcCodeForFailure` 反向产出）。 */
export const PSB_IPC_FAILURE_MESSAGE_KEYS = {
  PSB_AUTH_REQUIRED: 'remoteWorkspace.error.auth',
  PSB_ORG_REQUIRED: 'remoteWorkspace.error.orgRequired',
  PSB_AUTH_EXPIRED: 'remoteWorkspace.error.authExpired',
  PSB_IDENTITY_NOT_LINKED: 'remoteWorkspace.error.identityNotLinked',
  PSB_WORKSPACE_OCCUPIED_BY_OTHER: 'remoteWorkspace.error.occupiedByOther',
  PSB_CLIENT_OFFLINE: 'remoteWorkspace.error.clientOffline',
  /**
   * 工作区还没就绪（`planned` / `provisioning` / `failed` / `deleting`）：发送前重建
   * 无法开始，等它就绪后重发即可。文案复用输入禁用的同一条（同一个事实，两种入口）。
   */
  PSB_WORKSPACE_NOT_READY: 'remoteWorkspace.input.workspaceNotReady',
  PSB_NOT_FOUND: 'remoteWorkspace.error.notFound',
  PSB_UNREACHABLE: 'remoteWorkspace.error.unreachable',
  PSB_STREAM_UNAVAILABLE: 'remoteWorkspace.session.streamUnsupported',
  /**
   * 本端此刻没有活动的串流连接（还没启动 / 已停止 / 连接已断开），所以输入无处可发。
   *
   * 与 `PSB_STREAM_UNAVAILABLE` 分开：那个是「这台机器/客户端不支持串流」（不可恢复），
   * 这个是「先把观看启动起来」（用户一步就能恢复）。渲染层据此给「串流未启动」而不是
   * 「本机不能串流」，否则用户会去做无效动作。
   */
  PSB_STREAM_NOT_ACTIVE: 'remoteWorkspace.session.streamIdle',
} as const;

export type PsbIpcFailureCode = keyof typeof PSB_IPC_FAILURE_MESSAGE_KEYS;

/**
 * main 侧唯一出口：失败形状 → 命名空间化 IPC 错误码（IPC 层 `throwIpcError` 用）。
 *
 * 返回 `null` 表示这不是一条可行动的用户失败（协议错 / 未知码）：调用方落通用 `INTERNAL`，
 * 只把诊断原文放进 message。
 */
export function psbIpcCodeForFailure(failure: PsbRemoteFailure): PsbIpcFailureCode | null {
  switch (failure.code) {
    case 'AUTH_REQUIRED':
      // 个人 membership 与未登录都会走到 AUTH_REQUIRED；文案要区分「需要登录」与「需要企业组织」。
      return failure.messageKey === 'remoteWorkspace.status.needOrg'
        ? 'PSB_ORG_REQUIRED'
        : 'PSB_AUTH_REQUIRED';
    case 'AUTH_INVALID':
    case 'AUTH_EXPIRED':
      return 'PSB_AUTH_EXPIRED';
    case 'IDENTITY_NOT_LINKED':
      return 'PSB_IDENTITY_NOT_LINKED';
    case 'WORKSPACE_OCCUPIED_BY_OTHER':
      return 'PSB_WORKSPACE_OCCUPIED_BY_OTHER';
    case 'CLIENT_OFFLINE':
      return 'PSB_CLIENT_OFFLINE';
    // 工作区可见但未就绪（occupied 闸门 / 发送前重建都会遇到）：`planned` / `provisioning` /
    // `failed` / `deleting` 时不能写，等它就绪后重试即可 —— 与「找不到工作区」是不同的下一步。
    case 'WORKSPACE_NOT_READY':
      return 'PSB_WORKSPACE_NOT_READY';
    // 403「不是归属人」按找不到呈现（PSB-RW-08：不泄漏会话存在性）。
    case 'NOT_FOUND':
    case 'FORBIDDEN':
      return 'PSB_NOT_FOUND';
    case 'PSB_UNREACHABLE':
      return 'PSB_UNREACHABLE';
    case 'PSB_STREAM_UNSUPPORTED':
    case 'PSB_STREAM_NOT_READY':
      return 'PSB_STREAM_UNAVAILABLE';
    // 输入没有可用的活动连接：可恢复（先启动观看），因此不并进「不支持串流」。
    case 'PSB_STREAM_NOT_ACTIVE':
      return 'PSB_STREAM_NOT_ACTIVE';
    default:
      return null;
  }
}

/** 失败码 → 文案键；不是 PSB 失败码返回 `null`（调用方回落通用文案）。 */
export function psbFailureMessageKeyForIpcCode(code: string): string | null {
  return (PSB_IPC_FAILURE_MESSAGE_KEYS as Record<string, string>)[code] ?? null;
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
const PSB_IPC_BANNER_MESSAGE_KEYS: Record<string, string> = {
  ...PSB_IPC_FAILURE_MESSAGE_KEYS,
  PSB_WORKSPACE_OCCUPIED_BY_OTHER: 'remoteWorkspace.error.workspaceOccupied',
};

/** 错误横幅用：失败码 → 文案键（含无名字兜底）；不是 PSB 失败码返回 `null`。 */
export function psbBannerMessageKeyForIpcCode(code: string): string | null {
  return (PSB_IPC_BANNER_MESSAGE_KEYS as Record<string, string>)[code] ?? null;
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
