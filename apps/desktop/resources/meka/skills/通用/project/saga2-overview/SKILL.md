---
name: saga2-overview
description: 在项目环境已就绪后，说明 SAGA2 在 MekaDesign、P4、配置表、客户端、项目管理和 MCPR 远程服务器之间的边界。战斗环境门禁 ready=false 时不得加载。
metadata:
  display-name: SAGA2 项目总览
  purpose: 在 SAGA2 各项目面之间正确路由工作
---

# SAGA2 项目总览

SAGA2 的完整交付由六个独立治理的表面组成：

- MekaDesign：设计平台内容与结构化交接数据。
- `saga2_design`：P4 中的产品和玩法策划文档。
- `saga2_json`：表格、配置源与校验规则。
- `saga2_unity`：Unity 客户端与编辑器工具。
- `saga2_pm`：项目治理、开发流程看板、交付评估 Skill 和版本记录。
- MCPR 绑定远程项目：服务器代码，只能通过允许的远程项目能力访问。

进入选定仓库后读取其 `AGENTS.md` 和命中的 Agent Skill。跨表面修改必须明确事实源，按依赖顺序更新消费者，并用各自的原生检查验证。项目内未限定的“技能”表示游戏玩法技能，不要误解为 Agent Skill。

术语映射：`服务器` 指绑定的 saga2-server 远程项目，不是 SSH 主机或本地目录；`客户端` 指 `saga2_unity`；`策划案` 指 `saga2_design`；`项目管理` 指 `saga2_pm`。

远程工作优先继续现有 MCPR 任务；仓库内容使用远程 Orca Worker；项目和服务管理使用专用 `project-agent`；通用 `mcp_router` 只做发现和配置。不得用 SSH 或本地 P4 路径替代服务器远程项目。

当前电脑上的 SAGA2 本地服务管理通过声明 MCPR 本地项目管理能力的插件执行：先用 `cindy:ghost_list` 发现能力，再调用 `account_overview` 和与用户意图唯一匹配的操作。配置目录候选只传直接子目录名 `saga2_json`；Host 确认存在后让用户确认，找不到时由 Host 打开系统目录选择器。不要把绝对本地路径传给插件，也不要硬编码开发期插件 ID。
