# 插件作为会话交接地发送方

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件记录对应能力的增量协议与旧端降级。

- `maker:session:handoff` 的既有能力探测增量返回 `pluginCaller:1`。插件发送方使用 `sender:{kind:'plugin',pluginId,name?}`，
  不提供 `sender.sessionId` 或任务请求来源；旧任务发送方及 wire 字段保持原样。缺新能力位时在发送内容前返回不支持。
  现有一次性回执绑定 `senderPluginId`，回查使用 `pluginId`；任务仍用原 session 字段，混合或缺失调用方拒绝。
  接收任务按来源电脑限定 `sourcePlugin.pluginId=deviceId::pluginId`，保留目标权限与 Plan；界面不把它导航到本机同名插件。
  不新增 channel、授权存储或 relay 字段；自建中转继续透明传输原业务 payload，无需同步适配。
