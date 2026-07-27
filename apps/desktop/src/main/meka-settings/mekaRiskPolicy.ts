/** Host-owned risk classification for project-scoped MCPRouter calls. */
export type MekaToolRisk = 'unknown' | 'low' | 'medium' | 'high';

const HIGH_RISK_ACTIONS = new Set([
  'deploy',
  'publish',
  'release',
  'restart',
  'stop',
  'kill',
  'delete',
  'purge',
  'truncate',
  'migrate',
  'migration',
  'rollback',
  'restore',
  'overwrite',
  'bulk_mutation',
  'bulk-mutation',
  'credential_change',
  'credential-change',
  'permission_change',
  'permission-change',
  'network_policy_change',
  'network-policy-change',
]);
const MUTATING_ACTIONS = new Set(['create', 'write', 'update', 'set', 'change', 'mutate']);
const PRODUCTION_ENVIRONMENTS = new Set(['prod', 'production']);
const RISK_RANK: Record<MekaToolRisk, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function normalizeMekaRouterRisk(value: unknown): MekaToolRisk {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'unknown';
}

export function classifyMekaRouterToolRisk(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  routerRisk: unknown,
): MekaToolRisk {
  const action = normalized(args.action) || normalized(args.operation);
  const environment = normalized(args.environment) || normalized(args.env);
  let hostRisk: MekaToolRisk = 'unknown';
  if (
    HIGH_RISK_ACTIONS.has(action) ||
    (PRODUCTION_ENVIRONMENTS.has(environment) &&
      (MUTATING_ACTIONS.has(action) || HIGH_RISK_ACTIONS.has(action)))
  ) {
    hostRisk = 'high';
  } else {
    const tokens = normalized(toolName)
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    if (
      tokens.some((token) => HIGH_RISK_ACTIONS.has(token)) ||
      (tokens.includes('bulk') &&
        tokens.some((token) => token === 'update' || token === 'mutate')) ||
      (tokens.includes('production') &&
        tokens.some((token) => token === 'write' || token === 'update')) ||
      (tokens.some((token) => token === 'secret' || token === 'credentials') &&
        tokens.some((token) => ['set', 'update', 'change', 'rotate'].includes(token)))
    ) {
      hostRisk = 'high';
    }
  }
  const normalizedRouterRisk = normalizeMekaRouterRisk(routerRisk);
  return RISK_RANK[normalizedRouterRisk] > RISK_RANK[hostRisk] ? normalizedRouterRisk : hostRisk;
}
