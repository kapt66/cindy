---
description: Meka Orca worker coordination procedure
purpose: Coordinate explicitly requested workers, delegation, and parallel work
---
# Meka Orca coordination

Create a worker only for a concrete, bounded slice that can proceed independently. For every local worker, explicitly choose one Host-approved working directory; the worker inherits the Lead's project and role configuration. Give the worker its deliverable, constraints, evidence requirements, and integration boundary.

When the slice belongs to a bound remote project — remote server code, logs, builds, or service state — use a worker on that remote instance (`remote_host_id="mcpr:<instanceId>"`, and do NOT pass `working_dir`; the remote workspace is resolved host-side) instead of a local directory. If no matching Worker exists, identify the target instance and ask the user whether to create the persistent, UI-visible remote Worker; assigning the underlying remote task is not by itself creation approval. After approval, call `start_team` directly if the team is not started yet — team startup needs no separate confirmation, and an `ALREADY_ENABLED` error means collaboration is already active — then create the Worker and dispatch its concrete task. Its working directory is the remote project workspace, and the same inheritance and review rules apply.

Keep shared decisions with the Lead. Review worker output against the original target, repository instructions, changed files, and executed tests before integrating it. A worker report is evidence, not automatic approval. Never use delegation to expand routes, credentials, write roots, or configured project/role resources.
