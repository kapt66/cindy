/**
 * 注入层第 2 层：**解析**（形态 A 的解析阶段 + 形态 C 的每轮续聊解析）。
 *
 * 职责：把 create opts / 用户消息与外部依赖（持久化绑定、Meka 运行期配置、平台技能、
 * 技能快照、MCP、战斗服务器目标）解析成结构化 `MekaInjectionPlan` / `MekaTurnInjection`。
 *
 * 不做什么：**不写 opts**（写入全在 applyPlan），不改任何注入文本（文本在 combatPrompts）。
 * 段落与 vendorOptions patch 按现状的**执行次序**产出，最终次序由 applyPlan 按 order 升序
 * 渲染决定 —— 两者与重构前逐字节一致。
 */

import type { MekaRoleMcpEntry } from '../../shared/meka-projects.js';
import type { MakerSessionCreateOpts } from '../maker-ipc/sessionRequest.js';
import {
  invalidateCombatTargetBinding,
  refreshCombatTargetBinding,
} from '../meka-projects/combatWorkflowPolicy.js';
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
import {
  COMBAT_CONTROLLER_SKILL_MARKER,
  COMBAT_EXECUTION_AUTHORIZATION_PROMPT,
  COMBAT_SERVER_WORKER_PROMPT,
  combatControllerSkillPrompt,
  combatProjectPathsPrompt,
  combatServerTargetPrompt,
  combatSkillIdVendorPatchFromUserPrompt,
  combatTargetPrompt,
  removeCombatStartupGate,
  roleContextPrompt,
} from './mekaCombatPrompts.js';
import {
  createMekaPromptSegment,
  type AppliedMekaRuntimeConfig,
  type ApplyMekaRuntimeConfigDeps,
  type CombatFollowupRuntimeContext,
  type MekaCombatServerWorkerTarget,
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
 * 重构前的 4 处去重 guard 写的是 `(opts.userPrompt ?? '').includes(marker)`：非字符串会被
 * `??` 放过（`123` 非 nullish）再调 `.includes`，于是**战斗工作流**会在 guard 处抛出一个没有
 * 错误码的 `TypeError`；而新建的非战斗会话不跑 guard，`prependPromptSection` 又把非字符串
 * 当空串 ⇒ `123` 被静默丢弃；resume 的非战斗会话不写任何 prompt ⇒ `123` 原样透传给下游。
 * IPC 是无类型边界（`readCreateSessionOpts` 不校验 `userPrompt`），三种旧结果都不可接受
 * （不可辨 / 丢用户输入 / 把脏值写进会话）。这里统一改成显式 `INVALID_PARAMS`。
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
 * 为什么需要它：现状的 `includes('[SAGA2_*]')` 去重 guard 检查的是**已经被前序段落
 * prepend 过的** `opts.userPrompt`。解析阶段不再写 opts，因此这里用同一算法模拟累积结果，
 * 保证 guard 判定与重构前完全一致（包括角色正文里恰好含某个 marker 的极端情况）。
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

/** base + 依序 spread 的 patch：用于解析阶段读取「patch 之后」的值（不写 opts）。 */
function projectVendorOptions(
  base: Record<string, unknown> | undefined,
  patches: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return Object.assign({}, base, ...patches);
}

/** 组装计划（diagnostics 直接取落地结果里的同名字段，避免两处不一致）。 */
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
    diagnostics: {
      workflow: input.result.workflow,
      workflowRecoveredFromRole: input.result.workflowRecoveredFromRole,
      combatEnvironmentReady: input.result.combatEnvironmentReady,
    },
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
 * 战斗服务器目标解析（I/O）。与现状 `injectCombatServerTarget` 的前半段完全同义：
 * - 只在「有唯一合法 `mekaCombatTargetSkillId`」且调用方提供了 resolver 时才解析；
 * - resolver 抛错按 unavailable（target = null）处理，仍然注入 unavailable 段；
 * - 返回 null = 现状的提前 return：既不解析、也不写路由键、也不注入该段。
 */
async function resolveCombatServerTargetInjection(input: {
  deps: ApplyMekaRuntimeConfigDeps;
  projectId: string;
  vendorOptions: Record<string, unknown>;
}): Promise<{ target: MekaCombatServerWorkerTarget | null; patch: Record<string, unknown> } | null> {
  const options = input.vendorOptions;
  if (
    typeof options.mekaCombatTargetSkillId !== 'string' ||
    !/^[1-9]\d*$/.test(options.mekaCombatTargetSkillId) ||
    !input.deps.resolveCombatServerTarget
  ) {
    return null;
  }
  let target: MekaCombatServerWorkerTarget | null = null;
  try {
    target = await input.deps.resolveCombatServerTarget(input.projectId);
  } catch {
    target = null;
  }
  return {
    target,
    patch: {
      mekaCombatServerRemoteHostId: target?.remoteHostId,
      mekaCombatServerWorkerAgent: target?.workerAgent,
    },
  };
}

/**
 * 用户消息里的技能 ID → vendorOptions patch（含现状的会话级绑定刷新副作用）。
 *
 * patch 顺序敏感：先 patch 本身，再（目标发生变化时）清空导出证据 —— 与现状
 * `applyCombatSkillIdToVendorOptions` 的两次 spread 顺序一致。解析阶段就完成，落地只是 spread。
 */
function pushCombatTargetPatches(input: {
  builder: MekaPlanBuilder;
  baseVendorOptions: Record<string, unknown>;
  userPrompt: unknown;
  sessionId: string;
}): void {
  const patch = combatSkillIdVendorPatchFromUserPrompt(input.userPrompt);
  if (!patch) return;
  const nextTarget = patch.mekaCombatTargetSkillId;
  const targetChanged =
    typeof nextTarget === 'string' &&
    nextTarget !== input.baseVendorOptions.mekaCombatTargetSkillId;
  if (typeof nextTarget === 'string') refreshCombatTargetBinding(input.sessionId, nextTarget);
  else invalidateCombatTargetBinding(input.sessionId);
  input.builder.patches.push(patch);
  if (targetChanged) {
    input.builder.patches.push({
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatPlanApproved: false,
      mekaCombatReferenceSkillId: undefined,
      mekaCombatTargetExportAttempted: undefined,
      mekaCombatTargetExportCompleted: undefined,
    });
  }
}

/**
 * resume 短路分支（I4）：`vendorOptions.mekaRuntimeResolved === true` 时只补战斗契约，
 * 不重解析项目/角色、不重算 MCP；角色段在这一路径下**不注入**（现状事实）。
 */
async function resolveFrozenInjection(input: {
  opts: MakerSessionCreateOpts;
  deps: ApplyMekaRuntimeConfigDeps;
  sessionId: string;
  currentUserPrompt: unknown;
  existingVendorOptions: Record<string, unknown>;
  materialize: MaterializeSkillSnapshot;
}): Promise<MekaInjectionPlan> {
  const { opts, deps, sessionId, currentUserPrompt, existingVendorOptions, materialize } = input;
  // 到达这里即 `mekaRuntimeResolved === true`：确定是 Meka 会话，可以先校验参数。
  assertMekaUserPromptType(opts.userPrompt);
  const builder = createPlanBuilder(currentUserPrompt);
  const isCombatWorkflow = existingVendorOptions.mekaWorkflow === 'saga2-combat-development-v1';

  if (
    isCombatWorkflow &&
    typeof existingVendorOptions.mekaCombatServerCapabilityStatus !== 'string'
  ) {
    builder.patches.push({ mekaCombatServerCapabilityStatus: 'unchecked' });
  }
  if (
    isCombatWorkflow &&
    existingVendorOptions.mekaCombatExecutionMode !== 'autonomous-user-request'
  ) {
    if (!builder.hasMarker('[SAGA2_COMBAT_EXECUTION_AUTHORIZATION]')) {
      builder.pushSegment(
        'meka.combat.execution-authorization',
        COMBAT_EXECUTION_AUTHORIZATION_PROMPT,
      );
    }
    builder.patches.push({ mekaCombatExecutionMode: 'autonomous-user-request' });
  }
  if (isCombatWorkflow) {
    // Session resume skips full runtime resolution. Preserve the combat role's
    // execution contract on that path as well, otherwise resumed drafts fall
    // back to the legacy plan-approval gate.
    pushCombatTargetPatches({
      builder,
      baseVendorOptions: projectVendorOptions(existingVendorOptions, builder.patches),
      userPrompt: currentUserPrompt,
      sessionId,
    });
    const projection = projectVendorOptions(existingVendorOptions, builder.patches);
    const targetPrompt = combatTargetPrompt(projection);
    if (targetPrompt && !builder.hasMarker('[SAGA2_COMBAT_TARGET]')) {
      builder.pushSegment('meka.combat.target', targetPrompt);
    }
    const projectPathsPrompt = combatProjectPathsPrompt(opts.workingDir);
    if (projectPathsPrompt && !builder.hasMarker('[SAGA2_PROJECT_PATHS]')) {
      builder.pushSegment('meka.combat.project-paths', projectPathsPrompt);
    }
    const serverTarget = await resolveCombatServerTargetInjection({
      deps,
      projectId: 'saga2',
      vendorOptions: projection,
    });
    if (serverTarget) {
      builder.patches.push(serverTarget.patch);
      builder.pushSegment(
        'meka.combat.server-target',
        combatServerTargetPrompt(serverTarget.target),
      );
    }
  }

  if (!sessionId.trim()) {
    // 现状：resume 分支缺 session id 时不物化快照，直接返回空结果（上面的战斗契约已写入）。
    return buildPlan({
      frozen: true,
      builder,
      materialized: false,
      skillSnapshot: null,
      nativeSkill: null,
      mcp: { providerIds: [], inlineConfigs: [] },
      platformSkillsCount: 0,
      rewriteVendorOptions: isCombatWorkflow,
      result: emptyMekaRuntimeResult(),
    });
  }
  const skillSnapshot = await materializeSkillSnapshotOrThrow(materialize, sessionId, []);
  if (isCombatWorkflow && !builder.hasMarker(COMBAT_CONTROLLER_SKILL_MARKER)) {
    builder.pushSegment('meka.combat.controller-skill', combatControllerSkillPrompt(skillSnapshot));
  }
  return buildPlan({
    frozen: true,
    builder,
    materialized: true,
    skillSnapshot,
    nativeSkill: nativeSkillMount(opts, skillSnapshot),
    mcp: { providerIds: [], inlineConfigs: [] },
    platformSkillsCount: 0,
    rewriteVendorOptions: isCombatWorkflow,
    result: { ...emptyMekaRuntimeResult(), skillSnapshot },
  });
}

/**
 * 常规会话创建分支：hydrate 持久绑定 → 解析项目/角色运行期 → 平台技能 → MCP → 技能快照
 * → 战斗契约段落。
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

  // Historical four-role Meka sessions intentionally retain their legacy role
  // column. Resolve it against today's bundled SAGA2 roles without rewriting DB.
  if (hydratedPersistedSession && projectId === 'saga2' && !roleId) {
    roleId = 'general-development';
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

  const isCombatServerWorker =
    runtime.workflow === 'saga2-combat-development-v1' &&
    Boolean(opts.remoteHostId) &&
    ((opts.vendorOptions as Record<string, unknown> | undefined)?.orcaRole === 'worker' ||
      opts.orcaRole === 'worker');
  let platformSkills: MekaRuntimeSkill[] = [];
  if (!isCombatServerWorker) {
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
  }
  const runtimeMcpEntries = isCombatServerWorker ? [] : mergePlatformMcp(runtime.mcp);
  const runtimeSkills = isCombatServerWorker
    ? []
    : mergePlatformSkills(runtime.skills, platformSkills);

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

  if (!isCombatServerWorker) {
    const runtimePrompt = removeCombatStartupGate(runtime.promptText.trim());
    if (runtimePrompt) {
      builder.pushSegment('meka.role-prompt', runtimePrompt);
    }
    builder.pushSegment('meka.role-context', roleContextPrompt(runtime));
    if (runtime.workflow === 'saga2-combat-development-v1') {
      builder.pushSegment(
        'meka.combat.execution-authorization',
        COMBAT_EXECUTION_AUTHORIZATION_PROMPT,
      );
    }
  }
  if (isCombatServerWorker) {
    builder.pushSegment('meka.combat.server-worker', COMBAT_SERVER_WORKER_PROMPT);
  }

  const existingVendorOptions = opts.vendorOptions as Record<string, unknown> | undefined;
  builder.patches.push({
    source: 'meka',
    mekaRuntimeResolved: true,
    mekaProjectId: runtime.projectId,
    mekaRoleId: runtime.roleId,
    mekaMcpProviderIds: mcp.providerIds,
    mekaMcpInlineConfigs: mcp.inlineConfigs,
    mekaPolicyProviderRefs: runtime.policyProviderRefs,
    ...(runtime.workflow === 'saga2-combat-development-v1' || isCombatServerWorker
      ? { codexNativeSubagentsDisabled: true }
      : {}),
    ...(runtime.workflow
      ? {
          mekaWorkflow:
            runtime.workflow === 'saga2-combat-development-v1' &&
            Boolean(opts.remoteHostId) &&
            ((opts.vendorOptions as Record<string, unknown> | undefined)?.orcaRole === 'worker' ||
              opts.orcaRole === 'worker')
              ? 'saga2-combat-server-worker-v1'
              : runtime.workflow,
        }
      : {}),
    ...(runtime.workflow === 'saga2-combat-development-v1'
      ? {
          mekaCombatExecutionMode: 'autonomous-user-request',
          mekaCombatServerCapabilityStatus: 'unchecked',
        }
      : {}),
  });

  if (runtime.workflow === 'saga2-combat-development-v1' && !isCombatServerWorker) {
    pushCombatTargetPatches({
      builder,
      baseVendorOptions: projectVendorOptions(existingVendorOptions, builder.patches),
      userPrompt: currentUserPrompt,
      sessionId,
    });
    const projection = projectVendorOptions(existingVendorOptions, builder.patches);
    const targetPrompt = combatTargetPrompt(projection);
    if (targetPrompt) builder.pushSegment('meka.combat.target', targetPrompt);
    const projectPathsPrompt = combatProjectPathsPrompt(opts.workingDir);
    if (projectPathsPrompt) builder.pushSegment('meka.combat.project-paths', projectPathsPrompt);
    const serverTarget = await resolveCombatServerTargetInjection({
      deps,
      projectId: runtime.projectId,
      vendorOptions: projection,
    });
    if (serverTarget) {
      builder.patches.push(serverTarget.patch);
      builder.pushSegment(
        'meka.combat.server-target',
        combatServerTargetPrompt(serverTarget.target),
      );
    }
    if (!builder.hasMarker(COMBAT_CONTROLLER_SKILL_MARKER)) {
      builder.pushSegment(
        'meka.combat.controller-skill',
        combatControllerSkillPrompt(skillSnapshot),
      );
    }
  }

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
      workflow: runtime.workflow ?? null,
      workflowRecoveredFromRole: runtime.workflowRecoveredFromRole,
      combatEnvironmentReady: null,
    },
  });
}

/**
 * 形态 A 的解析阶段：返回结构化计划，不写 opts。
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
      deps,
      sessionId: input.sessionId,
      currentUserPrompt,
      existingVendorOptions,
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

export async function prepareCombatFollowupRuntimeContext(input: {
  prompt: unknown;
  projectId: string;
  workingDir: unknown;
  sessionId?: string;
  resolveCombatServerTarget?: (projectId: string) => Promise<MekaCombatServerWorkerTarget | null>;
}): Promise<CombatFollowupRuntimeContext | null> {
  const targetPatch = combatSkillIdVendorPatchFromUserPrompt(input.prompt);
  if (!targetPatch) return null;

  const targetSkillId = targetPatch.mekaCombatTargetSkillId;
  if (typeof targetSkillId !== 'string' || !/^[1-9]\d*$/.test(targetSkillId)) {
    return {
      vendorOptionsPatch: {
        ...targetPatch,
        mekaCombatServerRemoteHostId: undefined,
        mekaCombatServerWorkerAgent: undefined,
        mekaCombatServerCapabilityStatus: 'unchecked',
        mekaCombatPlanApproved: false,
        mekaCombatReferenceSkillId: undefined,
        mekaCombatTargetExportAttempted: undefined,
        mekaCombatTargetExportCompleted: undefined,
      },
      promptSection: null,
    };
  }
  let serverTarget: MekaCombatServerWorkerTarget | null = null;
  if (input.resolveCombatServerTarget) {
    try {
      serverTarget = await input.resolveCombatServerTarget(input.projectId);
    } catch {
      serverTarget = null;
    }
  }
  const vendorOptionsPatch = {
    ...targetPatch,
    mekaCombatServerRemoteHostId: serverTarget?.remoteHostId,
    mekaCombatServerWorkerAgent: serverTarget?.workerAgent,
    mekaCombatServerCapabilityStatus: 'unchecked',
    mekaCombatPlanApproved: false,
    mekaCombatReferenceSkillId: undefined,
    mekaCombatTargetExportAttempted: undefined,
    mekaCombatTargetExportCompleted: undefined,
  };
  const sections = [
    combatTargetPrompt(vendorOptionsPatch),
    combatProjectPathsPrompt(input.workingDir),
    combatServerTargetPrompt(serverTarget),
  ].filter((section): section is string => Boolean(section));
  return {
    vendorOptionsPatch,
    promptSection: sections.join('\n\n'),
  };
}


