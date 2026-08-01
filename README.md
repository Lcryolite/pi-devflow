# pi-devflow

`pi-devflow` is a project-scoped control layer for substantial development work in Pi. It combines on-demand clarification, durable Goal contracts, a hierarchical Todo tree, resource-aware scheduling, and dynamic Workflows.

## What it does

- Asks one Grill question only when an ambiguity changes execution.
- Normalizes requests into a new Goal or a Todo on an existing Goal.
- Keeps Goal, Todo, blocker, evidence, and Workflow state in one journaled store.
- Continues independent Ready work when another branch is blocked.
- Chooses main-agent or Workflow execution from a conservative execution profile.
- Projects Workflow phases into child Todos while keeping agents in phase details.
- Audits required Todos and evidence before completing a Goal.
- Imports compatible `pi-codex-goal` and `rpiv-todo` state from the current session branch.

The product and technical specification is in [`docs/SPEC.md`](docs/SPEC.md).

## Requirements

- Node.js 24 or newer
- Pi with package support
- Git for GitHub installation

See [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) for the tested matrix.

## Install from GitHub

```bash
pi install git:github.com/Lcryolite/pi-devflow@main
```

Pin a release or commit for repeatable installs:

```bash
pi install git:github.com/Lcryolite/pi-devflow@v0.2.1
# or
pi install git:github.com/Lcryolite/pi-devflow@<commit-sha>
```

Restart Pi after installation. Run `/devflow doctor` to validate project state and report legacy tools.

For local development:

```bash
git clone https://github.com/Lcryolite/pi-devflow.git
cd pi-devflow
npm install
npm run verify
pi install .
```

## Use

- The Widget is owned by the current Pi session: work from other windows never appears or dispatches here.
- Idle uses zero lines. Main work uses one summary line; Workflow work shows a live 3-line card with phase N/M, agent progress, elapsed time, resolved model, and latest safe action.
- `Ctrl+Shift+D` toggles the current session's active execution tree and automatically reveals the current phase/agents; `/devflow` is optional management UI.
- `/devflow-models` or `/devflow models` opens the interactive central/small/medium/big model selector.
- Model routing is `small → fanout`, `medium → work`, `central → normal judge`, and `big → escalated judge`.
- `/devflow status` is session-local; `/devflow project` explicitly shows project-wide quarantined/history state.
- `/devflow pause|resume|recover` controls only the current session. `/devflow adopt <goal-id>` explicitly adopts quarantined legacy work.
- `/devflow doctor` validates state and reports migration or legacy conflicts.

The model-facing tools are `devflow_normalize`, `devflow_goal`, `devflow_todo`, and `devflow_workflow`.

Automatic continuation does not bypass Pi permissions or dangerous-operation confirmations.

## Legacy migration

**v0.2.0 is a breaking session-isolation upgrade. Close or reload every Pi window using Devflow before the first v0.2.0 session writes schema v3.** Old v0.1.x processes cannot safely coexist with schema v3 and may still have already-launched agents running.

Schema-v2 work is fail-closed: active leases are released, continuations expire, Workflows are quarantined, and Goals become `legacy-unowned`. It will not appear or auto-run in a random window. Inspect with `/devflow project`, then use `/devflow adopt <goal-id>` and retry intentionally.

At session start, `pi-devflow` checks the active branch for the latest `pi-codex-goal` custom entry and `rpiv-todo` tool snapshot. Import is atomic and keyed to the Pi session, so later changes in the same legacy session cannot create duplicates. Existing IDs are preserved when possible; collisions get deterministic import suffixes. Deleted legacy Todos are skipped and recorded as warnings.

Read [`docs/MIGRATION.md`](docs/MIGRATION.md) before disabling the old extensions. `/devflow doctor` warns when legacy tools are still active but never changes Pi configuration.

## Runtime state

Project identity is the nearest Git repository root above the Pi session cwd (or the cwd itself when no `.git` is found). Durable history and resource claims remain project-scoped, while Goal ownership, dispatch, recovery, evidence, Workflow control, Widget rendering, and model context are fenced to the originating Pi session.
Project state is stored outside the repository:

```text
~/.pi/agent/devflow/projects/<project-id>/
├── state.json
├── events.jsonl
└── lock
```

Writes use a cross-process lock, journal-first persistence, and atomic snapshots. Corrupt snapshots recover from the latest valid journal event. State must not contain credentials or full sensitive tool output.

`/devflow` shows the resolved project root in the panel header. `/devflow doctor` warns if the root is your home directory.

## Development

```bash
npm install
npm run verify
npm run smoke:platform
pi -e ./src/extension.ts
```

The platform smoke runs type checking, all tests, package-content validation, and manifest checks. GitHub Actions runs it on Linux, macOS, and Windows.

The npm package is not published yet. GitHub installation is the supported distribution path.

## License

MIT
