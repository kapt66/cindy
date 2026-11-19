# 插件读取与设置会话运行时权限模式

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件记录对应能力的增量协议与旧端降级。

- `get_session_runtime` 增量返回可选 `permission_mode`；`set_session_runtime` 接受该可选字段。
  复用现有权限提交与回滚，省略字段时原任务调用保持原行为。插件继续/插话使用已有 `sourcePlugin` 来源元数据，不伪造当前任务。
