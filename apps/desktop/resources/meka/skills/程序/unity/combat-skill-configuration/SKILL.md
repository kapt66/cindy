---
name: combat-skill-configuration
description: 按客户端、服务器和模块节点的共同契约设计、生成、导入并验证 SAGA2 战斗技能与关卡机制配置。仅在战斗开发任务中使用，不替代服务器代码修改或通用 Unity 编程。
metadata:
  display-name: 战斗技能配置
  purpose: 用模块组合和可审计 JSON 交付真实可验证的战斗机制
---

# SAGA2 战斗技能配置

## 证据预算（强制）

技能 ID 明确后，先确认常驻 Unity CLI 状态；第一条内容证据必须是通过老版编辑器导出的目标
技能 JSON。随后只读取 Host 注入的客户端入口规则和老版模块协议，再为当前技能 ID
派发一次窄范围只读服务器 Worker。禁止递归读取整个 `saga2_design`、重复读取同一文件或为无关
原子能力扩展搜索；每个未决业务原子最多两轮定向核查。仍无结论时立即停止工具调用，按
“可实现 / 无法保证 / 待确认业务选择”交付，不得让策划等待无终点探索。

这个 Skill 负责把战斗需求落到当前技能的模块节点图，并闭合
客户端编辑器、导出数据和服务器权威语义。它同时适用于角色技能、被动技能、召唤物技能和
战斗关卡机制；“技能”在本 Skill 中指游戏玩法技能，不是 Agent Skill。

## 首次调用的唯一形态

本角色通过公共 `cindy.ghost_call` 使用已安装插件，工具名和参数已经确定，禁止调用
`list_tools`、`ghost_info` 或 `ghost_list` 发现接口，也禁止试探旗标参数。技能 ID 明确后只按
以下形态执行；`<unityClientRoot>` 必须原样取自 Host 注入路径，不能省略：

```json
{
  "ghost_id": "meka-unity",
  "tool": "unity_inspect",
  "args": { "action": "status", "projectPath": "<unityClientRoot>", "format": "json" }
}
```

```json
{
  "ghost_id": "meka-unity",
  "tool": "unity_execute",
  "args": {
    "action": "command",
    "projectPath": "<unityClientRoot>",
    "arguments": [
      "legacy_module_export_json",
      "<skillId>",
      "<legacyModuleJsonTempRoot>/saga2_skill_<skillId>_target.json"
    ],
    "format": "json"
  }
}
```

`legacy_module_export_json` 的参数只接受上述三个位置参数：命令名、十进制技能 ID、绝对 JSON
路径。临时目录必须原样取 Host 注入的 `legacyModuleJsonTempRoot`，不得猜测 `C:\Windows\Temp`
或其它系统目录。不得改成 `--skill-id`、`--skill_id`、`--output`、`--output_path` 或其它旗标。
status 成功后立即执行目标导出，不插入任何其它工具调用。若 status 返回没有实例、未就绪、
Pipeline 缺失或其它不可用回执，Meka Unity 插件会返回 `UNITY_EDITOR_NOT_RUNNING`；此时先询问
用户是否由 Cindy 帮忙启动目标工程，只有明确同意后才能调用 `unity_execute(action=open)`，不得
静默启动或循环重试。未得到同意前，对当前目标技能仍只允许执行一次
`legacy_module_export_json` 取得结构化失败证据，随后继续独立的服务器只读核查；若导出传输也失败，
按 `uncertain` 交付并说明用户拒绝/未同意启动或需稍后重试。

## 技能 ID 硬入口

生成、基于现有技能修改，或检查/核对技能时，必须先由用户在当前任务中提供明确的正整数技能 ID。
不得从当前选中项、历史任务、搜索结果、相似配置或默认值推断 ID，也不得用节点 ID 代替技能
ID。缺少 ID 时只能原样回复 `请提供要生成、修改或检查的正整数技能 ID。`，随后结束当前轮；
不得添加解释或其它问题，不得读取模块、客户端或服务器，不得调用 Unity CLI、MCPRouter、P4，
不得生成或导入导出 JSON。追问后的下一条用户消息只包含一个正整数时，也视为用户明确提供了
技能 ID；不得要求用户重复“技能 ID”标签。用户补充 ID 后，才按本 Skill 的最小证据流程开始，并在方案和最终结果中原样记录
`targetSkillId`。多个 ID 必须先确认范围，禁止擅自批量处理。

Host 会把用户确认的技能 ID 绑定到当前任务。所有写入、最终结论、当前技能导入/导出、JSON 路径
和服务器报告都必须与绑定值一致；不一致时停止该工具调用并回到当前技能，不得把同类技能或旧
静态文件的结果当作当前技能证据。一个任务只允许这一个技能 ID；参考技能、历史样例和第二个
技能 ID 均不得读取、导出或写入。老版模块命令必须显式传 `skill_id`，不能依赖 Unity 当前打开
或选中的技能。

## 先决条件与事实源

开始核查时按顺序只取得：

- Host 注入的 `[SAGA2_PROJECT_PATHS]`，包括 `projectRoot`、`unityClientRoot`、
  `legacyModuleJsonTempRoot`、`unityAgentsPath` 和 `legacyModuleProtocolCodecPath`，不再调用
  `get_workspace_info`、猜测临时目录或自行拼接工程路径；
- `unity_inspect(action=status)`，并核对回执项目路径等于 `unityClientRoot`；
- Host 注入的 `[SAGA2_COMBAT_SERVER_TARGET]`。只有 `status: ready` 时才能创建服务器 Worker，
  `remote_host_id` 必须原样使用其中的 `serverRemoteHostId`，`agent` 必须原样使用其中的
  `serverWorkerAgent`；不得调用 `get_workspace_info`、实例列表或其它发现工具，也不得把项目 ID、
  显示名或 `saga2` 拼成 `mcpr:saga2`；
- 立即用 `legacy_module_export_json` 导出目标技能到操作系统临时目录。只有这次结构化回执明确
  返回目标资产不存在时，才把任务判为新建；文件搜索、旧导出、当前选中项和共享 JSON 都不能
  证明目标不存在；
- 目标导出后，先单独完整读取 `unityAgentsPath`，再单独完整读取
  `legacyModuleProtocolCodecPath`。这两个读取不得和搜索或其它命令放进同一个并行调用；禁止对
  `unityClientRoot` 或 `Assets` 根目录运行 `rg`、`Get-ChildItem`、`rg --files`。只有协议文件
  明确引用了另一个直接消费者且当前原子能力确实需要时，才对那个文件做一次定向读取。

完整读取 `legacyModuleProtocolCodecPath` 后，下一项项目动作必须是
`start_team(worker_permission_mode=auto)` 并派发当前技能的只读服务器核查。不得在两者之间对
`Assets/Editor/SkillEditor`、模块目录或其它客户端目录运行 `rg`、`Get-ChildItem`、`rg --files`
来发现伤害类型、数据函数、目标或模块枚举；这些运行时语义由当前服务器 HEAD 的 Worker 核实。
协议文件中出现的类型名、命名空间或 `using` 不是“明确引用了另一个直接消费者”；只有源码给出
当前原子能力对应文件的完整路径，或服务器报告明确留下一个客户端消费者缺口时，才允许随后
读取该单一文件。服务器报告回来之前没有这种缺口时，不再追加客户端 Shell 调用。

不得读取任何其它 Agent `SKILL.md`，不得调用 `ghost_info`、Skill 列表或项目管理 `list_tools`
发现辅助 Skill。不得读取历史任务留下的导出、共享的 `skill_entry_model_editor.json`，也不得扫描
`Library`、`Temp`、`Logs` 或 Unity 工程根目录。这个总控 Skill 已包含模块字段、连线和 JSON
协议；需要新的具体枚举或消费者时，直接在 Host 注入的 `unityClientRoot` 下定向读取源码。

只有发现业务规则冲突、字段语义冲突或客户端/服务器证据不足时，才按冲突点读取
`saga2_design` 中的具体章节；不得把战斗策划 Skill、治理规则或整份设计文档作为默认前置资料。
表现需求也在本总控流程内按具体资源或消费者取证，不加载 Timeline、Effect 或其它辅助 Skill。

事实优先级固定为：当前远端 HEAD 的服务器运行时消费者和解析约束 > 当前导出 JSON/表格 > Unity 模块编辑器
和现有资产 > 设计文档 > 口头假设。服务器是 MCPRouter 绑定的远程项目参考工作面，不能
用本地猜测、SSH、历史任务回执或旧分支替代。生成、修改和检查都必须在本任务为当前技能取得
一次 Host 验证的服务器报告；即使当前导出已与需求完全一致，也不能跳过。报告未验证为
`supported` 时，只能继续只读取证或按 `unsupported` / `uncertain` 交付，禁止写入。

## 策划输入与 Agent 内部翻译

本 Skill 的使用者可以完全不了解实现细节。策划输入只需要包含玩家可感知的设计意图：
触发场景、作用对象、效果、时长、次数、叠加/刷新规则、结束条件、例外情况和数值或表现
目标。`typ`、`kind`、`target` 数组、`time` 数组、节点 ID、JSON、编辑器操作、P4 和
服务器路径属于 Agent 内部工作，不得要求策划填写，也不得把它们作为开始配置的前置条件。

Agent 必须在内部把业务描述拆成原子能力，读取真实客户端/服务器证据，选择能表达意图的
模块组合并完成验证。默认直接推进，不把内部方案审批再交给策划。只有无法从上下文、项目
惯例或现有配置推断且会改变玩法结果的业务选择，才集中提出业务问题；问题应使用“单体还是
范围”“是否可叠加”这类设计语言，一次问完，不询问协议字段。

如果某个业务效果没有客户端或服务器能力，必须明确区分“已经实现的效果”和“无法保证的
效果”，给出最小的业务级替代方案或程序交接项；禁止猜测字段、伪造目标类型或静默改成
相似但不同的玩法。最终交付以业务结果为主，技术证据以简短可追溯附录呈现。

## 四阶段工作流

### 1. 理解需求和运行链路

先把自然语言拆成原子能力：入口/被动启动、触发事件、调度与次数、位置或目标来源、区域
筛选、锁定/继承、延迟、伤害/治疗、状态层数、特效、清理和终止条件。对客户端至少核对
Host 注入的 `legacyModuleProtocolCodecPath`，确认老版导入导出的字段与连线协议；只有需求明确
包含客户端 Timeline、动画、特效或释放表现时，才沿该具体入口读取一个直接消费者，不得把
日志文本中的 `BattleRoleSkill` 当成类型名搜索整个工程。对模块使用老版模块编辑器的
`legacy_module_export_json` 回读目标技能、节点和 Transition（当前官方 CLI 没有
未登记的模块查询接口，不得编造或反复尝试该名称）。Unity 的所有操作（包括老版模块编辑器的导入、保存、导出和回读）只能通过
Meka Unity 的 `unity_inspect` / `unity_execute` 官方 Unity CLI 完成。每个阶段第一次需要 Unity 证据时先调用
`unity_inspect(action=status)`；SAGA2 Unity Editor 是常驻进程，战斗工作流禁止再次调用
`unity_execute(action=open)`、重复执行“打开窗口”或重启命令，必须复用现有实例。status 失败时
不得调用 `pipeline install` 或其它安装/恢复命令；按上面的单次目标导出规则取得失败证据后，记录
证据缺口并继续不依赖 Unity 的服务器只读核查。老版模块编辑器是唯一的配置入口，底层协议字段以
本 Skill 的协议表和当前服务器消费者为准。

随后把目标技能导出回执（现有模块图或明确不存在）、老版模块协议字段和原子能力矩阵交给战斗角色的只读 MCPR 服务器 Worker，
核对服务器入口、目标处理器、模块执行分支和导出消费。Lead 不直接扫描服务器仓，也不能用
本地客户端代码代替远端证据。Worker 只记录与当前原子能力矩阵有关的证据；Lead 收到
auto-bridge 报告后必须原样调用 `validate_server_capability_report`。只有工具返回
`reportValidated=true` 且 `supportStatus=supported`，才可进入 P4 和老版模块导入阶段。
服务器报告必须包含与当前任务绑定值一致的正整数 `targetSkillId`；Host 在消费 auto-bridge 回执
前强校验该字段，错误或缺失的 ID 不能作为当前技能证据。
首次创建 Team 时显式调用 `start_team(worker_permission_mode=auto)`；只读服务器核查不得请求
Full access。创建 Worker 时原样使用 `[SAGA2_COMBAT_SERVER_TARGET]` 的 `serverRemoteHostId` 和
`serverWorkerAgent`；
目标状态不是 `ready` 时停止派发并报告服务器路由缺口，禁止猜测。派发成功后立即结束当前回合，
等待 auto-bridge，不调用诊断或轮询工具。

Lead 必须把当前原子能力对应的候选服务器符号明确写入 Worker 任务，不能让非技术策划提供这些
符号。对于普通伤害、攻击力百分比、等待/重复和技能目标锁定，候选搜索锚点分别为
`entryTypeDamageHit`、`dataFunRoleAtk`、`entryTypeTimeWait` 和 `entryTypeSetSkillTarget`；它们只是
搜索入口，不是免检结论，每轮仍须在当前远端 HEAD 核实定义、注册和执行分支。其它机制使用目标
老版导出中的精确 `typ` 数字和服务器报告已出现的精确枚举名作为锚点，不得编造。

Worker 第 3 次调用使用 `git grep -l -E <精确符号表达式> HEAD -- internal/battle` 只列出真实
路径；不得加入 `time`、`target`、`skill`、`damage`、`next`、`trigger` 或中文描述等通用词。
第 4 至 6 次对这些路径使用 `git grep -n -C 24 -E <精确符号表达式> HEAD -- <path>`，只读取
定义、注册和执行分支附近的上下文，不用 `git show` 打开大型实现文件，也不得猜测文件名。所有
搜索必须显式绑定 `HEAD`；若输出仍被工具层截断，不得用 `Read` 打开自动保存结果，应在剩余预算
内减少符号或上下文行数。服务器 Worker 不调用 `orca_worker_bridge`，只以唯一最终 JSON 回复
结束，由 Host auto-bridge 回传。

### 2. 集中澄清并形成方案

技能 ID 必须已经由用户绑定。随后一次性补齐仍影响数据结构的事项：create/rebuild/incremental、允许修改的表面、
目标与空间语义、时序和重复次数、叠加/刷新/清理、资源 ID、是否允许客户端代码变更，以及
未确认的服务器能力。方案必须包含以下回执，字段名保持不变：

```text
[SAGA2_COMBAT_CONFIG_PLAN]
targetSkillId: <用户确认的 ID>
changeMode: <create | rebuild | incremental>
surfaces: <module/timeline/table/export/client 的明确集合>
atomicRequirements: <逐项需求>
capabilityMatrix: <每项为 module-direct | module-composed | timeline | client | unsupported | uncertain>
jsonStrategy: <节点范围、入口和分支策略>
validationPlan: <Unity、导出、服务器和运行时检查>
remainingUnknowns: <none 或逐项列出>
[/SAGA2_COMBAT_CONFIG_PLAN]
```

用户明确要求实施时，方案只作为 Agent 内部检查点：完成证据、范围和字段核对后直接执行，
不要求额外的方案审批交互。服务器代码永远只作能力证据，不列入 `surfaces` 的实施面。

### 3. 生成并导入模块 JSON

默认把技能 ID 的完整节点范围视为 `skillId * 100 + 1` 到 `skillId * 100 + 99`；除非明确
要求增量，否则重建该范围并保留其它技能。每个节点都必须是可解释的协议对象：

- `id`、`typ`、`time`、`target`、`data`、`dataCondition`、`refresh`、层数、清理、概率、
  `next`/`trigger`/`elseTrig`/`bind`、`effects` 和目标排序字段逐项有来源；
- `time[1]` 是执行次数，未说明时使用一次；重复效果用持续时间/次数/间隔表达，不展开
  等价节点；
- 目标类型只使用服务器已核实的值，目标继承必须有直属上一步或事件记录作为前提；
- 事件→效果→同类事件、分支互回、无终止条件的重复链都要在写入前排除；状态、计数器和
  监听器必须有明确的宿主结束清理；
- 入口、Timeline 启动节点和普通模块是独立关系，不能用 Timeline 内容臆测模块行为；
- 只使用当前模块定义/预设表和服务器证据允许的字段，不把“看起来合理”的新类型硬塞进
  旧模块。
- 伤害数值必须先区分“固定数值”和“攻击力百分比”：服务器默认数据函数编码的是常量，
  不能把同类 JSON 中看似相近的 `data=[1,100]` 或 `data=[1,20]` 直接解释成 100%/20% 攻击力。
  `[4,p,1]` 是当前已知候选形状；本任务仍必须由服务器 Worker 在当前远端 HEAD 核实
  `dataFunRoleAtk=4`、参数顺序和尾字段后，才可分别使用 `[4,100,1]` 与 `[4,20,1]` 表达
  100% 与 20% 来源攻击力伤害。未取得本轮回执或新证据冲突时必须标记 uncertain 并停止写入。

导入草稿和回读 JSON 必须使用绝对路径，并且只允许放在操作系统临时目录或
`saga2_unity` 内；禁止在 `saga2_json`、`saga2_design` 或其它目录创建、覆盖临时产物。使用每轮
独立的临时文件，战斗角色不读取或修改共享的 `skill_entry_model_editor.json`。

导入前必须通过 Cindy 的 Meka P4 插件实际完成目标模块资产的版本控制动作，不能只看
`p4_status` 后假设已打开：

- 目标 `<skillId>.asset` 已存在时，先对该文件执行 `p4_edit`，并以插件成功回执为准；
- 目标资产不存在时，先通过官方 Unity CLI 调用 `legacy_module_prepare_asset(skill_id)` 只创建
  空白资产，再对返回的 `.asset` 和 `.meta` 分别执行 `p4_add`；两项成功后才能导入；
- P4 调用失败时停止导入并报告具体文件与失败原因，不得通过移除只读位或手改 `.asset` 绕过。

不得直接调用 `p4` CLI、P4V 或自行复制 P4 命令作为兜底。只替换目标技能节点范围，采用
结构化 JSON 解析或经过审查的最小补丁，禁止整文件重排和修改无关技能。

导入统一使用老版模块编辑器的“导入 Json 数据/当前技能”入口。通过 Meka Unity 官方 Unity CLI
的 `unity_execute(action=command, arguments=["legacy_module_import_json", ...])` 完成导入，
成功回执必须同时包含 `persistenceVerified=true`，且 `persistedNodeCount` 与导入节点数一致；
否则视为导入失败，不得继续声称已保存。随后再用 `legacy_module_export_json` 导出；不得调用
`open`、重启 Unity 或把编辑器视图字段写入服务器 JSON。若导入失败，保留现场并修正具体字段，
不通过手改 `.asset` 或绕过 P4 解决。

### 4. 逐字段验证与交付

导入后必须回读并完成以下闭环：

1. 先核对导入回执的磁盘重载验证，再用 `legacy_module_export_json` 对比节点数量、ID、入口
   标记和所有 Transition；同进程内存回读不能单独作为生效证据；
2. 通过老版模块编辑器官方导出入口导出服务器 JSON，并用结构化解析做 JSON round-trip；
3. 通过 Meka Unity 官方 Unity CLI 读取 Unity Console/编译状态，确认导入没有序列化错误；
4. 导出后的服务器 JSON 逐字段对照方案和服务器代码，特别是 `target`、`data`、条件、
   次数/间隔、清理和分支；
5. 检查 Timeline 是否仍指向正确的全局模块 ID、P4 状态是否只包含批准文件。SAGA2
   配置开发默认只做静态闭环，不要求进入游戏、Play Mode 或启动服务器；若用户明确要求
   运行时联调，再单独建立运行验证范围。没有运行时证据时不得声称运行时效果已验证。

运行验证命令不是默认阶段。静态配置阶段只需调用 `unity_inspect(action=status)` 确认官方
CLI 可用，再按需使用 `legacy_module_export_json` / `legacy_module_import_json`；不要为了
发现命令而把完整清单重复注入上下文，也不要调用未登记的模块查询接口。只有用户明确
要求运行时联调时，才按需调用 `editor_status`、`runtime_status`、`list_open_scenes`、
`find_gameobjects`、`console`、`list_tests`、`run_tests` 或 `eval`。`unity_inspect(action=list)`
仍保留为通用能力，但仅在命令名称未知时调用并筛选目标项，禁止原样转述 150 项清单。

最终回复包含：

```text
[SAGA2_COMBAT_CONFIG_RESULT]
targetSkillId: <ID>
implementedSurfaces: <实际修改面>
moduleGraph: <入口、关键节点和分支摘要>
fieldValidation: <通过/失败、磁盘持久化回读及证据路径>
serverCompatibility: <supported | unsupported | uncertain + 证据>
runtimeValidation: <已执行或未执行>
remainingRisks: <none 或逐项列出>
[/SAGA2_COMBAT_CONFIG_RESULT]
```

`serverCompatibility: supported` 必须同时引用本任务已验证报告的远端 `head` 和至少一个
`codeEvidence`；没有 `reportValidated=true` 时只能写 `uncertain`，且 `remainingRisks` 不能写
`none`。当前资产已经符合需求只允许省略重复导入，不允许省略服务器核对。

任何 `unsupported` 或 `uncertain` 都必须阻止当前实现，转成给服务器程序或客户端程序的
原子交接项；不能用“模块组合应该能实现”替代权威证据。
