---
name: saga2-overview
description: 说明 SAGA2 在 MekaDesign、P4 策划与客户端、配置表、项目管理和 MCPR 远程服务器之间的工作边界与路由。
metadata:
  display-name: SAGA2 项目总览
  purpose: 在 SAGA2 各项目面之间正确路由工作
---

# Saga2 repository overview

Saga2 work spans six independently governed project surfaces:

- MekaDesign contains design-platform content and structured handoff data.
- The P4 directory `saga2_design` contains product and gameplay design documentation.
- The P4 directory `saga2_json` contains table/configuration sources plus their validation rules.
- When the dedicated project-management tool starts local SAGA2 servers and asks for a project config
  directory candidate, pass the direct child name `saga2_json`. If the Host reports that candidate exists,
  ask the user whether to use it before adopting it; if no candidate exists, let the Host open its system
  directory picker. Do not inspect or pass an absolute local path through plugin arguments.
- For local server update, start, stop, status, or logs on the current computer, go directly through
  `cindy:ghost_list`, select the plugin whose declared purpose covers MCPR project/local-server management,
  and call `account_overview` followed by the single operation matching the user's intent. Use
  `update_servers` for update/rebuild/deploy requests, `start_servers` for start requests, and
  `stop_servers` for stop requests. Do not enumerate generic `mcp_router` tools, generic MCP instances,
  remote Workers, or low-level build/prepare/process operations first. Never hard-code a `meka-dev-*`
  runtime ID because development and installed identities differ.
- The P4 directory `saga2_unity` contains the Unity client and editor tooling.
- The P4 directory `saga2_pm` contains long-lived PM governance, AI development-flow dashboards, reusable Agent skills for delivery assessment, and version delivery/finalization records.
- The bound remote project contains server code. An existing MCPR remote task/session is the first
  route when the user asks the remote Agent to work in its selected project context. Repository
  content is read or written through a remote Orca worker on the bound instance; server lifecycle,
  deployment, health, branch, update, and delivery management uses the configured Host-provided
  `project-agent` tools. Generic `mcp_router` operations are only for remote-instance discovery or
  provisioning, not the default way to execute work; never use a Worker, SSH host, or local P4
  workspace as a substitute for the matching route.

Read the selected repository's own `AGENTS.md` and relevant Agent Skills before acting. Treat cross-surface changes as an explicit contract: identify the source of truth, update consumers in dependency order, and verify each surface with its native checks. In game-project discussion, unqualified Chinese `技能` means a gameplay ability; do not redirect it to Agent Skill management. Do not copy version-sensitive project rules into this built-in overview.

Saga2 term mapping: `服务器` / `server` = saga2-server, the game backend server project (the bound remote project — never an SSH host or a local directory); `客户端` / `client` = the `saga2_unity` subdirectory; `策划案` / `design documents` = the `saga2_design` subdirectory; `项目管理` / `PM` = the `saga2_pm` subdirectory; MekaDesign = the design platform producing system-feature UI designs importable into Unity as Prefabs; MCPRouter = the project team's internal tool platform. For current-computer server lifecycle, prefer the MCPR project-management plugin. For remote work, prefer the current MCPR remote session, then the remote Orca Worker for repository content, then the dedicated `project-agent` for remote project management, and only then generic `mcp_router` discovery/provisioning. Do not choose a broad underlying Router operation over a matching specialized route.
