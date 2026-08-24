---
name: orca-coordination
description: 协调明确请求的 Orca Worker、任务委派和并行工作；Worker 是可见执行单元，不是默认的远程仓库访问方式。
metadata:
  display-name: Orca 多智能体协作
  purpose: 协调 Worker、委派与并行工作
---

# Orca 多智能体协作

仅为边界明确、可独立推进的执行单元创建 Worker。读取一个远程项目文件、查看 Git 证据或确认服务器代码时，先使用远程项目只读能力；不要为普通参考读取默认创建 Worker。

创建 Worker 前说明交付物、目标、约束、证据和集成边界。远程 Worker 使用 `remote_host_id="mcpr:<instanceId>"`，不传本地 `working_dir`；其目标必须由 Host 按当前项目绑定和 capability 状态重新验证。

以下情况才升级为 Worker：需要独立可见历史、Lead 派单、持续运行、多轮追问、远程命令、结构化报告回传或用户接管。持久、可见 Worker 通常需要用户明确授权；业务流程明确授权的窄范围只读核查可以复用该授权，但不扩大到绑定、写入、分支或服务管理。

Worker 的结果是证据或交付物，不自动批准 Lead 的业务方案。共享决策、权限、目标归属和最终验收留在 Lead/Host；项目服务管理继续使用专用 `project-agent`，不通过 Worker 或通用 `mcp_router` 代替。
