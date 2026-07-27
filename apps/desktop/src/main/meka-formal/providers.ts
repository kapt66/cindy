import { formalWorkflowFirstMessage } from '../../shared/meka-formal.js';
import {
  normalizeJiraIssueContent,
  parseJiraIssueFromLink,
} from '../../shared/jira.js';
import {
  normalizeGitlabIssueContent,
  parseGitlabIssueFromUrl,
  parseGitlabProjectUrl,
} from '../../shared/gitlab.js';
import type { MekaProject } from '../../shared/meka-projects.js';
import { fetchGitlabIssue, fetchGitlabIssues } from './gitlabClient.js';
import { fetchJiraIssue, fetchJiraIssues } from './jiraClient.js';
import type { FormalIssueContent, MekaFormalWorkflowProvider } from './provider.js';
import { registerFormalProvider } from './registry.js';

const jiraDeps = {
  getAccessToken: async (accountId?: string) => {
    const brain = await import('../cindy-brain/index.js');
    return brain.getMekaAtlassianAccessToken(accountId);
  },
};

const gitlabDeps = {
  resolveToken: async (host: string) => {
    const brain = await import('../cindy-brain/index.js');
    return brain.resolveMekaGitlabToken(host);
  },
};

function gitlabContext(project: MekaProject): { host: string; projectPath: string } | null {
  return project.gitlabProjectUrl ? parseGitlabProjectUrl(project.gitlabProjectUrl) : null;
}

export const jiraFormalProvider: MekaFormalWorkflowProvider = {
  type: 'jira',
  async checkAuth() {
    const token = await jiraDeps.getAccessToken();
    if (token.ok) return { ok: true };
    return {
      ok: false,
      reason: token.error === 'AUTH_EXPIRED' ? 'AUTH_EXPIRED' : 'NOT_CONNECTED',
    };
  },
  async fetchIssueList(project) {
    return project.jiraProjectKey
      ? fetchJiraIssues(project.jiraProjectKey, jiraDeps)
      : { ok: false, error: 'PROJECT_NOT_CONFIGURED' };
  },
  async fetchIssueDetail(_project, ref) {
    const result = await fetchJiraIssue(ref, jiraDeps);
    return result.ok ? { ok: true, data: result.data as unknown as FormalIssueContent } : result;
  },
  parseLink(url, project) {
    const parsed = parseJiraIssueFromLink(url);
    if (!parsed || (project.jiraProjectKey && parsed.projectKey !== project.jiraProjectKey)) return null;
    return { ref: parsed.issueKey, webUrl: parsed.webUrl };
  },
  composeFirstMessage(link, content) {
    const normalized = normalizeJiraIssueContent(content);
    return formalWorkflowFirstMessage({
      providerLabel: 'Jira',
      link,
      title: normalized?.title,
      description: normalized?.description,
    });
  },
  titlePrefix(ref) {
    return ref;
  },
  validateContent(content) {
    return normalizeJiraIssueContent(content) as unknown as FormalIssueContent | null;
  },
};

export const gitlabFormalProvider: MekaFormalWorkflowProvider = {
  type: 'gitlab',
  async checkAuth(project) {
    const context = gitlabContext(project);
    if (!context) return { ok: false, reason: 'NOT_CONNECTED' };
    return await gitlabDeps.resolveToken(context.host)
      ? { ok: true }
      : { ok: false, reason: 'NOT_CONNECTED' };
  },
  async fetchIssueList(project) {
    const context = gitlabContext(project);
    return context
      ? fetchGitlabIssues(context, gitlabDeps)
      : { ok: false, error: 'PROJECT_NOT_CONFIGURED' };
  },
  async fetchIssueDetail(project, ref) {
    const context = gitlabContext(project);
    const iid = Number(ref);
    if (!context || !Number.isSafeInteger(iid) || iid <= 0) {
      return { ok: false, error: 'INVALID_REF' };
    }
    const result = await fetchGitlabIssue({ ...context, iid }, gitlabDeps);
    return result.ok ? { ok: true, data: result.data as unknown as FormalIssueContent } : result;
  },
  parseLink(url, project) {
    const parsed = parseGitlabIssueFromUrl(url);
    const context = gitlabContext(project);
    if (
      !parsed
      || !context
      || parsed.host !== context.host
      || parsed.projectPath !== context.projectPath
    ) {
      return null;
    }
    return { ref: String(parsed.iid), webUrl: parsed.webUrl };
  },
  composeFirstMessage(link, content) {
    const normalized = normalizeGitlabIssueContent(content);
    const text = formalWorkflowFirstMessage({
      providerLabel: 'GitLab',
      link,
      title: normalized?.title,
      description: normalized?.description,
    });
    if (!normalized?.comments.length) return text;
    return `${text}\n\n最近评论：\n${normalized.comments.map((item) => `- @${item.author}：${item.body}`).join('\n')}`;
  },
  titlePrefix(ref) {
    return `#${ref}`;
  },
  validateContent(content) {
    return normalizeGitlabIssueContent(content) as unknown as FormalIssueContent | null;
  },
};

let registered = false;

export function registerBuiltInFormalProviders(): void {
  if (registered) return;
  registerFormalProvider(jiraFormalProvider);
  registerFormalProvider(gitlabFormalProvider);
  registered = true;
}
