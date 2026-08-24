---
name: remote-operations
description: 通过 MCPRouter 访问已授权远程项目，并按只读参考、远程 Agent、Orca Worker 和项目管理能力选择最窄路径。
metadata:
  display-name: MCPR 远程项目操作
  purpose: 统一远程项目发现、读取、Agent 和管理路由
---

# MCPR 远程项目操作

远程项目是绑定到当前 Meka 项目的 MCPRouter 项目实例。它是一个外部项目工作面，不是本地目录，也不是 SSH 主机。远端物理路径由 Host 解析，不查询、不猜测、不传给本地参数。

## 路由优先级

1. 用户要求继续已有 MCPR 远程任务时，继续该任务。
2. 读取、搜索或核对远程仓库内容时，优先调用 `mcp_router.list_remote_directory`、
   `mcp_router.read_remote_file`、`mcp_router.search_remote_files`，再按需使用 Git
   preview/show/diff/log。把结果作为当前任务的参考证据；这些读取成功时禁止创建 Worker。
3. 只有直接只读能力不足，或用户明确要求独立可见历史、持续执行、远程命令或报告回传时，才使用 MCPRouter Agent tunnel 或明确授权的 Orca Worker。
4. 服务启停、健康检查、部署、更新、分支切换、提交、推送、合并和回滚使用专用 `project-agent` 能力，并接受对应风险确认。
5. 通用 `mcp_router` 只用于实例发现、模板、绑定和明确注册的项目能力，不替代更窄的项目 route。

不得用 SSH、本地 P4 路径或本地 Shell 冒充 MCPR 远程项目。`mcpr:<instanceId>` 是 MCPRouter 目标身份，不能进入 SSH host pool。

## 发现与配置

有业务读取依赖远程项目时，直接调用上述目录/文件/搜索工具；Host 会在同一次调用内自动尝试
已保存凭证重连、复用并绑定唯一匹配实例，或从唯一匹配模板创建并绑定。只有纯准备/绑定状态
查询也直接使用最小只读工具完成真实探测。只有工具返回 `fallbackUserAction`、候选有
歧义、没有匹配模板或自动恢复失败时，才向用户说明最小必要动作。不要先把未配置状态复述给
用户，也不要因为没有实例就改走本地仓库或 SSH。

远程项目只读能力和远程 Agent runtime 分开判断：项目 route 可用但 Agent runtime 不兼容时，仍可继续只读参考；只有创建 Agent/Worker 时才阻止该次执行并引导 Runtime 恢复。

调用失败时优先读取结构化 `reasonCode`、`recovery` 和 `retryTool`。登录、认证、网络和部署方 Runtime 升级由用户或部署方完成；保留当前进度，并继续不依赖 MCPR 的本地工作。

## Worker 升级路径

创建持久、可见的远程 Worker 通常属于独立动作。只有用户明确要求，或当前业务流程明确授权窄范围只读核查时，才说明目标并创建 Worker。Worker 只处理已授权的仓库内容，不执行服务管理、部署、分支、提交或推送。

派发成功后以 `create_worker` 的 accepted/queued 信号或 `send_to_worker` 的成功唤醒信号为准；没有真实派发信号不得等待或声称完成。

## 项目管理

项目实例、绑定、模板、健康和服务管理使用专用 `project-agent` 能力。需要写入或有副作用的 route 仍由 Host 进行风险确认；远程项目作为参考工作面不等于获得服务器写权限。
