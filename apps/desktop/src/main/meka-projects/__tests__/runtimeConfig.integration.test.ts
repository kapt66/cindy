import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';

const desktopRoot = path.resolve(__dirname, '../../../..');
const environment = vi.hoisted(() => ({ p4RootPath: null as string | null }));

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
    get: async () => ({
      p4RootPath: environment.p4RootPath,
      subfolders: [],
      extraDirs: [],
    }),
  }),
}));

describe('Meka runtime project/role resolution', () => {
  let resolveMekaRuntimeConfig: typeof import('../runtimeConfig.js').resolveMekaRuntimeConfig;
  let resolveMekaPlatformRuntimeSkills: typeof import('../runtimeConfig.js').resolveMekaPlatformRuntimeSkills;

  beforeAll(async () => {
    ({ resolveMekaRuntimeConfig, resolveMekaPlatformRuntimeSkills } =
      await import('../runtimeConfig.js'));
  });

  it('loads Host platform Skills independently from project and role configuration', async () => {
    const skills = await resolveMekaPlatformRuntimeSkills();

    expect(skills.map((skill) => skill.id)).toEqual(['platform-capabilities']);
    expect(skills[0]?.content).toContain('mcp_router.list_remote_directory');
  });

  it('uses the SAGA2 project and both built-in role manifests as the complete runtime source', async () => {
    const cases = [
      ['general-development', '# General development', true],
      ['combat-development', '# SAGA2 战斗开发', false],
    ] as const;

    for (const [roleId, promptHeading, hasDesign] of cases) {
      const resolved = await resolveMekaRuntimeConfig('saga2', roleId);

      expect(resolved).toMatchObject({
        projectId: 'saga2',
        roleId,
        roleDisplayName: roleId === 'combat-development' ? '战斗开发' : '通用开发',
        workflowRecoveredFromRole: false,
        policyProviderRefs: ['meka-host-risk-policy', 'meka-p4-boundary-policy'],
      });
      expect(resolved.promptText).toContain('# Meka target framework');
      expect(resolved.promptText).toContain(promptHeading);
      if (roleId === 'combat-development') {
        expect(resolved.workflow).toBe('saga2-combat-development-v1');
      } else {
        expect(resolved.workflow).toBeUndefined();
      }
      expect(resolved.skills.map((skill) => skill.id).sort()).toEqual(
        [
          'orca-coordination',
          'p4-operations',
          'safety-boundaries',
          'saga2-overview',
          'remote-operations',
          'saga2-server-reference',
          ...(hasDesign ? ['meka-design-handbook'] : []),
        ].sort(),
      );
      expect(resolved.mcp.map((entry) => entry.id)).toEqual([
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
            expect.objectContaining({ id: 'project-agent', enabled: true }),
          ]),
        );
        expect(resolved.promptText).toContain('## 0. 环境恢复');
        expect(resolved.promptText).toContain('不是任务级开关');
        expect(resolved.promptText).toContain('阻止该次调用');
        expect(resolved.promptText).toContain('## 1. 模块优先与服务器参考项目');
        expect(resolved.promptText).toContain('## 2. 集中澄清');
        expect(resolved.promptText).toContain('## 3. 方案与审批');
        expect(resolved.promptText).toContain('## 4. 实施与闭环');
        expect(resolved.promptText).toContain('服务器是绑定在 MCPRouter 上的远程项目参考工作面');
        expect(resolved.promptText).toContain('服务器代码');
        expect(resolved.promptText).toContain('[SAGA2_COMBAT_SOLUTION]');
        expect(resolved.promptText).toContain('targetSkillId:');
        expect(resolved.promptText).toContain('validate_server_capability_report');
        expect(resolved.promptText).toContain('整个任务永久只读');
        expect(resolved.promptText).toContain('交给服务器程序');
        expect(resolved.promptText).toContain('必须立即结束当前回合');
        expect(resolved.promptText).toContain('`list_workers`、`read_worker`、`worker_status`');
        expect(resolved.promptText).not.toContain('必须保持任务运行并通过 Orca 状态/消息接口等待');
        expect(resolved.promptText).not.toContain('battle-designer-server-development');
      }
      const saga2Overview = resolved.skills.find((skill) => skill.id === 'saga2-overview');
      const saga2OverviewContent = saga2Overview?.content.replace(/\r\n/g, '\n');
      expect(saga2OverviewContent).toContain('配置目录候选只传直接子目录名 `saga2_json`');
      expect(saga2OverviewContent).toContain('由 Host 打开系统目录选择器');
      expect(saga2OverviewContent).toContain('不要把绝对本地路径传给插件');
      {
        const remoteOperations = resolved.skills.find((skill) => skill.id === 'remote-operations');
        const orcaCoordination = resolved.skills.find((skill) => skill.id === 'orca-coordination');
        const serverReference = resolved.skills.find((skill) => skill.id === 'saga2-server-reference');
        expect(remoteOperations).toBeDefined();
        const remoteOperationsContent = remoteOperations!.content;
        expect(remoteOperationsContent).toContain('`mcpr:<instanceId>`');
        expect(remoteOperationsContent).toContain('远程项目只读能力');
        expect(remoteOperationsContent).toContain('只有直接只读能力不足');
        expect(remoteOperationsContent).toContain('专用 `project-agent`');
        expect(orcaCoordination?.content).toContain('先使用远程项目只读能力');
        expect(orcaCoordination?.content).toContain('通用 `mcp_router` 代替');
        expect(serverReference?.content).toContain('像本地参考目录一样');
        expect(saga2Overview?.content).toContain('通用 `mcp_router` 只做发现和配置');
      }
    }
  });

  it('upgrades a legacy project-owned combat role to the current Host workflow in memory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cindy-meka-combat-role-'));
    environment.p4RootPath = root;
    try {
      const project = JSON.parse(
        await readFile(
          path.join(desktopRoot, 'resources/meka/projects/saga2/project.json'),
          'utf8',
        ),
      ) as Record<string, unknown>;
      const bundledRole = JSON.parse(
        await readFile(
          path.join(desktopRoot, 'resources/meka/roles/combat-development.json'),
          'utf8',
        ),
      ) as Record<string, unknown>;
      const legacyRole = {
        ...bundledRole,
        workflow: undefined,
        promptFragments: undefined,
        displayName: 'Legacy combat role',
        prompt: '# Legacy combat prompt',
        skills: [
          { skillId: 'meka-design-handbook', enabled: true },
          ...(bundledRole.skills as unknown[]),
        ],
      };
      await mkdir(path.join(root, '.meka'), { recursive: true });
      await writeFile(
        path.join(root, '.meka', 'project.json'),
        `${JSON.stringify({ ...project, builtinRoles: [legacyRole] }, null, 2)}\n`,
        'utf8',
      );

      const resolved = await resolveMekaRuntimeConfig('saga2', 'combat-development');

      expect(resolved).toMatchObject({
        roleDisplayName: '战斗开发',
        workflow: 'saga2-combat-development-v1',
        workflowRecoveredFromRole: true,
      });
      expect(resolved.promptText).toContain('# SAGA2 战斗开发');
      expect(resolved.promptText).not.toContain('# Legacy combat prompt');
      expect(resolved.skills.map((skill) => skill.id)).toEqual(
        expect.arrayContaining(['meka-design-handbook', 'remote-operations']),
      );
      const persisted = await readFile(path.join(root, '.meka', 'project.json'), 'utf8');
      expect(persisted).toContain('# Legacy combat prompt');
      expect(persisted).not.toContain('saga2-combat-development-v1');
    } finally {
      environment.p4RootPath = null;
      await rm(root, { recursive: true, force: true });
    }
  });
});
