# Meka 会话注入层

## 触发条件

修改 `apps/desktop/src/main/meka-injection/**`、Meka 会话的 prompt 段注入、角色级
MCP／技能落地、技能快照挂载、`vendorOptions` 的 Meka 键，或进程级 Meka 运行时 MCP
注册（`registerMekaCapabilities` / `declareMekaRuntimeMcpAgents`）前，必须先读本文。
跨端行为事实以白名单清单
[`meka-whitelist-verification.md`](meka-whitelist-verification.md) 的 **WL-11**（项目/角色
与运行期注入链）、**WL-15**（Skill 走非 argv 载体）、**WL-16**（注入层契约与能力矩阵）
为准；本文只说明分层、接口契约与不变量。

**背景**：本目录是 `apps/desktop/src/main/maker-ipc/mekaRuntimeInjection.ts`（688 行单文件）
的搬迁与显式分层。该文件**已删除**，原路径**不留 re-export**（避免双入口）。
`maker-ipc/register.ts` 只改了 import 路径（`:588`），对外导出名与签名保持不变。

> **行号锚点的维护约定**：本文与白名单 WL-11 / WL-15 / WL-16 里的 `文件:行号` 锚点指向
> **本层当前的**实现位置，重构期已因分层与后续修复整体位移过一次。锚点只在「指向哪个
> 函数／哪一段」上要有意义，**不作为逐字契约**：改本层代码时顺手核一遍本文 §1／§2／§3／§5
> 与 WL 的锚点，别让它们指到别的函数上去（`check:dev-docs` 与 WL 结构契约测试都**不**
> 校验行号，指错了没有任何自动化会红）。
>
> **2026-09-23 追加（第二批文档同步时逐条重核）**：本批新增了 order 65 段
> （`mekaProjectReferencesPrompt` + 段文本常量，插在 `mekaCombatPrompts.ts` 的角色上下文段与
> 角色 prompt 之间）与运行期/写盘侧的一批新代码，**`mekaCombatPrompts.ts` 与
> `mekaResolvePlan.ts` 的行号再次整体后移**（前者约 +47～190 行、后者约 +110～170 行，
> 具体幅度随段/函数不同）。本次已**打开文件按符号名逐条复核**并改对了本文档里指错的锚点，
> 但**`meka-projects/runtimeConfig.ts` 在本次文档同步期间仍被并发编辑**（观测到 mtime 继续前进），
> 因此本文里 `runtimeConfig.ts` 的行号一律**按符号名理解**，不要照抄数字。
> **免责说明**：以上锚点在 2026-09-23 之后可能继续漂移；**引用时以符号名为准，并重新核对行号**。

## 0. 命名（`meka/main` §8）

本目录的**跨模块导出名**一律带 `meka`（`MekaInjectionPlan`、`MEKA_AGENT_CAPABILITIES`、
`registerMekaCapabilities`、`applyMekaRuntimeConfig`…），模块**文件名**同样带 `meka`
（`mekaResolvePlan.ts` / `mekaApplyPlan.ts` / `mekaCombatPrompts.ts` /
`mekaInjectionTypes.ts` / `mekaAgentMatrix.ts` / `mekaMcpRegistration.ts`），依据是
[`engineering-conventions.md`](engineering-conventions.md) §8「在 `meka/main` 上新引入的命名
一律带 `meka`」。两点例外与理由：

- **`index.ts` 保留目录约定的入口名**：它是入口惯例名而不是领域名，模块身份由
  `meka-injection/index.ts` 这条路径承担，且所有调用方都按路径 import。
- **层内私有 helper 不带前缀**（`buildPlan` / `createPlanBuilder` / `projectVendorOptions` /
  `resolveFrozenInjection` / `resolveBootstrapInjection` / `pushCombatTargetPatches` /
  `nativeSkillMount` / `mergePlatformSkills` / `mergePlatformMcp` /
  `resolveCombatServerTargetInjection` / `materializeSkillSnapshotOrThrow` /
  `prependPromptSection` 与本地类型 `MaterializeSkillSnapshot` / `VendorOptionPatches`）：
  它们不跨模块，不存在与其它模块撞名的可能，而这份重构的 review 方式恰恰是**逐行对照
  旧实现**（I1/I2 的逐字节等价）——给每个局部符号加前缀只会让那次对照更难做。§8 要挡的是
  「新引入的名字在 meka 产品线里分不清归属」，层内私有名不构成这个风险。

## 1. 分层与职责

| 层 | 文件 | 职责 | 禁止 |
| --- | --- | --- | --- |
| 0 文本常量 + 战斗 ID 解析 + 范围审批判定 | `meka-injection/mekaCombatPrompts.ts` | 所有注入段的**文本唯一来源**（`combatControllerSkillPrompt:78`、`combatTargetPrompt:109`、`combatScopePrompt:130`、`combatProjectPathsPrompt:253`、`combatServerTargetPrompt:291`、`roleContextPrompt:309`、**新增段 order 65 `mekaProjectReferencesPrompt:344`**（marker `MEKA_PROJECT_REFERENCES_MARKER:321`）、`COMBAT_SERVER_WORKER_PROMPT:33`、`COMBAT_EXECUTION_AUTHORIZATION_PROMPT:48`）、用户消息里的技能 ID／请求范围解析（`parseCombatSkillIdFromUserPrompt:740`、`combatSkillIdVendorPatchFromUserPrompt:756`），以及**两条**范围审批转换：聊天路径 `isCombatScopeAffirmation:605` / `combatRequestScopeApprovalPatch:680`，卡片路径 `isCombatScopeAnswerApproval:639` / `combatRequestScopeAnswerApprovalPatch:715`（两者共用补丁尾部 `combatScopeApprovedVendorPatch:653`） | 不做 I/O、不碰 opts、不读 deps |
| 1 计划类型 + order 表 | `meka-injection/mekaInjectionTypes.ts` | `MekaInjectionPlan:138`、`MekaPromptSegment:108`、`MEKA_PROMPT_SEGMENT_ORDER:94`、段落工厂 `createMekaPromptSegment:115` | 不含业务分支 |
| 2 解析 | `meka-injection/mekaResolvePlan.ts` | 把 create opts / 用户消息 + 外部依赖（持久化绑定、运行期配置、平台技能、技能快照、MCP、战斗服务器目标）解析成结构化 plan／turn context。**全部 I/O 都在这一层**（入口 `resolveMekaInjection:777`、`prepareCombatFollowupRuntimeContext:816`） | 不写 `opts`、不改注入文本 |
| 3 落地 | `meka-injection/mekaApplyPlan.ts` | 把 plan 写进 create opts：按 `order` 升序渲染段落（`renderMekaPromptSegments:55`）、写 `vendorOptions`（`:88-91`）、挂原生技能（`:96-100`） | 不解析、不做 I/O、不重算 `plan.result` |
| 能力矩阵 | `meka-injection/mekaAgentMatrix.ts` | `MEKA_AGENT_CAPABILITIES:38`、`MEKA_AGENT_KINDS:71`、`mekaRuntimeMcpAgentKinds:76` | 不得由调用方手写第二份 agent 清单 |
| 进程级注册（形态 B） | `meka-injection/mekaMcpRegistration.ts` | `registerMekaCapabilities:53`：按矩阵遍历三个 `AgentKind`，`runtimeMcp: true` 的取数组注册（取不到**抛错**），`false` 的显式留档（`:60-79`） | 不得绕过矩阵直接调低层原语 |
| 对外入口 | `meka-injection/index.ts` | 形态 A（`applyMekaRuntimeConfig:51`）与形态 C（转发 `prepareCombatFollowupRuntimeContext`）的**唯一**入口 | 不转发形态 B（避免出现第二个入口名）；不转出**没有消费者**的层内类型与形态 A 子步骤 |

## 2. 入口形态：「一个形态恰好一个入口」

| 形态 | 场景 | 唯一入口 | 说明 |
| --- | --- | --- | --- |
| A | 会话创建 / 恢复 | `meka-injection/index.ts` 的 `applyMekaRuntimeConfig(opts, deps?)` | 只做组合：`resolveMekaInjection`（含全部 I/O）→ `applyMekaInjection`（只写 opts）。生产调用点 `maker-ipc/register.ts:6810` |
| B | 进程级 Meka MCP 注册 | `meka-injection/mekaMcpRegistration.ts` 的 `registerMekaCapabilities(registry)` | 生产调用点**唯一**：`maker-host/index.ts:2308`（在 `_mcpProviders.pi = piMcpProviders`（`:2303`）之后，保证三个数组都已就位）。低层原语 `mcp-integrations/meka-runtime-mcp.ts` 的 `registerMekaRuntimeMcpArrays:1426` 仍是公开导出（测试直接用它），但**生产禁止直接调**——它只认数组、不认归属，少传一个数组时发现不了任何问题 |
| C | 每轮续聊 | `meka-injection/index.ts` 转发的 `prepareCombatFollowupRuntimeContext`（实现 `mekaResolvePlan.ts:816`） | 生产调用点 `maker-ipc/register.ts:12681` |

**约束**：新增形态必须新增**唯一**入口，并在此表登记；不得为已有形态开第二入口，
也不得把形态 B 从 `index.ts` 转发出去（那样会同时存在 `index.registerX` 与
`mekaMcpRegistration.registerX` 两个名字）。

**导出面只留公共签名**：`index.ts` 只转出两个形态入口、两个 ID 解析口子、一个**卡片答案审批口子**
（`combatRequestScopeAnswerApprovalPatch`，`index.ts:31`），以及这些签名上
真正用到的类型（`AppliedMekaRuntimeConfig` / `ApplyMekaRuntimeConfigDeps` /
`PersistedMekaSessionBinding` / `CombatFollowupRuntimeContext` / `CombatSkillIdParseResult`）。
形态 A 的两个子步骤（`resolveMekaInjection` / `applyMekaInjection`）与层内计划类型
（`MekaInjectionPlan` / `MekaInjectionInput` / `MekaSessionBindingPatch` /
`MekaNativeSkillMount` / `MekaInlineMcpConfig`）**不再转出**：它们在重构期曾以「分层契约
入口」为名保留，但生产与测试都只走 `applyMekaRuntimeConfig`，转出去只会长出第二入口。
新增生产调用方必须用 `applyMekaRuntimeConfig`，不得只跑其中一步。

> **与计划文本的差异（记录在案）**：实施计划写作「4 种入口形态」，实现里落成的是 **3 个形态
> （A / B / C）+ 1 组跨形态共享的解析入口**：`parseCombatSkillIdFromUserPrompt`（`mekaCombatPrompts.ts:740`）
> 与 `combatSkillIdVendorPatchFromUserPrompt`（`:756`）。后者同时服务形态 A 与形态 C
> （由两者各自调用），所以它**不是**独立形态，而是两个形态共用的“口子”。若以后要把它抬成
> 独立形态，必须在这里新增一行并说明它的唯一入口。
>
> **2026-09-22 追加：第三个消费者侧口子。** 除上面这组「两个形态共用的解析口子」之外，注入层现在
> 还有一个**跨形态共享、且被形态之外的调用方消费**的口子：`combatRequestScopeAnswerApprovalPatch`
> （`mekaCombatPrompts.ts:715-730`）。它**不服务形态 A / B / C 中的任何一条**——唯一消费者是交互
> resolve 口 `maker-ipc/register.ts:2846-2887`（`ask_user_question` 卡片答案 → 范围审批补丁）；
> 同一语义在聊天路径由 `combatRequestScopeApprovalPatch`（`:680-696`）承担，驱动源是计划层 / 续聊
> 口子的 `input.prompt`。两条路径共用补丁尾部 `combatScopeApprovedVendorPatch`（`:653-661`），
> 产出补丁逐键相同，差异只在判定粒度与前提（见 §3.2）。它的消费者**唯一**，因此同样满足
> 「一个口子恰好一个入口」；若以后要把它抬成独立形态，必须在这里新增一行并说明唯一入口。

## 3. `MEKA_PROMPT_SEGMENT_ORDER`：段落 id → order → 注入段

`mekaInjectionTypes.ts:94`。order 升序 = 最终 prompt 里自上而下的先后（`mekaApplyPlan.ts:72-79`
排序后拼接）。`order` 是**契约而不是实现细节**：它对应重构前 7 次 `prependPromptSection`
倒推出的现状顺序，逐字节基线用例（见 §6）直接断言。

| order | segment id | 对应注入段 | 现状序号 | 出处 |
| --- | --- | --- | --- | --- |
| 10 | `meka.combat.controller-skill` | `[SAGA2_COMBAT_CONTROLLER_SKILL]`（冻结正文绝对路径 + 先读完指令） | 1 | `mekaCombatPrompts.ts:78-91` |
| 20 | `meka.combat.server-target` | `[SAGA2_COMBAT_SERVER_TARGET]`（`ready` / `unavailable` 两态，**函数本身恒返回非空文本**——但整段是否入 plan 有前置条件，见下） | 2 | `mekaCombatPrompts.ts:291-307` |
| 30 | `meka.combat.project-paths` | `[SAGA2_PROJECT_PATHS]` | 3 | `mekaCombatPrompts.ts:253-289` |
| 35 | `meka.combat.scope` | `[SAGA2_COMBAT_SCOPE]`（`table-scope` 专用；与 `meka.combat.target` **互斥**，同一 order 空档只放一段） | 3.5 | `mekaCombatPrompts.ts:130-180`（`combatScopePrompt`） |
| 40 | `meka.combat.target` | `[SAGA2_COMBAT_TARGET]`（仅当解析出唯一合法技能 ID；`table-scope` 下恒不入 plan） | 4 | `mekaCombatPrompts.ts:109-122` |
| 50 | `meka.combat.execution-authorization` | `[SAGA2_COMBAT_EXECUTION_AUTHORIZATION]` | 5 | `mekaCombatPrompts.ts:48-53` |
| 60 | `meka.role-context` | `[MEKA_ROLE_CONTEXT]` | 6 | `mekaCombatPrompts.ts:309-318` |
| 65 | `meka.project-references` | `[MEKA_PROJECT_REFERENCES]`（**普通／默认角色**的 `agents-md`／`rule` 的「**作用范围 \| 绝对路径 \| 描述**」清单；**正文内联已被移除**，内容为空 ⇒ **整段不渲染**）。**与 order 30 的边界**：30 是**战斗 workflow 专属**的固定项目文件注入（四条路径 + 逐字 ReadCommand + `mekaCombatProjectRefPaths` 精确路径白名单），65 是**角色级**规范类元数据、只给地址与描述、不进路径白名单——战斗角色仍走内联（§7 D2.4 边界②）⇒ 65 段对战斗角色为空。两者互不替代，也不共享解析结果 | —（新段，无重构前序号） | `mekaCombatPrompts.ts:344-362`（marker `:321`）；推入 `mekaResolvePlan.ts:656-659` |
| 70 | `meka.role-prompt` | 角色 `promptText`（已过 `removeCombatStartupGate`） | 7 | `mekaCombatPrompts.ts:26-31`；`mekaResolvePlan.ts:648-651` |
| 80 | `meka.combat.server-worker` | `[SAGA2_COMBAT_REMOTE_SERVER_WORKER]`（`isCombatServerWorker` 分支**独占**，只注入这一段） | worker | `mekaCombatPrompts.ts:33-46`；`mekaResolvePlan.ts:668-670` |

**规则**：

- **新增段落只能插空档（如 15 / 25 / 45 / 55 / 75），不得重排既有段落。** order 数值一经发布即冻结；
  改既有段的 order = 改注入顺序 = 破坏 system prompt 前缀稳定性与 `maker-core-and-agent-behavior.md`
  §3.1/§4 的门禁，属于必须 owner 确认的改动。
  `meka.combat.scope`（2026-09-22 新增）占 **35**：那是 30 与 40 之间当时**唯一**的空档；
  `meka.project-references`（2026-09-23 新增）占 **65**：那是 60 与 70 之间当时**唯一**的空档
  （它落在角色上下文与角色 prompt 之间，因为它是角色级内容、必须与角色段同进同出）。
  后续新增段只能继续找空档（15 / 25 / 45 / 55 / 75 …），**不得**把既有段顺移。
- 段落工厂是 `createMekaPromptSegment`（`mekaInjectionTypes.ts:115`）：调用方**不得手写 order**，
  避免静默重排。
- `meka.role-prompt` 在正文为空时不入 plan（`mekaResolvePlan.ts:648-651`）；
  `meka.project-references` 在参考集合为空时不入 plan（`mekaCombatPrompts.ts:344-347`）；
  `meka.combat.target` / `meka.combat.project-paths` / `meka.combat.controller-skill`
  在无法构造文本时同样不入 plan。段落的**相对集合**也因此是逐字节基线的一部分。
- `meka.combat.server-target` 的入 plan 前置条件与「文本是否非空」无关：该段由
  `resolveCombatServerTargetInjection`（`mekaResolvePlan.ts:230`，重构前是 `injectCombatServerTarget`）
  构造，只在「`mekaCombatTargetSkillId` 是唯一合法正整数 **且** `deps.resolveCombatServerTarget`
  存在」时才会产生（resolver 抛错按 `unavailable` 处理，仍然入 plan）。因此无绑定技能 ID /
  歧义 ID / 未注入 resolver 时，该段**完全不出现**——不要把它读成「恒存在」。
  基线用例第 2、4 条即覆盖缺席形态。
- 解析层按**现状的执行次序** push 段落（次序与最终 order 相反），`mekaApplyPlan` 只按 order
  渲染；「执行次序」不再是语义，只有 order 是语义。

`plan.frozen === true`（resume 短路，§5 I4）时，角色段 **60 / 65 / 70 都不注入**（现状事实），
只补战斗契约段 —— 65 与角色段同进同出，不得为了 resume 注入它而在 frozen 路径上新增
`resolveRuntimeConfig` 调用（I4：resume 不重解析项目/角色）。

### 3.1 项目参考路径注入、vendorOptions 新键与精确路径白名单（2026-09-22）

架构反转：**Cindy 拥有流程与权限，项目仓拥有域事实**。冻结 Skill 不再内嵌模块/编码领域表；
域事实改由 Host 用**绝对路径**注入，模型按注入的 ReadCommand 逐字读取。

`[SAGA2_PROJECT_PATHS]`（段 30，`combatProjectPathsPrompt`）在既有 `projectRoot` /
`unityClientRoot` / `legacyModuleJsonTempRoot` / `unityAgentsPath` /
`legacyModuleProtocolCodecPath` 之外新增两条**项目侧域事实**路径与其 ReadCommand：

| 变量 | 含义 | 取值（唯一来源 `resolveCombatProjectRefPaths`） |
| --- | --- | --- |
| `moduleEditorSkillPath` | 项目技能库里的模块编辑器契约（节点/连线字段、`time`/`data`/`dataCondition` 编码、`@N` 映射、`moduleType` / target 字典、老版 CLI 形态） | `<unityClientRoot>/.agents/skills/editor-skill-editor-module/SKILL.md` |
| `damageEncodingRulePath` | 策划设计库里的伤害/模块编码权威规则 | `<projectRoot>/saga2_design/planning/04-职能组-functional-groups/战斗策划组-combat-planning/专业规则-rules/ModuleDesignKnowledge.md`（三段 CJK 目录名不可推导，只能注入） |
| `moduleEditorSkillReadCommand` / `damageEncodingRuleReadCommand` | 逐字读取命令 | `Get-Content -LiteralPath '<path>' -Encoding UTF8`（`unityAgentsReadCommand` / `legacyModuleProtocolCodecReadCommand` 同形，四条都带编码参数） |

> **四条参考文件优先用原生读取工具**：段正文明确要求先用原生文件读取工具（`read`）读这四条注入
> 路径（按 UTF-8 解码，不会把 CJK 正文读成乱码），Shell 是回退且必须逐字复制 ReadCommand
> （`-Encoding UTF8` 不得删改）。这是 2026-09-22 的正文变更，不是可选的实现细节。

**策略层不硬编码任何机器路径**：两条路径经 `combatProjectReferencePatch`（`mekaResolvePlan.ts:263-270`）
写进 `vendorOptions`，策略层只从注入值取值。

新增 `vendorOptions` 键（由 `mekaResolvePlan.ts` 写入，`combatWorkflowPolicy.ts` 消费；
I2 的键序契约照旧适用于它们）：

| 键 | 取值 | 消费面 |
| --- | --- | --- |
| `mekaCombatProjectRefPaths` | `[moduleEditorSkillPath, damageEncodingRulePath]`（绝对路径数组） | `combatProjectRefPaths` / `isAllowedCombatProjectRefPath`：**精确路径 + 单文件**只读的唯一放行来源；未注入 = 空 = 一律不放行（fail-closed） |
| `mekaCombatReadOnlyUnityCommands` | `['legacy_module_query_nodes','legacy_module_audit_coverage']`（`COMBAT_READ_ONLY_UNITY_PIPELINE_COMMANDS`） | `isCombatScopeResolutionUnityQuery`：表范围解析期 `unity_inspect(action="command")` 的**命令名白名单**；未注入 = 空 = 不放行 |
| `mekaCombatRequestScope` | `single-skill` / `table-scope`（缺省 = 老会话，等价单技能） | 请求范围分类，见下 |
| `mekaCombatRequestScopeState` | `missing` / `proposed` / `confirmed`（`'declined'` 已随 A6 删除：它从来没有生产者） | 范围解析状态 |
| `mekaCombatScopeSelection` | 命中的范围特征原文（或 undefined） | `combatScopePrompt` 的 `scopeSelection:` 行 |
| `mekaCombatScopeSourceTables` | 用户消息里点名的 `saga2_json` 表路径数组 | `isCombatScopeResolutionRead` 的声明源表放行 |
| `mekaCombatScopeSkillIds` | **Agent 自己按范围段做过的只读范围查询里显式传入的 ID**（`legacy_module_query_nodes` + `skill_ids`）：`recordCombatScopeSkillIds`（`combatWorkflowPolicy.ts:1604`）去重、按数值升序、只留正整数；**用户确认后冻结**（`mekaCombatScopeApproved === true` 时不再登记），漏斗进入表范围时重置为 `[]` | `approvedCombatScopeSkillIds`（`:1513`）逐目标成员比对。**这是一致性 guard，不是授权边界**：它只证明这些 ID 被 Agent 明确查询过、且整个范围经用户确认，不证明它们属于业务范围；真正的边界仍是 P4／路径白名单／审批位／证据依据 |
| `mekaCombatScopeSkillIdsTruncated` | 布尔；成员清单超过 `COMBAT_SCOPE_SKILL_IDS_LIMIT = 200` 时为 `true`，只保留前 200 个 | 截断 ⇒ `approvedCombatScopeSkillIds` 返回空，成员比对回落到「无清单」口径（部分清单会把范围内的 ID 误判成范围外，比没有清单更危险）；**这不是预算／额度，只是拒绝把不可能完整的清单当成员白名单** |
| `mekaCombatScopeApproved` | 布尔；用户肯定回复后才为 `true` | **只决定写入**，不决定能否只读解析范围 |
| `mekaCombatEvidenceBasis` | `project-reference` / `server-report`（缺省 = server-report）。**由 Host 依据注入情况写入，不是 Agent 判断**：`combatEvidenceBasisPatch`（`mekaResolvePlan.ts:282-302`），三处入口见 §3.2 | `combatEvidenceBasisIsProjectReference`（`combatWorkflowPolicy.ts:1642`，使用点 `:2637`）：`project-reference` **且**两条参考路径已注入 **且**（`table-scope` ⇒ `mekaCombatScopeApproved === true`，否则 ⇒ `mekaCombatTargetSkillIdState === 'confirmed'`）才免除服务器 `supported` 回执 |

**精确路径白名单的分层**（每一层都 fail-closed，任一层缺席即拒绝）：

1. **枚举层**：`isBroadCombatSkillExplorationCommand`（`combatWorkflowPolicy.ts:1763`）拒绝
   `.agents/skills` / `.codex/plugins` / `.claude/skills` 下的任何 `SKILL.md` 读取与批量枚举；
   唯一豁免是命中第 2 层的单文件读取。
2. **单文件精确路径层**：`isAllowedCombatProjectRefSingleRead`（`:1481`）要求请求路径 resolve 后与
   `mekaCombatProjectRefPaths` 中的某项**全等**；通配、`?`/`*`/`[`、目录都不放行。
3. **`saga2_design` 宽读层**：`isBroadCombatDesignExplorationCommand`（`:1751`）仍拒绝 `Get-Content`、
   `-Recurse`、`Get-ChildItem -Filter *.md`、`Select-String -Path $files` 等宽读形态，
   `01-治理规范-governance/` 始终拒绝；命中第 2 层时豁免。
4. **表范围只读解析层**：`isCombatScopeResolutionRead`（`:1656`）额外放行「声明的源表 + `saga2_json` 下的
   表文件 + 老版模块资产目录 `Module/Saved Data/Modules` 里的单个 `.asset`」的单文件读取；
   `ModuleV2` 仍被 `isForbiddenCombatClientEvidence`（`:1834`）拦掉。
5. **插件侧命令白名单层**：Cindy 侧只放行注入清单里的命令名，`projectPath` 必须与注入的
   `unityClientRoot` 逐字一致；meka-unity 插件对 `unity_inspect(action="command")` 另有一份
   9 项硬编码只读命令白名单作为**外层保证**（跨仓：`cindy-meka-plugins/meka-unity/node/worker.cjs:49-59`；
   增删任一命令必须两侧同时核对）。

**会话级战斗 vendorOptions 镜像（A3，`combatWorkflowPolicy.ts:84-115`）**：范围审批门禁必须先知道
「这个会话当前是不是表范围」，否则任何一句无关的「可以／继续／OK」都会被当成范围审批。maker-core 的
`Session` **只有写入口**（`setVendorOptions`，`maker.getSession()` 也不暴露 vendorOptions），所以
Host 自己维护一份**只镜像 `mekaCombat*` 键**的会话级镜像：

- 计划层在 bootstrap（`mekaResolvePlan.ts:742-745`）与 resume 短路（`:485`）时记录解析出的投影；
  续聊口子在 `register.ts:12712` 的 `onAccepted` 里记录**真正落地**的补丁（发送未派发而被
  `rollbackPatch` 回滚时不回写）。
- 消费面是 `prepareCombatFollowupRuntimeContext` 的 `previousVendorOptions` 回落值
  （`mekaResolvePlan.ts:825-826`；生产调用方 `register.ts:12689` 显式传入 `readCombatVendorOptions(sessionId)`）。
- **它不进 DB、不跨进程**：镜像随 Desktop 进程存活，**应用重启后为空** —— 此时语义是「状态未知」，
  只写合法的范围键（与 A3 之前的行为一致），不得把「未知」当成「非表范围」或「可以审批」。
- **它是一致性状态，不是授权边界**（与 §3.2 的成员清单同性质）；`forgetCombatVendorOptions` 目前
  **没有生产调用方**，会话结束时不清镜像，只随进程退出消失。

`MEKA_PROMPT_SEGMENT_ORDER` 里 `meka.combat.scope`（35）与 `meka.combat.target`（40）
**互斥**：`combatTargetPrompt` 在 `mekaCombatRequestScope === 'table-scope'` 时返回 null，
`combatScopePrompt` 在非 `table-scope` 时返回 null，因此同一 order 空档只会有一段。
完整产品语义见 [`../product-rules/meka-skills.md`](../product-rules/meka-skills.md) §8；
白名单落点为 **WL-11.11 / WL-11.12 / WL-11.13**（本层三组键与白名单）、
**WL-11.14**（Host 侧证据预算／配额／时限删除；提示词层的收敛纪律保留）与
**WL-11.15**（Pi 空回合兜底，跨 harness）。

**与 order 65 `[MEKA_PROJECT_REFERENCES]` 的边界（2026-09-23）**：本节的
`[SAGA2_PROJECT_PATHS]`（30）是**战斗 workflow 专属**的固定项目文件注入 —— 四条路径
（`projectRoot` / `unityClientRoot` / `unityAgentsPath` / `legacyModuleProtocolCodecPath`）
加两条域事实路径，各带逐字 ReadCommand，并与 `mekaCombatProjectRefPaths` **同源**
（同一份 `resolveCombatProjectRefPaths` 结果，避免第二套路径方案）。order 65 的
`[MEKA_PROJECT_REFERENCES]` 是**角色级**的规范类元数据（`agents-md` / `rule`）清单：
只给「作用范围 + 绝对路径 + 描述」，正文由 Agent 按需读取，来源是角色的
`projectMetadataSelection`（默认角色因 `includeAllProjectMetadata` 包含全部有效项）。
两者的边界是**载体与适用范围**，不是分工：30 段只服务战斗 workflow 的域事实，
65 段服务**普通／默认角色**的规范类元数据。

**战斗 workflow 的规范类元数据**仍按改动前**内联**投递、**不产出 `projectReferences`**
（有意差异，见 §7 D2.4 边界②）：`roleFile.workflow === 'saga2-combat-development-v1'` 的
角色，其 `agents-md` / `rule` 正文照旧 `prompts.push(content.trim())` 进 order 70，order 65
因此拿到空集合、**整段不渲染**。所以「战斗角色会同时看到 30 与 65 两段」是**改动前**的形态，
现状不是；30 与 65 因此互不替代、也不共享解析结果（65 不含 ReadCommand，也不进路径白名单）。

### 3.2 证据依据的定稿与表范围服务器派发的已知边界（2026-09-22）

**统一口径（owner 裁决，同日后续修订）**：证据依据的**两类请求共用同一语义** —— 当 Host 注入的项目
权威参考（`moduleEditorSkillPath`、`damageEncodingRulePath`）覆盖本轮运行时语义时，`table-scope` 与
`single-skill` **都不要求**服务器 `supported` 回执。此前「豁免只对已批准的 `table-scope` 生效、单技能
始终要回执」的形态已作废（历史观察保留在迁移总账 §6.56）。

**唯一写方 `combatEvidenceBasisPatch(patch, workingDir, baseVendorOptions)`**
（`mekaResolvePlan.ts:282-302`）：**该键由 Host 依据注入情况写入，不是 Agent 判断**；Agent 只能在
PLAN/RESULT 里原样声明 basis 与所依据的注入路径，Host 一律以 `vendorOptions` 的值为准。

- **无注入即 fail-closed**：`resolveCombatProjectRefPaths(workingDir) === null` 时**无条件**清除旧值
  （A7）：会话里已有 `mekaCombatEvidenceBasis` 就写回 `undefined`，本来没有就不写这个键
  （避免凭空多一个 `undefined` 键改变键序）⇒ 回落到服务器 `supported` 回执。
- `table-scope` ⇒ 返回 `{}`：依据由漏斗 `combatSkillIdVendorPatchFromUserPrompt`
  （`mekaCombatPrompts.ts:756-797`）与两条审批补丁——聊天路径 `combatRequestScopeApprovalPatch`
  （`:680-696`）、卡片路径 `combatRequestScopeAnswerApprovalPatch`（`:715-730`）——自带，两条补丁共用
  同一段尾部 `combatScopeApprovedVendorPatch`（`:653-661`），所以**写入内容逐键相同**，这里不重复写。
- `single-skill` 且 `mekaCombatTargetSkillIdState === 'confirmed'` ⇒ `'project-reference'`。漏斗补丁
  先写 `undefined`（`:795`），依据补丁在其后覆盖 ⇒ **patch 顺序敏感**，不得把依据补丁插到漏斗
  补丁之前（`builder.patches.push(patch, ...evidenceBasis)` 与
  `{ ...targetPatch, ...evidenceBasisPatch, ... }` 两处形态都依赖该顺序）。
- **本次消息没有改目标时读会话现状**（`baseVendorOptions`），因此本改动之前创建的会话在**下一次**
  续聊/恢复时也会拿到依据（`mekaResolvePlan.ts:296-300`）。

**卡片答案的审批补丁与聊天路径只差两点**（其余全部共用）。`combatRequestScopeAnswerApprovalPatch`
（`mekaCombatPrompts.ts:715-730`）与 `combatRequestScopeApprovalPatch`（`:680-696`）产出**逐键相同**的
范围确认补丁（共用尾部 `combatScopeApprovedVendorPatch:653-661`），差异只有：

- **判定粒度**：聊天路径看**整条消息**（`isCombatScopeAffirmation:605-613`，必须只由肯定词与标点组成），
  卡片路径只看**首词**（`isCombatScopeAnswerApproval:639-645`）。卡片选项标签**必然**带业务内容——
  真实卡片上的确认项是 `确认：只改这 15 个伤害节点，技能表参数先不动`，整条消息判据会把它判成新指令。
  首词判定**拒绝优先且锚定在开头**（`:643-644`）：同一张卡片的拒绝项是
  `先不执行，我要调整范围或数值`，而确认项自身含「参数先不动」，用子串搜索「先不」会把确认判成拒绝。
  首词既不是肯定也不是拒绝（自由文本、空串、空白、非字符串）一律返回 false——卡片上的自由文本输入
  可能是在提新要求，不能当成审批。
- **强制前提**：卡片路径**必须**已知会话处于表范围提案态
  （`previousVendorOptions.mekaCombatRequestScope === 'table-scope'`，`:722`），镜像缺失或非表范围
  一律返回 null。聊天路径没有这条前提，它靠「整条消息只由肯定词组成」挡住误判；卡片路径没有那层护栏，
  少了这条前提，任何一张选项恰好以「确认 / 好 / OK」开头的卡片都会写出范围审批 —— 那是**放宽**门禁。
  已确认过则幂等返回 null（与聊天路径同）。

**三处定稿入口**：`pushCombatTargetPatches`（`mekaResolvePlan.ts:347-401`，漏斗 → A2 guard →
审批补丁 → 依据定稿都在这里；被 bootstrap `:708-715` 与 resume `:443-449` 两条路径共用）与
`prepareCombatFollowupRuntimeContext`（`:816-934`）。键插入位置落在
`mekaCombatScopeApproved` 与 `mekaCombatPlanApproved` 之间 ⇒ 仍受 **I2 键序契约**约束，改动必须同步
基线用例的 `Object.keys` 期望。

**消费面**：`combatEvidenceBasisIsProjectReference`（`combatWorkflowPolicy.ts:1203-1209`，使用点
`:2186`）要求 `project-reference` **且** 两条参考路径已注入 **且**（`table-scope` ⇒
`mekaCombatScopeApproved === true`，否则 ⇒ `mekaCombatTargetSkillIdState === 'confirmed'`）。
`combatScopePrompt`（表范围段）按该键决定正文是「引用项目参考」还是「必须走服务器回执」；单技能段
`combatTargetPrompt` **不含**该文案（本键对注入文本的作用只落在表范围段），单技能侧的同一口径由角色
片段（`combat-evidence-budget.md` / `combat-server-worker-routing.md`）与冻结 SKILL.md 正文表达。
**不受本键影响、保持关闭的边界**：`unsupported` / `uncertain` 阻断写入、环境门禁（P4 / Unity /
MCPR）、P4 写边界、legacy-JSON 路径白名单、`create_workers` 拒绝、deny-by-default、其它 `SKILL.md`
与 `01-治理规范` 读禁、服务器 Worker 只读边界与派发协议，以及
`validate_server_capability_report` 的字段校验（`server-report` 单技能路径仍走它）。

**已知边界（登记，不是 bug）：表范围会话无法派发服务器 Worker。** 参考**未覆盖**语义或与需求
**冲突**时，`table-scope` 没有可达的服务器核查出口：

- `resolveCombatServerTargetInjection`（`mekaResolvePlan.ts:230-256`）只在存在唯一合法
  `mekaCombatTargetSkillId` 时才解析并写 `mekaCombatServerRemoteHostId` /
  `mekaCombatServerWorkerAgent`；表范围没有单值目标，`prepareCombatFollowupRuntimeContext` 的表范围
  分支显式把这两个键置 `undefined`（`:885-886`）。
- `authorizeCombatServerDispatch`（`combatWorkflowPolicy.ts:2228`）对 `create_worker` 要求请求里的
  `remote_host_id` 与注入值**全等**；注入值为空 ⇒ 永不相等 ⇒ `beginAuthorizedCombatServerDispatch`
  返回 false，走 `:2609` 的拒绝（「服务器核查 Worker 必须位于当前 SAGA2 已绑定…」）。
  `send_to_worker` 复用通道依赖同一 Lead 生命周期里由 Host 验证过的 Worker，源头同样不可达。
- 即使绕过派发，`validate_server_capability_report`（`mcp-integrations/meka-runtime-mcp.ts:873`）
  用 `mekaCombatTargetSkillId`（表范围为空）做期望目标 ⇒ 报告必然被判 `targetSkillId` 不匹配。

⇒ 角色片段 `combat-server-worker-routing.md` 与冻结 SKILL.md（`combat-skill-configuration/SKILL.md:110-112`）
里「table-scope 不逐目标派发、改绑范围内一个已确认 ID 退回单技能流程」的措辞与这条边界一致。
今天的出口只有两条：① 回到 `single-skill` 流程绑定一个 ID 后再核查（该路径完整可用）；② 由 owner
决定在 `meka-runtime-mcp.ts` 增加**按目标**的派发/回报通道，并在 plan 层补服务器路由注入。
`mekaCombatScopeSkillIds` 的成员清单现在**有生产写入方**（A4，见 §3.1），因此逐目标写入在
「Agent 先做过带显式 `skill_ids` 的只读范围查询」这一正常路径上真的会做成员比对；清单缺失
（用户直接批准、没走查询，或清单被截断）时才退化为「在用户已批准的范围里一次只处理一个显式 ID」，
其余门禁照旧。

**验证现状**：上述结论来自**阅读代码**（`mekaCombatPrompts.ts`、`mekaResolvePlan.ts`、
`combatWorkflowPolicy.ts`、`meka-runtime-mcp.ts` 当前工作树）与实现者在改动过程中运行的**定向单测**
（`mekaRuntimeInjection` + `mekaRuntimeInjectionBaseline` + `combatWorkflowPolicy`，当时报告
**3 个文件 / 106 个用例通过**）。**该数字是历史事实、不是当前文件集合的规模**：2026-09-22 复核时
用 `it(` 计数得到 `mekaRuntimeInjection.test.ts` 38 条（另有 2 组 `it.each`）、
`mekaRuntimeInjectionBaseline.test.ts` 18 条（10 + 8）、
`combatWorkflowPolicy.test.ts` 55 条，说明用例在此后仍有增长，那次通过**不构成对本工作树的验证**。
> **W25 批次终核（2026-09-23，只追加不改写上面的当日计数）**：`mekaRuntimeInjectionBaseline.test.ts`
> **当前为 28 条**（10 + 8 + 10；见 §6 的计数口径）。上面的「18 条（10 + 8）」是**第 16 组落地前**的
> 数字，**不适用于当前文件**。
本层**没有**对真实 SAGA2 工作区做端到端运行，表范围的「确认 → 逐目标导出 → P4 编辑
→ `legacy_module_import_json` 导入 → 回读」往返是**代码可证**而非实跑验证；成员清单（A4）与
会话级镜像（A3）都**没有实机验证**。

**验证现状（2026-09-22 卡片答案审批补丁批次；数字由实现者运行、本节登记人未复跑）**：
`pnpm --filter desktop run typecheck` exit 0；`mekaRuntimeInjection` + `mekaRuntimeInjectionBaseline` +
`combatWorkflowPolicy` + `runtimeConfig.integration` = **137 passed**（更早一次只跑前三个再加
`permissionInteractionPause` = **146 passed**）；读 `register.ts` 源码的形状断言落在「19 个文件
487 passed \| 12 skipped」那一批里。**红→绿证据**：把卡片判据换回聊天判据，新用例即以
`expected null to match object` 转红。**连带修好的存量回归**：`permissionInteractionPause.test.ts`
的 harness 需要把 `resolvePendingInteraction` 新引用的模块级名字
（`log` / `readCombatVendorOptions` / `rememberCombatVendorOptions` /
`combatRequestScopeAnswerApprovalPatch` / `getMakerIfReady`）一并注入——不注入时命中该分支会抛
`is not defined`，catch 里记日志又会再抛一次；补齐后 **15 passed**。**本批未做的验证**：没有
live / Electron 端到端实跑；`renderer → RESOLVE_INTERACTION → resolvePendingInteraction → agent
继续` 这条真实链路没有现成 harness，卡片路径只有单测 + `register.ts` 的源码形状断言。

## 4. `MEKA_AGENT_CAPABILITIES` 矩阵与 D1 裁决的取代

`mekaAgentMatrix.ts:38`（`Readonly<Record<AgentKind, MekaAgentCapabilities>>`，三层 `Object.freeze`）：

| agentKind | `skillSnapshot` | `runtimeMcp` | 依据 |
| --- | --- | --- | --- |
| `claude-code` | `true` | `true` | `packages/maker-core/src/agents/claude-code/index.ts:3327`、`:3900`（消费 `opts.nativeSkillPluginPath`） |
| `codex` | `true` | `true` | `packages/maker-core/src/agents/codex/index.ts:4852`（`nativeSkillPluginPath`） |
| `pi` | `true` | `true` | `packages/maker-core/src/agents/pi/host-skill-mount.ts:69`（`<path>/skills/<id>` → 显式 `--skill`，`pi/index.ts:3764`）；Meka 运行时 MCP 见 `mcp-integrations/meka-runtime-mcp.ts:180` |

**D1 已被取代（2026-09-22）。** 原 D1（用户裁决，2026-09-20）声明「Pi 有意不支持技能快照与 Meka
运行时 MCP」，矩阵写死两列 `false`。**取代理由**：那两列 `false` 描述的不是产品裁决，而是**两处
装配缺口**——Pi 侧对 `nativeSkillPluginPath` 零引用（没有落地形态），以及 bridge 的工厂阶段豁免
只认 codex（`isHarnessBridgeBootstrapContext` 的旧形态 `isCodexBridgeBootstrapContext`）。
本轮把两处都补齐（Pi 复用既有显式 `--skill` 通道；豁免泛化到 `pi`），矩阵随之翻转。**仍然存在的
边界**（不是缺口，是平台事实）：

- 远端会话（SSH / MCPRouter worker）**不挂任何 Pi 技能快照**（`host-skill-mount.ts:76`：harness
  跑在另一台机器上，本地路径无意义），且 Meka 的远端技能投递目前**只有 codex 通道**；
- 进程级 bridge 的 provider 列表在**工厂阶段**冻结，因此**没有**按会话收窄 facade 这回事——
  普通 Pi 会话仍看得到 `mcp_router` / `meka_design` facade，但调用 **fail closed**（与 codex
  同形态）；bridge 启动后才准备好的 inline Meka MCP 不会被追溯注入（对 codex 同样成立）。

完整改动、验证现状与未验证项见
[`../migrations/xdmaker-meka-to-cindy.md`](../migrations/xdmaker-meka-to-cindy.md) §6.54；
白名单落点为 **WL-18**。

矩阵的存在理由：以前「谁拿到了什么」是**涌现**的 —— 由 `maker-host` 手工传数组、
手工写 `vendorOptions` 决定；少传一个数组不报错，只让那个 agent 静默缺能力（Pi 就是这样
丢掉 mcp-router / meka-design 的）。改成显式矩阵后，「缺失」只能是声明式的，而声明被测试钉住。

**双锁**：

- 编译期：矩阵是 `Readonly<Record<AgentKind, ...>>`，maker-core 新增 `AgentKind` 而这里没填
  → 编译失败。
- 运行期：`meka-injection/__tests__/agentMatrix.test.ts` 用 `Record<AgentKind, true>` 再断言
  一次键集合（4 用例）；**矩阵对象、每个能力条目与键数组三层都冻结**（`Object.freeze`，
  `mekaAgentMatrix.ts:38,71`）——只冻结数组容器挡不住 `as`／`any` 的就地改写，那会让注册期
  断言与矩阵悄悄脱钩。
- 注册期硬失败：`declareMekaRuntimeMcpAgents`（`mcp-integrations/meka-runtime-mcp.ts:1460`）
  要求**每个 `AgentKind` 都必须被显式声明**（漏一个直接抛，`:1472-1479`），且声明必须与矩阵
  一致（矩阵说支持却不给数组 / 说不支持却塞了数组，都抛，`:1480-1489`）。`registerMekaCapabilities`
  在 `runtimeMcp: true` 的 agent 取不到数组时也直接抛（`mekaMcpRegistration.ts:66-72`；
  `runtimeMcp: false` 的显式留档分支保留在 `:60-63`，当前矩阵里没有 agent 走到它）。
  ——**「漏传」由此从静默缺能力变成启动期硬失败**（D2 顺手修掉的缺口）。

## 5. 硬性不变量 I1–I8

违反任一条 = P0，回退重做。

| # | 不变量 | 代码锚点 | 自动化兜底 |
| --- | --- | --- | --- |
| I1 | **注入文本逐字节不变**：所有 prompt 段的文本、相对顺序、分隔符（段间 `\n\n`、段内 `\n`）与重构前完全一致 | 文本唯一来源 `mekaCombatPrompts.ts`（**全文件**，2026-09-23 起同时承载新增段 `mekaProjectReferencesPrompt:344-362` 的文本 —— 该段是**新段**，不参与「与重构前逐字节一致」的对照，但同样必须在本文件取文本，不得在别处再拼一份）；渲染 `mekaApplyPlan.ts:43-79` | 基线用例（原有 10 条，§6）断言 `opts.userPrompt` **全文** |
| I2 | **`vendorOptions` 键名、取值、写入时机不变**：**`opts.vendorOptions` 自己的**键插入顺序也是契约（`combatWorkflowPolicy.ts`、`meka-runtime-mcp.ts` 按这些键裁决工具门禁）。注意范围：契约只到 `vendorOptions` 内部，**`opts` 整体的键插入顺序不是契约**（无消费者，见 §7 D2.2） | patch 构造 `mekaResolvePlan.ts:677-706`（bootstrap）与 `:421-486`（resume 短路）；写入 `mekaApplyPlan.ts:88-91`；空 patch 不写（保持对象引用） | 基线用例断言 `Object.keys(opts.vendorOptions)` 顺序（原有 2 个场景 + 追加的 frozen 场景）；`mekaRuntimeInjection.test.ts` |
| I3 | **技能快照冻结语义不变**：首次 materialize 固定 revision，resume 复用同一 revision；远端会话不暴露本地快照路径 | `mekaResolvePlan.ts:194-199`（`nativeSkillMount`：`opts.remoteHostId` 则 null）；物化 `:645`（resume 短路在 `:502`）；`meka-projects/skillSnapshot.ts:322-422`（`readBoundRevision:322-344` 复用） | WL-11.6；`mekaRuntimeInjection.test.ts` |
| I4 | **`mekaRuntimeResolved === true` 短路分支行为不变**：resume 只补战斗契约，不重解析项目/角色、不重算 MCP、不注入角色段（角色段 **60 / 65 / 70 一并缺席**；65 与角色段同进同出，frozen 路径**不得**新增 `resolveRuntimeConfig` 调用） | `mekaResolvePlan.ts:407-524`（`resolveFrozenInjection`）、`:777-793`（分流） | 基线用例 2 条（resume 战斗 / 非战斗） |
| I5 | **WL-15**：战斗总控 Skill 只注入冻结正文的**绝对路径 + 必须先完整读完**，**绝不内联正文** | `mekaCombatPrompts.ts:55-91`（入口常量 `:55`、marker `:56`、函数 `:78`，只 `path.join(pluginPath, …)`）；路径授权 `mekaResolvePlan.ts:194-199` + `mekaApplyPlan.ts:96-100`；冻结路径形状门 `meka-projects/combatWorkflowPolicy.ts:1223`（`isMekaSkillSnapshotEntrypoint` 在 `:1223-1229`） | `mekaRuntimeInjection.test.ts` 的正向 + **反向**断言（正文不得出现）；详见 WL-15 |
| I6 | **非 Meka 会话零影响**：`workspaceKind !== 'meka'` 时 `didApply=false`、不注入任何 prompt 段、不写任何 Meka 键；唯一写入是**持久化绑定回填**（`:538-556` 读持久绑定，`:557-573` 只回填绑定后早返回），该副作用是现状 | `mekaResolvePlan.ts:525-589`；`index.ts:51-60`（plan 为 null ⇒ 空结果，零写入） | 基线用例 `writes nothing for a non-Meka session` |
| I7 | **注入不进入 maker-core**：Meka 注入只落在 `apps/desktop/src/main/`；maker-core 只以 `opts.nativeSkillPluginPath` / `vendorOptions` 消费者身份出现 | `packages/maker-core/src/agents/base-agent.ts:1850-1851`（类型）、`claude-code/index.ts:3327`、`codex/index.ts:4852` | 见 `architecture-invariants.md` §1 |
| I8 | **main 进程禁止运行时动态 `import()`**：本层依赖一律顶层静态 import | `meka-injection/**.ts` 全部为静态 import | 见 `architecture-invariants.md` §2 |

补充约束：

- 写入次序：同一路径内三个写入（快照 / prompt / vendorOptions）的**相对次序**与重构前一致
  （`mekaApplyPlan.ts:115-124`：常规创建是 **快照 → prompt → vendorOptions**；resume 短路是
  **vendorOptions → prompt → 快照**）。但 **`opts` 自身的键插入顺序不是契约**：resume 短路
  路径下重构前把快照写在早段 prompt 与尾段 controller prompt **之间**，新实现统一放到最后，
  因此 `Object.keys(opts)` 在「只有 controller 段会写 prompt」这类输入下与重构前不同
  （新：`userPrompt → nativeSkillPluginPath → nativeSkillRevision`；旧：
  `nativeSkillPluginPath → nativeSkillRevision → userPrompt`）。**该差异不可观测**：全仓没有
  任何代码枚举 `opts` 的键（只有 `{...opts}` 扩散与命名字段访问），真正常用的是
  `opts.vendorOptions` 自己的键序（I2）。现状由基线用例显式钉住，见 §7 D2.2。
- 同一批段落里 `id` 必须唯一：`renderMekaPromptSegments`（`mekaApplyPlan.ts:55-80`）做只读断言，重复即抛。
  理由：`order` 并列时 `sort` 稳定（保持 push 次序 = 后者靠后），而重构前的 prepend 语义是
  「后 prepend 者靠前」——两者方向相反，于是重复 id 会静默反转整组段落次序。
- 段落拼接等价于原 `prependPromptSection`：`trim` + 丢空段 + `\n\n` 连接；全空则**不写**
  `opts.userPrompt`（保持调用方原值，含空白）。
- 解析层用 `createPlanBuilder`（`mekaResolvePlan.ts:115-133`）在解析期模拟「已 prepend 的 prompt」，
  以便 `hasMarker` 去重 guard 与重构前判定一致（含角色正文恰好含某 marker 的极端情况）。

- **「正文不内联」的边界必须限定在元数据通道（2026-09-23）**：本次改为引用投递的只有
  `agents-md` / `rule` **元数据**（`projectMetadataSelection`）；**`roleDefaults.rules[].text`
  仍有内联通道**，且是**刻意的显式例外**——它属「角色默认提示词」而不是 `rule` 元数据，
  由 `mergeMekaProjectRoleDefaults`（`runtimeConfig.ts` 的 `framework` 合并式在函数体末，
  **符号名定位**）并入 `roleFile.rules`，
  再在 `:938-940` 逐条 `prompts.push(rule.text.trim())` 进 **order 70**。宣称「零规范正文内联」
  时必须带上这条限定，否则默认角色（`useProjectDefaults: true`）一旦承接项目 `roleDefaults.rules`
  就与文档矛盾。
- **`includeAllBundledSkills` 只改选择集，不进 prompt**：展开点 `resolveBundledSkillSelections`
  （`runtimeConfig.ts`，**符号名定位**；三开关门与 catalog 铺底是它的唯一展开点）把 catalog 的
  skill id 铺进 `skills` 选择集，技能 **id 清单与正文
  都不写进 `prompts`**（harness 原生 catalog 已承载 name／description）。同一函数被运行期与面板
  读清单（`localDb/ipc/mekaRoles.ts:213-243`）共用，**禁止第二套展开逻辑**。

- **测试数据的平台可移植性（不得回退）**：`mekaRuntimeInjectionBaseline.test.ts` 与
  `mekaRuntimeInjection.test.ts` 里的 SAGA2 项目路径**必须从模块级基准根推导**
  （`path.resolve` / `path.join`），不得写死 `C:\Workspace\…` 字面量 —— 实现用的是
  `path.resolve`，Linux 上写死的 Windows 路径不可能匹配，而这些文件在 `ubuntu-latest`
  的 Linux unit shards 上会跑。辅助函数 `saga2ProjectPaths()` / `combatProjectPathsSection()`
  必须与 `meka-injection/mekaCombatPrompts.ts` 的 `combatProjectPathsPrompt` 同形。
  同一类修复已覆盖 `meka-projects/__tests__/combatWorkflowPolicy.test.ts`；登记与验证证据见
  [`../migrations/xdmaker-meka-to-cindy.md`](../migrations/xdmaker-meka-to-cindy.md) §6.49。

### 5.1 请求范围与技能 ID 的判定规则（D4／D5，2026-09-22）

判定发生在**任何工具调用之前**，且**用户标注的技能 ID 优先于表范围检测**——顺序本身就是一条风险：
被误绑的 ID 会抢在 `detectCombatTableScope` 之前把表范围整个吞掉（真会话里
「把怪物配置表里正在使用的技能10000的data都改成…」曾因此变成 `single-skill/confirmed`）。

**技能 ID 的两个标注分支必须对称**（`mekaCombatPrompts.ts` 的 `COMBAT_USER_LABELLED_SKILL_ID_PATTERNS`，
`:374-417`）：数字在 `技能` 之后的 `:407`，数字在
`技能` 之前的 `:410`。两侧都用**上下文名词**做负向断言——尾部 `(?!…表|参数|模块|data|节点|伤害行为)`
加单位词，前导 `(?<!…data|节点|伤害行为|参数|模块|表)`。单位词一支（段/级/次…）另见 A9。

**两条「用户逐个点名两个 ID」的写法**（`:415`、`:416`）落在 `single-skill/ambiguous` 并把**两个 ID
都登记**（`scanCombatSkillIds` 必须遍历全部捕获组，否则后一个会静默丢失）。两侧各需 ≥3 位，故
「技能 19 和 20」这类两位 ID 不进歧义分支、退回缺 ID 追问（fail-closed）。

**「把／将…都改成」不是独立检测器，只是 booster**（`:463-472`：`COMBAT_TABLE_SCOPE_BOOSTER_PATTERNS`
`:463-465` + 必须共现的 `COMBAT_TABLE_SCOPE_SOURCE_MARKER_PATTERN` `:471-472`）：该形状与「单技能内的
批量数值改动」完全同形，独立成检测器会把 `把伤害数值都改成0.5` 判成表范围，而表范围正文又禁止向用户
追问技能 ID ⇒ 两个流程互相踢皮球。现在它必须与**范围来源标记**（表/清单/某类/每类/范围…）共现才成立。

**刻意不做的两件事**（改动时不得「优化」回来）：

- **不维护 `moduleType` 取值清单**：正本在注入的项目参考里，`combat-skill-configuration/SKILL.md` 明确
  「不重复枚举」；客户端再存一份必然与正本脱钩。
- **不用位数猜**（「4 位以上只给 `proposed`」）：技能 ID 只要求正整数，5 位 ID 合法；且当前分类器
  **没有** `single-skill + proposed` 生产者，新增必须同时改 `mekaInjectionTypes.ts` 与
  `mekaResolvePlan.ts` 的映射。

**已登记的 fail-closed 代价**：`技能<N>的data` / `技能<N>的节点` 这类「技能 N 的〈模块字段〉」句式
**连 N 一起不绑定**，用户会被再问一次 ID。宁可多问一次，不得把唯一的技能 ID 硬绑定到 `moduleType`／
节点数上。

**红线的唯一豁免**：`技能#7`、`技能 ID 1019` 这类**用户自己写出数字并加标注**的形态仍是 `confirmed`——
数字来自用户而非启发式推断，不在「启发式不得产生 `confirmed`」的范围内。I1 的逐字节基线不受本节影响：
检测器只改分类与绑定，不动任何注入段文本（`mekaRuntimeInjectionBaseline.test.ts` 一行未改、18 条全绿）。
> **W25 批次追加标注（2026-09-23，只追加不改原句）**：这句里的「18 条」是**当轮**的规模；
> 该文件**当前为 28 条**（10 + 8 + 10，见 §6 计数口径）。「一行未改」也只对当轮成立 ——
> 该文件此后已新增 order 65 组的用例（原有的 10 条逐字节期望仍一个字符未改）。

**验证现状（2026-09-22）**：`pnpm --filter desktop run typecheck` exit 0；`mekaRuntimeInjection` +
`mekaRuntimeInjectionBaseline` + `combatWorkflowPolicy` = 125 passed；相关面 18 文件 305 passed \| 1 skipped。
负例全集（`-101 技能表参数1`、`+100技能`、`1.5技能`、`技能 3 段`、`技能 2 级`、裸 `0`、`伤害 100，重复 3 次`、
全角数字、`把所有怪物技能的伤害行为10000的data都改成…`）与表范围反向守卫均为实测；红→绿用源码反向还原
并以 SHA256 校验还原一致。**未实机验证**：真实 SAGA2 工作区的「表范围确认 → 逐目标导出 → 写入」全链路。

### 5.2 写入门禁的三层：范围绑定、命令面白名单、写后对账（D1／D3／D2，2026-09-22）

三层都在 `meka-projects/combatWorkflowPolicy.ts`，且**只有第一、二层原本存在**；第三层是本轮补的。

**① 范围绑定（D1）**：`explicitCombatSkillIds` 会从 `<tmp>/1019.import.json` 这类 **JSON 文件名**里也收到
ID，所以「请求里另有范围内 ID」不构成任何豁免。`mismatched.length > 0` 一律拒绝（`:464`），并且老版模块
命令必须**恰好携带一个** ID 且该 ID 在已确认范围内（`:477-479`：非 `withoutList` 时要求
`explicitIds.length === 1 && approvedExplicitIds.length === 1`）。`withoutList`（已批准但清单被截断／未登记）
那一支**保持原样**：只要求恰好一个显式 ID、不做成员资格比对——这是登记过的折中，不得收紧。

**② 命令面白名单（D3）**：`legacyModuleWriteCommandReason`（`:654`）只放行 `legacy_module_import_json`
（唯一登记写入）、`legacy_module_export_json`（目标取证读）与 Host 注入的 `mekaCombatReadOnlyUnityCommands`；
其余 `legacy_module_*` 一律拒绝。典型被拒者是 `legacy_module_migrate_layers`——它遍历**全部**模块资产、
不携带 `skill_id`，范围门禁无从检查。命令解析必须**通道无关**（`:589`／`:630`：同时认 `ghost_call`、
既有直传形态、以及 `meka-runtime-mcp` 的 `{name, args}` 形态；后者下既有 `mcpToolArguments` 解不出命令，
依赖它的门禁会**静默失效**）。门禁调用点 `:2463` 放在首证据门禁**之后**，以免改变既有拒绝理由的优先级。

**③ 写后对账（D2，Host 强制）**：`legacy_module_import_json` 是 `clear_existing=true` 的**全量替换**，而
回执里的 `importedNodeCount` 只是 payload 自己的节点数，**永远等于 payload 的节点数**；Host 唯一能拿来对账
的材料是**写入前**那次结构化导出的 `exportedNodeCount`。此前没有任何门禁读回执，所以丢节点的导入会返回
`success:true` 并通过全部检查。现行契约：

- 状态 `:53-63`：每会话 `{ skillId, baselineNodeCount, importedNodeCount, readBackNodeCount?, status }`，
  外加每 `(session, skill)` 的导出节点数基线表。
- 回执解析 `:694-788`：**宽容递归扫描**工具结果（含 MCP `content[].text` 里的 JSON 文本、ghost 的
  `{ok, result}`、`data` 嵌套与内联 `legacyModuleExport/Import.payload`），认 `exportedNodeCount` /
  `importedNodeCount` 及 snake_case 变体。取不到数值就是 `null`——**绝不编造**。
- `observeCombatLegacyModuleResult`（`:820`）：成功导出回执 ⇒ 记基线（并顺带结算回读）；成功导入回执 ⇒
  与基线比对，一致则不产生义务，**不一致／缺基线／数值不可解析** ⇒ 进入「必须结构化回读」。
  `settleCombatModuleReadBack`（`:790`）在回读值等于导入值时才结清。
- `combatModuleWriteReconciliationReason`（`:876`）：义务未结清时，**除同一技能的一次
  `legacy_module_export_json` 回读（或同一技能的重新导入）外的一切调用**都被拒；理由带技能 ID、写入前
  基线、导入回执值，并明说「回读完成前不得推进其它读取、P4 写入、下一个目标或收尾，也不得把这次导入当作
  无损成功上报」。
- 接入点：**MCP `:2383` 与 Shell `:1976` 两侧都要有**（少了 Shell 侧，模型可用 Shell 绕过「先回读」）；
  基线只在**传输成功**路径建立（`ghost.ts:2366`、`meka-runtime-mcp.ts:1350`），
  `markCombatTargetExportAttempted/Completed` **不产生**基线。

**Host 强制 vs 仍由模型承担的切分（不得含混）**：Host 强制 ①导入与写入前导出节点数必须一致，否则整轮除回读
外全被拦；②缺基线或回执不可解析时**不伪造通过**，同样要求回读；③回读与导入不一致时持续拦截并给出两边数值。
**仍由模型承担**：最终文字 `[SAGA2_COMBAT_CONFIG_RESULT]` 没有 Host 门禁（模型可以选择只回一句话收尾，
Host 只能掐掉它继续做其它事的一切工具通道）；任一侧回执取不到数值时，Host 只能证明「按要求做了结构化回读」，
节点数的**语义**比对仍靠模型与 SKILL 正文。**有界 trade-off**：对账义务绑定当前目标代次，显式切换目标
（`refreshCombatTargetBinding` / `invalidateCombatTargetBinding`）会一并作废旧义务——否则会与目标门禁互相死锁。

**D6／D7 的镜像还原**：镜像与实时 `vendorOptions` 分裂时，续聊口子会用镜像注入「范围已批准」而策略读实时状态
走单技能分支并拒绝一切工具（同一轮两条互相矛盾的指令）。修法是**只还原纯注入语义键**
（`COMBAT_SCOPE_STATE_RESTORE_KEYS`，`:129-135`：requestScope／requestScopeState／scopeSelection／
scopeSourceTables／scopeApproved），在续聊口子**之前**写回实时 Session（`register.ts:12672-12676`）。**刻意不做整份
镜像写回**：策略层会**就地**扩展 `mekaCombatScopeSkillIds` / `…Environment*` / `…TargetExport*`，回写会让成员
清单缩水、削弱 A4 门禁。D7 把 `forgetCombatVendorOptions` 接进会话关闭生命周期（`register.ts:4613`），判据是
`closeReason === 'requested'` **且**不在 rehydrate 抑制窗口内（`agent-switch`／`runtime-refresh` 是重建、
`unexpected` 之后 Host 会补发「继续」，这三种都必须留镜像，否则 D6 的还原没有来源）。镜像仍不过进程重启。

**D8 卡片答案的范围审批（2026-09-22，真实会话缺陷）**：范围审批原本**只**由用户手打的聊天消息驱动
（`input.prompt` → `combatRequestScopeApprovalPatch`），而 `ask_user_question` 的卡片答案是**另一条通道**
（renderer → `RESOLVE_INTERACTION` → `register.ts` 的 `resolvePendingInteraction`），门禁因此**永远看不到
那次确认**。真实会话 `6811f297-9e32-4d8d-b5d0-0e2be39184b4`（「怪物技能伤害改取攻击力」）：Agent 只读解析出
范围、用卡片请用户确认，用户**确实点了**确认项（`确认：只改这 15 个伤害节点，技能表参数先不动`），但
`mekaCombatScopeApproved` 从未被写入 ⇒ 策略层继续按「本轮是表范围请求…（尚未确认任何技能）」拒掉每一次调用，
**连门禁自己要求的那两次 `legacy_module_export_json` 也被拒**；该会话里用户**全程只发过最初那一条聊天
消息**，Agent 没有任何办法让那次确认生效，只能结束回合请用户把同一句话再打一遍。同批另一个真实战斗会话
`a262a888-9db2-45cf-9741-e1463806481b` 也命中同一形态（2 / 2）。

修法：`register.ts:2846-2887` 在 `resolvePendingInteraction` 里、紧跟既有的 `goalAskAnswerObserver` 块
（同一处 resolve 收口、同一套 catch 口径，不改动已 resolve 的交互语义）追加卡片答案观察者——从
`readCombatVendorOptions(resolver.sessionId)` 取会话现状，逐个答案求
`combatRequestScopeAnswerApprovalPatch`，命中即 `rememberCombatVendorOptions` **并**把同一份补丁写进实时
Session。用模块级 `getMakerIfReady()?.getSession(...)` 而不是 `maker`：`resolvePendingInteraction` 是模块级
函数，`maker` 不在它的作用域里。判定与前提全在注入层，这里不推断、也不代表 Agent 批准（`dismissed` 先被
排除）。

**同一轮可见性（核实过，不是假设）**：策略层读的是 `context.vendorOptions`，即 codex MCP 上下文按**引用**
持有的那个 `vo` 对象（`packages/maker-core/src/agents/codex/index.ts:5422`），引用同一由
`packages/maker-core/src/agents/codex/index.test.ts:20343-20373` 的
`expect(secondCtx?.vendorOptions).toBe(firstCtx?.vendorOptions)` 钉住（`:20366`）。`Session.setVendorOptions`
虽声明为 async，但三个 runtime 都在**第一个 `await` 之前**就地 `Object.assign` 到该对象上
（codex `index.ts:13930-13941`、claude-code `index.ts:7015-7025`、pi `index.ts:7225-7230`），且
`resolver.resolve(decision)` 先于该块执行 ⇒ 同一轮没有竞态，fire-and-forget 调用也已同步生效。
`[SAGA2_COMBAT_SCOPE]` 未批准分支的正文（`mekaCombatPrompts.ts:174`）同步写明：以肯定词开头的卡片答案
**就是**确认、Host 会**即时**登记、不得要求用户把同一句话重打一遍，也不得因为该段是在提问**之前**渲染的
（`scopeApproved` 仍读 false）就重复追问同一件事。

**D8 的登记边界（不是 bug，但必须一起读）**：① 多问题卡片只要**任一**答案文本以肯定词开头就能批准——
问题文本不过滤，与聊天路径同样的松度；② `getMakerIfReady()` 在 resolve 时取不到实时会话时**只写镜像**，
同一轮可见性顺延到下一次派发（镜像本身仍然成立，符合 A3 的口径）；③ 每 runtime「同步就地合并」是**源码
阅读**结论（`Object.assign` 早于首个 await），没有一条集成用例把它钉死；④ 首词启发式对畸形输入 fail-closed
（`No problem` 会被当成拒绝），词表与聊天路径**同一份**中文／英文清单，不额外扩表。

**验证现状（2026-09-22）**：`pnpm --filter desktop run typecheck` exit 0；`mekaRuntimeInjection` 49 +
`mekaRuntimeInjectionBaseline` 18 + `combatWorkflowPolicy` 60 + `combatServerCapabilityState` 7 = 134 passed；
`sessionEventPipeline` + `runtimeConfig.integration` = 100 passed；`ghostWorkdirGate` + `meka-runtime-mcp` +
`mcpRegistration` = 210 passed。各层均有红→绿证据（D1／D2／D3 各自的用例把对应门禁临时失效即转红）。
**未实机验证**：D2 依赖回执字段名，依据是 `combat-skill-configuration/SKILL.md` 的协议契约与迁移总账；
真实 meka-unity 结果封套的确切嵌套无法在本仓核验，故解析器刻意宽容、取不到即诚实回落「无基线 ⇒ 要求回读」。
**建议真机跑一次「导出 → 导入 → 导出」确认基线被记录。**

## 6. 验证方式

**逐字节基线（提交 1，在本层落地前抓取）**：
`apps/desktop/src/main/maker-ipc/__tests__/mekaRuntimeInjectionBaseline.test.ts`，
**前 10 条用例**，覆盖：

1. 新建非战斗角色（`pins the new-session non-combat injection byte for byte`）
2. 新建战斗角色、无绑定技能 ID
3. 新建战斗角色、已确认技能 ID
4. 新建战斗角色、两个技能 ID 歧义
5. 服务器目标 unavailable
6. resume 短路（已解析的**战斗**会话）
7. resume 短路（已解析的**非战斗**会话）
8. `isCombatServerWorker` 分支
9. 非 Meka 会话（断言**零写入**）
10. 注入段落集合的 order 严格升序且与基线一致

这些断言是在**未改动** `mekaRuntimeInjection.ts` 时捕获的现状快照，逐字段钉住
`opts.userPrompt` 全文、`opts.vendorOptions` 全量键值（含键顺序）与
`nativeSkillPluginPath` / `nativeSkillRevision`。**本层重构不得改这些用例一个字符。**

**重构后追加的用例（同一文件，共 8 条；§7 的有意差异靠它们钉住）**：

11. **一组 2 条**（`it.each`）：非字符串 `userPrompt` 的 Meka 战斗会话（新建 / resume 两条路径）
    ⇒ 显式 `INVALID_PARAMS`，且校验发生在任何 I/O 与任何 opts 写入之前（D2.1）
12. 非字符串 `userPrompt` 的非 Meka 会话 ⇒ 仍然零写入、零抛错（I6）
13. resume 短路 + 战斗 + 只有 controller 段写 prompt ⇒ `Object.keys(opts)` 新增键顺序（D2.2）
14. frozen + 战斗 + 带 target 补丁且 `vendorOptions` 已有键 ⇒ `Object.keys(opts.vendorOptions)` 键序
15. **一组 3 条**（`it.each`）：解析 / 物化抛错 ⇒ **opts 零写入**（键序、键集合、`vendorOptions`
    对象引用与原文全部不变）（D2.3）

这 4 组共 8 条钉的是**重构后声明过的行为**（§7），不是重构前的现状快照；改动它们必须先改 §7 的
结论，不得当作「基线漂移」直接更新。

**2026-09-23 追加的第 5 组（同一文件，共 10 条）**：

16. `describe('meka project references segment (order 65)')` —— **8 条 `it` + 1 组 `it.each`
    （展开为 2 条）= 10 条**，钉住 §7 **D2.4** 新声明的行为：非空集合逐字渲染（段文本从
    `mekaCombatPrompts.ts` 的构建器取，不在测试里另抄一份）、段位置 `60 < 65 < 70` 且只出现一次、
    空集合整段不渲染、`scope === ''` 渲染为 `(项目根)`、输入顺序不重排不去重（排序是生产方的职责）、
    **参考正文绝不内联的负向断言**、order 表逐档 `toEqual` 且严格升序（既有 9 档既未改值也未重排）、
    以及 frozen / resume 短路下「不注入该段、且 60 / 70 同时缺席」的同进同出证据（战斗 frozen 一支
    以战斗段在场反证「缺席不是因为整条路径没跑」）。

**当前该文件共 28 条用例（10 + 8 + 10）。**

> **计数口径（2026-09-23 W25 批次终核，按文件实际复核，不沿用任何旧数字）**：
> `mekaRuntimeInjectionBaseline.test.ts` 的前 10 条是逐个 `it`；「重构后追加」组 = `it.each` 2 条
> （第 11 组，非字符串 `userPrompt`：新建 / resume）+ 第 12 组 1 条 + 第 13 组 1 条 + 第 14 组 1 条
> + `it.each` 3 条（第 15 组，解析／物化抛错）；第 16 组 = 8 个 `it` + `it.each` 2 条 = 10 条。
> 合计 **10 + 8 + 10 = 28**。`it.each` 的展开条数按各自的用例数组逐项数出，不是按 `it(` 字面出现次数
> 计（该文件 `it(` 字面只有 21 处逐个 `it` + 3 组 `it.each`）——旧文档里的「18 条（10 + 8）」是
> 第 16 组落地前的数字，「27 条（10 + 8 + 9）」是 W25 重数前的数字（第 16 组当时只有 7 个 `it`）。

> **2026-09-22 的期望值更新（不增删用例）**：本批交付改了 `[SAGA2_PROJECT_PATHS]` 的正文（新增
> `moduleEditorSkillPath` / `damageEncodingRulePath` 两条路径与四条 `…ReadCommand`，并给 Shell
> ReadCommand 补上 `-Encoding UTF8`），因此基线文件里覆盖该段的期望文本随实现更新：辅助函数
> `combatProjectPathsSection()` 改为与 `combatProjectPathsPrompt` 同形（含 CJK 目录逐字与编码参数）。
> 用例条数不变，前 10 条的**集合与字段**也没变，变的是被注入正文本身。
>
> **2026-09-23 的期望值更新（用例已同步，门禁待跑）**：默认角色由「零注入」改为「出厂全量」，
> 并新增 order 65 段、把 `agents-md` / `rule` 从内联改为引用（§7 **D2.4**）。本批**没有改注入层
> 基线的逐字节期望**：唯一改动是给 `runtime()` 夹具补上新必填字段 `projectReferences: []`，
> 空集合 ⇒ order 65 段不渲染 ⇒ 前 10 条逐字节用例的期望文本**一个字符未改**（因此
> `meka-injection-layer.md` §7 的 R5 门槛**未被触发** —— 本批是「新增段 + 角色样本期望值更新」，
> 不是「既有段文本变化」）。新增的 9 条全部落在第 16 组（**W25 批次终核：该组此后又增 1 条 ⇒
> 10 条，本文件合计 28 条；原有 10 条逐字节期望仍一个字符未改**）。同一批还给
> `mekaRuntimeInjection.test.ts` 补了**两条**用例（**订正：原先写「一条」，实际是两条**，> `git diff` 实测新增两个 `it(`）——① `resolves the legacy-role fallback target through the real
> runtime resolver`：走真实 `resolveMekaRuntimeConfig` 的历史四角色兜底用例
> （持久行 `mekaRoleId: null` + 遗留角色列 ⇒ 断言派生目标 = `mekaDefaultRoleId('saga2')` 且真的解析出
> 角色 prompt，避免 fake resolver 用例「派生 id 对了但生产解析不出来」的假绿）；
> ② `mounts the platform skills exactly once when a role already selects the same id`：
> **平台技能同 id 只挂一次**（角色显式选择集与平台基线出现同一 skill id 时不得重复挂载）。
> **同批的 `scripts/meka-session-smoke.mjs` 也已按新契约更新**（含 WL-11.6 的新反向断言）。
> **本批没有跑任何门禁**，所以上述一切都还是**待实跑**（未验证），不得当作已通过。

**定向门禁**：

```bash
pnpm --filter desktop exec vitest run src/main/meka-injection src/main/maker-ipc/__tests__/mekaRuntimeInjectionBaseline.test.ts src/main/maker-ipc/__tests__/mekaRuntimeInjection.test.ts
```

- `meka-injection/__tests__/agentMatrix.test.ts`（4 用例）与
  `meka-injection/__tests__/mcpRegistration.test.ts`（12 用例）覆盖矩阵穷尽性、三层冻结、
  Pi 两列 `true` 的断言（原 D1 的 Pi `false` 断言已随 2026-09-22 能力补齐翻转）、漏传硬失败、
  声明与矩阵矛盾硬失败，以及 maker-host 接线契约。
  接线断言按**调用形状**匹配（先剥注释再归一化空白）并逐一要求三个 `_mcpProviders[*]`
  赋值都先于注册点，不再依赖单行精确字面量；它仍是**源码级、非行为级**判据。
- `meka-whitelist-verification.md` 的 **WL-16** 是本文的清单落点；改动本层必须同一次交付里
  更新 WL-16。**能力矩阵两列（`skillSnapshot` / `runtimeMcp`）另由 WL-18 保护**——
  翻转任何一列都必须同一次交付里更新 WL-18（2026-09-22 Pi 补齐时新增）。

## 7. 与重构前的有意差异（D2）

本节登记本层**明知且有意**偏离重构前行为的条目。除本节列出的条目外，本层必须与重构前
逐字段等价（I1–I8）。

| # | 项目 | 重构前 | 重构后 | 理由 | 门禁 |
| --- | --- | --- | --- | --- | --- |
| D2.1 | 非字符串 `opts.userPrompt`（如 `123`） | 分三种情形：①战斗工作流走到 `(opts.userPrompt ?? '').includes(marker)` 的 guard 时抛 `TypeError: ....includes is not a function`（**无错误码**，原 `mekaRuntimeInjection.ts:400,461,479,483`）；②新建非战斗会话不跑 guard，但 `prependPromptSection` 把非字符串当空串 ⇒ `123` 被静默**丢弃**（注入照常完成）；③resume 非战斗会话不写任何 prompt ⇒ `123` 原样**透传**给下游 | 所有 Meka 路径（新建 / resume、战斗 / 非战斗）都抛 `INVALID_PARAMS`：`Meka session userPrompt must be a string when provided` | IPC 是无类型边界（`readCreateSessionOpts` 不校验 `userPrompt`），三种旧结果都不可接受：①不可辨，②静默丢用户输入，③把脏值写进会话 | 基线用例第 11 / 12 组 |
| D2.2 | resume 短路下 `opts` 键插入顺序 | 快照键夹在早段 prompt 与尾段 controller prompt **之间**：`nativeSkillPluginPath → nativeSkillRevision → userPrompt`（原 `mekaRuntimeInjection.ts:501-502` 早于 `:505` 的 `injectCombatControllerSkill`） | 统一放到最后：`userPrompt → nativeSkillPluginPath → nativeSkillRevision` | 落地阶段按「vendorOptions → prompt → 快照」统一收敛，不再在一条路径上按段落写入阶段切分写入次序 | 基线用例第 13 组（**不可观测**，仅锁现状） |
| D2.3 | **解析／物化抛错时的写入语义：增量 → 原子** | 逐阶段就地写 opts：持久绑定一读到就写（原 `:526-529`）、resume 短路的 `vendorOptions` 补丁与早段 prompt 也在快照物化**之前**写（原 `:449-486`），因此中途抛错会留下「半个注入结果」（例如 `resolveRuntimeConfig` 抛错时绑定键已写、`materializeSkillSnapshot` 抛错时 prompt 段已拼好） | 所有 opts 写入只在 `applyMekaInjection` 落地 ⇒ **抛错时 opts 与调用前逐字节一致**（键集合、键序、`vendorOptions` 对象引用、原始 prompt 全不变） | 解析／落地分层的定义就是「I/O 与写入分开」；恢复增量写等于把两者重新交织回去，会推翻本层结构。失败路径上没有任何消费者读这些半成品：错误码／文案照旧抛出、不返回 result、不会建出会话 | 基线用例第 15 组（3 例）；成功路径的等价性由 10 条快照用例 + 差分验证兜底（下表注） |
| D2.4 | **默认角色的注入语义** + **规范类元数据（`agents-md` / `rule`）的交付形态**（2026-09-23） | 默认角色（`<projectId>-default-role`）manifest 全空、`useProjectDefaults` / `includeAllProjectMetadata` 均未设置 ⇒ **零角色级注入**（「最接近新建一个普通会话」）；`agents-md` / `rule` 的**正文**由 `prompts.push(content.trim())` 直接**内联进角色 prompt（order 70）** | 默认角色**出厂即全量**：`useProjectDefaults: true` + `includeAllProjectMetadata: true` + **`includeAllBundledSkills: true`**（本次新增的第三个通用开关，`resources/meka/skills/**` 扫到的**全部**内置 catalog skill 纳入该角色，与 `includeAllProjectMetadata` 同构）+ 三段行为契约 prompt（承接已退役「通用开发」的 prompt，**删掉其中面向 SAGA2 战斗流程升级的整段**）；`policyProviderRefs` 取原通用开发的两条，**并恢复原通用开发显式 pin 的 `meka-design` MCP**（`mcp: [{ id: 'meka-design', providerId: 'meka-design', enabled: true }]` —— 项目侧推不出这条 provider，必须显式声明）；`skills` / `rules` / `promptFragments` / `projectMetadataSelection` 的显式列表**刻意留空**（避免两套来源漂移，`skills` 的空是「靠 `includeAllBundledSkills` 铺底」而不是「没有技能」）；**不带 `workflow`**、**不注入任何战斗 promptFragments**。第三个开关的**理由**：退役的 `general-development` 曾**显式 pin 3 个内置 skill + `meka-design`**，「出厂全量」若不含 catalog 全量就会**静默丢掉那部分能力面**（`p4-operations` / `orca-coordination` / `safety-boundaries` / `meka-design-handbook` 等未被项目元数据覆盖的内置 skill）。`agents-md` / `rule` 一律**不再内联**，改为 `MekaRuntimeConfig.projectReferences`（`MekaProjectReference{ scope, path, description, itemType }`，**正文刻意不在其中**），由**新增段** `meka.project-references`（**order 65**、marker `[MEKA_PROJECT_REFERENCES]`）投递「**作用范围 \| 绝对路径 \| 描述**」清单，正文由 Agent 在工作涉及该目录时用原生 read 工具按需读取 | 内联正文会把**最常见角色**（新建 Meka 会话的默认选中项）的 system 前缀推到 Pi 的 argv 预算之外：win32 预算 `30_000` 字符，实测某真实项目 6 条 `agents-md` 正文合计 **95,418 B**（该样本 `promptText` ≈42,600 字符 ⇒ 引用化后 ≈4,900 字符），而超限报文指向「项目里 Pi skills 太多」（`pi-harness.md` §4 不变量 12 / WL-15）。技能侧在 Claude/Codex 早已是「只给地址」，规范侧是本次补齐的靶心；描述必须**确定性**产出（模型生成会让 `promptText` 非确定，破坏前缀稳定性与缓存率） | **待跑门禁（尚未实跑）**：注入层基线/注入用例的期望**已同步**（基线只给 `runtime()` 夹具补了新必填字段 `projectReferences: []` ⇒ 前 10 条逐字节期望**一个字符未改**，既有段文本**没有**变化，因此 R5 的门槛**未被触发**；新增 9 条落在 §6 第 16 组（**W25 终核：该组现为 10 条，本文件合计 28 条**）），但 `pnpm desktop:session-smoke` 与定向 vitest **都还没跑**；新的不变量口径登记在 WL-11.10（重写）与 WL-11.17（新增） |

**D2.4 的边界（必须一起读）**：

- **只在 bootstrap 路径注入 order 65**。`resolveFrozenInjection`（resume 短路）**不注入该段** ——
  它与角色段 60 / 70 **同进同出**（I4：resume 不重解析项目/角色），禁止为了 resume 注入而在
  frozen 路径上新增 `resolveRuntimeConfig` 调用。
- **空集合 ⇒ 整段不渲染**（`mekaProjectReferencesPrompt` 返回 null ⇒ 不入 plan），与
  「`meka.role-prompt` 文本为空不入 plan」同口径。渲染顺序 = `scope` 升序 → `path` 升序
  （确定性 ⇒ 前缀稳定）；`scope === ''` 渲染为 `(项目根)`。
- **段文本常量唯一来源**是 `mekaCombatPrompts.ts` 的 `mekaProjectReferencesPrompt`
  （`mekaResolvePlan.ts` 只负责推入），测试与文档共用同一份模板，不得在别处再拼一遍。
- **描述有两个确定性来源**：扫描期产出（frontmatter `description` → frontmatter `title` →
  正文首个**结构元素** —— 先出现的 ATX 标题，或先出现的非空段落取其首句；段落先出现时其后的标题
  不顶掉它，见 `metadataScanner.ts` 的 `probeReferenceBody`；折叠空白并 ≤300 字符），运行期再按
  `description → displayName → name → 相对 sourcePath` 兜底并同样有界化。
  **绝不由模型生成**。
- 远端服务器 Worker 分支（`isCombatServerWorker`）**不注入任何角色段**，65 与 60 / 70 一起被排除。
- **① 段文本的最终形态（order 65）**：`mekaProjectReferencesPrompt`（`mekaCombatPrompts.ts:344-362`）
  返回 **6 + N 行** —— marker 行、**两条独立成行的读取规则句**（之间恰好一个 `\n`，不是排版折行）、
  格式行、每条参考一行 `- <scope> | <绝对路径> | <描述>`、末行**禁止句**、闭合 marker。
  `scope === ''` 渲染为 `(项目根)`；**空集合返回 null ⇒ 整段不入 plan**。
  **禁止句的边界（本次修正，重要）**：末行只约束**规范文件**（`AGENTS.md` / `.cursorrules` /
  `rules.md`），**技能正文 `SKILL.md` 不受限** —— 技能走 harness 原生 catalog、正文必须按需读取，
  把 `SKILL.md` 也圈进禁止句等于与技能通道自相矛盾。初版是从 WL-15 的「只读我给你的这一份冻结正文
  ⇒ 不要读**其它** `SKILL.md`」语境直接搬运、语义被放大，本次在段文本里显式写成
  「技能正文（SKILL.md）按技能目录正常按需读取」。
- **② 战斗 workflow 的规范类元数据仍内联（有意差异 F3）**：
  `roleFile.workflow === 'saga2-combat-development-v1'` 的角色，`agents-md` / `rule` 照旧
  `prompts.push(content.trim())` 进 **order 70**、**不产出 `projectReferences`**，order 65 因此拿到
  空集合（段 65 空集不渲染）。**理由**：战斗会话的项目参考路径是一套**封闭且精确**的白名单契约
  （`[SAGA2_PROJECT_PATHS]` 逐条给 ReadCommand，同一份解析结果写进
  `vendorOptions.mekaCombatProjectRefPaths` 供策略层精确放行），而策略层会**拒绝**读取工作区根
  `AGENTS.md`（只放行已知的 `saga2_unity/AGENTS.md`）；再叠加一段「必须读取这些路径」的开放清单
  会让指令与 Host 策略正面冲突。**代价（必须说清）**：战斗角色若勾选了**大体积** `AGENTS.md`，
  内联后仍可能逼近 Pi 的 argv 预算（win32 30,000 字符）—— 本次**没有**为战斗角色加体积安全阀。
- **③ `roleDefaults.rules[].text` 仍是内联通道（显式例外）**：属「角色默认提示词」而非 `rule`
  元数据，`mergeMekaProjectRoleDefaults`（`runtimeConfig.ts`，**符号名定位**）合并后在 `:938-940` 内联进
  **order 70**。因此本层对外的准确说法是「**元数据通道零规范正文内联**」，不是「零规范正文内联」。
- **④ F1 容错边界（故意的，反直觉）**：默认角色的 `includeAllProjectMetadata: true` 让项目
  **全部 enabled 元数据**进入解析漏斗，因此 `runtimeConfig.ts` 的元数据循环 `catch`
  （**符号名定位**；本次核对在 `:1120-1135`）把失败半径收窄为——
  **仅由全量展开而来的项**解析失败（如 frontmatter 非法的 `SKILL.md`、声明不全的 `.mcp.json`）
  ⇒ `log.warn` + **跳过**；**角色清单或项目 `roleDefaults.projectMetadataSelection` 显式选择的项**
  ⇒ **仍然抛错（fail-closed 不放宽）**。**任何来源都抛**的仍是：`rootPath` 不在允许根、
  `..` 逃逸、未知 `itemType`（`runtimeConfig.ts`，**符号名定位**；本次核对
  `itemType` 穷尽性 `:1022-1031`、路径分流 `:1037-1049`，校验在容错边界之外）。
  **原失败模式**：项目里一个坏文件会让该项目的**所有新建会话**创建失败（默认角色是新会话默认选中项），
  这是刻意的容错边界，不是漏做的 fail-closed。
  **2026-09-23 第二批补充两条同口径的失败半径**（详见迁移总账 §11.27 B2）：
  ① 全量展开项的 `rootPath` 不在允许根 ⇒ 原先抛错，现仅对**全量展开项** `log.warn` + 跳过，
  **作者显式选择仍 fail-closed**；`..` 逃逸与未知 `itemType` **对任何来源都仍抛**（红线未放宽）。
  ② 技能快照物化：`collectSkillFiles`（`meka-projects/skillSnapshot.ts`）现复用扫描器的排除目录名单，
  且**仅对派生（非作者显式选择）的 skill** 在收集失败时 `log.warn` + **跳过该 skill**，
  显式选择仍抛错。
- **⑤ F5 `scope` 校验与参照系**：`projectReferenceScope`（`runtimeConfig.ts`，**符号名定位**；本次核对
  在 `:495-516`）只在
  `subProjectPath` 是**根内相对路径**时才采用（绝对路径 / 盘符 / UNC / 任何含 `..` 段的值一律
  **不采用**，`log.warn` 后**回落**到 `path.posix.dirname(selection.sourcePath)`）。
  `MekaProjectReference.scope` 的参照系注释因此改为**该条目自己的 `root`**（不再是「相对 projectRoot」），
  所以同一份项目配置里 `additionalPaths` 根下的条目也成立。

**D2.1 的校验位置**（`mekaResolvePlan.ts` 的 `assertMekaUserPromptType:102`）：

- bootstrap 分支放在 `workspaceKind === 'meka'` 判定**之后**（`:577`）—— 非 Meka 会话（含只回填
  持久绑定的早返回，`:557-573`）在那之前已经返回，因此 I6 的零行为变化不受影响；
- frozen 分支（`mekaRuntimeResolved === true`）本身即 Meka，校验放在 `resolveFrozenInjection`
  开头（`:417`）；
- 文案固定、不含时间/随机值；错误码与位置由基线用例第 11 组同时钉住。
- **审查前提的一处修正**：审查记载的旧行为是「战斗抛 `TypeError` / 非战斗静默透传」，
  实测（对照 base repo 的原文件）只有 `resume` 非战斗才是透传；`新建` 非战斗是 `123` 被当
  空串**丢弃**（`prependPromptSection` 的 `typeof existing === 'string'` 分支）。不改变处置，
  但任务描述仍应是三条情形（见上表）。

**D2.2 为什么可以接受**：`opts` 自身的键插入顺序**没有消费者** —— 全仓没有任何代码枚举
`opts` 的键（只有 `{...opts}` 扩散与命名字段访问）。真正是契约的是 `opts.vendorOptions` 自己的
键序（I2），那条仍逐字段不变。

**D2.3 为什么可以接受，以及「成功路径等价」的证据强度**：

- **失败路径上没有消费者**：解析／物化抛错时本轮不会建出会话，错误码与文案照旧抛出、
  不返回 result；重构前写下的那几个键随即被同一次失败的调用丢弃。
- **`I6` 的有意副作用不受影响**：非 Meka 会话的「只回填持久绑定后早返回」是一条**成功返回**
  路径（`resolveBootstrapInjection` 返回带 `sessionBindingPatch` 的 plan），绑定照旧写入；
  D2.3 只作用于**抛错**路径。
- **成功路径逐字段等价有独立证据**：本层收敛时用「把已删除的旧实现临时放回、与新实现跑
  同一套输入」的差分方式核对过 —— 1204 个输入组合（覆盖 bootstrap / frozen × 工作区类型 ×
  持久绑定 × 战斗/非战斗 × worker × 9 种 `userPrompt`（含 `undefined`/`null`/非字符串/含 marker） ×
  3 种 `workingDir` × 3 种快照 × 4 种服务器目标 resolver × 有无既有 `vendorOptions` × 3 种
  `sessionId`（含空串与纯空白） × 4 条依赖抛错注入轴）逐字段比对 `opts`（含键序）、返回值与
  错误码/文案：**除本节 D2.1–D2.3 外零差异**，且**全部 39 例 D2.3 差异都发生在抛错路径**
  （不抛错的组合没有一个字节不同）。该差分是一次性核对手段，不入库（需要时按本节描述重建：
  从基点 `94ceda727c` 取回原文件、临时放进 `maker-ipc/` 并跑对新旧两实现的对比用例）。

## 8. 已知缺口（登记，本轮不接线）

| 缺口 | 事实 | 处置 |
| --- | --- | --- |
| 技能快照目录**只增不减** | `meka-projects/skillSnapshot.ts` 在 `revisions/` 下按 revision 写快照，只有 staging 的 `fs.rm`（`:318`）与临时文件清理（`:417`），**没有任何 revision 级 GC／prune** | 已知事实，另案处理；本轮不引入清理 |
| `mekaPolicyProviderRefs` **无消费者** | 只有写入方 `mekaResolvePlan.ts:684`（取自 `runtime.policyProviderRefs`），全仓无读取方 | 登记但不接线；删除或接线都需要单独裁决 |
| WL-15 的**负向**实机断言缺失 | 模型「没读冻结文件就执行」会退化，尚无实机断言 | 见 WL-15「实机验证」的未验证项 |
| Pi 能力缺口（D1）**已闭环（2026-09-22）** | 两列补齐为 `true`：Pi 用既有显式 `--skill` 挂宿主技能快照，bridge 工厂阶段豁免泛化到 `pi` | 剩余边界不是缺口而是平台事实：远端（SSH / MCPRouter worker）会话**不挂**本地快照，Meka 远端技能投递仍只有 codex 通道；登记见 WL-18 与 §6.54 |
| `table-scope` **无法派发服务器 Worker**（已知边界，不是 bug） | 服务器路由键只在存在唯一合法 `mekaCombatTargetSkillId` 时注入（`mekaResolvePlan.ts:230-256`），而 `authorizeCombatServerDispatch` 要求请求的 `remote_host_id` 与注入值全等（`combatWorkflowPolicy.ts:2228`）⇒ 表范围的 `create_worker` 恒被拒；`validate_server_capability_report` 的期望目标同样为空（`meka-runtime-mcp.ts:873`） | 参考未覆盖/冲突时表范围没有核查出口：改绑单技能 ID 后核查（可用），或由 owner 决定新增按目标派发/回报通道。成员清单（A4）与会话级镜像（A3）都已落地但**未实机验证**。详见 §3.1／§3.2 与 WL-11.12／WL-11.13 |
| 规范类条目的**描述可能在存量项目上退化**（2026-09-23） | `agents-md` / `rule` 的描述由**发现流程**在扫描期落盘（frontmatter → title → 首个 ATX 标题 → 首段首句）。**存量项目若从未重跑「发现」**，其元数据可能只有文件名或相对路径、没有描述，于是 order 65 段里这一条只剩「作用范围 + 路径 + 文件名」，召回价值降低（`mergeDiscoveredMekaProjectMetadata` 会保留旧描述，因此不会自愈） | **刻意不**在项目打开时自动跑发现：`metadata: discovered.map(...)` 是整体替换，会让文件已消失的条目连同人工维护的 `displayName` / `notes` / `disciplines` / `domains` 一起丢失 = 静默数据丢失。用户重新触发一次发现即可补齐描述 |
| resume 的旧会话**拿不到项目参考清单**（2026-09-23） | order 65 只在 bootstrap 注入（与 60 / 70 同进同出，I4）。`mekaRuntimeResolved === true` 的 resume 短路复用冻结注入，不重解析项目/角色 ⇒ 旧会话的 system 前缀里没有该段 | 与既有「角色修改只影响新任务」同源，属**预期语义**而非缺陷；新任务即可获得。**不得**为它给 resume 加解析 |
| 本批（2026-09-23）**门禁尚未实跑、smoke 尚未实跑** | 用例期望**已同步**（注入层基线只给 `runtime()` 夹具补了 `projectReferences: []` ⇒ 前 10 条逐字节期望一个字符未改；新增 9 条见 §6 第 16 组（**W25 终核：现为 10 条，本文件合计 28 条**）；`mekaRuntimeInjection.test.ts` 另补一条走真实 `resolveMekaRuntimeConfig` 的历史四角色兜底用例；生产侧 `projectReferences` 断言另有一份 unit 层新文件 `meka-projects/__tests__/runtimeConfig.projectReferences.test.ts`，16 条（**W25 终核：19 条**）；`scripts/meka-session-smoke.mjs` 也已按新契约更新）。**但本批没有执行任何门禁，也没有实跑 smoke**：`pnpm test:unit:related` / `pnpm test:unit`、各 package `typecheck`、`pnpm test:db`、`pnpm check:i18n-glossary`、白名单实跑与 `pnpm desktop:session-smoke`（含 `-- --role 默认角色`）**全部未跑**。同样**未做 Light／Dark 实机目检**（只读面板与三个来源徽标只有渲染层单测的期望值，没有目检证据）。**「期望已同步」是代码改动方的声明，文档同步者没有运行任何用例去验证它成立** | 交付时**一次性**跑完定向门禁（§6 的命令）与 `pnpm desktop:session-smoke`，并注意退役迁移与重绑守卫的断言只在 `db` 层（`builtinMekaSeed.test.ts` 被 `unit` 层 exclude）⇒ `pnpm test:unit` / `test:unit:related` 不执行它，本地要跑必须显式 `pnpm test:db`（**W25 终核更正：CI 会跑它**——`.github/workflows/ci.yml` 两处「Run companion database regressions」步骤的写死路径清单已含 `src/main/localDb/__tests__/builtinMekaSeed.test.ts`，linux shard 1 与 windows shard 1 各一处）。在那之前本层的新行为只有代码与文档证据，**没有任何实跑证据**；凡「新期望」一律按「待实跑」读 |
| `scope` 对 **`additionalPaths` 条目**的参照系限制（2026-09-23） | `MekaProjectReference.scope` 的参照系是**该条目自己的 root**：未写 `rootPath` 的主项目元数据以 `projectRoot` 为原点，来自 `basic.additionalPaths` 的条目（写有 `rootPath`）以**该附加根**为原点。注入文本里那一列**只写相对位置、不写原点**，所以读清单的人（与模型）必须知道「这一条的目录是相对它自己的根」。`subProjectPath` 为绝对路径 / 盘符 / UNC / 含 `..` 段时**不采用**，`log.warn` 后回落到文档自身所在目录 | **刻意保留**（附加根本来就在项目根之外，若把 scope 强行改成相对 `projectRoot` 会产出 `../` 形态的越界路径）。登记为**已知限制**：文本里没有显式标出条目 root，只有产品规则（本层 §7 D2.4 边界⑤、WL-11.17 第 4b 条）与 unit 层用例钉住「按条目自己的 root 计算」 |
| `meka-role:read-manifest` **现在是配置 IO 路径**（2026-09-23 反转） | 面板读清单会对带开关的角色走 `expandRoleManifest`（`localDb/ipc/mekaRoles.ts:213-243`）：flag 门（`useProjectDefaults` / `includeAllProjectMetadata` / `includeAllBundledSkills` **任一为 true**）不命中 ⇒ **零额外 IO**直接返回；命中则读项目配置，**复用运行期的既有纯函数**（`mergeMekaProjectRoleDefaults` → `resolveRoleProjectMetadataSelections` → `resolveBundledSkillSelections`，**无第二套展开逻辑**）。**失败时三层回退、不抛错**：① flag 门不命中（零 IO）；② 项目配置文件不可用（取不到 ⇒ 返回角色自身 manifest）；③ 展开过程抛错（⇒ `log.warn` + 返回角色自身 manifest）。**注意它不读 skill 正文**（只要 id 清单）。⇒ 上一轮登记的「只读角色没有可写一致要求，展开会把 IO 拉进 IPC 读路径、制造第二套真相」**已作废**：IO 被 flag 门限制在 opt-in 角色，且展开复用同一批纯函数 | 这是刻意的设计（面板必须显示**有效清单**，否则出厂全量的默认角色在只读面板里看起来「什么都没配」）；`read-manifest` 的展开结果**只服务面板呈现**，不写库、不落盘、不参与运行期解析。**已知显示不一致**：它**不跑** `upgradeLegacyBundledWorkflowRole` / `migrateSAGA2CombatRoleSkills`，而运行期 `resolveRoleFile` 会跑 ⇒ 旧版 saga2 战斗快照的「有效清单」与运行期实际生效清单不一致（仅显示层，见迁移总账 §11.27 B8） |
| **Pi argv 余量是算术推演，不是实测**（2026-09-23） | 规范类元数据改为引用投递后，该样本 `promptText` 从约 **42,600** 字符降到约 **4,900** 字符。按 win32 预算 **30,000** 反推：基础 argv ≈ **1,500**、`--append-system-prompt` ≈ **6,400** ⇒ 留给 `--skill` 约 **22,100** 字符；单条快照 skill ≈ **193** 字符 ⇒ **约 114 个 skill 才越界**；实际规模 **42–51 条** ⇒ 余量约 **2×**。**全部是算术推演，未实跑**（判据仍以 argv 实测总长为准，见 `pi-harness.md` §4 不变量 12）。超过该量级时的两条 Pi 载体优化：`--append-system-prompt` 改**传文件**、`--skill` 改**传目录／根**（后者在 pin 的 0.85.1 二进制的 `--help` 里已写明接受目录） | 登记为**未实测的余量估计**；不得据此声称「预算已被自动守住」。余量收窄到不足时按上面两条载体优化处理，不新增注入段 |
| `roleDefaults.rules[].text` 的**内联例外**（2026-09-23） | 属「角色默认提示词」而非 `rule` 元数据，`mergeMekaProjectRoleDefaults`（`runtimeConfig.ts`，**符号名定位**）合并后在 `:938-940` 内联进 **order 70**。它是本次「元数据通道零内联」之外**唯一**保留的规范正文内联通道 | 属**刻意保留**（它是角色作者直接写的提示词，没有「地址」可投递），但对外措辞必须说「**元数据通道**零规范正文内联」，不得简写成「零规范正文内联」 |
| 「只读态呈现」在 **DESIGN** 里**无条文**（2026-09-23） | 默认角色只读面板要显示三个来源徽标与「本角色只读」分句（`MekaProjectRoleEditorRoute.tsx:608-679`），但 `docs/design-rules/DESIGN.md` 里没有关于「继承来源徽标 / 只读态说明」的条款 —— 这层呈现只有产品规则（本层 §7／WL-11.10）与渲染层单测钉住 | 登记为**设计规范缺口**：本次不改 DESIGN（不在本交付范围），但下次做设计系统迁移或新增同类只读态时，应先在 DESIGN 里补条款再复用 |
| `mergeBundledRoleFallbacks` 的 `includeAllProjectMetadata` 回填分支**当前不可达**（刻意保留） | `meka-projects/projectConfig.ts:558-561`：`projectRole.includeAllProjectMetadata === undefined && role.includeAllProjectMetadata !== undefined` 时才从 bundled 清单回填。包内在役的 bundled 角色只剩 `combat-development.json`，而它**不带**该字段；唯一带该字段（`false`）的来源 `general-development.json` 已随本次退役删除 ⇒ 该条件**没有任何可命中的输入** | **刻意保留**：它是「bundled 清单覆盖项目自有快照」的**通用**合并规则，不是与已删角色绑定的悬空 helper —— 将来任何 bundled 角色声明该字段都会让它重新可达。**不要**把它读成「仍然生效」，也不要因为「不可达」就删掉（删掉会静默改变未来 bundled 清单的合并语义） |

> **门禁实跑结果（2026-09-23 交付时一次性执行，权威）**：`pnpm --filter desktop run typecheck`
> **exit 0**（首跑暴露并修复了 12 个类型错误：`MekaRoleManifestFile` 未导入、`Pick<…,'prompt'>` 需
> `Partial`、新测试文件 shared 导入少一层、夹具/ mock 类型等；修复后复跑 exit 0）；
> `pnpm run test:workspaces --tier unit` **exit 0**（全部 `required` workspace PASS，含
> `apps/desktop unit`）；`pnpm check:design-inventory` **exit 0**；
> `node scripts/hardcoded-color-audit.mjs --base-ref HEAD --worktree` **exit 0**
> （`unexpected: 0`，2 条 `report/visible-layer-radius` 为治理 §13 第 4 条的未决分类上报）；
> `check:i18n` / `check:i18n-glossary` / `check:brand-terminology` / `check:dev-docs` 全部 **exit 0**。
> 两处 exit≠0 均已定性为**非本次引入**：`--tier db` 的 2 个失败全在
> `__tests__/codexLocalSessions.test.ts`，**单独跑该文件 122 passed** ⇒ 并行负载下的抖动；
> `pnpm test:runner` 的 2 个失败在**未改动**的 `scripts/__tests__/hardcoded-color-audit.test.mjs`
> 的 `:287` / `:405`，两处都断言 `spawnSync('bash', …)` 退出码，最小复现证明本机 `bash` 是 WSL
> 启动器且**不继承 Windows 环境变量** ⇒ 纯环境性（CI 在 ubuntu 跑 bash，不受影响）。
> **仍未验证**：`desktop:session-smoke` 未跑；**Light / Dark 均未目检**；**Pi argv 余量仍是算术推演**。
> 本节以上各处写的「本批未跑任何门禁」指**写作时**状态，以本块为最终实跑结果。

## 9. 相关文档

- [`meka-whitelist-verification.md`](meka-whitelist-verification.md)：WL-11（项目/角色运行期注入链，
  含 **WL-11.10** 默认角色只读契约与 **WL-11.17** 规范类元数据渐进披露）、
  WL-15（Skill 非 argv 载体）、WL-16（本层契约与能力矩阵）、WL-18（Pi 的技能快照与运行时 MCP）。
- [`architecture-invariants.md`](architecture-invariants.md)：§1 package 解耦、§2 main 静态依赖。
- [`maker-core-and-agent-behavior.md`](maker-core-and-agent-behavior.md)：system prompt 前缀稳定性
  与文本改动门禁。
- [`engineering-conventions.md`](engineering-conventions.md) §8：`meka/main` 上的命名（本层文件名与
  跨模块导出名的依据，§0）。
- [`pi-harness.md`](pi-harness.md) 第 4 节不变量 12：argv 预算与非 argv 载体；不变量 8：项目资源
  与宿主技能快照的显式装配。
- [`../migrations/xdmaker-meka-to-cindy.md`](../migrations/xdmaker-meka-to-cindy.md) §6.49：注入层重构登记；
  §6.54：Pi 能力补齐与 D1 的取代。
