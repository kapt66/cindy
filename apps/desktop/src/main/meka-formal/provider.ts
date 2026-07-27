import type { MekaProject } from '../../shared/meka-projects.js';

export interface FormalIssueListItem {
  ref: string;
  title: string;
  webUrl: string;
}

export type FormalIssueContent = Record<string, unknown>;
export type FormalFetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; detail?: string };

export interface MekaFormalWorkflowProvider {
  readonly type: 'jira' | 'gitlab' | (string & {});
  checkAuth(project: MekaProject): Promise<
    { ok: true } | { ok: false; reason: 'NOT_CONNECTED' | 'AUTH_EXPIRED' | 'NETWORK' }
  >;
  fetchIssueList(project: MekaProject): Promise<FormalFetchResult<FormalIssueListItem[]>>;
  fetchIssueDetail(project: MekaProject, ref: string): Promise<FormalFetchResult<FormalIssueContent>>;
  parseLink(url: string, project: MekaProject): { ref: string; webUrl: string } | null;
  composeFirstMessage(link: string, content: FormalIssueContent | null): string;
  titlePrefix(ref: string): string;
  validateContent(content: unknown): FormalIssueContent | null;
}
