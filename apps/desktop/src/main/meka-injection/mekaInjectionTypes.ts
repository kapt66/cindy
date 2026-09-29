/**
 * Meka 注入层的类型契约（解析 → 计划 → 落地三层共用）。
 *
 * 这里的名字是**对外契约**：`applyMekaRuntimeConfig` 的入参/返回类型都来自本文件。
 * 依赖集合与落地结果**只有一个名字**：`ApplyMekaRuntimeConfigDeps` /
 * `AppliedMekaRuntimeConfig`（同义别名会把真名架空，见
 * `docs/dev-rules/meka-injection-layer.md` §2）。
 */

import type { MekaRoleMcpEntry } from '../../shared/meka-projects.js';
import type { MakerSessionCreateOpts } from '../maker-ipc/sessionRequest.js';
import type { MekaRuntimeConfig, MekaRuntimeSkill } from '../meka-projects/runtimeConfig.js';
import type { MekaSkillSnapshot } from '../meka-projects/skillSnapshot.js';

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
}

export interface AppliedMekaRuntimeConfig {
  didApply: boolean;
  mcpProviderIds: string[];
  inlineMcpCount: number;
  skillsCount: number;
  platformSkillsCount: number;
  skillSnapshot: MekaSkillSnapshot | null;
}

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
  | 'meka.role-context'
  | 'meka.project-references'
  | 'meka.role-prompt';

/**
 * order 表：升序 = 自上而下（最终 prompt 里的先后）。
 *
 * 数值是契约而不是实现细节：60/65/70 原地冻结，**不得重排**；新增段落只能插空档。
 * `meka.project-references` 占 65，是 60 与 70 之间唯一的空档。
 */
export const MEKA_PROMPT_SEGMENT_ORDER: Readonly<Record<MekaPromptSegmentId, number>> = {
  'meka.role-context': 60,
  'meka.project-references': 65,
  'meka.role-prompt': 70,
};

/** 一个注入段落：`order` 决定最终位置，`text` 由 `mekaPrompts.ts` / 角色 prompt 提供。 */
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
  /** true = resume 短路分支：不重解析项目/角色、不重算 MCP，只写冻结路径的补丁（I4）。 */
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
   * 即使补丁为空也要重新赋值 `opts.vendorOptions`：保持同一写入形状，避免 opts 键插入顺序
   * 与对象引用与现状不同。
   */
  rewriteVendorOptions: boolean;
  /** 物化出的技能快照；null = 本路径未物化（非 Meka 会话 / 只回填持久绑定的早返回）。 */
  skills: { snapshot: MekaSkillSnapshot | null; revision: string | null } | null;
  /** 需要挂载到 create opts 的原生技能（远端会话 / 空选择为 null）。 */
  nativeSkill: MekaNativeSkillMount | null;
  /** MCP 落地结果（provider ids 与 inline 配置）。 */
  mcp: { providerIds: string[]; inlineConfigs: MekaInlineMcpConfig[] };
  platformSkillsCount: number;
  /**
   * 解析期诊断容器（保留声明）：原成员 `workflow` / `workflowRecoveredFromRole` /
   * `combatEnvironmentReady` 属 workflow 机制，已随该机制删除；空对象是这里唯一剩余的形态。
   */
  diagnostics: Record<string, never>;
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
