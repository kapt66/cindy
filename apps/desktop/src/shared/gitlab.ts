export interface GitlabIssueContent {
  title: string;
  description: string;
  comments: Array<{ author: string; body: string; createdAt: string }>;
}

function safeHttpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function parseGitlabProjectUrl(
  raw: string,
): { host: string; projectPath: string } | null {
  const url = safeHttpsUrl(raw);
  if (!url || url.port) return null;
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter((part) => part && part !== '-');
  return parts.length > 0 ? { host: url.hostname, projectPath: parts.join('/') } : null;
}

export function parseGitlabIssueFromUrl(raw: string): {
  host: string;
  projectPath: string;
  iid: number;
  webUrl: string;
} | null {
  const url = safeHttpsUrl(raw);
  if (!url || url.port) return null;
  const match = url.pathname.match(/^\/(.+?)\/-\/(?:issues|work_items)\/(\d+)\/?$/);
  if (!match) return null;
  const iid = Number(match[2]);
  if (!Number.isSafeInteger(iid) || iid <= 0) return null;
  return { host: url.hostname, projectPath: match[1], iid, webUrl: raw.trim() };
}

export function normalizeGitlabIssueContent(value: unknown): GitlabIssueContent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.title !== 'string'
    || typeof body.description !== 'string'
    || !Array.isArray(body.comments)
    || body.title.length > 200_000
    || body.description.length > 200_000
    || body.comments.length > 50
  ) {
    return null;
  }
  const comments: GitlabIssueContent['comments'] = [];
  for (const value of body.comments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (
      typeof item.author !== 'string'
      || typeof item.body !== 'string'
      || typeof item.createdAt !== 'string'
      || item.body.length > 200_000
    ) {
      return null;
    }
    comments.push({ author: item.author, body: item.body, createdAt: item.createdAt });
  }
  return { title: body.title, description: body.description, comments };
}
