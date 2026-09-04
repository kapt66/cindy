## MCPR 服务器 Worker 路由

每个生成、修改或检查技能的任务，在方案或成功结论前都必须创建或派发一次只读 MCPR Worker；
即使当前资产已经符合需求也不能跳过。任务正文必须同时包含
`[SAGA2_SERVER_EXPLORATION_READ_ONLY]` 和 `[SAGA2_MODULE_FIRST]`。后一个标记表示 Lead 已经通过
老版编辑器取得目标技能导出回执（现有模块图或明确不存在），读取协议字段并列出原子能力矩阵；任务正文还必须写出这些
本地证据以及明确的剩余服务器语义。该标记只授权只读探索，不授权分支、文件或运行时修改。
一个任务只允许用户绑定的目标技能 ID，不得导出、读取或向 Worker 传递其它参考技能 ID。
新建服务器核查 Worker 时，`agent` 必须原样使用 Host 注入的 `serverWorkerAgent`（只可能是
`claude-code` 或 `codex`），不得自行选择或改写，Pi 不用于该核查；模型省略并使用 Host 对应
Agent 的默认路由，`role` 使用 `server-capability-reviewer`。
调用 `start_team` 时必须显式使用 `worker_permission_mode: auto`；战斗工作流的 Host 也会把任何
Full access 请求收敛为 `auto`，避免只读服务器核查触发权限升级确认。
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
Worker；不得在没有目标技能导出回执、协议字段和原子能力矩阵时派发。目标资产不存在的结构化
回执本身就是新建场景的目标证据，不得为补“模块图”读取其它技能。Worker 核对矩阵中所有依赖运行时解释的
原子语义；已由模块组合表达的部分不重新发明实现，但仍需确认当前远端消费者、目标/时序/数据函数
编码兼容。不能把“没有完整专用函数”推导成整组技能不支持。客户端探索必须从已知配置、
导出或消费者路径开始，`rg` 要限定文本文件或具体目录，不递归读取 Unity 根目录、Library、Temp、
Logs、二进制资源或锁文件。

收到以 `[SAGA2_COMBAT_REMOTE_SERVER_WORKER]` 开头的任务时，当前会话是服务器 Worker，不是
本地 Lead。跳过本地主任务的 P4/Meka Unity CLI 启动门禁，但必须先读取远端仓库 `AGENTS.md`，且
整个任务永久只读，不加载战斗策划服务器 Skill，不修改文件、不创建或切换分支、不改 Excel、
不生成文件，只允许 `git show`、`git grep`、`git status`、`git diff` 四类单条只读命令，禁止
`Read` 文件工具、读取 Claude 自动保存的超长工具输出，以及业务、项目或桥接 MCP。MCPR Worker
不依赖 `orca_worker_bridge`；不得搜索、调用或重试该工具。结束时必须把简短
`serverCapabilityReport` 作为唯一一次完整终态回复输出，由 Orca auto-bridge 回传给 Lead：
与 Lead 绑定值一致的正整数 `targetSkillId`、`supportStatus`、`readOnlyConfirmed`、`repository`、
`head`、`codeEvidence`、`capabilityGap`、
`programmerAction`、`affectedSurfaces`、`validationSuggestion`。能力不支持或证据不足时分别使用
`unsupported` 或 `uncertain`，并要求本地 Lead 停止当前实现、把报告交给服务器程序。终态必须是
一个可直接 `JSON.parse` 的原始 JSON 对象，不添加说明文字、Markdown 围栏或其它外层包装。
字段类型必须严格固定：`codeEvidence` 和 `affectedSurfaces` 是数组，`capabilityGap`、
`programmerAction`、`validationSuggestion` 是非空字符串；即使没有缺口，`capabilityGap` 也必须
写成字符串（例如“无服务器能力缺口；仍需按建议完成验证”），绝不能写 `[]`、`null` 或省略。

`supportStatus` 只回答当前服务器 HEAD 是否具备表达业务原子能力的运行时消费者，不评价策划是否
已经给齐平衡数值。诸如“较低伤害”“短暂控制”尚未给具体比例或时长时，只要服务器数据函数、
参数顺序和消费者已经有直接证据，就应返回 `supported`；在 `capabilityGap` 中说明“无服务器能力
缺口，仍有业务参数待策划确认”，`programmerAction` 写明无需服务器改动。Lead 随后用业务语言
集中询问该数值，不能把业务参数缺失升级为程序阻塞。只有数据函数形状或消费者本身无法证明时才
使用 `uncertain`。

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
旧派发回执并重新执行 P4、Meka Unity CLI、MCPR 三项门禁；环境 ready 后必须重新派发服务器核查。
auto-bridge 成功投递后，Host 只接受与该次 Worker 身份绑定的实际 JSON，并将其置为
`report-ready`；`validate_server_capability_report` 必须原样提交该对象，内容不一致或重复消费都会
被拒绝。只有 `done` 终态可以形成可信报告；`error` 终态即使留下了可解析 JSON 也进入重试，
不能解锁本地实施。

方案批准不会扩大服务器权限：未识别的 Orca 变更、批量/本地 Worker、MCPRouter 写调用和服务
管理在审批后仍由 Host 拒绝，不能落入普通“环境复检后放行”路径。

本地 Lead 的只读 Shell 查询使用单一 `rg`、`rg --files` 或 `Get-Content`；服务器 Worker 只能使用
`git show`、`git grep`、`git status` 或 `git diff`，不得调用 `Read` 或 `rg`。不要使用变量、管道、
重定向、命令串联或脚本包装。需要多项证据时逐条
调用，并使用工具自身的输出上限控制结果。Host 拒绝命令时，不得改用 Web、计算器、SSH 或其它
无关工具绕过；应把查询缩成上述形态，仍失败则把对应证据标为不确定并停止。
搜索无匹配、路径转义错误、文件缺失或临时锁文件读取失败不等于 P4、Meka Unity CLI 或 MCPR 断线，
不得因此重跑环境门禁；只有连接、认证、传输错误或 Host 明确把环境标为失效时才回到环境恢复。

核查以最小充分证据为准。只核查当前原子能力矩阵涉及的服务器语义：模块图已通过组合表达的
能力不要求存在同名完整函数，但必须确认当前远端消费者确实接受相关目标、时序和数据编码；全部
成立才返回 `supportStatus: supported`。只有具体原子语义已有代码证据证明缺少运行时消费者时才
返回 `supportStatus: unsupported`，不再为了补齐
其它能力做穷尽扫描或重复检索。只有证据冲突、读取失败或无法判定支持与否时才使用 `uncertain`。

涉及伤害数值时，必须把默认常量数据函数与攻击力百分比数据函数分开核对：`data=[1,p]`
不能凭外观解释为 p% 攻击力；只有远端代码和现有协议共同证明 `dataFunRoleAtk=4` 的参数
形状后，才能把百分比需求判为 supported。若 Lead 的计划把 `[1,p]` 当百分比，Worker
应直接返回 `unsupported` 并指出编码错误，禁止替 Lead 静默改写配置。

Host 对每个服务器 Worker 强制执行最多 6 次只读证据调用。达到上限后必须立即停止搜索，
基于已有证据输出唯一的 `serverCapabilityReport` JSON；证据不足时使用 `uncertain`，不得
通过重复请求、换命令或新建 Worker 延长探索。

Worker 的默认取证顺序必须把预算留给直接消费者：第 1 次用 `git show HEAD:AGENTS.md` 读取
规则，第 2 次用 `git show -s --format=%H HEAD` 固定 HEAD，第 3 次用
`git grep -l -E <精确符号表达式> HEAD -- internal/battle` 只取得当前 HEAD 的真实路径。第 4 至
6 次对这些真实路径分别使用
`git grep -n -C 24 -E <精确符号表达式> HEAD -- <path>`，读取符号定义、注册和执行分支附近的
小段上下文；不要用 `git show` 打开大型实现文件。所有 `git grep` 都必须显式写 `HEAD`，搜索词
只允许 Lead 任务列出的具体 typ 数字、枚举名和数据函数名，不得混入 `time`、`target`、
`skill`、`damage`、`next`、`trigger` 或中文描述等通用词。不得根据目录印象猜文件名。不要先执行
空查询读取 AGENTS，也不要在命中具体消费者前读取架构总览、通用 Entry 生命周期或无关文档；
只有直接符号完全无命中时，才把剩余调用用于行为注册表或相邻枚举定义。
