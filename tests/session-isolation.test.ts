import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  abandonStaleSessionWorkflows,
  addGoal,
  addEvidence,
  addTodo,
  applySchedulePlan,
  createProjectState,
  createWorkflowBinding,
  formatStatus,
  planSchedule,
  reconcileProject,
  recoverInterruptedExecutions,
  retryTodo,
} from "../src/index.js";
import { filterReservedKeys } from "../src/runtime/dispatch.js";
import { DevflowRuntime } from "../src/runtime/session.js";

const now = "2026-08-01T00:00:00.000Z";
const a = { sessionId: "session-a", runtimeId: "runtime-a" };
const b = { sessionId: "session-b", runtimeId: "runtime-b" };

function twoSessionState() {
  let state = createProjectState("/repo", now);
  state.scheduler.maxConcurrentMain = 1;
  state = addGoal(state, { id: "a", title: "A", objective: "A", successCriteria: [], ownerSessionId: a.sessionId }, now);
  state = addTodo(state, { id: "a1", goalId: "a", title: "A work", execution: "main" }, now);
  state = addGoal(state, { id: "b", title: "B", objective: "B", successCriteria: [], ownerSessionId: b.sessionId }, now);
  state = addTodo(state, { id: "b1", goalId: "b", title: "B work", execution: "main" }, now);
  return reconcileProject(state, now);
}

test("scheduler only claims work owned by the current Pi session", () => {
  const state = twoSessionState();
  assert.deepEqual(planSchedule(state, now, a).starts.map((item) => item.todoId), ["a1"]);
  assert.deepEqual(planSchedule(state, now, b).starts.map((item) => item.todoId), ["b1"]);
});

test("foreign capacity is ignored but foreign resource claims still conflict", () => {
  let state = twoSessionState();
  state.todos.a1!.resourceClaims = [{ key: "repo/shared", mode: "write" }];
  state.todos.b1!.resourceClaims = [{ key: "repo/shared", mode: "write" }];
  state = applySchedulePlan(state, planSchedule(state, now, a), now, a);

  assert.equal(planSchedule(state, now, b).starts.length, 0);
  state.todos.b1!.resourceClaims = [{ key: "repo/other", mode: "write" }];
  assert.deepEqual(planSchedule(state, now, b).starts.map((item) => item.todoId), ["b1"]);
});

test("recovery only mutates leases owned by the exact runtime", () => {
  let state = twoSessionState();
  state = applySchedulePlan(state, planSchedule(state, now, a), now, a);
  state = applySchedulePlan(state, planSchedule(state, now, b), now, b);
  state = recoverInterruptedExecutions(state, a, "2026-08-01T00:01:00.000Z");

  assert.equal(state.todos.a1!.status, "blocked");
  assert.equal(state.todos.b1!.status, "in_progress");
  assert.equal(state.scheduler.activeLeases.a1, undefined);
  assert.equal(state.scheduler.activeLeases.b1?.ownerRuntimeId, b.runtimeId);
});

test("continuations and leases are stamped with session and runtime ownership", () => {
  let state = twoSessionState();
  const plan = planSchedule(state, now, a);
  state = applySchedulePlan(state, plan, now, a);
  const record = state.scheduler.continuationKeys[plan.starts[0]!.continuationKey]!;

  assert.equal(record.ownerSessionId, a.sessionId);
  assert.equal(record.ownerRuntimeId, a.runtimeId);
  assert.equal(state.scheduler.activeLeases.a1!.ownerSessionId, a.sessionId);
});


test("a second runtime cannot dispatch another runtime's reserved continuation", () => {
  let state = twoSessionState();
  state = applySchedulePlan(state, planSchedule(state, now, a), now, a);
  const sameSessionOtherRuntime = { sessionId: a.sessionId, runtimeId: "runtime-a2" };

  assert.equal(filterReservedKeys(state, true, a).length, 1);
  assert.deepEqual(filterReservedKeys(state, true, sameSessionOtherRuntime), []);
  assert.deepEqual(filterReservedKeys(state, true, b), []);
});


test("agent status projection never includes foreign session work", () => {
  const status = formatStatus(twoSessionState(), a.sessionId);
  assert.match(status, /A work/);
  assert.doesNotMatch(status, /B work/);
});


test("ephemeral windows never share a fallback session owner", () => {
  const ctx = { sessionManager: { getSessionId: () => undefined } } as unknown as ExtensionContext;
  const first = new DevflowRuntime({} as ExtensionAPI).getScope(ctx);
  const second = new DevflowRuntime({} as ExtensionAPI).getScope(ctx);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.match(first.sessionId, /^ephemeral:/);
});


test("evidence IDs cannot overwrite another session's audit record", () => {
  let state = twoSessionState();
  state = addEvidence(state, {
    id: "shared-id", ownerSessionId: a.sessionId, kind: "test", summary: "A", observedAt: now, valid: true,
  });
  assert.throws(() => addEvidence(state, {
    id: "shared-id", ownerSessionId: b.sessionId, kind: "test", summary: "B", observedAt: now, valid: true,
  }), /another Pi session/);
  assert.equal(state.evidence["shared-id"]!.summary, "A");
});


test("explicit recovery abandons planned Workflows from a dead runtime", () => {
  let state = twoSessionState();
  state.todos.a1!.execution = "workflow";
  state.todos.a1!.workflowPlan = { name: "retry", description: "retry", phases: [{ title: "fanout", role: "fanout", prompts: ["inspect"] }] };
  state = createWorkflowBinding(state, {
    bindingId: "stale", upstreamRunId: "pending:stale", todoId: "a1",
    ownerSessionId: a.sessionId, ownerRuntimeId: "dead-runtime", status: "planned",
    phases: [{ title: "fanout", role: "fanout" }],
  }, now);
  state = abandonStaleSessionWorkflows(state, a, "2026-08-01T00:01:00.000Z");
  assert.equal(state.workflowRuns.stale!.status, "stopped");
  assert.equal(state.todos["stale:phase:1"]!.status, "cancelled");
  assert.equal(state.todos.a1!.status, "blocked");
  assert.equal(state.todos.a1!.workflowRunId, undefined);
  state = reconcileProject(retryTodo(state, "a1", "fresh Workflow", "2026-08-01T00:02:00.000Z"), "2026-08-01T00:02:00.000Z");
  assert.equal(state.todos.a1!.status, "ready");
  assert.equal(state.todos.a1!.workflowPlan?.name, "retry");
});
