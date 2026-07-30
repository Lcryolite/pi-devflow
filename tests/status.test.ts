import assert from "node:assert/strict";
import test from "node:test";

import { addGoal, addTodo, createProjectState, formatStatus, reconcileProject } from "../src/index.js";

test("status summarizes goals and runnable work", () => {
  let state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  state = addGoal(state, {
    id: "goal-1",
    title: "Status output",
    objective: "Show current work",
    successCriteria: [],
  }, "2026-07-30T00:00:01.000Z");
  state = addTodo(state, { id: "todo-1", goalId: "goal-1", title: "Runnable" }, "2026-07-30T00:00:02.000Z");
  state = reconcileProject(state, "2026-07-30T00:00:03.000Z");

  const output = formatStatus(state);

  assert.match(output, /Devflow .* 1 goal/);
  assert.match(output, /1 ready/);
  assert.match(output, /#todo-1 Runnable/);
});
