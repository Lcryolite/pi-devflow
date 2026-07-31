import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowSnapshot } from "@quintinshaw/pi-dynamic-workflows";

import {
  addGoal,
  addTodo,
  applyWorkflowSnapshot,
  buildWorkflowScript,
  createProjectState,
  createWorkflowBinding,
  modelPolicyFromTierConfig,
  resolveRoleModel,
  projectTreeRows,
  workflowPhaseModelLabel,
} from "../src/index.js";

function workflowState() {
  let state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  state = addGoal(state, { id: "goal", title: "Goal", objective: "Run workflow", successCriteria: [] }, "2026-07-30T00:00:01.000Z");
  return addTodo(state, { id: "todo", goalId: "goal", title: "Review", execution: "workflow" }, "2026-07-30T00:00:02.000Z");
}

test("workflow phases become child todos while agents remain phase details", () => {
  let state = createWorkflowBinding(workflowState(), {
    bindingId: "binding", upstreamRunId: "run", todoId: "todo",
    phases: [{ title: "Inspect", role: "fanout" }, { title: "Judge", role: "judge" }],
  }, "2026-07-30T00:00:03.000Z");
  const snapshot: WorkflowSnapshot = {
    name: "review", phases: ["Inspect", "Judge"], currentPhase: "Inspect", logs: [],
    agents: [
      { id: 1, callId: "run:1", label: "reader", phase: "Inspect", prompt: "read", status: "done", model: "openai/gpt-small" },
      { id: 2, callId: "run:2", label: "reader", phase: "Inspect", prompt: "read", status: "running", model: "openai/gpt-small" },
    ],
    agentCount: 2, runningCount: 1, doneCount: 1, errorCount: 0,
  };

  state = applyWorkflowSnapshot(state, "binding", snapshot, 1, "2026-07-30T00:00:04.000Z");

  assert.deepEqual(state.todos.todo?.childIds, ["binding:phase:1", "binding:phase:2"]);
  assert.equal(state.todos["binding:phase:1"]?.status, "in_progress");
  assert.equal(state.workflowRuns.binding?.phases[0]?.agents.length, 2);
  assert.equal(state.workflowRuns.binding?.phases[0]?.actualModels[0], "openai/gpt-small");
  assert.equal(workflowPhaseModelLabel(state.workflowRuns.binding!.phases[0]!), "openai/gpt-small?");
  const rows = projectTreeRows(state, new Set(["goal:goal", "todo:todo", "todo:binding:phase:1"]));
  const agentRows = rows.filter((row) => row.key.includes(":agent:"));
  assert.equal(agentRows.length, 2);
  assert.match(agentRows[0]!.title, /openai\/gpt-small$/);
  assert.match(agentRows[1]!.title, /openai\/gpt-small\?$/);
});

test("out-of-order workflow snapshots cannot regress projection", () => {
  let state = createWorkflowBinding(workflowState(), {
    bindingId: "binding", upstreamRunId: "run", todoId: "todo",
    phases: [{ title: "Inspect", role: "work" }],
  }, "2026-07-30T00:00:03.000Z");
  const snapshot: WorkflowSnapshot = {
    name: "review", phases: ["Inspect"], currentPhase: "Inspect", logs: [], agents: [],
    agentCount: 0, runningCount: 0, doneCount: 0, errorCount: 0,
  };
  state = applyWorkflowSnapshot(state, "binding", snapshot, 2, "2026-07-30T00:00:04.000Z");
  const same = applyWorkflowSnapshot(state, "binding", snapshot, 1, "2026-07-30T00:00:05.000Z");
  assert.equal(same.workflowRuns.binding?.lastSnapshotSequence, 2);
});

test("three-role model routing is deterministic", () => {
  const policy = {
    fanout: "openai/gpt-small",
    work: "openai/gpt-medium",
    judge: "openai/gpt-large",
  };
  assert.equal(resolveRoleModel("fanout", "openai/gpt-main", policy, false), "openai/gpt-small");
  assert.equal(resolveRoleModel("work", "openai/gpt-main", policy, false), "openai/gpt-medium");
  assert.equal(resolveRoleModel("judge", "openai/gpt-main", policy, false), "openai/gpt-main");
  assert.equal(resolveRoleModel("judge", "openai/gpt-main", policy, true), "openai/gpt-large");
});


test("tier configuration maps small, medium, and big into Devflow roles", () => {
  assert.deepEqual(modelPolicyFromTierConfig({
    tiers: {
      small: "openai/gpt-small:low",
      medium: "openai/gpt-medium:high",
      big: "openai/gpt-big:xhigh",
    },
  }), {
    fanout: "openai/gpt-small:low",
    work: "openai/gpt-medium:high",
    judge: "openai/gpt-big:xhigh",
  });
});


test("generated Workflow script pins every phase to its resolved role model", () => {
  const built = buildWorkflowScript({
    name: "route",
    description: "route every phase",
    phases: [
      { title: "Fanout", role: "fanout", prompts: ["scan"] },
      { title: "Work", role: "work", prompts: ["implement"] },
      { title: "Judge", role: "judge", prompts: ["review"] },
      { title: "Escalated", role: "judge", prompts: ["deep review"], escalateJudge: true },
    ],
  }, "openai/main", {
    fanout: "openai/small",
    work: "openai/medium",
    judge: "openai/big",
  });

  assert.deepEqual(built.phases.map((phase) => phase.requestedModel), [
    "openai/small",
    "openai/medium",
    "openai/main",
    "openai/big",
  ]);
  assert.match(built.script, /"model":"openai\/small"/);
  assert.match(built.script, /"model":"openai\/medium"/);
  assert.match(built.script, /"model":"openai\/main"/);
  assert.match(built.script, /"model":"openai\/big"/);
});


test("resolved model labels expose fallback from an explicit request", () => {
  assert.equal(workflowPhaseModelLabel({
    id: "phase", title: "Inspect", role: "fanout", todoId: "todo", requestedModel: "small/requested",
    actualModels: ["main/fallback"], agentTotal: 1, agentCompleted: 1,
    agents: [{ callId: "call", label: "agent", status: "done", model: "main/fallback", modelConfirmed: true }],
  }), "main/fallback (fallback)");
});
