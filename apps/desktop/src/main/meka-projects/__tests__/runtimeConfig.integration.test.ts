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

  it('uses the SAGA2 project and both built-in role manifests as the complete runtime source', async () => {
    const cases = [
      ['general-development', '# General development', true],
      ['combat-development', '# Combat development', false],
    ] as const;

    for (const [roleId, promptHeading, hasDesign] of cases) {
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
          'remote-operations',
          ...(hasDesign ? ['meka-design-handbook'] : []),
        ].sort(),
      );
      expect(resolved.mcp.map((entry) => entry.id)).toEqual([
        'mcp-router',
        'project-agent',
        ...(hasDesign ? ['meka-design'] : []),
        'unity-editor',
      ]);
      if (roleId === 'combat-development') {
        const roleManifest = JSON.parse(
          await import('node:fs/promises').then(({ readFile }) =>
            readFile(
              path.join(desktopRoot, 'resources/meka/roles/combat-development.json'),
              'utf8',
            ),
          ),
        ) as {
          skills: Array<{ skillId: string; enabled: boolean }>;
          mcp: Array<{ id: string; enabled: boolean }>;
        };
        expect(roleManifest.skills).toEqual(
          expect.arrayContaining([{ skillId: 'remote-operations', enabled: true }]),
        );
        expect(roleManifest.mcp).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'mcp-router', enabled: true }),
            expect.objectContaining({ id: 'project-agent', enabled: true }),
          ]),
        );
        expect(resolved.promptText).toContain(
          'Treat module configuration as server-executed behavior',
        );
        expect(resolved.promptText).toContain(
          'do not infer server support from Unity authoring support alone',
        );
        expect(resolved.promptText).toContain(
          'explicitly invoke `battle-designer-server-development`',
        );
        expect(resolved.promptText).toContain(
          '`serverWorkflow.skillLoaded` is `true`',
        );
        expect(resolved.promptText).toContain(
          'this role-specific workflow does not apply to normal server-programmer development',
        );
        expect(resolved.promptText).toContain(
          'worker creation, dispatch success, or ordinary server output is not proof',
        );
      }
      const saga2Overview = resolved.skills.find((skill) => skill.id === 'saga2-overview');
      const saga2OverviewContent = saga2Overview?.content.replace(/\r\n/g, '\n');
      expect(saga2OverviewContent).toContain('pass the direct child name `saga2_json`');
      expect(saga2OverviewContent).toContain('ask the user whether to use it before adopting it');
      expect(saga2OverviewContent).toContain('let the Host open its system');
      expect(saga2OverviewContent).toContain('directory picker');
      expect(saga2OverviewContent).toContain('Do not inspect or pass an absolute local path');
      expect(saga2OverviewContent).toContain(
        'Use\n  `update_servers` for update/rebuild/deploy requests',
      );
      expect(saga2OverviewContent).toContain('`start_servers` for start requests');
      expect(saga2OverviewContent).toContain('`stop_servers` for stop requests');
      expect(saga2OverviewContent).toContain("single operation matching the user's intent");
      {
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
        expect(
          remoteOperationsContent.indexOf('Only use generic `mcp_router` tools'),
        ).toBeGreaterThan(remoteOperationsContent.indexOf('An existing MCPR remote task/session'));
        expect(remoteOperationsContent).toContain('ask whether to create that remote worker');
        expect(remoteOperationsContent).toContain(
          'the underlying read/edit request alone is not authorization to create one',
        );
        expect(remoteOperationsContent).toContain(
          'include it as `initial_task` so worker creation and dispatch are one operation',
        );
        expect(remoteOperationsContent).toContain('the current Lead task MUST end immediately');
        expect(remoteOperationsContent).toContain(
          'do not ask another confirmation, do not call another tool, and do not wait, sleep, poll, or keep the turn alive',
        );
        expect(orcaCoordination?.content).toContain('continue an MCPR remote task/session');
        expect(orcaCoordination?.content).toContain('Do not use a generic `mcp_router` operation');
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
