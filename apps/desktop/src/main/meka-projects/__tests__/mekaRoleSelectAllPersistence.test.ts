/**
 * mekaRoleSelectAllPersistence.test.ts — 「展开只用于显示，落盘必须保持开关即真相」的回归锁。
 *
 * 面板读清单（`meka-role:read-manifest`）返回的是**展开态**（见 `expandRoleManifest`）：三个
 * select-all 开关（`useProjectDefaults` / `includeAllProjectMetadata` / `includeAllBundledSkills`）
 * 被展开成显式清单后交给渲染层，渲染层把同一个对象当草稿，保存时原样回传。因此两条写盘入口
 * （`createMekaRole` / `updateMekaRole`）必须在 `normalizeMekaRoleManifest` **之前**把「与派生结果
 * 完全等价」的条目剥掉，否则：
 *
 * - `projectMetadataSelection` 里那些全量展开项会被物化成作者显式选择，运行期
 *   （`resolveMekaRuntimeConfig` 的 `explicitMetadataKeys`）对它 fail-closed ⇒ 项目里任何一个无法
 *   解析的第三方 `SKILL.md` / `.mcp.json` 都会把该角色的新建会话顶成 `INVALID_PARAMS`（F1 回归）；
 *   而 `MEKA_BUILTIN_READ_ONLY` 的文案正是引导用户「copy it to a project role instead」，
 *   复制的又恰好是三个开关全 true 的默认角色 —— 这条路径是被官方文案引导的。
 * - 四个列表会带上项目 roleDefaults / 包内 catalog 的静态副本，与「开关即真相、不枚举 id」冲突。
 *
 * 覆盖：纯函数 `stripSelectAllDerivedEntries` 的剥离口径（回归锁 / 用户排除意图 / 用户新增项 /
 * 零开销 / 全量 catalog / 列表之外的字段与 prompt 上的非派生改写不动），两条写盘入口的调用点
 * （创建、自定义更新、builtinRoles 分支）与降级契约（项目配置取不到 ⇒ 原样落盘、不抛错），
 * 以及一条**真串起来**的端到端往返（`meka-role:read-manifest` 的注册 handler 返回值深拷贝后直接
 * 喂给 `meka-role:update` 的注册 handler）。
 *
 * 第二批（P1 修复）追加 `prompt` 的派生 framework 前缀：`mergeMekaProjectRoleDefaults` 在
 * `projectFile.roleDefaults.promptFramework` 非空时把它**前置进 `prompt`**（own 为空则 prompt 恰为
 * framework），展开态草稿因此带着 framework 回传；不剥就会「每次打开面板 → 保存再叠一份」。本文件
 * 新增用例锁住：写盘结果的 `prompt` 不含 framework、与作者 own 逐字相等，且把写盘结果**再走一次真实的**
 * `mergeMekaProjectRoleDefaults` 得到的 prompt 与第一次展开值**逐字相等**（= 「不叠加」的直接证据），
 * 外加 `useProjectDefaults` 门控、空白 framework 与「改写过前缀」的不处理边界。
 *
 * 深相等判据在**真实面板往返**里成立，这不是理论假设：`MekaProjectRoleEditorRoute.tsx` 的
 * `metadataToSelectable` 构造的正是 `{rootPath?, sourcePath, itemType, enabled: true}`，
 * `RoleSkillsEditor.setSelected` / `bulkToggle` 对已有条目只改 `enabled`、对缺失的 catalog id
 * 追加 `{skillId, enabled: true}` —— 与 derived 逐字同形。因此「用户没动过的派生项」必然被剥掉，
 * 而任何 `enabled: false` 之类的不等价改写必然被保留（用户精确排除意图）。
 *
 * 位置说明：本文件**刻意不放在被测模块旁边**（`localDb/ipc/__tests__/`）。桌面 `unit` tier 的
 * `exclude` 含 `src/main/localDb/**`（`scripts/test-workspaces.config.mjs`），而该目录命中的 `db`
 * tier 是 `status: 'manual'` ⇒ 放在那里提交前门禁与 CI **都不会执行**，等于没有这条 P1 回归锁。
 * 故按同目录 `mekaDefaultRole.test.ts` 的同一做法留在 unit 层：同样 mock
 * `../../localDb/client/current.js`，同样驱动**真实注册的 IPC handler**（断言不依赖测试专用导出）。
 * 直接跑本文件（在 apps/desktop 目录）：
 * `pnpm --filter desktop exec vitest run src/main/meka-projects/__tests__/mekaRoleSelectAllPersistence.test.ts`。
 */
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  MekaProjectFile,
  MekaRoleManifestFile,
  MekaRoleRule,
  MekaRoleSkillEntry,
  MekaRoleSkillSelection,
} from '../../../shared/meka-projects.js';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  projectRow: null as Record<string, unknown> | null,
  roleRow: null as Record<string, unknown> | null,
  exec: vi.fn(async (_sql: string) => undefined),
  queryOne: vi.fn(async (_sql: string, _params?: unknown[]) => undefined as unknown),
  readProjectConfigState: vi.fn(async (_locator: unknown) => ({
    file: null as unknown,
    // 两种来源都要在用例里出现：`project`（可写项目文件）与 `builtin`（包内基线）。
    source: 'project' as 'project' | 'builtin',
  })),
  listBundledSkills: vi.fn(async () => new Map<string, string>()),
  createCustomRoleManifestExclusive: vi.fn(
    async (_id: string, _manifest: unknown, _userData: string) => undefined,
  ),
  writeCustomRoleManifest: vi.fn(
    async (_id: string, _manifest: unknown, _userData: string) => undefined,
  ),
  readCustomRoleManifest: vi.fn(
    async (_id: string, _userData: string, _projectId: string) => null as unknown,
  ),
  saveProjectConfig: vi.fn(async (_locator: unknown, _file: unknown) => undefined),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => 'C:\\CindyMekaTest' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    },
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    queryOne: h.queryOne,
    query: async () => [],
    exec: h.exec,
  }),
}));

vi.mock('../../meka-settings/ipc.js', () => ({
  // 只要是绝对路径即可（builtin 分支的前置校验），因此用 '/' 保持跨平台。
  getMekaP4SettingsService: () => ({ get: async () => ({ p4RootPath: '/' }) }),
}));

vi.mock('../projectConfig.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projectConfig.js')>();
  return {
    ...actual,
    readProjectConfigState: h.readProjectConfigState,
    createCustomRoleManifestExclusive: h.createCustomRoleManifestExclusive,
    writeCustomRoleManifest: h.writeCustomRoleManifest,
    readCustomRoleManifest: h.readCustomRoleManifest,
    saveProjectConfig: h.saveProjectConfig,
  };
});

// 只替换包内 catalog 扫描；展开漏斗里的纯函数（含被剥函数本身）全部走真实实现。
vi.mock('../runtimeConfig.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtimeConfig.js')>();
  return { ...actual, listBundledSkills: h.listBundledSkills };
});

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

import {
  mergeMekaProjectRoleDefaults,
  resolveBundledSkillSelections,
  resolveRoleProjectMetadataSelections,
  stripSelectAllDerivedEntries,
} from '../runtimeConfig.js';

const PROJECT_ROOT = path.resolve(process.cwd(), 'meka-select-all-project');
const PROJECT_ID = 'saga2';

function projectFileFixture(): MekaProjectFile {
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    basic: { displayName: 'SAGA2', path: PROJECT_ROOT },
    metadata: [
      { sourcePath: 'AGENTS.md', itemType: 'agents-md', enabled: true },
      { sourcePath: 'docs/rule.md', itemType: 'rule', enabled: true },
      { sourcePath: 'skills/vendor/SKILL.md', itemType: 'skill', enabled: true },
      // 项目侧显式关闭的项永远不进全量展开。
      { sourcePath: 'off.md', itemType: 'rule', enabled: false },
    ],
    roleDefaults: {
      promptFramework: '# Project framework',
      rules: [{ id: 'default-rule', text: 'default rule', enabled: true }],
      skills: ['project-default-skill'],
      mcp: [{ id: 'project-agent', providerId: 'project-agent', enabled: true }],
      projectMetadataSelection: [{ sourcePath: 'defaults.md', itemType: 'rule' }],
    },
  };
}

/** 包内 catalog 的量级与真实扫描同阶（42-51 条），用来证明「整批」被剥掉而不是只剥几条。 */
function catalogFixture(count = 45): Map<string, string> {
  return new Map(
    Array.from({ length: count }, (_, index) => {
      const id = `bundled-skill-${String(index).padStart(2, '0')}`;
      return [id, path.join(PROJECT_ROOT, 'resources', 'meka', 'skills', id, 'SKILL.md')] as const;
    }),
  );
}

function plainManifest(overrides: Partial<MekaRoleManifestFile> = {}): MekaRoleManifestFile {
  return {
    schemaVersion: 1,
    id: 'copied-role',
    projectId: PROJECT_ID,
    name: 'copied-role',
    displayName: 'Copied role',
    prompt: 'role prompt',
    rules: [],
    skills: [],
    promptFragments: [],
    // 无法从项目派生，因此是角色自己声明的。
    mcp: [{ id: 'meka-design', providerId: 'meka-design', enabled: true }],
    projectMetadataSelection: [],
    useProjectDefaults: true,
    includeAllProjectMetadata: true,
    includeAllBundledSkills: true,
    ...overrides,
  };
}

/**
 * 面板从 `read-manifest` 拿到的展开态：刻意用**同一批纯函数**、同一顺序算出，与
 * `expandRoleManifest` 逐字同源，否则这个测试就无法代表真实回传的草稿。
 *
 * `manifest` 只为需要改 own `prompt` / 开关的用例开放；默认就是 `plainManifest()`，既有用例的口径
 * 因此逐字不变。
 */
function expandedManifest(
  projectFile: MekaProjectFile,
  catalog: ReadonlyMap<string, string>,
  manifest: MekaRoleManifestFile = plainManifest(),
): MekaRoleManifestFile {
  const merged = mergeMekaProjectRoleDefaults(manifest, projectFile.roleDefaults ?? {});
  return {
    ...merged,
    // `mergeMekaProjectRoleDefaults` 的返回类型是 `MekaRoleFile`（不含 `projectId`），而运行期
    // spread 会保留它；这里显式写回来让类型闭合，取值与运行期逐字一致。
    projectId: manifest.projectId,
    projectMetadataSelection: resolveRoleProjectMetadataSelections(merged, projectFile.metadata),
    skills: resolveBundledSkillSelections(merged, catalog),
  };
}

function roleRowFixture(id: string, isBuiltin = false): Record<string, unknown> {
  return {
    id,
    project_id: PROJECT_ID,
    name: id,
    display_name: 'Copied role',
    description: null,
    tags: '[]',
    file_path: isBuiltin ? `meka/roles/${id}.json` : `meka-roles/${id}.json`,
    is_builtin: isBuiltin ? 1 : 0,
    content_digest: null,
    sort_order: 0,
    created_at: 1,
    updated_at: 1,
  };
}

function handler(channel: string): (...args: unknown[]) => unknown {
  const found = h.handlers.get(channel);
  if (!found) throw new Error(`handler not registered: ${channel}`);
  return found;
}

/** 任何属性访问都会抛错的替身：用来证明「零开销」路径真的一个字段都没读。 */
function explodingProjectFile(): MekaProjectFile {
  return new Proxy(
    {},
    {
      get: () => {
        throw new Error('the project file must not be read');
      },
    },
  ) as unknown as MekaProjectFile;
}

function explodingCatalog(): ReadonlyMap<string, string> {
  return new Proxy(
    new Map<string, string>(),
    {
      get: () => {
        throw new Error('the bundled catalog must not be read');
      },
    },
  ) as unknown as ReadonlyMap<string, string>;
}

beforeEach(async () => {
  h.handlers.clear();
  h.projectRow = { id: PROJECT_ID, path: PROJECT_ROOT, is_builtin: 0 };
  h.roleRow = null;
  h.exec.mockClear();
  h.queryOne.mockClear();
  // `projectExists` 要真值、`projectRow` / `roleRow` 各取所需。
  h.queryOne.mockImplementation(async (sql: string) =>
    sql.includes('meka_roles') ? (h.roleRow ?? undefined) : (h.projectRow ?? undefined),
  );
  h.readProjectConfigState.mockClear();
  h.readProjectConfigState.mockResolvedValue({ file: null, source: 'project' });
  h.listBundledSkills.mockClear();
  h.listBundledSkills.mockResolvedValue(new Map<string, string>());
  h.createCustomRoleManifestExclusive.mockClear();
  h.writeCustomRoleManifest.mockClear();
  h.readCustomRoleManifest.mockClear();
  h.readCustomRoleManifest.mockResolvedValue(null);
  h.saveProjectConfig.mockClear();
  const mod = await import('../../localDb/ipc/mekaRoles.js');
  mod.registerMekaRolesIpc();
});

describe('stripSelectAllDerivedEntries', () => {
  it('drops every switch-derived entry and keeps the switches as the single source', () => {
    const projectFile = projectFileFixture();
    const catalog = catalogFixture();
    const manifest = expandedManifest(projectFile, catalog);
    // 展开态确实带满了派生项：4 条元数据选择（3 条扫描项 + defaults 的 1 条）、46 条技能。
    expect(manifest.projectMetadataSelection).toHaveLength(4);
    expect(manifest.skills).toHaveLength(46);

    const stripped = stripSelectAllDerivedEntries(manifest, projectFile, catalog);

    // 剥掉后磁盘上只剩开关 —— 运行期据此重新展开，`explicitMetadataKeys` 快照为空，
    // 全量项仍是「解析失败只 warn + 跳过」，F1 的 fail-closed 语义不会被重新引入。
    expect(stripped.projectMetadataSelection).toEqual([]);
    // 四个列表之外的字段一个都不许动，**唯一例外**是 `prompt` 上那段由 `roleDefaults.promptFramework`
    // 派生的前缀：`plainManifest()` 的 own 是 'role prompt'，展开态是
    // '# Project framework\n\nrole prompt'，剥离后必须逐字回到 own（整对象相等仍是最强断言）。
    expect(stripped).toEqual({
      ...manifest,
      prompt: 'role prompt',
      rules: [],
      skills: [],
      mcp: [{ id: 'meka-design', providerId: 'meka-design', enabled: true }],
      projectMetadataSelection: [],
    });
    expect(stripped.useProjectDefaults).toBe(true);
    expect(stripped.includeAllProjectMetadata).toBe(true);
    expect(stripped.includeAllBundledSkills).toBe(true);

    // 有效清单不变：以剥掉后的清单再走一次运行期漏斗，派生项原样回来。
    const merged = mergeMekaProjectRoleDefaults(stripped, projectFile.roleDefaults ?? {});
    expect(resolveRoleProjectMetadataSelections(merged, projectFile.metadata)).toEqual(
      manifest.projectMetadataSelection,
    );
    expect(resolveBundledSkillSelections(merged, catalog)).toEqual(manifest.skills);
    // prompt 同样如此：运行期再前置一次 framework，得到的正是第一次的展开值（不叠加）。
    expect(merged.prompt).toBe(manifest.prompt);
  });

  it('keeps an entry the author excluded (enabled:false) and drops only its equivalent siblings', () => {
    const projectFile = projectFileFixture();
    const catalog = catalogFixture();
    const manifest = expandedManifest(projectFile, catalog);
    manifest.projectMetadataSelection = (manifest.projectMetadataSelection ?? []).map((entry) =>
      entry.sourcePath === 'docs/rule.md' ? { ...entry, enabled: false } : entry,
    );
    manifest.skills = manifest.skills.map(
      (entry): MekaRoleSkillSelection | MekaRoleSkillEntry =>
        'skillId' in entry && entry.skillId === 'bundled-skill-07'
          ? { ...entry, enabled: false }
          : entry,
    );

    const stripped = stripSelectAllDerivedEntries(manifest, projectFile, catalog);

    // 改写成「不等价」的条目是用户的精确排除意图，必须留下；其余等价派生项照剥。
    expect(stripped.projectMetadataSelection).toEqual([
      { sourcePath: 'docs/rule.md', itemType: 'rule', enabled: false },
    ]);
    expect(stripped.skills).toEqual([{ skillId: 'bundled-skill-07', enabled: false }]);
  });

  it('keeps the entries the author added that the switches could never derive', () => {
    const projectFile = projectFileFixture();
    const catalog = catalogFixture();
    const manifest = expandedManifest(projectFile, catalog);
    // 该夹具刻意模拟「`normalize` 之前的草稿」：`enabled` 由 normalize 补齐，这里不能凭空加上去，
    // 否则就测不到「剥离函数不注入字段」这条契约，故按未知形状断言类型。
    manifest.rules = [
      ...(manifest.rules ?? []),
      { id: 'user-rule', text: 'user rule' } as unknown as MekaRoleRule,
    ];
    manifest.mcp = [...manifest.mcp, { id: 'user-mcp', providerId: 'user-mcp', enabled: true }];
    manifest.projectMetadataSelection = [
      ...(manifest.projectMetadataSelection ?? []),
      { sourcePath: 'user.md', itemType: 'rule', enabled: true },
    ];
    manifest.skills = [...manifest.skills, { skillId: 'user-skill', enabled: true }];

    const stripped = stripSelectAllDerivedEntries(manifest, projectFile, catalog);

    // 作者新增的条目逐字保留（剥离发生在 normalize 之前，不会给它补 `enabled`）。
    expect(stripped.rules).toEqual([{ id: 'user-rule', text: 'user rule' }]);
    expect(stripped.mcp).toEqual([
      { id: 'meka-design', providerId: 'meka-design', enabled: true },
      { id: 'user-mcp', providerId: 'user-mcp', enabled: true },
    ]);
    expect(stripped.projectMetadataSelection).toEqual([
      { sourcePath: 'user.md', itemType: 'rule', enabled: true },
    ]);
    expect(stripped.skills).toEqual([{ skillId: 'user-skill', enabled: true }]);
  });

  it('returns the manifest untouched and reads neither the project file nor the catalog when no switch is on', () => {
    const manifest = plainManifest({
      useProjectDefaults: false,
      includeAllProjectMetadata: false,
      includeAllBundledSkills: false,
      rules: [{ id: 'role-rule', text: 'role rule' } as unknown as MekaRoleRule],
      skills: [{ skillId: 'role-skill', enabled: true }],
    });

    const result = stripSelectAllDerivedEntries(
      manifest,
      explodingProjectFile(),
      explodingCatalog(),
    );

    // 原样返回同一个引用，且 projectFile / catalog 一个字段都没被读过（属性访问即抛错）。
    expect(result).toBe(manifest);
  });

  it('also short-circuits when the three switches are simply absent', () => {
    const manifest = plainManifest({
      useProjectDefaults: undefined,
      includeAllProjectMetadata: undefined,
      includeAllBundledSkills: undefined,
    });

    expect(
      stripSelectAllDerivedEntries(manifest, explodingProjectFile(), explodingCatalog()),
    ).toBe(manifest);
  });

  it('drops the whole bundled catalog expansion while keeping the role-owned mcp entry', () => {
    const projectFile = projectFileFixture();
    const catalog = catalogFixture();
    const manifest = expandedManifest(projectFile, catalog);
    const catalogDerived = manifest.skills.filter(
      (entry) => 'skillId' in entry && entry.skillId.startsWith('bundled-skill-'),
    );
    expect(catalogDerived.length).toBeGreaterThanOrEqual(42);
    expect(catalogDerived.length).toBeLessThanOrEqual(51);

    const stripped = stripSelectAllDerivedEntries(manifest, projectFile, catalog);

    expect(stripped.skills).toEqual([]);
    // `meka-design` 不在项目 defaults 里 ⇒ 无法派生 ⇒ 保留（默认角色的显式声明）。
    expect(stripped.mcp).toEqual([{ id: 'meka-design', providerId: 'meka-design', enabled: true }]);
  });
});

describe('select-all persistence at the write boundaries', () => {
  it('saves the manifest as it is when the project configuration cannot be read', async () => {
    h.roleRow = roleRowFixture('copied-role');
    h.readProjectConfigState.mockRejectedValue(new Error('project configuration unavailable'));
    const manifest = expandedManifest(projectFileFixture(), catalogFixture());

    const role = (await handler('meka-role:update')(
      {},
      { projectId: PROJECT_ID, roleFile: manifest },
    )) as { id: string };

    // 剥离失败（取项目文件抛错）必须回退为「不剥离」，而不是让保存失败。
    expect(role.id).toBe('copied-role');
    const written = h.writeCustomRoleManifest.mock.calls[0]?.[1] as MekaRoleManifestFile;
    expect(written.projectMetadataSelection).toEqual(manifest.projectMetadataSelection);
    expect(written.skills).toEqual(manifest.skills);
    expect(written.mcp).toEqual(manifest.mcp);
  });

  it('saves the manifest as it is when the project has no readable configuration file', async () => {
    h.roleRow = roleRowFixture('copied-role');
    h.readProjectConfigState.mockResolvedValue({ file: null, source: 'project' });
    const manifest = expandedManifest(projectFileFixture(), catalogFixture());

    await handler('meka-role:update')({}, { projectId: PROJECT_ID, roleFile: manifest });

    const written = h.writeCustomRoleManifest.mock.calls[0]?.[1] as MekaRoleManifestFile;
    expect(written.projectMetadataSelection).toEqual(manifest.projectMetadataSelection);
    expect(written.skills).toEqual(manifest.skills);
  });

  it('strips the expanded lists on create, the documented copy-to-project-role path', async () => {
    h.roleRow = roleRowFixture('copied-role');
    h.readProjectConfigState.mockResolvedValue({ file: projectFileFixture(), source: 'project' });
    h.listBundledSkills.mockResolvedValue(catalogFixture());
    const manifest = expandedManifest(projectFileFixture(), catalogFixture());

    await handler('meka-role:create')({}, { projectId: PROJECT_ID, roleFile: manifest });

    const written = h.createCustomRoleManifestExclusive.mock.calls[0]?.[1] as MekaRoleManifestFile;
    expect(written.projectMetadataSelection).toEqual([]);
    expect(written.skills).toEqual([]);
    expect(written.rules).toEqual([]);
    expect(written.mcp).toEqual([{ id: 'meka-design', providerId: 'meka-design', enabled: true }]);
    expect(written.includeAllProjectMetadata).toBe(true);
    expect(written.includeAllBundledSkills).toBe(true);
  });

  it('writes the stripped manifest into the builtinRoles branch of the project file', async () => {
    const manifest: MekaRoleManifestFile = {
      ...expandedManifest(projectFileFixture(), catalogFixture()),
      id: 'flagged-role',
      name: 'flagged-role',
    };
    h.roleRow = roleRowFixture('flagged-role', true);
    h.projectRow = { id: PROJECT_ID, path: PROJECT_ROOT, is_builtin: 1 };
    h.readProjectConfigState.mockResolvedValue({
      file: { ...projectFileFixture(), builtinRoles: [manifest] },
      source: 'builtin',
    });
    h.listBundledSkills.mockResolvedValue(catalogFixture());

    await handler('meka-role:update')({}, { projectId: PROJECT_ID, roleFile: manifest });

    const saved = h.saveProjectConfig.mock.calls[0]?.[1] as MekaProjectFile;
    const savedRole = saved.builtinRoles?.[0];
    expect(savedRole?.id).toBe('flagged-role');
    expect(savedRole?.projectMetadataSelection).toEqual([]);
    expect(savedRole?.skills).toEqual([]);
    expect(savedRole?.rules).toEqual([]);
    expect(savedRole?.mcp).toEqual([
      { id: 'meka-design', providerId: 'meka-design', enabled: true },
    ]);
    expect(savedRole?.includeAllProjectMetadata).toBe(true);
  });

  it('reads no project configuration and scans no catalog for a role without any switch', async () => {
    h.roleRow = roleRowFixture('plain-role');
    const plain = {
      ...plainManifest({ id: 'plain-role', name: 'plain-role', displayName: 'Plain role' }),
      useProjectDefaults: false,
      includeAllProjectMetadata: false,
      includeAllBundledSkills: false,
    };

    await handler('meka-role:update')({}, { projectId: PROJECT_ID, roleFile: plain });

    // 开关都不为 true 的保存路径保持既有零开销：不读项目配置、不扫包内 catalog。
    expect(h.readProjectConfigState).not.toHaveBeenCalled();
    expect(h.listBundledSkills).not.toHaveBeenCalled();
    const written = h.writeCustomRoleManifest.mock.calls[0]?.[1] as MekaRoleManifestFile;
    expect(written.skills).toEqual(plain.skills);
  });

  it('scans the bundled catalog only when includeAllBundledSkills is on', async () => {
    h.roleRow = roleRowFixture('defaults-only-role');
    h.readProjectConfigState.mockResolvedValue({ file: projectFileFixture(), source: 'project' });
    const manifest = expandedManifest(projectFileFixture(), catalogFixture());
    const defaultsOnly: MekaRoleManifestFile = {
      ...manifest,
      id: 'defaults-only-role',
      name: 'defaults-only-role',
      includeAllBundledSkills: false,
      // 面板在开关关掉时不会带回包内 catalog 条目；这里只留项目派生项。
      skills: manifest.skills.filter(
        (entry) => !('skillId' in entry) || !entry.skillId.startsWith('bundled-skill-'),
      ),
    };

    await handler('meka-role:update')({}, { projectId: PROJECT_ID, roleFile: defaultsOnly });

    expect(h.readProjectConfigState).toHaveBeenCalled();
    expect(h.listBundledSkills).not.toHaveBeenCalled();
    // 项目 roleDefaults 派生的项仍被剥掉，角色自己的 mcp 仍在。
    const written = h.writeCustomRoleManifest.mock.calls[0]?.[1] as MekaRoleManifestFile;
    expect(written.projectMetadataSelection).toEqual([]);
    expect(written.skills).toEqual([]);
    expect(written.mcp).toEqual([{ id: 'meka-design', providerId: 'meka-design', enabled: true }]);
  });

  /**
   * 端到端往返（复审点名缺失的关键用例）：**真的**调 `meka-role:read-manifest` 的注册 handler 拿
   * 展开态，把返回对象**深拷贝后直接喂给** `meka-role:update` 的注册 handler，而不是自己用纯函数
   * 拼一份草稿。
   *
   * 它替代的是「渲染层一行未改，所以原样回传是安全的」这句口头论证：本用例不依赖对渲染层实现
   * （`MekaProjectRoleEditorRoute` / `RoleSkillsEditor`）的任何假设，只要求「面板原样回传」这一条，
   * 因此渲染层将来被改写也不会让这条回归锁失效。
   */
  it('round-trips the real read-manifest expansion through update without materializing it', async () => {
    const projectFile = projectFileFixture();
    const catalog = catalogFixture();
    const framework = projectFile.roleDefaults?.promptFramework ?? '';
    const own = plainManifest().prompt!;
    h.roleRow = roleRowFixture('copied-role');
    h.readCustomRoleManifest.mockResolvedValue(plainManifest());
    h.readProjectConfigState.mockResolvedValue({ file: projectFile, source: 'project' });
    h.listBundledSkills.mockResolvedValue(catalog);

    const draft = (await handler('meka-role:read-manifest')(
      {},
      'copied-role',
    )) as MekaRoleManifestFile;

    // 前提：面板拿到的确实是**展开态**，否则下面的往返断言没有意义。
    expect(draft.projectMetadataSelection).toHaveLength(4);
    expect(draft.skills).toHaveLength(46);
    expect(draft.prompt).toBe(`${framework}\n\n${own}`);

    await handler('meka-role:update')({}, {
      projectId: PROJECT_ID,
      roleFile: structuredClone(draft),
    });

    const written = h.writeCustomRoleManifest.mock.calls[0]?.[1] as MekaRoleManifestFile;
    // 写盘结果：四个列表为空、三个开关原样保留、prompt 不含项目 `promptFramework` 前缀。
    expect(written.projectMetadataSelection).toEqual([]);
    expect(written.skills).toEqual([]);
    expect(written.rules).toEqual([]);
    expect(written.mcp).toEqual([{ id: 'meka-design', providerId: 'meka-design', enabled: true }]);
    expect(written.useProjectDefaults).toBe(true);
    expect(written.includeAllProjectMetadata).toBe(true);
    expect(written.includeAllBundledSkills).toBe(true);
    expect(written.prompt).not.toContain(framework);
    expect(written.prompt).toBe(own.trim());

    // 「不叠加」的直接证据：把**真正写盘的结果**再走一次运行期漏斗，prompt 与第一次展开值逐字相等。
    const reExpanded = mergeMekaProjectRoleDefaults(written, projectFile.roleDefaults ?? {});
    expect(reExpanded.prompt).toBe(draft.prompt);
    expect(resolveRoleProjectMetadataSelections(reExpanded, projectFile.metadata)).toEqual(
      draft.projectMetadataSelection,
    );
    expect(resolveBundledSkillSelections(reExpanded, catalog)).toEqual(draft.skills);
  });
});

/**
 * `prompt` 上的派生 framework 前缀（第二批 P1 修复；上一版 12 条用例没有一条断言写盘后的 `prompt`，
 * 因此锁不住这条回路）。
 *
 * 展开态的 `prompt` 是 `mergeMekaProjectRoleDefaults` 的产物：own 为空时恰为 `framework`，否则为
 * `framework\n\n own`。落盘若不剥，磁盘 prompt 就成了 `framework\n\n own`，运行期再前置一次即
 * `framework\n\nframework\n\n own` —— **每次「打开面板 → 保存」再叠一份**（出厂 saga2 的
 * `promptFramework` 约 3.5 KB，而 Pi win32 的 argv 预算只有 30,000 字符）。
 *
 * 断言口径：展开态与「再合并一次」的期望值**一律由真实的 `mergeMekaProjectRoleDefaults` 算出**，
 * 这正是等价性的定义；不手抄展开值，也不用与被测实现同构的第二套推导。
 */
describe('derived prompt framework is stripped before it can stack up', () => {
  const FRAMEWORK = '# Project framework';

  /** 只换 project framework，其余项目配置与 `projectFileFixture()` 逐字一致。 */
  function projectFileWithFramework(promptFramework: string | undefined): MekaProjectFile {
    const base = projectFileFixture();
    return { ...base, roleDefaults: { ...base.roleDefaults, promptFramework } };
  }

  it('writes the author own prompt and re-expands to the same effective prompt (no stacking)', async () => {
    const projectFile = projectFileFixture();
    const catalog = catalogFixture();
    // 夹具前提：下面的期望值都建立在这个 framework 上。
    expect(projectFile.roleDefaults?.promptFramework).toBe(FRAMEWORK);
    const own = plainManifest().prompt!;
    const draft = expandedManifest(projectFile, catalog);
    // 前提：展开态确实带着派生的 framework 前缀，否则这条回归锁没有意义。
    expect(draft.prompt).toBe(`${FRAMEWORK}\n\n${own}`);

    h.roleRow = roleRowFixture('copied-role');
    h.readProjectConfigState.mockResolvedValue({ file: projectFile, source: 'project' });
    h.listBundledSkills.mockResolvedValue(catalog);

    await handler('meka-role:update')({}, { projectId: PROJECT_ID, roleFile: draft });

    const written = h.writeCustomRoleManifest.mock.calls[0]?.[1] as MekaRoleManifestFile;
    expect(written.prompt).not.toContain(FRAMEWORK);
    // `mergeMekaProjectRoleDefaults` 对 own 取 `.trim()`，期望值按同一口径。
    expect(written.prompt).toBe(own.trim());
    // 「不叠加」的直接证据：把写盘结果再走一次运行期漏斗，prompt 与第一次展开**逐字相等**；
    // 若写盘多留了一份 framework，这里会变成 `framework\n\nframework\n\n own`。
    const reExpanded = mergeMekaProjectRoleDefaults(written, projectFile.roleDefaults ?? {}).prompt;
    expect(reExpanded).toBe(draft.prompt);
    // framework 在有效 prompt 里只出现一次（叠一份就会出现两次）。
    expect(reExpanded?.split(FRAMEWORK)).toHaveLength(2);
  });

  it('writes an empty prompt when the draft prompt is exactly the framework (author own empty)', async () => {
    const projectFile = projectFileFixture();
    const catalog = catalogFixture();
    // own 为空 ⇒ 合并走 `${framework}` 分支 ⇒ 展开态恰为 framework。
    const draft = expandedManifest(projectFile, catalog, plainManifest({ prompt: undefined }));
    expect(draft.prompt).toBe(FRAMEWORK);
    // 纯函数层：写回空串，而不是删字段或写 undefined。
    expect(stripSelectAllDerivedEntries(draft, projectFile, catalog).prompt).toBe('');

    h.roleRow = roleRowFixture('copied-role');
    h.readProjectConfigState.mockResolvedValue({ file: projectFile, source: 'project' });
    h.listBundledSkills.mockResolvedValue(catalog);

    await handler('meka-role:update')({}, { projectId: PROJECT_ID, roleFile: draft });

    const written = h.writeCustomRoleManifest.mock.calls[0]?.[1] as MekaRoleManifestFile;
    // `normalizeMekaRoleManifest` 随后把空串规范成「无 prompt」（字段被省略）⇒ 读同一口径。
    expect(written.prompt ?? '').toBe('');
    expect(mergeMekaProjectRoleDefaults(written, projectFile.roleDefaults ?? {}).prompt).toBe(FRAMEWORK);
  });

  it('keeps a prompt the author rewrote verbatim', async () => {
    const projectFile = projectFileFixture();
    const catalog = catalogFixture();
    // 面板把 `prompt` 直接绑到文本域，用户可以在里面改写/删掉那段前缀 —— 这不是合并产物，不许动。
    const rewritten = 'Rewritten by the author';
    const draft: MekaRoleManifestFile = {
      ...expandedManifest(projectFile, catalog),
      prompt: rewritten,
    };
    expect((draft.prompt ?? '').startsWith(FRAMEWORK)).toBe(false);

    h.roleRow = roleRowFixture('copied-role');
    h.readProjectConfigState.mockResolvedValue({ file: projectFile, source: 'project' });
    h.listBundledSkills.mockResolvedValue(catalog);

    await handler('meka-role:update')({}, { projectId: PROJECT_ID, roleFile: draft });

    const written = h.writeCustomRoleManifest.mock.calls[0]?.[1] as MekaRoleManifestFile;
    expect(written.prompt).toBe(rewritten);
  });

  it('only strips the exact framework + blank line prefix, never a looser match', async () => {
    const projectFile = projectFileFixture();
    const catalog = catalogFixture();
    // 只有 `framework\n\n` 才是合并产物；单换行的前缀是作者的改写，不许被当作派生前缀剥掉。
    const singleNewline = `${FRAMEWORK}\nrole prompt`;
    const draft: MekaRoleManifestFile = {
      ...expandedManifest(projectFile, catalog),
      prompt: singleNewline,
    };

    h.roleRow = roleRowFixture('copied-role');
    h.readProjectConfigState.mockResolvedValue({ file: projectFile, source: 'project' });
    h.listBundledSkills.mockResolvedValue(catalog);

    await handler('meka-role:update')({}, { projectId: PROJECT_ID, roleFile: draft });

    const written = h.writeCustomRoleManifest.mock.calls[0]?.[1] as MekaRoleManifestFile;
    expect(written.prompt).toBe(singleNewline);
  });

  it('leaves the prompt untouched when useProjectDefaults is not true', async () => {
    const projectFile = projectFileFixture();
    const catalog = catalogFixture();
    // 只有 useProjectDefaults === true 才会被 `mergeMekaProjectRoleDefaults` 前置 framework
    // （其它角色走早退），因此 prompt 的处理必须被同一个门控住 —— 即使草稿恰好带那段前缀。
    const draft: MekaRoleManifestFile = {
      ...expandedManifest(projectFile, catalog, plainManifest({ useProjectDefaults: false })),
      prompt: `${FRAMEWORK}\n\nrole prompt`,
    };
    expect(draft.includeAllBundledSkills).toBe(true);

    h.roleRow = roleRowFixture('copied-role');
    h.readProjectConfigState.mockResolvedValue({ file: projectFile, source: 'project' });
    h.listBundledSkills.mockResolvedValue(catalog);

    await handler('meka-role:update')({}, { projectId: PROJECT_ID, roleFile: draft });

    const written = h.writeCustomRoleManifest.mock.calls[0]?.[1] as MekaRoleManifestFile;
    expect(written.prompt).toBe(draft.prompt);
    // 同时证明这次**确实**走了剥离（不是零开销早退）：catalog 派生的技能被剥光。
    expect(written.skills).toEqual([]);
  });

  it('leaves the prompt untouched when the project framework is absent, empty or blank', async () => {
    const catalog = catalogFixture();
    for (const promptFramework of [undefined, '', '   ']) {
      const projectFile = projectFileWithFramework(promptFramework);
      // framework 取不到 ⇒ 没有任何可派生的前缀，草稿里的同形前缀只能是作者自己写的。
      const draft: MekaRoleManifestFile = {
        ...expandedManifest(projectFile, catalog),
        prompt: `${FRAMEWORK}\n\nrole prompt`,
      };
      h.writeCustomRoleManifest.mockClear();
      h.roleRow = roleRowFixture('copied-role');
      h.readProjectConfigState.mockResolvedValue({ file: projectFile, source: 'project' });
      h.listBundledSkills.mockResolvedValue(catalog);

      await handler('meka-role:update')({}, { projectId: PROJECT_ID, roleFile: draft });

      const written = h.writeCustomRoleManifest.mock.calls[0]?.[1] as MekaRoleManifestFile;
      expect(written.prompt).toBe(draft.prompt);
      // 剥离确实跑了（catalog 派生技能被剥光），只是 prompt 不处理。
      expect(written.skills).toEqual([]);
    }
  });

  it('strips the derived framework prefix on create, the copy-to-project-role entry', async () => {
    const projectFile = projectFileFixture();
    const catalog = catalogFixture();
    const own = plainManifest().prompt!;
    const draft = expandedManifest(projectFile, catalog);
    expect(draft.prompt).toBe(`${FRAMEWORK}\n\n${own}`);

    h.roleRow = roleRowFixture('copied-role');
    h.readProjectConfigState.mockResolvedValue({ file: projectFile, source: 'project' });
    h.listBundledSkills.mockResolvedValue(catalog);

    await handler('meka-role:create')({}, { projectId: PROJECT_ID, roleFile: draft });

    // 两条写盘入口都要有覆盖：create 是 `MEKA_BUILTIN_READ_ONLY` 文本引导的那条路径。
    const written = h.createCustomRoleManifestExclusive.mock.calls[0]?.[1] as MekaRoleManifestFile;
    expect(written.prompt).not.toContain(FRAMEWORK);
    expect(written.prompt).toBe(own.trim());
    expect(mergeMekaProjectRoleDefaults(written, projectFile.roleDefaults ?? {}).prompt).toBe(
      draft.prompt,
    );
  });
});

/**
 * P1-A 的 main 侧：`read-manifest` 必须告诉面板**哪些行是开关派生的**。面板对派生行不画删除按钮——
 * 删除只改草稿，运行期会把项目 `roleDefaults` / 包内 catalog 的派生行重新铺回来，于是「删除成功、
 * 保存成功、行立刻回来」；唯一有效的排除是勾选框的 `enabled: false`。
 *
 * 计算口径与本文件其余用例同源：派生 key = 出现在展开态、却**不在** `stripSelectAllDerivedEntries`
 * 结果里的 key；四个列表各按剥离函数自己的 key（`rule.id` / `entry.id` /
 * `isLegacySkill ? id : skillId` / `rootPath\0sourcePath\0itemType`）。
 *
 * 后半段锁住「该字段绝不落盘」：把**带该字段的读清单结果**原样提交给两条写盘入口，落盘清单里都不许
 * 出现它（`normalizeMekaRoleManifest` 是白名单式重建）。
 */
describe('derived entry keys are reported for the panel and never persisted', () => {
  /** 与 `stripped` 侧同一口径的 metadata key（`rootPath` 缺省 ⇒ 空串前缀）。 */
  const metadataKey = (sourcePath: string, itemType: string) =>
    `\u0000${sourcePath}\u0000${itemType}`;

  /** 读清单结果：`MekaRoleManifestFile` 加上**展示用、非持久化**的派生 key。 */
  type ReadManifestResult = MekaRoleManifestFile & {
    derivedEntryKeys?: {
      rules: string[];
      skills: string[];
      mcp: string[];
      metadata: string[];
    };
  };

  it('reports every switch-derived key of the four lists and drops the field on the way to disk', async () => {
    const projectFile = projectFileFixture();
    const catalog = catalogFixture();
    // 四个列表各带一条「开关派生不出来」的自有项：它们必须**不出现在**派生集合里。
    const manifest = plainManifest({
      rules: [{ id: 'role-rule', text: 'role rule', enabled: true }],
      skills: [{ skillId: 'role-skill', enabled: true }],
      projectMetadataSelection: [{ sourcePath: 'role.md', itemType: 'rule', enabled: true }],
    });
    h.roleRow = roleRowFixture('copied-role');
    h.readCustomRoleManifest.mockResolvedValue(manifest);
    h.readProjectConfigState.mockResolvedValue({ file: projectFile, source: 'project' });
    h.listBundledSkills.mockResolvedValue(catalog);

    const draft = (await handler('meka-role:read-manifest')(
      {},
      'copied-role',
    )) as ReadManifestResult;

    expect(draft.derivedEntryKeys).toEqual({
      // 项目 `roleDefaults.rules` 的 id；角色自己的 `role-rule` 不在其中。
      rules: ['default-rule'],
      // 整批包内 catalog（45 条）+ `roleDefaults.skills` 的那一条；`role-skill` 不在其中。
      skills: [...catalog.keys(), 'project-default-skill'],
      // `roleDefaults.mcp` 的 id；角色显式声明的 `meka-design` 不在其中。
      mcp: ['project-agent'],
      // 3 条 enabled 的项目元数据 + `roleDefaults.projectMetadataSelection` 的 1 条；
      // 项目侧 `enabled: false` 的 `off.md` 与角色自己的 `role.md` 都不在其中。
      metadata: [
        metadataKey('AGENTS.md', 'agents-md'),
        metadataKey('docs/rule.md', 'rule'),
        metadataKey('skills/vendor/SKILL.md', 'skill'),
        metadataKey('defaults.md', 'rule'),
      ],
    });

    // 写盘入口 1：更新。展示字段必须被白名单重建丢掉。
    await handler('meka-role:update')({}, {
      projectId: PROJECT_ID,
      roleFile: structuredClone(draft),
    });
    const written = h.writeCustomRoleManifest.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(written).not.toHaveProperty('derivedEntryKeys');
    // 同一次写盘里，派生条目本身仍按既有契约被剥掉（作者自有项保留）。
    expect(written.skills).toEqual([{ skillId: 'role-skill', enabled: true }]);

    // 写盘入口 2：创建（`MEKA_BUILTIN_READ_ONLY` 文案引导的复制路径）。
    await handler('meka-role:create')({}, {
      projectId: PROJECT_ID,
      roleFile: structuredClone(draft),
    });
    const created = h.createCustomRoleManifestExclusive.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(created).not.toHaveProperty('derivedEntryKeys');
  });

  it('omits the field for a role whose switches derive nothing and reads no project configuration', async () => {
    const stored = plainManifest({
      id: 'plain-role',
      name: 'plain-role',
      useProjectDefaults: false,
      includeAllProjectMetadata: false,
      includeAllBundledSkills: false,
      rules: [{ id: 'role-rule', text: 'role rule', enabled: true }],
    });
    h.roleRow = roleRowFixture('plain-role');
    h.readCustomRoleManifest.mockResolvedValue(stored);
    // 开关全关 ⇒ 不展开、也没有派生信息：既有清单形状逐字不变，零开销路径保持零开销。
    h.readProjectConfigState.mockResolvedValue({ file: projectFileFixture(), source: 'project' });
    h.listBundledSkills.mockResolvedValue(catalogFixture());

    const draft = (await handler('meka-role:read-manifest')(
      {},
      'plain-role',
    )) as MekaRoleManifestFile;

    expect(draft).toEqual(stored);
    expect(Object.keys(draft)).not.toContain('derivedEntryKeys');
    expect(h.readProjectConfigState).not.toHaveBeenCalled();
    expect(h.listBundledSkills).not.toHaveBeenCalled();
  });

  it('omits the field when the project configuration cannot be resolved', async () => {
    const stored = plainManifest();
    h.roleRow = roleRowFixture('copied-role');
    h.readCustomRoleManifest.mockResolvedValue(stored);
    // 三层回退之一：取不到项目文件 ⇒ 退回存储态，此时没有任何可断言的派生信息。
    h.readProjectConfigState.mockResolvedValue({ file: null, source: 'project' });

    const draft = (await handler('meka-role:read-manifest')(
      {},
      'copied-role',
    )) as MekaRoleManifestFile;

    expect(draft).toEqual(stored);
    expect(Object.keys(draft)).not.toContain('derivedEntryKeys');
  });
});
