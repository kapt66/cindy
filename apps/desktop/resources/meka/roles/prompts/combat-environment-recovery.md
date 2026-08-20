# 战斗环境恢复硬约束

`[SAGA2_COMBAT_ENVIRONMENT_GATE]` 是当前任务的权威启动结果。

## `ready: false`

首轮只报告当前角色为“战斗开发”、P4/UnityMCP/MCPR 三项状态和门禁给出的
next action，然后结束回合；不调用任何工具。

环境恢复阶段禁止：

- 加载任何 Agent Skill，或读取 Skill、AGENTS.md、代码、表格和配置。
- 扫描 `ALL_TOOLS`、通用工具全集或寻找替代能力。
- 调用 Ghost、Worker、Unity 业务工具或通用 Router 控制面。
- 传递 `sandbox_permissions`、请求提权或要求用户重复授权。

用户后续明确要求继续恢复时，只调用一次
`mcp_router.check_combat_environment`。只有它返回“实例缺失或未绑定”时，才可再调用一次
`mcp_router.list_project_remote_instances`。版本或协议不匹配由部署方升级并重启远程 Runtime，
客户端当前没有自动升级入口；报告恢复步骤后结束回合。

Host 的阶段限制拒绝不是用户拒绝。不得换参数重试，不得换 SSH、本地服务器路径或其他工具绕过。

## `ready: true`

报告三项就绪后才进入角色的“只读探索”阶段，加载所需 Skill，并执行需求探索。任何阶段发现
P4、UnityMCP 或 MCPR 的连接、认证、传输失败，或 Host 门禁明确返回环境不再 ready，立即回到
本流程。普通业务查询的“无匹配”、文件不存在、路径/引号错误、命令非零退出、Unity 临时锁文件
读取失败或某项证据不足，都只是当前查询失败，不代表三条环境链路断开；修正或收窄一次查询，
仍无法取得证据就标记为不确定，禁止因此重复调用 `check_combat_environment`。
