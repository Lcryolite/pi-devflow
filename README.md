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
pi install git:github.com/Lcryolite/pi-devflow@v0.1.2
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

- The persistent Todo widget renders the Goal/Todo tree and updates it as work progresses.
- `/devflow` enters the interactive tree in TUI mode.
- `/devflow status` prints current Goals and runnable work.
- `/devflow pause` and `/devflow resume` control scheduling.
- `/devflow models` shows the three-role model policy.
- `/devflow doctor` validates state and reports conflicts.
- `Ctrl+Shift+D` enters the interactive Todo tree.

The model-facing tools are `devflow_normalize`, `devflow_goal`, `devflow_todo`, and `devflow_workflow`.

Automatic continuation does not bypass Pi permissions or dangerous-operation confirmations.

## Legacy migration

At session start, `pi-devflow` checks the active branch for the latest `pi-codex-goal` custom entry and `rpiv-todo` tool snapshot. Import is atomic and keyed to the Pi session, so later changes in the same legacy session cannot create duplicates. Existing IDs are preserved when possible; collisions get deterministic import suffixes. Deleted legacy Todos are skipped and recorded as warnings.

Read [`docs/MIGRATION.md`](docs/MIGRATION.md) before disabling the old extensions. `/devflow doctor` warns when legacy tools are still active but never changes Pi configuration.

## Runtime state

Project state is stored outside the repository:

```text
~/.pi/agent/devflow/projects/<project-id>/
├── state.json
├── events.jsonl
└── lock
```

Writes use a cross-process lock, journal-first persistence, and atomic snapshots. Corrupt snapshots recover from the latest valid journal event. State must not contain credentials or full sensitive tool output.

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
