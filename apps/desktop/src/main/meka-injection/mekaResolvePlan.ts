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

import { mekaDefaultRoleId, type MekaRoleMcpEntry } from '../../shared/meka-projects.js';
import type { MakerSessionCreateOpts } from '../maker-ipc/sessionRequest.js';
import {
  invalidateCombatTargetBinding,
  readCombatVendorOptions,
  refreshCombatTargetBinding,
  rememberCombatVendorOptions,
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
  COMBAT_READ_ONLY_UNITY_PIPELINE_COMMANDS,
  COMBAT_SERVER_WORKER_PROMPT,
  combatControllerSkillPrompt,
  combatProjectPathsPrompt,
  combatRequestScopeApprovalPatch,
  combatScopePrompt,
  combatServerTargetPrompt,
  combatSkillIdVendorPatchFromUserPrompt,
  combatTargetPrompt,
  isUnambiguousCombatTableScopePrompt,
  mekaProjectReferencesPrompt,
  removeCombatStartupGate,
  resolveCombatProjectRefPaths,
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
 * 项目侧白名单 patch（三条路径共用同一份取值，避免出现第二套白名单）：
 * - `mekaCombatProjectRefPaths`：允许读取的两条项目域事实文件（精确绝对路径）；
 * - `mekaCombatReadOnlyUnityCommands`：表范围解析允许的只读 Unity Pipeline 命令。
 */
function combatProjectReferencePatch(workingDir: unknown): Record<string, unknown> {
  const refPaths = resolveCombatProjectRefPaths(workingDir);
  if (!refPaths) return {};
  return {
    mekaCombatProjectRefPaths: [refPaths.moduleEditorSkillPath, refPaths.damageEncodingRulePath],
    mekaCombatReadOnlyUnityCommands: [...COMBAT_READ_ONLY_UNITY_PIPELINE_COMMANDS],
  };
}

/**
 * 证据依据的最终值（Host 依据注入情况写入，**不是** Agent 判断）：
 * - 两条项目参考未注入（无覆盖）⇒ `undefined`，fail-closed 回落到服务器 supported 回执；
 * - 单技能且目标已由用户确认（`…TargetSkillIdState === 'confirmed'`）⇒ `project-reference`
 *   （与表范围口径统一：项目权威规则本身就是「伤害 data 编码」这类域事实的权威）；
 * - 表范围由漏斗 / 审批补丁自带 `project-reference`，这里不重复写。
 *
 * `baseVendorOptions` 是会话现状：本次消息没有改目标时（例如续聊里只说「继续」）用它判断
 * 老会话的单技能目标是否已确认，避免 pre-change 会话永远拿不到依据。
 */
function combatEvidenceBasisPatch(
  patch: Record<string, unknown>,
  workingDir: unknown,
  baseVendorOptions: Record<string, unknown> = {},
): Record<string, unknown> {
  if (resolveCombatProjectRefPaths(workingDir) === null) {
    // 没有注入参考就绝不放行：**无条件**清掉会话里已知存在的旧值（A7）。只在「本轮产生了补丁」
    // 时才清是不够的 —— 本轮拿不到 workingDir（例如工作目录恢复失败）又没有产生补丁时，上一轮
    // 写下的 `project-reference` 会活下来，让写入继续跳过服务器 supported 回执。
    // 会话本来就没有依据时不写这个键：避免给「无参考且无依据」的会话凭空加一个 undefined 键
    // （写入结果与键序都保持原样）。
    return baseVendorOptions.mekaCombatEvidenceBasis === undefined
      ? {}
      : { mekaCombatEvidenceBasis: undefined };
  }
  const scope = patch.mekaCombatRequestScope ?? baseVendorOptions.mekaCombatRequestScope;
  if (scope === 'table-scope') return {};
  const targetState =
    patch.mekaCombatTargetSkillIdState ?? baseVendorOptions.mekaCombatTargetSkillIdState;
  return targetState === 'confirmed' ? { mekaCombatEvidenceBasis: 'project-reference' } : {};
}

/**
 * A2：会话**已经有用户确认的单技能绑定**时，表范围启发式不得覆盖它。
 *
 * 漏斗（`combatSkillIdVendorPatchFromUserPrompt`）是纯函数、看不到 vendorOptions，所以把
 * 「这个技能的所有模块都要检查」这类带范围量词但其实是单技能内部的表述判成表范围时，它写的
 * `mekaCombatTargetSkillId: undefined` 会把用户已确认的绑定连同导出/服务器/计划状态一起清掉。
 * 检测器已经把明显指代当前目标的表述（`这个|该|当前|本|此` + 技能）排除；剩下确实命中表范围
 * 特征的表述在这里再判一次：只有**无歧义表范围**（显式点名表/清单，或「某类技能」）才允许
 * 覆盖已确认绑定，否则按「本轮没有目标变化」处理（保留绑定，不动任何证据）。
 */
function suppressTableScopePatchForConfirmedBinding(input: {
  patch: Record<string, unknown> | null;
  prompt: unknown;
  baseVendorOptions: Record<string, unknown>;
}): Record<string, unknown> | null {
  const patch = input.patch;
  if (!patch || patch.mekaCombatRequestScope !== 'table-scope') return patch;
  const boundTarget = input.baseVendorOptions.mekaCombatTargetSkillId;
  const hasConfirmedBinding =
    input.baseVendorOptions.mekaCombatTargetSkillIdState === 'confirmed' &&
    typeof boundTarget === 'string' &&
    /^[1-9]\d*$/.test(boundTarget);
  if (!hasConfirmedBinding) return patch;
  return isUnambiguousCombatTableScopePrompt(input.prompt) ? patch : null;
}

/**
 * 用户消息里的技能 ID / 请求范围 → vendorOptions patch（含现状的会话级绑定刷新副作用）。
 *
 * patch 顺序敏感：先 patch 本身，再（目标或范围发生变化时）清空导出证据 —— 与现状
 * `applyCombatSkillIdToVendorOptions` 的两次 spread 顺序一致。解析阶段就完成，落地只是 spread。
 *
 * 漏斗返回 null（消息既没有明确 ID、也不是表范围指令）时才看**表范围审批转换**：表范围提案后
 * 用户回一句肯定（`确认`/`执行`/`没问题`…）即置 `mekaCombatScopeApproved=true`。新的范围指令
 * 与带 ID 的指令由漏斗自己覆盖并改写范围状态，不需要额外处理。
 *
 * 漏斗的表范围结果先过 A2 guard（`suppressTableScopePatchForConfirmedBinding`）：会话已有用户
 * 确认的单技能绑定时，只有无歧义表范围表述才允许覆盖它。
 *
 * **证据依据（`mekaCombatEvidenceBasis`）也在这里定稿**：纯函数漏斗拿不到 workingDir，所以由这里
 * 依据「两条项目参考是否确实注入」写最终值 —— 单技能（目标已由用户确认）与表范围口径一致；
 * 参考未注入时一律 `undefined`（fail-closed = 走服务器 supported 回执）。
 */
function pushCombatTargetPatches(input: {
  builder: MekaPlanBuilder;
  baseVendorOptions: Record<string, unknown>;
  userPrompt: unknown;
  sessionId: string;
  workingDir?: unknown;
}): void {
  const patch =
    suppressTableScopePatchForConfirmedBinding({
      patch: combatSkillIdVendorPatchFromUserPrompt(input.userPrompt),
      prompt: input.userPrompt,
      baseVendorOptions: input.baseVendorOptions,
    }) ??
    combatRequestScopeApprovalPatch({
      prompt: input.userPrompt,
      previousVendorOptions: input.baseVendorOptions,
    });
  const evidenceBasisPatch = combatEvidenceBasisPatch(
    patch ?? {},
    input.workingDir,
    input.baseVendorOptions,
  );
  const evidenceBasis = Object.keys(evidenceBasisPatch).length > 0 ? [evidenceBasisPatch] : [];
  if (!patch) {
    // 本次消息没有改目标/范围：仍然把证据依据定稿（老会话的单技能已确认目标也要拿到依据）。
    input.builder.patches.push(...evidenceBasis);
    return;
  }
  if (!('mekaCombatTargetSkillId' in patch)) {
    // 纯审批补丁（不含目标键）：只写范围状态与依据，不作废任何既有目标证据。
    input.builder.patches.push(patch, ...evidenceBasis);
    return;
  }
  const nextTarget = patch.mekaCombatTargetSkillId;
  // 进入表范围与切换目标一样，都要作废上个证据代次：单值导出证据不能证明范围级结论。
  const enteredTableScope =
    patch.mekaCombatRequestScope === 'table-scope' &&
    input.baseVendorOptions.mekaCombatRequestScope !== 'table-scope';
  const targetChanged =
    (typeof nextTarget === 'string' &&
      nextTarget !== input.baseVendorOptions.mekaCombatTargetSkillId) ||
    enteredTableScope;
  if (typeof nextTarget === 'string') refreshCombatTargetBinding(input.sessionId, nextTarget);
  else invalidateCombatTargetBinding(input.sessionId);
  input.builder.patches.push(patch, ...evidenceBasis);
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
      workingDir: opts.workingDir,
    });
    // 项目参考路径 / 只读范围发现命令白名单每轮重新从 workingDir 解析：老会话（本改动之前
    // 创建）也要拿到它，否则策略层会继续把这两条注入路径当「其它 Agent Skill /
    // saga2_design 长文档」拒掉。
    const projectRefPatch = combatProjectReferencePatch(opts.workingDir);
    if (Object.keys(projectRefPatch).length > 0) {
      builder.patches.push(projectRefPatch);
    }
    const projection = projectVendorOptions(existingVendorOptions, builder.patches);
    const targetPrompt = combatTargetPrompt(projection);
    if (targetPrompt && !builder.hasMarker('[SAGA2_COMBAT_TARGET]')) {
      builder.pushSegment('meka.combat.target', targetPrompt);
    }
    const scopePrompt = combatScopePrompt(projection);
    if (scopePrompt && !builder.hasMarker('[SAGA2_COMBAT_SCOPE]')) {
      builder.pushSegment('meka.combat.scope', scopePrompt);
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
    // 会话级镜像（A3/A10）：记录 resume 后该会话的战斗 vendorOptions 投影，供后续每轮续聊
    // 判定「当前是不是已批准的表范围」。写在这里而不是落地阶段，是因为镜像的语义就是
    // 「Host 刚刚为这个会话解析出的战斗状态」。
    rememberCombatVendorOptions(sessionId, projectVendorOptions(existingVendorOptions, builder.patches));
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

  // 历史 Meka 会话有意保留旧角色列（不在此处改写数据库行）。这里按**该项目自己的**共享默认角色
  // 派生运行期角色：写死 saga2 / 通用开发会在「通用开发」退役后让旧会话冷启动硬失败（退役迁移
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
    // 项目参考文件清单（段 id `meka.project-references`，order 65 ⇒ 最终落在角色上下文与角色
    // prompt 之间）。空集合返回 null，整段不入 plan（与 role-prompt 文本为空时同口径）；
    // 远端服务器 Worker 不注入任何角色段，这里与 60/70 一起被 isCombatServerWorker 排除。
    // resume 短路（frozen）路径同样不注入：它不重解析项目/角色（I4），因此该段与角色段同进同出。
    const projectReferencesPrompt = mekaProjectReferencesPrompt(runtime.projectReferences);
    if (projectReferencesPrompt) {
      builder.pushSegment('meka.project-references', projectReferencesPrompt);
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
  // 远端服务器 Worker 不落本机项目白名单（与 PROJECT_PATHS/角色段一致）。
  const combatProjectRefPatch = isCombatServerWorker
    ? {}
    : combatProjectReferencePatch(opts.workingDir);
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
          ...combatProjectRefPatch,
        }
      : {}),
  });

  if (runtime.workflow === 'saga2-combat-development-v1' && !isCombatServerWorker) {
    pushCombatTargetPatches({
      builder,
      baseVendorOptions: projectVendorOptions(existingVendorOptions, builder.patches),
      userPrompt: currentUserPrompt,
      sessionId,
      workingDir: opts.workingDir,
    });
    const projection = projectVendorOptions(existingVendorOptions, builder.patches);
    const targetPrompt = combatTargetPrompt(projection);
    if (targetPrompt) builder.pushSegment('meka.combat.target', targetPrompt);
    const scopePrompt = combatScopePrompt(projection);
    if (scopePrompt) builder.pushSegment('meka.combat.scope', scopePrompt);
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
    // 会话级镜像（A3/A10）：见 `resolveFrozenInjection` 同名调用。
    rememberCombatVendorOptions(
      sessionId,
      projectVendorOptions(existingVendorOptions, builder.patches),
    );
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

/**
 * 形态 C：每轮续聊的战斗运行时上下文（解析阶段，不写 opts）。
 *
 * **会话现状（`previousVendorOptions`）是审批门禁的前提**：调用方拿得到就传；拿不到时回落到
 * `combatWorkflowPolicy` 的会话级镜像（`readCombatVendorOptions`，由 bootstrap/resume 的计划层
 * 与 `register.ts` 的 `onAccepted` 维护）。镜像也没有 = 状态未知，此时只写合法的范围键
 * （与 A3 之前的行为一致）。**不能**把「未知」当成「非表范围」写死，也不能把「未知」当成
 * 「可以审批」——未知就是未知，见 `combatRequestScopeApprovalPatch`。
 *
 * A10：已批准的表范围会话在批准后的每一轮（包括批准轮本身）都要继续注入范围段，否则「按用户
 * 批准的范围逐目标实施」这条指令在批准之后再也到不了模型（批准轮的 promptSection 原来恒为
 * null，后续轮因为消息不再是肯定词而不产生补丁）。
 */
export async function prepareCombatFollowupRuntimeContext(input: {
  prompt: unknown;
  projectId: string;
  workingDir: unknown;
  sessionId?: string;
  /** 会话当前的 vendorOptions（调用方拿得到就传；缺省回落到会话级镜像）。 */
  previousVendorOptions?: Record<string, unknown> | null;
  resolveCombatServerTarget?: (projectId: string) => Promise<MekaCombatServerWorkerTarget | null>;
}): Promise<CombatFollowupRuntimeContext | null> {
  const mirroredVendorOptions = readCombatVendorOptions(input.sessionId);
  const previousVendorOptions = input.previousVendorOptions ?? mirroredVendorOptions;
  const funnelPatch = suppressTableScopePatchForConfirmedBinding({
    patch: combatSkillIdVendorPatchFromUserPrompt(input.prompt),
    prompt: input.prompt,
    baseVendorOptions: previousVendorOptions ?? {},
  });
  const approvalPatch = funnelPatch
    ? null
    : combatRequestScopeApprovalPatch({
        prompt: input.prompt,
        previousVendorOptions,
      });
  const targetPatch = funnelPatch ?? approvalPatch;
  const projectRefPatch = combatProjectReferencePatch(input.workingDir);
  // 证据依据定稿（见 combatEvidenceBasisPatch）：单技能已确认目标与表范围同一口径；
  // 两条项目参考解析不出来时**无论本轮有没有补丁**都要清掉旧依据（A7）。
  const evidenceBasisPatch = combatEvidenceBasisPatch(
    targetPatch ?? {},
    input.workingDir,
    previousVendorOptions ?? {},
  );
  if (!targetPatch) {
    // 本轮没有目标/范围补丁（例如「继续」「先看看有哪些模块」）：
    // - 证据依据仍然要定稿，并在参考不可用时清掉旧值（A7）；
    // - 已批准的表范围会话要继续拿到范围段（A10）。
    const basisClears =
      Object.prototype.hasOwnProperty.call(evidenceBasisPatch, 'mekaCombatEvidenceBasis') &&
      evidenceBasisPatch.mekaCombatEvidenceBasis === undefined;
    // 表范围会话（含已批准）继续注入范围段：A10 要求批准后的「逐目标实施」指令真的到得了模型；
    // 未批准时重复注入的也是同一句「先只读解析、确认前禁止写入」，不改变权限语义。
    const scopeSection = combatScopePrompt({
      ...(previousVendorOptions ?? {}),
      ...evidenceBasisPatch,
      ...projectRefPatch,
    });
    // 既没有要改的状态、也没有要注入的段 ⇒ 保持「本轮零写入」的现状（调用方不调
    // setVendorOptions，也就不会顺手作废目标导出证据）。
    if (!basisClears && !scopeSection) return null;
    return {
      vendorOptionsPatch: { ...evidenceBasisPatch, ...projectRefPatch },
      promptSection: scopeSection,
    };
  }

  const targetSkillId = targetPatch.mekaCombatTargetSkillId;
  if (approvalPatch) {
    // 纯审批消息：只改范围状态。**不得**顺手清空单技能导出证据、服务器状态或参考技能
    // （批准范围与切换目标是两件事）。范围段在批准轮就注入（A10）。
    const vendorOptionsPatch = { ...approvalPatch, ...evidenceBasisPatch, ...projectRefPatch };
    return {
      vendorOptionsPatch,
      promptSection: combatScopePrompt({ ...(previousVendorOptions ?? {}), ...vendorOptionsPatch }),
    };
  }
  if (typeof targetSkillId !== 'string' || !/^[1-9]\d*$/.test(targetSkillId)) {
    const vendorOptionsPatch = {
      ...targetPatch,
      ...evidenceBasisPatch,
      ...projectRefPatch,
      mekaCombatServerRemoteHostId: undefined,
      mekaCombatServerWorkerAgent: undefined,
      mekaCombatServerCapabilityStatus: 'unchecked',
      mekaCombatPlanApproved: false,
      mekaCombatReferenceSkillId: undefined,
      mekaCombatTargetExportAttempted: undefined,
      mekaCombatTargetExportCompleted: undefined,
    };
    // 表范围请求没有单值目标，但仍要注入范围段 + 项目参考路径（歧义态照旧不注入任何段）。
    const scopeSection = combatScopePrompt(vendorOptionsPatch);
    const scopeSections = scopeSection
      ? [scopeSection, combatProjectPathsPrompt(input.workingDir)]
      : [];
    return {
      vendorOptionsPatch,
      promptSection:
        scopeSections.filter((section): section is string => Boolean(section)).join('\n\n') || null,
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
    ...evidenceBasisPatch,
    ...projectRefPatch,
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
    combatScopePrompt(vendorOptionsPatch),
    combatProjectPathsPrompt(input.workingDir),
    combatServerTargetPrompt(serverTarget),
  ].filter((section): section is string => Boolean(section));
  return {
    vendorOptionsPatch,
    promptSection: sections.join('\n\n'),
  };
}


