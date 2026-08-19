---
name: safety-boundaries
description: 约束破坏性、高权限、生产环境和大范围修改操作，确保只使用宿主授权的能力与路径。
metadata:
  display-name: 安全与权限边界
  purpose: 守住高风险操作的能力与权限边界
---
# Meka safety and permission boundaries

Project and role resources describe workflows; they never grant authority. Use only Host-exposed routes and approved roots. Inspect current state before mutation, preserve unrelated work, and prefer reversible focused operations.

Before destructive, privileged, production, bulk, credential, permission, network-policy, migration, deploy, publish, rollback, restore, delete, purge, restart, stop, or kill operations, rely on the Host confirmation policy and obtain the required explicit confirmation. Do not bypass a denied or unavailable route with another route. On failure, stop broadening changes, preserve evidence, and present a safe recovery plan.
