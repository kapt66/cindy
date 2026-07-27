/** Frozen provider-neutral data persisted on a formal Meka session. */
export interface FormalSessionData {
  type: 'jira' | 'gitlab' | (string & {});
  link: string;
  ref: string;
  content: unknown;
}

/**
 * First user message for a formal session. It is intentionally user content,
 * not a system-prompt fragment, so the stable agent constitution is unchanged.
 */
export function formalWorkflowFirstMessage(input: {
  providerLabel: string;
  link: string;
  title?: string;
  description?: string;
}): string {
  const title = input.title?.trim();
  const description = input.description?.trim();
  return [
    `请基于以下 ${input.providerLabel} 任务开始正式流程。`,
    `${input.providerLabel} 链接：${input.link}`,
    title ? `${input.providerLabel} 标题：${title}` : null,
    description ? `${input.providerLabel} 描述：${description}` : null,
    '',
    '请先整理目标与验收要求，再向用户复述理解与执行计划并请求确认。',
    '未达成一致前不要开始执行；信息不足时请暂停并明确询问。',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** Backward-compatible Jira helper retained for migrated callers. */
export function FORMAL_WORKFLOW_PROMPT(
  jiraLink: string,
  jiraContent?: { title?: string; description?: string },
): string {
  return formalWorkflowFirstMessage({
    providerLabel: 'Jira',
    link: jiraLink,
    title: jiraContent?.title,
    description: jiraContent?.description,
  });
}
