# 插件宿主工具组声明与请求通道

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件记录对应能力的增量协议与旧端降级。

- `agent.hostTools: string[]` 增量声明宿主工具组，当前识别 history/control/handoff/settings/scheduler/terminal/files/storage/browser/computer/ssh/docs/discovery。
  未知字符串保留但当前宿主不支持；整体安装批准有效且已启用时按 manifest 已知声明放行，不另存分组批准。旧 receipt 中的 `approvedHostToolGroups` 字段读取时忽略，不迁移或清理数据。
  UI 管子新增 `host-tool-request`，Node 私有通道使用同类型加 `reqId`，共用宿主校验及 Agent 工具处理器；返回原始 MCP 结果。
  旧宿主可保留清单但不支持接口，插件须检测 `cindy.host?.call` 并处理不支持响应。无 Session 的插件调用方不会改变原任务调用方协议或身份；不涉及 device-link wire 变更。
  无 `node` 批准的插件不支持脚本/前置命令调度；普通调度更新、运行和恢复复用既有 `expectedSchedule` 参数及执行点检查，不新增协议字段或确认层，原 Agent 不带守卫时行为保持。
