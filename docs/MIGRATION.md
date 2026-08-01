# Legacy migration

`pi-devflow` imports state from the active Pi session branch. It recognizes `pi-codex-goal` custom entries and the latest successful `rpiv-todo` tool result.

## v0.1.x → v0.2.0 session-isolation upgrade

Before loading v0.2.0, close or reload **every** Pi window running Devflow. This is mandatory: schema v3 intentionally makes old runtimes fail closed, but it cannot retroactively stop agents an old process already launched.

On first schema-v3 load:

- existing Goals become `legacy-unowned` and are hidden from normal session Widget/status/context;
- reserved/sent continuations expire;
- active leases are removed;
- main executions become retryable blockers;
- running/planned Workflows are quarantined and no longer auto-resume.

Use `/devflow project` to inspect quarantined work. After confirming old windows are stopped, run `/devflow adopt <goal-id>`; Devflow adopts its connected dependency/evidence closure atomically. Then retry blocked work intentionally. `/devflow recover` abandons stale execution records owned by the current session/runtime lineage without touching another session.

## Safe migration procedure

1. Install `pi-devflow` while the old extensions are still available.
2. Open the project and resume the Pi session that contains the old Goal or Todo state.
3. Restart Pi or switch into that session. `pi-devflow` runs the importer during `session_start`.
4. Run `/devflow status` and inspect the tree with `/devflow`.
5. Run `/devflow doctor`.
6. Disable the old extensions only after the imported Goal and Todos look correct.

The importer never removes old entries or changes Pi configuration.

## Mapping

| Legacy source | Devflow result |
| --- | --- |
| `pi-codex-goal` objective | Goal title and objective |
| active legacy Goal | active Goal |
| completed legacy Goal | completed Goal |
| paused or budget-limited Goal | blocked resume-decision Todo plus a migration warning |
| `rpiv-todo` pending task | Todo, reconciled to Pending or Ready |
| in-progress task | blocked Todo that requires an explicit retry |
| completed task | completed Todo |
| `blockedBy` IDs | Todo dependencies |
| deleted task | skipped with a warning |

When only Todo state exists, the importer creates an `Imported legacy todos` Goal. If both sources exist, imported Todos attach to the imported legacy Goal.

## Idempotency and conflicts

The importer keys its migration record by Pi session ID, so later timestamp or task changes in the same legacy session cannot create duplicate Goals or Todos. The first import is the migration boundary; changes made in the old extensions afterward are intentionally ignored. Legacy IDs are preserved when free. A collision uses a deterministic `:import:<hash>` suffix; a second collision fails the atomic transaction rather than overwriting data.

Migration warnings and source IDs are stored in `state.migrations`. The importer copies only Goal and Todo fields needed by Devflow. It does not copy chat text, credentials, or full tool output.

## Rollback

Import is one journaled transaction. A validation error leaves the prior Devflow snapshot unchanged. To remove a successful import, use Devflow tools to cancel or delete the imported work; do not edit `state.json` directly. Keep the journal if recovery may be needed.
