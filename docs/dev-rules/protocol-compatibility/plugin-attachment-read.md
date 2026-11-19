# 插件读取会话附件

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件记录对应能力的增量协议与旧端降级。

- `read_session_attachment` 的公开工具结果为分块 base64（最多 64 KiB）与内容摘要，插件媒体与普通文件分别复用 grant / handoff。
  第 10 项附件读取仅覆盖已有宿主授权的 Cindy 媒体及 grant / deposit / handoff 引用。历史 JSON 的 `files.path`、绝对路径与旧文件直读 URL 返回 `UNSUPPORTED_CAPABILITY`，不凭消息内容授权读文件或创建交接副本。
  可选 `mediaHash` 仅续读已交接给当前插件的媒体：复核既有 grant 后按范围读总仓字节，复用内容寻址摘要；普通文件继续使用 `attachment_ref`。不新增缓存、授权事实或路径字段，旧端不识别续读参数时仍可从原消息读取。
  普通文件续读复用原交接句柄的范围读取和首次交接摘要，不逐页重读整份副本；调用方组装后校验，副本变化或摘要不符时通过既有授权交接流程重新取得。
  仅支持本机任务；跨电脑返回 `UNSUPPORTED_CAPABILITY`，不加入跨设备历史查询、文件传输或 Device Link channel。
