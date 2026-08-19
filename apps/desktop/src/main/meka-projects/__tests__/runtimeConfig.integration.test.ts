import path from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';

const desktopRoot = path.resolve(__dirname, '../../../..');

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => desktopRoot,
    getPath: (name: string) =>
      name === 'userData' ? path.join(desktopRoot, '.test-user-data') : desktopRoot,
  },
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    queryOne: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM meka_projects')) {
        return { id: 'saga2', path: 'saga2', is_builtin: 1 };
      }
      if (sql.includes('FROM meka_roles')) {
        const roleId = String(params[0]);
        return {
          id: roleId,
          project_id: 'saga2',
          is_builtin: 1,
          file_path: `meka/roles/${roleId}.json`,
        };
      }
      return undefined;
    },
  }),
}));

vi.mock('../../meka-settings/ipc.js', () => ({
  getMekaP4SettingsService: () => ({
    get: async () => ({ p4RootPath: null, subfolders: [], extraDirs: [] }),
  }),
}));

describe('Meka runtime project/role resolution', () => {
  let resolveMekaRuntimeConfig: typeof import('../runtimeConfig.js').resolveMekaRuntimeConfig;

  beforeAll(async () => {
    ({ resolveMekaRuntimeConfig } = await import('../runtimeConfig.js'));
  });

  it('uses the SAGA2 project and every built-in role manifest as the complete runtime source', async () => {
    const cases = [
      ['combat-config', '# Combat configuration', false, true],
      ['combat-debug', '# Combat debugging', false, true],
      ['general-development', '# General development', true, true],
      ['system-debug', '# System debugging', false, true],
      ['system-development', '# System development', true, true],
      ['system-overview', '# System overview', false, false],
    ] as const;

    for (const [roleId, promptHeading, hasDesign, hasRemote] of cases) {
      const resolved = await resolveMekaRuntimeConfig('saga2', roleId);

      expect(resolved).toMatchObject({
        projectId: 'saga2',
        roleId,
        policyProviderRefs: ['meka-host-risk-policy', 'meka-p4-boundary-policy'],
      });
      expect(resolved.promptText).toContain('# Meka target framework');
      expect(resolved.promptText).toContain(promptHeading);
      expect(resolved.skills.map((skill) => skill.id).sort()).toEqual(
        [
          'orca-coordination',
          'p4-operations',
          'safety-boundaries',
          'saga2-overview',
          ...(hasRemote ? ['remote-operations'] : []),
          ...(hasDesign ? ['meka-design-handbook'] : []),
        ].sort(),
      );
      expect(resolved.mcp.map((entry) => entry.id)).toEqual(
        hasRemote ? ['mcp-router', 'project-agent', ...(hasDesign ? ['meka-design'] : [])] : [],
      );
      const saga2Overview = resolved.skills.find((skill) => skill.id === 'saga2-overview');
      const saga2OverviewContent = saga2Overview?.content.replace(/\r\n/g, '\n');
      expect(saga2OverviewContent).toContain('pass the direct child name `saga2_json`');
      expect(saga2OverviewContent).toContain('ask the user whether to use it before adopting it');
      expect(saga2OverviewContent).toContain('let the Host open its system');
      expect(saga2OverviewContent).toContain('directory picker');
      expect(saga2OverviewContent).toContain('Do not inspect or pass an absolute local path');
      expect(saga2OverviewContent).toContain('Use\n  `update_servers` for update/rebuild/deploy requests');
      expect(saga2OverviewContent).toContain('`start_servers` for start requests');
      expect(saga2OverviewContent).toContain('`stop_servers` for stop requests');
      expect(saga2OverviewContent).toContain('single operation matching the user\'s intent');
      if (hasRemote) {
        const remoteOperations = resolved.skills.find((skill) => skill.id === 'remote-operations');
        const orcaCoordination = resolved.skills.find((skill) => skill.id === 'orca-coordination');
        expect(remoteOperations).toBeDefined();
        const remoteOperationsContent = remoteOperations!.content;
        expect(remoteOperationsContent).toContain(
          'An existing MCPR remote task/session (`remoteHostId="mcpr:<instanceId>"`) is the first choice',
        );
        expect(remoteOperationsContent).toContain(
          'Only use generic `mcp_router` tools as a control-plane fallback',
        );
        expect(remoteOperationsContent).toContain(
          'generic tool merely because it can expose a broad underlying operation',
        );
        expect(remoteOperationsContent).toContain('The dedicated MCPRouter `project-agent` tools');
        expect(remoteOperationsContent.indexOf('Only use generic `mcp_router` tools')).toBeGreaterThan(
          remoteOperationsContent.indexOf('An existing MCPR remote task/session'),
        );
        expect(remoteOperationsContent).toContain(
          'ask whether to create that remote worker',
        );
        expect(remoteOperationsContent).toContain(
          'the underlying read/edit request alone is not authorization to create one',
        );
        expect(remoteOperationsContent).toContain(
          'include it as `initial_task` so worker creation and dispatch are one operation',
        );
        expect(remoteOperationsContent).toContain(
          'the current Lead task MUST end immediately',
        );
        expect(remoteOperationsContent).toContain(
          'do not ask another confirmation, do not call another tool, and do not wait, sleep, poll, or keep the turn alive',
        );
        expect(orcaCoordination?.content).toContain(
          'continue an MCPR remote task/session',
        );
        expect(orcaCoordination?.content).toContain(
          'Do not use a generic `mcp_router` operation',
        );
        expect(saga2Overview?.content).toContain(
          'Generic `mcp_router` operations are only for remote-instance discovery',
        );
        expect(saga2Overview?.content).toContain(
          'Do not choose a broad underlying Router operation over a matching specialized route',
        );
      }
    }
  });
});
