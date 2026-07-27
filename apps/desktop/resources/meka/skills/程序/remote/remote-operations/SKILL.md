---
description: Safe allowlisted remote project operations
purpose: Discover, diagnose, edit, build, deploy, or restart authorized remote projects
---
# Remote project operations

Remote projects are MCPRouter project-agent instances bound to the current Meka project; they are not local directories. Read the remote repository's own `AGENTS.md` and relevant Agent Skills before acting; built-in guidance does not replace project knowledge.

**What runs where (deterministic facts — do not re-probe them):**

- Router tools cover project management / design-asset domains only. They do NOT cover remote file reads, directory listings, or shell commands — never call `list_tools` just to check whether such an operation is covered; it never is.
- A remote instance (`mcpr:<id>`) is NOT an SSH host. Never try SSH tools (`ssh_list_hosts`, `ssh_exec`, …) to reach it; they cannot.
- The reverse also holds: an SSH host is NOT the project's server. `服务器` / `server` in a game-project context means the server codebase (a remote project instance), not a machine you can ssh into. If the provisioning chain (Step 2) finds no instance and no template, the correct outcome is "the remote server is not configured yet" — never fall back to `ssh_list_hosts` / `ssh_exec` to go find "the server", and never offer SSH hosts as candidate interpretations of `服务器`.
- Resolve ambiguous requests in this priority order: (1) project-internal knowledge — client / server repos, config tables, design documents; (2) peripheral tools — MekaDesign, MCPRouter; (3) platform tools — Orca workers, SSH, Ghost plugins. Always exhaust the earlier tier before reaching for a later one.
- The instance's physical path on the remote host is deliberately not exposed — it is meaningless locally, and the remote workspace is resolved host-side from the instance binding. Never ask for it, never guess it, and never substitute any local path for it.
- Therefore: any task that reads remote code, lists remote files, or runs remote commands goes straight to a remote Orca worker (Step 3), even if the task is small. Workers are cheap to reuse — keep the worker alive for iterative queries instead of recreating it per question.

**Step 1 — Discover bound instances.** Call the `mcp_router` `list_project_remote_instances` tool. It returns this project's bound instances with `projectName` / `projectDescription` (use them to identify which instance carries what, for example the server code), `availability`, and `remoteHostId`. If an `available` instance matches the task, go to Step 3.

**Step 2 — No bound match: the provisioning chain.** Only when Step 1 yields no matching instance, and only while MCPRouter is connected. Follow these substeps IN ORDER and do not abandon the chain between them — an empty result moves you to the next substep, it does not end the chain and it is never a reason to switch to SSH or any other platform tool:

1. Call `list_remote_instances` to see all of the user's instances. If candidates match the task: exactly one match → confirm it with the user; multiple matches → you MUST ask the user which one to use, never guess. If the chosen instance has `boundToThisProject: false`, ask the user whether to bind it to this project; on a yes, call `bind_remote_instance` (that is the configuration step — you do it for the user, but only with their explicit approval).
2. If no instance matches, you MUST call `list_remote_project_templates` next — do not skip this step. If a template matches, you MUST show the user the template (name / description / repoUrl) and get explicit approval before calling `create_remote_instance` — creating from the wrong template is expensive to undo. After creation, ask about binding as above.
3. Only after BOTH `list_remote_instances` and `list_remote_project_templates` come back without a match may you conclude there is no remote target: tell the user exactly that and stop — never pretend to reach a nonexistent target, and never substitute a local P4 directory or an SSH host for a remote one.

**Step 3 — Remote execution.** Create a remote Orca worker on the bound instance. If collaboration is not started yet, call `start_team` directly first — no user confirmation flow exists or is needed; an `ALREADY_ENABLED` error means the team already exists, treat it as success. Then call `create_worker` with `remote_host_id="mcpr:<instanceId>"` (the exact `remoteHostId` value returned by `list_project_remote_instances`; do NOT pass `working_dir` — the remote workspace is resolved host-side from the instance binding). The worker runs on the remote host with the project workspace as its working directory. **Verify the result: `execution_target.type` must be `"remote"` with the requested `remote_host_id`. If it shows `"local"`, the parameter did not take effect — recreate the worker with the correct `remote_host_id`, and never tell the user the worker is on the remote instance while `execution_target` says local.** Dispatch tasks with `send_to_worker`, and treat its reports as evidence to review, not automatic approval.

**Reporting.** When the task asks for raw data (a listing, a log excerpt, command output), relay the worker's raw output verbatim — do not summarize, reformat, or truncate it. Only analyze, filter, or reformat when the task itself calls for judgement or the raw output is too large to relay; say what you omitted when you do.

**Failure branches.** If the needed instance is `missing` or `unavailable`, report exactly which instance and its availability, and ask the user to check the instance connection and project binding — never pretend to reach it. If the Orca tools themselves are unavailable (the collaboration-mode plugin is disabled), ask the user to enable collaboration mode.

For diagnosis, capture service state, logs, versions, and the failing command before changing anything. For file edits, commands, builds, and tests, use the narrowest approved working directory and report exact evidence. Deployment, restart, stop, rollback, deletion, migration, production writes, and broad mutation require the Host high-risk confirmation path. Plan recovery before a risky operation, verify health afterward, and stop with preserved evidence when recovery cannot be proven.
