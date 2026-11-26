/**
 * 工作区选择器的**显示口径**（弹窗行 / 草稿页下拉行 / 项目胶囊同源，唯一实现）。
 *
 * 2026-11-26 用户实机反馈：主标签直接显示**工作区名称**（PSB 的 `title`，如 `saga2_project`；
 * 用户可改名）。机器与短 id 只在名称缺失（老数据 / PSB 还没回填标题 / 手改脏数据）时兜底。
 *
 * 同一个名称可以出现在多台机器（同名工作区）：区分先交给**单行次要信息**
 * （优先目录，目录与名称同名时退回机器名），两者都撞时由 `psbWorkspaceRowLabels` 追加短 id
 * 消歧——否则两行在用户看来完全一样，选错工作区的代价是占用/会话落到别人记录上。
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

/** 工作区选择器的显示名输入（弹窗行 / 下拉行 / 项目胶囊共用）。 */
export interface PsbWorkspaceDisplayParts {
  clientName: string;
  workspaceId: string;
  workspaceTitle?: string;
}

/**
 * 工作区选择器的**显示名**口径（名称优先；缺失才 `<机器>-<短 id>`，再短 id）。
 *
 * 胶囊只承载当前选中的那一个，不需要消歧；列表行由 `psbWorkspaceRowLabels` 统一消歧。
 */
export function psbWorkspaceDisplayName(parts: PsbWorkspaceDisplayParts): string {
  const title = parts.workspaceTitle?.trim() ?? '';
  if (title) return title;
  const shortId = shortPsbWorkspaceId(parts.workspaceId);
  const clientName = parts.clientName.trim();
  if (clientName && shortId) return `${clientName}-${shortId}`;
  return shortId || parts.workspaceId;
}

/** PSB 工作区行 → 选择器显示名（唯一映射：弹窗 / 下拉 / 项目胶囊同源）。 */
export function psbWorkspaceRowDisplayName(workspace: PsbRemoteWorkspace): string {
  return psbWorkspaceDisplayName({
    clientName: workspace.clientName,
    workspaceId: workspace.id,
    workspaceTitle: workspace.title,
  });
}

/**
 * 工作区行的**唯一**次要信息（单行、去重）：优先目录名 —— 它才是本机上唯一区分同名工作区的
 * 那一份目录；没有目录名时退回机器名 / 模板名，且同一字符串只出现一次。
 *
 * 历史上这里同时渲染 `title` 与 `directoryName`，同名时变成「saga2_project saga2_project」
 * 两遍；模板名再叠进来会三遍。所以次要行固定由本函数产出，调用方不得再自行拼接。
 *
 * 「目录」前缀走 i18n（`remoteWorkspace.dialog.directorySecondary`），**不在这里写死中文**：
 * 这个函数被 12 个 locale 的弹窗与草稿页下拉共用，写死中文会让非中文界面出现中文行。
 * 目录名本身不是文案（PSB 的服务端事实），只作为 `{{directory}}` 插入。
 */
export function psbWorkspaceSecondaryText(
  workspace: PsbRemoteWorkspace,
  t: (key: string, options?: Record<string, string>) => string,
): string | null {
  const title = workspace.title.trim();
  const directory = workspace.directoryName?.trim() ?? '';
  if (directory && directory !== title) {
    return t('remoteWorkspace.dialog.directorySecondary', { directory });
  }
  // 名称缺失：主标题已经是「机器-短 id」，输出与主标签 / 短 id 重复的值没有意义。
  if (!title) return null;
  const clientName = workspace.clientName.trim();
  if (clientName && clientName !== title) return clientName;
  const template = workspace.templateTitle?.trim() ?? '';
  if (template && template !== title) return template;
  return null;
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
 * 冲突只发生在极端情况：两台机器上同名、同目录（或都拿不到目录/机器）的工作区。这时给
 * 冲突行追加 `-<短 id>`（与名称缺失时的兜底同一分隔符，不新增 i18n 句式）：优先短 id，
 * 仍撞（理论上 8 位前缀相同）时用完整 id，保证最终每行主标题唯一。
 *
 * 不冲突时**不**改名字：跨机器的同名工作区仍靠次要行的机器名区分，主标题保持干净。
 */
export function psbWorkspaceRowLabels(
  workspaces: readonly PsbRemoteWorkspace[],
  t: (key: string, options?: Record<string, string>) => string,
): ReadonlyMap<string, PsbWorkspaceRowLabels> {
  const rows = workspaces.map((workspace) => ({
    workspace,
    name: psbWorkspaceRowDisplayName(workspace),
    secondary: psbWorkspaceSecondaryText(workspace, t),
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
