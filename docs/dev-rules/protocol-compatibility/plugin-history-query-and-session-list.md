# 插件历史查询与任务目录

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件记录对应能力的增量协议与旧端降级。

- 历史查询通道增量支持 `list_teammates`，复用同一个工具 registry 校验与宿主目录读取；不新增 channel。
  目录和指定 `teammate_id` 的关系分别分页，默认 100、最多 1000，返回 `nextCursor` / `hasMore`，游标复用历史查询的编码。

旧端拒绝未知查询时按既有远程错误报告，聚合结果保留 `partial`，不当成空目录。
`list_sessions.hiddenAt` 为可选增量字段，旧响应缺失不推断隐藏；跨电脑伙伴目录中的任务关系使用 `deviceId::sessionId`，伙伴 id 保持原值。
