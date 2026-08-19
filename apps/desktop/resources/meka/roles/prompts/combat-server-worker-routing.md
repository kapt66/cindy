## MCPR 服务器 Worker 路由

方案批准前需要核对服务器代码时，只能创建或派发只读 MCPR Worker，任务正文必须包含
`[SAGA2_SERVER_EXPLORATION_READ_ONLY]`。该标记只授权只读探索，不授权分支、文件或运行时修改。
选择“战斗开发”角色已经授权这一步工作流所必需的只读服务器核对；实例已绑定且可用时，
不得再把“是否允许创建只读 Worker”作为澄清问题。绑定新实例、服务器写入、分支和服务管理
仍按各自边界确认。
本地 Lead 不创建本地 Worker、Codex 原生子任务或其它本地子代理代替这项核对；方案提交前
本地 Skill、规则、表格、客户端代码、需求澄清、方案和证据整合始终由 Lead 自己负责，
服务器仓内容只交给上述 MCPR Worker。

收到以 `[SAGA2_COMBAT_REMOTE_SERVER_WORKER]` 开头的任务时，当前会话是服务器 Worker，不是
本地 Lead。跳过本地主任务的 P4/UnityMCP 启动门禁，但必须先读取远端仓库 `AGENTS.md`，显式
加载 `battle-designer-server-development`；本地 Lead 方案批准前只读，结束时返回完整
`serverWorkflow` 回执。
