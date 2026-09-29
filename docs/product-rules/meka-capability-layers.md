# Meka 外部能力分层

> 状态：实施中
>
> 本文定义 Meka 如何选择和组合本地能力、MCPRouter 远程项目、远程 Agent、Orca Worker
> 与确定性 Workflow。平台层只描述能力契约；SAGA2 等项目的业务路由放在业务 Skill 中。

## 1. 两层 Skill

Meka Skill 分为两层：

- 平台层（`platform-capabilities`，随包唯一的平台 Skill）：说明能力类型、选择顺序、配置层级、
  恢复策略和权限边界，不绑定具体业务项目名称。
- 业务层（例如项目自己声明的 `saga2-project-battle-designer`、`editor-skill-editor-module`，
  或插件提供的 Skill）：说明项目有哪些工作面、证据优先级、默认 route 和何时升级；不重新定义
  MCP、远程 Agent 或 Orca transport。**业务层不再随包**：`resources/meka/` 只带
  `platform-capabilities`，业务 Skill 由项目 `<project-root>/.meka/project.json` 的
  `metadata` 清单（`itemType: 'skill'`）或已安装插件声明。

业务 Skill 说明“要查什么”，平台 Skill 决定“通过什么能力到达”。Skill 本身不授予
凭证、路由、写入根、远端物理路径或绕过 Host 的权限。

平台层由 Desktop Host 在每个普通 Meka 任务 bootstrap 时动态加入：始终挂载
`platform-capabilities` Skill 与 `mcp-router` provider，不读取项目
`roleDefaults`、角色 Skill/MCP 选择或旧任务中的角色配置来决定是否启用。项目和角色不能排除
这组平台基线。专用 MCPR 远端 Worker 继续使用窄能力包，不继承普通 Meka 平台 Skill/provider。

**「短的自动路由契约」的现状要说准（2026-09-29 订正）**：本节此前承诺平台基线里带一段
「短的自动路由契约」。**代码里从来没有这样一个注入段**——注入层的 prompt 段只有三段
（`meka.role-context` 60 / `meka.project-references` 65 / `meka.role-prompt` 70，见
[`../dev-rules/meka-injection-layer.md`](../dev-rules/meka-injection-layer.md) §3），
平台基线**不产生任何 prompt 段**。这条承诺实际由**两个非 prompt 载体**满足：

1. **`platform-capabilities` Skill 正文**（36 行）—— 能力阶梯、配置层级、恢复与降级、
   结果归属，经 **harness 原生 skill catalog** 交付（只暴露 name / description，正文按需读取）；
2. **`mcp-router` provider 的既有基线** —— 三条只读 route 的 tool description 本身承载
   「Host 自动解析和确保远程项目，不要先调用 Router 管理或 Worker 工具」「不需要实例 ID」这类
   路由指令（`mcp-integrations/meka-runtime-mcp.ts` 的 `list_remote_directory` / `read_remote_file` /
   `search_remote_files` 注册处）。

> **与 [`meka-skills.md`](meka-skills.md) §5 的口径对齐**：该文件写的是「Desktop Host 在每个普通
> Meka 任务启动时动态加入 `mcp-router` 能力引用与 `platform-capabilities` Skill，但只有明确的
> 服务器任务才注入主动读取/登录契约」——**这是代码支持的那一份**（平台基线给 Skill + provider，
> 路由文本落在 Skill 正文与 tool description 里，不额外注入一个路由段）。本文 §1 旧措辞里的
> 「短的自动路由契约」按「一段注入文本」读是错的，已按上面两条载体改写；两处表述现在一致。

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

`mcp-router` 是普通 Meka 任务的平台 provider，不是角色开关，由 Host 强制注入
（`MEKA_PLATFORM_MCP` 保证该 server 始终挂载）。**`project-agent` 只是 `mcp-router` 的兼容别名：
两者同源、命中同一个 `mcp_router` server、同一套工具，没有独立语义；新配置不得再声明它**
（存量角色与项目仍在声明，故该 id 必须继续被接受，否则它们会抛 `unknown Meka MCP provider`
而打不开会话）。角色真正能决定的是 `meka-design`、Meka Unity 官方 CLI 等额外业务能力。
运行时事实以 Host 返回的目标、能力状态、绑定关系和恢复动作为准。业务 Skill 不得在
prompt 中写入 Router URL、实例内部 ID、凭证或远端物理路径；实例 ID 只由 Host 从当前
项目绑定中解析和校验。

> **口径更正（2026-09-29）**：本节此前把 `project-agent` 列为「角色决定的额外业务能力」之一，
> 与实现不符 —— 实现见 `apps/desktop/src/main/mcp-integrations/meka-runtime-mcp.ts:16` 的
> `ROUTER_PROVIDER_IDS = new Set(['mcp-router','project-agent'])`（该文件只构造 `mcp_router` /
> `meka_design` / inline 三个 server）。同时，本节所说的「专用能力优先」在实现里是**提示词纪律**
> 而非 provider 门禁：远端 route 经 `call_tool` → `service.callProjectTool(...)` 抵达，
> 全仓没有任何 route 级白名单。**若日后要真正的路由最小权限，落点是 `call_tool` 的 route 白名单
> 或高风险授权，不是 provider id 别名。**

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
**载体（2026-09-29 订正）**：这条要求过去在 `platform-capabilities` Skill 正文里有一份逐句
副本，收敛时**按「与工具描述重复的内容归工具描述」删掉了该副本**；现在它由 `mcp-router`
provider 的三条只读 route 的 tool description 承载（`list_remote_directory` 写「Host 自动解析
和确保远程项目，不要先调用 Router 管理或 Worker 工具」，`read_remote_file` /
`search_remote_files` 同口径写明「不需要实例 ID」）。**产品要求本身未变**，变的是它的载体。
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
