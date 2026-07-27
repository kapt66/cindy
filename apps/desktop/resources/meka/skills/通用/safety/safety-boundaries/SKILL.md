---
description: Meka capability and permission safety boundaries
purpose: Guard destructive, privileged, production, or broad mutation operations
---
# Meka safety and permission boundaries

Project and role resources describe workflows; they never grant authority. Use only Host-exposed routes and approved roots. Inspect current state before mutation, preserve unrelated work, and prefer reversible focused operations.

Before destructive, privileged, production, bulk, credential, permission, network-policy, migration, deploy, publish, rollback, restore, delete, purge, restart, stop, or kill operations, rely on the Host confirmation policy and obtain the required explicit confirmation. Do not bypass a denied or unavailable route with another route. On failure, stop broadening changes, preserve evidence, and present a safe recovery plan.
