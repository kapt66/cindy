# 插件删除任务的控制工具

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件记录对应能力的增量协议与旧端降级。

- `control/delete_session` 为增量 Agent 工具，插件通过同一入口调用；本机复用 `patchSessionMetaInDb(status:'deleted')`，
  远程复用已有 `local-db:sessions:patch-meta` 状态协议，不新增通道或重试；无法确认写入结果时返回 `REMOTE_RESULT_UNKNOWN`。
