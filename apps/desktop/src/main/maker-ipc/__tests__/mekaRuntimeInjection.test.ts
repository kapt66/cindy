import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
  BUILTIN_MEKA_PROJECTS,
  MEKA_DEFAULT_ROLE_DISPLAY_NAME,
  type MekaRoleMcpEntry,
  mekaDefaultRoleId,
} from '../../../shared/meka-projects.js';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import type { MekaRuntimeConfig } from '../../meka-projects/runtimeConfig.js';
import { applyMekaRuntimeConfig as applyMekaRuntimeConfigImpl } from '../../meka-injection/index.js';
import type { MakerSessionCreateOpts } from '../sessionRequest.js';

const environmentServices = vi.hoisted(() => ({
  p4: { get: vi.fn(async () => ({ p4RootPath: null })) },
  router: {
    listInstances: vi.fn(async () => []),
    listProjectBindings: vi.fn(async () => []),
  },
}));

vi.mock('../../meka-settings/ipc.js', () => ({
  getMekaP4SettingsService: () => environmentServices.p4,
  getMekaRouterService: () => environmentServices.router,
}));

vi.mock('../../maker-host/mcpr-codex-capability.js', () => ({
  probeRemoteCodexCapability: vi.fn(async () => undefined),
}));

vi.mock('../../maker-host/mcpr-claude-capability.js', () => ({
  probeRemoteClaudeCapability: vi.fn(async () => undefined),
}));

/**
 * 真实 `resolveMekaRuntimeConfig` 用例（历史四角色兜底）用的 DB 替身。
 *
 * 关键点：替身的行集合**完全由包内角色注册表派生** —— `seedBuiltinMekaProjects` 写进
 * `meka_roles` / `meka_projects` 的就是 `BUILTIN_MEKA_PROJECTS`。因此「兜底目标角色已从包里删除」
 * 会真的走成 `Meka role not found`，不会被替身掩盖成通过（这正是 fake resolver 用例的盲区）。
 *
 * 用 `setCurrentDbClient` 而不是 mock 模块：只有显式注册它的那条用例里 DB 才是 ready，
 * 其余用例仍按真实语义拿 `DbClient not ready`。
 */
function realRuntimeDbClient(): DbClient {
  return {
    queryOne: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM meka_projects')) {
        const project = BUILTIN_MEKA_PROJECTS.find(
          (candidate) => candidate.id === String(params[0]),
        );
        return project ? { id: project.id, path: project.path, is_builtin: 1 } : undefined;
      }
      if (sql.includes('FROM meka_roles')) {
        const roleId = String(params[0]);
        const project = BUILTIN_MEKA_PROJECTS.find((candidate) =>
          candidate.roles.some((role) => role.id === roleId),
        );
        if (!project) return undefined;
        return {
          id: roleId,
          project_id: project.id,
          is_builtin: 1,
          file_path: `meka/roles/${roleId}.json`,
        };
      }
      return undefined;
    },
  } as unknown as DbClient;
}

/** `apps/desktop` 的绝对路径：与调用方 cwd 无关（包内资源就在它下面）。 */
const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

// 同一份源码只读一次：本文件的多条跨文件契约断言共用它，避免把
// 「读取 register.ts」这种 guard 级静态契约扩散成多次 source read。
const REGISTER_SOURCE_URL = new URL('../register.ts', import.meta.url);
let registerSourcePromise: Promise<string> | null = null;
const loadRegisterSource = () => (registerSourcePromise ??= fs.readFile(REGISTER_SOURCE_URL, 'utf8'));

type ApplyDeps = NonNullable<Parameters<typeof applyMekaRuntimeConfigImpl>[1]>;

function applyMekaRuntimeConfig(opts: MakerSessionCreateOpts, deps: ApplyDeps = {}) {
  return applyMekaRuntimeConfigImpl(opts, {
    resolvePlatformSkills: async () => [],
    ...deps,
  });
}

function platformSkill() {
  return {
    id: 'platform-capabilities',
    name: 'platform-capabilities',
    description: 'Host-owned Meka platform capabilities.',
    content: '# Platform Capabilities',
    sourceDirectory: 'C:/skills/platform-capabilities',
    sourceEntryPath: 'C:/skills/platform-capabilities/SKILL.md',
  };
}

function baseOpts(overrides: Partial<MakerSessionCreateOpts> = {}): MakerSessionCreateOpts {
  return {
    id: 'session-1',
    agentKind: 'codex',
    model: 'gpt-test',
    workingDir: 'C:/Workspace/saga2/saga2_project',
    workspaceKind: 'meka',
    mekaProjectId: 'saga2',
    mekaRoleId: 'saga2-default-role',
    ...overrides,
  };
}

function runtime(overrides: Partial<MekaRuntimeConfig> = {}): MekaRuntimeConfig {
  return {
    projectId: 'saga2',
    roleId: 'saga2-default-role',
    roleDisplayName: '默认角色',
    promptText: 'SAGA2 server code lives behind MCPRouter as saga2-server.',
    skills: [
      {
        id: 'remote-operation',
        name: 'Remote Operation',
        description: 'Use bound MCPRouter instances.',
        content: '# Remote Operation',
        sourceDirectory: 'C:/skills/remote-operation',
        sourceEntryPath: 'C:/skills/remote-operation/SKILL.md',
      },
    ],
    mcp: [
      { id: 'router', providerId: 'mcp-router', enabled: true },
      { id: 'project-agent', providerId: 'project-agent', enabled: true },
      { id: 'design', providerId: 'meka-design', enabled: true },
      { id: 'local-http', transport: 'http', url: 'https://example.invalid/mcp', enabled: true },
    ],
    policyProviderRefs: [],
    // 新必填字段：空集合 ⇒ `meka.project-references` 段整段不渲染，本文件的既有断言不变。
    projectReferences: [],
    ...overrides,
  };
}

describe('applyMekaRuntimeConfig', () => {
  it('is wired into register bootstrap before maker.createSession', async () => {
    const source = await loadRegisterSource();
    // 第八轮同步后上游把函数体改名为 `bootstrapSessionOnce`（Meka 的 in-flight 去重包装仍叫
    // `bootstrapSession`），创建调用也从 `maker.createSession(o)` 收敛成
    // `createSessionWithRuntimePlugins(o, creationSignal)`。锚点按**符号名 + 前缀**定位，
    // 不绑已被上游改写的字面量（否则每次上游重命名都会假红）。
    const bootstrap = source.indexOf('async function bootstrapSessionOnce');
    const applyRuntime = source.indexOf('await applyMekaRuntimeConfig(o,', bootstrap);
    const createSession = source.indexOf('createSessionWithRuntimePlugins(o', applyRuntime);

    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(applyRuntime).toBeGreaterThan(bootstrap);
    expect(createSession).toBeGreaterThan(applyRuntime);
  });

  it('injects project-role prompt and MCP provider ids for Meka sessions', async () => {
    const opts = baseOpts({
      userPrompt: 'USER PROMPT',
      vendorOptions: { onStderrLine: 'keep-me', orcaRole: 'lead' },
    });
    const snapshot = {
      revision: 'a'.repeat(64),
      pluginPath: 'C:/CindyMeka/meka-skill-snapshots/revisions/a/claude-plugin',
      files: [
        {
          relativePath: 'skills/remote-operation/SKILL.md',
          contentBase64: 'IyBSZW1vdGUgT3BlcmF0aW9u',
          digest: '1'.repeat(64),
        },
      ],
    };
    const materialize = vi.fn(async () => snapshot);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime()),
      prepareRuntimeMcp: vi.fn((entries: readonly MekaRoleMcpEntry[]) => ({
        providerIds: entries
          .filter(
            (entry): entry is Extract<typeof entry, { providerId: string }> =>
              'providerId' in entry,
          )
          .map((entry) => entry.providerId),
        inlineConfigs: entries.filter(
          (entry): entry is Extract<typeof entry, { transport: unknown }> => 'transport' in entry,
        ),
      })),
      materializeSkillSnapshot: materialize,
    });

    expect(result).toMatchObject({
      didApply: true,
      mcpProviderIds: ['mcp-router', 'project-agent', 'meka-design'],
      inlineMcpCount: 1,
      skillsCount: 1,
      skillSnapshot: snapshot,
    });
    expect(opts.userPrompt).toContain('[MEKA_ROLE_CONTEXT]');
    expect(opts.userPrompt).toContain('roleId: saga2-default-role');
    expect(opts.userPrompt).toContain('displayName: 默认角色');
    expect(opts.userPrompt).toContain(
      'SAGA2 server code lives behind MCPRouter as saga2-server.\n\nUSER PROMPT',
    );
    expect(opts.userPrompt).not.toContain('# Remote Operation');
    expect(opts.nativeSkillPluginPath).toBe(snapshot.pluginPath);
    expect(opts.nativeSkillRevision).toBe(snapshot.revision);
    expect(opts.vendorOptions).toMatchObject({
      onStderrLine: 'keep-me',
      orcaRole: 'lead',
      source: 'meka',
      mekaProjectId: 'saga2',
      mekaRoleId: 'saga2-default-role',
      mekaMcpProviderIds: ['mcp-router', 'project-agent', 'meka-design'],
      mekaMcpInlineConfigs: [
        { id: 'local-http', transport: 'http', url: 'https://example.invalid/mcp' },
      ],
    });
    // workflow 机制删除后 `codexNativeSubagentsDisabled` 在本仓**没有任何生产者**（它原本只由
    // 「是战斗 workflow」这一个条件产出）。消费者仍在 `packages/maker-core`，改由宿主策略经
    // vendorOptions 声明 ⇒ 普通 Meka 会话上这个键必须缺席。
    expect(opts.vendorOptions).not.toHaveProperty('codexNativeSubagentsDisabled');
    // 注入路径本身不做任何环境探测（曾由战斗环境门禁引入的 P4 根 / Router 实例查询已随该机制
    // 删除；这条断言把「启动期零探测」钉住，防止它换个名字回来）。
    expect(environmentServices.p4.get).not.toHaveBeenCalled();
    expect(environmentServices.router.listInstances).not.toHaveBeenCalled();
    expect(materialize).toHaveBeenCalledWith(opts.id, runtime().skills);
  });

  it('does not inject active Router guidance into ordinary Meka tasks', async () => {
    const opts = baseOpts({ userPrompt: 'USER PROMPT' });
    const materialize = vi.fn(async () => null);
    const prepareRuntimeMcp = vi.fn((entries: readonly MekaRoleMcpEntry[]) => ({
      providerIds: entries
        .filter(
          (entry): entry is Extract<typeof entry, { providerId: string }> =>
            'providerId' in entry,
        )
        .map((entry) => entry.providerId),
      inlineConfigs: [],
    }));

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime({ skills: [], mcp: [] })),
      resolvePlatformSkills: vi.fn(async () => [platformSkill()]),
      prepareRuntimeMcp,
      materializeSkillSnapshot: materialize,
    });

    expect(result).toMatchObject({
      didApply: true,
      mcpProviderIds: ['mcp-router'],
      skillsCount: 1,
      platformSkillsCount: 1,
    });
    expect(prepareRuntimeMcp).toHaveBeenCalledWith([
      { id: 'mcp-router', providerId: 'mcp-router', enabled: true },
    ]);
    expect(materialize).toHaveBeenCalledWith(opts.id, [platformSkill()]);
    expect(opts.userPrompt).not.toContain('[MEKA_PLATFORM_CAPABILITIES]');
    expect(opts.userPrompt).not.toContain('mcp_router.list_remote_directory');
  });

  it('mounts the platform skills exactly once when a role already selects the same id', async () => {
    const opts = baseOpts({ userPrompt: 'USER PROMPT' });
    const materialize = vi.fn(async () => null);
    // 角色自己扫出来的同名 skill（`includeAllBundledSkills` 下 `platform-capabilities` 必然在其中）。
    const roleOwnedPlatformSkill = {
      ...platformSkill(),
      name: 'role-owned platform-capabilities',
      content: '# Role-owned copy',
      sourceDirectory: 'C:/skills/role-owned-platform-capabilities',
      sourceEntryPath: 'C:/skills/role-owned-platform-capabilities/SKILL.md',
    };

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () =>
        runtime({ skills: [roleOwnedPlatformSkill], mcp: [] }),
      ),
      resolvePlatformSkills: vi.fn(async () => [platformSkill()]),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      materializeSkillSnapshot: materialize,
    });

    // `mergePlatformSkills` 按 id 去重且平台基线版本胜出：挂载一次，不是两次。
    expect(result.skillsCount).toBe(1);
    expect(result.platformSkillsCount).toBe(1);
    expect(materialize).toHaveBeenCalledWith(opts.id, [platformSkill()]);
  });

  it('uses an immutable native Skill snapshot without mutating the workspace', async () => {
    const opts = baseOpts({ workingDir: 'C:/Workspace/real-project' });
    const resolved = runtime();
    const snapshot = {
      revision: 'b'.repeat(64),
      pluginPath: 'C:/CindyMeka/meka-skill-snapshots/revisions/b/claude-plugin',
      files: [
        {
          relativePath: 'skills/remote-operation/SKILL.md',
          contentBase64: 'IyBSZW1vdGUgT3BlcmF0aW9u',
          digest: '2'.repeat(64),
        },
      ],
    };
    const materialize = vi.fn(async () => snapshot);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => resolved),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      materializeSkillSnapshot: materialize,
    });

    expect(result.skillSnapshot).toBe(snapshot);
    expect(materialize).toHaveBeenCalledWith(opts.id, resolved.skills);
    expect(opts.nativeSkillPluginPath).toBe(snapshot.pluginPath);
    expect(opts.nativeSkillRevision).toBe(snapshot.revision);
    expect(opts.userPrompt).toContain('[MEKA_ROLE_CONTEXT]');
    expect(opts.userPrompt).toContain('SAGA2 server code lives behind MCPRouter as saga2-server.');
  });

  it('freezes an empty selection without mounting an empty native Skill plugin', async () => {
    const opts = baseOpts();
    const snapshot = {
      revision: '0'.repeat(64),
      pluginPath: 'C:/CindyMeka/meka-skill-snapshots/revisions/0/claude-plugin',
      files: [{ relativePath: 'catalog.json', contentBase64: 'W10K', digest: '4'.repeat(64) }],
    };

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime({ skills: [], mcp: [] })),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      materializeSkillSnapshot: vi.fn(async () => snapshot),
    });

    expect(result.skillSnapshot).toBe(snapshot);
    expect(opts.nativeSkillPluginPath).toBeUndefined();
    expect(opts.nativeSkillRevision).toBeUndefined();
  });

  // 兜底目标：历史四角色列（planner/artist/programmer/tester）没有对应角色行，派生目标必须是
  // **该项目自己的共享默认角色**（`mekaDefaultRoleId('saga2')` === `saga2-default-role`）。
  // 旧目标 `general-development` 已随「通用开发」退役（`RETIRED_BUILTIN_MEKA_DEFAULT_ROLE_ALIASES`），
  // 包内已无该角色的清单文件，继续指向它会让旧会话冷启动抛 `Meka role not found`。
  it.each([
    ['planner', 'saga2-default-role'],
    ['artist', 'saga2-default-role'],
    ['tester', 'saga2-default-role'],
    ['programmer', 'saga2-default-role'],
  ] as const)(
    'hydrates a persisted legacy %s binding as %s',
    async (legacyRole, expectedRoleId) => {
      const opts = baseOpts({
        id: 'legacy-session',
        workspaceKind: undefined,
        mekaProjectId: null,
        mekaRoleId: null,
        mekaRole: null,
      });
      const resolveRuntimeConfig = vi.fn(async (projectId: string, roleId: string) =>
        runtime({ projectId, roleId, skills: [], mcp: [] }),
      );

      const result = await applyMekaRuntimeConfig(opts, {
        readPersistedSession: vi.fn(async () => ({
          workspaceKind: 'meka' as const,
          mekaProjectId: 'saga2',
          mekaRoleId: null,
          mekaRole: legacyRole,
        })),
        resolveRuntimeConfig,
        prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
        materializeSkillSnapshot: vi.fn(async () => null),
      });

      expect(result.didApply).toBe(true);
      expect(resolveRuntimeConfig).toHaveBeenCalledWith('saga2', expectedRoleId);
      expect(opts).toMatchObject({
        workspaceKind: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: expectedRoleId,
        mekaRole: legacyRole,
      });
    },
  );

  // 上面那组用的是 fake resolver：它只证明「派生出了哪个 id」，不证明那个 id 在生产里能解析出来
  // （「通用开发」被删时正是这种静默回归 —— fake resolver 照样返回，生产抛 `Meka role not found`）。
  // 这条用例用**真实 `resolveMekaRuntimeConfig`**（真实包内资源 + 真实内置角色注册表派生的 DB 行）
  // 走完整条兜底路径：一旦兜底目标失效，它会以解析失败的方式变红。
  it('resolves the legacy-role fallback target through the real runtime resolver', async () => {
    const opts = baseOpts({
      id: 'legacy-session-real',
      workspaceKind: undefined,
      mekaProjectId: null,
      mekaRoleId: null,
      mekaRole: null,
    });
    const prepareRuntimeMcp = vi.fn(() => ({ providerIds: [], inlineConfigs: [] }));
    const materializeSkillSnapshot = vi.fn(async () => null);
    const dbClient = realRuntimeDbClient();
    const originalGetAppPath = app.getAppPath;
    // 该用例刻意**不注入** `resolveRuntimeConfig`：走 `resolveMekaRuntimeConfig` 生产实现。
    // 真实解析要读包内资源（`resources/meka/**`），而 `resourcePaths.ts` 用 `app.getAppPath()`
    // 定位它（vitest 的 electron 替身返回 `process.cwd()`，依赖调用方 cwd）。这里临时钉到
    // 由本测试文件位置推导的 `apps/desktop`，让该用例与 cwd 无关。
    (app as { getAppPath: () => string }).getAppPath = () => DESKTOP_ROOT;
    setCurrentDbClient(dbClient, 'test-user');
    try {
      const result = await applyMekaRuntimeConfig(opts, {
        readPersistedSession: vi.fn(async () => ({
          workspaceKind: 'meka' as const,
          mekaProjectId: 'saga2',
          mekaRoleId: null,
          // `vi.fn` 不参与上下文类型推断，字面量会被拓宽成 `string`；这里钉死为联合类型成员。
          mekaRole: 'planner' as const,
        })),
        prepareRuntimeMcp,
        materializeSkillSnapshot,
      });

      expect(result.didApply).toBe(true);
      // 兜底目标必须真实存在于该项目的角色列表里 —— 这里由真实解析成功本身证明。
      expect(opts).toMatchObject({
        workspaceKind: 'meka',
        mekaProjectId: 'saga2',
        mekaRoleId: mekaDefaultRoleId('saga2'),
      });
      expect(MEKA_DEFAULT_ROLE_DISPLAY_NAME).toBe('默认角色');
      expect(opts.userPrompt).toContain(`roleId: ${mekaDefaultRoleId('saga2')}`);
      expect(opts.userPrompt).toContain(`displayName: ${MEKA_DEFAULT_ROLE_DISPLAY_NAME}`);
      // 角色段里的 prompt 正文真的被解析出来了（不是一个空壳）：它来自 `mekaDefaultRoleManifest`
      // 的出厂 prompt。项目侧 `saga2/project.json` 的 `roleDefaults.promptFramework` 属内置提示词
      // 正文，已随本轮删除，不再参与角色段 —— 这里断言的是角色清单自身的契约句。
      expect(opts.userPrompt).toContain(
        'Identify whether the target needs design, local project, configuration, or remote-service work.',
      );
    } finally {
      (app as { getAppPath: () => string }).getAppPath = originalGetAppPath;
      clearCurrentDbClient(dbClient);
    }
  });

  it('does not duplicate prompt injection when the same create opts are bootstrapped twice', async () => {
    const opts = baseOpts({ userPrompt: 'USER PROMPT' });
    const resolveRuntimeConfig = vi.fn(async () => runtime({ skills: [], mcp: [] }));
    const prepareRuntimeMcp = vi.fn(() => ({ providerIds: [], inlineConfigs: [] }));
    const materializeSkillSnapshot = vi.fn(async () => null);
    const resolvePlatformSkills = vi.fn(async () => [platformSkill()]);

    const first = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      prepareRuntimeMcp,
      materializeSkillSnapshot,
      resolvePlatformSkills,
    });
    const promptAfterFirstBootstrap = opts.userPrompt;
    const second = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      prepareRuntimeMcp,
      materializeSkillSnapshot,
      resolvePlatformSkills,
    });

    expect(first.didApply).toBe(true);
    // 第二次带上了第一次写下的 `mekaRuntimeResolved: true` ⇒ 走 resume 短路：不重解析、
    // 不重算 MCP、不写任何段，只物化一次空技能集合并早返回。
    expect(second.didApply).toBe(false);
    expect(second).toStrictEqual({
      didApply: false,
      mcpProviderIds: [],
      inlineMcpCount: 0,
      skillsCount: 0,
      platformSkillsCount: 0,
      skillSnapshot: null,
    });
    expect(resolveRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(prepareRuntimeMcp).toHaveBeenCalledTimes(1);
    expect(resolvePlatformSkills).toHaveBeenCalledTimes(1);
    expect(materializeSkillSnapshot).toHaveBeenCalledTimes(2);
    expect(materializeSkillSnapshot).toHaveBeenNthCalledWith(1, opts.id, [platformSkill()]);
    expect(materializeSkillSnapshot).toHaveBeenNthCalledWith(2, opts.id, []);
    expect(opts.userPrompt).toBe(promptAfterFirstBootstrap);
    // 幂等的最强证据：整篇 prompt 里角色段只出现一次。
    expect(opts.userPrompt?.match(/\[MEKA_ROLE_CONTEXT\]/g)?.length).toBe(1);
    expect(opts.userPrompt).not.toContain('[MEKA_PLATFORM_CAPABILITIES]');
  });

  it('freezes remote skills without exposing the local snapshot path to the remote harness', async () => {
    const opts = baseOpts({ remoteHostId: 'mcpr:instance-1' });
    const snapshot = {
      revision: 'c'.repeat(64),
      pluginPath: 'C:/CindyMeka/meka-skill-snapshots/revisions/c/claude-plugin',
      files: [
        {
          relativePath: 'skills/remote-operation/SKILL.md',
          contentBase64: 'IyBSZW1vdGUgT3BlcmF0aW9u',
          digest: '3'.repeat(64),
        },
      ],
    };
    const materialize = vi.fn(async () => snapshot);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime()),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      materializeSkillSnapshot: materialize,
    });

    expect(result.skillSnapshot).toBe(snapshot);
    expect(materialize).toHaveBeenCalledWith(opts.id, runtime().skills);
    expect(opts.nativeSkillPluginPath).toBeUndefined();
    expect(opts.nativeSkillRevision).toBeUndefined();
    expect(opts.userPrompt).not.toContain('# Remote Operation');

    const retried = await applyMekaRuntimeConfig(opts, {
      materializeSkillSnapshot: materialize,
    });
    expect(retried.skillSnapshot).toBe(snapshot);
    expect(opts.userPrompt).toContain('[MEKA_ROLE_CONTEXT]');
    expect(opts.userPrompt).toContain('SAGA2 server code lives behind MCPRouter as saga2-server.');
    expect(materialize).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: 'project/role resolution',
      deps: {
        resolveRuntimeConfig: vi.fn(async () => {
          throw new Error('broken role');
        }),
      },
      message: '[INVALID_PARAMS] Meka project/role configuration failed: broken role',
    },
    {
      name: 'MCP preparation',
      deps: {
        resolveRuntimeConfig: vi.fn(async () => runtime()),
        prepareRuntimeMcp: vi.fn(() => {
          throw new Error('broken MCP');
        }),
      },
      message: '[INVALID_PARAMS] Meka project/role MCP configuration failed: broken MCP',
    },
  ])('preserves INVALID_PARAMS for $name failures', async ({ deps, message }) => {
    await expect(applyMekaRuntimeConfig(baseOpts(), deps)).rejects.toThrow(message);
  });

  it('leaves non-Meka sessions untouched', async () => {
    const opts = baseOpts({
      workspaceKind: 'project',
      mekaProjectId: null,
      mekaRoleId: null,
      userPrompt: 'USER PROMPT',
    });
    const resolveRuntimeConfig = vi.fn();

    const result = await applyMekaRuntimeConfig(opts, { resolveRuntimeConfig });

    expect(result.didApply).toBe(false);
    expect(resolveRuntimeConfig).not.toHaveBeenCalled();
    expect(opts.userPrompt).toBe('USER PROMPT');
    expect(opts.vendorOptions).toBeUndefined();
  });
});

// ————————————————————————————————————————————————————————————————
// 2026-11-20：Meka 助理会话身份 = 持久化绑定（`mekaProjectId` + `mekaRoleId`），
// `workspaceKind` 只是展示归类。规则见 `docs/dev-rules/meka-assistant-session-binding.md`。
//
// 测试价值
// - 生产入口与可观察结果：`applyMekaRuntimeConfig` 的触发条件；冷启动（桌面 / IM / hook）时
//   普通 kind 的新 Meka 会话必须被注入角色提示词与项目 MCP，普通会话必须零注入、零回填。
// - Bug／规则依据：身份从 kind 改成绑定后，若触发条件仍只看 kind，所有新 Meka 会话冷启动
//   都会静默退化成普通任务（无角色 prompt / 无项目能力）。
// - 现有覆盖缺口：既有用例全部用 `baseOpts`（kind='meka' + 绑定）触发，没有任何用例证明
//   「kind 普通但绑定成对」会注入，也没有普通会话 + readPersistedSession 的负向用例。
// - 最小失败输入：create opts `workspaceKind='project'` + 成对绑定（新桌面会话的形状），
//   或 IM 冷启动只有会话 id 而 DB 行带绑定。
// - tier：unit（注入层，纯内存 fake）。
// ————————————————————————————————————————————————————————————————
describe('Meka session identity from the persisted binding (2026-11-20)', () => {
  function runtimeDeps(materialize = vi.fn(async () => null)) {
    return {
      resolveRuntimeConfig: vi.fn(async (projectId: string, roleId: string) =>
        runtime({ projectId, roleId, skills: [], mcp: [] }),
      ),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      materializeSkillSnapshot: materialize,
    };
  }

  it('injects when the create opts carry a complete binding under the ordinary project kind', async () => {
    const opts = baseOpts({ workspaceKind: 'project', userPrompt: 'USER PROMPT' });
    const deps = runtimeDeps();

    const result = await applyMekaRuntimeConfig(opts, deps);

    expect(result.didApply).toBe(true);
    expect(deps.resolveRuntimeConfig).toHaveBeenCalledWith('saga2', 'saga2-default-role');
    expect(opts.userPrompt).toContain('[MEKA_ROLE_CONTEXT]');
    expect(opts.userPrompt).toContain('roleId: saga2-default-role');
    expect(opts.vendorOptions).toMatchObject({
      source: 'meka',
      mekaProjectId: 'saga2',
      mekaRoleId: 'saga2-default-role',
    });
  });

  it('hydrates the persisted binding for a cold start whose create opts carry no identity', async () => {
    const opts = baseOpts({
      workspaceKind: undefined,
      mekaProjectId: null,
      mekaRoleId: null,
      mekaRole: null,
      userPrompt: 'USER PROMPT',
    });
    const deps = runtimeDeps();
    const readPersistedSession = vi.fn(async () => ({
      workspaceKind: 'project' as const,
      mekaProjectId: 'saga2',
      mekaRoleId: 'saga2-default-role',
      mekaRole: null,
    }));

    const result = await applyMekaRuntimeConfig(opts, { ...deps, readPersistedSession });

    expect(readPersistedSession).toHaveBeenCalledWith(opts.id);
    expect(result.didApply).toBe(true);
    // 回填的绑定写回 create opts：IM / hook 后续 createSession 看到的是完整 Meka 会话。
    expect(opts).toMatchObject({
      workspaceKind: 'project',
      mekaProjectId: 'saga2',
      mekaRoleId: 'saga2-default-role',
    });
    expect(opts.userPrompt).toContain('[MEKA_ROLE_CONTEXT]');
  });

  it('leaves an ordinary persisted session untouched and never backfills a binding', async () => {
    const opts = baseOpts({
      workspaceKind: 'project',
      mekaProjectId: null,
      mekaRoleId: null,
      userPrompt: 'USER PROMPT',
    });
    const before = { ...opts };
    const deps = runtimeDeps();

    const result = await applyMekaRuntimeConfig(opts, {
      ...deps,
      readPersistedSession: vi.fn(async () => ({
        workspaceKind: 'project' as const,
        mekaProjectId: null,
        mekaRoleId: null,
        mekaRole: null,
      })),
    });

    expect(result.didApply).toBe(false);
    expect(deps.resolveRuntimeConfig).not.toHaveBeenCalled();
    expect({ ...opts }).toEqual(before);
  });

  it('rejects a legacy meka row that has no project/role instead of injecting a roleless session', async () => {
    const opts = baseOpts({
      workspaceKind: 'meka',
      mekaProjectId: null,
      mekaRoleId: null,
    });

    await expect(applyMekaRuntimeConfig(opts, runtimeDeps())).rejects.toThrow(
      '[INVALID_PARAMS] Meka session requires a project and role',
    );
  });
});

/**
 * WL-11.3（Meka 会话行绑定 project/role）：`send_to_session` 的 create 分支是
 * `sendToSessionInternal` 巨型闭包，仓内没有可单独调用的生产入口，因此按本文件既有
 * guard 口径用源码契约守住「写入方不变量」——成对绑定必须与 session 行同一次写入，
 * 缺一即降级普通任务、不落半绑定行。2026-11-20 起判据是**绑定成对**而不是
 * `workspace_kind='meka'`（新会话 kind 是普通值，旧 kind 只作展示分类）。
 *
 * 真实回归 1：Meka 项目入口新建草稿 → 首次发送走 create 分支，早先把 dispatcher 的
 * `'meka'` 一律降级成 project/dialogue，会话行落成
 * `workspace_kind='dialogue' / meka_project_id=null / meka_role_id=null`（smoke WL-11.3 红）。
 * 真实回归 2（2026-11-20）：身份改成绑定后，若继承判据仍要求 kind==='meka'，新 Meka 会话
 * 派生的子任务会丢掉绑定、冷启动不再注入角色运行时。
 */
describe('send_to_session create 分支的 Meka 归属继承', () => {
  /** create 分支里决定「继承哪个 workspaceKind / 写哪些 Meka 字段」的那一段。 */
  async function inheritedWorkspaceSlice(): Promise<string> {
    const source = await loadRegisterSource();
    const start = source.indexOf('const inheritedMekaProjectId = row?.mekaProjectId ?? null;');
    // 结束锚点：上游把来源路由判定抽成 `resolveSendToSessionCreateRoute(...)`（原先的
    // `const hasExecutionOverrides =` 局部变量已不存在），但「这段继承逻辑到路由解析为止」
    // 的语义不变 ⇒ 用新符号名做边界。
    const end = source.indexOf('const route = await resolveSendToSessionCreateRoute({', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  /** createOpts 与 openSession body 两处写出 Meka 身份的行。 */
  async function mekaIdentityWriteSites(): Promise<string> {
    const source = await loadRegisterSource();
    const createOpts = source.indexOf('const createOpts = buildCreateOptsWithStderr({');
    const openSession = source.indexOf('await openSession({', createOpts);
    const end = source.indexOf('}, async (row, assertCurrent) => {', openSession);
    expect(createOpts).toBeGreaterThanOrEqual(0);
    expect(openSession).toBeGreaterThan(createOpts);
    expect(end).toBeGreaterThan(openSession);
    return source.slice(createOpts, end);
  }

  it('inherits both ids whenever the dispatcher row carries a complete binding, regardless of kind', async () => {
    const slice = await inheritedWorkspaceSlice();
    // 判据：两个 id 都在 + 调用方没显式换项目；不再要求 dispatcher 的 kind === 'meka'。
    expect(slice).toContain('Boolean(inheritedMekaProjectId)');
    expect(slice).toContain('Boolean(inheritedMekaRoleId)');
    expect(slice).toContain('params.projectDir === undefined');
    expect(slice).toContain('inheritsMekaBinding');
    // 新会话（普通 kind + 绑定）同样把身份带出子任务。
    expect(slice).toContain('mekaProjectId: inheritedMekaProjectId, mekaRoleId: inheritedMekaRoleId');
    // 旧 kind='meka' 仍原样复制第三态，但只作展示分类：它出现在绑定判定**之后**，
    // 证明 kind 不是继承身份的前提。
    const bindingIndex = slice.indexOf('inheritsMekaBinding');
    const mekaKindIndex = slice.indexOf("meta.workspaceKind === 'meka'");
    const mekaKindValueIndex = slice.indexOf("? 'meka'");
    expect(bindingIndex).toBeGreaterThanOrEqual(0);
    expect(mekaKindIndex).toBeGreaterThan(bindingIndex);
    expect(mekaKindValueIndex).toBeGreaterThan(mekaKindIndex);
  });

  it('degrades to a plain task when the dispatcher lacks project or role', async () => {
    const slice = await inheritedWorkspaceSlice();
    // 降级分支仍按目录语义：dialogue 保持 dialogue，其余 project。
    expect(slice).toContain("? 'dialogue'");
    expect(slice).toContain(": 'project'");
    // 'meka' 只出现在 inheritsMekaBinding 之后，且两个 id 缺一不会走到它。
    const mekaIndex = slice.indexOf("? 'meka'");
    const bindingIndex = slice.indexOf('inheritsMekaBinding');
    expect(bindingIndex).toBeGreaterThanOrEqual(0);
    expect(mekaIndex).toBeGreaterThan(bindingIndex);
    // 显式换项目（含 projectDir:null）时绝不继承 Meka 绑定。
    expect(slice).toContain('params.projectDir === null');
    expect(slice).toContain('params.projectDir !== undefined');
  });

  it('persists the identity through both createOpts and the openSession insert', async () => {
    const writes = await mekaIdentityWriteSites();
    // createOpts 与 openSession body 各自一次，且都要求成对（同一条件表达式）。
    const pairs = writes.match(/inherited\.mekaProjectId && inherited\.mekaRoleId/g);
    expect(pairs).toHaveLength(2);
    expect(writes).toContain('mekaProjectId: inherited.mekaProjectId, mekaRoleId: inherited.mekaRoleId');
  });

  it('keeps the MCP receipt on the shared two-value contract', async () => {
    const source = await loadRegisterSource();
    // 回执不随内部第三态扩到 'meka'：跨端 `send_to_session.workspace_kind` 保持两值。
    expect(source).toContain(
      "workspaceKind: openedRow.workspaceKind === 'dialogue' ? 'dialogue' : 'project',",
    );
  });
});
