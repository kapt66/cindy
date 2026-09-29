/**
 * The shared built-in default role (`<projectId>-default-role`) is factory-inclusive and
 * read-only by contract.
 *
 * Its manifest deliberately lives in memory, never on disk: `resources/meka/roles/<id>.json` does not
 * exist, and the strict `readBuiltinRoleManifest` *throws* when the file is missing (only
 * `readBuiltinRoleManifestOrProjectDefault` falls back), so
 * `meka-role:read-manifest` resolves this one role from `mekaDefaultRoleManifest()`. That
 * manifest is the opposite of "zero injection": it opts into the project's role defaults
 * (`useProjectDefaults`), into every enabled project metadata item (`includeAllProjectMetadata`),
 * into every skill the bundled catalog scans (`includeAllBundledSkills`) and carries the factory
 * two-paragraph prompt, while declaring no prompt fragments of its own.
 *
 * Both interceptors in `localDb/ipc/mekaRoles.ts` are load-bearing rather than cosmetic: if the
 * read-manifest short-circuit regressed, the role panel would fail to load instead of
 * degrading; if the update guard regressed, editing would fall through to the generic
 * builtin path. Neither was covered before this test.
 *
 * These exercise the real registered IPC handlers rather than a test-only export, so the
 * assertions still hold if the registration wiring changes.
 *
 * This lives here rather than beside the module on purpose: `src/main/localDb/**` is excluded
 * from the desktop `unit` tier (see scripts/test-workspaces.config.mjs) and the `db` tier is
 * `status: 'manual'`, so a test in `localDb/ipc/__tests__` would run in neither the mandated
 * pre-commit gate nor CI. Mocking the same modules the way `mekaProjectsImport.test.ts` does
 * keeps this in the unit tier.
 */
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    roleRow: null as Record<string, unknown> | null,
    projectRow: null as Record<string, unknown> | null,
    exec: vi.fn(async () => undefined),
    readBuiltinRoleManifestOrProjectDefault: vi.fn(),
    /**
     * 真实回落实现的引用，由下面的 module mock 在工厂里写入：`beforeEach` 用它把 mock 复位回
     * 「走真实回落」这个已知状态（`mockReset` 会连带清掉实现，光 `mockClear` 又会把上个用例的
     * `mockResolvedValue` 泄漏到下一个用例）。
     */
    realReadBuiltinRoleManifestOrProjectDefault: null as null | ((
      roleId: string,
      projectId: string,
    ) => Promise<unknown>),
    readCustomRoleManifest: vi.fn(),
    saveProjectConfig: vi.fn(async () => undefined),
    writeCustomRoleManifest: vi.fn(async () => undefined),
    builtinProjectFile: null as Record<string, unknown> | null,
    /** 让项目配置读取本身抛错：覆盖 `expandRoleManifest` 的 catch 分支。 */
    projectConfigThrows: false,
    /** 项目配置读取被调用了几次（用计数器而不是 spy，避免 hoisted 值的类型摩擦）。 */
    readProjectConfigStateCalls: 0,
    readProjectConfigState: async (
      _locator: unknown,
    ): Promise<{ file: Record<string, unknown> | null; source: string }> => {
      state.readProjectConfigStateCalls += 1;
      if (state.projectConfigThrows) throw new Error('project config unreadable');
      return { file: state.builtinProjectFile, source: 'builtin' };
    },
  };
  return state;
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    // 真实包内资源根：`listBundledSkills()` 要走真实 `resources/meka/skills/**` 扫描。
    getAppPath: () => path.resolve(__dirname, '../../../..'),
    getPath: () => 'C:\\CindyMekaTest',
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    },
  },
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    queryOne: async (sql: string) => {
      if (sql.includes('FROM meka_projects')) return h.projectRow ?? undefined;
      return sql.includes('FROM meka_roles') ? h.roleRow : undefined;
    },
    query: async () => (h.roleRow ? [h.roleRow] : []),
    exec: h.exec,
  }),
}));

vi.mock('../../meka-settings/ipc.js', () => ({
  getMekaP4SettingsService: () => ({ get: async () => ({ p4RootPath: 'C:\\Workspace\\saga2' }) }),
}));

vi.mock('../projectConfig.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projectConfig.js')>();
  // 回落入口默认走**真实**实现：随包已不再附带任何角色清单文件，真实实现因此就是「找不到文件
  // ⇒ 回落该项目默认角色」（T2）。只有需要构造边界（项目配置不可用等）的用例才在用例内覆盖它；
  // 真实实现留一份引用给 `beforeEach` 复位。
  h.realReadBuiltinRoleManifestOrProjectDefault = (roleId, projectId) =>
    actual.readBuiltinRoleManifestOrProjectDefault(roleId, projectId);
  return {
    ...actual,
    readProjectConfigState: h.readProjectConfigState,
    readBuiltinRoleManifestOrProjectDefault: h.readBuiltinRoleManifestOrProjectDefault,
    readCustomRoleManifest: h.readCustomRoleManifest,
    saveProjectConfig: h.saveProjectConfig,
    writeCustomRoleManifest: h.writeCustomRoleManifest,
  };
});

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

const SAGA2_DEFAULT_ROLE = 'saga2-default-role';

function installDefaultRoleRow(): void {
  h.roleRow = {
    id: SAGA2_DEFAULT_ROLE,
    project_id: 'saga2',
    name: SAGA2_DEFAULT_ROLE,
    display_name: '默认角色',
    description: null,
    tags: '["builtin","default"]',
    file_path: `meka/roles/${SAGA2_DEFAULT_ROLE}.json`,
    is_builtin: 1,
    content_digest: null,
    sort_order: -1,
    created_at: 1,
    updated_at: 1,
  };
}

function handler(channel: string): (...args: unknown[]) => unknown {
  const found = h.handlers.get(channel);
  if (!found) throw new Error(`handler not registered: ${channel}`);
  return found;
}

function installBuiltinRoleRow(roleId: string): void {
  h.roleRow = {
    id: roleId,
    project_id: 'saga2',
    name: roleId,
    display_name: roleId,
    description: null,
    tags: '[]',
    file_path: `meka/roles/${roleId}.json`,
    is_builtin: 1,
    content_digest: null,
    sort_order: 0,
    created_at: 1,
    updated_at: 1,
  };
}

/**
 * 一个三个开关全开的角色清单：读清单必须把项目 `roleDefaults`、全量项目元数据与整个包内
 * catalog 都展开出来（这正是「只读面板看起来什么都没选」那个缺口的反面）。
 */
function flaggedRoleManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'flagged-role',
    projectId: 'saga2',
    name: 'flagged-role',
    displayName: 'Flagged role',
    prompt: 'flagged prompt',
    rules: [],
    // 显式 `enabled: false`：展开后必须精确排除这一个 id（包内 catalog 只剩它一个，因此这条排除
    // 也正是「显式否决压过全量开关」的唯一可用对照）。
    skills: [{ skillId: 'platform-capabilities', enabled: false }],
    promptFragments: [],
    mcp: [{ id: 'meka-design', providerId: 'meka-design', enabled: true }],
    projectMetadataSelection: [],
    useProjectDefaults: true,
    includeAllProjectMetadata: true,
    includeAllBundledSkills: true,
  };
}

function projectFileWithDefaults(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectId: 'saga2',
    metadata: [
      { sourcePath: 'AGENTS.md', itemType: 'agents-md', enabled: true },
      { sourcePath: 'skills/x/SKILL.md', itemType: 'skill', enabled: true },
      { sourcePath: 'off.md', itemType: 'rule', enabled: false },
    ],
    roleDefaults: {
      promptFramework: '# Project framework',
      rules: [{ id: 'default-rule', text: 'default rule', enabled: true }],
      skills: ['platform-capabilities'],
      mcp: [{ id: 'project-agent', providerId: 'project-agent', enabled: true }],
    },
  };
}

beforeEach(async () => {
  h.handlers.clear();
  h.roleRow = null;
  h.projectRow = null;
  h.builtinProjectFile = null;
  h.projectConfigThrows = false;
  h.readProjectConfigStateCalls = 0;
  h.exec.mockClear();
  h.saveProjectConfig.mockClear();
  h.writeCustomRoleManifest.mockClear();
  // Only the call history is cleared here: the mock is reset back to the **real** fallback below (the
  // package ships no role manifest file at all, so the real function reads nothing and falls back to
  // the project default role — T2). Leaving a previous case's `mockResolvedValue` in place would
  // silently pin every later orphan-row case to that fixture.
  h.readBuiltinRoleManifestOrProjectDefault.mockReset();
  h.readBuiltinRoleManifestOrProjectDefault.mockImplementation(
    (roleId: string, projectId: string) =>
      h.realReadBuiltinRoleManifestOrProjectDefault!(roleId, projectId),
  );
  h.readCustomRoleManifest.mockReset().mockResolvedValue(null);
  const mod = await import('../../localDb/ipc/mekaRoles.js');
  mod.registerMekaRolesIpc();
});

describe('shared default role read-only contract', () => {
  it('resolves its factory-inclusive manifest in memory instead of reading a bundled file', async () => {
    installDefaultRoleRow();

    const manifest = (await handler('meka-role:read-manifest')(
      {},
      SAGA2_DEFAULT_ROLE,
    )) as Record<string, unknown> | null;

    expect(manifest).toMatchObject({
      id: SAGA2_DEFAULT_ROLE,
      projectId: 'saga2',
      displayName: '默认角色',
      // Factory-inclusive: the whole project plus the whole bundled catalog is reachable without the
      // user configuring anything. All **three** opt-in flags are on.
      useProjectDefaults: true,
      includeAllProjectMetadata: true,
      includeAllBundledSkills: true,
      policyProviderRefs: ['meka-host-risk-policy', 'meka-p4-boundary-policy'],
      // Still empty on purpose: the three opt-in flags above are the single source for every
      // project- and catalog-derived item, so these four project-derived lists must not duplicate
      // them. `mcp` is the deliberate exception — the MCP the retired general-development role
      // pinned cannot be re-derived from the project, so it stays declared explicitly.
      rules: [],
      skills: [],
      mcp: [{ id: 'meka-design', providerId: 'meka-design', enabled: true }],
      promptFragments: [],
      projectMetadataSelection: [],
    });

    const prompt = String(manifest?.prompt ?? '');
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('Establish the relevant contracts first');
    expect(prompt).toContain('safe diagnostics and recovery actions');
    // The factory prompt carries no project or business contract: the SAGA2 escalation paragraph of
    // the retired "general development" prompt is gone for good, so none of its tokens may come back.
    expect(prompt).not.toContain('EntryModel modules');
    expect(prompt).not.toContain('skill_entry_model_editor.json');
    expect(prompt).not.toContain('combat-skill-configuration');
    expect(prompt).not.toContain('Play Mode');
    // A missing bundled file must never be consulted for this role: the id short-circuit answers
    // before the fallback entry point is reached at all.
    expect(h.readBuiltinRoleManifestOrProjectDefault).not.toHaveBeenCalled();
  });

  it('rejects an update with MEKA_BUILTIN_READ_ONLY and writes nothing', async () => {
    installDefaultRoleRow();

    await expect(
      handler('meka-role:update')(
        {},
        {
          projectId: 'saga2',
          roleFile: {
            schemaVersion: 1,
            id: SAGA2_DEFAULT_ROLE,
            projectId: 'saga2',
            name: SAGA2_DEFAULT_ROLE,
            displayName: 'hijacked',
            skills: [],
            promptFragments: [],
            mcp: [],
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'MEKA_BUILTIN_READ_ONLY' });

    expect(h.saveProjectConfig).not.toHaveBeenCalled();
    expect(h.writeCustomRoleManifest).not.toHaveBeenCalled();
  });

  it('rejects deleting the default role as a built-in', async () => {
    installDefaultRoleRow();

    await expect(handler('meka-role:delete')({}, SAGA2_DEFAULT_ROLE)).rejects.toMatchObject({
      code: 'MEKA_BUILTIN_READ_ONLY',
    });
  });
});

/**
 * W10：读清单（`meka-role:read-manifest`）必须返回**展开后的有效清单**。
 *
 * 只回流存储的 manifest 会让只读面板把「出厂即全量」渲染成「什么都没选」——面板与实际运行
 * 不一致。展开走的是与运行期**同一批纯函数**（`mergeMekaProjectRoleDefaults` →
 * `resolveRoleProjectMetadataSelections` → `resolveBundledSkillSelections`），因此这里断言的
 * 四项（技能 / 规则 / MCP / 元数据选择）都与运行期同源。
 */
describe('Meka role manifest read expansion', () => {
  it('returns the explicitly stored manifest untouched for a role that opts into nothing', async () => {
    const plain = {
      schemaVersion: 1,
      id: 'plain-role',
      projectId: 'saga2',
      name: 'plain-role',
      displayName: 'Plain role',
      prompt: 'plain prompt',
      rules: [],
      skills: [{ skillId: 'platform-capabilities', enabled: true }],
      promptFragments: [],
      mcp: [],
      projectMetadataSelection: [],
    };
    installBuiltinRoleRow('plain-role');
    // 项目配置**存在且会改变结果**：不带开关的角色仍必须原样返回。清单来自项目文件里的快照，
    // 因此这里也与「包内清单已随包删除」的事实无关。
    h.projectRow = { id: 'saga2', path: 'saga2', is_builtin: 1 };
    h.builtinProjectFile = { ...projectFileWithDefaults(), builtinRoles: [plain] };

    const manifest = (await handler('meka-role:read-manifest')(
      {},
      'plain-role',
    )) as Record<string, unknown>;

    // 可证 no-op：逐字节等于存储的 manifest……
    expect(JSON.stringify(manifest)).toBe(JSON.stringify(plain));
    // ……并且项目那份**会改变结果**的配置一个字节都没生效（开关是唯一判据，不是角色 id / 名称）。
    expect(String(manifest.prompt)).toBe('plain prompt');
    expect(String(manifest.prompt)).not.toContain('# Project framework');
    expect(manifest.skills).toEqual([{ skillId: 'platform-capabilities', enabled: true }]);
    expect(manifest.projectMetadataSelection).toEqual([]);
  });

  it('expands the project defaults, every enabled metadata item and the whole bundled catalog', async () => {
    const flagged = flaggedRoleManifest();
    installBuiltinRoleRow('flagged-role');
    h.projectRow = { id: 'saga2', path: 'saga2', is_builtin: 1 };
    h.builtinProjectFile = { ...projectFileWithDefaults(), builtinRoles: [flagged] };

    const manifest = (await handler('meka-role:read-manifest')(
      {},
      'flagged-role',
    )) as Record<string, unknown>;

    // 技能：包内 catalog 全量 id 都进清单（真实扫描 `resources/meka/skills`，收敛后只剩平台 skill），
    // 显式 `enabled: false` 的那一条保持 false —— 面板据此把它渲染成未勾选，运行期据此不挂载。
    const { listBundledSkills } = await import('../runtimeConfig.js');
    const catalog = [...(await listBundledSkills()).keys()].sort();
    expect(catalog).toEqual(['platform-capabilities']);
    const entries = manifest.skills as Array<{ skillId: string; enabled: boolean }>;
    expect(entries.map((entry) => entry.skillId).sort()).toEqual(catalog);
    for (const entry of entries) {
      expect(entry.enabled).toBe(entry.skillId !== 'platform-capabilities');
    }
    // 规则：项目 `roleDefaults.rules` 展开进列表。
    expect(manifest.rules).toEqual([{ id: 'default-rule', text: 'default rule', enabled: true }]);
    // MCP：项目 defaults 的 `project-agent` 与角色自己声明的 `meka-design` 都在。
    expect((manifest.mcp as Array<{ id: string }>).map((entry) => entry.id)).toEqual([
      'project-agent',
      'meka-design',
    ]);
    // 元数据选择：全量展开只收 enabled 项，`off.md` 被排除。
    expect(manifest.projectMetadataSelection).toEqual([
      { sourcePath: 'AGENTS.md', itemType: 'agents-md', enabled: true },
      { sourcePath: 'skills/x/SKILL.md', itemType: 'skill', enabled: true },
    ]);
    // prompt 也被 defaults 的 framework 前置（与运行期同一口径）。
    expect(String(manifest.prompt)).toBe('# Project framework\n\nflagged prompt');
  });

  it('falls back to the stored manifest without throwing when the project configuration is unavailable', async () => {
    const flagged = flaggedRoleManifest();
    installBuiltinRoleRow('flagged-role');
    h.readBuiltinRoleManifestOrProjectDefault.mockResolvedValue(flagged);
    h.projectRow = { id: 'saga2', path: 'saga2', is_builtin: 1 };
    h.builtinProjectFile = null;

    const manifest = (await handler('meka-role:read-manifest')(
      {},
      'flagged-role',
    )) as Record<string, unknown>;

    expect(JSON.stringify(manifest)).toBe(JSON.stringify(flagged));
  });

  it('resolves an orphan builtin role row to the project default role instead of failing (T2)', async () => {
    // 存量库里的内置角色行指向的包内清单已随包删除（`combat-development` 是必然的那一个），而 seed
    // 从不会删除这种行。面板读清单必须与运行期 `resolveRoleFile` 一样回落到该项目的默认角色，否则
    // 角色列表里就留下「点开就报错」的僵尸行 —— 这里用**真实**回落实现（未覆盖 mock）。
    installBuiltinRoleRow('combat-development');
    h.projectRow = { id: 'saga2', path: 'saga2', is_builtin: 1 };
    h.builtinProjectFile = null;

    const manifest = (await handler('meka-role:read-manifest')(
      {},
      'combat-development',
    )) as Record<string, unknown> | null;

    expect(h.readBuiltinRoleManifestOrProjectDefault).toHaveBeenCalledWith(
      'combat-development',
      'saga2',
    );
    expect(manifest).toMatchObject({
      id: 'saga2-default-role',
      projectId: 'saga2',
      displayName: '默认角色',
      useProjectDefaults: true,
      includeAllProjectMetadata: true,
      includeAllBundledSkills: true,
    });
  });

  it('falls back to the stored manifest without throwing when expansion itself throws', async () => {
    const flagged = flaggedRoleManifest();
    // 自定义角色（`is_builtin = 0`）：`readRoleManifest` 直接把它交给 `expandRoleManifest`，
    // 因此项目配置读取抛错时命中的是展开函数的 catch 分支。
    h.roleRow = {
      id: 'custom-flagged-role',
      project_id: 'demo',
      name: 'custom-flagged-role',
      display_name: 'Custom flagged role',
      description: null,
      tags: '[]',
      file_path: 'meka-roles/custom-flagged-role.json',
      is_builtin: 0,
      content_digest: null,
      sort_order: 0,
      created_at: 1,
      updated_at: 1,
    };
    h.readCustomRoleManifest.mockResolvedValue({ ...flagged, projectId: 'demo' });
    // 项目路径必须按平台构造为**绝对**路径：生产侧 `projectFileForRole` 在
    // `!path.isAbsolute(configuredPath)` 时直接返回 null（`localDb/ipc/mekaRoles.ts:185`），
    // 硬编码 `C:\Workspace\demo` 在 POSIX 上不是绝对路径 ⇒ 读配置的调用数恒为 0、
    // 断言 `readProjectConfigStateCalls > 0` 必红（这就是本用例此前在 Linux 单测分片上
    // 报 `expected 0 to be greater than 0` 的原因）。用 `path.resolve` 保证两平台都绝对。
    h.projectRow = { id: 'demo', path: path.resolve('workspace-demo'), is_builtin: 0 };
    h.projectConfigThrows = true;

    const manifest = (await handler('meka-role:read-manifest')(
      {},
      'custom-flagged-role',
    )) as Record<string, unknown>;

    // 展开失败只降级（面板仍能打开），绝不把整个只读面板顶成错误。
    expect(h.readProjectConfigStateCalls).toBeGreaterThan(0);
    expect(JSON.stringify(manifest)).toBe(
      JSON.stringify({ ...flagged, projectId: 'demo' }),
    );
    expect(String(manifest.prompt)).toBe('flagged prompt');
  });
});
