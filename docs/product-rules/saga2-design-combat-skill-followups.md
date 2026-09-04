# SAGA2 设计库战斗技能工具链待审清单

状态：待用户审查；本清单只记录后续建议，不授权自动修改 `saga2_design`。

日期：2026-09-01
扫描范围：`saga2_design/planning/04-职能组-functional-groups/战斗策划组-combat-planning` 只读扫描
本轮实施范围：`saga2_unity`、Cindy、`cindy-meka-plugins`
明确排除：`saga2_design` 全部目录，尤其 `planning`

## 结论摘要

设计库目前同时存在两套互相冲突的模块配置口径：一套要求同时维护模块 Asset 与
`skill_entry_model_editor.json`，另一套（当前 Cindy 实施链）应以老版模块编辑器 JSON
导入/导出为唯一配置入口。设计库还保留 P4 CLI/P4V 兜底、机器相关绝对路径和旧的编辑器
函数名。这些内容会使 Agent 在真实任务中绕过 Cindy 插件、误写受管 Asset 或把不存在的
接口当成可调用工具。

本轮没有改动设计库文件；以下条目交给用户审查后，再决定是否在后续独立变更中处理。

## 需要后续修改的活动文件

| 优先级 | 文件                                                                                                                                        | 证据                                                                                                                      | 建议                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| P0     | `planning/04-职能组-functional-groups/战斗策划组-combat-planning/skills/saga2-project-battle-designer/SKILL.md`                             | 第 125、302、309 行仍要求 Asset+JSON 双写，并在第 302 行描述旧 P4 状态路径；第 30、31、77、78 行含机器绝对路径/Excel 路径 | 统一为老版 JSON 导入/导出主链；P4 只走 Cindy Meka P4；路径改为当前工作区相对路径；增加 `saga2_design` 只读边界和静态验收默认值 |
| P0     | `planning/04-职能组-functional-groups/战斗策划组-combat-planning/skills/saga2-project-battle-designer/references/skill-module-authoring.md` | 第 16、26、44-50 行要求 Asset+JSON 双写并直接使用 `p4 login/fstat/edit`                                                   | 改为 JSON 生成→老版编辑器导入→导出 round-trip；把服务器代码作为只读语义证据；删除 CLI/P4V 兜底                                 |
| P0     | `planning/04-职能组-functional-groups/战斗策划组-combat-planning/专业规则-rules/ModuleDesignKnowledge.md`                                   | 第 311-331 行仍以 Asset+JSON 双写为默认，第 327 行要求 P4 状态探测                                                        | 重新裁决“配置入口”和“只读资产证据”；保留字段语义，但把写入动作收敛到老版 JSON CLI 与 Cindy P4                                  |
| P1     | `planning/04-职能组-functional-groups/战斗策划组-combat-planning/skills/saga2-project-battle-designer/references/perforce-workflow.md`      | 第 24-40、56 行把 P4V/P4 CLI 作为恢复与 checkout 方式                                                                     | 改为 Meka P4 插件能力和失败回执；未暴露能力时停止，不建议 Agent 复制命令行                                                     |
| P1     | `planning/04-职能组-functional-groups/战斗策划组-combat-planning/skills/saga2-project-battle-designer/references/update-scan.md`            | 第 32-33 行要求 `p4 login -s`、`p4 sync`                                                                                  | 将更新扫描改为 Meka P4 插件的只读状态/同步能力；保留扫描结果格式                                                               |
| P1     | `planning/04-职能组-functional-groups/战斗策划组-combat-planning/skills/saga2-alias-skill/SKILL.md`                                         | 第 66、78、94-135 行包含旧全局 Skill、绝对路径和 P4 CLI/client 管理流程                                                   | 该 alias 当前不应注入 Cindy；后续若继续维护，应明确“只读迁移提示”或停用，避免与项目 Skill 分叉                                 |

活动文件统计：**6 个**（3 个入口/规则 Skill，3 个 reference/alias 规则文件）。

## 需要程序评审的设计提案

以下 6 个提案文件声明了新的模块类型、服务器导出或编辑器字段，但没有在本轮进行服务端
能力确认；它们不应被 Agent 直接转成生产 JSON：

1. `文档库-proposals/机制草案-draft/被动技能系统机制草案-20260818.md`
2. `文档库-proposals/机制草案-draft/血量均摊机制_health-pool-equalization.md`
3. `文档库-proposals/机制草案-draft/敌方强制位移与牵引机制草案-20260821.md`
4. `文档库-proposals/机制草案-draft/攻击方向判断与方向增伤机制草案-20260821.md`
5. `文档库-proposals/机制草案-draft/技能按键替换机制草案-20260730.md`
6. `文档库-proposals/机制草案-draft/区域进出检测与持续效果机制草案-20260819.md`

提案统计：**6 个**。后续处理顺序建议为：先由服务器程序确认模块消费者/字段编码，再由
客户端程序确认导出和消费者，最后才更新设计规则或生成技能配置。

## 仅作历史证据，不建议改写

以下归档记录包含旧路径、旧流程或历史冲突，用来解释为什么需要本清单；本轮不修改：

- `版本存档-history/saga2-project-battle-designer-skill-682bb53f/records.md`
- `版本存档-history/saga2-alias-skill-skill-a25d8236/records.md`
- `版本存档-history/moduledesignknowledge/records.md`

## 审查与后续入口

- 本清单不是设计需求，也不是写入授权；用户审查后可逐条决定是否纳入后续变更。
- 设计库变更若获批准，应在独立任务中执行，并继续保持 Cindy、Unity 和插件边界一致。
- 本轮 Cindy Host 已对 `saga2_design/planning` 写入做 fail-closed 阻断；只读读取仍可用于
  需求和语义证据。
- 生产技能配置的默认验收仍是客户端消费者、老版 JSON round-trip、服务器只读契约和 P4
  范围；不要求进入游戏或 Play Mode。

## 本轮实施与验证记录

### Host Shell 策略错误提示

战斗任务可能因为路径、证据范围或工具边界触发 Host Shell 策略阻止。该阻止继续使用
稳定错误码 `host-shell-command-blocked`，但共享 Renderer 文案必须保持任务通用，不能
把所有 Host 策略误称为 iOS 模拟器绕过。具体的战斗策略原因仍通过事件的 `message` 保留，
便于日志和 Agent 诊断；用户应按当前角色要求的专用工具或只读证据入口继续。

- Cindy 侧已将 SAGA2 战斗角色的配置入口收敛为老版模块编辑器 JSON 导入/导出；其它编辑器
  和 Unity 桥接不参与当前闭环，也不重新打开常驻 Unity。
- Unity 官方 CLI 只读检查已通过：目标工程 `saga2_unity` 的 Editor 为 `ready`，版本
  `6000.3.18f1`，PID `32192`；Pipeline 工具发现返回 150 项。未进入游戏、Play Mode 或
  启动服务器。
- 技能 1010 的静态配置证据已完成：节点 101011--101017 保持连线，节点 101016 的
  `typ=30003` 使用 `dataCondition=[30,5,90,0]`、`data=[]`；这与客户端旧模块协议和
  MCPRouter/服务器 `eventCheckHandlerHasTargetInFacing` 的 `CondExpr` 消费语义一致。
- 本轮通过常驻 Editor 的官方 CLI `legacy_module_export_json(skill_id=1010)` 再次导出，结果为
  7 个节点；与项目当前 JSON 按节点 ID 深比较为 `exact=true`，导出字段和连线保持一致。
- Cindy 定向回归：6 个测试文件、207 项通过、2 项平台跳过；Desktop typecheck 通过。
- Meka P4 插件已在当前 Cindy 会话安装并可用：ledger 记录 `meka-p4`、版本 `1.0.60`、
  `installed=true`；同一会话真实调用 `ghost_list`、`ghost_info("meka-p4")` 和
  `meka-p4.p4_status` 均成功。`p4_status` 返回 `ok=true`、根目录
  `C:\\Workspace\\saga2\\saga2_project`、`source=meka`，并明确返回 `unstaged` 与
  `staged` 文件列表（当前 `staged` 为空）。本轮未执行同步、checkout、提交或其它 P4
  写操作。

## 2026-09-02 实际回放补充

- 通过 Meka Unity 官方 CLI 直接复用已连接的 Pipeline 服务（`127.0.0.1:7800`）执行
  `editor_status`，返回 `status=ready`、`compiling=false`、`domainReloadInProgress=false`、
  `playMode=stopped`、Unity `6000.3.18f1`。
- 同次回放中，CLI 的全局 `status` 返回 `STATUS_NO_INSTANCES`，但工程级 `editor_status` 和
  `list` 均能访问 `127.0.0.1:7800`。因此当前“实例发现”与“Pipeline 工程连接”存在口径差异；
  配置回放以工程级命令为证据，`status` 适合继续作为防止误 `open` 的保守门禁，待后续统一
  两种状态来源后再放宽。
- 真实执行老版 `legacy_module_import_json(skill_id=1010, clear_existing=true)`，返回
  `importedNodeCount=7`；随后导出到临时 JSON，结构化比较为 `roundTripExact=true`，节点
  `101016` 的 `typ=30003`、`dataCondition=[30,5,90,0]`、`trigger=[101017]` 保持一致。
- 真实启动 Meka Unity Worker 做协议回放：缺少导出路径时，Worker 返回
  `success=false`、`errors[0].code=UNITY_COMMAND_FAILED`；合法路径时返回
  `success=true`、7 节点。此前外层 CLI 会把嵌套的 `data.result.success=false` 误报为成功，
  已在 `meka-unity` Worker 中修复并补充 16 项插件测试。
- 实测发现 Unity 工程仍保留一套历史编辑器桥接依赖，且相关编辑器脚本仍编译依赖它。这不
  影响本次官方 CLI 回放，但与“项目连接只走官方 Unity CLI”的清理目标不一致；本轮不擅自
  移除，需单独评估这些历史桥接代码的替代方案。

## 2026-09-02 实际对话收敛性回归

- 在已登录的 Cindy 真实任务 `SAGA2技能1010静态配置回归测试` 中发送后续追查请求；复用当前
  `saga2_project`、`战斗开发` 角色和常驻 Unity，未启动第二个 Cindy，未调用 Unity `open`、
  重启、历史桥接入口、开发中编辑器或服务器运行时。
- 首次追查请求确实调用了 `Meka Unity · unity_inspect` 和 MCPRouter 只读搜索，但约 10 分钟内
  反复读取远程文件并触发多次上下文压缩，未形成最终答复。该回放记录为对话链路“不收敛”，
  不能把中间状态当作完成结果。
- 在同一任务中发送“只基于已有回执、禁止继续工具调用、10 行内总结”的收敛复测后，约 16 秒
  完成最终答复。答复明确确认：服务器条件 30 只返回布尔值，不会把敌方目标写入 101017；
  `101017.target=[1]` 解析为自身；普通技能结束、角色死亡和外部重置均没有足够证据证明会清理
  `101015` 的永久监听，战斗结束清理调用仍未找到。
- 该回放证明当前 Agent 能在已有证据约束下给出高质量风险结论，但远程代码搜索阶段仍有
  工具调用过深、上下文膨胀和无法自动收敛的产品问题；后续应在角色提示或工具预算层增加
  证据范围、搜索次数和“先总结再扩展”的硬门槛。

## 2026-09-02 业务优先输入契约

- 针对非技术策划的真实使用方式，战斗角色和通用开发角色现明确把“玩家可感知的设计意图”
  作为输入契约：触发场景、作用对象、效果、时长、次数、叠加/刷新、结束条件、例外和
  数值/表现目标即可开始工作。
- `typ`、`kind`、`target` 数组、`time` 数组、节点 ID、JSON、编辑器操作、P4、服务器路径
  和 Unity CLI 均属于 Agent 内部实现细节；角色不得要求策划填写或理解这些内容。Agent
  必须自行完成业务意图到模块图的翻译，并只在会改变玩法结果且无法推断的业务选择上提问。
- 技术能力不足时，交付格式改为“已实现的业务效果、无法保证的业务效果、证据、业务级替代
  方案/程序交接项”，禁止猜字段或静默改成相似玩法。技术证据保留为简短附录。
- 已增加内置角色回归测试，确保 `combat-development` 与 `general-development` 都持续包含
  该业务优先契约。该改动未改变工具暴露、权限门禁、Unity 常驻复用或服务器只读边界。
- 真实 Cindy 业务输入回放使用完全不含技术字段的描述（冲刺、前方敌人、嘲讽、一次伤害和
  持续伤害）。Agent 未向策划索要模块类型、字段、JSON、节点编号、编辑器或命令，自动完成
  静态能力核查，并以业务语言交付：可实现“冲刺开始检测前方目标、选择最近目标、嘲讽、一次
  伤害和间隔持续伤害”；无法保证“冲刺碰撞命中才触发”以及多个效果始终锁定同一目标；需要
  程序确认目标锁定、持续伤害换目标和监听清理等业务选项。该回放验证了非技术策划可以只
  提供设计意图，技术翻译由 Agent 内部承担。

## 2026-09-02 严格业务需求实际对话复测

- 在已登录 Cindy 的 `SAGA2` 普通任务中重新选择 `战斗开发`，提交完全业务化需求：蓄力、向前冲锋、撞到第一个敌人后一次高伤害与短暂打断、冲锋结束后的范围持续伤害，以及效果结束后的清理；同时明确禁止技术字段、配置格式、节点编号、编辑器操作、命令、进入游戏和启动服务器。
- 终态答复按“可以可靠实现的玩家体验 / 当前静态证据无法保证的体验 / 需要确认的业务选择”三部分输出。答复没有要求策划填写模块类型、目标数组、时间数组、JSON、节点编号或工具命令，也没有编造端到端碰撞事件链；对“冲锋途中第一个真实碰撞目标”和“严格在冲锋结束瞬间接续”明确标记为无法保证，并给出业务级替代选择。
- 回放期间首轮深度探索在 UI 中超过 4 分钟才收敛，需发送一次“只基于已有证据、禁止继续搜索”的收束消息；收束后任务日志形成完整终态。该现象说明业务契约和输出质量已达预期，但探索预算/自动收敛仍需后续优化。本次未重启 Cindy、Unity 或服务器，未调用 Unity `open`、历史桥接入口、开发中编辑器或 Play Mode，也未修改设计库或技能配置。
- 后续通用入口复测发现 `includeAllProjectMetadata` 会把设计库元数据全量注入，已关闭该默认项；同时将证据预算片段挂载到通用角色，并把同样的停止条件提升到 `combat-skill-configuration` 与 `skill-entry-model` Skill 顶部。关闭全量元数据后仍观察到既有运行时任务继续读取长设计文档，说明当前 Cindy 进程/任务可能持有旧角色快照；该复测已停止，不能宣称收敛问题完全解决。角色种子回归测试仍为 4/4 通过。

## 2026-09-02 战斗角色真实复测补充

- 旧版 SAGA2 项目快照可能仍引用已重命名的 `skill-entry-model`。Cindy 运行时对
  `saga2/combat-development` 与 `saga2/general-development` 都在加载技能前做内存兼容迁移到
  `saga2-entry-model`；战斗角色同时刷新旧快照的战斗 prompt/fragment，通用角色保留通用角色
  prompt，仅替换过期技能引用。两条路径都不改写 P4 下 `.meka/project.json`，因此普通对话可以
  先由通用角色接住，再按自然语言切入战斗工作流。
- 真实发送曾因旧 Skill ID 直接触发 `unknown bundled Meka skill`；迁移后新任务已能启动并
  复用常驻 Unity 官方 CLI、访问 MCPRouter 只读能力。
- 真实任务曾出现外部 `spreadsheets/SKILL.md` 读取和 `rg --files saga2_unity/saga2_json`
  全量枚举，造成上下文膨胀。当前战斗提示词、策略分类器和普通 Shell 生产执行点均已排除外部
  Skill、项目 Skill 递归枚举和客户端/配置仓库全量文件枚举；精确消费者/配置读取保留。
- 证据预算进一步增加硬上限：环境检查后最多 8 次成功证据调用，探索超过约 3 分钟立即
  交付阶段性业务结论；服务器远端最多一次定向搜索加一次窄文件读取。
- 旧角色快照兼容迁移同时恢复当前 bundled 战斗角色的 `projectMetadataSelection`，避免旧
  快照继续注入 `saga2_design` 治理规则；P4 快照仍只读保留，用户自定义文件不被自动回写。
- 战斗角色关闭 `useProjectDefaults`，不再注入项目根通用治理框架；战斗自身 prompt、Skill
  和 Host 门禁成为唯一运行时工作契约，通用角色行为不受影响。
- 本轮未进入游戏、未启动服务器、未重启 Unity；服务器远端读取能力缺失时 Agent 已停止
  重试并将受影响语义标为无法保证。下一次真实任务需在 Host 门禁更新后确认扫描调用被拒绝，
  并观察是否在最小证据包后收敛。

## 2026-09-02 技能 ID 与 1019 真实配置回放

- 在已登录的 Cindy 隔离开发实例中选择 `SAGA2` 的“战斗开发”角色，先发送不含技能 ID
  的纯业务需求。Agent 最终只回复“请提供要生成的正整数技能 ID”，没有读取客户端、服务器
  或配置文件，也没有调用 Unity CLI、MCPRouter 或 P4；随后在同一任务中补充技能 ID `1019`。
- 使用完全业务化需求：立即对当前敌人造成 100% 攻击力伤害；1 秒后对同一敌人追加 3 次
  20% 攻击力伤害，每次间隔 1 秒；只做静态配置和字段验证，不进入游戏、不启动服务器。
- Agent 通过常驻 Unity 的官方 CLI 和老版模块编辑器完成导入。首次 3 节点草稿被逐字段回读
  发现把立即伤害放在 1 秒等待位置，Agent 主动阻止并修正为 4 节点有限链：入口
  `101901` → 立即伤害 `101911` → 等待 1 秒 `101921` → 追加伤害 `101922`。
- 最终 Cindy 回执为 `targetSkillId: 1019`、`fieldValidation: 通过`、`serverCompatibility:
supported`。回读确认目标链为当前目标 `[4]` → 上一步目标 `[5]`，伤害数据为 `[4,100,1]`
  与 `[4,20,1]`，时序为立即、1 秒后、2 秒后、3 秒后，且使用服务器 commit
  `3cf1064f1ddfe1d9960d913b3fbeef4d398b528d` 的 `dataFunRoleAtk=4` 语义。
- 本回放未重启 Cindy 或 Unity，未调用 Unity `open`、历史桥接入口或开发中编辑器，未进入
  游戏/Play Mode，未启动服务器；没有修改 `saga2_design`。该回放证明技能 ID 硬入口、业务
  语言输入、客户端/服务器证据核对、老版编辑器导入、导出 round-trip 和时序纠错链已经在
  真实 Cindy 对话中闭合。

## 2026-09-02 技能 ID 硬入口

- 生成新技能、基于现有技能修改，或检查/核对技能，必须由用户在当前任务中提供明确技能 ID。
- SAGA2 当前老版模块配置入口只接受正整数技能 ID；带前缀或别名且没有明确数字映射时，Agent
  必须在调用 Unity、MCPRouter 或 P4 前直接向用户索要正整数，不能先启动环境探索后再失败。
- Agent 不得从 Unity 当前选中项、历史任务、搜索结果、相似配置或默认值推断 ID，也不得用
  节点 ID 代替技能 ID。
- 缺少 ID 时，Agent 只能用业务语言询问目标技能 ID（可同时询问生成/修改/检查意图），
  当前轮不得读取模块、客户端或服务器，不得调用 Unity CLI、MCPRouter、P4，不得生成或导入
  导出 JSON。补充 ID 后才开始最小证据流程；多个 ID 必须先确认处理范围。
- 该规则同时写入战斗角色的 `combat-skill-id-contract` prompt fragment 和
  `combat-skill-configuration` Skill，并由 `runtimeConfig.integration.test.ts` 锁定注入结果。
- Host 在任务创建和续聊入口只提取用户明确标为“技能 ID / 技能编号 / 技能 1019”的正整数；
  伤害、持续时间、次数等未标注数字不参与推断，`skill_001` 仍视为缺少可用 ID。确认值写入
  当前任务运行时状态，多个不同 ID 会清空目标并要求用户先收窄范围。
- 工具门禁会对显式技能引用做同一目标校验。读取 `skill_entry_model_<id>_static.json`、老版
  `legacy_module_import_json` / `legacy_module_export_json`、JSON 产物路径和服务器 Worker 任务
  若引用其它 ID 会在执行前被拒绝；老版模块调用还必须显式携带当前 `skill_id`，不得依赖
  Unity 当前选中项。方案中的 `targetSkillId` 也必须与任务绑定值完全一致。
- 真实任务 `技能1019伤害目标与时序检查` 暴露了该门禁的必要性：Agent 已正确导出 1019，
  但派发服务器核查前误读 `skill_entry_model_1010_static.json`，并在约 3 分钟后仍未自动收敛。
  该回放判定为不达标；新增 Host 校验正是阻止这类跨技能证据污染，不能把该轮回答作为 1019
  的合格检查结论。

## 2026-09-02 服务器 Worker 证据预算

- 真实对话回放发现服务器只读 Worker 在 167 秒内产生 23 次模型请求，主任务迟迟没有终态；
  原因是只读门禁没有把提示词中的“最多两轮核查”落实为可执行限制。
- Cindy Host 的战斗策略状态现在为每个服务器 Worker 维护独立的只读证据计数，最多允许 6 次
  文件读取或经该策略执行点的只读 Shell 调用；达到上限后工具返回收束信号，只允许输出
  `serverCapabilityReport`。普通 Shell 已接入同一策略并计入预算；真实回放仍需验证预算覆盖的
  直接消费者是否充分，证据不足必须标记 `uncertain`，不得重复调用或新建 Worker 延长探索。
- 该限制只作用于 `saga2-combat-server-worker-v1`，不改变通用工具接口暴露，也不影响本地
  Lead 的 Unity CLI、P4 或 MCPRouter 环境检查；Worker 仍永久禁止写入和运行时操作。

## 2026-09-02 服务器报告直发回执修复

- 真实 Cindy 回放发现：服务器 Worker 通过 `orca_worker_bridge.send_to_lead` 直接发送结构化
  `serverCapabilityReport` 时，消息能够到达 Lead，但 Host 只在自动桥接路径登记可信回执，
  导致 Lead 随后调用 `validate_server_capability_report` 被错误拒绝。
- Host 现将 Worker session ID 随直发消息传递；仅当来源为指定 `send_to_lead` 且正文包含
  `serverCapabilityReport` 或 `supportStatus` 时登记可信回执。普通进度、问题或非结构化消息
  不会改变服务器能力门禁。
- 定向验证：Desktop typecheck、`combatServerCapabilityState` 5 项、
  `combatWorkflowPolicy` 31 项、`orcaTeamService` 70 项及 Orca bridge 23 项全部通过。
- 修复后的真实 Cindy 任务 `蓄力冲锋技能静态配置评估` 使用战斗开发角色和技能 ID `1010`：
  无 ID 首轮只询问 ID；补充 ID 后完成 P4/Unity CLI/服务器只读核查并输出结构化
  `SAGA2_COMBAT_CONFIG_RESULT`。由于服务器没有首个碰撞目标上下文，结果为 `blocked`，
  `imported=false`、`runtimeTested=false`，未生成或覆盖配置。

## 2026-09-02 服务器能力报告解释性字段兼容

- 真实生成回放中，服务器 Worker 在 `supportStatus=supported` 时返回了带证据说明的
  `capabilityGap` 与 `programmerAction`（例如“无运行时原子能力缺口”“无需服务器程序改动”），
  但 Host 校验器只接受严格的 `none`，导致已取得权威证据的配置流程在导入前错误中止。
- `validate_server_capability_report` 现允许 `supported` 报告使用具体的解释性文本；仍拒绝
  `unknown`、`待确认` 等占位值。`unsupported` 与 `uncertain` 继续要求明确缺口和程序动作，
  不会因为该兼容调整而放行不支持的能力。
- 回归测试使用解释性文本覆盖 `supported` 报告，并保留不支持报告的阻断断言。该修复只影响
  Cindy Host 的报告校验，不改变服务器权限、服务器代码或技能配置数据。

## 2026-09-02 百分比伤害编码真实回放

- 真实 Cindy 生成任务使用纯业务输入和技能 ID `1019`，要求“立即造成 100% 攻击力伤害，
  1 秒后对同一敌人追加 3 次 20% 攻击力伤害”。Agent 能自行导出空技能、建立模块图并派发
  服务器只读核查，但曾把同类配置中的 `data=[1,100]` / `[1,20]` 误解释为攻击力百分比。
- 服务器 Worker 以当前远端 SHA `3cf1064f1ddfe1d9960d913b3fbeef4d398b528d` 核实：
  `dataFunDefault=1` 返回常量，攻击力百分比函数为 `dataFunRoleAtk=4`，按
  `atk * val * 0.01` 计算。Worker 因此正确返回 `unsupported` 并阻止错误配置写入；本次
  未导入、未进入游戏、未启动服务器、未重启 Unity。
- 战斗 Skill、证据预算和 Worker 路由现显式要求区分常量伤害与攻击力百分比，禁止仅凭 JSON
  外观把 `[1,p]` 当作 p% 攻击力；攻击力函数参数形状不完整时必须 `uncertain` 并停止写入。
- 该回放同时暴露两项未收敛问题：本地相似配置搜索超过 7 分钟；Worker 完成后存在可信回传
  通道未登记的偶发现象。二者都必须在后续真实回放中解决，当前不能把战斗生成链路标记为达标。

## 2026-09-02 战斗 Skill 路由收敛

- `combat-skill-configuration` 已移除直接调用 `p4 login/fstat/edit` 的指引，配置文件状态和
  checkout/edit 统一由 Cindy Meka P4 插件完成；P4 CLI、P4V 和命令行兜底不属于战斗 Agent
  配置流程。
- 战斗角色默认项目元数据只注入 `editor-skill-editor-module/SKILL.md`。Timeline、Effect 和
  脚本类项目 Skill 仅在当前业务原子确实需要时按需读取，避免每轮把无关长文档灌入上下文；
  老版模块编辑器仍是唯一导入/导出入口，未将 V2 纳入 Agent 流程。
- Skill Creator 校验脚本未能在本机执行（Python 环境缺少 `yaml` 模块）；文件结构、JSON
  解析、Desktop typecheck 和相关定向测试已完成验证，后续应在带 PyYAML 的工作区补跑脚本。

## 2026-09-02 Unity 工程 Skill 加载收敛

- 真实回放发现 Unity 工程 `AGENTS.md` 的“`.agents/skills` 按需自动加载”仍会让战斗模块检查
  读取完整 `saga2-project-battle-designer`，并暴露历史 Unity 编辑器桥接目录，造成上下文膨胀
  和旧连接路径误选。
- 已将 Unity 工程入口收紧为：战斗模块配置默认只加载
  `editor-skill-editor-module/SKILL.md`；Timeline、特效或脚本 Skill 仅在当前业务明确需要时
  单个加载；历史 Unity 编辑器桥接 Skill 永久禁止读取或调用；Unity 连接继续只使用 Meka Unity 官方 CLI。
- 该调整只修改 `saga2_unity/AGENTS.md` 的加载路由，不删除历史 Skill 文件，也未修改
  `saga2_design` 或任何服务器内容。

## 2026-09-02 运行时提示词旧连接术语清理

- 战斗证据预算 prompt 不再显示历史 Unity 编辑器桥接 Skill 的具体名称，只保留“历史 Unity
  编辑器桥接 Skill”这一泛化禁止语义；运行时连接路径统一只描述 Meka Unity 官方 CLI。
- 该清理只影响 Cindy 注入给战斗 Agent 的可见提示文本，不删除 Unity 工程中的历史文件，
  不修改 `saga2_design`、服务器或技能配置数据。

## 2026-09-02 Lead 证据预算硬门禁

- 真实“检查技能 1019”回放曾产生重复读取和无效枚举。战斗策略现为每个本地 Lead 任务维护
  独立的只读证据计数，探索阶段最多允许 8 次经策略执行点的文件、Shell 或只读 MCP 证据调用；
  普通 Shell 已通过完整任务上下文接入同一 Host 策略，预算覆盖其真实调用。
  达到上限后返回收束信号，要求基于已有证据交付业务结论，证据不足标记为无法保证或
  uncertain。
- 环境诊断、服务器 Worker 自身预算、已授权实施和老版编辑器导入/导出回读不消耗该预算；
  任务会话清理时同步清除计数。该门禁只限制本地 Lead 的重复探索，不改变通用工具接口、
  服务器只读边界或 `saga2_design` 只读约束。
- 回归验证覆盖第 8 次放行、第 9 次拒绝以及执行阶段回读放行；Desktop typecheck 与战斗
  相关测试均通过。

## 2026-09-02 Meka Unity 未知工具纠偏

- 重载后的真实 Cindy 回放确认技能 ID 硬入口已生效，但模型仍曾对 `meka-unity` 错误调用
  `list_tools`；该插件实际只声明 `unity_inspect` 与 `unity_execute`，错误回执原先会沿用
  通用二级分派提示，容易诱导再次重试并造成任务不收敛。
- `pipeDispatcher.toolNotFoundMessage` 现对 `meka-unity` 返回专用纠偏：列出实际声明的官方
  CLI 工具，明确没有动态 `list_tools` 接口并禁止重试未知工具；其它插件的 `call_tool` 自愈
  文案保持不变。
- 新增 `pipeDispatcher` 单测覆盖该边界。该修复不改变通用工具暴露，只减少战斗角色误选工具
  时的无效循环；仍需在修复后的常驻 Cindy 进程中完成一次带技能 ID 的完整静态检查回放。

## 2026-09-02 公共 Ghost 战斗门禁补齐

- 真实 Cindy 战斗回放的无 ID 阶段符合预期：Agent 只询问正整数技能 ID，没有调用工具。补充
  `1019` 后，Agent 却通过公共 `cindy.ghost_call` 调用了技能 `1010` 的老版模块导出，并发出
  缺少 JSON 路径的 `legacy_module_export_json 1019`。这说明直连 Meka MCP 已有的技能绑定和
  路径门禁没有覆盖实际使用的公共插件分发路径。
- 同轮还把临时回读文件写入 `saga2_unity/Assets/Editor/SkillEditor/Skill/Exportd Data/Server`，
  并把其它业务需求的 7 节点配置当作 `1019` 结论；因此即使最终回复能列出风险，也不能视为
  当前纯业务需求的合格配置产物。
- Cindy 现于公共 `ghost_call` 的插件 setup、附件授权和真实派发之前恢复任务语境并执行
  `combatWorkflowPolicy`。跨技能 ID、老版命令缺少显式 ID/绝对 JSON 路径，以及写入
  `saga2_json`、`saga2_design` 或其它目录的调用均返回
  `COMBAT_WORKFLOW_POLICY_DENIED`；系统临时目录与 `saga2_unity` 内当前技能路径继续放行。
- 回归覆盖公共 Ghost 的真实参数形态，并确认普通角色与非战斗插件不受影响；定向测试
  `103/103` 通过。生产实例重载后仍以全新任务回放确认真实 Agent 不再借用其它技能、不再产生
  越界临时文件，并完成当前技能的持久化回读闭环。

## 2026-09-02 续聊技能 ID 在线绑定修复

- 修复公共 Ghost 门禁后，真实任务 `即时伤害并延迟追加三击` 的首轮表现符合预期：纯业务需求
  没有 ID 时只询问正整数技能 ID，约 3 秒结束且没有工具调用。
- 用户在同一任务第二轮明确回复 `技能 ID 是 1019` 后，Agent 正确规划了 1019 的老版模块流程，
  但 Host 仍沿用任务创建时的“缺少 ID”状态，错误拒绝 `unity_inspect(status)` 和显式携带
  `1019`、绝对临时 JSON 路径的 `legacy_module_export_json`。Agent 没有绕过 CLI 或修改资产，
  但要求用户再次重复 ID，判定为不达标。
- 根因是技能 ID 只在任务创建/恢复的 `applyMekaRuntimeConfig` 中解析，在线任务的后续用户消息
  没有刷新 Codex MCP thread context 的 `vendorOptions`。Cindy 现在在每条真实用户消息规范化后、
  模型派发前重新解析明确标注的 ID；仅当数据库确认角色为 `saga2/combat-development` 时调用
  `setVendorOptions` 刷新在线上下文。普通数字不触发更新，缺少 ID 保留已有绑定，多个 ID 进入
  歧义态。
- 回归测试覆盖“首轮只有伤害/时长/次数数字，次轮补充技能 ID 1019”的补丁生成和在线派发接线；
  战斗运行时、策略与公共 Ghost 三组定向测试合计 `126/126` 通过。仍需在重载后的 Cindy 中继续
  同一纯业务用例，完成服务器语义、P4、老版导入和持久化回读验收。

## 2026-09-02 目标首证据真实回放与门禁补充

- 真实任务 `83e6a6a6-fdd5-4be0-aa42-105132d5ad9e` 再次确认技能 ID 硬入口：无 ID 时唯一回复
  为“请提供要生成、修改或检查的正整数技能 ID。”，且零工具调用；补充 `1020` 后 Host 正确
  绑定目标，老版导出返回 `exportedNodeCount=0` 和“技能模块资产不存在：1020”。
- 同轮 Agent 在目标导出前重复发现工作区、环境和插件，之后枚举 `AGENTS.md`/资产并读取
  `ModuleV2`、共享服务器 JSON、任意参考技能。该结果判定为流程不达标，不能用最终业务追问
  掩盖证据链偏航；本轮没有导入或修改 1020。
- Cindy 战斗 Host 现对 MCP 与公共 Ghost 调用按顺序失败关闭：保留所有通用接口的暴露，但拒绝
  无价值发现、ready 环境复检及目标导出前的其它 MCP 项目证据。Shell 侧的 `AGENTS.md` 枚举、
  开发中编辑器目录和共享 JSON 仍依靠 prompt/权限契约，尚无生产 Host 硬拦截。Skill 快照只允许
  总控 Skill；参考技能和第二个 ID 不再允许。定向策略回归 39/39 通过。
- 本节只记录 Cindy/插件改进和待验证项；`saga2_design` 的活动文件统计仍为 6 个、设计提案
  仍为 6 个，本轮没有修改其中任何文件。

## 2026-09-03 当前 HEAD 消费者取证模板

- 真实技能 1021 回放已经证明技能 ID 追问、目标绑定、常驻 Unity 复用、老版导出、只读服务器
  Worker、auto-bridge 和 Host 报告校验链可用；本轮 `uncertain` 来自搜索模板未覆盖伤害、目标和
  时序消费者，没有产生策划文件或技能资产修改。
- Cindy 侧已把远端证据改为显式 `HEAD` 的精确符号路径检索和小范围上下文检索。非技术策划仍
  只提供业务需求与正整数技能 ID，不需要提供模块类型、代码符号、JSON 或服务器路径。
- 该项不新增 `saga2_design` 修改建议；设计侧活动文件统计仍为 6 个、提案仍为 6 个。下一轮只
  根据真实服务器证据决定技能 1021 是否可静态配置，不把工具取证不足误报为设计缺口。
- 后续真实回放已取得 `supported` 服务器报告，但报告附带正确的 `targetSkillId` 时被 Cindy 的
  严格 schema 拒绝。该字段现纳入 Cindy 报告协议并由 Host 与任务绑定值比对；这是工具契约修复，
  不新增 `saga2_design` 修改项。

## 2026-09-03 服务器派发自然语言证据兼容

- 真实任务 `5023e3d7-11e0-447e-bf68-0fdf7aedca39` 再次验证了技能 ID 硬入口：首轮只有
  业务需求时零工具调用并只追问正整数技能 ID；用户下一轮仅回复 `1021` 后，任务正确保留
  上一轮业务需求并将 1021 绑定为生成、修改、检查和服务器报告的唯一目标。
- 该轮已通过常驻 Unity 的老版编辑器导出确认目标技能模块资产不存在，但 Lead 使用
  “老版 Unity 导出”“目标技能模块资产不存在”“请在当前 HEAD 核实”等自然语言组织 Worker
  请求时，Host 的模块优先门禁未识别这些等价证据，错误拒绝只读服务器核对。
- Cindy 现兼容上述受限自然表达，并将“需核实”“尚需核实”“请核实/核对”等表述识别为剩余
  问题；这只扩展等价证据的解析，不降低模块首证据、原子能力矩阵、只读服务器、固定 HEAD、
  六次读取预算及 `targetSkillId` 一致性门禁。
- 定向回归覆盖真实请求正文及目标资产不存在的变体，战斗状态、工作流策略、运行时注入和
  Meka Runtime MCP 共 `106/106` 通过。该项不修改 `saga2_design`，设计侧活动文件统计和
  提案数量均保持不变。

## 2026-09-03 Unity CLI 故障降级回放

- 新建真实任务 `fd42adfd-95df-4351-aaf8-5efd2c4171ed`：首轮纯业务需求仍只得到技能 ID
  追问，零工具调用；补充 `1021` 后先调用 `unity_inspect(action=status)`，回执为
  `STATUS_NO_INSTANCES`，随后按规则尝试一次 `legacy_module_export_json`，返回
  `COMMAND_FAILED`，未调用 `pipeline install`、`open`、重启 Unity 或安装组件。
- Host 新增“目标导出已尝试”状态：结构化导出失败也能作为首证据终点，允许已知规则读取和
  MCPRouter 服务器只读核查，但不解锁 P4、导入或其它写入。该状态与成功导出状态分离，避免
  将失败误报为模块已保存。
- 服务器只读核查仍需在 Unity CLI 恢复可见后重新完成；本次没有修改 `saga2_design`、技能
  资产或服务器内容。设计侧活动文件统计与提案数量保持不变。

## 2026-09-04 续聊目标绑定事务边界

- 战斗 follow-up 的技能 ID、歧义状态和服务器目标补丁只在对应用户消息完成持久化后提交到
  在线任务；纯预处理不能刷新内存绑定，也不能让上一轮导出成功／尝试证据进入新一代目标。
- 若消息在 vendor 不可逆派发前被拒绝、取消或抛错，Host 必须清空本次绑定、导出完成态、
  导出尝试态和在线 `vendorOptions` 补丁，不恢复旧证据。多个技能 ID 形成歧义时同样立即使
  旧目标证据失效；用户随后重新选择旧 ID，也必须重新执行该 ID 的首证据导出。
- 若消息已经跨过不可逆派发边界，只清理本次事务 token，不回滚目标绑定。回滚只允许命中
  当前消息自己的 token，较早消息的迟到结果不能清除较新的已接受绑定。
- 回归覆盖持久化成功后的提交、落库失败不提交、派发拒绝回滚，以及显式失效后旧技能导出
  证据不可复用。本节不修改 `saga2_design`，设计侧活动文件和提案数量保持不变。
