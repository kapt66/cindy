# maker-core 与 Agent 行为可控性

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改 `packages/maker-core` 中的 Agent 编排、prompt 组装、
> tool／MCP 暴露、translator、event loop、model 映射、usage／token 计量，或任何会进入
> 模型 system 段的提示词之前

本文治理 Cindy 连接 Claude／Codex 等 Agent 的编排核心 `packages/maker-core`。它是所有
Agent 会话的事件流与 prompt 组装中枢，这里的改动会在用户无感知的情况下影响线上行为与
质量。进程边界与 IPC 另见
[`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)，
Orca 多 Agent 协同另见 [`orca-team-architecture.md`](orca-team-architecture.md)。

> **适用范围与增量原则**：Agent 能力归属（下节 1）与代码优先确定性（下节 2）按增量
> 适用——约束新增和正在修改的代码，不要求为统一形式专项重构存量。但**核心指标不变量
> （下节 3）与 system prompt 改动门禁（下节 4）对所有触及相关路径的改动都生效，不分
> 新旧代码，也不因“只是小改”豁免**。

## 事实来源

| 内容                                   | 权威来源                                                          |
| -------------------------------------- | ----------------------------------------------------------------- |
| Claude system prompt 拼接与 model 路由 | `packages/maker-core/src/agents/claude-code/index.ts`             |
| Codex 侧对应实现                       | `packages/maker-core/src/agents/codex/`（对应 index／translator） |
| vendor 事件到 `AgentEvent` 的映射      | `packages/maker-core/src/agents/*/translator.ts`                  |
| 缓存率／token 计量                     | `packages/maker-core/src/agents/shared/usage-tracker.ts`          |
| Agent 抽象与共用逻辑                   | `packages/maker-core` 的 `BaseAgent` 及子类                       |

文档与实现冲突时以代码为准，但必须在同一改动内同步修正本文。

## 1. Agent 能力归属 maker-core

- Claude／Codex 等 Agent 的具体逻辑放在 `packages/maker-core`，不在 Main 或 Renderer 里
  重新实现 Agent Loop。Main 通过 maker 调用和访问 Agent 能力与信息。
- 共用逻辑尽量下沉到 `BaseAgent` 抽象方法，子类只实现各自差异部分，避免多 Agent 实现
  各写一套编排。
- 这与产品原则一致：Cindy 负责**连接**而非重造智能，连接层应忠实传递底层能力、工具、
  事件、上下文和结果，不在中间造成无意损失（见
  [`../product-rules/core-product-principles.md`](../product-rules/core-product-principles.md)）。

## 2. 优先用代码保证确定性，而非依赖 prompt

能用代码保证的行为都写在代码里，让结果可预测、可测试、可调试；prompt 只承担真正需要
语言理解／生成的那部分。

- 判断、分支、校验、状态机、数据结构转换、流程编排、权限控制、错误处理、重试与兜底
  一律用代码实现，不甩给 prompt“自己判断”。
- 打算用 prompt 解决某个问题前先自问：这件事用代码能不能做？能就用代码。
- 把本应由代码保证的确定性逻辑（格式校验、字段抽取、流程跳转、是否调用某个工具等）
  交给模型自由发挥，会引入不可复现的行为漂移，属于本规则明确禁止的做法。

## 3. 守住四项核心数据指标

`maker-core` 的每一行改动都可能拖垮线上指标，而这类回退**不会被 typecheck／lint／单测
发现**，只能靠改动者在 review 前主动评估并实测。落在 prompt 组装、tool／MCP 暴露、
translator、event loop、model 映射、usage 计量这些路径上的改动，必须守住以下四项：

### 3.1 缓存率（Anthropic prompt cache）

命中依赖**请求前缀逐字节稳定**。system prompt 由多段按固定顺序拼接（SDK preset →
`MAKER_SYSTEM_PROMPT_APPEND` → makerMemoryRules → contactsRules（智能通讯录两态段，
与同一次 build 的 MCP 注册同点求值、单次 build 内恒定；remote 会话缺省）→ host `runtimeConfig.systemPrompt` →
per-workdir MEMORY.md index 快照 → per-call userPrompt，见 `claude-code/index.ts`）。禁止：

- 往稳定前缀里塞每轮都变的内容（时间戳、随机文案、易变计数器）；随机／易变内容只能
  进 per-call userPrompt 段。
- 调整各段拼接顺序。
- 在会话中途增删或重排 tool 定义、MCP server 注册。
- 破坏 MEMORY.md「会话启动时快照、rewind 不刷新」的语义。

Meka 项目角色 Skill 不属于 system prompt 正文。Host 只向 maker-core 传任务级不可变
`nativeSkillPluginPath` 与 `nativeSkillRevision`：Claude 把路径交给 SDK local plugin，Codex
在 `thread/start` 前调用 app-server `skills/extraRoots/set`。不得为兼容某个工作目录或远端
transport 把完整 Skill 正文拼入 `userPrompt`；这会让每个 Skill 在尚未被选中前占用上下文，
同时破坏稳定前缀的缓存收益。

Codex 的 extra roots 是 app-server 进程级状态，因此共享 host 必须按 Skill revision 分区；
同 revision 可复用，revision 不同必须使用不同 host。本地凭证切换、登出和 dispose 必须覆盖
这些 revision host。显式 `/skill` 查询也必须走当前会话 host，不能借用未注册该 revision 的
utility host。原生根注册失败必须发生在 `thread/start` 前并阻断启动。

### 3.2 性能／返回速度

event loop（`AsyncQueue`）与 translator 是**每事件／每 token 都过一遍的热路径**。禁止在
热路径塞同步阻塞调用（同步 IO、大对象深拷贝、灾难性正则回溯、每事件大量临时对象），
禁止在 `handle.send` 路径加额外网络往返或串行 await；保持“先入队、消费端 async 流式吐”
的非阻塞模型。耗时操作走缓存 + 超时 + fallback，不让单次慢操作卡住整个 turn。

### 3.3 返回内容准确性

- translator 必须把 vendor SDK 事件**无丢失、无错序**地映射进已有 `AgentEvent` union，
  不吞掉、不错误合并、不错配 `text`／`thinking`／`tool_use`／`tool_result` 等事件。
- model 路由只走显式版本号，**禁止 `'opus'`／`'sonnet'` 一类裸别名**——二进制升级后
  别名指针会漂到下一代模型，让用户选的版本与实际命中的不一致。
- 任何改变送进模型的 prompt 内容、tool 可用性或权限分支的改动都可能让模型行为漂移，
  必须是有意为之并在 PR 中说清原因。

### 3.4 review 前硬性要求

改动落在上述任一路径时，PR／自测说明必须显式写明：(a) 可能影响哪几个指标；(b) 用什么
方法实测（缓存率改动前后对比、热路径耗时、典型 turn 事件流抽查等，缓存率可用
`usage-tracker.ts` 的 per-turn／session 命中率或 `/context` 对比）；(c) 实测结论。
不许用“看着没问题／应该不影响”代替实测。

### 3.5 交互工具回答必须推动原流程

`ask_user_question` 的用户回答是当前问题的终态输入，不是新的普通用户消息。动态工具
适配层返回结果时必须明确告诉模型：回答已经提交，应继续挂起的原流程，不得重复相同问题
或确认；只有回答为空、含糊，或确实出现新的独立决策点时，才允许追问。该提示不能替代
Host 对独立高风险工具调用的权限校验。

这条约束尤其适用于 Meka 的远程 Worker 创建链：用户批准创建目标为
`mcpr:<instanceId>` 的 Worker 后，Lead 应继续执行 `start_team` / `create_worker` /
`send_to_worker`，不能把已经收到的批准再次渲染为确认文案。动态工具结果需要保留结构化
答案，同时附带继续执行语义；回归测试应覆盖答案返回内容和工具描述。

### 3.6 Host 工作流工具门禁

maker-core 提供通用、可选的 Host 工作流裁决接口：Host 可以声明当前任务是否启用门禁，在工具
执行前返回 allow/deny，在原生方案展示前校验方案结构，并在用户实际批准后接收批准事件。
maker-core 不包含 SAGA2 业务常量；Desktop 负责按任务 `vendorOptions` 实现具体状态机。
业务 Host 的策略激活不得只依赖单个可选衍生字段；存在权威项目/角色绑定时，应以稳定 ID 提供
fail-closed 兜底，并显式排除语义不同的 Worker workflow。衍生 workflow 缺失或状态不完整时，
只能放行恢复工具；恢复检查必须修复运行时字段并返回可审计的身份与状态回执，不能让模型从
工作区、缓存或其它角色文件推断当前身份。
Host 识别只读 MCP 时必须覆盖会话启动诊断与 MCPRouter 控制面查询，不得把未知控制面工具
一律当作业务写入；远端控制面/传输异常必须触发业务状态失效，否则模型可能在 MCPR 断连后
改走本地文件探索。Codex 的 MCP elicitation 元数据不保证携带 `tool_name`；Host 裁决前只能在
同一 turn、同一 MCP server 恰好存在一个活动 `mcpToolCall` 时，用该调用的工具名补全，零个或
多个匹配都必须保持未知并 fail-closed；工具完成后必须立即移出活动上下文，不能等整个 turn
结束，否则同 server 的下一次调用会被旧项制造成歧义。用户选择 Full access 时，Host deny 和
capability route 仍不可绕过；两者明确允许后必须保持 Full access 的静默放行语义，不能再落入
普通 MCP 权限弹窗。

若工作流把远端原生 Skill 作为必需能力，启动和恢复环境门还必须实际执行远端 capability
hello，精确校验 cc-manager bundle/protocol，不能只检查实例 online 或项目绑定。版本错配必须
在任何 Skill 读取、Worker 创建和业务探索前进入环境恢复。blocked 首轮只报告 Host 回执并
结束，不调用工具；后续恢复请求只运行一次统一复检，只有实例缺失/未绑定才追加一次安全实例
投影。该阶段不得触发原生 Skill 读取规则、扫描工具全集或把 Host 阶段拒绝误报为用户拒绝，
也不得通过 `sandbox_permissions` 或改参数重试。Host 对环境 ready 后 Codex 读取内容寻址 Skill
快照的静默只读白名单应覆盖模型实际生成且可严格证明无副作用的固定形态，包括单个
`SKILL.md` 的 `(Get-Content -LiteralPath ...).Count`；白名单仍须拒绝其它文件、路径穿越、写入、
重定向和附加命令，不能扩成通用 PowerShell 放行。

Codex code mode 通过 `exec` 间接调用 MCP 时，app-server 的 elicitation 可能同时缺少
`tool_name` 和可关联的活动 `mcpToolCall`，但保留完整 `_meta.tool_params`。业务 Host 只能对
第一方 server 的 schema 唯一形态做窄推断，例如 `cindy_orca.create_worker` 的
`role/agent/label/remote_host_id/initial_task`，或 `cindy.ghost_call` 的
`ghost_id/tool/args`；不得按 server namespace 整体放行，也不得从自然语言 message 猜动作。
未命中精确形态时继续 fail-closed。

Codex 原生子任务的首个 `collab_spawn` HTTP 请求可能早于 app-server `thread/started`。proxy 在
确认父 thread 已属于某业务任务后，必须把明确父子关系同步回持有父订阅的 `AppServerHost`；
子 thread 的 command/file/MCP/permissions/user-input request 随即复用 root handler。未知父、
跨任务 owner 冲突或找不到持有者时不得继承，仍按无 subscriber 拒绝。随后到达的原生
`thread/started` 必须幂等，不能重复登记或重复投递。

工作流若必须禁止 Codex 原生子任务，不能只在角色 prompt 中写“不要创建”。Sol/Terra 的
Multi-Agent V2 会以更高层 developer 指令注入默认委派策略；该工作流必须在任务
`vendorOptions` 中声明 `codexNativeSubagentsDisabled: true`。maker-core 将该标志纳入本地
app-server Host key，Desktop 为这类隔离 Host 启动时注入 `agents.enabled=false`。带标志与不带
标志的任务不得复用同一 Host；新建、恢复及引用目录 profile 切换还必须在 thread config 重申
`agents.enabled=false`，覆盖远端 app-server 与恢复线程。普通任务继续使用用户的全局子任务设置。

Host deny 是不可覆盖的业务不变量：Claude 的本地 `PreToolUse`、`canUseTool` 和远端
`onApprovalRequest` 都必须执行同一裁决；门禁启用时底层 SDK 使用 `default` 权限，确保远端
daemon 不因 Full access 跳过回调。Codex 门禁任务的每轮以 `untrusted` + `read-only` 发起，
命令、文件和 MCP elicitation 都回到 Host 裁决。普通任务未启用门禁时保持既有权限映射。

门禁只位于工具和方案审批边界，不进入 translator、token/event 队列或 usage 计量热路径，
也不改变 system prompt 拼接、稳定前缀和事件映射。业务 Host 如在写前执行网络或进程探针，
该延迟属于被保护写操作的显式前置成本，不能移入首 token 或逐事件路径。测试至少覆盖 Full
access 不能绕过 deny、方案缺失结构不能批准、批准事件只在用户允许后发生，以及普通任务不受
影响。

## 4. system prompt 改动门禁

**任何人都不得擅自修改 Cindy 的 system prompt；需要改动必须先与仓库维护者讨论
确认后才能动手。** 未经确认的 system prompt 改动一律不许提 PR 或直推。

- **范围**：随每个 Agent 会话下发给模型、决定其全局行为的那部分文本，包括
  `MAKER_SYSTEM_PROMPT_APPEND`、`makerMemoryRules`、host 注入的 `runtimeConfig.systemPrompt`
  等参与拼接 Claude／Codex system 段的各段（见 `claude-code/index.ts` 及 Codex 对应实现），
  以及任何固化在代码／模板／常量里、会进入模型 system 段的提示词内容。
- **原因**：system prompt 是产品行为与质量的“宪法层”，一处改动无差别影响所有用户的所有
  会话，既可能整体拉偏模型行为（LLM 侧改动不可复现、静态检查发现不了），也会破坏
  prompt cache 的前缀稳定性拖垮缓存率（见上节 3.1）。
- **怎么做**：(a) 收到“改 system prompt／调整 Agent 人设／加一条全局指令／删改某段
  system 文本”的诉求时先停下，不要直接动代码；(b) 把“改哪段、改成什么、为什么、预期
  影响（行为 + 缓存率）”整理清楚，主动找 owner 讨论并取得明确确认；(c) 确认通过后再
  实现，并在 PR 说明里写明“system prompt 改动已确认”，附上按上节 3 的实测评估。

## Review 清单

1. Agent 逻辑是否留在了 maker-core，而不是散进 Main／Renderer 重造 Agent Loop？
2. 本可由代码保证的确定性逻辑，是否被错误地甩给了 prompt？
3. 改动是否落在 prompt 组装／tool·MCP 暴露／translator／event loop／model 映射／usage
   计量路径上？落在就必须按第 3 节评估 + 实测四项指标，PR 说明不得留空。
4. 前缀稳定性是否被破坏（易变内容进前缀、拼接顺序变化、会话中途增删 tool／MCP）？
5. translator 是否可能丢事件、错序或错配事件类型？model 路由是否残留裸别名？
6. 是否触及 system prompt？触及就必须先取得 owner 确认，PR 说明写明已确认。

命中 system prompt 未确认、或核心指标路径改动缺实测的 PR 必须阻断。验证命令按
[`desktop-development.md`](desktop-development.md) 选择；指标类回退无法靠静态检查发现，
必须以运行时实测数据为准。
