import {
  GitlabApiError,
  GitlabClient,
  type GitlabIssue,
  type GitlabNote,
} from '@cindy/gitlab-client';

import type { GitlabIssueContent } from '../../shared/gitlab.js';
import type { FormalFetchResult, FormalIssueListItem } from './provider.js';

export interface GitlabClientDeps {
  resolveToken: (host: string) => Promise<string | null>;
}

function client(host: string, projectPath: string, token: string): GitlabClient {
  return new GitlabClient({ baseUrl: `https://${host}`, projectPath, token });
}

function clientError(error: unknown): FormalFetchResult<never> {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof GitlabApiError && (error.status === 401 || error.status === 403)) {
    return { ok: false, error: 'AUTH_EXPIRED', detail };
  }
  if (error instanceof TypeError || /network|fetch|ECONN|ENETUNREACH/i.test(detail)) {
    return { ok: false, error: 'NETWORK', detail };
  }
  return { ok: false, error: 'HTTP', detail };
}

export async function fetchGitlabIssues(
  context: { host: string; projectPath: string },
  deps: GitlabClientDeps,
): Promise<FormalFetchResult<FormalIssueListItem[]>> {
  const token = await deps.resolveToken(context.host);
  if (!token) return { ok: false, error: 'NO_ACCOUNT' };
  try {
    const issues: GitlabIssue[] = await client(context.host, context.projectPath, token)
      .listIssues({ state: 'opened', per_page: 100 });
    return {
      ok: true,
      data: issues.map((issue) => ({
        ref: String(issue.iid),
        title: issue.title,
        webUrl: issue.web_url,
      })),
    };
  } catch (error) {
    return clientError(error);
  }
}

export async function fetchGitlabIssue(
  context: { host: string; projectPath: string; iid: number },
  deps: GitlabClientDeps,
): Promise<FormalFetchResult<GitlabIssueContent>> {
  const token = await deps.resolveToken(context.host);
  if (!token) return { ok: false, error: 'NO_ACCOUNT' };
  try {
    const api = client(context.host, context.projectPath, token);
    const issue: GitlabIssue = await api.getIssue(context.iid);
    const notes: GitlabNote[] = await api.getIssueComments(context.iid);
    return {
      ok: true,
      data: {
        title: issue.title,
        description: issue.description ?? '',
        comments: notes.slice(-5).map((note) => ({
          author: note.author?.username ?? '',
          body: note.body,
          createdAt: note.created_at,
        })),
      },
    };
  } catch (error) {
    return clientError(error);
  }
}
