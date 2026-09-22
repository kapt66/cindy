/**
 * Meka 注入段的**文本唯一来源**：段落构建器 + 用户消息里的战斗技能 ID 解析。
 *
 * 全部是从 `maker-ipc/mekaRuntimeInjection.ts` **原样搬迁**的纯函数：没有 I/O、不碰 opts、
 * 不读 deps。因此「注入文本逐字节不变」（I1）的评审范围可以只看本文件。
 *
 * 段落之间的分隔统一是 `\n\n`（由 applyPlan 渲染），段内分隔是 `\n`（各构建器 join）。
 * 改动任何一个字符都会破坏 system prompt 前缀稳定性（maker-core-and-agent-behavior.md
 * §3.1/§4），属于必须owner确认的改动。
 */

import os from 'node:os';
import path from 'node:path';

import type { MekaRuntimeConfig } from '../meka-projects/runtimeConfig.js';
import type { MekaSkillSnapshot } from '../meka-projects/skillSnapshot.js';
import type {
  CombatRequestScopeClassification,
  CombatSkillIdParseResult,
  MekaCombatServerWorkerTarget,
} from './mekaInjectionTypes.js';

export function removeCombatStartupGate(prompt: string): string {
  return prompt.replace(
    /## 0\. 环境恢复\n\n任务启动时先读取 `\[SAGA2_COMBAT_ENVIRONMENT_GATE\]`。[\s\S]*?不得换 SSH、本地服务器路径或其它工具绕过。\n\n/i,
    '## 0. 依赖按需处理\n\n仅在实际调用 P4、Meka Unity 官方 CLI 或 MCPRouter 工具时处理对应依赖；单项依赖失败只阻止该次调用，继续其它不相关工作。\n\n',
  );
}

export const COMBAT_SERVER_WORKER_PROMPT = [
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

export const COMBAT_EXECUTION_AUTHORIZATION_PROMPT = [
  '[SAGA2_COMBAT_EXECUTION_AUTHORIZATION]',
  '用户明确要求实施战斗技能或关卡配置时，本轮请求已经包含实施授权。内部完成方案、字段和证据检查后直接执行，不要要求额外的方案审批卡或二次确认。',
  'Host 仍会强制 P4 工作区、服务器只读、范围边界、禁止手改 JSON/.asset，以及只通过 Meka Unity 官方 Unity CLI；依赖故障要修复工具链后继续。',
  '[/SAGA2_COMBAT_EXECUTION_AUTHORIZATION]',
].join('\n');

const COMBAT_CONTROLLER_SKILL_ENTRY = 'skills/combat-skill-configuration/SKILL.md';
export const COMBAT_CONTROLLER_SKILL_MARKER = '[SAGA2_COMBAT_CONTROLLER_SKILL]';

/**
 * 战斗总控 Skill 的注入段。
 *
 * **只注入「冻结正文的绝对路径 + 必须先完整读完它」的指令，不注入正文本身。**
 *
 * 原因：host 注入的这段文本最终会经 pi 的 `--append-system-prompt` 作为**命令行参数**
 * 传给子进程，而命令行有平台硬上限（Windows CreateProcess 32767 字符，上游守卫取
 * 30000 的保守预算）。2026-09-18 的插桩实测（当时的注入段仍整篇内联该正文）：段长
 * 24,027 字符，占该 prompt 的 80.5%、占整个 argv 的 78.8% ⇒ 整篇内联会让 argv 从
 * ~6.5KB 涨到 30,497（预算 30,000），于是战斗角色会话在 Windows 上被上游
 * `assertPiSpawnArgvFitsPlatform` 直接拒绝（报「项目里 Pi skills 太多」，与真实原因无关）。
 * 那组数字只是**当时**的测量值，不是现状：改走文件载体后本段长度与正文无关，正文自身
 * 也已收缩到 16,381 字节 / 8,991 字符，不得再用 24,027 估算今天的 argv。
 * 证据：docs/migrations/2026-09-18-origin-main-to-meka-main.md §7.8.3 / §7.8.6。
 *
 * **语义不变**：正文仍是该任务 revision 级冻结的**唯一权威正文**，落在
 * `snapshot.pluginPath`（该目录已作为 `nativeSkillPluginPath` 交给运行期，因此 Agent
 * 本来就有权读它），只是把「Host 把正文塞进 prompt」换成「Host 给出唯一路径并要求先读
 * 完」——仍然**禁止探索/枚举其它 SKILL.md**，也不允许用记忆或缓存里的旧版正文替代。
 */
export function combatControllerSkillPrompt(snapshot: MekaSkillSnapshot | null): string | null {
  const entry = snapshot?.files.find((file) => file.relativePath === COMBAT_CONTROLLER_SKILL_ENTRY);
  if (!entry) return null;
  const pluginPath = snapshot?.pluginPath;
  if (!pluginPath) return null;
  const frozenSkillPath = path.join(pluginPath, ...COMBAT_CONTROLLER_SKILL_ENTRY.split('/'));
  return [
    COMBAT_CONTROLLER_SKILL_MARKER,
    '当前任务冻结的唯一战斗总控 Skill 正文在下面这个文件里（Host 已按任务 revision 冻结，不要修改它）：',
    frozenSkillPath,
    '执行前必须先把该文件完整读完，再严格按正文执行。不要读取、枚举或发现任何其它 SKILL.md，也不要用记忆、缓存或旧版快照里的正文替代它。',
    '[/SAGA2_COMBAT_CONTROLLER_SKILL]',
  ].join('\n');
}

/**
 * 单技能目标段。**只在用户明确给出技能 ID 时才说实话的那一句。**
 *
 * `mekaCombatTargetSkillIdState` 的生产值只有两种：`confirmed`（用户在消息里明确标注了 ID，
 * 或整条消息只回一个正整数 —— 首轮追问后的标准回复）与 `ambiguous`（多个 ID，需用户收敛到
 * 一个；此时 `mekaCombatTargetSkillId` 为 undefined，本段不注入）。因此生产上本段只走已确认
 * 分支。
 *
 * 未确认分支保留为**遗留状态防线**：老会话或外部写入可能留下一个未被用户确认的候选
 * （`proposed`），文案对它必须保持诚实，不得声称「由用户确认并由 Host 绑定」。当前漏斗**没有**
 * 这种生产者（`classifyCombatRequestScope` 也不返回该状态）；将来新增由上下文推断的候选时，
 * 必须新增 `proposed` 分类并映射成 `proposed`，不得写成 `confirmed`。
 *
 * 表范围请求下 `mekaCombatTargetSkillId` 恒为 undefined（显式置空），因此本段不注入；
 * 由 `combatScopePrompt` 的 `[SAGA2_COMBAT_SCOPE]` 段替代。
 */
export function combatTargetPrompt(vendorOptions: Record<string, unknown>): string | null {
  if (vendorOptions.mekaCombatRequestScope === 'table-scope') return null;
  const target = vendorOptions.mekaCombatTargetSkillId;
  if (typeof target !== 'string' || !/^[1-9]\d*$/.test(target)) return null;
  const userConfirmed = vendorOptions.mekaCombatTargetSkillIdState === 'confirmed';
  return [
    '[SAGA2_COMBAT_TARGET]',
    `targetSkillId: ${target}`,
    userConfirmed
      ? '这是当前任务由用户确认并由 Host 绑定的唯一技能 ID。续聊和 Worker 回传不得清空、替换或重新推断它；最终结果必须原样使用该值。'
      : '这是 Host 从用户消息里解析出的候选技能 ID，**尚未经用户确认**。开始实施前必须先向用户复述该 ID 并取得确认；若它与用户表述的范围不符，停止并按用户的原始表述澄清，不得把它当成已确认的绑定。',
    '[/SAGA2_COMBAT_TARGET]',
  ].join('\n');
}

/**
 * 表范围请求段。与 `[SAGA2_COMBAT_TARGET]` 互斥（同一 order 空档只放一段）。
 *
 * 它必须说清四件事：本轮是表范围、没有唯一技能 ID、范围由声明的源表解析、解析结果经用户
 * 确认前禁止写入。
 */
export function combatScopePrompt(vendorOptions: Record<string, unknown>): string | null {
  if (vendorOptions.mekaCombatRequestScope !== 'table-scope') return null;
  const selection = vendorOptions.mekaCombatScopeSelection;
  const sourceTables = vendorOptions.mekaCombatScopeSourceTables;
  const selectionLine =
    typeof selection === 'string' && selection.trim()
      ? `scopeSelection: ${selection.trim()}`
      : 'scopeSelection: （按用户原始表述确定，Host 未给出更窄的规则）';
  const tables = Array.isArray(sourceTables)
    ? sourceTables.filter(
        (table): table is string => typeof table === 'string' && Boolean(table.trim()),
      )
    : [];
  const queryCommands = Array.isArray(vendorOptions.mekaCombatReadOnlyUnityCommands)
    ? vendorOptions.mekaCombatReadOnlyUnityCommands.filter(
        (command): command is string => typeof command === 'string' && Boolean(command.trim()),
      )
    : [];
  const approved =
    vendorOptions.mekaCombatRequestScopeState === 'confirmed' &&
    vendorOptions.mekaCombatScopeApproved === true;
  // 证据依据：缺省走服务器回执（fail-closed），只有 Host 明确记录 project-reference 才改口径。
  const evidenceBasis =
    vendorOptions.mekaCombatEvidenceBasis === 'project-reference'
      ? 'project-reference'
      : 'server-report';
  return [
    '[SAGA2_COMBAT_SCOPE]',
    'requestScope: table-scope',
    'targetSkillId: none',
    selectionLine,
    tables.length > 0
      ? `scopeSourceTables: ${tables.map((table) => table.trim()).join('；')}`
      : 'scopeSourceTables: （用户原始表述里点名的表；Host 未解析出可读路径）',
    approved
      ? 'scopeApproved: true（用户已确认范围）'
      : 'scopeApproved: false（用户尚未确认范围）',
    '本轮是**表范围**请求：没有唯一技能 ID，Host 已显式清空单技能绑定，不得把范围降维成单个技能执行，也不得自行扩大范围。',
    '范围必须从上面声明的源表（以及 Host 注入的项目参考路径）只读解析得出；解析时只允许读取这些源表、它们列出的技能资产和已注入的项目参考路径，不得枚举目录或读取其它 Skill。',
    queryCommands.length > 0
      ? `范围发现只允许走只读通道：除上述单文件读取外，只可用 \`unity_inspect(action="command")\` 执行这些只读查询：${queryCommands.join('、')}（projectPath 必须使用 Host 注入的 unityClientRoot）。禁止用 unity_execute 或任何写命令做范围发现。`
      : '范围发现只允许单文件只读读取；禁止枚举目录，禁止用任何写命令做范围发现。',
    approved
      ? '范围已获用户确认：按逐目标流程实施，每次调用只处理一个范围内的技能 ID，并在计划与结果里逐项列出；P4 边界、路径白名单与证据要求不变。'
      : '先只读解析出范围内的目标集合（技能 ID 逐项列出）与逐目标的改动集合，把两份清单提交用户确认；**用户确认前禁止任何写入**（P4 写入、老版模块导入、资产创建、临时 JSON 生成）。',
    evidenceBasis === 'project-reference'
      ? 'evidenceBasis: project-reference —— 本轮运行时语义（模块编码规则与老版命令契约）由 Host 注入的项目权威参考覆盖：优先读 `damageEncodingRulePath`（伤害/模块编码）与 `moduleEditorSkillPath`（模块字段、连线与老版导入导出命令契约）。若这两条参考**未覆盖**你要改的语义、或与需求**冲突**，不得自行推断：表范围**没有**可达的服务器核查通道（服务器目标段与路由键只在绑定唯一技能 ID 时注入，`validate_server_capability_report` 也只会比对那个唯一 ID），所以不要派发只读 Worker。必须停止写入、如实向用户说明缺口，并**回落到单技能流程**：请用户把范围收敛到一个具体技能 ID；绑定该 ID 后 Host 会注入服务器目标段与路由键，届时按单技能流程取得只读服务器 supported 回执；依据项目参考时，PLAN/RESULT 必须原样写明依据了哪条注入路径（damageEncodingRulePath / moduleEditorSkillPath）。'
      : 'evidenceBasis: server-report —— 表范围**没有**可达的服务器核查通道（服务器目标段与路由键只在绑定唯一技能 ID 时注入），本轮无法用只读服务器 Worker 取得 supported 回执：不要尝试派发 Worker，也不要声称已取得回执。必须停止写入、如实向用户说明缺口，并**回落到单技能流程**：请用户把范围收敛到一个具体技能 ID；绑定后按单技能流程取得只读服务器 supported 回执，并在 PLAN/RESULT 原样写明 evidenceBasis: server-report 与报告 head。',
    '[/SAGA2_COMBAT_SCOPE]',
  ].join('\n');
}

/** 由 `workingDir` 解析出的 SAGA2 项目根（与 `combatProjectPathsPrompt` 同一套规则）。 */
function resolveCombatProjectRoots(
  workingDir: unknown,
): { projectRoot: string; unityClientRoot: string } | null {
  if (typeof workingDir !== 'string' || !workingDir.trim()) return null;
  const resolvedWorkingDir = path.resolve(workingDir);
  const unityClientRoot =
    path.basename(resolvedWorkingDir).toLowerCase() === 'saga2_unity'
      ? resolvedWorkingDir
      : path.join(resolvedWorkingDir, 'saga2_unity');
  const projectRoot =
    path.basename(resolvedWorkingDir).toLowerCase() === 'saga2_unity'
      ? path.dirname(resolvedWorkingDir)
      : resolvedWorkingDir;
  return { projectRoot, unityClientRoot };
}

/** 两条**项目侧域事实**参考路径（Host 注入、策略白名单、模型不得自行推导）。 */
export interface CombatProjectRefPaths {
  /** 项目技能库里的模块编辑器契约（老版 CLI 形态 + 编码细则 + target 状态表）。 */
  moduleEditorSkillPath: string;
  /** 策划设计库里的伤害/模块编码权威规则（路径含三段 CJK 目录名，不可推导）。 */
  damageEncodingRulePath: string;
}

/**
 * 表范围解析允许的**只读** Unity Pipeline 命令白名单。
 *
 * meka-unity 插件对 `unity_inspect(action="command")` 使用自己的硬编码只读白名单作为
 * 外层保证；这里只放行范围发现真正需要的两条（最小权限），并把清单注入
 * `vendorOptions.mekaCombatReadOnlyUnityCommands`，让策略层不必硬编码命令名。
 * **增删任一命令都要同时核对插件白名单**；写入类命令（`legacy_module_export_json`、
 * `legacy_module_import_json`、`module_v2_*`、`eval`、`run_script`）永远不进这份清单。
 */
export const COMBAT_READ_ONLY_UNITY_PIPELINE_COMMANDS: readonly string[] = [
  'legacy_module_query_nodes',
  'legacy_module_audit_coverage',
];

/**
 * 解析并返回两条项目参考路径。**唯一来源**：`[SAGA2_PROJECT_PATHS]` 的注入文本与
 * `vendorOptions.mekaCombatProjectRefPaths`（策略层白名单）都从这里取值，避免出现第二套
 * 路径方案。返回 null = workingDir 不可用（与 `combatProjectPathsPrompt` 一致）。
 */
export function resolveCombatProjectRefPaths(
  workingDir: unknown,
): CombatProjectRefPaths | null {
  const roots = resolveCombatProjectRoots(workingDir);
  if (!roots) return null;
  return {
    moduleEditorSkillPath: path.join(
      roots.unityClientRoot,
      '.agents',
      'skills',
      'editor-skill-editor-module',
      'SKILL.md',
    ),
    // 目录名逐字来自项目 repo（`04-职能组-functional-groups` / `战斗策划组-combat-planning` /
    // `专业规则-rules`）：只能注入，不能由模型拼接。
    damageEncodingRulePath: path.join(
      roots.projectRoot,
      'saga2_design',
      'planning',
      '04-职能组-functional-groups',
      '战斗策划组-combat-planning',
      '专业规则-rules',
      'ModuleDesignKnowledge.md',
    ),
  };
}

export function combatProjectPathsPrompt(workingDir: unknown): string | null {
  const roots = resolveCombatProjectRoots(workingDir);
  const refPaths = resolveCombatProjectRefPaths(workingDir);
  if (!roots || !refPaths) return null;
  const { projectRoot, unityClientRoot } = roots;
  const { moduleEditorSkillPath, damageEncodingRulePath } = refPaths;
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

export function combatServerTargetPrompt(target: MekaCombatServerWorkerTarget | null): string {
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

export function roleContextPrompt(runtime: MekaRuntimeConfig): string {
  return [
    '[MEKA_ROLE_CONTEXT]',
    `projectId: ${runtime.projectId}`,
    `roleId: ${runtime.roleId}`,
    `displayName: ${runtime.roleDisplayName}`,
    '这是当前任务的权威角色绑定。不得根据打开的窗口、缓存文件或其它项目角色推断或替换当前角色。',
    '[/MEKA_ROLE_CONTEXT]',
  ].join('\n');
}

function normalizePositiveDecimal(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  return raw;
}

/**
 * 用户**明确标注**技能 ID 的既有写法。只有命中这里的 ID 才算「用户标注」，
 * 也才允许产生 `confirmed` 绑定。
 */
const COMBAT_USER_LABELLED_SKILL_ID_PATTERNS: readonly RegExp[] = [
  /技能\s*(?:ID|Id|id|编号)\s*(?:就是|是|为|[:：=])?\s*#?\s*(\d+)\b/g,
  // Chinese UI/task shorthand commonly places the number before the noun:
  // “检查下1009技能”. The adjacent “技能” label keeps ordinary numbers
  // such as damage, duration, and repeat counts out of the target binding.
  // Signed, decimal and digit-adjacent numbers (“-101 技能表参数1”,
  // “+100技能”, “1.5技能”) are data references, not a target, and
  // “技能表/参数/模块” is a table/module context rather than a skill.
  //
  // 数字后紧跟单位/量词是业务数值而不是技能 ID（A9）：“技能2段伤害怎么配”“技能3级时触发”
  // 绑定的都是段数/等级；`\b` 同时挡住 `(\d+)` 回退（否则“技能10段”会回退成 1）。这里用
  // 负向先行先拒绝单位词。
  //
  // D4：本分支（数字在 `技能` **之后**）必须与下面「数字在 `技能` 之前」的分支**对称**。
  // 域事实（`combat-skill-configuration/SKILL.md`、`combat-skill-id-contract.md`）：
  // `moduleType` 数值、节点 ID、技能表参数引用**都不是技能 ID**（取值与含义以注入的项目
  // 参考为准，正文明确不枚举）。因此除单位词外还要拒绝 `表/参数/模块` 与 **模块字段语境**
  // （`data` / 节点 / 伤害行为）。`技能10000的data` 里的 `10000` 是伤害行为的 `moduleType`，
  // 把它绑成 confirmed 单技能目标正是「启发式不得产生 confirmed」这条硬红线唯一的现存违例。
  //
  // 判据只用**上下文名词**，刻意不做的两件事：
  // - 不维护 `moduleType` 取值清单（含 `10000`）：正本在注入的项目参考里，客户端再存一份
  //   会与正本脱钩，且正文明确「不重复枚举」；
  // - 不用**位数**猜（“4 位以上就只给 proposed”）：技能 ID 只要求正整数，5 位技能 ID 合法，
  //   且当前分类器没有 `single-skill` + `proposed` 生产者（要新增必须同时改
  //   `CombatRequestScopeClassification` 与计划层映射，超出本文件职责）。
  //
  // 代价（**fail-closed，已知并接受**）：“技能N的<模块字段>”句式不再绑定 N（例如
  // `技能1019的data` / `技能1019的节点` 都不再产出目标），用户会被重新追问一次 ID。
  // 宁可多问一次，不得错绑：错绑会把唯一的技能 ID 硬绑定到 `moduleType` 上。
  // 刻意保留的一侧：`技能1019的伤害行为10000的data` 里 `的伤害行为` **仍然**绑定 1019 ——
  // 该句式无法与「技能 1019 的伤害行为」区分，后者是合法单技能表述；而 `10000` 跟在
  // `伤害行为` 之后，本来就不被任何分支绑定成技能 ID。
  /技能\s*#?\s*(\d+)\b(?!\s*(?:表|参数|模块|data|节点|伤害行为|[段级次秒个种星层条阶])|\s*的\s*(?:表|参数|模块|data|节点|[段级次秒个种星层条阶]))/g,
  // 数字在 `技能` 之前：左侧的模块/表语境（`伤害行为10000技能`、`参数1技能`、`节点1019技能`、
  // `表1技能`）同样说明这个数字是 `moduleType`／节点／参数引用，不是技能 ID（D4 的对称面）。
  /(?<![-+.\d]|data|节点|伤害行为|参数|模块|表)([1-9]\d*)\s*技能(?!表|参数|模块)/g,
  // 用户在同一句里**逐个点名**两个技能 ID（“技能1019和1020都改成100”“把 1019 和 1020 都改成
  // 取100%攻击力”）⇒ 两个都算用户给出的 ID，落到歧义（要求用户收敛到一个），而不是静默丢掉
  // 一个、更不是把其中一个升成 confirmed（D5）。两侧都要求 ≥3 位：域内技能 ID 观察值都是 4 位，
  // 这个下限把“技能1019，2段伤害”这类「ID + 业务数值」排除在枚举之外。
  /技能\s*#?\s*(\d{3,})\s*(?:和|与|及|跟|、|,|，)\s*#?(\d{3,})\b/g,
  /(?:把|将)[^。；！？\n]{0,8}?(?<![-+.\d])(\d{3,})\s*(?:和|与|及|跟|、|,|，)\s*#?(\d{3,})\s*(?:都|全部|统一|所有)/g,
];

/** 整条消息就是一个裸正整数：可以当候选目标，但**不是**用户标注。 */
const COMBAT_STANDALONE_NUMBER_PATTERN = /^#?\s*([1-9]\d*)\s*[。.!！]?$/;

/**
 * 指代「当前已绑定目标」的限定词 + 技能（`这个技能` / `该技能` / `当前技能` / `本技能` /
 * `此技能`）：这是**单技能上下文**，不得再按表范围分类（A2）。
 *
 * 排除「这个技能表」这类表引用（`(?!表)`）：那里被限定的是表，不是当前目标。
 */
const COMBAT_CURRENT_TARGET_DEMONSTRATIVE_PATTERN = /(?:这个|该|当前|本|此)\s*技能(?!表)/;

/**
 * **表范围**请求的低误报文本特征。要求「范围量词 + 技能集合」或「范围来源显式指向表」，
 * 且必须与「没有用户标注的技能 ID」合取才成立（见 `classifyCombatRequestScope`）。
 *
 * 故意不引入裸「批量」「全部改成」这类词：它们既可能是范围也可能是单技能内的批量节点改动，
 * 单靠它们会把单技能请求误判成表范围。规范例（角色/技能正文里承诺可识别的表述）：
 * 「（怪物/角色…）配置表里配置的正在使用的技能」「表里正在使用的」「某类技能…（统一）改成」。
 * 「把…都改成」**不在**本清单里（D5）：它只作加权项，必须与范围来源标记共现，见
 * `COMBAT_TABLE_SCOPE_BOOSTER_PATTERNS` 与 `COMBAT_TABLE_SCOPE_SOURCE_MARKER_PATTERN`。
 *
 * 量词必须锚在**技能集合或表**上：裸「各模块 / 所有模块」是单技能内部结构（模块属于某个技能），
 * 不构成表范围证据（A2）。
 */
const COMBAT_TABLE_SCOPE_REQUEST_PATTERNS: readonly RegExp[] = [
  /(?:所有|全部|每个|各个|各项|各种|一切|全量|各)(?:的)?[^。；！？\n]{0,8}?(?:怪物)?技能(?!表|参数|模块)/,
  /范围[^。；！？\n]{0,12}?(?:由|按|取决于|来自)[^。；！？\n]{0,12}?(?:表|配置|清单|规则)/,
  /(?:技能|模块)[^。；！？\n]{0,8}?(?:范围|清单)[^。；！？\n]{0,8}?(?:由|按|取决于|来自)[^。；！？\n]{0,8}?(?:表|配置|清单|规则)/,
  // 「（怪物/角色）配置表里配置的正在使用的技能」「表里正在使用的（技能）」。
  /(?:配置表|技能表|表)[里内][^。；！？\n]{0,12}?(?:正在使用|正在配置|在用|使用中|配置的)[^。；！？\n]{0,10}?(?:技能|模块)/,
  // 「某类技能/模块…（统一/都/改成）」。
  /(?:某类|某一种|某一类|这类|该类|各类)[^。；！？\n]{0,8}?(?:技能|模块)[^。；！？\n]{0,14}?(?:统一|全部|都|批量|改成|改为)/,
];

/**
 * 「把/将 … 都（统一）改成」只是**加权项（booster）**，单独出现**不能**证明表范围（D5）。
 *
 * 单技能内部的批量数值改动与表范围的形状完全相同：「把伤害数值都改成0.5」改的是某个技能里的
 * 伤害数值，不是「范围由表决定」。把它当独立检测器会把这轮请求推进「先确认范围」的流程，而
 * 表范围正文又**禁止**向用户追问技能 ID（`combat-skill-id-contract.md`：table-scope 不得回复
 * 「请提供正整数技能 ID」）⇒ 用户会被要求确认一个根本不存在的范围，且两个流程互相踢皮球。
 *
 * 因此它必须与下面的**范围来源标记**共现，才允许当作表范围证据。
 */
const COMBAT_TABLE_SCOPE_BOOSTER_PATTERNS: readonly RegExp[] = [
  /(?:把|将)[^。；！？\n]{0,30}?(?:都|全部|统一|所有)[^。；！？\n]{0,10}?(?:改成|改为|换成|修改成|设成)/,
];

/**
 * booster 必须与之共现的**范围来源标记**（D5）：表 / 清单 / 按类划分的技能集合。
 * 「每类」与 `COMBAT_TABLE_SCOPE_REQUEST_PATTERNS` 里的「某类」同级，同样算来源标记。
 */
const COMBAT_TABLE_SCOPE_SOURCE_MARKER_PATTERN =
  /(?:表|清单|某类|某一种|某一类|每类|这类|该类|各类|范围)/;

/**
 * **无歧义表范围**表述（比 `COMBAT_TABLE_SCOPE_REQUEST_PATTERNS` 更严）：用户显式点名
 * 「表 / 配置表 / 技能表 / 清单」或显式声明「范围由表决定」，或显式说「某类技能」这种
 * 按类划分的范围。
 *
 * 会话**已经有用户确认的单技能绑定**时，只有命中这里才允许让表范围分类覆盖那个绑定
 * （见 `mekaResolvePlan.ts` 的计划层 guard，A2）：把「把…都改成」「所有…模块」这类既可能
 * 落在单技能内部的量词排除在外，避免静默丢掉用户已确认的目标。
 */
const COMBAT_UNAMBIGUOUS_TABLE_SCOPE_PATTERNS: readonly RegExp[] = [
  /范围[^。；！？\n]{0,12}?(?:由|按|取决于|来自)[^。；！？\n]{0,12}?(?:表|配置|清单|规则)/,
  /(?:技能|模块)[^。；！？\n]{0,8}?(?:范围|清单)[^。；！？\n]{0,8}?(?:由|按|取决于|来自)[^。；！？\n]{0,8}?(?:表|配置|清单|规则)/,
  /(?:所有|全部|每个|各个|各项|各种|一切|全量|各)[^。；！？\n]{0,8}?表[^。；！？\n]{0,12}?(?:技能|模块)/,
  /(?:配置表|技能表|表)[里内][^。；！？\n]{0,12}?(?:正在使用|正在配置|在用|使用中|配置的)[^。；！？\n]{0,10}?(?:技能|模块)/,
  /(?:某类|某一种|某一类|这类|该类|各类)[^。；！？\n]{0,8}?(?:技能|模块)[^。；！？\n]{0,14}?(?:统一|全部|都|批量|改成|改为)/,
];

/**
 * 本轮表述是否**无歧义地表范围**（纯函数）。调用方只在「会话已有用户确认的单技能绑定」这一
 * 分支上用它来决定是否允许覆盖该绑定。
 */
export function isUnambiguousCombatTableScopePrompt(prompt: unknown): boolean {
  if (typeof prompt !== 'string' || !prompt.trim()) return false;
  if (COMBAT_CURRENT_TARGET_DEMONSTRATIVE_PATTERN.test(prompt)) return false;
  return COMBAT_UNAMBIGUOUS_TABLE_SCOPE_PATTERNS.some((pattern) => pattern.test(prompt));
}

/** 用户消息里显式点名的 `saga2_json` 表路径（绝对或相对），用作范围解析的声明源表。 */
const COMBAT_SCOPE_SOURCE_TABLE_PATTERN =
  /(?:[A-Za-z]:[\\/])?[^\s"'，。；、（）()]*saga2_json[\\/][^\s"'，。；、（）()]+/g;

interface CombatSkillIdScan {
  /** 命中用户标注写法的 ID。 */
  labelledIds: string[];
  /** 只有裸数字（整条消息）等未标注形态。 */
  unlabelledIds: string[];
}

function scanCombatSkillIds(prompt: string): CombatSkillIdScan {
  const labelled = new Set<string>();
  const unlabelled = new Set<string>();
  const standaloneId = normalizePositiveDecimal(prompt.trim().match(COMBAT_STANDALONE_NUMBER_PATTERN)?.[1]);
  if (standaloneId) unlabelled.add(standaloneId);
  for (const pattern of COMBAT_USER_LABELLED_SKILL_ID_PATTERNS) {
    for (const match of prompt.matchAll(pattern)) {
      // 枚举写法（“技能1019和1020”）一次命中**两个** ID，两个都要登记：少登记一个就等于
      // 静默丢掉用户点名的目标（D5）。
      for (const group of match.slice(1)) {
        const normalized = normalizePositiveDecimal(group);
        if (normalized) labelled.add(normalized);
      }
    }
  }
  return { labelledIds: [...labelled], unlabelledIds: [...unlabelled] };
}

function detectCombatTableScope(
  prompt: string,
): { selection: string | null; sourceTables: string[] } | null {
  // 指代当前目标的限定词（「这个技能的所有模块」）是单技能上下文，不是表范围（A2）。
  if (COMBAT_CURRENT_TARGET_DEMONSTRATIVE_PATTERN.test(prompt)) return null;
  const matched =
    COMBAT_TABLE_SCOPE_REQUEST_PATTERNS.map((pattern) => pattern.exec(prompt)).find(
      (match): match is RegExpExecArray => Boolean(match),
    ) ??
    // D5：「把…都改成」只有在与**范围来源标记**（表/清单/某类技能…）共现时才作为表范围证据。
    // 单独的「把…都改成」是单技能内部的批量改动（「把伤害数值都改成0.5」），不是范围。
    (COMBAT_TABLE_SCOPE_SOURCE_MARKER_PATTERN.test(prompt)
      ? COMBAT_TABLE_SCOPE_BOOSTER_PATTERNS.map((pattern) => pattern.exec(prompt)).find(
          (match): match is RegExpExecArray => Boolean(match),
        )
      : undefined);
  if (!matched) return null;
  const sourceTables = [
    ...new Set(
      [...prompt.matchAll(COMBAT_SCOPE_SOURCE_TABLE_PATTERN)].map((match) => match[0].trim()),
    ),
  ].filter(Boolean);
  return { selection: matched[0].trim() || null, sourceTables };
}

/**
 * 请求范围分类（纯函数）。
 *
 * **硬规则（不可放宽）**：启发式推断**不得**产生 `confirmed` 绑定。
 * - 用户明确给出的技能 ID ⇒ `single-skill` + `confirmed`。明确给出的形态包括三种标注写法，
 *   **以及整条消息只有一个正整数**（`docs/product-rules/meka-skills.md`：首轮缺少 ID 时
 *   Host 零工具追问，用户在追问后只回复一个正整数即视为明确绑定，不要求重复「技能 ID」标签）；
 * - 多个标注 ID ⇒ `single-skill` + `missing`（歧义，仍需用户收敛到一个）；
 * - 表范围特征且**无**用户给出的 ID ⇒ `table-scope` + `proposed`（等用户确认解析出的集合）。
 *
 * `single-skill` + `proposed`（由上下文/范围词/相似配置推断出的候选）**当前没有生产者**，
 * 因此 `CombatRequestScopeClassification` 不再保留该成员（A6）；将来新增时必须补回该成员并
 * 在漏斗里映射成 `mekaCombatTargetSkillIdState: 'proposed'`，不得复用 `confirmed`。
 *
 * 用户明确给出的 ID 优先级最高：消息里出现明确 ID 时，即使同时出现范围词也按单技能处理。
 */
export function classifyCombatRequestScope(
  prompt: unknown,
): CombatRequestScopeClassification | null {
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  const scan = scanCombatSkillIds(prompt);
  if (scan.labelledIds.length === 1) {
    return { scope: 'single-skill', state: 'confirmed', skillId: scan.labelledIds[0]! };
  }
  if (scan.labelledIds.length > 1) {
    return { scope: 'single-skill', state: 'missing', skillIds: scan.labelledIds };
  }
  const tableScope = detectCombatTableScope(prompt);
  if (tableScope) {
    return { scope: 'table-scope', state: 'proposed', ...tableScope };
  }
  if (scan.unlabelledIds.length === 1) {
    // 整条消息只有一个正整数：用户明确给出（追问后的标准回复），不是启发式推断。
    return { scope: 'single-skill', state: 'confirmed', skillId: scan.unlabelledIds[0]! };
  }
  return null;
}

/**
 * 表范围审批确认词（**整条消息只由肯定词与标点组成**才算确认）。
 *
 * 只有把「肯定」这个意图显式写出来（或用户点名「按这个范围」）才算审批；任何带业务内容的
 * 消息都按新指令重新分类。`继续` / `执行` 这类词既可能是「继续做」也可能是「按此执行」，
 * 因此在表范围会话里一律按「确认范围」处理（fail-closed 的反面：不确认就不写）。
 */
const COMBAT_SCOPE_AFFIRMATION_TOKEN =
  /^(?:确认|确定|可以|同意|执行|继续|没问题|好的|好|行|开始|就按这个范围|按这个范围|按此范围|按这个方案|按此方案|就这样|一下|吧|了|ok|okay|yes)+$/i;
const COMBAT_SCOPE_AFFIRMATION_STRONG =
  /(?:确认|确定|可以|同意|执行|继续|没问题|好的|好|行|开始|就按这个范围|按这个范围|按此范围|按这个方案|按此方案|就这样|ok|okay|yes)/i;

export function isCombatScopeAffirmation(prompt: unknown): boolean {
  if (typeof prompt !== 'string') return false;
  const normalized = prompt.trim().replace(/[\s，,。.!！?？~～、；;：:]+/g, '');
  if (!normalized) return false;
  return (
    COMBAT_SCOPE_AFFIRMATION_TOKEN.test(normalized) &&
    COMBAT_SCOPE_AFFIRMATION_STRONG.test(normalized)
  );
}

/**
 * 表范围审批转换（纯函数）：把「用户在表范围提案后回了一句肯定」转成范围确认。
 *
 * - `previousVendorOptions` 已知且不是表范围 ⇒ 不动任何状态（避免把别处的「确认」当成范围审批）；
 * - `previousVendorOptions` 未知（调用方**确实**拿不到会话现状）⇒ 只写
 *   `mekaCombatRequestScopeState` / `mekaCombatScopeApproved` / `mekaCombatEvidenceBasis`。
 *   **这三个键并非「完全惰性」**：`mekaCombatEvidenceBasis` 会被单技能分支读取
 *   （`combatWorkflowPolicy.ts` 的 `combatEvidenceBasisIsProjectReference` 对单技能检查
 *   `mekaCombatTargetSkillIdState === 'confirmed'`）。之所以无害，是因为它被写成
 *   `project-reference`，与单技能已确认目标时 `combatEvidenceBasisPatch` 写的是同一个值；
 *   两个范围键才是真正惰性的（所有范围门禁都以 `mekaCombatRequestScope==='table-scope'` 为前提）。
 *   生产调用方**必须**尽量传入会话现状（见 `mekaResolvePlan.ts` 的会话级 vendorOptions 镜像），
 *   否则一次无关的「可以 / 继续 / OK」会被误当成范围审批（A3）；
 * - 已经确认过 ⇒ 幂等返回 null；
 * - 审批**只影响写入**：只读发现阶段不受它影响（表范围永远没有单值目标，用审批锁只读会死锁）。
 */
export function combatRequestScopeApprovalPatch(input: {
  prompt: unknown;
  previousVendorOptions?: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  if (!isCombatScopeAffirmation(input.prompt)) return null;
  const previous = input.previousVendorOptions;
  const previousScope = previous?.mekaCombatRequestScope;
  if (previous && previousScope !== 'table-scope') return null;
  if (
    previousScope === 'table-scope' &&
    previous?.mekaCombatRequestScopeState === 'confirmed' &&
    previous?.mekaCombatScopeApproved === true
  ) {
    return null;
  }
  return {
    ...(previousScope === 'table-scope' ? { mekaCombatRequestScope: 'table-scope' } : {}),
    mekaCombatRequestScopeState: 'confirmed',
    mekaCombatScopeApproved: true,
    // 审批同时固定证据依据：表范围请求的运行时语义由注入的项目权威参考覆盖
    // （计划/结果必须原样写明依据了哪条注入路径，见 combatScopePrompt）。
    mekaCombatEvidenceBasis: 'project-reference',
  };
}

/**
 * Only accept an ID that the user labels as a skill. Unlabelled numbers may be
 * damage, duration or count values and must never become the mutation target.
 *
 * **不再是生产路径**：唯一生产漏斗是 `combatSkillIdVendorPatchFromUserPrompt`，本函数只按
 * `meka-injection/index.ts` 的对外导出面保留为诊断/兼容口子。回归用例必须以**漏斗**为准
 * （`mekaRuntimeInjection.test.ts` 的负例都走漏斗），本函数只保留一条冒烟断言（A6）。
 */
export function parseCombatSkillIdFromUserPrompt(prompt: unknown): CombatSkillIdParseResult {
  if (typeof prompt !== 'string' || !prompt.trim()) return { state: 'missing' };
  const scan = scanCombatSkillIds(prompt);
  const ids = [...new Set([...scan.unlabelledIds, ...scan.labelledIds])];
  if (ids.length === 0) return { state: 'missing' };
  if (ids.length > 1) return { state: 'ambiguous', skillIds: ids };
  return { state: 'valid', skillId: ids[0]! };
}

/**
 * 「用户消息 → 战斗绑定」的**唯一漏斗**（bootstrap / resume / 本轮续聊三条路径都经过它）。
 *
 * 除单 ID 外还在这里做**请求范围分类**：表范围请求显式置空
 * `mekaCombatTargetSkillId`（单值门禁不得再把正则猜出的数字当事实），并且**绝不**使用
 * `mekaCombatTargetSkillIds`（那是歧义载体，不是范围载体）。
 */
export function combatSkillIdVendorPatchFromUserPrompt(
  prompt: unknown,
): Record<string, unknown> | null {
  const classification = classifyCombatRequestScope(prompt);
  if (!classification) return null;
  if (classification.scope === 'table-scope') {
    return {
      mekaCombatTargetSkillId: undefined,
      mekaCombatTargetSkillIdState: 'missing',
      mekaCombatTargetSkillIds: undefined,
      mekaCombatRequestScope: 'table-scope',
      mekaCombatRequestScopeState: 'proposed',
      mekaCombatScopeSelection: classification.selection ?? undefined,
      mekaCombatScopeSourceTables: classification.sourceTables,
      mekaCombatScopeSkillIds: [],
      mekaCombatScopeApproved: false,
      // 表范围的运行时语义（编码 + 命令契约）由注入的项目权威参考覆盖 ⇒ 证据依据是项目参考。
      // 表范围**没有**可达的服务器核查通道（见 combatScopePrompt），所以参考未覆盖/冲突时
      // 的出口是回落到单技能流程，不是派发 Worker。
      mekaCombatEvidenceBasis: 'project-reference',
    };
  }
  return {
    mekaCombatTargetSkillId:
      classification.state === 'missing' ? undefined : classification.skillId,
    // 分类只有两种结果：用户明确给出（标注写法或整条消息一个正整数）⇒ confirmed；
    // 多个 ID ⇒ ambiguous。将来新增「上下文推断的候选」时必须加 `proposed` 分类成员并在这里
    // 显式映射，不得悄悄写成 confirmed。
    mekaCombatTargetSkillIdState: classification.state === 'missing' ? 'ambiguous' : 'confirmed',
    mekaCombatTargetSkillIds:
      classification.state === 'missing' ? classification.skillIds : undefined,
    mekaCombatRequestScope: 'single-skill',
    mekaCombatRequestScopeState: classification.state,
    mekaCombatScopeSelection: undefined,
    mekaCombatScopeSourceTables: undefined,
    mekaCombatScopeSkillIds: undefined,
    mekaCombatScopeApproved: false,
    // 单技能路径本层不写依据：Host 在计划层按「两条项目参考是否已注入 + 目标是否已由用户
    // 确认」定稿（`combatEvidenceBasisPatch`）——目标已确认时同样是 project-reference。
    mekaCombatEvidenceBasis: undefined,
  };
}
