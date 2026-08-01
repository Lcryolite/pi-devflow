import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import {
  addGoal,
  addTodo,
  createProjectState,
  renderDynamicWidget,
  syncWidgetExpandedIds,
  syncWidgetView,
  toggleWidgetView,
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

test("idle widget disappears instead of pinning completed history above messages", () => {
  const state = widgetState();
  state.goals["goal-1"]!.status = "completed";
  state.todos.parent!.status = "completed";
  state.todos.child!.status = "completed";

  assert.deepEqual(renderDynamicWidget(state, 120, theme, new Set(), false), []);
});

test("working widget defaults to one dynamic summary line", () => {
  const state = widgetState();
  state.todos.parent!.status = "in_progress";

  const lines = renderDynamicWidget(state, 120, theme, new Set(), false);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^◆ Devflow · 1 running · Ctrl\+Shift\+D 展开 · Parent Todo$/);
});

test("expanded widget renders the full active tree without an interactive cursor", () => {
  const state = widgetState();
  state.todos.parent!.status = "in_progress";
  const lines = renderDynamicWidget(state, 120, theme, new Set(["goal:goal-1"]), true);

  assert.deepEqual(lines, [
    "▼ ● #1 Persistent tree",
    "  ▶ ● #1.1 Parent Todo",
  ]);
  assert.ok(lines.every((line) => !line.startsWith(">")));
});

test("global widget toggle expands and collapses without opening a panel", () => {
  const view = { expanded: false, hadActivity: false };
  assert.equal(toggleWidgetView(view), true);
  assert.equal(toggleWidgetView(view), false);
});

test("widget auto-collapses only when work transitions to idle", () => {
  const active = widgetState();
  active.todos.parent!.status = "in_progress";
  const idle = structuredClone(active);
  idle.goals["goal-1"]!.status = "completed";
  idle.todos.parent!.status = "completed";
  idle.todos.child!.status = "completed";
  const view = { expanded: true, hadActivity: undefined as boolean | undefined };

  syncWidgetView(active, view);
  assert.equal(view.expanded, true);
  syncWidgetView(idle, view);
  assert.equal(view.expanded, false);
  toggleWidgetView(view);
  syncWidgetView(idle, view);
  assert.equal(view.expanded, true, "manual idle expansion survives unrelated refreshes");
});

test("interactive tree and persistent widget share expansion state", () => {
  const state = widgetState();
  state.todos.parent!.status = "in_progress";
  const expanded = new Set(["goal:goal-1"]);
  const controller = new TreeController(state, expanded);

  assert.equal(renderDynamicWidget(state, 120, theme, expanded, true).length, 2);
  assert.deepEqual(controller.activate(), { type: "collapse", key: "goal:goal-1" });
  assert.deepEqual(renderDynamicWidget(state, 120, theme, expanded, true), [
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
