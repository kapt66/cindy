import os from 'node:os';
import path from 'node:path';

import {
  classifyShellCommand,
  type HostToolExecutionContext,
  type HostToolExecutionDecision,
} from '@cindy/maker-core';

import {
  combatEnvironmentAvailability,
  runCombatEnvironmentGate,
  type CombatEnvironmentGateResult,
} from './combatEnvironmentGate.js';
import {
  beginCombatServerCapabilityDispatch,
  COMBAT_MODULE_FIRST_MARKER,
  getTrustedCombatServerWorkerRemoteHost,
  hasTrustedCombatServerCapabilityReport,
  isModuleFirstCombatServerExplorationTask,
  isCombatServerExplorationTask,
  resetCombatServerCapabilityFlow,
} from './combatServerCapabilityState.js';
import { parseMcprRemoteHostId, type MekaRouterInstance } from '../../shared/meka-router.js';
import { getMekaP4SettingsService, getMekaRouterService } from '../meka-settings/ipc.js';
import { classifyRemoteSessionTransport } from '../maker-host/remote-session-routing.js';
import { probeRemoteCodexCapability } from '../maker-host/mcpr-codex-capability.js';
import { probeRemoteClaudeCapability } from '../maker-host/mcpr-claude-capability.js';

const WORKFLOW = 'saga2-combat-development-v1';
const SERVER_WORKER_WORKFLOW = 'saga2-combat-server-worker-v1';
const completedTargetExportBySession = new Map<string, string>();
const attemptedTargetExportBySession = new Map<string, string>();
const boundCombatTargetBySession = new Map<string, string>();

/**
 * D2：老版模块文件写入的**写后对账**状态。
 *
 * `legacy_module_import_json` 是 `--clear_existing true` 的**全量替换** —— 协议层会删除目标技能里
 * payload 未包含的每一个节点（`SkillModuleProtocolCodec.Import`）。所以「payload 少带了节点」在协议层
 * 是**静默成功**：回执里的 `importedNodeCount` 只是 payload 自己的节点数，永远等于 payload 的节点数。
 * Host 唯一能拿来对账的材料是**写入前**那次结构化导出的 `exportedNodeCount`。
 *
 * 状态含义：
 *  - `baselineNodeCount`：写入前最后一次**成功导出**回执里的节点数；`null` = Host 没有可用基线
 *    （**如实记录**：不编造一个通过，也不假装已核对）。
 *  - `importedNodeCount`：导入回执里的 `importedNodeCount`；`null` = 回执里没有可解析的数值。
 *  - `status === 'read-back-mismatch'`：回读回执的节点数与导入回执不一致 ⇒ 落盘结果与导入回执不符。
 *
 * 处于该状态的会话，除「对同一技能的一次结构化 `legacy_module_export_json` 回读」外的一切战斗工具
 * 调用都会被 `evaluateCombatToolExecution` 拦下 —— 有损导入因此不可能被静默带过这一轮。
 */
type CombatModuleWriteReconciliation = {
  skillId: string;
  baselineNodeCount: number | null;
  importedNodeCount: number | null;
  readBackNodeCount?: number | null;
  status: 'read-back-required' | 'read-back-mismatch';
};

const combatModuleReconciliationBySession = new Map<string, CombatModuleWriteReconciliation>();
/** 写入前导出基线：sessionId → (skillId → exportedNodeCount)。 */
const combatExportNodeCountBySession = new Map<string, Map<string, number>>();

/**
 * 会话级战斗 vendorOptions **镜像**（A3）：Host 记录「这个会话最后一次被成功注入的战斗键」。
 *
 * 为什么需要它：范围审批必须知道会话当前是不是表范围，否则任何一句「可以 / 继续 / OK」都会被
 * 当成范围审批。但 maker-core 的 `Session` 只有 `setVendorOptions`（写），**没有读取口子**
 * （`maker.getSession()` 也不暴露 vendorOptions），所以注入层只能自己记录自己写过的东西：
 * 计划层在 bootstrap / resume 时记录投影，续聊口子在 `onAccepted` 里记录真正落地的补丁。
 *
 * **只镜像 `mekaCombat*` 键**：所有战斗门禁都只看这些键，其余键（MCP 配置、角色、Orca）与门禁
 * 无关，不镜像可以避免在这里留一份 MCP 配置的副本。记录语义是「最后一次**已接受**的注入」，
 * 发送失败回滚时不回写（那时会话真实状态由 rollbackPatch 决定，镜像只是过期而不是错误授权）。
 *
 * 这是**一致性状态**，不是授权边界，也不进 DB：镜像缺失（进程重启 / 老会话首轮续聊）时调用方
 * 拿到 null，行为与没有镜像时一致（只写合法的范围键）。
 */
const COMBAT_MIRRORED_VENDOR_OPTIONS_PREFIX = 'mekaCombat';
const combatVendorOptionsBySession = new Map<string, Record<string, unknown>>();

/** 合并记录某会话本轮落地/注入的战斗 vendorOptions 键（其它键被忽略）。 */
export function rememberCombatVendorOptions(
  sessionId: string | undefined,
  options: Record<string, unknown> | undefined | null,
): void {
  const session = sessionId?.trim();
  if (!session || !options) return;
  const entries = Object.entries(options).filter(([key]) =>
    key.startsWith(COMBAT_MIRRORED_VENDOR_OPTIONS_PREFIX),
  );
  if (entries.length === 0) return;
  const current = combatVendorOptionsBySession.get(session) ?? {};
  for (const [key, value] of entries) current[key] = value;
  combatVendorOptionsBySession.set(session, current);
}

/** 读某会话的战斗 vendorOptions 镜像；null = 本进程没有记录（状态未知）。 */
export function readCombatVendorOptions(
  sessionId: string | undefined,
): Record<string, unknown> | null {
  const session = sessionId?.trim();
  if (!session) return null;
  return combatVendorOptionsBySession.get(session) ?? null;
}

/** 丢弃某会话的镜像（会话关闭 / 测试清理）。 */
export function forgetCombatVendorOptions(sessionId: string | undefined): void {
  const session = sessionId?.trim();
  if (!session) return;
  combatVendorOptionsBySession.delete(session);
}

export function resetCombatVendorOptionsMirrorForTests(): void {
  combatVendorOptionsBySession.clear();
}

/**
 * 镜像里**只由注入补丁写、不会被策略层就地扩展**的范围状态键。
 *
 * 为什么必须是白名单而不是整份写回：策略层会**就地**改实时 `vendorOptions` 的若干战斗键 ——
 * `recordCombatScopeSkillIds` 往 `mekaCombatScopeSkillIds` 累加成员、`refreshEnvironment` 写
 * `mekaCombatEnvironmentReady`/`…Checks`、导出证据记录器写 `…TargetExportAttempted/Completed`。
 * 镜像里这些键的值可能**比实时值更旧**（甚至恒为初始的 `[]`），整份写回会把已登记的成员清单缩水，
 * 让成员资格比对退化成「无清单」口径 —— 那是**削弱**门禁，不是修复分裂。
 * 所以还原只覆盖这五个纯注入语义的键。
 */
const COMBAT_SCOPE_STATE_RESTORE_KEYS = [
  'mekaCombatRequestScope',
  'mekaCombatRequestScopeState',
  'mekaCombatScopeSelection',
  'mekaCombatScopeSourceTables',
  'mekaCombatScopeApproved',
] as const;

/**
 * D6：把会话级镜像里的范围状态还原成一次 `setVendorOptions` 补丁。
 *
 * 分裂的成因：续聊口子的提示词用镜像判断「当前是不是表范围 / 范围是否已批准」，而策略层读的是
 * **实时** `vendorOptions`。Session 被重建（lazy-create / 从渲染进程的排队快照 rehydrate，快照里
 * 没有战斗键）时，镜像还带着 `table-scope` + `approved`，实时状态却是空的 —— 同一轮里提示词说
 * 「范围已批准，逐目标实施」，策略层却退回单技能分支并拒掉每一次调用，而 SKILL 禁止向表范围请求
 * 索要单个技能 ID（A3/D6）。
 *
 * 调度前把这份补丁写回实时 Session，两层就不可能再各说一套：提示词依据的状态**就是**实时状态。
 * 镜像缺失（进程重启 / 老会话首轮续聊）时返回空补丁 —— 与「没有镜像」时的行为一致。
 */
export function combatScopeStateRestorePatch(
  sessionId: string | undefined,
): Record<string, unknown> {
  const mirrored = readCombatVendorOptions(sessionId);
  if (!mirrored) return {};
  const patch: Record<string, unknown> = {};
  for (const key of COMBAT_SCOPE_STATE_RESTORE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(mirrored, key)) patch[key] = mirrored[key];
  }
  return patch;
}

const READ_ONLY_MCP_TOOL_NAMES =
  /^(?:check_|get_|list_|read_|search_|find_|inspect_|query_|validate_|describe_|status$)/i;
const READ_ONLY_UNITY_CLI_ACTIONS = new Set([
  'status',
  'list',
  'doctor',
  'editors',
  'projects',
  'releases',
  'env',
  'license',
  'diagnose',
]);
const READ_ONLY_ROUTER_CONTROL_TOOLS = new Set([
  'mcp_list_instances',
  'mcp_instance_tools',
  'mcp_list_servers',
  'mcp_list_resources',
]);
const READ_ONLY_ROUTER_PROJECT_TOOLS = new Set([
  'projects.list',
  'project-instances.list',
  'git.preview',
  'git.tree',
  'git.read',
  'git.search',
  'git.diff',
  'git.log',
  'git.branches',
  'git.show',
]);

function isKnownReadOnlyRouterProjectTool(tool: string): boolean {
  return READ_ONLY_ROUTER_PROJECT_TOOLS.has(tool);
}

export function isCombatEnvironmentRecoveryControlTool(name: string): boolean {
  return READ_ONLY_ROUTER_CONTROL_TOOLS.has(name);
}
const READ_ONLY_GLOBAL_MCP_TOOLS = new Set(['ghost_list']);

type CombatVendorOptions = Record<string, unknown> & {
  source?: unknown;
  mekaProjectId?: unknown;
  mekaRoleId?: unknown;
  mekaWorkflow?: unknown;
  mekaCombatEnvironmentReady?: unknown;
  mekaCombatEnvironmentChecks?: unknown;
  mekaCombatPlanApproved?: unknown;
  mekaCombatPhase?: unknown;
  mekaCombatServerCapabilityStatus?: unknown;
  mekaCombatTargetSkillId?: unknown;
  mekaCombatTargetSkillIdState?: unknown;
  mekaCombatTargetExportAttempted?: unknown;
  mekaCombatTargetExportCompleted?: unknown;
  /**
   * Host 注入的项目参考路径白名单（绝对值，来自 `mekaResolvePlan` 的
   * `mekaCombatProjectRefPaths`）。策略层只从它取值，不硬编码任何机器路径。
   */
  mekaCombatProjectRefPaths?: unknown;
  /** 请求范围：`single-skill` | `table-scope`（缺省 = 老会话，等价单技能）。 */
  mekaCombatRequestScope?: unknown;
  /** 范围解析状态：`missing` | `proposed` | `confirmed`（见 `mekaCombatPrompts`）。 */
  mekaCombatRequestScopeState?: unknown;
  mekaCombatScopeSelection?: unknown;
  mekaCombatScopeSourceTables?: unknown;
  mekaCombatScopeSkillIds?: unknown;
  /**
   * 成员清单被上限截断的事实（A4）。true 时清单**不是**完整成员集，成员资格比对回落到
   * 「无清单」口径，避免部分清单造成错误拒绝。
   */
  mekaCombatScopeSkillIdsTruncated?: unknown;
  mekaCombatScopeApproved?: unknown;
  /**
   * 表范围解析允许的只读 Unity Pipeline 命令白名单（来自 `mekaResolvePlan` 的
   * `mekaCombatReadOnlyUnityCommands`；与 `mekaCombatProjectRefPaths` 同一注入风格）。
   */
  mekaCombatReadOnlyUnityCommands?: unknown;
  /**
   * 证据依据：`project-reference`（Host 注入的项目权威参考覆盖了本次运行时语义，写入不要求
   * 服务器 supported 回执）或 `server-report`（必须取得只读 Worker 的 supported 回执）。
   * 缺省 / 其它值 = 走服务器回执。
   */
  mekaCombatEvidenceBasis?: unknown;
};

function combatOptions(value: Record<string, unknown>): CombatVendorOptions {
  return value as CombatVendorOptions;
}

function hasCompletedCombatTargetExport(context: HostToolExecutionContext): boolean {
  const options = combatOptions(context.vendorOptions);
  const target = text(options.mekaCombatTargetSkillId);
  return (
    options.mekaCombatTargetExportCompleted === true ||
    (Boolean(target) && completedTargetExportBySession.get(context.sessionId) === target)
  );
}

function hasAttemptedCombatTargetExport(context: HostToolExecutionContext): boolean {
  const options = combatOptions(context.vendorOptions);
  const target = text(options.mekaCombatTargetSkillId);
  return (
    options.mekaCombatTargetExportAttempted === true ||
    (Boolean(target) && attemptedTargetExportBySession.get(context.sessionId) === target)
  );
}

export function resetCombatTargetExportStateForTests(): void {
  completedTargetExportBySession.clear();
  attemptedTargetExportBySession.clear();
  boundCombatTargetBySession.clear();
  combatModuleReconciliationBySession.clear();
  combatExportNodeCountBySession.clear();
}

/**
 * 目标绑定失效 / 切换 = 当前证据代次结束（register.ts 的续聊口子在目标不再是唯一正整数或换到
 * 另一个 ID 时调用）。D2 的写后对账义务绑定在**当前目标**上：目标代次一换，旧义务必须一起作废，
 * 否则模型会卡在「对上一个技能回读」与「新目标门禁」之间（旧的 `skill_id` 在新目标下必然被目标
 * 门禁拒绝），这是死锁而不是更强的约束。代价是已知且有界的：目标切换本身会作废导出证据、
 * 重新要求新目标的首条导出证据，而对账失败在**发生当时**就已经以「期望/实际节点数」的理由
 * 拒绝了下一次调用（见交付说明）。
 */
function resetCombatModuleWorkflowStateForSession(sessionId: string): void {
  combatModuleReconciliationBySession.delete(sessionId);
  combatExportNodeCountBySession.delete(sessionId);
}

/** Any non-unique target ends the current evidence generation. */
export function invalidateCombatTargetBinding(sessionId: string | undefined): void {
  const session = sessionId?.trim();
  if (!session) return;
  completedTargetExportBySession.delete(session);
  attemptedTargetExportBySession.delete(session);
  boundCombatTargetBySession.delete(session);
  resetCombatModuleWorkflowStateForSession(session);
}

/**
 * A follow-up target change starts a new evidence generation. This invalidates
 * the in-memory fallback maps as well as the vendor-option flags, preventing a
 * later switch back to an older skill from reusing stale export evidence.
 */
export function refreshCombatTargetBinding(
  sessionId: string | undefined,
  targetSkillId: string,
): void {
  const session = sessionId?.trim();
  const target = targetSkillId.trim();
  if (!session || !/^[1-9]\d*$/.test(target)) return;
  const previous = boundCombatTargetBySession.get(session);
  if (previous && previous !== target) {
    completedTargetExportBySession.delete(session);
    attemptedTargetExportBySession.delete(session);
    resetCombatModuleWorkflowStateForSession(session);
  }
  boundCombatTargetBySession.set(session, target);
}

export function isCombatWorkflowPolicyActive(context: {
  vendorOptions: Record<string, unknown>;
}): boolean {
  const options = combatOptions(context.vendorOptions);
  return (
    options.source === 'meka' &&
    options.mekaProjectId === 'saga2' &&
    options.mekaWorkflow !== SERVER_WORKER_WORKFLOW &&
    (options.mekaWorkflow === WORKFLOW || options.mekaRoleId === 'combat-development')
  );
}

function isCombatServerWorkerPolicyActive(context: {
  vendorOptions: Record<string, unknown>;
}): boolean {
  const options = combatOptions(context.vendorOptions);
  return (
    options.source === 'meka' &&
    options.mekaProjectId === 'saga2' &&
    options.mekaWorkflow === SERVER_WORKER_WORKFLOW
  );
}

export function isCombatToolPolicyActive(context: {
  vendorOptions: Record<string, unknown>;
}): boolean {
  return isCombatWorkflowPolicyActive(context) || isCombatServerWorkerPolicyActive(context);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePositiveDecimal(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  return raw;
}

function serializedToolTarget(context: HostToolExecutionContext): string {
  const parts: Array<string | undefined> = [
    context.action.kind === 'read' || context.action.kind === 'file-write'
      ? context.action.path
      : undefined,
    context.action.kind === 'exec' ? context.action.command : undefined,
  ];
  try {
    parts.push(JSON.stringify(context.input));
  } catch {
    // Cyclic input cannot carry trusted target evidence.
  }
  return parts.filter((part): part is string => typeof part === 'string').join('\n');
}

function explicitCombatSkillIds(context: HostToolExecutionContext): string[] {
  const payload = serializedToolTarget(context);
  const ids = new Set<string>();
  const patterns = [
    /skill_entry_model_(\d+)(?:_static)?\.json/gi,
    /targetSkillId\s*(?:=|:|：)\s*#?\s*(\d+)\b/gi,
    /(?:skill[_-]?id|技能\s*(?:ID|Id|id|编号)?)\s*(?:=|:|：|是|为|\\?"|')*\s*#?\s*(\d+)\b/g,
    /--skill[_-]?id(?:=|\s+)(\d+)\b/gi,
    /(?:^|[\\/])(\d+)\.(?:import|export|static)\.json\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of payload.matchAll(pattern)) {
      const normalized = normalizePositiveDecimal(match[1]);
      if (normalized) ids.add(normalized);
    }
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (
          typeof value[index] === 'string' &&
          /^legacy_module_(?:prepare_asset|import_json|export_json)$/i.test(value[index]) &&
          normalizePositiveDecimal(value[index + 1])
        ) {
          ids.add(normalizePositiveDecimal(value[index + 1])!);
        }
        if (
          typeof value[index] === 'string' &&
          /^--?skill[_-]?id$/i.test(value[index]) &&
          normalizePositiveDecimal(value[index + 1])
        ) {
          ids.add(normalizePositiveDecimal(value[index + 1])!);
        }
        visit(value[index]);
      }
      return;
    }
    const object = record(value);
    if (!object) return;
    for (const [key, entry] of Object.entries(object)) {
      if (/^skill[_-]?id$/i.test(key)) {
        const normalized = normalizePositiveDecimal(entry);
        if (normalized) ids.add(normalized);
      }
      visit(entry);
    }
  };
  visit(context.input);
  return [...ids].filter((id) => /^[1-9]\d*$/.test(id));
}

/**
 * 目标门禁文案里指代「本轮目标」的标签。
 *
 * 只有**表范围**才写成「逐个已确认目标」：单技能会话即使目标还没定（`missing`/`ambiguous`）
 * 也是在等一个正整数技能 ID，把它说成「表范围」是假事实（A6）。
 */
function combatTargetLabel(options: CombatVendorOptions): string {
  if (isCombatTableScope(options)) return '（表范围：逐个已确认目标）';
  const target = text(options.mekaCombatTargetSkillId);
  return /^[1-9]\d*$/.test(target) ? target : '（尚未确定的正整数技能 ID）';
}

function combatSkillTargetReason(context: HostToolExecutionContext): string | null {
  const options = combatOptions(context.vendorOptions);
  // 表范围请求里没有单值目标：不得再回「缺少正整数技能 ID / 请只询问技能 ID」。
  // 用户确认范围之前只放行有界的只读范围解析（`isCombatScopeResolutionRead`）；写入门禁
  // 一概不动。确认之后按用户批准（并由 Agent 自己的只读范围查询登记）的
  // `mekaCombatScopeSkillIds` 校验出现的具体 ID —— 这是一致性 guard，不是授权边界（A4）。
  if (options.mekaCombatRequestScope === 'table-scope') {
    const scopeIds = approvedCombatScopeSkillIds(options);
    // 已批准但 Host 没有成员清单（或清单被截断）：Host 无法比对成员资格，改由「每次一个 ID +
    // 已确认范围 + 其余写入门禁」约束。清单的正常来源是 Agent 自己按范围段要求做的只读范围
    // 查询：`recordCombatScopeSkillIds` 把显式 `skill_ids` 记进 `mekaCombatScopeSkillIds`
    // （A4），因此真实会话里这个分支只在「用户直接批准、Agent 没查询」时出现。
    const withoutList = isApprovedCombatTableScopeWithoutList(options);
    const explicitIds = explicitCombatSkillIds(context);
    const approvedExplicitIds = explicitIds.filter((id) => scopeIds.includes(id));
    const mismatched = withoutList ? [] : explicitIds.filter((id) => !scopeIds.includes(id));
    // 范围外 ID 一律拒绝：**不得**因为同一请求里另有范围内 ID 就放行。一次
    // `legacy_module_import_json` 是 `clear_existing=true` 的全量替换，只要它携带一个范围外
    // `skill_id`，被写坏的就是**那个范围外的技能**；请求里同时出现一个范围内 ID（例如藏在
    // `<tmp>/1019.import.json` 这种 JSON 文件名里）不构成任何豁免理由（D1）。
    if (mismatched.length > 0) {
      return `本轮是表范围请求，但当前工具请求显式引用了范围外的技能 ID ${mismatched.join('、')}。请只处理用户已确认的范围（${scopeIds.join('、') || '尚未确认任何技能'}）；不得借用范围外的技能证据。`;
    }
    const legacyModuleCall =
      /legacy_module_(?:prepare_asset|import_json|export_json)/i.test(
        serializedToolTarget(context),
      );
    if (
      legacyModuleCall &&
      // 除范围成员资格外再钉一层：老版模块命令必须**恰好**携带一个 ID。非 `withoutList` 时该 ID
      // 还必须已在已确认范围内（`mismatched` 为空已保证，这里显式写出以免将来有人改回宽松形态）；
      // `withoutList`（已批准但清单被截断 / 未登记）是登记过的折中：只要求一个显式 ID，
      // 不做成员资格比对 —— 这一支的行为**保持原样**。
      !(withoutList
        ? explicitIds.length === 1
        : explicitIds.length === 1 && approvedExplicitIds.length === 1)
    ) {
      return `老版模块编辑器准备、导入和导出必须显式传入本轮技能 ID ${combatTargetLabel(options)}，且每次调用只允许一个已确认范围内的 ID，不得依赖当前打开或选中的技能。`;
    }
    return null;
  }
  const target = text(options.mekaCombatTargetSkillId);
  if (!/^[1-9]\d*$/.test(target)) {
    return options.mekaCombatTargetSkillIdState === 'ambiguous'
      ? '当前消息提供了多个技能 ID。请先让用户明确本轮只生成、修改或检查哪一个正整数技能 ID；确认前不得读取项目或调用工具。'
      : '当前任务缺少用户明确提供的正整数技能 ID。请只询问要生成、修改或检查的技能 ID；获得 ID 前不得读取项目或调用 Unity CLI、MCPRouter、P4。';
  }
  const referenceMarker = serializedToolTarget(context).match(
    /\[SAGA2_REFERENCE_SKILL_ID:\s*([1-9]\d*)\s*\]/i,
  );
  if (referenceMarker?.[1]) {
    return `本轮目标技能 ID 是 ${target}，但当前工具请求显式引用了 ${referenceMarker[1]}。一个任务只允许一个目标技能 ID；请移除参考技能 marker，只对 ${target} 取证。`;
  }
  const explicitIds = explicitCombatSkillIds(context);
  const mismatched = explicitIds.filter((id) => id !== target);
  if (mismatched.length > 0) {
    return `本轮目标技能 ID 是 ${target}，但当前工具请求显式引用了 ${mismatched.join('、')}。请停止该调用并只对 ${target} 取证；不得借用其它技能的静态结果冒充当前技能证据。`;
  }
  if (
    /legacy_module_(?:prepare_asset|import_json|export_json)/i.test(
      serializedToolTarget(context),
    ) &&
    !explicitIds.includes(target)
  ) {
    return `老版模块编辑器准备、导入和导出必须显式传入本轮技能 ID ${target}，不得依赖当前打开或选中的技能。`;
  }
  return null;
}

function legacyModuleJsonCommand(
  context: HostToolExecutionContext,
): { command: string; jsonPath: string | null; projectPath: string | null } | null {
  const target = effectiveMcpTarget(context.toolName, context.input);
  let args: Record<string, unknown> | null = null;
  if (target?.server === 'meka-unity' && target.tool === 'unity_execute') {
    args = mcpToolArguments(context.input);
  } else if (target?.server === 'cindy' && target.tool === 'ghost_call') {
    const unityCall = ghostUnityCall(context.input);
    if (unityCall?.tool === 'unity_execute') args = unityCall.args;
  }
  if (!args || text(args.action) !== 'command' || !Array.isArray(args.arguments)) return null;
  const values = args.arguments.map((value) => String(value));
  const commandIndex = values.findIndex((value) =>
    /^legacy_module_(?:import|export)_json$/i.test(value),
  );
  if (commandIndex < 0) return null;
  const command = values[commandIndex]!;
  const tail = values.slice(commandIndex + 1);
  for (let index = 0; index < tail.length; index += 1) {
    if (/^--?path$/i.test(tail[index]!)) {
      return {
        command,
        jsonPath: tail[index + 1] ?? null,
        projectPath: text(args.projectPath) || null,
      };
    }
    const inline = tail[index]!.match(/^--?path=(.+)$/i);
    if (inline) {
      return {
        command,
        jsonPath: inline[1] ?? null,
        projectPath: text(args.projectPath) || null,
      };
    }
  }
  const positional: string[] = [];
  for (let index = 0; index < tail.length; index += 1) {
    const value = tail[index]!;
    if (/^--?/.test(value)) {
      if (!value.includes('=')) index += 1;
      continue;
    }
    positional.push(value);
  }
  return {
    command,
    jsonPath: positional[1] ?? null,
    projectPath: text(args.projectPath) || null,
  };
}

/** `--name value` / `--name=value` 形态的旗标取值。 */
function unityCommandFlagValue(values: string[], name: RegExp): string | null {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (!name.test(value)) continue;
    const inline = value.match(/^[^=]+=(.+)$/);
    if (inline) return inline[1] ?? null;
    return values[index + 1] ?? null;
  }
  return null;
}

/**
 * `unity_execute` / `unity_inspect` 的 `action="command"` 参数在两条通道下的三种封装。
 *
 * - `ghost_call`（生产形态）：`{ ghost_id: 'meka-unity', tool: 'unity_execute', args: {...} }`；
 * - 直连 `meka-unity` 运行时 MCP：`meka-runtime-mcp` 的 `CallToolRequestSchema` 把 MCP
 *   `CallToolRequest` 原样透传成 `{ name, args }`，因此参数在 `input.args` 一层里；
 * - 既有门禁/测试用的直传形态：参数就是 `input` 本身。
 *
 * 既有 `mcpToolArguments` 只认 `toolParams` 与直传形态，所以在 `{ name, args }` 形态下
 * `legacyModuleJsonCommand` 恒为 `null`、依赖它的门禁会**静默失效**。本函数只服务新增/本次收紧的
 * 解析点（D2/D3），不改动既有门禁的解析口径，避免影响已冻结的行为。
 */
function unityActionCommandRequest(
  context: HostToolExecutionContext,
): { tool: string; args: Record<string, unknown> } | null {
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (!target) return null;
  if (
    target.server === 'meka-unity' &&
    (target.tool === 'unity_execute' || target.tool === 'unity_inspect')
  ) {
    const outer = record(context.input) ?? {};
    const direct = record(outer.toolParams) ?? outer;
    if (text(direct.action) === 'command' && Array.isArray(direct.arguments)) {
      return { tool: target.tool, args: direct };
    }
    const nested = record(outer.args);
    if (nested && text(nested.action) === 'command' && Array.isArray(nested.arguments)) {
      return { tool: target.tool, args: nested };
    }
    return null;
  }
  if (target.server === 'cindy' && target.tool === 'ghost_call') {
    const unityCall = ghostUnityCall(context.input);
    if (
      unityCall &&
      (unityCall.tool === 'unity_execute' || unityCall.tool === 'unity_inspect') &&
      text(unityCall.args.action) === 'command' &&
      Array.isArray(unityCall.args.arguments)
    ) {
      return { tool: unityCall.tool, args: unityCall.args };
    }
  }
  return null;
}

/**
 * 通道无关的 `legacy_module_*` 命令解析（D2/D3）。
 *
 * 与 `legacyModuleJsonCommand` 的差别：(1) 同时认 `unity_inspect`（批量写命令既可走写通道，也可
 * 走只读查询通道）；(2) 认 `meka-runtime-mcp` 的 `{ name, args }` 形态；(3) 顺带解出命令自己的
 * `skill_id`（positional 或 `--skill_id`），这是老版模块命令唯一可校验的范围标识。
 */
function combatLegacyModuleCommand(
  context: HostToolExecutionContext,
): { tool: string; command: string; skillId: string | null } | null {
  const request = unityActionCommandRequest(context);
  if (!request) return null;
  const values = request.args.arguments as unknown[];
  const rawCommand = values.length > 0 ? String(values[0] ?? '').trim() : '';
  if (!/^legacy_module_[a-z0-9_]+$/i.test(rawCommand)) return null;
  const stringValues = values.map((value) => String(value));
  const skillId =
    normalizePositiveDecimal(stringValues[1]) ??
    normalizePositiveDecimal(unityCommandFlagValue(stringValues, /^--?skill[_-]?id$/i));
  return { tool: request.tool, command: rawCommand, skillId };
}

/**
 * D3：模块编辑器命令面的**写入白名单**。
 *
 * 战斗流程里登记过的模块写入面只有一条：`legacy_module_import_json`（显式技能 ID +
 * `--clear_existing true`，全量替换该技能的模块图）。其余 `legacy_module_*` 命令既不是 Host 注入的
 * 只读查询命令，也不是登记过的写入命令 —— 典型是 `legacy_module_migrate_layers`：它遍历**全部**模块
 * 资产改层并落盘，既不携带 `skill_id`（范围成员资格无从比对），也不带 JSON 路径（路径白名单无从
 * 生效），因此在策略层必须单独拒绝，不能只靠「它是写通道」这一层间接约束。
 */
function legacyModuleWriteCommandReason(context: HostToolExecutionContext): string | null {
  const call = combatLegacyModuleCommand(context);
  if (!call) return null;
  const command = call.command.toLowerCase();
  if (command === 'legacy_module_import_json') return null;
  if (command === 'legacy_module_export_json') return null;
  if (readOnlyCombatUnityCommands(context).some((allowed) => allowed.trim().toLowerCase() === command)) {
    return null;
  }
  return `战斗流程里登记过的模块写入命令只有 legacy_module_import_json（显式技能 ID + --clear_existing true，全量替换该技能的模块图）。${call.command} 既不是 Host 注入的只读查询命令，也不是登记过的写入命令，而且不携带可校验的技能 ID 或 JSON 路径，无法限定到本轮范围，禁止调用。`;
}

function combatSessionKey(sessionId: string | undefined): string {
  return sessionId?.trim() ?? '';
}

/** 回执里的节点数：只接受非负整数（数字或纯数字字符串）；其它一律视为「取不到」。 */
function receiptNodeCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  const raw = typeof value === 'string' ? value.trim() : '';
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

function readCombatExportNodeCount(sessionId: string, skillId: string): number | null {
  return combatExportNodeCountBySession.get(sessionId)?.get(skillId) ?? null;
}

function recordCombatExportNodeCount(sessionId: string, skillId: string, count: number): void {
  const bySkill = combatExportNodeCountBySession.get(sessionId) ?? new Map<string, number>();
  bySkill.set(skillId, count);
  combatExportNodeCountBySession.set(sessionId, bySkill);
}

/**
 * 把工具结果里所有可能承载结构化回执的对象收集起来。
 *
 * 回执出现在哪一层取决于通道：`ghost_call` 是 `{ ok, result: { data: ... } }`，直连 meka-unity
 * 运行时 MCP 是 `{ content: [{ type: 'text', text: '{"..."}' }] }`，插件还可能把 `legacyModuleExport`
 * 内联在 `data` 里。这里只做「能解析出结构化数字就用，解析不出就如实记成未知」，绝不猜。
 */
function collectCombatReceiptObjects(
  value: unknown,
  out: Record<string, unknown>[],
  depth = 0,
): void {
  if (depth > 10 || out.length > 128) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
    try {
      collectCombatReceiptObjects(JSON.parse(trimmed), out, depth + 1);
    } catch {
      // 非 JSON 文本里没有结构化回执。
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectCombatReceiptObjects(entry, out, depth + 1);
    return;
  }
  const object = record(value);
  if (!object) return;
  out.push(object);
  for (const entry of Object.values(object)) collectCombatReceiptObjects(entry, out, depth + 1);
}

/** 内联导出/导入 payload 的节点数（`payload` 可能是对象，也可能是 JSON 文本）。 */
function inlineLegacyModulePayloadNodeCount(payload: unknown): number | null {
  if (Array.isArray(payload)) return payload.length;
  const object = record(payload);
  if (object) {
    for (const key of ['nodes', 'moduleNodes', 'nodeList']) {
      const candidate = object[key];
      if (Array.isArray(candidate)) return candidate.length;
    }
    return null;
  }
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      return inlineLegacyModulePayloadNodeCount(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return null;
}

const COMBAT_INLINE_MODULE_RECEIPT_KEYS = ['legacyModuleExport', 'legacyModuleImport'] as const;

/**
 * 从工具结果里取该命令的节点数。优先显式回执字段（`exportedNodeCount` / `importedNodeCount`，
 * 含 snake_case 变体），其次取内联 `legacyModuleExport` / `legacyModuleImport` 的节点数。
 * 取不到返回 `null` —— 调用方必须把它当成「Host 无法对账」，不得当成通过。
 */
function legacyModuleNodeCountFromResult(result: unknown, kind: 'export' | 'import'): number | null {
  const objects: Record<string, unknown>[] = [];
  collectCombatReceiptObjects(result, objects);
  const explicitKeys = kind === 'export' ? ['exportedNodeCount', 'exported_node_count'] : ['importedNodeCount', 'imported_node_count'];
  for (const object of objects) {
    for (const key of explicitKeys) {
      const count = receiptNodeCount(object[key]);
      if (count !== null) return count;
    }
  }
  const inlineKey = kind === 'export' ? 'legacyModuleExport' : 'legacyModuleImport';
  for (const object of objects) {
    const inline = record(object[inlineKey]);
    if (!inline) continue;
    for (const key of [...explicitKeys, 'nodeCount', 'node_count']) {
      const count = receiptNodeCount(inline[key]);
      if (count !== null) return count;
    }
    const payloadCount = inlineLegacyModulePayloadNodeCount(inline.payload);
    if (payloadCount !== null) return payloadCount;
  }
  // 最宽松的兜底：对象里确实出现内联导出/导入块时，也接受同层的通用节点数字段。
  for (const object of objects) {
    if (!COMBAT_INLINE_MODULE_RECEIPT_KEYS.some((key) => key in object)) continue;
    for (const key of ['nodeCount', 'node_count']) {
      const count = receiptNodeCount(object[key]);
      if (count !== null) return count;
    }
  }
  return null;
}

/**
 * 回读回执到达时结清对账义务。
 *
 * - 回读节点数 == 导入回执节点数 ⇒ 落盘结果与导入回执一致，义务结清。
 * - 两者都有值但不等 ⇒ 落盘结果与导入回执不符，保持拦截（`read-back-mismatch`）。
 * - 任一侧取不到数值 ⇒ Host **无法**做数值比对；此时不编造通过，只结清「按要求做了结构化回读」
 *   这一层，数值比对仍由模型与 Skill 承担（见交付说明的 Host-enforced / model-enforced 划分）。
 */
function settleCombatModuleReadBack(
  sessionId: string,
  skillId: string,
  readBackNodeCount: number | null,
): void {
  const pending = combatModuleReconciliationBySession.get(sessionId);
  if (!pending || pending.skillId !== skillId) return;
  if (pending.importedNodeCount === null || readBackNodeCount === null) {
    combatModuleReconciliationBySession.delete(sessionId);
    return;
  }
  if (pending.importedNodeCount !== readBackNodeCount) {
    combatModuleReconciliationBySession.set(sessionId, {
      ...pending,
      readBackNodeCount,
      status: 'read-back-mismatch',
    });
    return;
  }
  combatModuleReconciliationBySession.delete(sessionId);
}

/**
 * D2：消费老版模块编辑器的**结构化回执**（由传输层在拿到真实工具结果后调用）。
 *
 * 这是 `importedNodeCount` / `exportedNodeCount` 在 Host 侧的**唯一消费者**：没有它，一次丢节点的
 * `clear_existing=true` 全量替换会以 `success: true` 静默通过所有 19 道门禁。
 *
 * 只有**传输成功**的结果才应该传进来（失败结果没有可信回执，也不能建立基线）。
 */
export function observeCombatLegacyModuleResult(
  context: HostToolExecutionContext,
  result: unknown,
): void {
  if (!isCombatWorkflowPolicyActive(context)) return;
  const sessionId = combatSessionKey(context.sessionId);
  if (!sessionId) return;
  const call = combatLegacyModuleCommand(context);
  if (!call?.skillId) return;
  const skillId = call.skillId;
  if (/^legacy_module_export_json$/i.test(call.command)) {
    const exportedNodeCount = legacyModuleNodeCountFromResult(result, 'export');
    if (exportedNodeCount !== null) recordCombatExportNodeCount(sessionId, skillId, exportedNodeCount);
    settleCombatModuleReadBack(sessionId, skillId, exportedNodeCount);
    return;
  }
  if (/^legacy_module_import_json$/i.test(call.command)) {
    const importedNodeCount = legacyModuleNodeCountFromResult(result, 'import');
    const baselineNodeCount = readCombatExportNodeCount(sessionId, skillId);
    if (
      baselineNodeCount !== null &&
      importedNodeCount !== null &&
      baselineNodeCount === importedNodeCount
    ) {
      // 节点数与写入前基线一致：payload 没有丢节点，不产生回读义务。
      combatModuleReconciliationBySession.delete(sessionId);
      return;
    }
    combatModuleReconciliationBySession.set(sessionId, {
      skillId,
      baselineNodeCount,
      importedNodeCount,
      status: 'read-back-required',
    });
  }
}

/** 该调用是否是针对 `skillId` 的结构化导出回读（`legacy_module_export_json` + 该技能 ID）。 */
function isCombatModuleReadBackFor(
  context: HostToolExecutionContext,
  skillId: string,
): boolean {
  const call = combatLegacyModuleCommand(context);
  return Boolean(
    call && /^legacy_module_export_json$/i.test(call.command) && call.skillId === skillId,
  );
}

/**
 * 某种模块写义务未结清时，除「对同一技能的结构化导出回读」与「对同一技能的重新导入」之外，
 * 一律拦住。
 *
 * 「拒绝让这一轮以成功收尾」在策略层的落点就是这里：有损导入之后模型既不能继续读其它东西、也不能
 * 直接去做 P4 写入或换下一个目标，必须先交出结构化回读；拒绝理由带着技能 ID、写入前基线节点数与
 * 导入回执节点数，是一个可执行的指令而不是一句笼统的失败。
 */
function combatModuleWriteReconciliationReason(
  context: HostToolExecutionContext,
): string | null {
  const sessionId = combatSessionKey(context.sessionId);
  const pending = sessionId ? combatModuleReconciliationBySession.get(sessionId) : undefined;
  if (!pending) return null;
  if (isCombatModuleReadBackFor(context, pending.skillId)) return null;
  const retryImport = combatLegacyModuleCommand(context);
  if (
    retryImport &&
    /^legacy_module_import_json$/i.test(retryImport.command) &&
    retryImport.skillId === pending.skillId
  ) {
    return null;
  }
  const baseline =
    pending.baselineNodeCount === null
      ? '未建立（Host 没有该技能写入前的结构化导出基线，无法证明本次 payload 无损）'
      : String(pending.baselineNodeCount);
  const imported =
    pending.importedNodeCount === null
      ? '未解析出（导入回执里没有可读的 importedNodeCount）'
      : String(pending.importedNodeCount);
  const readBackNote =
    pending.status === 'read-back-mismatch'
      ? `已完成一次结构化回读，回读的 exportedNodeCount 是 ${pending.readBackNodeCount ?? '未解析出'}，与导入回执不一致：说明落盘的模块图与导入回执不是同一份事实。`
      : '';
  return `技能 ${pending.skillId} 的 legacy_module_import_json 是 --clear_existing=true 的全量替换，Host 必须看到写后对账才能让本轮继续：写入前导出的节点数基线 ${baseline}，导入回执的 importedNodeCount ${imported}。${readBackNote}请立刻对技能 ${pending.skillId} 再执行一次结构化的 legacy_module_export_json 回读（回执字段 exportedNodeCount），确认落盘节点数与导入回执一致后再继续；回读完成前不得推进其它读取、P4 写入、下一个目标或收尾，也不得把这次导入当作无损成功上报。若节点数确实是有意变化，必须在交付里逐项说明原因。`;
}

function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = path.resolve(root);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function combatUnityProjectRoot(context: HostToolExecutionContext): string {
  const workingDir = path.resolve(context.workingDir);
  const segments = workingDir.split(path.sep);
  const unityIndex = segments.findIndex((segment) => segment.toLowerCase() === 'saga2_unity');
  return unityIndex >= 0
    ? segments.slice(0, unityIndex + 1).join(path.sep)
    : path.join(workingDir, 'saga2_unity');
}

function legacyModuleJsonPathReason(context: HostToolExecutionContext): string | null {
  const call = legacyModuleJsonCommand(context);
  if (!call) return null;
  const expectedProjectPath = combatUnityProjectRoot(context);
  if (!call.projectPath || path.resolve(call.projectPath) !== path.resolve(expectedProjectPath)) {
    return `${call.command} 必须显式使用 Host 注入的 Unity 工程路径 ${expectedProjectPath}；不得省略 projectPath、使用当前选择或连接其它常驻 Unity 实例。`;
  }
  if (
    !call.jsonPath ||
    !path.isAbsolute(call.jsonPath) ||
    path.extname(call.jsonPath).toLowerCase() !== '.json'
  ) {
    return `${call.command} 必须使用绝对 .json 路径。导入源和回读导出只能放在操作系统临时目录或 saga2_unity 内。`;
  }
  if (
    !isPathInside(call.jsonPath, os.tmpdir()) &&
    !isPathInside(call.jsonPath, combatUnityProjectRoot(context))
  ) {
    return `${call.command} 的 JSON 路径超出授权范围。禁止写入 saga2_json、saga2_design 或其它目录；请改用操作系统临时目录或 saga2_unity。`;
  }
  return null;
}

function mcpParts(toolName: string | undefined): { server: string; tool: string } | null {
  if (!toolName) return null;
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.slice(5).split('__');
    return parts.length >= 2 ? { server: parts[0]!, tool: parts.slice(1).join('__') } : null;
  }
  if (toolName.startsWith('mcp:')) {
    const parts = toolName.slice(4).split(':');
    return parts.length >= 2
      ? { server: parts[0]!, tool: parts.slice(1).join(':') }
      : { server: parts[0]!, tool: '' };
  }
  return null;
}

function effectiveMcpTarget(
  toolName: string | undefined,
  input: unknown,
): { server: string; tool: string } | null {
  const target = mcpParts(toolName);
  if (!target) return null;
  if (target.tool) return target;
  const outer = record(input);
  const toolParams = record(outer?.toolParams);
  let inferredTool = text(outer?.toolName) || text(outer?.name);
  // Codex code-mode MCP approvals can omit `_meta.tool_name` while preserving
  // the complete arguments in `_meta.tool_params`. Infer only schema-unique
  // first-party wrappers; every other unknown action remains blocked.
  if (
    !inferredTool &&
    target.server === 'cindy' &&
    text(toolParams?.ghost_id) &&
    text(toolParams?.tool)
  ) {
    inferredTool = 'ghost_call';
  }
  if (!inferredTool && target.server === 'mcp_router' && text(toolParams?.name)) {
    inferredTool = 'call_tool';
  }
  if (!inferredTool && target.server === 'cindy_orca') {
    if (Array.isArray(toolParams?.workers)) {
      inferredTool = 'create_workers';
    } else if (
      text(toolParams?.initial_task) &&
      text(toolParams?.remote_host_id) &&
      text(toolParams?.role) &&
      text(toolParams?.agent) &&
      text(toolParams?.label)
    ) {
      inferredTool = 'create_worker';
    } else if (
      text(toolParams?.message) &&
      (text(toolParams?.worker_id) || text(toolParams?.session_id))
    ) {
      inferredTool = 'send_to_worker';
    }
  }
  if (!inferredTool) return null;
  return {
    ...target,
    tool: inferredTool,
  };
}

function mcpToolArguments(input: unknown): Record<string, unknown> {
  const outer = record(input) ?? {};
  return record(outer.toolParams) ?? outer;
}

function progressiveInnerCall(
  input: unknown,
): { name: string; args: Record<string, unknown> } | null {
  const outer = record(input);
  if (!outer) return null;
  const directName = text(outer.name);
  if (directName) return { name: directName, args: record(outer.args) ?? {} };
  const params = record(outer.toolParams);
  const nestedName = text(params?.name);
  return nestedName ? { name: nestedName, args: record(params?.args) ?? {} } : null;
}

function isUnityReadOnly(tool: string, input: unknown): boolean {
  if (READ_ONLY_MCP_TOOL_NAMES.test(tool)) return true;
  const outer = record(input);
  if (tool === 'unity_inspect') {
    return READ_ONLY_UNITY_CLI_ACTIONS.has(text(outer?.action));
  }
  if (tool !== 'unity_execute' || text(outer?.action) !== 'command') return false;
  const args = Array.isArray(outer?.arguments) ? outer.arguments : [];
  return text(args[0]) === 'legacy_module_export_json';
}

function ghostUnityCall(input: unknown): { tool: string; args: Record<string, unknown> } | null {
  const args = mcpToolArguments(input);
  if (text(args.ghost_id) !== 'meka-unity') return null;
  const tool = text(args.tool);
  return tool ? { tool, args: record(args.args) ?? {} } : null;
}

function isDesignPlanningPath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.includes('/saga2_design/planning/') || normalized.endsWith('/saga2_design/planning')
  );
}

function isPlanningMutation(context: HostToolExecutionContext): boolean {
  if (context.action.kind === 'file-write' && isDesignPlanningPath(context.action.path))
    return true;
  if (context.action.kind !== 'mcp') return false;
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server !== 'cindy' || target.tool !== 'ghost_call') return false;
  const args = mcpToolArguments(context.input);
  if (text(args.ghost_id) !== 'meka-p4') return false;
  const p4Args = record(args.args) ?? {};
  return Object.values(p4Args).some(isDesignPlanningPath);
}

function isUnityOpenRequest(context: HostToolExecutionContext): boolean {
  if (context.action.kind !== 'mcp') return false;
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server === 'meka-unity' && target.tool === 'unity_execute') {
    return text(mcpToolArguments(context.input).action) === 'open';
  }
  if (target?.server === 'cindy' && target.tool === 'ghost_call') {
    const unityCall = ghostUnityCall(context.input);
    return unityCall?.tool === 'unity_execute' && text(unityCall.args.action) === 'open';
  }
  return false;
}

async function isRouterReadOnly(projectId: string, tool: string, input: unknown): Promise<boolean> {
  if (tool === 'check_combat_environment' || READ_ONLY_MCP_TOOL_NAMES.test(tool)) return true;
  if (tool !== 'call_tool') return false;
  const inner = progressiveInnerCall(input);
  if (!inner) return false;
  if (READ_ONLY_ROUTER_CONTROL_TOOLS.has(inner.name)) return true;
  if (isKnownReadOnlyRouterProjectTool(inner.name)) return true;
  const tools = await getMekaRouterService().listProjectTools(projectId);
  const definition = tools.find((candidate) => text(candidate.name) === inner.name);
  const annotations = record(definition?.annotations);
  if (annotations?.readOnlyHint === true || annotations?.read_only === true) return true;
  if (annotations?.destructiveHint === true) return false;
  return READ_ONLY_MCP_TOOL_NAMES.test(inner.name);
}

async function isReadOnlyMcpCall(context: HostToolExecutionContext): Promise<boolean> {
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (!target) return false;
  if (target.server === 'cindy' && READ_ONLY_GLOBAL_MCP_TOOLS.has(target.tool)) return true;
  if (target.server === 'cindy' && target.tool === 'ghost_call') {
    const args = mcpToolArguments(context.input);
    if (text(args.ghost_id) === 'meka-p4' && text(args.tool) === 'p4_status') return true;
    const unityCall = ghostUnityCall(context.input);
    return unityCall ? isUnityReadOnly(unityCall.tool, unityCall.args) : false;
  }
  if (target.server === 'meka-unity') return isUnityReadOnly(target.tool, context.input);
  if (target.server === 'mcp_router') {
    return isRouterReadOnly('saga2', target.tool, context.input);
  }
  return READ_ONLY_MCP_TOOL_NAMES.test(target.tool);
}

function isEnvironmentRecoveryMcp(context: HostToolExecutionContext): boolean {
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server !== 'mcp_router') return false;
  if (
    [
      'check_combat_environment',
      'diagnose_mcp_router_connection',
      'list_tools',
      'list_project_remote_instances',
      'list_remote_instances',
      'list_remote_project_templates',
      'list_remote_directory',
      'read_remote_file',
      'search_remote_files',
      'create_remote_instance',
      'bind_remote_instance',
    ].includes(target.tool)
  ) {
    return true;
  }
  const inner = target.tool === 'call_tool' ? progressiveInnerCall(context.input) : null;
  return Boolean(inner && isCombatEnvironmentRecoveryControlTool(inner.name));
}

function isEnvironmentDiagnosticCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ').toLowerCase();
  return /^(?:where(?:\.exe)? p4|where(?:\.exe)? unity|p4 (?:-ztag )?(?:info|where|client -o|protects\b|login -s\b)|get-process\b|test-netconnection\b|netstat\b)/.test(
    normalized,
  );
}

type CombatEnvironmentDependency = 'p4' | 'unityCli' | 'mcpr';

function combatToolDependency(
  context: HostToolExecutionContext,
): CombatEnvironmentDependency | null {
  if (context.action.kind === 'file-write') return 'p4';
  if (context.action.kind === 'exec') {
    if (isEnvironmentDiagnosticCommand(context.action.command)) return null;
    const normalized = context.action.command
      .trim()
      .replace(/^['"]+/, '')
      .toLowerCase();
    if (/^(?:p4\b|p4\.exe\b)/.test(normalized)) return 'p4';
    return null;
  }
  if (context.action.kind !== 'mcp') return null;
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (!target) return null;
  if (target.server === 'meka-unity') return 'unityCli';
  if (target.server === 'cindy' && target.tool === 'ghost_call') {
    const args = mcpToolArguments(context.input);
    if (text(args.ghost_id) === 'meka-p4') return 'p4';
    return ghostUnityCall(context.input) ? 'unityCli' : null;
  }
  if (target.server === 'mcp_router') {
    return isCombatEnvironmentCheck(context) ? null : 'mcpr';
  }
  if (target.server === 'cindy_orca' && combatServerDispatchRequest(context)) return 'mcpr';
  return null;
}

function blockedDependencyReason(
  options: CombatVendorOptions,
  dependency: CombatEnvironmentDependency,
): string | null {
  const checks = record(options.mekaCombatEnvironmentChecks);
  const check = record(checks?.[dependency]);
  const status = text(check?.status);
  if (status === 'ready') return null;
  if (status !== 'blocked' && options.mekaWorkflow === WORKFLOW) return null;

  const label = dependency === 'p4' ? 'P4' : dependency === 'unityCli' ? 'Unity CLI' : 'MCPRouter';
  const summary = text(check?.summary) || `${label} 当前状态尚未完成校验`;
  const nextAction =
    text(check?.nextAction) || '调用 mcp_router.check_combat_environment 刷新三条链路状态后重试';
  return `当前工具实际依赖 ${label}，因此只阻止本次调用，不冻结整个任务。原因：${summary}。解决方案：${nextAction}。不依赖 ${label} 的探索、澄清和其它工具仍可继续。`;
}

function readOnlySelectStringPayload(command: string): string | null {
  const match = command.match(
    /^"[^"]*[\\/](?:pwsh|powershell)(?:\.exe)?"\s+-command\s+"([\s\S]*)"\s*$/i,
  );
  const payload = match?.[1]?.trim();
  if (!payload || !/^select-string\b/i.test(payload)) return null;
  if (/\b(?:env|variable|function|registry):/i.test(payload)) return null;

  let singleQuoted = false;
  let shellReviewPayload = '';
  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index];
    if (char === "'") {
      if (singleQuoted && payload[index + 1] === "'") {
        shellReviewPayload += "''";
        index += 1;
        continue;
      }
      singleQuoted = !singleQuoted;
      shellReviewPayload += char;
      continue;
    }
    if (!singleQuoted && /["`$;&|><(){}]/.test(char)) return null;
    // POSIX shell review removes quotes before some checks. PowerShell treats
    // these characters as literal data inside single quotes, so mask them to
    // avoid misclassifying a regex such as '预警|伤害' as a shell pipeline.
    shellReviewPayload += singleQuoted && /[`$;&|><(){}]/.test(char) ? '_' : char;
  }
  if (singleQuoted) return null;
  return shellReviewPayload;
}

function isMekaSkillSnapshotEntrypoint(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, '/');
  if (/[?*;|><`$(){}]/.test(normalized) || normalized.split('/').includes('..')) return false;
  return /\/meka-skill-snapshots\/revisions\/[a-f0-9]{32,256}\/claude-plugin\/skills\/combat-skill-configuration\/SKILL\.md$/i.test(
    normalized,
  );
}

function powerShellCommandPayload(command: string): string | null {
  const wrapper = command.match(
    /^"[^"]*[\\/](?:pwsh|powershell)(?:\.exe)?"\s+-command\s+([\s\S]+)$/i,
  );
  const payload = wrapper?.[1]?.trim() ?? '';
  return payload && !/[\r\n]/.test(payload) ? payload : null;
}

function isReadOnlySkillSnapshotProbe(command: string): boolean {
  const payload = powerShellCommandPayload(command);
  if (!payload) return false;

  // Codex may read a selected Skill through this generated PowerShell shape in
  // order to emit both its line count and complete content. Keep the allowance
  // narrower than general PowerShell: one snapshot SKILL.md read, then two
  // outputs from the same local variable, with no pipeline or extra command.
  const probe = payload.match(
    /^['"]*\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Get-Content\s+(?:-Raw\s+)?-LiteralPath\s+['"]+([^'";\r\n]+)['"]+\s*;\s*['"]*\$\1\.Length\s*;\s*\$\1['"]*$/i,
  );
  return Boolean(probe?.[2] && isMekaSkillSnapshotEntrypoint(probe[2]));
}

function isReadOnlySkillSnapshotDirectRead(command: string): boolean {
  const wrappedPayload = powerShellCommandPayload(command);
  const payload =
    wrappedPayload?.startsWith('"') && wrappedPayload.endsWith('"')
      ? wrappedPayload.slice(1, -1).trim()
      : (wrappedPayload ?? command.trim());
  const probe = payload.match(/^\s*Get-Content(?:\s+-Raw)?\s+['"]([^'"\r\n]+)['"]\s*$/i);
  return Boolean(probe?.[1] && isMekaSkillSnapshotEntrypoint(probe[1]));
}

function isReadOnlySkillSnapshotLineCount(command: string): boolean {
  const payload = powerShellCommandPayload(command);
  if (!payload) return false;
  const batch = payload.match(
    /^['"]*\$paths\s*=\s*@\(([\s\S]*?)\)\s*;\s*foreach\s*\(\s*['"]*\$p\s+in\s+\$paths\s*\)\s*\{\s*if\s*\(\s*Test-Path\s+\$p\s*\)\s*\{\s*\$m\s*=\s*Get-Content\s+\$p\s*\|\s*Measure-Object\s+-Line\s*;\s*Write-Output\s+['"]*\$p`t\$\(\$m\.Lines\)['"]*\s*\}\s*\}['"]*$/i,
  );
  const pathList = batch?.[1];
  if (!pathList) return false;

  const paths: string[] = [];
  const remainder = pathList.replace(/['"]+([^'"\r\n]+)['"]+/g, (_match, candidate: string) => {
    paths.push(candidate);
    return '';
  });
  return (
    paths.length > 0 &&
    paths.length <= 32 &&
    /^[\s,]*$/.test(remainder) &&
    paths.every(isMekaSkillSnapshotEntrypoint)
  );
}

function isReadOnlySkillSnapshotCount(command: string): boolean {
  const payload = powerShellCommandPayload(command);
  if (!payload) return false;
  const probe = payload.match(
    /^['"]*\(\s*Get-Content\s+(?:-Raw\s+)?-LiteralPath\s+['"]+([^'";\r\n]+)['"]+\s*\)\.Count['"]*$/i,
  );
  return Boolean(probe?.[1] && isMekaSkillSnapshotEntrypoint(probe[1]));
}

function posixShellCommandPayload(command: string): string | null {
  const wrapper = command.match(
    /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|sh)\s+-(?:c|lc)\s+'([^'\r\n]*)'\s*$/i,
  );
  const payload = wrapper?.[1]?.trim();
  return payload || null;
}

function isStrictReadOnlyGitGrep(command: string): boolean {
  if (/[;&<>`\r\n]/.test(command) || /\$\(/.test(command)) return false;
  return /^git\s+grep(?:\s+(?:-n|-E|-I|-l|--full-name|--no-color|-C\s+(?:[0-9]|[1-3][0-9]|40)|--context=(?:[0-9]|[1-3][0-9]|40))){0,7}\s+(?:[A-Za-z0-9_.*+?^,:=\\/-]+|['"][A-Za-z0-9_.*+?^|()[\]{}\\,:=/-]+['"])\s+HEAD\s+--\s+(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+(?:\s+(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+)*$/i.test(
    command,
  );
}

function isStrictCombatServerReadOnlyExec(command: string): boolean {
  const payload = posixShellCommandPayload(command) ?? command.trim();
  if (/[;&<>`\r\n]/.test(payload) || /\$\(/.test(payload)) return false;
  if (isStrictReadOnlyGitGrep(payload)) return true;
  return (
    /^git\s+show\s+-s\s+--format=%H\s+HEAD$/i.test(payload) ||
    /^git\s+show\s+HEAD:(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+(?:\s+HEAD:(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+)*$/i.test(
      payload,
    ) ||
    /^git\s+status(?:\s+--short)?$/i.test(payload) ||
    /^git\s+diff(?:\s+--(?:stat|name-only|name-status))?(?:\s+--\s+(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+(?:\s+(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+)*)?$/i.test(
      payload,
    )
  );
}

function isCombatReadOnlyExec(
  command: string,
  workingDir: string,
  cwd?: string,
  cwdUnknown?: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const reviewOptions = {
    ...(cwd ? { cwd } : {}),
    ...(cwdUnknown ? { cwdUnknown: true } : {}),
    platform,
  };
  if (classifyShellCommand(command, [workingDir], reviewOptions) === 'auto-approve') return true;
  const posixPayload = posixShellCommandPayload(command);
  if (
    posixPayload &&
    (classifyShellCommand(posixPayload, [workingDir], reviewOptions) === 'auto-approve' ||
      isStrictReadOnlyGitGrep(posixPayload))
  )
    return true;
  if (
    isReadOnlySkillSnapshotDirectRead(command) ||
    isReadOnlySkillSnapshotProbe(command) ||
    isReadOnlySkillSnapshotLineCount(command) ||
    isReadOnlySkillSnapshotCount(command)
  )
    return true;
  const selectStringPayload = readOnlySelectStringPayload(command);
  if (!selectStringPayload) return false;
  const normalized = selectStringPayload.replace(/^select-string\b/i, 'grep');
  return classifyShellCommand(normalized, [workingDir], reviewOptions) === 'auto-approve';
}

function isTargetedCombatClientReadPath(
  context: HostToolExecutionContext,
  requestedPath: string,
): boolean {
  if (/[?*[\]]/.test(requestedPath)) return false;
  const baseDir =
    context.action.kind === 'exec' && context.action.cwd ? context.action.cwd : context.workingDir;
  const absolutePath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(baseDir, requestedPath);
  const unityRoot = combatUnityProjectRoot(context);
  if (!isPathInside(absolutePath, unityRoot) || isForbiddenCombatClientEvidence(absolutePath)) {
    return false;
  }
  const relative = path.relative(unityRoot, absolutePath).replace(/\\/g, '/').toLowerCase();
  if (!relative || relative.split('/').includes('..')) return false;
  if (/(?:^|\/)\.agents(?:\/|$)/.test(relative)) return false;
  return (
    relative === 'agents.md' ||
    (relative.startsWith('assets/scripts/hot/') && path.extname(relative) === '.cs') ||
    (relative.startsWith('assets/editor/skilleditor/common/') && path.extname(relative) === '.cs')
  );
}

function targetedSelectStringPath(command: string): string | null {
  const payload = exactPowerShellReadPayload(command);
  if (!/^Select-String\b/i.test(payload) || /[\r\n]/.test(payload)) return null;

  let singleQuoted = false;
  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index];
    if (char === "'") {
      if (singleQuoted && payload[index + 1] === "'") {
        index += 1;
        continue;
      }
      singleQuoted = !singleQuoted;
      continue;
    }
    if (!singleQuoted && /["`$;&|><(){}]/.test(char)) return null;
  }
  if (singleQuoted) return null;

  const optionPattern = /(?:^|\s)-(Path|LiteralPath|Pattern)\s+'((?:''|[^'])*)'/gi;
  const options = [...payload.matchAll(optionPattern)];
  const paths = options.filter((match) => /^(?:Path|LiteralPath)$/i.test(match[1] ?? ''));
  const patterns = options.filter((match) => /^Pattern$/i.test(match[1] ?? ''));
  if (paths.length !== 1 || patterns.length !== 1 || !paths[0]?.[2]) return null;

  const remainder = payload
    .replace(/^Select-String\b/i, '')
    .replace(optionPattern, ' ')
    .trim();
  if (
    remainder !== '' &&
    !/^(?:(?:-(?:SimpleMatch|CaseSensitive|List|AllMatches|Quiet|NoEmphasis))|(?:-Context\s+\d{1,3}\s*,\s*\d{1,3})|(?:-Encoding\s+(?:ascii|bigendianunicode|bigendianutf32|oem|unicode|utf7|utf8|utf8bom|utf8nobom|utf32)))(?:\s+(?=-)|\s*$)*$/i.test(
      remainder,
    )
  ) {
    return null;
  }
  return paths[0][2].replace(/''/g, "'");
}

function isTargetedCombatClientPowerShellRead(context: HostToolExecutionContext): boolean {
  if (context.action.kind !== 'exec') return false;
  const directReadPath = exactPowerShellReadPath(context.action.command);
  if (directReadPath && isTargetedCombatClientReadPath(context, directReadPath)) return true;
  const selectStringPath = targetedSelectStringPath(context.action.command);
  return Boolean(selectStringPath && isTargetedCombatClientReadPath(context, selectStringPath));
}

/**
 * 项目参考路径白名单：Host 在 `[SAGA2_PROJECT_PATHS]` 里用 `*ReadCommand` 明确交给战斗角色的
 * **项目侧域事实**文件 —— 老版模块编辑器契约 `editor-skill-editor-module/SKILL.md` 与策划
 * 设计库的伤害/模块编码权威规则 `ModuleDesignKnowledge.md`。
 *
 * 这两条路径由 `mekaResolvePlan` 从当前 workingDir 解析后写进
 * `vendorOptions.mekaCombatProjectRefPaths`；策略层只读该数组，**不得**硬编码任何用户机器
 * 路径。放行是**精确路径 + 单文件只读**：枚举、通配、写操作仍然一律拒绝。
 */
function combatProjectRefPaths(context: { vendorOptions: Record<string, unknown> }): string[] {
  const raw = context.vendorOptions.mekaCombatProjectRefPaths;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => path.resolve(value.trim()));
}

function combatReadBaseDir(context: HostToolExecutionContext): string {
  return context.action.kind === 'exec' && context.action.cwd
    ? context.action.cwd
    : context.workingDir;
}

function resolveCombatReadTarget(context: HostToolExecutionContext, candidate: string): string {
  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(combatReadBaseDir(context), candidate);
}

/**
 * 候选读路径：原生 Read 的 `path`，或 Shell 里**单条** `Get-Content` 的 LiteralPath。
 * 枚举形态（`rg --files`、`Get-ChildItem -Recurse`、`$files` 批读、多命令串联）拿不到路径。
 */
function requestedCombatReadPath(context: HostToolExecutionContext): string | null {
  if (context.action.kind === 'read') return context.action.path?.trim() || null;
  if (context.action.kind !== 'exec') return null;
  return exactPowerShellReadPath(context.action.command);
}

function isAllowedCombatProjectRefPath(
  context: HostToolExecutionContext,
  candidate: string | null | undefined,
): boolean {
  if (!candidate || /[?*[\]]/.test(candidate)) return false;
  const allowed = combatProjectRefPaths(context);
  if (allowed.length === 0) return false;
  const absolute = resolveCombatReadTarget(context, candidate);
  return allowed.some((entry) => sameResolvedPath(absolute, entry));
}

/** 白名单路径的**单文件只读**判定（注入路径放行的统一入口）。 */
function isAllowedCombatProjectRefSingleRead(context: HostToolExecutionContext): boolean {
  return isAllowedCombatProjectRefPath(context, requestedCombatReadPath(context));
}

/**
 * 项目根解析，规则与 `combatProjectPathsPrompt` 的 `projectRoot` 逐字一致
 * （`workingDir` 以 `saga2_unity` 结尾时上移一层）。两处必须同步修改。
 */
function combatProjectRootForPolicy(context: HostToolExecutionContext): string {
  const workingDir = path.resolve(context.workingDir);
  return path.basename(workingDir).toLowerCase() === 'saga2_unity'
    ? path.dirname(workingDir)
    : workingDir;
}

/**
 * 是否表范围请求。**只用于只读解析面**：审批位（`mekaCombatScopeApproved`）只决定写入，
 * 不决定能否只读解析范围 —— 否则用户一旦确认范围，范围级的只读发现反而会被首证据门禁锁死
 * （表范围没有单值目标，永远无法产生 `mekaCombatTargetExportCompleted`）。
 */
function isCombatTableScope(options: CombatVendorOptions): boolean {
  return options.mekaCombatRequestScope === 'table-scope';
}

/** 用户在消息里声明的范围源表（`mekaCombatScopeSourceTables`）。 */
function combatScopeSourceTables(context: HostToolExecutionContext): string[] {
  const raw = combatOptions(context.vendorOptions).mekaCombatScopeSourceTables;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
}

/** 用户确认范围后允许出现的技能 ID 集合（未确认时恒为空）。 */
function approvedCombatScopeSkillIds(options: CombatVendorOptions): string[] {
  if (options.mekaCombatRequestScope !== 'table-scope' || options.mekaCombatScopeApproved !== true) {
    return [];
  }
  // 截断过的清单**不是**完整成员集：部分清单会把范围里的 ID 误判成「范围外」（错误拒绝），
  // 比「没有清单」更危险。截断时按没有清单处理（逐次单 ID 约束），并保留 truncated 事实。
  if (options.mekaCombatScopeSkillIdsTruncated === true) return [];
  const raw = options.mekaCombatScopeSkillIds;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => normalizePositiveDecimal(value))
    .filter((value): value is string => Boolean(value));
}

/**
 * 已批准的表范围，但 Host 手上还没有成员 ID 清单（清单在 Agent 解析结果里，Host 读不到）。
 * 此时无法做成员白名单比对，只能靠**逐次单 ID + 用户已确认的范围**约束；其余写入门禁
 * （P4 边界、路径白名单、首证据、证据依据）全部照旧。
 *
 * A4 之后这个分支不再是「唯一形态」：Agent 只要按范围段要求做过一次带显式 `skill_ids` 的
 * 只读范围查询，Host 就已经把那些 ID 记进 `mekaCombatScopeSkillIds`，成员资格比对因此真的
 * 生效。清单缺失只发生在「用户直接批准、Agent 没走过查询」或清单被截断时。
 */
function isApprovedCombatTableScopeWithoutList(options: CombatVendorOptions): boolean {
  return (
    isCombatTableScope(options) &&
    options.mekaCombatScopeApproved === true &&
    approvedCombatScopeSkillIds(options).length === 0
  );
}

/**
 * 表范围成员清单上限。超过上限时只保留前 N 个并记 `mekaCombatScopeSkillIdsTruncated=true`
 * —— 该标记会让成员资格比对回落到「无清单」口径，避免部分清单造成错误拒绝。
 * （这不是新的额度/预算，只是防止把一份不可能完整的清单当成成员白名单。）
 */
const COMBAT_SCOPE_SKILL_IDS_LIMIT = 200;

/** 数值字符串升序（`'10' < '9'` 是错的，必须按数值比较）。 */
function compareNumericStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 只读范围查询参数里显式传入的技能 ID（`skill_ids=1019,1020` / `--skill_ids 1019 1020`）。
 * 只认 `/^[1-9]\d*$/`：`all`、`*`、空值与其它命名参数一律忽略。
 */
function explicitScopeQuerySkillIds(arguments_: readonly string[]): string[] {
  const ids = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index] ?? '';
    const inline = value.match(/^(?:--?)?skill[_-]?ids?=(.+)$/i);
    if (inline?.[1]) {
      for (const part of inline[1].split(/[,\s]+/)) {
        const normalized = normalizePositiveDecimal(part);
        if (normalized) ids.add(normalized);
      }
      continue;
    }
    if (!/^(?:--?)?skill[_-]?ids?$/i.test(value)) continue;
    for (let cursor = index + 1; cursor < arguments_.length; cursor += 1) {
      const next = arguments_[cursor] ?? '';
      // 下一个命名参数（`-x` / `--x` / `name=`）之后就不再是本参数的取值。
      if (/^-{1,2}[A-Za-z]/.test(next) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) break;
      for (const part of next.split(/[,\s]+/)) {
        const normalized = normalizePositiveDecimal(part);
        if (normalized) ids.add(normalized);
      }
      index = cursor;
    }
  }
  return [...ids];
}

/**
 * 表范围解析期的**成员清单登记**（A4）。
 *
 * 范围段要求 Agent 在用户批准前先用白名单只读查询（`legacy_module_query_nodes`，显式传
 * `skill_ids`）取回「在用集合」；这些 ID 正是用户随后确认的范围。Host 在这里把 Agent 自己
 * 查过的 ID 记进 `vendorOptions.mekaCombatScopeSkillIds`，于是批准之后的成员资格比对
 * （`approvedCombatScopeSkillIds` / `isTargetLegacyModuleExport` 的严格分支）真的非空、
 * 真的能拦住范围外的显式 ID。
 *
 * 这是「Agent 自己的只读范围查询 + 用户确认」推导出的**一致性 guard**，**不是**授权边界：
 * 它不证明这些 ID 属于业务范围，只保证实施阶段出现的 ID 曾经被 Agent 明确查询过、并且整个
 * 范围经用户确认。真正的边界仍是 P4 / 路径白名单 / 审批位 / 证据依据这些门禁。
 *
 * 只在**未批准**时登记（用户确认之后清单冻结，避免已批准会话通过再次查询自行扩大成员集）；
 * 去重、按数值升序、只保留正整数。
 */
function recordCombatScopeSkillIds(context: HostToolExecutionContext): void {
  const options = combatOptions(context.vendorOptions);
  if (!isCombatTableScope(options)) return;
  if (options.mekaCombatScopeApproved === true) return;
  const request = unityInspectCommandRequest(context);
  if (!request || !/^legacy_module_query_nodes$/i.test(request.command)) return;
  const queried = explicitScopeQuerySkillIds(request.arguments);
  if (queried.length === 0) return;
  const existing = Array.isArray(options.mekaCombatScopeSkillIds)
    ? options.mekaCombatScopeSkillIds
    : [];
  const merged = new Set<string>();
  for (const value of [...existing, ...queried]) {
    const normalized = normalizePositiveDecimal(value);
    if (normalized) merged.add(normalized);
  }
  const sorted = [...merged].sort(compareNumericStrings);
  options.mekaCombatScopeSkillIds = sorted.slice(0, COMBAT_SCOPE_SKILL_IDS_LIMIT);
  if (sorted.length > COMBAT_SCOPE_SKILL_IDS_LIMIT) {
    options.mekaCombatScopeSkillIdsTruncated = true;
  } else {
    delete options.mekaCombatScopeSkillIdsTruncated;
  }
}

/**
 * 证据依据是否为「注入的项目权威参考」。**该键由 Host 依据注入情况写入，不是 Agent 的判断**：
 * Agent 只能在 PLAN/RESULT 里原样声明 basis 与所依据的注入路径，Host 一律以 vendorOptions 里的
 * 值为准。两类请求口径统一为「参考覆盖 ⇒ 不要求服务器 supported 回执」：
 * 1) 表范围：`mekaCombatScopeApproved === true`（用户已确认范围）；
 * 2) 单技能：`mekaCombatTargetSkillIdState === 'confirmed'`（目标由用户给出并绑定）；
 * 3) 共同前提：`mekaCombatProjectRefPaths` **确实已注入**（未注入 = 无覆盖，fail-closed 回落到
 *    服务器回执），且 Host 记录了 `mekaCombatEvidenceBasis === 'project-reference'`。
 *
 * 只影响「写入是否需要服务器 supported 回执」。Worker 只读边界、派发协议、报告 schema、
 * `validate_server_capability_report` 的字段校验、`unsupported`/`uncertain` 的拒绝与环境门禁
 * 全部不变。
 */
function combatEvidenceBasisIsProjectReference(context: HostToolExecutionContext): boolean {
  const options = combatOptions(context.vendorOptions);
  if (options.mekaCombatEvidenceBasis !== 'project-reference') return false;
  if (combatProjectRefPaths(context).length === 0) return false;
  if (isCombatTableScope(options)) return options.mekaCombatScopeApproved === true;
  return options.mekaCombatTargetSkillIdState === 'confirmed';
}

/**
 * 表范围的有界只读范围解析面：只允许对声明的源表、`saga2_json` 下的表文件、
 * 老版模块资产目录里的单个 `.asset` 和已注入的项目参考路径做**单文件**读取。
 * 枚举、通配、其它目录与全部写操作都不在此列（`ModuleV2` 另被
 * `isForbiddenCombatClientEvidence` 拦掉）。
 */
function isCombatScopeResolutionRead(context: HostToolExecutionContext): boolean {
  if (!isCombatTableScope(combatOptions(context.vendorOptions))) return false;
  const requested = requestedCombatReadPath(context);
  if (!requested || /[?*[\]]/.test(requested)) return false;
  const absolute = resolveCombatReadTarget(context, requested);
  if (isForbiddenCombatClientEvidence(absolute)) return false;
  if (isAllowedCombatProjectRefPath(context, absolute)) return true;
  const projectRoot = combatProjectRootForPolicy(context);
  if (
    combatScopeSourceTables(context).some((table) =>
      sameResolvedPath(absolute, path.resolve(projectRoot, table)),
    )
  ) {
    return true;
  }
  if (isPathInside(absolute, path.join(projectRoot, 'saga2_json'))) return true;
  // 「模块资产」= 老版模块编辑器的资产正本（`Module/Saved Data/Modules/<id>.asset`）。
  return (
    path.extname(absolute).toLowerCase() === '.asset' &&
    isPathInside(
      absolute,
      path.join(
        combatUnityProjectRoot(context),
        'Assets',
        'Editor',
        'SkillEditor',
        'Module',
        'Saved Data',
        'Modules',
      ),
    )
  );
}

/** 只读 Unity Pipeline 命令白名单（Host 注入；未注入 = 空 = 一律不放行）。 */
function readOnlyCombatUnityCommands(context: {
  vendorOptions: Record<string, unknown>;
}): string[] {
  const raw = context.vendorOptions.mekaCombatReadOnlyUnityCommands;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => value.trim());
}

/**
 * `unity_inspect(action="command", projectPath, arguments=[...])` 的请求形态
 * （直连 meka-unity 或 `cindy ghost_call` 包装都认）。只返回**单条**命令：
 * 参数里出现 shell 连接符或换行就不是单条只读查询，返回 null。
 */
function unityInspectCommandRequest(
  context: HostToolExecutionContext,
): { command: string; projectPath: string; arguments: string[] } | null {
  if (context.action.kind !== 'mcp') return null;
  const target = effectiveMcpTarget(context.toolName, context.input);
  let args: Record<string, unknown> | null = null;
  if (target?.server === 'meka-unity' && target.tool === 'unity_inspect') {
    args = mcpToolArguments(context.input);
  } else if (target?.server === 'cindy' && target.tool === 'ghost_call') {
    const unityCall = ghostUnityCall(context.input);
    if (unityCall?.tool === 'unity_inspect') args = unityCall.args;
  }
  if (!args || text(args.action) !== 'command' || !Array.isArray(args.arguments)) return null;
  const values = args.arguments.map((value) => String(value));
  const [command, ...rest] = values;
  if (!command) return null;
  if (rest.some((value) => /[;&|<>`\r\n]/.test(value))) return null;
  return { command, projectPath: text(args.projectPath), arguments: values };
}

/**
 * 表范围解析期（`mekaCombatRequestScope === 'table-scope'`）的只读范围发现通道：
 * `unity_inspect(action="command")` + Host 注入白名单命令，且 `projectPath` 必须与注入的
 * `unityClientRoot` 逐字一致（复用 status 的同一校验口径）。
 *
 * **只放行只读查询**：`unity_execute`（含老版模块导入/导出）不在此列；写入仍受 P4 边界、
 * 路径白名单、审批位与服务器 supported 回执约束。
 */
function isCombatScopeResolutionUnityQuery(context: HostToolExecutionContext): boolean {
  if (!isCombatTableScope(combatOptions(context.vendorOptions))) return false;
  const request = unityInspectCommandRequest(context);
  if (!request) return false;
  if (!readOnlyCombatUnityCommands(context).includes(request.command)) return false;
  if (!request.projectPath) return false;
  return path.resolve(request.projectPath) === path.resolve(combatUnityProjectRoot(context));
}

/**
 * Design documents are a read-only source, but bulk-reading them can consume the
 * entire context. Keep targeted searches available while rejecting full-file/batch scans.
 *
 * 例外：Host 注入的项目参考路径（伤害/模块编码规则）允许**单文件只读**读取；枚举与
 * 通配形态（`-Recurse`、`Get-ChildItem`、`Select-String -Path $files`）仍然拒绝，
 * `01-治理规范-governance/` 也仍然拒绝。
 */
function isBroadCombatDesignExplorationCommand(context: HostToolExecutionContext): boolean {
  if (context.action.kind !== 'exec') return false;
  const command = context.action.command;
  if (!/saga2_design/i.test(command)) return false;
  if (isAllowedCombatProjectRefSingleRead(context)) return false;
  return (
    /Get-Content\b/i.test(command) ||
    /(?:-Recurse|Get-ChildItem\b[^\r\n]*(?:-Filter\s+\*\.md|-File\b))/i.test(command) ||
    /(?:Select-String\b[^\r\n]*-Path\s+[^\r\n]*\$files|foreach\s*\([^\r\n]*\$files)/i.test(command)
  );
}

function isBroadCombatSkillExplorationCommand(context: HostToolExecutionContext): boolean {
  if (context.action.kind !== 'exec') return false;
  const command = context.action.command;
  if (
    !/(?:saga2_unity[\\/]\.agents[\\/]skills|\.codex[\\/]plugins|\.claude[\\/]skills)/i.test(
      command,
    )
  )
    return false;
  // 唯一豁免：Host 注入并白名单的 `editor-skill-editor-module/SKILL.md` 的单文件只读读取。
  // 其余任何 `SKILL.md`（含同目录其它技能、相对路径改写、批量枚举）仍然拒绝。
  if (isAllowedCombatProjectRefSingleRead(context)) return false;
  if (
    /(?:\.agents[\\/]skills|\.codex[\\/]plugins|\.claude[\\/]skills)/i.test(command) &&
    /SKILL\.md/i.test(command)
  )
    return true;
  return /(?:Get-ChildItem|rg\s+--files|find\s+|dir\s+)[^\r\n]*(?:-Recurse|\.agents[\\/]skills)/i.test(
    command,
  );
}

function isBroadCombatWorkspaceEnumeration(command: string): boolean {
  return /(?:rg\s+--files|Get-ChildItem|dir\s+|find\s+)[^\r\n]*\b(?:saga2_unity|saga2_json)(?:\b|[\\/])/i.test(
    command,
  );
}

function isBroadCombatClientSearch(command: string): boolean {
  if (!/(?:^|\s)(?:rg|Select-String)\b/i.test(command)) return false;
  const normalized = command.replace(/\\/g, '/');
  return (
    /saga2_unity\/Assets(?:[\s'"]|$)/i.test(normalized) ||
    /saga2_unity\/Assets\/Editor\/SkillEditor\/Module(?:[\s'"]|$)/i.test(normalized)
  );
}

function isBroadCombatDesignReadPath(
  context: HostToolExecutionContext,
  filePath: string | undefined,
): boolean {
  if (!filePath || !/saga2_design[\\/]/i.test(filePath)) return false;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  // 治理规范始终拒绝（先判，不能被白名单短路）。
  if (normalized.includes('/01-治理规范-governance/')) return true;
  // Host 注入的项目参考路径（策划设计库编码规则）按精确路径放行。
  if (isAllowedCombatProjectRefPath(context, filePath)) return false;
  return normalized.endsWith('/skill.md');
}

/**
 * `.agents/skills`、`.codex`、`.claude` 下的 `SKILL.md` 一律视为「其它 Agent Skill」。
 *
 * **唯一例外**：Host 注入并写进 `mekaCombatProjectRefPaths` 的
 * `editor-skill-editor-module/SKILL.md`（项目侧域事实正本）。判定是**精确解析路径**比对
 * （`sameResolvedPath`），不是目录前缀：同目录下其它技能、被改写的相对路径、以及
 * `.codex`/`.claude` 下的任何 `SKILL.md` 仍然拒绝。
 */
function isUnrelatedCombatSkillReadPath(
  context: HostToolExecutionContext,
  filePath: string | undefined,
): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const isAgentSkillDocument =
    /(?:^|\/)(?:\.agents\/skills|\.codex|\.claude)(?:\/|$)/.test(normalized) &&
    /(?:^|\/)skill\.md$/.test(normalized);
  if (!isAgentSkillDocument) return false;
  return !isAllowedCombatProjectRefPath(context, filePath);
}

function isForbiddenCombatClientEvidence(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.includes('/modulev2/') ||
    normalized.includes('modulev2') ||
    normalized.includes('module_v2') ||
    /(?:^|\/)skill_entry_model_editor\.json(?:$|[\s'";,])/i.test(normalized)
  );
}

function isKnownAgentsFileEnumeration(command: string): boolean {
  return (
    /(?:rg\s+--files|get-childitem|dir\s+|find\s+)[^\r\n]*\bagents\.md\b/i.test(command) ||
    /\bagents\.md\b[^\r\n]*(?:rg\s+--files|get-childitem|dir\s+|find\s+)/i.test(command)
  );
}

function isDisallowedCombatAgentsRead(command: string): boolean {
  if (!/\bAGENTS\.md\b/i.test(command)) return false;
  if (isKnownAgentsFileEnumeration(command)) return true;
  const normalized = command.replace(/[\\/]+/g, '/');
  return !/saga2_unity\/AGENTS\.md/i.test(normalized);
}

function exactPowerShellReadPayload(command: string): string {
  const wrapped = powerShellCommandPayload(command);
  if (!wrapped) return command.trim();
  return wrapped.startsWith('"') && wrapped.endsWith('"') ? wrapped.slice(1, -1).trim() : wrapped;
}

function exactPowerShellReadPath(command: string): string | null {
  const payload = exactPowerShellReadPayload(command);
  if (/[;|&<>`\r\n]/.test(payload)) return null;
  const normalizedPayload = payload.replace(/\\{2,}/g, '\\').trim();
  // `-Encoding` 只接受 UTF-8 家族：被放行的参考文件都是 UTF-8，`-Encoding Oem/Default`
  // 之类会把中文读成乱码，等于"读了但没读到"，不能算一次成功的读取。
  // （与 `Select-String` 的宽松编码白名单刻意不同，这里收窄到 utf8 / utf8bom / utf8nobom。）
  return (
    normalizedPayload.match(
      /^Get-Content(?:\s+-(?:Raw|LiteralPath|Encoding\s+utf8(?:bom|nobom)?)){0,3}\s+['"]([^'"]+)['"](?:\s+-(?:Raw|Encoding\s+utf8(?:bom|nobom)?)){0,2}$/i,
    )?.[1] ?? null
  );
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function expectedLegacyModuleProtocolCodecPath(context: HostToolExecutionContext): string {
  return path.join(
    combatUnityProjectRoot(context),
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
}

function authoritativeCombatReadPathReason(context: HostToolExecutionContext): string | null {
  if (context.action.kind !== 'exec') return null;
  const requestedPath = exactPowerShellReadPath(context.action.command);
  if (!requestedPath) return null;
  const normalized = requestedPath.replace(/\\/g, '/').toLowerCase();
  const isUnityAgents = normalized.endsWith('/saga2_unity/agents.md');
  const isLegacyProtocol = normalized.endsWith(
    '/saga2_unity/assets/editor/skilleditor/common/editor/exporter/execute/impl/type/skillmoduleprotocolcodec.cs',
  );
  if (!isUnityAgents && !isLegacyProtocol) return null;
  const expectedPath = isUnityAgents
    ? path.join(combatUnityProjectRoot(context), 'AGENTS.md')
    : expectedLegacyModuleProtocolCodecPath(context);
  return sameResolvedPath(requestedPath, expectedPath)
    ? null
    : `战斗任务的权威客户端文件必须使用 Host 从当前 workingDir 解析的绝对路径 ${expectedPath}；不得缩短、猜测或改写目录。`;
}

function isKnownUnityAgentsRead(context: HostToolExecutionContext): boolean {
  const payload = exactPowerShellReadPayload(
    context.action.kind === 'exec' ? context.action.command : '',
  );
  if (isKnownAgentsFileEnumeration(payload)) return false;
  const requestedPath = exactPowerShellReadPath(payload);
  return Boolean(
    requestedPath &&
    sameResolvedPath(requestedPath, path.join(combatUnityProjectRoot(context), 'AGENTS.md')),
  );
}

function isKnownLegacyModuleProtocolCodecRead(context: HostToolExecutionContext): boolean {
  const requestedPath = exactPowerShellReadPath(
    context.action.kind === 'exec' ? context.action.command : '',
  );
  return Boolean(
    requestedPath &&
    sameResolvedPath(requestedPath, expectedLegacyModuleProtocolCodecPath(context)),
  );
}

function isCodexCodeModeContainer(command: string): boolean {
  const normalized = command.trim();
  return (
    /^(?:const|let)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*await\s+tools\.[A-Za-z0-9_]+\s*\(/.test(
      normalized,
    ) && /\btext\s*\(/.test(normalized)
  );
}

/**
 * Synchronous Codex exec guard. Native command approval and item-start events
 * cannot await the broader MCP policy, so this keeps combat Shell constrained
 * to the same target and evidence boundaries without changing other roles.
 */
export function evaluateCombatShellCommandExecution(
  context: HostToolExecutionContext,
): HostToolExecutionDecision {
  if (context.action.kind !== 'exec' || !isCombatToolPolicyActive(context)) {
    return { behavior: 'allow' };
  }
  if (isCombatServerWorkerPolicyActive(context)) {
    return isStrictCombatServerReadOnlyExec(context.action.command)
      ? { behavior: 'allow' }
      : deny(
          '战斗开发服务器 Worker 的 Shell 只允许单条 git show、git grep、git status 或 git diff 只读命令；禁止 rg、管道、重定向、命令串联和脚本写入。请缩小到当前原子能力的直接消费者。',
        );
  }

  const options = combatOptions(context.vendorOptions);
  const targetReason = combatSkillTargetReason(context);
  if (targetReason) return deny(targetReason);
  // D2：未结清的模块写对账义务同样拦 Shell。回读走的是 Unity MCP 通道，所以这里**没有**豁免口子
  // —— 少了这一处，模型只要改用 Shell 就能绕开「先回读再继续」。
  const reconciliationReason = combatModuleWriteReconciliationReason(context);
  if (reconciliationReason) return deny(reconciliationReason);
  if (context.remoteHostId) {
    return deny('战斗开发主任务必须运行在本机 SAGA2 P4/Unity 工作区；服务器访问请使用 MCPRouter。');
  }
  // Codex Code Mode is surfaced as a commandExecution item even though this
  // JavaScript only orchestrates brokered tools. Each nested tool call reaches
  // this policy again with its real command/input, so do not classify the
  // container source itself as an operating-system shell command.
  if (isCodexCodeModeContainer(context.action.command)) return { behavior: 'allow' };
  if (isForbiddenCombatClientEvidence(context.action.command)) {
    return deny(
      '战斗配置流程完全不使用新模块编辑器相关实现或共享 skill_entry_model_editor.json。请只读取老版模块协议与当前技能的直接运行时消费者。',
    );
  }
  if (
    !hasCompletedCombatTargetExport(context) &&
    !hasAttemptedCombatTargetExport(context) &&
    !isCombatSkillEntrypointRead(context) &&
    // Host 注入的两条项目参考路径（域事实正本）必须先可读；表范围请求允许有界的只读
    // 范围解析。两者都不放行写入。
    !isAllowedCombatProjectRefSingleRead(context) &&
    !isCombatScopeResolutionRead(context)
  ) {
    return deny(
      `第一条项目内容证据必须是老版模块编辑器对目标技能 ${combatTargetLabel(options)} 的 legacy_module_export_json 结构化回执。导出前 Shell 只能读取已注入的总控 Skill 和项目参考路径。`,
    );
  }
  if (isBroadCombatDesignExplorationCommand(context)) {
    return deny(
      '战斗开发禁止批量或全文读取 saga2_design。请只针对当前未决业务规则做一次定向检索。',
    );
  }
  if (isBroadCombatSkillExplorationCommand(context)) {
    return deny('战斗开发禁止枚举或读取其它 Agent Skill；请使用已注入的总控 Skill。');
  }
  if (
    isBroadCombatWorkspaceEnumeration(context.action.command) ||
    isBroadCombatClientSearch(context.action.command)
  ) {
    return deny(
      '战斗开发禁止枚举或搜索整个客户端资产目录。请读取已知协议文件，或把检索限定到一个直接消费者目录。',
    );
  }
  if (isDisallowedCombatAgentsRead(context.action.command)) {
    return deny(
      '战斗任务路径和根规则已由 Host 注入；禁止枚举或读取工作区根 AGENTS.md。目标导出后只允许读取已知的 saga2_unity/AGENTS.md。',
    );
  }
  const authoritativeReadPathReason = authoritativeCombatReadPathReason(context);
  if (authoritativeReadPathReason) return deny(authoritativeReadPathReason);
  if (isKnownUnityAgentsRead(context)) return { behavior: 'allow' };
  if (isKnownLegacyModuleProtocolCodecRead(context)) {
    return { behavior: 'allow' };
  }
  // 白名单参考路径的单文件只读与表范围只读解析：不依赖通用只读分类器，确定性放行。
  if (isAllowedCombatProjectRefSingleRead(context) || isCombatScopeResolutionRead(context)) {
    return { behavior: 'allow' };
  }
  if (isTargetedCombatClientPowerShellRead(context)) {
    return { behavior: 'allow' };
  }
  if (
    isCombatReadOnlyExec(
      context.action.command,
      context.workingDir,
      context.action.cwd,
      context.action.cwdUnknown,
    )
  ) {
    return { behavior: 'allow' };
  }
  return deny(
    '战斗开发的 Shell 只用于单条、可证明只读且范围明确的客户端证据查询。配置写入必须走 Meka P4、Meka Unity 官方 CLI 和老版模块编辑器入口。',
  );
}

function combatDiscoveryMcpReason(context: HostToolExecutionContext): string | null {
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (!target) return null;
  if (target.server === 'cindy_orca' && target.tool === 'get_workspace_info') {
    return '战斗任务的 projectRoot 与 unityClientRoot 已由 Host 注入；禁止调用 get_workspace_info。请直接使用注入路径。';
  }
  if (target.server === 'cindy' && (target.tool === 'ghost_info' || target.tool === 'ghost_list')) {
    return '战斗任务所需的 Meka Unity 与 Meka P4 已由角色配置直接暴露；禁止调用 ghost_info 或 ghost_list 重新发现插件。请直接调用目标工具。';
  }
  if (target.server === 'cindy' && target.tool === 'ghost_call') {
    const args = mcpToolArguments(context.input);
    if (text(args.tool) === 'list_tools') {
      return 'Meka Unity 和 Meka P4 没有战斗流程可用的动态 list_tools 入口。请直接按总控 Skill 调用 unity_inspect、unity_execute 或目标 P4 工具，不得重试工具发现。';
    }
  }
  if (target.tool === 'list_tools') {
    return '战斗任务禁止调用 list_tools 枚举能力。所需 Unity、P4、MCPRouter 和 Orca 接口已经直接暴露；请按总控 Skill 的固定证据顺序调用。';
  }
  return null;
}

function isRedundantCombatEnvironmentCheck(
  context: HostToolExecutionContext,
  options: CombatVendorOptions,
): boolean {
  if (!isCombatEnvironmentCheck(context)) return false;
  return (
    options.mekaCombatEnvironmentReady === true &&
    text(options.mekaCombatPhase) !== 'environment-recovery' &&
    text(options.mekaCombatServerCapabilityStatus) !== 'retry-required'
  );
}

function isTargetLegacyModuleExport(context: HostToolExecutionContext): boolean {
  const call = legacyModuleJsonCommand(context);
  if (!call || !/^legacy_module_export_json$/i.test(call.command)) return false;
  const options = combatOptions(context.vendorOptions);
  const target = text(options.mekaCombatTargetSkillId);
  if (target && explicitCombatSkillIds(context).includes(target)) return true;
  // 表范围已确认：允许逐个已确认目标各记一次导出证据（每次调用只允许一个 ID）。
  // 未确认时 `approvedCombatScopeSkillIds` 恒为空且不走下面的分支 ⇒ 不放行任何目标。
  // 严格分支的成员集来自 `recordCombatScopeSkillIds`（Agent 自己带 `skill_ids` 的只读范围
  // 查询），因此真实会话里这条分支是可达到的，不是死代码（A4）。
  if (isApprovedCombatTableScopeWithoutList(options)) {
    return explicitCombatSkillIds(context).length === 1;
  }
  const scopeIds = approvedCombatScopeSkillIds(options);
  if (scopeIds.length === 0) return false;
  const explicitIds = explicitCombatSkillIds(context);
  return explicitIds.length === 1 && scopeIds.includes(explicitIds[0]!);
}

/**
 * Record target export evidence only after the transport has returned a
 * successful structured result. Preflight authorization is not evidence that
 * Unity actually exported the requested skill.
 */
export function markCombatTargetExportCompleted(context: HostToolExecutionContext): void {
  if (!isCombatWorkflowPolicyActive(context) || !isTargetLegacyModuleExport(context)) return;
  const options = combatOptions(context.vendorOptions);
  const target = text(options.mekaCombatTargetSkillId);
  // 表范围没有单值目标：只记「本次导出已完成」，不往单值证据表里写空键。
  if (target) refreshCombatTargetBinding(context.sessionId, target);
  options.mekaCombatTargetExportCompleted = true;
  if (target) completedTargetExportBySession.set(context.sessionId, target);
}

/** Record that the target export reached the Unity bridge, even when Unity
 * returned a structured failure (for example, no Pipeline instance). This
 * lets the lead preserve the failure evidence and continue independent
 * server-only review without treating the failed export as success. */
export function markCombatTargetExportAttempted(context: HostToolExecutionContext): void {
  if (!isCombatWorkflowPolicyActive(context) || !isTargetLegacyModuleExport(context)) return;
  const options = combatOptions(context.vendorOptions);
  const target = text(options.mekaCombatTargetSkillId);
  if (target) refreshCombatTargetBinding(context.sessionId, target);
  options.mekaCombatTargetExportAttempted = true;
  if (target) attemptedTargetExportBySession.set(context.sessionId, target);
}

function isUnityStatusInspection(context: HostToolExecutionContext): boolean {
  if (context.action.kind !== 'mcp') return false;
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server === 'meka-unity' && target.tool === 'unity_inspect') {
    return text(mcpToolArguments(context.input).action) === 'status';
  }
  if (target?.server === 'cindy' && target.tool === 'ghost_call') {
    const call = ghostUnityCall(context.input);
    return call?.tool === 'unity_inspect' && text(call.args.action) === 'status';
  }
  return false;
}

function unityStatusProjectPathReason(context: HostToolExecutionContext): string | null {
  if (!isUnityStatusInspection(context)) return null;
  const target = effectiveMcpTarget(context.toolName, context.input);
  const args =
    target?.server === 'cindy' && target.tool === 'ghost_call'
      ? ghostUnityCall(context.input)?.args
      : mcpToolArguments(context.input);
  const expectedProjectPath = combatUnityProjectRoot(context);
  const requestedProjectPath = text(args?.projectPath);
  return requestedProjectPath &&
    path.resolve(requestedProjectPath) === path.resolve(expectedProjectPath)
    ? null
    : `unity_inspect(action=status) 必须显式使用 Host 注入的 Unity 工程路径 ${expectedProjectPath}，避免连接到其它常驻 Unity 实例。`;
}

function isCombatSkillEntrypointRead(context: HostToolExecutionContext): boolean {
  if (context.action.kind === 'read') {
    const normalized = (context.action.path ?? '').replace(/\\/g, '/').toLowerCase();
    return normalized.endsWith('/combat-skill-configuration/skill.md');
  }
  return (
    context.action.kind === 'exec' &&
    (isReadOnlySkillSnapshotDirectRead(context.action.command) ||
      isReadOnlySkillSnapshotProbe(context.action.command))
  );
}

function combatServerDispatchRequest(context: HostToolExecutionContext): {
  kind: 'create_worker' | 'send_to_worker';
  task: string;
  requestedWorkerRef?: string;
  remoteHostId?: string;
  workerAgent?: 'claude-code' | 'codex';
} | null {
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (
    target?.server !== 'cindy_orca' ||
    (target.tool !== 'create_worker' && target.tool !== 'send_to_worker')
  ) {
    return null;
  }
  const args = mcpToolArguments(context.input);
  const task = text(args.initial_task) || text(args.message) || text(args.task);
  const remoteHostId = text(args.remote_host_id);
  const requestedWorkerAgent = text(args.agent);
  if (
    target.tool === 'create_worker' &&
    requestedWorkerAgent !== 'claude-code' &&
    requestedWorkerAgent !== 'codex'
  ) {
    return null;
  }
  const workerAgent =
    requestedWorkerAgent === 'claude-code' || requestedWorkerAgent === 'codex'
      ? requestedWorkerAgent
      : undefined;
  // 授权门:只有 MCPRouter(`mcpr:`)远端目标才可能是本通路的服务器只读 Worker。
  // `remoteHostId` 来自 `text()`(恒为 string, 空值是 `''`), 分类器对空值返回
  // 'local', 因此 `!== 'mcpr'` 与旧的前缀判定逐分支等价, 判定不变;
  // 畸形的 `mcpr:` 仍留在 MCPRouter 错误路径, 不会降级成 SSH host。
  if (
    !isModuleFirstCombatServerExplorationTask(task) ||
    (target.tool === 'create_worker'
      && classifyRemoteSessionTransport(remoteHostId) !== 'mcpr')
  ) {
    return null;
  }
  return {
    kind: target.tool,
    task,
    ...(target.tool === 'create_worker'
      ? { remoteHostId, workerAgent }
      : { requestedWorkerRef: text(args.target_session_id) }),
  };
}

function looksLikeCombatServer(instance: MekaRouterInstance): boolean {
  return /server|服务器|saga2[-_ ]?server/i.test(
    `${instance.projectName} ${instance.projectDescription ?? ''}`,
  );
}

async function authorizeCombatServerDispatch(
  context: HostToolExecutionContext,
  dispatch: NonNullable<ReturnType<typeof combatServerDispatchRequest>>,
): Promise<string | null> {
  const remoteHostId =
    dispatch.kind === 'create_worker'
      ? dispatch.remoteHostId
      : getTrustedCombatServerWorkerRemoteHost(context.sessionId, dispatch.requestedWorkerRef);
  const instanceId = parseMcprRemoteHostId(remoteHostId);
  if (!instanceId) return null;

  const router = getMekaRouterService();
  const [bindings, instances] = await Promise.all([
    router.listProjectBindings('saga2'),
    router.listInstances(),
  ]);
  const instance = instances.find((candidate) => candidate.id === instanceId);
  if (!bindings.includes(instanceId) || !instance?.available || !looksLikeCombatServer(instance)) {
    return null;
  }
  if (dispatch.kind === 'create_worker') {
    const expectedRemoteHostId = text(context.vendorOptions.mekaCombatServerRemoteHostId);
    const expectedWorkerAgent = text(context.vendorOptions.mekaCombatServerWorkerAgent);
    const actualWorkerAgent = instance.agentType === 'claude' ? 'claude-code' : instance.agentType;
    if (
      remoteHostId !== expectedRemoteHostId ||
      dispatch.workerAgent !== expectedWorkerAgent ||
      dispatch.workerAgent !== actualWorkerAgent
    ) {
      return null;
    }
  }
  if (instance.agentType === 'claude') await probeRemoteClaudeCapability(instanceId);
  else if (instance.agentType === 'codex') await probeRemoteCodexCapability(instanceId);
  else return null;
  return remoteHostId ?? null;
}

async function beginAuthorizedCombatServerDispatch(
  context: HostToolExecutionContext,
  dispatch: NonNullable<ReturnType<typeof combatServerDispatchRequest>>,
): Promise<boolean> {
  const remoteHostId = await authorizeCombatServerDispatch(context, dispatch);
  if (!remoteHostId) return false;
  return beginCombatServerCapabilityDispatch({
    leadSessionId: context.sessionId,
    vendorOptions: context.vendorOptions,
    ...dispatch,
    remoteHostId,
  });
}

function isUnscopedServerExplorationRequest(context: HostToolExecutionContext): boolean {
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (
    target?.server !== 'cindy_orca' ||
    (target.tool !== 'create_worker' && target.tool !== 'send_to_worker')
  ) {
    return false;
  }
  const args = mcpToolArguments(context.input);
  const task = text(args.initial_task) || text(args.message) || text(args.task);
  return isCombatServerExplorationTask(task) && !isModuleFirstCombatServerExplorationTask(task);
}

function orcaExplorationInfrastructure(context: HostToolExecutionContext): boolean {
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server !== 'cindy_orca') return false;
  return (
    /^(?:get_|list_|start_team$)/i.test(target.tool) ||
    combatServerDispatchRequest(context) !== null
  );
}

function isServerCapabilityReportValidation(context: HostToolExecutionContext): boolean {
  if (context.action.kind !== 'mcp') return false;
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server !== 'mcp_router') return false;
  if (target.tool === 'validate_server_capability_report') return true;
  return (
    target.tool === 'call_tool' &&
    progressiveInnerCall(context.input)?.name === 'validate_server_capability_report'
  );
}

function isCombatEnvironmentCheck(context: HostToolExecutionContext): boolean {
  if (context.action.kind !== 'mcp') return false;
  const target = effectiveMcpTarget(context.toolName, context.input);
  if (target?.server !== 'mcp_router') return false;
  if (target.tool === 'check_combat_environment') return true;
  return (
    target.tool === 'call_tool' &&
    progressiveInnerCall(context.input)?.name === 'check_combat_environment'
  );
}

function isBatchedWorkerCreation(context: HostToolExecutionContext): boolean {
  const target = effectiveMcpTarget(context.toolName, context.input);
  return target?.server === 'cindy_orca' && target.tool === 'create_workers';
}

async function refreshEnvironment(
  options: CombatVendorOptions,
  updateLocalState = true,
): Promise<CombatEnvironmentGateResult> {
  const router = getMekaRouterService();
  const gate = await runCombatEnvironmentGate({
    p4: await getMekaP4SettingsService().get(),
    listInstances: () => router.listInstances(),
    listProjectBindings: (projectId) => router.listProjectBindings(projectId),
    probeRemoteCodexCapability,
    projectId: 'saga2',
  });
  if (updateLocalState) {
    options.mekaCombatEnvironmentReady = gate.ready;
    options.mekaCombatEnvironmentChecks = combatEnvironmentAvailability(gate);
    options.mekaCombatPhase = gate.ready ? 'execution' : 'environment-recovery';
  }
  return gate;
}

function deny(reason: string): HostToolExecutionDecision {
  return { behavior: 'deny', reason };
}

export async function evaluateCombatToolExecution(
  context: HostToolExecutionContext,
): Promise<HostToolExecutionDecision> {
  if (!isCombatToolPolicyActive(context)) return { behavior: 'allow' };
  const options = combatOptions(context.vendorOptions);
  if (isCombatServerWorkerPolicyActive(context)) {
    if (context.action.kind === 'session-state') {
      return { behavior: 'allow' };
    }
    if (context.action.kind === 'read') {
      return deny(
        '战斗开发服务器 Worker 只能通过单条 git show、git grep、git status 或 git diff 查询当前 HEAD；禁止 Read/文件读取工具，包括读取 Claude 自动保存的超长工具输出。请缩窄 git grep 后直接读取其返回的真实路径。',
      );
    }
    if (context.action.kind === 'exec') {
      if (isStrictCombatServerReadOnlyExec(context.action.command)) {
        return { behavior: 'allow' };
      }
    }
    return deny(
      '战斗开发服务器 Worker 永久只读，仅允许单条 git show、git grep、git status 或 git diff 查询。终态报告必须作为本轮唯一最终回复，由 Orca auto-bridge 回传；禁止 Read、orca_worker_bridge 和其它 MCP，禁止修改文件、创建分支、改 Excel或生成文件。',
    );
  }
  if (context.action.kind !== 'session-state') {
    const targetReason = combatSkillTargetReason(context);
    if (targetReason) return deny(targetReason);
    const jsonPathReason = legacyModuleJsonPathReason(context);
    if (jsonPathReason) return deny(jsonPathReason);
    // D2：未结清的模块写对账义务优先于后续一切放行。放在目标/路径门禁之后，于是「范围外 ID」
    // 仍然报范围理由，而「对账未结清」的调用拿到的是带节点数与动作的具体指令。
    const reconciliationReason = combatModuleWriteReconciliationReason(context);
    if (reconciliationReason) return deny(reconciliationReason);
  }
  if (context.remoteHostId) {
    return deny('战斗开发主任务必须运行在本机 SAGA2 P4/Unity 工作区；服务器访问请使用 MCPRouter。');
  }

  if (isPlanningMutation(context)) {
    return deny(
      '当前任务暂不允许修改 saga2_design/planning。该目录仅作为只读需求来源；请把需要调整的内容记录到 Cindy 审查文档，实施面限定在 saga2_unity、Cindy 或 Cindy 插件。',
    );
  }

  // Startup recovery is owned by the Meka Unity plugin. Its tool contract
  // requires the Agent to obtain explicit user agreement before calling open.
  if (isUnityOpenRequest(context)) return { behavior: 'allow' };

  if (context.action.kind === 'session-state') {
    return { behavior: 'allow' };
  }
  if (context.action.kind === 'mcp') {
    const discoveryReason = combatDiscoveryMcpReason(context);
    if (discoveryReason) return deny(discoveryReason);
    if (isRedundantCombatEnvironmentCheck(context, options)) {
      return deny(
        'Host 启动门禁已确认当前 P4、Unity CLI 与 MCPRouter 环境 ready；禁止立即重复调用 check_combat_environment。只有真实传输失败进入 environment-recovery，或服务器 Worker 标记 retry-required 后才复检。',
      );
    }
    if (
      isEnvironmentRecoveryMcp(context) &&
      (options.mekaCombatEnvironmentReady !== true ||
        text(options.mekaCombatPhase) === 'environment-recovery' ||
        text(options.mekaCombatServerCapabilityStatus) === 'retry-required')
    ) {
      return { behavior: 'allow' };
    }
  }
  if (
    context.action.kind === 'exec' &&
    isEnvironmentDiagnosticCommand(context.action.command) &&
    (options.mekaCombatEnvironmentReady !== true ||
      text(options.mekaCombatPhase) === 'environment-recovery')
  ) {
    return { behavior: 'allow' };
  }
  const requestedEvidence =
    context.action.kind === 'read'
      ? context.action.path
      : context.action.kind === 'exec'
        ? context.action.command
        : context.action.kind === 'file-write'
          ? context.action.path
          : undefined;
  if (isForbiddenCombatClientEvidence(requestedEvidence)) {
    return deny(
      '战斗配置流程完全不使用 ModuleV2 或共享 skill_entry_model_editor.json。请只通过老版模块编辑器对当前技能执行 legacy_module_export_json / legacy_module_import_json，并读取最窄的运行时消费者。',
    );
  }
  const statusProjectPathReason = unityStatusProjectPathReason(context);
  if (statusProjectPathReason) return deny(statusProjectPathReason);
  const targetExport = isTargetLegacyModuleExport(context);
  if (
    !hasCompletedCombatTargetExport(context) &&
    !hasAttemptedCombatTargetExport(context) &&
    !targetExport &&
    !isUnityStatusInspection(context) &&
    !isCombatSkillEntrypointRead(context) &&
    // 与 Shell 变体一致：Host 注入的项目参考路径先可读；表范围请求允许有界的只读范围
    // 解析（含白名单只读 Unity 查询）。写操作仍然被本门禁拦住（这些谓词都只匹配单文件
    // 只读或只读查询形态）。
    !isAllowedCombatProjectRefSingleRead(context) &&
    !isCombatScopeResolutionRead(context) &&
    !isCombatScopeResolutionUnityQuery(context)
  ) {
    return deny(
      `第一条项目内容证据必须是老版模块编辑器对目标技能 ${combatTargetLabel(options)} 的 legacy_module_export_json 结构化回执。导出尝试前只允许读取已注入的总控 Skill、项目参考路径和调用 unity_inspect(action=status)；不得读取 AGENTS、客户端源码、资产目录、参考技能或服务器。`,
    );
  }
  // D3：模块编辑器命令面白名单。放在首证据门禁之后，避免改变既有拒绝理由的优先级
  // （未登记的批量写命令在「还没导出证据」时仍然先报首证据）。
  const legacyModuleWriteReason = legacyModuleWriteCommandReason(context);
  if (legacyModuleWriteReason) return deny(legacyModuleWriteReason);
  const dependency = combatToolDependency(context);
  const dependencyReason = dependency ? blockedDependencyReason(options, dependency) : null;
  if (dependencyReason) return deny(dependencyReason);
  const serverCapabilityStatus = text(options.mekaCombatServerCapabilityStatus);
  if (
    serverCapabilityStatus === 'dispatching' ||
    serverCapabilityStatus === 'pending' ||
    serverCapabilityStatus === 'report-ready' ||
    serverCapabilityStatus === 'retry-required'
  ) {
    if (isCombatEnvironmentCheck(context)) return { behavior: 'allow' };
    if (
      serverCapabilityStatus === 'report-ready' &&
      isServerCapabilityReportValidation(context) &&
      hasTrustedCombatServerCapabilityReport(context.sessionId)
    ) {
      return { behavior: 'allow' };
    }
    if (serverCapabilityStatus === 'retry-required') {
      const retry = combatServerDispatchRequest(context);
      if (retry) {
        try {
          if (await beginAuthorizedCombatServerDispatch(context, retry)) {
            return { behavior: 'allow' };
          }
        } catch {
          options.mekaCombatEnvironmentReady = false;
          resetCombatServerCapabilityFlow({
            leadSessionId: context.sessionId,
            vendorOptions: context.vendorOptions,
            phase: 'environment-recovery',
          });
          return deny('MCPR 目标能力复检失败，已回到环境恢复阶段；请重新检查三条环境链路。');
        }
      }
    }
    return deny(
      serverCapabilityStatus === 'report-ready'
        ? 'Host 已收到服务器 Worker 的 auto-bridge 终态报告。只能原样调用 validate_server_capability_report；不得改写或代写报告。'
        : serverCapabilityStatus === 'retry-required'
          ? '服务器 Worker 派发或报告回传未完成。请重新调用 check_combat_environment；环境 ready 后重新派发带只读标记的 MCPR Worker，不得绕过服务器核查继续实施。'
          : '服务器只读 Worker 正在派发或运行。立即结束当前回合并等待 Orca auto-bridge 自动回传；等待期间禁止继续探索或主动轮询。若 MCPR 断开，可直接调用 check_combat_environment 回到环境恢复。',
    );
  }
  if (context.action.kind === 'mcp' && isBatchedWorkerCreation(context)) {
    return deny(
      'SAGA2 服务器能力核查必须使用单个带只读标记的 MCPR create_worker 或已有 Worker 的 send_to_worker；禁止用 create_workers 绕过 Host 可信回执状态。',
    );
  }
  if (context.action.kind === 'mcp' && isUnscopedServerExplorationRequest(context)) {
    return deny(
      `服务器能力核查必须先完成 ${COMBAT_MODULE_FIRST_MARKER} 模块优先取证：记录当前目标技能的老版导出回执（现有模块图或明确不存在）、协议字段和原子能力矩阵，并只把剩余服务器语义作为核查问题；不得读取其它技能或用“没有完整专用函数”替代模块组合判断。`,
    );
  }
  if (context.action.kind === 'read') {
    if (isBroadCombatDesignReadPath(context, context.action.path)) {
      return deny(
        '战斗开发禁止读取 saga2_design 治理长文档或整份策划 Skill。请只读取当前业务缺口对应的具体语义文件；证据不足时停止探索并交付业务结论。',
      );
    }
    if (isUnrelatedCombatSkillReadPath(context, context.action.path)) {
      return deny(
        '战斗开发禁止读取其它 Agent Skill。已注入的 combat-skill-configuration 是唯一总控 Skill；请直接导出目标技能并读取当前配置、客户端消费者或服务器窄语义。',
      );
    }
    return { behavior: 'allow' };
  }
  if (context.action.kind === 'exec') {
    if (isBroadCombatDesignExplorationCommand(context)) {
      return deny(
        '战斗开发禁止批量或全文读取 saga2_design。请只针对当前未决业务规则做一次定向检索；证据不足时停止探索并按可实现、无法保证、待确认业务选择交付。',
      );
    }
    if (isBroadCombatSkillExplorationCommand(context)) {
      return deny(
        '战斗开发禁止递归枚举项目 Skill 或读取外部 Skill 文档。请使用已注入的战斗 Skill 并只读取 Host 注入的项目参考路径。',
      );
    }
    if (isBroadCombatWorkspaceEnumeration(context.action.command)) {
      return deny(
        '战斗开发禁止枚举整个客户端或配置仓库。请针对当前技能的文件、字段或消费者做精确检索，证据不足时直接交付业务结论。',
      );
    }
    if (isBroadCombatClientSearch(context.action.command)) {
      return deny(
        '战斗开发禁止搜索整个客户端资产目录或编辑器实现目录。请读取已知的老版协议文件，或把检索限定到一个直接运行时消费者目录。',
      );
    }
    if (isDisallowedCombatAgentsRead(context.action.command)) {
      return deny(
        '战斗任务的路径和根规则已经由 Host 注入。禁止枚举或读取工作区根 AGENTS.md；目标技能导出后只读取已知的 saga2_unity/AGENTS.md。',
      );
    }
    if (isAllowedCombatProjectRefSingleRead(context) || isCombatScopeResolutionRead(context)) {
      return { behavior: 'allow' };
    }
    if (
      isCombatReadOnlyExec(
        context.action.command,
        context.workingDir,
        context.action.cwd,
        context.action.cwdUnknown,
      ) ||
      isTargetedCombatClientPowerShellRead(context)
    )
      return { behavior: 'allow' };
  }
  if (context.action.kind === 'mcp') {
    try {
      if (await isReadOnlyMcpCall(context)) {
        return { behavior: 'allow' };
      }
    } catch {
      options.mekaCombatEnvironmentReady = false;
      resetCombatServerCapabilityFlow({
        leadSessionId: context.sessionId,
        vendorOptions: context.vendorOptions,
        phase: 'environment-recovery',
      });
      return deny('MCPRouter 只读探查失败，已回到环境恢复阶段；请重新检查 P4、Unity CLI 和 MCPR。');
    }
    const target = effectiveMcpTarget(context.toolName, context.input);
    if (target?.server === 'mcp_router') {
      return deny(
        '战斗开发中的 MCPRouter 只允许环境恢复和只读查询；服务器修改、服务管理或其它有副作用的 Router 调用必须停止并交给服务器程序。',
      );
    }
    if (target?.server === 'cindy_orca') {
      const dispatch = combatServerDispatchRequest(context);
      if (dispatch) {
        try {
          if (await beginAuthorizedCombatServerDispatch(context, dispatch)) {
            return { behavior: 'allow' };
          }
        } catch {
          options.mekaCombatEnvironmentReady = false;
          resetCombatServerCapabilityFlow({
            leadSessionId: context.sessionId,
            vendorOptions: context.vendorOptions,
            phase: 'environment-recovery',
          });
          return deny('MCPR 目标能力复检失败，已回到环境恢复阶段；请重新检查三条环境链路。');
        }
        return deny(
          '服务器核查 Worker 必须位于当前 SAGA2 已绑定、在线且 capability-ready 的 MCPR 服务器实例；已有 Worker 只有在本任务中经过 Host 验证后才能复用。',
        );
      }
      if (orcaExplorationInfrastructure(context)) return { behavior: 'allow' };
      return deny(
        '战斗开发禁止创建本地 Worker、批量 Worker 或执行未识别的 Orca 变更；服务器核查只能使用 Host 验证的单个只读 MCPR Worker。',
      );
    }
  }
  if (context.action.kind === 'network' && options.mekaCombatEnvironmentReady === true) {
    return { behavior: 'allow' };
  }

  // 表范围解析期的只读范围发现（`unity_inspect(action="command")` + Host 注入白名单命令）：
  // 不要求 supported 回执（表范围没有单值目标可以核查），但仍然在 P4/路径/依赖门禁**之后**、
  // 写路径门禁之内 —— unity_execute、模块导入和老版导出都不在此列。
  // 放行的同时登记 Agent 显式查询过的 `skill_ids`（A4）：这些 ID 就是用户随后确认的成员集，
  // 批准后的成员资格比对因此非空可用。
  if (isCombatScopeResolutionUnityQuery(context)) {
    recordCombatScopeSkillIds(context);
    return { behavior: 'allow' };
  }

  // 证据依据条件触发：已批准的表范围且本次语义由注入的项目权威参考覆盖时，写入不要求
  // 服务器 supported 回执（参考未覆盖或冲突时，范围段要求 Agent 改走只读 Worker 回执，届时
  // 会话会出现 unsupported/uncertain，下面的检查仍然拦住实施）。
  // 未注入参考、目标未确认（单技能）/范围未批准（表范围），以及显式 server-report 依据，
  // 一律仍需服务器 supported 回执。
  const projectReferenceBasis = combatEvidenceBasisIsProjectReference(context);
  if (serverCapabilityStatus !== 'supported' && !projectReferenceBasis) {
    return deny(
      '当前技能尚未取得 Host 验证的服务器 supported 回执，只允许当前技能导出、客户端只读取证、环境恢复和只读 MCPR Worker 派发。完成 auto-bridge 回传并调用 validate_server_capability_report 前，禁止 P4 写入、资产创建、老版模块导入及其它实施操作；历史结论或本地代码不能替代当前远端 HEAD。',
    );
  }

  if (
    options.mekaCombatServerCapabilityStatus === 'unsupported' ||
    options.mekaCombatServerCapabilityStatus === 'uncertain'
  ) {
    return deny(
      '当前操作依赖的服务器能力尚不支持或证据不确定，因此只阻止本次实施调用。请按服务器能力报告完成程序交接或补齐证据；不涉及该缺口的探索和方案工作仍可继续。',
    );
  }
  if (dependency) {
    await refreshEnvironment(options);
    const refreshedReason = blockedDependencyReason(options, dependency);
    if (refreshedReason) return deny(refreshedReason);
  }
  return { behavior: 'allow' };
}
