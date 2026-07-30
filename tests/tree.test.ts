import assert from "node:assert/strict";
import test from "node:test";

import {
  addGoal,
  addTodo,
  createProjectState,
  projectTreeRows,
  setTodoStatus,
  TreeController,
} from "../src/index.js";

function treeState() {
  let state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  state = addGoal(state, {
    id: "goal-1", title: "Goal", objective: "Tree", successCriteria: [],
  }, "2026-07-30T00:00:01.000Z");
  state = addTodo(state, { id: "parent", goalId: "goal-1", title: "Parent" }, "2026-07-30T00:00:02.000Z");
  state = addTodo(state, { id: "child", goalId: "goal-1", parentId: "parent", title: "Child" }, "2026-07-30T00:00:03.000Z");
  return setTodoStatus(state, "child", "blocked", "Need a target", "2026-07-30T00:00:04.000Z");
}

test("tree projection numbers children and reveals blocker details only when expanded", () => {
  const state = treeState();
  const collapsed = projectTreeRows(state, new Set(["goal:goal-1"]));
  assert.deepEqual(collapsed.map((row) => row.number), ["#1", "#1.1"]);

  const expanded = projectTreeRows(state, new Set(["goal:goal-1", "todo:parent", "todo:child"]));
  assert.deepEqual(expanded.filter((row) => row.kind !== "detail").map((row) => row.number), ["#1", "#1.1", "#1.1.1"]);
  assert.equal(expanded.at(-1)?.kind, "detail");
  assert.match(expanded.at(-1)?.title ?? "", /Need a target/);
});

test("tree controller expands, collapses, and returns retry for blocked todos", () => {
  const controller = new TreeController(treeState());
  controller.expand("goal:goal-1");
  controller.expand("todo:parent");
  controller.selectKey("todo:child");

  assert.deepEqual(controller.activate(), { type: "expand", key: "todo:child" });
  assert.deepEqual(controller.retrySelected(), { type: "retry", todoId: "child" });
  controller.left();
  assert.equal(controller.selectedRow()?.key, "todo:child");
  controller.left();
  assert.equal(controller.selectedRow()?.key, "todo:parent");
});
