---
name: orca-coordination
description: 在项目环境已就绪后协调明确请求的 Orca Worker、任务委派和并行工作。SAGA2 战斗环境门禁 ready=false 时不得加载本 Skill 或创建 Worker。
metadata:
  display-name: Orca 多智能体协作
  purpose: 协调 Worker、委派与并行工作
---

# Orca 多智能体协作

仅为边界明确、可独立推进的子任务创建 Worker。每个本地 Worker 必须使用 Host 允许的工作目录，并继承 Lead 的项目与角色配置。派发内容需写明交付物、约束、证据要求和集成边界。

远程任务优先继续已有 MCPR 任务；远程仓库内容读写使用绑定实例上的 Orca Worker；服务生命周期、健康、部署、更新、分支和交付管理使用专用 `project-agent`。不要用通用 `mcp_router` 覆盖已有专用能力。

远程仓库 Worker 使用 `remote_host_id="mcpr:<instanceId>"`，不传 `working_dir`。创建持久、可见的 Worker 前通常要说明目标并取得用户确认；底层仓库请求本身不等于创建授权。若当前权威角色工作流明确要求带专用只读标记的 MCPR Worker，且 Host 会限制该 Worker 只能读，则不重复询问这一步只读核对；绑定新实例、写入、分支和服务管理不适用该例外。确认或命中该窄例外后按需调用 `start_team`，再创建并派发 Worker。Worker 只处理仓库内容读写，不执行服务管理、构建测试、部署、提交或推送。

共享决策留在 Lead。整合前按原始目标、仓库规则、实际改动和验证结果审查 Worker 回执。Worker 输出是证据，不是自动批准；委派不得扩大路由、凭证、写入根或角色能力。
