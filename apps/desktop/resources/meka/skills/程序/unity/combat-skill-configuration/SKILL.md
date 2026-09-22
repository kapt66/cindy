---
name: combat-skill-configuration
description: 按客户端、服务器和模块节点的共同契约设计、生成、导入并验证 SAGA2 战斗技能与关卡机制配置。仅在战斗开发任务中使用，不替代服务器代码修改或通用 Unity 编程。
metadata:
  display-name: 战斗技能配置
  purpose: 用模块组合和可审计 JSON 交付真实可验证的战斗机制
---

# SAGA2 战斗技能配置

本 Skill 只规定**流程与权限**；**领域事实不在本文件内**，从 Host 注入读取：`moduleEditorSkillPath`
（老版模块编辑器命令契约与参数名、节点/连线字段、`time`/`data`/`dataCondition` 编码、`@N` 映射、
`moduleType` 与 target 字典）、`damageEncodingRulePath`（策划侧权威规则，含伤害 `data` 编码）。这两条
与 `unityAgentsPath`、`legacyModuleProtocolCodecPath` 是本项目**唯一允许读取**的项目文件，必须优先用
**原生文件读取工具（read）**读取：它按 UTF-8 解码，不会把 CJK 正文读成乱码。仅当原生工具不可用时才
改用注入的 ReadCommand，且必须逐字复制（已带 `-Encoding UTF8`，不得删改或省略编码参数）；
不得读取任何其它 Agent `SKILL.md`，不得枚举 `.agents/skills/**`，不得用记忆或旧快照替代；本文件
没有的表与命令细节按资料取证。“技能”指游戏玩法技能。

**编码守卫**：任何参考读取只要返回乱码或替换字符（mojibake），该次内容一律视为**未读到**，不得解释、
摘录或据此得出任何域结论（“乱码但大意可读”不成立）。必须改用原生文件读取工具重读；重读仍乱码时按
资料不可读处理并如实交付，不得凭乱码内容推断模块字段、编码或伤害语义。

## 请求分类（零工具调用）

- `single-skill`：用户明确给出正整数技能 ID（「技能 ID / 技能 / 编号」标签，或整条消息只有该正整数）。
- `table-scope`：范围由配置表或项目规则决定、用户未给 ID，如「所有怪物技能」「怪物配置表里配置的
  正在使用的」。
- 负号编码的技能参数引用、`moduleType` 数值、节点 ID 都不是技能 ID（具体取值与含义以注入的项目
  参考资料为准，本文件不重复枚举）。
- `table-scope` 不得套用单技能流程、不得追问技能 ID，**也不得回复「请提供正整数技能 ID」**；两者都不
  成立时才按缺 ID 规则追问并结束当前轮。
- Host 绑定值未经用户确认时只是候选，不得当作已确认绑定；启发式候选永远不能成为 `confirmed`。

## single-skill：技能 ID 硬入口

ID 只能由用户在当前任务中明确提供；不得从当前选中项、历史任务、搜索结果、相似配置或默认值推断，
也不得用节点 ID 代替。缺少 ID（或 `skill_001` 这类无数字映射的别名）时只原样回复
`请提供要生成、修改或检查的正整数技能 ID。` 并结束当前轮：不读取文件，不调用 Unity CLI、MCPRouter、
P4，不生成或导入导出 JSON。追问后只含一个正整数的下一条消息也视为明确提供；多个 ID 且无范围口径时用
同一句追问，不擅自批量处理。Host 绑定的 ID 是本单技能任务的唯一目标，写入、导入/导出与服务器报告都
必须与它一致；不得读取、导出或写入参考技能或第二个 ID。老版模块命令必须显式传 `skill_id`，不能依赖
Unity 当前选中项。

## table-scope：范围解析与写入前确认

1. **先取只读全集**：用 `legacy_module_query_nodes --skill_ids ... --module_type ...` 一次拿到命中节点
   全集（含归属 `skillId`、现 `data`、`assetPath`），不逐技能导出。`matchedNodeCount` 是命中总数，不因
   截断减少；`truncated=true` 表示 `rows` 不完整，必须收窄 `skill_ids`/`module_type` 后重试，**不得按
   不完整结果写入**。
2. **在用集合自己算**：必须由你从请求声明的源表解析（`Skills ∪ Atks` 与技能表对账），源表、字段与
   口径以请求声明和注入的项目参考资料为准；解析结果再通过 `--skill_ids` 传给查询命令；
   `--require_referenced_by_monster true` 尚未实现且 fail-closed，不要依赖它。
3. **分离无资产技能**：用 `legacy_module_audit_coverage --skill_ids ... --export_json_path ...` 区分有
   `.asset` 的技能与只在导出 JSON 里的技能（`jsonOnlySkillIds`）——后者正是导出会删节点的成因，必须
   归入额外内容并询问用户；省略 `export_json_path` 时 `exportChecked=false`，不得据此声称覆盖已全清。
4. **写入前一次性确认**：把「解析出的范围 + 精确改动集 + 超出表面清单 + 口径歧义」用业务语言一次
   问完；**确认前不得写入，也不得导入/导出**。来源不可读或口径有歧义时停止并请用户裁定，不得自行
   选子集继续，不得让启发式结果充当已确认绑定。
5. 确认后逐目标执行，报告逐目标状态；未获确认或超出表面的目标必须显式标为未完成。

## 工具面（唯一形态）

经公共 `ghost_call` 使用已安装插件（ghost）。**插件不是 MCP 服务器**：`meka-unity`、`meka-p4` 是
插件 id，只能作为 `ghost_id`；不得用 `ghost_info`、`ghost_list` 或 Skill 列表发现辅助 Skill 或其它
插件。首次执行 `ghost_call` 前先用 `cindy_mcp_list_tools` 披露一次 schema，参数为
`{"server": "cindy", "tool": "ghost_call"}`——唯一允许的披露调用。随后只按已登记形态执行，不试探
未登记的命令名或旗标；老版模块命令的调用形态与参数名（`skill_id`、`path`、`clear_existing`）以
`moduleEditorSkillPath` 为准，不自造未声明旗标名。

首个调用是 status 探针：`ghost_id=meka-unity`、`tool=unity_inspect`、`args` 为
`{"action": "status", "projectPath": "<unityClientRoot>", "format": "json"}`，路径原样取自注入，回执
必须显示可用实例且 `projectPath` 等于它。Editor 常驻：常规配置复用现有实例，不重启、不安装；只有插件
返回「需要启动目标工程」的结构化恢复信号时，才直接请求 `unity_execute(action=open)`，由 Host 用 Cindy
通用确认框接管询问，用户同意后才在同一工具调用内执行**一次**——不得静默启动、不得在 Agent 对话正文自行
询问、不得循环重试；status 失败时按一次导出取得失败证据并继续不依赖 Unity 的工作。

只读与写入走不同通道：只读 Pipeline 命令用 `unity_inspect(action="command", projectPath=
"<unityClientRoot>", arguments=[...], format="json")`，插件只放行固定白名单
（`legacy_module_query_nodes`、`legacy_module_audit_coverage`、`module_v2_snapshot`、
`module_v2_component_catalog`、`module_v2_pattern_catalog`、`find_assets`、`get_serialized_fields`、
`get_console_logs`、`editor_status`）；`legacy_module_export_json`、`legacy_module_import_json`、
`module_v2_arrange/capture/validate_all`、`eval`、`run_script` **不在白名单**，必须走 `unity_execute`。
不要把只读命令塞进 `unity_execute`，也不要试探白名单外的命令名。

## 证据纪律

- `single-skill` 的第一条内容证据必须是通过老版编辑器导出的目标技能 JSON（消费回执中的
  `data.legacyModuleExport.payload`，不用 Shell 回读临时文件），导出后分别单独完整读取
  `unityAgentsPath`、`legacyModuleProtocolCodecPath`，再读 `moduleEditorSkillPath` 与
  `damageEncodingRulePath`，不得与搜索并行；这四条都用原生文件读取工具读取，出现乱码即视为未读到
  （见上文编码守卫）。`table-scope` 的第一条内容证据是范围来源的只读解析，
  此时不得先导出单个技能。只有协议文件明确引用了另一直接消费者且当前原子能力确实需要时才定向读该
  文件一次。
- 禁止递归读 `saga2_design`、重复读同一文件、为无关能力扩展搜索；禁止对 `unityClientRoot`、
  `Assets` 根、`Library`、`Temp`、`Logs` 运行 `rg`、`Get-ChildItem`、`rg --files`；不读历史导出或共享
  的 `skill_entry_model_editor.json`——唯一例外是步骤 3 里对它做的那一次
  `legacy_module_audit_coverage --export_json_path …` 显式只读比对。
- 每个未决业务原子最多两轮定向核查；足够即收口，仍无结论就停止工具调用，按“可实现 / 无法保证 /
  待确认业务选择”交付，任何阻塞都必须产出可见结论。事实优先级：注入资料与导出 JSON/表格 > 编辑器
  与现有资产 > 远端 HEAD 消费者（冲突裁决证据）。

## 服务器核查（条件触发）

注入资料已覆盖当前运行时语义时直接引用资料路径与结论，**不派发服务器 Worker**，也不得把项目权威
规则降级为 `uncertain`。只有资料未覆盖该语义、资料冲突或与客户端证据冲突时才派发一次窄范围只读
核实：`[SAGA2_COMBAT_SERVER_TARGET]` 必须 `status: ready`，`remote_host_id` 与 `agent` 原样使用
`serverRemoteHostId`、`serverWorkerAgent`，不得调用 `get_workspace_info` 或实例列表；显式
`start_team(worker_permission_mode=auto)`，Worker 任务含 `[SAGA2_SERVER_EXPLORATION_READ_ONLY]` 与
`[SAGA2_MODULE_FIRST]`、只读。`table-scope` **不逐目标派发**：服务器路由键只为唯一正整数绑定目标注入，
表范围没有该绑定，派发与报告校验必然不匹配；资料未覆盖又必须核查时，改绑范围内一个已确认的技能 ID，
退回单技能流程完成这次核查（一次只绑一个 ID），报告的 `targetSkillId` 写该 ID。派发后
立即结束回合等 auto-bridge，收到报告必须原样调用 `validate_server_capability_report`，以
`reportValidated=true` 且 `supportStatus=supported` 为写入前提，否则按 `unsupported`/`uncertain` 交付。

## 可写表面与额外内容

可写表面只有一条：**老版模块编辑器能寻址的编辑器模块资产**（`Modules/<skillId>.asset`，经
`legacy_module_import_json` 导入）。导入必须显式 `--clear_existing true`：协议只支持目标技能范围的
全量替换，未定义增量语义。导入前必须通过 Meka P4 插件实际完成版本控制（已有资产先
`p4_edit`），仅查 `p4_status` 不算前置；回答「这个文件被谁 open／锁了、锁类型、版本」用只读的
`p4_opened` / `p4_fileinfo`；不得直接调用 `p4`、P4V 或复制 P4 命令兜底，不得手改
`.asset`、移除只读位或绕过 P4。临时 JSON 只放操作系统临时目录或 `saga2_unity`，不得写入
`saga2_json`、`saga2_design` 或其它目录；只替换目标技能节点范围，不整文件重排、不动无关技能。

**额外内容必须单独询问用户**，取得明确同意后才可执行；未获同意时不得执行、不得静默降级，只能在
报告中标为未完成：技能表/配置表参数（含伤害倍率来源的参数槽；具体槽位以注入的项目参考资料为准）；
没有模块资产的技能（节点只存在于共享导出 JSON，即 `legacy_module_audit_coverage` 的
`jsonOnlySkillIds`）；**共享 `skill_entry_model_editor.json` 的全量导出管线**（它会按存在的资产重写
共享 JSON，丢弃没有资产的技能的节点，风险最高，必须由用户拍板）——这里**不含**单技能导出到临时目录
的只读回读（`legacy_module_export_json`，那是读取证据而不是共享写）；**P4 提交（`p4_submit`）、
revert、sync 或任何写仓库／丢弃他人改动的动作**（不可逆，必须由用户明确要求，不得推断）；Timeline、
Effect、客户端/服务器代码、`saga2_json`、`saga2_design` 及其它表面。

## 方案与执行

范围（单技能 ID 或已确认的表级范围）明确后，一次补齐影响数据结构的事项（创建/重建模式、允许修改的
表面、目标与时序、叠加/清理、资源 ID、是否允许客户端代码变更、未确认能力）。字段名保持不变：

```text
[SAGA2_COMBAT_CONFIG_PLAN]
scopeKind: <single-skill | table-scope>
targetSkillId / targetSkillIds: <single-skill 写用户确认的 ID；table-scope 写 none 与已确认列表>
changeMode: <create | rebuild>（导入只支持全量替换，`--clear_existing true` 必填）
surfaces: <module/timeline/table/export/client 集合>
atomicRequirements: <逐项需求>
capabilityMatrix: <每项 module-direct | module-composed | timeline | client | unsupported | uncertain>
jsonStrategy: <节点范围、入口和分支策略>
perTarget: <逐目标改动集与状态>
outOfSurfaceTargets: <超表面目标及原因>
validationPlan: <Unity、导出、服务器和运行时检查>
remainingUnknowns: <none 或逐项>
[/SAGA2_COMBAT_CONFIG_PLAN]
```

用户明确要求实施且范围已明确时，方案只是内部检查点，直接执行（`table-scope` 的写入前确认是范围确认，
不是方案审批）；服务器代码只作能力证据，不列入 `surfaces`。

1. 按 `moduleEditorSkillPath` 的命令契约生成并导入模块 JSON，导入必须显式 `--clear_existing true`
   （全量替换目标技能范围，协议未定义增量语义）。资产不存在时命令返回失败（“技能模块资产不存在”）；
   **没有**创建空白资产的命令，不得调用或试探任何“创建资产”命令名，也不得手改 `.asset` 代替——该
   目标归入额外内容，报告并询问用户。
2. 导入成功的判据是回执 `success: true` 且 `importedNodeCount` 等于本次导入节点数；回执字段就是
   `success / skillId / importedNodeCount / clearExisting / sourcePath / message`。本协议**不存在**
   `persistenceVerified` 或 `persistedNodeCount`，不得以不存在的字段判定导入失败；持久化验证由随后
   `legacy_module_export_json` 的结构化回读完成（`success / skillId / exportedNodeCount / targetPath /
   message`）。
3. 回读比对节点数量、ID、入口标记和所有 Transition（同进程内存回读不算生效证据），再读 Unity
   Console/编译状态确认无序列化错误，并检查 Timeline 与 P4 状态只含批准文件。默认只做静态闭环，
   不进入游戏、Play Mode 或启动服务器；无运行时证据时不得声称运行时效果已验证。

## 交付

```text
[SAGA2_COMBAT_CONFIG_RESULT]
scopeKind: <single-skill | table-scope>
targetSkillId / targetSkillIds: <single-skill 写该 ID；table-scope 写 none 与已确认并处理的目标>
implementedSurfaces: <实际修改面>
moduleGraph: <入口、关键节点和分支摘要>
perTarget: <逐目标实际结果与状态>
outOfSurfaceTargets: <未执行或超表面目标及原因>
fieldValidation: <导出回读与证据路径>
serverCompatibility: <supported | unsupported | uncertain；资料覆盖路径引用注入资料路径，Worker 路径引用已验证报告的 head 与 codeEvidence>
runtimeValidation: <已执行或未执行>
remainingRisks: <none 或逐项>
[/SAGA2_COMBAT_CONFIG_RESULT]
```

`serverCompatibility` 只有两条互斥路径，按本次实际取证方式二选一：

- **(a) 资料覆盖路径**（注入的项目参考资料已覆盖该运行时语义，未派发 Worker）：必须写 `supported`，并
  引用被引用的注入资料路径与结论——这条路径**没有** `reportValidated`，不得因此降级为 `uncertain`。
- **(b) Worker 路径**（资料未覆盖、资料冲突或与客户端证据冲突，派发过一次只读服务器核查）：`supported`
  必须同时引用已验证报告的远端 `head` 与至少一个 `codeEvidence`，且 `reportValidated=true`；只有报告
  回执、没有验证通过时只能写 `uncertain`。

两条都不成立时不得写 `supported`：只能写 `uncertain`（`remainingRisks` 不能写 `none`），或按报告写
`unsupported`。任何 `unsupported`、`uncertain` 或未获同意的额外内容都必须阻止对应实现并转成原子交接项。
