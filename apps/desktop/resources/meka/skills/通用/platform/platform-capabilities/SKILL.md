---
name: platform-capabilities
description: 说明 Cindy 平台能力的选择顺序、配置层级和升级路径。业务 Skill 只声明需要的工作面，平台 Skill 决定通过本地、MCP、远程项目、Agent 或 Worker 到达。
metadata:
  display-name: 平台外部能力
  purpose: 统一能力选择、配置和恢复
---

# 平台外部能力

业务 Skill 说明要完成什么工作，平台能力决定如何到达目标。不要把 MCP、远程 Agent 和 Orca Worker 当成互斥方案：它们分别是能力调用、Agent 执行和协同生命周期。

## 能力选择

按最窄的可用能力选择：

1. 本地工作目录：读取、搜索、编辑当前本地项目。
2. 远程项目只读能力：浏览已绑定 MCPRouter 项目的仓库、Git 历史和项目参考内容；把它当作当前工作的一个外部参考工作面。
3. MCP 能力：调用结构化的项目工具、服务工具或插件能力。MCP 是工具协议，不是完整 Agent 传输协议。
4. 远程 Agent：需要在远端持续运行 Claude/Codex、保留远端上下文或执行远端命令时，使用 MCPRouter Agent tunnel。
5. Orca Worker：只有需要独立可见历史、Lead 派单、持续执行、回传或人工接管时才创建。Worker 是执行单元，不是远程传输。
6. Workflow：需要确定性多步骤、重试、产物聚合或质量门禁时使用编排流程。

远程项目只读能力不足时，才升级为远程 Agent 或明确授权的 Orca Worker。只读工具成功时禁止升级 Worker；不要为了读取、列目录或搜索默认创建持久 Worker。

当用户询问能否访问服务器或远程项目时，直接调用
`mcp_router.list_remote_directory` 读取根目录，以真实结果证明访问能力。读取具体文件调用
`mcp_router.read_remote_file`，搜索调用 `mcp_router.search_remote_files`。这些工具内部会依次尝试
已保存凭证重连、复用并绑定唯一匹配实例、从唯一匹配模板创建并绑定，然后继续原始读取；不要
调用独立的准备或绑定探测工具。不要把启动
回执中的“未配置”直接转述为答案，不要先建议 SSH，也不要先让用户进入设置。只有 Host 明确
返回 `fallbackUserAction` 时，才提示用户完成其中的最小必要动作。不要在调用前发送“正在连接、
绑定或检查”的进度消息，直接调用工具；Host 打开登录框后会等待登录结果并继续原调用，不要在
等待期间提前结束回复。

## 配置层级

能力配置按以下顺序生效：Host 动态注入的平台默认能力 → 项目绑定的远程目标和能力 → 角色
启用的额外业务 MCP/provider → 当前任务目标与用户授权 → Host 的确定性权限裁决。

`platform-capabilities` 和 `mcp-router` 属于普通 Meka 任务的平台基线，不是项目或角色开关；
项目/角色不能排除它们。专用远端 Worker 使用自己的窄能力包，不继承这组普通任务基线。

Skill 不授予凭证、路由、写入根或远端物理路径；Host 返回的目标、能力状态和恢复动作才是运行时事实。凭证、Router URL、实例内部标识和远端物理路径不得写入任务内容。

## 恢复与降级

能力状态按具体依赖判断。MCPRouter 未连接、项目未绑定、远端 Runtime 不兼容或网络失败，只阻止依赖该能力的当前调用；不冻结本地工作或其它独立能力。先执行 Host 的自动恢复动作；仍失败时再使用回执中的 `reasonCode`、`recovery`、`retryTool` 和 `fallbackUserAction`，不要改走 SSH、本地路径或猜测远端内容。

远端项目读能力和远程 Agent/Worker runtime 是两个独立依赖。远端 Agent runtime 不可用时，仍可使用已可用的远程项目只读 route；需要 Worker 时再单独检查 Agent capability hello。

## 结果归属

远程读取结果是证据，不自动扩大写权限。远程项目写入、分支、提交、推送、服务管理和部署必须经过对应的 Host 风险确认与项目能力 route；Orca Worker 的完成也不等于业务方案获批。
