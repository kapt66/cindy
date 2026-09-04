# 战斗环境降级与恢复约束

`[SAGA2_COMBAT_ENVIRONMENT_GATE]` 是当前任务的权威启动结果。
本文件覆盖角色基础 prompt 中“只有 `ready: true` 才能开始业务探索”的旧表述：`ready` 只表示
三条链路是否全部可用于完整实施，不是任务级开关。

## `ready: false`

不要把三项状态或 next action 作为首轮固定播报。用户请求依赖哪条链路，就先使用该链路可用的
自动恢复与工具能力推进；只有自动恢复后仍需用户处理时，才报告最小必要动作。

环境未完全就绪时仍可：

- 使用已注入的总控 Skill；目标技能导出后只读取已知的 `saga2_unity/AGENTS.md`、代码、表格和配置。
- 做 Host 可证明只读的本地探索、需求澄清和方案整理。
- 使用仍可用链路上的只读能力，但不得把失败链路的证据替换成本地猜测。

Meka Unity `unity_inspect(action=status)` 或其它 Unity 操作若发现没有实例、未就绪或 Pipeline 缺失，
插件返回结构化恢复信号；Host 通过 Cindy 通用确认框询问是否启动目标 Unity 工程，确认框不写入
Agent 对话正文。用户点击同意后，Host 在同一工具调用内只执行一次 `unity_execute(action=open)`；
Agent 不得调用 `ask_user_question` 或在聊天正文自行询问启动，遇到该恢复信号应直接调用
`unity_execute(action=open)`，由 Host 接管确认与一次重试；
用户取消、超时或启动失败时不得循环重试。状态通信失败且无法证明“无实例”时仍必须阻止 open。
未获确认时，对当前目标技能只尝试一次老版 `legacy_module_export_json` 取得结构化失败回执，随后
可跳过 Unity 依赖继续 MCPRouter 服务器只读核查；导出传输也失败时将 Unity 部分标记为 `uncertain`，
保留其它独立证据。插件与 Host 共同负责这套恢复语义，角色不应自行发明聊天询问流程。

环境总状态不是操作总开关。Host 只在某个具体工具实际依赖故障链路时阻止该次调用，并返回
依赖、原因和解决方案；例如 MCPR 故障不能阻止 P4 或老版模块编辑器操作，Meka Unity CLI 故障不能阻止
MCPR 服务器核查。普通方案审批和风险确认仍按原规则执行。不得传递 `sandbox_permissions`、
请求提权或要求用户重复授权；具体调用被阻止后，记录该部分暂不可用并继续其它独立工作。

战斗 Lead 需要服务器证据时，先完成当前目标技能老版导出、Host 注入的协议字段读取和原子能力矩阵，再按
`combat-server-worker-routing` 派发只读 MCPR 服务器 Worker；不要由 Lead 直接扫描远端仓库。
Worker 的读取链内部自动尝试已保存凭证重连、实例复用、模板创建和项目绑定，不得只复述
“未配置/不可用”，也不得用绑定状态或历史结论代替当前远端 HEAD 的真实读取。
本段明确覆盖角色基础 prompt 中旧的“先做独立准备探测”规则：该独立工具不再向 Agent 暴露，
绑定/准备状态不能证明仓库可读。
旧回执缺少结构化恢复信息时可调用一次 `diagnose_mcp_router_connection`。只有自动恢复明确返回
`fallbackUserAction` 时才提示用户完成其中的最小必要动作，不额外追加设置入口。凭证、候选歧义、
模板缺失、网络或远端 Runtime 无法由 Host 代办时才停在该依赖边界。

`mcp_router.check_combat_environment` 只在 Host 明确进入 `environment-recovery`、服务器派发状态为
`retry-required`，或真实连接/认证/传输失败后调用一次。阶段切换和实施前不得主动复检；启动门禁
已经提供当前状态。
普通文件不存在、查询无结果或证据不足不触发复检。版本或协议不匹配由部署方升级并重启远程
Runtime，客户端当前没有自动升级入口，但本地只读探索不因此停止。

Host 的阶段限制拒绝不是用户拒绝。不得换参数重试，不得换 SSH、本地服务器路径或其他工具绕过。

## `ready: true`

直接继续角色的“只读探索”阶段。任何阶段发现
P4、Meka Unity CLI 或 MCPR 的连接、认证、传输失败，或 Host 门禁明确返回环境不再 ready，立即回到
本流程。普通业务查询的“无匹配”、文件不存在、路径/引号错误、命令非零退出、Unity 临时锁文件
读取失败或某项证据不足，都只是当前查询失败，不代表三条环境链路断开；修正或收窄一次查询，
仍无法取得证据就标记为不确定，禁止因此重复调用 `check_combat_environment`。
