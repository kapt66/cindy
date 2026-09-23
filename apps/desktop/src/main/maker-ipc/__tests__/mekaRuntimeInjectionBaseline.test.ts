import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { MekaProjectReference } from '../../../shared/meka-projects.js';
import type { MekaRuntimeConfig } from '../../meka-projects/runtimeConfig.js';
import { applyMekaRuntimeConfig as applyMekaRuntimeConfigImpl } from '../../meka-injection/index.js';
import {
  MEKA_PROJECT_REFERENCES_MARKER,
  mekaProjectReferencesPrompt,
} from '../../meka-injection/mekaCombatPrompts.js';
import { MEKA_PROMPT_SEGMENT_ORDER } from '../../meka-injection/mekaInjectionTypes.js';
import type { MakerSessionCreateOpts } from '../sessionRequest.js';

/**
 * 特性化基线（characterization baseline）。
 *
 * 这些断言是在**未改动 `mekaRuntimeInjection.ts`** 的前提下捕获的现状快照：它把
 * `opts.userPrompt` 全文、`opts.vendorOptions` 全量键值、`opts.nativeSkillPluginPath`
 * 与 `opts.nativeSkillRevision` 逐字节钉死，作为后续注入层重构（解析 → 计划 → 落地）
 * 的唯一「行为不变」证据。
 *
 * 约定：
 * - 只用显式字面量断言，不使用 snapshot（inline 或外部文件都不行），这样任何一处注入
 *   文本变化都会在 diff 里直接显示出来。
 * - 「文本变化」由整串 `toBe` 捕获；「顺序变化」由本文件末尾的显式 order 用例捕获
 *   （它单独断言各段标记在全文中的下标严格递增且顺序与基线一致）。两者互不替代。
 * - prompt 里的路径行必须与实现同样按当前平台解析（`path.resolve` / `path.join`），
 *   否则 Windows 与 Linux 会得出不同的分隔符；标签与顺序仍是字面量。
 *
 * **重构后追加的用例**：本文件原有的 10 条用例是重构前的特性化快照，一个字符都不得改；
 * 文件末尾标有「重构后追加」的用例钉的不是旧快照，而是注入层重构**声明过**的新行为
 * （非字符串 `userPrompt` 的显式报错、新实现的 opts 键插入顺序、frozen 路径的
 * `vendorOptions` 键序缺口）。改动它们前先读
 * `docs/dev-rules/meka-injection-layer.md` 的 §7「与重构前的有意差异」。
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
const WORKER_PROMPT = 'WORKER PROMPT';
const NON_COMBAT_ROLE_PROMPT = 'SAGA2 server code lives behind MCPRouter as saga2-server.';
const COMBAT_ROLE_PROMPT = '战斗开发角色正文：严格按总控 Skill 执行。';
const COMBAT_USER_PROMPT_WITH_ID = '技能 ID：1019。检查当前伤害目标。';
const COMBAT_USER_PROMPT_AMBIGUOUS = '对比技能 1019 和技能 1010。';
const SERVER_TARGET = { remoteHostId: 'mcpr:server-1', workerAgent: 'claude-code' as const };

const REVISION_NON_COMBAT = 'a'.repeat(64);
const REVISION_COMBAT = 'e'.repeat(64);
const PLUGIN_PATH_NON_COMBAT = `C:/CindyMeka/meka-skill-snapshots/revisions/${REVISION_NON_COMBAT}/claude-plugin`;
const PLUGIN_PATH_COMBAT = `C:/CindyMeka/meka-skill-snapshots/revisions/${REVISION_COMBAT}/claude-plugin`;

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

function combatSnapshot() {
  return {
    revision: REVISION_COMBAT,
    pluginPath: PLUGIN_PATH_COMBAT,
    files: [
      {
        relativePath: 'skills/combat-skill-configuration/SKILL.md',
        contentBase64: 'IyBDb21iYXQgQ29udHJvbGxlcgoKU1RBVFVTX1RIRU5fVEFSR0VUX0VYUE9SVA==',
        digest: '5'.repeat(64),
      },
    ],
  };
}

/**
 * 空的项目参考集合：新增段（order 65）在空集合下**整段不渲染**，所以下面 10 条逐字节基线
 * 用例的期望文本一个字符都不需要改。非空集合由文件末尾「project references」一组用例覆盖。
 */
const NO_PROJECT_REFERENCES: readonly MekaProjectReference[] = [];

function runtime(overrides: Partial<MekaRuntimeConfig> = {}): MekaRuntimeConfig {
  return {
    projectId: 'saga2',
    roleId: 'general-development',
    roleDisplayName: '通用开发',
    workflowRecoveredFromRole: false,
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

function combatRuntime(): MekaRuntimeConfig {
  return runtime({
    roleId: 'combat-development',
    roleDisplayName: '战斗开发',
    workflow: 'saga2-combat-development-v1',
    promptText: COMBAT_ROLE_PROMPT,
    skills: [],
  });
}

// ————— 期望注入文本（字面量，逐字节对应现状实现） —————

function combatControllerSkillSection(pluginPath: string): string {
  const frozenSkillPath = path.join(
    pluginPath,
    'skills',
    'combat-skill-configuration',
    'SKILL.md',
  );
  return [
    '[SAGA2_COMBAT_CONTROLLER_SKILL]',
    '当前任务冻结的唯一战斗总控 Skill 正文在下面这个文件里（Host 已按任务 revision 冻结，不要修改它）：',
    frozenSkillPath,
    '执行前必须先把该文件完整读完，再严格按正文执行。不要读取、枚举或发现任何其它 SKILL.md，也不要用记忆、缓存或旧版快照里的正文替代它。',
    '[/SAGA2_COMBAT_CONTROLLER_SKILL]',
  ].join('\n');
}

function combatServerTargetSection(
  target: { remoteHostId: string; workerAgent: 'claude-code' | 'codex' } | null,
): string {
  return [
    '[SAGA2_COMBAT_SERVER_TARGET]',
    ...(target
      ? [
          'status: ready',
          `serverRemoteHostId: ${target.remoteHostId}`,
          `serverWorkerAgent: ${target.workerAgent}`,
          '以上值是 Host 对当前 SAGA2 项目绑定、在线状态、实例 Agent 类型和 capability hello 核验后的唯一服务器 Worker 目标。create_worker 的 remote_host_id 和 agent 必须分别原样使用。',
        ]
      : [
          'status: unavailable',
          'Host 未找到唯一且 capability-ready 的 SAGA2 服务器 Worker 目标。禁止调用 get_workspace_info 或自行拼接 mcpr 实例 ID；不得派发或绕过服务器核查。',
        ]),
    '[/SAGA2_COMBAT_SERVER_TARGET]',
  ].join('\n');
}

function combatProjectPathsSection(workingDir: string): string {
  const projectRoot = path.resolve(workingDir);
  const unityClientRoot = path.join(projectRoot, 'saga2_unity');
  const unityAgentsPath = path.join(unityClientRoot, 'AGENTS.md');
  const legacyModuleProtocolCodecPath = path.join(
    unityClientRoot,
    'Assets',
    'Editor',
    'SkillEditor',
    'Common',
    'Editor',
    'Exporter',
    'Execute',
    'Impl',
    'Type',
    'SkillModuleProtocolCodec.cs',
  );
  const { moduleEditorSkillPath, damageEncodingRulePath } = combatProjectRefPaths(workingDir);
  return [
    '[SAGA2_PROJECT_PATHS]',
    `projectRoot: ${projectRoot}`,
    `unityClientRoot: ${unityClientRoot}`,
    `legacyModuleJsonTempRoot: ${os.tmpdir()}`,
    `unityAgentsPath: ${unityAgentsPath}`,
    `legacyModuleProtocolCodecPath: ${legacyModuleProtocolCodecPath}`,
    `moduleEditorSkillPath: ${moduleEditorSkillPath}`,
    `damageEncodingRulePath: ${damageEncodingRulePath}`,
    `unityAgentsReadCommand: Get-Content -LiteralPath '${unityAgentsPath}' -Encoding UTF8`,
    `legacyModuleProtocolCodecReadCommand: Get-Content -LiteralPath '${legacyModuleProtocolCodecPath}' -Encoding UTF8`,
    `moduleEditorSkillReadCommand: Get-Content -LiteralPath '${moduleEditorSkillPath}' -Encoding UTF8`,
    `damageEncodingRuleReadCommand: Get-Content -LiteralPath '${damageEncodingRulePath}' -Encoding UTF8`,
    '以上路径和读取命令由 Host 从当前任务 workingDir 解析。四条注入的参考文件必须优先用原生文件读取工具（read）读取：它按 UTF-8 解码，不会把 CJK 正文读成乱码；仅当原生工具不可用时才改用 Shell，并逐字复制对应 ReadCommand（已带 -Encoding UTF8，不得删改或省略编码参数）。读取两个权威文件时不得根据 projectRoot 二次拼接、缩短或猜测另一套 SAGA2 路径；Unity CLI status 返回的 projectPath 必须与 unityClientRoot 一致。start_team 和 create_worker 不需要工作区发现，禁止调用 get_workspace_info。',
    '[/SAGA2_PROJECT_PATHS]',
  ].join('\n');
}

/** 与实现同一套规则：`projectRoot` 上移判定 + 两条项目参考路径（含 CJK 目录逐字）。 */
function combatProjectRefPaths(workingDir: string): {
  moduleEditorSkillPath: string;
  damageEncodingRulePath: string;
} {
  const resolved = path.resolve(workingDir);
  const projectRoot =
    path.basename(resolved).toLowerCase() === 'saga2_unity' ? path.dirname(resolved) : resolved;
  const unityClientRoot =
    path.basename(resolved).toLowerCase() === 'saga2_unity'
      ? resolved
      : path.join(resolved, 'saga2_unity');
  return {
    moduleEditorSkillPath: path.join(
      unityClientRoot,
      '.agents',
      'skills',
      'editor-skill-editor-module',
      'SKILL.md',
    ),
    damageEncodingRulePath: path.join(
      projectRoot,
      'saga2_design',
      'planning',
      '04-职能组-functional-groups',
      '战斗策划组-combat-planning',
      '专业规则-rules',
      'ModuleDesignKnowledge.md',
    ),
  };
}

/** 只读 Unity 查询命令白名单（Host 注入，`mekaCombatReadOnlyUnityCommands`）。 */
const COMBAT_READ_ONLY_UNITY_COMMANDS = [
  'legacy_module_query_nodes',
  'legacy_module_audit_coverage',
];

/** 漏斗会在每个 patch 里同时写入请求范围键（顺序与实现一致，键序断言依赖它）。 */
function combatScopeVendorOptions(
  scope: 'single-skill' | 'table-scope',
  state: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mekaCombatRequestScope: scope,
    mekaCombatRequestScopeState: state,
    mekaCombatScopeSelection: undefined,
    mekaCombatScopeSourceTables: undefined,
    mekaCombatScopeSkillIds: undefined,
    mekaCombatScopeApproved: false,
    // 口径统一：表范围、以及「目标已由用户确认」的单技能，证据依据都是项目参考
    // （前提是参考已注入 —— 本文件用到的 workingDir 都可解析，故恒成立）。
    mekaCombatEvidenceBasis:
      scope === 'table-scope' || state === 'confirmed' ? 'project-reference' : undefined,
    ...extras,
  };
}

function combatTargetSection(skillId: string): string {
  return [
    '[SAGA2_COMBAT_TARGET]',
    `targetSkillId: ${skillId}`,
    '这是当前任务由用户确认并由 Host 绑定的唯一技能 ID。续聊和 Worker 回传不得清空、替换或重新推断它；最终结果必须原样使用该值。',
    '[/SAGA2_COMBAT_TARGET]',
  ].join('\n');
}

function combatExecutionAuthorizationSection(): string {
  return [
    '[SAGA2_COMBAT_EXECUTION_AUTHORIZATION]',
    '用户明确要求实施战斗技能或关卡配置时，本轮请求已经包含实施授权。内部完成方案、字段和证据检查后直接执行，不要要求额外的方案审批卡或二次确认。',
    'Host 仍会强制 P4 工作区、服务器只读、范围边界、禁止手改 JSON/.asset，以及只通过 Meka Unity 官方 Unity CLI；依赖故障要修复工具链后继续。',
    '[/SAGA2_COMBAT_EXECUTION_AUTHORIZATION]',
  ].join('\n');
}

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

function combatServerWorkerSection(): string {
  return [
    '[SAGA2_COMBAT_REMOTE_SERVER_WORKER]',
    '当前任务是 MCPR 服务器仓 Worker，不是本地战斗开发 Lead。跳过本地主任务的 P4/Meka Unity CLI 启动门禁。',
    '先读取远端仓库 AGENTS.md，只读核查当前 HEAD 的现有服务器能力；不要加载战斗策划服务器 Skill。',
    '整个任务永久只读：只允许文件读取和 Host 可证明只读的命令；禁止修改文件、创建或切换分支、改 Excel、生成文件或调用业务/项目 MCP。',
    '命令只使用单一 git show、git grep、git status 或 git diff 只读查询；不要使用 Read、rg、变量、管道、重定向、命令串联或脚本包装，也不要读取 Claude 自动保存的超长工具输出。需要多项证据时逐条调用并直接消费当前 Git 命令回执。',
    '只读查询不设次数上限；证据不足时可继续逐条查询，但不要重复同一项查询。默认取证顺序固定为：先 `git show HEAD:AGENTS.md` 读取规则，再用 `git show -s --format=%H HEAD` 固定 HEAD，然后用 `git grep -l -E <精确符号表达式> HEAD -- internal/battle` 只取得当前 HEAD 中的真实路径；随后对这些真实路径分别使用 `git grep -n -C 24 -E <精确符号表达式> HEAD -- <path>` 读取直接消费者附近的小段上下文，不要用 `git show` 打开大型实现文件。所有 `git grep` 都必须显式写 `HEAD`。查询只包含 Lead 任务列出的精确 typ 数字、枚举名和数据函数名，禁止加入 `time`、`target`、`skill`、`damage`、`next`、`trigger` 或中文描述等通用词；没有真实路径时不得猜文件名。禁止先用空查询读取 AGENTS，禁止在命中具体消费者前读取架构总览或通用生命周期文件。',
    'Lead 已在任务正文提供 [SAGA2_MODULE_FIRST] 的目标技能老版导出、模块证据和原子能力矩阵；只核查其中依赖当前服务器解释的窄语义。没有完整专用函数不等于模块组合不支持：模块图已覆盖的能力必须按 supported 处理，只有具体原子语义缺少运行时消费者时才返回 unsupported，证据冲突或读取失败才返回 uncertain。',
    '结束时必须把 serverCapabilityReport 作为唯一一次完整终态回复输出：targetSkillId（与 Lead 绑定值一致的正整数）、supportStatus、readOnlyConfirmed、repository、head、codeEvidence、capabilityGap、programmerAction、affectedSurfaces、validationSuggestion。不要搜索或重试 orca_worker_bridge；Orca 会把终态回复自动桥接给 Lead。',
    '报告字段类型必须严格固定：codeEvidence、affectedSurfaces 为数组；capabilityGap、programmerAction、validationSuggestion 为非空字符串。即使没有能力缺口，capabilityGap 也必须写字符串（例如“无服务器能力缺口；仍需按建议完成验证”），不得写 []、null 或省略。',
    'head 必须是当前仓库真实 Git SHA。必须完成核查并返回最终报告；不得用“未取得回执”、占位值或普通进度消息代替。',
    '若能力不支持或证据不足，supportStatus 使用 unsupported 或 uncertain，并明确要求 Lead 停止当前实现、把简短报告交给服务器程序。',
    '[/SAGA2_COMBAT_REMOTE_SERVER_WORKER]',
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
    workflow: null,
    workflowRecoveredFromRole: false,
    combatEnvironmentReady: null,
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
    const resolveCombatServerTarget = vi.fn(async () => SERVER_TARGET);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime()),
      resolvePlatformSkills,
      materializeSkillSnapshot,
      resolveCombatServerTarget,
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
    expect(opts.nativeSkillPluginPath).toBe(PLUGIN_PATH_NON_COMBAT);
    expect(opts.nativeSkillRevision).toBe(REVISION_NON_COMBAT);
    expect(result).toStrictEqual({
      didApply: true,
      mcpProviderIds: MCP_PROVIDER_IDS,
      inlineMcpCount: 1,
      skillsCount: 1,
      platformSkillsCount: 0,
      skillSnapshot: snapshot,
      workflow: null,
      workflowRecoveredFromRole: false,
      combatEnvironmentReady: null,
    });
    expect(resolvePlatformSkills).toHaveBeenCalledTimes(1);
    expect(resolveCombatServerTarget).not.toHaveBeenCalled();
    expect(materializeSkillSnapshot).toHaveBeenCalledWith(SESSION_ID, runtime().skills);
  });

  it('pins the new-session combat injection without a bound skill ID', async () => {
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      userPrompt: '请先看一下当前技能配置。',
    });
    const snapshot = combatSnapshot();
    const resolveCombatServerTarget = vi.fn(async () => SERVER_TARGET);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => combatRuntime()),
      materializeSkillSnapshot: vi.fn(async () => snapshot),
      resolveCombatServerTarget,
    });

    expect(opts.userPrompt).toBe(
      expectedPrompt([
        combatControllerSkillSection(PLUGIN_PATH_COMBAT),
        combatProjectPathsSection(WORKING_DIR),
        combatExecutionAuthorizationSection(),
        roleContextSection('combat-development', '战斗开发'),
        COMBAT_ROLE_PROMPT,
        '请先看一下当前技能配置。',
      ]),
    );
    expect(opts.vendorOptions).toStrictEqual({
      ...BASE_VENDOR_OPTIONS,
      mekaRoleId: 'combat-development',
      codexNativeSubagentsDisabled: true,
      mekaWorkflow: 'saga2-combat-development-v1',
      mekaCombatExecutionMode: 'autonomous-user-request',
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatProjectRefPaths: [
        combatProjectRefPaths(WORKING_DIR).moduleEditorSkillPath,
        combatProjectRefPaths(WORKING_DIR).damageEncodingRulePath,
      ],
      mekaCombatReadOnlyUnityCommands: COMBAT_READ_ONLY_UNITY_COMMANDS,
    });
    expect(opts.nativeSkillPluginPath).toBe(PLUGIN_PATH_COMBAT);
    expect(opts.nativeSkillRevision).toBe(REVISION_COMBAT);
    expect(result).toStrictEqual({
      didApply: true,
      mcpProviderIds: MCP_PROVIDER_IDS,
      inlineMcpCount: 1,
      skillsCount: 0,
      platformSkillsCount: 0,
      skillSnapshot: snapshot,
      workflow: 'saga2-combat-development-v1',
      workflowRecoveredFromRole: false,
      combatEnvironmentReady: null,
    });
    // 现状基线：没有唯一合法技能 ID 时既不解析服务器目标，也不注入该段。
    expect(resolveCombatServerTarget).not.toHaveBeenCalled();
  });

  it('pins the new-session combat injection with a confirmed skill ID', async () => {
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      userPrompt: COMBAT_USER_PROMPT_WITH_ID,
    });
    const snapshot = combatSnapshot();
    const resolveCombatServerTarget = vi.fn(async () => SERVER_TARGET);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => combatRuntime()),
      materializeSkillSnapshot: vi.fn(async () => snapshot),
      resolveCombatServerTarget,
    });

    expect(opts.userPrompt).toBe(
      expectedPrompt([
        combatControllerSkillSection(PLUGIN_PATH_COMBAT),
        combatServerTargetSection(SERVER_TARGET),
        combatProjectPathsSection(WORKING_DIR),
        combatTargetSection('1019'),
        combatExecutionAuthorizationSection(),
        roleContextSection('combat-development', '战斗开发'),
        COMBAT_ROLE_PROMPT,
        COMBAT_USER_PROMPT_WITH_ID,
      ]),
    );
    expect(opts.vendorOptions).toStrictEqual({
      ...BASE_VENDOR_OPTIONS,
      mekaRoleId: 'combat-development',
      codexNativeSubagentsDisabled: true,
      mekaWorkflow: 'saga2-combat-development-v1',
      mekaCombatExecutionMode: 'autonomous-user-request',
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatProjectRefPaths: [
        combatProjectRefPaths(WORKING_DIR).moduleEditorSkillPath,
        combatProjectRefPaths(WORKING_DIR).damageEncodingRulePath,
      ],
      mekaCombatReadOnlyUnityCommands: COMBAT_READ_ONLY_UNITY_COMMANDS,
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatTargetSkillIds: undefined,
      ...combatScopeVendorOptions('single-skill', 'confirmed'),
      mekaCombatPlanApproved: false,
      mekaCombatReferenceSkillId: undefined,
      mekaCombatTargetExportAttempted: undefined,
      mekaCombatTargetExportCompleted: undefined,
      mekaCombatServerRemoteHostId: 'mcpr:server-1',
      mekaCombatServerWorkerAgent: 'claude-code',
    });
    // 键的**插入顺序**也是现状基线的一部分（下游按这些键裁决工具门禁）。
    expect(Object.keys(opts.vendorOptions ?? {})).toEqual([
      'source',
      'mekaRuntimeResolved',
      'mekaProjectId',
      'mekaRoleId',
      'mekaMcpProviderIds',
      'mekaMcpInlineConfigs',
      'mekaPolicyProviderRefs',
      'codexNativeSubagentsDisabled',
      'mekaWorkflow',
      'mekaCombatExecutionMode',
      'mekaCombatServerCapabilityStatus',
      'mekaCombatProjectRefPaths',
      'mekaCombatReadOnlyUnityCommands',
      'mekaCombatTargetSkillId',
      'mekaCombatTargetSkillIdState',
      'mekaCombatTargetSkillIds',
      'mekaCombatRequestScope',
      'mekaCombatRequestScopeState',
      'mekaCombatScopeSelection',
      'mekaCombatScopeSourceTables',
      'mekaCombatScopeSkillIds',
      'mekaCombatScopeApproved',
      'mekaCombatEvidenceBasis',
      'mekaCombatPlanApproved',
      'mekaCombatReferenceSkillId',
      'mekaCombatTargetExportAttempted',
      'mekaCombatTargetExportCompleted',
      'mekaCombatServerRemoteHostId',
      'mekaCombatServerWorkerAgent',
    ]);
    expect(opts.nativeSkillPluginPath).toBe(PLUGIN_PATH_COMBAT);
    expect(opts.nativeSkillRevision).toBe(REVISION_COMBAT);
    expect(result).toStrictEqual({
      didApply: true,
      mcpProviderIds: MCP_PROVIDER_IDS,
      inlineMcpCount: 1,
      skillsCount: 0,
      platformSkillsCount: 0,
      skillSnapshot: snapshot,
      workflow: 'saga2-combat-development-v1',
      workflowRecoveredFromRole: false,
      combatEnvironmentReady: null,
    });
    expect(resolveCombatServerTarget).toHaveBeenCalledWith('saga2');
    // WL-15：注入的是冻结正文的绝对路径，绝不内联正文。
    expect(opts.userPrompt).not.toContain('STATUS_THEN_TARGET_EXPORT');
  });

  it('pins the new-session combat injection when two skill IDs are ambiguous', async () => {
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      userPrompt: COMBAT_USER_PROMPT_AMBIGUOUS,
    });
    const snapshot = combatSnapshot();
    const resolveCombatServerTarget = vi.fn(async () => SERVER_TARGET);

    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => combatRuntime()),
      materializeSkillSnapshot: vi.fn(async () => snapshot),
      resolveCombatServerTarget,
    });

    expect(opts.userPrompt).toBe(
      expectedPrompt([
        combatControllerSkillSection(PLUGIN_PATH_COMBAT),
        combatProjectPathsSection(WORKING_DIR),
        combatExecutionAuthorizationSection(),
        roleContextSection('combat-development', '战斗开发'),
        COMBAT_ROLE_PROMPT,
        COMBAT_USER_PROMPT_AMBIGUOUS,
      ]),
    );
    expect(opts.vendorOptions).toStrictEqual({
      ...BASE_VENDOR_OPTIONS,
      mekaRoleId: 'combat-development',
      codexNativeSubagentsDisabled: true,
      mekaWorkflow: 'saga2-combat-development-v1',
      mekaCombatExecutionMode: 'autonomous-user-request',
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatProjectRefPaths: [
        combatProjectRefPaths(WORKING_DIR).moduleEditorSkillPath,
        combatProjectRefPaths(WORKING_DIR).damageEncodingRulePath,
      ],
      mekaCombatReadOnlyUnityCommands: COMBAT_READ_ONLY_UNITY_COMMANDS,
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'ambiguous',
      mekaCombatTargetSkillIds: ['1019', '1010'],
      ...combatScopeVendorOptions('single-skill', 'missing'),
    });
    expect(opts.nativeSkillPluginPath).toBe(PLUGIN_PATH_COMBAT);
    expect(opts.nativeSkillRevision).toBe(REVISION_COMBAT);
    // 现状基线：歧义只清空目标，不写服务器路由键，也不解析服务器目标。
    expect(resolveCombatServerTarget).not.toHaveBeenCalled();
  });

  it('pins the new-session combat injection when the server target is unavailable', async () => {
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      userPrompt: COMBAT_USER_PROMPT_WITH_ID,
    });

    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => combatRuntime()),
      materializeSkillSnapshot: vi.fn(async () => combatSnapshot()),
      resolveCombatServerTarget: vi.fn(async () => {
        throw new Error('transport unavailable');
      }),
    });

    expect(opts.userPrompt).toBe(
      expectedPrompt([
        combatControllerSkillSection(PLUGIN_PATH_COMBAT),
        combatServerTargetSection(null),
        combatProjectPathsSection(WORKING_DIR),
        combatTargetSection('1019'),
        combatExecutionAuthorizationSection(),
        roleContextSection('combat-development', '战斗开发'),
        COMBAT_ROLE_PROMPT,
        COMBAT_USER_PROMPT_WITH_ID,
      ]),
    );
    expect(opts.vendorOptions).toStrictEqual({
      ...BASE_VENDOR_OPTIONS,
      mekaRoleId: 'combat-development',
      codexNativeSubagentsDisabled: true,
      mekaWorkflow: 'saga2-combat-development-v1',
      mekaCombatExecutionMode: 'autonomous-user-request',
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatProjectRefPaths: [
        combatProjectRefPaths(WORKING_DIR).moduleEditorSkillPath,
        combatProjectRefPaths(WORKING_DIR).damageEncodingRulePath,
      ],
      mekaCombatReadOnlyUnityCommands: COMBAT_READ_ONLY_UNITY_COMMANDS,
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatTargetSkillIds: undefined,
      ...combatScopeVendorOptions('single-skill', 'confirmed'),
      mekaCombatPlanApproved: false,
      mekaCombatReferenceSkillId: undefined,
      mekaCombatTargetExportAttempted: undefined,
      mekaCombatTargetExportCompleted: undefined,
      mekaCombatServerRemoteHostId: undefined,
      mekaCombatServerWorkerAgent: undefined,
    });
    expect(opts.nativeSkillPluginPath).toBe(PLUGIN_PATH_COMBAT);
    expect(opts.nativeSkillRevision).toBe(REVISION_COMBAT);
  });

  it('pins the resume short-circuit for an already-resolved combat session', async () => {
    const opts = baseOpts({
      userPrompt: RESUMED_USER_PROMPT,
      vendorOptions: {
        source: 'meka',
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatTargetSkillId: '1019',
        mekaCombatTargetSkillIdState: 'confirmed',
      },
    });
    const snapshot = combatSnapshot();
    const resolveRuntimeConfig = vi.fn();
    const resolveCombatServerTarget = vi.fn(async () => SERVER_TARGET);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      materializeSkillSnapshot: vi.fn(async () => snapshot),
      resolveCombatServerTarget,
    });

    expect(opts.userPrompt).toBe(
      expectedPrompt([
        combatControllerSkillSection(PLUGIN_PATH_COMBAT),
        combatServerTargetSection(SERVER_TARGET),
        combatProjectPathsSection(WORKING_DIR),
        combatTargetSection('1019'),
        combatExecutionAuthorizationSection(),
        RESUMED_USER_PROMPT,
      ]),
    );
    expect(opts.vendorOptions).toStrictEqual({
      source: 'meka',
      mekaRuntimeResolved: true,
      mekaWorkflow: 'saga2-combat-development-v1',
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatExecutionMode: 'autonomous-user-request',
      // 本次消息没有改目标，但会话里已确认的单技能目标同样定稿为项目参考依据。
      mekaCombatEvidenceBasis: 'project-reference',
      mekaCombatProjectRefPaths: [
        combatProjectRefPaths(WORKING_DIR).moduleEditorSkillPath,
        combatProjectRefPaths(WORKING_DIR).damageEncodingRulePath,
      ],
      mekaCombatReadOnlyUnityCommands: COMBAT_READ_ONLY_UNITY_COMMANDS,
      mekaCombatServerRemoteHostId: 'mcpr:server-1',
      mekaCombatServerWorkerAgent: 'claude-code',
    });
    expect(opts.nativeSkillPluginPath).toBe(PLUGIN_PATH_COMBAT);
    expect(opts.nativeSkillRevision).toBe(REVISION_COMBAT);
    expect(result).toStrictEqual({ ...emptyResult(), skillSnapshot: snapshot });
    // I4：resume 短路分支不重解析项目/角色，因此没有角色绑定段，也不重算 MCP。
    expect(resolveRuntimeConfig).not.toHaveBeenCalled();
    expect(opts.userPrompt).not.toContain('[MEKA_ROLE_CONTEXT]');
    expect(resolveCombatServerTarget).toHaveBeenCalledWith('saga2');
  });

  it('pins the resume short-circuit for an already-resolved non-combat session', async () => {
    const opts = baseOpts({
      userPrompt: RESUMED_USER_PROMPT,
      vendorOptions: { source: 'meka', mekaRuntimeResolved: true },
    });
    const snapshot = nonCombatSnapshot();
    const resolveRuntimeConfig = vi.fn();
    const materializeSkillSnapshot = vi.fn(async () => snapshot);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      materializeSkillSnapshot,
    });

    expect(opts.userPrompt).toBe(RESUMED_USER_PROMPT);
    expect(opts.vendorOptions).toStrictEqual({ source: 'meka', mekaRuntimeResolved: true });
    expect(opts.nativeSkillPluginPath).toBe(PLUGIN_PATH_NON_COMBAT);
    expect(opts.nativeSkillRevision).toBe(REVISION_NON_COMBAT);
    expect(result).toStrictEqual({ ...emptyResult(), skillSnapshot: snapshot });
    expect(resolveRuntimeConfig).not.toHaveBeenCalled();
    // resume 分支只复用固定 revision，不重新选技能。
    expect(materializeSkillSnapshot).toHaveBeenCalledWith(SESSION_ID, []);
  });

  it('pins the combat server worker injection', async () => {
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      remoteHostId: 'mcpr:server-1',
      orcaRole: 'worker',
      userPrompt: WORKER_PROMPT,
      vendorOptions: { orcaRole: 'worker', orcaLeadSessionId: 'lead-1' },
    });
    const resolvePlatformSkills = vi.fn(async () => []);
    const materializeSkillSnapshot = vi.fn(async () => null);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => combatRuntime()),
      resolvePlatformSkills,
      materializeSkillSnapshot,
    });

    expect(opts.userPrompt).toBe(
      expectedPrompt([combatServerWorkerSection(), WORKER_PROMPT]),
    );
    expect(opts.vendorOptions).toStrictEqual({
      orcaRole: 'worker',
      orcaLeadSessionId: 'lead-1',
      ...BASE_VENDOR_OPTIONS,
      mekaMcpProviderIds: [],
      mekaMcpInlineConfigs: [],
      mekaRoleId: 'combat-development',
      codexNativeSubagentsDisabled: true,
      mekaWorkflow: 'saga2-combat-server-worker-v1',
      mekaCombatExecutionMode: 'autonomous-user-request',
      mekaCombatServerCapabilityStatus: 'unchecked',
    });
    expect(Object.keys(opts.vendorOptions ?? {})).toEqual([
      'orcaRole',
      'orcaLeadSessionId',
      'source',
      'mekaRuntimeResolved',
      'mekaProjectId',
      'mekaRoleId',
      'mekaMcpProviderIds',
      'mekaMcpInlineConfigs',
      'mekaPolicyProviderRefs',
      'codexNativeSubagentsDisabled',
      'mekaWorkflow',
      'mekaCombatExecutionMode',
      'mekaCombatServerCapabilityStatus',
    ]);
    // 现状基线：Worker 不挂本地快照、不解析平台技能、不注入任何本地战斗段。
    expect(opts.nativeSkillPluginPath).toBeUndefined();
    expect(opts.nativeSkillRevision).toBeUndefined();
    expect(resolvePlatformSkills).not.toHaveBeenCalled();
    expect(materializeSkillSnapshot).toHaveBeenCalledWith(SESSION_ID, []);
    expect(opts.userPrompt).not.toContain('[MEKA_ROLE_CONTEXT]');
    expect(opts.userPrompt).not.toContain('[SAGA2_COMBAT_CONTROLLER_SKILL]');
    expect(opts.userPrompt).not.toContain('[SAGA2_PROJECT_PATHS]');
    expect(result).toStrictEqual({
      didApply: true,
      mcpProviderIds: [],
      inlineMcpCount: 0,
      skillsCount: 0,
      platformSkillsCount: 0,
      skillSnapshot: null,
      workflow: 'saga2-combat-development-v1',
      workflowRecoveredFromRole: false,
      combatEnvironmentReady: null,
    });
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
    const resolveCombatServerTarget = vi.fn();
    const resolvePlatformSkills = vi.fn();

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      materializeSkillSnapshot,
      resolveCombatServerTarget,
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
    expect(resolveCombatServerTarget).not.toHaveBeenCalled();
    expect(resolvePlatformSkills).not.toHaveBeenCalled();
  });

  it('keeps the injected prompt section order strictly increasing and identical to the baseline', async () => {
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      userPrompt: COMBAT_USER_PROMPT_WITH_ID,
    });
    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => combatRuntime()),
      materializeSkillSnapshot: vi.fn(async () => combatSnapshot()),
      resolveCombatServerTarget: vi.fn(async () => SERVER_TARGET),
    });

    const prompt = opts.userPrompt ?? '';
    // 标记 + 角色正文 + 调用方原始 prompt：相对顺序必须与计划 §2 的现状基线一致。
    const expectedOrder = [
      '[SAGA2_COMBAT_CONTROLLER_SKILL]',
      '[SAGA2_COMBAT_SERVER_TARGET]',
      '[SAGA2_PROJECT_PATHS]',
      '[SAGA2_COMBAT_TARGET]',
      '[SAGA2_COMBAT_EXECUTION_AUTHORIZATION]',
      '[MEKA_ROLE_CONTEXT]',
      COMBAT_ROLE_PROMPT,
      COMBAT_USER_PROMPT_WITH_ID,
    ];
    const markerPattern = /\[(?:SAGA2_[A-Z_]+|MEKA_ROLE_CONTEXT)\]/g;
    const placed = [
      ...[...prompt.matchAll(markerPattern)].map((match) => ({
        text: match[0],
        index: match.index ?? -1,
      })),
      { text: COMBAT_ROLE_PROMPT, index: prompt.indexOf(COMBAT_ROLE_PROMPT) },
      { text: COMBAT_USER_PROMPT_WITH_ID, index: prompt.indexOf(COMBAT_USER_PROMPT_WITH_ID) },
    ];
    // 顺序变化（而不是文本变化）由这里的下标与顺序断言捕获。
    expect(placed.map((entry) => entry.text)).toEqual(expectedOrder);
    placed.forEach((entry) => {
      expect(entry.index).toBeGreaterThanOrEqual(0);
    });
    const indexes = placed.map((entry) => entry.index);
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
    expect(new Set(indexes).size).toBe(indexes.length);
    // 每个标记只出现一次，且调用方原始 prompt 仍是全文末尾。
    for (const marker of expectedOrder.slice(0, 6)) {
      expect(prompt.split(marker).length - 1).toBe(1);
    }
    expect(prompt.endsWith(COMBAT_USER_PROMPT_WITH_ID)).toBe(true);
  });

  // ————————————————————————————————————————————————————————————————
  // 以下 4 组用例由「Meka 注入层重构」追加：它们钉的是**重构后声明过的行为**，
  // 不是重构前的现状快照（见 `docs/dev-rules/meka-injection-layer.md` §7）。
  // ————————————————————————————————————————————————————————————————

  it.each([
    {
      name: 'new session',
      buildOpts: (): MakerSessionCreateOpts =>
        baseOpts({
          mekaRoleId: 'combat-development',
          // 非字符串：IPC 是无类型边界，`readCreateSessionOpts` 不校验 `userPrompt`。
          userPrompt: 123 as unknown as string,
        }),
    },
    {
      name: 'resume short-circuit',
      buildOpts: (): MakerSessionCreateOpts =>
        baseOpts({
          userPrompt: 123 as unknown as string,
          vendorOptions: {
            source: 'meka',
            mekaRuntimeResolved: true,
            mekaWorkflow: 'saga2-combat-development-v1',
          },
        }),
    },
  ])('rejects a non-string userPrompt on a Meka combat session ($name)', async ({ buildOpts }) => {
    const opts = buildOpts();
    const vendorOptionsBefore = opts.vendorOptions;
    const resolveRuntimeConfig = vi.fn(async () => combatRuntime());
    const materializeSkillSnapshot = vi.fn(async () => combatSnapshot());

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
    const resolveCombatServerTarget = vi.fn();

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      materializeSkillSnapshot,
      resolveCombatServerTarget,
    });

    expect(result).toStrictEqual(emptyResult());
    // I6：参数校验只在确定是 Meka 之后发生，非 Meka 会话零写入、零抛错。
    expect({ ...opts }).toStrictEqual(before);
    expect(opts.userPrompt).toBe(123);
    expect(opts.vendorOptions).toBeUndefined();
    expect(resolveRuntimeConfig).not.toHaveBeenCalled();
    expect(materializeSkillSnapshot).not.toHaveBeenCalled();
    expect(resolveCombatServerTarget).not.toHaveBeenCalled();
  });

  it('pins the resume short-circuit opts key order when only the controller segment writes the prompt', async () => {
    const opts = baseOpts({
      // 让早段的所有 prompt 写入都不成立：无 workingDir（不注入 PROJECT_PATHS）、
      // exec mode 已是 autonomous（不注入 AUTHORIZATION）、无合法技能 ID（不注入 TARGET）。
      workingDir: undefined,
      vendorOptions: {
        source: 'meka',
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatExecutionMode: 'autonomous-user-request',
        mekaCombatServerCapabilityStatus: 'unchecked',
      },
    });
    const keysBefore = Object.keys(opts);
    const vendorOptionsBefore = opts.vendorOptions;
    const vendorOptionsKeysBefore = Object.keys(opts.vendorOptions ?? {});
    const resolveCombatServerTarget = vi.fn(async () => SERVER_TARGET);
    const resolveRuntimeConfig = vi.fn();

    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      materializeSkillSnapshot: vi.fn(async () => combatSnapshot()),
      resolveCombatServerTarget,
    });

    // 只剩 controller 段会写 prompt：整篇就是该段本身。
    expect(opts.userPrompt).toBe(combatControllerSkillSection(PLUGIN_PATH_COMBAT));
    expect(resolveRuntimeConfig).not.toHaveBeenCalled();
    expect(resolveCombatServerTarget).not.toHaveBeenCalled();
    expect(opts.vendorOptions).toStrictEqual(vendorOptionsBefore);
    // rewriteVendorOptions=true 会重写该字段，但补丁为空 ⇒ 键序不变。
    expect(Object.keys(opts.vendorOptions ?? {})).toEqual(vendorOptionsKeysBefore);
    expect(Object.keys(opts.vendorOptions ?? {})).toEqual([
      'source',
      'mekaRuntimeResolved',
      'mekaWorkflow',
      'mekaCombatExecutionMode',
      'mekaCombatServerCapabilityStatus',
    ]);

    // **新实现**的键插入顺序：`userPrompt → nativeSkillPluginPath → nativeSkillRevision`。
    // 重构前是 `nativeSkillPluginPath → nativeSkillRevision → userPrompt`：快照写在早段
    // prompt 写入与尾段 controller prompt 写入**之间**（原 `mekaRuntimeInjection.ts:501-502`
    // 的 `nativeSkillPluginPath/Revision` 在 `:505` 的 `injectCombatControllerSkill` 之前）。
    // **该差异不可观测**：全仓没有任何代码枚举 `opts` 的键（只有 `{...opts}` 扩散与
    // 命名字段访问）。这条断言不是为了“证明等价”，而是把新实现的当前行为锁下来，
    // 防止后续重构再次静默改动（§7 D2.2）。
    expect(Object.keys(opts).filter((key) => !keysBefore.includes(key))).toEqual([
      'userPrompt',
      'nativeSkillPluginPath',
      'nativeSkillRevision',
    ]);
  });

  it('pins the frozen combat vendorOptions key order with a target patch and pre-existing keys', async () => {
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      userPrompt: COMBAT_USER_PROMPT_WITH_ID,
      vendorOptions: {
        source: 'meka',
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatExecutionMode: 'autonomous-user-request',
        mekaCombatServerCapabilityStatus: 'unchecked',
        onStderrLine: 'keep-me',
      },
    });
    const resolveCombatServerTarget = vi.fn(async () => SERVER_TARGET);

    await applyMekaRuntimeConfig(opts, {
      materializeSkillSnapshot: vi.fn(async () => combatSnapshot()),
      resolveCombatServerTarget,
    });

    expect(resolveCombatServerTarget).toHaveBeenCalledWith('saga2');
    expect(opts.vendorOptions).toStrictEqual({
      source: 'meka',
      mekaRuntimeResolved: true,
      mekaWorkflow: 'saga2-combat-development-v1',
      mekaCombatExecutionMode: 'autonomous-user-request',
      mekaCombatServerCapabilityStatus: 'unchecked',
      onStderrLine: 'keep-me',
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatTargetSkillIds: undefined,
      ...combatScopeVendorOptions('single-skill', 'confirmed'),
      mekaCombatPlanApproved: false,
      mekaCombatReferenceSkillId: undefined,
      mekaCombatTargetExportAttempted: undefined,
      mekaCombatTargetExportCompleted: undefined,
      mekaCombatProjectRefPaths: [
        combatProjectRefPaths(WORKING_DIR).moduleEditorSkillPath,
        combatProjectRefPaths(WORKING_DIR).damageEncodingRulePath,
      ],
      mekaCombatReadOnlyUnityCommands: COMBAT_READ_ONLY_UNITY_COMMANDS,
      mekaCombatServerRemoteHostId: 'mcpr:server-1',
      mekaCombatServerWorkerAgent: 'claude-code',
    });
    // I2：已存在的键保持原位，新键按补丁的 spread 次序追加（§6 原本只覆盖了
    // 「新建 + 已确认技能 ID」与「server worker」两个场景）。
    expect(Object.keys(opts.vendorOptions ?? {})).toEqual([
      'source',
      'mekaRuntimeResolved',
      'mekaWorkflow',
      'mekaCombatExecutionMode',
      'mekaCombatServerCapabilityStatus',
      'onStderrLine',
      'mekaCombatTargetSkillId',
      'mekaCombatTargetSkillIdState',
      'mekaCombatTargetSkillIds',
      'mekaCombatRequestScope',
      'mekaCombatRequestScopeState',
      'mekaCombatScopeSelection',
      'mekaCombatScopeSourceTables',
      'mekaCombatScopeSkillIds',
      'mekaCombatScopeApproved',
      'mekaCombatEvidenceBasis',
      'mekaCombatPlanApproved',
      'mekaCombatReferenceSkillId',
      'mekaCombatTargetExportAttempted',
      'mekaCombatTargetExportCompleted',
      'mekaCombatProjectRefPaths',
      'mekaCombatReadOnlyUnityCommands',
      'mekaCombatServerRemoteHostId',
      'mekaCombatServerWorkerAgent',
    ]);
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
      // 重构前这三个键会被写进 opts（原实现读到持久行即 `opts.mekaProjectId = …`）。
      absentKeys: ['workspaceKind', 'mekaProjectId', 'mekaRoleId', 'mekaRole'],
    },
    {
      name: 'bootstrap snapshot materialization throws',
      message: '[INVALID_PARAMS] Meka native Skill snapshot failed: snapshot boom',
      buildOpts: () =>
        baseOpts({ mekaRoleId: 'combat-development', userPrompt: COMBAT_USER_PROMPT_WITH_ID }),
      buildDeps: (): ApplyDeps => ({
        resolveRuntimeConfig: async () => combatRuntime(),
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
          mekaRoleId: 'combat-development',
          userPrompt: COMBAT_USER_PROMPT_WITH_ID,
          vendorOptions: {
            source: 'meka',
            mekaRuntimeResolved: true,
            mekaWorkflow: 'saga2-combat-development-v1',
            mekaCombatExecutionMode: 'autonomous-user-request',
            mekaCombatServerCapabilityStatus: 'unchecked',
          },
        }),
      buildDeps: (): ApplyDeps => ({
        materializeSkillSnapshot: async () => {
          throw new Error('snapshot boom');
        },
        resolveCombatServerTarget: async () => SERVER_TARGET,
      }),
      // 重构前这条路径在物化**之前**已写：vendorOptions 的技能 ID 补丁、exec-mode 补丁，
      // 以及 TARGET / PROJECT_PATHS / SERVER_TARGET 三段 prompt。
      absentKeys: [],
      assertExtra: (opts: MakerSessionCreateOpts) => {
        expect(opts.userPrompt).toBe(COMBAT_USER_PROMPT_WITH_ID);
        expect(opts.vendorOptions).not.toHaveProperty('mekaCombatTargetSkillId');
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
//   · 文本唯一来源 = `mekaCombatPrompts.ts` 的 `mekaProjectReferencesPrompt`（测试与实现共用，
//     绝不在这里另抄一份段文本）；
//   · 空集合 ⇒ 整段不入 plan；
//   · order 65（`[MEKA_ROLE_CONTEXT]` 之后、`meka.role-prompt` 之前），既有 9 档未重排；
//   · 只投递「作用范围 + 绝对路径 + 描述」，**正文绝不进 prompt**（负向断言）；
//   · 与 60/70 同进同出：frozen/resume 短路（`mekaRuntimeResolved === true`）不注入该段。
// 这一组是 §7 **D2.4** 新声明行为的正向证据（D2.4 的门禁列指向本文件），它**没有**推翻任何
// 重构前快照：上面 10 条逐字节基线一个字符都没改，靠 `projectReferences: []` 让新段整段不渲染。
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

  it('pins order 65 and keeps the nine pre-existing segment orders unchanged and ascending', () => {
    expect(MEKA_PROMPT_SEGMENT_ORDER['meka.project-references']).toBe(65);
    // 逐档钉死：新增段只能占空档，既有 9 档既未改值也未重排。
    expect(MEKA_PROMPT_SEGMENT_ORDER).toEqual({
      'meka.combat.controller-skill': 10,
      'meka.combat.server-target': 20,
      'meka.combat.project-paths': 30,
      'meka.combat.scope': 35,
      'meka.combat.target': 40,
      'meka.combat.execution-authorization': 50,
      'meka.role-context': 60,
      'meka.project-references': 65,
      'meka.role-prompt': 70,
      'meka.combat.server-worker': 80,
    });
    const orders = Object.values(MEKA_PROMPT_SEGMENT_ORDER);
    expect(orders).toEqual([...orders].sort((left, right) => left - right));
    expect(new Set(orders).size).toBe(orders.length);
    // 65 正好落在 60 与 70 之间：这是它唯一合法的位置。
    expect(orders.indexOf(65)).toBe(orders.indexOf(60) + 1);
    expect(orders.indexOf(65)).toBe(orders.indexOf(70) - 1);
  });

  it.each([
    {
      name: 'non-combat session',
      // 非战斗 frozen 路径整篇就是调用方原始 prompt（没有 60/70，自然也没有 65）。
      frozenSectionMarker: null,
      buildOpts: (): MakerSessionCreateOpts =>
        baseOpts({
          userPrompt: RESUMED_USER_PROMPT,
          vendorOptions: { source: 'meka', mekaRuntimeResolved: true },
        }),
      buildDeps: (): ApplyDeps => ({
        materializeSkillSnapshot: vi.fn(async () => nonCombatSnapshot()),
      }),
    },
    {
      name: 'combat session',
      // 战斗 frozen 路径确实注入了战斗段（证明「缺席」不是因为整条路径没跑）。
      frozenSectionMarker: '[SAGA2_COMBAT_CONTROLLER_SKILL]',
      buildOpts: (): MakerSessionCreateOpts =>
        baseOpts({
          mekaRoleId: 'combat-development',
          userPrompt: RESUMED_USER_PROMPT,
          vendorOptions: {
            source: 'meka',
            mekaRuntimeResolved: true,
            mekaWorkflow: 'saga2-combat-development-v1',
          },
        }),
      buildDeps: (): ApplyDeps => ({
        materializeSkillSnapshot: vi.fn(async () => combatSnapshot()),
        resolveCombatServerTarget: vi.fn(async () => SERVER_TARGET),
      }),
    },
  ])(
    'never injects the reference segment on the frozen/resume short-circuit ($name)',
    async ({ buildOpts, buildDeps, frozenSectionMarker }) => {
      const opts = buildOpts();
      const resolveRuntimeConfig = vi.fn();

      await applyMekaRuntimeConfig(opts, { resolveRuntimeConfig, ...buildDeps() });

      // I4：resume 只补战斗契约，不重解析项目/角色 ⇒ 60 / 65 / 70 三段同进同出。
      expect(resolveRuntimeConfig).not.toHaveBeenCalled();
      expect(opts.userPrompt).not.toContain(MEKA_PROJECT_REFERENCES_MARKER);
      expect(opts.userPrompt).not.toContain(PROJECT_REFERENCES_CLOSING_MARKER);
      expect(opts.userPrompt).not.toContain('[MEKA_ROLE_CONTEXT]');
      expect(opts.userPrompt).not.toContain(NON_COMBAT_ROLE_PROMPT);
      if (frozenSectionMarker) {
        expect(opts.userPrompt).toContain(frozenSectionMarker);
      } else {
        // 非战斗 frozen：整篇就是调用方原始 prompt，逐字节不变。
        expect(opts.userPrompt).toBe(RESUMED_USER_PROMPT);
      }
    },
  );
});
