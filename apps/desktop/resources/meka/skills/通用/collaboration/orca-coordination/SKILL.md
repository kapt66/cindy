---
description: Meka Orca worker coordination procedure
purpose: Coordinate explicitly requested workers, delegation, and parallel work
---
# Meka Orca coordination

Create a worker only for a concrete, bounded slice that can proceed independently. For every local worker, explicitly choose one Host-approved working directory; the worker inherits the Lead's project and role configuration. Give the worker its deliverable, constraints, evidence requirements, and integration boundary.

For a remote request, preserve the narrowest existing route: continue an MCPR remote task/session
when the user is asking the remote Agent to work in that session; use an Orca Worker only for remote
repository content; and use the dedicated MCPRouter `project-agent` tools for project/service
management. Do not use a generic `mcp_router` operation when one of those specialized capabilities
matches. When the slice is remote repository content — repository reads, directory listings, or
requested file writes — use a worker on that remote instance (`remote_host_id="mcpr:<instanceId>"`,
and do NOT pass `working_dir`; the remote workspace is resolved host-side) instead of a local
directory. The Worker is content-only: it must not start/stop/restart services, inspect processes,
run builds/tests, deploy, update/sync, push, switch branches, merge, rollback, or perform other
project management. Server lifecycle, deployment, health, update/sync, push, branch, and release
operations belong to the configured MCPRouter `project-agent` management tools and must not create
or use an Orca Worker. If no matching Worker exists for repository content, identify the target
instance and ask the user whether to create the persistent, UI-visible remote Worker; assigning the
underlying repository task is not by itself creation approval. After approval, call `start_team`
directly if the team is not started yet — team startup needs no separate confirmation, and an
`ALREADY_ENABLED` error means collaboration is already active — then create the Worker and dispatch
its repository content task. Its working directory is the remote project workspace, and the same
inheritance and review rules apply.

Keep shared decisions with the Lead. Review worker output against the original target, repository instructions, changed files, and executed tests before integrating it. A worker report is evidence, not automatic approval. Never use delegation to expand routes, credentials, write roots, or configured project/role resources.
