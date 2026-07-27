import type { JiraIssueContent } from '../../shared/jira.js';
import type { FormalFetchResult, FormalIssueListItem } from './provider.js';

export type AtlassianTokenResult =
  | { ok: true; accessToken: string; accountId: string }
  | {
      ok: false;
      error: 'NO_CLIENT_CONFIG' | 'NO_ACCOUNT' | 'AUTH_EXPIRED' | 'REFRESH_FAILED' | 'NETWORK';
      detail?: string;
    };

export interface JiraClientDeps {
  getAccessToken: (accountId?: string) => Promise<AtlassianTokenResult>;
  fetchImpl?: typeof fetch;
}

const RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

function adfToText(value: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const body = node as Record<string, unknown>;
    if (typeof body.text === 'string') out.push(body.text);
    if (!Array.isArray(body.content)) return;
    for (const child of body.content) {
      walk(child);
      const type = child && typeof child === 'object'
        ? (child as Record<string, unknown>).type
        : null;
      if (typeof type === 'string' && /^(paragraph|heading|listItem|codeBlock|blockquote)$/.test(type)) {
        out.push('\n');
      }
    }
  };
  walk(value);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function tokenError(result: Exclude<AtlassianTokenResult, { ok: true }>): FormalFetchResult<never> {
  if (result.error === 'NO_ACCOUNT' || result.error === 'NO_CLIENT_CONFIG') {
    return { ok: false, error: 'NO_ACCOUNT', detail: result.detail };
  }
  if (result.error === 'AUTH_EXPIRED') {
    return { ok: false, error: 'AUTH_EXPIRED', detail: result.detail };
  }
  return { ok: false, error: 'NETWORK', detail: result.detail };
}

async function resolveSite(
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
): Promise<FormalFetchResult<{ cloudId: string; siteUrl: string }>> {
  try {
    const response = await fetchImpl(RESOURCES_URL, { headers });
    if (response.status === 401) return { ok: false, error: 'AUTH_EXPIRED' };
    if (!response.ok) return { ok: false, error: 'NETWORK', detail: `resources ${response.status}` };
    const value = await response.json() as unknown;
    if (!Array.isArray(value)) return { ok: false, error: 'NO_SITE' };
    const site = value.find((item) => {
      if (!item || typeof item !== 'object') return false;
      const scopes = (item as Record<string, unknown>).scopes;
      return Array.isArray(scopes) && scopes.some((scope) => typeof scope === 'string' && scope.includes('jira'));
    }) ?? value[0];
    if (!site || typeof site !== 'object') return { ok: false, error: 'NO_SITE' };
    const cloudId = (site as Record<string, unknown>).id;
    const siteUrl = (site as Record<string, unknown>).url;
    if (typeof cloudId !== 'string' || typeof siteUrl !== 'string') {
      return { ok: false, error: 'NO_SITE' };
    }
    return { ok: true, data: { cloudId, siteUrl: siteUrl.replace(/\/+$/, '') } };
  } catch (error) {
    return { ok: false, error: 'NETWORK', detail: error instanceof Error ? error.message : String(error) };
  }
}

async function withAuth(deps: JiraClientDeps): Promise<
  FormalFetchResult<{ fetchImpl: typeof fetch; headers: Record<string, string>; cloudId: string; siteUrl: string }>
> {
  const token = await deps.getAccessToken();
  if (!token.ok) return tokenError(token);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json' };
  const site = await resolveSite(fetchImpl, headers);
  return site.ok
    ? { ok: true, data: { fetchImpl, headers, ...site.data } }
    : site;
}

export async function fetchJiraIssue(
  issueKey: string,
  deps: JiraClientDeps,
): Promise<FormalFetchResult<JiraIssueContent>> {
  const auth = await withAuth(deps);
  if (!auth.ok) return auth;
  const { fetchImpl, headers, cloudId } = auth.data;
  const endpoint = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,attachment`;
  try {
    const response = await fetchImpl(endpoint, { headers });
    if (response.status === 401) return { ok: false, error: 'AUTH_EXPIRED' };
    if (!response.ok) return { ok: false, error: 'HTTP', detail: `issue ${response.status}` };
    const value = await response.json() as Record<string, unknown>;
    const fields = value.fields as Record<string, unknown> | undefined;
    if (!fields) return { ok: false, error: 'HTTP', detail: 'issue fields missing' };
    const attachments = Array.isArray(fields.attachment)
      ? fields.attachment.flatMap((raw) => {
          if (!raw || typeof raw !== 'object') return [];
          const item = raw as Record<string, unknown>;
          return [{
            id: typeof item.id === 'string' ? item.id : String(item.id ?? ''),
            filename: typeof item.filename === 'string' ? item.filename : '',
            mimeType: typeof item.mimeType === 'string' ? item.mimeType : '',
            size: typeof item.size === 'number' ? item.size : 0,
          }];
        })
      : [];
    return {
      ok: true,
      data: {
        title: typeof fields.summary === 'string' ? fields.summary : '',
        description: adfToText(fields.description),
        attachments,
      },
    };
  } catch (error) {
    return { ok: false, error: 'NETWORK', detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchJiraIssues(
  projectKey: string,
  deps: JiraClientDeps,
): Promise<FormalFetchResult<FormalIssueListItem[]>> {
  const auth = await withAuth(deps);
  if (!auth.ok) return auth;
  const { fetchImpl, headers, cloudId, siteUrl } = auth.data;
  const params = new URLSearchParams({
    jql: `project=${projectKey} AND resolution=EMPTY AND assignee=currentUser() ORDER BY created DESC`,
    fields: 'summary',
    maxResults: '100',
  });
  try {
    const response = await fetchImpl(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search/jql?${params}`,
      { headers },
    );
    if (response.status === 401) return { ok: false, error: 'AUTH_EXPIRED' };
    if (!response.ok) return { ok: false, error: 'HTTP', detail: `search ${response.status}` };
    const value = await response.json() as Record<string, unknown>;
    if (!Array.isArray(value.issues)) return { ok: false, error: 'HTTP', detail: 'issues missing' };
    return {
      ok: true,
      data: value.issues.flatMap((raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const issue = raw as Record<string, unknown>;
        if (typeof issue.key !== 'string') return [];
        const fields = issue.fields as Record<string, unknown> | undefined;
        return [{
          ref: issue.key,
          title: typeof fields?.summary === 'string' ? fields.summary : '',
          webUrl: `${siteUrl}/browse/${issue.key}`,
        }];
      }),
    };
  } catch (error) {
    return { ok: false, error: 'NETWORK', detail: error instanceof Error ? error.message : String(error) };
  }
}
