import { ipcMain } from 'electron';

import type { FormalSessionData } from '../../../shared/meka-formal.js';
import { registerBuiltInFormalProviders } from '../../meka-formal/providers.js';
import { getFormalProvider, listFormalProviderTypes } from '../../meka-formal/registry.js';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate.js';
import { getMekaProjectById } from './mekaProjects.js';

export const MEKA_FORMAL_PROVIDER_LIST = 'meka-formal:provider-list';
export const MEKA_FORMAL_CHECK_AUTH = 'meka-formal:check-auth';
export const MEKA_FORMAL_FETCH_ISSUES = 'meka-formal:fetch-issues';
export const MEKA_FORMAL_PREPARE = 'meka-formal:prepare';

function providerType(value: unknown): string {
  const type = requireString(value, 'type').trim();
  if (!getFormalProvider(type)) {
    throwIpcError('INVALID_PARAMS', `unsupported formal provider: ${type}`);
  }
  return type;
}

async function context(input: unknown) {
  const body = requireObject(input);
  const projectId = requireString(body.projectId, 'projectId').trim();
  const project = await getMekaProjectById(projectId);
  if (!project) throwIpcError('MEKA_PROJECT_NOT_FOUND', `Meka project ${projectId} not found`);
  const type = providerType(body.type);
  if (
    project.formalWorkflowEnabled !== true
    || project.workflowType === 'none'
    || project.workflowType !== type
  ) {
    throwIpcError('INVALID_PARAMS', 'formal provider does not match the project configuration');
  }
  return { body, project, provider: getFormalProvider(type)! };
}

export function registerMekaFormalIpc(): void {
  registerBuiltInFormalProviders();

  ipcMain.handle(MEKA_FORMAL_PROVIDER_LIST, () => listFormalProviderTypes());
  ipcMain.handle(MEKA_FORMAL_CHECK_AUTH, async (_event, input) => {
    const { project, provider } = await context(input);
    return provider.checkAuth(project);
  });
  ipcMain.handle(MEKA_FORMAL_FETCH_ISSUES, async (_event, input) => {
    const { project, provider } = await context(input);
    return provider.fetchIssueList(project);
  });
  ipcMain.handle(MEKA_FORMAL_PREPARE, async (_event, input) => {
    const { body, project, provider } = await context(input);
    const link = requireString(body.link, 'link').trim();
    const parsed = provider.parseLink(link, project);
    if (!parsed) throwIpcError('INVALID_PARAMS', 'issue link does not belong to this project');
    const fetched = await provider.fetchIssueDetail(project, parsed.ref);
    if (!fetched.ok) return fetched;
    const content = provider.validateContent(fetched.data);
    if (!content) return { ok: false, error: 'INVALID_CONTENT' };
    const formal: FormalSessionData = {
      type: provider.type,
      link: parsed.webUrl,
      ref: parsed.ref,
      content,
    };
    return {
      ok: true,
      data: {
        formal,
        firstMessage: provider.composeFirstMessage(parsed.webUrl, content),
        titlePrefix: provider.titlePrefix(parsed.ref),
      },
    };
  });
}
