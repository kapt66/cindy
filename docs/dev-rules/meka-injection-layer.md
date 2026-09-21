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
`maker-ipc/register.ts` 只改了 import 路径（`:583-584`），对外导出名与签名保持不变。

> **行号锚点的维护约定**：本文与白名单 WL-11 / WL-15 / WL-16 里的 `文件:行号` 锚点指向
> **本层当前的**实现位置，重构期已因分层与后续修复整体位移过一次。锚点只在「指向哪个
> 函数／哪一段」上要有意义，**不作为逐字契约**：改本层代码时顺手核一遍本文 §1／§2／§3／§5
> 与 WL 的锚点，别让它们指到别的函数上去（`check:dev-docs` 与 WL 结构契约测试都**不**
> 校验行号，指错了没有任何自动化会红）。

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
| 0 文本常量 + 战斗 ID 解析 | `meka-injection/mekaCombatPrompts.ts` | 所有注入段的**文本唯一来源**（`combatControllerSkillPrompt:69`、`combatTargetPrompt:84`、`combatProjectPathsPrompt:95`、`combatServerTargetPrompt:134`、`roleContextPrompt:152`、`COMBAT_SERVER_WORKER_PROMPT:26`、`COMBAT_EXECUTION_AUTHORIZATION_PROMPT:41`）与用户消息里的技能 ID 解析（`parseCombatSkillIdFromUserPrompt:173`、`combatSkillIdVendorPatchFromUserPrompt:199`） | 不做 I/O、不碰 opts、不读 deps |
| 1 计划类型 + order 表 | `meka-injection/mekaInjectionTypes.ts` | `MekaInjectionPlan:126`、`MekaPromptSegment:102`、`MEKA_PROMPT_SEGMENT_ORDER:90`、段落工厂 `createMekaPromptSegment:109` | 不含业务分支 |
| 2 解析 | `meka-injection/mekaResolvePlan.ts` | 把 create opts / 用户消息 + 外部依赖（持久化绑定、运行期配置、平台技能、技能快照、MCP、战斗服务器目标）解析成结构化 plan／turn context。**全部 I/O 都在这一层**（入口 `resolveMekaInjection:617`、`prepareCombatFollowupRuntimeContext:643`） | 不写 `opts`、不改注入文本 |
| 3 落地 | `meka-injection/mekaApplyPlan.ts` | 把 plan 写进 create opts：按 `order` 升序渲染段落（`renderMekaPromptSegments:55`）、写 `vendorOptions`（`:88-91`）、挂原生技能（`:96-100`） | 不解析、不做 I/O、不重算 `plan.result` |
| 能力矩阵 | `meka-injection/mekaAgentMatrix.ts` | `MEKA_AGENT_CAPABILITIES:28`、`MEKA_AGENT_KINDS:48`、`mekaRuntimeMcpAgentKinds:53` | 不得由调用方手写第二份 agent 清单 |
| 进程级注册（形态 B） | `meka-injection/mekaMcpRegistration.ts` | `registerMekaCapabilities:42`：按矩阵遍历三个 `AgentKind`，`runtimeMcp: true` 的取数组注册（取不到**抛错**），`false` 的显式留档（`:48-64`） | 不得绕过矩阵直接调低层原语 |
| 对外入口 | `meka-injection/index.ts` | 形态 A（`applyMekaRuntimeConfig:47`）与形态 C（转发 `prepareCombatFollowupRuntimeContext`）的**唯一**入口 | 不转发形态 B（避免出现第二个入口名）；不转出**没有消费者**的层内类型与形态 A 子步骤 |

## 2. 入口形态：「一个形态恰好一个入口」

| 形态 | 场景 | 唯一入口 | 说明 |
| --- | --- | --- | --- |
| A | 会话创建 / 恢复 | `meka-injection/index.ts` 的 `applyMekaRuntimeConfig(opts, deps?)` | 只做组合：`resolveMekaInjection`（含全部 I/O）→ `applyMekaInjection`（只写 opts）。生产调用点 `maker-ipc/register.ts:6747` |
| B | 进程级 Meka MCP 注册 | `meka-injection/mekaMcpRegistration.ts` 的 `registerMekaCapabilities(registry)` | 生产调用点**唯一**：`maker-host/index.ts:2308`（在 `_mcpProviders.pi = piMcpProviders`（`:2303`）之后，保证三个数组都已就位）。低层原语 `mcp-integrations/meka-runtime-mcp.ts` 的 `registerMekaRuntimeMcpArrays:1413` 仍是公开导出（测试直接用它），但**生产禁止直接调**——它只认数组、不认归属，少传一个数组时发现不了任何问题 |
| C | 每轮续聊 | `meka-injection/index.ts` 转发的 `prepareCombatFollowupRuntimeContext`（实现 `mekaResolvePlan.ts:643`） | 生产调用点 `maker-ipc/register.ts:12605` |

**约束**：新增形态必须新增**唯一**入口，并在此表登记；不得为已有形态开第二入口，
也不得把形态 B 从 `index.ts` 转发出去（那样会同时存在 `index.registerX` 与
`mekaMcpRegistration.registerX` 两个名字）。

**导出面只留公共签名**：`index.ts` 只转出两个形态入口、两个 ID 解析口子，以及这些签名上
真正用到的类型（`AppliedMekaRuntimeConfig` / `ApplyMekaRuntimeConfigDeps` /
`PersistedMekaSessionBinding` / `CombatFollowupRuntimeContext` / `CombatSkillIdParseResult`）。
形态 A 的两个子步骤（`resolveMekaInjection` / `applyMekaInjection`）与层内计划类型
（`MekaInjectionPlan` / `MekaInjectionInput` / `MekaSessionBindingPatch` /
`MekaNativeSkillMount` / `MekaInlineMcpConfig`）**不再转出**：它们在重构期曾以「分层契约
入口」为名保留，但生产与测试都只走 `applyMekaRuntimeConfig`，转出去只会长出第二入口。
新增生产调用方必须用 `applyMekaRuntimeConfig`，不得只跑其中一步。

> **与计划文本的差异（记录在案）**：实施计划写作「4 种入口形态」，实现里落成的是 **3 个形态
> （A / B / C）+ 1 组跨形态共享的解析入口**：`parseCombatSkillIdFromUserPrompt`（`mekaCombatPrompts.ts:173`）
> 与 `combatSkillIdVendorPatchFromUserPrompt`（`:199`）。后者同时服务形态 A 与形态 C
> （由两者各自调用），所以它**不是**独立形态，而是两个形态共用的“口子”。若以后要把它抬成
> 独立形态，必须在这里新增一行并说明它的唯一入口。

## 3. `MEKA_PROMPT_SEGMENT_ORDER`：段落 id → order → 注入段

`mekaInjectionTypes.ts:90`。order 升序 = 最终 prompt 里自上而下的先后（`mekaApplyPlan.ts:72-79`
排序后拼接）。`order` 是**契约而不是实现细节**：它对应重构前 7 次 `prependPromptSection`
倒推出的现状顺序，逐字节基线用例（见 §6）直接断言。

| order | segment id | 对应注入段 | 现状序号 | 出处 |
| --- | --- | --- | --- | --- |
| 10 | `meka.combat.controller-skill` | `[SAGA2_COMBAT_CONTROLLER_SKILL]`（冻结正文绝对路径 + 先读完指令） | 1 | `mekaCombatPrompts.ts:69-82` |
| 20 | `meka.combat.server-target` | `[SAGA2_COMBAT_SERVER_TARGET]`（`ready` / `unavailable` 两态，**函数本身恒返回非空文本**——但整段是否入 plan 有前置条件，见下） | 2 | `mekaCombatPrompts.ts:134-150` |
| 30 | `meka.combat.project-paths` | `[SAGA2_PROJECT_PATHS]` | 3 | `mekaCombatPrompts.ts:95-132` |
| 40 | `meka.combat.target` | `[SAGA2_COMBAT_TARGET]`（仅当解析出唯一合法技能 ID） | 4 | `mekaCombatPrompts.ts:84-93` |
| 50 | `meka.combat.execution-authorization` | `[SAGA2_COMBAT_EXECUTION_AUTHORIZATION]` | 5 | `mekaCombatPrompts.ts:41-46` |
| 60 | `meka.role-context` | `[MEKA_ROLE_CONTEXT]` | 6 | `mekaCombatPrompts.ts:152-161` |
| 70 | `meka.role-prompt` | 角色 `promptText`（已过 `removeCombatStartupGate`） | 7 | `mekaCombatPrompts.ts:19-24`；`mekaResolvePlan.ts:509-512` |
| 80 | `meka.combat.server-worker` | `[SAGA2_COMBAT_REMOTE_SERVER_WORKER]`（`isCombatServerWorker` 分支**独占**，只注入这一段） | worker | `mekaCombatPrompts.ts:26-39`；`mekaResolvePlan.ts:521-523` |

**规则**：

- **新增段落只能插空档（如 15 / 25 / 65），不得重排既有段落。** order 数值一经发布即冻结；
  改既有段的 order = 改注入顺序 = 破坏 system prompt 前缀稳定性与 `maker-core-and-agent-behavior.md`
  §3.1/§4 的门禁，属于必须 owner 确认的改动。
- 段落工厂是 `createMekaPromptSegment`（`mekaInjectionTypes.ts:109`）：调用方**不得手写 order**，
  避免静默重排。
- `meka.role-prompt` 在正文为空时不入 plan（`mekaResolvePlan.ts:509-512`）；
  `meka.combat.target` / `meka.combat.project-paths` / `meka.combat.controller-skill`
  在无法构造文本时同样不入 plan。段落的**相对集合**也因此是逐字节基线的一部分。
- `meka.combat.server-target` 的入 plan 前置条件与「文本是否非空」无关：该段由
  `resolveCombatServerTargetInjection`（`mekaResolvePlan.ts:222`，重构前是 `injectCombatServerTarget`）
  构造，只在「`mekaCombatTargetSkillId` 是唯一合法正整数 **且** `deps.resolveCombatServerTarget`
  存在」时才会产生（resolver 抛错按 `unavailable` 处理，仍然入 plan）。因此无绑定技能 ID /
  歧义 ID / 未注入 resolver 时，该段**完全不出现**——不要把它读成「恒存在」。
  基线用例第 2、4 条即覆盖缺席形态。
- 解析层按**现状的执行次序** push 段落（次序与最终 order 相反），`mekaApplyPlan` 只按 order
  渲染；「执行次序」不再是语义，只有 order 是语义。

`plan.frozen === true`（resume 短路，§5 I4）时，角色段 60 / 70 **不注入**（现状事实），
只补战斗契约段。

## 4. `MEKA_AGENT_CAPABILITIES` 矩阵与 D1 裁决

`mekaAgentMatrix.ts:28`（`Readonly<Record<AgentKind, MekaAgentCapabilities>>`，三层 `Object.freeze`）：

| agentKind | `skillSnapshot` | `runtimeMcp` | 依据 |
| --- | --- | --- | --- |
| `claude-code` | `true` | `true` | `packages/maker-core/src/agents/claude-code/index.ts:3327`、`:3900`（消费 `opts.nativeSkillPluginPath`） |
| `codex` | `true` | `true` | `packages/maker-core/src/agents/codex/index.ts:4852`（`nativeSkillPluginPath`） |
| `pi` | **`false`** | **`false`** | `packages/maker-core/src/agents/pi/**` 对 `nativeSkillPluginPath` 与 Meka 运行时 MCP **零引用** |

**D1（用户裁决，本轮生效）：Pi 有意不支持技能快照与 Meka 运行时 MCP。** 本轮**不补齐**
Pi 能力，只把「意外缺失」改写成「声明式缺失」——Pi 的实际行为必须与改动前逐字节一致。
翻转这两行 = 改产品裁决，必须另开一轮并重新评审，不得顺手改。

矩阵的存在理由：以前「谁拿到了什么」是**涌现**的 —— 由 `maker-host` 手工传数组、
手工写 `vendorOptions` 决定；少传一个数组不报错，只让那个 agent 静默缺能力（Pi 就是这样
丢掉 mcp-router / meka-design 的）。改成显式矩阵后，「缺失」只能是声明式的，而声明被测试钉住。

**双锁**：

- 编译期：矩阵是 `Readonly<Record<AgentKind, ...>>`，maker-core 新增 `AgentKind` 而这里没填
  → 编译失败。
- 运行期：`meka-injection/__tests__/agentMatrix.test.ts` 用 `Record<AgentKind, true>` 再断言
  一次键集合（4 用例）；**矩阵对象、每个能力条目与键数组三层都冻结**（`Object.freeze`，
  `mekaAgentMatrix.ts:28,48`）——只冻结数组容器挡不住 `as`／`any` 的就地改写，那会让注册期
  断言与矩阵悄悄脱钩。
- 注册期硬失败：`declareMekaRuntimeMcpAgents`（`mcp-integrations/meka-runtime-mcp.ts:1433`）
  要求**每个 `AgentKind` 都必须被显式声明**（漏一个直接抛，`:1445-1452`），且声明必须与矩阵
  一致（矩阵说支持却不给数组 / 说不支持却塞了数组，都抛，`:1453-1464`）。`registerMekaCapabilities`
  在 `runtimeMcp: true` 的 agent 取不到数组时也直接抛（`mekaMcpRegistration.ts:55-61`）。
  ——**「漏传」由此从静默缺能力变成启动期硬失败**（D2 顺手修掉的缺口）。

## 5. 硬性不变量 I1–I8

违反任一条 = P0，回退重做。

| # | 不变量 | 代码锚点 | 自动化兜底 |
| --- | --- | --- | --- |
| I1 | **注入文本逐字节不变**：所有 prompt 段的文本、相对顺序、分隔符（段间 `\n\n`、段内 `\n`）与重构前完全一致 | 文本唯一来源 `mekaCombatPrompts.ts`（全文件）；渲染 `mekaApplyPlan.ts:43-79` | 基线用例（原有 10 条，§6）断言 `opts.userPrompt` **全文** |
| I2 | **`vendorOptions` 键名、取值、写入时机不变**：**`opts.vendorOptions` 自己的**键插入顺序也是契约（`combatWorkflowPolicy.ts`、`meka-runtime-mcp.ts` 按这些键裁决工具门禁）。注意范围：契约只到 `vendorOptions` 内部，**`opts` 整体的键插入顺序不是契约**（无消费者，见 §7 D2.2） | patch 构造 `mekaResolvePlan.ts:526-554`（resume 短路路径的补丁在 `:304-350`）；写入 `mekaApplyPlan.ts:88-91`；空 patch 不写（保持对象引用） | 基线用例断言 `Object.keys(opts.vendorOptions)` 顺序（原有 2 个场景 + 追加的 frozen 场景）；`mekaRuntimeInjection.test.ts` |
| I3 | **技能快照冻结语义不变**：首次 materialize 固定 revision，resume 复用同一 revision；远端会话不暴露本地快照路径 | `mekaResolvePlan.ts:186-193`（`nativeSkillMount`：`opts.remoteHostId` 则 null）；物化 `:506`；`meka-projects/skillSnapshot.ts:345-423`（`readBoundRevision` 复用） | WL-11.6；`mekaRuntimeInjection.test.ts` |
| I4 | **`mekaRuntimeResolved === true` 短路分支行为不变**：resume 只补战斗契约，不重解析项目/角色、不重算 MCP、不注入角色段 | `mekaResolvePlan.ts:286-386`（`resolveFrozenInjection`）、`:624-640`（分流） | 基线用例 2 条（resume 战斗 / 非战斗） |
| I5 | **WL-15**：战斗总控 Skill 只注入冻结正文的**绝对路径 + 必须先完整读完**，**绝不内联正文** | `mekaCombatPrompts.ts:48-82`（入口常量 `:48`、marker `:49`、只 `path.join(pluginPath, …)`）；路径授权 `mekaResolvePlan.ts:186-193` + `mekaApplyPlan.ts:96-100`；冻结路径形状门 `meka-projects/combatWorkflowPolicy.ts:779` | `mekaRuntimeInjection.test.ts` 的正向 + **反向**断言（正文不得出现）；详见 WL-15 |
| I6 | **非 Meka 会话零影响**：`workspaceKind !== 'meka'` 时 `didApply=false`、不注入任何 prompt 段、不写任何 Meka 键；唯一写入是**持久化绑定回填**（`:398-419` 读持久绑定，`:420-433` 只回填绑定后早返回），该副作用是现状 | `mekaResolvePlan.ts:388-433`；`index.ts:47-57`（plan 为 null ⇒ 空结果，零写入） | 基线用例 `writes nothing for a non-Meka session` |
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
- 解析层用 `createPlanBuilder`（`mekaResolvePlan.ts:107-124`）在解析期模拟「已 prepend 的 prompt」，
  以便 `hasMarker` 去重 guard 与重构前判定一致（含角色正文恰好含某 marker 的极端情况）。

- **测试数据的平台可移植性（不得回退）**：`mekaRuntimeInjectionBaseline.test.ts` 与
  `mekaRuntimeInjection.test.ts` 里的 SAGA2 项目路径**必须从模块级基准根推导**
  （`path.resolve` / `path.join`），不得写死 `C:\Workspace\…` 字面量 —— 实现用的是
  `path.resolve`，Linux 上写死的 Windows 路径不可能匹配，而这些文件在 `ubuntu-latest`
  的 Linux unit shards 上会跑。辅助函数 `saga2ProjectPaths()` / `combatProjectPathsSection()`
  必须与 `meka-injection/mekaCombatPrompts.ts` 的 `combatProjectPathsPrompt` 同形。
  同一类修复已覆盖 `meka-projects/__tests__/combatWorkflowPolicy.test.ts`；登记与验证证据见
  [`../migrations/xdmaker-meka-to-cindy.md`](../migrations/xdmaker-meka-to-cindy.md) §6.48。

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
结论，不得当作「基线漂移」直接更新。当前该文件共 **18 条**用例（10 + 8）。

**定向门禁**：

```bash
pnpm --filter desktop exec vitest run src/main/meka-injection src/main/maker-ipc/__tests__/mekaRuntimeInjectionBaseline.test.ts src/main/maker-ipc/__tests__/mekaRuntimeInjection.test.ts
```

- `meka-injection/__tests__/agentMatrix.test.ts`（4 用例）与
  `meka-injection/__tests__/mcpRegistration.test.ts`（12 用例）覆盖矩阵穷尽性、三层冻结、
  D1 的 Pi `false` 断言、漏传硬失败、声明与矩阵矛盾硬失败，以及 maker-host 接线契约。
  接线断言按**调用形状**匹配（先剥注释再归一化空白）并逐一要求三个 `_mcpProviders[*]`
  赋值都先于注册点，不再依赖单行精确字面量；它仍是**源码级、非行为级**判据。
- `meka-whitelist-verification.md` 的 **WL-16** 是本文的清单落点；改动本层必须同一次交付里
  更新 WL-16。

## 7. 与重构前的有意差异（D2）

本节登记本层**明知且有意**偏离重构前行为的条目。除本节列出的条目外，本层必须与重构前
逐字段等价（I1–I8）。

| # | 项目 | 重构前 | 重构后 | 理由 | 门禁 |
| --- | --- | --- | --- | --- | --- |
| D2.1 | 非字符串 `opts.userPrompt`（如 `123`） | 分三种情形：①战斗工作流走到 `(opts.userPrompt ?? '').includes(marker)` 的 guard 时抛 `TypeError: ....includes is not a function`（**无错误码**，原 `mekaRuntimeInjection.ts:400,461,479,483`）；②新建非战斗会话不跑 guard，但 `prependPromptSection` 把非字符串当空串 ⇒ `123` 被静默**丢弃**（注入照常完成）；③resume 非战斗会话不写任何 prompt ⇒ `123` 原样**透传**给下游 | 所有 Meka 路径（新建 / resume、战斗 / 非战斗）都抛 `INVALID_PARAMS`：`Meka session userPrompt must be a string when provided` | IPC 是无类型边界（`readCreateSessionOpts` 不校验 `userPrompt`），三种旧结果都不可接受：①不可辨，②静默丢用户输入，③把脏值写进会话 | 基线用例第 11 / 12 组 |
| D2.2 | resume 短路下 `opts` 键插入顺序 | 快照键夹在早段 prompt 与尾段 controller prompt **之间**：`nativeSkillPluginPath → nativeSkillRevision → userPrompt`（原 `mekaRuntimeInjection.ts:501-502` 早于 `:505` 的 `injectCombatControllerSkill`） | 统一放到最后：`userPrompt → nativeSkillPluginPath → nativeSkillRevision` | 落地阶段按「vendorOptions → prompt → 快照」统一收敛，不再在一条路径上按段落写入阶段切分写入次序 | 基线用例第 13 组（**不可观测**，仅锁现状） |
| D2.3 | **解析／物化抛错时的写入语义：增量 → 原子** | 逐阶段就地写 opts：持久绑定一读到就写（原 `:526-529`）、resume 短路的 `vendorOptions` 补丁与早段 prompt 也在快照物化**之前**写（原 `:449-486`），因此中途抛错会留下「半个注入结果」（例如 `resolveRuntimeConfig` 抛错时绑定键已写、`materializeSkillSnapshot` 抛错时 prompt 段已拼好） | 所有 opts 写入只在 `applyMekaInjection` 落地 ⇒ **抛错时 opts 与调用前逐字节一致**（键集合、键序、`vendorOptions` 对象引用、原始 prompt 全不变） | 解析／落地分层的定义就是「I/O 与写入分开」；恢复增量写等于把两者重新交织回去，会推翻本层结构。失败路径上没有任何消费者读这些半成品：错误码／文案照旧抛出、不返回 result、不会建出会话 | 基线用例第 15 组（3 例）；成功路径的等价性由 10 条快照用例 + 差分验证兜底（下表注） |

**D2.1 的校验位置**（`mekaResolvePlan.ts` 的 `assertMekaUserPromptType:94`）：

- bootstrap 分支放在 `workspaceKind === 'meka'` 判定**之后**（`:440`）—— 非 Meka 会话（含只回填
  持久绑定的早返回，`:420-433`）在那之前已经返回，因此 I6 的零行为变化不受影响；
- frozen 分支（`mekaRuntimeResolved === true`）本身即 Meka，校验放在 `resolveFrozenInjection`
  开头（`:296`）；
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
| `mekaPolicyProviderRefs` **无消费者** | 只有写入方 `mekaResolvePlan.ts:530`（取自 `runtime.policyProviderRefs`），全仓无读取方 | 登记但不接线；删除或接线都需要单独裁决 |
| WL-15 的**负向**实机断言缺失 | 模型「没读冻结文件就执行」会退化，尚无实机断言 | 见 WL-15「实机验证」的未验证项 |
| Pi 能力缺口（D1） | Pi 不支持技能快照与运行时 MCP，**当前行为与声明一致** | 有意为之；补齐另开一轮 |

## 9. 相关文档

- [`meka-whitelist-verification.md`](meka-whitelist-verification.md)：WL-11（项目/角色运行期注入链）、
  WL-15（Skill 非 argv 载体）、WL-16（本层契约与能力矩阵）。
- [`architecture-invariants.md`](architecture-invariants.md)：§1 package 解耦、§2 main 静态依赖。
- [`maker-core-and-agent-behavior.md`](maker-core-and-agent-behavior.md)：system prompt 前缀稳定性
  与文本改动门禁。
- [`engineering-conventions.md`](engineering-conventions.md) §8：`meka/main` 上的命名（本层文件名与
  跨模块导出名的依据，§0）。
- [`pi-harness.md`](pi-harness.md) 第 4 节不变量 12：argv 预算与非 argv 载体。
- [`../migrations/xdmaker-meka-to-cindy.md`](../migrations/xdmaker-meka-to-cindy.md) §6.48：本轮重构登记。
