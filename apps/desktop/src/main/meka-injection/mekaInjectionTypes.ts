/**
 * Meka 注入层的类型契约（解析 → 计划 → 落地三层共用）。
 *
 * 这里的名字是**对外契约**：`applyMekaRuntimeConfig` 的入参/返回类型、形态 C 的返回类型
 * 都来自本文件，重构前后必须逐一对应（提交 2 只搬位置，不改切面）。
 */

import type { MekaRoleMcpEntry } from '../../shared/meka-projects.js';
import type { MakerSessionCreateOpts } from '../maker-ipc/sessionRequest.js';
import type { MekaRuntimeConfig, MekaRuntimeSkill } from '../meka-projects/runtimeConfig.js';
import type { MekaSkillSnapshot } from '../meka-projects/skillSnapshot.js';

/** 战斗工作流的远端服务器 Worker 目标（Host 解析出的唯一目标）。 */
export interface MekaCombatServerWorkerTarget {
  remoteHostId: string;
  workerAgent: 'claude-code' | 'codex';
}

export interface PersistedMekaSessionBinding {
  workspaceKind: MakerSessionCreateOpts['workspaceKind'];
  mekaProjectId: string | null;
  mekaRoleId: string | null;
  mekaRole: Exclude<MakerSessionCreateOpts['mekaRole'], undefined>;
}

export interface ApplyMekaRuntimeConfigDeps {
  resolveRuntimeConfig?: (projectId: string, roleId: string) => Promise<MekaRuntimeConfig>;
  resolvePlatformSkills?: () => Promise<MekaRuntimeSkill[]>;
  prepareRuntimeMcp?: (entries: readonly MekaRoleMcpEntry[]) => {
    providerIds: string[];
    inlineConfigs: Array<Extract<MekaRoleMcpEntry, { transport: unknown }>>;
  };
  materializeSkillSnapshot?: (
    sessionId: string,
    skills: readonly MekaRuntimeConfig['skills'][number][],
  ) => Promise<MekaSkillSnapshot | null>;
  readPersistedSession?: (sessionId: string) => Promise<PersistedMekaSessionBinding | null>;
  resolveCombatServerTarget?: (projectId: string) => Promise<MekaCombatServerWorkerTarget | null>;
}

export interface AppliedMekaRuntimeConfig {
  didApply: boolean;
  mcpProviderIds: string[];
  inlineMcpCount: number;
  skillsCount: number;
  platformSkillsCount: number;
  skillSnapshot: MekaSkillSnapshot | null;
  workflow: MekaRuntimeConfig['workflow'] | null;
  workflowRecoveredFromRole: boolean;
  combatEnvironmentReady: boolean | null;
}

/*
 * 依赖集合与落地结果**只有一个名字**：`ApplyMekaRuntimeConfigDeps` /
 * `AppliedMekaRuntimeConfig`。重构期曾并列 `MekaInjectionDeps` / `MekaInjectionResult` /
 * `MekaTurnInjection` 三个同义别名，结果是真名被架空、别名只在本层内部流通 —— 与本层
 * 「同一个东西不给第二个名字」（见 `docs/dev-rules/meka-injection-layer.md` §2）冲突，
 * 已删除；形态 C 的返回类型继续用 `CombatFollowupRuntimeContext`。
 */

/** 需要回填到 create opts 的会话绑定（持久化 hydration / 遗留角色回填）。 */
export interface MekaSessionBindingPatch {
  workspaceKind?: MakerSessionCreateOpts['workspaceKind'];
  mekaProjectId?: string | null;
  mekaRoleId?: string | null;
  mekaRole?: MakerSessionCreateOpts['mekaRole'];
}

/**
 * 注入段 id：稳定标识，一个语义一个 id。测试与后续扩展按 id 断言，
 * 不再依赖「谁先 prepend」这种涌现顺序。
 */
export type MekaPromptSegmentId =
  | 'meka.combat.controller-skill'
  | 'meka.combat.server-target'
  | 'meka.combat.project-paths'
  | 'meka.combat.scope'
  | 'meka.combat.target'
  | 'meka.combat.execution-authorization'
  | 'meka.role-context'
  | 'meka.role-prompt'
  | 'meka.combat.server-worker';

/**
 * order 表：升序 = 自上而下（最终 prompt 里的先后）。
 *
 * 数值是契约而不是实现细节：它对应重构前 7 次 `prependPromptSection` 倒推出的现状顺序，
 * 重构后必须逐字节一致（基线用例的 order 断言钉住）。**新增段落只能插空档（如 15/25/35），
 * 不得重排既有段落。**`meka.combat.scope` 占 35：那是 30 与 40 之间唯一的空档。
 */
export const MEKA_PROMPT_SEGMENT_ORDER: Readonly<Record<MekaPromptSegmentId, number>> = {
  'meka.combat.controller-skill': 10,
  'meka.combat.server-target': 20,
  'meka.combat.project-paths': 30,
  'meka.combat.scope': 35,
  'meka.combat.target': 40,
  'meka.combat.execution-authorization': 50,
  'meka.role-context': 60,
  'meka.role-prompt': 70,
  'meka.combat.server-worker': 80,
};

/** 一个注入段落：`order` 决定最终位置，`text` 必须与现状逐字节一致。 */
export interface MekaPromptSegment {
  id: MekaPromptSegmentId;
  order: number;
  text: string;
}

/** 按 id 表取 order 的段落工厂：调用方不得手写 order，避免静默重排。 */
export function createMekaPromptSegment(id: MekaPromptSegmentId, text: string): MekaPromptSegment {
  return { id, order: MEKA_PROMPT_SEGMENT_ORDER[id], text };
}

/** inline Meka MCP 配置条目（transport 形态）。 */
export type MekaInlineMcpConfig = Extract<MekaRoleMcpEntry, { transport: unknown }>;

/**
 * 要挂到 create opts 的原生技能插件（I3：revision 是该任务冻结值）。
 *
 * 落地形态由 harness 自己决定（本层不感知）：claude-code 当本地 plugin 挂整目录、
 * codex 注册 `<pluginPath>/skills` 为额外原生根、pi 把 `<pluginPath>/skills/<id>` 作为
 * 显式 `--skill` 目录传入。远端会话在解析阶段就为 null（I3）。
 */
export interface MekaNativeSkillMount {
  pluginPath: string;
  revision: string;
}

/**
 * 解析阶段的产物：结构化、agent 无关，可只读检查（测试直接断言字段）。
 * 落地（写 opts）由 `applyMekaInjection` 完成；本对象不再重解析、不再做 I/O。
 */
export interface MekaInjectionPlan {
  /** true = resume 短路分支：只补战斗契约，不重解析项目/角色（I4）。 */
  frozen: boolean;
  /**
   * 注入段。解析阶段按**现状的执行次序**写入，落地时按 `order` 升序渲染。
   * 「执行次序与最终次序相反」是重构前的真相，这里显式区分，不再用调用顺序表达语义。
   */
  promptSegments: MekaPromptSegment[];
  /** 需要回填 create opts 的会话绑定；null = 无需回填。 */
  sessionBindingPatch: MekaSessionBindingPatch | null;
  /** 需要写进 `opts.vendorOptions` 的补丁（键插入顺序即 I2 的契约）。 */
  vendorOptionsPatch: Record<string, unknown>;
  /**
   * 即使补丁为空也要重新赋值 `opts.vendorOptions`：resume 短路分支的现状会无条件重写
   * 该字段，保持同一写入形状，避免 opts 键插入顺序与对象引用与重构前不同。
   */
  rewriteVendorOptions: boolean;
  /** 物化出的技能快照；null = 本路径未物化（例如 resume 缺 session id）。 */
  skills: { snapshot: MekaSkillSnapshot | null; revision: string | null } | null;
  /** 需要挂载到 create opts 的原生技能（远端会话 / 空选择为 null）。 */
  nativeSkill: MekaNativeSkillMount | null;
  /** MCP 落地结果（provider ids 与 inline 配置）。 */
  mcp: { providerIds: string[]; inlineConfigs: MekaInlineMcpConfig[] };
  platformSkillsCount: number;
  diagnostics: {
    workflow: MekaRuntimeConfig['workflow'] | null;
    workflowRecoveredFromRole: boolean;
    combatEnvironmentReady: boolean | null;
  };
  /** 解析阶段就已确定的落地结果；`applyMekaInjection` 原样返回，不重算。 */
  result: AppliedMekaRuntimeConfig;
}

/** `resolveMekaInjection` 的入参（形态 A）。 */
export interface MekaInjectionInput {
  /** 会话 id。生产上的唯一来源是 `opts.id`（见 `applyMekaRuntimeConfig`）；空串 = 无 id。 */
  sessionId: string;
  opts: MakerSessionCreateOpts;
  deps?: ApplyMekaRuntimeConfigDeps;
}

export type CombatSkillIdParseResult =
  | { state: 'missing' }
  | { state: 'valid'; skillId: string }
  | { state: 'ambiguous'; skillIds: string[] };

/**
 * 单一漏斗 `combatSkillIdVendorPatchFromUserPrompt` 的纯分类结果（无 vendorOptions、无 I/O）。
 *
 * - `single-skill/confirmed`：用户明确点了一个技能（三种 ID 标注写法，或整条消息只有一个正整数）。
 * - `single-skill/missing`：多个标注 ID（歧义）⇒ 仍需用户收敛到一个。
 * - `table-scope/proposed`：识别出表范围请求，等待用户确认解析出的目标集合。
 *
 * **历史删减（A6）**：`single-skill/proposed`（上下文推断的候选）与 `'declined'` 范围状态从来
 * 没有生产者 —— `classifyCombatRequestScope` 永远不会返回它们，`'declined'` 也从未被写入。
 * 连带删除的 `MekaCombatRequestScope` / `MekaCombatRequestScopeState` 两个导出没有任何引用。
 * 将来真的要引入启发式候选或「用户拒绝范围」时，必须把成员和它的生产分支**一起**加回来，
 * 而不是留一个死成员等它自己长出来。
 */
export type CombatRequestScopeClassification =
  | { scope: 'single-skill'; state: 'confirmed'; skillId: string }
  | { scope: 'single-skill'; state: 'missing'; skillIds: string[] }
  | {
      scope: 'table-scope';
      state: 'proposed';
      selection: string | null;
      sourceTables: string[];
    };

export interface CombatFollowupRuntimeContext {
  vendorOptionsPatch: Record<string, unknown>;
  promptSection: string | null;
}

