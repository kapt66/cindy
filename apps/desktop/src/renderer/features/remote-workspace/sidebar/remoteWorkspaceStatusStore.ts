/**
 * 远程工作区（`psb:` 会话）的侧栏状态缓存。
 *
 * ## 它解决什么
 *
 * 侧栏会话行要画「在线 / 离线 / 使用中 / 准备中 / 失败 / 不支持 Agent」标签与占用锁
 * （产品正本 `docs/product-rules/psb-remote-workspace-sessions.md` §2.1）。这些状态**不是**
 * 会话行自己的字段，而是它所在**工作区**的状态：
 *
 *   - 在线 / 工作区状态 / 占用视角 ← `PsbRemoteWorkspace`（`psbWorkspaceHealth` 计算口径）
 *   - 变化通知 ← `bridge.onWorkspaceChanged` 推送
 *
 * 如果每行各自发一次请求，侧栏一次渲染就会打出一串 PSB 请求（网络风暴 + 没有跨行一致的
 * 快照）。所以这里收口成**一个进程内缓存**：
 *
 *   1. 批量拉取：`bridge.refreshWorkspaces()` 一次拿全部工作区，10~15s TTL 节流 + 聚焦补拉；
 *   2. 推送增量：`onWorkspaceChanged` 单条更新，不整表重拉；
 *   3. 引用计数：只有侧栏「远程工作区」节点挂载期间才轮询（`retain()`），卸载后停；
 *   4. 快照稳定：内容没变的工作区保留旧对象引用，行上的 `useSyncExternalStore` 因此不会
 *      因为一次轮询而重渲染（`SessionItem` 的 memo 红线，见
 *      `features/cc-agent/sidebar/SessionItem.tsx` 文件头性能不变量）。
 *
 * ## 会话 → 工作区怎么对上
 *
 * `psb:<PSB sessionId>` 里只有 PSB 会话 id，没有工作区 id；IPC 面也没有「会话→工作区」的
 * 批量查询（见 `docs/dev-rules/psb-remote-session-transport.md` §4 的通道清单）。解析只用
 * **虚拟工作目录反查**：会话行的 `workingDir` 是 `/psb-remote/<目录名或工作区 id>`
 * （共享契约 `buildPsbVirtualWorkingDir`，草稿页写草稿目标时用的是同一个纯函数），用它反查
 * 工作区；命中多个（跨客户端同名目录）时放弃，宁可不显示也不贴错状态。
 *
 * 没有「会话 id → 工作区」的显式绑定：远端工作区会话的 `psb:<id>` 是**首条消息建会话时**
 * 才由草稿页生成的，侧栏在弹窗阶段拿不到会话 id；绑定表还会在重启后失效，不如只留一条
 * 可解释的反查规则。
 *
 * 兜底：用户点击行首图标按钮时用一次 `bridge.sessionStatus()` 解析（显式动作、非渲染期请求），
 * 只用于本次打开网页，不写入缓存。
 *
 * 已知限制：既没有虚拟工作目录、又反查不唯一的会话不显示状态标签与锁（不会显示错的状态）。
 */

import { buildPsbVirtualWorkingDir, type PsbRemoteWorkspace } from '../../../../shared/psb-remote-workspace';
import { createLogger } from '@/lib/logger';
import { tryGetPsbRemoteBridge } from '../bridge';
import { remoteWorkspacePsbSessionId } from './isRemoteWorkspaceSession';

const log = createLogger('RemoteWorkspaceSidebar');

/** 状态刷新节流（批量拉取的最小间隔）：侧栏行上的标签不需要秒级实时。 */
const REFRESH_TTL_MS = 12_000;

/**
 * 轮询间隔（节点挂载期间）。
 *
 * 与 `REFRESH_TTL_MS` **分开**：TTL 是「两次批量拉取至少隔多久」的节流，轮询是「多久主动刷一次」
 * 的节奏。用同一个常量会让轮询永远刚好卡在 TTL 边界上（浮点/调度抖动时被节流吞掉一次，
 * 表现为偶尔 24s 才更新），也让「聚焦补拉」「推送增量」与轮询互相污染。轮询略长于 TTL，
 * 保证每次轮询都能真的发请求。
 */
const POLL_INTERVAL_MS = 15_000;

/** 侧栏会话行解析工作区所需的字段（`Session` 满足该结构）。 */
export interface RemoteWorkspaceSidebarSessionLike {
  readonly id: string;
  readonly remoteHostId?: string | null;
  readonly workingDir?: string | null;
}

export interface RemoteWorkspaceSidebarSnapshot {
  /** 工作区表版本号：每次批量刷新 / 推送都会 +1。 */
  readonly revision: number;
  /** 最近一次批量刷新是否失败（用于侧栏空态给「读不到列表」而不是「没有会话」）。 */
  readonly loadFailed: boolean;
}

let workspacesById = new Map<string, PsbRemoteWorkspace>();
const listListeners = new Set<() => void>();
let snapshot: RemoteWorkspaceSidebarSnapshot = { revision: 0, loadFailed: false };
let loadedAtMs = 0;
let inFlight: Promise<void> | null = null;
let releaseBridgeEvents: (() => void) | null = null;
let retainCount = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let focusRegistered = false;
/**
 * 会话 → 工作区反查的**单次解析缓存**：侧栏同一行会挂两个装饰组件（外链按钮 + 状态徽标），
 * 它们各自调用 `resolveRemoteWorkspaceForSession`，一次渲染就是两次全表扫描。
 * 键里带 `snapshot.revision`，任何批量刷新/推送都会让缓存自然失效。
 */
let resolveCacheKey: string | null = null;
let resolveCacheResult: PsbRemoteWorkspace | null = null;

function publishListChange(loadFailed: boolean): void {
  snapshot = { revision: snapshot.revision + 1, loadFailed };
  resolveCacheKey = null;
  resolveCacheResult = null;
  for (const listener of listListeners) listener();
}

/** 列表级快照（版本号 + 上次刷新失败态）；引用稳定，只在内容变化时替换。 */
export function getRemoteWorkspaceSnapshot(): RemoteWorkspaceSidebarSnapshot {
  return snapshot;
}

export function subscribeRemoteWorkspaceList(listener: () => void): () => void {
  listListeners.add(listener);
  return () => {
    listListeners.delete(listener);
  };
}

/**
 * 行投影：**只包含会渲染到侧栏行上的字段**。
 *
 * 旧实现手列 14 个字段做逐字段比较：新增一个渲染字段时要么忘记加（状态不刷新），要么把
 * 只用于其它入口的字段也塞进来（无谓地让整行重渲染）。这里让「比较什么」由投影结构直接表达：
 * 投影里有什么字段，就是行会读到什么；没进投影的字段变化不会替换对象引用。
 */
interface RemoteWorkspaceRowProjection {
  readonly id: string;
  readonly title: string;
  readonly clientName: string;
  readonly templateTitle: string | null;
  readonly directoryName: string | null;
  readonly state: string | null;
  readonly clientOnline: boolean;
  readonly usable: boolean;
  readonly unusableReason: string | null;
  readonly occupancy: {
    readonly occupied: boolean;
    readonly byMe: boolean;
    readonly personId: string | null;
    readonly personName: string;
    readonly occupiedAt: number | null;
  };
}

function workspaceRowProjection(workspace: PsbRemoteWorkspace): RemoteWorkspaceRowProjection {
  return {
    id: workspace.id,
    title: workspace.title,
    clientName: workspace.clientName,
    templateTitle: workspace.templateTitle,
    directoryName: workspace.directoryName,
    state: workspace.state,
    clientOnline: workspace.clientOnline,
    usable: workspace.usable,
    unusableReason: workspace.unusableReason,
    occupancy: {
      occupied: workspace.occupancy.occupied,
      byMe: workspace.occupancy.byMe,
      personId: workspace.occupancy.personId,
      personName: workspace.occupancy.personName,
      occupiedAt: workspace.occupancy.occupiedAt,
    },
  };
}

/** 两个行投影是否完全相同（字段少、浅比较；`occupancy` 是唯一嵌套对象）。 */
function sameRowProjection(
  a: RemoteWorkspaceRowProjection,
  b: RemoteWorkspaceRowProjection,
): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.clientName === b.clientName &&
    a.templateTitle === b.templateTitle &&
    a.directoryName === b.directoryName &&
    a.state === b.state &&
    a.clientOnline === b.clientOnline &&
    a.usable === b.usable &&
    a.unusableReason === b.unusableReason &&
    a.occupancy.occupied === b.occupancy.occupied &&
    a.occupancy.byMe === b.occupancy.byMe &&
    a.occupancy.personId === b.occupancy.personId &&
    a.occupancy.personName === b.occupancy.personName &&
    a.occupancy.occupiedAt === b.occupancy.occupiedAt
  );
}

/** 行投影不变时保留旧对象引用：行上的快照不变 → React 不重渲染这一行。 */
function mergeWorkspace(
  previous: PsbRemoteWorkspace | undefined,
  next: PsbRemoteWorkspace,
): PsbRemoteWorkspace {
  if (!previous) return next;
  return sameRowProjection(workspaceRowProjection(previous), workspaceRowProjection(next))
    ? previous
    : next;
}

/**
 * 批量刷新工作区状态（**一次** IPC，全表替换）。渲染期不逐行请求的唯一入口。
 *
 * - `force = false`（默认）：TTL 内直接返回；轮询与聚焦补拉传 `true`。
 * - 失败也记 `loadedAtMs`：错误不应该把重试放大成风暴，等下一档再试。
 */
export function refreshRemoteWorkspaces(force = false): Promise<void> {
  const bridge = tryGetPsbRemoteBridge();
  // 旧 preload / 单测 / 非主窗口：保持「不可用」，不抛错也不轮询重试。
  if (!bridge) return Promise.resolve();
  if (inFlight) return inFlight;
  if (!force && Date.now() - loadedAtMs < REFRESH_TTL_MS) return Promise.resolve();
  inFlight = bridge
    .refreshWorkspaces()
    .then((result) => {
      const previous = workspacesById;
      const next = new Map<string, PsbRemoteWorkspace>();
      for (const workspace of result.workspaces) {
        next.set(workspace.id, mergeWorkspace(previous.get(workspace.id), workspace));
      }
      workspacesById = next;
      loadedAtMs = Date.now();
      publishListChange(false);
    })
    .catch((error: unknown) => {
      loadedAtMs = Date.now();
      publishListChange(true);
      log.warn('refresh workspaces failed', error);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * 解析一条会话所属的工作区快照；解析不出来返回 `null`（行上不显示状态标签与锁）。
 *
 * 解析依据只有一条：会话行的虚拟 `workingDir` 是 `/psb-remote/<目录名或工作区 id>`
 * （共享契约 `buildPsbVirtualWorkingDir`，草稿页写草稿目标时用的是同一个纯函数），
 * 用它反查工作区。**没有会话 id 的显式绑定** —— 远端工作区会话的 `psb:<id>` 是首条消息
 * 建会话时才生成的，弹窗阶段拿不到，所以绑定表本来就会在重启后失效，不如只留一条可解释的
 * 反查规则。
 *
 * 同时接受「带目录名」与「只有工作区 id」两种形态：草稿目标里的 `directoryName` 可能为空
 * （例如弹窗刚建出、PSB 还在准备中），也可能在 PSB 侧后来被改掉；只按当前 `directoryName`
 * 匹配会让这类会话掉标签。命中多个（跨客户端同名目录）时放弃，宁可不显示也不贴错状态。
 *
 * 内容没变时返回同一个对象引用，因此可以安全地作为 `useSyncExternalStore` 的快照函数。
 */
export function resolveRemoteWorkspaceForSession(
  session: RemoteWorkspaceSidebarSessionLike | null | undefined,
): PsbRemoteWorkspace | null {
  if (!session) return null;
  if (remoteWorkspacePsbSessionId(session) === null) return null;
  const workingDir = session.workingDir?.trim();
  if (!workingDir) return null;
  const cacheKey = `${snapshot.revision}\u0000${workingDir}`;
  if (resolveCacheKey === cacheKey) return resolveCacheResult;
  let found: PsbRemoteWorkspace | null = null;
  for (const workspace of workspacesById.values()) {
    if (!matchesVirtualWorkingDir(workspace, workingDir)) continue;
    if (found) {
      found = null;
      break;
    }
    found = workspace;
  }
  resolveCacheKey = cacheKey;
  resolveCacheResult = found;
  return found;
}

/** 会话的虚拟工作目录是否属于这个工作区（接受带目录名与仅 id 两种落库形态）。 */
function matchesVirtualWorkingDir(
  workspace: PsbRemoteWorkspace,
  workingDir: string,
): boolean {
  const idOnly = buildPsbVirtualWorkingDir({ workspaceId: workspace.id, directoryName: null });
  if (workingDir === idOnly) return true;
  const withDirectoryName = buildPsbVirtualWorkingDir({
    workspaceId: workspace.id,
    directoryName: workspace.directoryName,
  });
  return workingDir === withDirectoryName;
}

function handleWindowFocus(): void {
  void refreshRemoteWorkspaces(true);
}

/**
 * 侧栏「远程工作区」节点挂载期间保留轮询与推送（引用计数）。
 *
 * 第一个订阅者进来时：订阅 `onWorkspaceChanged` + 立刻刷新 + 起 12s 轮询 + 聚焦补拉；
 * 最后一个离开时全部停掉（不为一个不可见的节点持续打 PSB）。
 */
export function retainRemoteWorkspaceStatus(): () => void {
  retainCount += 1;
  if (retainCount === 1) {
    const bridge = tryGetPsbRemoteBridge();
    if (bridge) {
      releaseBridgeEvents = bridge.onWorkspaceChanged((event) => {
        if (event.workspace) {
          const previous = workspacesById.get(event.workspace.id);
          const next = new Map(workspacesById);
          next.set(event.workspace.id, mergeWorkspace(previous, event.workspace));
          workspacesById = next;
        } else if (workspacesById.has(event.workspaceId)) {
          const next = new Map(workspacesById);
          next.delete(event.workspaceId);
          workspacesById = next;
        } else {
          return;
        }
        publishListChange(false);
      });
    }
    void refreshRemoteWorkspaces(true);
    pollTimer = setInterval(() => {
      void refreshRemoteWorkspaces(true);
    }, POLL_INTERVAL_MS);
    if (typeof window !== 'undefined' && !focusRegistered) {
      focusRegistered = true;
      window.addEventListener('focus', handleWindowFocus);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retainCount = Math.max(0, retainCount - 1);
    if (retainCount > 0) return;
    releaseBridgeEvents?.();
    releaseBridgeEvents = null;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (typeof window !== 'undefined' && focusRegistered) {
      focusRegistered = false;
      window.removeEventListener('focus', handleWindowFocus);
    }
    // 释放引用后不留陈旧快照：下次打开侧栏重新拉，避免展示很久以前占用状态。
    workspacesById = new Map();
    resolveCacheKey = null;
    resolveCacheResult = null;
    inFlight = null;
    loadedAtMs = 0;
    // **清空也要 publish**：否则已经挂着的会话行还拿着旧工作区引用，占用锁/状态标签不会消失
    // （旧实现只在清空前不通知，节点收起后行上残留「使用中」）。
    snapshot = { revision: snapshot.revision + 1, loadFailed: false };
    for (const listener of listListeners) listener();
  };
}

/** 单测用：清空模块级缓存与订阅（生产代码走 `retain()` 的释放路径）。 */
export function resetRemoteWorkspaceStatusForTest(): void {
  releaseBridgeEvents?.();
  releaseBridgeEvents = null;
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (typeof window !== 'undefined' && focusRegistered) {
    window.removeEventListener('focus', handleWindowFocus);
    focusRegistered = false;
  }
  workspacesById = new Map();
  resolveCacheKey = null;
  resolveCacheResult = null;
  listListeners.clear();
  snapshot = { revision: 0, loadFailed: false };
  loadedAtMs = 0;
  inFlight = null;
  retainCount = 0;
}
