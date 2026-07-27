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
    }
  });
});
