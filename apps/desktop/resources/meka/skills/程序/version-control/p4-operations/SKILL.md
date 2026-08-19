---
name: p4-operations
description: 在 Perforce 环境已就绪后安全执行编辑、变更列表整理、冲突处理与提交前验证。SAGA2 战斗环境门禁 ready=false 时不得加载本 Skill。
metadata:
  display-name: Perforce 操作
  purpose: 管理授权的 Perforce 内容和变更列表
---

# Perforce 操作

只在 Host 允许的 P4 子工作区内操作。编辑前确认客户端、根目录、当前变更列表、文件状态和仓库规则；跟踪文件按项目约定先执行 checkout 或 `p4 edit`。只有逐项核对新增、修改、删除和移动候选后才能 reconcile。

任务文件放入范围明确的变更列表，排除缓存、临时文件和无关改动。冲突必须依据源内容解决，不整边接受任一侧。提交前审查 diff、运行要求的验证、确认没有意外打开文件，并取得明确提交授权。

同步、解决冲突、reconcile、验证或提交失败时保留变更列表与现场证据，不做宽泛重复重试，并报告恢复路径。
