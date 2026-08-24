# Meka 外部能力分层

> 状态：实施中
>
> 本文定义 Meka 如何选择和组合本地能力、MCPRouter 远程项目、远程 Agent、Orca Worker
> 与确定性 Workflow。平台层只描述能力契约；SAGA2 等项目的业务路由放在业务 Skill 中。

## 1. 两层 Skill

Meka Skill 分为两层：

- 平台层（`platform-capabilities`）：说明能力类型、选择顺序、配置层级、恢复策略和
  权限边界，不绑定具体业务项目名称。
- 业务层（例如 `saga2-server-reference`）：说明项目有哪些工作面、证据优先级、默认
  route 和何时升级；不重新定义 MCP、远程 Agent 或 Orca transport。

业务 Skill 说明“要查什么”，平台 Skill 决定“通过什么能力到达”。Skill 本身不授予
凭证、路由、写入根、远端物理路径或绕过 Host 的权限。

平台层由 Desktop Host 在每个普通 Meka 任务 bootstrap 时动态加入：始终挂载
`platform-capabilities` Skill、`mcp-router` provider 和短的自动路由契约，不读取项目
`roleDefaults`、角色 Skill/MCP 选择或旧任务中的角色配置来决定是否启用。项目和角色不能排除
这组平台基线。专用 MCPR 远端 Worker 继续使用窄能力包，不继承普通 Meka 平台 Skill/provider。

## 2. 能力选择

按最窄的可用能力选择：

1. 本地工作目录：读取、搜索和编辑当前项目。
2. MCPRouter 远程项目只读 route：通过 `list_remote_directory`、`read_remote_file`、
   `search_remote_files` 读取绑定项目仓库 `HEAD` 的目录、文本和固定字符串搜索结果，把它
   当作当前工作的外部参考工作面。这些工具由 Host 自动确保登录、实例和绑定，不启动 Agent。
3. MCP：调用结构化项目、服务或插件能力。MCP 是工具调用协议，不等于 Agent 执行通道。
4. 远程 Agent：需要远端持续上下文、远端命令或跨多轮执行时使用 Agent tunnel。
5. Orca Worker：需要独立可见历史、Lead 派单、持续运行、结构化回传或人工接管时创建。
6. Workflow：需要确定性多步骤、重试、产物聚合或质量门禁时使用编排流程。

读取远程项目文件、Git 证据或可访问状态时，直接调用对应只读工具；工具内部恢复已保存凭证、
复用唯一匹配实例，或从唯一匹配模板创建并绑定。独立准备/绑定探测不向 Agent 暴露，避免用
准备状态冒充真实读取。只读 route 成功时禁止升级为 Agent/Worker；只有缺少远端
命令、持续上下文或独立协作生命周期等明确能力后，才升级到远程 Agent 或授权 Worker，并在
任务中写明交付物、范围和只读/写入边界。

三条只读 route 是 Router session 鉴权的 capability gateway 能力：Desktop Host 调用
`POST /api/plugin-capabilities/call`，并提交 `selected-instance` scope；它们不是
`/mcp/:clientKey` 中可发现的普通 MCP tool。Host 必须先按当前项目绑定校验 `instanceId`，再由
Router 做账号与实例所有权校验。不得通过 `tools/list` 探测 `git.tree` / `git.read` /
`git.search`，也不得在该清单缺失时改走 Worker。

## 3. 配置与事实来源

配置按以下顺序生效：

1. Host 动态注入的平台默认能力；
2. 项目绑定的远程目标、模板和能力；
3. 角色启用的额外业务 MCP/provider；
4. 当前任务目标和用户授权；
5. Host 的确定性权限裁决。

`mcp-router` 是普通 Meka 任务的平台 provider，不是角色开关；角色只决定
`project-agent`、`meka-design`、UnityMCP 等额外业务能力。运行时事实以 Host 返回的目标、
能力状态、绑定关系和恢复动作为准。业务 Skill 不得在
prompt 中写入 Router URL、实例内部 ID、凭证或远端物理路径；实例 ID 只由 Host 从当前
项目绑定中解析和校验。

## 4. 降级与恢复

每种能力单独判断可用性。任一真实 MCPRouter 读取发现会话或客户端 key 缺失时，Router Service
先用 Host 加密保存的账号材料单飞重连，再继续原调用；项目请求随后自动确保实例和绑定。
MCPRouter 未连接、项目未绑定、远端 Agent runtime 版本不兼容或网络失败，先由 Host 执行无感的自动恢复；自动恢复仍失败时才阻止依赖该能力的具体调用，
不冻结本地探索或其它独立能力。

capability gateway 返回 `ROUTE_NOT_FOUND` 表示当前 MCPRouter 服务端没有部署对应 route，
不是登录、网络或 SSH 故障。此时只提示部署方更新并重启 MCPRouter 服务；不得要求用户修改
Cindy 设置、重新连接 SSH 或重复创建远程实例。

远程项目只读能力与 Agent/Worker runtime 是两个独立依赖：远端 runtime 不兼容时仍可使用
已可用的远程项目只读 route；真正创建 Agent/Worker 时再执行 capability hello。恢复时遵循
Host 回执中的 `reasonCode`、`recovery` 和 `retryTool`，不得改走 SSH、猜测本地路径或伪造
远端内容。

普通 Meka 任务的动态契约要求：用户询问能否访问服务器或远程项目时，必须直接调用
`mcp_router.list_remote_directory` 对仓库根目录做真实读取探测；不能用启动状态直接回答
“不能”，也不能先提示 SSH、设置页或手工连接。该工具会自动确保远程引用；只有工具明确
返回 `fallbackUserAction` 才展示最小必要动作。
需要用户完成 MCPRouter 登录时，Host 只向 Cindy 主壳窗口投递登录弹窗；独立右侧栏、
资源用量窗、utility、插件面板与会话副窗都不是合法目标，也不得仅因 IPC 已发送就误报
弹窗已打开。真实远程项目工具会保持本次调用等待：Renderer 确认弹窗已展示，连接或注册成功
后 Main 唤醒原调用并继续实例发现、模板创建和项目绑定；取消、五分钟超时或主壳不可用时才
返回最小恢复动作。并发远程调用共用一次登录请求，账号、密码和令牌仍只走 Renderer 到 Main
的既有加密存储链路，不进入 Agent 工具参数、prompt 或日志。Agent 不在工具调用前发送连接或
绑定的手工动作/进度消息，也不在登录等待期间提前结束回复。

## 5. 权限边界

远程项目作为参考工作面不等于获得服务器写权限。远程文件修改、分支、提交、推送、服务
管理、部署和发布始终需要对应的专用能力与 Host 风险确认。Worker 完成只产生证据或交付物，
不自动批准业务方案，也不扩大 Lead 的权限。

## 6. 实机验收基线

服务器可访问性不能以绑定成功、准备成功、弹窗已发送或 Agent 文案为验收证据，必须核对任务
rollout 中真实工具调用及其结果。2026-08-24 的任务
`2e2a0724-4591-42d5-b599-e84d2085736e` 只调用了已准备远程引用的旧探测工具，没有读取仓库，
因此判定为假成功并促成该探测工具从 Agent 可见工具集中移除。

同日使用共享正式 profile 重启 Desktop 后，新任务
`87724f03-4603-4df4-8f57-bf9d9af44659` 完成真实验收：rollout 中
`list_remote_directory=1`、`read_remote_file=1`、`search_remote_files=1`，旧准备探测与 Worker
调用均为 0；根目录、`AGENTS.md` 与固定字符串搜索均返回成功，三条 route 返回同一仓库 HEAD
`565cc7ab89d088d48f5c0777e129804b04d0f716`。回复没有要求 SSH、打开设置、手工连接或创建
Worker。后续修改该链路时必须至少复现同等级的真实任务与 rollout 证据，单元测试不能替代实机
验收。
