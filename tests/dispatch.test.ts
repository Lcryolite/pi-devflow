import assert from "node:assert/strict";
import test from "node:test";

import { applyContinuationClaim, resolveContinuationClaim } from "../src/domain/continuation.js";
import { createProjectState } from "../src/domain/state.js";
import { decideReservedContinuation, filterReservedKeys } from "../src/runtime/dispatch.js";
import type { ProjectState } from "../src/domain/types.js";

function baseState(): ProjectState {
  const now = "2026-01-01T00:00:00.000Z";
  const state = createProjectState("/tmp/devflow-test", now);
  state.goals.g1 = {
    id: "g1",
    ownerSessionId: "legacy-unowned",
    title: "Goal",
    objective: "obj",
    successCriteria: [],
    constraints: [],
    nonGoals: [],
    evidenceRequirements: [],
    status: "active",
    dependsOn: [],
    rootTodoIds: ["t1"],
    createdAt: now,
    updatedAt: now,
  };
  state.todos.t1 = {
    id: "t1",
    goalId: "g1",
    title: "Todo",
    status: "in_progress",
    required: true,
    dependsOn: [],
    childIds: [],
    execution: "main",
    resourceClaims: [],
    systemManaged: false,
    executionGeneration: 0,
    attempts: [],
    createdAt: now,
    updatedAt: now,
  };
  state.scheduler.activeLeases.t1 = {
    id: "t1",
    todoId: "t1",
    goalId: "g1",
    ownerSessionId: "legacy-unowned",
    ownerRuntimeId: "legacy-unowned",
    mode: "main",
    resourceClaims: [],
    acquiredAt: now,
  };
  state.scheduler.continuationKeys["k1"] = {
    key: "k1",
    todoId: "t1",
    ownerSessionId: "legacy-unowned",
    ownerRuntimeId: "legacy-unowned",
    revision: 0,
    status: "reserved",
    createdAt: now,
  };
  return state;
}

test("decideReservedContinuation sends main agent for main execution", () => {
  const state = baseState();
  assert.deepEqual(decideReservedContinuation(state, "k1"), {
    kind: "send_main",
    todoId: "t1",
    key: "k1",
    title: "Todo",
  });
});

test("decideReservedContinuation expires invalid reservations", () => {
  const state = baseState();
  state.todos.t1!.status = "ready";
  assert.deepEqual(decideReservedContinuation(state, "k1"), { kind: "expire", key: "k1" });
});

test("decideReservedContinuation requires workflow plan", () => {
  const state = baseState();
  state.todos.t1!.execution = "workflow";
  state.scheduler.activeLeases.t1!.mode = "workflow";
  assert.deepEqual(decideReservedContinuation(state, "k1"), {
    kind: "block_missing_plan",
    todoId: "t1",
    key: "k1",
  });
});

test("filterReservedKeys respects allowMain", () => {
  const state = baseState();
  assert.deepEqual(filterReservedKeys(state, true), ["k1"]);
  assert.deepEqual(filterReservedKeys(state, false), []);
  state.todos.t1!.execution = "workflow";
  assert.deepEqual(filterReservedKeys(state, false), ["k1"]);
});

test("resolveContinuationClaim claims sent in-progress leases", () => {
  const state = baseState();
  state.scheduler.continuationKeys.k1!.status = "sent";
  assert.equal(resolveContinuationClaim(state, "k1"), "claimed");
  const applied = applyContinuationClaim(state, "k1");
  assert.equal(applied.stale, false);
  assert.equal(applied.state.scheduler.continuationKeys.k1!.status, "claimed");
});

test("resolveContinuationClaim marks missing keys stale", () => {
  const state = baseState();
  assert.equal(resolveContinuationClaim(state, "missing"), "stale");
  assert.equal(applyContinuationClaim(state, "missing").stale, true);
});
