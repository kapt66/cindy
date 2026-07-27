export interface JiraIssueContent {
  title: string;
  description: string;
  attachments: Array<{
    id: string;
    filename: string;
    mimeType: string;
    size: number;
  }>;
}

export function parseJiraIssueFromLink(
  raw: string,
): { projectKey: string; issueKey: string; webUrl: string } | null {
  const value = raw.trim();
  const bare = /^([A-Z][A-Z0-9]+)-(\d+)$/.exec(value);
  if (bare) {
    return {
      projectKey: bare[1],
      issueKey: `${bare[1]}-${bare[2]}`,
      webUrl: value,
    };
  }
  const linked = /^https:\/\/[^\s/]+\/browse\/([A-Z][A-Z0-9]+)-(\d+)(?:[/?#].*)?$/.exec(value);
  if (!linked) return null;
  return {
    projectKey: linked[1],
    issueKey: `${linked[1]}-${linked[2]}`,
    webUrl: value,
  };
}

export function normalizeJiraIssueContent(value: unknown): JiraIssueContent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.title !== 'string'
    || typeof body.description !== 'string'
    || !Array.isArray(body.attachments)
    || body.title.length > 200_000
    || body.description.length > 200_000
    || body.attachments.length > 100
  ) {
    return null;
  }
  const attachments: JiraIssueContent['attachments'] = [];
  for (const value of body.attachments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (
      typeof item.id !== 'string'
      || typeof item.filename !== 'string'
      || typeof item.mimeType !== 'string'
      || typeof item.size !== 'number'
      || !Number.isSafeInteger(item.size)
      || item.size < 0
    ) {
      return null;
    }
    attachments.push({
      id: item.id,
      filename: item.filename,
      mimeType: item.mimeType,
      size: item.size,
    });
  }
  return { title: body.title, description: body.description, attachments };
}
