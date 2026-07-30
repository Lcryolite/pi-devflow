import assert from "node:assert/strict";
import test from "node:test";

import {
  addGoal,
  addTodo,
  applySchedulePlan,
  blockTodo,
  createProjectState,
  planSchedule,
  markContinuation,
  reconcileProject,
  recoverInterruptedExecutions,
  retryTodo,
  selectExecutionMode,
} from "../src/index.js";

const now = "2026-07-30T00:00:00.000Z";

test("execution mode selects workflow only for safe parallel work", () => {
  assert.equal(selectExecutionMode({ independentUnits: 3, hasSequentialDependency: false, writeScope: "known-disjoint", mergeableResults: true, estimatedUnits: 3 }), "workflow");
  assert.equal(selectExecutionMode({ independentUnits: 3, hasSequentialDependency: false, writeScope: "shared", mergeableResults: true, estimatedUnits: 3 }), "main");
});

test("scheduler preserves independent progress while respecting resource conflicts", () => {
  let state = createProjectState("/repo", now);
  state.scheduler.maxConcurrentMain = 3;
  for (const id of ["a", "b", "c"]) {
    state = addGoal(state, { id, title: id, objective: id, successCriteria: [] }, now);
  }
  state = addTodo(state, { id: "a1", goalId: "a", title: "A", execution: "main", resourceClaims: [{ key: "repo:file", mode: "write" }] }, now);
  state = addTodo(state, { id: "b1", goalId: "b", title: "B", execution: "main", resourceClaims: [{ key: "repo:file", mode: "read" }] }, now);
  state = addTodo(state, { id: "c1", goalId: "c", title: "C", execution: "main", resourceClaims: [{ key: "repo:other", mode: "write" }] }, now);
  state = reconcileProject(state, now);

  const plan = planSchedule(state, now);
  assert.deepEqual(plan.starts.map((start) => start.todoId), ["a1", "c1"]);
  state = applySchedulePlan(state, plan, now);
  assert.equal(state.todos.a1?.status, "in_progress");
  assert.equal(state.todos.b1?.status, "ready");
});

test("continuation reservations are idempotent", () => {
  let state = createProjectState("/repo", now);
  state = addGoal(state, { id: "a", title: "a", objective: "a", successCriteria: [] }, now);
  state = addTodo(state, { id: "a1", goalId: "a", title: "A", execution: "main" }, now);
  state = reconcileProject(state, now);
  const plan = planSchedule(state, now);
  state = applySchedulePlan(state, plan, now);
  const replay = applySchedulePlan(state, { ...plan, revision: state.revision }, now);
  assert.equal(Object.keys(replay.scheduler.continuationKeys).length, 1);
});


test("interrupted main-agent leases recover as retryable blockers", () => {
  let state = createProjectState("/repo", now);
  state = addGoal(state, { id: "a", title: "a", objective: "a", successCriteria: [] }, now);
  state = addTodo(state, { id: "a1", goalId: "a", title: "A", execution: "main" }, now);
  state = reconcileProject(state, now);
  state = applySchedulePlan(state, planSchedule(state, now), now);
  state = recoverInterruptedExecutions(state, "2026-07-30T00:01:00.000Z");
  assert.equal(state.todos.a1?.status, "blocked");
  assert.equal(Object.keys(state.scheduler.activeLeases).length, 0);
  assert.equal(Object.values(state.scheduler.continuationKeys)[0]?.status, "expired");
});


test("retry after a claimed continuation gets a fresh scheduling key", () => {
  let state = createProjectState("/repo", now);
  state = addGoal(state, { id: "a", title: "a", objective: "a", successCriteria: [] }, now);
  state = addTodo(state, { id: "a1", goalId: "a", title: "A", execution: "main" }, now);
  state = reconcileProject(state, now);
  const firstPlan = planSchedule(state, now);
  state = applySchedulePlan(state, firstPlan, now);
  state = markContinuation(state, firstPlan.starts[0]!.continuationKey, "claimed");
  state = blockTodo(state, "a1", { kind: "decision", reason: "Choose", sourceIds: [] }, now);
  state = reconcileProject(state, now);
  state = retryTodo(state, "a1", "new strategy", now);
  state = reconcileProject(state, now);
  assert.equal(planSchedule(state, now).starts.length, 1);
});
