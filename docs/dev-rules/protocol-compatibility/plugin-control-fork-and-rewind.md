# 插件的任务分叉与回退

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件记录对应能力的增量协议与旧端降级。

- `control/fork_session` 与 `rewind_session` 通过共用的 UI 业务入口执行；远程复用既有 `maker:fork` / `maker:rewind:commit`。
  `message_client_id` 是历史消息现有 clientId，不另建检查点 ID 或迁移；原有控制端参数与行为保持。未收到可信回执返回结果未知，不重放写入。
  `get_chat_history.messages[].clientId` 为可选增量字段，透传 reader 已有的原生/UI 锚点；旧端缺失时不从存储行 id 猜测。
