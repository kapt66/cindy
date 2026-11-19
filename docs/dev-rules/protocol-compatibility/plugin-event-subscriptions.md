# 插件事件订阅

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件记录对应能力的增量协议与旧端降级。

- `subscribe.topics` 增量识别 `message` / `task-state`，事件名为 `did-message-created` / `did-task-state-changed`，复用现有管子事件封装。
  整体安装批准有效且已启用时按 manifest 已知 topic 声明分发，不另存主题批准；旧 receipt 中的 `approvedEventTopics` 字段读取时忽略，原有 topic 继续原行为。
  新消息事件只提供正文和附件位置，不提供宿主路径；`historyCursor` 复用 `get_chat_history` 编解码，序号不作为持久重放凭证。
  `task-state` 只发布开始、结束、出错、等待权限/回答、排队、取消及归档/恢复/删除等生命周期变化，不发布高频进度、活动或仅隐藏状态的变化。
  两种 topic 沿用逐事件投递、100 条熄灯队列和单调序号，不新增合批、折叠或 timer；序号缺口可补拉，溢出标记 `dropped`。
  无新跨设备 channel、轮询、事件持久化或中转协议；旧端可保留新声明但不投递。
