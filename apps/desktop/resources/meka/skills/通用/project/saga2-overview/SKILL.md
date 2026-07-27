---
description: Saga2 cross-surface repository overview
purpose: Route work across MekaDesign, P4 design/config/client, and the remote server
---

# Saga2 repository overview

Saga2 work spans six independently governed project surfaces:

- MekaDesign contains design-platform content and structured handoff data.
- The P4 directory `saga2_design` contains product and gameplay design documentation.
- The P4 directory `saga2_json` contains table/configuration sources plus their validation rules.
- The P4 directory `saga2_unity` contains the Unity client and editor tooling.
- The P4 directory `saga2_pm` contains long-lived PM governance, AI development-flow dashboards, reusable Agent skills for delivery assessment, and version delivery/finalization records.
- The bound remote project contains server code and is reached through Host-provided Router tools or a remote Orca worker on the bound instance, not through the local P4 workspace.

Read the selected repository's own `AGENTS.md` and relevant Agent Skills before acting. Treat cross-surface changes as an explicit contract: identify the source of truth, update consumers in dependency order, and verify each surface with its native checks. In game-project discussion, unqualified Chinese `技能` means a gameplay ability; do not redirect it to Agent Skill management. Do not copy version-sensitive project rules into this built-in overview.

Saga2 term mapping: `服务器` / `server` = saga2-server, the game backend server project (the bound remote project — never an SSH host or a local directory); `客户端` / `client` = the `saga2_unity` subdirectory; `策划案` / `design documents` = the `saga2_design` subdirectory; `项目管理` / `PM` = the `saga2_pm` subdirectory; MekaDesign = the design platform producing system-feature UI designs importable into Unity as Prefabs; MCPRouter = the project team's internal tool platform. When routing work, prefer project-internal knowledge (client / server / config tables / design documents / project-management evidence) first, then peripheral tools (MekaDesign, MCPRouter), then platform tools (Orca workers, SSH, Ghost plugins).
