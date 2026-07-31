# Release audit

This audit maps the Phase 2–5 request to repository artifacts and observed checks. A passing test alone is not counted as the artifact.

## Phase 2: TUI and recovery

| Requirement | Artifact | Evidence |
| --- | --- | --- |
| Interactive tree and arrows | `src/ui/tree-model.ts`, `tree-controller.ts`, `panel.ts`, `widget.ts` | Tree/controller tests and isolated real Pi TUI smoke (`/devflow`, help rendered, no crash) |
| Shortcut and lifecycle | `src/extension.ts` | Registration test confirms `Ctrl+Shift+D`, start/tree/compact/shutdown hooks |
| Journal-first atomic state | `src/store/journal.ts`, `project-store.ts` | Recovery test restores a corrupt snapshot from journal |
| Cross-process lock | `src/store/project-lock.ts` | Concurrent-store test and ownerless stale-lock recovery test |
| Blocker detail and Grill continuation | `src/ui/tree-model.ts`, `src/grill.ts`, `src/extension.ts` | Expanded blocker and one-question deduplication tests |
| Interrupted execution recovery | `recoverInterruptedExecutions` in `src/domain/scheduler.ts` | Lease recovery test; session start/shutdown integration |

## Phase 3: Workflow adaptation

| Requirement | Artifact | Evidence |
| --- | --- | --- |
| One manager and adapter | `src/workflow/adapter.ts`, `src/extension.ts` | Adapter integration test starts and projects one run |
| Phase-to-Todo projection | `src/workflow/projection.ts` | Projection tests verify ordered child Todos |
| Agents only in phase detail | `src/ui/tree-model.ts` | Expanded phase rows contain agents; no Agent Todo is created |
| Actual model and fallback visibility | `workflowPhaseModelLabel` | Tests cover provisional `?`, resolved model, mixed logic, and fallback label |
| fanout/work/judge routing | `src/workflow/model-router.ts`, `script.ts` | Deterministic routing test |

## Phase 4: central automation

| Requirement | Artifact | Evidence |
| --- | --- | --- |
| Goal normalization | `src/domain/normalization.ts`, `devflow_normalize` | False-Goal merge, ask-without-mutation, and executable-root tests |
| Main/Workflow selection | `selectExecutionMode` | Safe parallel and shared-write tests |
| Multi-Goal scheduling | `src/domain/scheduler.ts` | Fair progress and conflicting-resource serialization test |
| Idempotent continuation | durable `scheduler.continuationKeys`; `dispatchReady` | Replay test proves one reservation; RPC smoke confirms extension command path |
| Automatic start without permission bypass | system-managed root Todo and follow-up dispatcher | Continuation text preserves Pi permission and dangerous-operation confirmation |
| Completion audit | `src/domain/audit.ts`, typed evidence registry | Invalid evidence, valid evidence, and stale-revision tests |
| Tool evidence references | `tool_execution_end` hook | Stores only tool identity, result status, and locator; never full output |

## Phase 5: migration and distribution

| Requirement | Artifact | Evidence |
| --- | --- | --- |
| Legacy import | `src/import/legacy.ts` | Combined Goal/Todo, idempotency, deleted-item warning, and paused-Goal recovery tests |
| GitHub install docs | `README.md` | Commands target `Lcryolite/pi-devflow` |
| Platform smoke | `scripts/platform-smoke.mjs`, `.github/workflows/ci.yml` | Linux, macOS, and Windows passed in GitHub Actions run [`30583167124`](https://github.com/Lcryolite/pi-devflow/actions/runs/30583167124) |
| Compatibility matrix | `docs/COMPATIBILITY.md` | Records Node, Pi, Workflow package, and operating-system coverage |
| npm publication | not published | Optional; GitHub is the supported channel |

## Observed local checks

- `npm run verify`: TypeScript clean; 44 tests passed.
- `npm run smoke:platform`: passed on Linux x64, Node v24.14.0.
- Skill validator: `Skill is valid!`.
- `npm pack --dry-run --json`: `pi-devflow@0.1.3`, 36 packaged files, 50,731 bytes.
- Local `pi install .`: installed and listed by Pi.
- Pi RPC smoke on Pi 0.82.1: `/devflow` registered and `/devflow doctor` returned valid revision 0.
- Isolated Pi TUI smoke on Pi 0.82.1: `/devflow` opened the panel, rendered navigation/expand help, and exited without a crash.
- Two independent code audits found five lifecycle/idempotency blockers; all were fixed and the focused re-audit cleared them.
- The first remote Windows smoke exposed a `.cmd` launcher bug; `v0.1.1` switched to `npm_execpath`, and clean branch/tag matrix runs then passed on Linux, macOS, and Windows.
- `v0.1.2` adds persistent Goal/Todo tree rendering to the Todo widget; focused widget tests verify active and completed Goals, hierarchy, arrows, status symbols, and absence of an interactive cursor.
- `v0.1.3` adds `/devflow-models`, routes medium to work, pins every generated Workflow phase to its resolved model, shares panel/Widget expansion state, and auto-collapses completed Goals.

## Distribution gates

- Repository: [`github.com/Lcryolite/pi-devflow`](https://github.com/Lcryolite/pi-devflow).
- Supported release tag: `v0.1.3` (resolve the immutable commit with `git rev-list -n 1 v0.1.3`).
- GitHub installation command: `pi install git:github.com/Lcryolite/pi-devflow@v0.1.3`; validate registration with `/devflow doctor` after reload.
- npm publication remains intentionally deferred; it was optional and GitHub is the supported distribution channel.
