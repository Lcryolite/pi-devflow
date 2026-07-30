import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import { addGoal, addTodo, createProjectState, renderCompactWidget } from "../src/index.js";

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

test("persistent widget includes completed Goals instead of disappearing", () => {
  const state = widgetState();
  state.goals["goal-1"]!.status = "completed";
  state.todos.parent!.status = "completed";
  state.todos.child!.status = "completed";

  assert.deepEqual(renderCompactWidget(state, 120, theme), [
    "▼ ✓ #1 Persistent tree",
    "  ▶ ✓ #1.1 Parent Todo",
  ]);
});
