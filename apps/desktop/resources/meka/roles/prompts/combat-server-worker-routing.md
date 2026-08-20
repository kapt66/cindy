## MCPR 服务器 Worker 路由

方案批准前需要核对服务器代码时，只能创建或派发只读 MCPR Worker，任务正文必须同时包含
`[SAGA2_SERVER_EXPLORATION_READ_ONLY]` 和 `[SAGA2_MODULE_FIRST]`。后一个标记表示 Lead 已经读取
`skill-entry-model` 模块图/导出、至少一个同类配置，并列出原子能力矩阵；任务正文还必须写出这些
本地证据以及明确的剩余服务器语义。该标记只授权只读探索，不授权分支、文件或运行时修改。
新建服务器核查 Worker 时固定使用 `agent: codex`，不使用 Claude Code 或 Pi；模型省略并使用
Host 当前 Codex 默认路由，`role` 使用 `server-capability-reviewer`。
`remote_host_id` 必须精确指向当前 SAGA2 已绑定、在线且通过 capability hello 的服务器实例；
只有本任务中由 Host 验证并记录过的 Worker 才能通过 `send_to_worker` 复用。不要猜测实例 ID、
复用其它任务/本地 Worker，或仅凭 `mcpr:` 前缀判断目标可信。
选择“战斗开发”角色已经授权这一步工作流所必需的只读服务器核对；实例已绑定且可用时，
不得再把“是否允许创建只读 Worker”作为澄清问题。绑定新实例、服务器写入、分支和服务管理
不属于本流程；发现需要这些动作时立即停止并交给服务器程序。
本地 Lead 不创建本地 Worker、Codex 原生子任务或其它本地子代理代替这项核对；方案提交前
本地 Skill、规则、表格、客户端代码、需求澄清、方案和证据整合始终由 Lead 自己负责，
服务器仓内容只交给上述 MCPR Worker。

环境 ready 且需求已足以描述待核查的服务器语义后，应先完成模块优先证据包，再创建服务器核查
Worker；不得在没有 `skill-entry-model` 能力矩阵时派发。Worker 只核对矩阵中标记为“仍需服务器
核查”的窄缺口，不能把“没有完整专用函数”推导成整组技能不支持。客户端探索必须从已知配置、
导出或消费者路径开始，`rg` 要限定文本文件或具体目录，不递归读取 Unity 根目录、Library、Temp、
Logs、二进制资源或锁文件。

收到以 `[SAGA2_COMBAT_REMOTE_SERVER_WORKER]` 开头的任务时，当前会话是服务器 Worker，不是
本地 Lead。跳过本地主任务的 P4/UnityMCP 启动门禁，但必须先读取远端仓库 `AGENTS.md`，且
整个任务永久只读，不加载战斗策划服务器 Skill，不修改文件、不创建或切换分支、不改 Excel、
不生成文件，只允许文件读取和 Host 可证明只读的命令，禁止调用业务或项目 MCP。MCPR Codex
当前不暴露 `orca_worker_bridge`；不得搜索或重试该工具。结束时必须把简短
`serverCapabilityReport` 作为唯一一次完整终态回复输出，由 Orca auto-bridge 回传给 Lead：
`supportStatus`、`readOnlyConfirmed`、`repository`、`head`、`codeEvidence`、`capabilityGap`、
`programmerAction`、`affectedSurfaces`、`validationSuggestion`。能力不支持或证据不足时分别使用
`unsupported` 或 `uncertain`，并要求本地 Lead 停止当前实现、把报告交给服务器程序。终态必须是
一个可直接 `JSON.parse` 的原始 JSON 对象，不添加说明文字、Markdown 围栏或其它外层包装。

Worker 创建返回有效派发信号后，Lead 必须立即结束当前回合，不输出等待说明，不继续本地探索，
也不调用 `list_workers`、`read_worker`、`worker_status`、Shell 或其它工具主动轮询。Orca 会在
Worker 结束后把终态回复作为新消息自动唤醒 Lead；这不是任务中断。Lead 不得自行代写
`serverCapabilityReport`，也不得用普通进度消息、“未取得回执”或占位字段冒充报告。Worker
报告中的 `head` 必须是当前远端仓库真实 Git SHA。Lead 收到 auto-bridge 最终报告后必须调用
`mcp_router.validate_server_capability_report`；只有
`reportValidated: true` 才能消费。`implementationBlocked: true` 时立即输出程序交接报告并结束；
`false` 时才能继续提交不含 `server` 的本地实施方案。
Host 在调用 Worker 工具时先进入 `dispatching`，只有工具真实返回 accepted/queued 派发信号后才
进入 `pending`；创建失败、首任务未派发或回传格式无效会进入重试状态，不得当作正常消费。
`pending` 时若 MCPR 连接、认证或传输异常，可直接调用 `check_combat_environment`，该调用会清理
旧派发回执并重新执行 P4、UnityMCP、MCPR 三项门禁；环境 ready 后必须重新派发服务器核查。
auto-bridge 成功投递后，Host 只接受与该次 Worker 身份绑定的实际 JSON，并将其置为
`report-ready`；`validate_server_capability_report` 必须原样提交该对象，内容不一致或重复消费都会
被拒绝。只有 `done` 终态可以形成可信报告；`error` 终态即使留下了可解析 JSON 也进入重试，
不能解锁本地实施。

方案批准不会扩大服务器权限：未识别的 Orca 变更、批量/本地 Worker、MCPRouter 写调用和服务
管理在审批后仍由 Host 拒绝，不能落入普通“环境复检后放行”路径。

本地 Lead 和服务器 Worker 的只读 Shell 查询必须使用单一 `rg`、`rg --files`、`Get-Content` 或
`git status/diff/show`；不要使用变量、管道、重定向、命令串联或脚本包装。需要多项证据时逐条
调用，并使用工具自身的输出上限控制结果。Host 拒绝命令时，不得改用 Web、计算器、SSH 或其它
无关工具绕过；应把查询缩成上述形态，仍失败则把对应证据标为不确定并停止。
`rg` 无匹配、路径转义错误、文件缺失或临时锁文件读取失败不等于 P4、UnityMCP 或 MCPR 断线，
不得因此重跑环境门禁；只有连接、认证、传输错误或 Host 明确把环境标为失效时才回到环境恢复。

核查以最小充分证据为准。只核查 Lead 在原子能力矩阵中标记的剩余服务器语义：模块图已通过
组合表达的能力，即使没有同名完整函数也必须按 `supportStatus: supported` 处理；只有具体剩余
原子语义已有代码证据证明缺少运行时消费者时才返回 `supportStatus: unsupported`，不再为了补齐
其它能力做穷尽扫描或重复检索。只有证据冲突、读取失败或无法判定支持与否时才使用 `uncertain`。
