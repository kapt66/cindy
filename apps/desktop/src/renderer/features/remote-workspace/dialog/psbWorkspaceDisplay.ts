/**
 * 工作区选择器的**显示口径**（弹窗行 / 草稿页下拉行 / 项目胶囊 / 管理页页头同源，唯一实现）。
 *
 * 2026-11-27 用户人工复测：**实例名是工作区自己的目录名**（PSB `directoryName`，如
 * `saga2_project-3`），**模板名只是模板**（`templateTitle`，如 `saga2_project`）。同一个模板可以
 * 建出多个工作区，把模板名当主标签会让这些工作区在列表 / 页头 / 胶囊里看起来一模一样。
 *
 * 主标签优先级：`directoryName`（trim 非空）→ `title` → `<机器>-<短 id>` → 短 id。模板名与机器名
 * 只作**次要信息**（`psbWorkspaceSecondaryText`，固定顺序「模板名 · 机器名」）。目录名缺失只可能是
 * 老数据 / PSB 还没回填 / 手改脏数据，此时回退 `title`（旧口径，不新增兜底）。
 *
 * 同一个目录名可以出现在多台机器（同一模板在两个客户端各建一次）：区分先交给次要行的机器名；
 * 主标题与次要行**都撞**时由 `psbWorkspaceRowLabels` 追加短 id 消歧——否则两行在用户看来完全一样，
 * 选错工作区的代价是占用 / 会话落到别人的记录上。
 */

import type { PsbRemoteWorkspace, PsbWorkspaceHealth } from '../../../../shared/psb-remote-workspace';

/**
 * 工作区实例 id 的短显示形态：保留前 8 位（PSB id 形态不在 Cindy 侧解析，只截断显示）。
 *
 * 选择器（弹窗、草稿页位置渠道下拉、项目胶囊）必须共用这一份截断口径，否则同一个工作区
 * 在三处显示成三个名字。
 */
export function shortPsbWorkspaceId(workspaceId: string): string {
  const value = workspaceId.trim();
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

/** 次要信息（模板名 / 机器名）的连接符：中性分隔，**不进翻译**（两侧都是 PSB 事实）。 */
export const PSB_WORKSPACE_SECONDARY_SEPARATOR = ' · ';

/** 工作区选择器的显示名输入（弹窗行 / 下拉行 / 项目胶囊共用）。 */
export interface PsbWorkspaceDisplayParts {
  clientName: string;
  workspaceId: string;
  workspaceTitle?: string;
  /** 工作区目录名 = **实例名**（PSB `directoryName`）；缺失时回退 `workspaceTitle`。 */
  directoryName?: string | null;
}

/**
 * 工作区**实例名**的唯一口径：目录名优先，缺失回退标题（两者都 trim，空串表示没有）。
 *
 * 只有这一层决定「显示名从哪来」；`psbWorkspaceDisplayName` 与 `psbWorkspaceRowDisplayName` 都
 * 经它取实例名，管理页页头也用它（页头的空值占位由调用方补，不用短 id 兜底）。
 */
export function psbWorkspaceInstanceName(input: {
  directoryName?: string | null;
  workspaceTitle?: string | null;
}): string {
  const directoryName = input.directoryName?.trim() ?? '';
  if (directoryName) return directoryName;
  return input.workspaceTitle?.trim() ?? '';
}

/**
 * 工作区选择器的**显示名**口径（实例名优先；缺失才 `<机器>-<短 id>`，再短 id）。
 *
 * 胶囊只承载当前选中的那一个，不需要消歧；列表行由 `psbWorkspaceRowLabels` 统一消歧。
 */
export function psbWorkspaceDisplayName(parts: PsbWorkspaceDisplayParts): string {
  const instanceName = psbWorkspaceInstanceName(parts);
  if (instanceName) return instanceName;
  const shortId = shortPsbWorkspaceId(parts.workspaceId);
  const clientName = parts.clientName.trim();
  if (clientName && shortId) return `${clientName}-${shortId}`;
  return shortId || parts.workspaceId;
}

/**
 * 工作区次要信息（**模板名 · 机器名**）：单行、去重、` · ` 连接。
 *
 * `primaryName` = 主标签（实例名）。与主标签相同的值不再重复写一遍（模板名通常就是工作区标题的
 * 来源，去掉它才对得上「实例名是目录名、模板名只是模板」）；模板 / 机器都为空或都被去重掉时
 * 返回 `null` —— 主标签已经是目录名，再输出「目录：<同一个目录名>」只是重复。
 */
export function psbWorkspaceTemplateMachineText(input: {
  templateTitle?: string | null;
  clientName?: string | null;
  primaryName?: string | null;
}): string | null {
  const primaryName = input.primaryName?.trim() ?? '';
  const parts: string[] = [];
  for (const raw of [input.templateTitle, input.clientName]) {
    const value = raw?.trim() ?? '';
    if (!value || value === primaryName || parts.includes(value)) continue;
    parts.push(value);
  }
  return parts.length > 0 ? parts.join(PSB_WORKSPACE_SECONDARY_SEPARATOR) : null;
}

/** PSB 工作区行 → 选择器显示名（唯一映射：弹窗 / 下拉 / 项目胶囊同源）。 */
export function psbWorkspaceRowDisplayName(workspace: PsbRemoteWorkspace): string {
  return psbWorkspaceDisplayName({
    clientName: workspace.clientName,
    workspaceId: workspace.id,
    workspaceTitle: workspace.title,
    directoryName: workspace.directoryName,
  });
}

/**
 * 草稿页 PSB 目标（`psbTarget`，已持久化 / 跨重启恢复）→ 项目胶囊显示名。
 *
 * 它与 `psbWorkspaceRowDisplayName` 必须同一口径：胶囊显示什么，下拉行就显示什么。目标载荷里的
 * `directoryName` 是**加性可空**字段（旧草稿 / 旧路由 state 没有它），缺失时回退标题。
 */
export function psbWorkspaceTargetDisplayName(target: {
  workspaceId: string;
  clientName: string;
  workspaceTitle: string;
  directoryName?: string | null;
}): string {
  return psbWorkspaceDisplayName({
    clientName: target.clientName,
    workspaceId: target.workspaceId,
    workspaceTitle: target.workspaceTitle,
    directoryName: target.directoryName,
  });
}

/**
 * 工作区行的**唯一**次要信息（单行、去重）：模板名 · 机器名。
 *
 * 历史沿革：主标签还是「工作区名称」时，这里显示过目录（`目录：<directoryName>`，i18n key
 * `remoteWorkspace.dialog.directorySecondary`）。现在主标签就是目录名（实例名），目录不再出现在
 * 次要行——同一个词写两遍只会让用户以为选错了工作区。旧 i18n key 因此在本口径下不再被引用。
 *
 * 次要行固定由本函数产出，调用方不得再自行拼接模板名 / 机器名。
 */
export function psbWorkspaceSecondaryText(workspace: PsbRemoteWorkspace): string | null {
  const instanceName = psbWorkspaceInstanceName({
    directoryName: workspace.directoryName,
    workspaceTitle: workspace.title,
  });
  return psbWorkspaceTemplateMachineText({
    templateTitle: workspace.templateTitle,
    // 没有实例名时主标签已退回「机器-短 id」（或短 id）：机器名就在主标签里，不再重复。
    clientName: instanceName ? workspace.clientName : '',
    primaryName: instanceName || psbWorkspaceRowDisplayName(workspace),
  });
}

/**
 * 不可用行的**可行动原因**（用于行 tooltip）：用户需要知道「为什么这台不能用」，
 * 而不是列表里凭空少一行（docs/product-rules/psb-remote-workspace-sessions.md §2.2）。
 * 可用行返回 null。
 *
 * 行内**不再重复渲染这句长文案**（同一占用曾出现「徽标 + 长句 + 锁」三遍），
 * 徽标给短标签，长句只进 tooltip。
 */
export function psbWorkspaceUnavailableReason(
  workspace: PsbRemoteWorkspace,
  health: PsbWorkspaceHealth,
  t: (key: string, options?: Record<string, string>) => string,
): string | null {
  if (health.canStartSession) return null;
  if (health.tone === 'warn') {
    const name = workspace.occupancy.personName.trim();
    return name
      ? t('remoteWorkspace.error.occupiedByOther', { name })
      : t('remoteWorkspace.error.workspaceOccupied');
  }
  return t(health.badgeKey);
}

/** 一行选择器最终要渲染的两段文字（消歧后）。 */
export interface PsbWorkspaceRowLabels {
  /** 主标题（已按同列表内容消歧）。 */
  readonly name: string;
  /** 单行次要信息（可能为 `null`）。 */
  readonly secondary: string | null;
}

/**
 * 按**整个列表**计算每行标签，并消除「主标题 + 次要信息」完全相同的碰撞。
 *
 * 实例名（目录名）通常唯一，冲突只发生在极端情况：两台机器上同目录、同模板且都拿不到机器名
 * （或老数据都没有目录名与标题）。这时给冲突行追加 `-<短 id>`（与名称缺失时的兜底同一分隔符，
 * 不新增 i18n 句式）：优先短 id，仍撞（理论上 8 位前缀相同）时用完整 id，保证最终每行主标题唯一。
 *
 * 不冲突时**不**改名字：跨机器的同名工作区仍靠次要行的机器名区分，主标题保持干净。
 */
export function psbWorkspaceRowLabels(
  workspaces: readonly PsbRemoteWorkspace[],
): ReadonlyMap<string, PsbWorkspaceRowLabels> {
  const rows = workspaces.map((workspace) => ({
    workspace,
    name: psbWorkspaceRowDisplayName(workspace),
    secondary: psbWorkspaceSecondaryText(workspace),
  }));

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.name}\u0000${row.secondary ?? ''}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      const shortId = shortPsbWorkspaceId(row.workspace.id);
      row.name = `${row.name}-${shortId}`;
    }
    // 8 位短 id 前缀理论上可能相同：仍有主标题 + 次要信息完全相同的行时改用完整 id。
    const stillColliding = new Set<string>();
    const seen = new Map<string, number>();
    for (const row of group) {
      const key = `${row.name}\u0000${row.secondary ?? ''}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [key, count] of seen) {
      if (count > 1) stillColliding.add(key);
    }
    for (const row of group) {
      if (!stillColliding.has(`${row.name}\u0000${row.secondary ?? ''}`)) continue;
      row.name = `${psbWorkspaceRowDisplayName(row.workspace)}-${row.workspace.id.trim()}`;
    }
  }

  return new Map(
    rows.map((row) => [row.workspace.id, { name: row.name, secondary: row.secondary }]),
  );
}
