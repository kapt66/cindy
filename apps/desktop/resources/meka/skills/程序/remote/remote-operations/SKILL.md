---
name: remote-operations
description: 在远程项目环境已就绪后，通过 MCPRouter 安全访问已授权仓库，并区分仓库内容与服务管理。SAGA2 战斗环境门禁 ready=false 时不得加载本 Skill，只按 Host 回执恢复。
metadata:
  display-name: MCPR 远程项目操作
  purpose: 发现、读取和修改已授权的远程项目仓库
---

# MCPR 远程项目操作

在 SAGA2 战斗开发中，只有 `[SAGA2_COMBAT_ENVIRONMENT_GATE]` 的 `ready: true` 才允许使用本 Skill。环境恢复阶段不读取本文件，不用它寻找升级或重启路径。

远程项目是绑定到当前 Meka 项目的 MCPRouter 项目实例，不是本地目录，也不是 SSH 主机。进入远程仓库后先读该仓的 `AGENTS.md` 和命中的 Agent Skill；本 Skill 只负责路由，不替代远端项目规则。

## 路由优先级

按最窄且已经存在的能力选择：

1. 用户要求继续已有 MCPR 远程任务时，继续该任务。
2. 读取或编辑远程仓库内容时，使用绑定在 `mcpr:<instanceId>` 上的 Orca Worker。
3. 服务启停、健康检查、部署、更新、分支切换、提交、推送、合并、回滚等项目管理操作，使用专用 `project-agent` 工具。
4. 通用 `mcp_router` 只用于实例发现、创建和绑定，或没有更窄能力时的控制面操作。

不得用 SSH、本地 P4 路径或通用 Shell 替代 MCPR。远端物理路径由 Host 解析，不查询、不猜测、不向本地参数传递。

## 发现与配置

先调用 `list_project_remote_instances`。存在匹配且 `available` 的实例时，按上述优先级路由。

没有绑定匹配项时依次执行：

1. `list_remote_instances`：一个候选需用户确认；多个候选必须让用户选择。绑定前取得明确确认，再调用 `bind_remote_instance`。
2. 没有实例候选时调用 `list_remote_project_templates`。创建前展示模板名称和说明并取得确认，再调用 `create_remote_instance`，随后确认是否绑定。
3. 实例和模板都没有匹配项时，如实报告未配置并停止，不切换到 SSH 或本地目录。

## 仓库内容 Worker

创建持久、可见的远程 Worker 通常属于独立动作。先说明目标实例并取得确认；已经在当前任务明确确认过则不重复询问。若当前权威角色工作流明确要求带专用只读标记的 MCPR Worker，且 Host 会限制该 Worker 只能读，则角色选择与当前任务已构成这一步只读核对的授权，不再追加“是否允许只读核对”问题；该例外不授权绑定新实例、写仓库、分支或服务管理。确认或命中该窄例外后：

1. 尚未开启协同时调用 `start_team`；`ALREADY_ENABLED` 表示已经开启。
2. 调用 `create_worker`，传入准确的 `remote_host_id="mcpr:<instanceId>"`，不要传 `working_dir`。
3. 已知具体任务时用 `initial_task` 一次完成创建和派发。
4. 校验 `execution_target.type="remote"` 且 `remote_host_id` 与目标一致；返回本地目标时不得声称成功。

Worker 只处理仓库内容读写，不执行服务管理、构建测试、部署、分支管理、提交或推送。已有 Worker 用 `send_to_worker` 继续派发。

派发成功的唯一证据：`create_worker` 返回 `dispatched=true`、`queued_message_id` 或成功的 `dispatch_outcome`；`send_to_worker` 返回 `ok=true` 且 `wake_kind` 为 `resumed`、`already-active` 或 `queued`。出现这些信号后当前 Lead 回合立即结束，不输出确认、不轮询；Worker 结果会通过回传消息到达。缺少派发信号时报告失败并停止。

## 项目与服务管理

使用专用 `project-agent` 工具操作匹配实例，并核对工具返回的状态或健康证据。高风险动作继续走 Host 确认。专用能力缺失时明确报告并停止，不改派 Worker、SSH、Shell 或本地目录。

用户要求原始列表、日志或命令输出时原样转交；只有用户要求分析或输出过大时才摘要，并说明省略内容。实例不可用时报告实例和可用状态，引导恢复连接与绑定。
