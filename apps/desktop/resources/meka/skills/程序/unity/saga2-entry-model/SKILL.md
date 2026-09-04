---
name: saga2-entry-model
description: 读取和配置 SAGA2 EntryModel 技能模块节点；用于把战斗需求映射到服务器权威模块语义并生成可导入老版模块编辑器的 JSON。
metadata:
  display-name: EntryModel 模块语义
  purpose: 用客户端消费者、模块导出和服务器代码共同校验字段，而不是凭字段名猜测
---

# SAGA2 EntryModel 模块语义

## 证据预算（强制）

只读取当前技能导出、一个同类配置和解决当前缺口所需的客户端/服务器代码。禁止递归扫描整个设计库、重复读取同一资料或把完整 Skill 文档批量灌入上下文；每个未决业务原子最多两轮定向核查。证据不足时立即停止并输出可实现项、无法保证项和待确认业务选择，不得编造字段或继续无界搜索。

本 Skill 是 Cindy 随角色快照提供的模块语义参考。它不是独立的本地服务器副本，也不授予
写入权限。任何技能配置都必须在真实项目中取证后再生成 JSON。

策划不需要阅读或填写本 Skill 的协议字段。策划只提供业务目标和玩家可感知的规则；Agent
负责把目标翻译为模块图，自动补齐 `kind`、`typ`、`target`、`time` 和 Transition 的
证据。除非缺少会改变玩法的业务选择，不得把字段、节点或编辑器操作反问给策划。遇到
能力缺口时，先用业务语言说明哪些效果不能保证，再提出可选设计或程序交接，不得臆造字段。

## 证据顺序

1. 先读取当前技能的老版模块编辑器导出 JSON 和节点 Transition；如需确认同类组合，可额外只读
   导出一个文件名带 `reference` 与参考技能 ID 的技能，但它不能替代当前目标证据。使用 Meka Unity 官方 Unity
   CLI 的 `unity_inspect(action=status)` 与 `legacy_module_export_json` 回读。Unity Editor
   已常驻时复用现有实例，常规配置不要调用 `open`，也不要调用会返回完整资产清单的 `list`。
   技能资产不存在时导出必须失败，不能把自动创建的空资产当作当前配置。
2. 再读取客户端消费者和编辑器字段定义，确认节点如何组合、目标如何继承、time/data 的索引
   如何消费。
3. 服务器语义只能通过当前 SAGA2 绑定的 MCPRouter 远程项目只读工具取得。不要用本地服务器
   仓库、SSH 主机、旧分支或记忆替代权威证据。

## 节点判读

- `kind` 表示激活机制，`typ` 表示行为或监听事件；两者必须分别解释。
- `kind=1` 通常是行为/属性模块，`kind=2/3/4` 是事件或伤害时机监听，`kind=5` 是条件
  判断并通过 `trigger` / `not_pass_trigger` 分支。
- `time` 必须逐项说明 `[duration, count, interval, delay]`；不能把缺省数组当成永久监听。
- `target`、`dataCondition`、`data` 的含义随 `typ` 变化。陌生 `typ` 必须先查服务器
  `runAction` / `isPassEvent` 及对应客户端消费者，再写入。
- `trigger`、`next`、`elseTrig`、`bind` 和清理字段必须画成有终点的图；禁止事件自触发、
  无界循环、悬空节点和未声明的目标继承。

## 生成与验证

需要实施时，先在内部形成原子能力矩阵和 `[SAGA2_COMBAT_CONFIG_PLAN]`，再按目标技能 ID
最小范围生成 JSON。导入只使用老版模块编辑器的 JSON 入口；不得手改 `.asset`，不得把
其它模块编辑器入口纳入 Agent 配置流程。

导入源和回读文件只放在操作系统临时目录或 `saga2_unity`。已有模块资产必须先通过 Meka P4
插件实际执行 `p4_edit`；新资产先调用 `legacy_module_prepare_asset`，再对返回的 `.asset` 与
`.meta` 执行 `p4_add`。仅查询状态不算完成版本控制前置。

导入成功必须以 `persistenceVerified=true` 和一致的 `persistedNodeCount` 为准；随后通过同一
官方 CLI 导出并结构化比较：节点数、ID、kind、typ、time、target、
dataCondition、data、概率、Transition、层数、刷新、清理和绑定字段逐项回读。服务器证据
不足时标记 `uncertain` 并停止实施，不得声称端到端完成。

最终报告必须区分：已由模块组合表达的能力、需要客户端/服务器代码的能力、尚未验证的能力，
并给出真实证据路径和运行时验证范围。
