import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MekaRoleMcpEntry } from '../../../shared/meka-projects.js';
import type { MekaRuntimeConfig } from '../../meka-projects/runtimeConfig.js';
import {
  readCombatVendorOptions,
  rememberCombatVendorOptions,
  resetCombatVendorOptionsMirrorForTests,
} from '../../meka-projects/combatWorkflowPolicy.js';
import {
  applyMekaRuntimeConfig as applyMekaRuntimeConfigImpl,
  combatRequestScopeAnswerApprovalPatch,
  combatSkillIdVendorPatchFromUserPrompt,
  parseCombatSkillIdFromUserPrompt,
  prepareCombatFollowupRuntimeContext,
} from '../../meka-injection/index.js';
import {
  combatRequestScopeApprovalPatch,
  combatScopePrompt,
  isCombatScopeAffirmation,
  isCombatScopeAnswerApproval,
} from '../../meka-injection/mekaCombatPrompts.js';
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
    mekaRoleId: 'general-development',
    ...overrides,
  };
}

/**
 * 从 `workingDir` 推导 SAGA2 项目路径，规则与实现
 * （`meka-injection/mekaCombatPrompts.ts` 的 `combatProjectPathsPrompt`）完全一致：
 *
 * - `projectRoot` / `unityClientRoot` 用 `path.resolve` / `path.join` 推导，前缀是当前
 *   平台的路径分隔符（Windows `\`、Linux `/`），因此断言里不能写死任一种字面量。
 * - 以 `saga2_unity` 结尾时，`unityClientRoot` 就是 `workingDir` 本身，`projectRoot` 上移一层。
 */
function saga2ProjectPaths(workingDir: string) {
  const resolved = path.resolve(workingDir);
  const isUnityClientRoot = path.basename(resolved).toLowerCase() === 'saga2_unity';
  const projectRoot = isUnityClientRoot ? path.dirname(resolved) : resolved;
  const unityClientRoot = isUnityClientRoot ? resolved : path.join(resolved, 'saga2_unity');
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
  // 项目侧域事实的两条固定参考路径（含 CJK 目录名，注入文本与策略白名单共用）。
  const moduleEditorSkillPath = path.join(
    unityClientRoot,
    '.agents',
    'skills',
    'editor-skill-editor-module',
    'SKILL.md',
  );
  const damageEncodingRulePath = path.join(
    projectRoot,
    'saga2_design',
    'planning',
    '04-职能组-functional-groups',
    '战斗策划组-combat-planning',
    '专业规则-rules',
    'ModuleDesignKnowledge.md',
  );
  return {
    projectRoot,
    unityClientRoot,
    unityAgentsPath,
    legacyModuleProtocolCodecPath,
    moduleEditorSkillPath,
    damageEncodingRulePath,
  };
}

function runtime(overrides: Partial<MekaRuntimeConfig> = {}): MekaRuntimeConfig {
  return {
    projectId: 'saga2',
    roleId: 'general-development',
    roleDisplayName: '通用开发',
    workflowRecoveredFromRole: false,
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
    ...overrides,
  };
}

describe('applyMekaRuntimeConfig', () => {
  beforeEach(() => {
    // 会话级战斗 vendorOptions 镜像（A3/A10）是模块级状态：逐用例清掉，避免跨用例泄漏。
    resetCombatVendorOptionsMirrorForTests();
  });

  it('extracts only an explicitly labelled positive combat skill ID', () => {
    expect(parseCombatSkillIdFromUserPrompt('技能 ID：1019，伤害 100，重复 3 次')).toEqual({
      state: 'valid',
      skillId: '1019',
    });
    expect(parseCombatSkillIdFromUserPrompt('请检查技能1019的伤害目标')).toEqual({
      state: 'valid',
      skillId: '1019',
    });
    expect(parseCombatSkillIdFromUserPrompt('检查下1009技能')).toEqual({
      state: 'valid',
      skillId: '1009',
    });
    expect(parseCombatSkillIdFromUserPrompt('请检查 1009 技能的伤害目标')).toEqual({
      state: 'valid',
      skillId: '1009',
    });
    expect(parseCombatSkillIdFromUserPrompt('技能编号就是 1019，继续完成刚才的修改')).toEqual({
      state: 'valid',
      skillId: '1019',
    });
    expect(parseCombatSkillIdFromUserPrompt('1021')).toEqual({
      state: 'valid',
      skillId: '1021',
    });
    expect(parseCombatSkillIdFromUserPrompt('对比技能 1019 和技能 1010')).toEqual({
      state: 'ambiguous',
      skillIds: ['1019', '1010'],
    });
    expect(parseCombatSkillIdFromUserPrompt('技能 ID: 900719925474099312345678901')).toEqual({
      state: 'valid',
      skillId: '900719925474099312345678901',
    });
    // A6：上面的正例只保留一条冒烟；**负例全部走生产漏斗**（`combatSkillIdVendorPatchFromUserPrompt`），
    // 否则「普通数值不得成为目标」这条硬规则只在没有生产调用方的旧口子上被证明。
    for (const prompt of [
      '伤害 100，重复 3 次',
      '技能ID是skill_001',
      '-101 技能表参数1',
      '伤害行为10000 技能表参数1',
      '4 取攻击力百分比',
      '1 自身（一般攻击力的都是怪物自身）',
      '+100技能',
      '1.5技能',
      '技能2段伤害怎么配',
      '技能3级时触发',
    ]) {
      expect(combatSkillIdVendorPatchFromUserPrompt(prompt), prompt).toBeNull();
    }
    // 长示例（H2 的真实历史消息）确实是表范围请求：漏斗必须**不绑定**其中任何数字，
    // 而不是返回 null（它含「所有…技能」「都改成」，命中表范围特征）。
    expect(
      combatSkillIdVendorPatchFromUserPrompt(
        [
          '编辑模块:把目前所有怪物技能(怪物配置表里配置的正在使用',
          '的)使用的伤害行为10000的data都改成取100%的怪物功击力。补充说明：4 取攻击力百分比',
          '-101 技能表参数1  （-102就是参数2） 以后改值可以直接技能表里改',
          '1 自身（一般攻击力的都是怪物自身）',
        ].join('\n'),
      ),
    ).toEqual({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatTargetSkillIds: undefined,
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeSelection: '所有怪物技能',
      mekaCombatScopeSourceTables: [],
      mekaCombatScopeSkillIds: [],
      mekaCombatScopeApproved: false,
      mekaCombatEvidenceBasis: 'project-reference',
    });
  });

  it('binds only user-given skill IDs and rejects unit-suffixed numbers (A9)', () => {
    // 「技能2段伤害怎么配」「技能3级时触发」里的数字是段数/等级，不是技能 ID。
    expect(combatSkillIdVendorPatchFromUserPrompt('技能2段伤害怎么配')).toBeNull();
    expect(combatSkillIdVendorPatchFromUserPrompt('技能3级时触发')).toBeNull();
    expect(combatSkillIdVendorPatchFromUserPrompt('技能2次伤害')).toBeNull();
    // 真正的标注写法仍然 confirmed。
    expect(combatSkillIdVendorPatchFromUserPrompt('技能1019的伤害目标')).toMatchObject({
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
    });
    expect(combatSkillIdVendorPatchFromUserPrompt('检查下1009技能')).toMatchObject({
      mekaCombatTargetSkillId: '1009',
      mekaCombatTargetSkillIdState: 'confirmed',
    });
  });

  it('turns a follow-up skill ID into a live target patch without guessing ordinary numbers', () => {
    expect(combatSkillIdVendorPatchFromUserPrompt('伤害 100，1 秒后重复 3 次')).toBeNull();
    expect(
      combatSkillIdVendorPatchFromUserPrompt('技能 ID 就是 1019，继续完成刚才的修改。'),
    ).toEqual({
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatTargetSkillIds: undefined,
      mekaCombatRequestScope: 'single-skill',
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatScopeSelection: undefined,
      mekaCombatScopeSourceTables: undefined,
      mekaCombatScopeSkillIds: undefined,
      mekaCombatScopeApproved: false,
    });
    expect(combatSkillIdVendorPatchFromUserPrompt('对比技能 1019 和技能 1010')).toEqual({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'ambiguous',
      mekaCombatTargetSkillIds: ['1019', '1010'],
      mekaCombatRequestScope: 'single-skill',
      mekaCombatRequestScopeState: 'missing',
      mekaCombatScopeSelection: undefined,
      mekaCombatScopeSourceTables: undefined,
      mekaCombatScopeSkillIds: undefined,
      mekaCombatScopeApproved: false,
    });
  });

  it('treats every user-given form as confirmed and reserves proposed for table scope', () => {
    // 整条消息只回一个正整数 = 用户明确绑定（首轮追问后的标准形态），必须 confirmed。
    expect(combatSkillIdVendorPatchFromUserPrompt('1021')).toMatchObject({
      mekaCombatTargetSkillId: '1021',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatRequestScope: 'single-skill',
      mekaCombatRequestScopeState: 'confirmed',
    });
    // 表范围启发式：不绑定单值目标，状态只到 proposed，且 approved 恒为 false。
    const tableScope = combatSkillIdVendorPatchFromUserPrompt(
      '把目前所有怪物技能的伤害行为10000的data都改成取100%攻击力',
    );
    expect(tableScope).toMatchObject({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatTargetSkillIds: undefined,
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
      mekaCombatEvidenceBasis: 'project-reference',
    });
    // 用户标注的 ID 优先于范围词：explicit ID 永远收敛回单技能 confirmed。
    expect(
      combatSkillIdVendorPatchFromUserPrompt('所有技能里先把技能 ID 1019 的伤害改掉'),
    ).toMatchObject({
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatRequestScope: 'single-skill',
      mekaCombatRequestScopeState: 'confirmed',
    });
    // 显式声明范围来源表时逐字保留用户给出的 saga2_json 路径。
    expect(
      combatSkillIdVendorPatchFromUserPrompt(
        '范围由 saga2_json/MonsterSkill.json 决定，把所有怪物技能的伤害统一改成取100%攻击力',
      ),
    ).toMatchObject({
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeSourceTables: ['saga2_json/MonsterSkill.json'],
    });
  });

  it('recognises the canonical table-scope phrasings the injected role text promises (A1)', () => {
    // 角色/技能正文承诺可识别的三个规范例：全部必须落到 table-scope，且**绝不**产生
    // confirmed 绑定（启发式不得升级成用户确认）。
    for (const prompt of [
      '把怪物配置表里配置的正在使用的技能的伤害改成取100%攻击力',
      '把某类技能的某个字段统一改成100',
      '把目前所有怪物技能的伤害行为10000的data都改成取100%攻击力',
      '把表里正在使用的技能都改成取100%攻击力',
    ]) {
      expect(combatSkillIdVendorPatchFromUserPrompt(prompt), prompt).toMatchObject({
        mekaCombatTargetSkillId: undefined,
        mekaCombatTargetSkillIdState: 'missing',
        mekaCombatRequestScope: 'table-scope',
        mekaCombatRequestScopeState: 'proposed',
        mekaCombatScopeApproved: false,
      });
    }
    // 低误报：单技能内的数值/结构表述不得被吃进表范围。
    for (const prompt of ['把伤害行为10000的data改成取100%攻击力', '技能1019的伤害改成100']) {
      const patch = combatSkillIdVendorPatchFromUserPrompt(prompt);
      if (patch) expect(patch.mekaCombatRequestScope).not.toBe('table-scope');
    }
  });

  it('never binds a moduleType/node context number as a confirmed single-skill target (D4)', () => {
    // 审查复现：`10000` 在本域是伤害行为的 `moduleType`（`技能10000的data` 是「模块字段语境」），
    // 正文明确「`moduleType` 数值、节点 ID、技能表参数引用都不是技能 ID」。旧实现把它绑成
    // confirmed 单技能目标 —— 这是「启发式不得产生 confirmed」唯一的现存违例。
    for (const prompt of [
      '技能10000的data',
      '技能10000的节点',
      '技能10000 参数',
      '技能10000模块',
      // 数字在 `技能` 之前的对称面：模块/表语境在左侧。
      '伤害行为10000技能',
      '参数1技能',
      '节点1019技能',
    ]) {
      expect(combatSkillIdVendorPatchFromUserPrompt(prompt), prompt).toBeNull();
    }
    // 表范围表述不得再被 `moduleType` 数字抢先吞成单技能 confirmed（D4 的后两行复现）。
    for (const prompt of [
      '把所有技能10000的data都改成取100%攻击力',
      '把怪物配置表里配置的正在使用的技能10000的data都改成取100%攻击力',
    ]) {
      expect(combatSkillIdVendorPatchFromUserPrompt(prompt), prompt).toMatchObject({
        mekaCombatTargetSkillId: undefined,
        mekaCombatTargetSkillIdState: 'missing',
        mekaCombatTargetSkillIds: undefined,
        mekaCombatRequestScope: 'table-scope',
        mekaCombatRequestScopeState: 'proposed',
        mekaCombatScopeApproved: false,
      });
    }
    // 合法标注形态必须照旧 confirmed（修 D4 不得误伤用户明确给出的 ID）。
    for (const [prompt, skillId] of [
      ['技能 ID 1019', '1019'],
      ['技能编号就是 1019，继续完成刚才的修改', '1019'],
      ['技能1019', '1019'],
      ['技能#1019', '1019'],
      ['技能 1019 的伤害目标', '1019'],
      ['技能1019的伤害改成100', '1019'],
      ['检查下1009技能', '1009'],
      ['1019', '1019'],
    ] as const) {
      expect(combatSkillIdVendorPatchFromUserPrompt(prompt), prompt).toMatchObject({
        mekaCombatTargetSkillId: skillId,
        mekaCombatTargetSkillIdState: 'confirmed',
        mekaCombatRequestScope: 'single-skill',
        mekaCombatRequestScopeState: 'confirmed',
      });
    }
    // 代价面的**显式登记**（fail-closed）：模块字段句式连 N 一起不绑定，用户会被再问一次 ID。
    for (const prompt of ['技能1019的data', '技能1019的节点']) {
      expect(combatSkillIdVendorPatchFromUserPrompt(prompt), prompt).toBeNull();
    }
    // 刻意保留的一侧：`技能N的伤害行为<moduleType>` 无法与「技能 N 的伤害行为」区分（后者是
    // 合法单技能表述），因此仍绑定 1019；而 `伤害行为` 之后的 `10000` 本来就不是任何分支的目标。
    expect(
      combatSkillIdVendorPatchFromUserPrompt('技能1019的伤害行为10000的data改成取100%攻击力'),
    ).toMatchObject({
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatRequestScope: 'single-skill',
    });
  });

  it('keeps an in-skill bulk numeric edit single-skill and surfaces two named IDs (D5)', () => {
    // 行 1（审查复现）：单技能内的批量数值改动与表范围形状完全相同，但**不是**表范围。
    // 旧实现把它判成 table-scope/proposed，于是这轮请求进入「先确认范围」流程，而表范围正文
    // 又禁止向用户追问技能 ID ⇒ 用户被要求确认一个不存在的范围。正确路由 = 单技能流程缺 ID 追问。
    expect(combatSkillIdVendorPatchFromUserPrompt('把伤害数值都改成0.5')).toBeNull();
    // 行 2 / 行 3（审查复现）：用户在同一句里点名两个 ID ⇒ 两个都进 `single-skill` 歧义分支
    // （`missing` + `skillIds`），既不静默丢掉一个，也不把其中一个升成 confirmed。
    for (const prompt of ['把 1019 和 1020 都改成取100%攻击力', '把技能1019和1020都改成100']) {
      expect(combatSkillIdVendorPatchFromUserPrompt(prompt), prompt).toMatchObject({
        mekaCombatTargetSkillId: undefined,
        mekaCombatTargetSkillIdState: 'ambiguous',
        mekaCombatTargetSkillIds: ['1019', '1020'],
        mekaCombatRequestScope: 'single-skill',
        mekaCombatRequestScopeState: 'missing',
        mekaCombatScopeApproved: false,
      });
    }
    // 反向守卫：「把…都改成」在与**范围来源标记**共现时仍然是表范围证据（不得因为降级误杀）。
    for (const prompt of [
      '把全部技能表里所有模块的伤害都改成取100%攻击力',
      '把怪物配置表里配置的正在使用的技能都改成取100%攻击力',
      '把某类技能的某个字段统一改成100',
      '把每类技能的伤害都改成取100%攻击力',
      '把表里的伤害数值都改成0.5',
    ]) {
      expect(combatSkillIdVendorPatchFromUserPrompt(prompt), prompt).toMatchObject({
        mekaCombatTargetSkillId: undefined,
        mekaCombatTargetSkillIdState: 'missing',
        mekaCombatRequestScope: 'table-scope',
        mekaCombatRequestScopeState: 'proposed',
      });
    }
  });

  it('routes a single-skill bulk edit into the ID prompt instead of the table-scope flow (D5)', async () => {
    // 路由后果（这是 D5 的真实危害面，不只是分类标签）：零绑定会话里的单技能批量数值改动
    // 必须回到单技能硬入口的缺 ID 追问，而不是带着 proposed 范围段进入「先确认范围」流程。
    expect(
      await prepareCombatFollowupRuntimeContext({
        prompt: '把伤害数值都改成0.5',
        projectId: 'saga2',
        workingDir: 'C:/Workspace/saga2/saga2_project',
        sessionId: 'd5-in-skill-edit',
      }),
    ).toBeNull();
    // 对照：真正点名的表范围仍然产出范围段（同一个入口、相反路由）。
    const tableScope = await prepareCombatFollowupRuntimeContext({
      prompt: '把怪物配置表里配置的正在使用的技能都改成取100%攻击力',
      projectId: 'saga2',
      workingDir: 'C:/Workspace/saga2/saga2_project',
      sessionId: 'd5-table-scope',
    });
    expect(tableScope?.vendorOptionsPatch).toMatchObject({
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
    });
    expect(tableScope?.promptSection).toContain('[SAGA2_COMBAT_SCOPE]');
    // 两个用户点名的 ID：走歧义分支，不注入任何段（要求用户先收敛到一个 ID）。
    const twoIds = await prepareCombatFollowupRuntimeContext({
      prompt: '把 1019 和 1020 都改成取100%攻击力',
      projectId: 'saga2',
      workingDir: 'C:/Workspace/saga2/saga2_project',
      sessionId: 'd5-two-ids',
    });
    expect(twoIds?.vendorOptionsPatch).toMatchObject({
      mekaCombatTargetSkillIdState: 'ambiguous',
      mekaCombatTargetSkillIds: ['1019', '1020'],
      mekaCombatRequestScope: 'single-skill',
    });
    expect(twoIds?.promptSection).toBeNull();
  });

  it('keeps the confirmed invariant across the adversarial battery', () => {
    // 负例全集（用户**没有**提供技能 ID）：结论只能是「无绑定」或「表范围 proposed」。
    const mustNotBind: ReadonlyArray<readonly [string, 'none' | 'table-scope']> = [
      ['-101 技能表参数1', 'none'],
      ['+100技能', 'none'],
      ['1.5技能', 'none'],
      ['技能 3 段', 'none'],
      ['技能 2 级', 'none'],
      ['0', 'none'],
      ['伤害 100，重复 3 次', 'none'],
      ['把伤害改成 100', 'none'],
      // 全角数字不做归一化：不绑定（fail-closed，回到缺 ID 追问），绝不猜。
      ['技能１０１９', 'none'],
      ['技能１００的data', 'none'],
      ['１００技能', 'none'],
      // 含一个整数的表范围表述：只到 proposed。
      ['把所有怪物技能的伤害行为10000的data都改成取100%攻击力', 'table-scope'],
      ['把怪物配置表里配置的正在使用的技能10000的data都改成取100%攻击力', 'table-scope'],
    ];
    for (const [prompt, expected] of mustNotBind) {
      const patch = combatSkillIdVendorPatchFromUserPrompt(prompt);
      if (expected === 'none') {
        expect(patch, prompt).toBeNull();
        continue;
      }
      expect(patch, prompt).toMatchObject({
        mekaCombatTargetSkillId: undefined,
        mekaCombatTargetSkillIdState: 'missing',
        mekaCombatRequestScope: 'table-scope',
        mekaCombatRequestScopeState: 'proposed',
      });
      // 红线复查：这一档里**任何**结果都不得是 confirmed。
      expect(patch?.mekaCombatTargetSkillIdState, prompt).not.toBe('confirmed');
    }
    // 报告点名的 `技能#7`：它与 `技能#1019` 是同一种**用户显式标注**形态（`技能#<正整数>`），
    // 数字由用户自己写出来，因此仍然是 confirmed 7 —— 不是启发式推断，不在红线范围内。
    // 这一点在报告里如实登记：它属于「合法标注形态」，不是负例。
    expect(combatSkillIdVendorPatchFromUserPrompt('技能#7')).toMatchObject({
      mekaCombatTargetSkillId: '7',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatRequestScope: 'single-skill',
    });
    // 机械复查：所有 confirmed 绑定的值都必须是消息里**逐字出现**的整数（用户自己写的）。
    for (const prompt of ['技能#7', '技能 ID 1019', '技能1019', '技能#1019', '1019']) {
      const patch = combatSkillIdVendorPatchFromUserPrompt(prompt);
      expect(patch?.mekaCombatTargetSkillIdState, prompt).toBe('confirmed');
      expect(prompt, prompt).toContain(String(patch?.mekaCombatTargetSkillId));
    }
  });

  it('keeps a user-confirmed single-skill binding away from module-level quantifiers (A2)', async () => {
    // 检测器层：指代当前目标的限定词 + 技能 = 单技能上下文，不做任何分类。
    expect(combatSkillIdVendorPatchFromUserPrompt('这个技能的所有模块都要检查')).toBeNull();
    expect(combatSkillIdVendorPatchFromUserPrompt('各模块的 typ 都要检查')).toBeNull();
    expect(combatSkillIdVendorPatchFromUserPrompt('该技能的模块都检查一遍')).toBeNull();
    // 计划层 guard：量词锚在单技能内部、不是无歧义表范围时，已确认绑定不得被覆盖。
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      userPrompt: '把每个技能的模块都改成取100%攻击力',
      vendorOptions: {
        source: 'meka',
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatTargetSkillId: '1019',
        mekaCombatTargetSkillIdState: 'confirmed',
        mekaCombatRequestScope: 'single-skill',
        mekaCombatRequestScopeState: 'confirmed',
        mekaCombatTargetExportCompleted: true,
      },
    });
    await applyMekaRuntimeConfig(opts, { materializeSkillSnapshot: vi.fn(async () => null) });
    expect(opts.vendorOptions).toMatchObject({
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatRequestScope: 'single-skill',
      // 已确认的导出证据不得被顺手作废。
      mekaCombatTargetExportCompleted: true,
    });
    expect(opts.vendorOptions?.mekaCombatScopeApproved).not.toBe(true);
    // 反面：显式点名表的无歧义表述仍然允许进入表范围（覆盖绑定）。
    const explicitTable = baseOpts({
      mekaRoleId: 'combat-development',
      userPrompt: '现在把全部技能表里所有模块的伤害都改成取100%攻击力',
      vendorOptions: {
        source: 'meka',
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatTargetSkillId: '1019',
        mekaCombatTargetSkillIdState: 'confirmed',
        mekaCombatRequestScope: 'single-skill',
      },
    });
    await applyMekaRuntimeConfig(explicitTable, {
      materializeSkillSnapshot: vi.fn(async () => null),
    });
    expect(explicitTable.vendorOptions).toMatchObject({
      mekaCombatTargetSkillId: undefined,
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
    });
  });

  it('confirms a proposed table scope only on an explicit user affirmation', async () => {
    const proposedTableScope = {
      source: 'meka',
      mekaRuntimeResolved: true,
      mekaWorkflow: 'saga2-combat-development-v1',
      mekaCombatExecutionMode: 'autonomous-user-request',
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
      mekaCombatScopeSkillIds: [],
      mekaCombatEvidenceBasis: 'project-reference',
    };
    const resumeWith = async (prompt: string) => {
      const opts = baseOpts({ userPrompt: prompt, vendorOptions: { ...proposedTableScope } });
      await applyMekaRuntimeConfig(opts, { materializeSkillSnapshot: vi.fn(async () => null) });
      return opts.vendorOptions ?? {};
    };

    // 肯定词（含尾随标点/连接词）⇒ 范围 confirmed + approved。
    for (const affirmation of ['确认', '确认，就按这个范围执行。', '没问题，继续', 'OK!']) {
      expect(await resumeWith(affirmation)).toMatchObject({
        mekaCombatRequestScope: 'table-scope',
        mekaCombatRequestScopeState: 'confirmed',
        mekaCombatScopeApproved: true,
        mekaCombatEvidenceBasis: 'project-reference',
      });
    }
    // 新的范围型指令 ⇒ 重新按新指令分类，覆盖 proposed（approved 归零）。
    expect(
      await resumeWith('现在把全部技能表里所有模块的伤害都改成取100%攻击力'),
    ).toMatchObject({
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
    });
    // 带标注技能 ID 的指令 ⇒ 切回单技能并清掉表级状态。
    expect(await resumeWith('改成只处理技能 ID 1019')).toMatchObject({
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatRequestScope: 'single-skill',
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatScopeApproved: false,
      mekaCombatScopeSkillIds: undefined,
    });
    // 无关消息不改变范围状态（既不确认也不降级）。
    expect(await resumeWith('先看看当前有哪些模块')).toMatchObject({
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
    });
  });

  it('confirms a proposed table scope from the in-turn follow-up patch without prior state', async () => {
    // 状态**未知**（调用方既没传 previousVendorOptions，也没有会话级镜像）：只写范围键。
    // 这是「未知就是未知」的兜底，不是生产路径 —— 生产调用方总会带上会话现状（见下一个用例）。
    const confirmed = await prepareCombatFollowupRuntimeContext({
      prompt: '确认',
      projectId: 'saga2',
      workingDir: 'C:/Workspace/saga2/saga2_project',
    });
    expect(confirmed?.vendorOptionsPatch).toMatchObject({
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatScopeApproved: true,
      mekaCombatEvidenceBasis: 'project-reference',
    });
    // 纯审批消息不得顺手清空目标/导出证据/服务器状态。
    expect(confirmed?.vendorOptionsPatch).not.toHaveProperty('mekaCombatTargetExportCompleted');
    expect(confirmed?.vendorOptionsPatch).not.toHaveProperty('mekaCombatServerCapabilityStatus');
    // 状态未知时连范围键都不是合法表范围上下文，所以没有可注入的范围段。
    expect(confirmed?.promptSection).toBeNull();
    // 无关消息不产生任何补丁（不改范围状态，也不会被误当成审批）。
    expect(
      await prepareCombatFollowupRuntimeContext({
        prompt: '先看看当前有哪些模块',
        projectId: 'saga2',
        workingDir: 'C:/Workspace/saga2/saga2_project',
      }),
    ).toBeNull();
    // 新的范围型指令按新指令重新分类（覆盖 proposed，approved 归零），不是审批。
    const newScope = await prepareCombatFollowupRuntimeContext({
      prompt: '把所有怪物技能的伤害改成取100%攻击力',
      projectId: 'saga2',
      workingDir: 'C:/Workspace/saga2/saga2_project',
    });
    expect(newScope?.vendorOptionsPatch).toMatchObject({
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
    });
  });

  it('runs the range-approval guard on the live path so unrelated affirmations cannot approve (A3)', async () => {
    const workDir = 'C:/Workspace/saga2/saga2_project';
    const singleSkillSession = {
      source: 'meka',
      mekaWorkflow: 'saga2-combat-development-v1',
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatRequestScope: 'single-skill',
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatScopeApproved: false,
    };
    // 调用方显式传入会话现状：单技能会话里任何一句「可以 / 继续 / OK」都不得变成范围审批。
    for (const affirmation of ['可以', '继续', 'OK', '执行', '没问题']) {
      expect(
        await prepareCombatFollowupRuntimeContext({
          prompt: affirmation,
          projectId: 'saga2',
          workingDir: workDir,
          sessionId: 'live-guarded-1',
          previousVendorOptions: { ...singleSkillSession },
        }),
        affirmation,
      ).toBeNull();
    }
    // 同一会话经**会话级镜像**（无显式 previousVendorOptions）也走同一条 guard：
    // 这正是 register.ts 的生产形态（Session 没有 vendorOptions 读取口子）。
    rememberCombatVendorOptions('live-guarded-2', singleSkillSession);
    expect(readCombatVendorOptions('live-guarded-2')).toMatchObject({
      mekaCombatRequestScope: 'single-skill',
    });
    expect(
      await prepareCombatFollowupRuntimeContext({
        prompt: '可以',
        projectId: 'saga2',
        workingDir: workDir,
        sessionId: 'live-guarded-2',
      }),
    ).toBeNull();
    // 表范围提案会话（镜像里就是表范围）里同一句话仍然是审批。
    rememberCombatVendorOptions('live-guarded-3', {
      ...singleSkillSession,
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
    });
    const approved = await prepareCombatFollowupRuntimeContext({
      prompt: '可以',
      projectId: 'saga2',
      workingDir: workDir,
      sessionId: 'live-guarded-3',
    });
    expect(approved?.vendorOptionsPatch).toMatchObject({
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatScopeApproved: true,
    });
  });

  // ——— 卡片答案审批（`ask_user_question` 路径）———
  // 真实缺陷：用户通过 ask_user_question 卡片确认了表范围，但审批门禁只由 `input.prompt`
  // 驱动 ⇒ `mekaCombatScopeApproved` 永远写不进去，策略层继续按「尚未确认任何技能」拒掉每一次
  // 工具调用，最后只能要求用户把同一句话再打一遍。下面两条用例钉住卡片路径的判定与前提。
  it('treats a card option label as scope approval by its first word, refusal wins (card path)', () => {
    // 真实卡片上的两个选项：确认项带业务内容（整条消息判据会拒掉它），拒绝项必须不批准。
    const confirmLabel = '确认：只改这 15 个伤害节点，技能表参数先不动';
    const refusalLabel = '先不执行，我要调整范围或数值';
    expect(isCombatScopeAnswerApproval(confirmLabel)).toBe(true);
    expect(isCombatScopeAnswerApproval(refusalLabel)).toBe(false);
    // 这正是卡片路径必须单独判定的原因：聊天判据要求整条消息只由肯定词组成。
    expect(isCombatScopeAffirmation(confirmLabel)).toBe(false);
    expect(isCombatScopeAffirmation('确认')).toBe(true);
    // 拒绝只看**首词**：确认项自身含「参数先不动」，子串搜索会把确认判成拒绝。
    expect(isCombatScopeAnswerApproval('确认：参数先不动')).toBe(true);
    expect(isCombatScopeAnswerApproval('不动参数，先确认范围')).toBe(false);
    // 卡片上的关闭 / 跳过是空答案；自由文本（可能是在提新要求）不算审批。
    for (const blank of ['', '   ', '\n', undefined, null, 123]) {
      expect(isCombatScopeAnswerApproval(blank)).toBe(false);
    }
    expect(isCombatScopeAnswerApproval('把范围改成只改 3001064')).toBe(false);
    for (const affirmed of ['确认', '好的，按这个来', 'OK', 'okay 继续', '就按这个清单执行', 'YES']) {
      expect(isCombatScopeAnswerApproval(affirmed), affirmed).toBe(true);
    }
    for (const refused of ['不', '取消', '算了', '稍后再看', 'No, 先不动', '停止执行']) {
      expect(isCombatScopeAnswerApproval(refused), refused).toBe(false);
    }
  });

  it('requires a table-scope session before a card answer becomes scope approval (card path)', () => {
    const answer = '确认：只改这 15 个伤害节点，技能表参数先不动';
    const proposed = {
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
    };
    const patch = combatRequestScopeAnswerApprovalPatch({ answer, previousVendorOptions: proposed });
    expect(patch).toEqual({
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatScopeApproved: true,
      mekaCombatEvidenceBasis: 'project-reference',
    });
    // 与聊天路径产出**同一份**补丁（两条通道只差判定与前提，不差写入内容）。
    expect(patch).toEqual(
      combatRequestScopeApprovalPatch({ prompt: '确认', previousVendorOptions: proposed }),
    );
    // 卡片路径没有「整条消息只由肯定词组成」这层护栏，所以表范围前提是唯一的护栏：
    // 单技能会话、镜像缺失时都必须不写（否则任何「确认…」开头的卡片都会批范围）。
    expect(
      combatRequestScopeAnswerApprovalPatch({
        answer,
        previousVendorOptions: { mekaCombatRequestScope: 'single-skill' },
      }),
    ).toBeNull();
    expect(combatRequestScopeAnswerApprovalPatch({ answer })).toBeNull();
    expect(
      combatRequestScopeAnswerApprovalPatch({ answer, previousVendorOptions: {} }),
    ).toBeNull();
    // 已确认过 ⇒ 幂等。
    expect(
      combatRequestScopeAnswerApprovalPatch({
        answer,
        previousVendorOptions: {
          ...proposed,
          mekaCombatRequestScopeState: 'confirmed',
          mekaCombatScopeApproved: true,
        },
      }),
    ).toBeNull();
    // 正确前提下，拒绝项 / 空答案 / 自由文本同样不产生补丁。
    for (const denied of ['先不执行，我要调整范围或数值', '', '把范围改成只改 3001064']) {
      expect(
        combatRequestScopeAnswerApprovalPatch({ answer: denied, previousVendorOptions: proposed }),
        denied,
      ).toBeNull();
    }
  });

  it('wires the card-answer scope approval into the interaction resolve without touching chat (D8)', async () => {
    const source = await fs.readFile(new URL('../register.ts', import.meta.url), 'utf8');
    const observer = source.indexOf("log.warn('goalAskAnswerObserver threw'");
    const approve = source.indexOf('combatRequestScopeAnswerApprovalPatch({', observer);
    const dismissal = source.indexOf('decision.dismissed !== true', observer);
    const mirror = source.indexOf(
      'rememberCombatVendorOptions(resolver.sessionId, approvalPatch)',
      approve,
    );
    const live = source.indexOf('setVendorOptions(approvalPatch)', mirror);
    expect(observer).toBeGreaterThanOrEqual(0);
    // 卡片审批块紧跟在既有的 goal 观察者之后（同一处 resolve 收口）。
    expect(approve).toBeGreaterThan(observer);
    // 只在**用户本人**作答时才算：dismissed（系统空答）先被排除。
    expect(dismissal).toBeGreaterThan(observer);
    expect(dismissal).toBeLessThan(approve);
    // 会话现状来自 Host 维护的镜像（Session 没有 vendorOptions 读取口子），并原样交给注入层判定。
    const slice = source.slice(observer, live);
    expect(slice).toContain('resolver.kind === \'ask_user_question\'');
    expect(slice).toContain('decision.kind === \'ask_user_question\'');
    expect(slice).toContain('const previousVendorOptions = readCombatVendorOptions(resolver.sessionId)');
    expect(slice).toContain(
      'combatRequestScopeAnswerApprovalPatch({ answer, previousVendorOptions })',
    );
    // 镜像先记，再把同一份补丁写进实时 Session（策略层读的是实时 vendorOptions）。
    expect(mirror).toBeGreaterThan(approve);
    expect(live).toBeGreaterThan(mirror);
  });

  it('keeps injecting the approved scope block on the turns after approval (A10)', async () => {
    const workDir = 'C:/Workspace/saga2/saga2_project';
    const approvedTableScope = {
      source: 'meka',
      mekaWorkflow: 'saga2-combat-development-v1',
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatScopeApproved: true,
      mekaCombatScopeSkillIds: ['1019', '1020'],
      mekaCombatEvidenceBasis: 'project-reference',
    };
    rememberCombatVendorOptions('live-approved-1', approvedTableScope);

    // 批准之后的普通实施轮（消息本身不是肯定词、也不带目标）也必须拿到范围段。
    const followup = await prepareCombatFollowupRuntimeContext({
      prompt: '继续逐目标实施，先处理第一个',
      projectId: 'saga2',
      workingDir: workDir,
      sessionId: 'live-approved-1',
    });
    expect(followup?.promptSection).toContain('[SAGA2_COMBAT_SCOPE]');
    expect(followup?.promptSection).toContain('scopeApproved: true（用户已确认范围）');
    expect(followup?.promptSection).toContain('按逐目标流程实施');

    // 批准轮本身也要注入「已批准」变体（原来 promptSection 恒为 null）。
    const approvalTurn = await prepareCombatFollowupRuntimeContext({
      prompt: '确认',
      projectId: 'saga2',
      workingDir: workDir,
      sessionId: 'live-approved-1',
      previousVendorOptions: { ...approvedTableScope, mekaCombatRequestScopeState: 'proposed', mekaCombatScopeApproved: false },
    });
    expect(approvalTurn?.vendorOptionsPatch).toMatchObject({
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatScopeApproved: true,
    });
    expect(approvalTurn?.promptSection).toContain('scopeApproved: true（用户已确认范围）');
    expect(approvalTurn?.promptSection).toContain('evidenceBasis: project-reference');
  });

  it('clears a stale evidence basis when the project references cannot be resolved (A7)', async () => {
    const staleBasis = {
      source: 'meka',
      mekaWorkflow: 'saga2-combat-development-v1',
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatRequestScope: 'single-skill',
      mekaCombatRequestScopeState: 'confirmed',
      mekaCombatEvidenceBasis: 'project-reference',
    };
    // 本轮拿不到 workingDir（工作目录恢复失败）且消息本身不产生目标补丁：
    // 旧的 project-reference 依据必须被清掉，不能让它继续跳过服务器回执。
    const cleared = await prepareCombatFollowupRuntimeContext({
      prompt: '继续',
      projectId: 'saga2',
      workingDir: undefined,
      sessionId: 'live-basis-1',
      previousVendorOptions: { ...staleBasis },
    });
    expect(cleared?.vendorOptionsPatch).toEqual({ mekaCombatEvidenceBasis: undefined });
    expect(cleared?.promptSection).toBeNull();

    // resume/bootstrap 路径同样清掉旧值。
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      userPrompt: '继续',
      workingDir: undefined,
      vendorOptions: { ...staleBasis, mekaRuntimeResolved: true },
    });
    await applyMekaRuntimeConfig(opts, { materializeSkillSnapshot: vi.fn(async () => null) });
    expect(opts.vendorOptions?.mekaCombatEvidenceBasis).toBeUndefined();
    expect(opts.vendorOptions?.mekaCombatTargetSkillId).toBe('1019');
  });

  it('wires the live session state and the mirror commit into register.ts (A3)', async () => {
    const source = await fs.readFile(new URL('../register.ts', import.meta.url), 'utf8');
    const call = source.indexOf('await prepareCombatFollowupRuntimeContext');
    const accepted = source.indexOf('onAccepted: async', call);
    expect(call).toBeGreaterThanOrEqual(0);
    // 生产调用方必须把 Host 维护的会话级镜像交给审批门禁。
    expect(source.slice(call, accepted)).toContain('previousVendorOptions: readCombatVendorOptions(sessionId)');
    // 只有真正落地的补丁才进镜像（onAccepted 内、setVendorOptions 之后）。
    const setOptions = source.indexOf('await liveSession.setVendorOptions', accepted);
    const mirror = source.indexOf('rememberCombatVendorOptions(sessionId', setOptions);
    expect(setOptions).toBeGreaterThan(accepted);
    expect(mirror).toBeGreaterThan(setOptions);
  });

  it('restores the scope mirror into the live session and forgets it only on a terminal close (D6/D7)', async () => {
    const source = await fs.readFile(new URL('../register.ts', import.meta.url), 'utf8');
    // 还原必须发生在续聊口子**之前**：策略层在 turn 派发时读的是实时 vendorOptions，晚于计划层
    // 就没有意义了（那一轮的门禁已经按空状态判过）。
    const restore = source.indexOf('combatScopeStateRestorePatch(sessionId)');
    const call = source.indexOf('await prepareCombatFollowupRuntimeContext');
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThanOrEqual(0);
    expect(restore).toBeLessThan(call);
    expect(source.slice(restore, call)).toContain(
      'await liveCombatSession.setVendorOptions(combatScopeRestore)',
    );
    // 镜像的丢弃只在**终态关闭**：理由必须是 `requested`，且不在 rehydrate 抑制窗口内
    // （`withRehydrateCloseSuppressed(... closeSession(id))` 这类重建用的正是默认理由）。
    // 这段 wiring 位于会话关闭生命周期里，文本位置在 `registerMakerIpc` 主体之前，所以只钉住
    // 「它存在、且守卫条件完整」，不比较它与续聊口子的先后。
    const forget = source.indexOf('forgetCombatVendorOptions(session.id)');
    expect(forget).toBeGreaterThanOrEqual(0);
    expect(source.slice(forget - 400, forget)).toContain("context.closeReason === 'requested'");
    expect(source.slice(forget - 400, forget)).toContain(
      'rehydrateCloseSuppression.isSuppressed(session.id)',
    );
  });

  it('clears prior target export state when a follow-up switches skills', async () => {
    const runtimeConfig: MekaRuntimeConfig = runtime({
      workflow: 'saga2-combat-development-v1',
      roleId: 'combat-development',
      skills: [],
    });
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      userPrompt: '技能 ID: 1019',
      vendorOptions: {
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatTargetSkillId: '1019',
        mekaCombatTargetExportAttempted: true,
        mekaCombatTargetExportCompleted: true,
      },
    });
    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtimeConfig),
      materializeSkillSnapshot: vi.fn(async () => null),
    });
    opts.userPrompt = '技能 ID: 1021';
    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtimeConfig),
      materializeSkillSnapshot: vi.fn(async () => null),
    });
    expect(opts.vendorOptions).toMatchObject({
      mekaCombatTargetSkillId: '1021',
      mekaCombatTargetExportAttempted: undefined,
      mekaCombatTargetExportCompleted: undefined,
    });
  });

  it('injects the confirmed follow-up target, project paths, and resolved server target', async () => {
    const resolveCombatServerTarget = vi.fn(async () => ({
      remoteHostId: 'mcpr:server-1',
      workerAgent: 'claude-code' as const,
    }));

    const result = await prepareCombatFollowupRuntimeContext({
      prompt: '1021',
      projectId: 'saga2',
      workingDir: 'C:/Workspace/saga2/saga2_project',
      resolveCombatServerTarget,
    });

    const saga2Paths = saga2ProjectPaths('C:/Workspace/saga2/saga2_project');

    expect(resolveCombatServerTarget).toHaveBeenCalledWith('saga2');
    expect(result?.vendorOptionsPatch).toMatchObject({
      mekaCombatTargetSkillId: '1021',
      // 整条消息只回一个正整数 = 用户明确绑定（首轮追问后的标准形态），仍是 confirmed。
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatRequestScope: 'single-skill',
      mekaCombatRequestScopeState: 'confirmed',
      // 口径统一：单技能目标已由用户确认 + 参考已注入 ⇒ 依据是项目参考（不再要求 supported）。
      mekaCombatEvidenceBasis: 'project-reference',
      mekaCombatTargetExportAttempted: undefined,
      mekaCombatTargetExportCompleted: undefined,
      mekaCombatServerRemoteHostId: 'mcpr:server-1',
      mekaCombatServerWorkerAgent: 'claude-code',
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatPlanApproved: false,
      mekaCombatProjectRefPaths: [
        saga2Paths.moduleEditorSkillPath,
        saga2Paths.damageEncodingRulePath,
      ],
      mekaCombatReadOnlyUnityCommands: [
        'legacy_module_query_nodes',
        'legacy_module_audit_coverage',
      ],
    });
    expect(result?.promptSection).toContain('[SAGA2_COMBAT_TARGET]');
    expect(result?.promptSection).toContain('targetSkillId: 1021');
    expect(result?.promptSection).toContain('由用户确认并由 Host 绑定的唯一技能 ID');
    expect(result?.promptSection).toContain('[SAGA2_PROJECT_PATHS]');
    expect(result?.promptSection).toContain(`unityClientRoot: ${saga2Paths.unityClientRoot}`);
    expect(result?.promptSection).toContain(
      `unityAgentsReadCommand: Get-Content -LiteralPath '${saga2Paths.unityAgentsPath}' -Encoding UTF8`,
    );
    expect(result?.promptSection).toContain(
      `moduleEditorSkillPath: ${saga2Paths.moduleEditorSkillPath}`,
    );
    expect(result?.promptSection).toContain(
      `damageEncodingRulePath: ${saga2Paths.damageEncodingRulePath}`,
    );
    expect(result?.promptSection).toContain(
      `moduleEditorSkillReadCommand: Get-Content -LiteralPath '${saga2Paths.moduleEditorSkillPath}' -Encoding UTF8`,
    );
    expect(result?.promptSection).toContain(
      `damageEncodingRuleReadCommand: Get-Content -LiteralPath '${saga2Paths.damageEncodingRulePath}' -Encoding UTF8`,
    );
    expect(result?.promptSection).toContain('[SAGA2_COMBAT_SERVER_TARGET]');
    expect(result?.promptSection).toContain('serverRemoteHostId: mcpr:server-1');
    expect(result?.promptSection).toContain('serverWorkerAgent: claude-code');
  });

  it('confirms a bare positive integer in a live follow-up as the bound target', async () => {
    const result = await prepareCombatFollowupRuntimeContext({
      prompt: '1021',
      projectId: 'saga2',
      workingDir: 'C:/Workspace/saga2/saga2_project',
      resolveCombatServerTarget: vi.fn(async () => null),
    });

    // 首轮追问后用户只回一个正整数：视为用户明确绑定，目标段保持强表述。
    expect(result?.vendorOptionsPatch).toMatchObject({
      mekaCombatTargetSkillId: '1021',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatRequestScope: 'single-skill',
      mekaCombatRequestScopeState: 'confirmed',
    });
    expect(result?.promptSection).toContain('[SAGA2_COMBAT_TARGET]');
    expect(result?.promptSection).toContain('由用户确认并由 Host 绑定的唯一技能 ID');
    expect(result?.promptSection).not.toContain('尚未经用户确认');
  });

  it('keeps the target block truthful for a context-inferred (proposed) candidate', async () => {
    const opts = baseOpts({
      userPrompt: '继续。',
      vendorOptions: {
        source: 'meka',
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
        // 预留形态：值由上下文启发式推断，不是用户明确给出 ⇒ 不得声称「由用户确认」。
        mekaCombatTargetSkillId: '1019',
        mekaCombatTargetSkillIdState: 'proposed',
      },
    });

    await applyMekaRuntimeConfig(opts, { materializeSkillSnapshot: vi.fn(async () => null) });

    expect(opts.userPrompt).toContain('targetSkillId: 1019');
    expect(opts.userPrompt).toContain('尚未经用户确认');
    expect(opts.userPrompt).not.toContain('由用户确认并由 Host 绑定的唯一技能 ID');
    // 非表范围会话不会被「继续」误当成范围审批。
    expect(opts.vendorOptions).not.toHaveProperty('mekaCombatScopeApproved');
  });

  it('clears stale export evidence in the live follow-up patch', async () => {
    const result = await prepareCombatFollowupRuntimeContext({
      prompt: '技能 ID: 1021，继续修改',
      projectId: 'saga2',
      workingDir: 'C:/Workspace/saga2/saga2_project',
      sessionId: 'live-followup-1',
      resolveCombatServerTarget: vi.fn(async () => null),
    });
    const liveOptions: Record<string, unknown> = {
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetExportAttempted: true,
      mekaCombatTargetExportCompleted: true,
      mekaCombatServerCapabilityStatus: 'supported',
      mekaCombatPlanApproved: true,
    };
    Object.assign(liveOptions, result?.vendorOptionsPatch);
    expect(liveOptions).toMatchObject({
      mekaCombatTargetSkillId: '1021',
      mekaCombatTargetExportAttempted: undefined,
      mekaCombatTargetExportCompleted: undefined,
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatPlanApproved: false,
    });
  });

  it('injects an unavailable server target when follow-up target resolution fails', async () => {
    const result = await prepareCombatFollowupRuntimeContext({
      prompt: '技能 ID 是 1021',
      projectId: 'saga2',
      workingDir: 'C:/Workspace/saga2/saga2_project',
      resolveCombatServerTarget: vi.fn(async () => {
        throw new Error('transport unavailable');
      }),
    });

    expect(result?.vendorOptionsPatch).toMatchObject({
      mekaCombatTargetSkillId: '1021',
      mekaCombatServerRemoteHostId: undefined,
      mekaCombatServerWorkerAgent: undefined,
    });
    expect(result?.promptSection).toContain('[SAGA2_COMBAT_SERVER_TARGET]');
    expect(result?.promptSection).toContain('status: unavailable');
  });

  it('clears target and server routing for an ambiguous follow-up without resolving a worker', async () => {
    const resolveCombatServerTarget = vi.fn();
    const result = await prepareCombatFollowupRuntimeContext({
      prompt: '对比技能 1019 和技能 1010',
      projectId: 'saga2',
      workingDir: 'C:/Workspace/saga2/saga2_project',
      resolveCombatServerTarget,
    });

    expect(resolveCombatServerTarget).not.toHaveBeenCalled();
    const saga2Paths = saga2ProjectPaths('C:/Workspace/saga2/saga2_project');
    expect(result).toEqual({
      vendorOptionsPatch: {
        mekaCombatTargetSkillId: undefined,
        mekaCombatTargetSkillIdState: 'ambiguous',
        mekaCombatTargetSkillIds: ['1019', '1010'],
        mekaCombatRequestScope: 'single-skill',
        mekaCombatRequestScopeState: 'missing',
        mekaCombatScopeSelection: undefined,
        mekaCombatScopeSourceTables: undefined,
        mekaCombatScopeSkillIds: undefined,
        mekaCombatScopeApproved: false,
        mekaCombatProjectRefPaths: [
          saga2Paths.moduleEditorSkillPath,
          saga2Paths.damageEncodingRulePath,
        ],
        mekaCombatReadOnlyUnityCommands: [
          'legacy_module_query_nodes',
          'legacy_module_audit_coverage',
        ],
        mekaCombatServerRemoteHostId: undefined,
        mekaCombatServerWorkerAgent: undefined,
        mekaCombatServerCapabilityStatus: 'unchecked',
        mekaCombatPlanApproved: false,
        mekaCombatReferenceSkillId: undefined,
        mekaCombatTargetExportCompleted: undefined,
      },
      promptSection: null,
    });
  });

  it('classifies a table-scope request without binding a single skill ID', async () => {
    const prompt = [
      '编辑模块:把目前所有怪物技能(怪物配置表里配置的正在使用',
      '的)使用的伤害行为10000的data都改成取100%的怪物功击力。补充说明：4 取攻击力百分比',
      '-101 技能表参数1  （-102就是参数2） 以后改值可以直接技能表里改',
      '1 自身（一般攻击力的都是怪物自身）',
    ].join('\n');
    const resolveCombatServerTarget = vi.fn(async () => null);

    const result = await prepareCombatFollowupRuntimeContext({
      prompt,
      projectId: 'saga2',
      workingDir: 'C:/Workspace/saga2/saga2_project',
      resolveCombatServerTarget,
    });

    // 表范围没有单值目标：不得再把正则猜出的数字当绑定，也不得使用歧义载体键。
    expect(result?.vendorOptionsPatch).toMatchObject({
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatTargetSkillIds: undefined,
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeSelection: '所有怪物技能',
      mekaCombatScopeSourceTables: [],
      mekaCombatScopeSkillIds: [],
      mekaCombatScopeApproved: false,
    });
    expect(resolveCombatServerTarget).not.toHaveBeenCalled();
    // 单技能目标段不注入，由表范围段替代。
    expect(result?.promptSection).not.toContain('[SAGA2_COMBAT_TARGET]');
    expect(result?.promptSection).toContain('[SAGA2_COMBAT_SCOPE]');
    expect(result?.promptSection).toContain('requestScope: table-scope');
    expect(result?.promptSection).toContain('targetSkillId: none');
    expect(result?.promptSection).toContain('用户确认前禁止任何写入');
    // 范围发现的只读 Unity 通道由 Host 白名单注入，且写明 projectPath 约束。
    expect(result?.vendorOptionsPatch).toMatchObject({
      mekaCombatReadOnlyUnityCommands: [
        'legacy_module_query_nodes',
        'legacy_module_audit_coverage',
      ],
    });
    expect(result?.promptSection).toContain('legacy_module_query_nodes');
    expect(result?.promptSection).toContain('禁止用 unity_execute');
    expect(result?.promptSection).toContain('[SAGA2_PROJECT_PATHS]');
  });

  it('never orders an unreachable server Worker recovery from the table-scope block (A5)', async () => {
    const tableScopeOptions = {
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeApproved: false,
      mekaCombatEvidenceBasis: 'project-reference',
    };
    // 项目参考口径：参考未覆盖/冲突时的出口必须是「回落单技能流程 + 绑定一个技能 ID」，
    // 不得命令模型派发只读服务器 Worker（表范围没有路由键，那条路走不通）。
    const projectReference = combatScopePrompt(tableScopeOptions) ?? '';
    expect(projectReference).toContain('回落到单技能流程');
    expect(projectReference).not.toContain('必须改走只读服务器 Worker');
    expect(projectReference).not.toContain('必须用只读服务器 Worker 取得 supported 回执');
    // server-report 口径（缺省 fail-closed）同样是回落，而不是派发。
    const serverReport = combatScopePrompt({ ...tableScopeOptions, mekaCombatEvidenceBasis: undefined }) ?? '';
    expect(serverReport).toContain('回落到单技能流程');
    expect(serverReport).not.toContain('必须用只读服务器 Worker 取得 supported 回执后再实施');
    expect(serverReport).toContain('不要尝试派发 Worker');
    // 但服务器回执本身没有被取消：绑定唯一 ID 之后仍要按单技能流程取得它。
    expect(serverReport).toContain('supported 回执');
  });

  it('commits live combat context only from the accepted-message hook', async () => {
    const source = await fs.readFile(new URL('../register.ts', import.meta.url), 'utf8');
    const prepare = source.indexOf('prepareSendUserMessage: async');
    const normalize = source.indexOf('await prepareUserMessageForAgent', prepare);
    const resolve = source.indexOf('await prepareCombatFollowupRuntimeContext', prepare);
    const accepted = source.indexOf('onAccepted: async', resolve);
    const refresh = source.indexOf('await liveSession.setVendorOptions', accepted);
    const undispatched = source.indexOf('onUndispatched: async', refresh);

    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(normalize).toBeGreaterThan(prepare);
    expect(resolve).toBeGreaterThan(normalize);
    expect(accepted).toBeGreaterThan(resolve);
    expect(refresh).toBeGreaterThan(accepted);
    expect(undispatched).toBeGreaterThan(refresh);
    expect(source.slice(resolve, accepted)).not.toContain('setVendorOptions');
  });

  it('is wired into register bootstrap before maker.createSession', async () => {
    const source = await fs.readFile(new URL('../register.ts', import.meta.url), 'utf8');
    const bootstrap = source.indexOf('async function bootstrapSession');
    const applyRuntime = source.indexOf('await applyMekaRuntimeConfig(o,', bootstrap);
    const createSession = source.indexOf('await maker.createSession(o)', bootstrap);

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
      workflow: null,
      workflowRecoveredFromRole: false,
      combatEnvironmentReady: null,
    });
    expect(opts.userPrompt).toContain('[MEKA_ROLE_CONTEXT]');
    expect(opts.userPrompt).toContain('roleId: general-development');
    expect(opts.userPrompt).toContain('displayName: 通用开发');
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
      mekaRoleId: 'general-development',
      mekaMcpProviderIds: ['mcp-router', 'project-agent', 'meka-design'],
      mekaMcpInlineConfigs: [
        { id: 'local-http', transport: 'http', url: 'https://example.invalid/mcp' },
      ],
    });
    expect(materialize).toHaveBeenCalledWith(opts.id, runtime().skills);
  });

  it('does not inject active Router guidance into ordinary Meka tasks', async () => {
    const opts = baseOpts({ userPrompt: 'USER PROMPT' });
    const materialize = vi.fn(async () => null);
    const prepareRuntimeMcp = vi.fn((entries: readonly MekaRoleMcpEntry[]) => ({
      providerIds: entries
        .filter(
          (entry): entry is Extract<typeof entry, { providerId: string }> => 'providerId' in entry,
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

  it('does not inject the combat startup gate prompt for a combat role', async () => {
    const opts = baseOpts({ mekaRoleId: 'combat-development' });
    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () =>
        runtime({
          roleId: 'combat-development',
          roleDisplayName: '战斗开发',
          workflow: 'saga2-combat-development-v1',
        }),
      ),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      materializeSkillSnapshot: vi.fn(async () => null),
    });
    expect(environmentServices.p4.get).not.toHaveBeenCalled();
    expect(environmentServices.router.listInstances).not.toHaveBeenCalled();
    expect(opts.userPrompt).not.toContain('[SAGA2_COMBAT_ENVIRONMENT_GATE]');
    expect(opts.userPrompt).not.toContain('# SAGA2 战斗开发');
    expect(opts.vendorOptions).not.toHaveProperty('mekaCombatEnvironmentReady');
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

  it('does not run an aggregate combat environment gate at session startup', async () => {
    const opts = baseOpts({ mekaRoleId: 'combat-development' });

    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () =>
        runtime({
          roleId: 'combat-development',
          roleDisplayName: '战斗开发',
          workflow: 'saga2-combat-development-v1',
        }),
      ),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      materializeSkillSnapshot: vi.fn(async () => null),
    });

    expect(environmentServices.p4.get).not.toHaveBeenCalled();
    expect(environmentServices.router.listInstances).not.toHaveBeenCalled();
    expect(opts.userPrompt).not.toContain('[SAGA2_COMBAT_ENVIRONMENT_GATE]');
    expect(opts.vendorOptions).toMatchObject({
      codexNativeSubagentsDisabled: true,
    });
    expect(opts.vendorOptions).not.toHaveProperty('mekaCombatEnvironmentReady');
  });

  it('injects the frozen combat controller Skill body into new and resumed combat tasks', async () => {
    const skillBody = '# Combat Controller\n\nSTATUS_THEN_TARGET_EXPORT';
    const snapshot = {
      revision: 'e'.repeat(64),
      pluginPath: 'C:/CindyMeka/meka-skill-snapshots/revisions/e/claude-plugin',
      files: [
        {
          relativePath: 'skills/combat-skill-configuration/SKILL.md',
          contentBase64: Buffer.from(skillBody).toString('base64'),
          digest: '5'.repeat(64),
        },
      ],
    };
    const materializeSkillSnapshot = vi.fn(async () => snapshot);
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      userPrompt: '技能 ID：1021，请生成。',
    });

    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () =>
        runtime({
          roleId: 'combat-development',
          roleDisplayName: '战斗开发',
          workflow: 'saga2-combat-development-v1',
        }),
      ),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      materializeSkillSnapshot,
    });

    expect(opts.userPrompt).toContain('[SAGA2_COMBAT_CONTROLLER_SKILL]');
    // 注入的是**冻结正文的绝对路径**，不是正文本身：正文经 `--append-system-prompt`
    // 作为命令行参数传给 pi，整篇内联会在 Windows 上顶破上游的 argv 预算守卫
    // （实测 24,027 字符 ⇒ argv 30,497 > 预算 30,000）。见
    // docs/migrations/2026-09-18-origin-main-to-meka-main.md §7.8.3/§7.8.6。
    // 实现用 path.join，Windows 下是反斜杠；断言前把实际值归一成正斜杠再比。
    const normalizedPrompt = (opts.userPrompt ?? '').replace(/\\/g, '/');
    expect(normalizedPrompt).toContain(
      `${snapshot.pluginPath}/skills/combat-skill-configuration/SKILL.md`,
    );
    expect(opts.userPrompt).toContain('执行前必须先把该文件完整读完');
    expect(opts.userPrompt).toContain('不要读取、枚举或发现任何其它 SKILL.md');
    // 回归防线：正文**不得**再出现在 prompt 里（否则 argv 立刻回到超限状态）。
    expect(opts.userPrompt).not.toContain('STATUS_THEN_TARGET_EXPORT');

    const resumed = baseOpts({
      userPrompt: '继续。',
      vendorOptions: {
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatTargetSkillId: '1021',
        mekaCombatTargetSkillIdState: 'confirmed',
      },
    });
    await applyMekaRuntimeConfig(resumed, { materializeSkillSnapshot });

    expect(resumed.userPrompt).toContain('[SAGA2_COMBAT_CONTROLLER_SKILL]');
    expect((resumed.userPrompt ?? '').replace(/\\/g, '/')).toContain(
      `${snapshot.pluginPath}/skills/combat-skill-configuration/SKILL.md`,
    );
    expect(resumed.userPrompt).not.toContain('STATUS_THEN_TARGET_EXPORT');
    expect((resumed.userPrompt ?? '').match(/\[SAGA2_COMBAT_CONTROLLER_SKILL\]/g)?.length).toBe(1);
  });

  it('isolates remote server workers from local combat environment state', async () => {
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      remoteHostId: 'mcpr:server-1',
      orcaRole: 'worker',
      vendorOptions: { orcaRole: 'worker', orcaLeadSessionId: 'lead-1' },
    });

    const materialize = vi.fn(async () => null);
    const prepareRuntimeMcp = vi.fn(() => ({ providerIds: [], inlineConfigs: [] }));
    const resolvePlatformSkills = vi.fn(async () => [platformSkill()]);
    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () =>
        runtime({
          roleId: 'combat-development',
          roleDisplayName: '战斗开发',
          workflow: 'saga2-combat-development-v1',
        }),
      ),
      resolvePlatformSkills,
      prepareRuntimeMcp,
      materializeSkillSnapshot: materialize,
    });

    expect(result).toMatchObject({
      didApply: true,
      mcpProviderIds: [],
      inlineMcpCount: 0,
      skillsCount: 0,
      skillSnapshot: null,
    });
    expect(prepareRuntimeMcp).toHaveBeenCalledWith([]);
    expect(materialize).toHaveBeenCalledWith(opts.id, []);
    expect(resolvePlatformSkills).not.toHaveBeenCalled();
    expect(opts.nativeSkillPluginPath).toBeUndefined();
    expect(opts.nativeSkillRevision).toBeUndefined();
    expect(opts.vendorOptions).toMatchObject({
      mekaWorkflow: 'saga2-combat-server-worker-v1',
      source: 'meka',
      mekaProjectId: 'saga2',
      codexNativeSubagentsDisabled: true,
    });
    expect(opts.vendorOptions).not.toHaveProperty('mekaCombatEnvironmentReady');
    expect(opts.vendorOptions).not.toHaveProperty('mekaCombatPlanApproved');
    expect(opts.userPrompt).toContain('[SAGA2_COMBAT_REMOTE_SERVER_WORKER]');
    expect(opts.userPrompt).toContain('整个任务永久只读');
    expect(opts.userPrompt).toContain('serverCapabilityReport');
    expect(opts.userPrompt).toContain('targetSkillId（与 Lead 绑定值一致的正整数）');
    expect(opts.userPrompt).toContain('唯一一次完整终态回复');
    expect(opts.userPrompt).toContain('不要搜索或重试 orca_worker_bridge');
    expect(opts.userPrompt).toContain('Orca 会把终态回复自动桥接给 Lead');
    expect(opts.userPrompt).toContain('git grep -l -E <精确符号表达式> HEAD -- internal/battle');
    expect(opts.userPrompt).toContain('git grep -n -C 24 -E <精确符号表达式> HEAD -- <path>');
    expect(opts.userPrompt).toContain('所有 `git grep` 都必须显式写 `HEAD`');
    expect(opts.userPrompt).toContain('不要用 `git show` 打开大型实现文件');
    expect(opts.userPrompt).toContain('[SAGA2_MODULE_FIRST]');
    expect(opts.userPrompt).toContain('只核查其中依赖当前服务器解释的窄语义');
    expect(opts.userPrompt).toContain('没有完整专用函数不等于模块组合不支持');
    expect(opts.userPrompt).not.toContain('battle-designer-server-development');
    expect(opts.userPrompt).not.toContain(
      'SAGA2 server code lives behind MCPRouter as saga2-server.',
    );
    expect(opts.userPrompt).not.toContain('[MEKA_ROLE_CONTEXT]');
    expect(opts.userPrompt).not.toContain('[MEKA_PLATFORM_CAPABILITIES]');
  });

  it('arms autonomous execution only for the local combat role', async () => {
    const resolveCombatServerTarget = vi.fn(async () => ({
      remoteHostId: 'mcpr:server-1',
      workerAgent: 'claude-code' as const,
    }));
    const opts = baseOpts({
      mekaRoleId: 'combat-development',
      userPrompt: '技能 ID：1019。检查当前伤害目标。',
    });
    await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () =>
        runtime({
          roleId: 'combat-development',
          roleDisplayName: '战斗开发',
          workflow: 'saga2-combat-development-v1',
        }),
      ),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      materializeSkillSnapshot: vi.fn(async () => null),
      resolveCombatServerTarget,
    });
    const saga2Paths = saga2ProjectPaths('C:/Workspace/saga2/saga2_project');
    expect(opts.vendorOptions).toMatchObject({
      mekaCombatExecutionMode: 'autonomous-user-request',
      mekaCombatTargetSkillId: '1019',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatServerRemoteHostId: 'mcpr:server-1',
      mekaCombatServerWorkerAgent: 'claude-code',
    });
    expect(resolveCombatServerTarget).toHaveBeenCalledWith('saga2');
    expect(opts.userPrompt).toContain('[SAGA2_COMBAT_EXECUTION_AUTHORIZATION]');
    expect(opts.userPrompt).toContain('[SAGA2_COMBAT_TARGET]');
    expect(opts.userPrompt).toContain('targetSkillId: 1019');
    expect(opts.userPrompt).toContain('[SAGA2_PROJECT_PATHS]');
    expect(opts.userPrompt).toContain(`projectRoot: ${saga2Paths.projectRoot}`);
    expect(opts.userPrompt).toContain(`unityClientRoot: ${saga2Paths.unityClientRoot}`);
    expect(opts.userPrompt).toContain(`legacyModuleJsonTempRoot: ${os.tmpdir()}`);
    expect(opts.userPrompt).toContain(`unityAgentsPath: ${saga2Paths.unityAgentsPath}`);
    expect(opts.userPrompt).toContain(
      `legacyModuleProtocolCodecPath: ${saga2Paths.legacyModuleProtocolCodecPath}`,
    );
    expect(opts.userPrompt).toContain('[SAGA2_COMBAT_SERVER_TARGET]');
    expect(opts.userPrompt).toContain('serverRemoteHostId: mcpr:server-1');
    expect(opts.userPrompt).toContain('serverWorkerAgent: claude-code');
    expect(opts.userPrompt).toContain('create_worker 的 remote_host_id 和 agent 必须分别原样使用');
  });

  it('updates the confirmed combat skill ID from a resumed user message', async () => {
    const opts = baseOpts({
      userPrompt: '现在检查技能 ID 1020。',
      vendorOptions: {
        source: 'meka',
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatTargetSkillId: '1019',
      },
    });

    await applyMekaRuntimeConfig(opts, {
      materializeSkillSnapshot: vi.fn(async () => null),
    });

    const saga2Paths = saga2ProjectPaths('C:/Workspace/saga2/saga2_project');
    expect(opts.vendorOptions).toMatchObject({
      mekaCombatTargetSkillId: '1020',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatServerCapabilityStatus: 'unchecked',
    });
    expect(opts.userPrompt).toContain('targetSkillId: 1020');
    expect(opts.userPrompt).toContain(`unityClientRoot: ${saga2Paths.unityClientRoot}`);
  });

  it('invalidates server evidence when a resumed combat task changes skill ID', async () => {
    const opts = baseOpts({
      userPrompt: '改为检查技能 ID 1020。',
      vendorOptions: {
        source: 'meka',
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
        mekaCombatExecutionMode: 'autonomous-user-request',
        mekaCombatTargetSkillId: '1019',
        mekaCombatTargetSkillIdState: 'confirmed',
        mekaCombatServerCapabilityStatus: 'supported',
        mekaCombatPlanApproved: true,
        mekaCombatTargetExportCompleted: true,
      },
    });

    await applyMekaRuntimeConfig(opts, {
      materializeSkillSnapshot: vi.fn(async () => null),
    });

    expect(opts.vendorOptions).toMatchObject({
      mekaCombatTargetSkillId: '1020',
      mekaCombatTargetSkillIdState: 'confirmed',
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatPlanApproved: false,
    });
    expect(opts.vendorOptions?.mekaCombatTargetExportCompleted).toBeUndefined();
  });

  it('restores autonomous execution when resuming an already-resolved combat session', async () => {
    const opts = baseOpts({
      userPrompt: 'RESUMED USER PROMPT',
      vendorOptions: {
        source: 'meka',
        mekaRuntimeResolved: true,
        mekaWorkflow: 'saga2-combat-development-v1',
      },
    });

    await applyMekaRuntimeConfig(opts, {
      materializeSkillSnapshot: vi.fn(async () => null),
    });
    await applyMekaRuntimeConfig(opts, {
      materializeSkillSnapshot: vi.fn(async () => null),
    });

    expect(opts.vendorOptions).toMatchObject({
      mekaRuntimeResolved: true,
      mekaWorkflow: 'saga2-combat-development-v1',
      mekaCombatExecutionMode: 'autonomous-user-request',
    });
    expect(
      (opts.userPrompt ?? '').match(/\[SAGA2_COMBAT_EXECUTION_AUTHORIZATION\]/g)?.length ?? 0,
    ).toBe(1);
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

  it.each([
    ['planner', 'general-development'],
    ['artist', 'general-development'],
    ['tester', 'general-development'],
    ['programmer', 'general-development'],
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
    expect(second.didApply).toBe(false);
    expect(resolveRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(prepareRuntimeMcp).toHaveBeenCalledTimes(1);
    expect(materializeSkillSnapshot).toHaveBeenCalledTimes(2);
    expect(opts.userPrompt).toBe(promptAfterFirstBootstrap);
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

