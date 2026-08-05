import { describe, expect, it } from 'vitest';

import type { MekaProject } from '../../../shared/meka-projects';
import { gitlabFormalProvider, jiraFormalProvider } from '../providers';

function project(patch: Partial<MekaProject>): MekaProject {
  return {
    id: 'p1',
    name: 'p1',
    displayName: 'Project',
    description: null,
    path: 'C:\\work',
    tags: [],
    isBuiltin: false,
    configSource: 'project',
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    roles: [],
    ...patch,
  };
}

describe('Meka formal providers', () => {
  it('accepts only Jira links from the configured project', () => {
    const configured = project({ jiraProjectKey: 'APP' });
    expect(
      jiraFormalProvider.parseLink('https://team.atlassian.net/browse/APP-42', configured),
    ).toEqual({
      ref: 'APP-42',
      webUrl: 'https://team.atlassian.net/browse/APP-42',
    });
    expect(
      jiraFormalProvider.parseLink('https://team.atlassian.net/browse/OTHER-42', configured),
    ).toBeNull();
    expect(
      jiraFormalProvider.parseLink('http://team.atlassian.net/browse/APP-42', configured),
    ).toBeNull();
  });

  it('pins GitLab issue links to the configured HTTPS host and project', () => {
    const configured = project({ gitlabProjectUrl: 'https://git.example.com/group/app' });
    expect(
      gitlabFormalProvider.parseLink('https://git.example.com/group/app/-/issues/7', configured),
    ).toEqual({
      ref: '7',
      webUrl: 'https://git.example.com/group/app/-/issues/7',
    });
    expect(
      gitlabFormalProvider.parseLink('https://evil.example.com/group/app/-/issues/7', configured),
    ).toBeNull();
  });

  it('rejects oversized or malformed frozen content', () => {
    expect(
      jiraFormalProvider.validateContent({
        title: 'Title',
        description: 'Description',
        attachments: [{ id: '1', filename: 'a.txt', mimeType: 'text/plain', size: 4 }],
      }),
    ).not.toBeNull();
    expect(
      jiraFormalProvider.validateContent({
        title: 'Title',
        description: 'Description',
        attachments: [{ id: '1', filename: 'a.txt', mimeType: 'text/plain', size: -1 }],
      }),
    ).toBeNull();
    expect(
      gitlabFormalProvider.validateContent({
        title: 'Title',
        description: 'Description',
        comments: [{ author: 'alice', body: 'ok', createdAt: '2026-07-24' }],
      }),
    ).not.toBeNull();
  });

  it('composes deterministic first messages', () => {
    const content = {
      title: 'Ship',
      description: 'Do the thing',
      attachments: [],
    };
    expect(jiraFormalProvider.composeFirstMessage('https://example/browse/APP-1', content)).toBe(
      jiraFormalProvider.composeFirstMessage('https://example/browse/APP-1', content),
    );
  });
});
