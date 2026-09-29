import { describe, expect, it, vi } from 'vitest';

import type { MekaProjectReference } from '../../../shared/meka-projects.js';
import type { MekaRuntimeConfig } from '../../meka-projects/runtimeConfig.js';
import { applyMekaRuntimeConfig as applyMekaRuntimeConfigImpl } from '../../meka-injection/index.js';
import {
  MEKA_PROJECT_REFERENCES_MARKER,
  mekaProjectReferencesPrompt,
} from '../../meka-injection/mekaPrompts.js';
import { MEKA_PROMPT_SEGMENT_ORDER } from '../../meka-injection/mekaInjectionTypes.js';
import type { MakerSessionCreateOpts } from '../sessionRequest.js';

/**
 * 特性化基线（characterization baseline）。
 *
 * 这些断言是在**未改动 `mekaRuntimeInjection.ts`** 的前提下捕获的现状快照：它把
 * `opts.userPrompt` 全文、`opts.vendorOptions` 全量键值与**键插入顺序**、
 * `opts.nativeSkillPluginPath` 与 `opts.nativeSkillRevision` 逐字节钉死，作为注入层
 * 重构（解析 → 计划 → 落地）的唯一「行为不变」证据。
 *
 * 平台注入面收敛后只剩三段（order 见 `mekaInjectionTypes.ts` 的 `MEKA_PROMPT_SEGMENT_ORDER`）：
 * 60 `meka.role-context` / 65 `meka.project-references` / 70 `meka.role-prompt`。原先的 10 档
 * 里有 7 档是战斗段，已随战斗业务与 workflow 机制整体退役 —— 本文件因此**删除了逐条战斗
 * 注入基线**（含战斗 resume 与战斗 vendorOptions 键序），只保留机制面（解析 / 落地 /
 * resume 短路 / 原子写入 / order 表 / 项目参考段）的基线。
 *
 * 约定：
 * - 只用显式字面量断言，不使用 snapshot（inline 或外部文件都不行），这样任何一处注入
 *   文本变化都会在 diff 里直接显示出来。
 * - 「文本变化」由整串 `toBe` 捕获；「顺序变化」由 order 表用例与段下标用例捕获
 *   （后者断言 60/65/70 三段标记在全文中的下标严格递增）。两者互不替代。
 * - 非战斗基线用例（新建会话 / resume 短路 / 非 Meka 零写入）钉的是**非战斗角色**的
 *   逐字节现状，一个字符都不得放松：它是 60/70 段序与 `vendorOptions` 键序的回归网。
 * - 文件末尾标有「重构后追加」的用例钉的不是旧快照，而是注入层重构**声明过**的新行为
 *   （非字符串 `userPrompt` 的显式报错、原子写入、frozen 路径的写入次序）。改动它们前
 *   先读 `docs/dev-rules/meka-injection-layer.md` 的 §7「与重构前的有意差异」。
 */

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

type ApplyDeps = NonNullable<Parameters<typeof applyMekaRuntimeConfigImpl>[1]>;

function applyMekaRuntimeConfig(opts: MakerSessionCreateOpts, deps: ApplyDeps = {}) {
  return applyMekaRuntimeConfigImpl(opts, {
    resolvePlatformSkills: async () => [],
    ...deps,
  });
}

// ————— fixtures —————

const SESSION_ID = 'session-1';
const WORKING_DIR = 'C:/Workspace/saga2/saga2_project';
const USER_PROMPT = 'USER PROMPT';
const RESUMED_USER_PROMPT = 'RESUMED USER PROMPT';
const NON_COMBAT_ROLE_PROMPT = 'SAGA2 server code lives behind MCPRouter as saga2-server.';

const REVISION_NON_COMBAT = 'a'.repeat(64);
const PLUGIN_PATH_NON_COMBAT = `C:/CindyMeka/meka-skill-snapshots/revisions/${REVISION_NON_COMBAT}/claude-plugin`;

const MCP_PROVIDER_IDS = ['mcp-router', 'project-agent', 'meka-design'];
const INLINE_MCP_CONFIGS = [
  { id: 'local-http', transport: 'http', url: 'https://example.invalid/mcp', enabled: true },
];

function baseOpts(overrides: Partial<MakerSessionCreateOpts> = {}): MakerSessionCreateOpts {
  return {
    id: SESSION_ID,
    agentKind: 'codex',
    model: 'gpt-test',
    workingDir: WORKING_DIR,
    workspaceKind: 'meka',
    mekaProjectId: 'saga2',
    mekaRoleId: 'general-development',
    ...overrides,
  };
}

function nonCombatSnapshot() {
  return {
    revision: REVISION_NON_COMBAT,
    pluginPath: PLUGIN_PATH_NON_COMBAT,
    files: [
      {
        relativePath: 'skills/remote-operation/SKILL.md',
        contentBase64: 'IyBSZW1vdGUgT3BlcmF0aW9u',
        digest: '1'.repeat(64),
      },
    ],
  };
}

/**
 * 空的项目参考集合：段（order 65）在空集合下**整段不渲染**，所以下面的逐字节基线用例的期望
 * 文本一个字符都不需要改。非空集合由文件末尾「project references」一组用例覆盖。
 */
const NO_PROJECT_REFERENCES: readonly MekaProjectReference[] = [];

function runtime(overrides: Partial<MekaRuntimeConfig> = {}): MekaRuntimeConfig {
  return {
    projectId: 'saga2',
    roleId: 'general-development',
    roleDisplayName: '通用开发',
    promptText: NON_COMBAT_ROLE_PROMPT,
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
    // `MekaRuntimeConfig.projectReferences` 是必填字段（2026-09-23 新增）。空集合 ⇒
    // `mekaProjectReferencesPrompt` 返回 null ⇒ 该段不入 plan ⇒ 既有逐字节基线不变。
    projectReferences: NO_PROJECT_REFERENCES,
    ...overrides,
  };
}

// ————— 期望注入文本（字面量，逐字节对应现状实现） —————

function roleContextSection(roleId: string, displayName: string): string {
  return [
    '[MEKA_ROLE_CONTEXT]',
    'projectId: saga2',
    `roleId: ${roleId}`,
    `displayName: ${displayName}`,
    '这是当前任务的权威角色绑定。不得根据打开的窗口、缓存文件或其它项目角色推断或替换当前角色。',
    '[/MEKA_ROLE_CONTEXT]',
  ].join('\n');
}

function expectedPrompt(sections: readonly string[]): string {
  return sections.join('\n\n');
}

function emptyResult() {
  return {
    didApply: false,
    mcpProviderIds: [],
    inlineMcpCount: 0,
    skillsCount: 0,
    platformSkillsCount: 0,
    skillSnapshot: null,
  };
}

const BASE_VENDOR_OPTIONS = {
  source: 'meka',
  mekaRuntimeResolved: true,
  mekaProjectId: 'saga2',
  mekaMcpProviderIds: MCP_PROVIDER_IDS,
  mekaMcpInlineConfigs: INLINE_MCP_CONFIGS,
  mekaPolicyProviderRefs: [],
};

describe('meka runtime injection baseline', () => {
  it('pins the new-session non-combat injection byte for byte', async () => {
    const opts = baseOpts({
      userPrompt: USER_PROMPT,
      vendorOptions: { onStderrLine: 'keep-me', orcaRole: 'lead' },
    });
    const snapshot = nonCombatSnapshot();
    const resolvePlatformSkills = vi.fn(async () => []);
    const materializeSkillSnapshot = vi.fn(async () => snapshot);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime()),
      resolvePlatformSkills,
      materializeSkillSnapshot,
    });

    expect(opts.userPrompt).toBe(
      expectedPrompt([
        roleContextSection('general-development', '通用开发'),
        NON_COMBAT_ROLE_PROMPT,
        USER_PROMPT,
      ]),
    );
    expect(opts.vendorOptions).toStrictEqual({
      onStderrLine: 'keep-me',
      orcaRole: 'lead',
      ...BASE_VENDOR_OPTIONS,
      mekaRoleId: 'general-development',
    });
    // I2：`vendorOptions` 的**键插入顺序**也是契约（下游按这些键裁决工具门禁）。调用方原有的
    // 两个键保持原位，bootstrap 补丁的 7 个键按 `mekaResolvePlan` 的 patch spread 次序追加。
    expect(Object.keys(opts.vendorOptions ?? {})).toEqual([
      'onStderrLine',
      'orcaRole',
      'source',
      'mekaRuntimeResolved',
      'mekaProjectId',
      'mekaRoleId',
      'mekaMcpProviderIds',
      'mekaMcpInlineConfigs',
      'mekaPolicyProviderRefs',
    ]);
    expect(opts.nativeSkillPluginPath).toBe(PLUGIN_PATH_NON_COMBAT);
    expect(opts.nativeSkillRevision).toBe(REVISION_NON_COMBAT);
    expect(result).toStrictEqual({
      didApply: true,
      mcpProviderIds: MCP_PROVIDER_IDS,
      inlineMcpCount: 1,
      skillsCount: 1,
      platformSkillsCount: 0,
      skillSnapshot: snapshot,
    });
    expect(resolvePlatformSkills).toHaveBeenCalledTimes(1);
    expect(materializeSkillSnapshot).toHaveBeenCalledWith(SESSION_ID, runtime().skills);
  });

  it('pins the resume short-circuit for an already-resolved non-combat session', async () => {
    const opts = baseOpts({
      userPrompt: RESUMED_USER_PROMPT,
      vendorOptions: { source: 'meka', mekaRuntimeResolved: true },
    });
    const keysBefore = Object.keys(opts);
    const vendorOptionsBefore = opts.vendorOptions;
    const snapshot = nonCombatSnapshot();
    const resolveRuntimeConfig = vi.fn();
    const materializeSkillSnapshot = vi.fn(async () => snapshot);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      materializeSkillSnapshot,
    });

    // resume 短路（I4）：不重解析项目/角色、不写任何 prompt 段、不写 vendorOptions 补丁。
    expect(opts.userPrompt).toBe(RESUMED_USER_PROMPT);
    expect(opts.vendorOptions).toStrictEqual({ source: 'meka', mekaRuntimeResolved: true });
    // 补丁为空 ⇒ 连 `opts.vendorOptions` 的对象引用都必须保持原样（不重写该字段）。
    expect(opts.vendorOptions).toBe(vendorOptionsBefore);
    expect(opts.nativeSkillPluginPath).toBe(PLUGIN_PATH_NON_COMBAT);
    expect(opts.nativeSkillRevision).toBe(REVISION_NON_COMBAT);
    expect(result).toStrictEqual({ ...emptyResult(), skillSnapshot: snapshot });
    expect(resolveRuntimeConfig).not.toHaveBeenCalled();
    // resume 分支只复用固定 revision，不重新选技能。
    expect(materializeSkillSnapshot).toHaveBeenCalledWith(SESSION_ID, []);
    // frozen 路径的写入次序是 `vendorOptions（空 ⇒ 不写）→ userPrompt（无段 ⇒ 不写）→ 原生技能`，
    // 因此新增的 opts 键恰好是这两个、且顺序固定（§7 D2.2）。该差异不可观测，这条断言只是
    // 把新实现的当前行为锁下来，防止后续重构再次静默改动。
    expect(Object.keys(opts).filter((key) => !keysBefore.includes(key))).toEqual([
      'nativeSkillPluginPath',
      'nativeSkillRevision',
    ]);
  });

  it('writes nothing for a non-Meka session', async () => {
    const opts = baseOpts({
      workspaceKind: 'project',
      mekaProjectId: null,
      mekaRoleId: null,
      userPrompt: USER_PROMPT,
    });
    const before = { ...opts };
    const resolveRuntimeConfig = vi.fn();
    const materializeSkillSnapshot = vi.fn();
    const resolvePlatformSkills = vi.fn();

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      materializeSkillSnapshot,
      resolvePlatformSkills,
    });

    expect(result).toStrictEqual(emptyResult());
    expect(opts.userPrompt).toBe(USER_PROMPT);
    expect(opts.vendorOptions).toBeUndefined();
    expect(opts.nativeSkillPluginPath).toBeUndefined();
    expect(opts.nativeSkillRevision).toBeUndefined();
    // 零写入：create opts 的任何字段都没有被新增或改写。
    expect({ ...opts }).toStrictEqual(before);
    expect(Object.keys(opts).filter((key) => /^(?:source|meka)/i.test(key))).toEqual([
      'mekaProjectId',
      'mekaRoleId',
    ]);
    expect(resolveRuntimeConfig).not.toHaveBeenCalled();
    expect(materializeSkillSnapshot).not.toHaveBeenCalled();
    expect(resolvePlatformSkills).not.toHaveBeenCalled();
  });

  // ————————————————————————————————————————————————————————————————
  // 以下 3 组用例由「Meka 注入层重构」追加：它们钉的是**重构后声明过的行为**，
  // 不是重构前的现状快照（见 `docs/dev-rules/meka-injection-layer.md` §7）。
  // ————————————————————————————————————————————————————————————————

  it.each([
    {
      name: 'new session',
      buildOpts: (): MakerSessionCreateOpts =>
        baseOpts({
          // 非字符串：IPC 是无类型边界，`readCreateSessionOpts` 不校验 `userPrompt`。
          userPrompt: 123 as unknown as string,
        }),
    },
    {
      name: 'resume short-circuit',
      buildOpts: (): MakerSessionCreateOpts =>
        baseOpts({
          userPrompt: 123 as unknown as string,
          vendorOptions: { source: 'meka', mekaRuntimeResolved: true },
        }),
    },
  ])('rejects a non-string userPrompt on a Meka session ($name)', async ({ buildOpts }) => {
    const opts = buildOpts();
    const vendorOptionsBefore = opts.vendorOptions;
    const keysBefore = Object.keys(opts);
    const resolveRuntimeConfig = vi.fn(async () => runtime());
    const materializeSkillSnapshot = vi.fn(async () => nonCombatSnapshot());

    const error = (await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      materializeSkillSnapshot,
    }).catch((thrown: unknown) => thrown)) as Error & { code?: unknown };

    // 重构前：`(opts.userPrompt ?? '').includes(marker)` 只在战斗角色会话里抛出**没有
    // 错误码**的 `TypeError`；新实现统一成显式 `INVALID_PARAMS`（§7 D2.1）。
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toBe(
      '[INVALID_PARAMS] Meka session userPrompt must be a string when provided',
    );
    // 校验发生在任何 I/O、任何 opts 写入之前。
    expect(resolveRuntimeConfig).not.toHaveBeenCalled();
    expect(materializeSkillSnapshot).not.toHaveBeenCalled();
    expect(opts.userPrompt).toBe(123);
    expect(opts.vendorOptions).toBe(vendorOptionsBefore);
    expect(Object.keys(opts)).toEqual(keysBefore);
    expect(opts.nativeSkillPluginPath).toBeUndefined();
    expect(opts.nativeSkillRevision).toBeUndefined();
  });

  it('does not reject a non-string userPrompt on a non-Meka session', async () => {
    const opts = baseOpts({
      workspaceKind: 'project',
      mekaProjectId: null,
      mekaRoleId: null,
      userPrompt: 123 as unknown as string,
    });
    const before = { ...opts };
    const resolveRuntimeConfig = vi.fn();
    const materializeSkillSnapshot = vi.fn();

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      materializeSkillSnapshot,
    });

    expect(result).toStrictEqual(emptyResult());
    // I6：参数校验只在确定是 Meka 之后发生，非 Meka 会话零写入、零抛错。
    expect({ ...opts }).toStrictEqual(before);
    expect(opts.userPrompt).toBe(123);
    expect(opts.vendorOptions).toBeUndefined();
    expect(resolveRuntimeConfig).not.toHaveBeenCalled();
    expect(materializeSkillSnapshot).not.toHaveBeenCalled();
  });

  // ————————————————————————————————————————————————————————————————
  // 第 15 组（D2.3）：解析／物化抛错时的写入语义 —— **原子**，不是重构前的增量写。
  //
  // 重构前是逐阶段就地写 opts：持久绑定一读到就写、resume 短路的 vendorOptions 补丁
  // 与早段 prompt 也在快照物化**之前**写，因此中途抛错时 opts 会留下"半个注入结果"。
  // 显式分层后所有 opts 写入都收敛到 `applyMekaInjection`，只有解析与物化全部成功才
  // 落地 ⇒ 抛错时 opts 与调用前逐字节一致。这是本层**有意**的语义变化（§7 D2.3），
  // 不是遗漏：恢复增量写等于把 I/O 与写入重新交织回去，会推翻解析／落地分层本身。
  //
  // 错误码与文案、以及返回值切面仍与重构前一致（抛错路径不返回任何 result）。
  // ————————————————————————————————————————————————————————————————
  it.each([
    {
      name: 'bootstrap runtime-config resolution throws (pre-refactor wrote the persisted binding first)',
      message: '[INVALID_PARAMS] Meka project/role configuration failed: runtime boom',
      buildOpts: () =>
        ({
          id: SESSION_ID,
          agentKind: 'codex',
          model: 'gpt-test',
          workingDir: WORKING_DIR,
          userPrompt: USER_PROMPT,
        }) as MakerSessionCreateOpts,
      buildDeps: (): ApplyDeps => ({
        readPersistedSession: async () => ({
          workspaceKind: 'meka',
          mekaProjectId: 'saga2',
          mekaRoleId: 'general-development',
          // `mekaRole` 是**遗留的四角色列**（planner/artist/programmer/tester），
          // 与 `mekaRoleId`（今天的角色 id）不是同一个东西。
          mekaRole: 'programmer',
        }),
        resolveRuntimeConfig: async () => {
          throw new Error('runtime boom');
        },
      }),
      // 重构前这几个键会被写进 opts（原实现读到持久行即 `opts.mekaProjectId = …`）。
      absentKeys: ['workspaceKind', 'mekaProjectId', 'mekaRoleId', 'mekaRole'],
    },
    {
      name: 'bootstrap snapshot materialization throws',
      message: '[INVALID_PARAMS] Meka native Skill snapshot failed: snapshot boom',
      buildOpts: () => baseOpts({ userPrompt: USER_PROMPT }),
      buildDeps: (): ApplyDeps => ({
        resolveRuntimeConfig: async () => runtime(),
        materializeSkillSnapshot: async () => {
          throw new Error('snapshot boom');
        },
      }),
      absentKeys: [],
    },
    {
      name: 'frozen short-circuit snapshot materialization throws (pre-refactor wrote patches and prompts first)',
      message: '[INVALID_PARAMS] Meka native Skill snapshot failed: snapshot boom',
      buildOpts: () =>
        baseOpts({
          userPrompt: RESUMED_USER_PROMPT,
          vendorOptions: { source: 'meka', mekaRuntimeResolved: true },
        }),
      buildDeps: (): ApplyDeps => ({
        materializeSkillSnapshot: async () => {
          throw new Error('snapshot boom');
        },
      }),
      // 重构前这条路径在物化**之前**已写：vendorOptions 的技能 ID 补丁、exec-mode 补丁，
      // 以及 TARGET / PROJECT_PATHS / SERVER_TARGET 三段 prompt。收敛后 frozen 路径不写
      // 任何段、不写任何补丁，所以物化失败时整篇 prompt 仍是调用方原值。
      absentKeys: [],
      assertExtra: (opts: MakerSessionCreateOpts) => {
        expect(opts.userPrompt).toBe(RESUMED_USER_PROMPT);
        expect(opts.vendorOptions).toStrictEqual({ source: 'meka', mekaRuntimeResolved: true });
      },
    },
  ])(
    'leaves create opts untouched when Meka injection throws ($name)',
    async ({ buildOpts, buildDeps, message, absentKeys, assertExtra }) => {
      const opts = buildOpts();
      const keysBefore = Object.keys(opts);
      const vendorOptionsBefore = opts.vendorOptions;
      const vendorOptionsKeysBefore = Object.keys(opts.vendorOptions ?? {});
      const optsJsonBefore = JSON.stringify(opts);
      const deps = buildDeps();

      const error = (await applyMekaRuntimeConfig(opts, deps).catch(
        (thrown: unknown) => thrown,
      )) as Error & { code?: unknown };

      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe('INVALID_PARAMS');
      expect(error.message).toBe(message);
      // D2.3：抛错时零写入 —— 新增键为空、键序不变、vendorOptions 保持对象引用、
      // 调用方原始 prompt 未被追加任何注入段。
      expect(Object.keys(opts)).toEqual(keysBefore);
      expect(JSON.stringify(opts)).toBe(optsJsonBefore);
      expect(opts.vendorOptions).toBe(vendorOptionsBefore);
      expect(Object.keys(opts.vendorOptions ?? {})).toEqual(vendorOptionsKeysBefore);
      for (const key of absentKeys) {
        expect(Object.prototype.hasOwnProperty.call(opts, key)).toBe(false);
      }
      assertExtra?.(opts);
    },
  );
});

// ————————————————————————————————————————————————————————————————
// 第 16 组（order 65）：项目参考文件清单段 `meka.project-references`。
//
// 这一组**不是**上面的逐字节基线（那个基线一个字符都没动，靠 `projectReferences: []`
// 让新段整段不渲染）。它钉的是 2026-09-23 新声明的注入契约：
//   · 文本唯一来源 = `mekaPrompts.ts` 的 `mekaProjectReferencesPrompt`（测试与实现共用，
//     绝不在这里另抄一份段文本）；
//   · 空集合 ⇒ 整段不入 plan；
//   · order 65（`[MEKA_ROLE_CONTEXT]` 之后、`meka.role-prompt` 之前），60/65/70 三档原地未重排；
//   · 只投递「作用范围 + 绝对路径 + 描述」，**正文绝不进 prompt**（负向断言）；
//   · 与 60/70 同进同出：frozen/resume 短路（`mekaRuntimeResolved === true`）不注入该段。
// 这一组是 §7 **D2.4** 新声明行为的正向证据（D2.4 的门禁列指向本文件），它**没有**推翻上面的
// 逐字节基线：那些基线的期望文本一个字符都没改，靠 `projectReferences: []` 让新段整段不渲染。
// ————————————————————————————————————————————————————————————————

/** 夹具里刻意混入中英文路径与描述；正文标志串只用于负向断言，绝不应出现在 prompt 里。 */
const REFERENCE_BODY_MARKER = 'REFERENCE-BODY-MUST-NOT-BE-INLINED-8f3a1';
const PROJECT_REFERENCES: readonly MekaProjectReference[] = [
  {
    scope: '',
    path: 'C:/Workspace/saga2/saga2_project/AGENTS.md',
    description: '项目 Agent 入口，说明四个 P4 目录结构与规则索引。',
    itemType: 'agents-md',
  },
  {
    scope: 'saga2_design',
    path: 'C:/Workspace/saga2/saga2_project/saga2_design/AGENTS.md',
    description: 'Design knowledge base entry with the mandatory onboarding protocol.',
    itemType: 'agents-md',
  },
  {
    scope: 'saga2_json/tables',
    path: 'C:/Workspace/saga2/saga2_project/saga2_json/tables/rule.md',
    description: '表结构校验规则（作用范围仅覆盖 saga2_json/tables 及其子目录）。',
    itemType: 'rule',
  },
];

/**
 * 「段不在场」的负向断言用闭合 marker 指纹，**从共享构建器的输出里取**（不在测试里另抄一份
 * 段文本）：只要该段被渲染，闭合 marker 必然出现。
 */
const PROJECT_REFERENCES_CLOSING_MARKER = mekaProjectReferencesPrompt(
  PROJECT_REFERENCES,
)!.split('\n').at(-1)!;

describe('meka project references segment (order 65)', () => {
  it('appends the reference segment verbatim for a non-empty reference set', async () => {
    const opts = baseOpts({ userPrompt: USER_PROMPT });
    const referencesWithBody = PROJECT_REFERENCES.map((reference) => ({
      ...reference,
      // 正文标志串只存在于「被引用的文件」里。段构建器拿不到正文，所以它不可能出现在 prompt 中。
      body: REFERENCE_BODY_MARKER,
    }));

    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () =>
        runtime({ projectReferences: referencesWithBody }),
      ),
      materializeSkillSnapshot: vi.fn(async () => nonCombatSnapshot()),
    });

    const section = mekaProjectReferencesPrompt(PROJECT_REFERENCES);
    expect(section).not.toBeNull();
    // 逐字等于共享常量构建器的输出（不在这里另抄一份段文本）。
    expect(opts.userPrompt).toContain(section!);
    expect(opts.userPrompt).toBe(
      expectedPrompt([
        roleContextSection('general-development', '通用开发'),
        section!,
        NON_COMBAT_ROLE_PROMPT,
        USER_PROMPT,
      ]),
    );
    // 6 + N 行：第 1 行 marker、第 2–3 行两条独立规则句、第 4 行格式说明、
    // 随后 N 行条目、最后一行禁令，末行闭合 marker；无尾随换行。
    const lines = section!.split('\n');
    expect(lines).toHaveLength(6 + PROJECT_REFERENCES.length);
    expect(lines[0]).toBe(MEKA_PROJECT_REFERENCES_MARKER);
    expect(lines.at(-1)).toBe('[/MEKA_PROJECT_REFERENCES]');
    expect(section!.endsWith('\n')).toBe(false);
    // N 行条目逐行对应输入顺序（含中英文路径与描述）。
    expect(lines.slice(4, 4 + PROJECT_REFERENCES.length)).toEqual([
      `- (项目根) | ${PROJECT_REFERENCES[0]!.path} | ${PROJECT_REFERENCES[0]!.description}`,
      `- ${PROJECT_REFERENCES[1]!.scope} | ${PROJECT_REFERENCES[1]!.path} | ${PROJECT_REFERENCES[1]!.description}`,
      `- ${PROJECT_REFERENCES[2]!.scope} | ${PROJECT_REFERENCES[2]!.path} | ${PROJECT_REFERENCES[2]!.description}`,
    ]);
  });

  it('pins the segment prose body as a contract, so any wording change must update this test too', () => {
    // 本组其它用例都从共享构建器 `mekaProjectReferencesPrompt()` 取段文本（自洽）：构建器里的
    // **散文**被改写时它们全都跟着变绿，没有一个会红。所以这里把散文正文**逐字写死**——marker 行、
    // 两条独立成行的规则句、格式行、闭合前的禁止句、闭合 marker，即除 N 条条目以外的全部行。
    //
    // 刻意的写法约束：字面量**不从**构建器输出推导，也不抽成共享常量（那又变成自洽）。散文是注入
    // 契约的一部分，改字必须同时改这里，改不了就是契约变更。
    const sectionLines = mekaProjectReferencesPrompt(PROJECT_REFERENCES)!.split('\n');
    // 前 4 行：marker、两条规则句（各自独立成行，之间恰好一个 `\n`，不是排版折行）、条目格式行。
    const pinnedOpeningProse = [
      '[MEKA_PROJECT_REFERENCES]',
      '项目参考文件按作用范围列出。当你的工作涉及某个作用范围内（该目录及其子目录）的内容时，',
      '必须先用原生文件读取工具（read）完整读取该范围内列出的文件，再动手；不要凭记忆、缓存或旧版内容替代。',
      '每条格式：作用范围 | 绝对路径 | 用途',
    ];
    // 末 2 行：闭合前的禁止句（渐进披露的负向约束）+ 闭合 marker。
    const pinnedClosingProse = [
      '不要读取、枚举或发现本清单未列出的 AGENTS.md / .cursorrules / rules.md；技能正文（SKILL.md）按技能目录正常按需读取；不要根据项目根目录二次拼接或猜测其它路径。',
      '[/MEKA_PROJECT_REFERENCES]',
    ];

    expect(sectionLines.slice(0, 4)).toEqual(pinnedOpeningProse);
    expect(sectionLines.slice(-2)).toEqual(pinnedClosingProse);
    // 被断言的对象确实是段构建器的真实输出：散文 + N 条条目 + 散文，总行数 6 + N。
    expect(sectionLines).toHaveLength(4 + PROJECT_REFERENCES.length + 2);
  });

  it('places the reference segment after the role context and before the role prompt', async () => {
    const opts = baseOpts({ userPrompt: USER_PROMPT });

    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime({ projectReferences: PROJECT_REFERENCES })),
      materializeSkillSnapshot: vi.fn(async () => nonCombatSnapshot()),
    });

    const prompt = opts.userPrompt ?? '';
    const roleContextIndex = prompt.indexOf('[MEKA_ROLE_CONTEXT]');
    const referencesIndex = prompt.indexOf(MEKA_PROJECT_REFERENCES_MARKER);
    const rolePromptIndex = prompt.indexOf(NON_COMBAT_ROLE_PROMPT);
    const userPromptIndex = prompt.indexOf(USER_PROMPT);

    for (const index of [roleContextIndex, referencesIndex, rolePromptIndex, userPromptIndex]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    // order 60 < 65 < 70 的实际效果。
    expect(roleContextIndex).toBeLessThan(referencesIndex);
    expect(referencesIndex).toBeLessThan(rolePromptIndex);
    expect(rolePromptIndex).toBeLessThan(userPromptIndex);
    // 该段只出现一次。
    expect(prompt.split(MEKA_PROJECT_REFERENCES_MARKER).length - 1).toBe(1);
  });

  it('does not render the segment at all for an empty reference set', async () => {
    const opts = baseOpts({ userPrompt: USER_PROMPT });

    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime({ projectReferences: [] })),
      materializeSkillSnapshot: vi.fn(async () => nonCombatSnapshot()),
    });

    expect(mekaProjectReferencesPrompt([])).toBeNull();
    expect(opts.userPrompt).not.toContain(MEKA_PROJECT_REFERENCES_MARKER);
    expect(opts.userPrompt).not.toContain(PROJECT_REFERENCES_CLOSING_MARKER);
    // 其余段落不受影响（与既有基线一致）。
    expect(opts.userPrompt).toBe(
      expectedPrompt([
        roleContextSection('general-development', '通用开发'),
        NON_COMBAT_ROLE_PROMPT,
        USER_PROMPT,
      ]),
    );
  });

  it('renders the project root label for an empty scope instead of an empty field', async () => {
    const references: readonly MekaProjectReference[] = [
      {
        scope: '',
        path: 'C:/Workspace/saga2/saga2_project/AGENTS.md',
        description: '项目根入口。',
        itemType: 'agents-md',
      },
    ];

    const section = mekaProjectReferencesPrompt(references);
    expect(section).not.toBeNull();
    expect(section).toContain('- (项目根) | C:/Workspace/saga2/saga2_project/AGENTS.md | 项目根入口。');

    const opts = baseOpts({ userPrompt: USER_PROMPT });
    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime({ projectReferences: references })),
      materializeSkillSnapshot: vi.fn(async () => nonCombatSnapshot()),
    });
    expect(opts.userPrompt).toContain('(项目根)');
  });

  it('renders references in input order and never reorders or de-duplicates them', async () => {
    // 乱序（且带一个重复条目）的输入：渲染必须**逐字保持输入顺序**，排序是生产方
    // （`runtimeConfig.ts` 的 `compareProjectReferences`）的职责，本函数只渲染。
    const shuffled: readonly MekaProjectReference[] = [
      PROJECT_REFERENCES[2]!,
      PROJECT_REFERENCES[0]!,
      PROJECT_REFERENCES[1]!,
      PROJECT_REFERENCES[2]!,
    ];

    const section = mekaProjectReferencesPrompt(shuffled);
    expect(section).not.toBeNull();
    const lines = section!.split('\n');
    expect(lines).toHaveLength(6 + shuffled.length);
    expect(lines.slice(4, 4 + shuffled.length)).toEqual(
      shuffled.map(
        (reference) =>
          `- ${reference.scope === '' ? '(项目根)' : reference.scope} | ${reference.path} | ${reference.description}`,
      ),
    );
    // 重复条目既不去重也不换位：第 1 条与第 4 条逐字相同。
    expect(lines[4]).toBe(lines[7]);

    // 端到端：注入层把 `runtime.projectReferences` **原样**交给段构建器（若它自己排序或去重，
    // 这里就匹配不上按输入顺序构造的段）。
    const opts = baseOpts({ userPrompt: USER_PROMPT });
    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime({ projectReferences: shuffled })),
      materializeSkillSnapshot: vi.fn(async () => nonCombatSnapshot()),
    });
    expect(opts.userPrompt).toContain(section!);
  });

  it('never inlines the referenced file bodies', async () => {
    const opts = baseOpts({ userPrompt: USER_PROMPT });
    const referencesWithBody = PROJECT_REFERENCES.map((reference) => ({
      ...reference,
      body: REFERENCE_BODY_MARKER,
    }));

    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () =>
        runtime({ projectReferences: referencesWithBody }),
      ),
      materializeSkillSnapshot: vi.fn(async () => nonCombatSnapshot()),
    });

    // 渐进披露的硬约束：只给「作用范围 + 绝对路径 + 描述」，正文按需读取。
    expect(opts.userPrompt).toContain(MEKA_PROJECT_REFERENCES_MARKER);
    expect(opts.userPrompt).not.toContain(REFERENCE_BODY_MARKER);
    // 段内也没有任何条目长到能装下正文的迹象：每个条目行都等于「scope | path | description」。
    const section = mekaProjectReferencesPrompt(PROJECT_REFERENCES) ?? '';
    for (const line of section.split('\n').filter((entry) => entry.startsWith('- '))) {
      expect(line.split(' | ')).toHaveLength(3);
    }
  });

  it('pins the frozen three-row order table and keeps 60/65/70 in place', () => {
    // 战斗段的 7 档（10/20/30/35/40/50/80）已随 workflow 机制删除。剩下的三档**数值原地冻结**：
    // 删除相邻档不得触发重排，新增段只能插空档。
    expect(MEKA_PROMPT_SEGMENT_ORDER).toEqual({
      'meka.role-context': 60,
      'meka.project-references': 65,
      'meka.role-prompt': 70,
    });
    const orders = Object.values(MEKA_PROMPT_SEGMENT_ORDER);
    expect(orders).toEqual([...orders].sort((left, right) => left - right));
    expect(new Set(orders).size).toBe(orders.length);
    // 65 正好落在 60 与 70 之间：这是它唯一合法的位置。
    expect(orders.indexOf(65)).toBe(orders.indexOf(60) + 1);
    expect(orders.indexOf(65)).toBe(orders.indexOf(70) - 1);
  });

  it('never injects the reference segment on the frozen/resume short-circuit', async () => {
    // 非战斗 frozen 路径整篇就是调用方原始 prompt（没有 60/70，自然也没有 65）。
    const opts = baseOpts({
      userPrompt: RESUMED_USER_PROMPT,
      vendorOptions: { source: 'meka', mekaRuntimeResolved: true },
    });
    const resolveRuntimeConfig = vi.fn();

    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      materializeSkillSnapshot: vi.fn(async () => nonCombatSnapshot()),
    });

    // I4：resume 不重解析项目/角色 ⇒ 60 / 65 / 70 三段同进同出。
    expect(resolveRuntimeConfig).not.toHaveBeenCalled();
    expect(opts.userPrompt).not.toContain(MEKA_PROJECT_REFERENCES_MARKER);
    expect(opts.userPrompt).not.toContain(PROJECT_REFERENCES_CLOSING_MARKER);
    expect(opts.userPrompt).not.toContain('[MEKA_ROLE_CONTEXT]');
    expect(opts.userPrompt).not.toContain(NON_COMBAT_ROLE_PROMPT);
    expect(opts.userPrompt).toBe(RESUMED_USER_PROMPT);
  });
});
