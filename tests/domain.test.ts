import assert from "node:assert/strict";
import test from "node:test";

import {
  addCriterionEvidence,
  addEvidence,
  addGoal,
  addTodo,
  completeGoal,
  createProjectState,
  reconcileProject,
  setTodoStatus,
  validateProject,
} from "../src/index.js";

test("a blocked todo does not stop independent siblings", () => {
  let state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  state = addGoal(state, {
    id: "goal-1",
    title: "Ship feature",
    objective: "Finish eight independent tasks",
    successCriteria: [],
  }, "2026-07-30T00:00:01.000Z");

  for (let index = 1; index <= 8; index += 1) {
    state = addTodo(state, {
      id: `todo-${index}`,
      goalId: "goal-1",
      title: `Task ${index}`,
    }, `2026-07-30T00:00:${index + 1}.000Z`);
  }

  state = setTodoStatus(state, "todo-1", "blocked", "Missing external input", "2026-07-30T00:01:00.000Z");
  state = reconcileProject(state, "2026-07-30T00:01:01.000Z");

  assert.equal(state.todos["todo-1"]?.status, "blocked");
  assert.deepEqual(
    Object.values(state.todos).filter((todo) => todo.status === "ready").map((todo) => todo.id).sort(),
    ["todo-2", "todo-3", "todo-4", "todo-5", "todo-6", "todo-7", "todo-8"],
  );
  assert.equal(state.goals["goal-1"]?.status, "active");
});


test("a parent todo completes when all required children complete", () => {
  let state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  state = addGoal(state, {
    id: "goal-1",
    title: "Parent aggregation",
    objective: "Complete required child work",
    successCriteria: [],
  }, "2026-07-30T00:00:01.000Z");
  state = addTodo(state, { id: "parent", goalId: "goal-1", title: "Parent" }, "2026-07-30T00:00:02.000Z");
  state = addTodo(state, { id: "child-a", goalId: "goal-1", parentId: "parent", title: "A" }, "2026-07-30T00:00:03.000Z");
  state = addTodo(state, { id: "child-b", goalId: "goal-1", parentId: "parent", title: "B" }, "2026-07-30T00:00:04.000Z");
  state = setTodoStatus(state, "child-a", "completed", undefined, "2026-07-30T00:00:05.000Z");
  state = setTodoStatus(state, "child-b", "completed", undefined, "2026-07-30T00:00:06.000Z");

  state = reconcileProject(state, "2026-07-30T00:00:07.000Z");

  assert.equal(state.todos.parent?.status, "completed");
});


test("todo dependency cycles are rejected", () => {
  let state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  state = addGoal(state, {
    id: "goal-1",
    title: "Reject cycles",
    objective: "Keep scheduling deterministic",
    successCriteria: [],
  }, "2026-07-30T00:00:01.000Z");
  state = addTodo(state, { id: "a", goalId: "goal-1", title: "A", dependsOn: ["b"] }, "2026-07-30T00:00:02.000Z");
  state = addTodo(state, { id: "b", goalId: "goal-1", title: "B", dependsOn: ["a"] }, "2026-07-30T00:00:03.000Z");

  assert.throws(() => validateProject(state), /Todo dependency cycle/);
});


test("a goal cannot complete without evidence for every required criterion", () => {
  let state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  state = addGoal(state, {
    id: "goal-1",
    title: "Evidence gate",
    objective: "Prove completion",
    successCriteria: [{ id: "criterion-1", text: "Tests pass", required: true, evidenceIds: [] }],
  }, "2026-07-30T00:00:01.000Z");

  assert.throws(() => completeGoal(state, "goal-1", "2026-07-30T00:00:02.000Z"), /missing evidence/);
  assert.throws(() => addCriterionEvidence(state, "goal-1", "criterion-1", "unknown", "2026-07-30T00:00:02.000Z"), /does not exist/);
  state = addEvidence(state, {
    id: "test:npm-test", kind: "test", summary: "npm test", observedAt: "2026-07-30T00:00:03.000Z", valid: true,
  });

  state = addCriterionEvidence(state, "goal-1", "criterion-1", "test:npm-test", "2026-07-30T00:00:03.000Z");
  state = completeGoal(state, "goal-1", "2026-07-30T00:00:04.000Z");

  assert.equal(state.goals["goal-1"]?.status, "completed");
});


test("a goal becomes blocked only when no required todo can run", () => {
  let state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  state = addGoal(state, {
    id: "goal-1",
    title: "Blocked goal",
    objective: "Wait for input",
    successCriteria: [],
  }, "2026-07-30T00:00:01.000Z");
  state = addTodo(state, { id: "only", goalId: "goal-1", title: "Only task" }, "2026-07-30T00:00:02.000Z");
  state = setTodoStatus(state, "only", "blocked", "Need user decision", "2026-07-30T00:00:03.000Z");

  state = reconcileProject(state, "2026-07-30T00:00:04.000Z");

  assert.equal(state.goals["goal-1"]?.status, "blocked");
});


test("record-map identifiers reject prototype keys", () => {
  const state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  assert.throws(() => addGoal(state, {
    id: "__proto__", title: "unsafe", objective: "unsafe", successCriteria: [],
  }, "2026-07-30T00:00:01.000Z"), /safe identifier/);
});
