/**
 * PSB「待释放占用」常驻提示条的 UI store（2026-11-27，T3 释放失败账本 UI 消费）。
 *
 * ## 为什么需要这一层
 *
 * 释放失败过去只 `log.warn`：PSB 协作锁没有 TTL，用户把远程任务归档 / 删除后，如果释放
 * 失败（网络 / 鉴权 / 5xx），那把锁仍挂在自己名下，同事或自己的另一台设备会被
 * `PSB_WORKSPACE_OCCUPIED_BY_OTHER` 挡住，而用户完全不知道。产品 §2.5 / §2.7 / §8 要求
 * **非阻塞提示 + 常驻提示条 + 显式重试**；两个数据源（main 账本、渲染层工作区级账本）此前
 * 都已记账，但渲染层 0 调用方。
 *
 * ## 两个数据源（两本账本不合并，展示按 workspaceId 去重）
 *
 * 1. **main 账本**（`cc-agent/psbOccupancyRelease` 缓存的 `PENDING_RELEASES_*` 快照）：
 *    会话结束释放失败的权威事实。key 空间是 `(sessionId, reason)`；DTO 现已带
 *    `workspaceId`（失败那一次已读到的 PSB 工作区，`shared/psb-remote-workspace.ts` §7b；
 *    读会话行就失败时为 `null`）。
 * 2. **工作区级账本**（`draft/psbPendingReleaseLedger`）：picker 放弃草稿 / 在途取消时渲染层
 *    直接调 `releaseWorkspace` 失败的记录，key 空间是 `workspaceId`。
 *
 * 两本账本**存储与 key 空间仍不合并**（产品 §2.5），但展示按 `workspaceId` 跨源去重：同一把
 * 工作区锁只出现一条（main 条目优先，工作区级作为补充）；main 内部同一 `workspaceId` 也只留
 * 最近失败的那条。没有 `workspaceId` 的 main 条目（读会话行就失败）按来源 key
 * `session:<key>` 保留——它们代表的可释放义务无法与工作区级条目对齐，不能猜着合并。
 * 去重让计数 = **可能被占住的工作区数**（而不是记账次数），原因行不重复，重试也不会对同一
 * 工作区打两次（见 `retryPendingPsbReleasesEverywhere`）。
 *
 * ## 失败码归一
 *
 * main 账本的 `failureCode` 是 **PSB 原始码**（`AUTH_INVALID` / `CLIENT_OFFLINE` / `HTTP_5xx` /
 * `PSB_PROTOCOL` …），不是跨 IPC 的 `PSB_*` IPC 码；渲染层文案出口 `psbFailureText` 只认 IPC
 * 码。所以这里用共享单表的 `psbFailureDescriptorForPsbCode` 把原始码归一到描述符（文案键），
 * 再交给 `psbFailureText`——已知 PSB 失败不再落成 PSB 原文 / 通用文案。归一不了的码
 * （`PSB_PROTOCOL` / `HTTP_5xx` / 未来新码）保留原始码：`psbFailureText` 先查
 * `ipcError.<CODE>`，再按它的既有约定把可读 PSB 原文当正文（比通用文案可行动），原文不做
 * 重复诊断行。
 *
 * ## 交互口径
 *
 * - 重试是**唯一入口** `retryPendingPsbReleasesEverywhere()`：先重试 main 账本（走
 *   `retryPendingWorkspaceReleases` IPC），再重试工作区级账本（走 `releaseWorkspace`）。
 *   不允许界面上出现两个「重试」按钮。同一工作区两本账并存时由 main 那次重试代表（它是会话
 *   结束释放的权威），工作区级重复条目出账，不再单独打一次 `releaseWorkspace`。
 * - 不自动重试（工程契约 §3.2）：只有用户点重试 / 应用退出（main 自己）会重放写操作。
 * - 关闭 = 本会话不再显示**当前这一批**条目（`dismissedFingerprint`）；账本仍在，用户主动
 *   重试或新的失败（fingerprint 变化）会重新显示。模块级状态，组件因路由 / 条件卸载重挂后
 *   不会把用户关掉的提示又弹回来。
 */

import {
  listPendingWorkspaceReleasesFromMain,
  retryPendingWorkspaceReleasesInMain,
  subscribePendingWorkspaceReleases,
} from '@/features/cc-agent/psbOccupancyRelease';
import {
  psbFailureDescriptorForPsbCode,
  type PsbPendingWorkspaceReleaseInfo,
  type PsbPendingWorkspaceReleasesRetryResult,
} from '../../../../shared/psb-remote-workspace';
import type { PsbRemoteBridge } from '../bridge';
import { tryGetPsbRemoteBridge } from '../bridge';
import { psbFailureDiagnosticText } from '../dialog/psbFailure';
import type { PsbFailureLike } from '../psbFailureText';
import { stripPsbFailureCodePrefix } from '../psbFailureText';
import {
  clearPsbPendingRelease,
  listPsbPendingReleases,
  retryPsbPendingReleases,
  subscribePsbPendingReleases,
  type PsbPendingReleaseEntry,
} from '../draft/psbPendingReleaseLedger';

/** 一条待释放项的来源（两本账本；UI 只用它做 main 优先去重与诊断，不改变重试目标）。 */
export type PendingReleaseNoticeSource = 'main' | 'workspace';

/** 合并后的一条待释放项（提示条按它渲染原因行）。 */
export interface PendingReleaseNoticeItem {
  /**
   * 来源内去重身份（稳定）：main = `session:<key>`，工作区级 = `workspace:<workspaceId>`。
   *
   * 跨源去重不靠它，靠 {@link workspaceId}（见 `mergePendingReleaseNoticeItems`）；前缀只保证
   * 「同一个 workspaceId 在两本账里各有一条」时两条 id 不会相撞。
   */
  readonly id: string;
  readonly source: PendingReleaseNoticeSource;
  /** main 是 PSB 会话 id，工作区级是 workspaceId（只用于排查 / 行 title，不是凭据）。 */
  readonly identity: string;
  /**
   * PSB 工作区 id：main 条目取失败时已读到的 `workspaceId`（读会话行就失败时 `null`），
   * 工作区级条目就是自己的 `workspaceId`。跨源合并去重与重试去重都用它。
   */
  readonly workspaceId: string | null;
  readonly attempts: number;
  /** 最近一次失败时间（main: updatedAt / 工作区级: lastFailedAt）；只用于稳定排序与关闭指纹。 */
  readonly updatedAt: number;
  /** 交给 `psbFailureText` 的失败事实（码表在共享契约，唯一映射点）。 */
  readonly failure: PsbFailureLike;
  /** 归一化后的 PSB / 本机原文（诊断行；正文已消费时为 `null`）。 */
  readonly detail: string | null;
}

/** 提示条快照（`useSyncExternalStore` 的 getSnapshot；没变化时返回同一引用）。 */
export interface PendingReleaseNoticeSnapshot {
  readonly items: readonly PendingReleaseNoticeItem[];
  readonly count: number;
  /** 关闭指纹：条目集合 + 每次失败的尝试次数/时间，变了就代表「新的一批」。 */
  readonly fingerprint: string;
  /** 用户是否已关闭**当前这一批**条目。 */
  readonly dismissed: boolean;
}

export interface PendingReleaseNoticeDeps {
  getBridge?: () => PsbRemoteBridge | null;
}

/** 一次统一重试的结果（UI 只用于「重试后是否仍有条目」与诊断日志）。 */
export interface PendingReleaseRetrySummary {
  /** 本次实际尝试的释放数（两本账相加）。 */
  readonly attempted: number;
  readonly released: number;
  readonly failed: number;
  /** 重试后仍待处理的合并条目数（0 = 提示条自动消失）。 */
  readonly remaining: number;
  /** 旧 preload 缺 main 账本方法时为 `true`（本次只重试了工作区级账本）。 */
  readonly mainRetryUnavailable: boolean;
}

/**
 * main 账本的 `failureCode`（PSB 原始码）→ 交给 `psbFailureText` 的失败事实。
 *
 * main 账本记的是 `PsbRemoteFailure.code`（`AUTH_INVALID` / `CLIENT_OFFLINE` / `HTTP_5xx` /
 * `PSB_PROTOCOL` …），而 `psbFailureText` 只按 **IPC 码**查共享单表与 `ipcError.<CODE>`。直接
 * 原样传会让已知失败（鉴权过期 / 客户端离线 / 未链接身份…）落成 PSB 原文或通用文案，所以先用
 * `psbFailureDescriptorForPsbCode` 归一：
 *
 * - 能归一 → 交描述符的文案键（共享单表的唯一映射点，不在这里另抄 code→文案表）；
 * - 不能归一（`PSB_PROTOCOL` / `HTTP_5xx` / 未来新码）→ 保留原始码：`psbFailureText` 先查
 *   `ipcError.<CODE>`，再按它的既有约定把可读 PSB 原文当正文（比通用文案可行动）；
 * - 没有码 → 正文落通用文案，PSB 原文只做诊断行。
 */
function mainLedgerFailure(failureCode: string | null, detail: string | null): PsbFailureLike {
  const rawCode = failureCode?.trim() || null;
  if (!rawCode) return { code: null, message: detail };
  const descriptor = psbFailureDescriptorForPsbCode(rawCode);
  if (!descriptor) return { code: rawCode, message: detail };
  // 归一后只给文案键：原始 PSB 码不是 IPC 码，继续传下去只会在 `ipcError.<raw>` 里白查一次。
  return { code: null, messageKey: descriptor.messageKey, message: detail };
}

function mainItem(entry: PsbPendingWorkspaceReleaseInfo): PendingReleaseNoticeItem {
  const detail = stripPsbFailureCodePrefix(entry.lastError ?? '');
  return {
    // main 账本的 key 由 `(sessionId, reason)` 组成，正常已唯一；旧 main / 重复推送时按它去重。
    id: `session:${entry.key}`,
    source: 'main',
    identity: entry.psbSessionId || entry.remoteHostId,
    workspaceId: entry.workspaceId?.trim() || null,
    attempts: entry.attempt,
    updatedAt: entry.updatedAt,
    // 码表映射在 `psbFailureText`：原始 PSB 码先归一到共享单表描述符；没有码时正文落通用文案、原文走 detail。
    failure: mainLedgerFailure(entry.failureCode, detail || null),
    detail: detail || null,
  };
}

function workspaceItem(entry: PsbPendingReleaseEntry): PendingReleaseNoticeItem {
  return {
    // 工作区级账本自己按 workspaceId 去重；这里再兜一次（旧持久化 / 重复 record）。
    id: `workspace:${entry.workspaceId}`,
    source: 'workspace',
    identity: entry.workspaceId,
    workspaceId: entry.workspaceId,
    attempts: entry.attempts,
    updatedAt: entry.lastFailedAt,
    failure: entry.failure,
    detail: psbFailureDiagnosticText(entry.failure),
  };
}

/**
 * 合并两本账本（main 在前、工作区级在后；组内保持账本自己的顺序），**按 workspaceId 跨源去重**。
 *
 * 规则：
 * - 同一把工作区锁只展示一条：main 条目优先（main 是会话结束释放的单权威），工作区级条目只在
 *   main 没有覆盖该工作区时作为补充；
 * - main 内部同一 `workspaceId` 也只留一条（取 `updatedAt` 最近的那次失败，行内原因才是当前
 *   可重试的错误；两条 main 记录通常只来自多任务同工作区并发失败，锁只有一把）；
 * - 没有 `workspaceId` 的 main 条目（读 PSB 会话行就失败）无法与工作区对齐，按来源 key
 *   `session:<key>` 保留——宁可多一条，也不猜着合并两条不同的待释放义务。
 *
 * 不在这里截断条数：两本账本各自有界（main 64 / 工作区级 16），截断会让计数与「还剩几条」
 * 说谎；提示条只限制**展示**的原因行数（`PsbPendingReleaseNotice` 的 `MAX_REASON_ROWS`）。
 */
export function mergePendingReleaseNoticeItems(
  mainReleases: readonly PsbPendingWorkspaceReleaseInfo[],
  workspaceReleases: readonly PsbPendingReleaseEntry[],
): readonly PendingReleaseNoticeItem[] {
  const mainItems = mainReleases.map(mainItem);
  // main 内同一工作区选「最近一次失败」那条代表该锁；时间相同取先出现者（账本顺序稳定）。
  const representativeByWorkspace = new Map<string, PendingReleaseNoticeItem>();
  for (const item of mainItems) {
    if (!item.workspaceId) continue;
    const current = representativeByWorkspace.get(item.workspaceId);
    if (!current || item.updatedAt > current.updatedAt) {
      representativeByWorkspace.set(item.workspaceId, item);
    }
  }

  const items: PendingReleaseNoticeItem[] = [];
  const seenIds = new Set<string>();
  /** 已展示过的工作区（决定工作区级条目是否还有补充价值）。 */
  const coveredWorkspaces = new Set<string>();
  for (const item of mainItems) {
    if (seenIds.has(item.id)) continue;
    if (item.workspaceId) {
      if (coveredWorkspaces.has(item.workspaceId)) continue;
      if (representativeByWorkspace.get(item.workspaceId)?.id !== item.id) continue;
      coveredWorkspaces.add(item.workspaceId);
    }
    seenIds.add(item.id);
    items.push(item);
  }
  for (const entry of workspaceReleases) {
    const item = workspaceItem(entry);
    if (seenIds.has(item.id)) continue;
    if (item.workspaceId && coveredWorkspaces.has(item.workspaceId)) continue;
    seenIds.add(item.id);
    if (item.workspaceId) coveredWorkspaces.add(item.workspaceId);
    items.push(item);
  }
  return items;
}

function fingerprintOf(items: readonly PendingReleaseNoticeItem[]): string {
  return items
    .map((item) => `${item.id}#${item.attempts}#${item.updatedAt}`)
    .sort()
    .join('|');
}

let cachedSnapshot: PendingReleaseNoticeSnapshot | null = null;
let dismissedFingerprint: string | null = null;
const listeners = new Set<() => void>();
let sourceRelease: (() => void) | null = null;

function invalidatePendingReleaseNotice(): void {
  cachedSnapshot = null;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 单个订阅者异常不影响提示条 / 其它订阅者。
    }
  }
}

/**
 * 提示条快照（`getSnapshot` 必须返回稳定引用直到数据变化，否则 render 会死循环）。
 *
 * 不用「缓存在某个时刻失效」的写法：账本可能在最后一个订阅者卸载后继续变化（例如提示条
 * 因窗口条件卸载、后台 main 推送到达），只靠订阅失效会让下一次挂载读到旧缓存。这里每次按
 * 两本账本重建并比较指纹，指纹相同才复用上一份对象（引用稳定），保证跨卸载 / 重挂正确。
 */
export function readPendingReleaseNoticeSnapshot(): PendingReleaseNoticeSnapshot {
  const items = mergePendingReleaseNoticeItems(
    listPendingWorkspaceReleasesFromMain(),
    listPsbPendingReleases(),
  );
  const fingerprint = fingerprintOf(items);
  // 空账本时 dismissed 无意义（提示条本来就不渲染）。
  const dismissed = items.length > 0 && dismissedFingerprint === fingerprint;
  const cached = cachedSnapshot;
  if (
    cached
    && cached.fingerprint === fingerprint
    && cached.count === items.length
    && cached.dismissed === dismissed
  ) {
    return cached;
  }
  cachedSnapshot = { items, count: items.length, fingerprint, dismissed };
  return cachedSnapshot;
}

/**
 * 订阅合并快照（首次订阅时接上两个数据源；最后一个订阅者卸载时断开）。
 *
 * 接数据源放在这里而不是组件：提示条只有主窗一个挂载点，数据源的生命周期与它一致；
 * 反过来如果 App 和组件各订阅一次，同一次推送会重复更新快照（无害但白费）。
 */
export function subscribePendingReleaseNotice(listener: () => void): () => void {
  listeners.add(listener);
  if (!sourceRelease) {
    const releaseMain = subscribePendingWorkspaceReleases(invalidatePendingReleaseNotice);
    const releaseWorkspace = subscribePsbPendingReleases(invalidatePendingReleaseNotice);
    sourceRelease = () => {
      releaseMain();
      releaseWorkspace();
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    const release = sourceRelease;
    sourceRelease = null;
    release?.();
  };
}

/** 关闭（稍后）：本会话不显示当前这一批；账本与重试能力不变。 */
export function dismissPendingReleaseNotice(): void {
  dismissedFingerprint = readPendingReleaseNoticeSnapshot().fingerprint;
  invalidatePendingReleaseNotice();
}

/** main 账本里已覆盖的工作区（只统计能对齐到 workspaceId 的条目）。 */
function mainLedgerWorkspaces(
  releases: readonly PsbPendingWorkspaceReleaseInfo[],
): ReadonlySet<string> {
  const workspaces = new Set<string>();
  for (const release of releases) {
    const workspaceId = release.workspaceId?.trim();
    if (workspaceId) workspaces.add(workspaceId);
  }
  return workspaces;
}

/**
 * **唯一**的重试入口（提示条「重试」按钮）：main 账本 + 工作区级账本各重试一次。
 *
 * 同一工作区两本账并存时只由 main 那次重试代表（main 是会话结束释放的单权威），工作区级重复
 * 条目直接出账：
 * - main 这次释放成功 → 锁已归还，工作区级副本是陈旧事实（不出账会让提示条多留一轮、用户还
 *   得再点一次）；
 * - main 这次仍失败 → 由 main 账本继续负责重试，本次不再对同一把锁打第二次 `releaseWorkspace`
 *   （旧实现的「重试双打」）。
 * 只有本次真的重试过 main（`mainResult !== null`）才做这步：旧 preload 缺 main 账本方法时两本
 * 账互不可替代，工作区级条目照旧各自重试。
 *
 * 不抛错：两个数据源的重试函数各自吞掉失败并更新账本；UI 用 `remaining` 决定是否继续显示。
 */
export async function retryPendingPsbReleasesEverywhere(
  deps: PendingReleaseNoticeDeps = {},
): Promise<PendingReleaseRetrySummary> {
  const mainBefore = listPendingWorkspaceReleasesFromMain();
  const workspaceBefore = listPsbPendingReleases();
  const mainResult: PsbPendingWorkspaceReleasesRetryResult | null =
    await retryPendingWorkspaceReleasesInMain(deps);
  if (mainResult) {
    const coveredByMain = mainLedgerWorkspaces(mainBefore);
    for (const entry of workspaceBefore) {
      if (coveredByMain.has(entry.workspaceId)) clearPsbPendingRelease(entry.workspaceId);
    }
  }
  // 去重后仍归本端重试的工作区（main 账本已经代表过的那些已在上一步出账）。
  const workspaceTargets = listPsbPendingReleases();
  const bridge = (deps.getBridge ?? tryGetPsbRemoteBridge)();
  // 没有桥（旧 preload 整体缺失 / 单测）时不能假装重试过：条目原样保留。
  const workspaceRemaining = bridge
    ? await retryPsbPendingReleases(() => bridge)
    : workspaceTargets.map((entry) => entry.workspaceId);
  const workspaceReleased = bridge ? Math.max(0, workspaceTargets.length - workspaceRemaining.length) : 0;
  const workspaceFailed = bridge ? workspaceRemaining.length : 0;
  // 两本账都没变化时缓存仍是旧值：显式失效后再数剩余条目。
  invalidatePendingReleaseNotice();
  return {
    attempted: (mainResult?.attempted ?? 0) + (bridge ? workspaceTargets.length : 0),
    released: (mainResult?.released ?? 0) + workspaceReleased,
    failed: (mainResult?.failed ?? 0) + workspaceFailed,
    remaining: readPendingReleaseNoticeSnapshot().count,
    mainRetryUnavailable: mainResult === null,
  };
}

/** 单测隔离：清空关闭指纹、缓存与订阅（不触碰两个数据源自己的账本）。 */
export function resetPendingReleaseNoticeStoreForTest(): void {
  cachedSnapshot = null;
  dismissedFingerprint = null;
  listeners.clear();
  const release = sourceRelease;
  sourceRelease = null;
  release?.();
}
