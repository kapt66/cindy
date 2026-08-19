---
name: p4-operations
description: 在授权的 Perforce 工作区中安全执行编辑、变更列表整理、冲突处理与提交前验证。
metadata:
  display-name: Perforce 操作
  purpose: 管理授权的 Perforce 内容和变更列表
---
# Perforce operations

Operate only inside the Host-approved enabled P4 child workspace. Confirm the client, root, current changelist, file state, and repository instructions before editing. Open tracked files with the repository's expected checkout or edit flow; use reconcile only after reviewing the exact add, edit, delete, and move candidates.

Keep task files in a focused changelist, exclude generated caches and temporary artifacts, and never sweep unrelated workspace changes into the result. Inspect conflicts and resolve them with source evidence rather than accepting a side wholesale. Before submit, review the diff, run required validation, confirm no unintended files are open, and obtain explicit submit authorization. If sync, resolve, reconcile, validation, or submit fails, preserve the changelist and workspace evidence, avoid repeated broad retries, and report a recovery path.
