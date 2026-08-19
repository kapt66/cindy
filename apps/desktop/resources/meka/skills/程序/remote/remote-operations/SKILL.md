---
name: remote-operations
description: 通过 MCPRouter 安全访问已授权的远程项目仓库，并区分仓库内容操作与项目服务管理。
metadata:
  display-name: MCPR 远程项目操作
  purpose: 发现、读取和修改已授权的远程项目仓库
---
# Remote project operations

Remote projects are MCPRouter project-agent instances bound to the current Meka project; they are not local directories. Read the remote repository's own `AGENTS.md` and relevant Agent Skills before acting; built-in guidance does not replace project knowledge.

**Routing priority — choose the narrowest existing capability:**

- An existing MCPR remote task/session (`remoteHostId="mcpr:<instanceId>"`) is the first choice
  when the user is asking the remote Agent to work in its already selected project context. Continue
  that remote session; do not replace it with a generic Router MCP call or create an Orca worker just
  to imitate a remote session.
- A remote Orca Worker is the first choice for remote repository content: list directories, read
  files, inspect repository guidance, or write requested files. It is not a general remote shell.
- The dedicated MCPRouter `project-agent` tools are the first choice for project/service management.
- Only use generic `mcp_router` tools as a control-plane fallback for discovering/provisioning a
  remote instance or when no narrower, configured capability matches the request. Do not call a
  generic tool merely because it can expose a broad underlying operation when a remote session,
  Orca Worker, `project-agent`, or another dedicated provider already owns the task.

**What runs where (deterministic facts — do not re-probe them):**

- The configured `project-agent` / MCPRouter project-management tools own remote project lifecycle and delivery operations. Use them for server start/stop/restart, health/status, deploy/release, update/sync, push, branch switching, merge, rollback, and other repository or service management actions. These actions must not be implemented by an Orca worker.
- Router project-management tools do NOT replace remote repository content access: use the remote Orca worker for repository file reads, directory listings, and file writes only. Do not use a worker to run server commands, inspect processes, run builds/tests, deploy, restart/stop services, update/sync branches, push, merge, or perform other management.
- A remote instance (`mcpr:<id>`) is NOT an SSH host. Never try SSH tools (`ssh_list_hosts`, `ssh_exec`, …) to reach it; they cannot.
- The reverse also holds: an SSH host is NOT the project's server. `服务器` / `server` in a game-project context means the server codebase (a remote project instance), not a machine you can ssh into. If the provisioning chain (Step 2) finds no instance and no template, the correct outcome is "the remote server is not configured yet" — never fall back to `ssh_list_hosts` / `ssh_exec` to go find "the server", and never offer SSH hosts as candidate interpretations of `服务器`.
- Resolve requests by capability, not by the breadth of a provider: (1) the current MCPR remote
  session when it is already the requested execution context; (2) remote Orca Worker for repository
  content; (3) dedicated `project-agent` for project/service management; (4) MekaDesign for design
  intent and handoff; (5) generic `mcp_router` only for instance discovery/provisioning or when no
  specialized capability exists. Do not route a request to a later or broader tier when an earlier
  specialized tier matches.
- The instance's physical path on the remote host is deliberately not exposed — it is meaningless locally, and the remote workspace is resolved host-side from the instance binding. Never ask for it, never guess it, and never substitute any local path for it.
- Therefore: a task that reads or edits remote repository content goes to a remote Orca worker (Step 3), even if the task is small. A task that manages the project or service goes to the configured `project-agent` tools (Step 4), without creating or using a worker. Workers are cheap to reuse for content work — keep the worker alive for iterative read/write queries instead of recreating it per question.

**Step 1 — Discover bound instances.** This is the one normal discovery use of the generic
`mcp_router` provider: call `list_project_remote_instances`. It returns this project's bound
instances with `projectName` / `projectDescription` (use them to identify which instance carries
what, for example the server code), `availability`, and `remoteHostId`. If an `available` instance
matches the task, route to the narrowest capability above: continue the MCPR remote session,
create/reuse a remote Orca Worker for repository content, or call the dedicated `project-agent`
management tool.

**Step 2 — No bound match: the provisioning chain.** Only when Step 1 yields no matching instance,
and only while MCPRouter is connected, use the generic Router tools to inspect user instances and
templates and obtain explicit binding/creation approval. Follow these substeps IN ORDER and do not
abandon the chain between them — an empty result moves you to the next substep, it does not end the
chain and it is never a reason to switch to SSH or any other platform tool:

1. Call `list_remote_instances` to see all of the user's instances. If candidates match the task: exactly one match → confirm it with the user; multiple matches → you MUST ask the user which one to use, never guess. If the chosen instance has `boundToThisProject: false`, ask the user whether to bind it to this project; on a yes, call `bind_remote_instance` (that is the configuration step — you do it for the user, but only with their explicit approval).
2. If no instance matches, you MUST call `list_remote_project_templates` next — do not skip this step. If a template matches, you MUST show the user the template (name / description / repoUrl) and get explicit approval before calling `create_remote_instance` — creating from the wrong template is expensive to undo. After creation, ask about binding as above.
3. Only after BOTH `list_remote_instances` and `list_remote_project_templates` come back without a match may you conclude there is no remote target: tell the user exactly that and stop — never pretend to reach a nonexistent target, and never substitute a local P4 directory or an SSH host for a remote one.

**Step 3 — Remote repository content.** Accessing or editing remote repository files requires a persistent, UI-visible Orca worker on the matched instance. Tell the user which instance will be used and ask whether to create that remote worker; the underlying read/edit request alone is not authorization to create one. If the user already explicitly approved creating that worker in the current task, do not ask twice. Once `ask_user_question` returns an answer, the question is resolved: treat a positive answer as the worker-creation approval, continue the pending workflow, and do not emit another prose confirmation or repeat the same question. On approval, call `start_team` directly if collaboration is not started yet — team startup itself needs no separate confirmation, and an `ALREADY_ENABLED` error means the team already exists. Then call `create_worker` with `remote_host_id="mcpr:<instanceId>"` (the exact `remoteHostId` value returned by `list_project_remote_instances`; do NOT pass `working_dir` — the remote workspace is resolved host-side from the instance binding). When the concrete repository read/write task is already known, include it as `initial_task` so worker creation and dispatch are one operation. The worker runs on the remote host with the project workspace as its working directory. **Verify the result: `execution_target.type` must be `"remote"` with the requested `remote_host_id`. If it shows `"local"`, the parameter did not take effect — recreate the worker with the correct `remote_host_id`, and never tell the user the worker is on the remote instance while `execution_target` says local.** The worker may read/list repository files and write requested repository content only. It must not start/stop/restart services, inspect processes, run builds/tests, deploy, update/sync, push, switch branches, merge, rollback, or perform other management. If an existing worker is reused, dispatch only a repository content task with `send_to_worker`. Treat worker reports as evidence to review, not automatic approval. If the user declines worker creation, stop without substituting Router management tools, a local directory, an SSH host, or a native subagent.

**Step 4 — Remote project/service management.** For server start, stop, restart, health/status, deploy/release, update/sync, push, branch switching, merge, rollback, and any other project or service management request, use the already configured `project-agent` / MCPRouter project-management tool directly against the matched bound instance. Discover or select the matching project-management tool from the provider's exposed tools, pass the exact bound instance context, and let the Host high-risk confirmation path authorize high-risk actions. Do not create `start_team`, create an Orca worker, or call `send_to_worker` for these operations. If the project-management provider or matching tool is unavailable, report that clearly and stop; never substitute an Orca worker, SSH, a local directory, or a generic shell command. Verify the management tool's returned status/health evidence and report it.

**Dispatch termination rule — highest priority.** A successful `create_worker` with a concrete `initial_task` is dispatched when its result contains `dispatched=true`, `queued_message_id`, or the documented successful `dispatch_outcome`; a successful `send_to_worker` is dispatched when its result has `ok=true` and `wake_kind=resumed`, `already-active`, or `queued`. As soon as any remote task has one of those concrete dispatch signals, the current Lead task MUST end immediately: emit no prose, do not ask another confirmation, do not call another tool, and do not wait, sleep, poll, or keep the turn alive. The worker result will arrive later as a new Lead message through `send_to_lead` or auto-bridge. A worker creation without a dispatch signal, or a failed dispatch, is not complete; report that failure and stop. This rule applies equally to resumed, already-active, and queued remote workers.

**Reporting.** When the task asks for raw data (a listing, a log excerpt, command output), relay the worker's raw output verbatim — do not summarize, reformat, or truncate it. Only analyze, filter, or reformat when the task itself calls for judgement or the raw output is too large to relay; say what you omitted when you do.

**Failure branches.** If the needed instance is `missing` or `unavailable`, report exactly which instance and its availability, and ask the user to check the instance connection and project binding — never pretend to reach it. If the Orca tools themselves are unavailable (the collaboration-mode plugin is disabled), ask the user to enable collaboration mode.

For diagnosis, capture service state, logs, versions, and the failing command before changing anything. For file edits, commands, builds, and tests, use the narrowest approved working directory and report exact evidence. Deployment, restart, stop, rollback, deletion, migration, production writes, and broad mutation require the Host high-risk confirmation path. Plan recovery before a risky operation, verify health afterward, and stop with preserved evidence when recovery cannot be proven.
