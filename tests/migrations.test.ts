import assert from "node:assert/strict";
import test from "node:test";

import { addGoal, addTodo, applySchedulePlan, createProjectState, createWorkflowBinding, migrateProjectState, planSchedule, reconcileProject, retryTodo } from "../src/index.js";

test("schema v1 state migrates deterministically through session-owned v3", () => {
  const modern = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  const legacy = {
    ...modern,
    schemaVersion: 1,
    scheduler: { paused: false, grill: {} },
  } as unknown as Record<string, unknown>;
  delete legacy.evidence;
  delete legacy.appliedProposalIds;
  delete legacy.migrations;

  const migrated = migrateProjectState(legacy, "2026-07-30T00:00:01.000Z");
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.scheduler.maxConcurrentMain, 1);
  assert.ok(migrated.migrations["schema-v1-to-v2"]);
  assert.ok(migrated.migrations["schema-v2-to-v3"]);
  assert.deepEqual(migrated.scheduler.sessionPaused, {});
});


test("v2 active work is quarantined instead of claimed by the first upgraded window", () => {
  const now = "2026-07-30T00:00:00.000Z";
  let modern = createProjectState("/repo", now);
  modern = addGoal(modern, { id: "legacy", title: "Legacy", objective: "Legacy", successCriteria: [] }, now);
  modern = addTodo(modern, { id: "legacy-work", goalId: "legacy", title: "Legacy work", execution: "main" }, now);
  modern = reconcileProject(modern, now);
  modern = applySchedulePlan(modern, planSchedule(modern, now), now);
  const v2 = structuredClone(modern) as unknown as Record<string, any>;
  v2.schemaVersion = 2;
  delete v2.scheduler.sessionPaused;
  delete v2.goals.legacy.ownerSessionId;
  for (const lease of Object.values(v2.scheduler.activeLeases) as Array<Record<string, any>>) {
    delete lease.ownerSessionId;
    delete lease.ownerRuntimeId;
  }
  for (const record of Object.values(v2.scheduler.continuationKeys) as Array<Record<string, any>>) {
    delete record.ownerSessionId;
    delete record.ownerRuntimeId;
  }

  const migrated = migrateProjectState(v2, now);
  assert.equal(migrated.goals.legacy!.ownerSessionId, "legacy-unowned");
  assert.equal(Object.keys(migrated.scheduler.activeLeases).length, 0);
  assert.equal(Object.values(migrated.scheduler.continuationKeys)[0]?.status, "expired");
  assert.equal(migrated.todos["legacy-work"]!.status, "blocked");
  assert.deepEqual(planSchedule(migrated, now, { sessionId: "new-window", runtimeId: "runtime" }).starts, []);
});


test("a quarantined v2 Workflow can be adopted and retried from its parent", () => {
  const now = "2026-07-30T00:00:00.000Z";
  let state = createProjectState("/repo", now);
  state = addGoal(state, { id: "legacy", title: "Legacy", objective: "Legacy", successCriteria: [] }, now);
  state = addTodo(state, {
    id: "work", goalId: "legacy", title: "Work", execution: "workflow",
    workflowPlan: { name: "fresh", description: "fresh", phases: [{ title: "Inspect", role: "work", prompts: ["inspect"] }] },
  }, now);
  state = createWorkflowBinding(state, {
    bindingId: "old", upstreamRunId: "old-run", todoId: "work", status: "running",
    phases: [{ title: "Inspect", role: "work" }],
  }, now);
  const v2 = structuredClone(state) as unknown as Record<string, any>;
  v2.schemaVersion = 2;
  delete v2.goals.legacy.ownerSessionId;
  delete v2.workflowRuns.old.ownerSessionId;
  delete v2.workflowRuns.old.ownerRuntimeId;

  let migrated = migrateProjectState(v2, now);
  assert.equal(migrated.workflowRuns.old!.status, "stopped");
  assert.equal(migrated.todos.work!.status, "blocked");
  assert.equal(migrated.todos.work!.workflowRunId, undefined);
  assert.deepEqual(migrated.todos.work!.childIds, []);
  migrated.goals.legacy!.ownerSessionId = "session";
  migrated.workflowRuns.old!.ownerSessionId = "session";
  migrated = reconcileProject(retryTodo(migrated, "work", "fresh Workflow", now), now);
  assert.equal(migrated.todos.work!.status, "ready");
  assert.equal(migrated.todos.work!.workflowPlan?.name, "fresh");
});
