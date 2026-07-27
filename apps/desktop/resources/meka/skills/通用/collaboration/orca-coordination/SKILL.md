---
description: Meka Orca worker coordination procedure
purpose: Coordinate explicitly requested workers, delegation, and parallel work
---
# Meka Orca coordination

Create a worker only for a concrete, bounded slice that can proceed independently. For every local worker, explicitly choose one Host-approved working directory; the worker inherits the Lead's project and role configuration. Give the worker its deliverable, constraints, evidence requirements, and integration boundary.

When the slice belongs to a bound remote project — remote server code, logs, builds, or service state — create the worker on that remote instance (`remote_host_id="mcpr:<instanceId>"`, and do NOT pass `working_dir`; the remote workspace is resolved host-side) instead of a local directory. Its working directory is the remote project workspace, and the same inheritance and review rules apply. If the team is not started yet, call `start_team` directly first — no confirmation flow; an `ALREADY_ENABLED` error means collaboration is already active, treat it as success.

Keep shared decisions with the Lead. Review worker output against the original target, repository instructions, changed files, and executed tests before integrating it. A worker report is evidence, not automatic approval. Never use delegation to expand routes, credentials, write roots, or configured project/role resources.
