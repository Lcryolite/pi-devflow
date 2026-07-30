---
name: devflow
description: Manage substantial development work with project-scoped Goal contracts, hierarchical Todo trees, local blocker handling, automatic continuation, and optional Workflow delegation. Use when work needs durable completion criteria, dependent steps, recovery, or coordinated parallel execution.
---

# Devflow

Use `devflow_normalize` before creating durable state. Use `devflow_goal` for completion contracts, `devflow_todo` for execution, and `devflow_workflow` for explicit Workflow control.

## Intake

1. Decide whether the request has an independent, verifiable deliverable.
2. Create a Goal only when it has independent completion value. Otherwise merge it into an active Goal as a Todo.
3. Ask one Grill question only when a missing decision changes execution. Include a recommended answer.
4. Do not ask when a safe default is reversible and execution can proceed.

## Execution

- Keep Todo titles short and put optional detail in `description`.
- Use dependencies for real ordering and resource claims for actual conflicts.
- Supply all execution-profile fields together. Let Devflow choose Workflow only for safe, mergeable parallel units.
- Attach a Workflow plan before selecting Workflow execution.
- Continue Ready branches when an unrelated branch is blocked.
- After failure, retry with a different strategy and new evidence. Stop after two failed recovery strategies.
- Never bypass Pi permissions or dangerous-operation confirmation.

## Evidence and completion

- Record typed evidence with a short summary and locator; do not store full sensitive output.
- Attach valid evidence to every required criterion.
- Use `devflow_goal` with `action: "audit"` before completion when the result is uncertain.
- Completion runs a revision-bound audit. Do not claim completion when the audit is partial or blocked.

## Workflow projection

Workflow phases appear as child Todos. Agents are details of their phase, not sibling Todos. Treat a displayed model as provisional until upstream progress confirms it.
