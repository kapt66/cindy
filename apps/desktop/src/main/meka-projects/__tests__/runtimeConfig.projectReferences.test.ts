/**
 * `projectReferences`「地址 + 描述」投递形态的**生产侧**契约，**落在 unit 层**。
 *
 * 为什么本文件与 `runtimeConfigProjectFiles.test.ts` 分开：后者原名
 * `runtimeConfig.integration.test.ts`，而 `scripts/test-workspaces.config.mjs` 把 desktop `unit`
 * 层的 exclude 写成 `**\/*.integration.test.ts`（`test-workspaces.mjs` 会把它透传成 vitest 的
 * `--exclude`），desktop **没有** integration tier（`tiers` 只有 unit / git-integration / e2e /
 * db / migration / db-perf / guard），`--all` 也只是纳入 manual tier ⇒ 该后缀在本仓
 * `test:unit`、`test:unit:related`、`test:db`、`test:all` 与 CI 里**都不会被执行**。那批断言因此
 * 搬到本文件（unit 层）；原文件已于 2026-09-23 改名为 `runtimeConfigProjectFiles.test.ts` 一并纳入
 * unit 层，本文件不再依赖它的存在。
 *
 * 所以本文件用**真实** `resolveMekaRuntimeConfig` + 临时目录夹具，承接那批断言并追加本批修复的
 * 能力：多条目精确形状、`scope` 归一化、描述四级回落与 300 码点截断、ENOENT 跳过、disabled
 * 排除、确定性排序、`rootPath` 作用范围、容错边界（坏 `SKILL.md` / 坏 `.mcp.json` 只 warn 跳过，
 * 而作者显式选择仍然 fail-closed）、`includeAllBundledSkills` 展开、
 * 「root 白名单失配按来源分流」（全量展开项 warn + 跳过，作者显式选择仍抛错）、「`..` 逃逸对
 * 任何来源都抛错」，以及「规范正文与描述都不得进 promptText」的负向断言。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

/** `apps/desktop`：包内资源（`resources/meka/**`）就在它下面，与调用方 cwd 无关。 */
const desktopRoot = path.resolve(__dirname, '../../../..');

const environment = vi.hoisted(() => ({
  p4RootPath: null as string | null,
  userData: '',
  projects: {} as Record<string, { id: string; path: string; is_builtin: number }>,
  roles: {} as Record<
    string,
    { id: string; project_id: string; is_builtin: number; file_path: string }
  >,
}));

/**
 * 单条用例可覆盖「项目文件」本身。只有**归一化层已不可达**的输入（例如非规范 `subProjectPath`
 * 与 `..` 逃逸的 `sourcePath`）才走它；所有主断言都读真实 `.meka/project.json`。
 */
const projectConfigOverride = vi.hoisted(() => ({ file: null as unknown }));

/** 运行期 warn 的取证窗口：F1 的降级路径必须留下可观察的 warn，而不只是「没抛错」。 */
const logging = vi.hoisted(() => ({ warnings: [] as Array<{ message: string; meta?: unknown }> }));

/**
 * 包内资源根（`bundledMekaRolesRoot()` / `bundledMekaSkillsRoot()`）的取样点，默认仍是**真实**
 * 资源目录，形态与 `projectConfig.test.ts` 的 `useBundledRoleCatalog` 一致。
 *
 * 两处接缝各有一个不可替代的用途（T1 / T4 的回归用例专属）：
 * - `seamRolesRoot`：fragment 根对内置角色就是 `bundledMekaRolesRoot()`，而真实
 *   `resources/meka/roles/` 整个目录都已随包删除 ⇒ 只有把根指向临时目录，才能造出「一部分
 *   fragment 已删（ENOENT）、另一部分仍在」这件 T4 唯一要区分的事实。
 * - `seamSkillsRoot`：T1 的平台例外要求「catalog **查不到** `platform-capabilities`」，而真实
 *   catalog 里它必然存在（C1 就是它必须随包）⇒ 只有把扫描根指向空目录才能驱动那条硬失败。
 *
 * 两个默认值都是 `null` ⇒ 回落到真实资源根，既有用例的行为逐字不变。
 */
const resource = vi.hoisted(() => ({
  seamRolesRoot: null as string | null,
  seamSkillsRoot: null as string | null,
}));

vi.mock('../resourcePaths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../resourcePaths.js')>();
  return {
    ...actual,
    bundledMekaRolesRoot: () => resource.seamRolesRoot ?? actual.bundledMekaRolesRoot(),
    bundledMekaSkillsRoot: () => resource.seamSkillsRoot ?? actual.bundledMekaSkillsRoot(),
  };
});

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((message: string, meta?: unknown) => {
      logging.warnings.push({ message, meta });
    }),
    error: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => desktopRoot,
    getPath: (name: string) => (name === 'userData' ? environment.userData : desktopRoot),
  },
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    queryOne: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM meka_projects')) return environment.projects[String(params[0])];
      if (sql.includes('FROM meka_roles')) return environment.roles[String(params[0])];
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

vi.mock('../projectConfig.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projectConfig.js')>();
  return {
    ...actual,
    readEffectiveProjectConfig: async (
      locator: Parameters<typeof actual.readEffectiveProjectConfig>[0],
    ) =>
      projectConfigOverride.file ?? (await actual.readEffectiveProjectConfig(locator)),
  };
});

import type {
  MekaProjectFile,
  MekaProjectMetadataConfigItem,
  MekaProjectMetadataItemType,
} from '../../../shared/meka-projects.js';
import {
  listBundledSkills,
  resolveMekaPlatformRuntimeSkills,
  resolveMekaRuntimeConfig,
} from '../runtimeConfig.js';

const temporaryRoots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  environment.p4RootPath = null;
  environment.userData = '';
  environment.projects = {};
  environment.roles = {};
  projectConfigOverride.file = null;
  logging.warnings.length = 0;
  resource.seamRolesRoot = null;
  resource.seamSkillsRoot = null;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function projectFile(root: string, overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

async function writeProject(root: string, file: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(root, '.meka'), { recursive: true });
  await writeFile(
    path.join(root, '.meka', 'project.json'),
    `${JSON.stringify(file, null, 2)}\n`,
    'utf8',
  );
}

async function writeText(root: string, relativePath: string, content: string): Promise<string> {
  const absolute = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
  return absolute;
}

/** 注册内置 SAGA2 项目：`path: 'saga2'` ⇒ 项目根由 P4 设置给出（工作目录实际根）。 */
function useSaga2(): void {
  environment.projects = { saga2: { id: 'saga2', path: 'saga2', is_builtin: 1 } };
  environment.roles = {
    'saga2-default-role': {
      id: 'saga2-default-role',
      project_id: 'saga2',
      is_builtin: 1,
      file_path: 'meka/roles/saga2-default-role.json',
    },
  };
}

/** 无包内清单的自定义项目：项目文件走 `.meka/project.json`，且**没有** bundled 兜底。 */
function useCustomProject(root: string, projectId = 'demo'): void {
  environment.projects = { [projectId]: { id: projectId, path: root, is_builtin: 0 } };
  environment.roles = {
    [`${projectId}-role`]: {
      id: `${projectId}-role`,
      project_id: projectId,
      is_builtin: 0,
      file_path: `meka-roles/${projectId}-role.json`,
    },
  };
}

/** 写一个**自定义角色**清单（`is_builtin = 0` ⇒ 只读 `<userData>/meka-roles/<id>.json`）。 */
async function useCustomRole(
  root: string,
  role: Record<string, unknown> & { id: string },
): Promise<void> {
  environment.userData = path.join(root, 'user-data');
  await mkdir(path.join(environment.userData, 'meka-roles'), { recursive: true });
  await writeFile(
    path.join(environment.userData, 'meka-roles', `${role.id}.json`),
    `${JSON.stringify({ schemaVersion: 1, projectId: 'saga2', ...role }, null, 2)}\n`,
    'utf8',
  );
  environment.roles[role.id] = {
    id: role.id,
    project_id: 'saga2',
    is_builtin: 0,
    file_path: `meka-roles/${role.id}.json`,
  };
}

async function catalogIds(): Promise<string[]> {
  return [...(await listBundledSkills()).keys()].sort();
}

function metadataEntry(
  overrides: Partial<MekaProjectMetadataConfigItem> & { sourcePath: string },
): MekaProjectMetadataConfigItem {
  return {
    itemType: 'agents-md',
    enabled: true,
    contentFingerprint: 'sha256:fixture',
    ...overrides,
  };
}

describe('Meka runtime project references (progressive disclosure)', () => {
  it('delivers every enabled project document as an address plus a bounded description', async () => {
    const root = await makeRoot('cindy-meka-refs-');
    useSaga2();
    environment.p4RootPath = root;

    // 正文标志串只用于负向断言：参考文件的正文绝不能进 promptText。
    await writeText(
      root,
      'saga2_design/AGENTS.md',
      '# AI 初次接入治理规则\n\n策划知识库写入前必须先确认授权范围，不得凭记忆改写规范正文。\n',
    );
    await writeText(root, 'saga2_design/planning/AGENTS.md', '# 规划入口\n\n规划目录规范正文。\n');
    await writeText(root, 'docs/.cursorrules', '只在 docs 目录生效。\n');
    await writeText(root, 'tools/AGENTS.md', '工具目录规则。\n');

    await writeProject(
      root,
      projectFile(root, {
        metadata: [
          // 1. `description` 优先，`subProjectPath` 决定作用范围。
          metadataEntry({
            sourcePath: 'saga2_design/AGENTS.md',
            name: 'AGENTS.md',
            displayName: '策划库Agent入口',
            description: '策划知识库 Agent 入口。',
            subProjectPath: 'saga2_design',
          }),
          // 2. 没有 `description` 时退到 `displayName`；同一作用范围内按路径排序。
          metadataEntry({
            sourcePath: 'saga2_design/planning/AGENTS.md',
            name: 'AGENTS.md',
            displayName: '策划库规划入口',
            subProjectPath: 'saga2_design',
          }),
          // 3. 再退到 `name`。
          metadataEntry({
            sourcePath: 'docs/.cursorrules',
            itemType: 'rule',
            name: 'docs-rules',
          }),
          // 4. 都没有时用 `sourcePath`；作用范围回落到文档所在目录。
          metadataEntry({ sourcePath: 'tools/AGENTS.md' }),
          // 5. 项目侧 `enabled: false` 优先于 `includeAllProjectMetadata`。
          metadataEntry({
            sourcePath: 'saga2_design/CLAUDE.md',
            name: 'CLAUDE.md',
            enabled: false,
          }),
          // 6. 选中的文件不存在：必须整条跳过，不产出悬空引用。
          metadataEntry({ sourcePath: 'saga2_unity/AGENTS.md', name: 'AGENTS.md' }),
        ],
        roleDefaults: {
          promptFramework: '# Project framework',
          rules: [{ id: 'project-rule', text: '# Project default rule', enabled: true }],
          skills: ['platform-capabilities'],
          mcp: [{ id: 'project-agent', providerId: 'project-agent', enabled: true }],
        },
      }),
    );

    const resolved = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');

    // 精确形状：scope 来自 `subProjectPath`（缺失时回落文档目录），描述走四级链。
    expect(resolved.projectReferences).toEqual([
      {
        scope: 'docs',
        path: path.join(root, 'docs', '.cursorrules'),
        description: 'docs-rules',
        itemType: 'rule',
      },
      {
        scope: 'saga2_design',
        path: path.join(root, 'saga2_design', 'AGENTS.md'),
        description: '策划知识库 Agent 入口。',
        itemType: 'agents-md',
      },
      {
        scope: 'saga2_design',
        path: path.join(root, 'saga2_design', 'planning', 'AGENTS.md'),
        description: '策划库规划入口',
        itemType: 'agents-md',
      },
      {
        scope: 'tools',
        path: path.join(root, 'tools', 'AGENTS.md'),
        description: 'tools/AGENTS.md',
        itemType: 'agents-md',
      },
    ]);

    // `path` 是绝对路径且**真实可读**：引用必须是可被 `read` 打开的地址。
    for (const reference of resolved.projectReferences) {
      expect(path.isAbsolute(reference.path)).toBe(true);
      expect(typeof (await readFile(reference.path, 'utf8'))).toBe('string');
    }
    const referencePaths = resolved.projectReferences.map((reference) => reference.path);
    expect(referencePaths).not.toContain(path.join(root, 'saga2_design', 'CLAUDE.md'));
    expect(referencePaths).not.toContain(path.join(root, 'saga2_unity', 'AGENTS.md'));

    // 负向：规范正文**与描述**都不得出现在 promptText（描述只属于 order 65 清单段）。
    expect(resolved.promptText).toContain('# Project framework');
    expect(resolved.promptText).not.toContain('AI 初次接入治理规则');
    expect(resolved.promptText).not.toContain('不得凭记忆改写规范正文');
    expect(resolved.promptText).not.toContain('策划知识库 Agent 入口');
    expect(resolved.promptText).not.toContain('策划库规划入口');
    expect(resolved.promptText).not.toContain('规划目录规范正文');
    expect(resolved.promptText).not.toContain('只在 docs 目录生效');
    expect(resolved.promptText).not.toContain('工具目录规则');
  });

  it('normalizes every scope variant through the range declaration, not through the file location', async () => {
    const root = await makeRoot('cindy-meka-scope-');
    useSaga2();
    environment.p4RootPath = root;
    await writeText(root, 'design/AGENTS.md', '根作用范围。\n');
    await writeText(root, 'design/nested/AGENTS.md', '显式相对目录。\n');
    await writeText(root, 'design/b/AGENTS.md', '反斜杠分隔符。\n');
    await writeText(root, 'design/a/AGENTS.md', '尾随斜杠。\n');
    await writeText(root, 'docs/AGENTS.md', '无声明。\n');

    // 归一化层拦得住的值（`.` 与尾随 `/`）走真实项目文件。
    await writeProject(
      root,
      projectFile(root, {
        metadata: [
          metadataEntry({ sourcePath: 'design/AGENTS.md', subProjectPath: '.' }),
          metadataEntry({ sourcePath: 'design/a/AGENTS.md', subProjectPath: 'a/' }),
          metadataEntry({ sourcePath: 'design/nested/AGENTS.md', subProjectPath: '' }),
          metadataEntry({ sourcePath: 'docs/AGENTS.md' }),
        ],
      }),
    );

    const resolved = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');
    const byPath = new Map(
      resolved.projectReferences.map((reference) => [reference.path, reference.scope]),
    );

    // `'.'` ⇒ 项目根（''），而不是文档所在目录 `design`。
    expect(byPath.get(path.join(root, 'design', 'AGENTS.md'))).toBe('');
    // `'a/'` ⇒ `a`，而不是 `design/a`。
    expect(byPath.get(path.join(root, 'design', 'a', 'AGENTS.md'))).toBe('a');
    // 空声明不采用 ⇒ 回落到文档自身目录。
    expect(byPath.get(path.join(root, 'design', 'nested', 'AGENTS.md'))).toBe('design/nested');
    expect(byPath.get(path.join(root, 'docs', 'AGENTS.md'))).toBe('docs');

    // `./x` 与 `a\b` 在项目配置边界就被 `canonicalRelativePath` 拒绝（真实文件路径下不可达），
    // 归一化函数仍必须对它们成立 —— 用不可信项目文件直接驱动运行期，防止将来某个写入方绕过校验。
    projectConfigOverride.file = {
      schemaVersion: 1,
      projectId: 'saga2',
      basic: { displayName: 'SAGA2', path: root, disciplines: [], domains: [] },
      metadata: [
        metadataEntry({ sourcePath: 'design/nested/AGENTS.md', subProjectPath: './x' }),
        metadataEntry({ sourcePath: 'design/b/AGENTS.md', subProjectPath: 'a\\b' }),
      ],
    } satisfies MekaProjectFile;

    const unnormalized = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');
    expect(
      unnormalized.projectReferences.map((reference) => [reference.scope, reference.path]),
    ).toEqual([
      ['a/b', path.join(root, 'design', 'b', 'AGENTS.md')],
      ['x', path.join(root, 'design', 'nested', 'AGENTS.md')],
    ]);
  });

  it('rejects a non-canonical scope declaration written into a real project file', async () => {
    const root = await makeRoot('cindy-meka-scope-reject-');
    useCustomProject(root);
    await writeProject(
      root,
      projectFile(root, {
        projectId: 'demo',
        metadata: [metadataEntry({ sourcePath: 'design/AGENTS.md', subProjectPath: './x' })],
      }),
    );

    await expect(resolveMekaRuntimeConfig('demo', 'demo-role')).rejects.toThrow(
      /subProjectPath must be a canonical relative POSIX path/,
    );
  });

  it('bounds the description to 300 code points without splitting a surrogate pair', async () => {
    const root = await makeRoot('cindy-meka-description-');
    useSaga2();
    environment.p4RootPath = root;
    await writeText(root, 'docs/AGENTS.md', '正文。\n');
    await writeText(root, 'docs/RULES.md', '正文。\n');

    // 320 个星号面字符（每个占 2 个 UTF-16 码元）：按码元截断会切出半个字符。
    const longDescription = '🙂'.repeat(320);
    await writeProject(
      root,
      projectFile(root, {
        metadata: [
          metadataEntry({ sourcePath: 'docs/AGENTS.md', description: longDescription }),
          metadataEntry({
            sourcePath: 'docs/RULES.md',
            itemType: 'rule',
            description: '  多行\n描述\t被折叠  ',
          }),
        ],
      }),
    );

    const resolved = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');
    const bounded = resolved.projectReferences.find((reference) =>
      reference.path.endsWith('AGENTS.md'),
    );
    const collapsed = resolved.projectReferences.find((reference) =>
      reference.path.endsWith('RULES.md'),
    );

    expect(bounded).toBeDefined();
    const characters = Array.from(bounded!.description);
    expect(characters).toHaveLength(300);
    expect(bounded!.description.endsWith('...')).toBe(true);
    // 码点级截断：收尾的省略号之外，整串仍是完整的星号面字符（没有任何半个代理对）。
    expect(characters.slice(0, -3).every((character) => character === '🙂')).toBe(true);

    // 描述先折叠空白再 trim：多行/制表符都收敛成单个空格。
    expect(collapsed!.description).toBe('多行 描述 被折叠');
  });

  it('sorts references by scope then path deterministically, independent of the metadata order', async () => {
    const root = await makeRoot('cindy-meka-order-');
    useSaga2();
    environment.p4RootPath = root;
    await writeText(root, 'AGENTS.md', '项目根。\n');
    await writeText(root, 'saga2_design/AGENTS.md', '策划库。\n');
    await writeText(root, 'saga2_design/planning/AGENTS.md', '规划。\n');
    await writeText(root, 'docs/.cursorrules', '文档规则。\n');

    const entries = [
      metadataEntry({ sourcePath: 'saga2_design/planning/AGENTS.md', name: 'planning' }),
      metadataEntry({ sourcePath: 'docs/.cursorrules', itemType: 'rule', name: 'docs-rules' }),
      metadataEntry({ sourcePath: 'AGENTS.md', name: 'root-agents' }),
      metadataEntry({ sourcePath: 'saga2_design/AGENTS.md', name: 'design-agents' }),
    ];

    await writeProject(root, projectFile(root, { metadata: entries }));
    const forward = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');
    await writeProject(root, projectFile(root, { metadata: [...entries].reverse() }));
    const reversed = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');

    const expected = [
      ['', 'AGENTS.md'],
      ['docs', 'docs/.cursorrules'],
      ['saga2_design', 'saga2_design/AGENTS.md'],
      // 没有 `subProjectPath` 的条目按 scope → path 排在**它自己所在目录**那一档，且路径升序
      // 让 `saga2_design/AGENTS.md` 排在 `saga2_design/planning/AGENTS.md` 之前。
      ['saga2_design/planning', 'saga2_design/planning/AGENTS.md'],
    ];
    const shape = (references: readonly { scope: string; path: string }[]) =>
      references.map((reference) => [
        reference.scope,
        path.relative(root, reference.path).split(path.sep).join('/'),
      ]);
    expect(shape(forward.projectReferences)).toEqual(expected);
    // 输入顺序完全反转后结果逐条不变 ⇒ 排序只依赖内容，不依赖扫描/写入顺序。
    expect(shape(reversed.projectReferences)).toEqual(expected);
    expect(reversed.projectReferences).toEqual(forward.projectReferences);
    // 作用范围为空条目排在最前：`'' < 'docs'`。
    expect(forward.projectReferences[0]!.scope).toBe('');
  });

  it('computes the scope against the item own root for additional-root metadata', async () => {
    const root = await makeRoot('cindy-meka-rootpath-project-');
    const extra = await makeRoot('cindy-meka-rootpath-extra-');
    useSaga2();
    environment.p4RootPath = root;
    await writeText(extra, 'docs/AGENTS.md', '附加根规范。\n');
    await writeText(extra, 'sub/RULES.md', '附加根子目录规则。\n');

    await writeProject(
      root,
      projectFile(root, {
        basic: {
          name: 'saga2',
          displayName: 'SAGA2',
          path: root,
          disciplines: ['通用'],
          domains: [],
          additionalPaths: [extra],
        },
        metadata: [
          metadataEntry({ rootPath: extra, sourcePath: 'docs/AGENTS.md', subProjectPath: 'docs' }),
          metadataEntry({ rootPath: extra, sourcePath: 'sub/RULES.md', itemType: 'rule' }),
        ],
      }),
    );

    const resolved = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');
    // 参照系是该条目自己的 `rootPath`（附加根），不是 projectRoot：`sub/RULES.md` 的 scope 是 `sub`。
    expect(resolved.projectReferences).toEqual([
      {
        scope: 'docs',
        path: path.join(extra, 'docs', 'AGENTS.md'),
        description: 'docs/AGENTS.md',
        itemType: 'agents-md',
      },
      {
        scope: 'sub',
        path: path.join(extra, 'sub', 'RULES.md'),
        description: 'sub/RULES.md',
        itemType: 'rule',
      },
    ]);
    for (const reference of resolved.projectReferences) {
      expect(typeof (await readFile(reference.path, 'utf8'))).toBe('string');
    }
  });

  it('warns and skips metadata selected only by includeAllProjectMetadata when one file is unparsable', async () => {
    const root = await makeRoot('cindy-meka-tolerant-');
    useSaga2();
    environment.p4RootPath = root;
    // 坏 frontmatter（未闭合引号 + 未闭合流式序列）⇒ `gray-matter` 抛错。
    await writeText(
      root,
      'broken/SKILL.md',
      '---\nname: "unterminated\nbroken: [1, 2\n---\n# Broken skill\n',
    );
    await writeText(root, 'broken/.mcp.json', '{ not json at all');
    await writeText(root, 'good/SKILL.md', '# Good skill\n\n可用技能。\n');
    await writeText(
      root,
      'good/mcp.json',
      `${JSON.stringify({ mcpServers: { 'good-router': { command: 'node', args: ['mcp.js'] } } })}\n`,
    );

    await writeProject(
      root,
      projectFile(root, {
        metadata: [
          metadataEntry({ sourcePath: 'broken/SKILL.md', itemType: 'skill', name: 'broken-skill' }),
          metadataEntry({ sourcePath: 'broken/.mcp.json', itemType: 'mcp', name: 'broken-mcp' }),
          metadataEntry({ sourcePath: 'good/SKILL.md', itemType: 'skill', name: 'good-skill' }),
          metadataEntry({ sourcePath: 'good/mcp.json', itemType: 'mcp', name: 'good-mcp' }),
        ],
      }),
    );

    // 会话配置**不抛错**：一个坏文件不得把该项目的所有新建会话顶成 INVALID_PARAMS。
    const resolved = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');

    // 其余项仍解析成功（同一个漏斗里坏项被 warn + 跳过，好项照常生效）。
    expect(resolved.skills.map((skill) => skill.id)).toContain('good-skill');
    expect(resolved.skills.map((skill) => skill.id)).not.toContain('broken-skill');
    expect(resolved.mcp.map((entry) => entry.id)).toContain('good-router');
    expect(resolved.projectReferences).toEqual([]);
  });

  it('keeps the author explicit selection fail-closed when the very same file is unparsable', async () => {
    const root = await makeRoot('cindy-meka-strict-');
    useSaga2();
    environment.p4RootPath = root;
    await writeText(root, 'broken/SKILL.md', '---\nname: "unterminated\nbroken: [1, 2\n---\n# B\n');
    await writeText(root, 'good/SKILL.md', '# Good skill\n');

    // 同一份坏文件，但这次由作者**显式勾选**（`roleDefaults.projectMetadataSelection`）。
    await writeProject(
      root,
      projectFile(root, {
        metadata: [
          metadataEntry({ sourcePath: 'broken/SKILL.md', itemType: 'skill', name: 'broken-skill' }),
          metadataEntry({ sourcePath: 'good/SKILL.md', itemType: 'skill', name: 'good-skill' }),
        ],
        roleDefaults: {
          projectMetadataSelection: [{ sourcePath: 'broken/SKILL.md', itemType: 'skill' }],
        },
      }),
    );

    // 显式选择是作者意图：解析失败仍然上抛，绝不静默降级为「配置生效了但什么都没有」。
    await expect(resolveMekaRuntimeConfig('saga2', 'saga2-default-role')).rejects.toThrow(
      /invalid Meka Skill frontmatter for broken/,
    );
  });

  /**
   * 缺陷 1（P1）的核心回归：root 白名单失配**按来源分流**。
   *
   * 触发路径：用户给项目配了 `additionalPaths` → 跑「发现」把元数据项连同该附加根作为 `rootPath`
   * 写进项目文件 → 之后把该附加路径从项目配置里删掉并保存。那个元数据项仍是 enabled、仍带旧
   * `rootPath`；共享默认角色（`includeAllProjectMetadata: true`）全量选中它。改动前默认角色零注入，
   * 同一状态不会失败；改动后它会在元数据循环里抛错 ⇒ 该项目**所有新建会话**一起失败。
   */
  it('skips a metadata root that is no longer configured when the selection is only expanded', async () => {
    const root = await makeRoot('cindy-meka-root-guard-');
    const foreign = await makeRoot('cindy-meka-root-foreign-');
    useSaga2();
    environment.p4RootPath = root;
    // 外来根里的文件**真实存在**：跳过必须发生在读盘之前。若这里只是「读不到才跳过」，本用例会
    // 读成功并产出一个允许根之外的引用，下面的断言就会失败。
    await writeText(foreign, 'AGENTS.md', '外来根。\n');
    await writeText(root, 'docs/AGENTS.md', '允许根内的项。\n');

    await writeProject(
      root,
      projectFile(root, {
        // `additionalPaths` 已删：`rootPath` 合法（绝对路径）但**不在**允许根集合里。
        metadata: [
          metadataEntry({ rootPath: foreign, sourcePath: 'AGENTS.md' }),
          metadataEntry({ sourcePath: 'docs/AGENTS.md' }),
        ],
      }),
    );

    const resolved = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');

    // 不抛错：坏项被跳过，其余项照常生效（与 ENOENT / 解析失败同口径）。
    expect(resolved.projectReferences).toEqual([
      {
        scope: 'docs',
        path: path.join(root, 'docs', 'AGENTS.md'),
        description: 'docs/AGENTS.md',
        itemType: 'agents-md',
      },
    ]);
    expect(resolved.projectReferences.map((reference) => reference.path)).not.toContain(
      path.join(foreign, 'AGENTS.md'),
    );
    // 降级必须留下 warn，否则「配置里的 rootPath 已经失效」这件事对用户完全不可见。
    expect(
      logging.warnings.some((warning) => warning.message.includes('root is no longer configured')),
    ).toBe(true);
  });

  it('keeps the author explicit root selection fail-closed for the very same mismatch', async () => {
    const root = await makeRoot('cindy-meka-root-guard-explicit-');
    const foreign = await makeRoot('cindy-meka-root-foreign-explicit-');
    useSaga2();
    environment.p4RootPath = root;
    await writeText(foreign, 'AGENTS.md', '外来根。\n');

    await writeProject(
      root,
      projectFile(root, {
        metadata: [metadataEntry({ rootPath: foreign, sourcePath: 'AGENTS.md' })],
        // 同一条失配，但这次由作者**显式选择**（项目 `roleDefaults.projectMetadataSelection`，
        // 与角色清单里的显式条目同一口径 —— 快照取自 `mergeMekaProjectRoleDefaults` 之后）。
        roleDefaults: {
          projectMetadataSelection: [
            { rootPath: foreign, sourcePath: 'AGENTS.md', itemType: 'agents-md' },
          ],
        },
      }),
    );

    // 显式选择是作者意图：静默跳过会把「配置写错了」变成「配置生效了但什么都没有」，因此仍然
    // 上抛，且错误文案逐字不变。
    await expect(resolveMekaRuntimeConfig('saga2', 'saga2-default-role')).rejects.toThrow(
      /Meka project metadata root is not configured/,
    );
    expect(
      logging.warnings.some((warning) => warning.message.includes('root is no longer configured')),
    ).toBe(false);
  });

  /**
   * `..` 逃逸是安全红线，**任何来源都不放宽**（与 root 白名单失配不同口径）。这里特意让该条目的
   * `rootPath` 本身是允许根（附加根），使白名单校验必然通过 —— 于是「抛错」只能来自逃逸校验，
   * 证明两条口径确实彼此独立。
   */
  it('still rejects a .. escape for an expanded selection even when the item own root is allowed', async () => {
    const root = await makeRoot('cindy-meka-escape-derived-');
    const extra = path.join(root, 'extra');
    useSaga2();
    environment.p4RootPath = root;
    await writeText(root, 'extra/AGENTS.md', '附加根内的项。\n');
    await writeText(root, 'escaped.md', '附加根之外，但仍在项目根内。\n');

    projectConfigOverride.file = {
      schemaVersion: 1,
      projectId: 'saga2',
      basic: {
        displayName: 'SAGA2',
        path: root,
        disciplines: [],
        domains: [],
        additionalPaths: [extra],
      },
      // 附加根在允许根集合里（白名单这一关能过），逃逸的是**该条目自己的 root**。
      metadata: [metadataEntry({ rootPath: extra, sourcePath: '../escaped.md' })],
    } satisfies MekaProjectFile;

    await expect(resolveMekaRuntimeConfig('saga2', 'saga2-default-role')).rejects.toThrow(
      /Meka project metadata escapes the project root: \.\.\/escaped\.md/,
    );
    expect(
      logging.warnings.some((warning) => warning.message.includes('root is no longer configured')),
    ).toBe(false);
  });

  it('rejects a selection that escapes the project root regardless of its source', async () => {
    const root = await makeRoot('cindy-meka-escape-');
    useCustomProject(root);
    await writeProject(
      root,
      projectFile(root, {
        projectId: 'demo',
        metadata: [metadataEntry({ sourcePath: '../escape.md' })],
      }),
    );

    // 真实项目文件路径：配边界即拒绝（`canonicalRelativePath`），会话根本起不来。
    await expect(resolveMekaRuntimeConfig('demo', 'demo-role')).rejects.toThrow(
      /sourcePath must be a canonical relative POSIX path/,
    );

    // 运行期自己的 `..` 逃逸校验同样不得对「全量展开」来源放宽。
    const sagaRoot = await makeRoot('cindy-meka-escape-runtime-');
    useSaga2();
    environment.p4RootPath = sagaRoot;
    projectConfigOverride.file = {
      schemaVersion: 1,
      projectId: 'saga2',
      basic: { displayName: 'SAGA2', path: sagaRoot, disciplines: [], domains: [] },
      metadata: [metadataEntry({ sourcePath: '../escape.md' })],
    } satisfies MekaProjectFile;

    await expect(resolveMekaRuntimeConfig('saga2', 'saga2-default-role')).rejects.toThrow(
      /escapes the project root/,
    );
  });

  it('rejects an unknown itemType whether it comes from the project scan or from a role manifest', async () => {
    const root = await makeRoot('cindy-meka-itemtype-');
    useCustomProject(root);
    // 项目扫描出来的元数据类型不合法 ⇒ 项目配置边界拒绝（不会进入"全量展开"再被跳过）。
    await writeProject(
      root,
      projectFile(root, {
        projectId: 'demo',
        metadata: [
          metadataEntry({
            sourcePath: 'docs/AGENTS.md',
            itemType: 'bogus' as MekaProjectMetadataItemType,
          }),
        ],
      }),
    );
    await expect(resolveMekaRuntimeConfig('demo', 'demo-role')).rejects.toThrow(
      /unsupported project metadata item type/,
    );

    // 角色清单里的选择类型不合法 ⇒ 运行期穷尽性校验抛错，绝不因为"不是作者显式选择"就跳过。
    const sagaRoot = await makeRoot('cindy-meka-itemtype-role-');
    useSaga2();
    environment.p4RootPath = sagaRoot;
    await writeProject(sagaRoot, projectFile(sagaRoot, { metadata: [] }));
    await useCustomRole(sagaRoot, {
      id: 'bogus-type-role',
      name: 'bogus-type-role',
      displayName: 'Bogus type role',
      prompt: 'bogus type role prompt',
      rules: [],
      skills: [],
      promptFragments: [],
      mcp: [],
      projectMetadataSelection: [
        { sourcePath: 'docs/AGENTS.md', itemType: 'bogus', enabled: true },
      ],
    });
    await expect(resolveMekaRuntimeConfig('saga2', 'bogus-type-role')).rejects.toThrow(
      /unsupported Meka project metadata type: bogus/,
    );
  });

  it('expands the whole bundled catalog for includeAllBundledSkills and excludes a single explicit id', async () => {
    const root = await makeRoot('cindy-meka-catalog-');
    useSaga2();
    const catalog = await catalogIds();
    // 包内 catalog 收敛后只剩平台 skill：这条用例的「全量展开」因此是严格的一个 id。
    expect(catalog).toEqual(['platform-capabilities']);

    await useCustomRole(root, {
      id: 'catalog-role',
      name: 'catalog-role',
      displayName: 'Catalog role',
      prompt: 'catalog role prompt',
      rules: [],
      skills: [],
      promptFragments: [],
      mcp: [],
      includeAllBundledSkills: true,
    });

    const expanded = await resolveMekaRuntimeConfig('saga2', 'catalog-role');
    expect(expanded.skills.map((skill) => skill.id).sort()).toEqual(catalog);

    // 显式 `{ skillId, enabled: false }` 精确排除单个：其余一个不少。
    const excludedId = 'platform-capabilities';
    expect(catalog).toContain(excludedId);
    await useCustomRole(root, {
      id: 'excluding-role',
      name: 'excluding-role',
      displayName: 'Excluding role',
      prompt: 'excluding role prompt',
      rules: [],
      skills: [{ skillId: excludedId, enabled: false }],
      promptFragments: [],
      mcp: [],
      includeAllBundledSkills: true,
    });

    const excluded = await resolveMekaRuntimeConfig('saga2', 'excluding-role');
    expect(excluded.skills.map((skill) => skill.id).sort()).toEqual(
      catalog.filter((id) => id !== excludedId),
    );
    expect(excluded.skills.map((skill) => skill.id)).not.toContain(excludedId);
  });

  it('merges project role defaults underneath the bundled catalog and lets the role override by id', async () => {
    const root = await makeRoot('cindy-meka-catalog-defaults-');
    useSaga2();
    environment.p4RootPath = root;
    const catalog = await catalogIds();

    await writeProject(
      root,
      projectFile(root, {
        metadata: [],
        roleDefaults: {
          promptFramework: '# Project framework',
          skills: ['platform-capabilities'],
          mcp: [{ id: 'project-agent', providerId: 'project-agent', enabled: true }],
        },
      }),
    );
    await useCustomRole(root, {
      id: 'defaults-role',
      name: 'defaults-role',
      displayName: 'Defaults role',
      prompt: 'defaults role prompt',
      rules: [],
      // 与 `roleDefaults.skills` 同 id 的显式 false：角色显式项覆盖 defaults（也覆盖 catalog 铺底）。
      skills: [{ skillId: 'platform-capabilities', enabled: false }],
      promptFragments: [],
      mcp: [],
      useProjectDefaults: true,
      includeAllBundledSkills: true,
    });

    const resolved = await resolveMekaRuntimeConfig('saga2', 'defaults-role');
    // 合并关系：defaults 的 promptFramework / MCP 生效，defaults 的 skill 被角色显式项否决。
    expect(resolved.promptText).toContain('# Project framework');
    expect(resolved.promptText).toContain('defaults role prompt');
    expect(resolved.mcp.map((entry) => entry.id)).toEqual(['project-agent']);
    expect(resolved.skills.map((skill) => skill.id)).not.toContain('platform-capabilities');
    expect(resolved.skills.map((skill) => skill.id).sort()).toEqual(
      catalog.filter((id) => id !== 'platform-capabilities'),
    );
  });

  /**
   * `derivedOnly` 的**真实设置点**：只由三个全量开关派生出来的 skill 才带该标记，作者显式选择
   * （角色清单 + 项目 `roleDefaults`）一律不带。`skillSnapshot` 的「跳过还是抛错」完全依赖这个
   * 区分，所以这里在**生产实现**上钉住它，而不是只在快照测试里手工构造 `derivedOnly`。
   */
  it('marks only switch-derived Skills as derivedOnly and keeps author selections fail-closed', async () => {
    const root = await makeRoot('cindy-meka-derived-flag-');
    useSaga2();
    environment.p4RootPath = root;
    const catalog = await catalogIds();
    await writeText(root, 'vendor/SKILL.md', '# Vendor skill\n\n第三方技能。\n');
    const metadata = [
      metadataEntry({ sourcePath: 'vendor/SKILL.md', itemType: 'skill', name: 'vendor-skill' }),
    ];

    // A：全部由 `includeAllProjectMetadata` / `includeAllBundledSkills` 展开。
    await writeProject(
      root,
      projectFile(root, { metadata, roleDefaults: { skills: ['platform-capabilities'] } }),
    );
    const expanded = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');
    const expandedById = new Map(expanded.skills.map((skill) => [skill.id, skill]));

    expect(expandedById.get('vendor-skill')?.derivedOnly).toBe(true);
    // 作者显式声明的那一条覆盖 catalog 铺底的同 id：id 集合不因它多出一条。
    expect(expanded.skills.map((skill) => skill.id).sort()).toEqual([...catalog, 'vendor-skill'].sort());
    // `roleDefaults.skills` 是**作者显式声明**（与 `explicitMetadataKeys` 同一落位口径）⇒ 不带标记。
    expect(expandedById.get('platform-capabilities')?.derivedOnly).toBeUndefined();

    // 反向证据：同一项目去掉作者声明后，catalog 铺底的同 id 就是派生项。包内 catalog 收敛到只剩
    // 一个 id，所以这条对照只能在「两次运行之间」做，不能靠「catalog 里除它以外还有别的 id」。
    await writeProject(root, projectFile(root, { metadata }));
    const switchedOnly = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');
    expect(
      switchedOnly.skills.find((skill) => skill.id === 'platform-capabilities')?.derivedOnly,
    ).toBe(true);
    expect(switchedOnly.skills.map((skill) => skill.id).sort()).toEqual([
      'platform-capabilities',
      'vendor-skill',
    ]);

    // B：同一条项目 skill，改由作者显式勾选 ⇒ 不再是派生（收集失败时必须仍然抛错）。
    await writeProject(
      root,
      projectFile(root, {
        metadata,
        roleDefaults: {
          projectMetadataSelection: [{ sourcePath: 'vendor/SKILL.md', itemType: 'skill' }],
        },
      }),
    );
    const explicit = await resolveMekaRuntimeConfig('saga2', 'saga2-default-role');
    const selected = explicit.skills.find((skill) => skill.id === 'vendor-skill');

    expect(selected).toBeDefined();
    expect(selected?.derivedOnly).toBeUndefined();
  });

  it('never writes the bundled catalog switch or any skill body into promptText', async () => {
    const root = await makeRoot('cindy-meka-catalog-prompt-');
    useSaga2();
    await useCustomRole(root, {
      id: 'prompt-role',
      name: 'prompt-role',
      displayName: 'Prompt role',
      prompt: 'prompt role body',
      rules: [],
      skills: [],
      promptFragments: [],
      mcp: [],
      includeAllBundledSkills: true,
    });

    const resolved = await resolveMekaRuntimeConfig('saga2', 'prompt-role');
    const catalog = await listBundledSkills();
    expect(resolved.skills.map((skill) => skill.id).sort()).toEqual([...catalog.keys()].sort());
    expect(resolved.promptText).toContain('prompt role body');
    // 开关本身不是注入文本，技能走 harness 原生 catalog，**正文**绝不内联。
    expect(resolved.promptText).not.toContain('includeAllBundledSkills');
    for (const [id, entryPath] of catalog) {
      const body = (await readFile(entryPath, 'utf8')).trim();
      expect(body.length).toBeGreaterThan(0);
      expect(resolved.promptText).not.toContain(body);
      expect(resolved.promptText.includes(`\n# ${id}\n`)).toBe(false);
    }
    expect(resolved.projectReferences).toEqual([]);
  });
});

/**
 * T1 / T4 容错的回归：**随包角色清单与 9 个随包 skill 被删除**之后新增的两条读时容忍
 * （`runtimeConfig.ts` 的 fragment 循环 `~:809-834` 与 skill 循环 `~:849-880`，2026-09-29）。
 *
 * 为什么这批用例必须走**项目文件的 `builtinRoles` 快照**：`resolveRoleFile` 里项目快照
 * **优先于** `readBuiltinRoleManifestOrProjectDefault` 的 T2 回落，而旧版角色编辑器 /
 * `mergeBundledRoleFallbacks` 会把随包角色（含 `skills` 选择与 `promptFragments` 路径）整份写进
 * 用户项目文件。清单已删除、随包 catalog 也只剩 `platform-capabilities`，于是快照里的残留引用就是
 * T1/T4 **唯一**的真实输入 —— 自定义角色或手工造的内置清单都重现不了这条优先级（后者还会被
 * `mergeBundledRoleFallbacks` 当成包内清单参与合并）。
 *
 * 快照夹具形状见 `combatDevelopmentSnapshot()`：`{ schemaVersion: 1, id: 'combat-development',
 * projectId: 'saga2', name, displayName: '战斗开发', policyProviderRefs: [], prompt, rules,
 * skills: [{ skillId, enabled }], promptFragments: [{ id, path }], mcp: [],
 * projectMetadataSelection: [], useProjectDefaults: false, ... }`，经项目文件的 `builtinRoles`
 * 通道落进 `<projectRoot>/.meka/project.json`，由 `normalizeMekaProjectFile` 归一化
 * （`displayName` 非空、`skills` / `mcp` 必须是数组是它的最小可接受集）。另一半是 `useSaga2()` 里
 * 追加的**内置**角色行（`is_builtin = 1`）：只有内置行才会把快照与 fragment 根都按「随包角色目录」
 * 解析。
 */
describe('Meka runtime tolerance for retired bundled role assets (T1/T4)', () => {
  /** 旧版写进项目文件的内置角色快照（`MekaRoleManifestFile` 的最小可接受形状）。 */
  function combatDevelopmentSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 1,
      id: 'combat-development',
      projectId: 'saga2',
      name: 'combat-development',
      displayName: '战斗开发',
      policyProviderRefs: [],
      prompt: '# snapshot prompt',
      rules: [{ id: 'snapshot-rule', text: '# snapshot rule', enabled: true }],
      skills: [],
      promptFragments: [],
      mcp: [],
      projectMetadataSelection: [],
      useProjectDefaults: false,
      includeAllProjectMetadata: false,
      includeAllBundledSkills: false,
      ...overrides,
    };
  }

  /**
   * 注册 `combat-development` 的内置角色行。存量库里必然留着它（seed 只 upsert、从不删除不在注册表
   * 里的行），这正是快照会被读到的前提。
   */
  function useCombatDevelopmentRow(): void {
    environment.roles['combat-development'] = {
      id: 'combat-development',
      project_id: 'saga2',
      is_builtin: 1,
      file_path: 'meka/roles/combat-development.json',
    };
  }

  /**
   * T1：快照里显式选择的 **已删、非平台** skill ⇒ 跳过 + 告警，会话照常解析。
   *
   * 失败模式（T1 被移除）：`readBundledRuntimeSkill` 抛 `unknown bundled Meka skill:
   * combat-skill-configuration` ⇒ 整个 `resolveMekaRuntimeConfig` reject，本用例的 `await` 直接抛
   * （等价于用户那边「会话建不出也打不开、INVALID_PARAMS」）。
   */
  it('skips a deleted non-platform skill selected by a project snapshot and keeps the rest (T1)', async () => {
    const root = await makeRoot('cindy-meka-t1-snapshot-');
    useSaga2();
    useCombatDevelopmentRow();
    environment.p4RootPath = root;

    // 夹具自检：这个 id 确实已不随包（否则本用例什么都没证），随包 catalog 只剩平台基线 skill。
    expect([...(await listBundledSkills()).keys()]).not.toContain('combat-skill-configuration');
    const platformSkills = await resolveMekaPlatformRuntimeSkills();
    expect(platformSkills.map((skill) => skill.id)).toEqual(['platform-capabilities']);

    await writeProject(
      root,
      projectFile(root, {
        builtinRoles: [
          combatDevelopmentSnapshot({
            skills: [
              { skillId: 'combat-skill-configuration', enabled: true },
              { skillId: 'platform-capabilities', enabled: true },
            ],
          }),
        ],
      }),
    );

    const resolved = await resolveMekaRuntimeConfig('saga2', 'combat-development');

    // 先证明走的是**快照**而不是 T2 回落（回落会给出「默认角色」）⇒ 下面的选择集确实来自快照。
    expect(resolved).toMatchObject({ roleId: 'combat-development', roleDisplayName: '战斗开发' });
    // 不抛错：未知项被跳过，其余照常解析。
    expect(resolved.skills.map((skill) => skill.id)).toEqual(['platform-capabilities']);
    // 存活项逐字未受影响：同一份随包正文/地址，且仍是作者显式选择（不带 derivedOnly 标记）。
    expect(resolved.skills).toEqual(platformSkills);
    // 静默跳过不可接受：跳过的 id 必须留下可观察的 warn。
    expect(
      logging.warnings.some(
        (warning) =>
          warning.message.includes('unknown bundled Meka skill') &&
          (warning.meta as { skillId?: string }).skillId === 'combat-skill-configuration',
      ),
    ).toBe(true);
  });

  /**
   * T1 的**平台例外**：catalog 取不到 `platform-capabilities` 时必须仍然硬失败。
   *
   * 真实 catalog 里这个 id 必然存在（C1），所以只有把扫描根指向空目录才能驱动这条路径；同一条用例
   * 里先用**非平台** id 做对照，证明「同一份 catalog 下非平台 id 只是跳过」——
   * 于是后面那句抛错只能来自平台例外本身，而不是「catalog 空了就一律抛错」。
   *
   * 失败模式（`!isMekaPlatformSkillId(...)` 这半个条件被删）：平台 id 会退化成跳过 + 告警，
   * `rejects.toThrow` 与「不得出现跳过告警」两条断言同时失败。
   */
  it('still fails closed when the platform baseline skill cannot be resolved (T1 platform exception)', async () => {
    const root = await makeRoot('cindy-meka-t1-platform-');
    const emptyCatalog = await makeRoot('cindy-meka-t1-empty-catalog-');
    useSaga2();
    useCombatDevelopmentRow();
    environment.p4RootPath = root;
    resource.seamSkillsRoot = emptyCatalog;
    // 夹具自检：catalog 真的查不到任何 id（否则下面的硬失败证明不了任何事）。
    expect([...(await listBundledSkills()).keys()]).toEqual([]);

    // 对照：非平台 id 在同一份空 catalog 下仍然按 T1 跳过。
    await writeProject(
      root,
      projectFile(root, {
        builtinRoles: [
          combatDevelopmentSnapshot({
            skills: [{ skillId: 'combat-skill-configuration', enabled: true }],
          }),
        ],
      }),
    );
    const tolerant = await resolveMekaRuntimeConfig('saga2', 'combat-development');
    expect(tolerant.skills).toEqual([]);
    expect(
      logging.warnings.some(
        (warning) =>
          warning.message.includes('unknown bundled Meka skill') &&
          (warning.meta as { skillId?: string }).skillId === 'combat-skill-configuration',
      ),
    ).toBe(true);

    // 平台基线取不到 = 包损坏（不是历史残留）⇒ 必须硬失败，且**不得**降级成跳过 + 告警。
    logging.warnings.length = 0;
    await writeProject(
      root,
      projectFile(root, {
        builtinRoles: [
          combatDevelopmentSnapshot({
            skills: [{ skillId: 'platform-capabilities', enabled: true }],
          }),
        ],
      }),
    );
    await expect(resolveMekaRuntimeConfig('saga2', 'combat-development')).rejects.toThrow(
      /unknown bundled Meka skill: platform-capabilities/,
    );
    expect(
      logging.warnings.some((warning) => warning.message.includes('unknown bundled Meka skill')),
    ).toBe(false);
  });

  /**
   * T4：快照里的 fragment 指向**已删文件**（ENOENT）⇒ 跳过该 fragment，其余 prompt / rules /
   * fragment 逐字按声明顺序保留。
   *
   * 失败模式（T4 被移除）：`readRoleRelativeFile` 的 ENOENT 直接上抛 ⇒ `resolveMekaRuntimeConfig`
   * reject（会话打不开），本用例的 `await` 抛错。
   */
  it('skips a prompt fragment whose role-relative file is gone and keeps the rest in order (T4)', async () => {
    const root = await makeRoot('cindy-meka-t4-missing-');
    const rolesRoot = path.join(root, 'bundled-roles');
    useSaga2();
    useCombatDevelopmentRow();
    environment.p4RootPath = root;
    // fragment 根对内置角色就是 `bundledMekaRolesRoot()`：指向临时目录后，只有**存活**的 fragment
    // 真存在，已随包删除的 `combat-*.md` 读取必然 ENOENT —— 这正是 T4 要区分的事实。
    resource.seamRolesRoot = rolesRoot;
    await writeText(root, 'bundled-roles/prompts/combat-kept.md', '# kept fragment body\n');
    await writeText(root, 'bundled-roles/prompts/combat-tail.md', '# tail fragment body\n');

    // 夹具自检：被断言「省略」的两个 fragment 文件真的不存在 ⇒ 跳过只能来自 ENOENT。
    await expect(
      readFile(path.join(rolesRoot, 'prompts', 'combat-skill-id-contract.md'), 'utf8'),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      readFile(path.join(rolesRoot, 'prompts', 'combat-evidence-budget.md'), 'utf8'),
    ).rejects.toThrow(/ENOENT/);

    await writeProject(
      root,
      projectFile(root, {
        builtinRoles: [
          combatDevelopmentSnapshot({
            promptFragments: [
              { id: 'combat-skill-id-contract', path: 'prompts/combat-skill-id-contract.md' },
              { id: 'combat-kept', path: 'prompts/combat-kept.md' },
              { id: 'combat-evidence-budget', path: 'prompts/combat-evidence-budget.md' },
              { id: 'combat-tail', path: 'prompts/combat-tail.md' },
            ],
          }),
        ],
      }),
    );

    const resolved = await resolveMekaRuntimeConfig('saga2', 'combat-development');

    expect(resolved).toMatchObject({ roleId: 'combat-development', roleDisplayName: '战斗开发' });
    // 逐字顺序：`prompt` → `rules` → 存活的 fragment（按声明顺序）。缺失的两个既不占位、也不留空段，
    // 其余一项不少不变。
    expect(resolved.promptText).toBe(
      ['# snapshot prompt', '# snapshot rule', '# kept fragment body', '# tail fragment body'].join(
        '\n\n',
      ),
    );
    // 缺失 fragment 的 id / 路径不得以任何形式残留在结果文本里。
    expect(resolved.promptText).not.toContain('combat-skill-id-contract');
    expect(resolved.promptText).not.toContain('combat-evidence-budget');
  });

  /**
   * T4 的告警取证：每一个被跳过的 fragment 都要留下 warn（含角色、fragment id 与原路径），
   * 存活的 fragment 不得留下「跳过」告警。
   *
   * 失败模式（跳过分支里删掉 `log.warn`）：解析结果不变，但本用例的告警断言失败 —— 这正是不允许
   * 「静默跳过」的地方（用户必须能看出角色引用的 fragment 已经不存在了）。
   */
  it('warns for every skipped missing fragment instead of skipping silently (T4)', async () => {
    const root = await makeRoot('cindy-meka-t4-warn-');
    const rolesRoot = path.join(root, 'bundled-roles');
    useSaga2();
    useCombatDevelopmentRow();
    environment.p4RootPath = root;
    resource.seamRolesRoot = rolesRoot;
    await writeText(root, 'bundled-roles/prompts/combat-kept.md', '# kept fragment body\n');

    await writeProject(
      root,
      projectFile(root, {
        builtinRoles: [
          combatDevelopmentSnapshot({
            promptFragments: [
              { id: 'combat-skill-id-contract', path: 'prompts/combat-skill-id-contract.md' },
              { id: 'combat-kept', path: 'prompts/combat-kept.md' },
              { id: 'combat-evidence-budget', path: 'prompts/combat-evidence-budget.md' },
            ],
          }),
        ],
      }),
    );

    const resolved = await resolveMekaRuntimeConfig('saga2', 'combat-development');
    expect(resolved.promptText).toContain('# kept fragment body');

    const skipped = logging.warnings.filter((warning) =>
      warning.message.includes('missing Meka role prompt fragment'),
    );
    // 逐条、按声明顺序：两个缺失项各一条，存活项零条。
    expect(skipped.map((warning) => (warning.meta as { fragmentId?: string }).fragmentId)).toEqual([
      'combat-skill-id-contract',
      'combat-evidence-budget',
    ]);
    expect(skipped[0]?.meta).toMatchObject({
      projectId: 'saga2',
      roleId: 'combat-development',
      path: 'prompts/combat-skill-id-contract.md',
    });
    expect(
      skipped.map((warning) => (warning.meta as { fragmentId?: string }).fragmentId),
    ).not.toContain('combat-kept');
  });

  /**
   * T4 的负向控制（关键）：**只有 ENOENT 被容忍**。fragment 路径逃出角色目录必须照旧抛错。
   *
   * 逃逸目标刻意是**真实存在**的文件：只要 T4 被放宽成「凡读取失败/任何错误都跳过」，甚至「读到了就
   * 注入」，本用例就会 resolves，并可能把角色目录之外的正文注入 promptText。
   *
   * 失败模式：把 `if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;` 改成无条件
   * `continue`（catch-all），`rejects.toThrow` 直接失败。
   */
  it('still rejects a fragment path that escapes the role directory, even though it exists (T4 negative control)', async () => {
    const root = await makeRoot('cindy-meka-t4-escape-');
    const rolesRoot = path.join(root, 'bundled-roles');
    useSaga2();
    useCombatDevelopmentRow();
    environment.p4RootPath = root;
    resource.seamRolesRoot = rolesRoot;
    await mkdir(rolesRoot, { recursive: true });
    await writeText(root, 'escape-target.md', '# outside the role directory\n');

    await writeProject(
      root,
      projectFile(root, {
        builtinRoles: [
          combatDevelopmentSnapshot({
            promptFragments: [{ id: 'escape', path: '../escape-target.md' }],
          }),
        ],
      }),
    );

    await expect(resolveMekaRuntimeConfig('saga2', 'combat-development')).rejects.toThrow(
      /Meka role resource escapes the role directory: \.\.\/escape-target\.md/,
    );
    // 逃逸是安全红线：绝不允许被降级成「跳过 + 告警」。
    expect(
      logging.warnings.some((warning) => warning.message.includes('missing Meka role prompt fragment')),
    ).toBe(false);
  });

  /**
   * T4 的负向控制：空 `path` 仍在读盘之前抛自己的错误。
   *
   * 注意这条断言钉的是**循环入口的契约校验**（`~:810-812`），它结构上位于 T4 的 try/catch **之外**
   * ⇒ 它不会被「删掉 T4」打破，只会在「有人把这条校验也改成容忍」时失败（例如把空 path 当 ENOENT
   * 跳过、或让它退化成读取角色目录本身）。
   */
  it('still rejects a fragment with an empty path before any tolerance applies (T4 negative control)', async () => {
    const root = await makeRoot('cindy-meka-t4-empty-path-');
    useSaga2();
    useCombatDevelopmentRow();
    environment.p4RootPath = root;

    await writeProject(
      root,
      projectFile(root, {
        builtinRoles: [
          combatDevelopmentSnapshot({
            promptFragments: [{ id: 'blank-fragment', path: '   ' }],
          }),
        ],
      }),
    );

    await expect(resolveMekaRuntimeConfig('saga2', 'combat-development')).rejects.toThrow(
      /Meka role prompt fragment blank-fragment has an empty path/,
    );
  });
});
