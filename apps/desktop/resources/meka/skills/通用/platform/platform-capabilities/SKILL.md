---
name: platform-capabilities
description: 说明 Cindy 平台能力的选择顺序与配置层级。业务 Skill 只声明需要的工作面，平台 Skill 决定通过本地、MCP、远程项目、Agent 或 Worker 到达。
metadata:
  display-name: 平台外部能力
  purpose: 统一能力选择、配置和恢复
---

# 平台外部能力

## 能力选择（按最窄的可用能力选择）

1. 本地工作目录：读取、搜索、编辑当前本地项目。
2. 远程项目只读能力：浏览已绑定 MCPRouter 项目的仓库、Git 历史和项目参考内容；把它当作当前工作的外部参考工作面。
3. MCP 能力：调用结构化的项目工具、服务工具或插件能力。MCP 是工具协议，不是完整 Agent 传输协议。
4. 远程 Agent：需要在远端持续运行 Claude/Codex、保留远端上下文或执行远端命令时，使用 MCPRouter Agent tunnel。
5. Orca Worker：只有需要独立可见历史、Lead 派单、持续执行、回传或人工接管时才创建。Worker 是执行单元，不是远程传输。
6. Workflow：需要确定性多步骤、重试、产物聚合或质量门禁时使用编排流程。

远程项目只读能力不足时，才升级为远程 Agent 或明确授权的 Orca Worker；只读工具成功时禁止升级 Worker，也不要为读取、列目录或搜索默认创建持久 Worker。

## 配置层级

能力配置按以下顺序生效：Host 动态注入的平台默认能力 → 项目绑定的远程目标和能力 → 角色启用的额外业务 MCP/provider → 当前任务目标与用户授权 → Host 的确定性权限裁决。

`platform-capabilities` 和 `mcp-router` 属于普通 Meka 任务的平台基线，不是项目或角色开关；项目/角色不能排除它们。专用远端 Worker 使用自己的窄能力包，不继承这组任务基线。

Skill 不授予凭证、路由、写入根或远端物理路径；Host 返回的目标、能力状态和恢复动作才是运行时事实。凭证、Router URL、实例内部标识和远端物理路径不得写入任务内容。

## 恢复与降级

能力状态按具体依赖判断：MCPRouter 未连接、项目未绑定、远端 Runtime 不兼容或网络失败只阻止依赖该能力的当前调用，不冻结本地工作或其它独立能力，远端项目只读与远端 Agent runtime 也各自独立。先执行 Host 的自动恢复动作，仍失败时再使用回执中的 `reasonCode`、`recovery`、`retryTool` 和 `fallbackUserAction`，不要改走 SSH、本地路径或猜测远端内容。

## 结果归属

远程读取结果是证据，不自动扩大写权限。远程项目写入、分支、提交、推送、服务管理和部署必须经过对应的 Host 风险确认与项目能力 route；Orca Worker 的完成也不等于业务方案获批。
