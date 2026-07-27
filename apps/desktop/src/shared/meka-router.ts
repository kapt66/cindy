export interface MekaRouterSettingsView {
  configured: boolean;
  routerUrl: string | null;
  defaultRouterUrl: string;
  routerUsername: string | null;
  mekaDesignConfigured: boolean;
  mekaDesignUrl: string | null;
}

export interface MekaRouterTool {
  name: string;
  description?: string;
}

export interface MekaRouterRoute {
  id: string;
  toolName: string;
  endpoint: string;
  clientName: string | null;
  clientDescription: string | null;
  enabled: boolean;
}

export interface MekaRouterTemplate {
  id: string;
  name: string;
  description: string | null;
}

export interface MekaRouterInstance {
  id: string;
  instanceId: string;
  projectId: string | null;
  projectName: string;
  projectDescription: string | null;
  agentType: string;
  agentMode: string;
  status: string | null;
  workspaceRef: string | null;
  supported: boolean;
  available: boolean;
  remoteHostId: string;
  workingDir: string;
}

export const MCPR_REMOTE_HOST_PREFIX = 'mcpr:';

export function buildMcprRemoteHostId(instanceId: string): string {
  return `${MCPR_REMOTE_HOST_PREFIX}${instanceId}`;
}

export function parseMcprRemoteHostId(value: string | null | undefined): string | null {
  if (!value?.startsWith(MCPR_REMOTE_HOST_PREFIX)) return null;
  const id = value.slice(MCPR_REMOTE_HOST_PREFIX.length);
  return id ? id : null;
}

export function isMekaRouterInstanceAvailable(status: string | null | undefined): boolean {
  return status === 'running' || status === 'ready' || status === 'online';
}
