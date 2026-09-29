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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    expect(skills[0]?.content).toContain('# 平台外部能力');
    expect(skills[0]?.content).toContain('Host 动态注入的平台默认能力');
  });

  it('resolves the shared default role from the bundled SAGA2 project as the runtime source', async () => {
    const resolved = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');

    expect(resolved).toMatchObject({
      projectId: 'saga2',
      roleId: 'saga2-default-role',
      roleDisplayName: '默认角色',
      policyProviderRefs: ['meka-host-risk-policy', 'meka-p4-boundary-policy'],
    });
    // Factory-inclusive: the factory prompt reaches the system prefix even though the role manifest
    // itself declares no prompt body items. The bundled project ships no prompt framework of its own
    // any more, so this is the whole of the factory contract.
    expect(resolved.promptText).toContain('Establish the relevant contracts first');
    expect(resolved.promptText).toContain('safe diagnostics and recovery actions');
    // `useProjectDefaults` absorbs the project's default MCP server, and `includeAllBundledSkills`
    // adds every skill the packaged catalog scans on top of it — the catalog now scans exactly one.
    expect(resolved.skills.map((skill) => skill.id).sort()).toEqual(['platform-capabilities']);
    // `meka-design` is the one entry the manifest declares itself: it cannot be re-derived from the
    // project, unlike the `project-agent` entry the project's `roleDefaults` contributes.
    expect(resolved.mcp.map((entry) => entry.id)).toEqual(['project-agent', 'meka-design']);
    // No P4 root is configured in this case, so every selected reference file is unreadable and
    // must be skipped: `includeAllProjectMetadata` never produces a dangling reference.
    expect(resolved.projectReferences).toEqual([]);
  });

  it('falls back to the project default role when a builtin role manifest is no longer packaged (T2)', async () => {
    // 存量库必然留下指向已删包内清单的内置角色行（seed 只 upsert、从不删除不在注册表里的行），
    // `combat-development` 就是必然的那一个。解析它必须回落该项目默认角色，而不是抛
    // `builtin Meka role <id> not found` —— 抛错等于这些会话**打不开**（不是降级）。
    const resolved = await resolveMekaRuntimeConfig('saga2', 'combat-development');

    expect(resolved).toMatchObject({
      // 请求的角色 id 保持不变（会话绑定的是这一行），只有清单回落。
      roleId: 'combat-development',
      projectId: 'saga2',
      roleDisplayName: '默认角色',
      policyProviderRefs: ['meka-host-risk-policy', 'meka-p4-boundary-policy'],
    });
    expect(resolved.promptText).toContain('Establish the relevant contracts first');
    expect(resolved.skills.map((skill) => skill.id).sort()).toEqual(['platform-capabilities']);
    expect(resolved.mcp.map((entry) => entry.id)).toEqual(['project-agent', 'meka-design']);
    expect(resolved.projectReferences).toEqual([]);
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
              skills: ['platform-capabilities'],
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
        policyProviderRefs: ['meka-host-risk-policy', 'meka-p4-boundary-policy'],
      });
      // Positive direction of the new contract: the default role is no longer zero-injection.
      expect(resolved.promptText).toContain('# Project framework');
      expect(resolved.promptText).toContain('Establish the relevant contracts first');
      expect(resolved.promptText).toContain('safe diagnostics and recovery actions');
      expect(resolved.promptText).toContain('# Project default rule');
      expect(resolved.skills.map((skill) => skill.id).sort()).toEqual(['platform-capabilities']);
      // `roleDefaults.skills` 是作者显式声明（与 `explicitMetadataKeys` 同一落位口径）⇒ 同 id 的
      // catalog 铺底项被它覆盖，不带 `derivedOnly` 标记。
      expect(resolved.skills[0]?.derivedOnly).toBeUndefined();
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
            // A project-owned file that pretends the shared default role is a bundle snapshot. The
            // funnel keys off "this row is the derived `<projectId>-default-role`" *before* it ever
            // looks at project snapshots, and the factory manifest never reaches disk, so a snapshot
            // claiming that id must be ignored from start to finish — including its `enabled: false`
            // exclusion, which is exactly what a hijack would try to smuggle in.
            builtinRoles: [
              {
                schemaVersion: 1,
                id: 'saga2-default-role',
                projectId: 'saga2',
                name: 'saga2-default-role',
                displayName: 'Hijacked default role',
                prompt: '# Hijacked default prompt',
                rules: [],
                skills: [{ skillId: 'platform-capabilities', enabled: false }],
                promptFragments: [],
                mcp: [],
                projectMetadataSelection: [],
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

      // Resolving at all is part of the contract: a snapshot for this id must not route resolution
      // through the packaged manifest (which no longer exists for any role).
      const resolved = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');

      expect(resolved.roleDisplayName).toBe('默认角色');
      expect(resolved.promptText).toContain('# Project framework');
      expect(resolved.promptText).toContain('Establish the relevant contracts first');
      expect(resolved.promptText).not.toContain('# Hijacked default prompt');
      // The hijacked snapshot must not contribute anything; what remains is the factory contract —
      // the whole packaged catalog plus the one MCP the manifest declares itself.
      expect(resolved.skills.map((skill) => skill.id).sort()).toEqual(['platform-capabilities']);
      expect(resolved.mcp.map((entry) => entry.id)).toEqual(['meka-design']);
    } finally {
      environment.p4RootPath = null;
      await rm(root, { recursive: true, force: true });
    }
  });
});
