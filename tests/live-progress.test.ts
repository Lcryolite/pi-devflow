import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { WorkflowSnapshot } from "@quintinshaw/pi-dynamic-workflows";

import {
  addGoal,
  addTodo,
  applyWorkflowSnapshot,
  createProjectState,
  createWorkflowBinding,
  renderDynamicWidget,
} from "../src/index.js";

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const started = "2026-08-01T00:00:00.000Z";

function progressState() {
  let state = createProjectState("/repo", started);
  state = addGoal(state, {
    id: "foreign", title: "Foreign window", objective: "foreign", successCriteria: [], ownerSessionId: "session-b",
  }, started);
  state = addTodo(state, { id: "foreign-work", goalId: "foreign", title: "Foreign work", execution: "main" }, started);
  state.todos["foreign-work"]!.status = "in_progress";

  state = addGoal(state, {
    id: "mine", title: "Analyze novel", objective: "mine", successCriteria: [], ownerSessionId: "session-a",
  }, started);
  state = addTodo(state, { id: "workflow", goalId: "mine", title: "Analyze novel", execution: "workflow" }, started);
  state = createWorkflowBinding(state, {
    bindingId: "binding", upstreamRunId: "run", todoId: "workflow", ownerSessionId: "session-a", ownerRuntimeId: "runtime-a",
    phases: [
      { title: "fanout", role: "fanout", requestedModel: "openai/small" },
      { title: "work", role: "work", requestedModel: "openai/medium" },
      { title: "judge", role: "judge", requestedModel: "openai/big" },
    ],
  }, started);
  const snapshot: WorkflowSnapshot = {
    name: "novel", phases: ["fanout", "work", "judge"], currentPhase: "work", logs: [],
    agents: [
      { id: 1, callId: "run:1", label: "writer", phase: "work", prompt: "write", status: "done", model: "openai/medium" },
      { id: 2, callId: "run:2", label: "reviewer", phase: "work", prompt: "review", status: "running", model: "openai/medium" },
    ],
    agentCount: 2, runningCount: 1, doneCount: 1, errorCount: 0,
  };
  return applyWorkflowSnapshot(state, "binding", snapshot, 1, "2026-08-01T00:00:05.000Z");
}

test("compact widget is session-owned and shows live workflow phase progress", () => {
  const lines = renderDynamicWidget(progressState(), 140, theme, new Set(), false, "session-a", Date.parse("2026-08-01T00:02:05.000Z"));

  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /Analyze novel · workflow · 2:05/);
  assert.match(lines[1]!, /phase 2\/3 work · agents 1\/2 · openai\/medium/);
  assert.match(lines[2]!, /reviewer/);
  assert.ok(lines.every((line) => !line.includes("Foreign")));
});

test("foreign work produces no widget lines in this session", () => {
  const state = progressState();
  assert.deepEqual(renderDynamicWidget(state, 120, theme, new Set(), false, "session-c", Date.now()), []);
});

test("expanded tree only contains goals owned by the current session", () => {
  const state = progressState();
  const lines = renderDynamicWidget(state, 140, theme, new Set(["goal:mine"]), true, "session-a", Date.now());
  assert.ok(lines.some((line) => line.includes("Analyze novel")));
  assert.ok(lines.every((line) => !line.includes("Foreign window")));
  assert.ok(lines.some((line) => line.includes("phase 2/3") || line.includes("work")));
  assert.ok(lines.some((line) => line.includes("reviewer")));
});

test("workflow snapshot persists current phase and progress timestamp", () => {
  const binding = progressState().workflowRuns.binding!;
  assert.equal(binding.currentPhaseTitle, "work");
  assert.equal(binding.lastProgressAt, "2026-08-01T00:00:05.000Z");
});


test("cancelled Workflow history never pins the idle widget", () => {
  const state = progressState();
  state.workflowRuns.binding!.status = "failed";
  state.workflowRuns.binding!.endedAt = "2026-08-01T00:01:00.000Z";
  state.todos.workflow!.status = "cancelled";
  state.goals.mine!.status = "cancelled";
  assert.deepEqual(renderDynamicWidget(state, 120, theme, new Set(), false, "session-a", Date.now()), []);
  assert.deepEqual(renderDynamicWidget(state, 120, theme, new Set(), true, "session-a", Date.now()), []);
});
