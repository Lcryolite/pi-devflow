import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import {
  addGoal,
  addTodo,
  createProjectState,
  renderCompactWidget,
  syncWidgetExpandedIds,
  TreeController,
} from "../src/index.js";

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function widgetState() {
  let state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  state = addGoal(state, {
    id: "goal-1",
    title: "Persistent tree",
    objective: "Render the Todo tree in the widget",
    successCriteria: [],
  }, "2026-07-30T00:00:01.000Z");
  state = addTodo(state, {
    id: "parent",
    goalId: "goal-1",
    title: "Parent Todo",
  }, "2026-07-30T00:00:02.000Z");
  return addTodo(state, {
    id: "child",
    goalId: "goal-1",
    parentId: "parent",
    title: "Child Todo",
  }, "2026-07-30T00:00:03.000Z");
}

test("persistent widget renders the Goal/Todo tree without an interactive cursor", () => {
  const lines = renderCompactWidget(widgetState(), 120, theme);

  assert.deepEqual(lines, [
    "▼ ● #1 Persistent tree",
    "  ▶ ○ #1.1 Parent Todo",
  ]);
  assert.ok(lines.every((line) => !line.startsWith(">")));
  assert.ok(lines.every((line) => !line.includes("Devflow ·")));
});

test("persistent widget collapses completed Goals by default", () => {
  const state = widgetState();
  state.goals["goal-1"]!.status = "completed";
  state.todos.parent!.status = "completed";
  state.todos.child!.status = "completed";

  assert.deepEqual(renderCompactWidget(state, 120, theme), [
    "▶ ✓ #1 Persistent tree",
  ]);
});

test("interactive tree and persistent widget share expansion state", () => {
  const state = widgetState();
  const expanded = new Set(["goal:goal-1"]);
  const controller = new TreeController(state, expanded);

  assert.equal(renderCompactWidget(state, 120, theme, expanded).length, 2);
  assert.deepEqual(controller.activate(), { type: "collapse", key: "goal:goal-1" });
  assert.deepEqual(renderCompactWidget(state, 120, theme, expanded), [
    "▶ ● #1 Persistent tree",
  ]);
});


test("widget expansion follows Goal lifecycle without overriding manual toggles", () => {
  const state = widgetState();
  const expanded = new Set<string>();
  const statuses = new Map<string, typeof state.goals[string]["status"]>();

  syncWidgetExpandedIds(state, expanded, statuses);
  assert.deepEqual([...expanded], ["goal:goal-1"]);

  expanded.clear();
  syncWidgetExpandedIds(state, expanded, statuses);
  assert.equal(expanded.size, 0, "manual collapse must survive unrelated state refreshes");

  state.goals["goal-1"]!.status = "completed";
  expanded.add("goal:goal-1");
  syncWidgetExpandedIds(state, expanded, statuses);
  assert.equal(expanded.size, 0, "completion transition must auto-collapse the Goal");

  expanded.add("goal:goal-1");
  syncWidgetExpandedIds(state, expanded, statuses);
  assert.deepEqual([...expanded], ["goal:goal-1"], "completed Goals can be reopened manually");
});
