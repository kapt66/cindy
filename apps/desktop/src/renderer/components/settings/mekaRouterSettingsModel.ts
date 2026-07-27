import type {
  MekaRouterInstance,
  MekaRouterRoute,
  MekaRouterTemplate,
  MekaRouterTool,
} from '../../../shared/meka-router';

export interface MekaRouterClientGroup {
  endpoint: string;
  name: string | null;
  description: string | null;
  routeIds: string[];
  toolCount: number;
  enabled: boolean;
}

export function buildMekaRouterClientGroups(
  tools: MekaRouterTool[],
  routes: MekaRouterRoute[],
): { clients: MekaRouterClientGroup[]; systemToolCount: number } {
  const grouped = new Map<string, MekaRouterRoute[]>();
  for (const route of routes) {
    const current = grouped.get(route.endpoint) ?? [];
    current.push(route);
    grouped.set(route.endpoint, current);
  }

  const routedToolNames = new Set(routes.map((route) => route.toolName));
  return {
    clients: [...grouped.entries()].map(([endpoint, clientRoutes]) => ({
      endpoint,
      name: clientRoutes.find((route) => route.clientName)?.clientName ?? null,
      description: clientRoutes.find((route) => route.clientDescription)?.clientDescription ?? null,
      routeIds: clientRoutes.map((route) => route.id),
      toolCount: clientRoutes.length,
      enabled: clientRoutes.length > 0 && clientRoutes.every((route) => route.enabled),
    })),
    systemToolCount: tools.filter((tool) => !routedToolNames.has(tool.name)).length,
  };
}

export function getMekaRouterClientLabel(
  endpoint: string,
  mekaDesignUrl: string | null | undefined,
  clientName?: string | null,
): string {
  if (clientName) return clientName;
  if (mekaDesignUrl && endpoint === mekaDesignUrl) return 'MekaDesign';
  try {
    return new URL(endpoint).host || endpoint;
  } catch {
    return endpoint;
  }
}

export function groupMekaRouterTemplates(
  templates: MekaRouterTemplate[],
  instances: MekaRouterInstance[],
): {
  templates: Array<{ template: MekaRouterTemplate; instances: MekaRouterInstance[] }>;
  orphanInstances: MekaRouterInstance[];
} {
  const templateIds = new Set(templates.map((template) => template.id));
  return {
    templates: templates.map((template) => ({
      template,
      instances: instances.filter((instance) => instance.projectId === template.id),
    })),
    orphanInstances: instances.filter(
      (instance) => !instance.projectId || !templateIds.has(instance.projectId),
    ),
  };
}
