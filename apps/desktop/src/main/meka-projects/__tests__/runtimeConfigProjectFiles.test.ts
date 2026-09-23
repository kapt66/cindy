// 本文件原名 `runtimeConfig.integration.test.ts`，已改名为 `runtimeConfigProjectFiles.test.ts`。
//
// 改名原因：`*.integration.test.ts` 在 desktop **没有任何 tier 归属** ——
// `scripts/test-workspaces.config.mjs` 的 unit tier `exclude` 含该后缀，而 desktop 没有
// integration tier，于是 `--tier unit` 与 `test:all`（`--all` 只额外纳入 manual tier）都不选它：
// 唯一执行途径是人工 `pnpm --filter desktop test` 或显式指定路径，CI 里**从不执行**。本文件却是
// 本次交付新增用例的落点，等于没有覆盖。去掉 `.integration.` 后缀后，
// `apps/desktop/vitest.config.ts` 的 `desktopTestInclude`（`src/main` 下的
// `__tests__/**/*.test.ts` 形态）与 unit tier 都会选中它，因此它随 unit tier 进入 CI。
//
// 它为什么原来是「integration」：用临时目录与**真实文件系统**驱动项目/角色解析 —— `mkdtemp` 造
// 项目根、把 `.meka/project.json` 真写进去、再断言运行期解析结果（含「快照不被改写」的负向事实）。
// 它**不需要 runtime assets**：只读包内 `resources/meka/**` 与临时目录。
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

  it('resolves the shared default role from the bundled SAGA2 project as the runtime source', async () => {
    const resolved = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');

    expect(resolved).toMatchObject({
      projectId: 'saga2',
      roleId: 'saga2-default-role',
      roleDisplayName: '默认角色',
      workflowRecoveredFromRole: false,
      policyProviderRefs: ['meka-host-risk-policy', 'meka-p4-boundary-policy'],
    });
    // Factory-inclusive: the project prompt framework and the factory three-paragraph prompt both
    // reach the system prefix even though the role manifest itself declares no prompt body items.
    expect(resolved.promptText).toContain('# Meka target framework');
    expect(resolved.promptText).toContain('business intent as the input contract');
    expect(resolved.promptText).toContain('safe diagnostics and recovery actions');
    // The SAGA2 combat-upgrade paragraph of the retired "general development" prompt is gone.
    expect(resolved.promptText).not.toContain('EntryModel modules');
    expect(resolved.promptText).not.toContain('combat-development workflow');
    expect(resolved.promptText).not.toContain('Do not create a generic local subagent');
    expect(resolved.workflow).toBeUndefined();
    // `useProjectDefaults` absorbs the project's default skills and MCP server, and
    // `includeAllBundledSkills` adds every skill the bundled catalog scans on top of them.
    expect(resolved.skills.map((skill) => skill.id).sort()).toEqual([
      'combat-skill-configuration',
      'meka-design-handbook',
      'orca-coordination',
      'p4-operations',
      'platform-capabilities',
      'remote-operations',
      'safety-boundaries',
      'saga2-entry-model',
      'saga2-overview',
      'saga2-server-reference',
    ]);
    // `meka-design` is the one entry the manifest declares itself: it cannot be re-derived from the
    // project, unlike the `project-agent` entry the project's `roleDefaults` contributes.
    expect(resolved.mcp.map((entry) => entry.id)).toEqual(['project-agent', 'meka-design']);
    // No P4 root is configured in this case, so every selected reference file is unreadable and
    // must be skipped: `includeAllProjectMetadata` never produces a dangling reference.
    expect(resolved.projectReferences).toEqual([]);

    const saga2Overview = resolved.skills.find((skill) => skill.id === 'saga2-overview');
    const saga2OverviewContent = saga2Overview?.content.replace(/\r\n/g, '\n');
    expect(saga2OverviewContent).toContain('配置目录候选只传直接子目录名 `saga2_json`');
    expect(saga2OverviewContent).toContain('由 Host 打开系统目录选择器');
    expect(saga2OverviewContent).toContain('不要把绝对本地路径传给插件');
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
  });

  it('resolves the SAGA2 combat role from its bundled manifest as the complete runtime source', async () => {
    const resolved = await resolveMekaRuntimeConfig('saga2', 'combat-development');

    expect(resolved).toMatchObject({
      projectId: 'saga2',
      roleId: 'combat-development',
      roleDisplayName: '战斗开发',
      workflowRecoveredFromRole: false,
      workflow: 'saga2-combat-development-v1',
      policyProviderRefs: ['meka-host-risk-policy', 'meka-p4-boundary-policy'],
    });
    // The combat role owns its complete contract, so it deliberately does not absorb the project
    // defaults (`useProjectDefaults: false`) nor expand every project metadata item.
    expect(resolved.promptText).not.toContain('# Meka target framework');
    expect(resolved.promptText).toContain('# SAGA2 战斗开发');
    expect(resolved.skills.map((skill) => skill.id).sort()).toEqual(['combat-skill-configuration']);
    expect(resolved.mcp.map((entry) => entry.id)).toEqual(['project-agent']);
    expect(resolved.projectReferences).toEqual([]);

    const roleManifest = JSON.parse(
      await readFile(
        path.join(desktopRoot, 'resources/meka/roles/combat-development.json'),
        'utf8',
      ),
    ) as {
      skills: Array<{ skillId: string; enabled: boolean }>;
      mcp: Array<{ id: string; enabled: boolean }>;
    };
    expect(roleManifest.skills).toEqual([{ skillId: 'combat-skill-configuration', enabled: true }]);
    expect(roleManifest.mcp).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'project-agent', enabled: true })]),
    );
    expect(resolved.promptText).toContain('# SAGA2 战斗开发');
    expect(resolved.promptText).toContain('Meka Unity 官方 CLI');
    expect(resolved.promptText).toContain('不是任务级开关');
    expect(resolved.promptText).toContain('阻止该次调用');
    expect(resolved.promptText).toContain('使用模块组合实现战斗技能和关卡机制');
    expect(resolved.promptText).toContain('combat-skill-configuration');
    expect(resolved.promptText).toContain('技能 ID 硬入口');
    expect(resolved.promptText).toContain('不得从 Unity 当前选中项、历史任务、搜索结果');
    expect(resolved.promptText).toContain('技能 ID 是硬入口，只能由用户给出');
    expect(resolved.promptText).toContain('table-scope：范围由配置表或规则决定');
    expect(resolved.promptText).toContain('启发式或推断得到的候选永远不能成为已确认绑定');
    expect(resolved.promptText).toContain('只动编辑器模块资产');
    expect(resolved.promptText).toContain('当前模块配置入口要求技能 ID 为正整数');
    expect(resolved.promptText).toContain('skill_001` 这类前缀/别名而没有明确数字映射');
    expect(resolved.promptText).toContain('请提供要生成、修改或检查的正整数技能 ID。');
    expect(resolved.promptText).toContain('Unity 只通过 Meka Unity 官方 CLI');
    const combatSkill = resolved.skills.find(
      (skill) => skill.id === 'combat-skill-configuration',
    );
    expect(combatSkill?.content).toContain('不得读取任何其它 Agent `SKILL.md`');
    expect(combatSkill?.content).toContain('第一条内容证据必须是通过老版编辑器导出的目标');
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
        expect.arrayContaining(['meka-design-handbook', 'combat-skill-configuration']),
      );
      expect(resolved.skills.map((skill) => skill.id)).not.toContain('remote-operations');
      const persisted = await readFile(path.join(root, '.meka', 'project.json'), 'utf8');
      expect(persisted).toContain('# Legacy combat prompt');
      expect(persisted).not.toContain('saga2-combat-development-v1');
    } finally {
      environment.p4RootPath = null;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the shared default role with project defaults and project MCP', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cindy-meka-default-role-'));
    environment.p4RootPath = root;
    try {
      await mkdir(path.join(root, '.meka'), { recursive: true });
      await writeFile(
        path.join(root, '.meka', 'project.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            projectId: 'saga2',
            basic: {
              name: 'saga2',
              displayName: 'SAGA2',
              path: root,
              disciplines: ['通用'],
              domains: [],
            },
            metadata: [],
            // Project defaults a role with `useProjectDefaults` inherits.
            roleDefaults: {
              promptFramework: '# Project framework',
              rules: [{ id: 'project-rule', text: '# Project default rule', enabled: true }],
              skills: ['saga2-overview'],
              mcp: [{ id: 'project-agent', providerId: 'project-agent', enabled: true }],
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );

      const resolved = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');

      expect(resolved).toMatchObject({
        projectId: 'saga2',
        roleId: 'saga2-default-role',
        roleDisplayName: '默认角色',
        workflowRecoveredFromRole: false,
        policyProviderRefs: ['meka-host-risk-policy', 'meka-p4-boundary-policy'],
      });
      // Positive direction of the new contract: the default role is no longer zero-injection.
      expect(resolved.promptText).toContain('# Project framework');
      expect(resolved.promptText).toContain('business intent as the input contract');
      expect(resolved.promptText).toContain('safe diagnostics and recovery actions');
      expect(resolved.promptText).toContain('# Project default rule');
      expect(resolved.workflow).toBeUndefined();
      // `roleDefaults.skills` is a subset of the bundled catalog, so the catalog switch keeps the
      // effective set at all ten ids.
      expect(resolved.skills.map((skill) => skill.id).sort()).toEqual([
        'combat-skill-configuration',
        'meka-design-handbook',
        'orca-coordination',
        'p4-operations',
        'platform-capabilities',
        'remote-operations',
        'safety-boundaries',
        'saga2-entry-model',
        'saga2-overview',
        'saga2-server-reference',
      ]);
      expect(resolved.mcp.map((entry) => entry.id)).toEqual(['project-agent', 'meka-design']);
      // `projectReferences`（地址 + 描述、ENOENT 跳过、disabled 排除、scope→path 确定性排序）已整体
      // **迁移**到 unit 层的 `runtimeConfig.projectReferences.test.ts`：本文件被
      // `scripts/test-workspaces.config.mjs` 的 unit 层 exclude 排除，且 desktop 没有 integration
      // tier ⇒ 留在这里的断言等于没有覆盖。此处只保留「无项目根 ⇒ 不产出悬空引用」这一个负向事实。
      expect(resolved.projectReferences).toEqual([]);
    } finally {
      environment.p4RootPath = null;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the shared default role from its in-memory manifest, never from a project snapshot', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cindy-meka-default-role-snapshot-'));
    environment.p4RootPath = root;
    try {
      const bundledCombatRole = JSON.parse(
        await readFile(
          path.join(desktopRoot, 'resources/meka/roles/combat-development.json'),
          'utf8',
        ),
      ) as Record<string, unknown>;
      await mkdir(path.join(root, '.meka'), { recursive: true });
      await writeFile(
        path.join(root, '.meka', 'project.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            projectId: 'saga2',
            basic: {
              name: 'saga2',
              displayName: 'SAGA2',
              path: root,
              disciplines: ['通用'],
              domains: [],
            },
            metadata: [],
            roleDefaults: { promptFramework: '# Project framework', skills: [], mcp: [] },
            // A project-owned file that pretends the shared default role is a legacy bundled
            // snapshot. Both in-memory upgrade paths key off "a bundled manifest exists for this
            // roleId" and would rewrite prompt / fragments / flags from it — but the default role
            // has no packaged file and its manifest never reaches disk, so it must be resolved
            // from the factory manifest instead until the very end of the funnel.
            builtinRoles: [
              {
                ...bundledCombatRole,
                id: 'saga2-default-role',
                projectId: 'saga2',
                displayName: 'Hijacked default role',
                prompt: '# Hijacked default prompt',
                useProjectDefaults: false,
                includeAllProjectMetadata: false,
              },
            ],
          },
          null,
          2,
        )}\n`,
        'utf8',
      );

      // If the default role were routed through `readBuiltinRoleManifest` /
      // `migrateSAGA2CombatRoleSkills`, resolution would throw for the missing packaged file;
      // resolving at all is part of the contract.
      const resolved = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');

      expect(resolved.roleDisplayName).toBe('默认角色');
      expect(resolved.promptText).toContain('# Project framework');
      expect(resolved.promptText).toContain('business intent as the input contract');
      expect(resolved.promptText).not.toContain('# Hijacked default prompt');
      expect(resolved.promptText).not.toContain('面向策划的工作契约');
      expect(resolved.workflow).toBeUndefined();
      // The hijacked snapshot must not contribute anything; what remains is the factory contract —
      // the whole bundled catalog plus the one MCP the manifest declares itself.
      expect(resolved.skills.map((skill) => skill.id).sort()).toEqual([
        'combat-skill-configuration',
        'meka-design-handbook',
        'orca-coordination',
        'p4-operations',
        'platform-capabilities',
        'remote-operations',
        'safety-boundaries',
        'saga2-entry-model',
        'saga2-overview',
        'saga2-server-reference',
      ]);
      expect(resolved.mcp.map((entry) => entry.id)).toEqual(['meka-design']);
    } finally {
      environment.p4RootPath = null;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('migrates the renamed SAGA2 combat skill id in memory without rewriting the project snapshot', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cindy-meka-combat-skill-rename-'));
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
      const snapshot = {
        ...bundledRole,
        useProjectDefaults: true,
        includeAllProjectMetadata: true,
        skills: [
          ...(bundledRole.skills as Array<Record<string, unknown>>),
          { skillId: 'skill-entry-model', enabled: true },
        ],
        projectMetadataSelection: [
          ...(bundledRole.projectMetadataSelection as unknown[]),
          { sourcePath: 'saga2_design/AGENTS.md', itemType: 'agents-md', enabled: true },
        ],
      };
      await mkdir(path.join(root, '.meka'), { recursive: true });
      await mkdir(path.join(root, 'saga2_design'), { recursive: true });
      await writeFile(
        path.join(root, 'saga2_design', 'AGENTS.md'),
        '# AI 初次接入治理规则\n',
        'utf8',
      );
      await writeFile(
        path.join(root, '.meka', 'project.json'),
        `${JSON.stringify({ ...project, builtinRoles: [snapshot] }, null, 2)}\n`,
        'utf8',
      );

      const resolved = await resolveMekaRuntimeConfig('saga2', 'combat-development');

      expect(resolved.skills.map((skill) => skill.id)).not.toContain('saga2-entry-model');
      expect(resolved.skills.map((skill) => skill.id)).not.toContain('skill-entry-model');
      expect(resolved.promptText).toContain('面向策划的工作契约');
      expect(resolved.promptText).not.toContain('skill-entry-model');
      expect(resolved.promptText).not.toContain('AI 初次接入');
      expect(resolved.promptText).not.toContain('# Meka target framework');
      expect(resolved.skills.map((skill) => skill.id)).not.toContain(
        'saga2-project-battle-designer',
      );
      expect(await readFile(path.join(root, '.meka', 'project.json'), 'utf8')).toContain(
        'skill-entry-model',
      );
    } finally {
      environment.p4RootPath = null;
      await rm(root, { recursive: true, force: true });
    }
  });
});
