/**
 * 注入层第 2 层：**解析**（形态 A 的解析阶段）。
 *
 * 职责：把 create opts 与外部依赖（持久化绑定、Meka 运行期配置、平台技能、技能快照、MCP）
 * 解析成结构化 `MekaInjectionPlan`。
 *
 * 不做什么：**不写 opts**（写入全在 applyPlan），不改任何注入文本（文本在 mekaPrompts）。
 * 段落与 vendorOptions patch 按现状的**执行次序**产出，最终次序由 applyPlan 按 order 升序
 * 渲染决定。
 */

import { mekaDefaultRoleId, type MekaRoleMcpEntry } from '../../shared/meka-projects.js';
import type { MakerSessionCreateOpts } from '../maker-ipc/sessionRequest.js';
import {
  resolveMekaPlatformRuntimeSkills,
  resolveMekaRuntimeConfig,
  type MekaRuntimeConfig,
  type MekaRuntimeSkill,
} from '../meka-projects/runtimeConfig.js';
import {
  hasMekaSkillSnapshotEntries,
  materializeMekaSkillSnapshot,
  type MekaSkillSnapshot,
} from '../meka-projects/skillSnapshot.js';
import { prepareMekaRuntimeMcp } from '../mcp-integrations/meka-runtime-mcp.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { emptyMekaRuntimeResult } from './mekaApplyPlan.js';
import { mekaProjectReferencesPrompt, roleContextPrompt } from './mekaPrompts.js';
import {
  createMekaPromptSegment,
  type AppliedMekaRuntimeConfig,
  type ApplyMekaRuntimeConfigDeps,
  type MekaInjectionInput,
  type MekaInjectionPlan,
  type MekaInlineMcpConfig,
  type MekaNativeSkillMount,
  type MekaPromptSegment,
  type MekaPromptSegmentId,
  type MekaSessionBindingPatch,
} from './mekaInjectionTypes.js';

/**
 * 第 2 层解析阶段**必填**的快照物化函数：从 deps 契约上派生，不再手抄一份同形签名
 * （同形签名会在 deps 改动时静默脱钩）。`deps.materializeSkillSnapshot` 是可选注入点，
 * 缺省时由 `resolveMekaInjection` 填入生产实现。
 */
type MaterializeSkillSnapshot = NonNullable<
  ApplyMekaRuntimeConfigDeps['materializeSkillSnapshot']
>;

/** 顺序敏感的一组 vendorOptions patch：落地按同顺序 spread，键插入顺序因此不变。 */
type VendorOptionPatches = Array<Record<string, unknown>>;

/** 段落/patch 收集器：按现状执行次序累积，并模拟 prepend 结果供去重 guard 使用。 */
interface MekaPlanBuilder {
  readonly segments: MekaPromptSegment[];
  readonly patches: VendorOptionPatches;
  sessionBindingPatch: MekaSessionBindingPatch | null;
  /** 追加段落（次序 = 现状里 prependPromptSection 的执行次序）。text 为空则跳过。 */
  pushSegment(id: MekaPromptSegmentId, text: string | null): void;
  /** 现状的去重 guard：检查「已经被前序段落 prepend 过的 prompt」。 */
  hasMarker(marker: string): boolean;
}

/**
 * Meka 会话上 `opts.userPrompt` 的类型校验（有意差异，见 `docs/dev-rules/meka-injection-layer.md` §7）。
 *
 * 落地的 `prependPromptSection` 把非字符串当空串 ⇒ 非 Meka 会话里 `123` 这类脏值会被**静默
 * 丢弃**；而 `readCreateSessionOpts` 不校验 `userPrompt`（IPC 是无类型边界）。静默丢用户输入
 * 不可接受，这里统一改成显式 `INVALID_PARAMS`。
 *
 * **只在确定是 Meka 会话之后调用**（I6：非 Meka 会话零行为变化）。
 */
function assertMekaUserPromptType(userPrompt: unknown): void {
  if (userPrompt === undefined || userPrompt === null) return;
  if (typeof userPrompt === 'string') return;
  throwIpcError('INVALID_PARAMS', 'Meka session userPrompt must be a string when provided');
}

/**
 * 与现状 `prependPromptSection` 逐步 prepend 等价的累积器。
 *
 * 为什么需要它：现状的去重 guard 检查的是**已经被前序段落 prepend 过的** `opts.userPrompt`。
 * 解析阶段不再写 opts，因此这里用同一算法模拟累积结果，保证 guard 判定与重构前完全一致
 * （包括角色正文里恰好含某个 marker 的极端情况）。
 */
function createPlanBuilder(originalPrompt: unknown): MekaPlanBuilder {
  let accumulated = typeof originalPrompt === 'string' ? originalPrompt : '';
  const segments: MekaPromptSegment[] = [];
  const patches: VendorOptionPatches = [];
  return {
    segments,
    patches,
    sessionBindingPatch: null,
    pushSegment(id, text) {
      if (!text) return;
      segments.push(createMekaPromptSegment(id, text));
      accumulated = [text.trim(), accumulated.trim()].filter(Boolean).join('\n\n');
    },
    hasMarker(marker) {
      return accumulated.includes(marker);
    },
  };
}

/** 组装计划（`result` 由解析阶段给定，落地阶段原样返回、不重算）。 */
function buildPlan(input: {
  frozen: boolean;
  builder: MekaPlanBuilder;
  materialized: boolean;
  skillSnapshot: MekaSkillSnapshot | null;
  nativeSkill: MekaNativeSkillMount | null;
  mcp: { providerIds: string[]; inlineConfigs: MekaInlineMcpConfig[] };
  platformSkillsCount: number;
  rewriteVendorOptions: boolean;
  result: AppliedMekaRuntimeConfig;
}): MekaInjectionPlan {
  return {
    frozen: input.frozen,
    promptSegments: input.builder.segments,
    sessionBindingPatch: input.builder.sessionBindingPatch,
    vendorOptionsPatch: Object.assign({}, ...input.builder.patches),
    rewriteVendorOptions: input.rewriteVendorOptions,
    skills: input.materialized
      ? { snapshot: input.skillSnapshot, revision: input.skillSnapshot?.revision ?? null }
      : null,
    nativeSkill: input.nativeSkill,
    mcp: input.mcp,
    platformSkillsCount: input.platformSkillsCount,
    // workflow 机制删除：diagnostics 原有的 `workflow` / `workflowRecoveredFromRole` /
    // `combatEnvironmentReady` 三个成员已随该机制移除，容器本身（计划契约）保留。
    diagnostics: {},
    result: input.result,
  };
}

/** 技能快照物化（I/O）。失败按现状转成 INVALID_PARAMS（文案逐字不变）。 */
async function materializeSkillSnapshotOrThrow(
  materialize: MaterializeSkillSnapshot,
  sessionId: string,
  skills: readonly MekaRuntimeConfig['skills'][number][],
): Promise<MekaSkillSnapshot | null> {
  try {
    return await materialize(sessionId, skills);
  } catch (error) {
    throwIpcError(
      'INVALID_PARAMS',
      `Meka native Skill snapshot failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** 要挂到 create opts 的原生技能（I3：远端会话不暴露本地快照路径）。 */
function nativeSkillMount(
  opts: MakerSessionCreateOpts,
  snapshot: MekaSkillSnapshot | null,
): MekaNativeSkillMount | null {
  if (!snapshot || !hasMekaSkillSnapshotEntries(snapshot) || opts.remoteHostId) return null;
  return { pluginPath: snapshot.pluginPath, revision: snapshot.revision };
}

const MEKA_PLATFORM_MCP: MekaRoleMcpEntry = {
  id: 'mcp-router',
  providerId: 'mcp-router',
  enabled: true,
};

function mergePlatformSkills(
  current: readonly MekaRuntimeSkill[],
  platform: readonly MekaRuntimeSkill[],
): MekaRuntimeSkill[] {
  const merged = new Map(current.map((skill) => [skill.id, skill]));
  for (const skill of platform) merged.set(skill.id, skill);
  return [...merged.values()];
}

function mergePlatformMcp(current: readonly MekaRoleMcpEntry[]): MekaRoleMcpEntry[] {
  if (current.some((entry) => 'providerId' in entry && entry.providerId === 'mcp-router')) {
    return [...current];
  }
  return [MEKA_PLATFORM_MCP, ...current];
}

/**
 * resume 短路分支（I4）：`vendorOptions.mekaRuntimeResolved === true` 时只写冻结路径的补丁，
 * 不重解析项目/角色、不重算 MCP；角色段在这一路径下**不注入**（现状事实，与 `plan.frozen`
 * 的三段写入次序一起构成 resume 的机制）。
 *
 * 原实现在这条路径上只补战斗契约段与战斗补丁，那些内容已随 workflow 机制删除；因此这里
 * 不再 push 任何注入段，只保留机制本身：sessionId 处理、快照物化（空技能集合）、原生技能
 * 挂载与早返回 —— **不落到 bootstrap**。
 */
async function resolveFrozenInjection(input: {
  opts: MakerSessionCreateOpts;
  sessionId: string;
  currentUserPrompt: unknown;
  materialize: MaterializeSkillSnapshot;
}): Promise<MekaInjectionPlan> {
  const { opts, sessionId, currentUserPrompt, materialize } = input;
  // 到达这里即 `mekaRuntimeResolved === true`：确定是 Meka 会话，可以先校验参数。
  assertMekaUserPromptType(opts.userPrompt);
  const builder = createPlanBuilder(currentUserPrompt);

  if (!sessionId.trim()) {
    // 现状：resume 分支缺 session id 时不物化快照，直接返回空结果（补丁先于物化写入）。
    return buildPlan({
      frozen: true,
      builder,
      materialized: false,
      skillSnapshot: null,
      nativeSkill: null,
      mcp: { providerIds: [], inlineConfigs: [] },
      platformSkillsCount: 0,
      rewriteVendorOptions: false,
      result: emptyMekaRuntimeResult(),
    });
  }
  const skillSnapshot = await materializeSkillSnapshotOrThrow(materialize, sessionId, []);
  return buildPlan({
    frozen: true,
    builder,
    materialized: true,
    skillSnapshot,
    nativeSkill: nativeSkillMount(opts, skillSnapshot),
    mcp: { providerIds: [], inlineConfigs: [] },
    platformSkillsCount: 0,
    rewriteVendorOptions: false,
    result: { ...emptyMekaRuntimeResult(), skillSnapshot },
  });
}

/**
 * 常规会话创建分支：hydrate 持久绑定 → 解析项目/角色运行期 → 平台技能 → MCP → 技能快照
 * → 三个平台注入段。
 *
 * 返回 null = 现状的「非 Meka 会话」提前返回且无需回填（I6：调用方零写入）。
 */
async function resolveBootstrapInjection(input: {
  opts: MakerSessionCreateOpts;
  deps: ApplyMekaRuntimeConfigDeps;
  sessionId: string;
  currentUserPrompt: unknown;
  materialize: MaterializeSkillSnapshot;
}): Promise<MekaInjectionPlan | null> {
  const { opts, deps, sessionId, currentUserPrompt, materialize } = input;
  const builder = createPlanBuilder(currentUserPrompt);
  let workspaceKind = opts.workspaceKind;
  let projectId = opts.mekaProjectId ?? null;
  let roleId = opts.mekaRoleId ?? null;
  let hydratedPersistedSession = false;
  if (
    sessionId.length > 0 &&
    (!workspaceKind || workspaceKind === 'meka') &&
    deps.readPersistedSession
  ) {
    const persisted = await deps.readPersistedSession(sessionId);
    if (persisted) {
      hydratedPersistedSession = true;
      workspaceKind = persisted.workspaceKind;
      projectId = persisted.mekaProjectId;
      roleId = persisted.mekaRoleId;
      builder.sessionBindingPatch = {
        workspaceKind: persisted.workspaceKind,
        mekaProjectId: persisted.mekaProjectId,
        mekaRoleId: persisted.mekaRoleId,
        mekaRole: persisted.mekaRole,
      };
    }
  }
  if (workspaceKind !== 'meka') {
    // 现状：持久绑定回填发生在 workspaceKind 判定**之前**，即使会话不是 Meka 也已写回 opts
    // （否则 createSession 会丢掉 DB 里的 workspaceKind）。这里保留该副作用：只回填绑定，
    // 不做任何其它写入，result.didApply 仍为 false。
    if (!builder.sessionBindingPatch) return null;
    return buildPlan({
      frozen: false,
      builder,
      materialized: false,
      skillSnapshot: null,
      nativeSkill: null,
      mcp: { providerIds: [], inlineConfigs: [] },
      platformSkillsCount: 0,
      rewriteVendorOptions: false,
      result: emptyMekaRuntimeResult(),
    });
  }

  // 到这里 workspaceKind 已确定为 'meka'：参数校验只在这里发生，非 Meka 会话（含只回填
  // 持久绑定的早返回）保持零行为变化（I6）。
  assertMekaUserPromptType(opts.userPrompt);

  // 历史 Meka 会话有意保留旧角色列（不在此处改写数据库行）。这里按**该项目自己的**共享默认角色
  // 派生运行期角色：写死某个项目 id 会在内置角色退役后让旧会话冷启动硬失败（退役迁移
  // 已把同一批历史会话重绑到 `<projectId>-default-role`，见 shared/meka-projects.ts 的
  // RETIRED_BUILTIN_MEKA_DEFAULT_ROLE_ALIASES）。
  if (hydratedPersistedSession && projectId && !roleId) {
    roleId = mekaDefaultRoleId(projectId);
    builder.sessionBindingPatch = { ...(builder.sessionBindingPatch ?? {}), mekaRoleId: roleId };
  }
  if (!projectId || !roleId) {
    throwIpcError('INVALID_PARAMS', 'Meka session requires a project and role');
  }

  const resolveRuntime = deps.resolveRuntimeConfig ?? resolveMekaRuntimeConfig;
  const resolvePlatformSkills = deps.resolvePlatformSkills ?? resolveMekaPlatformRuntimeSkills;
  const prepareMcp = deps.prepareRuntimeMcp ?? prepareMekaRuntimeMcp;

  let runtime: MekaRuntimeConfig;
  try {
    runtime = await resolveRuntime(projectId, roleId);
  } catch (error) {
    throwIpcError(
      'INVALID_PARAMS',
      `Meka project/role configuration failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let platformSkills: MekaRuntimeSkill[] = [];
  try {
    platformSkills = await resolvePlatformSkills();
  } catch (error) {
    throwIpcError(
      'INVALID_PARAMS',
      `Meka platform capabilities failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const runtimeMcpEntries = mergePlatformMcp(runtime.mcp);
  const runtimeSkills = mergePlatformSkills(runtime.skills, platformSkills);

  let mcp: ReturnType<typeof prepareMcp>;
  try {
    mcp = prepareMcp(runtimeMcpEntries);
  } catch (error) {
    throwIpcError(
      'INVALID_PARAMS',
      `Meka project/role MCP configuration failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!sessionId.trim()) {
    throwIpcError('INVALID_PARAMS', 'Meka native Skills require a persisted session id');
  }
  const skillSnapshot = await materializeSkillSnapshotOrThrow(materialize, sessionId, runtimeSkills);

  const runtimePrompt = runtime.promptText.trim();
  if (runtimePrompt) {
    builder.pushSegment('meka.role-prompt', runtimePrompt);
  }
  // 项目参考文件清单（段 id `meka.project-references`，order 65 ⇒ 最终落在角色上下文与角色
  // prompt 之间）。空集合返回 null，整段不入 plan（与 role-prompt 文本为空时同口径）。
  const projectReferencesPrompt = mekaProjectReferencesPrompt(runtime.projectReferences);
  if (projectReferencesPrompt) {
    builder.pushSegment('meka.project-references', projectReferencesPrompt);
  }
  builder.pushSegment('meka.role-context', roleContextPrompt(runtime));

  builder.patches.push({
    source: 'meka',
    mekaRuntimeResolved: true,
    mekaProjectId: runtime.projectId,
    mekaRoleId: runtime.roleId,
    mekaMcpProviderIds: mcp.providerIds,
    mekaMcpInlineConfigs: mcp.inlineConfigs,
    mekaPolicyProviderRefs: runtime.policyProviderRefs,
    // `codexNativeSubagentsDisabled`（通用 gate：maker-core 的 codex 通道与 maker-host 消费，
    // 见 `packages/maker-core/src/agents/codex/index.ts`）原本就在这个键位，产出条件是
    // `runtime.workflow === 'saga2-combat-development-v1' || isCombatServerWorker` —— 两个判据
    // 都在 workflow 机制内、已随该机制删除，`MekaRuntimeConfig` 上没有任何存活字段能等价替代。
    // 把判据换成角色 id / 远端 worker 会给**普通任务**新增行为，与 `meka-skills.md` 的
    // 「共享默认角色及普通任务继续沿用用户的全局子任务设置」直接冲突，因此本层不再产出该键，
    // 生产者交还宿主策略经 vendorOptions 声明（同 `start_team.ts` 中立键的写法）。
  });

  return buildPlan({
    frozen: false,
    builder,
    materialized: true,
    skillSnapshot,
    nativeSkill: nativeSkillMount(opts, skillSnapshot),
    mcp: { providerIds: mcp.providerIds, inlineConfigs: mcp.inlineConfigs },
    platformSkillsCount: platformSkills.length,
    rewriteVendorOptions: false,
    result: {
      didApply: true,
      mcpProviderIds: mcp.providerIds,
      inlineMcpCount: mcp.inlineConfigs.length,
      skillsCount: runtimeSkills.length,
      platformSkillsCount: platformSkills.length,
      skillSnapshot,
    },
  });
}

/**
 * 形态 A 的解析阶段：返回结构化计划，不写 opts。
 *
 * `vendorOptions.mekaRuntimeResolved === true`（续聊 / resume）走 `resolveFrozenInjection` 短路
 * （I4：不重解析项目/角色、不重算 MCP）；其余情况走 `resolveBootstrapInjection` 全量解析。
 *
 * - null = 非 Meka 会话且无需回填绑定（调用方零写入、零形态变化）。
 * - 抛 `INVALID_PARAMS` 的错误码与文案与重构前完全一致。
 */
export async function resolveMekaInjection(
  input: MekaInjectionInput,
): Promise<MekaInjectionPlan | null> {
  const { opts, deps = {} } = input;
  const currentUserPrompt = opts.userPrompt;
  const materialize = deps.materializeSkillSnapshot ?? materializeMekaSkillSnapshot;
  const existingVendorOptions = opts.vendorOptions as Record<string, unknown> | undefined;
  if (existingVendorOptions?.mekaRuntimeResolved === true) {
    return resolveFrozenInjection({
      opts,
      sessionId: input.sessionId,
      currentUserPrompt,
      materialize,
    });
  }
  return resolveBootstrapInjection({
    opts,
    deps,
    sessionId: input.sessionId,
    currentUserPrompt,
    materialize,
  });
}
